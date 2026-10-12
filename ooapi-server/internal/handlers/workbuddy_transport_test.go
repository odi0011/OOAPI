package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"ooapi/internal/services"
)

type workbuddyTransportMock func(*http.Request) (*http.Response, error)

func (f workbuddyTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockWorkBuddyResolver(t *testing.T, cred services.WorkBuddyCredential, err error) {
	t.Helper()
	old := resolveWorkBuddyCredential
	resolveWorkBuddyCredential = func(context.Context, int64) (services.WorkBuddyCredential, error) { return cred, err }
	t.Cleanup(func() { resolveWorkBuddyCredential = old })
}

func workBuddySSE(chunks ...string) *http.Response {
	body := ""
	for _, c := range chunks {
		body += "data: " + c + "\n\n"
	}
	body += "data: [DONE]\n\n"
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestWorkBuddyTransportChatHeadersAndRewrite(t *testing.T) {
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{
		AccessToken: "wb-token", Realm: "cn", Endpoint: services.WorkBuddyCNBase,
		UserID: "u9", EnterpriseID: "e9", ExpiresAt: 4102444800,
	}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://copilot.tencent.com/v2/chat/completions" {
			t.Fatalf("url %s", r.URL)
		}
		h := r.Header
		checks := map[string]string{
			"Authorization":       "Bearer wb-token",
			"Accept":              "application/json, text/event-stream",
			"Accept-Language":     "zh-CN",
			"X-Requested-With":    "XMLHttpRequest",
			"X-Codebuddy-Request": "1",
			"X-Domain":            "www.codebuddy.cn",
			"X-Product":           "SaaS",
			"X-Ide-Type":          "CLI",
			"X-Ide-Name":          "CLI",
			"X-Ide-Version":       "2.117.2",
			"X-Agent-Intent":      "craft",
			"X-Agent-Purpose":     "conversation",
			"User-Agent":          "CLI/2.117.2 CodeBuddy/2.117.2",
			"Origin":              "https://www.codebuddy.cn",
			"Referer":             "https://www.codebuddy.cn/",
			"X-User-Id":           "u9",
			"X-Enterprise-Id":     "e9",
		}
		for key, want := range checks {
			if got := h.Get(key); got != want {
				t.Errorf("%s=%q want %q", key, got, want)
			}
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		messages, _ := body["messages"].([]any)
		if len(messages) != 3 {
			t.Fatalf("messages %v", messages)
		}
		first := messages[0].(map[string]any)
		if first["role"] != "system" || first["content"] != "You are a helpful assistant." {
			t.Fatalf("system prompt not prepended: %v", first)
		}
		if messages[1].(map[string]any)["role"] != "user" {
			t.Fatalf("user message lost: %v", messages[1])
		}
		if messages[2].(map[string]any)["role"] != "system" {
			t.Fatalf("developer not rewritten: %v", messages[2])
		}
		if body["stream"] != true {
			t.Fatalf("upstream must be streamed: %v", body)
		}
		return workBuddySSE(`{"choices":[{"delta":{"content":"hi"}}]}`, `{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`), nil
	})}
	req, _ := http.NewRequest("POST", "https://www.workbuddy.ai/v2/chat/completions", strings.NewReader(`{"model":"glm-5.3","stream":true,"messages":[{"role":"user","content":"hi"},{"role":"developer","content":"d"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "hi") || !strings.HasSuffix(string(raw), "data: [DONE]\n\n") {
		t.Fatalf("stream changed: %q", raw)
	}
}

func TestWorkBuddyTransportNonStreamAggregates(t *testing.T) {
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: "wb-token", Realm: "global", Endpoint: services.WorkBuddyGlobalBase, ExpiresAt: 4102444800}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Accept-Language") != "en-US" || r.Header.Get("Origin") != "https://www.workbuddy.ai" {
			t.Fatalf("global locale headers %v", r.Header)
		}
		if r.Header.Get("X-No-Enterprise-Id") != "1" || r.Header.Get("X-User-Id") != "" {
			t.Fatalf("no-enterprise headers %v", r.Header)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true {
			t.Fatalf("non-stream request not upgraded: %v", body)
		}
		return workBuddySSE(
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"f","arguments":"{\"x\":1}"}}]}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`,
		), nil
	})}
	req, _ := http.NewRequest("POST", "https://www.workbuddy.ai/v2/chat/completions", strings.NewReader(`{"model":"glm-5.3","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
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
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Choices) != 1 || out.Choices[0].Message.Content != "Hello" || out.Choices[0].FinishReason != "tool_calls" {
		t.Fatalf("aggregated %#v", out)
	}
	tc := out.Choices[0].Message.ToolCalls
	if len(tc) != 1 || tc[0].ID != "call_a" || tc[0].Function.Name != "f" || tc[0].Function.Arguments != `{"x":1}` {
		t.Fatalf("tool call %#v", tc)
	}
	if out.Usage["total_tokens"].(float64) != 7 {
		t.Fatalf("usage %#v", out.Usage)
	}
}

func TestWorkBuddyTransportAuthFailureTellsAdminToRebind(t *testing.T) {
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: "wb-token", Realm: "cn", Endpoint: services.WorkBuddyCNBase, ExpiresAt: 4102444800}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>401</html>"))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://copilot.tencent.com/v2/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"system","content":"s"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 401 || !strings.Contains(string(raw), "登录已过期，请重新一键绑定") {
		t.Fatalf("401 handling %d %q", resp.StatusCode, raw)
	}
}

func TestWorkBuddyTransportModelsConfigConversion(t *testing.T) {
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: "wb-token", Realm: "cn", Endpoint: services.WorkBuddyCNBase, ExpiresAt: 4102444800}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v3/config" || r.Method != "GET" {
			t.Fatalf("config request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("X-Codebuddy-Request") != "1" || r.Header.Get("User-Agent") != "CLI/2.117.2 CodeBuddy/2.117.2" {
			t.Fatalf("config headers %v", r.Header)
		}
		if r.Header.Get("X-Domain") != "www.codebuddy.cn" || r.Header.Get("Accept") != "application/json" {
			t.Fatalf("config headers %v", r.Header)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":{"models":[
			{"id":"glm-5.3"},{"id":"kimi-k3","tags":["text"]},
			{"id":"hunyuan-image"},{"id":"nes-completion"},{"id":"foo-completion-x"},
			{"id":"tagged","tags":["text-to-image"]},{"id":""}
		]}}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://copilot.tencent.com/models", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
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
	if len(out.Data) != 2 || out.Data[0].ID != "glm-5.3" || out.Data[1].ID != "kimi-k3" {
		t.Fatalf("models %#v", out.Data)
	}
}

func TestWorkBuddyTransportRejectsMarkerToOtherHost(t *testing.T) {
	called := false
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	req, _ := http.NewRequest("POST", "https://unrelated.example/v2/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("internal marker forwarded to foreign host")
	}
}

// 本地 auth_expires_at 已过 ≠ 上游一定拒绝：JWT 可能仍然有效，
// 因此传输层不得据此本地拦截，必须把请求发出去、以上游 401/403 为准。
func TestWorkBuddyTransportDoesNotGateOnStoredExpiry(t *testing.T) {
	upstreamCalls := 0
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: "wb-token", Realm: "cn", Endpoint: services.WorkBuddyCNBase, ExpiresAt: 1}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(*http.Request) (*http.Response, error) {
		upstreamCalls++
		return workBuddySSE(`{"choices":[{"delta":{"content":"ok"}}]}`), nil
	})}
	req, _ := http.NewRequest("POST", "https://copilot.tencent.com/v2/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"system","content":"s"}]}`))
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if upstreamCalls != 1 || resp.StatusCode != 200 || !strings.Contains(string(raw), "ok") {
		t.Fatalf("locally-expired credential was not forwarded: calls=%d status=%d body=%q", upstreamCalls, resp.StatusCode, raw)
	}
}

// 上游 401 才是「登录已过期」的唯一判据；错误信息必须保留、引导重新一键绑定。
func TestWorkBuddyTransportUpstream401YieldsRebindMessage(t *testing.T) {
	for _, status := range []int{401, 403} {
		mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: "wb-token", Realm: "cn", Endpoint: services.WorkBuddyCNBase, ExpiresAt: time.Now().Unix() + 86400}, nil)
		transport := &workbuddyTransport{base: workbuddyTransportMock(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader("<html>denied</html>"))}, nil
		})}
		req, _ := http.NewRequest("POST", "https://copilot.tencent.com/v2/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"system","content":"s"}]}`))
		req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != status || !strings.Contains(string(raw), "登录已过期，请重新一键绑定") {
			t.Fatalf("upstream %d handling %d %q", status, resp.StatusCode, raw)
		}
	}
}

// 凭据直接带 JWT 时，models 链路同样不被本地过期时间拦截。
func TestWorkBuddyTransportModelsForwardsExpiredJWTCredential(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1000000000}`))
	jwt := "h." + payload + ".s"
	mockWorkBuddyResolver(t, services.WorkBuddyCredential{AccessToken: jwt, Realm: "cn", Endpoint: services.WorkBuddyCNBase, ExpiresAt: 2}, nil)
	transport := &workbuddyTransport{base: workbuddyTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v3/config" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+jwt {
			t.Fatalf("token not forwarded: %q", r.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":{"models":[{"id":"glm-5.3"}]}}`))}, nil
	})}
	req, _ := http.NewRequest("GET", "https://copilot.tencent.com/models", nil)
	req.Header.Set("Authorization", "Bearer "+services.DeviceCredentialMarker("workbuddy", 7))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
