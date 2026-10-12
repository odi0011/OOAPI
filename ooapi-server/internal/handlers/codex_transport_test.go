package handlers

// Codex（ChatGPT 订阅）传输层测试：凭据解析全部替换为 mock，不依赖数据库。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"ooapi/internal/services"
)

type codexTransportMock func(*http.Request) (*http.Response, error)

func (f codexTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// mockCodexResolver 替换凭据解析函数（测试不碰数据库）。
func mockCodexResolver(t *testing.T, cred services.CodexCredential, err error) {
	t.Helper()
	old := resolveCodexCredential
	resolveCodexCredential = func(context.Context, int64) (services.CodexCredential, error) { return cred, err }
	t.Cleanup(func() { resolveCodexCredential = old })
}

func mockCodexForceRefresh(t *testing.T, cred services.CodexCredential, err error) {
	t.Helper()
	old := forceRefreshCodexCredential
	forceRefreshCodexCredential = func(context.Context, int64) (services.CodexCredential, error) { return cred, err }
	t.Cleanup(func() { forceRefreshCodexCredential = old })
}

// codexResponsesSSE 构造一段官方 Responses 事件流。
func codexResponsesSSE() *http.Response {
	body := "" +
		"event: response.created\n" +
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5-codex"}}` + "\n\n" +
		"event: response.output_text.delta\n" +
		`data: {"type":"response.output_text.delta","delta":"Hel"}` + "\n\n" +
		"event: response.output_text.delta\n" +
		`data: {"type":"response.output_text.delta","delta":"lo"}` + "\n\n" +
		"event: response.completed\n" +
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5-codex","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}` + "\n\n"
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func codexChatRequest(t *testing.T, stream bool) *http.Request {
	t.Helper()
	payload := `{"model":"gpt-5-codex","stream":` + map[bool]string{true: "true", false: "false"}[stream] +
		`,"messages":[{"role":"system","content":"规则"},{"role":"user","content":"hi"}]}`
	req, _ := http.NewRequest("POST", codexResponsesURL, strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer ooapi-codex-channel-7")
	return req
}

// 请求被改写为 Responses、头组与请求体形状与原始实现一致、SSE 转成 OpenAI 分块。
func TestCodexTransportChatHeadersRewriteAndStream(t *testing.T) {
	session := codexSessionID(7)
	mockCodexResolver(t, services.CodexCredential{AccessToken: "codex-access", AccountID: "acc-123", ExpiresAt: 4102444800}, nil)
	transport := &codexTransport{base: codexTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.String() != "https://chatgpt.com/backend-api/codex/responses" {
			t.Fatalf("method=%s url=%s", r.Method, r.URL)
		}
		h := r.Header
		checks := map[string]string{
			"Authorization":      "Bearer codex-access",
			"Content-Type":       "application/json",
			"Accept":             "text/event-stream",
			"Originator":         "codex-tui",
			"Chatgpt-Account-Id": "acc-123",
			"session_id":         session,
			"User-Agent":         "codex_cli_rs/0.1.0",
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
		if body["model"] != "gpt-5-codex" || body["stream"] != true || body["store"] != false {
			t.Fatalf("body shape %v", body)
		}
		if body["prompt_cache_key"] != session {
			t.Fatalf("prompt_cache_key %v", body["prompt_cache_key"])
		}
		if body["instructions"] != "规则" {
			t.Fatalf("instructions %v", body["instructions"])
		}
		input, _ := body["input"].([]any)
		if len(input) != 1 {
			t.Fatalf("input %v", input)
		}
		if _, exists := body["reasoning"]; exists {
			t.Fatal("reasoning must stay omitted without an explicit thinking hint")
		}
		metadata, _ := body["client_metadata"].(map[string]any)
		if metadata["x-codex-installation-id"] != codexInstallationID(7) || metadata["x-codex-window-id"] != codexWindowID(7) {
			t.Fatalf("client_metadata %v", body["client_metadata"])
		}
		return codexResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(codexChatRequest(t, true))
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
	// 用量帧必须带正确的 prompt/completion tokens，并以 [DONE] 收尾。
	if !strings.Contains(text, `"prompt_tokens":5`) || !strings.Contains(text, `"completion_tokens":2`) || !strings.Contains(text, `"total_tokens":7`) {
		t.Fatalf("usage frame missing: %q", text)
	}
	if !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("missing [DONE]: %q", text)
	}
}

// 非流式下游：上游事件流被聚合成一个 chat.completion JSON。
func TestCodexTransportChatNonStreamAggregates(t *testing.T) {
	mockCodexResolver(t, services.CodexCredential{AccessToken: "codex-access", ExpiresAt: 4102444800}, nil)
	transport := &codexTransport{base: codexTransportMock(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Fatalf("upstream must always be streamed: %v", body)
		}
		return codexResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(codexChatRequest(t, false))
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

// 身份值必须确定性且形状为 UUID v4。
func TestCodexTransportIdentityDeterministic(t *testing.T) {
	if codexInstallationID(7) != codexInstallationID(7) || codexWindowID(7) != codexWindowID(7) || codexSessionID(7) != codexSessionID(7) {
		t.Fatal("identity helpers are not deterministic")
	}
	if codexInstallationID(7) == codexInstallationID(8) || codexSessionID(7) == codexSessionID(8) {
		t.Fatal("identity must differ across channels")
	}
	// 三个身份由不同命名空间派生，不允许互相撞值。
	values := map[string]bool{codexInstallationID(7): true, codexWindowID(7): true, codexSessionID(7): true}
	if len(values) != 3 {
		t.Fatalf("identity values collide: %v", values)
	}
	if len(codexInstallationID(7)) != 32 || len(codexWindowID(7)) != 32 {
		t.Fatalf("install/window must be 32 hex chars: %q %q", codexInstallationID(7), codexWindowID(7))
	}
	uuidV4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if !uuidV4.MatchString(codexSessionID(7)) || !uuidV4.MatchString(codexSessionID(123456789)) {
		t.Fatalf("session id is not uuid v4: %q", codexSessionID(7))
	}
}

// 401 先强制刷新重试一次；第二次成功则透传成功响应，且第二次用的是新令牌。
func TestCodexTransportRetriesOnceAfterForceRefresh(t *testing.T) {
	mockCodexResolver(t, services.CodexCredential{AccessToken: "stale-token", ExpiresAt: 4102444800}, nil)
	mockCodexForceRefresh(t, services.CodexCredential{AccessToken: "fresh-token", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &codexTransport{base: codexTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer stale-token" {
			return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error":"bad-credentials"}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Fatalf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		return codexResponsesSSE(), nil
	})}
	resp, err := transport.RoundTrip(codexChatRequest(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d", resp.StatusCode, calls.Load())
	}
}

// 401/403 且刷新无效时给出「重新一键登录」错误（统一按 401 语义返回）。
func TestCodexTransportUpstream401YieldsReloginMessage(t *testing.T) {
	for _, status := range []int{401, 403} {
		mockCodexResolver(t, services.CodexCredential{AccessToken: "codex-access", ExpiresAt: 4102444800}, nil)
		mockCodexForceRefresh(t, services.CodexCredential{}, context.DeadlineExceeded)
		transport := &codexTransport{base: codexTransportMock(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>denied</html>"))}, nil
		})}
		resp, err := transport.RoundTrip(codexChatRequest(t, true))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("upstream %d must surface as 401, got %d", status, resp.StatusCode)
		}
		// 错误体必须是 jsonErrorMessage 的形状（与 Grok 的重登录错误一致）。
		var body struct {
			Error struct {
				Message string `json:"message"`
				Type    string `json:"type"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &body) != nil || body.Error.Message != "Codex 登录已过期，请重新一键登录" || body.Error.Type == "" {
			t.Fatalf("relogin error body %q", raw)
		}
	}
}

// 内部标识绝不允许发往非官方主机（含仿冒域名与 http）；未知路径也不许带凭据转发。
func TestCodexTransportRejectsMarkerElsewhere(t *testing.T) {
	resolved := false
	oldResolve := resolveCodexCredential
	resolveCodexCredential = func(context.Context, int64) (services.CodexCredential, error) {
		resolved = true
		return services.CodexCredential{AccessToken: "codex-access", ExpiresAt: 4102444800}, nil
	}
	t.Cleanup(func() { resolveCodexCredential = oldResolve })
	called := false
	transport := &codexTransport{base: codexTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	for _, target := range []string{
		"https://unrelated.example/backend-api/codex/responses",
		"https://chatgpt.com.evil.example/backend-api/codex/responses",
		"http://chatgpt.com/backend-api/codex/responses",
	} {
		req, _ := http.NewRequest("POST", target, nil)
		req.Header.Set("Authorization", "Bearer ooapi-codex-channel-7")
		if _, err := transport.RoundTrip(req); err == nil || called || resolved {
			t.Fatalf("internal marker forwarded to %s", target)
		}
	}
	// 官方主机上的未知路径（如 embeddings）必须拒绝，不得外发凭据。
	req2, _ := http.NewRequest("POST", "https://chatgpt.com/backend-api/codex/embeddings", nil)
	req2.Header.Set("Authorization", "Bearer ooapi-codex-channel-7")
	if _, err := transport.RoundTrip(req2); err == nil || called || resolved {
		t.Fatal("marker forwarded to unsupported path")
	}
}

// 非标识请求原样透传（api 渠道不受影响）；无关主机也必须原样透传。
func TestCodexTransportPassesThroughNonInternal(t *testing.T) {
	var seen atomic.Int32
	transport := &codexTransport{base: codexTransportMock(func(r *http.Request) (*http.Response, error) {
		seen.Add(1)
		if r.Header.Get("Authorization") != "Bearer real-api-key" {
			t.Fatalf("auth rewritten: %q", r.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("ok"))}, nil
	})}
	// 无关主机：原样透传。
	req, _ := http.NewRequest("POST", "https://unrelated.example/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req); err != nil || seen.Load() != 1 {
		t.Fatal("unrelated host must pass through unchanged")
	}
	// 官方主机上的 api 渠道（管理员自填 key）：URL 与鉴权头都不得被改写。
	req2, _ := http.NewRequest("GET", "https://chatgpt.com/backend-api/codex/models", nil)
	req2.Header.Set("Authorization", "Bearer real-api-key")
	resp, err := transport.RoundTrip(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if seen.Load() != 2 || resp.StatusCode != 200 {
		t.Fatalf("plain api-key request on codex host must pass through: calls=%d status=%d", seen.Load(), resp.StatusCode)
	}
	req3, _ := http.NewRequest("POST", "https://chatgpt.com/backend-api/codex/responses", nil)
	req3.Header.Set("Authorization", "Bearer real-api-key")
	if _, err := transport.RoundTrip(req3); err != nil {
		t.Fatal(err)
	}
	if req3.URL.String() != "https://chatgpt.com/backend-api/codex/responses" {
		t.Fatalf("api-key request was rewritten: %s", req3.URL)
	}
	if seen.Load() != 3 {
		t.Fatalf("calls=%d", seen.Load())
	}
}

// 模型列表：与聊天同一通道、同一身份头。
func TestCodexTransportModelsUsesIdentityHeaders(t *testing.T) {
	session := codexSessionID(7)
	mockCodexResolver(t, services.CodexCredential{AccessToken: "codex-access", AccountID: "acc-123", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &codexTransport{base: codexTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.String() != "https://chatgpt.com/backend-api/codex/models" {
			t.Fatalf("url %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer codex-access" || r.Header.Get("Accept") != "application/json" {
			t.Fatalf("headers %v", r.Header)
		}
		if r.Header.Get("Originator") != "codex-tui" || r.Header.Get("session_id") != session || r.Header.Get("Chatgpt-Account-Id") != "acc-123" {
			t.Fatalf("identity headers %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"gpt-5-codex"}]}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://chatgpt.com/backend-api/codex/models", nil)
	req.Header.Set("Authorization", "Bearer ooapi-codex-channel-7")
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), "gpt-5-codex") {
		t.Fatalf("models passthrough %d %q", resp.StatusCode, raw)
	}
	// 模型列表 401 同样给出重新登录提示。
	mockCodexResolver(t, services.CodexCredential{AccessToken: "codex-access", ExpiresAt: 4102444800}, nil)
	failing := &codexTransport{base: codexTransportMock(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader("denied"))}, nil
	})}
	req2, _ := http.NewRequest("GET", "https://chatgpt.com/backend-api/codex/models", nil)
	req2.Header.Set("Authorization", "Bearer ooapi-codex-channel-7")
	resp2, err := failing.RoundTrip(req2)
	if err != nil {
		t.Fatal(err)
	}
	raw2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if resp2.StatusCode != 401 || !strings.Contains(string(raw2), "Codex 登录已过期") {
		t.Fatalf("models 401 %d %q", resp2.StatusCode, raw2)
	}
}
