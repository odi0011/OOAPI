package handlers

/*
等待室（hold.go）的单测。

测试的两条关键路径（用户要的就是这两条）：
  1. **账号恢复**：进入等待室 → 客户收到「正在紧急调度」→ 后台账号恢复
     → 真实回答无缝接在同一条流里（不需要客户端做任何事）；
  2. **等到超时**：一直没有账号 → 每分钟都有进度、最后收到明确的超时说明。

为了让 50 分钟的等待能在毫秒级跑完，测试压缩 holdInterval /
holdPollStep / holdMaxWait —— 跑的是同一份代码，不是另写一个测试专用分支。
*/

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/netguard"
	"ooapi/internal/services"
)

// allowLoopbackUpstream 让等待室测试能打到本机 httptest 上游。
// 生产默认仍拒绝回环；这里只在该测试期间打开，并清掉可能缓存的拒绝结果。
func allowLoopbackUpstream(t *testing.T) {
	t.Helper()
	netguard.SetAllowLoopbackForTest(true)
	netguard.ClearCache()
	t.Cleanup(func() {
		netguard.SetAllowLoopbackForTest(false)
		netguard.ClearCache()
	})
}

// ---------- 测试脚手架 ----------

// shrinkingHoldTimings 把等待室的时间参数压缩到毫秒级，测试结束自动还原。
func shrinkingHoldTimings(t *testing.T) {
	t.Helper()
	origInterval, origPoll, origMax, origJSON := holdInterval, holdPollStep, holdMaxWait, jsonHoldMaxWait
	holdInterval = 20 * time.Millisecond
	holdPollStep = 5 * time.Millisecond
	holdMaxWait = 300 * time.Millisecond
	jsonHoldMaxWait = 300 * time.Millisecond
	t.Cleanup(func() {
		holdInterval, holdPollStep, holdMaxWait, jsonHoldMaxWait = origInterval, origPoll, origMax, origJSON
	})
}

/*
channelRows 造一份 channels 表的查询结果。

loadChannels 的 SELECT 列顺序必须严格对应（见 gateway.go 的说明），
所以这里按同一顺序给出：

	id, name, vendor, base_url, api_key, models, group_name,
	priority, weight, status, cooldown_until, headers, model_paths, method,
	concurrency, min_gap_ms, max_per_min, context_billing,
	namespace, require_caller, proxy_url, tls_fingerprint, model_bindings
*/
func channelRows(cooldownUntil time.Time) *callerTestRows {
	return &callerTestRows{
		columns: []string{
			"id", "name", "vendor", "base_url", "api_key", "models", "group_name",
			"priority", "weight", "status", "cooldown_until", "headers", "model_paths", "method",
			"concurrency", "min_gap_ms", "max_per_min", "context_billing",
			"namespace", "require_caller", "proxy_url", "tls_fingerprint", "model_bindings",
		},
		values: [][]driver.Value{{
			int64(7), "测试账号", "opencode", "http://127.0.0.1:1/v1", "k", "deepseek-flash", "",
			int64(1), int64(1), int64(1), cooldownUntil, "", "", "api",
			int64(0), int64(0), int64(0), "auto",
			"", "", "", "", "",
		}},
	}
}

// installChannelsQuery 让 services.loadChannels 读到指定的渠道行。
//
// modelMap 是「上游名 → 官方名」的映射（options 表里的 model_map: 项），
// 给出它才能模拟真实场景：渠道声明上游叫法（deepseek-v4.1-flash），
// 而客户端用官方名（deepseek-flash）调用。
func installChannelsQuery(t *testing.T, rows *callerTestRows, modelMap map[string]string) *callerTestDriver {
	t.Helper()
	services.MarkChannelsDirty()
	services.InvalidateModelMap()

	d := &callerTestDriver{}
	d.query = func(q string, args []driver.NamedValue) (driver.Rows, error) {
		if strings.Contains(q, "FROM channels") {
			copied := &callerTestRows{columns: rows.columns, values: append([][]driver.Value(nil), rows.values...)}
			return copied, nil
		}
		if strings.Contains(q, "FROM options") {
			out := &callerTestRows{columns: []string{"key_name", "value"}}
			for from, to := range modelMap {
				out.values = append(out.values, []driver.Value{"model_map:" + from, to})
			}
			return out, nil
		}
		if strings.Contains(q, "FROM model_prices") {
			// 调用入口会拒绝没有可用定价的模型，并在转发前预扣。
			// 等待室测试打的是 deepseek-flash，给它一行可用价格。
			return &callerTestRows{
				columns: []string{"model", "input_price", "output_price", "cached_price", "context_tiers"},
				values:  [][]driver.Value{{"deepseek-flash", float64(1), float64(2), float64(0.1), ""}},
			}, nil
		}
		return &callerTestRows{columns: []string{"model", "input_price", "output_price", "cached_price", "context_tiers"}}, nil
	}
	useCallerTestDB(t, d)
	t.Cleanup(func() {
		services.MarkChannelsDirty()
		services.InvalidateModelMap()
	})
	return d
}

// ---------- 分类规则 ----------

func TestClassifyFailureForHold(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want channelFailureKind
	}{
		{"没有可用账号 → 可等", errors.New("没有可用账号，请在后台检查账号状态与模型配置"), channelFailureRetryable},
		{"限流包装 → 可等", fmt.Errorf("%w：账号「x」", errChannelRateLimited), channelFailureRetryable},
		{"上游 5xx → 可等", newUpstreamError(502, "bad gateway", true), channelFailureRetryable},
		{"连不上（Status 0）→ 可等", newUpstreamError(0, "无法连接上游", true), channelFailureRetryable},
		{"429 → 可等", newUpstreamError(429, "too many requests", true), channelFailureRetryable},
		{"风控标记 → 可等（换账号即恢复）", newUpstreamError(400,
			`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`, true), channelFailureRetryable},
		{"模型不存在（4xx）→ 不等", newUpstreamError(404, "model not found", false), channelFailureFatal},
		{"参数错（400）→ 不等", newUpstreamError(400, "invalid parameter", false), channelFailureFatal},
		{"欠费（402）→ 不等", newUpstreamError(402, "insufficient funds", false), channelFailureFatal},
		{"客户端取消 → 不等", context.Canceled, channelFailureFatal},
		{"nil → 不等", nil, channelFailureFatal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyFailureForHold(tc.err); got != tc.want {
				t.Fatalf("classifyFailureForHold = %v, want %v", got, tc.want)
			}
		})
	}
}

// ---------- 提示语必须能被三个翻译器翻成正常消息 ----------

/*
Markdown 样式的约束。

提示语用引用块（`>`）+ 加粗 + `[OOAPI]` 标记，让它在模型输出里一眼可辨。
但 Markdown 有个容易踩的坑：**引用块靠空行结束**。
少了空行，紧随其后的真实回答会被吸进引用块（lazy continuation），
用户看到的是「整段回答都变成灰色引用」—— 比不做样式还糟。
所以这里把「每条提示语都以空行结尾」当成硬约束来测。
*/
func TestHoldMessagesAreWellFormedMarkdown(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"首次提示", fmt.Sprintf(holdStatusMessage, "deepseek-flash")},
		{"重发提示", fmt.Sprintf(holdRetryMessage, "deepseek-flash", "1 分钟")},
		{"恢复过渡", holdRecoveredMessage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !strings.HasPrefix(tc.text, ">") {
				t.Fatalf("应以引用块开头（便于与模型输出区分）: %q", tc.text)
			}
			// 结尾必须留出空行，否则后面的真实回答会被吸进引用块。
			if !strings.HasSuffix(tc.text, "\n\n") {
				t.Fatalf("必须以空行结尾（结束引用块）: %q", tc.text)
			}
			if !strings.Contains(tc.text, "**") {
				t.Fatalf("应有加粗强调: %q", tc.text)
			}
			if !strings.Contains(tc.text, holdMarker) {
				t.Fatalf("应带稳定标记 %s（用于识别与剥离）: %q", holdMarker, tc.text)
			}
			// 连续两行引用之间不能有裸换行（那会把引用断开成两段）。
			for _, line := range strings.Split(strings.TrimSuffix(tc.text, "\n\n"), "\n") {
				if line != "" && !strings.HasPrefix(line, ">") {
					t.Fatalf("引用块内的行都必须以 > 开头，违规行: %q", line)
				}
			}
		})
	}
}

// 用户明确要求不要 emoji（不同终端字形不一，且不利于稳定识别）。
func TestHoldMessagesHaveNoEmoji(t *testing.T) {
	all := fmt.Sprintf(holdStatusMessage, "m") + fmt.Sprintf(holdRetryMessage, "m", "1 分钟") +
		holdRecoveredMessage + fmt.Sprintf(holdTimeoutError, "50 分钟", "m") +
		fmt.Sprintf(holdFatalError, "x")
	for _, r := range all {
		/*
			只排除 emoji 所在区段，不能简单地「大于 U+2100 就报错」——
			中文（U+4E00 起）与全角标点都在更高的区段。
			这里拦下的是 emoji 与各种图形符号的实际区段。
		*/
		switch {
		case r >= 0x2190 && r <= 0x2BFF: // 箭头、杂项符号、装饰符号（✅⏳❌ 所在区）
			t.Fatalf("提示语里不应出现 emoji / 图形符号: %q (U+%04X)", string(r), r)
		case r >= 0x1F000 && r <= 0x1FAFF: // emoji 主区
			t.Fatalf("提示语里不应出现 emoji: %q (U+%04X)", string(r), r)
		case r == 0xFE0F || r == 0x200D: // 变体选择符 / 零宽连接符（拼 emoji 用）
			t.Fatalf("提示语里不应出现 emoji 组合符: U+%04X", r)
		}
	}
}

// 时长要说成人话（"1 分钟"而不是 Go 的 "1m0s"）。
func TestHoldElapsedIsHumanReadable(t *testing.T) {
	cases := map[time.Duration]string{
		3 * time.Second:                       "3 秒",
		59 * time.Second:                      "59 秒",
		time.Minute:                           "1 分钟",
		2*time.Minute + 30*time.Second:        "2 分钟",
		50 * time.Minute:                      "50 分钟",
		90*time.Second + 500*time.Millisecond: "1 分钟",
	}
	for d, want := range cases {
		if got := holdElapsed(d); got != want {
			t.Fatalf("holdElapsed(%s) = %q, want %q", d, got, want)
		}
	}
}

// sseTextContent 从一段 SSE 事件流里把正文抽出来（解码 JSON 转义）。
//
// 为什么要解码后再断言：翻译器（responses / anthropic）用 json.Marshal
// 重新编码事件，默认会把 `>` 转义成 `\u003e`。这是**合法 JSON**，
// 客户端解析后拿到的仍是 `>`，渲染不受影响。
// 所以断言必须针对「解码后的正文」，而不是原始字节 ——
// 否则测试会因为一个无害的转义而误报。
func sseTextContent(t *testing.T, stream string) string {
	t.Helper()
	var sb strings.Builder
	for _, block := range strings.Split(stream, "\n\n") {
		data := ""
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		if data == "" {
			continue
		}
		var generic map[string]any
		if json.Unmarshal([]byte(data), &generic) != nil {
			continue
		}
		if d, ok := generic["delta"].(map[string]any); ok {
			if text, okText := d["text"].(string); okText {
				sb.WriteString(text)
			}
		}
		if text, okText := generic["delta"].(string); okText {
			sb.WriteString(text)
		}
	}
	return sb.String()
}

func TestHoldNoticeTranslatesToClientMessage(t *testing.T) {
	notice := fmt.Sprintf(holdStatusMessage, "deepseek-flash")
	chunk := chatTextChunk("deepseek-flash", notice)
	if len(chunk) == 0 {
		t.Fatal("chatTextChunk 返回空")
	}
	if !strings.HasSuffix(string(chunk), "\n\n") {
		t.Fatalf("帧必须以空行结束（SSE 分帧要求）: %q", chunk)
	}
	// 引用块字符不应被转义成 \u003e（否则人工看流/字符串级处理时很难辨认）。
	if strings.Contains(string(chunk), `\u003e`) {
		t.Fatalf("引用块符被 HTML 转义了: %q", chunk)
	}

	t.Run("chat 透传", func(t *testing.T) {
		chunks := (&chatPassthrough{}).Translate(chunk)
		got := string(joinChunks(chunks))
		if !strings.Contains(got, "正在紧急调度") {
			t.Fatalf("提示语未出现在 chat 流里: %q", got)
		}
		if !strings.Contains(got, "> **[OOAPI]") {
			t.Fatalf("引用块样式在 chat 流里丢失: %q", got)
		}
	})

	t.Run("responses 事件", func(t *testing.T) {
		tr := &responsesTranslator{model: "deepseek-flash"}
		tr.Start("deepseek-flash")
		var sb strings.Builder
		for _, c := range tr.Translate(chunk) {
			sb.Write(c)
		}
		out := sb.String()
		if !strings.Contains(out, "response.output_text.delta") {
			t.Fatalf("缺少 responses 文本事件: %q", out)
		}
		// 断言解码后的正文（见 sseTextContent 的说明）。
		if text := sseTextContent(t, out); !strings.Contains(text, "> **[OOAPI]") {
			t.Fatalf("解码后的正文里没有引用块样式: %q", text)
		}
	})

	t.Run("anthropic 事件", func(t *testing.T) {
		tr := &anthropicTranslator{model: "deepseek-flash"}
		tr.Start("deepseek-flash")
		var sb strings.Builder
		for _, c := range tr.Translate(chunk) {
			sb.Write(c)
		}
		out := sb.String()
		if !strings.Contains(out, "content_block_delta") {
			t.Fatalf("缺少 anthropic 文本事件: %q", out)
		}
		if text := sseTextContent(t, out); !strings.Contains(text, "> **[OOAPI]") {
			t.Fatalf("解码后的正文里没有引用块样式: %q", text)
		}
	})
}

func joinChunks(chunks [][]byte) []byte {
	var out []byte
	for _, c := range chunks {
		out = append(out, c...)
	}
	return out
}

// ---------- 恢复路径：账号冷却结束后无缝接上真实回答 ----------

func TestHoldRecoversWhenChannelComesBack(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shrinkingHoldTimings(t)
	allowLoopbackUpstream(t)

	// 上游：账号一恢复就返回一个正常的 chat 流（含 usage 与 [DONE]）。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"真实回答"},"finish_reason":null}]}`+"\n\n")
		io.WriteString(w, `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}`+"\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	/*
		账号一开始在冷却中（SelectChannels 会跳过它）→ 触发等待室；
		base_url 指向测试上游，冷却一到期就能真的接上。

		渠道声明的是**上游叫法**（deepseek-v4.1-flash），客户端请求的是
		**官方名**（deepseek-flash）—— 这是线上真实形状（WorkBuddy 就是这样），
		顺带验证等待结束后模型名的双向映射没被破坏。
	*/
	rows := channelRows(time.Now().Add(60 * time.Millisecond))
	rows.values[0][3] = upstream.URL + "/v1"
	rows.values[0][5] = "deepseek-v4.1-flash"
	installChannelsQuery(t, rows, map[string]string{"deepseek-v4.1-flash": "deepseek-flash"})

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}
	body := []byte(`{"model":"deepseek-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	ok := relayUpstream(c, token, group, "deepseek-flash", body, start,
		&chatPassthrough{}, writeOpenAIError)
	if !ok {
		t.Fatalf("relayUpstream 返回 false（应进等待室并最终成功）；输出：\n%s", rec.Body.String())
	}

	// 关键断言：提示语在前、真实回答在后，且都在同一条流里。
	out := rec.Body.String()
	noticeAt := strings.Index(out, "正在紧急调度")
	answerAt := strings.Index(out, "真实回答")
	if noticeAt < 0 {
		t.Fatalf("没有发等待提示语：\n%s", out)
	}
	if answerAt < 0 {
		t.Fatalf("没有收到真实回答：\n%s", out)
	}
	if answerAt < noticeAt {
		t.Fatalf("真实回答应在提示语之后（notice=%d answer=%d）", noticeAt, answerAt)
	}
	// 流必须正确收尾，否则客户端会一直等。
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("流没有 [DONE] 收尾：\n%s", out)
	}
	// 不能混进 HTTP 错误 JSON（那是「忘了流已打开」的典型事故）。
	if strings.Contains(out, `"upstream_error"`) {
		t.Fatalf("流里混进了错误 JSON：\n%s", out)
	}
	// 响应里回显的模型名应是客户端请求的官方名。
	if strings.Contains(out, "deepseek-v4.1-flash") {
		t.Fatalf("上游模型名泄漏给了客户端：\n%s", out)
	}
}

// ---------- 超时路径：一直没有账号 ----------

func TestHoldTimesOutWithProgressAndExplanation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shrinkingHoldTimings(t)

	// 账号长期冷却（冷却到一小时后）→ 等待期间始终不可用。
	installChannelsQuery(t, channelRows(time.Now().Add(time.Hour)), nil)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}
	body := []byte(`{"model":"deepseek-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}`)

	ok := relayUpstream(c, token, group, "deepseek-flash", body, start,
		&chatPassthrough{}, writeOpenAIError)
	if ok {
		t.Fatal("没有任何可用账号时不该返回成功")
	}

	out := rec.Body.String()
	if !strings.Contains(out, "正在紧急调度") {
		t.Fatalf("缺少等待提示语：\n%s", out)
	}
	// 进度要发多次（每分钟一次的口径被压缩成 20ms，300ms 内至少两次）。
	if n := strings.Count(out, "正在紧急调度") + strings.Count(out, "仍在紧急调度"); n < 2 {
		t.Fatalf("进度通知只发了 %d 次，应至少 2 次：\n%s", n, out)
	}
	/*
		关键：必须用**错误帧**收尾，而不是正常结束。

		用户的要求：
		> 最终如果彻底结束了，就返回报错啊，而不是返回对话结束状态码，
		> 不然 agent 会误认为会话正常结束的

		chat 协议的错误约定是 `data: {"error": {...}}`；若只发 [DONE]，
		SDK 会把它当成一次成功的空回复 —— 用户回到电脑前只看到
		「正在调度」那句，完全不知道请求失败了。
	*/
	if !strings.Contains(out, `"error"`) || !strings.Contains(out, "调度超时") {
		t.Fatalf("超时必须发错误帧（否则 agent 会以为正常结束）：\n%s", out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("错误帧之后仍要有 [DONE]（连接正常关闭）：\n%s", out)
	}
	// 不能再出现正常收尾的痕迹（那会让 agent 误判成功）。
	if strings.Contains(out, `"finish_reason":"stop"`) {
		t.Fatalf("失败路径不应出现正常结束标记：\n%s", out)
	}
}

// ---------- 账号被禁用：必须等（不让会话断） ----------

/*
用户的要求原话：

> 他不要断懂吗，就伪装正常显示啊，因为有时候我不在电脑旁，
> 如果三方 agent 调用，因为点小原因断开会话了我这边发个「继续」
> 会导致上下文混乱。

Codex / Claude Code 的重试次数是写死的，一断就得人工补「继续」，
补「继续」又会让上下文错位 —— 这是用户最不想要的。
而「账号被禁用」是**临时状态**（管理员误操作、还没配好、风控自动禁用），
随时能恢复，所以必须占住连接等，而不是立刻 502。

（线上真实触发过：做测试时临时禁用了几个渠道，用户那边的 Codex
正在重试，连续收到 502 后重试次数用尽、会话断开。）
*/
func TestHoldWaitsWhenChannelsAreDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shrinkingHoldTimings(t)

	// 渠道声明了该模型，但被禁用（status=0）。
	rows := channelRows(time.Time{})
	rows.values[0][9] = int64(0) // status 列
	installChannelsQuery(t, rows, nil)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}

	ok := relayUpstream(c, token, group, "deepseek-flash",
		[]byte(`{"model":"deepseek-flash","stream":true}`), start,
		&chatPassthrough{}, writeOpenAIError)
	if ok {
		t.Fatal("账号禁用时不该返回成功（本用例只跑到超时）")
	}

	out := rec.Body.String()
	if !strings.Contains(out, "正在紧急调度") {
		t.Fatalf("账号被禁用时应占住连接并给提示（而不是 502），实际：\n%s", out)
	}
	// 超时必须走错误帧（见超时用例里的说明），并正常关闭连接。
	if !strings.Contains(out, `"error"`) || !strings.Contains(out, "调度超时") {
		t.Fatalf("超时后应发错误帧：\n%s", out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("错误帧后仍要有 [DONE]：\n%s", out)
	}
	if elapsed := time.Since(start); elapsed < 200*time.Millisecond {
		t.Fatalf("应占住连接等待，实际只用了 %s", elapsed)
	}
}

// ---------- 模型名压根没配置：立刻报错（等也没用） ----------

/*
与上一条相对的另一面：模型名打错 / 还没配置时，SelectChannels 同样回
「没有可用账号」。此时**不能**等 —— 等 50 分钟只会让用户百思不得其解，
真正该做的是立刻告诉他「这个模型没有账号支持」。

区分点：分组里有没有**任何**账号（不看启用状态）声明支持该模型。
*/
func TestHoldFailsFastWhenModelIsNotDeclaredAnywhere(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shrinkingHoldTimings(t)

	// 渠道声明的是别的模型，且客户端请求的模型没有任何账号支持。
	rows := channelRows(time.Time{})
	rows.values[0][5] = "some-other-model"
	installChannelsQuery(t, rows, nil)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}

	began := time.Now()
	ok := relayUpstream(c, token, group, "deepseek-flash",
		[]byte(`{"model":"deepseek-flash","stream":true}`), start,
		&chatPassthrough{}, writeOpenAIError)
	if ok {
		t.Fatal("没有账号支持该模型时不该返回成功")
	}
	// 必须立刻失败（而不是占住连接等 50 分钟）。
	if elapsed := time.Since(began); elapsed > 150*time.Millisecond {
		t.Fatalf("模型未配置时应立刻报错，却等了 %s", elapsed)
	}
	if strings.Contains(rec.Body.String(), "正在紧急调度") {
		t.Fatalf("模型未配置时不该显示调度提示：\n%s", rec.Body.String())
	}
	// 流没开，所以是普通 HTTP 错误（JSON），不是 SSE。
	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("应返回 JSON 错误，实际：%q", rec.Body.String())
	}
}

// ---------- 非流式：静默等待，不发进度 ----------

func TestNonStreamWaitsSilentlyThenFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shrinkingHoldTimings(t)

	installChannelsQuery(t, channelRows(time.Now().Add(time.Hour)), nil)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}
	body := []byte(`{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}]}`)

	_, ok := callUpstream(c.Request.Context(), c, token, group, "deepseek-flash", body, start, writeOpenAIError)
	if ok {
		t.Fatal("没有账号时非流式不该成功")
	}
	// 非流式等待期间不能往 body 里写任何东西（HTTP 只能回一个响应）。
	if rec.Body.Len() != 0 && !strings.Contains(rec.Body.String(), "upstream_error") {
		t.Fatalf("非流式不应输出中间消息，实际：%q", rec.Body.String())
	}
	// 等待发生在「无法建连」之后，必须真的等过（而不是立刻报错）。
	if elapsed := time.Since(start); elapsed < 250*time.Millisecond {
		t.Fatalf("应静默等待一段时间，实际只用了 %s", elapsed)
	}
}

// ---------- 上游流必须能读到结束（context 生命周期回归） ----------

/*
慢速上游：分两次写，中间停一下。

存在的理由（线上事故）：把 forwardStreamWith 拆成「建连」与「转发」两步后，
建连函数里留了个 `defer cancel()` —— 函数一返回就取消了 context，
而响应体还在被转发函数读。现象是每次流式调用都在中途变成
`context canceled`，被记成「流式传输中断」，还会给好账号上冷却
（实测把 OpenCode Go 与 WorkBuddy 两个账号都打进了小黑屋）。

上面的等待室测试没逮到它，因为那些 mock 上游都是一次性写完 ——
这里的停顿正是关键：只有在读的过程中 context 被取消才会暴露。
*/
func TestUpstreamStreamSurvivesOpenReturn(t *testing.T) {
	gin.SetMode(gin.TestMode)
	allowLoopbackUpstream(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		io.WriteString(w, `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"第一段"},"finish_reason":null}]}`+"\n\n")
		flusher.Flush()
		// 停顿：模拟模型思考/长回答的间隔。context 若已被取消，
		// 写端会失败，客户端也收不到后面的内容。
		time.Sleep(120 * time.Millisecond)
		io.WriteString(w, `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"第二段"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`+"\n\n")
		flusher.Flush()
		time.Sleep(120 * time.Millisecond)
		io.WriteString(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	rows := channelRows(time.Time{})
	rows.values[0][3] = upstream.URL + "/v1"
	installChannelsQuery(t, rows, nil)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	start := time.Now()
	token := &apiToken{ID: 1, UserID: 1, GroupName: "ds-flash"}
	group := &services.Group{Name: "ds-flash", Rate: 1}

	ok := relayUpstream(c, token, group, "deepseek-flash",
		[]byte(`{"model":"deepseek-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}`),
		start, &chatPassthrough{}, writeOpenAIError)
	if !ok {
		t.Fatalf("流式请求失败：\n%s", rec.Body.String())
	}

	out := rec.Body.String()
	// 两段内容都必须到达客户端 —— 只到第一段就说明中途被取消了。
	if !strings.Contains(out, "第一段") || !strings.Contains(out, "第二段") {
		t.Fatalf("流被中途截断（context 生命周期问题）：\n%s", out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("流没有正常收尾：\n%s", out)
	}
}

// ---------- 提示语不能进入模型上下文 ----------

/*
用户的要求：

> 然后这个东西不要计入到上下文中

等待期间那几句提示语会以**助手回复**的身份被 agent 记进对话历史，
下一次请求时原样带回来。不剥掉的话模型每轮都能读到「OOAPI 正在紧急调度…」，
轻则白烧 token，重则顺着这个话头把自己当成调度系统往下编。
*/
func TestStripHoldNoticesRemovesNotices(t *testing.T) {
	notice := fmt.Sprintf(holdStatusMessage, "deepseek-flash")
	body := []byte(`{"model":"deepseek-flash","messages":[` +
		`{"role":"user","content":"帮我写个脚本"},` +
		`{"role":"assistant","content":` + jsonStringForTest(t, notice+notice) + `},` +
		`{"role":"user","content":"继续"}]}`)

	out := string(stripHoldNotices(body))

	if strings.Contains(out, holdMarker) {
		t.Fatalf("提示语没有被剥掉：%s", out)
	}
	// 用户真实说的话必须一字不动地保留。
	for _, want := range []string{"帮我写个脚本", "继续"} {
		if !strings.Contains(out, want) {
			t.Fatalf("用户内容被误删（%q）：%s", want, out)
		}
	}
	// 那条纯提示语的助手消息应当整条消失，而不是留一条空消息。
	if strings.Contains(out, `"content":""`) {
		t.Fatalf("剥空后不应留下空消息：%s", out)
	}
	if !json.Valid([]byte(out)) {
		t.Fatalf("剥完不是合法 JSON：%s", out)
	}
}

// 提示语与真实回答混在同一条消息里时，只删提示语、保留回答。
func TestStripHoldNoticesKeepsRealAnswer(t *testing.T) {
	notice := fmt.Sprintf(holdStatusMessage, "deepseek-flash")
	mixed := notice + "这是模型的真实回答。"
	body := []byte(`{"model":"m","messages":[{"role":"assistant","content":` + jsonStringForTest(t, mixed) + `}]}`)

	out := string(stripHoldNotices(body))
	if strings.Contains(out, holdMarker) {
		t.Fatalf("提示语没剥掉：%s", out)
	}
	if !strings.Contains(out, "这是模型的真实回答。") {
		t.Fatalf("真实回答被误删：%s", out)
	}
}

// 不含提示语的请求必须**逐字节原样返回**（常规路径零风险）。
func TestStripHoldNoticesLeavesOthersUntouched(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hello"}],"temperature":0.7}`)
	if got := string(stripHoldNotices(body)); got != string(body) {
		t.Fatalf("不该改动的请求被改动了：\n原: %s\n新: %s", body, got)
	}
	// 非法 JSON 也不能被弄坏（原样返回，交给下游按它自己的方式报错）。
	broken := []byte(`{"model":`)
	if got := string(stripHoldNotices(broken)); got != string(broken) {
		t.Fatalf("非法 JSON 应原样返回：%q", got)
	}
}

// 分段数组形状的 content 也要能剥。
func TestStripHoldNoticesHandlesPartsArray(t *testing.T) {
	notice := fmt.Sprintf(holdStatusMessage, "deepseek-flash")
	body := []byte(`{"model":"m","messages":[{"role":"assistant","content":[` +
		`{"type":"text","text":` + jsonStringForTest(t, notice) + `},` +
		`{"type":"text","text":"真正的回答"}]}]}`)

	out := stripHoldNotices(body)
	if strings.Contains(string(out), holdMarker) {
		t.Fatalf("分段里的提示语没剥掉：%s", out)
	}
	if !strings.Contains(string(out), "真正的回答") {
		t.Fatalf("同一条消息里的其他分段被误删：%s", out)
	}
}

// 剥掉消息后不能出现相邻同角色消息（Anthropic 要求严格交替）。
func TestStripHoldNoticesMergesAdjacentSameRole(t *testing.T) {
	notice := fmt.Sprintf(holdStatusMessage, "m")
	body := []byte(`{"model":"m","messages":[` +
		`{"role":"user","content":"第一句"},` +
		`{"role":"assistant","content":` + jsonStringForTest(t, notice) + `},` +
		`{"role":"user","content":"第二句"}]}`)

	var payload struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	out := stripHoldNotices(body)
	if err := json.Unmarshal(out, &payload); err != nil {
		t.Fatalf("结果不是合法 JSON：%v", err)
	}
	for i := 1; i < len(payload.Messages); i++ {
		if payload.Messages[i].Role == payload.Messages[i-1].Role {
			t.Fatalf("出现了相邻同角色消息（协议可能拒绝）：%s", out)
		}
	}
	// 两条用户消息应当被合并成一条，内容都在。
	if len(payload.Messages) != 1 {
		t.Fatalf("相邻 user 消息未被合并：%s", out)
	}
	for _, want := range []string{"第一句", "第二句"} {
		if !strings.Contains(payload.Messages[0].Content, want) {
			t.Fatalf("合并后丢了内容 %q：%s", want, payload.Messages[0].Content)
		}
	}
}

func jsonStringForTest(t *testing.T, s string) string {
	t.Helper()
	encoded, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// ---------- 失败收尾必须是**协议的错误事件** ----------

/*
用户的要求：

> 最终如果彻底结束了，就返回报错啊，而不是返回对话结束状态码，
> 不然 agent 会误认为会话正常结束的

三个协议的「失败」与「成功」收尾事件完全不同，逐个验证。
*/
func TestFinishErrorUsesProtocolErrorEvents(t *testing.T) {
	const msg = "OOAPI 调度超时：已等待 50 分钟仍无可用账号"

	t.Run("chat 用 error 帧 + [DONE]", func(t *testing.T) {
		frames := (&chatPassthrough{}).FinishError(msg)
		var sb strings.Builder
		for _, f := range frames {
			sb.Write(f)
		}
		out := sb.String()
		if !strings.Contains(out, `"error"`) || !strings.Contains(out, msg) {
			t.Fatalf("缺少错误帧：%q", out)
		}
		if !strings.Contains(out, "no_available_channel") {
			t.Fatalf("缺少错误码（SDK 据此区分失败原因）：%q", out)
		}
		// [DONE] 仍要有：连接要正常关闭，否则客户端挂住。
		if !strings.Contains(out, "[DONE]") {
			t.Fatalf("错误帧后缺少 [DONE]：%q", out)
		}
		// 绝不能出现正常结束标记。
		if strings.Contains(out, `"finish_reason":"stop"`) {
			t.Fatalf("失败收尾里出现了正常结束标记：%q", out)
		}
	})

	t.Run("responses 用 response.failed", func(t *testing.T) {
		tr := &responsesTranslator{model: "m"}
		out := string(joinChunks(tr.FinishError(msg)))
		if !strings.Contains(out, "response.failed") {
			t.Fatalf("缺少 response.failed（Codex 靠它判定本轮失败）：%q", out)
		}
		if strings.Contains(out, "response.completed") {
			t.Fatalf("失败收尾里出现了 response.completed（会被当成成功）：%q", out)
		}
		// 状态与错误信息都要带上，客户端才能显示原因。
		if !strings.Contains(out, `"status":"failed"`) || !strings.Contains(out, msg) {
			t.Fatalf("失败事件缺少状态或原因：%q", out)
		}
	})

	t.Run("anthropic 用 error 事件", func(t *testing.T) {
		tr := &anthropicTranslator{model: "m"}
		out := string(joinChunks(tr.FinishError(msg)))
		if !strings.Contains(out, "event: error") {
			t.Fatalf("缺少 error 事件（Claude Code 靠它报错）：%q", out)
		}
		if strings.Contains(out, "message_stop") || strings.Contains(out, "message_delta") {
			t.Fatalf("失败收尾里出现了正常结束事件（会被当成完整答复）：%q", out)
		}
		if !strings.Contains(out, msg) {
			t.Fatalf("错误事件缺少原因：%q", out)
		}
	})
}
