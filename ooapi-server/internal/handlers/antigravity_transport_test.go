package handlers

// Antigravity（Google 订阅）传输层测试：凭据解析、项目号引导与强制刷新全部替换为
// mock，不依赖数据库、不联网。

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

type antigravityTransportMock func(*http.Request) (*http.Response, error)

func (f antigravityTransportMock) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockAntigravityResolver(t *testing.T, cred services.AntigravityCredential, err error) {
	t.Helper()
	old := resolveAntigravityCredential
	resolveAntigravityCredential = func(context.Context, int64) (services.AntigravityCredential, error) { return cred, err }
	t.Cleanup(func() { resolveAntigravityCredential = old })
}

func mockAntigravityForceRefresh(t *testing.T, cred services.AntigravityCredential, err error) {
	t.Helper()
	old := forceRefreshAntigravityCredential
	forceRefreshAntigravityCredential = func(context.Context, int64) (services.AntigravityCredential, error) { return cred, err }
	t.Cleanup(func() { forceRefreshAntigravityCredential = old })
}

// mockAntigravityProject 替换项目号引导：测试不发 loadCodeAssist / onboardUser。
func mockAntigravityProject(t *testing.T, project string, err error) {
	t.Helper()
	old := antigravityProjectFor
	antigravityProjectFor = func(context.Context, int64, services.AntigravityCredential) (string, error) { return project, err }
	t.Cleanup(func() { antigravityProjectFor = old })
}

func antigravityTestCredential() services.AntigravityCredential {
	return services.AntigravityCredential{
		AccessToken:  "google-access",
		RefreshToken: "google-refresh",
		ExpiresAt:    4102444800,
		ProjectID:    "proj-1",
	}
}

func antigravityMarker() string { return antigravityMarkerPrefix + "7" }

func antigravityChatRequest(t *testing.T, payload string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "https://daily-cloudcode-pa.googleapis.com/v1internal/chat/completions", strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+antigravityMarker())
	req.Header.Set("Content-Type", "application/json")
	return req
}

// antigravitySSE 把若干数据载荷拼成一段 alt=sse 响应体。
func antigravitySSE(payloads ...string) *http.Response {
	var sb strings.Builder
	for _, payload := range payloads {
		sb.WriteString("data: " + payload + "\n\n")
	}
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(sb.String())),
	}
}

// antigravityChunks 解析转换后的 OpenAI SSE 分块（跳过 [DONE]）。
func antigravityChunks(t *testing.T, raw string) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			t.Fatalf("分块不是合法 JSON：%v（%q）", err, payload)
		}
		out = append(out, chunk)
	}
	return out
}

func antigravityDelta(t *testing.T, chunk map[string]any) map[string]any {
	t.Helper()
	choices, _ := chunk["choices"].([]any)
	if len(choices) != 1 {
		t.Fatalf("choices %v", chunk["choices"])
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	return delta
}

// ---------- 主机白名单与路径守卫 ----------

// 内部标识只允许发往官方主机；未知路径同样拒绝，且解析凭据前就拦下（不泄密）。
func TestAntigravityTransportRejectsMarkerElsewhere(t *testing.T) {
	var resolverCalls atomic.Int32
	mockAntigravityProject(t, "proj-1", nil)
	old := resolveAntigravityCredential
	resolveAntigravityCredential = func(context.Context, int64) (services.AntigravityCredential, error) {
		resolverCalls.Add(1)
		return antigravityTestCredential(), nil
	}
	t.Cleanup(func() { resolveAntigravityCredential = old })

	called := false
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})}
	// 内部标识 → 非官方主机：必须报错。
	req, _ := http.NewRequest(http.MethodPost, "https://unrelated.example/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+antigravityMarker())
	if _, err := transport.RoundTrip(req); err == nil || called {
		t.Fatal("Google 内部标识被转发到了非官方主机")
	}
	// 官方主机 + 内部标识，但路径不在白名单（如 embeddings）：拒绝。
	req2, _ := http.NewRequest(http.MethodPost, "https://daily-cloudcode-pa.googleapis.com/v1internal:embedContent", strings.NewReader(`{}`))
	req2.Header.Set("Authorization", "Bearer "+antigravityMarker())
	if _, err := transport.RoundTrip(req2); err == nil || called {
		t.Fatal("未知路径携带了 Google 内部标识")
	}
	// 以上两例都不得触发凭据解析（标识不能被当成可解析的凭据泄漏出去）。
	if resolverCalls.Load() != 0 {
		t.Fatalf("凭据在守卫之前被解析了 %d 次", resolverCalls.Load())
	}
}

// 非内部请求原样透传：官方主机上的自填 key 渠道与其它主机的普通请求都不受影响。
func TestAntigravityTransportPassesPlainRequestsThrough(t *testing.T) {
	mockAntigravityProject(t, "proj-1", nil)
	calls := []string{}
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.Method+" "+r.URL.String()+" "+r.Header.Get("Authorization"))
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	// 官方主机上使用真实 API key 的 api 渠道请求。
	plain, _ := http.NewRequest(http.MethodPost, "https://cloudcode-pa.googleapis.com/v1internal/chat/completions", strings.NewReader(`{}`))
	plain.Header.Set("Authorization", "Bearer real-api-key")
	resp, err := transport.RoundTrip(plain)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("plain request on official host: %v %v", err, resp)
	}
	resp.Body.Close()
	// 非官方主机的普通请求。
	other, _ := http.NewRequest(http.MethodGet, "https://api.example.com/v1/models", nil)
	resp2, err := transport.RoundTrip(other)
	if err != nil || resp2.StatusCode != 200 {
		t.Fatalf("plain request elsewhere: %v %v", err, resp2)
	}
	resp2.Body.Close()
	if len(calls) != 2 || calls[0] != "POST https://cloudcode-pa.googleapis.com/v1internal/chat/completions Bearer real-api-key" {
		t.Fatalf("透传被改写了：%v", calls)
	}
}

// ---------- 请求信封 ----------

// 聊天：URL / 头组 / 信封形状（键序、contents、systemInstruction、generationConfig）。
func TestAntigravityTransportChatEnvelope(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	var rawBody []byte
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse" {
			t.Fatalf("url %s", r.URL)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer google-access" {
			t.Fatalf("authorization %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != "antigravity/hub/2.9.1 darwin/arm64" {
			t.Fatalf("user-agent %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("content-type %q", got)
		}
		rawBody, _ = io.ReadAll(r.Body)
		return antigravitySSE(`{"response":{"candidates":[{"content":{"parts":[{"text":"好"}]}}]}}`, `{"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}`), nil
	})}

	payload := `{"model":"gemini-2.5-pro","stream":true,"max_tokens":4096,"messages":[` +
		`{"role":"system","content":"规则一"},{"role":"system","content":"规则二"},` +
		`{"role":"assistant","content":"开头先说话"},` +
		`{"role":"user","content":[{"type":"text","text":"你好"},{"type":"image_url","image_url":{"url":"https://x/1.png"}}]},` +
		`{"role":"assistant","content":"上一答"},{"role":"user","content":"继续"}]}`
	resp, err := transport.RoundTrip(antigravityChatRequest(t, payload))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatal(err)
	}

	text := string(rawBody)
	// 顶层键序与原始实现一致：model → userAgent → requestType → project → requestId → request。
	if !strings.HasPrefix(text, `{"model":"gemini-2.5-pro","userAgent":"antigravity","requestType":"agent","project":"proj-1","requestId":"agent-`) {
		t.Fatalf("信封前缀不对：%.160s", text)
	}
	var envelope struct {
		Model       string `json:"model"`
		UserAgent   string `json:"userAgent"`
		RequestType string `json:"requestType"`
		Project     string `json:"project"`
		RequestID   string `json:"requestId"`
		Request     struct {
			Contents          []map[string]any `json:"contents"`
			SessionID         string           `json:"sessionId"`
			SystemInstruction map[string]any   `json:"systemInstruction"`
			GenerationConfig  map[string]any   `json:"generationConfig"`
			Tools             []any            `json:"tools"`
		} `json:"request"`
	}
	if err := json.Unmarshal(rawBody, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Model != "gemini-2.5-pro" || envelope.UserAgent != "antigravity" || envelope.RequestType != "agent" {
		t.Fatalf("envelope %+v", envelope)
	}
	if envelope.Project == "" {
		t.Fatal("project 不能为空")
	}
	if !strings.HasPrefix(envelope.RequestID, "agent-") {
		t.Fatalf("requestId %q", envelope.RequestID)
	}
	if !strings.HasPrefix(envelope.Request.SessionID, "-") {
		t.Fatalf("sessionId %q", envelope.Request.SessionID)
	}
	if len(envelope.Request.Contents) != 3 {
		t.Fatalf("contents %v", envelope.Request.Contents)
	}
	first := envelope.Request.Contents[0]
	if first["role"] != "user" {
		t.Fatalf("首条必须是 user：%v", first)
	}
	parts, _ := first["parts"].([]any)
	part, _ := parts[0].(map[string]any)
	if part["text"] != "你好" {
		t.Fatalf("文本归一化错误（图片片必须忽略）：%v", part)
	}
	if envelope.Request.Contents[1]["role"] != "model" || envelope.Request.Contents[2]["role"] != "user" {
		t.Fatalf("角色映射错误：%v", envelope.Request.Contents)
	}
	systemParts, _ := envelope.Request.SystemInstruction["parts"].([]any)
	systemPart, _ := systemParts[0].(map[string]any)
	if systemPart["text"] != "规则一\n\n规则二" {
		t.Fatalf("systemInstruction %v", envelope.Request.SystemInstruction)
	}
	if envelope.Request.GenerationConfig["maxOutputTokens"] != float64(4096) {
		t.Fatalf("generationConfig %v", envelope.Request.GenerationConfig)
	}
	if envelope.Request.Tools != nil {
		t.Fatalf("没给工具时不应出现 tools：%v", envelope.Request.Tools)
	}
	// request 内部键序：contents → sessionId → systemInstruction → generationConfig。
	contentsPos := strings.Index(text, `"contents"`)
	sessionPos := strings.Index(text, `"sessionId"`)
	systemPos := strings.Index(text, `"systemInstruction"`)
	generationPos := strings.Index(text, `"generationConfig"`)
	if !(contentsPos < sessionPos && sessionPos < systemPos && systemPos < generationPos) {
		t.Fatalf("request 键序错误：%d %d %d %d", contentsPos, sessionPos, systemPos, generationPos)
	}
}

// 模型名含 image 时 requestType 必须是 image_gen。
func TestAntigravityTransportImageGenRequestType(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	var requestType string
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		requestType, _ = body["requestType"].(string)
		return antigravitySSE(`{"response":{"candidates":[{"finishReason":"STOP"}]}}`), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-flash-image-preview","stream":true,"messages":[{"role":"user","content":"画一只猫"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if requestType != "image_gen" {
		t.Fatalf("requestType %q", requestType)
	}
}

// 带工具来回的对话：contents 必须换成结构化形状（functionCall / functionResponse）。
func TestAntigravityTransportStructuredToolContents(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	var envelope struct {
		Request struct {
			Contents []map[string]any `json:"contents"`
		} `json:"request"`
	}
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		return antigravitySSE(`{"response":{"candidates":[{"finishReason":"STOP"}]}}`), nil
	})}
	payload := `{"model":"gemini-2.5-pro","stream":true,"messages":[` +
		`{"role":"user","content":"北京天气"},` +
		`{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"},"thoughtSignature":"sig-1"}]},` +
		`{"role":"tool","tool_call_id":"call_1","content":[{"type":"text","text":"晴"}]}]}`
	resp, err := transport.RoundTrip(antigravityChatRequest(t, payload))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if len(envelope.Request.Contents) != 3 {
		t.Fatalf("contents %v", envelope.Request.Contents)
	}
	parts, _ := envelope.Request.Contents[1]["parts"].([]any)
	callPart, _ := parts[0].(map[string]any)
	call, _ := callPart["functionCall"].(map[string]any)
	if call["id"] != "call_1" || call["name"] != "get_weather" {
		t.Fatalf("functionCall %v", callPart)
	}
	args, _ := call["args"].(map[string]any)
	if args["city"] != "北京" {
		t.Fatalf("args 必须是解析后的对象：%v", call["args"])
	}
	if callPart["thoughtSignature"] != "sig-1" {
		t.Fatalf("thoughtSignature 丢失：%v", callPart)
	}
	toolParts, _ := envelope.Request.Contents[2]["parts"].([]any)
	toolPart, _ := toolParts[0].(map[string]any)
	response, _ := toolPart["functionResponse"].(map[string]any)
	if response["id"] != "call_1" || response["name"] != "get_weather" {
		t.Fatalf("functionResponse %v", toolPart)
	}
	inner, _ := response["response"].(map[string]any)
	if inner["output"] != "晴" {
		t.Fatalf("functionResponse.response %v", response["response"])
	}
}

// 工具定义与 tool_choice：functionDeclarations / functionCallingConfig 的映射。
func TestAntigravityTransportToolDefinitionsAndChoice(t *testing.T) {
	tools := `"tools":[{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]`
	cases := []struct {
		name        string
		choice      string
		wantMode    string
		wantAllowed string
	}{
		{"none", `"none"`, "NONE", ""},
		{"required", `"required"`, "ANY", ""},
		{"any", `"any"`, "ANY", ""},
		{"auto", `"auto"`, "AUTO", ""},
		{"explicit", `{"type":"function","function":{"name":"get_weather"}}`, "ANY", "get_weather"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mockAntigravityResolver(t, antigravityTestCredential(), nil)
			mockAntigravityProject(t, "proj-1", nil)
			var request struct {
				Request struct {
					Tools      []any          `json:"tools"`
					ToolConfig map[string]any `json:"toolConfig"`
				} `json:"request"`
			}
			transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &request); err != nil {
					t.Fatal(err)
				}
				return antigravitySSE(`{"response":{"candidates":[{"finishReason":"STOP"}]}}`), nil
			})}
			payload := `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}],` + tools + `,"tool_choice":` + tc.choice + `}`
			resp, err := transport.RoundTrip(antigravityChatRequest(t, payload))
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()

			if len(request.Request.Tools) != 1 {
				t.Fatalf("tools %v", request.Request.Tools)
			}
			config, _ := request.Request.ToolConfig["functionCallingConfig"].(map[string]any)
			if config["mode"] != tc.wantMode {
				t.Fatalf("mode %v want %q", request.Request.ToolConfig, tc.wantMode)
			}
			if tc.wantAllowed == "" {
				if _, ok := config["allowedFunctionNames"]; ok {
					t.Fatalf("不应出现 allowedFunctionNames：%v", config)
				}
			} else {
				names, _ := config["allowedFunctionNames"].([]any)
				if len(names) != 1 || names[0] != tc.wantAllowed {
					t.Fatalf("allowedFunctionNames %v", config["allowedFunctionNames"])
				}
			}
		})
	}
}

// ---------- 确定性身份 ----------

func TestAntigravityIdentityDeterministic(t *testing.T) {
	if antigravityRequestID(7) != antigravityRequestID(7) || antigravitySessionNegID(7) != antigravitySessionNegID(7) {
		t.Fatal("身份必须对同一渠道稳定")
	}
	if antigravityRequestID(7) == antigravityRequestID(8) || antigravitySessionNegID(7) == antigravitySessionNegID(8) {
		t.Fatal("不同渠道的身份不能相同")
	}
	requestID := regexp.MustCompile(`^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if !requestID.MatchString(antigravityRequestID(7)) {
		t.Fatalf("requestId 不是 UUID v4 形状：%q", antigravityRequestID(7))
	}
	sessionID := regexp.MustCompile(`^-[0-9]+$`)
	if !sessionID.MatchString(antigravitySessionNegID(7)) {
		t.Fatalf("sessionId 形状错误：%q", antigravitySessionNegID(7))
	}
}

// ---------- 响应转换 ----------

// 流式：正文 / 思考 / 末尾 usage 帧（usage 常晚于 STOP 到达）。
func TestAntigravityTransportStreamConversion(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return antigravitySSE(
			`{"response":{"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}}`,
			`{"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"思考中"}]}}]}}`,
			`{"response":{"candidates":[{"finishReason":"STOP"}]}}`,
			`{"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3,"totalTokenCount":18,"cachedContentTokenCount":2}}}`,
		), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content-type %q", resp.Header.Get("Content-Type"))
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("缺少 [DONE]：%q", text)
	}
	chunks := antigravityChunks(t, text)
	if len(chunks) != 3 {
		t.Fatalf("分块数 %d：%q", len(chunks), text)
	}
	if delta := antigravityDelta(t, chunks[0]); delta["content"] != "你好" {
		t.Fatalf("正文增量 %v", chunks[0])
	}
	if delta := antigravityDelta(t, chunks[1]); delta["reasoning_content"] != "思考中" {
		t.Fatalf("思考增量 %v", chunks[1])
	}
	final := chunks[2]
	choice := final["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "stop" {
		t.Fatalf("finish_reason %v", choice["finish_reason"])
	}
	usage, _ := final["usage"].(map[string]any)
	// 思考 token 也属于补全消耗：completion = candidates + thoughts。
	want := map[string]float64{"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18, "cached_tokens": 2}
	for key, value := range want {
		if usage[key] != value {
			t.Fatalf("usage[%s]=%v want %v（%v）", key, usage[key], value, usage)
		}
	}
}

// 非流式下游：上游流被聚合成单个 chat.completion JSON。
func TestAntigravityTransportNonStreamAggregates(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		return antigravitySSE(
			`{"response":{"modelVersion":"gemini-2.5-pro-001","candidates":[{"content":{"parts":[{"text":"你"}]}}]}}`,
			`{"response":{"candidates":[{"content":{"parts":[{"text":"好"}]}}]}}`,
			`{"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}}`,
		), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("content-type %q", resp.Header.Get("Content-Type"))
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
	if out.Object != "chat.completion" || len(out.Choices) != 1 {
		t.Fatalf("聚合结果 %+v", out)
	}
	if out.Choices[0].Message.Content != "你好" || out.Choices[0].FinishReason != "stop" {
		t.Fatalf("合并文本 %+v", out.Choices[0])
	}
	if out.Usage["total_tokens"] != float64(6) {
		t.Fatalf("usage %v", out.Usage)
	}
}

// functionCall 分片 → OpenAI tool_calls 增量。
func TestAntigravityTransportToolCallFrame(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return antigravitySSE(
			`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_abc","name":"get_weather","args":{"city":"北京"}}}]}}]}}`,
			`{"response":{"candidates":[{"finishReason":"STOP"}]}}`,
		), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	chunks := antigravityChunks(t, string(raw))
	if len(chunks) != 2 {
		t.Fatalf("分块数 %d：%q", len(chunks), raw)
	}
	delta := antigravityDelta(t, chunks[0])
	calls, _ := delta["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls %v", delta)
	}
	call, _ := calls[0].(map[string]any)
	if call["id"] != "call_abc" || call["type"] != "function" {
		t.Fatalf("call %v", call)
	}
	function, _ := call["function"].(map[string]any)
	if function["name"] != "get_weather" {
		t.Fatalf("function %v", function)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(function["arguments"].(string)), &args); err != nil || args["city"] != "北京" {
		t.Fatalf("arguments %v（%v）", function["arguments"], err)
	}
	finalChoice := chunks[1]["choices"].([]any)[0].(map[string]any)
	if finalChoice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason %v", finalChoice["finish_reason"])
	}
}

// ---------- 401 刷新重试 ----------

// 401 → 强制刷新 → 用新令牌重放成功。
func TestAntigravityTransportRetriesOnceAfterForceRefresh(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	mockAntigravityForceRefresh(t, services.AntigravityCredential{AccessToken: "fresh-token", ExpiresAt: 4102444800}, nil)
	var calls atomic.Int32
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer google-access" {
			return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":401,"message":"bad"}}`))}, nil
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Fatalf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		return antigravitySSE(`{"response":{"candidates":[{"finishReason":"STOP"}]}}`), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d", resp.StatusCode, calls.Load())
	}
}

// 401 且刷新拿不到新令牌（失败或令牌没变）→ 可读的重登错误；不重复打上游。
func TestAntigravityTransport401YieldsReloginMessage(t *testing.T) {
	cases := []struct {
		name  string
		fresh services.AntigravityCredential
		err   error
	}{
		{"refresh-failed", services.AntigravityCredential{}, context.DeadlineExceeded},
		{"token-unchanged", services.AntigravityCredential{AccessToken: "google-access"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mockAntigravityResolver(t, antigravityTestCredential(), nil)
			mockAntigravityProject(t, "proj-1", nil)
			mockAntigravityForceRefresh(t, tc.fresh, tc.err)
			var calls atomic.Int32
			transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				return &http.Response{StatusCode: 401, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":401,"message":"bad"}}`))}, nil
			})}
			resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 401 || !strings.Contains(string(raw), "Google 登录已过期，请重新一键登录") {
				t.Fatalf("status=%d body=%q", resp.StatusCode, raw)
			}
			if calls.Load() != 1 {
				t.Fatalf("没有换到新令牌时不允许重放：calls=%d", calls.Load())
			}
		})
	}
}

// ---------- 模型列表 ----------

// fetchAvailableModels：改写 URL/方法/请求体，对象形状的模型表转 OpenAI 列表并过滤排序。
func TestAntigravityTransportModels(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-9", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels" {
			t.Fatalf("url %s", r.URL)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer google-access" || r.Header.Get("User-Agent") != "antigravity/hub/2.9.1 darwin/arm64" {
			t.Fatalf("headers %v", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != `{"project":"proj-9"}` {
			t.Fatalf("body %s", raw)
		}
		models := `{"models":{"chat_foo":{},"tab_bar":{},"gemini-2.5-pro":{"x":1},"gemini-2.5-flash":{}}}`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(models))}, nil
	})}
	req, _ := http.NewRequest(http.MethodGet, "https://daily-cloudcode-pa.googleapis.com/v1internal/models", nil)
	req.Header.Set("Authorization", "Bearer "+antigravityMarker())
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "list" || len(out.Data) != 2 {
		t.Fatalf("模型列表 %+v", out)
	}
	if out.Data[0].ID != "gemini-2.5-flash" || out.Data[1].ID != "gemini-2.5-pro" {
		t.Fatalf("必须过滤 chat_/tab_ 并按升序：%+v", out.Data)
	}
	for _, item := range out.Data {
		if item.Object != "model" || item.OwnedBy != "google" {
			t.Fatalf("条目形状 %+v", item)
		}
	}
}

// 模型列表 401/403 → 重登错误。
func TestAntigravityTransportModels401(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"denied"}}`))}, nil
	})}
	req, _ := http.NewRequest(http.MethodGet, "https://daily-cloudcode-pa.googleapis.com/v1internal/models", nil)
	req.Header.Set("Authorization", "Bearer "+antigravityMarker())
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 403 || !strings.Contains(string(raw), "Google 登录已过期，请重新一键登录") {
		t.Fatalf("status=%d body=%q", resp.StatusCode, raw)
	}
}

// ---------- 整包 JSON / 数组载荷 / 流内错误 ----------

// Content-Type 为 application/json 时整个响应体是一个载荷（不走 data: 前缀）。
func TestAntigravityTransportJSONPayloadResponse(t *testing.T) {
	jsonResp := func(body string) *http.Response {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
	}
	// 流式下游：整包也应被转成 OpenAI 分块。
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	streamTransport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return jsonResp(`{"response":{"candidates":[{"content":{"parts":[{"text":"整包正文"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}}`), nil
	})}
	resp, err := streamTransport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	chunks := antigravityChunks(t, string(raw))
	if len(chunks) != 2 || antigravityDelta(t, chunks[0])["content"] != "整包正文" {
		t.Fatalf("整包 JSON 未转换：%q", raw)
	}

	// 非流式下游：整包聚合为一个 chat.completion；载荷也可以是数组。
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	aggregateTransport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return jsonResp(`[{"response":{"candidates":[{"content":{"parts":[{"text":"数组"}]}}]}},{"response":{"candidates":[{"content":{"parts":[{"text":"载荷"}]}},{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}]`), nil
	})}
	resp2, err := aggregateTransport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var out struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "chat.completion" || out.Choices[0].Message.Content != "数组载荷" {
		t.Fatalf("数组载荷聚合错误：%+v", out)
	}
}

// 流内错误（HTTP 200 的错误体）：非流式下游必须拿到错误而不是「空回答」成功。
func TestAntigravityTransportInStreamErrorNonStream(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return antigravitySSE(`{"response":{"error":{"code":429,"message":"quota exceeded"}}}`), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":false,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 400 || !strings.Contains(string(raw), "quota exceeded") {
		t.Fatalf("流内错误被当成成功：%d %q", resp.StatusCode, raw)
	}
}

// 流式下游遇到流内错误：输出 OpenAI 错误事件并终止（不能把错误静默丢掉）。
func TestAntigravityTransportInStreamErrorStreaming(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	transport := &antigravityTransport{base: antigravityTransportMock(func(*http.Request) (*http.Response, error) {
		return antigravitySSE(`{"response":{"candidates":[{"content":{"parts":[{"text":"半截"}]}}]}}`, `{"error":{"code":500,"message":"boom"}}`), nil
	})}
	resp, err := transport.RoundTrip(antigravityChatRequest(t, `{"model":"gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	text := string(raw)
	if !strings.Contains(text, `"content":"半截"`) {
		t.Fatalf("正文增量丢失：%q", text)
	}
	if !strings.Contains(text, "boom") || !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("错误事件未输出或未收尾：%q", text)
	}
}

// 结构化工具对话里首条是 assistant（带 tool_calls）时，同样要补一条空 user 开头。
func TestAntigravityTransportStructuredContentsPrependsUser(t *testing.T) {
	mockAntigravityResolver(t, antigravityTestCredential(), nil)
	mockAntigravityProject(t, "proj-1", nil)
	var envelope struct {
		Request struct {
			Contents []map[string]any `json:"contents"`
		} `json:"request"`
	}
	transport := &antigravityTransport{base: antigravityTransportMock(func(r *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		return antigravitySSE(`{"response":{"candidates":[{"finishReason":"STOP"}]}}`), nil
	})}
	payload := `{"model":"gemini-2.5-pro","stream":true,"messages":[` +
		`{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},` +
		`{"role":"tool","tool_call_id":"c1","content":"result"}]}`
	resp, err := transport.RoundTrip(antigravityChatRequest(t, payload))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if len(envelope.Request.Contents) != 3 || envelope.Request.Contents[0]["role"] != "user" {
		t.Fatalf("结构化 contents 缺少 leading user：%v", envelope.Request.Contents)
	}
	parts, _ := envelope.Request.Contents[0]["parts"].([]any)
	part, _ := parts[0].(map[string]any)
	if text, _ := part["text"].(string); text != "" {
		t.Fatalf("leading user 应为空文本：%v", part)
	}
}
