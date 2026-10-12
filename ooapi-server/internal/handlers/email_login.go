package handlers

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

// SendEmailCode 发送登录验证码。
//
// 无论邮箱是否存在都返回成功 —— 否则这个接口会变成一个
// 「查询某邮箱是否注册过本站」的探测器。
func SendEmailCode(c *gin.Context) {
	if !services.SMTPAvailable() {
		fail(c, http.StatusForbidden, "本站未开启邮箱验证码登录", "email_code_disabled")
		return
	}

	var req struct {
		Email string `json:"email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	email := strings.TrimSpace(req.Email)
	if err := authz.ValidateEmail(email); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_email")
		return
	}

	if err := services.SendLoginCode(email, c.ClientIP()); err != nil {
		switch {
		case errors.Is(err, services.ErrCodeRateLimited):
			fail(c, http.StatusTooManyRequests, err.Error(), "rate_limited")
		case errors.Is(err, services.ErrEmailCodeDisabled):
			fail(c, http.StatusForbidden, err.Error(), "email_code_disabled")
		default:
			// 发信失败的原因（端口错、认证失败）对管理员排障有用，如实返回。
			log.Printf("[emailcode] 发送失败: %v", err)
			fail(c, http.StatusInternalServerError, err.Error(), "send_failed")
		}
		return
	}

	ok(c, gin.H{"message": "验证码已发送，请查收邮件", "expires_in": 600})
}

// LoginWithEmailCode 用验证码登录。
//
// 已注册邮箱直接登录；未注册邮箱在「开放注册」时自动建号，
// 与三方登录保持同一套策略 —— 邮箱经过验证，可信度等同。
func LoginWithEmailCode(c *gin.Context) {
	if !services.SMTPAvailable() {
		fail(c, http.StatusForbidden, "本站未开启邮箱验证码登录", "email_code_disabled")
		return
	}

	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	email := normalizeEmailForLookup(req.Email)
	if err := authz.ValidateEmail(email); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_email")
		return
	}
	if err := services.AllowAuthAttempt(c.ClientIP(), email); err != nil {
		fail(c, http.StatusTooManyRequests, err.Error(), "rate_limited")
		return
	}

	if err := services.VerifyLoginCode(email, req.Code); err != nil {
		switch {
		case errors.Is(err, services.ErrCodeTooManyTries):
			fail(c, http.StatusTooManyRequests, err.Error(), "too_many_attempts")
		default:
			fail(c, http.StatusBadRequest, err.Error(), "invalid_code")
		}
		return
	}

	// 验证码已通过，下面找账号或建号。
	var (
		id     int64
		role   int
		status int
	)
	err := db.DB.QueryRow(
		"SELECT id, role, status FROM users WHERE email = ? LIMIT 1", email,
	).Scan(&id, &role, &status)

	isNew := false

	if errors.Is(err, sql.ErrNoRows) {
		// 未注册：按注册开关决定是否自动建号。
		if !services.GetBoolOption("password_register_enabled", false) {
			fail(c, http.StatusForbidden, "该邮箱尚未注册，且本站未开放注册", "register_closed")
			return
		}

		user, createErr := createEmailCodeUser(email)
		if createErr != nil {
			log.Printf("[emailcode] 自动建号失败: %v", createErr)
			fail(c, http.StatusInternalServerError, "创建账号失败，请稍后重试", "server_error")
			return
		}
		id, role, status = user.ID, user.Role, user.Status
		isNew = true
	} else if err != nil {
		log.Printf("[emailcode] 查询用户失败: %v", err)
		fail(c, http.StatusInternalServerError, "登录失败，请稍后重试", "server_error")
		return
	} else if status != 1 {
		fail(c, http.StatusForbidden, "账号已被禁用，请联系管理员", "user_disabled")
		return
	}

	// 用邮箱登录意味着该邮箱确实可用，补记验证状态。
	if _, err := db.DB.Exec(
		"UPDATE users SET email_verified = 1, last_login_at = NOW() WHERE id = ?", id,
	); err != nil {
		log.Printf("[emailcode] 更新验证状态失败: %v", err)
	}

	var username string
	if err := db.DB.QueryRow("SELECT username FROM users WHERE id = ?", id).Scan(&username); err != nil {
		log.Printf("[emailcode] 读取用户名失败: %v", err)
		fail(c, http.StatusInternalServerError, "登录失败，请稍后重试", "server_error")
		return
	}

	token, err := issueSessionToken(id, username, role)
	if err != nil {
		log.Printf("[emailcode] 签发令牌失败: %v", err)
		fail(c, http.StatusInternalServerError, "登录失败，请稍后重试", "server_error")
		return
	}

	// 登录审计（type = 5）：新用户首登与老用户登录都记。
	auditLogin(id, c.ClientIP(), c.Request.UserAgent(), "邮箱验证码登录",
		"邮箱 "+email+" 新用户="+strconv.FormatBool(isNew))

	setAuthCookie(c, token)
	log.Printf("[emailcode] %s 通过邮箱验证码登录，新用户=%v", email, isNew)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"is_new": isNew,
			"user": gin.H{
				"id":        id,
				"username":  username,
				"email":     email,
				"role":      role,
				"role_name": authz.ParseRole(role).Name(),
			},
		},
	})
}

// createEmailCodeUser 用邮箱建号。用户名取邮箱 @ 前的部分，冲突时加后缀。
func createEmailCodeUser(email string) (*models.User, error) {
	local := email
	if at := strings.Index(email, "@"); at > 0 {
		local = email[:at]
	}

	base := sanitizeUsername(local)
	if base == "" {
		base = "user"
	}

	username, err := uniqueUsername(base)
	if err != nil {
		return nil, err
	}

	giftOd := services.GetIntOption("quota_for_new_user", 0)
	unitsPerOd := services.GetIntOption("units_per_od", services.DefaultUnitsPerOD)
	quota := int64(giftOd) * int64(unitsPerOd)
	const defaultRole = int(authz.RoleUser)

	res, err := db.DB.Exec(
		`INSERT INTO users (username, display_name, password_hash, email, email_verified, role, status, quota, group_name)
		 VALUES (?, ?, '', ?, 1, ?, 1, ?, ?)`,
		username, username, email, defaultRole, quota, string(authz.DefaultGroup),
	)
	if err != nil {
		return nil, err
	}

	newID, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return loadUserByID(newID)
}
