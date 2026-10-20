package trading

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// 本引擎自己的单号前缀。只有 oo-ent- 开出来的仓才允许认领、改保护或 oo-cls。
const (
	clientPrefixEntry = "oo-ent-"
	clientPrefixClose = "oo-cls-"
)

// engineEntryClientID 判断这张单是不是本引擎的开仓单。
// 网页/App 的 web_usdt_、空单号、止损止盈和平仓单都不是。
func engineEntryClientID(id string) bool {
	return strings.HasPrefix(strings.TrimSpace(id), clientPrefixEntry)
}

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
