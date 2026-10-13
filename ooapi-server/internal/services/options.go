package services

import (
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"ooapi/internal/db"
)

// 系统设置项默认值。改这里的默认值只影响尚未写入 options 表的键。
//
// 注意：三方登录密钥、SMTP 密码等敏感项不在此列 ——
// 它们由 authconfig.go 单独管理并加密存储，避免被通用设置接口连带覆盖。
var optionDefaults = map[string]string{
	"system_name":               "OOAPI",
	"logo":                      "/logo.jpg",
	"api_endpoint":              "",
	"password_register_enabled": "false",
	"password_login_enabled":    "true",
	"currency_name":             "OD币",
	"units_per_od":              "10000",
	"quota_for_new_user":        "0",
	"request_timeout_ms":        "600000",
	// 设置页「更新」。默认关，避免未经确认就改运行中的代码。
	"system_auto_update": "false",
	// 站点对外地址，用于拼 OAuth 回调地址。
	// 留空则按请求头推导，但线上经反代时建议显式配置。
	"site_base_url": "",
}

type optionCache struct {
	mu     sync.RWMutex
	values map[string]string
	loaded time.Time
	ttl    time.Duration
}

var cache = &optionCache{ttl: 10 * time.Second}

// GetOption 读取系统设置，逐级回退：缓存 → 数据库 → 默认值。
// 设置值即时生效，但为降低每次请求的查询压力，这里做 10 秒缓存。
func GetOption(key, fallback string) string {
	cache.mu.RLock()
	if cache.values != nil && time.Since(cache.loaded) < cache.ttl {
		if v, ok := cache.values[key]; ok && v != "" {
			cache.mu.RUnlock()
			return v
		}
		cache.mu.RUnlock()
		if _, ok := cache.values[key]; ok {
			return fallback
		}
		return fallback
	}
	cache.mu.RUnlock()

	reload()

	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if v, ok := cache.values[key]; ok && v != "" {
		return v
	}
	if def, ok := optionDefaults[key]; ok {
		return def
	}
	return fallback
}

// GetBoolOption 把设置值按布尔解析。
// 必须走这里而不是直接判断字符串非空 —— "false" 在 Go 里同样是非空字符串。
func GetBoolOption(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(GetOption(key, "")))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	return fallback
}

func GetIntOption(key string, fallback int) int {
	raw := strings.TrimSpace(GetOption(key, ""))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

// GetFloatOption 解析小数值设置。用于兑换比例这类带小数的配置。
func GetFloatOption(key string, fallback float64) float64 {
	raw := strings.TrimSpace(GetOption(key, ""))
	if raw == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return f
}

func reload() {
	values := map[string]string{}
	if db.DB != nil {
		rows, err := db.DB.Query("SELECT key_name, value FROM options")
		if err != nil {
			log.Printf("[options] 读取设置失败: %v", err)
		} else {
			defer rows.Close()
			for rows.Next() {
				var k string
				var v *string
				if err := rows.Scan(&k, &v); err != nil {
					continue
				}
				if v != nil {
					values[k] = *v
				}
			}
		}
	}

	cache.mu.Lock()
	cache.values = values
	cache.loaded = time.Now()
	cache.mu.Unlock()
}

// SetOptions 批量写入设置并立即失效缓存，改完马上生效。
func SetOptions(kv map[string]string) error {
	if len(kv) == 0 {
		return nil
	}

	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for k, v := range kv {
		if _, err := tx.Exec(
			"INSERT INTO options (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
			k, v,
		); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	cache.mu.Lock()
	cache.loaded = time.Time{}
	cache.mu.Unlock()
	return nil
}

// allOptionsWithPrefix 返回所有以 prefix 开头的设置项（副本）。
//
// 用于「一批同前缀的配置」这类场景（如模型映射表）：
// 键名本身带信息，不需要再建一张表。
func allOptionsWithPrefix(prefix string) map[string]string {
	if db.DB == nil {
		return map[string]string{}
	}
	rows, err := db.DB.Query("SELECT key_name, value FROM options WHERE key_name LIKE ?", prefix+"%")
	if err != nil {
		log.Printf("[options] 按前缀读取设置失败: %v", err)
		return map[string]string{}
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k string
		var v *string
		if err := rows.Scan(&k, &v); err != nil || v == nil {
			continue
		}
		out[k] = *v
	}
	return out
}

// deleteOptionsWithPrefix 删除所有以 prefix 开头的设置项。
//
// 用在「整表替换」的写入路径上：先删旧项再写新项，
// 否则被管理员移除的条目会永远留在库里继续生效。
func deleteOptionsWithPrefix(prefix string) error {
	if db.DB == nil {
		return nil
	}
	if _, err := db.DB.Exec("DELETE FROM options WHERE key_name LIKE ?", prefix+"%"); err != nil {
		return err
	}
	cache.mu.Lock()
	cache.loaded = time.Time{}
	cache.mu.Unlock()
	return nil
}
