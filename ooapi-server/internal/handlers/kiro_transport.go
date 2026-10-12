package handlers

// Kiro 传输层（RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-kiro-channel-{id}"，真实凭据加密存在
// auth_credential。请求打到 https://codewhisperer.{region}.amazonaws.com 时：
//
//   - 用标识换出解密后的 access_token（必要时提前续期，单飞 + CAS）；
//   - POST /chat/completions → 改写为 POST /generateAssistantResponse，
//     请求体从 OpenAI chat 转成 Kiro 的 conversationState；
//   - 响应是 AWS EventStream 二进制帧，这里在流上实时转成 OpenAI SSE，
//     下游网关照常做用量提取、计费与日志；
//   - GET /models → /ListAvailableModels，转换为 OpenAI 模型列表形状。
//
// 只有内部标识的请求会被改写；其它打到该主机的请求原样透传。
// 凭据永远不会被发往非官方主机（见各分支的 host 判定）。

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"ooapi/internal/services"
)

const (
	kiroMarkerPrefix = "ooapi-kiro-channel-"
	kiroMaxBodyBytes = 32 << 20
	kiroMaxFrameSize = 16 << 20
)

// 解析器与强制刷新可在测试中替换（不依赖数据库）。
var (
	resolveKiroCredential      = services.ResolveKiroCredential
	forceRefreshKiroCredential = services.ForceRefreshKiroCredential
)

// init 把 Kiro 装饰器挂到共享客户端上。文件按名称顺序初始化
// （cline_transport.go < kiro_transport.go < workbuddy_transport.go），
// 因此本链位于 Cline 装饰器之外；这里包住「当前」transport 而不是
// http.DefaultTransport，三者才能同时生效。
func init() {
	upstreamClient.Transport = &kiroTransport{base: upstreamClient.Transport}
	probeClient.Transport = &kiroTransport{base: probeClient.Transport}
}

type kiroTransport struct{ base http.RoundTripper }

func isKiroHost(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && services.KiroRegionFromHost(u.Hostname()) != ""
}

func (t *kiroTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, kiroMarkerPrefix)
	if !isKiroHost(req.URL) {
		if internal {
			return nil, errors.New("Kiro 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		// 非设备授权渠道（管理员自填 key 的 api 渠道）：不动它的请求。
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, kiroMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("Kiro 内部凭据标识无效")
	}
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	isChat := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/chat/completions")
	isModels := req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("Kiro 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	cred, err := resolveKiroCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	base := services.KiroAPIBaseURL(cred.Region)
	if isModels {
		return t.listModels(req, cred, base)
	}
	return t.chat(req, id, cred, base)
}

// kiroChatRequest 是 OpenAI chat 请求体里我们需要的字段（其余忽略）。
type kiroChatRequest struct {
	Model    string        `json:"model"`
	Messages []kiroMessage `json:"messages"`
	Tools    []kiroTool    `json:"tools"`
	Stream   bool          `json:"stream"`
}

type kiroMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCalls  []kiroToolCall  `json:"tool_calls"`
	ToolCallID string          `json:"tool_call_id"`
	IsError    bool            `json:"is_error"`
}

type kiroToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type kiroTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

func (t *kiroTransport) chat(req *http.Request, channelID int64, cred services.KiroCredential, base string) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, kiroMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 Kiro 请求体失败")
	}
	var in kiroChatRequest
	if json.Unmarshal(raw, &in) != nil {
		return nil, errors.New("Kiro 请求体不是合法 JSON")
	}
	model := services.KiroModelID(in.Model)
	// 会话头（渠道自定义头里用 {{session}} 注入）：有它则 conversationId 稳定可复现。
	sessionID := strings.TrimSpace(req.Header.Get("X-Session-Id"))
	upstreamBody, err := buildKiroConversation(channelID, model, in, sessionID)
	if err != nil {
		return nil, err
	}
	upstreamURL, err := url.Parse(base + "/generateAssistantResponse")
	if err != nil {
		return nil, errors.New("Kiro 上游地址不合法")
	}

	attempt := func(token string) (*http.Response, error) {
		clone := req.Clone(req.Context())
		clone.URL = upstreamURL
		clone.Host = ""
		clone.Body = io.NopCloser(bytes.NewReader(upstreamBody))
		clone.ContentLength = int64(len(upstreamBody))
		clone.GetBody = nil
		setKiroChatHeaders(clone.Header, token, channelID)
		return t.base.RoundTrip(clone)
	}

	resp, err := attempt(cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Kiro 上游：%w", err)
	}
	// 403 → 强制刷新后重试一次（与开源实现一致）。
	if resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		token := cred.AccessToken
		if fresh, ferr := forceRefreshKiroCredential(req.Context(), channelID); ferr == nil && fresh.AccessToken != "" {
			token = fresh.AccessToken
		}
		resp, err = attempt(token)
		if err != nil {
			return nil, fmt.Errorf("无法连接 Kiro 上游：%w", err)
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	if !in.Stream {
		// 下游要非流式：上游本来就是流，这里读完整条流聚合成一个 chat.completion。
		return aggregateKiroResponse(resp, model)
	}
	wrapped := *resp
	wrapped.Body = newKiroSSEStream(resp.Body, model)
	wrapped.Header = resp.Header.Clone()
	wrapped.Header.Set("Content-Type", "text/event-stream")
	wrapped.Header.Del("Content-Length")
	wrapped.ContentLength = -1
	return &wrapped, nil
}

// setKiroChatHeaders 按 Kiro CLI 的实测头组设置请求头。
func setKiroChatHeaders(h http.Header, token string, channelID int64) {
	fp := services.KiroDeviceFingerprint(channelID)
	h.Set("Authorization", "Bearer "+token)
	h.Set("Content-Type", "application/x-amz-json-1.0")
	h.Set("X-Amz-Target", "AmazonCodeWhispererStreamingService.GenerateAssistantResponse")
	h.Set("User-Agent", "aws-sdk-js/1.0.27 ua/2.1 os/linux lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-"+fp)
	h.Set("X-Amz-User-Agent", "aws-sdk-js/1.0.27 KiroIDE-0.7.45-"+fp)
	h.Set("X-Amzn-Codewhisperer-Optout", "true")
	h.Set("X-Amzn-Kiro-Agent-Mode", "vibe")
	h.Set("Amz-Sdk-Invocation-Id", randomUUID())
	h.Set("Amz-Sdk-Request", "attempt=1; max=3")
	h.Set("Accept", "*/*")
}

func (t *kiroTransport) listModels(req *http.Request, cred services.KiroCredential, base string) (*http.Response, error) {
	target, err := url.Parse(base + "/ListAvailableModels?origin=AI_EDITOR&maxResults=50")
	if err != nil {
		return nil, errors.New("Kiro 模型列表地址不合法")
	}
	clone := req.Clone(req.Context())
	clone.URL = target
	clone.Host = ""
	clone.Body = nil
	clone.ContentLength = 0
	clone.GetBody = nil
	h := clone.Header
	h.Set("Authorization", "Bearer "+cred.AccessToken)
	h.Set("Accept", "application/json")
	h.Set("X-Amzn-Codewhisperer-Optout", "true")
	h.Set("User-Agent", "aws-sdk-js/1.0.0 KiroIDE-0.8.0")
	h.Set("X-Amz-User-Agent", "aws-sdk-js/1.0.0 KiroIDE-0.8.0")
	resp, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Kiro 上游：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	raw, err := readBodyLimited(resp.Body, 4<<20)
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	ids, err := parseKiroModels(raw)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, id := range ids {
		items = append(items, map[string]any{"id": id, "object": "model", "owned_by": "kiro"})
	}
	return jsonResponse(http.StatusOK, map[string]any{"object": "list", "data": items}), nil
}

// parseKiroModels 从 ListAvailableModels 的原始响应里提取模型 ID。
//
// 独立于 listModels：一键授权后、渠道还没落库时也要拉这份清单
// （按票据凭据直接请求），两条路径必须用同一套解析与去重规则。
func parseKiroModels(raw []byte) ([]string, error) {
	var parsed struct {
		Models []struct {
			ModelID   string `json:"modelId"`
			ModelName string `json:"modelName"`
			ID        string `json:"id"`
		} `json:"models"`
		Data []struct {
			ModelID   string `json:"modelId"`
			ModelName string `json:"modelName"`
			ID        string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("Kiro 模型列表不是合法 JSON")
	}
	list := parsed.Models
	if len(list) == 0 {
		list = parsed.Data
	}
	out := []string{}
	seen := map[string]struct{}{}
	for _, m := range list {
		id := strings.TrimSpace(m.ModelID)
		if id == "" {
			id = strings.TrimSpace(m.ModelName)
		}
		if id == "" {
			id = strings.TrimSpace(m.ID)
		}
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

// ---------- 请求体构造 ----------

// normalizeKiroContent 把 OpenAI 的 content（字符串 / 分片数组 / null）归一成纯文本。
func normalizeKiroContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, part := range parts {
			var asString string
			if json.Unmarshal(part, &asString) == nil {
				b.WriteString(asString)
				continue
			}
			var obj struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Content string `json:"content"`
			}
			if json.Unmarshal(part, &obj) == nil && (obj.Type == "text" || obj.Text != "" || obj.Content != "") {
				if obj.Text != "" {
					b.WriteString(obj.Text)
				} else {
					b.WriteString(obj.Content)
				}
			}
		}
		return b.String()
	}
	var obj struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return obj.Text
	}
	return ""
}

// kiroConversationID 生成 conversationId：有会话头时由 channelID+session 确定性派生
// （同一会话复用同一 id，上游才能延续上下文），否则随机 UUID。
func kiroConversationID(channelID int64, sessionID string) string {
	if strings.TrimSpace(sessionID) == "" {
		return randomUUID()
	}
	sum := sha256Hex(fmt.Sprintf("%d:%s", channelID, sessionID))
	return sum[:8] + "-" + sum[8:12] + "-" + sum[12:16] + "-" + sum[16:20] + "-" + sum[20:32]
}

// buildKiroConversation 把 OpenAI chat 请求体转成 Kiro 的 conversationState。
//
// Kiro 没有顶层 system 字段：system/developer 消息必须包进
// <system_instructions> 并前置到当前消息内容里。
func buildKiroConversation(channelID int64, model string, in kiroChatRequest, sessionID string) ([]byte, error) {
	systemParts := []string{}
	history := []map[string]any{}
	for _, m := range in.Messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		text := normalizeKiroContent(m.Content)
		switch role {
		case "system", "developer":
			if text != "" {
				systemParts = append(systemParts, text)
			}
		case "assistant":
			msg := map[string]any{"content": text}
			if text == "" {
				msg["content"] = " "
			}
			toolUses := []map[string]any{}
			for _, tc := range m.ToolCalls {
				var input any
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &input); err != nil {
					input = tc.Function.Arguments
				}
				toolUses = append(toolUses, map[string]any{
					"toolUseId": tc.ID,
					"name":      tc.Function.Name,
					"input":     input,
				})
			}
			if len(toolUses) > 0 {
				msg["toolUses"] = toolUses
			}
			history = append(history, map[string]any{"assistantResponseMessage": msg})
		default: // user / tool / 其它
			toolResults := []map[string]any{}
			if role == "tool" {
				status := "success"
				if m.IsError {
					status = "error"
				}
				toolResults = append(toolResults, map[string]any{
					"toolUseId": m.ToolCallID,
					"content":   []map[string]any{{"text": text}},
					"status":    status,
				})
			}
			if len(history) > 0 {
				if prev, ok := history[len(history)-1]["userInputMessage"].(map[string]any); ok {
					if role != "tool" && text != "" {
						prev["content"] = prev["content"].(string) + "\n" + text
					}
					if len(toolResults) > 0 {
						ctx, _ := prev["userInputMessageContext"].(map[string]any)
						if ctx == nil {
							ctx = map[string]any{}
						}
						existing, _ := ctx["toolResults"].([]map[string]any)
						ctx["toolResults"] = append(existing, toolResults...)
						prev["userInputMessageContext"] = ctx
					}
					continue
				}
			}
			content := text
			if role == "tool" {
				content = "工具执行结果如下。"
			}
			if content == "" {
				content = " "
			}
			uim := map[string]any{"content": content, "modelId": model, "origin": "AI_EDITOR"}
			if len(toolResults) > 0 {
				uim["userInputMessageContext"] = map[string]any{"toolResults": toolResults}
			}
			history = append(history, map[string]any{"userInputMessage": uim})
		}
	}
	current := map[string]any{"content": "继续", "modelId": model, "origin": "AI_EDITOR"}
	if len(history) > 0 {
		if last, ok := history[len(history)-1]["userInputMessage"].(map[string]any); ok {
			current = last
			history = history[:len(history)-1]
		}
	}
	if system := strings.Join(systemParts, "\n\n"); system != "" {
		current["content"] = "<system_instructions>\n" + system + "\n</system_instructions>\n\n" + current["content"].(string)
	}
	if len(in.Tools) > 0 {
		tools := []map[string]any{}
		for _, tl := range in.Tools {
			schema := tl.Function.Parameters
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			tools = append(tools, map[string]any{
				"toolSpecification": map[string]any{
					"name":        tl.Function.Name,
					"description": tl.Function.Description,
					"inputSchema": map[string]any{"json": schema},
				},
			})
		}
		ctx, _ := current["userInputMessageContext"].(map[string]any)
		if ctx == nil {
			ctx = map[string]any{}
		}
		ctx["tools"] = tools
		current["userInputMessageContext"] = ctx
	}
	state := map[string]any{
		"conversationId":  kiroConversationID(channelID, sessionID),
		"chatTriggerType": "MANUAL",
		"currentMessage":  map[string]any{"userInputMessage": current},
		"history":         history,
	}
	return json.Marshal(map[string]any{"conversationState": state})
}

// ---------- AWS EventStream 解析 ----------

// awsEventFrame 是一帧 AWS EventStream 消息。
type awsEventFrame struct {
	EventType   string
	MessageType string
	Payload     []byte
}

// awsEventStreamParser 是增量解析器：Push 返回本次解析出的完整帧。
// 帧格式：[4B total_len][4B headers_len][4B prelude_crc][headers][payload][4B message_crc]
type awsEventStreamParser struct{ buf []byte }

func (p *awsEventStreamParser) Push(chunk []byte) ([]awsEventFrame, error) {
	if len(chunk) > 0 {
		p.buf = append(p.buf, chunk...)
	}
	out := []awsEventFrame{}
	for {
		if len(p.buf) < 12 {
			break
		}
		total := int(binary.BigEndian.Uint32(p.buf[0:4]))
		headersLen := int(binary.BigEndian.Uint32(p.buf[4:8]))
		if total < 16 || total > kiroMaxFrameSize {
			p.buf = nil
			return out, fmt.Errorf("Kiro 事件帧长度异常（%d）", total)
		}
		if len(p.buf) < total {
			break
		}
		frame := p.buf[:total]
		p.buf = p.buf[total:]
		headerEnd := 12 + headersLen
		if headersLen < 0 || headerEnd > total-4 {
			continue
		}
		headers := parseAwsEventHeaders(frame[12:headerEnd])
		payload := append([]byte(nil), frame[headerEnd:total-4]...)
		out = append(out, awsEventFrame{
			EventType:   headers[":event-type"],
			MessageType: headers[":message-type"],
			Payload:     payload,
		})
	}
	if len(p.buf) == 0 {
		p.buf = nil
	}
	return out, nil
}

// parseAwsEventHeaders 解析帧头；类型编码：0/1 布尔、2 byte、3 short、4 int、
// 5 long、6 bytes、7 string、8 timestamp、9 uuid。未知类型无法安全跳长度，直接结束。
func parseAwsEventHeaders(buf []byte) map[string]string {
	headers := map[string]string{}
	i := 0
	for i < len(buf) {
		nameLen := int(buf[i])
		i++
		if i+nameLen > len(buf) {
			break
		}
		name := string(buf[i : i+nameLen])
		i += nameLen
		if i >= len(buf) {
			break
		}
		kind := buf[i]
		i++
		switch kind {
		case 0:
			headers[name] = "true"
		case 1:
			headers[name] = "false"
		case 2:
			i++
		case 3:
			i += 2
		case 4:
			i += 4
		case 5, 8:
			i += 8
		case 9:
			i += 16
		case 6:
			if i+2 > len(buf) {
				return headers
			}
			i += 2 + int(binary.BigEndian.Uint16(buf[i:]))
		case 7:
			if i+2 > len(buf) {
				return headers
			}
			n := int(binary.BigEndian.Uint16(buf[i:]))
			i += 2
			if i+n > len(buf) {
				return headers
			}
			headers[name] = string(buf[i : i+n])
			i += n
		default:
			return headers
		}
		if i > len(buf) {
			break
		}
	}
	return headers
}

// kiroTokenUsage 是 messageMetadataEvent 里的用量字段。
type kiroTokenUsage struct {
	UncachedInputTokens   *int64 `json:"uncachedInputTokens"`
	CacheReadInputTokens  int64  `json:"cacheReadInputTokens"`
	CacheWriteInputTokens int64  `json:"cacheWriteInputTokens"`
	InputTokens           int64  `json:"inputTokens"`
	OutputTokens          int64  `json:"outputTokens"`
}

// toOpenAIUsage 映射到 OpenAI 口径。
//
// 输入总量：AWS 的 inputTokens 有时是「含缓存的全部输入」，而 uncached+cacheRead
// 是分项之和；取两者较大值再加 cacheWrite，避免重复计费也不漏计。
func (u *kiroTokenUsage) toOpenAIUsage() map[string]any {
	if u == nil {
		return nil
	}
	prompt := u.InputTokens
	if u.UncachedInputTokens != nil {
		split := *u.UncachedInputTokens + u.CacheReadInputTokens
		if split > prompt {
			prompt = split
		}
		prompt += u.CacheWriteInputTokens
	}
	if prompt < 0 {
		prompt = 0
	}
	completion := u.OutputTokens
	if completion < 0 {
		completion = 0
	}
	out := map[string]any{
		"prompt_tokens":     prompt,
		"completion_tokens": completion,
		"total_tokens":      prompt + completion,
	}
	if u.CacheReadInputTokens > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": u.CacheReadInputTokens}
	}
	return out
}

// ---------- EventStream → OpenAI SSE ----------

// kiroStreamBody 让消费者 Close 时同时关闭上游连接 ——
// 否则客户端断开后读取 goroutine 会一直阻塞在 upstream.Read 上。
type kiroStreamBody struct {
	*io.PipeReader
	upstream io.ReadCloser
}

func (b *kiroStreamBody) Close() error {
	err := b.PipeReader.Close()
	b.upstream.Close()
	return err
}

// newKiroSSEStream 在响应体流上实时把 EventStream 转成 OpenAI SSE。
// 上游读取出错时以 CloseWithError 结束，网关据此标记账号故障而不是「正常结束」。
func newKiroSSEStream(upstream io.ReadCloser, model string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Close()
		defer pw.Close()
		w := &kiroSSEWriter{pw: pw, model: model, id: "chatcmpl-" + randomHex(12), created: time.Now().Unix(), toolIndex: map[string]int{}, toolInput: map[string]*kiroToolInputState{}}
		if err := w.emitRole(); err != nil {
			return
		}
		parser := &awsEventStreamParser{}
		buf := make([]byte, 32<<10)
		for {
			n, err := upstream.Read(buf)
			if n > 0 {
				frames, perr := parser.Push(buf[:n])
				if perr != nil {
					w.fail(perr)
					return
				}
				for _, f := range frames {
					if werr := w.handleFrame(f); werr != nil {
						w.fail(werr)
						return
					}
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if werr := w.finish(); werr != nil {
						w.fail(werr)
					}
					return
				}
				w.fail(fmt.Errorf("Kiro 响应中断：%w", err))
				return
			}
		}
	}()
	return &kiroStreamBody{PipeReader: pr, upstream: upstream}
}

// kiroToolInputState 记录单个工具调用的参数累积状态。
// Kiro 的 toolUseEvent 参数有两种形态：字符串分片（追加）与完整对象（整体替换）。
type kiroToolInputState struct {
	arguments  string
	objectDone bool
}

type kiroSSEWriter struct {
	pw        *io.PipeWriter
	model     string
	id        string
	created   int64
	toolIndex map[string]int
	toolInput map[string]*kiroToolInputState
	toolCount int
	usage     *kiroTokenUsage
}

func (w *kiroSSEWriter) emit(v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w.pw, "data: %s\n\n", raw); err != nil {
		return err
	}
	return nil
}

func (w *kiroSSEWriter) chunk(delta map[string]any, finish any) error {
	return w.emit(map[string]any{
		"id":      w.id,
		"object":  "chat.completion.chunk",
		"created": w.created,
		"model":   w.model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
	})
}

func (w *kiroSSEWriter) emitRole() error {
	return w.chunk(map[string]any{"role": "assistant", "content": ""}, nil)
}

func (w *kiroSSEWriter) fail(err error) {
	// 已写错误帧后以管道错误收尾：网关会把「上游中途出错」记为账号失败而不是成功。
	_ = w.emit(map[string]any{"error": map[string]any{"message": err.Error()}})
	_ = w.pw.CloseWithError(err)
}

func (w *kiroSSEWriter) finish() error {
	finish := "stop"
	if w.toolCount > 0 {
		finish = "tool_calls"
	}
	if err := w.chunk(map[string]any{}, finish); err != nil {
		return err
	}
	if usage := w.usage.toOpenAIUsage(); usage != nil {
		if err := w.emit(map[string]any{
			"id": w.id, "object": "chat.completion.chunk", "created": w.created, "model": w.model,
			"choices": []any{}, "usage": usage,
		}); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w.pw, "data: [DONE]\n\n")
	return err
}

func (w *kiroSSEWriter) handleFrame(f awsEventFrame) error {
	if f.MessageType == "exception" || f.MessageType == "error" {
		var p struct {
			Message string `json:"message"`
			Reason  string `json:"reason"`
		}
		json.Unmarshal(f.Payload, &p)
		msg := p.Message
		if msg == "" {
			msg = p.Reason
		}
		if msg == "" {
			msg = f.EventType
		}
		return fmt.Errorf("Kiro 上游错误：%s", msg)
	}
	switch f.EventType {
	case "assistantResponseEvent":
		var p struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(f.Payload, &p) == nil && p.Content != "" {
			return w.chunk(map[string]any{"content": p.Content}, nil)
		}
	case "reasoningContentEvent":
		var p struct {
			Text    string `json:"text"`
			Content string `json:"content"`
		}
		if json.Unmarshal(f.Payload, &p) == nil {
			text := p.Text
			if text == "" {
				text = p.Content
			}
			if text != "" {
				return w.chunk(map[string]any{"reasoning_content": text}, nil)
			}
		}
	case "toolUseEvent":
		var p struct {
			ToolUseID string          `json:"toolUseId"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			Stop      bool            `json:"stop"`
		}
		if json.Unmarshal(f.Payload, &p) != nil {
			return nil
		}
		id := p.ToolUseID
		if id == "" {
			id = fmt.Sprintf("tool-%d", w.toolCount)
		}
		idx, known := w.toolIndex[id]
		if !known {
			idx = w.toolCount
			w.toolIndex[id] = idx
			w.toolCount++
		}
		fn := map[string]any{}
		call := map[string]any{"index": idx, "type": "function", "function": fn}
		if !known {
			call["id"] = id
		}
		if p.Name != "" {
			fn["name"] = p.Name
		}
		state := w.toolInput[id]
		if state == nil {
			state = &kiroToolInputState{}
			w.toolInput[id] = state
		}
		trimmed := bytes.TrimSpace(p.Input)
		if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
			if trimmed[0] == '"' {
				// 字符串分片：按 OpenAI 语义追加（对象形态只发一次，之后不再追加）。
				var s string
				if json.Unmarshal(trimmed, &s) == nil && !state.objectDone {
					state.arguments += s
					fn["arguments"] = s
				}
			} else {
				// 完整对象：整体替换。
				state.arguments = string(trimmed)
				state.objectDone = true
				fn["arguments"] = string(trimmed)
			}
		}
		return w.chunk(map[string]any{"tool_calls": []any{call}}, nil)
	case "messageMetadataEvent":
		var p struct {
			TokenUsage *kiroTokenUsage `json:"tokenUsage"`
			Usage      *kiroTokenUsage `json:"usage"`
		}
		if json.Unmarshal(f.Payload, &p) == nil {
			switch {
			case p.TokenUsage != nil:
				w.usage = p.TokenUsage
			case p.Usage != nil:
				w.usage = p.Usage
			}
		}
	case "invalidStateEvent":
		var p struct {
			Reason  string `json:"reason"`
			Message string `json:"message"`
		}
		json.Unmarshal(f.Payload, &p)
		msg := p.Reason
		if msg == "" {
			msg = p.Message
		}
		if msg == "" {
			msg = "Kiro 会话状态异常"
		}
		return fmt.Errorf("Kiro 上游错误：%s", msg)
	}
	return nil
}

// aggregateKiroResponse 读完整条 EventStream，聚合为一个 chat.completion JSON。
func aggregateKiroResponse(resp *http.Response, model string) (*http.Response, error) {
	defer resp.Body.Close()
	body, err := readBodyLimited(resp.Body, kiroMaxBodyBytes)
	if err != nil {
		return nil, err
	}
	parser := &awsEventStreamParser{}
	frames, err := parser.Push(body)
	if err != nil {
		return nil, err
	}
	var content, reasoning strings.Builder
	toolIndex := map[string]int{}
	toolState := map[string]*kiroToolInputState{}
	tools := []map[string]any{}
	var usage *kiroTokenUsage
	upstreamErr := ""
	for _, f := range frames {
		if f.MessageType == "exception" || f.MessageType == "error" {
			var p struct {
				Message string `json:"message"`
				Reason  string `json:"reason"`
			}
			json.Unmarshal(f.Payload, &p)
			upstreamErr = p.Message
			if upstreamErr == "" {
				upstreamErr = p.Reason
			}
			if upstreamErr == "" {
				upstreamErr = f.EventType
			}
			continue
		}
		switch f.EventType {
		case "assistantResponseEvent":
			var p struct {
				Content string `json:"content"`
			}
			json.Unmarshal(f.Payload, &p)
			content.WriteString(p.Content)
		case "reasoningContentEvent":
			var p struct {
				Text    string `json:"text"`
				Content string `json:"content"`
			}
			json.Unmarshal(f.Payload, &p)
			if p.Text != "" {
				reasoning.WriteString(p.Text)
			} else {
				reasoning.WriteString(p.Content)
			}
		case "toolUseEvent":
			var p struct {
				ToolUseID string          `json:"toolUseId"`
				Name      string          `json:"name"`
				Input     json.RawMessage `json:"input"`
				Stop      bool            `json:"stop"`
			}
			if json.Unmarshal(f.Payload, &p) != nil {
				continue
			}
			id := p.ToolUseID
			if id == "" {
				id = fmt.Sprintf("tool-%d", len(tools))
			}
			idx, ok := toolIndex[id]
			if !ok {
				idx = len(tools)
				toolIndex[id] = idx
				tools = append(tools, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": "", "arguments": ""}})
			}
			entry := tools[idx]
			fn := entry["function"].(map[string]any)
			if p.Name != "" {
				fn["name"] = p.Name
			}
			state := toolState[id]
			if state == nil {
				state = &kiroToolInputState{}
				toolState[id] = state
			}
			trimmed := bytes.TrimSpace(p.Input)
			if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
				if trimmed[0] == '"' {
					var s string
					if json.Unmarshal(trimmed, &s) == nil && !state.objectDone {
						state.arguments += s
						fn["arguments"] = state.arguments
					}
				} else {
					// 完整对象：整体替换（与流式路径、原 tool-wire 语义一致）。
					state.arguments = string(trimmed)
					state.objectDone = true
					fn["arguments"] = state.arguments
				}
			}
		case "messageMetadataEvent":
			var p struct {
				TokenUsage *kiroTokenUsage `json:"tokenUsage"`
				Usage      *kiroTokenUsage `json:"usage"`
			}
			if json.Unmarshal(f.Payload, &p) == nil {
				if p.TokenUsage != nil {
					usage = p.TokenUsage
				} else if p.Usage != nil {
					usage = p.Usage
				}
			}
		case "invalidStateEvent":
			var p struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			}
			json.Unmarshal(f.Payload, &p)
			upstreamErr = p.Reason
			if upstreamErr == "" {
				upstreamErr = p.Message
			}
		}
	}
	if upstreamErr != "" {
		return jsonErrorMessage(http.StatusBadGateway, "Kiro 上游错误："+upstreamErr), nil
	}
	finish := "stop"
	if len(tools) > 0 {
		finish = "tool_calls"
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if len(tools) > 0 {
		message["tool_calls"] = tools
	}
	out := map[string]any{
		"id":      "chatcmpl-" + randomHex(12),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
	}
	if usageMap := usage.toOpenAIUsage(); usageMap != nil {
		out["usage"] = usageMap
	}
	return jsonResponse(http.StatusOK, out), nil
}

// ---------- 通用小工具 ----------

func readBodyLimited(r io.Reader, limit int64) ([]byte, error) {
	if r == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("上游响应过大或读取失败")
	}
	return data, nil
}

func jsonResponse(status int, payload any) *http.Response {
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = []byte(`{"error":{"message":"响应序列化失败"}}`)
	}
	return &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:        http.Header{"Content-Type": []string{"application/json"}},
		Body:          io.NopCloser(bytes.NewReader(raw)),
		ContentLength: int64(len(raw)),
	}
}

func jsonErrorMessage(status int, message string) *http.Response {
	return jsonResponse(status, map[string]any{"error": map[string]any{"message": message, "type": "upstream_error"}})
}

func randomUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", time.Now().UnixNano()%1e12)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(buf[0:4]), hex.EncodeToString(buf[4:6]), hex.EncodeToString(buf[6:8]), hex.EncodeToString(buf[8:10]), hex.EncodeToString(buf[10:16]))
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
