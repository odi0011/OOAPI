package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"ooapi/internal/services"
)

type clineTransportMock func(*http.Request) (*http.Response, error)

func (f clineTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestClineForwardJSONUsesActualAPIAndUnwrapsUsage(t *testing.T) {
	old := upstreamClient
	t.Cleanup(func() { upstreamClient = old })
	var called bool
	upstreamClient = &http.Client{Transport: &clineTransport{base: clineTransportMock(func(r *http.Request) (*http.Response, error) {
		called = true
		if r.URL.String() != services.ClineAPIBase+"/chat/completions" || r.Header.Get("Authorization") != "Bearer cline-api-key" {
			t.Fatal("wrong API/auth", r.URL, r.Header)
		}
		if r.Header.Get("X-Title") != "OOAPI" || r.Header.Get("User-Agent") != "OOAPI-Gateway/1.0" || r.Header.Get("X-CLIENT-TYPE") != "" {
			t.Fatal("wrong attribution/impersonation", r.Header)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "anthropic/claude-haiku-4.5" {
			t.Fatal("provider model prefix lost")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"success":true,"data":{"model":"anthropic/claude-haiku-4.5","choices":[{"message":{"content":"real-adapter-reply"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}`))}, nil
	})}}
	ch := &services.UpstreamChannel{Vendor: "cline", Method: "api", BaseURL: services.ClineAPIBase, APIKeys: []string{"cline-api-key"}}
	body, usage, err := forwardJSON(context.Background(), ch, []byte(`{"model":"anthropic/claude-haiku-4.5","messages":[{"role":"user","content":"hi"}],"stream":false}`), "anthropic/claude-haiku-4.5")
	if err != nil || !called || usage.PromptTokens != 10 || usage.CompletionTokens != 2 || !strings.Contains(string(body), "real-adapter-reply") {
		t.Fatalf("forward %s %#v %v", body, usage, err)
	}
}
func TestClineTransportRejectsCredentialMarkerToOtherHost(t *testing.T) {
	called := false
	transport := &clineTransport{base: clineTransportMock(func(*http.Request) (*http.Response, error) { called = true; return nil, nil })}
	req, _ := http.NewRequest("POST", "https://unrelated.example/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer ooapi-cline-channel-13")
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("internal marker forwarded")
	}
}
func TestClineTransportPreservesSSEAndUpstreamDenials(t *testing.T) {
	for _, tt := range []struct {
		code       int
		kind, body string
	}{
		{200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"},
		{403, "application/json", `{"error":{"message":"only available via Cline product surfaces"}}`},
	} {
		t.Run(tt.kind, func(t *testing.T) {
			transport := &clineTransport{base: clineTransportMock(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tt.code, Header: http.Header{"Content-Type": []string{tt.kind}}, Body: io.NopCloser(strings.NewReader(tt.body))}, nil
			})}
			req, _ := http.NewRequest("POST", services.ClineAPIBase+"/chat/completions", nil)
			req.Header.Set("Authorization", "Bearer api-key")
			resp, err := transport.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			if string(raw) != tt.body || resp.StatusCode != tt.code {
				t.Fatal("stream or error changed")
			}
		})
	}
}
func TestChannelRejectsOAuthJSONAsAPIKey(t *testing.T) {
	for _, raw := range []string{`{"access_token":"oauth"}`, `["oauth"]`, "ooapi-cline-channel-1"} {
		req := channelRequest{Name: "test", BaseURL: services.ClineAPIBase, APIKey: raw, Models: []string{"claude-sonnet-4.5"}}
		if validateChannelInput(&req, "create") == nil {
			t.Fatal("OAuth/marker accepted as API key")
		}
	}
	req := channelRequest{Name: "test", BaseURL: services.ClineAPIBase, APIKey: "official-key", Models: []string{"claude-sonnet-4.5"}}
	if err := validateChannelInput(&req, "create"); err != nil {
		t.Fatal(err)
	}
}

// TestChannelRequiresAtLeastOneModel 覆盖「至少一个支持的模型」规则。
//
// 创建时无条件要求（models 为空 / 全空白条目都算空）；
// 更新时只在传了 models 字段时校验 —— 没传表示保持库里的原值，
// 不该因为改个备注就卡住。
func TestChannelRequiresAtLeastOneModel(t *testing.T) {
	base := func(models []string) channelRequest {
		return channelRequest{Name: "test", BaseURL: "https://api.example.com/v1", APIKey: "sk-test", Models: models}
	}
	for _, models := range [][]string{nil, {}, {""}, {" ", ""}} {
		if err := validateChannelInput(func() *channelRequest { r := base(models); return &r }(), "create"); err == nil {
			t.Fatalf("create accepted empty models: %#v", models)
		}
	}
	r := base([]string{"glm-5.3"})
	if err := validateChannelInput(&r, "create"); err != nil {
		t.Fatalf("create with one model rejected: %v", err)
	}
	// 更新：不传 models（nil 指针语义通过 Models nil 表达）不校验。
	u := channelRequest{Name: "test"}
	if err := validateChannelInput(&u, "update"); err != nil {
		t.Fatalf("update without models rejected: %v", err)
	}
	// 更新：显式传了空列表必须被拒。
	u2 := channelRequest{Name: "test", Models: []string{}}
	if err := validateChannelInput(&u2, "update"); err == nil {
		t.Fatal("update accepted empty models")
	}
}
