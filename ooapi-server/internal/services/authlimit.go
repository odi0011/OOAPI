package services

import (
	"errors"
	"strings"
	"sync"
	"time"
)

// 登录与注册的尝试次数限制。
//
// 密码登录每次都要跑 bcrypt，不限速时可以拿接口做在线爆破，
// 也能把 CPU 打满。按 IP 与账号（用户名或邮箱）各记一笔，
// 窗口内超过上限直接拒绝，不再查库、不再验密码。

var ErrAuthRateLimited = errors.New("尝试过于频繁，请稍后再试")

const (
	authLimitWindow = 10 * time.Minute
	authIPLimit     = 30
	authIdentLimit  = 10
)

type authBucket struct {
	window []time.Time
}

var (
	authLimitMu sync.Mutex
	authBuckets = map[string]*authBucket{}
)

// AllowAuthAttempt 登记一次登录或注册尝试。
// identities 是用户名或邮箱，可空（只按 IP 限制）。超限返回 ErrAuthRateLimited。
func AllowAuthAttempt(ip string, identities ...string) error {
	authLimitMu.Lock()
	defer authLimitMu.Unlock()

	now := time.Now()
	ip = strings.TrimSpace(ip)
	if ip != "" && !allowAuthBucket("ip:"+ip, authIPLimit, now) {
		return ErrAuthRateLimited
	}
	for _, identity := range identities {
		identity = strings.ToLower(strings.TrimSpace(identity))
		if identity != "" && !allowAuthBucket("id:"+identity, authIdentLimit, now) {
			return ErrAuthRateLimited
		}
	}
	return nil
}

func allowAuthBucket(key string, max int, now time.Time) bool {
	b := authBuckets[key]
	if b == nil {
		b = &authBucket{}
		authBuckets[key] = b
	}
	cut := now.Add(-authLimitWindow)
	kept := b.window[:0]
	for _, ts := range b.window {
		if ts.After(cut) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= max {
		b.window = kept
		return false
	}
	b.window = append(kept, now)
	return true
}

// ResetAuthAttempts 清空计数，仅供测试。
func ResetAuthAttempts() {
	authLimitMu.Lock()
	authBuckets = map[string]*authBucket{}
	authLimitMu.Unlock()
}
