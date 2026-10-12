package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/db"
)

/*
行为审计日志。

logs 表里 type = 1（管理操作）与 type = 5（登录）的记录是审计条目：
谁、什么时候、从哪里、对什么做了什么。它们与调用日志共用一张表，
这样「操作日志」页面能在一个时间线上看到「改了什么」与「谁登了进来」。

写入失败绝不阻断业务：审计是为了事后追溯，
不该因为它写不进去就让管理员的操作失败。
*/
func auditLog(c *gin.Context, action, detail string) {
	user, okUser := currentUser(c)
	if !okUser {
		return
	}
	writeAuditLog(user.ID, LogTypeAdmin, 0, c.ClientIP(), c.Request.UserAgent(), action, detail)
}

// auditLogQuota 额度变动审计：多带一个变动值。
// 操作日志页的「额度变动」列读的就是 quota 字段 —— 不写它，
// 用户看到「调整了额度」却看不到调了多少，审计就失去意义。
func auditLogQuota(c *gin.Context, action, detail string, quota int64) {
	user, okUser := currentUser(c)
	if !okUser {
		return
	}
	writeAuditLog(user.ID, LogTypeAdmin, quota, c.ClientIP(), c.Request.UserAgent(), action, detail)
}

// auditLogin 登录审计（type = 5）。
//
// 登录接口是匿名的，拿不到 currentUser，所以由调用方传入用户与来源信息。
func auditLogin(userID int64, ip, userAgent, action, detail string) {
	if userID <= 0 {
		return
	}
	writeAuditLog(userID, LogTypeLogin, 0, ip, userAgent, action, detail)
}

// writeAuditLog 写一条行为审计。失败只记服务端日志，绝不影响业务动作。
func writeAuditLog(userID int64, logType int, quota int64, ip, userAgent, action, detail string) {
	userAgent = sanitizeCallerUserAgent(userAgent)
	if _, err := db.DB.Exec(
		`INSERT INTO logs (user_id, token_id, channel_id, type, model,
		                   prompt_tokens, completion_tokens, cached_tokens,
		                   quota, latency_ms, ip, user_agent, caller_client, detail)
		 VALUES (?, 0, 0, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?, ?)`,
		userID, logType, truncate(action, 120), quota,
		truncate(ip, 64), userAgent, callerClientFromUserAgent(userAgent), truncate(detail, 480),
	); err != nil {
		log.Printf("[audit] 写入审计日志失败: %v", err)
	}
}

// randomHex 生成 n 字节的随机十六进制串。
// 用于给 Responses / Anthropic 协议里的 id 字段凑出唯一值 ——
// 那些 id 由网关生成（上游的 id 格式不同），客户端只要求它们稳定且唯一。
func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
