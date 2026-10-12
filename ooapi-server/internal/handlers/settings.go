package handlers

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// SiteSettings 是设置页的完整配置快照。
//
// 所有字段都用「是否已设置」之外的中性类型，方便前端直接绑定表单；
// 敏感项（三方密钥、SMTP 密码）不在这里，它们由 /api/admin/auth-config 单独管理。
type SiteSettings struct {
	// 外观（全局生效）
	Appearance services.Appearance `json:"appearance"`

	// 站点信息
	SystemName  string `json:"system_name"`
	Logo        string `json:"logo"`
	APIEndpoint string `json:"api_endpoint"`
	SiteBaseURL string `json:"site_base_url"`

	// 注册与登录
	RegisterEnabled bool `json:"password_register_enabled"`
	LoginEnabled    bool `json:"password_login_enabled"`
	QuotaForNewUser int  `json:"quota_for_new_user"`

	// 计费
	CurrencyName string  `json:"currency_name"`
	CurrencyIcon string  `json:"currency_icon"`
	CurrencyRate float64 `json:"currency_rate"`
	UnitsPerOD   int     `json:"units_per_od"`

	// 网关
	RequestTimeoutMS int `json:"request_timeout_ms"`
}

// AdminGetSettings 读取完整设置，需要 option:view。
func AdminGetSettings(c *gin.Context) {
	cur := services.GetCurrency()
	a := services.GetAppearance()

	ok(c, SiteSettings{
		Appearance: a,

		SystemName:  services.GetOption("system_name", "OOAPI"),
		Logo:        services.GetOption("logo", "/logo.jpg"),
		APIEndpoint: services.GetOption("api_endpoint", ""),
		SiteBaseURL: services.GetOption("site_base_url", ""),

		RegisterEnabled: services.GetBoolOption("password_register_enabled", false),
		LoginEnabled:    services.GetBoolOption("password_login_enabled", true),
		QuotaForNewUser: services.GetIntOption("quota_for_new_user", 0),

		CurrencyName: cur.Name,
		CurrencyIcon: cur.Icon,
		CurrencyRate: cur.Rate,
		UnitsPerOD:   cur.UnitsPerUnit,

		RequestTimeoutMS: services.GetIntOption("request_timeout_ms", 600000),
	})
}

// AdminUpdateSettings 保存设置，需要 option:edit。
//
// 用指针字段接收：只有这样才区分得出「没传这个字段」与「传了空值」。
// 若用值类型，前端只想改一项时也得把全部字段回传，漏传的会被写空。
type settingsPatch struct {
	Appearance *struct {
		Theme   *string `json:"theme"`
		Accent  *string `json:"accent"`
		Font    *string `json:"font"`
		Density *string `json:"density"`
	} `json:"appearance"`

	SystemName  *string `json:"system_name"`
	Logo        *string `json:"logo"`
	APIEndpoint *string `json:"api_endpoint"`
	SiteBaseURL *string `json:"site_base_url"`

	RegisterEnabled *bool `json:"password_register_enabled"`
	LoginEnabled    *bool `json:"password_login_enabled"`
	QuotaForNewUser *int  `json:"quota_for_new_user"`

	CurrencyName *string  `json:"currency_name"`
	CurrencyIcon *string  `json:"currency_icon"`
	CurrencyRate *float64 `json:"currency_rate"`
	UnitsPerOD   *int     `json:"units_per_od"`

	RequestTimeoutMS *int `json:"request_timeout_ms"`
}

func AdminUpdateSettings(c *gin.Context) {
	var req settingsPatch
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	updates := map[string]string{}

	// ---- 外观 ----
	if req.Appearance != nil {
		if req.Appearance.Theme != nil {
			v := strings.TrimSpace(*req.Appearance.Theme)
			if !services.ValidTheme(v) {
				fail(c, http.StatusBadRequest, "明暗模式只能是 light / dark / system", "invalid_theme")
				return
			}
			updates["appearance_theme"] = v
		}
		if req.Appearance.Accent != nil {
			v := strings.TrimSpace(*req.Appearance.Accent)
			if !services.ValidAccent(v) {
				fail(c, http.StatusBadRequest, "不支持的主题色："+v, "invalid_accent")
				return
			}
			updates["appearance_accent"] = v
		}
		if req.Appearance.Font != nil {
			v := strings.TrimSpace(*req.Appearance.Font)
			if !services.ValidFont(v) {
				fail(c, http.StatusBadRequest, "不支持的字体："+v, "invalid_font")
				return
			}
			updates["appearance_font"] = v
		}
		if req.Appearance.Density != nil {
			v := strings.TrimSpace(*req.Appearance.Density)
			if v != "comfortable" && v != "compact" {
				fail(c, http.StatusBadRequest, "布局密度只能是 comfortable 或 compact", "invalid_density")
				return
			}
			updates["appearance_density"] = v
		}
	}

	// ---- 站点信息 ----
	if req.SystemName != nil {
		name := strings.TrimSpace(*req.SystemName)
		if name == "" {
			fail(c, http.StatusBadRequest, "站点名称不能为空", "invalid_name")
			return
		}
		if len([]rune(name)) > 32 {
			fail(c, http.StatusBadRequest, "站点名称最长 32 个字符", "invalid_name")
			return
		}
		updates["system_name"] = name
	}

	if req.Logo != nil {
		updates["logo"] = strings.TrimSpace(*req.Logo)
	}

	if req.APIEndpoint != nil {
		updates["api_endpoint"] = strings.TrimSpace(*req.APIEndpoint)
	}

	if req.SiteBaseURL != nil {
		base := strings.TrimRight(strings.TrimSpace(*req.SiteBaseURL), "/")
		if base != "" && !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
			fail(c, http.StatusBadRequest, "站点地址需以 http:// 或 https:// 开头", "invalid_url")
			return
		}
		updates["site_base_url"] = base
	}

	// ---- 注册与登录 ----
	if req.RegisterEnabled != nil {
		updates["password_register_enabled"] = boolToStr(*req.RegisterEnabled)
	}
	if req.LoginEnabled != nil {
		updates["password_login_enabled"] = boolToStr(*req.LoginEnabled)
	}
	if req.QuotaForNewUser != nil {
		if *req.QuotaForNewUser < 0 {
			fail(c, http.StatusBadRequest, "赠送额度不能为负", "invalid_quota")
			return
		}
		updates["quota_for_new_user"] = strconv.Itoa(*req.QuotaForNewUser)
	}

	// ---- 计费与货币 ----
	if req.CurrencyName != nil {
		name := strings.TrimSpace(*req.CurrencyName)
		if name == "" {
			fail(c, http.StatusBadRequest, "货币名称不能为空", "invalid_currency")
			return
		}
		if len([]rune(name)) > 16 {
			fail(c, http.StatusBadRequest, "货币名称最长 16 个字符", "invalid_currency")
			return
		}
		updates["currency_name"] = name
	}
	if req.CurrencyIcon != nil {
		icon := strings.TrimSpace(*req.CurrencyIcon)
		// 只接受站内路径或 /uploads/ 下的上传文件，杜绝把外站图片写进设置。
		if icon != "" && !strings.HasPrefix(icon, "/") {
			fail(c, http.StatusBadRequest, "货币图标需为站内路径，请使用上传功能", "invalid_icon")
			return
		}
		updates["currency_icon"] = icon
	}
	if req.CurrencyRate != nil {
		// 比例必须为正：为 0 会导致换算除零，为负会让金额符号反转。
		if *req.CurrencyRate <= 0 || *req.CurrencyRate > 100000 {
			fail(c, http.StatusBadRequest, "兑换比例需在 0 到 100000 之间", "invalid_rate")
			return
		}
		updates["currency_rate"] = strconv.FormatFloat(*req.CurrencyRate, 'f', -1, 64)
	}
	if req.UnitsPerOD != nil {
		// 为 0 会导致除零，进而让账单计算全部崩掉。
		if *req.UnitsPerOD <= 0 {
			fail(c, http.StatusBadRequest, "1 单位货币对应的额度单位数必须大于 0", "invalid_units")
			return
		}
		updates["units_per_od"] = strconv.Itoa(*req.UnitsPerOD)
	}

	// ---- 网关 ----
	if req.RequestTimeoutMS != nil {
		// 上限 10 分钟：再长会把连接池占满，且上游多半早已断开。
		if *req.RequestTimeoutMS < 1000 || *req.RequestTimeoutMS > 600000 {
			fail(c, http.StatusBadRequest, "请求超时需在 1000–600000 毫秒之间", "invalid_timeout")
			return
		}
		updates["request_timeout_ms"] = strconv.Itoa(*req.RequestTimeoutMS)
	}

	if len(updates) == 0 {
		fail(c, http.StatusBadRequest, "没有需要更新的设置项", "nothing_to_update")
		return
	}

	if err := services.SetOptions(updates); err != nil {
		log.Printf("[admin/settings] 保存失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存设置失败", "server_error")
		return
	}

	operator, _ := currentUser(c)
	if operator != nil {
		log.Printf("[admin] %s 更新了站点设置（%d 项）", operator.Username, len(updates))
	}

	// 回传最新完整设置，前端不必再发一次 GET。
	AdminGetSettings(c)
}

// PublicSettings 是匿名可读的站点配置（首页与登录页用）。
// 只包含展示所需字段，不含任何敏感信息。
func PublicSettings(c *gin.Context) {
	cur := services.GetCurrency()

	ok(c, gin.H{
		"system_name":               services.GetOption("system_name", "OOAPI"),
		"logo":                      services.GetOption("logo", "/logo.jpg"),
		"api_endpoint":              services.GetOption("api_endpoint", ""),
		"currency_name":             cur.Name,
		"currency_icon":             cur.Icon,
		"currency_rate":             cur.Rate,
		"units_per_od":              cur.UnitsPerUnit,
		"password_register_enabled": services.GetBoolOption("password_register_enabled", false),
		"password_login_enabled":    services.GetBoolOption("password_login_enabled", true),
		// 外观对全站生效，匿名访客也要拿到。
		"appearance": services.PublicAppearance(),
	})
}
