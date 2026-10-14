package router

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/config"
	"ooapi/internal/handlers"
	"ooapi/internal/middleware"
)

func Setup(cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), corsMiddleware(cfg))

	r.MaxMultipartMemory = 32 << 20

	requireAuth := middleware.RequireAuth(cfg.JWTSecret)
	optionalAuth := middleware.OptionalAuth(cfg.JWTSecret)

	// ---------- 公开接口 ----------
	api := r.Group("/api")
	{
		api.GET("/status", handlers.Status)
		api.GET("/health", handlers.Health)
		// 站点公开配置，含全局外观设置。
		api.GET("/settings/public", handlers.PublicSettings)

		// 认证：注册与登录本身必须匿名可访问。
		authGroup := api.Group("/auth")
		{
			authGroup.POST("/register", handlers.Register)
			authGroup.POST("/login", handlers.Login)
			authGroup.POST("/logout", handlers.Logout)
			// me 用 OptionalAuth：未登录返回 401 而不是报错，前端据此判断登录态。
			authGroup.GET("/me", optionalAuth, handlers.Me)

			// 邮箱验证码登录：仅在管理员配好 SMTP 后可用，
			// handler 内部也会再校验一次，不依赖前端隐藏。
			authGroup.POST("/email/send", handlers.SendEmailCode)
			authGroup.POST("/email/login", handlers.LoginWithEmailCode)

			// 三方登录。start 与 callback 都是整页跳转，
			// 前端不通过 fetch 调用，因此不受 CORS 影响。
			authGroup.GET("/oauth/:provider/start", handlers.OAuthStart)
			authGroup.GET("/oauth/:provider/callback", handlers.OAuthCallback)
		}

		// 登录页需要知道「有哪些登录方式可用」，但不能拿到任何凭据。
		api.GET("/auth/providers", handlers.PublicAuthProviders)

		// 媒体公开读端点：聊天里的 <img> 与头像都带不了 Authorization 头，
		// 所以走 optionalAuth —— 带令牌就认身份，不带按匿名继续，
		// 由 handler 内部校验签名/归属。绝不能全局挂 requireAuth，
		// 否则带合法签名也 401、头像永远显示不出来。
		mediaPublic := api.Group("/media", optionalAuth)
		{
			// 原始文件流与公开头像：匿名可达（签名或归属校验在 handler 内）。
			mediaPublic.GET("/avatar/:userId", handlers.MediaAvatar)
			mediaPublic.GET("/:id/raw", handlers.MediaRaw)
		}

		/*
			中转站对接：倍率声明。

			new-api / one-api 系在「倍率同步」时会匿名拉这个接口，
			拿本站的价格表与它本地配置逐项对比。必须允许匿名 ——
			它请求时不带任何凭据；而价格本来就属于公开信息（定价页要展示）。

			放在 /api 下而不是 /v1 下，是为了与 new-api 的路径约定一致：
			它默认请求 `{base_url}/api/pricing`。
		*/
		api.GET("/pricing", handlers.AdminPricing)

		// 实盘加速和检测事件：OOAPI_BOOST_TOKEN，或 OptionalAuth 后具备 option:edit 的管理员。
		api.POST("/trading/engine/boost", optionalAuth, handlers.PostTradingEngineBoost)
		api.GET("/trading/engine/events", optionalAuth, handlers.GetTradingEngineEvents)
	}

	// sub2api 的倍率声明在 /v1 下（按 key 维度，需要鉴权）
	v1Public := r.Group("/v1")
	{
		v1Public.GET("/sub2api/billing", handlers.KeyBilling)
	}

	// ---------- 需登录（普通用户即可） ----------
	user := api.Group("", requireAuth)
	{
		user.PUT("/user/profile", handlers.UpdateProfile)
		user.PUT("/user/password", handlers.ChangePassword)

		// 三方账号绑定管理：查看与解绑自己绑定的平台。
		user.GET("/user/oauth", handlers.AdminListOAuthBindings)
		user.DELETE("/user/oauth/:provider", handlers.UnbindOAuth)

		// 分组列表：创建密钥时要选，普通用户需可读。
		// 增删改在下面的管理区，按能力点收口。
		user.GET("/groups", handlers.PublicGroups)

		// 密钥是用户自己的资源，靠 user_id 归属过滤。
		//
		// 注意 /reconcile 必须声明在 /:id 之前 —— 否则会被当作 id 参数匹配，
		// 解析失败后返回「密钥不存在」，这是很典型的路由顺序坑。
		user.GET("/token/reconcile", handlers.ReconcileTokens)
		user.GET("/token/", handlers.ListMyTokens)
		user.POST("/token/", handlers.CreateMyToken)
		user.GET("/token/:id/reveal", handlers.RevealMyToken)
		user.PUT("/token/:id", handlers.UpdateMyToken)
		user.DELETE("/token/:id", handlers.DeleteMyToken)

		// 自动交易。密钥按 user_id 归属；策略与引擎走 option:edit。
		// 引擎读已有的策略和密钥，测网在内存撮合，实盘默认不下单。
		// 行情、持仓、委托只读，不打开发单门闩。
		user.GET("/trading/exchange-keys", handlers.ListExchangeKeys)
		user.POST("/trading/exchange-keys", handlers.CreateExchangeKey)
		user.POST("/trading/exchange-keys/:id/reveal", handlers.RevealExchangeKey)
		user.POST("/trading/exchange-keys/:id/revoke", handlers.RevokeExchangeKey)
		user.DELETE("/trading/exchange-keys/:id", handlers.RevokeExchangeKey)

		strategies := user.Group("/trading/strategies", middleware.RequirePermission(authz.PermOptionEdit))
		{
			strategies.GET("", handlers.ListTradingStrategies)
			strategies.POST("", handlers.CreateTradingStrategy)
			strategies.GET("/:id/pause-entries", handlers.GetStrategyPauseEntries)
			strategies.POST("/:id/pause-entries", handlers.PostStrategyPauseEntries)
			strategies.GET("/:id", handlers.GetTradingStrategy)
			strategies.PATCH("/:id", handlers.UpdateTradingStrategy)
			strategies.DELETE("/:id", handlers.DeleteTradingStrategy)
		}

		user.GET("/trading/backtest", middleware.RequirePermission(authz.PermOptionEdit), handlers.GetTradingBacktest)
		user.GET("/trading/engines", middleware.RequirePermission(authz.PermOptionEdit), handlers.TradingEnginesList)

		engineAPI := user.Group("/trading/engine", middleware.RequirePermission(authz.PermOptionEdit))
		{
			engineAPI.GET("/state", handlers.GetTradingEngineState)
			engineAPI.GET("/market", handlers.GetTradingMarket)
			engineAPI.GET("/position", handlers.GetTradingPosition)
			engineAPI.GET("/orders", handlers.GetTradingOrders)
			engineAPI.GET("/balance", handlers.GetTradingBalance)
			engineAPI.POST("/start", handlers.StartTradingEngine)
			engineAPI.POST("/resume", handlers.ResumeTradingEngine)
			engineAPI.POST("/stop", handlers.StopTradingEngine)
			engineAPI.POST("/step", handlers.StepTradingEngine)
			engineAPI.POST("/testnet-green", handlers.SetTradingTestnetGreen)
		}

		// 使用记录与操作日志：所有登录用户可访问。
		// 数据归属在 handler 内强制 —— 有 log:view_all 的看全站，
		// 其余人只能看到自己的记录。
		user.GET("/logs/usage", handlers.UsageLogs)
		user.GET("/logs/usage/summary", handlers.UsageLogSummary)
		user.GET("/logs/usage/filters", handlers.UsageLogFilters)
		// 单条明细（含原文快照）。声明在静态路径之后：
		// 归属与字段裁剪在 handler 内完成，普通用户只能取到自己的记录。
		user.GET("/logs/usage/:id", handlers.UsageLogDetail)
		user.GET("/logs/operation", handlers.OperationLogs)

		// 个人资料（个人资料页用）：字段一次取齐，与 /api/auth/me 解耦。
		user.GET("/user/profile", handlers.UserProfile)

		// ---------- 媒体库 ----------
		// 路由顺序很关键：具名子路径必须写在 /:id 之前，
		// 否则 DELETE /media/avatar 会被 /media/:id 匹配（id 变成字符串 "avatar"）。
		user.POST("/media/avatar", handlers.MediaAvatarUpload)
		user.DELETE("/media/avatar", handlers.MediaAvatarDelete)
		user.GET("/media/stats", handlers.MediaStats)
		user.POST("/media/gc", handlers.MediaGC)
		user.POST("/media", handlers.MediaUpload)
		user.GET("/media", handlers.MediaList)
		user.GET("/media/:id", handlers.MediaDetail)
		user.PATCH("/media/:id", handlers.MediaRename)
		user.DELETE("/media/:id", handlers.MediaDelete)
	}

	// ---------- 管理接口：按能力点分组 ----------
	admin := api.Group("/admin", requireAuth)
	{
		// 用户管理
		users := admin.Group("/users")
		{
			users.GET("", middleware.RequirePermission(authz.PermUserView), handlers.AdminListUsers)
			users.PUT("/:id/role",
				middleware.RequirePermission(authz.PermRoleAssign),
				handlers.AdminUpdateUserRole,
			)
			users.PUT("/:id/status",
				middleware.RequirePermission(authz.PermUserEdit),
				handlers.AdminUpdateUserStatus,
			)
			users.PUT("/:id/quota",
				middleware.RequirePermission(authz.PermUserManageQuota),
				handlers.AdminUpdateUserQuota,
			)
			users.PUT("/:id/profile",
				middleware.RequirePermission(authz.PermUserEdit),
				handlers.AdminUpdateUserProfile,
			)
			users.DELETE("/:id",
				middleware.RequirePermission(authz.PermUserEdit),
				handlers.AdminDeleteUser,
			)
		}

		// 系统设置：查看与修改分开授权，
		// 允许「能看但不能改」这种角色存在。
		admin.GET("/options",
			middleware.RequirePermission(authz.PermOptionView),
			handlers.AdminListOptions,
		)
		admin.PUT("/options",
			middleware.RequirePermission(authz.PermOptionEdit),
			handlers.AdminUpdateOptions,
		)

		// 认证方式配置（三方登录密钥、SMTP）。
		// 查看与修改同样分开授权：密钥虽已掩码，仍属于敏感配置。
		admin.GET("/auth-config",
			middleware.RequirePermission(authz.PermOptionView),
			handlers.AdminListAuthConfig,
		)
		admin.PUT("/auth-config",
			middleware.RequirePermission(authz.PermOptionEdit),
			handlers.AdminUpdateAuthConfig,
		)
		admin.POST("/auth-config/test-smtp",
			middleware.RequirePermission(authz.PermOptionEdit),
			handlers.AdminTestSMTP,
		)

		// 站点设置（外观、站点信息、注册、计费、网关）。
		// 外观对全站生效，但只有超管能改 —— 它影响所有用户的观感。
		admin.GET("/settings",
			middleware.RequirePermission(authz.PermOptionView),
			handlers.AdminGetSettings,
		)
		admin.PUT("/settings",
			middleware.RequirePermission(authz.PermOptionEdit),
			handlers.AdminUpdateSettings,
		)

		// 图标上传（站点图标、货币图标）。用文件上传而不是让管理员手填地址。
		admin.POST("/upload/icon",
			middleware.RequirePermission(authz.PermOptionEdit),
			handlers.AdminUploadIcon,
		)

		// ---------- 账号分组 ----------
		// 分组决定「这把密钥能调哪些模型、按什么倍率计费」，
		// 属于网关核心配置，读用 user:view、写用 user:edit 收口。
		groups := admin.Group("/groups")
		{
			groups.GET("", middleware.RequirePermission(authz.PermUserView), handlers.AdminListGroups)
			groups.POST("", middleware.RequirePermission(authz.PermUserEdit), handlers.AdminCreateGroup)
			groups.PUT("/:id", middleware.RequirePermission(authz.PermUserEdit), handlers.AdminUpdateGroup)
			groups.DELETE("/:id", middleware.RequirePermission(authz.PermUserEdit), handlers.AdminDeleteGroup)
		}

		// ---------- 账号 ----------
		// 读写与删除分开授权：允许「能看能改但不能删」这种角色存在。
		channels := admin.Group("/channels")
		{
			channels.GET("/devices/vendors", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDeviceVendors)
			channels.POST("/devices/start", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDeviceStart)
			channels.POST("/devices/poll", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDevicePoll)
			channels.POST("/devices/cancel", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDeviceCancel)
			channels.POST("/devices/claim", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDeviceClaim)
			// 一键授权成功后立刻拉模型：用票据里的凭据，不依赖渠道已落库。
			channels.POST("/devices/models", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminDeviceModels)
			// 订阅账号（Codex / Claude / Google）的交互式 OAuth 登录。
			// 服务端只生成授权地址与换令牌，用户在官方页面完成授权后
			// 把回调地址粘回来 —— 见 handlers/upstream_login.go 顶部说明。
			channels.POST("/devices/login/start", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminUpstreamLoginStart)
			channels.POST("/devices/login/exchange", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminUpstreamLoginExchange)
			channels.POST("/devices/login/models", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminUpstreamLoginModels)
			// 粘贴凭据导入（官方 CLI / CPA / sub2api 导出）：与登录并列的入口。
			channels.POST("/devices/login/import", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminUpstreamLoginImport)
			channels.GET("", middleware.RequirePermission(authz.PermChannelView), handlers.AdminListChannels)
			channels.POST("", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminCreateChannel)
			channels.PUT("/:id", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminUpdateChannel)
			channels.DELETE("/:id", middleware.RequirePermission(authz.PermChannelDelete), handlers.AdminDeleteChannel)
			channels.POST("/:id/test", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminTestChannel)
			channels.POST("/fetch-models", middleware.RequirePermission(authz.PermChannelEdit), handlers.AdminFetchModels)
		}

		// ---------- 模型定价 ----------
		prices := admin.Group("/prices")
		{
			prices.GET("", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminListPrices)
			prices.POST("", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminUpsertPrice)
			// 模型名可能含斜杠（如 vendor/model），因此用通配参数而不是普通参数。
			prices.DELETE("/:model", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminDeletePrice)
		}

		// ---------- 模型配置（能力参数 + 上游名映射）----------
		// 与定价同一权限：都属于「这个模型该怎么用、按什么价算」的配置。
		models := admin.Group("/models")
		{
			models.GET("/configs", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminListModelConfigs)
			models.GET("/configs/:model", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminGetModelConfig)
			models.PUT("/configs", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminSaveModelConfig)
			models.DELETE("/configs/:model", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminDeleteModelConfig)
			models.GET("/map", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminListModelMap)
			models.PUT("/map", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminSaveModelMap)
			models.GET("/map/candidates", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminModelMapCandidates)
			// 全部模型总览：按厂商分组看「谁支持什么、有没有配价、该跟随谁」。
			models.GET("/catalog", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminModelCatalog)
			models.POST("/follow", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminModelFollow)
			models.DELETE("/follow/:model", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminModelUnfollow)
			// 真实模型目录与绑定：上游别名必须绑到真实模型才能保存与调用。
			models.GET("/real", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminRealModels)
			models.POST("/bind", middleware.RequirePermission(authz.PermPricingEdit), handlers.AdminBindRealModel)
			models.GET("/bind/presets", middleware.RequirePermission(authz.PermViewPricing), handlers.AdminRealModelPresetNames)
		}

		// 使用记录与操作日志已提到上面的登录组：
		// 它们对所有登录用户开放（服务端按 log:view_all 收口数据范围），
		// 普通用户也要能查「我自己的调用与谁动过我的账号」。

		// ---------- 运行状态 ----------
		admin.GET("/status",
			middleware.RequirePermission(authz.PermOptionView),
			handlers.AdminStatus,
		)

		// ---------- 看板与消费分析 ----------
		// 数据范围在 handler 内按权限收口：有 log:view_all 拿到全站数据，
		// 其他人只拿到自己的。因此这里只要求登录，不额外拦权限 ——
		// 普通用户同样需要一个「我自己的用量看板」。
		admin.GET("/stats", handlers.AdminStats)
		admin.GET("/stats/filters", handlers.DashboardFilters)
	}

	// ---------- 对外 OpenAI 兼容接口 ----------
	v1 := r.Group("/v1")
	{
		v1.GET("/models", handlers.ListModels)
		// 网关核心：账号调度 → 上游转发 → 计费 → 记日志。
		// 鉴权在 handler 内部用 API Key 完成（不是 JWT），
		// 因为这里的调用方是外部应用，不是本站登录用户。
		v1.POST("/chat/completions", handlers.ChatCompletions)

		// 另两种协议：只有外壳不同，内部链路完全一致。
		//
		// /responses 是 Codex CLI 唯一支持的协议（0.145 起去掉了 chat）；
		// /messages 是 Claude Code 唯一支持的协议。
		// 不提供它们，这两个主流 CLI 就无法接入本站。
		v1.POST("/responses", handlers.Responses)
		v1.POST("/responses/compact", handlers.ResponsesCompact)
		v1.POST("/messages", handlers.AnthropicMessages)
		v1.POST("/messages/count_tokens", handlers.AnthropicCountTokens)
	}

	registerSPA(r, cfg.WebDir)

	return r
}

// corsMiddleware 只对允许列表里的 Origin 反射，并带上凭据。
// 未列入的来源得不到 Access-Control-Allow-Origin，浏览器会丢掉带 cookie 的跨域响应。
func corsMiddleware(cfg *config.Config) gin.HandlerFunc {
	allow := map[string]struct{}{}
	allowLocal := false
	if cfg != nil {
		allowLocal = cfg.CORSAllowLocalhost
		for _, origin := range cfg.CORSOrigins {
			origin = strings.TrimSpace(origin)
			if origin != "" {
				allow[origin] = struct{}{}
			}
		}
	}
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin != "" && originPermitted(origin, allow, allowLocal) {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Requested-With")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func originPermitted(origin string, allow map[string]struct{}, allowLocal bool) bool {
	if _, ok := allow[origin]; ok {
		return true
	}
	if !allowLocal {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// registerSPA 托管前端构建产物。
// 单页应用需要回落：静态文件命中就返回文件，否则一律给 index.html，
// 让前端路由处理，否则直接刷新 /login 会 404。
func registerSPA(r *gin.Engine, webDir string) {
	indexPath := filepath.Join(webDir, "index.html")
	r.Static("/assets", filepath.Join(webDir, "assets"))

	// 上传的图标走独立目录，位于前端构建产物之外。
	// 上传时已校验类型与文件头，这里直接静态托管。
	uploadDir := handlers.UploadRootPath(webDir)
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		// 目录建不出来不算致命：只是上传会失败，站点仍可正常访问。
		log.Printf("[router] 创建上传目录失败: %v", err)
	}
	r.Static("/uploads", uploadDir)

	r.NoRoute(func(c *gin.Context) {
		path := c.Request.URL.Path

		// 接口路径不能回落到 HTML，否则前端会把 HTML 当 JSON 解析。
		if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/v1/") {
			c.JSON(http.StatusNotFound, gin.H{
				"success": false,
				"error":   gin.H{"message": "接口不存在", "code": "not_found"},
			})
			return
		}

		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.JSON(http.StatusMethodNotAllowed, gin.H{
				"success": false,
				"error":   gin.H{"message": "方法不允许", "code": "method_not_allowed"},
			})
			return
		}

		candidate := filepath.Join(webDir, filepath.Clean("/"+path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			c.File(candidate)
			return
		}

		if _, err := os.Stat(indexPath); err != nil {
			c.String(http.StatusNotFound, "前端尚未构建：请先在 ooapi-web 执行 npm run build")
			return
		}
		c.File(indexPath)
	})
}
