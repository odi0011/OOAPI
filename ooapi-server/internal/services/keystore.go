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

// keystoreLogf 是迁移日志出口。测试替换它，避免抢全局 logger。
var keystoreLogf = log.Printf

// secretMigrateStats 是一轮迁移的计数。已迁移指本轮写库成功的行。
type secretMigrateStats struct {
	scanned  int
	migrated int
	skipped  int
	failed   int
}

func (s secretMigrateStats) log(label string) {
	keystoreLogf("[keystore] %s迁移: 扫描 %d，已迁移 %d，跳过 %d，失败 %d",
		label, s.scanned, s.migrated, s.skipped, s.failed)
}

// MigratePlaintextSecrets 把仍以明文落库的用户密钥和渠道 API Key 补加密。
//
// 进程启动时跑（schema 补列之后）。可以重复执行：已经是 enc:v1: 且用户密钥
// 摘要齐全的行不会再写。单行失败只记日志并计入失败数，不挡住进程，也不动其余行。
// 回写带上原来的 api_key 条件，写到一半或和其他写入撞车时不会盖掉新值。
// 失败留下的明文仍能走网关的「空摘要 + 明文相等」查找，下一轮启动再试。
func MigratePlaintextSecrets() {
	if db.DB == nil || JWTSecret() == "" {
		keystoreLogf("[keystore] 跳过明文密钥迁移: 数据库或主密钥未就绪")
		return
	}
	migrateTokenKeys().log("用户密钥")
	migrateChannelKeys().log("渠道密钥")
}

// 用户密钥不能只看「是否以 enc:v1: 开头」：前导空格会让前缀判断失效，
// 空的 key_hash 会让网关对不上摘要。渠道密钥同理，首行已加密时后面仍可能是明文。
const migrateTokenQuery = `
SELECT id, api_key, key_hash
FROM tokens
WHERE api_key <> ''`

const migrateChannelQuery = `
SELECT id, api_key
FROM channels
WHERE api_key <> ''`

const migrateTokenUpdate = `
UPDATE tokens
SET api_key = ?, key_hash = ?
WHERE id = ? AND api_key = ?`

const migrateChannelUpdate = `
UPDATE channels
SET api_key = ?
WHERE id = ? AND api_key = ?`

func migrateTokenKeys() secretMigrateStats {
	var stats secretMigrateStats
	rows, err := db.DB.Query(migrateTokenQuery)
	if err != nil {
		keystoreLogf("[keystore] 扫描用户密钥失败: %v", err)
		stats.failed++
		return stats
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id      int64
			apiKey  string
			keyHash string
		)
		if err := rows.Scan(&id, &apiKey, &keyHash); err != nil {
			stats.failed++
			keystoreLogf("[keystore] 读取用户密钥行失败: %v", err)
			continue
		}
		stats.scanned++
		stored, hash, rewrite, err := planTokenMigration(apiKey, keyHash)
		if err != nil {
			stats.failed++
			keystoreLogf("[keystore] 加密用户密钥 %d 失败: %v", id, err)
			continue
		}
		if !rewrite {
			stats.skipped++
			continue
		}
		updated, err := applyKeyUpdate(migrateTokenUpdate, stored, hash, id, apiKey)
		if err != nil {
			stats.failed++
			keystoreLogf("[keystore] 回写用户密钥 %d 失败: %v", id, err)
			continue
		}
		if !updated {
			stats.skipped++
			keystoreLogf("[keystore] 用户密钥 %d 未改写（内容已变化）", id)
			continue
		}
		stats.migrated++
	}
	if err := rows.Err(); err != nil {
		stats.failed++
		keystoreLogf("[keystore] 遍历用户密钥失败: %v", err)
	}
	return stats
}

// planTokenMigration 决定这一行要不要写回。
// rewrite 为 false 时 stored/hash 仍是目标形态，调用方不要写库。
func planTokenMigration(apiKey, keyHash string) (stored, hash string, rewrite bool, err error) {
	trimmed := strings.TrimSpace(apiKey)
	hash = strings.TrimSpace(keyHash)
	if trimmed == "" {
		return "", "", false, nil
	}
	if !cryptoutil.IsEncrypted(trimmed) {
		stored, hash, err = SealTokenKey(trimmed)
		if err != nil {
			return "", "", false, err
		}
		return stored, hash, true, nil
	}

	plain, err := cryptoutil.Decrypt(JWTSecret(), trimmed)
	if err != nil {
		return "", "", false, err
	}
	plain = strings.TrimSpace(plain)
	if plain == "" {
		return "", "", false, errors.New("解密结果为空")
	}
	// 前导空格曾让「已加密」判断失效，旧迁移会把密文再加密一遍。
	// 只剥一层，剥完仍是密文就停，避免主密钥不对时把行写坏。
	if cryptoutil.IsEncrypted(plain) {
		inner, err := cryptoutil.Decrypt(JWTSecret(), plain)
		if err != nil {
			return "", "", false, err
		}
		inner = strings.TrimSpace(inner)
		if inner == "" || cryptoutil.IsEncrypted(inner) {
			return "", "", false, errors.New("密钥被重复加密，无法安全还原")
		}
		stored, hash, err = SealTokenKey(inner)
		if err != nil {
			return "", "", false, err
		}
		return stored, hash, true, nil
	}

	want := TokenKeyHash(plain)
	if hash == want && trimmed == apiKey {
		return trimmed, hash, false, nil
	}
	return trimmed, want, true, nil
}

func migrateChannelKeys() secretMigrateStats {
	var stats secretMigrateStats
	rows, err := db.DB.Query(migrateChannelQuery)
	if err != nil {
		keystoreLogf("[keystore] 扫描渠道密钥失败: %v", err)
		stats.failed++
		return stats
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id  int64
			raw string
		)
		if err := rows.Scan(&id, &raw); err != nil {
			stats.failed++
			keystoreLogf("[keystore] 读取渠道密钥行失败: %v", err)
			continue
		}
		stats.scanned++
		if strings.TrimSpace(raw) == "" {
			stats.skipped++
			continue
		}
		sealed, rewrite, err := planChannelMigration(raw)
		if err != nil {
			stats.failed++
			keystoreLogf("[keystore] 加密渠道密钥 %d 失败: %v", id, err)
			continue
		}
		if !rewrite {
			stats.skipped++
			continue
		}
		updated, err := applyKeyUpdate(migrateChannelUpdate, sealed, id, raw)
		if err != nil {
			stats.failed++
			keystoreLogf("[keystore] 回写渠道密钥 %d 失败: %v", id, err)
			continue
		}
		if !updated {
			stats.skipped++
			keystoreLogf("[keystore] 渠道密钥 %d 未改写（内容已变化）", id)
			continue
		}
		stats.migrated++
	}
	if err := rows.Err(); err != nil {
		stats.failed++
		keystoreLogf("[keystore] 遍历渠道密钥失败: %v", err)
	}
	return stats
}

// planChannelMigration 加密仍是明文的密钥行。内部标识保持原样。
// 已封存的行 Seal 结果与原值相同（nonce 不会重滚），因此重复启动不会改写。
func planChannelMigration(raw string) (sealed string, rewrite bool, err error) {
	sealed, err = SealChannelAPIKey(raw)
	if err != nil {
		return "", false, err
	}
	if sealed == "" || sealed == raw {
		return sealed, false, nil
	}
	return sealed, true, nil
}

// applyKeyUpdate 执行带原值条件的更新。affected == 0 不算失败：行已经被别人改过。
func applyKeyUpdate(query string, args ...any) (bool, error) {
	res, err := db.DB.Exec(query, args...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
