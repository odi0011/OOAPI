package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/models"
)

// 上下文键名，供 handler 读取当前身份。
const (
	CtxUserKey = "ooapi_user"
	CtxRoleKey = "ooapi_role"
)

// RequireAuth 校验访问令牌并加载用户。
//
// 关键点：权限以「数据库当前状态」为准，而不是令牌里签发的角色。
// 否则用户被降级或禁用后，其尚未过期的令牌仍能访问管理接口。
func RequireAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := ExtractToken(c)
		if raw == "" {
			abort(c, http.StatusUnauthorized, "未登录或缺少访问令牌", "unauthorized")
			return
		}

		claims, err := auth.Parse(secret, raw)
		if err != nil {
			abort(c, http.StatusUnauthorized, "登录状态已失效，请重新登录", "unauthorized")
			return
		}

		disabled, ok := bindClaims(c, claims)
		if disabled {
			abort(c, http.StatusForbidden, "账号已被禁用", "user_disabled")
			return
		}
		if !ok {
			abort(c, http.StatusUnauthorized, "登录状态已失效，请重新登录", "unauthorized")
			return
		}
		c.Next()
	}
}

// RequirePermission 按能力点拦截。
// 所有管理类接口都必须挂这里，不要在 handler 里用角色数值直接比较 ——
// 那样权限调整时要改多处，容易漏。
func RequirePermission(perms ...authz.Permission) gin.HandlerFunc {
	return func(c *gin.Context) {
		role, ok := CurrentRole(c)
		if !ok {
			abort(c, http.StatusUnauthorized, "未登录", "unauthorized")
			return
		}

		if !authz.CanAny(role, perms...) {
			abort(c, http.StatusForbidden, "没有执行该操作的权限", "forbidden")
			return
		}
		c.Next()
	}
}

// OptionalAuth 有令牌就解析，没有也放行。
// 用于首页状态、个人主页等匿名可见但登录后内容更多的接口。
func OptionalAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := ExtractToken(c)
		if raw == "" {
			return
		}

		claims, err := auth.Parse(secret, raw)
		if err != nil {
			return
		}

		_, _ = bindClaims(c, claims)
	}
}

// bindClaims 加载用户并核对会话版本。版本不一致说明已经退出或改过密码。
// disabled 为真时账号存在但已禁用，调用方应返回 403 而不是「未登录」。
func bindClaims(c *gin.Context, claims *auth.Claims) (disabled, ok bool) {
	user, err := loadUser(claims.UserID)
	if err != nil || !claims.MatchesSession(user.SessionVersion) {
		return false, false
	}
	if user.Status != 1 {
		return true, false
	}
	c.Set(CtxUserKey, user)
	c.Set(CtxRoleKey, authz.ParseRole(user.Role))
	return false, true
}

// ExtractToken 依次尝试 Authorization 头与 cookie。
// Bearer 之外的写法（如裸令牌）不被接受，避免误用。
func ExtractToken(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); h != "" {
		if after, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(after)
		}
		return ""
	}
	if v, err := c.Cookie("ooapi_token"); err == nil {
		return strings.TrimSpace(v)
	}
	return ""
}

func loadUser(id int64) (*models.User, error) {
	var u models.User
	err := db.DB.QueryRow(
		`SELECT id, username, display_name, password_hash, email, role, status,
		        quota, used_quota, group_name, created_at, updated_at, last_login_at,
		        avatar_url, session_version
		 FROM users WHERE id = ?`, id,
	).Scan(
		&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Email, &u.Role, &u.Status,
		&u.Quota, &u.UsedQuota, &u.GroupName, &u.CreatedAt, &u.UpdatedAt, &u.LastLoginAt,
		&u.AvatarURL, &u.SessionVersion,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CurrentUser 返回已登录用户；未登录时第二个返回值为 false。
func CurrentUser(c *gin.Context) (*models.User, bool) {
	v, ok := c.Get(CtxUserKey)
	if !ok {
		return nil, false
	}
	u, ok := v.(*models.User)
	return u, ok
}

func CurrentRole(c *gin.Context) (authz.Role, bool) {
	v, ok := c.Get(CtxRoleKey)
	if !ok {
		return authz.RoleGuest, false
	}
	r, ok := v.(authz.Role)
	return r, ok
}

// abort 统一错误响应结构，前端只认这一种形状。
func abort(c *gin.Context, status int, message, code string) {
	c.AbortWithStatusJSON(status, gin.H{
		"success": false,
		"error": gin.H{
			"message": message,
			"code":    code,
		},
	})
}
