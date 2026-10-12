package handlers

// Codex（ChatGPT 订阅）传输层（RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-codex-channel-{id}"，真实凭据加密存在
// auth_credential。请求打到官方后端主机 https://chatgpt.com/backend-api/codex 时：
//
//   - 用标识换出解密后的 access_token（必要时提前续期，单飞 + CAS）；
//   - POST .../responses：网关交给上游的是通用语（chat-completions）请求体，
//     这里翻成 Responses 形状，并补上原始实现固定发送的字段
//     （stream=true、store=false、prompt_cache_key、client_metadata 身份）；
//   - 上游响应是 Responses 事件的 SSE 流，这里在流上实时转成 OpenAI
//     chat-completions 分块，下游通用管线（protocol.go）原样透传，无需改动；
//     下游要非流式时聚合为一个 chat.completion JSON；
//   - GET .../models 按原始实现带相同的身份头透传；
//   - 401/403：先强制刷新凭据重试一次（原始实现同样把 403 当凭据问题处理），
//     仍被拒则返回「Codex 登录已过期，请重新一键登录」。
//
// 该主机上的请求只带一种凭据：内部标识。凭据永远不会被发往其它主机。
//
// 身份（安装号 / 窗口号 / 会话号）由渠道 ID 确定性派生：重启后必须保持不变，
// 否则上游会把「身份频繁变化」当成账号共享而拒绝。

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
	codexMarkerPrefix = "ooapi-codex-channel-"
	codexMaxBodyBytes = 32 << 20
	// codexMaxSSELine 防止上游异常数据把内存撑爆（与 Grok 同取 8MB）。
	codexMaxSSELine = 8 << 20

	// 官方后端地址硬编码：主机与路径前缀写死，凭据在任何情况下都不得被发往其他地址。
	codexBackendBase  = "https://chatgpt.com/backend-api/codex"
	codexResponsesURL = codexBackendBase + "/responses"
	codexModelsURL    = codexBackendBase + "/models"

	// codexOriginator 是原始实现固定发送的客户端标识头。
	codexOriginator = "codex-tui"
	// codexUserAgent：原始实现的精确 UA 无法从参考代码核实，按约定取 Codex CLI
	// 发行版的 UA 形状；自造版本号会让上游把请求归到未知客户端。
	codexUserAgent = "codex_cli_rs/0.1.0"

	codexReloginMessage = "Codex 登录已过期，请重新一键登录"
)

// 解析与强制刷新可在测试中替换（不依赖数据库）。
var (
	resolveCodexCredential      = services.ResolveCodexCredential
	forceRefreshCodexCredential = services.ForceRefreshCodexCredential
)

// init 把 Codex 装饰器挂到共享客户端上。文件按名称顺序初始化
// （cline_transport.go < codex_transport.go < grok_transport.go < kiro_transport.go < workbuddy_transport.go），
// 这里包住「当前」transport 而不是 http.DefaultTransport，各装饰器才能同时生效。
func init() {
	upstreamClient.Transport = &codexTransport{base: upstreamClient.Transport}
	probeClient.Transport = &codexTransport{base: probeClient.Transport}
}

type codexTransport struct{ base http.RoundTripper }

// isCodexBackendURL 只认原始实现使用的官方后端主机与路径前缀。
// 主机名与路径都硬编码：凭据在任何情况下都不得被发往其他地址。
func isCodexBackendURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || !strings.EqualFold(u.Hostname(), "chatgpt.com") {
		return false
	}
	// 前缀后必须紧跟路径分隔符，避免 "/backend-api/codexevil" 这类仿冒路径被当成官方路径。
	return u.Path == "/backend-api/codex" || strings.HasPrefix(u.Path, "/backend-api/codex/")
}

// ---------- 确定性身份 ----------

// codexIdentityHex 由渠道 ID 确定性派生 32 位十六进制身份值。
// 种子格式与 services.GrokSessionID 的 profileSeed 同形，只换标签：
// 同一渠道每次请求都得到同一个值，重启不变。
func codexIdentityHex(id int64, tag string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("ooapi-cli-profile|%s|codex:%d", tag, id)))
	return hex.EncodeToString(sum[:])[:32]
}

// codexInstallationID 是 client_metadata 里的安装标识。
func codexInstallationID(id int64) string { return codexIdentityHex(id, "codex-installation") }

// codexWindowID 是 client_metadata 里的窗口标识。
func codexWindowID(id int64) string { return codexIdentityHex(id, "codex-window") }

// codexSessionID 与 GrokSessionID 同一算法形状（seededUuid 的位运算）：
// 版本位固定 4（0100），变体位取 8/9/a/b。同时用于 session_id 头与
// 请求体里的 prompt_cache_key。
func codexSessionID(id int64) string {
	h := codexIdentityHex(id, "codex-session")
	variant := (codexHexNibble(h[16]) & 0x3) | 0x8
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" + fmt.Sprintf("%x", variant) + h[17:20] + "-" + h[20:32]
}

// codexHexNibble 把十六进制字符转成数值（与 services.grokHexNibble 同形）。
func codexHexNibble(c byte) int {
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

// ---------- RoundTrip ----------

func (t *codexTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, codexMarkerPrefix)
	if !isCodexBackendURL(req.URL) {
		if internal {
			return nil, errors.New("Codex 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		// 非订阅渠道（管理员自填 key 的 api 渠道）：不动它的请求。
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, codexMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("Codex 内部凭据标识无效")
	}
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	isChat := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/responses")
	isModels := req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("Codex 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	cred, err := resolveCodexCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cred.AccessToken) == "" {
		return nil, errors.New("Codex 账号缺少 access_token，请重新一键登录")
	}
	// 不按本地 auth_expires_at 拦截：本地估算可能不准，是否过期以上游 401/403 为准
	// （与 Grok / WorkBuddy 同一策略）。
	if isModels {
		return t.models(req, id, cred)
	}
	return t.chat(req, id, cred)
}

// codexHeaders 是原始实现头组的忠实翻版（订阅通道必须带身份头，
// 否则会被上游当成非官方客户端）。
func codexHeaders(h http.Header, token string, channelID int64, accountID string, sse bool) {
	h.Set("Authorization", "Bearer "+token)
	h.Set("Content-Type", "application/json")
	if sse {
		h.Set("Accept", "text/event-stream")
	} else {
		h.Set("Accept", "application/json")
	}
	h.Set("Originator", codexOriginator)
	if strings.TrimSpace(accountID) != "" {
		h.Set("Chatgpt-Account-Id", accountID)
	} else {
		// 空账号头比缺头更糟：必须清掉调用方可能带上的旧值。
		h.Del("Chatgpt-Account-Id")
	}
	h.Set("session_id", codexSessionID(channelID))
	h.Set("User-Agent", codexUserAgent)
}

// codexResponsesBody 把网关交来的请求体翻成 Codex 后端需要的 Responses 形状，
// 并补上原始实现固定发送的字段。
//
// 入参可能是两种形状：渠道未配置 model_paths 时网关发的是 chat-completions 形状，
// 配置成 /responses 后网关已经翻过一遍。两种都要能接住 —— 按 Responses 的
// 标志字段 input 判断形状，避免把已翻好的请求再翻坏一次。
func codexResponsesBody(raw []byte, model string, channelID int64) ([]byte, error) {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, errors.New("Codex 请求体不是合法 JSON")
	}
	if _, isResponses := payload["input"]; !isResponses {
		converted, err := chatToResponsesBody(raw, model)
		if err != nil {
			return nil, errors.New("Codex 请求体转换失败")
		}
		if json.Unmarshal(converted, &payload) != nil {
			return nil, errors.New("Codex 请求体转换失败")
		}
	}
	if strings.TrimSpace(model) != "" {
		payload["model"] = model
	}
	if _, ok := payload["instructions"]; !ok {
		// 原始实现即使没有 system 消息也固定发送 instructions（空串）。
		payload["instructions"] = ""
	}
	if _, ok := payload["input"]; !ok {
		payload["input"] = []any{}
	}
	// 官方后端只提供流式；下游要非流式时由本传输层聚合。
	payload["stream"] = true
	payload["store"] = false
	payload["prompt_cache_key"] = codexSessionID(channelID)
	payload["client_metadata"] = map[string]any{
		"x-codex-installation-id": codexInstallationID(channelID),
		"x-codex-window-id":       codexWindowID(channelID),
	}
	return json.Marshal(payload)
}

func (t *codexTransport) chat(req *http.Request, channelID int64, cred services.CodexCredential) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, codexMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 Codex 请求体失败")
	}
	var parsed struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("Codex 请求体不是合法 JSON")
	}
	upstreamBody, err := codexResponsesBody(raw, parsed.Model, channelID)
	if err != nil {
		return nil, err
	}
	// 固定官方后端地址：设备渠道的 base_url 由服务端推导，这里再做一次硬校验，
	// 保证凭据只可能发往 chatgpt.com 的 /backend-api/codex/responses。
	upstreamURL, err := url.Parse(codexResponsesURL)
	if err != nil {
		return nil, errors.New("Codex 上游地址不合法")
	}

	attempt := func(token string) (*http.Response, error) {
		clone := req.Clone(req.Context())
		clone.URL = upstreamURL
		clone.Host = ""
		clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
		clone.ContentLength = int64(len(upstreamBody))
		clone.GetBody = nil
		codexHeaders(clone.Header, token, channelID, cred.AccountID, true)
		return t.base.RoundTrip(clone)
	}

	resp, err := attempt(cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Codex 上游：%w", err)
	}
	// 401/403 先刷新重试一次（与原始实现一致：403 同样按凭据问题处理）。
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		token := cred.AccessToken
		if fresh, ferr := forceRefreshCodexCredential(req.Context(), channelID); ferr == nil && strings.TrimSpace(fresh.AccessToken) != "" {
			token = fresh.AccessToken
		}
		if token != cred.AccessToken {
			resp, err = attempt(token)
			if err != nil {
				return nil, fmt.Errorf("无法连接 Codex 上游：%w", err)
			}
		}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		// 统一按 401 返回（凭据问题的语义），下游据此提示重新一键登录。
		return jsonErrorMessage(http.StatusUnauthorized, codexReloginMessage), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	// 上游理论上始终返回 SSE；若是 JSON（非流式兜底），按形状分别处理。
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		if parsed.Stream {
			return resp, nil
		}
		body, readErr := readBodyLimited(resp.Body, codexMaxBodyBytes)
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		converted, convErr := responsesToChatResponse(body, parsed.Model)
		if convErr != nil {
			return nil, errors.New("Codex 响应转换失败")
		}
		return jsonResponse(http.StatusOK, json.RawMessage(converted)), nil
	}
	if !parsed.Stream {
		// 下游要非流式：上游只提供事件流，这里读完整条流聚合成 chat.completion。
		return aggregateCodexResponsesSSE(resp.Body, parsed.Model)
	}
	wrapped := *resp
	wrapped.Body = newCodexSSEStream(resp.Body, parsed.Model)
	wrapped.Header = resp.Header.Clone()
	wrapped.Header.Set("Content-Type", "text/event-stream")
	wrapped.Header.Del("Content-Length")
	wrapped.ContentLength = -1
	return &wrapped, nil
}

// models 按原始实现的方式转发 GET {base}/models。
func (t *codexTransport) models(req *http.Request, channelID int64, cred services.CodexCredential) (*http.Response, error) {
	upstreamURL, err := url.Parse(codexModelsURL)
	if err != nil {
		return nil, errors.New("Codex 上游地址不合法")
	}
	clone := req.Clone(req.Context())
	clone.URL = upstreamURL
	clone.Host = ""
	clone.Body = nil
	clone.ContentLength = 0
	clone.GetBody = nil
	codexHeaders(clone.Header, cred.AccessToken, channelID, cred.AccountID, false)
	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Codex 上游：%w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(http.StatusUnauthorized, codexReloginMessage), nil
	}
	return resp, nil
}

// ---------- Responses SSE → OpenAI chat-completions ----------

// codexStreamBody 让消费者 Close 时同时关闭上游连接。
type codexStreamBody struct {
	*io.PipeReader
	upstream io.ReadCloser
}

func (b *codexStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.upstream.Close()
	return err
}

// newCodexSSEStream 在响应体流上实时把 Responses 事件转成 OpenAI chat 分块。
// 复用 responsesStreamToChat（与上游协议适配层同一实现），转换出错时以
// CloseWithError 结束，网关据此把账号标记为失败而不是「正常结束」。
func newCodexSSEStream(upstream io.ReadCloser, model string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Close()
		defer pw.Close()
		conv := newResponsesStreamToChat(model)
		reader := bufio.NewReaderSize(upstream, 64<<10)
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				if len(line) > codexMaxSSELine {
					pw.CloseWithError(errors.New("Codex 数据帧异常（单行超过 8MB）"))
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
				pw.CloseWithError(fmt.Errorf("Codex 响应中断：%w", err))
				return
			}
		}
	}()
	return &codexStreamBody{PipeReader: pr, upstream: upstream}
}

// aggregateCodexResponsesSSE 把上游 Responses 事件流聚合成一个 chat.completion JSON。
//
// 先把每一行喂给 responsesStreamToChat 转成 chat 分块，再合并分块：
// 正文/思考拼接，工具调用按 index 累积（首个分块带 id/name，后续补 arguments）。
func aggregateCodexResponsesSSE(upstream io.ReadCloser, model string) (*http.Response, error) {
	defer upstream.Close()
	conv := newResponsesStreamToChat(model)
	reader := bufio.NewReaderSize(io.LimitReader(upstream, codexMaxBodyBytes), 64<<10)
	var content, reasoning strings.Builder
	toolIndex := map[int]int{}
	toolCalls := []map[string]any{}
	var usage map[string]any
	finish := ""
	id := ""
	outModel := model
	var readErr error
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if len(line) > codexMaxSSELine {
				return nil, errors.New("Codex 数据帧异常（单行超过 8MB）")
			}
			chunk := conv.Convert(line)
			if len(chunk) > 0 {
				payload := bytes.TrimSpace(bytes.TrimPrefix(bytes.TrimSpace(chunk), []byte("data:")))
				var parsed struct {
					ID      string `json:"id"`
					Model   string `json:"model"`
					Choices []struct {
						Delta struct {
							Content          string `json:"content"`
							ReasoningContent string `json:"reasoning_content"`
							Reasoning        string `json:"reasoning"`
							ToolCalls        []struct {
								Index    int    `json:"index"`
								ID       string `json:"id"`
								Type     string `json:"type"`
								Function struct {
									Name      string `json:"name"`
									Arguments string `json:"arguments"`
								} `json:"function"`
							} `json:"tool_calls"`
						} `json:"delta"`
						FinishReason *string `json:"finish_reason"`
					} `json:"choices"`
					Usage map[string]any `json:"usage"`
				}
				if json.Unmarshal(payload, &parsed) == nil {
					if parsed.ID != "" {
						id = parsed.ID
					}
					if parsed.Model != "" {
						outModel = parsed.Model
					}
					if parsed.Usage != nil {
						usage = parsed.Usage
					}
					for _, choice := range parsed.Choices {
						delta := choice.Delta
						content.WriteString(delta.Content)
						if delta.ReasoningContent != "" {
							reasoning.WriteString(delta.ReasoningContent)
						} else {
							reasoning.WriteString(delta.Reasoning)
						}
						for _, tc := range delta.ToolCalls {
							idx, known := toolIndex[tc.Index]
							if !known {
								idx = len(toolCalls)
								toolIndex[tc.Index] = idx
								toolCalls = append(toolCalls, map[string]any{
									"id": "", "type": "function",
									"function": map[string]any{"name": "", "arguments": ""},
								})
							}
							entry := toolCalls[idx]
							fn := entry["function"].(map[string]any)
							if tc.ID != "" {
								entry["id"] = tc.ID
							}
							if tc.Type != "" {
								entry["type"] = tc.Type
							}
							if tc.Function.Name != "" {
								fn["name"] = fn["name"].(string) + tc.Function.Name
							}
							fn["arguments"] = fn["arguments"].(string) + tc.Function.Arguments
						}
						if choice.FinishReason != nil {
							finish = *choice.FinishReason
						}
					}
				}
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}
	if readErr != nil {
		return nil, fmt.Errorf("读取 Codex 响应流失败：%w", readErr)
	}
	if finish == "" {
		if len(toolCalls) > 0 {
			finish = "tool_calls"
		} else {
			finish = "stop"
		}
	}
	message := map[string]any{"role": "assistant"}
	if content.Len() == 0 && len(toolCalls) > 0 {
		message["content"] = nil
	} else {
		message["content"] = content.String()
	}
	if reasoning.Len() > 0 {
		message["reasoning_content"] = reasoning.String()
	}
	if len(toolCalls) > 0 {
		for _, call := range toolCalls {
			if call["id"] == "" {
				call["id"] = "call_" + randomHex(12)
			}
		}
		message["tool_calls"] = toolCalls
	}
	out := map[string]any{
		"id":      firstNonEmpty(id, "chatcmpl-"+randomHex(12)),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   outModel,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
	}
	if usage != nil {
		out["usage"] = usage
	}
	return jsonResponse(http.StatusOK, out), nil
}
