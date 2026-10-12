package handlers

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"

	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

type kiroTransportMock func(*http.Request) (*http.Response, error)

func (f kiroTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// mockKiroResolver 替换凭据解析函数（测试不碰数据库）。
func mockKiroResolver(t *testing.T, cred services.KiroCredential, err error) {
	t.Helper()
	old := resolveKiroCredential
	resolveKiroCredential = func(context.Context, int64) (services.KiroCredential, error) { return cred, err }
	t.Cleanup(func() { resolveKiroCredential = old })
}

// kiroFrame 构造一帧 AWS EventStream 消息（CRC 置零：解析器不做 CRC 校验）。
func kiroFrame(eventType, messageType, payload string) []byte {
	headers := []byte{}
	add := func(name string, kind byte, value string) {
		headers = append(headers, byte(len(name)))
		headers = append(headers, name...)
		headers = append(headers, kind)
		if kind == 7 {
			headers = append(headers, byte(len(value)>>8), byte(len(value)))
			headers = append(headers, value...)
		}
	}
	add(":event-type", 7, eventType)
	add(":content-type", 7, "application/json")
	add(":message-type", 7, messageType)
	total := 12 + len(headers) + len(payload) + 4
	out := make([]byte, 12, total)
	binary.BigEndian.PutUint32(out[0:], uint32(total))
	binary.BigEndian.PutUint32(out[4:], uint32(len(headers)))
	out = append(out, headers...)
	out = append(out, payload...)
	out = append(out, 0, 0, 0, 0)
	return out
}

func TestKiroEventStreamParser(t *testing.T) {
	frame1 := kiroFrame("assistantResponseEvent", "event", `{"content":"你好"}`)
	frame2 := kiroFrame("messageMetadataEvent", "event", `{"tokenUsage":{"outputTokens":3}}`)
	// 故意在第二帧中间断开，验证增量解析。
	parser := &awsEventStreamParser{}
	events, err := parser.Push(append(append([]byte{}, frame1...), frame2[:len(frame2)/2]...))
	if err != nil || len(events) != 1 || events[0].EventType != "assistantResponseEvent" {
		t.Fatalf("first chunk %#v %v", events, err)
	}
	var got map[string]any
	json.Unmarshal(events[0].Payload, &got)
	if got["content"] != "你好" {
		t.Fatalf("payload %v", got)
	}
	events, err = parser.Push(frame2[len(frame2)/2:])
	if err != nil || len(events) != 1 || events[0].EventType != "messageMetadataEvent" {
		t.Fatalf("second chunk %#v %v", events, err)
	}
	if events[0].MessageType != "event" {
		t.Fatalf("message type %q", events[0].MessageType)
	}
	// 长度异常必须报错而不是无限等待。
	bad := make([]byte, 16)
	binary.BigEndian.PutUint32(bad[0:], 4)
	if _, err := (&awsEventStreamParser{}).Push(bad); err == nil {
		t.Fatal("bad frame length accepted")
	}
	if _, err := (&awsEventStreamParser{}).Push(make([]byte, 12)); err == nil {
		t.Fatal("zero-length frame accepted")
	}
}

func TestKiroParseHeadersTypes(t *testing.T) {
	headers := []byte{}
	appendStr := func(name string, kind byte, value []byte) {
		headers = append(headers, byte(len(name)))
		headers = append(headers, name...)
		headers = append(headers, kind)
		headers = append(headers, value...)
	}
	// string
	headers = append(headers, byte(5))
	headers = append(headers, ":type"...)
	headers = append(headers, 7, 0, 3)
	headers = append(headers, 'a', 'b', 'c')
	// int32
	appendStr("num", 4, []byte{0, 0, 0, 7})
	// bool true / false
	appendStr("yes", 0, nil)
	appendStr("no", 1, nil)
	// uuid 16B 跳过
	appendStr("uuid", 9, make([]byte, 16))
	// timestamp int64
	appendStr("ts", 8, []byte{0, 0, 0, 0, 0, 0, 0, 1})
	got := parseAwsEventHeaders(headers)
	if got[":type"] != "abc" || got["yes"] != "true" || got["no"] != "false" {
		t.Fatalf("headers %v", got)
	}
	if _, exists := got["uuid"]; exists {
		t.Fatal("uuid value should be skipped")
	}
	// 未知类型：直接结束，不恐慌。
	if out := parseAwsEventHeaders(appendStr2(12)); out == nil {
		t.Fatal("unknown type must return a map")
	}
}

func appendStr2(kind byte) []byte {
	out := []byte{5}
	out = append(out, ":bad:"...)
	out = append(out, kind)
	return out
}

func TestKiroBodyBuilderMapping(t *testing.T) {
	raw := `{
		"model":"claude-sonnet-5",
		"messages":[
			{"role":"system","content":"你是助手"},
			{"role":"developer","content":[{"type":"text","text":"规则B"}]},
			{"role":"user","content":"u1"},
			{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"sf\"}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"sunny"},
			{"role":"user","content":"u2"}
		],
		"tools":[{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]
	}`
	var in kiroChatRequest
	if json.Unmarshal([]byte(raw), &in) != nil {
		t.Fatal("unmarshal")
	}
	model := services.KiroModelID(in.Model)
	body, err := buildKiroConversation(13, model, in, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		ConversationState struct {
			ConversationID  string `json:"conversationId"`
			ChatTriggerType string `json:"chatTriggerType"`
			CurrentMessage  struct {
				UserInputMessage struct {
					Content             string `json:"content"`
					ModelID             string `json:"modelId"`
					Origin              string `json:"origin"`
					UserInputMessageCtx struct {
						Tools []struct {
							ToolSpecification struct {
								Name        string `json:"name"`
								Description string `json:"description"`
								InputSchema struct {
									JSON json.RawMessage `json:"json"`
								} `json:"inputSchema"`
							} `json:"toolSpecification"`
						} `json:"tools"`
						ToolResults []struct {
							ToolUseID string `json:"toolUseId"`
							Content   []struct {
								Text string `json:"text"`
							} `json:"content"`
							Status string `json:"status"`
						} `json:"toolResults"`
					} `json:"userInputMessageContext"`
				} `json:"userInputMessage"`
			} `json:"currentMessage"`
			History []map[string]json.RawMessage `json:"history"`
		} `json:"conversationState"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		t.Fatal("body not JSON")
	}
	state := parsed.ConversationState
	if state.ChatTriggerType != "MANUAL" || state.ConversationID == "" {
		t.Fatalf("state %#v", state)
	}
	current := state.CurrentMessage.UserInputMessage
	if current.ModelID != "claude-sonnet-4.5" || current.Origin != "AI_EDITOR" {
		t.Fatalf("current %#v", current)
	}
	if !strings.HasPrefix(current.Content, "<system_instructions>\n你是助手\n\n规则B\n</system_instructions>\n\n") {
		t.Fatalf("system not prepended: %q", current.Content)
	}
	if !strings.Contains(current.Content, "工具执行结果如下。") || !strings.Contains(current.Content, "u2") {
		t.Fatalf("tool/user merge broken: %q", current.Content)
	}
	results := current.UserInputMessageCtx.ToolResults
	if len(results) != 1 || results[0].ToolUseID != "call_1" || len(results[0].Content) != 1 || results[0].Content[0].Text != "sunny" || results[0].Status != "success" {
		t.Fatalf("tool results %#v", results)
	}
	if len(current.UserInputMessageCtx.Tools) != 1 || current.UserInputMessageCtx.Tools[0].ToolSpecification.Name != "get_weather" {
		t.Fatalf("tools %#v", current.UserInputMessageCtx.Tools)
	}
	if len(state.History) != 2 {
		t.Fatalf("history %#v", state.History)
	}
	var firstUser struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(state.History[0]["userInputMessage"], &firstUser) != nil || firstUser.Content != "u1" {
		t.Fatalf("history user %#v", firstUser)
	}
	var assistant struct {
		Content  string `json:"content"`
		ToolUses []struct {
			ToolUseID string         `json:"toolUseId"`
			Name      string         `json:"name"`
			Input     map[string]any `json:"input"`
		} `json:"toolUses"`
	}
	if json.Unmarshal(state.History[1]["assistantResponseMessage"], &assistant) != nil {
		t.Fatal("assistant history missing")
	}
	tu := assistant.ToolUses
	if len(tu) != 1 || tu[0].ToolUseID != "call_1" || tu[0].Name != "get_weather" || tu[0].Input["city"] != "sf" {
		t.Fatalf("tool uses %#v", tu)
	}
}

func TestKiroConversationIDStableForSession(t *testing.T) {
	a := kiroConversationID(13, "sess-1")
	b := kiroConversationID(13, "sess-1")
	c := kiroConversationID(13, "sess-2")
	d := kiroConversationID(14, "sess-1")
	if a != b || a == c || a == d || len(a) != 36 {
		t.Fatalf("conversation id %q %q %q %q", a, b, c, d)
	}
	if kiroConversationID(13, "") == kiroConversationID(13, "") {
		t.Fatal("sessions without header must not share a conversation id")
	}
}

func TestKiroTransportChatStreamConversion(t *testing.T) {
	mockKiroResolver(t, services.KiroCredential{AccessToken: "kiro-token", Region: "us-east-1", ExpiresAt: 4102444800}, nil)
	fp := services.KiroDeviceFingerprint(13)
	var frameStream = append(append(append(append(
		kiroFrame("assistantResponseEvent", "event", `{"content":"Hello "}`),
		kiroFrame("reasoningContentEvent", "event", `{"text":"thinking"}`)...),
		kiroFrame("assistantResponseEvent", "event", `{"content":"world"}`)...),
		kiroFrame("toolUseEvent", "event", `{"toolUseId":"t1","name":"get_weather","input":{"city":"sf"},"stop":true}`)...),
		kiroFrame("messageMetadataEvent", "event", `{"tokenUsage":{"uncachedInputTokens":10,"cacheReadInputTokens":2,"cacheWriteInputTokens":0,"inputTokens":12,"outputTokens":5}}`)...)

	transport := &kiroTransport{base: kiroTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse" {
			t.Fatalf("wrong upstream url %s", r.URL)
		}
		h := r.Header
		if h.Get("Authorization") != "Bearer kiro-token" {
			t.Fatalf("auth %q", h.Get("Authorization"))
		}
		if h.Get("Content-Type") != "application/x-amz-json-1.0" {
			t.Fatalf("content type %q", h.Get("Content-Type"))
		}
		if h.Get("X-Amz-Target") != "AmazonCodeWhispererStreamingService.GenerateAssistantResponse" {
			t.Fatalf("target %q", h.Get("X-Amz-Target"))
		}
		if !strings.Contains(h.Get("User-Agent"), "aws-sdk-js/1.0.27") || !strings.Contains(h.Get("User-Agent"), "KiroIDE-0.7.45-"+fp) {
			t.Fatalf("ua %q", h.Get("User-Agent"))
		}
		if h.Get("X-Amz-User-Agent") != "aws-sdk-js/1.0.27 KiroIDE-0.7.45-"+fp {
			t.Fatalf("x-amz-ua %q", h.Get("X-Amz-User-Agent"))
		}
		if h.Get("X-Amzn-Codewhisperer-Optout") != "true" || h.Get("X-Amzn-Kiro-Agent-Mode") != "vibe" {
			t.Fatalf("kiro headers %v", h)
		}
		if h.Get("Amz-Sdk-Invocation-Id") == "" || h.Get("Amz-Sdk-Request") != "attempt=1; max=3" || h.Get("Accept") != "*/*" {
			t.Fatalf("sdk headers %v", h)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["conversationState"] == nil {
			t.Fatalf("body %v", body)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/vnd.amazon.eventstream"}}, Body: io.NopCloser(strings.NewReader(string(frameStream)))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://codewhisperer.us-east-1.amazonaws.com/chat/completions", strings.NewReader(`{"model":"claude-sonnet-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	req.Header.Set("X-Session-Id", "sess-1")
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	chunks := parseKiroSSE(t, string(raw))
	var content, reasoning strings.Builder
	toolCalls, usage := 0, map[string]any(nil)
	finish := ""
	for _, chunk := range chunks {
		choices, _ := chunk["choices"].([]any)
		for _, c := range choices {
			choice := c.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if delta != nil {
				if s, ok := delta["content"].(string); ok {
					content.WriteString(s)
				}
				if s, ok := delta["reasoning_content"].(string); ok {
					reasoning.WriteString(s)
				}
				if tc, ok := delta["tool_calls"].([]any); ok {
					toolCalls += len(tc)
				}
			}
			if fr, ok := choice["finish_reason"].(string); ok && fr != "" {
				finish = fr
			}
		}
		if u, ok := chunk["usage"].(map[string]any); ok {
			usage = u
		}
	}
	if content.String() != "Hello world" || reasoning.String() != "thinking" {
		t.Fatalf("content=%q reasoning=%q", content.String(), reasoning.String())
	}
	if toolCalls == 0 || finish != "tool_calls" {
		t.Fatalf("tool calls %d finish %q", toolCalls, finish)
	}
	if usage == nil || usage["prompt_tokens"].(float64) != 12 || usage["completion_tokens"].(float64) != 5 || usage["total_tokens"].(float64) != 17 {
		t.Fatalf("usage %v", usage)
	}
	if !strings.HasSuffix(string(raw), "data: [DONE]\n\n") {
		t.Fatal("stream not terminated")
	}
}

func TestKiroTransportNonStreamAggregation(t *testing.T) {
	mockKiroResolver(t, services.KiroCredential{AccessToken: "kiro-token", Region: "us-east-1", ExpiresAt: 4102444800}, nil)
	body := string(append(append(
		kiroFrame("assistantResponseEvent", "event", `{"content":"Hi"}`),
		kiroFrame("assistantResponseEvent", "event", `{"content":" there"}`)...),
		kiroFrame("messageMetadataEvent", "event", `{"tokenUsage":{"inputTokens":4,"outputTokens":2}}`)...))
	transport := &kiroTransport{base: kiroTransportMock(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/vnd.amazon.eventstream"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://codewhisperer.us-east-1.amazonaws.com/chat/completions", strings.NewReader(`{"model":"claude-sonnet-5","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Choices) != 1 || out.Choices[0].Message.Content != "Hi there" || out.Choices[0].FinishReason != "stop" {
		t.Fatalf("aggregated %#v", out)
	}
	if out.Usage.PromptTokens != 4 || out.Usage.CompletionTokens != 2 {
		t.Fatalf("usage %#v", out.Usage)
	}
}

func TestKiroTransportStreamErrorSurfaces(t *testing.T) {
	mockKiroResolver(t, services.KiroCredential{AccessToken: "kiro-token", Region: "us-east-1", ExpiresAt: 4102444800}, nil)
	frames := string(append(
		kiroFrame("assistantResponseEvent", "event", `{"content":"partial"}`),
		kiroFrame("InternalServerException", "exception", `{"message":"upstream blew up"}`)...))
	transport := &kiroTransport{base: kiroTransportMock(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/vnd.amazon.eventstream"}}, Body: io.NopCloser(strings.NewReader(frames))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://codewhisperer.us-east-1.amazonaws.com/chat/completions", strings.NewReader(`{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(resp.Body)
	if readErr == nil {
		t.Fatal("stream error must not look like a clean EOF")
	}
	if !strings.Contains(string(raw), "upstream blew up") {
		t.Fatalf("error not surfaced to caller: %q", raw)
	}
	if !strings.Contains(readErr.Error(), "upstream blew up") {
		t.Fatalf("read error %v", readErr)
	}
}

func TestKiroTransportModelsListing(t *testing.T) {
	mockKiroResolver(t, services.KiroCredential{AccessToken: "kiro-token", Region: "ap-northeast-1", ExpiresAt: 4102444800}, nil)
	transport := &kiroTransport{base: kiroTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/ListAvailableModels" || r.URL.Query().Get("origin") != "AI_EDITOR" || r.URL.Query().Get("maxResults") != "50" {
			t.Fatalf("model url %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer kiro-token" || r.Header.Get("X-Amzn-Codewhisperer-Optout") != "true" {
			t.Fatalf("model headers %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"models":[{"modelId":"claude-sonnet-4.5"},{"modelName":"claude-haiku-4.5"},{"id":"dup"},{"modelName":"dup"}]}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://codewhisperer.ap-northeast-1.amazonaws.com/models", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if len(out.Data) != 3 || out.Data[0].ID != "claude-sonnet-4.5" || out.Data[2].ID != "dup" {
		t.Fatalf("models %#v", out.Data)
	}
}

func TestKiroTransport403ForcesRefreshAndRetries(t *testing.T) {
	mockKiroResolver(t, services.KiroCredential{AccessToken: "stale-token", Region: "us-east-1"}, nil)
	oldForce := forceRefreshKiroCredential
	var forced atomic.Int32
	forceRefreshKiroCredential = func(context.Context, int64) (services.KiroCredential, error) {
		forced.Add(1)
		return services.KiroCredential{AccessToken: "fresh-token", Region: "us-east-1", ExpiresAt: 4102444800}, nil
	}
	t.Cleanup(func() { forceRefreshKiroCredential = oldForce })
	var calls atomic.Int32
	transport := &kiroTransport{base: kiroTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer stale-token" {
			return &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader(`{"message":"expired"}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Fatalf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://codewhisperer.us-east-1.amazonaws.com/chat/completions", strings.NewReader(`{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || calls.Load() != 2 || forced.Load() != 1 {
		t.Fatalf("status=%d calls=%d forced=%d", resp.StatusCode, calls.Load(), forced.Load())
	}
}

func TestKiroTransportRejectsMarkerToOtherHost(t *testing.T) {
	called := false
	transport := &kiroTransport{base: kiroTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	req, _ := http.NewRequest("POST", "https://unrelated.example/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("kiro", 13))
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("internal marker forwarded to foreign host")
	}
	// 非标识请求原样透传（api 渠道不受影响）。
	req2, _ := http.NewRequest("POST", "https://codewhisperer.us-east-1.amazonaws.com/chat/completions", nil)
	req2.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req2); err != nil || !called {
		t.Fatal("plain api-key request must pass through untouched")
	}
}

// parseKiroSSE 把 SSE 文本解析成事件对象列表。
func parseKiroSSE(t *testing.T, raw string) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" || payload == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(payload), &obj); err != nil {
			t.Fatalf("bad SSE payload %q: %v", payload, err)
		}
		out = append(out, obj)
	}
	return out
}

// ---------- 设备绑定 HTTP 契约 ----------

func TestAdminDeviceVendorsContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/api/admin/channels/devices/vendors", nil)
	AdminDeviceVendors(c)
	if w.Code != 200 {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			Vendors     []string          `json:"vendors"`
			Methods     []string          `json:"methods"`
			Unavailable map[string]string `json:"unavailable"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	vendors := strings.Join(payload.Data.Vendors, ",")
	if vendors != "kiro,workbuddy,cline,grok" {
		t.Fatalf("vendors %q", vendors)
	}
	if strings.Join(payload.Data.Methods, ",") != "kiro,workbuddy,cli,grok" {
		t.Fatalf("methods %v", payload.Data.Methods)
	}
	if _, exists := payload.Data.Unavailable["kiro"]; exists {
		t.Fatal("kiro must no longer be unavailable")
	}
	if _, exists := payload.Data.Unavailable["workbuddy"]; exists {
		t.Fatal("workbuddy must no longer be unavailable")
	}
	if payload.Data.Unavailable["qoder"] == "" {
		t.Fatal("qoder reason missing")
	}
}

func TestCreateDeviceChannelValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	invoke := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(middleware.CtxUserKey, &models.User{ID: 1, Username: "tester"})
		c.Request = httptest.NewRequest("POST", "/api/admin/channels", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		req := channelRequestVendorForTest(body)
		createDeviceChannel(c, &req)
		return w
	}
	// 没有票据的 kiro/workbuddy 创建必须被拒（不能绕过一键绑定）。
	for _, body := range []string{
		`{"name":"k","vendor":"kiro","method":"kiro","base_url":"https://codewhisperer.us-east-1.amazonaws.com"}`,
		`{"name":"w","vendor":"workbuddy","method":"workbuddy","base_url":"https://www.workbuddy.ai/v2"}`,
		`{"name":"c","vendor":"cline","method":"cli"}`,
	} {
		w := invoke(body)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "device_create_failed") && !strings.Contains(w.Body.String(), "invalid_credential") {
			t.Fatalf("ticketless device channel accepted: %d %s", w.Code, w.Body.String())
		}
	}
	// 带票据但自定义非官方地址也必须被拒。
	w := invoke(`{"name":"k","vendor":"kiro","method":"kiro","ticket":"t","base_url":"https://evil.example"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_url") {
		t.Fatalf("custom unsafe base accepted: %d %s", w.Code, w.Body.String())
	}
	// 带票据但带 API Key 必须被拒。
	w = invoke(`{"name":"k","vendor":"kiro","method":"kiro","ticket":"t","api_key":"sk-x"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_credential") {
		t.Fatalf("api key with ticket accepted: %d %s", w.Code, w.Body.String())
	}
}

func channelRequestVendorForTest(body string) channelRequest {
	var req channelRequest
	json.Unmarshal([]byte(body), &req)
	return req
}
