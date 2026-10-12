package handlers

// Claude 订阅（Claude Code OAuth）传输层测试：凭据解析全部替换为 mock，不依赖数据库。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"ooapi/internal/services"
)

type claudeTransportMock func(*http.Request) (*http.Response, error)

func (f claudeTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// claudeTransportMarker 生成订阅渠道在 Authorization 头里的内部标识
// （与 services.DeviceCredentialMarker 的格式一致：ooapi-<method>-channel-<id>）。
func claudeTransportMarker(id int64) string {
	return claudeMarkerPrefix + strconv.FormatInt(id, 10)
}

// mockClaudeOAuthResolver 替换凭据解析函数（测试不碰数据库）。
func mockClaudeOAuthResolver(t *testing.T, cred services.ClaudeOAuthCredential, err error) {
	t.Helper()
	old := resolveClaudeCredential
	resolveClaudeCredential = func(context.Context, int64) (services.ClaudeOAuthCredential, error) { return cred, err }
	t.Cleanup(func() { resolveClaudeCredential = old })
}

func mockClaudeOAuthForceRefresh(t *testing.T, cred services.ClaudeOAuthCredential, err error) {
	t.Helper()
	old := forceRefreshClaudeCredential
	forceRefreshClaudeCredential = func(context.Context, int64) (services.ClaudeOAuthCredential, error) { return cred, err }
	t.Cleanup(func() { forceRefreshClaudeCredential = old })
}

var (
	// claudeUUIDPattern 是 UUID v4 形状：版本位 4，变体位 8/9/a/b。
	claudeUUIDPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	claudeDeviceIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// claudeChatPayload 构造内部通用语（chat-completions）请求体 ——
// 传输层收到的就是这一形状，由它自己翻成 Messages 请求。
func claudeChatPayload(stream bool) string {
	return `{"model":"claude-sonnet-4-5","stream":` + map[bool]string{true: "true", false: "false"}[stream] +
		`,"messages":[{"role":"system","content":"规则"},{"role":"user","content":"hi"}]}`
}

// claudeMessagesRequest 构造订阅渠道的对话请求（打向官方主机、带内部标识）。
func claudeMessagesRequest(t *testing.T, id int64, stream bool) *http.Request {
	t.Helper()
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(claudeChatPayload(stream)))
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(id))
	return req
}

// claudeMessagesSSE 构造一段官方 Messages 事件流：usage 里带缓存命中/写入字段。
func claudeMessagesSSE() *http.Response {
	body := "" +
		"event: message_start\n" +
		`data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"cache_read_input_tokens":30,"cache_creation_input_tokens":20}}}` + "\n\n" +
		"event: content_block_start\n" +
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}` + "\n\n" +
		"event: message_delta\n" +
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}` + "\n\n" +
		"event: message_stop\n" +
		`data: {"type":"message_stop"}` + "\n\n"
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// claudeLastUsageFrame 从转换后的 OpenAI 分块流里取最后一条 usage。
func claudeLastUsageFrame(t *testing.T, sse string) map[string]any {
	t.Helper()
	var usage map[string]any
	for _, line := range strings.Split(sse, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var chunk struct {
			Usage map[string]any `json:"usage"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
	}
	if usage == nil {
		t.Fatal("转换结果里没有 usage 分块")
	}
	return usage
}

// 内部标识绝不允许发往非官方主机；官方主机上的未知路径也不许带凭据转发。
func TestClaudeTransportRejectsMarkerElsewhere(t *testing.T) {
	called := false
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	req, _ := http.NewRequest("POST", "https://unrelated.example/v1/messages", strings.NewReader(claudeChatPayload(true)))
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("internal marker forwarded to foreign host")
	}
	// 官方主机上的未知路径（如 embeddings）必须拒绝，不得外发凭据。
	req2, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/embeddings", strings.NewReader(`{}`))
	req2.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	if _, err := transport.RoundTrip(req2); err == nil || called {
		t.Fatal("marker forwarded to unsupported path")
	}
}

// 非内部标识的请求原样透传（api 渠道与其它厂商不受影响）。
func TestClaudeTransportPassesPlainRequestsThrough(t *testing.T) {
	var seen *http.Request
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		seen = r
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-5"}`))
	req.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if seen.Header.Get("Authorization") != "Bearer real-api-key" || seen.URL.String() != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("plain request was modified: %v %v", seen.Header, seen.URL)
	}
	// 其它主机上的普通请求同样原样透传。
	seen = nil
	req2, _ := http.NewRequest("POST", "https://unrelated.example/v1/messages", nil)
	req2.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req2); err != nil || seen == nil {
		t.Fatalf("foreign plain request must pass through: %v", err)
	}
}

// 对话：URL/方法被改写为官方 Messages 端点，头组与请求体形状与原版一致。
func TestClaudeTransportChatRewritesBodyAndHeaders(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	session := claudeSessionUUID(7)
	var seen *http.Request
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		seen = r
		return claudeMessagesSSE(), nil
	})}
	req := claudeMessagesRequest(t, 7, true)
	// 网关按 Anthropic 协议组头时会把标识塞进 x-api-key：不允许外发。
	req.Header.Set("x-api-key", claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if seen.Method != "POST" || seen.URL.String() != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("upstream url/method %s %s", seen.Method, seen.URL)
	}
	checks := map[string]string{
		"Authorization":     "Bearer claude-access",
		"Content-Type":      "application/json",
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Beta":    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11",
		"Anthropic-Dangerous-Direct-Browser-Access": "true",
		"X-App":                       "cli",
		"X-Stainless-Retry-Count":     "0",
		"X-Stainless-Runtime":         "node",
		"X-Stainless-Lang":            "js",
		"X-Stainless-Async":           "async",
		"X-Stainless-Timeout":         "600",
		"X-Stainless-Package-Version": "0.112.1",
		"X-Stainless-Runtime-Version": "v26.3.0",
		"X-Stainless-Os":              "MacOS",
		"X-Stainless-Arch":            "arm64",
		"X-Claude-Code-Session-Id":    session,
		"Accept":                      "application/json",
		"User-Agent":                  "claude-cli/2.1.258 (external, cli)",
	}
	for key, want := range checks {
		if got := seen.Header.Get(key); got != want {
			t.Errorf("%s=%q want %q", key, got, want)
		}
	}
	if seen.Header.Get("x-api-key") != "" {
		t.Fatalf("internal marker leaked via x-api-key: %q", seen.Header.Get("x-api-key"))
	}
	if requestID := seen.Header.Get("X-Client-Request-Id"); !claudeUUIDPattern.MatchString(requestID) || requestID == session {
		t.Fatalf("x-client-request-id %q", requestID)
	}

	var body map[string]any
	if err := json.NewDecoder(seen.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "claude-sonnet-4-5" || body["stream"] != true {
		t.Fatalf("body shape %v", body)
	}
	system, _ := body["system"].([]any)
	if len(system) != 2 {
		t.Fatalf("system must be an array of two blocks: %v", body["system"])
	}
	first, _ := system[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "You are Claude Code, Anthropic's official CLI for Claude." {
		t.Fatalf("identity block %v", system[0])
	}
	cache, _ := first["cache_control"].(map[string]any)
	if cache["type"] != "ephemeral" {
		t.Fatalf("identity cache_control %v", first["cache_control"])
	}
	second, _ := system[1].(map[string]any)
	if second["text"] != "规则" {
		t.Fatalf("system text block %v", system[1])
	}

	metadata, _ := body["metadata"].(map[string]any)
	userID, ok := metadata["user_id"].(string)
	if !ok {
		t.Fatalf("metadata.user_id must be a JSON string: %#v", metadata["user_id"])
	}
	var parsedUser struct {
		DeviceID    string `json:"device_id"`
		AccountUUID string `json:"account_uuid"`
		SessionID   string `json:"session_id"`
	}
	if err := json.Unmarshal([]byte(userID), &parsedUser); err != nil {
		t.Fatalf("metadata.user_id is not valid JSON: %q", userID)
	}
	if parsedUser.DeviceID != claudeDeviceID(7) || parsedUser.AccountUUID != claudeAccountUUID(7) || parsedUser.SessionID != claudeSessionUUID(7) {
		t.Fatalf("metadata.user_id identities %#v", parsedUser)
	}
	// 通用语已翻成 Messages 形状：system 消息不在 messages 里。
	messages, _ := body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages %v", body["messages"])
	}
	if msg, _ := messages[0].(map[string]any); msg["role"] != "user" || msg["content"] != "hi" {
		t.Fatalf("messages[0] %v", messages[0])
	}
}

// max_tokens：客户给了就保留，没给用原版兜底值（开思考时 16000）。
func TestClaudeTransportMaxTokensDefaults(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	cases := []struct {
		name string
		body string
		want float64
	}{
		{"client value kept", `{"model":"claude-sonnet-4-5","max_tokens":1234,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, 1234},
		{"base default", `{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`, 8192},
		{"thinking budget", `{"model":"claude-sonnet-4-5","stream":true,"reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`, 16000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *http.Request
			transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
				seen = r
				return claudeMessagesSSE(), nil
			})}
			req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(tc.body))
			req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
			resp, err := transport.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			var body map[string]any
			if err := json.NewDecoder(seen.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["max_tokens"] != tc.want {
				t.Fatalf("max_tokens=%v want %v", body["max_tokens"], tc.want)
			}
			// 思考信号不能随请求外发（Messages 形状里没有这个字段）。
			if _, exists := body["reasoning_effort"]; exists {
				t.Fatalf("reasoning_effort must not leak upstream: %v", body)
			}
		})
	}
}

// 确定性身份：同一渠道稳定、不同渠道/标签不撞，UUID 必须是 v4 形状。
func TestClaudeIdentityHelpersDeterministic(t *testing.T) {
	if !claudeDeviceIDPattern.MatchString(claudeDeviceID(7)) {
		t.Fatalf("device id %q", claudeDeviceID(7))
	}
	if claudeDeviceID(7) != claudeDeviceID(7) || claudeDeviceID(7) == claudeDeviceID(8) {
		t.Fatal("device id must be deterministic per channel")
	}
	account, session := claudeAccountUUID(7), claudeSessionUUID(7)
	if !claudeUUIDPattern.MatchString(account) || !claudeUUIDPattern.MatchString(session) {
		t.Fatalf("uuid shapes %q %q", account, session)
	}
	if account == session || account != claudeAccountUUID(7) || account == claudeAccountUUID(8) {
		t.Fatal("account/session uuids must be deterministic and distinct")
	}
	// 请求号是每次随机的，但必须是 v4 形状且两次不同。
	a, b := claudeRequestID(7), claudeRequestID(7)
	if !claudeUUIDPattern.MatchString(a) || !claudeUUIDPattern.MatchString(b) || a == b {
		t.Fatalf("request ids %q %q", a, b)
	}
}

// 流式：Messages 事件流被转成 OpenAI 分块，usage 并入缓存命中/写入的 token。
func TestClaudeTransportStreamConversionIncludesCacheUsage(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(*http.Request) (*http.Response, error) {
		return claudeMessagesSSE(), nil
	})}
	resp, err := transport.RoundTrip(claudeMessagesRequest(t, 7, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	text := string(raw)
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	if !strings.Contains(text, `"content":"Hel"`) || !strings.Contains(text, `"content":"lo"`) {
		t.Fatalf("deltas not converted: %q", text)
	}
	if !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("missing [DONE]: %q", text)
	}
	// prompt_tokens = input(100) + cache_read(30) + cache_creation(20)
	// cached_tokens 只记命中，写入留在未缓存输入里，避免缓存被计两次。
	usage := claudeLastUsageFrame(t, text)
	if usage["prompt_tokens"] != float64(150) || usage["completion_tokens"] != float64(7) || usage["total_tokens"] != float64(157) {
		t.Fatalf("usage frame %#v", usage)
	}
	details, _ := usage["prompt_tokens_details"].(map[string]any)
	if details == nil || details["cached_tokens"] != float64(30) {
		t.Fatalf("cache read must be reported once in prompt_tokens_details, got %#v", usage)
	}
}

// 非流式下游：上游仍按流式请求，这里聚合成一个 chat.completion JSON。
func TestClaudeTransportNonStreamAggregates(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Fatalf("upstream must always be streamed: %v", body)
		}
		return claudeMessagesSSE(), nil
	})}
	resp, err := transport.RoundTrip(claudeMessagesRequest(t, 7, false))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	var out struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "chat.completion" || len(out.Choices) != 1 ||
		out.Choices[0].Message.Content != "Hello" || out.Choices[0].FinishReason != "stop" {
		t.Fatalf("aggregated %#v", out)
	}
	if out.Usage["prompt_tokens"] != float64(150) || out.Usage["total_tokens"] != float64(157) {
		t.Fatalf("aggregated usage %#v", out.Usage)
	}
	details, _ := out.Usage["prompt_tokens_details"].(map[string]any)
	if details == nil || details["cached_tokens"] != float64(30) {
		t.Fatalf("aggregated cache tokens %#v", out.Usage)
	}
}

// 401/403 先强制刷新重试一次；第二次成功则透传成功响应。
func TestClaudeTransportRetriesOnceAfterForceRefresh(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "stale-token", ExpiresAt: 4102444800}, nil)
	mockClaudeOAuthForceRefresh(t, services.ClaudeOAuthCredential{AccessToken: "fresh-token", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer stale-token" {
			return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"type":"authentication_error"}}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Fatalf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		return claudeMessagesSSE(), nil
	})}
	resp, err := transport.RoundTrip(claudeMessagesRequest(t, 7, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || calls.Load() != 2 || !strings.Contains(string(raw), `"content":"Hel"`) {
		t.Fatalf("status=%d calls=%d body=%q", resp.StatusCode, calls.Load(), raw)
	}
}

// 刷新失败时不重放；上游持续 401/403 则返回「重新一键登录」错误（统一 401）。
func TestClaudeTransportUpstream401YieldsReloginMessage(t *testing.T) {
	for _, status := range []int{401, 403} {
		mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
		mockClaudeOAuthForceRefresh(t, services.ClaudeOAuthCredential{}, context.DeadlineExceeded)
		var calls atomic.Int32
		transport := &claudeOAuthTransport{base: claudeTransportMock(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>denied</html>"))}, nil
		})}
		resp, err := transport.RoundTrip(claudeMessagesRequest(t, 7, true))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 401 || !strings.Contains(string(raw), "Claude 登录已过期，请重新一键登录") {
			t.Fatalf("upstream %d handling %d %q", status, resp.StatusCode, raw)
		}
		if calls.Load() != 1 {
			t.Fatalf("refresh failed but request was replayed: calls=%d", calls.Load())
		}
	}
	// 刷新成功但拿到的是同一个令牌：也不得重放（重放只会多打一次上游）。
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "same-token", ExpiresAt: 4102444800}, nil)
	mockClaudeOAuthForceRefresh(t, services.ClaudeOAuthCredential{AccessToken: "same-token", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{}}`))}, nil
	})}
	resp, err := transport.RoundTrip(claudeMessagesRequest(t, 7, true))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 || calls.Load() != 1 {
		t.Fatalf("unchanged token must not be replayed: status=%d calls=%d", resp.StatusCode, calls.Load())
	}
}

// 未配置 model_paths 的渠道走 /chat/completions（连通性测试也打这个路径），
// 请求体是通用语，必须被翻成 Messages 形状后发出。
func TestClaudeTransportAcceptsChatCompletionsPath(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	var seen *http.Request
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		seen = r
		return claudeMessagesSSE(), nil
	})}
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/chat/completions", strings.NewReader(claudeChatPayload(true)))
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if seen.URL.String() != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("upstream url %s", seen.URL)
	}
	var body map[string]any
	if err := json.NewDecoder(seen.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	system, _ := body["system"].([]any)
	if len(system) != 2 {
		t.Fatalf("chat body was not translated: %v", body["system"])
	}
}

// 渠道配了 model_paths 时网关按 Anthropic 协议组头，标识在 x-api-key 上：
// 必须同样能识别，且不得把标识原样发往上游。
func TestClaudeTransportDetectsMarkerInAPIKeyHeader(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	var seen *http.Request
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		seen = r
		return claudeMessagesSSE(), nil
	})}
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(claudeChatPayload(true)))
	req.Header.Set("x-api-key", claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if seen == nil {
		t.Fatal("x-api-key marker was not recognized as internal")
	}
	if seen.Header.Get("Authorization") != "Bearer claude-access" || seen.Header.Get("x-api-key") != "" {
		t.Fatalf("marker must be swapped for the real token: %v", seen.Header)
	}
	// 内部标识打在 x-api-key 上、目标却是别的主机：同样必须拒绝。
	req2, _ := http.NewRequest("POST", "https://unrelated.example/v1/messages", strings.NewReader(`{}`))
	req2.Header.Set("x-api-key", claudeTransportMarker(7))
	if _, err := transport.RoundTrip(req2); err == nil {
		t.Fatal("x-api-key marker forwarded to foreign host")
	}
}

// 配置了 model_paths 的渠道：网关已把请求体翻成 Messages 形状，
// 传输层不得再翻一次（system 会丢、工具定义会被抹掉）。
func TestClaudeTransportKeepsPreConvertedMessagesBody(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	var seen *http.Request
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		seen = r
		return claudeMessagesSSE(), nil
	})}
	converted := `{"model":"claude-sonnet-4-5","max_tokens":2048,"stream":true,"system":"网关配置的规则",` +
		`"messages":[{"role":"user","content":"hi"}],` +
		`"tools":[{"name":"search","description":"","input_schema":{"type":"object","properties":{}}}]}`
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(converted))
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(seen.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	// 工具定义必须原样保留（重翻一遍会被丢光）。
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools lost in re-conversion: %v", body["tools"])
	}
	if tool, _ := tools[0].(map[string]any); tool["input_schema"] == nil || tool["name"] != "search" {
		t.Fatalf("tools %v", tools[0])
	}
	// 客户给的 max_tokens 必须保留。
	if body["max_tokens"] != float64(2048) {
		t.Fatalf("max_tokens %v", body["max_tokens"])
	}
	// system 仍是块数组，且身份块在最前、原 system 文本在后。
	system, _ := body["system"].([]any)
	if len(system) != 2 {
		t.Fatalf("system blocks %v", body["system"])
	}
	if first, _ := system[0].(map[string]any); first["text"] != "You are Claude Code, Anthropic's official CLI for Claude." {
		t.Fatalf("identity block %v", system[0])
	}
	if second, _ := system[1].(map[string]any); second["text"] != "网关配置的规则" {
		t.Fatalf("system text %v", system[1])
	}
}

// 模型列表：精简头组（只带单个 beta），路径改写为 /v1/models?limit=100。
func TestClaudeTransportModelsUsesSingleBeta(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" || r.URL.String() != "https://api.anthropic.com/v1/models?limit=100" {
			t.Fatalf("models url %s %s", r.Method, r.URL)
		}
		if got := r.Header.Get("Anthropic-Beta"); got != "oauth-2025-04-20" {
			t.Fatalf("anthropic-beta=%q want oauth-2025-04-20", got)
		}
		checks := map[string]string{
			"Authorization":     "Bearer claude-access",
			"Anthropic-Version": "2023-06-01",
			"User-Agent":        "claude-cli/2.1.258 (external, cli)",
			"X-App":             "cli",
			"Accept":            "application/json",
		}
		for key, want := range checks {
			if got := r.Header.Get(key); got != want {
				t.Errorf("%s=%q want %q", key, got, want)
			}
		}
		// 精简头组：对话路径专用的头不该出现。
		if r.Header.Get("Anthropic-Dangerous-Direct-Browser-Access") != "" || r.Header.Get("X-Stainless-Lang") != "" {
			t.Fatalf("models must use the reduced header set: %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"claude-sonnet-4-5"}]}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://api.anthropic.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), "claude-sonnet-4-5") {
		t.Fatalf("models passthrough %d %q", resp.StatusCode, raw)
	}
}

// 模型列表的 401/403 也必须是清晰的「重新登录」提示（不做刷新重试）。
func TestClaudeTransportModels401YieldsReloginMessage(t *testing.T) {
	mockClaudeOAuthResolver(t, services.ClaudeOAuthCredential{AccessToken: "claude-access", ExpiresAt: 4102444800}, nil)
	// 刷新函数即使可用也不得被调用（原版在拉模型路径上没有刷新重试）。
	var refreshCalls atomic.Int32
	old := forceRefreshClaudeCredential
	forceRefreshClaudeCredential = func(context.Context, int64) (services.ClaudeOAuthCredential, error) {
		refreshCalls.Add(1)
		return services.ClaudeOAuthCredential{AccessToken: "fresh-token"}, nil
	}
	t.Cleanup(func() { forceRefreshClaudeCredential = old })
	var calls atomic.Int32
	transport := &claudeOAuthTransport{base: claudeTransportMock(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"type":"authentication_error"}}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://api.anthropic.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+claudeTransportMarker(7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(string(raw), "Claude 登录已过期，请重新一键登录") {
		t.Fatalf("models 401 %d %q", resp.StatusCode, raw)
	}
	if calls.Load() != 1 || refreshCalls.Load() != 0 {
		t.Fatalf("models path must not retry after refresh: calls=%d refresh=%d", calls.Load(), refreshCalls.Load())
	}
}
