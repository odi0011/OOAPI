package handlers

// Grok（xAI 订阅）传输层（RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-grok-channel-{id}"，真实凭据加密存在
// auth_credential。请求打到官方订阅主机 https://cli-chat-proxy.grok.com 时：
//
//   - 用标识换出解密后的 access_token（必要时提前续期，单飞 + CAS）；
//   - POST /v1/chat/completions → 改写为 POST /v1/responses（xAI Responses API）：
//     请求体翻成 Responses 形状（instructions / input / tools），并补上原始实现
//     固定发送的 store=false、prompt_cache_key、include=["reasoning.encrypted_content"]；
//   - 上游响应是 Responses 事件的 SSE 流，这里在流上实时转成 OpenAI
//     chat-completions 分块，下游通用管线（protocol.go）原样透传，无需改动；
//     下游要非流式时聚合为一个 chat.completion JSON；
//   - GET /models 按原始实现带相同的身份头透传；
//   - 401/403：先强制刷新凭据重试一次（原始实现同样把 403 当凭据问题处理），
//     仍被拒则返回「Grok 登录已过期，请重新一键登录」。
//
// 该主机上的请求只带一种凭据：内部标识。凭据永远不会被发往其它主机。
// 不做任何 TLS/浏览器指纹伪装（原始实现明确拒绝指纹伪造，这里同样不做）。

import (
	"bufio"
	"bytes"
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
	grokMarkerPrefix = "ooapi-grok-channel-"
	grokMaxBodyBytes = 32 << 20
	// grokMaxSSELine 防止上游异常数据把内存撑爆（原始实现的单行上限为 8MB）。
	grokMaxSSELine = 8 << 20
)

// 解析与强制刷新可在测试中替换（不依赖数据库）。
var (
	resolveGrokCredential      = services.ResolveGrokCredential
	forceRefreshGrokCredential = services.ForceRefreshGrokCredential
)

// init 把 Grok 装饰器挂到共享客户端上。文件按名称顺序初始化
// （cline_transport.go < grok_transport.go < kiro_transport.go < workbuddy_transport.go），
// 这里包住「当前」transport 而不是 http.DefaultTransport，四个装饰器才能同时生效。
func init() {
	upstreamClient.Transport = &grokTransport{base: upstreamClient.Transport}
	probeClient.Transport = &grokTransport{base: probeClient.Transport}
}

type grokTransport struct{ base http.RoundTripper }

// isGrokSubscriptionHost 只认原始实现使用的官方订阅主机（CLI 代理）。
// 主机名硬编码：凭据在任何情况下都不得被发往其他地址。
func isGrokSubscriptionHost(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && strings.EqualFold(u.Hostname(), "cli-chat-proxy.grok.com")
}

func (t *grokTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, grokMarkerPrefix)
	if !isGrokSubscriptionHost(req.URL) {
		if internal {
			return nil, errors.New("Grok 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		// 非设备授权渠道（管理员自填 key 的 api 渠道）：不动它的请求。
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, grokMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("Grok 内部凭据标识无效")
	}
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	isChat := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/chat/completions")
	isModels := req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("Grok 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	cred, err := resolveGrokCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cred.AccessToken) == "" {
		return nil, errors.New("Grok 账号缺少 access_token，请重新一键登录")
	}
	// 不按本地 auth_expires_at 拦截：本地估算可能不准，是否过期以上游 401/403 为准
	// （与 WorkBuddy 的线上修复同一策略）。
	if isModels {
		return t.models(req, id, cred)
	}
	return t.chat(req, id, cred)
}

// grokHeaders 是原始实现 buildHeaders 的忠实翻版（CLI 通道必须带身份头，
// 否则会被上游当成非官方客户端）。
func grokHeaders(h http.Header, token string, channelID int64, sse bool) {
	sessionID := services.GrokSessionID(channelID)
	h.Set("Authorization", "Bearer "+token)
	h.Set("Content-Type", "application/json")
	if sse {
		h.Set("Accept", "text/event-stream")
	} else {
		h.Set("Accept", "application/json")
	}
	h.Set("Connection", "keep-alive")
	h.Set("X-Grok-Conv-Id", sessionID)
	h.Set("User-Agent", services.GrokUserAgent())
	h.Set("X-Grok-Client-Version", services.GrokClientVersion())
	h.Set("X-Grok-Client-Identifier", "grok-shell")
	h.Set("X-Xai-Token-Auth", "xai-grok-cli")
	h.Set("X-Authenticateresponse", "authenticate-response")
}

// grokResponsesBody 把内部通用语（chat-completions）翻成 Responses 请求体，
// 并补上原始实现固定发送的字段。temperature/top_p 这类原实现不发、部分
// Grok 模型会拒绝的参数在这里剔除，保持与原始请求形状一致。
func grokResponsesBody(chatBody []byte, model string, sessionID string) ([]byte, error) {
	// 推理强度在通用语里是 reasoning_effort；通用转换器会丢弃未知字段，
	// 这里先取出来，稍后按原始实现的 Responses 形状补 reasoning:{effort,summary:"auto"}。
	var rawFields struct {
		ReasoningEffort string `json:"reasoning_effort"`
	}
	_ = json.Unmarshal(chatBody, &rawFields)
	converted, err := chatToResponsesBody(chatBody, model)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if json.Unmarshal(converted, &payload) != nil {
		return nil, errors.New("Grok 请求体转换失败")
	}
	delete(payload, "temperature")
	delete(payload, "top_p")
	if effort := strings.TrimSpace(rawFields.ReasoningEffort); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort, "summary": "auto"}
	}
	payload["stream"] = true
	payload["store"] = false
	payload["prompt_cache_key"] = sessionID
	payload["include"] = []any{"reasoning.encrypted_content"}
	if _, ok := payload["instructions"]; !ok {
		payload["instructions"] = ""
	}
	return json.Marshal(payload)
}

func (t *grokTransport) chat(req *http.Request, channelID int64, cred services.GrokCredential) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, grokMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 Grok 请求体失败")
	}
	var parsed struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("Grok 请求体不是合法 JSON")
	}
	sessionID := services.GrokSessionID(channelID)
	upstreamBody, err := grokResponsesBody(raw, parsed.Model, sessionID)
	if err != nil {
		return nil, err
	}
	// 固定官方订阅地址：设备渠道的 base_url 由服务端推导，这里再做一次硬校验，
	// 保证凭据只可能发往 cli-chat-proxy.grok.com 的 /v1/responses。
	upstreamURL, err := url.Parse(services.GrokCLIBase + "/responses")
	if err != nil {
		return nil, errors.New("Grok 上游地址不合法")
	}

	attempt := func(token string) (*http.Response, error) {
		clone := req.Clone(req.Context())
		clone.URL = upstreamURL
		clone.Host = ""
		clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
		clone.ContentLength = int64(len(upstreamBody))
		clone.GetBody = nil
		grokHeaders(clone.Header, token, channelID, true)
		return t.base.RoundTrip(clone)
	}

	resp, err := attempt(cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Grok 上游：%w", err)
	}
	// 401/403 先刷新重试一次（与原始实现一致：403 bad-credentials 同样按凭据问题处理）。
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		token := cred.AccessToken
		if fresh, ferr := forceRefreshGrokCredential(req.Context(), channelID); ferr == nil && strings.TrimSpace(fresh.AccessToken) != "" {
			token = fresh.AccessToken
		}
		if token != cred.AccessToken {
			resp, err = attempt(token)
			if err != nil {
				return nil, fmt.Errorf("无法连接 Grok 上游：%w", err)
			}
		}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, fmt.Sprintf("Grok 登录已过期，请重新一键登录（上游返回 HTTP %d）", resp.StatusCode)), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	// 上游理论上始终返回 SSE；若是 JSON（非流式兜底），按形状分别处理。
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		if parsed.Stream {
			return resp, nil
		}
		raw, readErr := readBodyLimited(resp.Body, grokMaxBodyBytes)
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		converted, convErr := responsesToChatResponse(raw, parsed.Model)
		if convErr != nil {
			return nil, errors.New("Grok 响应转换失败")
		}
		return jsonResponse(http.StatusOK, json.RawMessage(converted)), nil
	}
	if !parsed.Stream {
		// 下游要非流式：上游只提供事件流，这里读完整条流聚合成 chat.completion。
		wrapped := &http.Response{StatusCode: resp.StatusCode, Header: resp.Header, Body: newGrokSSEStream(resp.Body, parsed.Model)}
		return aggregateOpenAISSE(wrapped, parsed.Model)
	}
	wrapped := *resp
	wrapped.Body = newGrokSSEStream(resp.Body, parsed.Model)
	wrapped.Header = resp.Header.Clone()
	wrapped.Header.Set("Content-Type", "text/event-stream")
	wrapped.Header.Del("Content-Length")
	wrapped.ContentLength = -1
	return &wrapped, nil
}

// models 按原始实现 fetchUpstreamModels 的方式转发 GET {base}/models。
func (t *grokTransport) models(req *http.Request, channelID int64, cred services.GrokCredential) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Body = nil
	clone.ContentLength = 0
	clone.GetBody = nil
	grokHeaders(clone.Header, cred.AccessToken, channelID, false)
	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Grok 上游：%w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, fmt.Sprintf("Grok 登录已过期，请重新一键登录（上游返回 HTTP %d）", resp.StatusCode)), nil
	}
	return resp, nil
}

// ---------- Responses SSE → OpenAI chat-completions SSE ----------

// grokStreamBody 让消费者 Close 时同时关闭上游连接。
type grokStreamBody struct {
	*io.PipeReader
	upstream io.ReadCloser
}

func (b *grokStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.upstream.Close()
	return err
}

// newGrokSSEStream 在响应体流上实时把 Responses 事件转成 OpenAI chat 分块。
// 复用 responsesStreamToChat（与上游协议适配层同一实现），转换出错时以
// CloseWithError 结束，网关据此把账号标记为失败而不是「正常结束」。
func newGrokSSEStream(upstream io.ReadCloser, model string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Close()
		defer pw.Close()
		conv := newResponsesStreamToChat(model)
		reader := bufio.NewReaderSize(upstream, 64<<10)
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				if len(line) > grokMaxSSELine {
					pw.CloseWithError(errors.New("Grok 数据帧异常（单行超过 8MB）"))
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
				pw.CloseWithError(fmt.Errorf("Grok 响应中断：%w", err))
				return
			}
		}
	}()
	return &grokStreamBody{PipeReader: pr, upstream: upstream}
}
