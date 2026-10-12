package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/authz"
	"ooapi/internal/db"
)

// UpdateProfile 修改自己的资料。
// 只允许改展示名、邮箱与个人简介类字段 —— 角色、额度、状态属于管理操作，
// 绝不能由用户通过这个接口传入。
func UpdateProfile(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var req struct {
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
		Bio         string `json:"bio"`
		Website     string `json:"website"`
		Location    string `json:"location"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	displayName := strings.TrimSpace(req.DisplayName)
	if len([]rune(displayName)) > 32 {
		fail(c, http.StatusBadRequest, "昵称最长 32 个字符", "invalid_display_name")
		return
	}
	if displayName == "" {
		displayName = user.Username
	}

	email := strings.TrimSpace(req.Email)
	if email != "" {
		if err := authz.ValidateEmail(email); err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_email")
			return
		}
		// 邮箱唯一性：换绑时排除自己。
		var taken int
		if err := db.DB.QueryRow("SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?", email, user.ID).Scan(&taken); err != nil {
			fail(c, http.StatusInternalServerError, "保存失败，请稍后重试", "server_error")
			return
		}
		if taken > 0 {
			fail(c, http.StatusConflict, "该邮箱已被其他账号使用", "email_taken")
			return
		}
	}

	// 简介允许多行（换行原样保留，只去首尾空白），限 255 字符。
	bio := strings.TrimSpace(req.Bio)
	if utf8.RuneCountInString(bio) > 255 {
		fail(c, http.StatusBadRequest, "个人简介最长 255 个字符", "invalid_bio")
		return
	}

	// 个人网站仅在非空时校验，且只允许 http/https —— 挡住 javascript: 之类
	// 挂在前端 <a href> 上会执行的伪协议。
	website := strings.TrimSpace(req.Website)
	if website != "" {
		u, err := url.Parse(website)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			fail(c, http.StatusBadRequest, "个人网站必须是以 http:// 或 https:// 开头的地址", "invalid_website")
			return
		}
	}
	if utf8.RuneCountInString(website) > 255 {
		fail(c, http.StatusBadRequest, "个人网站最长 255 个字符", "invalid_website")
		return
	}

	location := strings.TrimSpace(req.Location)
	if utf8.RuneCountInString(location) > 64 {
		fail(c, http.StatusBadRequest, "所在地最长 64 个字符", "invalid_location")
		return
	}

	// 空串即清空对应字段（前端传空 = 用户主动清除）。
	if _, err := db.DB.Exec(
		"UPDATE users SET display_name = ?, email = ?, bio = ?, website = ?, location = ? WHERE id = ?",
		displayName, email, bio, website, location, user.ID,
	); err != nil {
		log.Printf("[profile] 更新失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存失败，请稍后重试", "server_error")
		return
	}

	ok(c, gin.H{
		"display_name": displayName,
		"email":        email,
		"bio":          bio,
		"website":      website,
		"location":     location,
	})
}

// UserProfile 返回当前登录用户的完整资料（个人资料页用）。
//
// 单独开一个接口而不是扩展 /api/auth/me：me 由认证链路维护（可能被其它
// 代理改动），资料页需要的字段（bio/website/location/头像/配额）在这里一次取齐。
func UserProfile(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var (
		username, displayName, email string
		bio, website, location       string
		avatarURL, groupName         string
		avatarMediaID                int64
		quota, usedQuota             int64
	)
	err := db.DB.QueryRow(
		`SELECT username, display_name, email, bio, website, location,
		        avatar_url, avatar_media_id, group_name, quota, used_quota
		   FROM users WHERE id = ?`, user.ID,
	).Scan(&username, &displayName, &email, &bio, &website, &location,
		&avatarURL, &avatarMediaID, &groupName, &quota, &usedQuota)
	if err == sql.ErrNoRows {
		fail(c, http.StatusNotFound, "用户不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[profile] 查询资料失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}

	// 自定义头像：URL 里带 media id 作为版本号，换头像即换 URL。
	if avatarURL == "" && avatarMediaID > 0 {
		avatarURL = "/api/media/avatar/" + strconv.FormatInt(user.ID, 10) +
			"?v=" + strconv.FormatInt(avatarMediaID, 10)
	}

	roleName := ""
	if role, okRole := currentRole(c); okRole {
		roleName = role.Name()
	} else {
		roleName = authz.ParseRole(user.Role).Name()
	}

	ok(c, gin.H{
		"username":     username,
		"display_name": displayName,
		"email":        email,
		"bio":          bio,
		"website":      website,
		"location":     location,
		"avatar_url":   avatarURL,
		"quota":        quota,
		"used_quota":   usedQuota,
		"group_name":   groupName,
		"role_name":    roleName,
	})
}

// ChangePassword 修改自己的密码。
// 必须校验原密码：否则令牌泄露后可直接改密夺号。
func ChangePassword(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	var hash string
	if err := db.DB.QueryRow("SELECT password_hash FROM users WHERE id = ?", user.ID).Scan(&hash); err != nil {
		fail(c, http.StatusInternalServerError, "操作失败，请稍后重试", "server_error")
		return
	}

	if !auth.VerifyPassword(hash, req.OldPassword) {
		fail(c, http.StatusBadRequest, "原密码不正确", "wrong_password")
		return
	}

	if err := authz.ValidatePassword(req.NewPassword); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_password")
		return
	}

	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		fail(c, http.StatusInternalServerError, "操作失败，请稍后重试", "server_error")
		return
	}

	if _, err := db.DB.Exec(
		"UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?",
		newHash, user.ID,
	); err != nil {
		log.Printf("[profile] 修改密码失败: %v", err)
		fail(c, http.StatusInternalServerError, "操作失败，请稍后重试", "server_error")
		return
	}

	// 改密后抬高会话版本并清 cookie，旧 Bearer 与旧 cookie 一起失效。
	clearAuthCookie(c)
	ok(c, gin.H{"message": "密码已修改，请重新登录"})
}
