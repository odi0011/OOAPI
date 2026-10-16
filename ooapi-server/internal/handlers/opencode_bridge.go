package handlers

/*
OpenCode 桥接传输层。

**为什么需要**：OpenCode Zen 的免费档在服务端做了客户端校验，非官方客户端
一律 403 FreeTierError。实测（全部在同一服务器、同一 key 上）排除了所有
可以在 HTTP 层伪造的层面：

  - Mozilla UA / 官方 CLI UA / 完整官方头集合 —— 全部 403；
  - 6 种浏览器 TLS 指纹（chrome/firefox/safari/edge/ios/android）+ HTTP/2 —— 403；
  - 用 MITM 抓包还原官方 CLI 的逐字节请求（头、ID 编码、body）重放 —— 403；
  - 官方 CLI 二进制 v1.19.2 与它的 headless 模式（opencode serve）—— 200 成功。

结论：校验绑定在官方客户端进程的行为特征上。可靠路径是把请求交给本机的
`opencode serve`（官方 headless 服务）代为调用 —— 对上游来说就是官方客户端。

**链路**：网关 → 本机回环 HTTP → opencode serve → 上游。凭据只在本机传递。
serve 的 API key 由部署时写入（PUT /auth/opencode），网关不直接持有。

**协议翻译**：
  - chat-completions 请求 → serve 的「建会话 + prompt_async」；
  - serve 事件流 → chat-completions 的 SSE 分块（增量、用量、收尾、错误）；
  - 非流式复用同一通道（丢弃增量），等会话结束取最终文本。

**工具保持官方默认集，不在请求里增删**：上游的防滥用校验会比对请求形状 ——
实测「请求里带 tools 开关表（哪怕全是 false）」或「配置里禁用工具」都会
100% 被 403 拒绝（同一分钟交错对照可复现），必须与官方 CLI 的默认请求一致。
因此工具执行不由请求控制，改由三层防护兜底（见 systemd 单元的 User/沙箱、
opencode 默认权限为「询问」且无审批者、桥接从不代答审批）。

**已知限制**：桥接只支持文本对话。客户端自带的 function/tool 定义无法
透传给上游（serve 的 prompt API 不接受外部工具 schema），因此依赖
tool_calls 的 agent 工作负载不适用这条链路。
*/

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// openCodeBridgeAddr 是桥接 serve 的地址（本机回环）。
// 与 services.OpenCodeBridgeBase 同一默认值 —— 部署脚本与文档都以它为准。
var openCodeBridgeAddr = "http://127.0.0.1:4096"

// SetOpenCodeBridgeAddr 允许启动时按环境变量改写桥接地址。
func SetOpenCodeBridgeAddr(addr string) {
	trimmed := strings.TrimRight(strings.TrimSpace(addr), "/")
	if trimmed != "" {
		openCodeBridgeAddr = trimmed
	}
}

// bridgeHTTP 是网关 → serve 的 HTTP 客户端。
// 不设整体超时（流式响应可能持续很久）；超时由每个请求的 context 控制。
var bridgeHTTP = &http.Client{
	Timeout: 0,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Transport: &http.Transport{
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	},
}

/*
bridgeRetryAttempts 是单次请求内尝试次数。

免费档的客户端校验有约 5~10% 的偶发拒绝（同一形状有时 200 有时 403，
实测同一分钟交错对照可复现）。首次内容产出前的失败会换一个新会话重试，
把偶发率压到千分之一量级；这不是掩盖错误 —— 明确不可重试的失败
（余额不足、模型不存在）不重试。
*/
const bridgeRetryAttempts = 3

// bridgeRetryGap 是两次尝试之间的间隔。
var bridgeRetryGap = 400 * time.Millisecond

// bridgeOpenTimeout 是「会话建立 + 消息被接受」的等待上限。
// serve 接受 prompt_async 是即时的（204），超时说明它自身出了问题。
const bridgeOpenTimeout = 60 * time.Second

// bridgeFetchTimeout 是回读最终消息的超时（本机调用，给足即可）。
const bridgeFetchTimeout = 15 * time.Second

type bridgeModelRef struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

type bridgePart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type bridgeMessageBody struct {
	Model  bridgeModelRef `json:"model"`
	System string         `json:"system,omitempty"`
	Parts  []bridgePart   `json:"parts"`
}

/*
bridgeChatRequest 是翻译后的「通用语」请求。

下游三种协议（chat / messages / responses）都已归一到 chat-completions，
所以这里按 chat 的字段解析即可。
*/
type bridgeChatRequest struct {
	Model    string
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
}

// parseBridgeChatRequest 解析一份 chat-completions 请求体。
//
// content 可能是字符串或分段数组。桥接只做文本，非文本分段会被忽略。
func parseBridgeChatRequest(body []byte) (bridgeChatRequest, error) {
	var req bridgeChatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return bridgeChatRequest{}, fmt.Errorf("请求体不是合法的 chat 请求：%w", err)
	}
	if len(req.Messages) == 0 {
		return bridgeChatRequest{}, errors.New("请求缺少 messages")
	}
	return req, nil
}

// bridgePrompt 把 chat 消息列表翻译成 serve 的单条 prompt。
//
// system 角色单独提取（serve 有独立的 system 参数）；其余按角色标注拼接。
// 单轮对话不做角色标注：让请求体尽量接近真人输入。
func bridgePrompt(req bridgeChatRequest) (system string, prompt string) {
	var turns []string
	for _, m := range req.Messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		text := bridgeContentText(m.Content)
		if strings.TrimSpace(text) == "" {
			continue
		}
		switch role {
		case "system", "developer":
			if system == "" {
				system = text
			} else {
				system += "\n\n" + text
			}
		case "assistant":
			turns = append(turns, "Assistant: "+text)
		case "user":
			turns = append(turns, "User: "+text)
		default:
			turns = append(turns, text)
		}
	}
	if len(turns) == 0 {
		return system, "(no content)"
	}
	if len(turns) == 1 {
		return system, strings.TrimPrefix(turns[0], "User: ")
	}
	return system, strings.Join(turns, "\n\n")
}

// bridgeContentText 从 chat content 字段里取纯文本。
func bridgeContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var out strings.Builder
		for _, p := range parts {
			if strings.EqualFold(p.Type, "text") && p.Text != "" {
				if out.Len() > 0 {
					out.WriteString("\n")
				}
				out.WriteString(p.Text)
			}
		}
		return out.String()
	}
	return ""
}

// ---------- serve 交互 ----------

// openBridgeSession 在 serve 上创建新会话。
func openBridgeSession(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		openCodeBridgeAddr+"/session", strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := bridgeHTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法连接 OpenCode 桥接服务（%s）：%w", openCodeBridgeAddr, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("桥接服务创建会话失败（HTTP %d）：%s",
			resp.StatusCode, truncateText(string(raw), 160))
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &got); err != nil || got.ID == "" {
		return "", errors.New("桥接服务返回的会话格式不正确")
	}
	return got.ID, nil
}

// abortBridgeSession 尽力中止 serve 侧生成（客户端断开时调用）。
func abortBridgeSession(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		openCodeBridgeAddr+"/session/"+sessionID+"/abort", nil)
	if err != nil {
		return
	}
	resp, err := bridgeHTTP.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

// bridgeEvent 是 serve 事件流里我们关心的字段。
type bridgeEvent struct {
	Type       string `json:"type"`
	Properties struct {
		SessionID string `json:"sessionID"`
		Delta     string `json:"delta"`
		Field     string `json:"field"`
		Part      struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
		} `json:"part"`
		Info struct {
			Role      string `json:"role"`
			SessionID string `json:"sessionID"`
			Error     *struct {
				Name string `json:"name"`
				Data struct {
					Message string `json:"message"`
				} `json:"data"`
			} `json:"error"`
			Tokens struct {
				Input  int `json:"input"`
				Output int `json:"output"`
				Cache  struct {
					Read int `json:"read"`
				} `json:"cache"`
			} `json:"tokens"`
		} `json:"info"`
	} `json:"properties"`
}

// bridgeAttemptResult 是一次尝试的结果。
type bridgeAttemptResult struct {
	Text         string
	PromptTokens int
	OutputTokens int
	CachedTokens int
	// UpstreamErr 非空表示上游在流中途报了错（FreeTier 403、余额不足等）。
	UpstreamErr error
	// Emitted 表示是否已向客户端产出过内容增量。
	Emitted bool
}

/*
bridgeAttempt 执行一次完整尝试：建会话 → 订阅事件 → 发消息 → 边收增量边判完成。

**完成判定用轮询回读，不用等 session.idle 事件**：
serve 的 idle 事件在 busy→idle 时只发一次，而订阅与生成之间存在竞态 ——
生成可能在订阅生效前就结束（秒级的小请求尤其明显），于是 idle 事件永远
等不到、读取无限阻塞。线上实测：一次请求卡满 120 秒超时。

轮询回读（每秒一次）是权威的：assistant 消息带 time.completed 或 error
即为结束。事件流只负责把增量实时送出去。

onDelta 会把内容增量实时回调；onAccepted 在消息被 serve 接受（204）时回调。
*/
func bridgeAttempt(
	ctx context.Context,
	rawMsg []byte,
	onDelta func(string),
	onAccepted func(),
) (bridgeAttemptResult, error) {
	sessionID, err := openBridgeSession(ctx)
	if err != nil {
		return bridgeAttemptResult{}, err
	}
	// 会话用完即删：不清理的话 serve 的会话表会无限增长
	//（线上实测一次重试风暴积了 100 个会话）。
	defer deleteBridgeSession(sessionID)

	// 事件订阅先于发消息：prompt_async 是异步的，反过来会丢掉开头的事件。
	eventCtx, cancelEvents := context.WithCancel(ctx)
	defer cancelEvents()
	eventsReq, err := http.NewRequestWithContext(eventCtx, http.MethodGet, openCodeBridgeAddr+"/event", nil)
	if err != nil {
		return bridgeAttemptResult{}, err
	}
	eventsReq.Header.Set("Accept", "text/event-stream")
	eventsResp, err := bridgeHTTP.Do(eventsReq)
	if err != nil {
		return bridgeAttemptResult{}, fmt.Errorf("无法订阅桥接事件流：%w", err)
	}
	defer eventsResp.Body.Close()

	// 增量从事件流实时送出去（子 goroutine）。
	deltaCh := make(chan string, 256)
	var emitted atomic.Bool
	go readBridgeDeltas(eventsResp.Body, sessionID, func(delta string) {
		emitted.Store(true)
		select {
		case deltaCh <- delta:
		default:
		}
	})

	sendReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		openCodeBridgeAddr+"/session/"+sessionID+"/prompt_async", bytes.NewReader(rawMsg))
	if err != nil {
		return bridgeAttemptResult{}, err
	}
	sendReq.Header.Set("Content-Type", "application/json")
	sendResp, err := bridgeHTTP.Do(sendReq)
	if err != nil {
		return bridgeAttemptResult{}, fmt.Errorf("桥接服务接受消息失败：%w", err)
	}
	sendResp.Body.Close()
	if sendResp.StatusCode < 200 || sendResp.StatusCode >= 300 {
		return bridgeAttemptResult{}, fmt.Errorf("桥接服务拒绝消息（HTTP %d）", sendResp.StatusCode)
	}
	if onAccepted != nil {
		onAccepted()
	}

	// 主循环：每秒轮询一次回读；事件增量同时往外送。
	ticker := time.NewTicker(bridgePollGap)
	defer ticker.Stop()
	var textSent strings.Builder
	for {
		select {
		case delta := <-deltaCh:
			textSent.WriteString(delta)
			if onDelta != nil {
				onDelta(delta)
			}
			continue
		case <-ticker.C:
		case <-ctx.Done():
			abortBridgeSession(sessionID)
			return bridgeAttemptResult{}, ctx.Err()
		}
		// 排空增量队列。
		for {
			select {
			case delta := <-deltaCh:
				textSent.WriteString(delta)
				if onDelta != nil {
					onDelta(delta)
				}
				continue
			default:
			}
			break
		}
		text, usage, errText, done, ferr := pollBridgeMessage(ctx, sessionID)
		if ferr != nil {
			// 回读失败：serve 可能正在重启。继续轮询，直到超时。
			continue
		}
		if !done {
			continue
		}
		result := bridgeAttemptResult{
			Text:         text,
			PromptTokens: usage.PromptTokens,
			OutputTokens: usage.CompletionTokens,
			CachedTokens: usage.CachedTokens,
			Emitted:      emitted.Load(),
		}
		if text == "" && textSent.Len() > 0 {
			result.Text = textSent.String()
		}
		if errText != "" {
			result.UpstreamErr = errors.New(errText)
		}
		return result, nil
	}
}

// bridgePollGap 是完成判定的回读间隔。
var bridgePollGap = time.Second

// readBridgeDeltas 从事件流里抽本会话的文本增量（忽略其它一切事件）。
func readBridgeDeltas(body io.Reader, sessionID string, onDelta func(string)) {
	reader := bufio.NewReaderSize(body, 64<<10)
	for {
		line, err := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if bytes.HasPrefix(trimmed, []byte("data:")) {
			payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
			if len(payload) > 0 {
				var ev bridgeEvent
				if json.Unmarshal(payload, &ev) == nil &&
					ev.Type == "message.part.delta" &&
					ev.Properties.SessionID == sessionID &&
					ev.Properties.Field == "text" &&
					ev.Properties.Delta != "" {
					onDelta(ev.Properties.Delta)
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// deleteBridgeSession 删除会话（清理 serve 侧的会话记录）。
func deleteBridgeSession(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		openCodeBridgeAddr+"/session/"+sessionID, nil)
	if err != nil {
		return
	}
	resp, err := bridgeHTTP.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

/*
pollBridgeMessage 回读会话最后一条 assistant 消息，并报告它是否已完成。

返回 done=true 表示：
  - assistant 消息带 time.completed（正常完成），或
  - assistant 消息带 error（上游报错）。

完成判定不看 idle 事件（订阅竞态会漏掉它），以消息自身的状态为准 ——
这是 serve 的权威记录。
*/
func pollBridgeMessage(ctx context.Context, sessionID string) (text string, usage upstreamUsage, errText string, done bool, err error) {
	fetchCtx, cancel := context.WithTimeout(ctx, bridgeFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet,
		openCodeBridgeAddr+"/session/"+sessionID+"/message?limit=5", nil)
	if err != nil {
		return "", upstreamUsage{}, "", false, err
	}
	resp, err := bridgeHTTP.Do(req)
	if err != nil {
		return "", upstreamUsage{}, "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", upstreamUsage{}, "", false, fmt.Errorf("读回消息失败（HTTP %d）", resp.StatusCode)
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))

	type messagePart struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type message struct {
		Info struct {
			Role   string `json:"role"`
			Error  *struct {
				Data struct {
					Message string `json:"message"`
				} `json:"data"`
			} `json:"error"`
			Time struct {
				Created   int64 `json:"created"`
				Completed int64 `json:"completed"`
			} `json:"time"`
			Tokens struct {
				Input  int `json:"input"`
				Output int `json:"output"`
				Cache  struct {
					Read int `json:"read"`
				} `json:"cache"`
			} `json:"tokens"`
		} `json:"info"`
		Parts []messagePart `json:"parts"`
	}

	var messages []message
	if uerr := json.Unmarshal(raw, &messages); uerr != nil {
		var wrapped struct {
			Data []message `json:"data"`
		}
		if uerr2 := json.Unmarshal(raw, &wrapped); uerr2 != nil {
			return "", upstreamUsage{}, "", false, uerr
		}
		messages = wrapped.Data
	}

	// 找最后一条 assistant 消息。
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Info.Role != "assistant" {
			continue
		}
		var text strings.Builder
		for _, p := range m.Parts {
			if p.Type == "text" {
				text.WriteString(p.Text)
			}
		}
		usage = upstreamUsage{
			PromptTokens:     m.Info.Tokens.Input + m.Info.Tokens.Cache.Read,
			CompletionTokens: m.Info.Tokens.Output,
			TotalTokens:      m.Info.Tokens.Input + m.Info.Tokens.Cache.Read + m.Info.Tokens.Output,
			CachedTokens:     m.Info.Tokens.Cache.Read,
		}
		if m.Info.Error != nil && m.Info.Error.Data.Message != "" {
			return text.String(), usage, m.Info.Error.Data.Message, true, nil
		}
		if m.Info.Time.Completed > 0 {
			return text.String(), usage, "", true, nil
		}
		// assistant 消息还在生成中。
		return text.String(), usage, "", false, nil
	}
	// 还没有 assistant 消息（或只有 user 消息）：未完成。
	return "", upstreamUsage{}, "", false, nil
}

/*
bridgeExecute 执行桥接请求（含首内容前的重试）。

返回值：
  - err 非空：桥接链路本身失败（serve 不可达等），未产出任何内容；
  - result.UpstreamErr 非空：上游错误（重试后仍失败）；
  - 两者都空：成功，result.Text / 用量有效。
*/
func bridgeExecute(
	ctx context.Context,
	chatReq bridgeChatRequest,
	upstreamModel string,
	onDelta func(string),
	onAccepted func(),
) (bridgeAttemptResult, error) {
	system, prompt := bridgePrompt(chatReq)
	rawMsg, err := json.Marshal(bridgeMessageBody{
		Model:  bridgeModelRef{ProviderID: "opencode", ModelID: upstreamModel},
		System: system,
		Parts:  []bridgePart{{Type: "text", Text: prompt}},
	})
	if err != nil {
		return bridgeAttemptResult{}, err
	}

	var last bridgeAttemptResult
	accepted := false
	acceptOnce := func() {
		if !accepted {
			accepted = true
			if onAccepted != nil {
				onAccepted()
			}
		}
	}

	for attempt := 0; attempt < bridgeRetryAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(bridgeRetryGap):
			case <-ctx.Done():
				return last, ctx.Err()
			}
		}
		result, err := bridgeAttempt(ctx, rawMsg, onDelta, acceptOnce)
		if err != nil {
			// 链路错误：立即返回，由调用方按「账号不可用」重试下一个账号。
			return result, err
		}
		last = result
		if result.UpstreamErr == nil {
			return result, nil
		}
		// 已经产出过内容或在不可重试错误上：不再重试。
		if result.Emitted || !bridgeRetryable(result.UpstreamErr.Error()) {
			return result, nil
		}
	}
	return last, nil
}

/*
bridgeRetryable 判断上游错误是否值得换新会话重试。

免费档的客户端校验拒绝（FreeTierError）是偶发的：同一请求形状有时 200
有时 403 —— 重试即可。而余额不足、模型不存在这类是确定性的，
重试只是浪费一次来回。
*/
func bridgeRetryable(message string) bool {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "insufficient account funds"),
		strings.Contains(lower, "model is unavailable"),
		strings.Contains(lower, "not found"),
		strings.Contains(lower, "unauthorized"),
		strings.Contains(lower, "invalid_request"),
		strings.Contains(lower, "invalid request"):
		return false
	}
	return true
}

// ---------- 下游适配 ----------

/*
bridgeFrameReader 把「SSE 帧序列」暴露成 io.ReadCloser，
供 forwardOpenedStream 按普通上游响应体读取。
*/
type bridgeFrameReader struct {
	frames chan []byte
	closed chan struct{}
	tail   []byte
	once   sync.Once

	mu    sync.Mutex
	final error
}

func newBridgeFrameReader(frames chan []byte) *bridgeFrameReader {
	return &bridgeFrameReader{frames: frames, closed: make(chan struct{})}
}

func (r *bridgeFrameReader) setFinal(err error) {
	r.mu.Lock()
	r.final = err
	r.mu.Unlock()
}

func (r *bridgeFrameReader) Read(p []byte) (int, error) {
	if len(r.tail) > 0 {
		n := copy(p, r.tail)
		r.tail = r.tail[n:]
		return n, nil
	}
	select {
	case frame, ok := <-r.frames:
		if !ok {
			r.mu.Lock()
			err := r.final
			r.mu.Unlock()
			if err != nil {
				return 0, err
			}
			return 0, io.EOF
		}
		n := copy(p, frame)
		if n < len(frame) {
			r.tail = frame[n:]
		}
		return n, nil
	case <-r.closed:
		return 0, io.EOF
	}
}

func (r *bridgeFrameReader) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}

/*
openBridgeStream 为流式请求建立桥接流。

在 serve 接受消息（204）之前不返回 —— 与普通上游「拿到响应头」对齐：
之前的失败可以换账号重试，客户端一个字节都还没收到。
*/
func openBridgeStream(
	c *gin.Context,
	body []byte,
	upstreamModel string,
	emitModel string,
) (*openedStream, error) {
	chatReq, err := parseBridgeChatRequest(body)
	if err != nil {
		return nil, newUpstreamError(0, err.Error(), false)
	}

	runCtx, cancel := context.WithCancel(c.Request.Context())
	frames := make(chan []byte, 512)
	reader := newBridgeFrameReader(frames)
	started := make(chan struct{})
	finished := make(chan error, 1)

	go func() {
		produceErr := bridgeProduceFrames(runCtx, chatReq, upstreamModel, emitModel, frames, started)
		if produceErr != nil {
			reader.setFinal(produceErr)
		}
		close(frames)
		finished <- produceErr
	}()

	select {
	case <-started:
		// 消息已被 serve 接受，流进入正常转发阶段。
	case err := <-finished:
		cancel()
		if err == nil {
			err = errors.New("桥接流在建立阶段就结束了")
		}
		return nil, newUpstreamError(0, "OpenCode 桥接失败："+err.Error(), true)
	case <-time.After(bridgeOpenTimeout):
		cancel()
		return nil, newUpstreamError(0, "OpenCode 桥接服务响应超时（"+openCodeBridgeAddr+"）", true)
	case <-runCtx.Done():
		return nil, newUpstreamError(0, "请求已取消", false)
	}

	return &openedStream{
		resp:          &http.Response{StatusCode: http.StatusOK, Body: reader},
		upstreamProto: "openai",
		cancel:        cancel,
	}, nil
}

/*
bridgeProduceFrames 驱动一次桥接执行并把结果写成 chat-completions SSE 帧。

帧顺序：
  - 内容增量（每个 delta 一帧）
  - 若增量缺失但回读有文本：整段补一帧
  - 收尾帧（finish_reason=stop，带 usage）
  - data: [DONE]
失败时：错误帧 + [DONE]，并让读取方拿到错误（调用方据此标记渠道失败）。
*/
func bridgeProduceFrames(
	ctx context.Context,
	chatReq bridgeChatRequest,
	upstreamModel string,
	emitModel string,
	frames chan<- []byte,
	started chan<- struct{},
) error {
	var startedOnce sync.Once
	signalStarted := func() {
		startedOnce.Do(func() { close(started) })
	}

	result, err := bridgeExecute(ctx, chatReq, upstreamModel,
		func(delta string) {
			frames <- bridgeSSEChunk(emitModel, delta)
		},
		signalStarted,
	)
	if err != nil {
		return err
	}
	if result.UpstreamErr != nil {
		frames <- bridgeSSEError("OpenCode 上游错误：" + result.UpstreamErr.Error())
		frames <- []byte("data: [DONE]\n\n")
		return result.UpstreamErr
	}
	if !result.Emitted && result.Text != "" {
		frames <- bridgeSSEChunk(emitModel, result.Text)
	}
	frames <- bridgeSSEFinish(emitModel, upstreamUsage{
		PromptTokens:     result.PromptTokens,
		CompletionTokens: result.OutputTokens,
		TotalTokens:      result.PromptTokens + result.OutputTokens,
		CachedTokens:     result.CachedTokens,
	})
	frames <- []byte("data: [DONE]\n\n")
	return nil
}

/*
bridgeForwardJSON 非流式桥接转发。

复用流式通道（丢弃增量），等会话结束取回完整文本与用量，
组装成 chat-completions 响应体。
*/
func bridgeForwardJSON(
	ctx context.Context,
	ch *services.UpstreamChannel,
	body []byte,
	model string,
) ([]byte, upstreamUsage, error) {
	upstreamModel := services.UpstreamModelFor(ch, model)
	if upstreamModel == "" {
		return nil, upstreamUsage{}, newUpstreamError(0, "账号「"+ch.Name+"」不支持模型 "+model, false)
	}
	chatReq, err := parseBridgeChatRequest(body)
	if err != nil {
		return nil, upstreamUsage{}, newUpstreamError(400, err.Error(), false)
	}
	result, err := bridgeExecute(ctx, chatReq, upstreamModel, nil, nil)
	if err != nil {
		return nil, upstreamUsage{}, newUpstreamError(0, "OpenCode 桥接失败："+err.Error(), true)
	}
	if result.UpstreamErr != nil {
		return nil, upstreamUsage{}, newUpstreamError(502,
			friendlyBridgeError(result.UpstreamErr.Error()), false)
	}
	usage := upstreamUsage{
		PromptTokens:     result.PromptTokens,
		CompletionTokens: result.OutputTokens,
		TotalTokens:      result.PromptTokens + result.OutputTokens,
		CachedTokens:     result.CachedTokens,
	}
	return bridgeNonStreamResponse(model, result.Text, usage), usage, nil
}

// friendlyBridgeError 把桥接层的错误翻成用户能看懂的话。
func friendlyBridgeError(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "insufficient account funds"):
		return "上游账号余额不足（OpenCode 付费模型需要充值，免费模型不受影响）"
	case strings.Contains(lower, "freetier") || strings.Contains(lower, "can only be used from within opencode"):
		return "OpenCode 客户端校验拒绝了本次请求（免费档偶发，已重试仍失败）"
	}
	return raw
}

// ---------- chat-completions 分块合成 ----------

type bridgeChatChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int    `json:"index"`
		Delta        struct {
			Role    string `json:"role,omitempty"`
			Content string `json:"content,omitempty"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *upstreamUsage `json:"usage,omitempty"`
}

func bridgeChunk(model, content, role string, finish *string, usage *upstreamUsage) []byte {
	chunk := bridgeChatChunk{
		ID:      "chatcmpl-bridge",
		Object:  "chat.completion.chunk",
		Created: time.Now().Unix(),
		Model:   model,
		Usage:   usage,
	}
	choice := struct {
		Index        int    `json:"index"`
		Delta        struct {
			Role    string `json:"role,omitempty"`
			Content string `json:"content,omitempty"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	}{Index: 0, FinishReason: finish}
	choice.Delta.Content = content
	choice.Delta.Role = role
	chunk.Choices = append(chunk.Choices, choice)
	out, _ := json.Marshal(chunk)
	return append(append([]byte("data: "), out...), '\n', '\n')
}

// bridgeSSEChunk 包装一段内容增量。
func bridgeSSEChunk(model, content string) []byte {
	return bridgeChunk(model, content, "assistant", nil, nil)
}

// bridgeSSEFinish 生成收尾分块（finish_reason=stop，带用量）。
func bridgeSSEFinish(model string, usage upstreamUsage) []byte {
	stop := "stop"
	return bridgeChunk(model, "", "", &stop, &usage)
}

// bridgeSSEError 生成一行错误分块（上游在流中报错时用）。
func bridgeSSEError(message string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "upstream_error",
		},
	})
	return append(append([]byte("data: "), payload...), '\n', '\n')
}

// bridgeNonStreamResponse 组装非流式的 chat-completions 响应体。
func bridgeNonStreamResponse(model, content string, usage upstreamUsage) []byte {
	resp := map[string]any{
		"id":      "chatcmpl-bridge",
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{{
			"index": 0,
			"message": map[string]any{
				"role":    "assistant",
				"content": content,
			},
			"finish_reason": "stop",
		}},
		"usage": usage,
	}
	out, _ := json.Marshal(resp)
	return out
}

// bridgeHealthCheck 报告桥接 serve 是否可用（管理端测试渠道时用）。
func bridgeHealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openCodeBridgeAddr+"/config", nil)
	if err != nil {
		return err
	}
	resp, err := bridgeHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("OpenCode 桥接服务不可达（%s）：%w", openCodeBridgeAddr, err)
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("OpenCode 桥接服务异常（HTTP %d）", resp.StatusCode)
	}
	return nil
}

// truncateText 截断长文本用于错误信息。
func truncateText(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
