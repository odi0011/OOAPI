package handlers

import (
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/db"
	"ooapi/internal/oauth"
	"ooapi/internal/services"
)

// AdminListAuthConfig 返回认证方式的配置状态，需要 option:view。
//
// 返回的密钥一律是掩码 —— 管理后台同样可能被旁观或截图，
// 完整密钥只在管理员自己粘贴的那一刻存在于请求里。
func AdminListAuthConfig(c *gin.Context) {
	baseURL := requestBaseURL(c)

	ok(c, gin.H{
		"providers": services.OAuthProviderStates(baseURL),
		"smtp":      services.SMTPState(),
		"switches": gin.H{
			"password_login_enabled":    services.GetBoolOption("password_login_enabled", true),
			"password_register_enabled": services.GetBoolOption("password_register_enabled", false),
		},
		"site_base_url": services.GetOption("site_base_url", ""),
		"detected_base_url": baseURL,
	})
}

// AdminUpdateAuthConfig 更新认证配置，需要 option:edit。
func AdminUpdateAuthConfig(c *gin.Context) {
	var req struct {
		Providers []struct {
			Key          string `json:"key"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			Enabled      bool   `json:"enabled"`
		} `json:"providers"`
		SMTP *struct {
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Username string `json:"username"`
			Password string `json:"password"`
			From     string `json:"from"`
			FromName string `json:"from_name"`
			UseTLS   bool   `json:"use_tls"`
			Enabled  bool   `json:"enabled"`
		} `json:"smtp"`
		PasswordLoginEnabled   *bool   `json:"password_login_enabled"`
		PasswordRegisterEnabled *bool  `json:"password_register_enabled"`
		SiteBaseURL            *string `json:"site_base_url"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	// ---- 三方平台 ----
	for _, p := range req.Providers {
		if _, known := oauth.Lookup(p.Key); !known {
			fail(c, http.StatusBadRequest, "不支持的平台："+p.Key, "unknown_provider")
			return
		}

		// 前端展示的是掩码，如果原样提交回来就说明用户没改密钥，
		// 当成「保持原值」处理，避免把 "abcd••••••wxyz" 存成真密钥。
		secret := p.ClientSecret
		if strings.Contains(secret, "•") {
			secret = ""
		}

		if err := services.SaveOAuthProvider(p.Key, p.ClientID, secret, p.Enabled); err != nil {
			fail(c, http.StatusBadRequest, p.Key+"："+err.Error(), "save_failed")
			return
		}
	}

	// ---- SMTP ----
	if req.SMTP != nil {
		password := req.SMTP.Password
		if strings.Contains(password, "•") {
			password = ""
		}

		port := req.SMTP.Port
		if port <= 0 || port > 65535 {
			port = 587
		}

		fromName := strings.TrimSpace(req.SMTP.FromName)
		if fromName == "" {
			fromName = "OOAPI"
		}

		if err := services.SaveSMTP(services.SMTPConfig{
			Host:     strings.TrimSpace(req.SMTP.Host),
			Port:     port,
			Username: strings.TrimSpace(req.SMTP.Username),
			Password: password,
			From:     strings.TrimSpace(req.SMTP.From),
			FromName: fromName,
			UseTLS:   req.SMTP.UseTLS,
		}, req.SMTP.Enabled); err != nil {
			fail(c, http.StatusBadRequest, "邮件设置："+err.Error(), "save_failed")
			return
		}
	}

	// ---- 登录开关 ----
	switches := map[string]string{}
	if req.PasswordLoginEnabled != nil {
		switches["password_login_enabled"] = boolToStr(*req.PasswordLoginEnabled)
	}
	if req.PasswordRegisterEnabled != nil {
		switches["password_register_enabled"] = boolToStr(*req.PasswordRegisterEnabled)
	}
	if len(switches) > 0 {
		if err := services.SetOptions(switches); err != nil {
			fail(c, http.StatusInternalServerError, "保存登录开关失败", "server_error")
			return
		}
	}

	if req.SiteBaseURL != nil {
		base := strings.TrimSpace(*req.SiteBaseURL)
		// 结束斜杠会拼出 //api/auth/... 这种地址，平台侧可能判为不匹配。
		base = strings.TrimRight(base, "/")
		if base != "" && !strings.HasPrefix(base, "http") {
			fail(c, http.StatusBadRequest, "站点地址需以 http:// 或 https:// 开头", "invalid_url")
			return
		}
		if err := services.SetOptions(map[string]string{"site_base_url": base}); err != nil {
			fail(c, http.StatusInternalServerError, "保存站点地址失败", "server_error")
			return
		}
	}

	operator, _ := currentUser(c)
	if operator != nil {
		log.Printf("[admin] %s 更新了认证配置", operator.Username)
	}

	ok(c, gin.H{
		"providers": services.OAuthProviderStates(requestBaseURL(c)),
		"smtp":      services.SMTPState(),
	})
}

// AdminTestSMTP 发一封测试邮件，需要 option:edit。
func AdminTestSMTP(c *gin.Context) {
	var req struct {
		To string `json:"to"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	if strings.TrimSpace(req.To) == "" {
		fail(c, http.StatusBadRequest, "请填写收件邮箱", "bad_request")
		return
	}

	if err := services.TestSMTP(req.To); err != nil {
		log.Printf("[admin] SMTP 测试发信失败: %v", err)
		// 失败原因（端口、认证、证书）必须原样告诉管理员，否则无法排障。
		fail(c, http.StatusBadRequest, err.Error(), "send_failed")
		return
	}

	ok(c, gin.H{"message": "测试邮件已发送，请查收"})
}

// AdminListOAuthBindings 查看当前管理员自己绑定的三方账号，需要登录即可。
// 用于「账号设置」页展示已绑定的平台并支持解绑。
func AdminListOAuthBindings(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	rows, err := queryRows(
		`SELECT provider, provider_username, provider_email, created_at
		 FROM user_oauth WHERE user_id = ? ORDER BY provider`, user.ID,
	)
	if err != nil {
		log.Printf("[oauth] 查询绑定失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询绑定失败", "server_error")
		return
	}
	defer rows.Close()

	type binding struct {
		Provider string `json:"provider"`
		Username string `json:"username"`
		Email    string `json:"email"`
		BoundAt  string `json:"bound_at"`
	}

	out := []binding{}
	for rows.Next() {
		var b binding
		if err := rows.Scan(&b.Provider, &b.Username, &b.Email, &b.BoundAt); err != nil {
			continue
		}
		out = append(out, b)
	}

	ok(c, gin.H{"bindings": out})
}

// UnbindOAuth 解绑某个平台。
//
// 关键防护：不能把最后一个可用登录方式解绑掉 ——
// 否则账号会变成无法登录的死号。判断依据是「是否已设密码 + 是否还有其他绑定」。
func UnbindOAuth(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	provider := strings.TrimSpace(c.Param("provider"))
	if _, known := oauth.Lookup(provider); !known {
		fail(c, http.StatusBadRequest, "不支持的平台", "unknown_provider")
		return
	}

	// 统计该用户还剩几种登录方式
	var otherBindings int
	if err := db.DB.QueryRow(
		"SELECT COUNT(*) FROM user_oauth WHERE user_id = ? AND provider <> ?", user.ID, provider,
	).Scan(&otherBindings); err != nil {
		fail(c, http.StatusInternalServerError, "操作失败", "server_error")
		return
	}

	hasPassword := strings.TrimSpace(user.PasswordHash) != ""
	if !hasPassword && otherBindings == 0 {
		fail(c, http.StatusBadRequest,
			"这是账号唯一的登录方式，请先设置密码再解绑", "last_login_method")
		return
	}

	res, err := exec("DELETE FROM user_oauth WHERE user_id = ? AND provider = ?", user.ID, provider)
	if err != nil {
		log.Printf("[oauth] 解绑失败: %v", err)
		fail(c, http.StatusInternalServerError, "解绑失败", "server_error")
		return
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		fail(c, http.StatusNotFound, "未绑定该平台", "not_bound")
		return
	}

	log.Printf("[oauth] 用户 %s 解绑了 %s", user.Username, provider)
	ok(c, gin.H{"provider": provider})
}

func boolToStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
