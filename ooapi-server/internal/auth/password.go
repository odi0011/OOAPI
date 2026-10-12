package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// bcrypt 代价因子。12 在现代 CPU 上约 200–300ms，
// 足以让离线爆破变贵，又不至于拖慢正常登录。
const bcryptCost = 12

var (
	ErrUserExists     = errors.New("该用户名已被注册")
	ErrEmailExists    = errors.New("该邮箱已被注册")
	ErrUserNotFound   = errors.New("用户不存在或密码错误")
	ErrUserDisabled   = errors.New("账号已被禁用")
	ErrRegisterClosed = errors.New("本站暂未开放注册")
)

// HashPassword 生成密码哈希。绝不存明文，也不使用可逆加密。
func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("生成密码哈希: %w", err)
	}
	return string(b), nil
}

// VerifyPassword 校验密码。bcrypt 自带恒定时间比较，无需额外处理。
func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// NewAPIKey 生成对外令牌，形如 sk-xxxx。
// 只在创建时完整返回一次，数据库存全文以便校验（与密码不同，令牌需要可查）。
func NewAPIKey() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成令牌: %w", err)
	}
	return "sk-" + hex.EncodeToString(buf), nil
}

// MaskAPIKey 用于列表展示：只露头尾，中间打码。
// 避免管理页面被旁观时泄露他人密钥。
func MaskAPIKey(key string) string {
	if len(key) <= 12 {
		return "sk-****"
	}
	return key[:7] + "****" + key[len(key)-4:]
}

// IsValidAPIKeyShape 在数据库查询前先做形状校验，
// 避免把明显非法的输入带进查询。
func IsValidAPIKeyShape(key string) bool {
	return strings.HasPrefix(key, "sk-") && len(key) == 51
}
