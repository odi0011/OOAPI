package handlers

import (
	"database/sql/driver"
	"encoding/json"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// billing_test.go 覆盖「按次计费快照 + 内容捕获」：
//   · settle 写进 logs 的计费数字（raw_cost / base_quota / 单价 / 倍率）
//   · 请求文本抽取（数组分段 content、最后一条 user 消息、截断标记）
//   · 流式与非流式的输出累积
//
// 全部走 caller_clients_test.go 里的内存驱动，不需要真实数据库。

// makeCachedUsage 造一个带缓存用量的 usage（匿名结构体与 upstreamUsage 的定义一致）。
func makeCachedUsage(prompt, completion, cached int) upstreamUsage {
	u := upstreamUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: prompt + completion}
	u.PromptDetails = &struct {
		CachedTokens int `json:"cached_tokens"`
	}{CachedTokens: cached}
	return u
}

// findLogInsert 从驱动记录里找出日志 INSERT。
func findLogInsert(t *testing.T, d *callerTestDriver) callerTestExec {
	t.Helper()
	for _, ex := range d.execs {
		if strings.Contains(ex.query, "INSERT INTO logs") {
			return ex
		}
	}
	t.Fatalf("no logs insert captured: %+v", d.execs)
	return callerTestExec{}
}

// priceRowsFor 构造只对指定模型返回价格的驱动查询函数。
// 列清单与 services.PriceOf / ListPrices 的 SELECT 一致（含 context_tiers）。
func priceRowsFor(t *testing.T, model string, input, output, cached float64) func(string, []driver.NamedValue) (driver.Rows, error) {
	t.Helper()
	priceCols := func(rows ...[]driver.Value) *callerTestRows {
		return &callerTestRows{
			columns: []string{"model", "input_price", "output_price", "cached_price", "context_tiers"},
			values:  rows,
		}
	}
	return func(q string, args []driver.NamedValue) (driver.Rows, error) {
		if strings.Contains(q, "FROM model_prices") {
			if len(args) > 0 && args[0].Value == model {
				// 第五列模拟 SQL 侧 COALESCE(context_tiers, '')
				// 的产物：假驱动不做 SQL 求值，返回 NULL 会扫描失败。
				return priceCols([]driver.Value{model, input, output, cached, ""}), nil
			}
			return priceCols(), nil
		}
		return &callerTestRows{columns: []string{"k", "v"}}, nil
	}
}

func TestSettleBillingSnapshotCaptured(t *testing.T) {
	d := &callerTestDriver{}
	d.query = priceRowsFor(t, "upstream-model", 2, 4, 0.5)
	useCallerTestDB(t, d)

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)

	token := &apiToken{ID: 2, UserID: 3, UserAgent: "codex/1.0", CallerClient: "codex"}
	ch := &services.UpstreamChannel{ID: 4, Name: "up"}

	settle(c, token, &services.Group{Rate: 1.5}, ch, "alias-model",
		makeCachedUsage(1000, 2000, 500), time.Now(), 0, LogTypeCall, "",
		billingSnapshot{
			RequestedModel: "alias-model",
			UpstreamModel:  "upstream-model",
			PricingModel:   "upstream-model",
			InputText:      "用户问题",
			PromptText:     "[user] 用户问题\n",
			OutputText:     "模型回答",
		})

	ex := findLogInsert(t, d)
	if n := strings.Count(ex.query, "?"); n != len(ex.args) {
		t.Fatalf("placeholder mismatch: %d placeholders, %d args", n, len(ex.args))
	}
	for _, col := range []string{"requested_model", "upstream_model", "pricing_model",
		"input_price", "output_price", "cached_price", "group_rate", "base_quota", "raw_cost",
		"input_text", "prompt_text", "output_text", "text_truncated"} {
		if !strings.Contains(ex.query, col) {
			t.Fatalf("log insert missing snapshot column %s: %s", col, ex.query)
		}
	}

	// 快照列在 model(user_id/token_id/channel_id/type/model) 之后。
	if got := ex.args[5].Value; got != "alias-model" {
		t.Fatalf("requested_model = %v, want alias-model", got)
	}
	if got := ex.args[6].Value; got != "upstream-model" {
		t.Fatalf("upstream_model = %v, want upstream-model", got)
	}
	if got := ex.args[7].Value; got != "upstream-model" {
		t.Fatalf("pricing_model = %v, want upstream-model", got)
	}
	if got := ex.args[11].Value; got != float64(2) {
		t.Fatalf("input_price = %v, want 2", got)
	}
	if got := ex.args[12].Value; got != float64(4) {
		t.Fatalf("output_price = %v, want 4", got)
	}
	if got := ex.args[13].Value; got != float64(0.5) {
		t.Fatalf("cached_price = %v, want 0.5", got)
	}
	if got := ex.args[14].Value; got != float64(1.5) {
		t.Fatalf("group_rate = %v, want 1.5", got)
	}

	// 与 CalcQuota 对拍：raw_cost 是取整前的表达式 × unitsPerUnit。
	price := services.ModelPrice{Model: "upstream-model", InputPrice: 2, OutputPrice: 4, CachedPrice: 0.5}
	wantRaw := (1000.0/1e6*2 + 2000.0/1e6*4 + 500.0/1e6*0.5) * float64(services.DefaultUnitsPerOD)
	wantBase := services.CalcQuota(1000, 2000, 500, price, services.DefaultUnitsPerOD)
	if wantBase != 103 {
		t.Fatalf("fixture math changed: CalcQuota = %d, want 103", wantBase)
	}
	if got, ok := ex.args[15].Value.(int64); !ok || got != wantBase {
		t.Fatalf("base_quota = %v, want %d", ex.args[15].Value, wantBase)
	}
	if got, ok := ex.args[16].Value.(float64); !ok || math.Abs(got-wantRaw) > 1e-6 {
		t.Fatalf("raw_cost = %v, want %v", ex.args[16].Value, wantRaw)
	}
	wantQuota := services.ApplyGroupRate(wantBase, 1.5)
	if got, ok := ex.args[17].Value.(int64); !ok || got != wantQuota {
		t.Fatalf("quota = %v, want %d", ex.args[17].Value, wantQuota)
	}
	if wantQuota != 155 {
		t.Fatalf("fixture rate math changed: quota = %d, want 155", wantQuota)
	}
	if got := ex.args[22].Value; got != "用户问题" {
		t.Fatalf("input_text = %v", got)
	}
	if got := ex.args[23].Value; got != "[user] 用户问题\n" {
		t.Fatalf("prompt_text = %v", got)
	}
	if got := ex.args[24].Value; got != "模型回答" {
		t.Fatalf("output_text = %v", got)
	}
	if got := ex.args[25].Value; got != false {
		t.Fatalf("text_truncated = %v, want false", got)
	}

	// 扣费仍按现有公式：quota 进 tokens/users。
	var charged bool
	for _, e := range d.execs {
		if strings.Contains(e.query, "UPDATE tokens SET used_quota = used_quota + ?") {
			charged = true
			if got, ok := e.args[0].Value.(int64); !ok || got != wantQuota {
				t.Fatalf("charged units = %v, want %d", e.args[0].Value, wantQuota)
			}
		}
	}
	if !charged {
		t.Fatal("token quota was not charged")
	}
}

func TestSettlePriceLookupUsesPricingModel(t *testing.T) {
	d := &callerTestDriver{}
	// 价格只配在 upstream-model 上；按 alias 查会查不到。
	d.query = priceRowsFor(t, "upstream-model", 10, 10, 0)
	useCallerTestDB(t, d)

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/messages", nil)
	token := &apiToken{ID: 1, UserID: 1}
	ch := &services.UpstreamChannel{ID: 1, Name: "up"}

	settle(c, token, &services.Group{Rate: 1}, ch, "claude-sonnet-4-5",
		makeCachedUsage(1000, 1000, 0), time.Now(), 0, LogTypeCall, "",
		billingSnapshot{
			RequestedModel: "claude-sonnet-4-5",
			UpstreamModel:  "upstream-model",
			PricingModel:   "upstream-model",
		})

	ex := findLogInsert(t, d)
	if got := ex.args[4].Value; got != "claude-sonnet-4-5" {
		t.Fatalf("model column = %v, want the passed model", got)
	}
	if got := ex.args[6].Value; got != "upstream-model" {
		t.Fatalf("upstream_model = %v", got)
	}
	if got, ok := ex.args[15].Value.(int64); !ok || got != 200 {
		// (1000/1e6*10 + 1000/1e6*10) * 10000 = 200
		t.Fatalf("base_quota = %v, want 200 (price must be looked up by pricing model)", ex.args[15].Value)
	}
}

func TestSettleUnpricedModelKeepsZeroSnapshot(t *testing.T) {
	d := &callerTestDriver{}
	d.query = priceRowsFor(t, "some-other-model", 1, 1, 0) // 本型号没配价
	useCallerTestDB(t, d)

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	token := &apiToken{ID: 1, UserID: 1}
	ch := &services.UpstreamChannel{ID: 1, Name: "up"}

	settle(c, token, nil, ch, "no-price-model", makeCachedUsage(500, 500, 0),
		time.Now(), 0, LogTypeCall, "", billingSnapshot{RequestedModel: "no-price-model"})

	ex := findLogInsert(t, d)
	if got, ok := ex.args[15].Value.(int64); !ok || got != 0 {
		t.Fatalf("base_quota = %v, want 0", ex.args[15].Value)
	}
	if got, ok := ex.args[16].Value.(float64); !ok || got != 0 {
		t.Fatalf("raw_cost = %v, want 0", ex.args[16].Value)
	}
	if got, ok := ex.args[17].Value.(int64); !ok || got != 0 {
		t.Fatalf("quota = %v, want 0", ex.args[17].Value)
	}
	if got, ok := ex.args[14].Value.(float64); !ok || got != 0 {
		t.Fatalf("group_rate = %v, want 0 for nil group", ex.args[14].Value)
	}
	for _, e := range d.execs {
		if strings.Contains(e.query, "SET used_quota") {
			t.Fatalf("unpriced call must not charge: %s", e.query)
		}
	}
}

func TestSettleTruncatesAndFlagsTexts(t *testing.T) {
	d := &callerTestDriver{}
	d.query = priceRowsFor(t, "m", 1, 1, 0)
	useCallerTestDB(t, d)

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	token := &apiToken{ID: 1, UserID: 1}
	ch := &services.UpstreamChannel{ID: 1, Name: "up"}

	settle(c, token, &services.Group{Rate: 1}, ch, "m", upstreamUsage{}, time.Now(), 0,
		LogTypeChannelFail, "boom", billingSnapshot{
			RequestedModel: "m",
			InputText:      strings.Repeat("字", 4100),
			PromptText:     strings.Repeat("p", 3999),
			OutputText:     strings.Repeat("o", 5000),
		})

	ex := findLogInsert(t, d)
	in, _ := ex.args[22].Value.(string)
	if utf8.RuneCountInString(in) != logTextLimit {
		t.Fatalf("input_text runes = %d, want %d", utf8.RuneCountInString(in), logTextLimit)
	}
	prompt, _ := ex.args[23].Value.(string)
	if utf8.RuneCountInString(prompt) != 3999 {
		t.Fatalf("prompt_text should stay untruncated: %d runes", utf8.RuneCountInString(prompt))
	}
	out, _ := ex.args[24].Value.(string)
	if utf8.RuneCountInString(out) != logTextLimit {
		t.Fatalf("output_text runes = %d, want %d", utf8.RuneCountInString(out), logTextLimit)
	}
	if got := ex.args[25].Value; got != true {
		t.Fatalf("text_truncated = %v, want true", got)
	}
}

func TestExtractInputTextPicksLastUserMessage(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "array content parts are joined",
			body: `{"messages":[
				{"role":"system","content":"sys"},
				{"role":"user","content":[{"type":"text","text":"hello "},{"type":"text","text":"world"}]}
			]}`,
			want: "hello world",
		},
		{
			name: "last user message wins, assistant/tool ignored",
			body: `{"messages":[
				{"role":"user","content":"first"},
				{"role":"assistant","content":"answer"},
				{"role":"user","content":[{"type":"text","text":"second"}]}
			]}`,
			want: "second",
		},
		{
			name: "no user message",
			body: `{"messages":[{"role":"system","content":"sys"}]}`,
			want: "",
		},
		{
			name: "invalid json",
			body: `not-json`,
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractInputText([]byte(tc.body)); got != tc.want {
				t.Fatalf("extractInputText = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractPromptTextBuildsUpstreamContext(t *testing.T) {
	body := []byte(`{"messages":[
		{"role":"system","content":"be brief"},
		{"role":"user","content":"hi"},
		{"role":"assistant","content":null,"tool_calls":[{"function":{"name":"lookup","arguments":"{\"q\":1}"}}]},
		{"role":"tool","content":"result","tool_call_id":"t1"}
	]}`)
	got := extractPromptText(body)
	for _, want := range []string{"[system] be brief", "[user] hi", `[tool_call] lookup({"q":1})`, "[tool] result"} {
		if !strings.Contains(got, want) {
			t.Fatalf("prompt text %q missing %q", got, want)
		}
	}
	if strings.Index(got, "[system]") > strings.Index(got, "[user]") {
		t.Fatalf("prompt text out of order: %q", got)
	}
}

func TestOutputTextFromChatResponse(t *testing.T) {
	raw := []byte(`{
		"choices":[{"message":{
			"content":"正文",
			"reasoning_content":"思考",
			"tool_calls":[{"function":{"name":"f","arguments":"{\"a\":1}"}}]
		}}]}`)
	got := outputTextFromChatResponse(raw)
	for _, want := range []string{"正文", "思考", `[tool_call] f({"a":1})`} {
		if !strings.Contains(got, want) {
			t.Fatalf("output text %q missing %q", got, want)
		}
	}
	if outputTextFromChatResponse([]byte(`{"choices":[]}`)) != "" {
		t.Fatal("empty response must yield empty output text")
	}
	if outputTextFromChatResponse([]byte(`bad`)) != "" {
		t.Fatal("invalid json must yield empty output text")
	}
}

func TestOutputCaptureAccumulatesStreamDeltas(t *testing.T) {
	acc := &outputCapture{}
	lines := []string{
		`data: {"choices":[{"delta":{"role":"assistant"}}]}`,      // role 空壳：忽略
		`data: {"choices":[{"delta":{"content":"你好"}}]}`,          // 正文
		`data: {"choices":[{"delta":{"reasoning_content":"想"}}]}`, // 思考
		`data: {"choices":[{"delta":{"reasoning":"一下"}}]}`,        // 另一种思考字段
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\"city\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"SH\"}"}}]}}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}`, // usage 尾包：忽略
		`data: [DONE]`,
	}
	for _, line := range lines {
		acc.addSSELine([]byte(line))
	}

	got := acc.text()
	for _, want := range []string{"你好", "想一下", `[tool_call] get_weather({"city":"SH"})`} {
		if !strings.Contains(got, want) {
			t.Fatalf("captured output %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "assistant") || strings.Contains(got, "prompt_tokens") {
		t.Fatalf("role-only/usage-only chunks leaked into output: %q", got)
	}
}

func TestOutputCaptureStopsAtCap(t *testing.T) {
	acc := &outputCapture{}
	chunk := strings.Repeat("a", 2000)
	for i := 0; i < 6; i++ {
		line, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{"delta": map[string]any{"content": chunk}}},
		})
		acc.addSSELine([]byte("data: " + string(line)))
	}
	got := acc.text()
	if n := utf8.RuneCountInString(got); n > maxCapturedOutputChars {
		t.Fatalf("captured output %d runes, cap is %d", n, maxCapturedOutputChars)
	}
	if got == "" {
		t.Fatal("nothing captured")
	}
}

func TestTruncateLogText(t *testing.T) {
	text, cut := truncateLogText("short", logTextLimit)
	if text != "short" || cut {
		t.Fatalf("short text mangled: %q cut=%v", text, cut)
	}
	long, cut := truncateLogText(strings.Repeat("汉", logTextLimit+10), logTextLimit)
	if !cut || utf8.RuneCountInString(long) != logTextLimit {
		t.Fatalf("long text not truncated to %d runes (cut=%v)", logTextLimit, cut)
	}
	nul, _ := truncateLogText("a\x00b", logTextLimit)
	if strings.ContainsRune(nul, 0) {
		t.Fatalf("NUL survived truncation: %q", nul)
	}
	// 空串照写，不转 NULL：新记录用「已采集但为空」与历史记录的
	// 「根本没保存（NULL）」区分，页面对两者显示的文案不同。
	if v := logTextValue(""); v != "" {
		t.Fatalf("empty text must stay an empty string, got %#v", v)
	}
	if v := logTextValue("abc"); v != "abc" {
		t.Fatalf("non-empty text mangled: %#v", v)
	}
}
