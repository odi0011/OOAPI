package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

/*
Anthropic Messages 适配（/v1/messages）。

为什么必须做：Claude Code 只讲 Messages 协议，不做这一层它就连不上。
上游仍是 chat-completions，因此这里同样做双向翻译。

与其他两处协议的关键差别：
  - system 是**顶层字段**，不在 messages 数组里
  - 工具定义叫 tools[].input_schema，不是 function.parameters
  - 工具调用是 content 数组里的 tool_use 块，没有独立的 tool_calls 字段
  - 工具结果用 user 角色的 tool_result 块回传，不是 role=tool
*/

// anthropicRequest 是 Messages 请求体。
type anthropicRequest struct {
	Model         string          `json:"model"`
	MaxTokens     int             `json:"max_tokens"`
	Stream        bool            `json:"stream"`
	System        json.RawMessage `json:"system"`
	Messages      json.RawMessage `json:"messages"`
	Tools         json.RawMessage `json:"tools"`
	ToolChoice    json.RawMessage `json:"tool_choice"`
	Temperature   *float64        `json:"temperature"`
	TopP          *float64        `json:"top_p"`
	StopSequences []string        `json:"stop_sequences"`
	Metadata      json.RawMessage `json:"metadata"`
	Thinking      json.RawMessage `json:"thinking"`
}

// anthropicMessage 是 messages 数组里的一条。
type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// anthropicBlock 是 content 数组里的一块。
type anthropicBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
	// tool_use
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	// tool_result
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	// thinking
	Thinking string `json:"thinking"`
	// image：Claude Code 贴图时用的就是这一块。
	Source *anthropicImageSource `json:"source"`
}

// anthropicImageSource 是 image 块的来源（base64 或 url）。
type anthropicImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

// chatContentURL 把 Anthropic 的 image 块转成 chat 的 image_url 字符串。
//
// 只认 base64 与 url 两种来源；两种都不是时返回空串，
// 调用方据此跳过该块（而不是塞一个空 URL 让上游 400）。
func (s *anthropicImageSource) chatContentURL() string {
	if s == nil {
		return ""
	}
	if s.Type == "url" {
		return strings.TrimSpace(s.URL)
	}
	if s.Data == "" {
		return ""
	}
	mediaType := s.MediaType
	if mediaType == "" {
		mediaType = "image/png"
	}
	return "data:" + mediaType + ";base64," + s.Data
}

// anthropicTool 是 Messages 的工具定义。
type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// AnthropicMessages 处理 /v1/messages。
func AnthropicMessages(c *gin.Context) {
	start := time.Now()

	token, err := authenticateAPIKey(c)
	if err != nil {
		writeAnthropicError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 32<<20))
	if err != nil {
		writeAnthropicError(c, http.StatusBadRequest, "读取请求体失败", "invalid_request_error")
		return
	}

	var req anthropicRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeAnthropicError(c, http.StatusBadRequest, "请求体不是合法 JSON", "invalid_request_error")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeAnthropicError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}
	if rejectDecisionOnChat(c, req.Model, writeAnthropicError) {
		return
	}

	model, body, err := buildChatBodyFromAnthropic(&req)
	if err != nil {
		writeAnthropicError(c, http.StatusBadRequest, err.Error(), "invalid_request_error")
		return
	}

	group, okAccess := checkAccess(c, token, model, writeAnthropicError)
	if !okAccess {
		return
	}

	// 计费快照要区分「客户端请求的」与「别名映射后实际使用的」模型名：
	// model 是映射后的名字（checkAccess 与上游都用它），原始名只有 req.Model 有。
	// 只写进快照链路，不影响鉴权与转发。
	if req.Model != model {
		c.Set(ctxRequestedModelKey, req.Model)
	}

	if req.Stream {
		relayUpstream(c, token, group, model, body, start, &anthropicTranslator{model: model}, writeAnthropicError)
		return
	}

	call, okCall := callUpstream(c.Request.Context(), c, token, group, model, body, start, writeAnthropicError)
	if !okCall {
		return
	}

	out, err := anthropicFromChat(call.Body, model)
	if err != nil {
		writeAnthropicError(c, http.StatusBadGateway,
			"上游响应无法转换为 Messages 格式："+err.Error(), "upstream_error")
		return
	}
	c.Data(http.StatusOK, "application/json", out)
}

// buildChatBodyFromAnthropic 把 Messages 请求翻译成 chat-completions 请求。
//
// 返回实际要发给上游的模型名：Claude Code 发的模型名带它自己的版本串
// （如 claude-sonnet-4-5-20250929），本站的分组白名单里未必有，
// 因此可能需要在映射后使用。
func buildChatBodyFromAnthropic(req *anthropicRequest) (string, []byte, error) {
	model := normalizeAnthropicModel(req.Model)

	messages := []map[string]any{}

	if sys := flattenAnthropicSystem(req.System); sys != "" {
		messages = append(messages, map[string]any{"role": "system", "content": sys})
	}

	var items []anthropicMessage
	if len(bytes.TrimSpace(req.Messages)) > 0 {
		if err := json.Unmarshal(req.Messages, &items); err != nil {
			return "", nil, fmt.Errorf("messages 格式不正确")
		}
	}

	for _, item := range items {
		role := item.Role
		if role == "" {
			continue
		}

		// content 为字符串时直接作为文本
		trimmed := bytes.TrimSpace(item.Content)
		if len(trimmed) > 0 && trimmed[0] == '"' {
			var text string
			_ = json.Unmarshal(trimmed, &text)
			messages = append(messages, map[string]any{"role": role, "content": text})
			continue
		}

		var blocks []anthropicBlock
		if err := json.Unmarshal(item.Content, &blocks); err != nil {
			continue
		}

		/*
			Messages 的 content 数组里混着四五种块，需要拆成
			chat-completions 的两类结构：
			  - 文本块 → 当前消息的 content
			  - tool_use → assistant 消息的 tool_calls
			  - tool_result → 独立的 role=tool 消息

			注意 tool_result 在 Messages 里挂在 user 角色下，
			但 chat-completions 要求它是独立的 tool 角色消息，
			而且必须紧跟在带 tool_calls 的 assistant 消息之后。
		*/
		var (
			texts     []string
			toolCalls []map[string]any
			results   []map[string]any
			images    []map[string]any
		)

		for _, block := range blocks {
			switch block.Type {
			case "text", "":
				if block.Text != "" {
					texts = append(texts, block.Text)
				}
			case "tool_use":
				args := "{}"
				if len(block.Input) > 0 {
					args = string(block.Input)
				}
				toolCalls = append(toolCalls, map[string]any{
					"id":   block.ID,
					"type": "function",
					"function": map[string]any{
						"name":      block.Name,
						"arguments": args,
					},
				})
			case "tool_result":
				content, _ := flattenAnyContent(nil)
				if len(block.Content) > 0 {
					// tool_result 的 content 也可能是数组
					if inner, err := flattenContent(block.Content); err == nil {
						content = inner
					}
				}
				if block.IsError {
					content = "错误：" + content
				}
				results = append(results, map[string]any{
					"role":         "tool",
					"tool_call_id": block.ToolUseID,
					"content":      content,
				})
			case "thinking", "redacted_thinking":
				// 思考块不回传给上游：多数 chat-completions 上游
				// 不认识它，带上会直接 400。
				continue
			case "image":
				// 图片块要原样搬成 chat 的 image_url 分段。早先压成 "[图片]"
				// 文本 —— Claude Code 贴图后模型回「没看到图片」，视觉能力
				// 静默失效（与 Responses 的 image 丢失是同一个坑）。
				if url := block.Source.chatContentURL(); url != "" {
					images = append(images, map[string]any{
						"type":      "image_url",
						"image_url": map[string]any{"url": url},
					})
				}
			}
		}

		if role == "assistant" {
			msg := map[string]any{"role": "assistant"}
			content := strings.Join(texts, "\n")
			if content == "" {
				msg["content"] = nil
			} else {
				msg["content"] = content
			}
			if len(toolCalls) > 0 {
				msg["tool_calls"] = toolCalls
			}
			messages = append(messages, msg)
		} else {
			// user 角色：先放文本，再放工具结果（顺序不能反，
			// 否则上游会认为 tool 消息没有配对的前置 assistant 消息）。
			// 有图片时 content 用分段数组承载（文本 + image_url）。
			content := strings.Join(texts, "\n")
			switch {
			case len(images) > 0:
				blocks := make([]map[string]any, 0, len(images)+1)
				if strings.TrimSpace(content) != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": content})
				}
				blocks = append(blocks, images...)
				messages = append(messages, map[string]any{"role": "user", "content": blocks})
			case content != "":
				messages = append(messages, map[string]any{"role": "user", "content": content})
			}
			for _, r := range results {
				messages = append(messages, r)
			}
		}
	}

	if len(messages) == 0 {
		return "", nil, fmt.Errorf("messages 为空，没有可发送的内容")
	}

	payload := map[string]any{
		"model":    model,
		"messages": messages,
	}
	if req.Stream {
		payload["stream"] = true
	}
	if req.MaxTokens > 0 {
		payload["max_tokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if len(req.StopSequences) > 0 {
		payload["stop"] = req.StopSequences
	}
	if tools := convertAnthropicTools(req.Tools); len(tools) > 0 {
		payload["tools"] = tools
		if choice := convertAnthropicToolChoice(req.ToolChoice); choice != nil {
			payload["tool_choice"] = choice
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", nil, err
	}
	return model, body, nil
}

// anthropicModelAliases 把 Claude Code 常用的模型名映射到本站配置的模型名。
//
// Claude Code 会发 claude-sonnet-4-5-20250929 这类带日期的完整名，
// 而网关的分组白名单是管理员按上游实际可用的名字配的（如 claude-sonnet-5）。
// 不做映射的话，用户必须去改 Claude Code 的配置，体验很差。
var anthropicModelAliases = map[string]string{
	"claude-sonnet-4-5":          "claude-haiku-5-5",
	"claude-sonnet-4-5-20250929": "claude-haiku-5-5",
	"claude-3-5-haiku":           "claude-haiku-5-5",
	"claude-haiku-4-5":           "claude-haiku-5-5",
	"claude-opus-4-5":            "claude-haiku-5-5",
}

// normalizeAnthropicModel 归一化模型名。
//
// 只做「别名表命中」这一种处理，不做模糊匹配 ——
// 猜错模型会把请求发给错误的模型，账单与结果都对不上，
// 比直接报「模型不允许调用」严重得多。
func normalizeAnthropicModel(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	if mapped, ok := anthropicModelAliases[lower]; ok {
		return mapped
	}
	return name
}

// flattenAnthropicSystem 把 system 字段（字符串或数组）压成文本。
func flattenAnthropicSystem(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		_ = json.Unmarshal(trimmed, &text)
		return text
	}
	text, err := flattenContent(trimmed)
	if err != nil {
		return ""
	}
	return text
}

// convertAnthropicTools 把 input_schema 转成 parameters。
func convertAnthropicTools(raw json.RawMessage) []chatTool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}

	var items []anthropicTool
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil
	}

	out := []chatTool{}
	for _, t := range items {
		if strings.TrimSpace(t.Name) == "" {
			continue
		}
		var tool chatTool
		tool.Type = "function"
		tool.Function.Name = t.Name
		tool.Function.Description = t.Description
		if len(t.InputSchema) > 0 {
			tool.Function.Parameters = t.InputSchema
		} else {
			tool.Function.Parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, tool)
	}
	return out
}

// convertAnthropicToolChoice 转换工具选择。
func convertAnthropicToolChoice(raw json.RawMessage) any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}

	var obj struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil
	}

	switch obj.Type {
	case "auto":
		return "auto"
	case "any":
		// Anthropic 的 any = 必须调用某个工具，对应 OpenAI 的 required
		return "required"
	case "none":
		return "none"
	case "tool":
		if obj.Name != "" {
			return map[string]any{
				"type":     "function",
				"function": map[string]any{"name": obj.Name},
			}
		}
	}
	return nil
}

// anthropicFromChat 把 chat-completions 响应转成 Messages 格式。
func anthropicFromChat(raw []byte, model string) ([]byte, error) {
	var resp chatCompletionResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("上游没有返回任何候选结果")
	}

	choice := resp.Choices[0]
	content := []map[string]any{}

	if text, _ := flattenAnyContent(choice.Message.Content); strings.TrimSpace(text) != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}

	for _, tc := range choice.Message.ToolCalls {
		// input 是对象，上游给的是 JSON 字符串
		var input any = map[string]any{}
		if trimmed := strings.TrimSpace(tc.Function.Arguments); trimmed != "" {
			if err := json.Unmarshal([]byte(trimmed), &input); err != nil {
				// 参数不是合法 JSON 时原样包一层：
				// 直接丢弃会让 Claude Code 收到一个没有参数的工具调用。
				input = map[string]any{"_raw": trimmed}
			}
		}
		content = append(content, map[string]any{
			"type":  "tool_use",
			"id":    firstNonEmpty(tc.ID, "toolu_"+randomHex(12)),
			"name":  tc.Function.Name,
			"input": input,
		})
	}

	if len(content) == 0 {
		content = append(content, map[string]any{"type": "text", "text": ""})
	}

	stopReason := mapFinishReasonToAnthropic(choice.FinishReason)

	usage := map[string]any{"input_tokens": 0, "output_tokens": 0}
	if resp.Usage != nil {
		usage = map[string]any{
			"input_tokens":  resp.Usage.PromptTokens,
			"output_tokens": resp.Usage.CompletionTokens,
		}
	}

	/*
		回显**客户端请求的**模型名（与 /v1/responses 同一取舍）：
		上游的名字可能与请求的不同，而部分客户端会校验两者一致。
		上游真实用的名字在日志的 upstream_model 字段里。
	*/
	modelName := model
	if modelName == "" {
		modelName = resp.Model
	}

	out := map[string]any{
		"id":            "msg_" + randomHex(16),
		"type":          "message",
		"role":          "assistant",
		"model":         modelName,
		"content":       content,
		"stop_reason":   stopReason,
		"stop_sequence": nil,
		"usage":         usage,
	}
	return json.Marshal(out)
}

// mapFinishReasonToAnthropic 转换结束原因。
func mapFinishReasonToAnthropic(reason string) string {
	switch reason {
	case "tool_calls", "function_call":
		return "tool_use"
	case "length":
		return "max_tokens"
	case "stop":
		return "end_turn"
	case "":
		return "end_turn"
	default:
		return "end_turn"
	}
}

// ---------- 流式翻译（Anthropic 事件流） ----------

// anthropicTranslator 把 chat-completions 的流翻译成 Messages 事件流。
// 当前开着的块是文本还是工具。文本块与工具块交替出现时靠它判断要不要另起一块。
const (
	blockKindText = "text"
	blockKindTool = "tool"
)

type anthropicTranslator struct {
	model string

	started    bool
	blockOpen  bool
	blockKind  string
	blockIndex int
	// 工具调用块的 index → 是否已开块
	toolOpen map[int]bool
	// 上游最后一次给的 finish_reason，用于收尾时决定 stop_reason。
	finish  string
	stopped bool
}

func (t *anthropicTranslator) Start(model string) [][]byte {
	if model == "" {
		model = t.model
	}
	t.started = true
	t.toolOpen = map[int]bool{}
	return [][]byte{
		sseEvent("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_" + randomHex(16), "type": "message", "role": "assistant",
				"model": model, "content": []any{},
				"stop_reason": nil, "stop_sequence": nil,
				"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
			},
		}),
	}
}

func (t *anthropicTranslator) Translate(line []byte) [][]byte {
	if t.toolOpen == nil {
		t.toolOpen = map[int]bool{}
	}

	payload := sseData(line)
	if payload == nil {
		if len(bytes.TrimSpace(line)) == 0 {
			return [][]byte{line}
		}
		return nil
	}

	var chunk struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Delta        struct {
				Content   any `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil
	}
	if len(chunk.Choices) == 0 {
		return nil
	}

	out := [][]byte{}
	delta := chunk.Choices[0].Delta

	if fr := chunk.Choices[0].FinishReason; fr != "" {
		t.finish = fr
	}

	/*
		开一个新块。Anthropic 要求每块有独立且递增的 index，且上一块必须先
		content_block_stop。以前只在「文本块收尾」时自增，于是连续两个工具调用
		会共用同一个 index（甲方 SDK 把第二个工具的参数并进第一个），
		工具块之后再来文本块又会把 index 重置回 0。

		现在把「开块」收口成一个动作：先关掉还开着的那块，再占用下一个序号。
		blockIndex 初始为 0，只在关块后自增，所以第一块永远是 0。
	*/
	openBlock := func(kind string, start map[string]any) {
		if t.blockOpen {
			out = append(out, sseEvent("content_block_stop", map[string]any{
				"type": "content_block_stop", "index": t.blockIndex,
			}))
			t.blockIndex++
		}
		t.blockOpen = true
		t.blockKind = kind
		out = append(out, sseEvent("content_block_start", map[string]any{
			"type": "content_block_start", "index": t.blockIndex,
			"content_block": start,
		}))
	}

	// 文本块。已经开着工具块时不能直接往它上面贴文本 —— 得另起一块。
	if text, _ := flattenAnyContent(delta.Content); text != "" {
		if !t.blockOpen || t.blockKind != blockKindText {
			openBlock(blockKindText, map[string]any{"type": "text", "text": ""})
		}
		out = append(out, sseEvent("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": t.blockIndex,
			"delta": map[string]any{"type": "text_delta", "text": text},
		}))
	}

	// 工具调用块。同一个 OpenAI index 的后续分片复用已开的块，不重开。
	for _, tc := range delta.ToolCalls {
		if !t.toolOpen[tc.Index] {
			t.toolOpen[tc.Index] = true
			openBlock(blockKindTool, map[string]any{
				"type": "tool_use", "id": firstNonEmpty(tc.ID, "toolu_"+randomHex(12)),
				"name": tc.Function.Name, "input": map[string]any{},
			})
		}
		if tc.Function.Arguments != "" {
			out = append(out, sseEvent("content_block_delta", map[string]any{
				"type": "content_block_delta", "index": t.blockIndex,
				"delta": map[string]any{
					"type": "input_json_delta", "partial_json": tc.Function.Arguments,
				},
			}))
		}
	}

	return out
}

func (t *anthropicTranslator) Finish(usage upstreamUsage) [][]byte {
	out := [][]byte{}

	// 收尾只关「当前开着的那一块」。以前再按 toolOpen 逐项关一遍，
	// 那几个 content_block_stop 用的都是同一个 blockIndex，等于重复关同一块。
	if t.blockOpen {
		out = append(out, sseEvent("content_block_stop", map[string]any{
			"type": "content_block_stop", "index": t.blockIndex,
		}))
		t.blockOpen = false
	}

	/*
		收尾原因如实上报。

		以前只按「有没有工具调用」二选一，上游因 max_tokens 截断（finish_reason
		"length"）也会被报成 end_turn —— 客户端把半截回答当成说完了。
		非流式那边 mapFinishReasonToAnthropic 一直是对的，这里补齐。
	*/
	stopReason := "end_turn"
	switch {
	case t.finish == "length":
		stopReason = "max_tokens"
	case len(t.toolOpen) > 0:
		stopReason = "tool_use"
	}

	// input_tokens 在 message_start 里只能填 0（那时上游还没告诉我们），
	// 到收尾时才知道，按 Anthropic 现行约定补在最后一条 message_delta 的 usage 上。
	out = append(out, sseEvent("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
		"usage": map[string]any{
			"input_tokens":  usage.PromptTokens,
			"output_tokens": usage.CompletionTokens,
		},
	}))
	out = append(out, sseEvent("message_stop", map[string]any{"type": "message_stop"}))
	t.stopped = true

	return out
}

// Terminate Anthropic 的收尾事件是 message_stop，不需要 chat 的 [DONE]。
func (t *anthropicTranslator) Terminate([]byte) [][]byte { return nil }

/*
FinishError 发 Anthropic 协议的流式错误事件：`event: error`。

不能发 message_stop —— 那是「这条消息正常说完」的信号，
Claude Code 会把它当成完整答复（内容就是等待期间那句提示语），
用户以为模型就答了这么一句，而请求其实从未被处理。

Anthropic 的流式错误形状是 {"type":"error","error":{"type":...,"message":...}}，
客户端读到会抛错并保留会话，用户可以重试。
*/
func (t *anthropicTranslator) FinishError(message string) [][]byte {
	return [][]byte{sseEvent("error", map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "api_error",
			"message": message,
		},
	})}
}
