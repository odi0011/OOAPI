package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
)

// fail 输出统一错误结构，与 middleware.abort 保持同一形状，
// 前端只需处理一种错误格式。
func fail(c *gin.Context, status int, message, code string) {
	c.JSON(status, gin.H{
		"success": false,
		"error": gin.H{
			"message": message,
			"code":    code,
		},
	})
}

func ok(c *gin.Context, data any) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// currentUser 取当前登录用户，由 RequireAuth 写入。
func currentUser(c *gin.Context) (*models.User, bool) {
	return middleware.CurrentUser(c)
}

// currentRole 取当前角色。权限判断一律用能力点而非角色数值，
// 这里只在需要展示角色名或做数据归属过滤时使用。
func currentRole(c *gin.Context) (authz.Role, bool) {
	return middleware.CurrentRole(c)
}

// normalizeModelList 接受一批模型名，统一小写、去空白、去重后返回。
//
// 必须统一大小写：模型白名单是逐字符比较的，
// GPT-4 与 gpt-4 会被当成两个不同的模型，从而绕过白名单。
func normalizeModelList(models []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, m := range models {
		v := strings.ToLower(strings.TrimSpace(m))
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
