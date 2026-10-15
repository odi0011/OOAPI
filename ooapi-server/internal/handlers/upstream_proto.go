package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"ooapi/internal/services"
)

/*
上游协议适配。

背景：很多聚合型上游（OpenCode Go 就是典型）**同一个 base_url 下，
不同模型走不同协议**：

	https://opencode.ai/zen/go/v1/chat/completions   GLM / Kimi / DeepSeek / MiMo
	https://opencode.ai/zen/go/v1/messages            Claude / Qwen / MiniMax
	https://opencode.ai/zen/go/v1/responses           Grok / GPT Luna
	https://opencode.ai/zen/v1/systemone              Jev（System One 决策）

只管 /chat/completions 的话，一半的模型会直接返回
ModelProtocolUnsupported —— 实测就是这样发现的。

本站内部统一用 chat-completions 作为「通用语」（下游三种协议都已归一到它），
因此这里只需要再做一层「通用语 → 上游协议」的翻译。

路径的判定完全由账号配置决定（model_paths 字段），不做自动探测：
探测意味着每个新模型第一次调用都要失败一次再重试，
而用户看到的就是「偶尔报一次错」，很难解释。
*/

// upstreamPathForModel 决定某个模型该打到上游的哪个路径。
//
// 返回路径后缀，如 "/chat/completions"。
func upstreamPathForModel(ch *services.UpstreamChannel, model string) string {
	path := "/chat/completions"
	if ch != nil {
		for _, rule := range ch.ModelPaths {
			if matchModelPattern(rule.Pattern, model) {
				path = rule.Path
				break
			}
		}
	}
	// 决策模型的默认对话规则（chat: *）不能把它送去补全接口。
	// 管理员若显式写了 systemone 或一条自定义路径，上面的规则已经生效。
	if services.ModelKind(model) == "decision" {
		switch path {
		case "/chat/completions", "/messages", "/responses":
			return "/systemone"
		}
	}
	return path
}

// upstreamProtocol 判断某个路径属于哪种协议。
// 用于选择鉴权方式与响应解析方式。
func upstreamProtocol(path string) string {
	switch {
	case strings.HasSuffix(path, "/messages"):
		return "anthropic"
	case strings.HasSuffix(path, "/responses"):
		return "responses"
	case strings.HasSuffix(path, "/systemone"):
		return "systemone"
	default:
		return "openai"
	}
}

// matchModelPattern 支持精确匹配与末尾通配（claude-*）。
func matchModelPattern(pattern, model string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	model = strings.ToLower(strings.TrimSpace(model))
	if pattern == "" {
		return false
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(model, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == model
}

// buildUpstreamBody 把内部通用请求体（chat-completions）翻成上游协议需要的形状。
func buildUpstreamBody(protocol string, chatBody []byte, model string) ([]byte, error) {
	switch protocol {
	case "anthropic":
		return chatToAnthropicBody(chatBody, model)
	case "responses":
		return chatToResponsesBody(chatBody, model)
	case "systemone":
		// 决策请求已经是上游要的形状（state + questions）。
		// 只改模型名，不能补 chat 的推理字段，否则上游会拒。
		return rewriteBodyModel(chatBody, model), nil
	default:
		// chat 协议：先把请求体里的 model 换成上游认的名字，再补推理字段。
		//
		// 这一步曾经漏掉（线上事故）：客户端按官方名调用（deepseek-flash），
		// 账号里存的是上游叫法（deepseek-v4.1-flash），而 chat 分支原样透传请求体 ——
		// 于是上游收到它不认识的名字，回 11102「model not found」。
		// 协议转换分支（anthropic / responses）本来就带 model 参数、会重写，
		// 只有最常用的 chat 分支漏了，而它恰恰是绝大多数上游走的路。
		return applyChatReasoning(rewriteBodyModel(chatBody, model), model), nil
	}
}

/*
rewriteBodyModel 把请求体里的 model 字段替换成目标名字。

只改这一个字段，其余字节通过 map 往返保留（未知字段不丢）。
解析失败就原样返回：改不动模型名时让上游报它自己的错，
比在这里伪造一个请求体更安全。
*/
func rewriteBodyModel(body []byte, model string) []byte {
	trimmed := strings.TrimSpace(model)
	if trimmed == "" || len(body) == 0 {
		return body
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	if current, _ := payload["model"].(string); current == trimmed {
		return body
	}
	payload["model"] = trimmed
	converted, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return converted
}

/*
applyChatReasoning 给 OpenAI 兼容的 chat 请求体补上推理字段。

为什么不能直接透传客户端的 reasoning_effort：不同上游对同一个档位的
参数名与取值都不一样（DeepSeek 用 thinking.type、Gemini 用 thinkingConfig、
GLM 用 thinking_budget）。透传的后果是「参数被静默忽略」，
用户以为开了深度思考，实际按默认档跑 —— 账单和效果都对不上。

模型没配映射时**原样返回**：让上游用它自己的默认档，
而不是我们猜一个可能不存在的参数塞进去。
*/
func applyChatReasoning(chatBody []byte, model string) []byte {
	selection := services.SelectReasoning(model, reasoningHintFromChatBody(chatBody))
	if selection.Parameter == "" {
		return chatBody
	}
	extra := services.ReasoningBody(selection, "chat")
	if len(extra) == 0 {
		// 该参数在 chat 协议下没有对应字段（比如 Anthropic 专属的 thinking），
		// 不下发 —— 塞进去只会被上游当未知字段拒掉。
		return chatBody
	}
	var payload map[string]any
	if json.Unmarshal(chatBody, &payload) != nil {
		return chatBody
	}
	for key, value := range extra {
		payload[key] = value
	}
	merged, err := json.Marshal(payload)
	if err != nil {
		return chatBody
	}
	return merged
}

// applyUpstreamAuth 按协议设置鉴权头。
//
// Anthropic 协议用 x-api-key，OpenAI 系用 Bearer —— 用错的话
// 上游只回一句「Missing API key」，排查起来要绕很远。
func applyUpstreamAuth(req *http.Request, protocol, apiKey string) {
	switch protocol {
	case "anthropic":
		req.Header.Set("x-api-key", apiKey)
		// Anthropic 要求显式版本头，缺了会 400
		if req.Header.Get("anthropic-version") == "" {
			req.Header.Set("anthropic-version", "2023-06-01")
		}
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

// ---------- 图片搬运 ----------
//
// 三个协议对图片的表达完全不同（chat 是 image_url，Anthropic 是 image 块，
// Responses 是 input_image）。协议转换时**必须逐块搬运**：早先的版本把
// content 数组压平取文本，图片就此静默消失 —— 客户端贴了图，模型回
// 「没看到图片」，而日志一切正常，排查时无从下手（与「No response」那次同源）。
//
// 这里的两个助手只负责「从 chat 的 content 里取出图片 URL」与
// 「把 URL 转成 Anthropic 的 image 块」，其余交给各家协议。

// imageURLsOf 从 chat content（字符串或分段数组）里取出全部图片 URL。
func imageURLsOf(content any) []string {
	parts, ok := content.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	for _, part := range parts {
		m, ok := part.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := m["type"].(string)
		if kind != "image_url" && kind != "input_image" {
			continue
		}
		switch v := m["image_url"].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				out = append(out, v)
			}
		case map[string]any:
			if url, _ := v["url"].(string); strings.TrimSpace(url) != "" {
				out = append(out, url)
			}
		}
	}
	return out
}

// anthropicImageBlock 把图片 URL 转成 Anthropic 的 image 块。
//
// Anthropic 只认两种来源：base64 与 url。data: URI 要拆成 media_type + data，
// 普通的 https URL 直接透传 —— 拆不开的（既不是 data: 也不是 http(s)）
// 明确返回 false，让调用方跳过，而不是伪造一个空 data 让上游 400。
func anthropicImageBlock(rawURL string) (map[string]any, bool) {
	url := strings.TrimSpace(rawURL)
	if url == "" {
		return nil, false
	}
	if strings.HasPrefix(url, "data:") {
		header, data, found := strings.Cut(strings.TrimPrefix(url, "data:"), ",")
		if !found || data == "" {
			return nil, false
		}
		mediaType := "image/png"
		isBase64 := false
		for _, segment := range strings.Split(header, ";") {
			segment = strings.TrimSpace(segment)
			switch {
			case segment == "base64":
				isBase64 = true
			case segment != "":
				mediaType = segment
			}
		}
		if !isBase64 {
			return nil, false
		}
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": mediaType,
				"data":       data,
			},
		}, true
	}
	if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
		return map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "url", "url": url},
		}, true
	}
	return nil, false
}

// ---------- 通用语 → Anthropic Messages ----------

// chatToAnthropicBody 把 chat-completions 请求翻成 Messages 请求。
func chatToAnthropicBody(chatBody []byte, model string) ([]byte, error) {
	var req struct {
		Model       string            `json:"model"`
		Messages    []json.RawMessage `json:"messages"`
		Tools       []chatTool        `json:"tools"`
		ToolChoice  any               `json:"tool_choice"`
		Temperature *float64          `json:"temperature"`
		TopP        *float64          `json:"top_p"`
		MaxTokens   *int              `json:"max_tokens"`
		Stream      bool              `json:"stream"`
		Stop        json.RawMessage   `json:"stop"`
	}
	if err := json.Unmarshal(chatBody, &req); err != nil {
		return nil, err
	}

	type chatMsg struct {
		Role      string `json:"role"`
		Content   any    `json:"content"`
		ToolCalls []struct {
			ID       string `json:"id"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
		ToolCallID string `json:"tool_call_id"`
	}

	systemParts := []string{}
	messages := []map[string]any{}
	// 累积待合并的工具结果：Anthropic 要求 role=user 的 tool_result
	// 必须与文本分开成块，因此先攒起来，遇到非 tool 消息时再落盘。
	var pendingResults []map[string]any

	flushResults := func() {
		if len(pendingResults) == 0 {
			return
		}
		blocks := make([]map[string]any, 0, len(pendingResults))
		blocks = append(blocks, pendingResults...)
		messages = append(messages, map[string]any{"role": "user", "content": blocks})
		pendingResults = nil
	}

	for _, rawMsg := range req.Messages {
		var msg chatMsg
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			continue
		}

		switch msg.Role {
		case "system":
			if text, _ := flattenAnyContent(msg.Content); text != "" {
				systemParts = append(systemParts, text)
			}

		case "tool":
			content := ""
			if text, _ := flattenAnyContent(msg.Content); text != "" {
				content = text
			}
			pendingResults = append(pendingResults, map[string]any{
				"type":        "tool_result",
				"tool_use_id": msg.ToolCallID,
				"content":     content,
			})

		case "assistant":
			flushResults()
			blocks := []map[string]any{}
			if text, _ := flattenAnyContent(msg.Content); text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
			}
			for _, tc := range msg.ToolCalls {
				var input any = map[string]any{}
				if trimmed := strings.TrimSpace(tc.Function.Arguments); trimmed != "" {
					if err := json.Unmarshal([]byte(trimmed), &input); err != nil {
						input = map[string]any{"_raw": trimmed}
					}
				}
				blocks = append(blocks, map[string]any{
					"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input,
				})
			}
			if len(blocks) == 0 {
				continue
			}
			messages = append(messages, map[string]any{"role": "assistant", "content": blocks})

		default: // user
			flushResults()
			text, _ := flattenAnyContent(msg.Content)
			images := imageURLsOf(msg.Content)
			if strings.TrimSpace(text) == "" && len(images) == 0 {
				continue
			}
			if len(images) == 0 {
				messages = append(messages, map[string]any{"role": "user", "content": text})
				continue
			}
			// 含图片：Anthropic 要求图片是 content 数组里的 image 块。
			// 压成文本等于把视觉能力静默关掉（用户贴了图，模型说「没看到图」）。
			blocks := make([]map[string]any, 0, len(images)+1)
			if strings.TrimSpace(text) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
			}
			for _, url := range images {
				if block, ok := anthropicImageBlock(url); ok {
					blocks = append(blocks, block)
				}
			}
			if len(blocks) == 0 {
				continue
			}
			messages = append(messages, map[string]any{"role": "user", "content": blocks})
		}
	}
	flushResults()

	maxTokens := 4096
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		maxTokens = *req.MaxTokens
	}

	payload := map[string]any{
		"model":      model,
		"max_tokens": maxTokens,
		"messages":   messages,
	}
	if len(systemParts) > 0 {
		payload["system"] = strings.Join(systemParts, "\n\n")
	}
	if req.Stream {
		payload["stream"] = true
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.Type != "function" || t.Function.Name == "" {
				continue
			}
			tools = append(tools, map[string]any{
				"name":         t.Function.Name,
				"description":  t.Function.Description,
				"input_schema": t.Function.Parameters,
			})
		}
		if len(tools) > 0 {
			payload["tools"] = tools
			if choice := chatToolChoiceToAnthropic(req.ToolChoice); choice != nil {
				payload["tool_choice"] = choice
			}
		}
	}
	if len(req.Stop) > 0 && !bytes.Equal(bytes.TrimSpace(req.Stop), []byte("null")) {
		var stops []string
		if err := json.Unmarshal(req.Stop, &stops); err == nil && len(stops) > 0 {
			payload["stop_sequences"] = stops
		}
	}

	// 推理强度按模型配置下发。Anthropic 只认 thinking / output_config 两种形状，
	// 其余映射一律不下发 —— 透传未知字段会被上游拒掉。
	if selection := services.SelectReasoning(model, reasoningHintFromChatBody(chatBody)); selection.Parameter != "" {
		for key, value := range services.ReasoningBody(selection, "anthropic") {
			payload[key] = value
		}
	}

	return json.Marshal(payload)
}

/*
reasoningHintFromChatBody 从发往上游的 chat body 里读出客户端表达的推理强度。

客户端的三种协议外壳里，推理强度可能出现在 reasoning_effort（OpenAI 风格）
或 thinking 对象里。这里只做「读」——真正下发什么由模型配置决定，
客户端说了不算（否则用户能拿 deepseek 的价去要 opus 的思考预算）。
*/
func reasoningHintFromChatBody(chatBody []byte) string {
	var probe struct {
		ReasoningEffort string `json:"reasoning_effort"`
		Reasoning       *struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		Thinking *struct {
			Type string `json:"type"`
		} `json:"thinking"`
	}
	if json.Unmarshal(chatBody, &probe) != nil {
		return ""
	}
	if probe.ReasoningEffort != "" {
		return probe.ReasoningEffort
	}
	if probe.Reasoning != nil && probe.Reasoning.Effort != "" {
		return probe.Reasoning.Effort
	}
	if probe.Thinking != nil && probe.Thinking.Type != "" {
		switch probe.Thinking.Type {
		case "enabled", "adaptive":
			return "high"
		case "disabled":
			return "none"
		}
	}
	return ""
}

// chatToolChoiceToAnthropic 转换工具选择。
func chatToolChoiceToAnthropic(choice any) any {
	switch v := choice.(type) {
	case string:
		switch v {
		case "auto":
			return map[string]any{"type": "auto"}
		case "required", "any":
			return map[string]any{"type": "any"}
		case "none":
			return nil
		}
	case map[string]any:
		if fn, ok := v["function"].(map[string]any); ok {
			if name, ok := fn["name"].(string); ok && name != "" {
				return map[string]any{"type": "tool", "name": name}
			}
		}
	}
	return nil
}

// anthropicToChatResponse 把 Messages 响应翻回 chat-completions 格式。
func anthropicToChatResponse(raw []byte, model string) ([]byte, error) {
	var resp struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Content []struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			ID    string `json:"id"`
			Name  string `json:"name"`
			Input any    `json:"input"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}

	var (
		texts     []string
		toolCalls []map[string]any
	)
	for _, block := range resp.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				texts = append(texts, block.Text)
			}
		case "tool_use":
			args := "{}"
			if block.Input != nil {
				if b, err := json.Marshal(block.Input); err == nil {
					args = string(b)
				}
			}
			call := map[string]any{
				"id":   block.ID,
				"type": "function",
				"function": map[string]any{
					"name":      block.Name,
					"arguments": args,
				},
			}
			toolCalls = append(toolCalls, call)
		}
	}

	content := strings.Join(texts, "\n")
	finish := "stop"
	switch resp.StopReason {
	case "tool_use":
		finish = "tool_calls"
	case "max_tokens":
		finish = "length"
	}

	message := map[string]any{"role": "assistant"}
	if content == "" && len(toolCalls) > 0 {
		message["content"] = nil
	} else {
		message["content"] = content
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}

	modelName := resp.Model
	if modelName == "" {
		modelName = model
	}

	out := map[string]any{
		"id":      firstNonEmpty(resp.ID, "chatcmpl-"+randomHex(12)),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   modelName,
		"choices": []map[string]any{{
			"index":         0,
			"message":       message,
			"finish_reason": finish,
		}},
		"usage": map[string]any{
			"prompt_tokens":     resp.Usage.InputTokens,
			"completion_tokens": resp.Usage.OutputTokens,
			"total_tokens":      resp.Usage.InputTokens + resp.Usage.OutputTokens,
		},
	}
	return json.Marshal(out)
}

// ---------- 上游 Messages 事件流 → 通用语 ----------

/*
anthropicStreamToChat 把上游的 Messages 事件流转回 chat-completions 分块。

它是个有状态的小状态机：Anthropic 的事件带有 index 与块类型，
需要跟踪「当前块是文本还是工具调用」，才能生成正确的 delta。
如果状态丢了，工具调用会被当成正文吐出去 —— 客户端会收到一段 JSON 当回答。
*/
type anthropicStreamToChat struct {
	id      string
	model   string
	created int64
	started bool

	// 块类型：text 或 tool_use
	blockKind map[int]string
	// 工具调用的 index → 客户端侧的 tool_call index
	toolIndex map[int]int
	toolSeq   int

	inputTokens  int
	outputTokens int
	finishReason string
}

func newAnthropicStreamToChat(model string) *anthropicStreamToChat {
	return &anthropicStreamToChat{
		id:        "chatcmpl-" + randomHex(12),
		model:     model,
		created:   nowUnix(),
		blockKind: map[int]string{},
		toolIndex: map[int]int{},
	}
}

// Convert 处理一行上游 SSE。返回要转发给下游的字节（可能为空）。
func (s *anthropicStreamToChat) Convert(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return nil
	}

	// 只认 data: 行；event: 行由 data 里的 type 字段重复表达，可忽略
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}

	var env struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message *struct {
			ID    string `json:"id"`
			Model string `json:"model"`
			Usage struct {
				InputTokens int `json:"input_tokens"`
			} `json:"usage"`
		} `json:"message"`
		ContentBlock *struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"content_block"`
		Delta *struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			PartialJSON string `json:"partial_json"`
			StopReason  string `json:"stop_reason"`
		} `json:"delta"`
		Usage *struct {
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil
	}

	switch env.Type {
	case "message_start":
		if env.Message != nil {
			if env.Message.ID != "" {
				s.id = env.Message.ID
			}
			if env.Message.Model != "" {
				s.model = env.Message.Model
			}
			s.inputTokens = env.Message.Usage.InputTokens
		}
		s.started = true
		// 先发一个只带 role 的块，让客户端知道流开始了
		return chatChunk(s.id, s.model, s.created, map[string]any{"role": "assistant", "content": ""}, nil, nil)

	case "content_block_start":
		if env.ContentBlock != nil {
			s.blockKind[env.Index] = env.ContentBlock.Type
			if env.ContentBlock.Type == "tool_use" {
				clientIdx := s.toolSeq
				s.toolIndex[env.Index] = clientIdx
				s.toolSeq++
				return chatChunk(s.id, s.model, s.created, map[string]any{
					"tool_calls": []map[string]any{{
						"index": clientIdx,
						"id":    env.ContentBlock.ID,
						"type":  "function",
						"function": map[string]any{
							"name": env.ContentBlock.Name, "arguments": "",
						},
					}},
				}, nil, nil)
			}
		}
		return nil

	case "content_block_delta":
		if env.Delta == nil {
			return nil
		}
		switch env.Delta.Type {
		case "text_delta":
			if env.Delta.Text == "" {
				return nil
			}
			return chatChunk(s.id, s.model, s.created, map[string]any{"content": env.Delta.Text}, nil, nil)
		case "input_json_delta":
			if env.Delta.PartialJSON == "" {
				return nil
			}
			clientIdx := s.toolIndex[env.Index]
			return chatChunk(s.id, s.model, s.created, map[string]any{
				"tool_calls": []map[string]any{{
					"index":    clientIdx,
					"function": map[string]any{"arguments": env.Delta.PartialJSON},
				}},
			}, nil, nil)
		case "thinking_delta":
			// 思考过程不外发：下游三种协议的思考字段各不相同，
			// 硬塞进去会让不认识它的客户端解析失败。
			return nil
		}
		return nil

	case "message_delta":
		if env.Delta != nil && env.Delta.StopReason != "" {
			s.finishReason = env.Delta.StopReason
		}
		if env.Usage != nil {
			s.outputTokens = env.Usage.OutputTokens
		}
		return nil

	case "message_stop":
		finish := "stop"
		switch s.finishReason {
		case "tool_use":
			finish = "tool_calls"
		case "max_tokens":
			finish = "length"
		}
		// usage 放在最后一块（与 OpenAI 的行为一致）
		return chatChunk(s.id, s.model, s.created, map[string]any{}, &finish, map[string]any{
			"prompt_tokens":     s.inputTokens,
			"completion_tokens": s.outputTokens,
			"total_tokens":      s.inputTokens + s.outputTokens,
		})
	}

	return nil
}

// Done 输出流结束标记。
func (s *anthropicStreamToChat) Done() []byte {
	return []byte("data: [DONE]\n\n")
}

// Usage 返回已统计的用量，供计费使用。
func (s *anthropicStreamToChat) Usage() upstreamUsage {
	return upstreamUsage{
		PromptTokens:     s.inputTokens,
		CompletionTokens: s.outputTokens,
		TotalTokens:      s.inputTokens + s.outputTokens,
	}
}

// chatChunk 拼一个 chat-completions 的流式分块。
func chatChunk(id, model string, created int64, delta map[string]any, finish *string, usage map[string]any) []byte {
	chunk := map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"delta":         delta,
			"finish_reason": nil,
		}},
	}
	if finish != nil {
		chunk["choices"].([]map[string]any)[0]["finish_reason"] = *finish
	}
	if usage != nil {
		chunk["usage"] = usage
	}
	body, err := json.Marshal(chunk)
	if err != nil {
		return nil
	}
	return append(append([]byte("data: "), body...), []byte("\n\n")...)
}

// ---------- 通用语 → OpenAI Responses（上游） ----------

// chatToResponsesBody 把 chat-completions 请求翻成 Responses 请求。
//
// 目前用于 Grok / GPT Luna 这类只走 /responses 的上游模型。
func chatToResponsesBody(chatBody []byte, model string) ([]byte, error) {
	var req struct {
		Messages    []json.RawMessage `json:"messages"`
		Tools       []chatTool        `json:"tools"`
		ToolChoice  any               `json:"tool_choice"`
		Temperature *float64          `json:"temperature"`
		TopP        *float64          `json:"top_p"`
		MaxTokens   *int              `json:"max_tokens"`
		Stream      bool              `json:"stream"`
	}
	if err := json.Unmarshal(chatBody, &req); err != nil {
		return nil, err
	}

	type chatMsg struct {
		Role    string `json:"role"`
		Content any    `json:"content"`
	}

	instructions := []string{}
	input := []map[string]any{}

	for _, rawMsg := range req.Messages {
		var msg struct {
			Role      string `json:"role"`
			Content   any    `json:"content"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
			ToolCallID string `json:"tool_call_id"`
		}
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			continue
		}

		switch msg.Role {
		case "system":
			if text, _ := flattenAnyContent(msg.Content); text != "" {
				instructions = append(instructions, text)
			}
		case "tool":
			text, _ := flattenAnyContent(msg.Content)
			input = append(input, map[string]any{
				"type": "function_call_output", "call_id": msg.ToolCallID, "output": text,
			})
		case "assistant":
			if text, _ := flattenAnyContent(msg.Content); strings.TrimSpace(text) != "" {
				input = append(input, map[string]any{
					"type": "message", "role": "assistant",
					"content": []map[string]any{{"type": "output_text", "text": text}},
				})
			}
			for _, tc := range msg.ToolCalls {
				input = append(input, map[string]any{
					"type": "function_call", "call_id": tc.ID,
					"name": tc.Function.Name, "arguments": tc.Function.Arguments,
				})
			}
		default:
			text, _ := flattenAnyContent(msg.Content)
			images := imageURLsOf(msg.Content)
			if strings.TrimSpace(text) == "" && len(images) == 0 {
				continue
			}
			// Responses 的图片是 input_image，且 image_url 是**字符串**
			// （不像 chat 是嵌套对象）。压平会丢图，见 imageURLsOf 的说明。
			blocks := []map[string]any{}
			if strings.TrimSpace(text) != "" {
				blocks = append(blocks, map[string]any{"type": "input_text", "text": text})
			}
			for _, url := range images {
				blocks = append(blocks, map[string]any{"type": "input_image", "image_url": url})
			}
			if len(blocks) == 0 {
				continue
			}
			input = append(input, map[string]any{
				"type": "message", "role": "user",
				"content": blocks,
			})
		}
	}

	payload := map[string]any{
		"model": model,
		"input": input,
	}
	if len(instructions) > 0 {
		payload["instructions"] = strings.Join(instructions, "\n\n")
	}
	if req.Stream {
		payload["stream"] = true
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		payload["max_output_tokens"] = *req.MaxTokens
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.Type != "function" || t.Function.Name == "" {
				continue
			}
			tools = append(tools, map[string]any{
				"type": "function", "name": t.Function.Name,
				"description": t.Function.Description,
				"parameters":  t.Function.Parameters,
			})
		}
		if len(tools) > 0 {
			payload["tools"] = tools
		}
	}

	// 推理强度按模型配置下发（客户端在 chat body 里用 reasoning_effort 表达）。
	// 该模型没配映射时不下发任何字段 —— 让上游用默认档，而不是猜测。
	if selection := services.SelectReasoning(model, reasoningHintFromChatBody(chatBody)); selection.Parameter != "" {
		for key, value := range services.ReasoningBody(selection, "responses") {
			payload[key] = value
		}
	}

	return json.Marshal(payload)
}

// responsesToChatResponse 把 Responses 响应翻回 chat-completions。
func responsesToChatResponse(raw []byte, model string) ([]byte, error) {
	var resp struct {
		ID     string `json:"id"`
		Model  string `json:"model"`
		Status string `json:"status"`
		Output []struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"output"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}

	var (
		texts     []string
		toolCalls []map[string]any
	)
	for _, item := range resp.Output {
		switch item.Type {
		case "message":
			for _, c := range item.Content {
				if c.Type == "output_text" && c.Text != "" {
					texts = append(texts, c.Text)
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{
				"id":   firstNonEmpty(item.CallID, "call_"+randomHex(10)),
				"type": "function",
				"function": map[string]any{
					"name": item.Name, "arguments": item.Arguments,
				},
			})
		}
	}

	content := strings.Join(texts, "\n")
	finish := "stop"
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	}

	message := map[string]any{"role": "assistant"}
	if content == "" && len(toolCalls) > 0 {
		message["content"] = nil
	} else {
		message["content"] = content
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}

	modelName := resp.Model
	if modelName == "" {
		modelName = model
	}

	out := map[string]any{
		"id":      firstNonEmpty(resp.ID, "chatcmpl-"+randomHex(12)),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   modelName,
		"choices": []map[string]any{{
			"index": 0, "message": message, "finish_reason": finish,
		}},
		"usage": map[string]any{
			"prompt_tokens":     resp.Usage.InputTokens,
			"completion_tokens": resp.Usage.OutputTokens,
			"total_tokens":      resp.Usage.InputTokens + resp.Usage.OutputTokens,
		},
	}
	return json.Marshal(out)
}

// ---------- 上游 Responses 事件流 → 通用语 ----------

// responsesStreamToChat 把上游 Responses 事件流转回 chat-completions 分块。
type responsesStreamToChat struct {
	id      string
	model   string
	created int64

	toolIndex map[int]int
	toolSeq   int

	inputTokens  int
	outputTokens int
}

func newResponsesStreamToChat(model string) *responsesStreamToChat {
	return &responsesStreamToChat{
		id:        "chatcmpl-" + randomHex(12),
		model:     model,
		created:   nowUnix(),
		toolIndex: map[int]int{},
	}
}

func (s *responsesStreamToChat) Convert(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}

	var env struct {
		Type        string `json:"type"`
		Delta       string `json:"delta"`
		Arguments   string `json:"arguments"`
		OutputIndex int    `json:"output_index"`
		Response    *struct {
			ID    string `json:"id"`
			Model string `json:"model"`
			Usage struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		} `json:"response"`
		Item *struct {
			Type   string `json:"type"`
			CallID string `json:"call_id"`
			Name   string `json:"name"`
		} `json:"item"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil
	}

	switch env.Type {
	case "response.created", "response.in_progress":
		if env.Response != nil {
			if env.Response.ID != "" {
				s.id = env.Response.ID
			}
			if env.Response.Model != "" {
				s.model = env.Response.Model
			}
		}
		return chatChunk(s.id, s.model, s.created, map[string]any{"role": "assistant", "content": ""}, nil, nil)

	case "response.output_item.added":
		if env.Item != nil && env.Item.Type == "function_call" {
			clientIdx := s.toolSeq
			s.toolIndex[env.OutputIndex] = clientIdx
			s.toolSeq++
			return chatChunk(s.id, s.model, s.created, map[string]any{
				"tool_calls": []map[string]any{{
					"index": clientIdx,
					"id":    env.Item.CallID,
					"type":  "function",
					"function": map[string]any{
						"name": env.Item.Name, "arguments": "",
					},
				}},
			}, nil, nil)
		}
		return nil

	case "response.output_text.delta":
		if env.Delta == "" {
			return nil
		}
		return chatChunk(s.id, s.model, s.created, map[string]any{"content": env.Delta}, nil, nil)

	case "response.function_call_arguments.delta":
		if env.Arguments == "" {
			return nil
		}
		return chatChunk(s.id, s.model, s.created, map[string]any{
			"tool_calls": []map[string]any{{
				"index":    s.toolIndex[env.OutputIndex],
				"function": map[string]any{"arguments": env.Arguments},
			}},
		}, nil, nil)

	case "response.completed":
		if env.Response != nil {
			s.inputTokens = env.Response.Usage.InputTokens
			s.outputTokens = env.Response.Usage.OutputTokens
		}
		finish := "stop"
		if s.toolSeq > 0 {
			finish = "tool_calls"
		}
		return chatChunk(s.id, s.model, s.created, map[string]any{}, &finish, map[string]any{
			"prompt_tokens":     s.inputTokens,
			"completion_tokens": s.outputTokens,
			"total_tokens":      s.inputTokens + s.outputTokens,
		})
	}
	return nil
}

func (s *responsesStreamToChat) Done() []byte {
	return []byte("data: [DONE]\n\n")
}

func (s *responsesStreamToChat) Usage() upstreamUsage {
	return upstreamUsage{
		PromptTokens:     s.inputTokens,
		CompletionTokens: s.outputTokens,
		TotalTokens:      s.inputTokens + s.outputTokens,
	}
}

// upstreamStreamConverter 是上游流转换器的统一接口。
type upstreamStreamConverter interface {
	Convert(line []byte) []byte
	Done() []byte
	Usage() upstreamUsage
}

func newUpstreamStreamConverter(protocol, model string) upstreamStreamConverter {
	switch protocol {
	case "anthropic":
		return newAnthropicStreamToChat(model)
	case "responses":
		return newResponsesStreamToChat(model)
	default:
		return nil
	}
}

func nowUnix() int64 {
	return time.Now().Unix()
}
