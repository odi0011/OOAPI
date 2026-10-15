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
OpenAI Responses API 适配（/v1/responses）。

为什么必须做：Codex CLI 从 0.145 起**只**支持 Responses 协议，
`wire_api = "chat"` 被直接移除。也就是说，不做这一层，
Codex 这类工具根本连不上本站网关。

上游仍然是 chat-completions，因此这里做双向翻译：
  - 请求：instructions / input / tools → messages / tools
  - 响应：choices → output 数组（message + function_call）
  - 流式：choices[].delta → response.output_text.delta 等事件
*/

// responsesRequest 是 Responses API 的请求体（只声明用得到的字段）。
type responsesRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
	// Instructions 相当于 system 提示，Codex 用它塞入全部系统约束。
	Instructions string          `json:"instructions"`
	Input        json.RawMessage `json:"input"`
	Tools        json.RawMessage `json:"tools"`
	ToolChoice   json.RawMessage `json:"tool_choice"`
	Temperature  *float64        `json:"temperature"`
	TopP         *float64        `json:"top_p"`
	MaxTokens    *int            `json:"max_output_tokens"`
	// 以下字段 Codex 会发，但 chat-completions 没有对应项，
	// 声明出来只是为了不把它们透传给上游（上游不认识会报错）。
	Reasoning      *json.RawMessage `json:"reasoning"`
	Store          *bool            `json:"store"`
	Include        json.RawMessage  `json:"include"`
	Metadata       json.RawMessage  `json:"metadata"`
	PromptCacheKey *string          `json:"prompt_cache_key"`
	Text           json.RawMessage  `json:"text"`
	// 并行工具调用：chat-completions 用 parallel_tool_calls，语义一致。
	ParallelToolCalls  *bool           `json:"parallel_tool_calls"`
	PreviousResponseID *string         `json:"previous_response_id"`
	Truncation         json.RawMessage `json:"truncation"`
	ServiceTier        *string         `json:"service_tier"`
}

// responsesInputItem 是 input 数组里的一项。
// Responses 把「消息」「工具调用」「工具结果」放在同一个数组里，
// 靠 type 区分 —— 与 chat-completions 的扁平 messages 不同。
type responsesInputItem struct {
	Type string `json:"type"`
	Role string `json:"role"`
	// content 既可以是字符串也可以是数组，用 RawMessage 接住再判。
	Content json.RawMessage `json:"content"`
	// 工具调用相关
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments string          `json:"arguments"`
	Output    json.RawMessage `json:"output"`
	// 上下文中可能带回的 reasoning 项，忽略即可
	ID      string          `json:"id"`
	Status  string          `json:"status"`
	Summary json.RawMessage `json:"summary"`
}

// responsesContentPart 是 content 数组里的一项。
type responsesContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
	// Claude/GPT 的图片输入在 Responses 里是 input_image
	ImageURL string `json:"image_url"`
}

// chatTool 是 chat-completions 的工具定义。
type chatTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

// Responses 处理 /v1/responses。
func Responses(c *gin.Context) {
	start := time.Now()

	token, err := authenticateAPIKey(c)
	if err != nil {
		writeOpenAIError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 32<<20))
	if err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "读取请求体失败", "invalid_request_error")
		return
	}

	var req responsesRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "请求体不是合法 JSON", "invalid_request_error")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeOpenAIError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}
	if rejectDecisionOnChat(c, req.Model, writeOpenAIError) {
		return
	}
	if req.PreviousResponseID != nil && strings.TrimSpace(*req.PreviousResponseID) != "" {
		// 我们没有实现服务端会话存储（store: true 的续聊）。
		// 明确报错而不是静默忽略 —— 静默忽略会让模型丢掉全部上下文，
		// 用户看到的是「AI 突然失忆」，比直接报错更难排查。
		writeOpenAIError(c, http.StatusBadRequest,
			"本站不支持 previous_response_id 续聊，请在每次请求里带上完整 input。Codex 的默认配置已满足这一点。",
			"unsupported_parameter")
		return
	}

	body, compaction, err := buildChatBodyFromResponsesDetailed(&req)
	if err != nil {
		writeOpenAIError(c, http.StatusBadRequest, err.Error(), "invalid_request_error")
		return
	}

	group, okAccess := checkAccess(c, token, req.Model, writeOpenAIError)
	if !okAccess {
		return
	}

	if req.Stream {
		relayUpstream(c, token, group, req.Model, body, start,
			&responsesTranslator{model: req.Model, compaction: compaction}, writeOpenAIError)
		return
	}

	call, okCall := callUpstream(c.Request.Context(), c, token, group, req.Model, body, start, writeOpenAIError)
	if !okCall {
		return
	}

	/*
		压缩请求要用 compact 的响应形状。

		sub2api 的探测判定是「2xx 且响应里有 compaction 项」——
		普通 Responses 响应里没有这种项，探测会判「本站不支持远程压缩」，
		Codex 的上下文压缩就用不了。
	*/
	if compaction {
		out, err := responsesCompactFromChat(call.Body, req.Model)
		if err == nil {
			c.Data(http.StatusOK, "application/json", out)
			return
		}
		// 转换失败时退回普通形状：至少让调用方拿到内容，
		// 而不是因为一个格式问题整条请求失败。
	}

	out, err := responsesFromChat(call.Body, req.Model)
	if err != nil {
		writeOpenAIError(c, http.StatusBadGateway,
			"上游响应无法转换为 Responses 格式："+err.Error(), "upstream_error")
		return
	}
	c.Data(http.StatusOK, "application/json", out)
}

// buildChatBodyFromResponses 把 Responses 请求翻译成 chat-completions 请求。
func buildChatBodyFromResponses(req *responsesRequest) ([]byte, error) {
	body, _, err := buildChatBodyFromResponsesDetailed(req)
	return body, err
}

// buildChatBodyFromResponsesDetailed 与上面同，但额外回报
// 「这是一次压缩请求」——Compact 端点需要据此决定响应形状。
func buildChatBodyFromResponsesDetailed(req *responsesRequest) ([]byte, bool, error) {
	messages := []map[string]any{}

	// instructions 就是 system 提示
	if strings.TrimSpace(req.Instructions) != "" {
		messages = append(messages, map[string]any{
			"role": "system", "content": req.Instructions,
		})
	}

	items, err := parseResponsesInput(req.Input)
	if err != nil {
		return nil, false, err
	}

	/*
		Responses 的 input 是一个「事件流」式的数组：
		消息、函数调用、函数结果平铺在一起。chat-completions 则要求
		assistant 的 tool_calls 与随后的 role=tool 消息严格配对。

		因此这里需要把连续的 function_call 归并到上一条 assistant 消息上，
		再把 function_call_output 转成 role=tool。归并错了，
		上游会报「tool_calls must be followed by tool messages」。
	*/
	var pendingToolCalls []map[string]any
	// compactionRequested 标记这次请求是压缩请求。
	// 响应方向据此决定要不要产出 compaction 项（探测的判定依据）。
	compactionRequested := false

	flushPending := func() {
		if len(pendingToolCalls) == 0 {
			return
		}
		messages = append(messages, map[string]any{
			"role":       "assistant",
			"content":    nil,
			"tool_calls": pendingToolCalls,
		})
		pendingToolCalls = nil
	}

	for _, item := range items {
		switch item.Type {
		case "function_call":
			pendingToolCalls = append(pendingToolCalls, map[string]any{
				"id":   firstNonEmpty(item.CallID, item.ID),
				"type": "function",
				"function": map[string]any{
					"name":      item.Name,
					"arguments": item.Arguments,
				},
			})

		case "function_call_output":
			flushPending()
			content, err := flattenContent(item.Output)
			if err != nil {
				return nil, false, err
			}
			messages = append(messages, map[string]any{
				"role":         "tool",
				"tool_call_id": item.CallID,
				"content":      content,
			})

		case "message", "":
			// role 为 assistant 且带 tool_calls 的历史项也会走到这里，
			// 但 Codex 通常用 function_call 表达，因此这里只处理文本消息。
			flushPending()
			if item.Role == "" {
				continue
			}
			content, err := contentForChat(item.Content)
			if err != nil {
				return nil, false, err
			}
			// 空判定要看「文本是否为空」，不能对整个 content 做 TrimSpace ——
			// 含图片时它是数组，直接判空会把纯图片消息整条丢掉。
			if asText, okText := content.(string); okText && strings.TrimSpace(asText) == "" && item.Role != "assistant" {
				continue
			}
			messages = append(messages, map[string]any{
				"role": item.Role, "content": content,
			})

		case "reasoning":
			// 推理摘要：不让它进上下文。带上会让上游把它当历史正文，
			// 既浪费 token 又可能让模型误以为之前已经想过。
			continue

		case "compaction_trigger":
			/*
				Codex 的「远程上下文压缩」触发标记。

				sub2api 用「在 input 末尾放一个 compaction_trigger」
				来探测上游是否支持 remote_compaction_v2。
				它不是消息，本身不该进上下文；但**必须显式处理**：
				如果掉进 default 被静默忽略，这次请求就退化成一次普通对话，
				响应里不会出现压缩项，探测永远判「不支持」。

				这里把它转成一条明确的指令，让模型产出一段「上下文摘要」，
				再在响应的 output 里以 compaction 项返回（见 responsesCompactFromChat）。
			*/
			messages = append(messages, map[string]any{
				"role": "user",
				"content": "请把上述对话上下文压缩成一段简明摘要，保留关键事实、" +
					"已确定的决策与待办事项，供后续继续对话使用。只输出摘要内容。",
			})
			compactionRequested = true
			continue

		default:
			// 未知类型忽略而不是报错：OpenAI 会不断新增 item 类型，
			// 因为一个不认识的新类型就让整个请求失败，兼容性会很快崩掉。
			continue
		}
	}
	flushPending()

	if len(messages) == 0 {
		return nil, false, fmt.Errorf("input 为空，没有可发送的消息")
	}

	payload := map[string]any{
		"model":    req.Model,
		"messages": messages,
	}
	if req.Stream {
		payload["stream"] = true
	}
	if tools, err := convertResponsesTools(req.Tools); err != nil {
		return nil, false, err
	} else if len(tools) > 0 {
		payload["tools"] = tools
		// Responses 的 tool_choice 形状与 chat-completions 基本一致，
		// 但可能带 "type":"function" 包装，需要摊平。
		if choice := convertToolChoice(req.ToolChoice); choice != nil {
			payload["tool_choice"] = choice
		}
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		payload["top_p"] = *req.TopP
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		payload["max_tokens"] = *req.MaxTokens
	}
	if req.ParallelToolCalls != nil {
		payload["parallel_tool_calls"] = *req.ParallelToolCalls
	}

	out, err := json.Marshal(payload)
	if err != nil {
		return nil, false, err
	}
	return out, compactionRequested, nil
}

// parseResponsesInput 把 input 解析成条目数组。
// input 既可能是字符串（简写），也可能是数组。
func parseResponsesInput(raw json.RawMessage) ([]responsesInputItem, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}

	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return nil, fmt.Errorf("input 格式不正确")
		}
		return []responsesInputItem{{Type: "message", Role: "user", Content: mustJSON(text)}}, nil
	}

	var items []responsesInputItem
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, fmt.Errorf("input 格式不正确：需要字符串或数组")
	}
	return items, nil
}

/*
contentForChat 把 Responses 的 content 转成 chat-completions 的 content 值。

返回 any：

	· 纯文本 → **字符串**（压平成功率最高，多数上游对分段数组的兼容程度不一）；
	· 含图片 → **分段数组** [{type:"text"},{type:"image_url",image_url:{url}}]。

为什么含图片时必须保留结构：图片是模型唯一能「看见」的载体。
早先把图片压成 "[图片]" 文本占位，视觉能力就此静默失效 ——
客户端以为发了图，模型只收到三个字（线上实测：Codex 桌面端贴图后，
模型回复「图片无法解析/一片空白」）。对话正文压平是可以接受的取舍，
**把图片丢掉不是**。
*/
func contentForChat(raw json.RawMessage) (any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return "", fmt.Errorf("content 解析失败")
		}
		return text, nil
	}

	var parts []responsesContentPart
	if err := json.Unmarshal(trimmed, &parts); err != nil {
		// 不是数组就当字符串处理（有些客户端会塞数字等异类）
		return string(trimmed), nil
	}

	hasImage := false
	for _, part := range parts {
		if isImagePart(part) && strings.TrimSpace(part.ImageURL) != "" {
			hasImage = true
			break
		}
	}
	if !hasImage {
		return flattenContent(raw)
	}

	// 含图片：保留分段结构。用 []any 而不是 []map，保证序列化后顺序与内容一致。
	out := []any{}
	for _, part := range parts {
		if isImagePart(part) {
			url := strings.TrimSpace(part.ImageURL)
			if url == "" {
				continue
			}
			out = append(out, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": url},
			})
			continue
		}
		text := part.Text
		if strings.TrimSpace(text) == "" {
			continue
		}
		out = append(out, map[string]any{"type": "text", "text": text})
	}
	if len(out) == 0 {
		// 只有图片没有文字时也要有内容，否则上游会因空 content 报错。
		out = append(out, map[string]any{"type": "text", "text": "请描述这张图片。"})
	}
	return out, nil
}

// isImagePart 判断一个 content 分段是否是图片（Responses 用 input_image，
// chat 兼容层有时直接给 image_url）。
func isImagePart(part responsesContentPart) bool {
	return part.Type == "input_image" || part.Type == "image_url"
}

// flattenContent 把 Responses 的 content（字符串或分段数组）压成纯文本。
//
// chat-completions 也支持分段数组，但不同上游对分段的兼容程度不一，
// 压平成功率最高；纯文本对编程类对话已经足够。
func flattenContent(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}

	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return "", fmt.Errorf("content 解析失败")
		}
		return text, nil
	}

	var parts []responsesContentPart
	if err := json.Unmarshal(trimmed, &parts); err != nil {
		// 不是数组就当字符串处理（有些客户端会塞数字等异类）
		return string(trimmed), nil
	}

	var sb strings.Builder
	for _, part := range parts {
		switch part.Type {
		case "input_text", "output_text", "text", "summary_text", "":
			sb.WriteString(part.Text)
		case "input_image", "image_url":
			// 图片转成文本占位：上游未必支持图片，
			// 但至少要让模型知道「这里原本有一张图」，而不是凭空丢失。
			if part.ImageURL != "" {
				sb.WriteString("[图片]")
			}
		default:
			sb.WriteString(part.Text)
		}
	}
	return sb.String(), nil
}

// convertResponsesTools 把 Responses 的工具定义转成 chat-completions 形状。
//
// 两者的差别只有一层包装：Responses 是扁平的
// {type, name, description, parameters}，chat-completions 要
// {type, function:{name, description, parameters}}。
func convertResponsesTools(raw json.RawMessage) ([]chatTool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}

	var items []map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, fmt.Errorf("tools 格式不正确")
	}

	out := []chatTool{}
	for _, item := range items {
		var kind string
		if v, ok := item["type"]; ok {
			_ = json.Unmarshal(v, &kind)
		}
		// 只转发 function 类型。web_search / file_search 这类内置工具
		// 依赖 OpenAI 的服务端执行，我们的上游没有，传过去只会报错。
		if kind != "function" {
			continue
		}

		var tool chatTool
		tool.Type = "function"
		if v, ok := item["name"]; ok {
			_ = json.Unmarshal(v, &tool.Function.Name)
		}
		if v, ok := item["description"]; ok {
			_ = json.Unmarshal(v, &tool.Function.Description)
		}
		if v, ok := item["parameters"]; ok {
			tool.Function.Parameters = v
		}
		// 有些客户端已经把工具包成 function 形式，兼容一下
		if v, ok := item["function"]; ok {
			var fn struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				Parameters  json.RawMessage `json:"parameters"`
			}
			if err := json.Unmarshal(v, &fn); err == nil {
				if fn.Name != "" {
					tool.Function.Name = fn.Name
				}
				if fn.Description != "" {
					tool.Function.Description = fn.Description
				}
				if len(fn.Parameters) > 0 {
					tool.Function.Parameters = fn.Parameters
				}
			}
		}

		if tool.Function.Name == "" {
			continue
		}
		if len(tool.Function.Parameters) == 0 {
			// 缺参数定义时给个空 schema：上游对 null 的处理不一致，
			// 给 {} 比给 null 更稳。
			tool.Function.Parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, tool)
	}
	return out, nil
}

// convertToolChoice 摊平 tool_choice。
func convertToolChoice(raw json.RawMessage) any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}

	// 字符串形式："auto" / "none" / "required"
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err == nil {
			return s
		}
		return nil
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil
	}
	var kind string
	if v, ok := obj["type"]; ok {
		_ = json.Unmarshal(v, &kind)
	}
	switch kind {
	case "function":
		name := ""
		if v, ok := obj["name"]; ok {
			_ = json.Unmarshal(v, &name)
		}
		if name == "" {
			if v, ok := obj["function"]; ok {
				var fn struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(v, &fn)
				name = fn.Name
			}
		}
		if name != "" {
			return map[string]any{
				"type":     "function",
				"function": map[string]any{"name": name},
			}
		}
	case "allowed_tools":
		// Codex 在受限模式下会发这个，降级成 auto 让它继续工作
		return "auto"
	}
	return "auto"
}

// ---------- 响应方向的翻译 ----------

// chatCompletionResponse 是上游返回的 chat-completions 响应（只取需要的部分）。
type chatCompletionResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int    `json:"index"`
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Role      string `json:"role"`
			Content   any    `json:"content"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// responsesFromChat 把 chat-completions 响应转成 Responses 格式。
func responsesFromChat(raw []byte, model string) ([]byte, error) {
	var resp chatCompletionResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("上游没有返回任何候选结果")
	}

	choice := resp.Choices[0]
	output := []map[string]any{}

	// 正文
	text, _ := flattenAnyContent(choice.Message.Content)
	if strings.TrimSpace(text) != "" {
		output = append(output, map[string]any{
			"type":   "message",
			"id":     "msg_" + randomHex(12),
			"status": "completed",
			"role":   "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": text, "annotations": []any{}},
			},
		})
	}

	// 工具调用
	for _, tc := range choice.Message.ToolCalls {
		output = append(output, map[string]any{
			"type":      "function_call",
			"id":        "fc_" + randomHex(12),
			"call_id":   tc.ID,
			"name":      tc.Function.Name,
			"arguments": tc.Function.Arguments,
			"status":    "completed",
		})
	}

	usage := map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
	if resp.Usage != nil {
		usage = map[string]any{
			"input_tokens":  resp.Usage.PromptTokens,
			"output_tokens": resp.Usage.CompletionTokens,
			"total_tokens":  resp.Usage.TotalTokens,
		}
	}

	/*
		回显**客户端请求的**模型名，而不是上游返回的那个。

		原因：同一个模型在不同上游叫法不同（deepseek-v4.1-flash-sg），
		而客户端只认自己请求的名字 —— 部分 SDK/Agent 会校验返回的 model
		与请求的是否一致，不一致就报错。上游真实用的名字记在日志的
		upstream_model 字段里，排查时有据可查。
	*/
	modelName := model
	if modelName == "" {
		modelName = resp.Model
	}

	out := map[string]any{
		"id":         "resp_" + randomHex(16),
		"object":     "response",
		"created_at": time.Now().Unix(),
		"status":     "completed",
		"model":      modelName,
		"output":     output,
		"usage":      usage,
		// Codex 会读这几个字段；给空值比缺字段更让它安心
		"parallel_tool_calls": true,
		"tool_choice":         "auto",
		"tools":               []any{},
	}
	return json.Marshal(out)
}

// flattenAnyContent 处理 content 既可能是字符串也可能是数组的情况。
func flattenAnyContent(v any) (string, error) {
	switch val := v.(type) {
	case nil:
		return "", nil
	case string:
		return val, nil
	case []any:
		var sb strings.Builder
		for _, part := range val {
			if m, ok := part.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					sb.WriteString(t)
				}
			}
		}
		return sb.String(), nil
	default:
		b, err := json.Marshal(val)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
}

// ---------- 流式翻译 ----------

// responsesTranslator 把 chat-completions 的流翻译成 Responses 的事件流。
type responsesTranslator struct {
	model string
	// compaction 表示这是一次压缩请求：
	// 收尾时要把正文包成 compaction 项，探测方据此判定支持。
	compaction bool

	sentCreated bool
	textStarted bool
	textDone    bool
	outputIndex int
	textItemID  string
	// textBuf 累积完整正文。
	//
	// response.output_text.done 与 response.completed 都必须带上**完整文本**：
	// 客户端拿它作为最终结果（Codex 就靠这几个事件组装回答）。
	// 只发增量、done 里给空串，客户端会认为模型什么都没说。
	textBuf strings.Builder
	// 工具调用按 index 跟踪：一个流里可能先后出现多个工具调用，
	// 各自需要独立的 item 与 output_index。
	toolItems map[int]*responsesToolItem
	toolOrder []int
	finish    string
}

// args 累积某个工具调用的参数。
func (i *responsesToolItem) appendArgs(fragment string) {
	if fragment == "" {
		return
	}
	if i.args.Len() > 0 {
		i.args.WriteString(fragment)
		return
	}
	i.args.WriteString(fragment)
}

type responsesToolItem struct {
	itemID      string
	callID      string
	name        string
	outputIndex int
	argsSent    bool
	// args 累积完整参数 JSON：done 事件与 response.completed 需要它，
	// 缺了它客户端会认为这个工具调用没有参数。
	args strings.Builder
}

func (t *responsesTranslator) ensureInit() {
	if t.toolItems == nil {
		t.toolItems = map[int]*responsesToolItem{}
	}
}

func (t *responsesTranslator) Start(model string) [][]byte {
	t.ensureInit()
	if model == "" {
		model = t.model
	}
	t.sentCreated = true
	base := map[string]any{
		"id":         "resp_" + randomHex(16),
		"object":     "response",
		"created_at": time.Now().Unix(),
		"status":     "in_progress",
		"model":      model,
		"output":     []any{},
	}
	return [][]byte{sseEvent("response.created", map[string]any{
		"type": "response.created", "response": base,
	})}
}

func (t *responsesTranslator) Translate(line []byte) [][]byte {
	t.ensureInit()

	payload := sseData(line)
	if payload == nil {
		// 非 data 行（例如注释、心跳）原样放过：
		// 某些上游用注释行保活，丢掉会让长思考的请求被中间设备掐断。
		if len(bytes.TrimSpace(line)) == 0 {
			return [][]byte{line}
		}
		return nil
	}

	var chunk struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Delta        struct {
				Content   any    `json:"content"`
				Reasoning string `json:"reasoning_content"`
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
		// 结尾那条只带 usage 的包，交给 Finish 统一处理
		return nil
	}

	delta := chunk.Choices[0].Delta
	if chunk.Choices[0].FinishReason != "" {
		t.finish = chunk.Choices[0].FinishReason
	}

	out := [][]byte{}

	// 正文增量
	if text, _ := flattenAnyContent(delta.Content); text != "" {
		if !t.textStarted {
			t.textStarted = true
			t.textItemID = "msg_" + randomHex(12)
			out = append(out, sseEvent("response.output_item.added", map[string]any{
				"type":         "response.output_item.added",
				"output_index": t.outputIndex,
				"item": map[string]any{
					"type": "message", "id": t.textItemID, "status": "in_progress",
					"role": "assistant", "content": []any{},
				},
			}))
			out = append(out, sseEvent("response.content_part.added", map[string]any{
				"type":          "response.content_part.added",
				"item_id":       t.textItemID,
				"output_index":  t.outputIndex,
				"content_index": 0,
				"part":          map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
			}))
		}
		t.textBuf.WriteString(text)
		out = append(out, sseEvent("response.output_text.delta", map[string]any{
			"type":          "response.output_text.delta",
			"item_id":       t.textItemID,
			"output_index":  t.outputIndex,
			"content_index": 0,
			"delta":         text,
		}))
	}

	// 工具调用增量
	for _, tc := range delta.ToolCalls {
		item, seen := t.toolItems[tc.Index]
		if !seen {
			// 正文与工具调用不会同时出现，但真出现了也要各自占一个 output_index
			if t.textStarted && !t.textDone {
				t.textDone = true
				t.outputIndex++
			}
			item = &responsesToolItem{
				itemID:      "fc_" + randomHex(12),
				callID:      tc.ID,
				outputIndex: t.outputIndex,
			}
			t.toolItems[tc.Index] = item
			t.toolOrder = append(t.toolOrder, tc.Index)
			t.outputIndex++
		}
		if tc.ID != "" {
			item.callID = tc.ID
		}
		if tc.Function.Name != "" {
			item.name = tc.Function.Name
			out = append(out, sseEvent("response.output_item.added", map[string]any{
				"type":         "response.output_item.added",
				"output_index": item.outputIndex,
				"item": map[string]any{
					"type": "function_call", "id": item.itemID, "call_id": item.callID,
					"name": item.name, "arguments": "", "status": "in_progress",
				},
			}))
		}
		if tc.Function.Arguments != "" {
			item.args.WriteString(tc.Function.Arguments)
			out = append(out, sseEvent("response.function_call_arguments.delta", map[string]any{
				"type":         "response.function_call_arguments.delta",
				"item_id":      item.itemID,
				"output_index": item.outputIndex,
				"delta":        tc.Function.Arguments,
			}))
		}
	}

	return out
}

func (t *responsesTranslator) Finish(usage upstreamUsage) [][]byte {
	t.ensureInit()

	out := [][]byte{}

	if t.textStarted && !t.textDone {
		t.textDone = true
		fullText := t.textBuf.String()
		out = append(out, sseEvent("response.output_text.done", map[string]any{
			"type": "response.output_text.done", "item_id": t.textItemID,
			"output_index": 0, "content_index": 0, "text": fullText,
		}))
		out = append(out, sseEvent("response.content_part.done", map[string]any{
			"type": "response.content_part.done", "item_id": t.textItemID,
			"output_index": 0, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": fullText, "annotations": []any{}},
		}))
		out = append(out, sseEvent("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": 0,
			"item": map[string]any{
				"type": "message", "id": t.textItemID, "status": "completed",
				"role":    "assistant",
				"content": []map[string]any{{"type": "output_text", "text": fullText, "annotations": []any{}}},
			},
		}))
	}

	for _, idx := range t.toolOrder {
		item := t.toolItems[idx]
		args := item.args.String()
		out = append(out, sseEvent("response.function_call_arguments.done", map[string]any{
			"type": "response.function_call_arguments.done", "item_id": item.itemID,
			"output_index": item.outputIndex, "arguments": args,
		}))
		out = append(out, sseEvent("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": item.outputIndex,
			"item": map[string]any{
				"type": "function_call", "id": item.itemID, "call_id": item.callID,
				"name": item.name, "arguments": args, "status": "completed",
			},
		}))
	}

	// response.completed 要带完整的 output 数组。
	// 客户端据此得到「本次调用最终产出了什么」，缺了它 Codex 会显示空回答 ——
	// 这正是本次实测踩到的问题。
	finalOutput := []map[string]any{}
	if t.textStarted && t.textBuf.Len() > 0 {
		finalOutput = append(finalOutput, map[string]any{
			"type": "message", "id": t.textItemID, "status": "completed", "role": "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": t.textBuf.String(), "annotations": []any{}},
			},
		})
	}
	// 压缩请求额外产出 compaction 项。
	// 放一个空内容的项是必要的：sub2api 只认「有没有这个项」，
	// 没有它就判 unsupported（等价 Codex 的 "got 0 items" fatal）。
	if t.compaction {
		finalOutput = append(finalOutput, map[string]any{
			"type": "compaction",
			"id":   "comp_" + randomHex(12),
			"compacted_content": []map[string]any{
				{"type": "output_text", "text": t.textBuf.String()},
			},
			"status": "completed",
		})
	}
	for _, idx := range t.toolOrder {
		item := t.toolItems[idx]
		finalOutput = append(finalOutput, map[string]any{
			"type": "function_call", "id": item.itemID, "call_id": item.callID,
			"name": item.name, "arguments": item.args.String(), "status": "completed",
		})
	}

	/*
		上游因 max_tokens 截断（finish_reason "length"）时如实报 incomplete。

		以前无论 finish_reason 是什么都写 completed —— Codex 会把半截回答
		当成完整的一轮，用户看不出内容被截断了。t.finish 一直在收，只是没人读。
	*/
	resp := map[string]any{
		"id":         "resp_" + randomHex(16),
		"object":     "response",
		"created_at": time.Now().Unix(),
		"status":     "completed",
		"model":      t.model,
		"output":     finalOutput,
		"usage": map[string]any{
			"input_tokens":  usage.PromptTokens,
			"output_tokens": usage.CompletionTokens,
			"total_tokens":  usage.PromptTokens + usage.CompletionTokens,
		},
	}
	if t.finish == "length" {
		resp["status"] = "incomplete"
		resp["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	}
	out = append(out, sseEvent("response.completed", map[string]any{
		"type":     "response.completed",
		"response": resp,
	}))

	return out
}

// Terminate Responses 的收尾事件是 response.completed / response.failed，
// 不需要 chat 的 [DONE]。
func (t *responsesTranslator) Terminate([]byte) [][]byte { return nil }

/*
FinishError 发 Responses 协议的失败收尾事件：response.failed。

不能发 response.completed —— 那是「这一轮成功产出完毕」的信号，
Codex 会把它当作正常答复（内容就是等待期间那句提示语），
用户看到的是「助手说了句正在调度就结束了」，完全不知道请求其实失败了。

response.failed 是 Responses 规范里表达「本轮失败」的事件：
Codex 据此报错并保留上下文，用户可以重试，而不会误以为会话正常结束。
*/
func (t *responsesTranslator) FinishError(message string) [][]byte {
	return [][]byte{sseEvent("response.failed", map[string]any{
		"type": "response.failed",
		"response": map[string]any{
			"id":         "resp_" + randomHex(16),
			"object":     "response",
			"created_at": time.Now().Unix(),
			"status":     "failed",
			"model":      t.model,
			"output":     []any{},
			"error": map[string]any{
				"code":    "no_available_channel",
				"message": message,
			},
		},
	})}
}

// sseEvent 构造一条带 event 名称的 SSE 消息。
// Responses 协议要求 event: 行，客户端按它分发处理。
func sseEvent(name string, payload any) []byte {
	body, err := json.Marshal(payload)
	if err != nil {
		body = []byte("{}")
	}
	var buf bytes.Buffer
	buf.WriteString("event: ")
	buf.WriteString(name)
	buf.WriteString("\n")
	buf.WriteString("data: ")
	buf.Write(body)
	buf.WriteString("\n\n")
	return buf.Bytes()
}

// sseData 取出一行 SSE 的 data 载荷。不是 data 行时返回 nil。
func sseData(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}
	return payload
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return b
}
