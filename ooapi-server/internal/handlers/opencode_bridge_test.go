package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// ginTestContext 构造一个带请求的 gin 测试上下文。
func ginTestContext() (*gin.Context, *httptest.ResponseRecorder) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	return c, w
}

// fakeServe 是 opencode serve 的最小模拟：建会话、收消息、发事件流。
type fakeServe struct {
	mu       sync.Mutex
	sessions int
	lastBody map[string]any
	events   []string // 每次 prompt 要回放的事件（data: 行）
	promptCh chan struct{}
	// replied 为真时 /message 返回一条已完成的 assistant 消息，
	// 文本取自回放事件里的 delta（真实 serve 的行为：消息在生成后可得）。
	replied  bool
	replyTxt string
	errMsg   string
}

func newFakeServe() *fakeServe {
	return &fakeServe{promptCh: make(chan struct{}, 16)}
}

func (f *fakeServe) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		f.mu.Lock()
		f.sessions++
		id := "ses_test_" + strings.Repeat("a", 20)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"` + id + `"}`))
	})
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/prompt_async"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			// 从预置事件里抽出增量文本与错误，直接标记「已完成」——
			// 短轮询实现不再订阅 /event，完成状态全靠 /message 回读。
			var sb strings.Builder
			errMsg := ""
			f.mu.Lock()
			f.lastBody = body
			for _, ev := range f.events {
				var parsed struct {
					Type       string `json:"type"`
					Properties struct {
						Delta string `json:"delta"`
						Info  struct {
							Error *struct {
								Data struct {
									Message string `json:"message"`
								} `json:"data"`
							} `json:"error"`
						} `json:"info"`
					} `json:"properties"`
				}
				if json.Unmarshal([]byte(ev), &parsed) == nil {
					if parsed.Type == "message.part.delta" {
						sb.WriteString(parsed.Properties.Delta)
					}
					if parsed.Properties.Info.Error != nil {
						errMsg = parsed.Properties.Info.Error.Data.Message
					}
				}
			}
			f.replyTxt = sb.String()
			f.errMsg = errMsg
			f.replied = true
			f.mu.Unlock()
			select {
			case f.promptCh <- struct{}{}:
			default:
			}
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(path, "/message"):
			w.Header().Set("Content-Type", "application/json")
			f.mu.Lock()
			replied, txt, errMsg := f.replied, f.replyTxt, f.errMsg
			f.mu.Unlock()
			if !replied {
				// 还没生成完：只有 user 消息。
				_, _ = w.Write([]byte(`[{"info":{"role":"user"},"parts":[{"type":"text","text":"hi"}]}]`))
				return
			}
			errPart := "null"
			if errMsg != "" {
				errPart = `{"name":"APIError","data":{"message":"` + errMsg + `"}}`
			}
			// time.completed 非零 = 完成（完成判定的依据）。
			_, _ = w.Write([]byte(`[{"info":{"role":"assistant","error":` + errPart +
				`,"time":{"created":1,"completed":2},"tokens":{"input":11,"output":7,"cache":{"read":2}}},"parts":[{"type":"text","text":"` + txt + `"}]}]`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	return mux
}

func useFakeServe(t *testing.T, f *fakeServe) {
	t.Helper()
	server := httptest.NewServer(f.handler())
	t.Cleanup(server.Close)
	old := openCodeBridgeAddr
	SetOpenCodeBridgeAddr(server.URL)
	t.Cleanup(func() { openCodeBridgeAddr = old })
}

// 会话事件：一段增量 + idle。
func streamEvents(deltas ...string) []string {
	events := []string{
		`{"type":"message.updated","properties":{"sessionID":"ses_test_` + strings.Repeat("a", 20) + `","info":{"role":"assistant","tokens":{"input":11,"output":0,"cache":{"read":2}}}}}`,
	}
	for _, d := range deltas {
		payload, _ := json.Marshal(map[string]any{
			"type": "message.part.delta",
			"properties": map[string]any{
				"sessionID": "ses_test_" + strings.Repeat("a", 20),
				"field":     "text",
				"delta":     d,
			},
		})
		events = append(events, string(payload))
	}
	events = append(events,
		`{"type":"message.updated","properties":{"sessionID":"ses_test_`+strings.Repeat("a", 20)+`","info":{"role":"assistant","tokens":{"input":11,"output":7,"cache":{"read":2}}}}}`,
		`{"type":"session.idle","properties":{"sessionID":"ses_test_`+strings.Repeat("a", 20)+`"}}`,
	)
	return events
}

// prompt 翻译：单轮 user 不带角色前缀，system 进独立字段。
func TestBridgePromptSingleTurn(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hello"}]}`)
	req, err := parseBridgeChatRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	system, prompt := bridgePrompt(req)
	if system != "be brief" {
		t.Fatalf("system = %q", system)
	}
	if prompt != "hello" {
		t.Fatalf("prompt = %q, want bare text", prompt)
	}
}

// prompt 翻译：多轮带角色标注。
func TestBridgePromptMultiTurn(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}]}`)
	req, _ := parseBridgeChatRequest(body)
	_, prompt := bridgePrompt(req)
	want := "User: a\n\nAssistant: b\n\nUser: c"
	if prompt != want {
		t.Fatalf("prompt = %q want %q", prompt, want)
	}
}

// content 数组格式（多模态分段）取文本部分。
func TestBridgeContentParts(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"x"}}]}]}`)
	req, _ := parseBridgeChatRequest(body)
	_, prompt := bridgePrompt(req)
	if prompt != "hi" {
		t.Fatalf("prompt = %q, want hi", prompt)
	}
}

/*
回归测试：桥接请求体不得携带 tools 字段。

线上实证：请求里出现 tools 开关表（哪怕全是 false）会被上游
100% 以 FreeTierError 拒绝 —— 官方 CLI 从不在请求里带这个字段。
这里把这个约束钉死，防止「顺手加个工具禁用」把桥接打挂。
*/
func TestBridgeKeepsDefaultTools(t *testing.T) {
	fake := newFakeServe()
	useFakeServe(t, fake)
	fake.mu.Lock()
	fake.events = streamEvents("ok")
	fake.mu.Unlock()

	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	req, _ := parseBridgeChatRequest(body)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := bridgeExecute(ctx, req, "big-pickle", nil, nil); err != nil {
		t.Fatalf("bridgeExecute: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if _, present := fake.lastBody["tools"]; present {
		t.Fatalf("请求体里出现了 tools 字段（会触发上游拒绝）：%#v", fake.lastBody["tools"])
	}
	if model, _ := fake.lastBody["model"].(map[string]any); model == nil || model["modelID"] != "big-pickle" {
		t.Fatalf("model 字段不正确: %#v", fake.lastBody["model"])
	}
}

// 流式：增量 + 收尾帧 + [DONE]。
func TestBridgeStreamProducesChatSSE(t *testing.T) {
	fake := newFakeServe()
	useFakeServe(t, fake)
	fake.mu.Lock()
	fake.events = streamEvents("He", "llo")
	fake.mu.Unlock()

	c, _ := ginTestContext()
	opened, err := openBridgeStream(c, []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`), "big-pickle", "client-model")
	if err != nil {
		t.Fatalf("openBridgeStream: %v", err)
	}
	raw, err := io.ReadAll(opened.resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	text := string(raw)
	// 增量可能被合并成更少的帧（轮询取「比上轮多出来的部分」）——
	// 断言的是「内容完整且按序」，不是「分帧数量」。
	if !strings.Contains(text, `"Hello"`) {
		t.Fatalf("流里缺少完整内容增量:\n%s", text)
	}
	if !strings.Contains(text, `"finish_reason":"stop"`) {
		t.Fatalf("流里缺少收尾帧:\n%s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Fatalf("流里缺少 [DONE]:\n%s", text)
	}
	// 模型名必须是客户端请求的名字，而不是上游名。
	if !strings.Contains(text, `"model":"client-model"`) {
		t.Fatalf("流里的模型名没有回显客户端名字:\n%s", text)
	}
	if !strings.Contains(text, `"prompt_tokens":13`) {
		t.Fatalf("收尾帧缺少用量（input+cache=13）:\n%s", text)
	}
}

// 上游错误：错误帧 + [DONE]，且返回值携带错误。
func TestBridgeStreamReportsUpstreamError(t *testing.T) {
	fake := newFakeServe()
	useFakeServe(t, fake)
	bridgeRetryGap = time.Millisecond
	t.Cleanup(func() { bridgeRetryGap = 400 * time.Millisecond })
	sid := "ses_test_" + strings.Repeat("a", 20)
	fake.mu.Lock()
	fake.events = []string{
		`{"type":"message.updated","properties":{"sessionID":"` + sid + `","info":{"role":"assistant","error":{"name":"APIError","data":{"message":"Insufficient account funds"}}}}}`,
	}
	fake.mu.Unlock()
	bridgeRetryGap = time.Millisecond
	t.Cleanup(func() { bridgeRetryGap = 400 * time.Millisecond })

	c, _ := ginTestContext()
	opened, err := openBridgeStream(c, []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`), "glm-5.3", "m")
	if err == nil {
		// 建立阶段的偶发 403 会走重试；确定性错误（余额不足）不应重试。
		raw, _ := io.ReadAll(opened.resp.Body)
		if !strings.Contains(string(raw), "Insufficient account funds") {
			t.Fatalf("错误帧缺失：%s", string(raw))
		}
		if !strings.Contains(string(raw), "data: [DONE]") {
			t.Fatalf("错误路径也要有 [DONE]：%s", string(raw))
		}
		return
	}
	t.Fatalf("openBridgeStream 不应在建立阶段失败（错误发生在流内）: %v", err)
}

// 不可重试错误只尝试一次；可重试错误换新会话重试。
func TestBridgeRetryPolicy(t *testing.T) {
	if bridgeRetryable("Insufficient account funds") {
		t.Fatal("余额不足不应重试")
	}
	if bridgeRetryable("Model is unavailable") {
		t.Fatal("模型不可用不应重试")
	}
	if !bridgeRetryable("OpenCode's free tier can only be used from within OpenCode.") {
		t.Fatal("免费档偶发拒绝应当重试")
	}
	if !bridgeRetryable("some transient upstream glitch") {
		t.Fatal("未知错误应允许重试（保守选择：重试优于直接失败）")
	}
}

// 桥接地址识别：只有 opencode 厂商 + opencode.ai 域走桥接。
func TestUsesOpenCodeBridge(t *testing.T) {
	cases := []struct {
		vendor, base string
		want         bool
	}{
		{"opencode", "https://opencode.ai/zen/v1", true},
		{"opencode", "https://opencode.ai/inference/v1", true},
		{"opencode", "https://api.other.com/v1", false},
		{"openai", "https://opencode.ai/zen/v1", false},
		{"cline", "https://api.cline.bot/api/v1", false},
	}
	for _, c := range cases {
		ch := &services.UpstreamChannel{Vendor: c.vendor, BaseURL: c.base}
		if got := services.UsesOpenCodeBridge(ch); got != c.want {
			t.Fatalf("%s/%s = %v want %v", c.vendor, c.base, got, c.want)
		}
	}
	// 显式开关也能打开（测试与特殊部署）。
	if !services.UsesOpenCodeBridge(&services.UpstreamChannel{Bridge: true, Vendor: "x", BaseURL: "https://x"}) {
		t.Fatal("Bridge 显式开关失效")
	}
}

// 非流式响应装配。
func TestBridgeNonStreamResponse(t *testing.T) {
	raw := bridgeNonStreamResponse("client-model", "hello", upstreamUsage{PromptTokens: 5, CompletionTokens: 2, TotalTokens: 7})
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "client-model" || got["object"] != "chat.completion" {
		t.Fatalf("响应外壳不正确: %#v", got)
	}
	choices := got["choices"].([]any)
	msg := choices[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "hello" {
		t.Fatalf("content = %#v", msg["content"])
	}
}

/*
回归测试：事件流没有错误事件，但回读消息里带 error。

线上实证过这个洞：serve 的 403 发生在订阅生效之前，
事件流里没有任何错误痕迹，早先的实现把「空回答」返回给了用户。
错误检测必须以回读为权威来源。
*/
func TestBridgeDetectsErrorViaMessageReadback(t *testing.T) {
	sid := "ses_test_" + strings.Repeat("a", 20)
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"` + sid + `"}`))
	})
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		// 只有一条 idle：没有任何错误事件（模拟订阅竞态）。
		idle := `data: {"type":"session.idle","properties":{"sessionID":"` + sid + `"}}

`
		_, _ = w.Write([]byte(idle))
	})
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/prompt_async") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/message") {
			// 回读：assistant 消息带 error、无文本。
			mu.Lock()
			defer mu.Unlock()
			_, _ = w.Write([]byte(`[{"info":{"role":"assistant","error":{"name":"APIError","data":{"message":"Insufficient account funds"}},"tokens":{"input":5,"output":0,"cache":{"read":0}}},"parts":[]}]`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	old := openCodeBridgeAddr
	SetOpenCodeBridgeAddr(server.URL)
	t.Cleanup(func() { openCodeBridgeAddr = old })

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, _ := parseBridgeChatRequest([]byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	result, err := bridgeExecute(ctx, req, "glm-5.3", nil, nil)
	if err != nil {
		t.Fatalf("bridgeExecute: %v", err)
	}
	if result.UpstreamErr == nil {
		t.Fatal("回读里的错误没有被识别（这正是线上那个 bug）")
	}
	if !strings.Contains(result.UpstreamErr.Error(), "Insufficient account funds") {
		t.Fatalf("错误内容不正确: %v", result.UpstreamErr)
	}
}
