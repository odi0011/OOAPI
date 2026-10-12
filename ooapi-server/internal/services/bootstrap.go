package services

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"

	"ooapi/internal/auth"
	"ooapi/internal/authz"
	"ooapi/internal/db"
)

// defaultAdminUsername 是没配 ADMIN_USERNAME 时的兜底用户名。
// 用 root 而不是随机串：管理员一眼能认出这是初始超管、还没改过名。
const defaultAdminUsername = "root"

// EnsureDefaultAdmin 在首次启动时创建超管账号。
//
// 只在「不存在 role >= RoleAdmin 的用户」时执行，之后启动会跳过，
// 因此管理员改过密码不会被覆盖回默认值。
//
// 用户名可配置（ADMIN_USERNAME）：站点所有者习惯用哪个名字登录是他自己的事，
// 而写死 'root' 会让每次全新部署都要手工改名（部署脚本与文档也得跟着撒谎）。
func EnsureDefaultAdmin(configuredUsername, configuredPassword string) error {
	var count int
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM users WHERE role >= ?", int(authz.RoleAdmin)).Scan(&count); err != nil {
		return fmt.Errorf("检查管理员: %w", err)
	}
	if count > 0 {
		return nil
	}

	username := strings.TrimSpace(configuredUsername)
	if username == "" {
		username = defaultAdminUsername
	}

	password := configuredPassword
	generated := false
	if password == "" {
		buf := make([]byte, 12)
		if _, err := rand.Read(buf); err != nil {
			return fmt.Errorf("生成管理员密码: %w", err)
		}
		password = hex.EncodeToString(buf)
		generated = true
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return fmt.Errorf("生成管理员密码哈希: %w", err)
	}

	if _, err := db.DB.Exec(
		`INSERT INTO users (username, display_name, password_hash, role, status, quota, group_name)
		 VALUES (?, ?, ?, ?, 1, 0, ?)`,
		username, username, hash, int(authz.RoleRoot), string(authz.DefaultGroup),
	); err != nil {
		return fmt.Errorf("创建管理员: %w", err)
	}

	if generated {
		// 随机密码写入 0600 文件，日志里只给出路径，不打印密码本身。
		const path = ".admin-password"
		if err := os.WriteFile(path, []byte(password), 0o600); err != nil {
			log.Printf("[init] 已创建超管 %s，但密码写入 %s 失败: %v", username, path, err)
			return nil
		}
		log.Printf("[init] 已创建超管 %s；随机密码已写入 %s（0600）。登录后请立即改密并删除该文件。", username, path)
	} else {
		log.Printf("[init] 已创建超管 %s（密码来自 ADMIN_PASSWORD 环境变量）", username)
	}

	return nil
}
