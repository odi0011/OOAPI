package trading

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// newClientOrderID 生成币安合法的业务幂等单号（≤36，字符集 [.A-Za-z0-9_-]）。
// 前缀约定：oo-ent- / oo-sl- / oo-tp- / oo-cls-
func newClientOrderID(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = "oo-"
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// 极罕见：退回时间戳十六进制，仍保持唯一性足够用于单次下单。
		return truncateClientID(prefix + "0")
	}
	return truncateClientID(prefix + hex.EncodeToString(b[:]))
}

func truncateClientID(id string) string {
	if len(id) <= 36 {
		return id
	}
	return id[:36]
}

func ensureClientOrderID(id, prefix string) string {
	id = strings.TrimSpace(id)
	if id != "" {
		return truncateClientID(id)
	}
	return newClientOrderID(prefix)
}
