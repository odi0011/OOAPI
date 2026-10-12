package handlers

import (
	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// PublicAuthProviders 返回登录/注册页可用的登录方式。
//
// 只暴露「有哪些方式」，不含任何 Client ID 或密钥 ——
// 前端只需要知道显示哪些按钮、跳哪个地址。
func PublicAuthProviders(c *gin.Context) {
	baseURL := requestBaseURL(c)

	ok(c, gin.H{
		"oauth":              services.EnabledOAuthProviders(baseURL),
		"email_code_enabled": services.SMTPAvailable(),
		"password_enabled":   services.GetBoolOption("password_login_enabled", true),
		"register_enabled":   services.GetBoolOption("password_register_enabled", false),
	})
}
