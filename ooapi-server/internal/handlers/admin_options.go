package handlers

import (
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/db"
	"ooapi/internal/services"
)

// AdminListOptions 读取系统设置，需要 option:view。
// 返回全部键值，敏感项（如各类密钥）在写入时就应避免存入 options 表。
func AdminListOptions(c *gin.Context) {
	rows, err := queryRows("SELECT key_name, value FROM options")
	if err != nil {
		log.Printf("[admin/options] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取设置失败", "server_error")
		return
	}
	defer rows.Close()

	values := gin.H{}
	for rows.Next() {
		var k string
		var v *string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		if v != nil {
			values[k] = *v
		} else {
			values[k] = ""
		}
	}

	ok(c, gin.H{"options": values})
}

// 允许通过接口修改的设置项白名单。
// 未列入的键一律忽略 —— 防止接口被用来写入任意配置。
//
// 注意：三方登录密钥、SMTP 密码等敏感项不走这里，
// 它们由 admin_auth.go 的专用接口写入并加密，避免被通用配置接口连带改坏。
var editableOptions = map[string]struct{}{
	"system_name":               {},
	"logo":                      {},
	"api_endpoint":              {},
	"password_register_enabled": {},
	"password_login_enabled":    {},
	"currency_name":             {},
	"units_per_od":              {},
	"quota_for_new_user":        {},
	"request_timeout_ms":        {},
	"site_base_url":             {},
}

// boolOptions 列出需要按布尔语义校验的键，避免写入 "flase" 这类错值后
// 被当成真值使用。
var boolOptions = map[string]struct{}{
	"password_register_enabled": {},
	"password_login_enabled":    {},
}

// AdminUpdateOptions 批量更新设置，需要 option:edit。
func AdminUpdateOptions(c *gin.Context) {
	var req map[string]string
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	filtered := map[string]string{}
	for k, v := range req {
		if _, allowed := editableOptions[k]; !allowed {
			continue
		}

		val := strings.TrimSpace(v)

		if _, isBool := boolOptions[k]; isBool {
			lower := strings.ToLower(val)
			if lower != "true" && lower != "false" {
				fail(c, http.StatusBadRequest, "设置项 "+k+" 只能是 true 或 false", "invalid_value")
				return
			}
			val = lower
		}

		filtered[k] = val
	}

	if len(filtered) == 0 {
		fail(c, http.StatusBadRequest, "没有可更新的设置项", "nothing_to_update")
		return
	}

	if err := services.SetOptions(filtered); err != nil {
		log.Printf("[admin/options] 更新失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存设置失败", "server_error")
		return
	}

	ok(c, gin.H{"updated": len(filtered)})
}

// 保留 db 引用，确保本文件与其它 handler 共用同一连接池。
var _ = db.DB
