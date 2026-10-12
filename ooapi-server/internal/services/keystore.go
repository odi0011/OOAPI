package services

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"strings"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

// 用户密钥与渠道 API Key 的落库加密。
//
// 与三方登录 / SMTP 同一条 AES-GCM 路径（cryptoutil）：随机 nonce、带认证标签。
// 密文不可用于等值查找，所以用户密钥另存一份 HMAC，网关鉴权走 key_hash。
// 历史明文没有 enc:v1: 前缀，Decrypt 会原样返回，启动时再补加密。

// SealTokenKey 加密一把用户 API Key，并给出用于查找的摘要。
func SealTokenKey(plain string) (stored, hash string, err error) {
	plain = strings.TrimSpace(plain)
	if plain == "" {
		return "", "", errors.New("空密钥")
	}
	stored, err = cryptoutil.Encrypt(JWTSecret(), plain)
	if err != nil {
		return "", "", err
	}
	return stored, TokenKeyHash(plain), nil
}

// OpenTokenKey 还原用户 API Key。未加密的历史值原样返回。
func OpenTokenKey(stored string) (string, error) {
	return cryptoutil.Decrypt(JWTSecret(), strings.TrimSpace(stored))
}

// TokenKeyHash 是鉴权查找用的摘要。密钥本身高熵，摘要只为等值匹配，
// 域分隔避免和别的 HMAC 用途撞车。
func TokenKeyHash(plain string) string {
	mac := hmac.New(sha256.New, []byte("ooapi-token-key-v1|"+JWTSecret()))
	_, _ = mac.Write([]byte(strings.TrimSpace(plain)))
	return hex.EncodeToString(mac.Sum(nil))
}

// SealChannelAPIKey 加密渠道上的真实 API Key。
// 多行（多 key）逐行处理。内部标识（ooapi-*-channel-*）不是密钥，保持明文，
// 否则传输层认不出该走哪套加密凭据。
func SealChannelAPIKey(raw string) (string, error) {
	lines := splitKeyLines(raw)
	if len(lines) == 0 {
		return "", nil
	}
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if cryptoutil.IsEncrypted(line) || IsDeviceCredentialMarker(line) {
			out = append(out, line)
			continue
		}
		enc, err := cryptoutil.Encrypt(JWTSecret(), line)
		if err != nil {
			return "", err
		}
		out = append(out, enc)
	}
	return strings.Join(out, "\n"), nil
}

// OpenChannelAPIKey 还原渠道密钥。解密失败的行丢掉，绝不把密文当密钥发出去。
func OpenChannelAPIKey(stored string) string {
	lines := splitKeyLines(stored)
	if len(lines) == 0 {
		return ""
	}
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		plain, err := cryptoutil.Decrypt(JWTSecret(), line)
		if err != nil {
			log.Printf("[keystore] 解密渠道密钥失败: %v", err)
			continue
		}
		if plain != "" {
			out = append(out, plain)
		}
	}
	return strings.Join(out, "\n")
}

func splitKeyLines(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	out := []string{}
	for _, line := range strings.Split(raw, "\n") {
		if v := strings.TrimSpace(line); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// MigratePlaintextSecrets 把仍以明文落库的用户密钥和渠道 API Key 补加密。
// 启动时跑一次；单行失败只记日志，不挡住进程。
func MigratePlaintextSecrets() {
	if db.DB == nil || JWTSecret() == "" {
		return
	}
	migrateTokenKeys()
	migrateChannelKeys()
}

func migrateTokenKeys() {
	rows, err := db.DB.Query(
		`SELECT id, api_key FROM tokens WHERE api_key <> '' AND api_key NOT LIKE 'enc:v1:%'`,
	)
	if err != nil {
		log.Printf("[keystore] 扫描明文用户密钥失败: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id    int64
			plain string
		)
		if err := rows.Scan(&id, &plain); err != nil {
			continue
		}
		stored, hash, err := SealTokenKey(plain)
		if err != nil {
			log.Printf("[keystore] 加密用户密钥 %d 失败: %v", id, err)
			continue
		}
		if _, err := db.DB.Exec(
			`UPDATE tokens SET api_key = ?, key_hash = ? WHERE id = ? AND api_key = ?`,
			stored, hash, id, plain,
		); err != nil {
			log.Printf("[keystore] 回写用户密钥 %d 失败: %v", id, err)
		}
	}
}

func migrateChannelKeys() {
	rows, err := db.DB.Query(
		`SELECT id, api_key FROM channels WHERE api_key <> '' AND api_key NOT LIKE 'enc:v1:%'`,
	)
	if err != nil {
		log.Printf("[keystore] 扫描明文渠道密钥失败: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id  int64
			raw string
		)
		if err := rows.Scan(&id, &raw); err != nil {
			continue
		}
		sealed, err := SealChannelAPIKey(raw)
		if err != nil {
			log.Printf("[keystore] 加密渠道密钥 %d 失败: %v", id, err)
			continue
		}
		if sealed == raw {
			continue
		}
		if _, err := db.DB.Exec(
			`UPDATE channels SET api_key = ? WHERE id = ? AND api_key = ?`,
			sealed, id, raw,
		); err != nil {
			log.Printf("[keystore] 回写渠道密钥 %d 失败: %v", id, err)
		}
	}
}
