package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config 保存服务运行所需的全部配置。
// 敏感项（数据库密码、JWT 密钥）一律来自环境变量，不写死在代码里。
type Config struct {
	Port       string
	DBHost     string
	DBPort     string
	DBUser     string
	DBPassword string
	DBName     string
	JWTSecret  string
	// AdminUsername 是首次启动时创建的超管用户名（ADMIN_USERNAME，默认 root）。
	AdminUsername string
	AdminPassword string
	WebDir        string
}

func Load() *Config {
	// .env 存在则加载；不存在时全部走环境变量或默认值。
	if err := godotenv.Load(); err != nil {
		log.Printf("[config] 未找到 .env，使用环境变量与默认值")
	}

	c := &Config{
		Port:          getenv("PORT", "3001"),
		DBHost:        getenv("DB_HOST", "127.0.0.1"),
		DBPort:        getenv("DB_PORT", "3306"),
		DBUser:        getenv("DB_USER", "ooapi"),
		DBPassword:    os.Getenv("DB_PASSWORD"),
		DBName:        getenv("DB_NAME", "ooapi"),
		JWTSecret:     os.Getenv("JWT_SECRET"),
		AdminUsername: getenv("ADMIN_USERNAME", "root"),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"),
		WebDir:        getenv("WEB_DIR", "./web"),
	}

	if c.JWTSecret == "" {
		c.JWTSecret = loadOrCreateSecret(".jwt-secret")
	}

	return c
}

// DSN 返回 MySQL 连接串。parseTime 与字符集是必须的，
// 否则时间字段会以 []byte 形式返回、中文会乱码。
func (c *Config) DSN() string {
	return fmt.Sprintf(
		"%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=true&loc=Local&collation=utf8mb4_unicode_ci",
		c.DBUser, c.DBPassword, c.DBHost, c.DBPort, c.DBName,
	)
}

func getenv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// loadOrCreateSecret 读取本地密钥文件，不存在则生成随机密钥并落盘（0600）。
// 密钥文件不能提交到仓库，否则线上令牌可被伪造。
func loadOrCreateSecret(path string) string {
	if b, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("[config] 生成 JWT 密钥失败: %v", err)
	}
	secret := hex.EncodeToString(buf)

	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		log.Printf("[config] 密钥写入 %s 失败（将仅保存在内存中）: %v", path, err)
	} else {
		log.Printf("[config] 已生成 JWT 密钥并写入 %s（0600，请勿提交）", path)
	}
	return secret
}

// AtoiOr 用于解析可选数值配置，解析失败时回退默认值。
func AtoiOr(s string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return fallback
}
