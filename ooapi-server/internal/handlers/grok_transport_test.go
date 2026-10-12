package handlers

// Grok（xAI 订阅）传输层测试：凭据解析全部替换为 mock，不依赖数据库。

import (
	"context"
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

type grokTransportMock func(*http.Request) (*http.Response, error)

func (f grokTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// mockGrokResolver 替换凭据解析函数（测试不碰数据库）。
func mockGrokResolver(t *testing.T, cred services.GrokCredential, err error) {
	t.Helper()
	old := resolveGrokCredential
	resolveGrokCredential = func(context.Context, int64) (services.GrokCredential, error) { return cred, err }
	t.Cleanup(func() { resolveGrokCredential = old })
}

func mockGrokForceRefresh(t *testing.T, cred services.GrokCredential, err error) {
	t.Helper()
	old := forceRefreshGrokCredential
	forceRefreshGrokCredential = func(context.Context, int64) (services.GrokCredential, error) { return cred, err }
	t.Cleanup(func() { forceRefreshGrokCredential = old })
}

// grokResponsesSSE 构造一段官方 Responses 事件流。
func grokResponsesSSE() *http.Response {
	body := "" +
		"event: response.created\n" +
		`data: {"type":"response.created","response":{"id":"resp_1","model":"grok-4.5"}}` + "\n\n" +
		"event: response.output_text.delta\n" +
		`data: {"type":"response.output_text.delta","delta":"Hel"}` + "\n\n" +
		"event: response.output_text.delta\n" +
		`data: {"type":"response.output_text.delta","delta":"lo"}` + "\n\n" +
		"event: response.completed\n" +
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"grok-4.5","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}` + "\n\n"
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func grokChatRequest(t *testing.T, stream bool) *http.Request {
	t.Helper()
	payload := `{"model":"grok-4.5","stream":` + map[bool]string{true: "true", false: "false"}[stream] +
		`,"temperature":0.7,"reasoning_effort":"low","messages":[{"role":"system","content":"规则"},{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest("POST", "https://cli-chat-proxy.grok.com/v1/chat/completions", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("grok", 7))
	return req
}

// 请求被改写为 Responses、头组与请求体形状与原始实现一致、SSE 转成 OpenAI 分块。
func TestGrokTransportChatHeadersRewriteAndStream(t *testing.T) {
	session := services.GrokSessionID(7)
	mockGrokResolver(t, services.GrokCredential{AccessToken: "grok-access", RefreshToken: "r", ExpiresAt: 4102444800}, nil)
	transport := &grokTransport{base: grokTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://cli-chat-proxy.grok.com/v1/responses" {
			t.Fatalf("url %s", r.URL)
		}
		h := r.Header
		checks := map[string]string{
			"Authorization":            "Bearer grok-access",
			"Content-Type":             "application/json",
			"Accept":                   "text/event-stream",
			"Connection":               "keep-alive",
			"X-Grok-Conv-Id":           session,
			"User-Agent":               "xai-grok-workspace/1.0.13",
			"X-Grok-Client-Version":    "1.0.13",
			"X-Grok-Client-Identifier": "grok-shell",
			"X-Xai-Token-Auth":         "xai-grok-cli",
			"X-Authenticateresponse":   "authenticate-response",
		}
		for key, want := range checks {
			if got := h.Get(key); got != want {
				t.Errorf("%s=%q want %q", key, got, want)
			}
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "grok-4.5" || body["stream"] != true || body["store"] != false {
			t.Fatalf("body shape %v", body)
		}
		if body["prompt_cache_key"] != session {
			t.Fatalf("prompt_cache_key %v", body["prompt_cache_key"])
		}
		include, _ := body["include"].([]any)
		if len(include) != 1 || include[0] != "reasoning.encrypted_content" {
			t.Fatalf("include %v", body["include"])
		}
		if _, exists := body["temperature"]; exists {
			t.Fatal("temperature must be dropped like the original request shape")
		}
		if _, exists := body["reasoning_effort"]; exists {
			t.Fatal("reasoning_effort must be translated, not passed through")
		}
		reasoning, _ := body["reasoning"].(map[string]any)
		if reasoning["effort"] != "low" || reasoning["summary"] != "auto" {
			t.Fatalf("reasoning mapping %v", body["reasoning"])
		}
		if body["instructions"] != "规则" {
			t.Fatalf("instructions %v", body["instructions"])
		}
		input, _ := body["input"].([]any)
		if len(input) != 1 {
			t.Fatalf("input %v", input)
		}
		return grokResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(grokChatRequest(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	text := string(raw)
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	if !strings.Contains(text, "chat.completion.chunk") || !strings.Contains(text, `"content":"Hel"`) || !strings.Contains(text, `"content":"lo"`) {
		t.Fatalf("deltas not converted: %q", text)
	}
	if !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("missing [DONE]: %q", text)
	}
}

// 非流式下游：上游事件流被聚合成一个 chat.completion JSON。
func TestGrokTransportChatNonStreamAggregates(t *testing.T) {
	mockGrokResolver(t, services.GrokCredential{AccessToken: "grok-access", ExpiresAt: 4102444800}, nil)
	transport := &grokTransport{base: grokTransportMock(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Fatalf("upstream must always be streamed: %v", body)
		}
		return grokResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(grokChatRequest(t, false))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	var out struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
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
	if out.Object != "chat.completion" || len(out.Choices) != 1 || out.Choices[0].Message.Content != "Hello" || out.Choices[0].FinishReason != "stop" {
		t.Fatalf("aggregated %#v", out)
	}
	if out.Usage["total_tokens"].(float64) != 7 {
		t.Fatalf("usage %#v", out.Usage)
	}
}

// 上游 401/403 且刷新无效时给出「重新一键登录」错误。
func TestGrokTransportUpstream401YieldsReloginMessage(t *testing.T) {
	for _, status := range []int{401, 403} {
		mockGrokResolver(t, services.GrokCredential{AccessToken: "grok-access", ExpiresAt: 4102444800}, nil)
		mockGrokForceRefresh(t, services.GrokCredential{}, context.DeadlineExceeded)
		transport := &grokTransport{base: grokTransportMock(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>denied</html>"))}, nil
		})}
		resp, err := transport.RoundTrip(grokChatRequest(t, true))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != status || !strings.Contains(string(raw), "Grok 登录已过期，请重新一键登录") {
			t.Fatalf("upstream %d handling %d %q", status, resp.StatusCode, raw)
		}
	}
}

// 403/401 先强制刷新重试一次；第二次成功则透传成功响应。
func TestGrokTransportRetriesOnceAfterForceRefresh(t *testing.T) {
	mockGrokResolver(t, services.GrokCredential{AccessToken: "stale-token", ExpiresAt: 4102444800}, nil)
	mockGrokForceRefresh(t, services.GrokCredential{AccessToken: "fresh-token", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &grokTransport{base: grokTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer stale-token" {
			return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error":"bad-credentials"}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Fatalf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		return grokResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(grokChatRequest(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d", resp.StatusCode, calls.Load())
	}
}

// 本地 auth_expires_at 已过 ≠ 上游一定拒绝：传输层不得据此拦截。
func TestGrokTransportDoesNotGateOnStoredExpiry(t *testing.T) {
	var upstreamCalls atomic.Int32
	mockGrokResolver(t, services.GrokCredential{AccessToken: "grok-access", ExpiresAt: 1}, nil)
	transport := &grokTransport{base: grokTransportMock(func(r *http.Request) (*http.Response, error) {
		upstreamCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer grok-access" {
			t.Fatalf("token not forwarded: %q", r.Header.Get("Authorization"))
		}
		return grokResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(grokChatRequest(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if upstreamCalls.Load() != 1 || resp.StatusCode != 200 {
		t.Fatalf("locally-expired credential was not forwarded: calls=%d status=%d", upstreamCalls.Load(), resp.StatusCode)
	}
}

// 内部标识绝不允许发往非官方主机；官方主机上的未知路径也不许带凭据转发。
func TestGrokTransportRejectsMarkerElsewhere(t *testing.T) {
	called := false
	transport := &grokTransport{base: grokTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	req, _ := http.NewRequest("POST", "https://unrelated.example/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("grok", 7))
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("internal marker forwarded to foreign host")
	}
	// 官方主机上的未知路径（如 embeddings）必须拒绝，不得外发凭据。
	req2, _ := http.NewRequest("POST", "https://cli-chat-proxy.grok.com/v1/embeddings", nil)
	req2.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("grok", 7))
	if _, err := transport.RoundTrip(req2); err == nil || called {
		t.Fatal("marker forwarded to unsupported path")
	}
	// 非标识请求原样透传（api 渠道不受影响）。
	req3, _ := http.NewRequest("POST", "https://cli-chat-proxy.grok.com/v1/chat/completions", nil)
	req3.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req3); err != nil || !called {
		t.Fatal("plain api-key request must pass through untouched")
	}
}

// 模型列表：与聊天同一通道、同一身份头，路径与响应原样透传。
func TestGrokTransportModelsUsesIdentityHeaders(t *testing.T) {
	session := services.GrokSessionID(7)
	mockGrokResolver(t, services.GrokCredential{AccessToken: "grok-access", ExpiresAt: 4102444800}, nil)
	transport := &grokTransport{base: grokTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://cli-chat-proxy.grok.com/v1/models" {
			t.Fatalf("url %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer grok-access" || r.Header.Get("Accept") != "application/json" {
			t.Fatalf("headers %v", r.Header)
		}
		if r.Header.Get("X-Grok-Conv-Id") != session || r.Header.Get("X-Grok-Client-Identifier") != "grok-shell" {
			t.Fatalf("identity headers %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"grok-4.5"}]}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://cli-chat-proxy.grok.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("grok", 7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), "grok-4.5") {
		t.Fatalf("models passthrough %d %q", resp.StatusCode, raw)
	}
}

// ---------- 设备绑定 HTTP 契约 ----------

func TestAdminDeviceVendorsListsGrok(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/api/admin/channels/devices/vendors", nil)
	AdminDeviceVendors(c)
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			Vendors []string `json:"vendors"`
			Methods []string `json:"methods"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	vendors := strings.Join(payload.Data.Vendors, ",")
	methods := strings.Join(payload.Data.Methods, ",")
	if !strings.Contains(vendors, "grok") || !strings.Contains(methods, "grok") {
		t.Fatalf("grok not registered: vendors=%q methods=%q", vendors, methods)
	}
	// 厂商键必须与 label 映射一致（否则前端拿不到显示名）。
	if deviceVendorLabel("grok") != "Grok" {
		t.Fatalf("label %q", deviceVendorLabel("grok"))
	}
	if want, ok := deviceVendorMethods["grok"]; !ok || want != "grok" {
		t.Fatalf("deviceVendorMethods grok -> %q %v", want, ok)
	}
}

// 设备渠道必须通过票据创建；官方地址之外的自定义地址一律拒绝。
func TestCreateGrokDeviceChannelValidation(t *testing.T) {
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
	w := invoke(`{"name":"g","vendor":"grok","method":"grok"}`)
	if w.Code != 400 || (!strings.Contains(w.Body.String(), "device_create_failed") && !strings.Contains(w.Body.String(), "invalid_credential")) {
		t.Fatalf("ticketless grok channel accepted: %d %s", w.Code, w.Body.String())
	}
	w = invoke(`{"name":"g","vendor":"grok","method":"grok","ticket":"t","base_url":"https://evil.example/v1"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_url") {
		t.Fatalf("custom unsafe base accepted: %d %s", w.Code, w.Body.String())
	}
	if !deviceBaseLooksOfficial("grok", services.GrokCLIBase) || deviceBaseLooksOfficial("grok", "https://api.x.ai/v1") {
		t.Fatal("grok official base check wrong")
	}
}
