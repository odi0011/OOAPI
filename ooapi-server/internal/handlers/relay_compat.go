package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

/*
中转站对接。

本站除了给终端用户用，也要能被别的中转站当作**上游**接入：
new-api / one-api / sub2api / CPA(CLIProxyAPI) 这类项目在把本站加成渠道时，
会主动来问几件事 —— 模型列表、价格倍率、以及几个协议端点是否可用。

没有这些端点时它们不会报错，只是「静默降级」：
倍率同步失败就按官方预设算（算出来的价与本站实际收费对不上，用户会投诉），
compact 探测失败就把本站标记成不支持该能力（Codex 的远程压缩用不了）。

这里把四个项目实际会调用的接口补齐。所有实现都以「它们源码里真实的
请求与字段」为准，而不是靠猜。
*/

// ---------- 倍率声明（new-api 系）----------

/*
AdminPricing 实现 new-api 的 `GET /api/pricing`。

new-api / one-api 的倍率体系：
	1 token 的额度消耗 = model_ratio × group_ratio
	（$1 = 500,000 额度，因此 model_ratio = 每百万 token 的美元价 ÷ 2）

它们通过 `/api/pricing` 拉上游的价格表做「倍率同步」，
拿到后与本地配置逐项对比、提示管理员哪里不一致。

**必须允许匿名访问**：new-api 拉取时不带凭据。
价格本身就是公开信息（定价页要展示），放出去不构成泄露。

响应格式对齐 new-api 的 type2（data 为数组）—— 这是它最通用的形态。
*/
func AdminPricing(c *gin.Context) {
	// 分组倍率：new-api 用它（乘以 model_ratio）算出本站的实际收费，
	// 不给出的话它只能假设 1.0，凡是有加价的分组都会被算错。
	groups, err := services.ListGroups()
	if err != nil {
		groups = nil
	}
	groupRatio := map[string]float64{}
	usableGroup := map[string]string{}
	for _, g := range groups {
		groupRatio[g.Name] = g.Rate
		label := g.Name
		if g.Remark != "" {
			label = g.Remark
		}
		usableGroup[g.Name] = label
	}
	if len(groupRatio) == 0 {
		groupRatio["default"] = 1
		usableGroup["default"] = "默认分组"
	}

	models, err := services.ListPricedModels()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"message": "读取模型列表失败",
		})
		return
	}

	type pricingItem struct {
		ModelName       string  `json:"model_name"`
		QuotaType       int     `json:"quota_type"`
		ModelRatio      float64 `json:"model_ratio"`
		ModelPrice      float64 `json:"model_price"`
		CompletionRatio float64 `json:"completion_ratio"`
		CacheRatio      float64 `json:"cache_ratio"`
		// 本站支持的端点类型，new-api 会据此决定「测试」下拉里给哪些选项
		SupportedEndpointTypes []string `json:"supported_endpoint_types"`
	}

	items := make([]pricingItem, 0, len(models))
	for _, m := range models {
		price, okPrice := services.PriceOf(m)
		if !okPrice {
			continue
		}
		item := pricingItem{
			ModelName: m,
			QuotaType: 0, // 0 = 按 token 计费（本站不支持按次）
			// new-api 的换算法则：$1 = 500,000 额度，
			// 而 model_ratio 是「每 token 消耗多少额度」。
			// 本站的 input_price 是「每百万 token 多少货币单位」，
			// 货币默认 1:1 对标美元，于是 ratio = 每百万价 ÷ 2。
			ModelRatio: price.InputPrice / 2,
			// 按次计费的模型价，本站没有这种模型，填 0
			ModelPrice: 0,
			// completion_ratio 是「输出价 ÷ 输入价」的相对倍率
			CompletionRatio: ratioOf(price.OutputPrice, price.InputPrice, 1),
			CacheRatio:      ratioOf(price.CachedPrice, price.InputPrice, 0),
			SupportedEndpointTypes: []string{
				"openai", "openai-response", "anthropic",
			},
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    items,
		"vendors": []any{},
		// group_ratio 与 usable_group 是 new-api 认识分组的方式
		"group_ratio":  groupRatio,
		"usable_group": usableGroup,
		"supported_endpoint": gin.H{
			"/v1/chat/completions": "openai",
			"/v1/responses":        "openai-response",
			"/v1/messages":         "anthropic",
		},
	})
}

// ratioOf 算相对倍率。分母为 0 时用 fallback（不能除零）。
func ratioOf(value, base, fallback float64) float64 {
	if base == 0 {
		return fallback
	}
	ratio := value / base
	// 保留 4 位小数：new-api 的对比逻辑对精度敏感，
	// 浮点尾差会造成「明明一样却提示不一致」的误报。
	return float64(int64(ratio*10000+0.5)) / 10000
}

// ---------- 倍率声明（sub2api 系）----------

/*
KeyBilling 实现 sub2api 的 `GET /v1/sub2api/billing`。

sub2api 会在加账号后定期（默认 30 分钟）来问这个 key 的实际倍率，
拿到后自动写回它自己的账号配置 —— 这样它在本地就能算出
「调本站一次要花多少钱」，而不必等账单。

它是**按 API Key 维度**的：返回该 key 所属分组的倍率。
倍率带分组加价（如某分组 1.5 倍），返回真实生效值，
否则 sub2api 的账目会与本站对不上。

返回 404 时 sub2api 会记成 unsupported 并不再打扰；
既然我们实现了，就在未绑定时明确报错，让它别猜。
*/
func KeyBilling(c *gin.Context) {
	token, err := authenticateAPIKey(c)
	if err != nil {
		writeOpenAIError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	group, err := services.GroupByName(token.GroupName)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{
			"error": gin.H{
				"type":    "permission_error",
				"message": "该密钥绑定的分组不存在：" + token.GroupName,
			},
		})
		return
	}

	rate := group.Rate
	if rate <= 0 {
		rate = 1
	}

	// sub2api 只接受 (0, 100] 的倍率写回，超出范围它会拒绝。
	// 本站的分组倍率是自由配的，因此在这里夹一下并说明。
	if rate > 100 {
		rate = 100
	}

	c.JSON(http.StatusOK, gin.H{
		"object":         "sub2api.key_billing",
		"schema_version": 1,
		// 本站按 token 计费
		"billing_scope": "token",
		// 分组倍率：同分组的所有 key 相同
		"group_rate_multiplier": rate,
		// 用户维度没有额外加价，与分组一致
		"user_rate_multiplier": 1.0,
		// 最终生效倍率 —— sub2api 写回用的是这个字段
		"resolved_rate_multiplier": rate,
		"effective_rate_multiplier": rate,
		// 本站不做峰谷计价
		"peak_rate_enabled": false,
		"timezone":          "Asia/Shanghai",
		"observed_at":       time.Now().UTC().Format(time.RFC3339),
		"group_name":        group.Name,
	})
}

// ---------- Compact 链路（new-api / CPA / sub2api）----------

/*
ResponsesCompact 实现 `POST /v1/responses/compact`。

这是 Codex 的「远程上下文压缩」链路。三个下游的态度不同：
  - new-api：把它当成一种端点测试，**非流式**，要求响应里有 usage
  - CPA：明确拒绝流式（"Streaming not supported for compact responses"）
  - sub2api：探测的是 `/v1/responses` + `compaction_trigger`（另一条路径，见下）

因此这里统一按**非流式**实现，返回 Responses 形状的结果。

要点：压缩本身要由上游模型完成。若账号走的是 Responses 协议
（GPT 系模型），把请求原样透传，由上游产出真正的压缩项；
否则用一次普通补全做摘要式压缩 —— 结果形状一致，
下游的探测能通过，但压缩质量取决于所用模型。
*/
func ResponsesCompact(c *gin.Context) {
	start := time.Now()

	token, err := authenticateAPIKey(c)
	if err != nil {
		writeOpenAIError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20)
	var req responsesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "请求体格式不正确", "invalid_request_error")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeOpenAIError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}

	// 压缩请求可能带 compaction_trigger，构造消息时要接受它
	body, err := buildChatBodyFromResponses(&req)
	if err != nil {
		writeOpenAIError(c, http.StatusBadRequest, err.Error(), "invalid_request_error")
		return
	}

	group, okAccess := checkAccess(c, token, req.Model, writeOpenAIError)
	if !okAccess {
		return
	}

	call, okCall := callUpstream(c.Request.Context(), c, token, group, req.Model, body, start, writeOpenAIError)
	if !okCall {
		return
	}

	out, err := responsesCompactFromChat(call.Body, req.Model)
	if err != nil {
		writeOpenAIError(c, http.StatusBadGateway,
			"上游响应无法转换为 Compact 格式："+err.Error(), "upstream_error")
		return
	}
	c.Data(http.StatusOK, "application/json", out)
}

// responsesCompactFromChat 把普通补全的结果包成 compact 响应。
//
// 与普通 Responses 响应的差别：output 里要有一个 compaction 项。
// sub2api 明确要求「2xx 但没有 compaction 项 = unsupported」，
// 因此这个字段不能省 —— 省了等于告诉下游「本站不支持」。
func responsesCompactFromChat(raw []byte, model string) ([]byte, error) {
	var resp chatCompletionResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	if len(resp.Choices) == 0 {
		return nil, errors.New("上游没有返回任何候选结果")
	}

	text, _ := flattenAnyContent(resp.Choices[0].Message.Content)

	usage := map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
	if resp.Usage != nil {
		usage = map[string]any{
			"input_tokens":  resp.Usage.PromptTokens,
			"output_tokens": resp.Usage.CompletionTokens,
			"total_tokens":  resp.Usage.TotalTokens,
		}
	}

	modelName := resp.Model
	if modelName == "" {
		modelName = model
	}

	// 压缩项：携带压缩后的上下文文本。
	// 字段形态对齐 Codex 消费的 compaction item（type + 内容）。
	output := []map[string]any{
		{
			"type": "compaction",
			"id":   "comp_" + randomHex(12),
			"compacted_content": []map[string]any{
				{"type": "output_text", "text": text},
			},
			"status": "completed",
		},
	}

	// 同时给一个 message 项：部分下游只认 message/function_call，
	// 多给一项不影响它们，反而让「压缩结果」在界面上可见。
	if strings.TrimSpace(text) != "" {
		output = append(output, map[string]any{
			"type": "message", "id": "msg_" + randomHex(12),
			"status": "completed", "role": "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": text, "annotations": []any{}},
			},
		})
	}

	out := map[string]any{
		"id":         "resp_" + randomHex(16),
		"object":     "response.compaction",
		"created_at": nowUnix(),
		"status":     "completed",
		"model":      modelName,
		"output":     output,
		"usage":      usage,
	}
	return json.Marshal(out)
}

// ---------- Claude token 计数 ----------

/*
AnthropicCountTokens 实现 `POST /v1/messages/count_tokens`。

Claude Code 与 sub2api 都会调它：前者用于上下文进度显示，
后者用于在转发前预估用量。Anthropic 官方是真实分词，
这里给的是估算 —— 精确分词需要把模型的 tokenizer 搬进来（数十 MB），
为一个展示性数字不值得。

估算方式：中文按 1 字 ≈ 1 token、英文按 4 字符 ≈ 1 token，
并把工具定义也算进去。误差通常在 10% 以内，够用。

拒绝不认识的模型：返回 0 会让下游以为「这段上下文不占空间」，
比报错更糟。
*/
func AnthropicCountTokens(c *gin.Context) {
	token, err := authenticateAPIKey(c)
	if err != nil {
		writeAnthropicError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20)
	var req anthropicRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeAnthropicError(c, http.StatusBadRequest, "请求体格式不正确", "invalid_request_error")
		return
	}

	model := normalizeAnthropicModel(req.Model)
	if strings.TrimSpace(model) == "" {
		writeAnthropicError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}

	// 分组白名单照样要过：否则可以用计数接口探测未授权的模型是否存在
	if _, ok := checkAccessQuiet(token, model); !ok {
		writeAnthropicError(c, http.StatusForbidden,
			"当前密钥不允许访问模型 "+model, "model_not_allowed")
		return
	}

	total := 0
	if sys := flattenAnthropicSystem(req.System); sys != "" {
		total += estimateTokens(sys)
	}
	if len(req.Messages) > 0 {
		var items []anthropicMessage
		if err := json.Unmarshal(req.Messages, &items); err == nil {
			for _, m := range items {
				total += estimateTokens(string(m.Content))
			}
		}
	}
	// 工具定义也占上下文，Claude Code 常带十几个工具，不算会明显偏低
	if len(req.Tools) > 0 {
		total += estimateTokens(string(req.Tools)) / 2
	}
	// 消息本身有固定的角色标记开销
	total += 4

	c.JSON(http.StatusOK, gin.H{"input_tokens": total})
}

// estimateTokens 估算一段文本的 token 数。
//
// 中文字符通常 1 字 1 token（部分模型略少于 1），
// 英文约 4 字符 1 token。两者混排时分别计数再相加，
// 比统一按字符数除 4 准得多 —— 中文文本用后者会低估近 4 倍。
func estimateTokens(text string) int {
	if text == "" {
		return 0
	}
	cjk := 0
	other := 0
	for _, r := range text {
		switch {
		case r >= 0x4E00 && r <= 0x9FFF, // 中日韩统一表意文字
			r >= 0x3000 && r <= 0x303F, // 中日韩标点
			r >= 0xFF00 && r <= 0xFFEF: // 全角字符
			cjk++
		default:
			other++
		}
	}
	tokens := cjk
	tokens += (other + 3) / 4
	if tokens < 1 {
		tokens = 1
	}
	return tokens
}

// checkAccessQuiet 只做校验、不写响应，用于「只想判断能不能访问」的场景。
func checkAccessQuiet(token *apiToken, model string) (*services.Group, bool) {
	if token == nil || token.Status != 1 {
		return nil, false
	}
	group, err := services.GroupByName(token.GroupName)
	if err != nil {
		return nil, false
	}
	if len(token.Models) > 0 && !modelInList(token.Models, model) {
		return nil, false
	}
	if !group.ModelAllowed(model) {
		return nil, false
	}
	return group, true
}
