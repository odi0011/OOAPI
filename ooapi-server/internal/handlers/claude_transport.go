package handlers

// Claude 订阅（Claude Code OAuth）传输层（RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-claude-oauth-channel-{id}"，真实凭据加密存在
// auth_credential。请求打到官方地址 https://api.anthropic.com 时：
//
//   - 用标识换出解密后的 access_token（必要时提前续期，单飞 + CAS）；
//   - POST .../messages（或未配 model_paths 时的 /chat/completions）：把网关交来的
//     通用语（chat-completions）翻成 Messages 请求体（复用 chatToAnthropicBody）——
//     若网关已经翻过一遍（渠道配了 model_paths），则原样沿用、不再重翻，再补齐原版硬性要求：
//     · system 必须是块数组，首块固定为 Claude Code 身份块（带 ephemeral 缓存标记）；
//     · metadata.user_id 必须是 JSON 字符串（device_id / account_uuid / session_id，
//     三者均由渠道 ID 确定性派生，重启不变）；
//     · 客户没给 max_tokens 时兜底 8192（开思考时 16000）；
//     · 上游始终按流式请求（原版对非流式客户也这么发，然后自己聚合）；
//   - 上游的 Messages 事件流在流上实时转成 OpenAI chat 分块（复用
//     anthropicStreamToChat），并把缓存命中/写入的 token 并入 usage；
//   - GET .../models 用精简头组（只带单个 beta）转发到 /v1/models?limit=100；
//   - 401/403：先强制刷新凭据重试一次（只在确实换到新令牌时重放），仍被拒则返回
//     「Claude 登录已过期，请重新一键登录」。
//
// 该主机上的请求只带一种凭据：内部标识。凭据永远不会被发往其它主机。

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
	"strconv"
	"strings"

	"ooapi/internal/services"
)

const (
	// claudeMarkerPrefix 是渠道在 api_key 列存的内部标识前缀。
	claudeMarkerPrefix = "ooapi-claude-oauth-channel-"
	// claudeOAuthBase 是官方 Messages API 的固定地址；凭据只可能发往这里。
	claudeOAuthBase = "https://api.anthropic.com/v1"
	// claudeMaxBodyBytes / claudeMaxSSELine 防止异常数据把内存撑爆
	// （与其它传输层一致：请求体 32MB、单行 8MB）。
	claudeMaxBodyBytes = 32 << 20
	claudeMaxSSELine   = 8 << 20

	// claudeCLIUserAgent 是官方 Claude Code CLI 的 UA（原版固定值，写错会被当非官方客户端）。
	claudeCLIUserAgent = "claude-cli/2.1.258 (external, cli)"
	// claudeCodeIdentity 是原版要求的固定身份首块文本。
	claudeCodeIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
	// claudeChatBeta 是对话路径的完整 beta 清单（原版固定值，顺序也要一致）。
	claudeChatBeta = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11"
	// claudeModelsBeta 是拉模型清单用的单个 beta（原版如此）。
	claudeModelsBeta = "oauth-2025-04-20"

	// claudeBaseMaxTokens / claudeThinkingMaxTokens 是原版的 max_tokens 兜底值。
	claudeBaseMaxTokens     = 8192
	claudeThinkingMaxTokens = 16000

	// claudeReloginMessage 是凭据失效（401/403）时给用户看的提示。
	claudeReloginMessage = "Claude 登录已过期，请重新一键登录"

	// claudeIdentityNamespace 与 services.GrokSessionID 的派生算法同源：
	// 命名空间 + 标签 + 渠道，得到确定性的身份串。
	claudeIdentityNamespace = "ooapi-cli-profile"
)

// 解析与强制刷新可在测试中替换（不依赖数据库）。
var (
	resolveClaudeCredential      = services.ResolveClaudeOAuthCredential
	forceRefreshClaudeCredential = services.ForceRefreshClaudeOAuthCredential
)

// claudeInitBase 返回该客户端「当前」的 transport 作为 base。
//
// 本文件按名称排在所有装饰器之前，挂载时共享客户端的 Transport 还是零值，
// 因此这里用 http.DefaultTransport 兜底：只要后续装饰器改为包住「当前」
// transport，本层就会处于链的最内层，兜底保证它的透传分支不会打到 nil 上。
func claudeInitBase(current http.RoundTripper) http.RoundTripper {
	if current == nil {
		return http.DefaultTransport
	}
	return current
}

// init 把 Claude 装饰器挂到共享客户端上。文件按名称顺序初始化
// （claude_transport.go < cline_transport.go < codex_transport.go < grok_transport.go
// < kiro_transport.go < workbuddy_transport.go），惯例是每个装饰器都包住「当前」
// transport，各装饰器才能同时生效。
//
// 本文件排在最前，挂载时共享客户端的 Transport 仍是零值，因此 base 必须兜底
// （见 claudeInitBase），否则透传分支会打到 nil 上 panic。
//
// 注意（已实测核对的初始化顺序）：cline_transport.go 的 init 在本文件之后执行，
// 且把 base 写死为 http.DefaultTransport、整体覆盖这里的挂载 —— 也就是说本层
// 目前不会出现在最终链路上。让它生效需要把 cline 的 base 改为「当前」transport
// （与其余装饰器一致）；那属于其它传输层的改动，不在本文件范围。
// 本层自身始终可用：只要被挂进任意链路，下面的逻辑即刻生效。
func init() {
	upstreamClient.Transport = &claudeOAuthTransport{base: claudeInitBase(upstreamClient.Transport)}
	// 注意：链底兜底由 orDefaultTransport（cline_transport.go）统一处理。
	probeClient.Transport = &claudeOAuthTransport{base: claudeInitBase(probeClient.Transport)}
}

type claudeOAuthTransport struct{ base http.RoundTripper }

// isClaudeOAuthHost 只认官方主机。主机名硬编码：凭据在任何情况下都不得被发往其他地址。
func isClaudeOAuthHost(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && strings.EqualFold(u.Hostname(), "api.anthropic.com")
}

// claudeRequestMarker 取出请求里的内部凭据标识。
//
// 先看 Authorization，再看 x-api-key：网关注入密钥的位置随上游协议而变
// （applyUpstreamAuth：Anthropic 协议用 x-api-key，OpenAI 系用 Bearer）。
// 渠道配了 model_paths（messages: claude-*）时走前者，未配置时走后者 ——
// 两种接线都必须能识别，否则标识会被当成真密钥原样发给上游。
func claudeRequestMarker(h http.Header) string {
	if marker := strings.TrimPrefix(h.Get("Authorization"), "Bearer "); strings.HasPrefix(marker, claudeMarkerPrefix) {
		return marker
	}
	return strings.TrimSpace(h.Get("x-api-key"))
}

func (t *claudeOAuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := claudeRequestMarker(req.Header)
	internal := strings.HasPrefix(marker, claudeMarkerPrefix)
	if !isClaudeOAuthHost(req.URL) {
		if internal {
			return nil, errors.New("Claude 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		// 非订阅渠道（管理员自填 key 的 api 渠道）：不动它的请求。
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, claudeMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("Claude 内部凭据标识无效")
	}
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	//
	// 两个对话路径都要认：渠道配置了 model_paths（messages: claude-*）时网关发
	// /messages；未配置时与其它一键登录渠道一致，走 /chat/completions
	// （连通性测试也固定打这个路径）。两者最终都改写到官方的 /v1/messages。
	isChat := req.Method == http.MethodPost &&
		(strings.HasSuffix(req.URL.Path, "/messages") || strings.HasSuffix(req.URL.Path, "/chat/completions"))
	isModels := req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("Claude 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	cred, err := resolveClaudeCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cred.AccessToken) == "" {
		return nil, errors.New("Claude 账号缺少 access_token，请重新一键登录")
	}
	// 不按本地 auth_expires_at 拦截：本地估算可能不准，是否过期以上游 401/403 为准
	// （与 Grok / WorkBuddy 同一策略）。
	if isModels {
		return t.models(req, cred)
	}
	return t.chat(req, id, cred)
}

// ---------- 确定性身份 ----------
//
// 与 services.GrokSessionID 同一套算法形状：sha256(命名空间|标签|渠道) → hex，
// 再按需拼成 UUID v4 形状（版本位 4，变体位 8/9/a/b）。同一渠道重启后不变；
// 原版里这些值本来就是安装级常量，随机生成反而会让上游看到「新设备」。

func claudeSeededHex(tag string, id int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|claude-oauth:%d", claudeIdentityNamespace, tag, id)))
	return hex.EncodeToString(sum[:])
}

// claudeDeviceID 返回 64 位小写十六进制设备号。
func claudeDeviceID(id int64) string {
	return claudeSeededHex("claude-device", id)
}

// claudeSeededUUID 把种子 hex 裁成 UUID v4 形状（与 GrokSessionID 的位运算一致）。
func claudeSeededUUID(tag string, id int64) string {
	h := claudeSeededHex(tag, id)[:32]
	variant := (claudeHexNibble(h[16]) & 0x3) | 0x8
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" + fmt.Sprintf("%x", variant) + h[17:20] + "-" + h[20:32]
}

func claudeHexNibble(c byte) int {
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

// claudeAccountUUID / claudeSessionUUID 是两份独立的确定性身份：
// 前者进 metadata.user_id，后者进 x-claude-code-session-id。
func claudeAccountUUID(id int64) string { return claudeSeededUUID("claude-account", id) }
func claudeSessionUUID(id int64) string { return claudeSeededUUID("claude-session", id) }

// claudeRequestID 是每次请求新生成的随机 UUID（不参与身份派生，因此可以随机）。
func claudeRequestID(_ int64) string { return randomUUID() }

// claudeUserIDJSON 拼出 metadata.user_id：一个 JSON 字符串（不是对象），
// 三个身份全部确定性派生。原版要求这个形状，对象形状会被上游拒绝。
func claudeUserIDJSON(id int64) string {
	raw, _ := json.Marshal(map[string]string{
		"device_id":    claudeDeviceID(id),
		"account_uuid": claudeAccountUUID(id),
		"session_id":   claudeSessionUUID(id),
	})
	return string(raw)
}

// setClaudeChatHeaders 是原版 buildHeaders 的忠实翻版：CLI 通道必须带整套身份头，
// 否则会被上游当成非官方客户端。头部字面量故意保持小写（Go 会自动规范化）。
func setClaudeChatHeaders(h http.Header, token string, channelID int64) {
	h.Set("authorization", "Bearer "+token)
	h.Set("content-type", "application/json")
	h.Set("anthropic-version", "2023-06-01")
	h.Set("anthropic-beta", claudeChatBeta)
	h.Set("anthropic-dangerous-direct-browser-access", "true")
	h.Set("x-app", "cli")
	h.Set("x-stainless-retry-count", "0")
	h.Set("x-stainless-runtime", "node")
	h.Set("x-stainless-lang", "js")
	h.Set("x-stainless-async", "async")
	h.Set("x-stainless-timeout", "600")
	h.Set("x-stainless-package-version", "0.112.1")
	h.Set("x-stainless-runtime-version", "v26.3.0")
	h.Set("x-stainless-os", "MacOS")
	h.Set("x-stainless-arch", "arm64")
	// 会话号按渠道确定性派生；请求号每次随机（原版也是每次新生成）。
	h.Set("x-claude-code-session-id", claudeSessionUUID(channelID))
	h.Set("x-client-request-id", claudeRequestID(channelID))
	h.Set("accept", "application/json")
	h.Set("user-agent", claudeCLIUserAgent)
	// 内部标识可能被网关侧塞进 x-api-key：绝不能随请求外发（真正的鉴权用 Authorization）。
	h.Del("x-api-key")
}

// setClaudeModelsHeaders 是拉模型路径用的精简头组（原版只带单个 beta）。
func setClaudeModelsHeaders(h http.Header, token string) {
	h.Set("authorization", "Bearer "+token)
	h.Set("anthropic-version", "2023-06-01")
	h.Set("anthropic-beta", claudeModelsBeta)
	h.Set("user-agent", claudeCLIUserAgent)
	h.Set("x-app", "cli")
	h.Set("accept", "application/json")
	h.Del("x-api-key")
}

// claudeSystemText 把 system 字段压成文本：chatToAnthropicBody 产出的是字符串，
// 但数组（调用方直接传 Anthropic 形状时）也要能认。
func claudeSystemText(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case []any:
		parts := []string{}
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := block["text"].(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return ""
}

// claudeMaxTokensFor 返回原版的 max_tokens 兜底值。
// 通用语里没有 Messages 的 thinking 块，思考意图只可能出现在 thinking / reasoning_effort 上；
// 开思考时给更大的预算，否则正文可能被思考过程挤掉。
func claudeMaxTokensFor(thinking json.RawMessage, effort string) int {
	if strings.TrimSpace(effort) != "" {
		return claudeThinkingMaxTokens
	}
	if len(bytes.TrimSpace(thinking)) > 0 {
		var parsed struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(thinking, &parsed) == nil && parsed.Type == "enabled" {
			return claudeThinkingMaxTokens
		}
	}
	return claudeBaseMaxTokens
}

// claudeIsMessagesBody 判断入参是否已经是 Messages 形状。
//
// 渠道配置了 model_paths（messages: claude-*）时，网关在转发前已经用
// chatToAnthropicBody 翻过一遍；不判断就会把翻好的请求再翻坏一次
// （system 文本丢失、工具定义被丢光）。判据只取 chat 形状不可能出现的字段，
// 因此纯文本的 chat 请求即使被漏判，重翻一遍的结果也完全相同。
func claudeIsMessagesBody(raw []byte) bool {
	var probe struct {
		System        json.RawMessage `json:"system"`
		StopSequences json.RawMessage `json:"stop_sequences"`
		Tools         []struct {
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return false
	}
	// Messages 的 system 是顶层字段；chat 的 system 是 messages 里的一条。
	if len(bytes.TrimSpace(probe.System)) > 0 {
		return true
	}
	if len(bytes.TrimSpace(probe.StopSequences)) > 0 {
		return true
	}
	// 工具定义：Messages 用 input_schema，chat 用 function.parameters。
	for _, t := range probe.Tools {
		if len(bytes.TrimSpace(t.InputSchema)) > 0 {
			return true
		}
	}
	// 内容块：tool_use / tool_result / thinking 是 Messages 独有的类型名。
	for _, m := range probe.Messages {
		var blocks []struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(m.Content, &blocks) != nil {
			continue
		}
		for _, block := range blocks {
			switch block.Type {
			case "tool_use", "tool_result", "thinking", "redacted_thinking":
				return true
			}
		}
	}
	return false
}

// claudeMessagesBody 把内部通用语翻成 Messages 请求体，并做原版要求的后处理。
// 返回实际模型名与「客户端是否要流式」，后者决定响应侧要不要聚合。
func claudeMessagesBody(chatBody []byte, channelID int64) ([]byte, string, bool, error) {
	var rawFields struct {
		Model           string          `json:"model"`
		Stream          bool            `json:"stream"`
		MaxTokens       *int            `json:"max_tokens"`
		Thinking        json.RawMessage `json:"thinking"`
		ReasoningEffort string          `json:"reasoning_effort"`
	}
	if json.Unmarshal(chatBody, &rawFields) != nil {
		return nil, "", false, errors.New("Claude 请求体不是合法 JSON")
	}
	var payload map[string]any
	if claudeIsMessagesBody(chatBody) {
		if json.Unmarshal(chatBody, &payload) != nil {
			return nil, "", false, errors.New("Claude 请求体不是合法 JSON")
		}
	} else {
		converted, err := chatToAnthropicBody(chatBody, rawFields.Model)
		if err != nil {
			return nil, "", false, errors.New("Claude 请求体转换失败")
		}
		if json.Unmarshal(converted, &payload) != nil {
			return nil, "", false, errors.New("Claude 请求体转换失败")
		}
	}

	// 1) system 必须是块数组：首块固定为身份块（带 ephemeral 缓存标记）。
	//    chatToAnthropicBody 会把 system 消息压成一个字符串，这里改回数组形状。
	blocks := []any{map[string]any{
		"type":          "text",
		"text":          claudeCodeIdentity,
		"cache_control": map[string]any{"type": "ephemeral"},
	}}
	if text := claudeSystemText(payload["system"]); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	payload["system"] = blocks

	// 2) metadata.user_id 必须是 JSON 字符串。
	payload["metadata"] = map[string]any{"user_id": claudeUserIDJSON(channelID)}

	// 3) max_tokens：客户给了就保留（chatToAnthropicBody 已透传，默认值 4096 也在此列），
	//    没给时用原版兜底值。
	if rawFields.MaxTokens == nil || *rawFields.MaxTokens <= 0 {
		payload["max_tokens"] = claudeMaxTokensFor(rawFields.Thinking, rawFields.ReasoningEffort)
	}

	// 4) 上游始终按流式请求：原版对非流式客户也这么发，然后自己聚合。
	payload["stream"] = true

	out, err := json.Marshal(payload)
	if err != nil {
		return nil, "", false, errors.New("Claude 请求体序列化失败")
	}
	return out, rawFields.Model, rawFields.Stream, nil
}

func (t *claudeOAuthTransport) chat(req *http.Request, channelID int64, cred services.ClaudeOAuthCredential) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, claudeMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 Claude 请求体失败")
	}
	upstreamBody, model, clientStream, err := claudeMessagesBody(raw, channelID)
	if err != nil {
		return nil, err
	}
	// 固定官方地址：渠道 base_url 由服务端推导，这里再做一次硬校验，
	// 保证凭据只可能发往 api.anthropic.com 的 /v1/messages。
	upstreamURL, err := url.Parse(claudeOAuthBase + "/messages")
	if err != nil {
		return nil, errors.New("Claude 上游地址不合法")
	}

	attempt := func(token string) (*http.Response, error) {
		clone := req.Clone(req.Context())
		clone.URL = upstreamURL
		clone.Host = ""
		clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
		clone.ContentLength = int64(len(upstreamBody))
		clone.GetBody = nil
		setClaudeChatHeaders(clone.Header, token, channelID)
		return t.base.RoundTrip(clone)
	}

	resp, err := attempt(cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Claude 上游：%w", err)
	}
	// 401/403 先强制刷新重试一次，但只在确实换到了新令牌时重放
	// （刷新失败时拿旧令牌重放毫无意义，只会多打一次上游）。
	if isClaudeAuthStatus(resp.StatusCode) {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		token := cred.AccessToken
		if fresh, ferr := forceRefreshClaudeCredential(req.Context(), channelID); ferr == nil && strings.TrimSpace(fresh.AccessToken) != "" {
			token = fresh.AccessToken
		}
		if token != cred.AccessToken {
			resp, err = attempt(token)
			if err != nil {
				return nil, fmt.Errorf("无法连接 Claude 上游：%w", err)
			}
		}
	}
	if isClaudeAuthStatus(resp.StatusCode) {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		// 统一按 401 返回（凭据问题的语义），与原始实现一致；
		// 403 在上游也可能表示「账号被限制」，但用户能采取的动作同样是重新登录。
		return jsonErrorMessage(http.StatusUnauthorized, claudeReloginMessage), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	// 上游理论上始终返回 SSE；若是 JSON（非流式兜底），按形状分别处理。
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		if clientStream {
			return resp, nil
		}
		raw, readErr := readBodyLimited(resp.Body, claudeMaxBodyBytes)
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		converted, convErr := anthropicToChatResponse(raw, model)
		if convErr != nil {
			return nil, errors.New("Claude 响应转换失败")
		}
		return jsonResponse(http.StatusOK, json.RawMessage(converted)), nil
	}
	if !clientStream {
		// 下游要非流式：上游只提供事件流，这里把转换后的 OpenAI 分块聚合成 chat.completion
		// （复用 aggregateOpenAISSE，与 Grok 的非流式处理同一路径）。
		wrapped := &http.Response{StatusCode: resp.StatusCode, Header: resp.Header, Body: newClaudeSSEStream(resp.Body, model)}
		return aggregateOpenAISSE(wrapped, model)
	}
	wrapped := *resp
	wrapped.Body = newClaudeSSEStream(resp.Body, model)
	wrapped.Header = resp.Header.Clone()
	wrapped.Header.Set("Content-Type", "text/event-stream")
	wrapped.Header.Del("Content-Length")
	wrapped.ContentLength = -1
	return &wrapped, nil
}

// models 按原版方式转发 GET /v1/models?limit=100（精简头组、不做刷新重试）。
func (t *claudeOAuthTransport) models(req *http.Request, cred services.ClaudeOAuthCredential) (*http.Response, error) {
	upstreamURL, err := url.Parse(claudeOAuthBase + "/models?limit=100")
	if err != nil {
		return nil, errors.New("Claude 上游地址不合法")
	}
	clone := req.Clone(req.Context())
	clone.URL = upstreamURL
	clone.Host = ""
	clone.Body = nil
	clone.ContentLength = 0
	clone.GetBody = nil
	setClaudeModelsHeaders(clone.Header, cred.AccessToken)
	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Claude 上游：%w", err)
	}
	if isClaudeAuthStatus(resp.StatusCode) {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, "Claude 登录已过期，请重新一键登录"), nil
	}
	return resp, nil
}

func isClaudeAuthStatus(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden
}

// ---------- Messages 事件流 → OpenAI chat 分块 ----------

// claudeStreamBody 让消费者 Close 时同时关闭上游连接。
type claudeStreamBody struct {
	*io.PipeReader
	upstream io.ReadCloser
}

func (b *claudeStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.upstream.Close()
	return err
}

// newClaudeSSEStream 在响应体流上实时把 Messages 事件转成 OpenAI chat 分块。
// 复用 anthropicStreamToChat（与上游协议适配层同一实现），并在此之上补一层
// 缓存用量的记账 —— 见 claudeStreamToChat 的说明。转换出错时以 CloseWithError
// 结束，网关据此把账号标记为失败而不是「正常结束」。
func newClaudeSSEStream(upstream io.ReadCloser, model string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Close()
		defer pw.Close()
		conv := newClaudeStreamToChat(model)
		reader := bufio.NewReaderSize(upstream, 64<<10)
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				if len(line) > claudeMaxSSELine {
					pw.CloseWithError(errors.New("Claude 数据帧异常（单行超过 8MB）"))
					return
				}
				if chunk := conv.Convert(line); len(chunk) > 0 {
					if _, werr := pw.Write(chunk); werr != nil {
						return
					}
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if done := conv.Done(); len(done) > 0 {
						_, _ = pw.Write(done)
					}
					return
				}
				pw.CloseWithError(fmt.Errorf("Claude 响应中断：%w", err))
				return
			}
		}
	}()
	return &claudeStreamBody{PipeReader: pr, upstream: upstream}
}

/*
claudeStreamToChat 在 anthropicStreamToChat 之上补记 prompt 缓存用量。

官方 usage 把输入拆成三份：input_tokens、cache_read_input_tokens（命中缓存）
与 cache_creation_input_tokens（写入缓存）。通用转换器只读 input_tokens，
直接透传会让计费与下游 usage 少算缓存部分，因此这里在 message_start 时记下
两个缓存字段，并在最后的 usage 分块上补齐（prompt / total 同步相加）。
*/
type claudeStreamToChat struct {
	*anthropicStreamToChat
	cacheRead     int
	cacheCreation int
}

func newClaudeStreamToChat(model string) *claudeStreamToChat {
	return &claudeStreamToChat{anthropicStreamToChat: newAnthropicStreamToChat(model)}
}

func (s *claudeStreamToChat) Convert(line []byte) []byte {
	eventType, cacheRead, cacheCreation := claudeSSEEnvelope(line)
	if eventType == "message_start" {
		s.cacheRead = cacheRead
		s.cacheCreation = cacheCreation
	}
	out := s.anthropicStreamToChat.Convert(line)
	if eventType == "message_stop" && len(out) > 0 {
		if extra := s.cacheRead + s.cacheCreation; extra > 0 {
			out = claudeAddCacheUsage(out, extra)
		}
	}
	return out
}

// Usage 在通用转换器的统计上补回缓存用量（结算必须与下发的 usage 一致）。
func (s *claudeStreamToChat) Usage() upstreamUsage {
	usage := s.anthropicStreamToChat.Usage()
	extra := s.cacheRead + s.cacheCreation
	usage.PromptTokens += extra
	usage.TotalTokens += extra
	return usage
}

// claudeSSEEnvelope 读取一行的 type 与 message_start 里的缓存用量字段。
func claudeSSEEnvelope(line []byte) (string, int, int) {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return "", 0, 0
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return "", 0, 0
	}
	var env struct {
		Type    string `json:"type"`
		Message *struct {
			Usage struct {
				CacheReadInputTokens     int `json:"cache_read_input_tokens"`
				CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(payload, &env) != nil {
		return "", 0, 0
	}
	if env.Message != nil {
		return env.Type, env.Message.Usage.CacheReadInputTokens, env.Message.Usage.CacheCreationInputTokens
	}
	return env.Type, 0, 0
}

// claudeAddCacheUsage 把缓存部分的 token 加进最终 usage 分块。
func claudeAddCacheUsage(chunk []byte, extra int) []byte {
	trimmed := bytes.TrimSpace(chunk)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return chunk
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	var parsed map[string]any
	if json.Unmarshal(payload, &parsed) != nil {
		return chunk
	}
	usage, ok := parsed["usage"].(map[string]any)
	if !ok {
		return chunk
	}
	if prompt, ok := usage["prompt_tokens"].(float64); ok {
		usage["prompt_tokens"] = prompt + float64(extra)
	}
	if total, ok := usage["total_tokens"].(float64); ok {
		usage["total_tokens"] = total + float64(extra)
	}
	body, err := json.Marshal(parsed)
	if err != nil {
		return chunk
	}
	return append(append([]byte("data: "), body...), []byte("\n\n")...)
}
