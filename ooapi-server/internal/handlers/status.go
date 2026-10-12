package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// Status 返回站点公开配置，前端首屏用它渲染站点名、注册开关等。
// 只返回匿名可安全获取的字段，绝不包含密钥、额度等敏感信息。
func Status(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"system_name":               services.GetOption("system_name", "OOAPI"),
			"logo":                      services.GetOption("logo", "/logo.jpg"),
			"api_endpoint":              services.GetOption("api_endpoint", ""),
			"password_register_enabled": services.GetBoolOption("password_register_enabled", false),
			"password_login_enabled":    services.GetBoolOption("password_login_enabled", true),
			"currency_name":             services.GetOption("currency_name", "OD币"),
			"units_per_od":              services.GetIntOption("units_per_od", 10000),
			// 外观由管理员统一配置、对全站生效，因此匿名访客也要拿到。
			"appearance": services.PublicAppearance(),
		},
	})
}

// Health 供负载均衡与部署脚本探活，会真实探测数据库连通性。
func Health(c *gin.Context) {
	if db.DB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "db": "uninitialized"})
		return
	}
	if err := db.DB.Ping(); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "db": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "db": "ok"})
}

/*
ListModels 返回模型列表，遵循 OpenAI /v1/models 结构。

**带密钥时按该密钥的分组过滤**，只返回它真正能调的模型；
不带密钥时返回全站已定价目录（首页用它取示例模型名）。

为什么必须过滤：这个接口是客户端（和用户）判断「我能在你这儿用什么」的唯一依据。
分组只放行一个模型、列表却返回全部 → 用户按列表选模型必然 403
（原项目文档里把这个病记作「列表说能调、调用说不能」）。
口径与调度侧共用 `AvailableModelsForGroup`（渠道声明 ∩ 分组白名单），
两边不可能再各说各话。

不带密钥时给完整目录是**故意**的：首页/文档要展示平台有什么，
且那份数据本来就不是秘密（定价页公开可见）。要拿「我能调什么」必须带密钥。
*/
func ListModels(c *gin.Context) {
	// 不带密钥 → 全量目录；带了 → 按分组过滤。
	// 注意不能用 authenticateAPIKey 的报错来区分：格式不对的密钥应当报错，
	// 而不是静默降级成「给你全部模型」。
	raw := extractBearer(c)
	if raw != "" {
		if !auth.IsValidAPIKeyShape(raw) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": gin.H{"message": "API Key 格式不正确", "type": "invalid_request_error"}})
			return
		}
		token, err := authenticateAPIKey(c)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": gin.H{"message": err.Error(), "type": "invalid_request_error"}})
			return
		}
		allowed, err := services.AvailableModelsForGroup(token.GroupName)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": err.Error(), "type": "server_error"}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"object": "list", "data": buildModelItems(c, allowed)})
		return
	}

	models, err := services.ListPricedModels()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": err.Error(), "type": "server_error"}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"object": "list", "data": buildModelItems(c, models)})
}

type modelItem struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
	/*
		能力元数据一起带上。

		部分客户端（Codex、某些 SDK）会读模型的上下文窗口来决定
		自己的压缩阈值；不返回它们就只能用客户端自己猜的默认值。
		未核实的模型不给这些字段（omitempty），而不是编一个数字 ——
		编错会让客户端按错误窗口做压缩。

		字段名用业界通用的几种写法并给：不同客户端认不同的键，
		多写几个的代价远小于「配置了却没人读」。
	*/
	ContextWindow   int   `json:"context_window,omitempty"`
	ContextLength   int   `json:"context_length,omitempty"`
	MaxOutputTokens int   `json:"max_output_tokens,omitempty"`
	SupportsTools   *bool `json:"supports_tools,omitempty"`
	Capabilities    *struct {
		Vision      bool `json:"vision"`
		ToolCalling bool `json:"tool_calling"`
		Reasoning   bool `json:"reasoning"`
	} `json:"capabilities,omitempty"`
}

// buildModelItems 把模型名列表组装成 /v1/models 的响应项（含能力元数据）。
func buildModelItems(_ *gin.Context, models []string) []modelItem {

	items := make([]modelItem, 0, len(models))
	for _, m := range models {
		item := modelItem{ID: m, Object: "model", OwnedBy: "ooapi"}
		caps := services.ModelCapabilitiesOf(m)
		item.ContextWindow = caps.ContextWindow
		item.ContextLength = caps.ContextWindow
		item.MaxOutputTokens = caps.MaxOutputTokens
		if caps.ToolCalling != nil {
			value := *caps.ToolCalling
			item.SupportsTools = &value
		}
		vision := false
		for _, t := range caps.InputTypes {
			if t == "image" {
				vision = true
			}
		}
		item.Capabilities = &struct {
			Vision      bool `json:"vision"`
			ToolCalling bool `json:"tool_calling"`
			Reasoning   bool `json:"reasoning"`
		}{
			Vision:      vision,
			ToolCalling: services.SupportsToolCalling(m),
			Reasoning:   len(caps.Reasoning.Levels) > 0,
		}
		items = append(items, item)
	}
	return items
}
