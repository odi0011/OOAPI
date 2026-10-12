package handlers

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

type registerRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Register 注册新用户。
// 注册开关、初始额度与默认角色都由系统设置驱动，不在代码里写死。
func Register(c *gin.Context) {
	if !services.GetBoolOption("password_register_enabled", false) {
		fail(c, http.StatusForbidden, "本站暂未开放注册", "register_closed")
		return
	}

	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	username := authz.NormalizeUsername(req.Username)
	if err := authz.ValidateUsername(username); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_username")
		return
	}
	if err := authz.ValidatePassword(req.Password); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_password")
		return
	}

	email := strings.TrimSpace(req.Email)
	if email != "" {
		if err := authz.ValidateEmail(email); err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_email")
			return
		}
	}

	// 先查重再插入。唯一索引是最终防线，这里的查询是为了给出可读提示。
	var exists int
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM users WHERE username = ?", username).Scan(&exists); err != nil {
		log.Printf("[register] 查询用户名失败: %v", err)
		fail(c, http.StatusInternalServerError, "注册失败，请稍后重试", "server_error")
		return
	}
	if exists > 0 {
		fail(c, http.StatusConflict, "该用户名已被注册", "username_taken")
		return
	}

	if email != "" {
		if err := db.DB.QueryRow("SELECT COUNT(*) FROM users WHERE email = ?", email).Scan(&exists); err != nil {
			log.Printf("[register] 查询邮箱失败: %v", err)
			fail(c, http.StatusInternalServerError, "注册失败，请稍后重试", "server_error")
			return
		}
		if exists > 0 {
			fail(c, http.StatusConflict, "该邮箱已被注册", "email_taken")
			return
		}
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		log.Printf("[register] 生成密码哈希失败: %v", err)
		fail(c, http.StatusInternalServerError, "注册失败，请稍后重试", "server_error")
		return
	}

	// 新用户额度：后台「新用户赠送额度」按 OD 币填写，这里换算成单位。
	giftOd := services.GetIntOption("quota_for_new_user", 0)
	unitsPerOd := services.GetIntOption("units_per_od", services.DefaultUnitsPerOD)
	quota := int64(giftOd) * int64(unitsPerOd)

	// 角色固定为普通用户。注册接口绝不能接受请求体里的角色字段，
	// 否则任何人都能直接把自己注册成管理员。
	const defaultRole = int(authz.RoleUser)

	res, err := db.DB.Exec(
		`INSERT INTO users (username, display_name, password_hash, email, role, status, quota, group_name)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		username, username, hash, email, defaultRole, quota, string(authz.DefaultGroup),
	)
	if err != nil {
		// 唯一索引冲突（并发注册同名）也走这里。
		if isDuplicateKey(err) {
			fail(c, http.StatusConflict, "该用户名或邮箱已被注册", "already_taken")
			return
		}
		log.Printf("[register] 插入用户失败: %v", err)
		fail(c, http.StatusInternalServerError, "注册失败，请稍后重试", "server_error")
		return
	}

	uid, _ := res.LastInsertId()
	token, err := auth.Issue(services.JWTSecret(), uid, username, defaultRole)
	if err != nil {
		log.Printf("[register] 签发令牌失败: %v", err)
		fail(c, http.StatusInternalServerError, "注册成功但登录失败，请手动登录", "server_error")
		return
	}

	setAuthCookie(c, token)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"token": token,
			"user": gin.H{
				"id":         uid,
				"username":   username,
				"role":       defaultRole,
				"role_name":  authz.RoleUser.Name(),
				"quota":      quota,
				"group_name": string(authz.DefaultGroup),
			},
		},
	})
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Login 密码登录。
// 用户名不存在与密码错误返回同一提示，避免被用来枚举账号。
func Login(c *gin.Context) {
	if !services.GetBoolOption("password_login_enabled", true) {
		fail(c, http.StatusForbidden, "本站已关闭密码登录", "login_closed")
		return
	}

	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	username := authz.NormalizeUsername(req.Username)
	if username == "" || req.Password == "" {
		fail(c, http.StatusBadRequest, "请填写用户名与密码", "bad_request")
		return
	}

	var (
		id       int64
		hash     string
		role     int
		status   int
		quota    int64
		group    string
		display  string
		email    string
	)
	err := db.DB.QueryRow(
		`SELECT id, password_hash, role, status, quota, group_name, display_name, email
		 FROM users WHERE username = ?`, username,
	).Scan(&id, &hash, &role, &status, &quota, &group, &display, &email)

	if errors.Is(err, sql.ErrNoRows) {
		// 依然走一次哈希计算，抹平「用户不存在」与「密码错误」的响应时间差。
		auth.VerifyPassword("$2a$12$eImiTXuWVxfM37uY4JANjQ.j.9QOCJjLKVjT1uKPz.WpAFqUcJ3EK", req.Password)
		fail(c, http.StatusUnauthorized, "用户名或密码错误", "invalid_credentials")
		return
	}
	if err != nil {
		log.Printf("[login] 查询用户失败: %v", err)
		fail(c, http.StatusInternalServerError, "登录失败，请稍后重试", "server_error")
		return
	}

	if !auth.VerifyPassword(hash, req.Password) {
		fail(c, http.StatusUnauthorized, "用户名或密码错误", "invalid_credentials")
		return
	}

	if status != 1 {
		fail(c, http.StatusForbidden, "账号已被禁用，请联系管理员", "user_disabled")
		return
	}

	r := authz.ParseRole(role)
	token, err := auth.Issue(services.JWTSecret(), id, username, role)
	if err != nil {
		log.Printf("[login] 签发令牌失败: %v", err)
		fail(c, http.StatusInternalServerError, "登录失败，请稍后重试", "server_error")
		return
	}

	if _, err := db.DB.Exec("UPDATE users SET last_login_at = ? WHERE id = ?", time.Now(), id); err != nil {
		// 登录时间只用于展示，写失败不影响本次登录。
		log.Printf("[login] 更新登录时间失败: %v", err)
	}

	// 登录审计：操作日志页靠它回答「谁在什么时候从哪里登了进来」。
	auditLogin(id, c.ClientIP(), c.Request.UserAgent(), "密码登录", "用户名 "+username)

	setAuthCookie(c, token)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"token": token,
			"user": gin.H{
				"id":           id,
				"username":     username,
				"display_name": display,
				"email":        email,
				"role":         role,
				"role_name":    r.Name(),
				"quota":        quota,
				"group_name":   group,
				"permissions":  authz.PermissionsOf(r),
			},
		},
	})
}

// Logout 清除 cookie。
// JWT 无状态，服务端无法单方面吊销；真正的失效靠短有效期与改密后重新签发。
func Logout(c *gin.Context) {
	c.SetCookie("ooapi_token", "", -1, "/", "", true, true)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// Me 返回当前登录用户及其能力点列表，前端据此渲染菜单。
func Me(c *gin.Context) {
	role, ok := currentRole(c)
	if !ok {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	user, ok := currentUser(c)
	if !ok {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":           user.ID,
			"username":     user.Username,
			"display_name": user.DisplayName,
			"email":        user.Email,
			"role":         int(role),
			"role_name":    role.Name(),
			"quota":        user.Quota,
			"used_quota":   user.UsedQuota,
			"group_name":   user.GroupName,
			"permissions":  authz.PermissionsOf(role),
			"created_at":   user.CreatedAt,
			"last_login_at": user.LastLoginAt,
			"avatar_url":   user.AvatarURL,
		},
	})
}

// setAuthCookie 写 HttpOnly cookie。
// 前端也可用响应里的 token 走 Authorization 头；cookie 是为了刷新后仍保持登录。
func setAuthCookie(c *gin.Context, token string) {
	secure := c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https"
	maxAge := int(auth.AccessTokenTTL.Seconds())
	c.SetCookie("ooapi_token", token, maxAge, "/", "", secure, true)
}

func isDuplicateKey(err error) bool {
	s := err.Error()
	return strings.Contains(s, "Duplicate entry") || strings.Contains(s, "1062")
}
