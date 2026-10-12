package cryptoutil

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

// 加密后的密文带一个前缀，便于识别「已加密」与「历史明文」，
// 这样升级过程中老数据仍能读取，不会因为解密失败而丢掉配置。
const cipherPrefix = "enc:v1:"

var ErrNotEncrypted = errors.New("内容不是本模块加密的格式")

// deriveKey 从主密钥派生出一个固定的 32 字节 AES 密钥。
//
// 用 SHA-256 而不是直接截断：主密钥长度不定，直接截断会丢熵。
// 加盐串是为了让这个用途的密钥与其它用途（如 JWT 签名）即使共用主密钥也互不影响。
func deriveKey(master string) [32]byte {
	return sha256.Sum256([]byte("ooapi-secret-store-v1|" + master))
}

// Encrypt 加密敏感配置（如三方登录的 Client Secret、SMTP 密码）。
//
// 用 AES-256-GCM：带认证标签，密文被篡改时解密会失败而不是返回错误数据。
// 每次调用都用新的随机 nonce —— nonce 复用会直接摧毁 GCM 的安全性。
func Encrypt(master, plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	key := deriveKey(master)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("创建加密块: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建 GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("生成 nonce: %w", err)
	}

	// nonce 前置到密文，解密时再切出来。
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return cipherPrefix + base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt 解密。对未加密的历史数据原样返回，
// 这样即便某些配置是在引入加密前写入的，也不会突然读取失败。
func Decrypt(master, stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if !strings.HasPrefix(stored, cipherPrefix) {
		return stored, nil
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, cipherPrefix))
	if err != nil {
		return "", fmt.Errorf("解码密文: %w", err)
	}

	key := deriveKey(master)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("创建加密块: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("创建 GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", errors.New("密文长度不足")
	}

	plaintext, err := gcm.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return "", errors.New("解密失败（主密钥可能已更换）")
	}
	return string(plaintext), nil
}

// IsEncrypted 判断某个值是否已加密，用于管理端展示「是否已配置」而不暴露内容。
func IsEncrypted(v string) bool {
	return strings.HasPrefix(v, cipherPrefix)
}

// MaskSecret 给管理端展示用的掩码，只保留首尾少量字符。
// 绝不返回完整密钥 —— 管理页面同样可能被旁观或截图。
func MaskSecret(v string) string {
	if v == "" {
		return ""
	}
	if len(v) <= 8 {
		return "••••••••"
	}
	return v[:4] + "••••••••" + v[len(v)-4:]
}
