package handlers

// Antigravity（Google 订阅 · Antigravity / Gemini Code Assist OAuth）传输层
// （RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-antigravity-channel-{id}"，真实凭据加密存在
// auth_credential（vendor=gemini、method=antigravity）。请求打到官方私有主机
// daily-cloudcode-pa.googleapis.com / cloudcode-pa.googleapis.com 时：
//
//   - 用标识换出解密后的 Google access_token（必要时提前续期，单飞 + CAS）；
//     Google Cloud 项目号走 services.AntigravityProjectFor（首次自动引导并落库，
//     本层不重复实现引导流程）；
//   - POST /chat/completions → POST /v1internal:streamGenerateContent?alt=sse：
//     请求体翻成 Google 私有信封 {model, userAgent, requestType, project,
//     requestId, request:{contents, sessionId, systemInstruction, generationConfig,
//     tools, toolConfig}}；requestId / sessionId 由渠道 ID 确定性派生（重启不变，
//     见 antigravityIdentityHex），身份乱跳会被上游当风控特征；
//   - 上游响应是 Gemini 形状的 SSE（alt=sse），本层实时转成 OpenAI
//     chat-completions 分块，下游通用管线（protocol.go）原样透传；下游要非流式时
//     把同一个转换流聚合成一个 chat.completion JSON；
//   - GET /models → POST /v1internal:fetchAvailableModels，把对象形状的模型表
//     转成 OpenAI 模型列表（剔除 chat_/tab_ 档位）；
//   - 401/403：先强制刷新凭据重试一次（只在确实换到新令牌时重放），仍被拒则返回
//     「Google 登录已过期，请重新一键登录」。
//
// 该主机上的请求只带一种凭据：内部标识。凭据永远不会被发往其它主机；
// oauth2.googleapis.com 故意不在白名单里 —— 刷新流程由 services 自己的客户端承担，
// 网关侧带标识的请求没有理由打到那里。

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"ooapi/internal/services"
)

const (
	antigravityMarkerPrefix = "ooapi-antigravity-channel-"
	antigravityMaxBodyBytes = 32 << 20
	// antigravityMaxSSELine 防止上游异常数据把内存撑爆（原始实现的单行上限为 8MB）。
	antigravityMaxSSELine = 8 << 20

	// 固定官方地址：凭据只可能发往这里（原始实现同样把 URL 写死）。
	antigravityChatURL   = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
	antigravityModelsURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"

	// antigravityCLIUserAgent 是官方客户端的 UA 形状（对应原始实现
	// antigravityUserAgent(channel, {withNodeClient:false})）。
	// services 里的同形函数未导出，handlers 包无法引用，因此在此固定为常量 ——
	// 写错会被上游当成非官方客户端，改动前先核对 services.antigravityUserAgent。
	antigravityCLIUserAgent = "antigravity/hub/2.9.1 darwin/arm64"
)

// 解析、强制刷新与项目引导可在测试中替换（不依赖数据库、不联网）。
var (
	resolveAntigravityCredential      = services.ResolveAntigravityCredential
	forceRefreshAntigravityCredential = services.ForceRefreshAntigravityCredential
	antigravityProjectFor             = services.AntigravityProjectFor
)

// init 把 Antigravity 装饰器挂到共享客户端上。
//
// 注意初始化顺序（已核对）：本文件名以 a 开头，init 在本包所有传输层里最先执行，
// 此时 upstreamClient.Transport 还是零值，因此 base 需要兜底为
// http.DefaultTransport（与 claude_transport.go 同样的处理），否则透传分支会打到
// nil 上 panic。另外 cline_transport.go 的 init 随后会把 base 写死为
// http.DefaultTransport 并整体覆盖这里的挂载 —— 与 Claude 层同样的已知情况，
// 本层能否出现在最终链路上取决于 cline 的 base 是否改为「当前」transport，
// 那属于其它传输层的改动，不在本文件范围。本层自身始终可用：只要被挂进任意链路，
// 下面的逻辑即刻生效。
func init() {
	upstreamClient.Transport = &antigravityTransport{base: antigravityInitBase(upstreamClient.Transport)}
	probeClient.Transport = &antigravityTransport{base: antigravityInitBase(probeClient.Transport)}
}

func antigravityInitBase(current http.RoundTripper) http.RoundTripper {
	if current == nil {
		return http.DefaultTransport
	}
	return current
}

type antigravityTransport struct{ base http.RoundTripper }

// isAntigravityHost 只认原始实现使用的两个官方私有主机。主机名硬编码：
// 凭据在任何情况下都不得被发往其他地址。
func isAntigravityHost(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com":
		return true
	}
	return false
}

func (t *antigravityTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, antigravityMarkerPrefix)
	if !isAntigravityHost(req.URL) {
		if internal {
			return nil, errors.New("Google 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		// 管理员自填 key 的 api 渠道：不动它的请求。
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, antigravityMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("Google 内部凭据标识无效")
	}
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	isChat := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/chat/completions")
	// 拉模型入口在管理端可能以 GET 或 POST /models 到达，两者都接受（最终都改写为
	// 上游的 POST fetchAvailableModels）。
	isModels := strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("Google 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	cred, err := resolveAntigravityCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cred.AccessToken) == "" {
		return nil, errors.New("Google 账号缺少 access_token，请重新一键登录")
	}
	// 不按本地 expires_at 拦截：本地估算可能不准，是否过期以上游 401/403 为准
	// （与 Grok / WorkBuddy 的线上修复同一策略）。
	if isModels {
		return t.models(req, id, cred)
	}
	return t.chat(req, id, cred)
}

// antigravityHeaders 是原始实现 chat 请求的固定头组：少任何一项都会被上游按
// 非官方客户端处理。
func antigravityHeaders(h http.Header, token string) {
	h.Set("Content-Type", "application/json")
	h.Set("Authorization", "Bearer "+token)
	h.Set("User-Agent", antigravityCLIUserAgent)
}

// ---------- 对话 ----------

func (t *antigravityTransport) chat(req *http.Request, channelID int64, cred services.AntigravityCredential) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, antigravityMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 Google 请求体失败")
	}
	var body antigravityChatBody
	if json.Unmarshal(raw, &body) != nil {
		return nil, errors.New("Google 请求体不是合法 JSON")
	}
	project, err := antigravityProjectFor(req.Context(), channelID, cred)
	if err != nil {
		return nil, err
	}
	upstreamBody, err := antigravityBuildRequest(&body, project, channelID)
	if err != nil {
		return nil, err
	}
	upstreamURL, err := url.Parse(antigravityChatURL)
	if err != nil {
		return nil, errors.New("Google 上游地址不合法")
	}

	attempt := func(token string) (*http.Response, error) {
		clone := req.Clone(req.Context())
		clone.URL = upstreamURL
		clone.Host = ""
		clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
		clone.ContentLength = int64(len(upstreamBody))
		clone.GetBody = nil
		antigravityHeaders(clone.Header, token)
		return t.base.RoundTrip(clone)
	}

	resp, err := attempt(cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Google 上游：%w", err)
	}
	// 401/403 先刷新重试一次（与原始实现一致：刷新拿不到新令牌就不重放，避免
	// 用同一个坏令牌多打一次上游）。
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		token := cred.AccessToken
		if fresh, ferr := forceRefreshAntigravityCredential(req.Context(), channelID); ferr == nil && strings.TrimSpace(fresh.AccessToken) != "" {
			token = fresh.AccessToken
		}
		if token != cred.AccessToken {
			resp, err = attempt(token)
			if err != nil {
				return nil, fmt.Errorf("无法连接 Google 上游：%w", err)
			}
		}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, "Google 登录已过期，请重新一键登录"), nil
	}
	// 其余非 2xx 原样透传：上游的错误体对排查更有价值。
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	// 上游理论上始终返回 SSE；返回整包 JSON 时转换器按「单个载荷」处理。
	jsonPayload := strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json")
	if !body.Stream {
		// 下游要非流式：上游只提供流（或整包），这里把转换后的 OpenAI 分块聚合成
		// 一个 chat.completion JSON（与 WorkBuddy 的处理方式一致）。
		stream := newAntigravitySSEStream(resp.Body, body.Model, jsonPayload)
		converted, readErr := io.ReadAll(io.LimitReader(stream, antigravityMaxBodyBytes+1))
		stream.Close()
		if readErr != nil {
			// 流中断 / 上游报错节点：不能把半截内容当成功响应返回（会错误计费）。
			return nil, fmt.Errorf("Antigravity 响应流中断：%w", readErr)
		}
		if len(converted) > antigravityMaxBodyBytes {
			return nil, errors.New("Antigravity 响应过大")
		}
		if message := antigravityErrorFrame(converted); message != "" {
			return jsonErrorMessage(http.StatusBadGateway, message), nil
		}
		wrapped := &http.Response{
			StatusCode: resp.StatusCode,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(bytes.NewReader(converted)),
		}
		return aggregateOpenAISSE(wrapped, body.Model)
	}
	wrapped := *resp
	wrapped.Body = newAntigravitySSEStream(resp.Body, body.Model, jsonPayload)
	wrapped.Header = resp.Header.Clone()
	wrapped.Header.Set("Content-Type", "text/event-stream")
	wrapped.Header.Del("Content-Length")
	wrapped.ContentLength = -1
	return &wrapped, nil
}

// ---------- 模型列表 ----------

func (t *antigravityTransport) models(req *http.Request, channelID int64, cred services.AntigravityCredential) (*http.Response, error) {
	project, err := antigravityProjectFor(req.Context(), channelID, cred)
	if err != nil {
		return nil, err
	}
	upstreamBody, err := json.Marshal(map[string]any{"project": project})
	if err != nil {
		return nil, errors.New("Google 模型请求体序列化失败")
	}
	upstreamURL, err := url.Parse(antigravityModelsURL)
	if err != nil {
		return nil, errors.New("Google 上游地址不合法")
	}
	clone := req.Clone(req.Context())
	clone.URL = upstreamURL
	clone.Host = ""
	clone.Method = http.MethodPost
	clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
	clone.ContentLength = int64(len(upstreamBody))
	clone.GetBody = nil
	antigravityHeaders(clone.Header, cred.AccessToken)

	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Google 上游：%w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, "Google 登录已过期，请重新一键登录"), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	raw, err := readBodyLimited(resp.Body, 4<<20)
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Models map[string]json.RawMessage `json:"models"`
	}
	// 原始实现对非法 JSON 直接当空表（resp.json().catch(() => null)），保持一致。
	_ = json.Unmarshal(raw, &parsed)
	ids := make([]string, 0, len(parsed.Models))
	for id := range parsed.Models {
		if antigravityExcludedModel.MatchString(id) {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	items := []any{}
	for _, id := range ids {
		items = append(items, map[string]any{"id": id, "object": "model", "owned_by": "google"})
	}
	return jsonResponse(http.StatusOK, map[string]any{"object": "list", "data": items}), nil
}

// antigravityExcludedModel 是仅供内部使用、不能对话的档位（原始实现同款过滤）。
var antigravityExcludedModel = regexp.MustCompile(`^(chat_|tab_)`)

// ---------- 通用语 → Google 私有信封 ----------

// antigravityChatBody 是网关交来的通用语请求里用得到的字段。
type antigravityChatBody struct {
	Model      string            `json:"model"`
	Stream     bool              `json:"stream"`
	MaxTokens  *int              `json:"max_tokens"`
	Messages   []json.RawMessage `json:"messages"`
	Tools      []chatTool        `json:"tools"`
	ToolChoice json.RawMessage   `json:"tool_choice"`
}

// antigravityEnvelope 的字段顺序就是上游要求的键序（原始实现 JSON.stringify 的顺序）：
// model → userAgent → requestType → project → requestId → request。
type antigravityEnvelope struct {
	Model       string                 `json:"model"`
	UserAgent   string                 `json:"userAgent"`
	RequestType string                 `json:"requestType"`
	Project     string                 `json:"project"`
	RequestID   string                 `json:"requestId"`
	Request     antigravityRequestBody `json:"request"`
}

// antigravityRequestBody 的键序：contents → sessionId → systemInstruction →
// generationConfig → tools → toolConfig。
type antigravityRequestBody struct {
	Contents          []antigravityContent `json:"contents"`
	SessionID         string               `json:"sessionId"`
	SystemInstruction map[string]any       `json:"systemInstruction,omitempty"`
	GenerationConfig  map[string]any       `json:"generationConfig"`
	Tools             []map[string]any     `json:"tools,omitempty"`
	ToolConfig        map[string]any       `json:"toolConfig,omitempty"`
}

type antigravityContent struct {
	Role  string           `json:"role"`
	Parts []map[string]any `json:"parts"`
}

type antigravityFunctionDeclaration struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// antigravityBuildRequest 拼出上游信封（原始实现 toContents / extractSystem /
// applyToolDefinitions 的忠实翻版）。
func antigravityBuildRequest(body *antigravityChatBody, project string, channelID int64) ([]byte, error) {
	messages := antigravityMessageObjects(body.Messages)
	contents, err := antigravityContents(messages)
	if err != nil {
		return nil, err
	}
	// generationConfig 始终存在（上游要求）；max_tokens 为 0 时与原始实现的
	// truthiness 一致地省略。
	generationConfig := map[string]any{}
	if body.MaxTokens != nil && *body.MaxTokens != 0 {
		generationConfig["maxOutputTokens"] = *body.MaxTokens
	}
	request := antigravityRequestBody{
		Contents:          contents,
		SessionID:         antigravitySessionNegID(channelID),
		SystemInstruction: antigravitySystemInstruction(messages),
		GenerationConfig:  generationConfig,
	}
	// 工具与工具选择只在有工具定义时出现（applyToolDefinitions 的前置判断）。
	if tools := antigravityTools(body.Tools); len(tools) > 0 {
		request.Tools = tools
		request.ToolConfig = antigravityToolConfig(body.ToolChoice)
	}
	requestType := "agent"
	if strings.Contains(strings.ToLower(body.Model), "image") {
		requestType = "image_gen"
	}
	return json.Marshal(antigravityEnvelope{
		Model:       body.Model,
		UserAgent:   "antigravity",
		RequestType: requestType,
		Project:     project,
		RequestID:   antigravityRequestID(channelID),
		Request:     request,
	})
}

// antigravityMessageObjects 把 messages 解成对象列表；null / 非对象项跳过
// （原始实现的 `!m || typeof m !== "object"` 判断）。
func antigravityMessageObjects(raws []json.RawMessage) []map[string]any {
	out := make([]map[string]any, 0, len(raws))
	for _, raw := range raws {
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil && m != nil {
			out = append(out, m)
		}
	}
	return out
}

// antigravityContents 对应原始实现 toContents：system 跳过、首条必须是 user、
// 连续同角色合并；一旦出现工具消息（tool_calls / role=tool）整表换成结构化形状。
func antigravityContents(messages []map[string]any) ([]antigravityContent, error) {
	use := messages
	if len(use) == 0 {
		use = []map[string]any{{"role": "user", "content": "你好"}}
	}
	structured := false
	for _, m := range use {
		if role, _ := m["role"].(string); role == "tool" {
			structured = true
			break
		}
		// 原始实现判断的是 m.tool_calls 的 truthiness：空数组也算「有工具消息」。
		if value, ok := m["tool_calls"]; ok && antigravityTruthy(value) {
			structured = true
			break
		}
	}
	contents := []antigravityContent{}
	if structured {
		// 有工具来回时整表换成结构化形状（geminiMessages）。
		converted, err := antigravityGeminiContents(use)
		if err != nil {
			return nil, err
		}
		contents = converted
	} else {
		for _, m := range use {
			role, _ := m["role"].(string)
			if role == "system" {
				continue
			}
			googleRole := "user"
			if role == "assistant" {
				googleRole = "model"
			}
			text := antigravityContentText(m["content"])
			// Google 要求首条为 user：跳过开头连续的 model 轮。
			if len(contents) == 0 && googleRole != "user" {
				continue
			}
			if n := len(contents); n > 0 && contents[n-1].Role == googleRole {
				previous, _ := contents[n-1].Parts[0]["text"].(string)
				contents[n-1].Parts[0]["text"] = previous + "\n\n" + text
				continue
			}
			contents = append(contents, antigravityContent{Role: googleRole, Parts: []map[string]any{{"text": text}}})
		}
	}
	// 以下两步对两种形状都适用（原始实现在工具替换之后同样执行）：
	// 结果为空 → 兜底一句「你好」；首条不是 user → 补一条空 user。
	if len(contents) == 0 {
		contents = append(contents, antigravityContent{Role: "user", Parts: []map[string]any{{"text": "你好"}}})
	}
	if contents[0].Role != "user" {
		contents = append([]antigravityContent{{Role: "user", Parts: []map[string]any{{"text": ""}}}}, contents...)
	}
	return contents, nil
}

// antigravityGeminiContents 是 tool-wire.js geminiMessages 的翻版：带工具来回的
// 对话必须保留 functionCall / functionResponse 结构，否则上游会把它当成普通文本。
func antigravityGeminiContents(messages []map[string]any) ([]antigravityContent, error) {
	out := []antigravityContent{}
	// functionResponse 的 name 要从前一条 assistant 的 tool_calls 里按 id 反查：
	// 工具结果消息本身通常不带名字。
	names := map[string]string{}
	for _, m := range messages {
		role, _ := m["role"].(string)
		if role == "system" || role == "developer" {
			continue
		}
		googleRole := "user"
		if role == "assistant" {
			googleRole = "model"
		}
		parts := []map[string]any{}
		if role == "tool" {
			id, _ := m["tool_call_id"].(string)
			name := names[id]
			if name == "" {
				name, _ = m["name"].(string)
			}
			entry := map[string]any{"response": map[string]any{"output": antigravityContentText(m["content"])}}
			if id != "" {
				entry["id"] = id
			}
			if name != "" {
				entry["name"] = name
			}
			parts = append(parts, map[string]any{"functionResponse": entry})
		} else {
			if text := antigravityContentText(m["content"]); text != "" {
				parts = append(parts, map[string]any{"text": text})
			}
			calls, _ := m["tool_calls"].([]any)
			for _, rawCall := range calls {
				call, ok := rawCall.(map[string]any)
				if !ok {
					continue
				}
				id := antigravityFirstString(call["id"])
				name := antigravityFirstString(call["name"], antigravityNestedString(call, "function", "name"))
				names[id] = name
				args, err := antigravityToolCallArguments(call)
				if err != nil {
					return nil, err
				}
				part := map[string]any{"functionCall": map[string]any{"id": id, "name": name, "args": args}}
				// thoughtSignature 由上一轮响应带回时按原样转发（拿不到就不填，
				// 不能凭空生成）。
				if signature := antigravityFirstString(call["thoughtSignature"], m["thoughtSignature"]); signature != "" {
					part["thoughtSignature"] = signature
				}
				parts = append(parts, part)
			}
		}
		if len(parts) == 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Role == googleRole {
			out[n-1].Parts = append(out[n-1].Parts, parts...)
			continue
		}
		out = append(out, antigravityContent{Role: googleRole, Parts: parts})
	}
	return out, nil
}

// antigravitySystemInstruction 把全部 system 消息拼成 systemInstruction；
// 没有 system 消息（或全为空）时省略该字段。
func antigravitySystemInstruction(messages []map[string]any) map[string]any {
	texts := []string{}
	for _, m := range messages {
		if role, _ := m["role"].(string); role == "system" {
			texts = append(texts, antigravityContentText(m["content"]))
		}
	}
	text := strings.Join(texts, "\n\n")
	if text == "" {
		return nil
	}
	return map[string]any{"parts": []map[string]any{{"text": text}}}
}

// antigravityTools 把 OpenAI 工具定义翻成 functionDeclarations。
// 没有合法工具时返回 nil（连 toolConfig 一起省略，与 applyToolDefinitions 一致）。
func antigravityTools(tools []chatTool) []map[string]any {
	declarations := make([]antigravityFunctionDeclaration, 0, len(tools))
	for _, tool := range tools {
		if tool.Type != "function" || tool.Function.Name == "" {
			continue
		}
		declarations = append(declarations, antigravityFunctionDeclaration{
			Name:        tool.Function.Name,
			Description: tool.Function.Description,
			Parameters:  tool.Function.Parameters,
		})
	}
	if len(declarations) == 0 {
		return nil
	}
	return []map[string]any{{"functionDeclarations": declarations}}
}

// antigravityToolConfig 把 tool_choice 翻成 functionCallingConfig。
// 未提供 tool_choice（null / 空串）时返回 nil，保持字段不出现。
func antigravityToolConfig(raw json.RawMessage) map[string]any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var choice any
	if json.Unmarshal(raw, &choice) != nil {
		return nil
	}
	switch value := choice.(type) {
	case string:
		if value == "" {
			return nil
		}
		mode := "AUTO"
		switch value {
		case "none":
			mode = "NONE"
		case "required", "any":
			// OpenAI 里 "required" 与 "any" 同义（都表示必须调用工具），
			// 与 Google 的 ANY 对应；其余值交给上游按 AUTO 处理。
			mode = "ANY"
		}
		return map[string]any{"functionCallingConfig": map[string]any{"mode": mode}}
	case map[string]any:
		config := map[string]any{"mode": "ANY"}
		name := antigravityFirstString(value["name"], antigravityNestedString(value, "function", "name"))
		if name != "" {
			config["allowedFunctionNames"] = []string{name}
		}
		return map[string]any{"functionCallingConfig": config}
	default:
		return nil
	}
}

// antigravityContentText 是 content-text.js normalizeContentToText 的翻版：
// content 可能是字符串，也可能是 [{type:"text",...}] 分片数组（图片片忽略）。
// 直接 String(content) 会把图片分片变成 "[object Object]" 喂给模型。
func antigravityContentText(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		var sb strings.Builder
		for _, part := range v {
			switch p := part.(type) {
			case string:
				sb.WriteString(p)
			case map[string]any:
				if p["type"] == "text" {
					sb.WriteString(antigravityPartText(p))
				}
			}
		}
		return sb.String()
	case map[string]any:
		// 裸对象只看 .text（原始实现 String(content.text ?? "")，
		// 与数组分片不同：分片才允许回退到 .content）。
		return antigravityTextValue(v["text"])
	default:
		return antigravityJSString(v)
	}
}

// antigravityPartText 实现分片的 part.text ?? part.content ?? ""。
func antigravityPartText(part map[string]any) string {
	value, ok := part["text"]
	if !ok || value == nil {
		value = part["content"]
	}
	return antigravityTextValue(value)
}

// antigravityTextValue 对标 JS 的 String(value ?? "")（标量；对象/数组这类
// 会得到 "[object Object]" 的值在网关里没有意义，按空串处理）。
func antigravityTextValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return antigravityJSString(value)
}

// antigravityToolCallArguments 对应 tool-wire.callOf 的 arguments 语义：
// 已经是字符串就原样用，否则 JSON 序列化；两者都没有时序列化 {}。
// 空字符串按 {} 兜底（原始实现会 JSON.parse 抛错，网关侧没必要因此拒绝整轮对话）。
func antigravityToolCallArguments(call map[string]any) (any, error) {
	value := call["arguments"]
	if value == nil {
		if function, ok := call["function"].(map[string]any); ok {
			value = function["arguments"]
		}
	}
	var text string
	switch v := value.(type) {
	case nil:
		text = "{}"
	case string:
		text = v
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return nil, errors.New("工具调用参数无法序列化")
		}
		text = string(encoded)
	}
	if strings.TrimSpace(text) == "" {
		return map[string]any{}, nil
	}
	var args any
	if json.Unmarshal([]byte(text), &args) != nil {
		return nil, errors.New("工具调用参数不是合法 JSON")
	}
	return args, nil
}

// antigravityFirstString 返回第一个非空字符串（对应 JS 的 a || b || ""）。
func antigravityFirstString(values ...any) string {
	for _, value := range values {
		if s, ok := value.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// antigravityNestedString 读取嵌套对象的字符串字段（缺失或类型不符时返回 ""）。
func antigravityNestedString(m map[string]any, keys ...string) string {
	var current any = m
	for _, key := range keys {
		obj, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = obj[key]
	}
	s, _ := current.(string)
	return s
}

// antigravityTruthy 对应 JS 的 truthiness（决定是否走结构化 contents）。
func antigravityTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}

// antigravityJSString 对应 JS 的 String(原始值)，只处理 JSON 能解出的标量。
func antigravityJSString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return ""
	}
}

// ---------- 确定性身份 ----------

// antigravityIdentityHex 由渠道 ID 确定性派生身份值。
//
// 种子取 "antigravity:<渠道 id>"（与 services.GrokSessionID 的 "grok:<id>" 同形；
// 原始实现用 profileSeed = "<channel.type>:<id>"，这里把渠道类型固定为 antigravity），
// 标签沿用 cli-profile.js 的 ag-request / ag-session。同一渠道每次请求都得到同一个
// 值，重启不变；上游把「同一账号身份乱跳」当风控特征，所以绝不能改成随机值。
func antigravityIdentityHex(id int64, tag string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("ooapi-cli-profile|%s|antigravity:%d", tag, id)))
	return hex.EncodeToString(sum[:])[:32]
}

// antigravityHexNibble 把十六进制字符转成数值（与 codexHexNibble 同形）。
func antigravityHexNibble(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return 0
}

// antigravityRequestID 生成 "agent-<uuid v4 形状>" 的请求 id，内容由种子决定
// （对应 cli-profile.seededUuid(seed, "ag-request")）：版本位固定 4，变体位 8/9/a/b。
func antigravityRequestID(id int64) string {
	h := antigravityIdentityHex(id, "ag-request")
	variant := (antigravityHexNibble(h[16]) & 0x3) | 0x8
	return "agent-" + h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" +
		fmt.Sprintf("%x", variant) + h[17:20] + "-" + h[20:32]
}

// antigravitySessionNegID 生成 "-<int63>" 的会话 id（对应
// cli-profile.seededInt63(seed, "ag-session")）：取摘要前 16 个十六进制字符做
// uint64，再掩掉最高位保证是正整数。
func antigravitySessionNegID(id int64) string {
	h := antigravityIdentityHex(id, "ag-session")
	value, _ := strconv.ParseUint(h[:16], 16, 64)
	return "-" + strconv.FormatUint(value&0x7fffffffffffffff, 10)
}

// ---------- Gemini 响应（SSE 或整包）→ OpenAI chat-completions ----------

// antigravityUpstreamPart 是生成内容的一个分片。
type antigravityUpstreamPart struct {
	Text             string                   `json:"text"`
	Thought          bool                     `json:"thought"`
	ThoughtSignature string                   `json:"thoughtSignature"`
	FunctionCall     *antigravityFunctionCall `json:"functionCall"`
}

type antigravityFunctionCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type antigravityUpstreamCandidate struct {
	FinishReason string `json:"finishReason"`
	Content      struct {
		Parts []antigravityUpstreamPart `json:"parts"`
	} `json:"content"`
}

type antigravityUpstreamUsage struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	TotalTokenCount         int `json:"totalTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount"`
}

type antigravityUpstreamError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type antigravityUpstreamResponse struct {
	ModelVersion  string                         `json:"modelVersion"`
	Candidates    []antigravityUpstreamCandidate `json:"candidates"`
	UsageMetadata *antigravityUpstreamUsage      `json:"usageMetadata"`
	Error         *antigravityUpstreamError      `json:"error"`
}

// antigravityStreamToChat 是有状态的转换器：data 载荷可能是对象或数组，
// 每一项可能是 {response:{...}} 或裸响应体；首个候选之外的候选全部忽略
// （原始实现只取 candidates[0]）。
type antigravityStreamToChat struct {
	id      string
	model   string
	created int64

	usage      map[string]any
	toolSeq    int
	toolCalls  int
	terminated bool
	finalized  bool
	failed     bool
}

func newAntigravityStreamToChat(model string) *antigravityStreamToChat {
	return &antigravityStreamToChat{id: "chatcmpl-" + randomHex(12), model: model, created: nowUnix()}
}

// Convert 处理一行上游数据（可能带不带换行）。返回要写给下游的字节。
func (s *antigravityStreamToChat) Convert(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(trimmed[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}
	return s.handlePayload(payload)
}

// ConvertJSONPayload 处理整包 JSON 响应（Content-Type: application/json 时
// 响应体本身就是一个载荷，没有 "data:" 前缀，原始实现在流末单独解析一次）。
func (s *antigravityStreamToChat) ConvertJSONPayload(body []byte) []byte {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil
	}
	return s.handlePayload(trimmed)
}

func (s *antigravityStreamToChat) handlePayload(payload []byte) []byte {
	if s.failed || len(payload) == 0 {
		return nil
	}
	items := [][]byte{payload}
	if payload[0] == '[' {
		var raw []json.RawMessage
		if json.Unmarshal(payload, &raw) != nil {
			return nil
		}
		items = items[:0]
		for _, item := range raw {
			items = append(items, item)
		}
	}
	var out []byte
	for _, item := range items {
		out = append(out, s.handleItem(item)...)
		if s.failed {
			break
		}
	}
	return out
}

func (s *antigravityStreamToChat) handleItem(item []byte) []byte {
	if len(item) == 0 || string(bytes.TrimSpace(item)) == "null" {
		return nil
	}
	var envelope struct {
		Response json.RawMessage           `json:"response"`
		Error    *antigravityUpstreamError `json:"error"`
	}
	if json.Unmarshal(item, &envelope) != nil {
		return nil
	}
	body := item
	if len(envelope.Response) > 0 && string(bytes.TrimSpace(envelope.Response)) != "null" {
		body = envelope.Response
	}
	var r antigravityUpstreamResponse
	if json.Unmarshal(body, &r) != nil {
		return nil
	}
	// 流内错误（HTTP 200 也可能是错误体）：转成 OpenAI 错误事件后停止转换。
	if failure := r.Error; failure != nil || envelope.Error != nil {
		if failure == nil {
			failure = envelope.Error
		}
		message := failure.Message
		if message == "" {
			message = "Antigravity 返回错误事件"
		}
		return s.fail(message)
	}
	if r.ModelVersion != "" {
		s.model = r.ModelVersion
	}
	if r.UsageMetadata != nil {
		prompt := r.UsageMetadata.PromptTokenCount
		// 思考 token 也属于补全消耗，漏掉会少计费（原始实现同款计算）。
		completion := r.UsageMetadata.CandidatesTokenCount + r.UsageMetadata.ThoughtsTokenCount
		total := r.UsageMetadata.TotalTokenCount
		if total == 0 {
			total = prompt + completion
		}
		s.usage = map[string]any{
			"prompt_tokens":     prompt,
			"completion_tokens": completion,
			"total_tokens":      total,
			"cached_tokens":     r.UsageMetadata.CachedContentTokenCount,
		}
	}
	if len(r.Candidates) == 0 {
		return nil
	}
	candidate := r.Candidates[0]
	if candidate.FinishReason == "STOP" {
		s.terminated = true
	} else if candidate.FinishReason != "" && s.toolCalls > 0 {
		// 有工具调用却没有正常收尾：内容不完整，不能当成功响应。
		return s.fail("Gemini工具响应被截断")
	}
	var out []byte
	for _, part := range candidate.Content.Parts {
		if part.FunctionCall != nil {
			out = append(out, s.toolCallChunk(part.FunctionCall)...)
		}
		if part.Text == "" {
			continue
		}
		if part.Thought {
			out = append(out, chatChunk(s.id, s.model, s.created, map[string]any{"reasoning_content": part.Text}, nil, nil)...)
			continue
		}
		out = append(out, chatChunk(s.id, s.model, s.created, map[string]any{"content": part.Text}, nil, nil)...)
	}
	return out
}

// toolCallChunk 把 functionCall 分片转成 OpenAI 的 tool_calls 增量。
// Gemini 一次给全量参数（不是增量拼接），所以这里一个分片就是一个完整调用。
func (s *antigravityStreamToChat) toolCallChunk(call *antigravityFunctionCall) []byte {
	index := s.toolSeq
	s.toolSeq++
	s.toolCalls++
	id := call.ID
	if id == "" {
		// 上游没给 id 时补一个合法的 OpenAI 调用 id（结果回传时还要用它关联）。
		id = "call_" + randomHex(12)
	}
	args := "{}"
	if len(call.Args) > 0 && string(bytes.TrimSpace(call.Args)) != "null" {
		var parsed any
		if json.Unmarshal(call.Args, &parsed) == nil {
			if encoded, err := json.Marshal(parsed); err == nil {
				args = string(encoded)
			}
		}
	}
	return chatChunk(s.id, s.model, s.created, map[string]any{
		"tool_calls": []map[string]any{{
			"index": index,
			"id":    id,
			"type":  "function",
			"function": map[string]any{
				"name":      call.Name,
				"arguments": args,
			},
		}},
	}, nil, nil)
}

// fail 输出一个 OpenAI 错误事件并终止转换（HTTP 头早已发出，无法再改状态码）。
func (s *antigravityStreamToChat) fail(message string) []byte {
	if s.failed {
		return nil
	}
	s.failed = true
	raw, err := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": "upstream_error"}})
	if err != nil {
		raw = []byte(`{"error":{"message":"Antigravity 返回错误事件","type":"upstream_error"}}`)
	}
	out := append([]byte("data: "), raw...)
	out = append(out, "\n\n"...)
	return append(out, "data: [DONE]\n\n"...)
}

// Done 输出最终帧：finish_reason + usage，再跟 [DONE]。
// 最终帧放在流末而不是收到 STOP 的那一刻：usageMetadata 常在 STOP 之后的
// 独立数据帧里到达，提前收尾会丢掉用量（少计费）。
func (s *antigravityStreamToChat) Done() []byte {
	if s.failed || s.finalized {
		return nil
	}
	s.finalized = true
	finish := "stop"
	if s.toolCalls > 0 {
		finish = "tool_calls"
	}
	out := chatChunk(s.id, s.model, s.created, map[string]any{}, &finish, s.usage)
	return append(out, "data: [DONE]\n\n"...)
}

// CompletionError 是流结束时的完整性判定（对应原始实现收尾处的检查）：
// 有工具调用却始终没出现 STOP 收尾 → 参数可能被截断，不能当成功响应。
func (s *antigravityStreamToChat) CompletionError() error {
	if s.failed || s.terminated || s.toolCalls == 0 {
		return nil
	}
	return errors.New("Antigravity 工具响应未完成")
}

// antigravityErrorFrame 从转换后的分块流里找出错误事件（用于非流式聚合：
// 不识别它就会把错误当成「空回答」返回成功）。
func antigravityErrorFrame(converted []byte) string {
	for _, line := range bytes.Split(converted, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(line[len("data:"):])
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		var frame struct {
			Error *antigravityUpstreamError `json:"error"`
		}
		if json.Unmarshal(payload, &frame) == nil && frame.Error != nil {
			return frame.Error.Message
		}
	}
	return ""
}

// antigravityStreamBody 让消费者 Close 时同时关闭上游连接（与 grokStreamBody 同形）。
type antigravityStreamBody struct {
	*io.PipeReader
	upstream io.ReadCloser
}

func (b *antigravityStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.upstream.Close()
	return err
}

// newAntigravitySSEStream 在响应体流上实时把 Gemini 响应转成 OpenAI chat 分块。
// jsonPayload 为真时整包是一个 JSON 载荷（Content-Type: application/json），
// 按原始实现的做法先累积、到流末一次性解析。转换出错时以 CloseWithError 结束，
// 网关据此把账号标记为失败而不是「正常结束」。
func newAntigravitySSEStream(upstream io.ReadCloser, model string, jsonPayload bool) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Close()
		defer pw.Close()
		converter := newAntigravityStreamToChat(model)
		reader := bufio.NewReaderSize(upstream, 64<<10)
		var payload bytes.Buffer
		write := func(chunk []byte) bool {
			if len(chunk) == 0 {
				return true
			}
			_, err := pw.Write(chunk)
			return err == nil
		}
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				if len(line) > antigravityMaxSSELine {
					pw.CloseWithError(errors.New("Antigravity 数据帧异常（单行超过 8MB）"))
					return
				}
				if jsonPayload {
					payload.Write(line)
					if payload.Len() > antigravityMaxSSELine {
						pw.CloseWithError(errors.New("Antigravity 数据帧异常（整包超过 8MB）"))
						return
					}
				} else if chunk := converter.Convert(line); !write(chunk) {
					return
				}
			}
			if err == nil {
				continue
			}
			if errors.Is(err, io.EOF) {
				// 收尾：末尾不带换行符的残帧不能丢（可能是最后一个文本增量或 usage）。
				if jsonPayload {
					if chunk := converter.ConvertJSONPayload(payload.Bytes()); !write(chunk) {
						return
					}
				}
				// 有工具调用却没有正常收尾：让网关把这次标记为失败，而不是交付
				// 可能被截断的工具参数。
				if completionErr := converter.CompletionError(); completionErr != nil {
					pw.CloseWithError(completionErr)
					return
				}
				write(converter.Done())
				return
			}
			pw.CloseWithError(fmt.Errorf("Antigravity 响应中断：%w", err))
			return
		}
	}()
	return &antigravityStreamBody{PipeReader: pr, upstream: upstream}
}
