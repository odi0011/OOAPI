package handlers

// WorkBuddy / CodeBuddy 传输层（RoundTripper 装饰器）。
//
// 渠道在 api_key 列存内部标识 "ooapi-workbuddy-channel-{id}"，真实凭据加密存在
// auth_credential。请求打到 https://www.workbuddy.ai 或 https://copilot.tencent.com 时：
//
//   - 用标识换出解密后的 access_token；
//   - 请求域重写为账号 realm 对应的官方域（域不匹配会被上游 401，且看起来像 token 失效）；
//   - 聊天：POST {base}/v2/chat/completions，补齐上游强制要求的头组，
//     developer 角色改写为 system 且首条必须是 system（否则 400 code 11128）；
//   - 拉模型：GET .../models → GET {base}/v3/config，过滤不可对话档位后转成 OpenAI 形状。
//
// 上游只支持流式对话：下游要非流式时这里强制 stream:true 并把 SSE 聚合成
// 一个 chat.completion JSON。SSE 内容本身原样透传，不做事件级改写。
// 该厂商没有刷新流程：401/403 时返回可读错误，引导管理员重新一键绑定。

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ooapi/internal/services"
)

const (
	workBuddyMarkerPrefix = "ooapi-workbuddy-channel-"
	workBuddyMaxBodyBytes = 32 << 20
	workBuddyCLIVersion   = "2.117.2"
)

// 不可对话档位（图像/视频/补全）会在上游被以 11102 拒掉。
var workBuddyExcludedModel = regexp.MustCompile(`(?i)image|video|nes-|completion-`)

// 可在测试中替换（不依赖数据库）。
var resolveWorkBuddyCredential = services.ResolveWorkBuddyCredential

// init 把 WorkBuddy 装饰器挂到共享客户端上（链在既有 transport 之外）。
func init() {
	upstreamClient.Transport = &workbuddyTransport{base: upstreamClient.Transport}
	probeClient.Transport = &workbuddyTransport{base: probeClient.Transport}
}

type workbuddyTransport struct{ base http.RoundTripper }

func isWorkBuddyHost(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "www.workbuddy.ai", "copilot.tencent.com":
		return true
	}
	return false
}

func (t *workbuddyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	marker := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	internal := strings.HasPrefix(marker, workBuddyMarkerPrefix)
	if !isWorkBuddyHost(req.URL) {
		if internal {
			return nil, errors.New("WorkBuddy 凭据不可转发到其它上游")
		}
		return t.base.RoundTrip(req)
	}
	if !internal {
		return t.base.RoundTrip(req)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(marker, workBuddyMarkerPrefix), 10, 64)
	if err != nil || id <= 0 {
		return nil, errors.New("WorkBuddy 内部凭据标识无效")
	}
	cred, err := resolveWorkBuddyCredential(req.Context(), id)
	if err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, errors.New("WorkBuddy 账号缺少 access_token，请重新一键绑定")
	}
	// 不按本地 auth_expires_at 拦截：该值可能来自早期「1 小时」的兜底估算，
	// 而 JWT 实际上仍然有效（也可能反过来）。是否过期以上游 401/403 为准，
	// 见 chat / listModels 的响应处理。
	// 只改写已知的网关路径；未知路径不得携带凭据打出去。
	isChat := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/chat/completions")
	isModels := req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/models")
	if !isChat && !isModels {
		return nil, errors.New("WorkBuddy 渠道不支持的请求路径，已拒绝携带凭据转发")
	}
	apiBase, webHost, locale := services.WorkBuddyRealmHosts(cred.Realm)
	base, err := url.Parse(apiBase)
	if err != nil {
		return nil, errors.New("WorkBuddy 上游地址不合法")
	}
	clone := req.Clone(req.Context())
	clone.URL = &url.URL{Scheme: "https", Host: base.Host, Path: req.URL.Path, RawQuery: req.URL.RawQuery}
	clone.Host = ""
	clone.GetBody = nil

	if isModels {
		return t.listModels(clone, cred, webHost, locale)
	}
	return t.chat(clone, cred, webHost, locale)
}

func (t *workbuddyTransport) chat(req *http.Request, cred services.WorkBuddyCredential, webHost, locale string) (*http.Response, error) {
	raw, err := readBodyLimited(req.Body, workBuddyMaxBodyBytes)
	if err != nil {
		return nil, errors.New("读取 WorkBuddy 请求体失败")
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return nil, errors.New("WorkBuddy 请求体不是合法 JSON")
	}
	rewriteWorkBuddyMessages(body)
	stream, _ := body["stream"].(bool)
	if !stream {
		// 上游只接受流式；下游要非流式时由这里聚合。
		body["stream"] = true
		if body["stream_options"] == nil {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	upstreamBody, err := json.Marshal(body)
	if err != nil {
		return nil, errors.New("WorkBuddy 请求体序列化失败")
	}
	req.Body = io.NopCloser(bytes.NewReader(upstreamBody))
	req.ContentLength = int64(len(upstreamBody))
	setWorkBuddyHeaders(req.Header, cred, webHost, locale, true)

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接 WorkBuddy 上游：%w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, fmt.Sprintf(
			"WorkBuddy 登录已过期，请重新一键绑定（上游返回 HTTP %d）。若账号版本（国际/国内）与渠道域不匹配也会返回相同错误，请在绑定时选择正确的版本",
			resp.StatusCode)), nil
	}
	if !stream && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		model, _ := body["model"].(string)
		return aggregateOpenAISSE(resp, model)
	}
	return resp, nil
}

// rewriteWorkBuddyMessages 把 developer 角色映射为 system，并保证首条是 system。
// 上游原文报错：400 code 11128 first message is not system prompt。
func rewriteWorkBuddyMessages(body map[string]any) {
	messages, _ := body["messages"].([]any)
	out := make([]any, 0, len(messages)+1)
	for _, m := range messages {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := msg["role"].(string); role == "developer" {
			msg["role"] = "system"
		}
		out = append(out, msg)
	}
	if len(out) == 0 {
		out = append(out,
			map[string]any{"role": "system", "content": "You are a helpful assistant."},
			map[string]any{"role": "user", "content": ""},
		)
	} else if role, _ := out[0].(map[string]any)["role"].(string); role != "system" {
		out = append([]any{map[string]any{"role": "system", "content": "You are a helpful assistant."}}, out...)
	}
	body["messages"] = out
}

// setWorkBuddyHeaders 是上游实测最小可用头组：缺 X-CodeBuddy-Request、
// UA 不是双段、Origin 与 realm 不同域都会直接被拒。
func setWorkBuddyHeaders(h http.Header, cred services.WorkBuddyCredential, webHost, locale string, sse bool) {
	h.Set("Authorization", "Bearer "+cred.AccessToken)
	h.Set("Content-Type", "application/json")
	if sse {
		h.Set("Accept", "application/json, text/event-stream")
	} else {
		h.Set("Accept", "application/json")
	}
	h.Set("Accept-Language", locale)
	h.Set("X-Requested-With", "XMLHttpRequest")
	h.Set("X-Codebuddy-Request", "1")
	h.Set("X-Domain", webHost)
	h.Set("X-Product", "SaaS")
	h.Set("X-Ide-Type", "CLI")
	h.Set("X-Ide-Name", "CLI")
	h.Set("X-Ide-Version", workBuddyCLIVersion)
	h.Set("X-Agent-Intent", "craft")
	h.Set("X-Agent-Purpose", "conversation")
	h.Set("User-Agent", "CLI/"+workBuddyCLIVersion+" CodeBuddy/"+workBuddyCLIVersion)
	h.Set("Origin", "https://"+webHost)
	h.Set("Referer", "https://"+webHost+"/")
	if cred.UserID != "" {
		h.Set("X-User-Id", cred.UserID)
	} else {
		h.Del("X-User-Id")
	}
	if cred.EnterpriseID != "" {
		h.Set("X-Enterprise-Id", cred.EnterpriseID)
		h.Del("X-No-Enterprise-Id")
	} else {
		h.Set("X-No-Enterprise-Id", "1")
		h.Del("X-Enterprise-Id")
	}
}

func (t *workbuddyTransport) listModels(req *http.Request, cred services.WorkBuddyCredential, webHost, locale string) (*http.Response, error) {
	req.URL = &url.URL{Scheme: "https", Host: req.URL.Host, Path: "/v3/config"}
	req.Body = nil
	req.ContentLength = 0
	setWorkBuddyHeaders(req.Header, cred, webHost, locale, false)
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接 WorkBuddy 上游：%w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return jsonErrorMessage(resp.StatusCode, fmt.Sprintf(
			"WorkBuddy 登录已过期，请重新一键绑定（上游返回 HTTP %d）。若账号版本（国际/国内）与渠道域不匹配也会返回相同错误，请在绑定时选择正确的版本",
			resp.StatusCode)), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}
	raw, err := readBodyLimited(resp.Body, 4<<20)
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	ids, err := parseWorkBuddyModels(raw)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, id := range ids {
		items = append(items, map[string]any{"id": id, "object": "model", "owned_by": "workbuddy"})
	}
	return jsonResponse(http.StatusOK, map[string]any{"object": "list", "data": items}), nil
}

// parseWorkBuddyModels 从 /v3/config 的原始响应里提取可对话模型 ID。
//
// 过滤规则（图像 / 视频 / 补全档位）与 listModels 共用同一份实现：
// 一键授权后按票据拉清单时也必须过滤，否则会把不可用的档位写进渠道配置。
func parseWorkBuddyModels(raw []byte) ([]string, error) {
	var parsed struct {
		Data struct {
			Models []struct {
				ID   string   `json:"id"`
				Tags []string `json:"tags"`
			} `json:"models"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("WorkBuddy 模型列表不是合法 JSON")
	}
	out := []string{}
	for _, m := range parsed.Data.Models {
		id := strings.TrimSpace(m.ID)
		if id == "" || workBuddyExcludedModel.MatchString(id) {
			continue
		}
		skip := false
		for _, tag := range m.Tags {
			if strings.EqualFold(strings.TrimSpace(tag), "text-to-image") {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

// aggregateOpenAISSE 把 OpenAI 兼容的 SSE 流聚合成一个 chat.completion JSON。
func aggregateOpenAISSE(resp *http.Response, model string) (*http.Response, error) {
	defer resp.Body.Close()
	reader := bufio.NewReaderSize(io.LimitReader(resp.Body, workBuddyMaxBodyBytes), 64<<10)
	var content, reasoning strings.Builder
	toolIndex := map[int]int{}
	toolCalls := []map[string]any{}
	var usage map[string]any
	finish := ""
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
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
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
		for _, choice := range chunk.Choices {
			d := choice.Delta
			content.WriteString(d.Content)
			if d.ReasoningContent != "" {
				reasoning.WriteString(d.ReasoningContent)
			} else {
				reasoning.WriteString(d.Reasoning)
			}
			for _, tc := range d.ToolCalls {
				idx, known := toolIndex[tc.Index]
				if !known {
					idx = len(toolCalls)
					toolIndex[tc.Index] = idx
					toolCalls = append(toolCalls, map[string]any{"id": "", "type": "function", "function": map[string]any{"name": "", "arguments": ""}})
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
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取 WorkBuddy 响应流失败：%w", err)
	}
	if finish == "" {
		if len(toolCalls) > 0 {
			finish = "tool_calls"
		} else {
			finish = "stop"
		}
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
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
		"id":      "chatcmpl-" + randomHex(12),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
	}
	if usage != nil {
		out["usage"] = usage
	}
	return jsonResponse(http.StatusOK, out), nil
}
