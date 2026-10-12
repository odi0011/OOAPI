package netguard

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// 上游地址校验。
//
// 为什么必须有：账号的 base_url 由管理员填写，而「从上游拉取模型」等接口
// 会真的去请求这个地址。若不校验，管理员（或拿到管理员权限的人）可以把地址
// 指向内网服务或云厂商元数据端点（169.254.169.254），借站点的服务器去探测
// 内部网络 —— 这类攻击叫 SSRF（服务端请求伪造）。
//
// 校验分三层：
//   1. 协议白名单（只允许 http/https）
//   2. 禁止携带凭据（http://user:pass@host）
//   3. 域名解析后逐个 IP 检查，任何一个是私有地址就拒绝

var (
	ErrBadScheme   = errors.New("只支持 http 与 https 地址")
	ErrHasCreds    = errors.New("地址中不允许携带用户名或密码")
	ErrPrivateIP   = errors.New("该地址指向内网，出于安全考虑已拒绝")
	ErrBadHost     = errors.New("地址格式不正确")
	ErrLookupFail  = errors.New("域名解析失败")
)

// 私有与保留网段。覆盖 IPv4 与 IPv6。
var blockedNets = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8",          // 本网络
		"10.0.0.0/8",         // 私有
		"100.64.0.0/10",      // 运营商级 NAT
		"127.0.0.0/8",        // 环回
		"169.254.0.0/16",     // 链路本地（含云元数据 169.254.169.254）
		"172.16.0.0/12",      // 私有
		"192.0.0.0/24",       // IETF 协议分配
		"192.0.2.0/24",       // 文档用
		"192.168.0.0/16",     // 私有
		"198.18.0.0/15",      // 基准测试
		"198.51.100.0/24",    // 文档用
		"203.0.113.0/24",     // 文档用
		"224.0.0.0/4",        // 组播
		"240.0.0.0/4",        // 保留
		"255.255.255.255/32", // 广播
		// IPv6
		"::/128",    // 未指定
		"::1/128",   // 环回
		"fc00::/7",  // 唯一本地
		"fe80::/10", // 链路本地
		"ff00::/8",  // 组播
		/*
			刻意不把 "::ffff:0:0/96"（IPv4 映射网段）放进列表。

			它涵盖整个 IPv4 空间（::ffff:a.b.c.d 对任意 a.b.c.d），
			而 IsPrivateIP 会先把 IPv4 转成 4 字节再比较 ——
			此时 8.8.8.8 也会落进这个网段，导致**所有公网地址被误判为内网**。
			这是实测踩到的：api.openai.com 解析到 Cloudflare 的 162.159.140.245
			被拒绝，账号根本建不出来。

			IPv4 映射地址的安全性由「先 To4() 转回 IPv4 再判断」保证：
			::ffff:10.0.0.1 会被转成 10.0.0.1，然后被上面的 10.0.0.0/8 拦住。
		*/
	}

	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// IsPrivateIP 判断是否为私有/保留地址。
func IsPrivateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}

	/*
		IPv4 映射地址（::ffff:10.0.0.1）与 IPv4 兼容地址（::10.0.0.1）
		必须先取回 4 字节形式再判断，否则会绕过 IPv4 的网段检查 ——
		攻击者可以用 ::ffff:169.254.169.254 访问云元数据端点。

		同时保留原始形式做一次判断：某些保留网段只在 IPv6 侧定义
		（如 ::/128、fc00::/7），转成 4 字节后就匹配不到了。
	*/
	forms := []net.IP{ip}
	if v4 := ip.To4(); v4 != nil {
		forms = []net.IP{v4, ip}
	}

	for _, n := range blockedNets {
		for _, f := range forms {
			if n.Contains(f) {
				return true
			}
		}
	}
	return false
}

// 解析结果缓存。
//
// 为什么需要：对话请求若每次都做 DNS 解析会加一段真实 RTT（走线程池，
// 不命中系统缓存时尤其明显）。账号地址由管理员配置、变化极慢，
// 缓存 60 秒既省掉这段延迟，又能在 DNS 被改成内网时最迟一分钟后失效。
//
// 失败结果缓存更短（10 秒），避免坏域名拖慢每一次请求。
type cacheEntry struct {
	ok  bool
	err error
	exp time.Time
}

var (
	cacheMu sync.RWMutex
	cache   = map[string]cacheEntry{}
)

const (
	okTTL  = 60 * time.Second
	badTTL = 10 * time.Second
)

// AssertPublicURL 校验地址是否可安全访问。
//
// 先做不依赖 DNS 的静态检查（快，且能立刻拦住带凭据的地址），
// 再解析域名并逐个检查 IP。
func AssertPublicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, ErrBadHost
	}

	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, ErrBadScheme
	}
	if u.User != nil {
		return nil, ErrHasCreds
	}

	host := strings.ToLower(u.Hostname())

	cacheMu.RLock()
	hit, found := cache[host]
	cacheMu.RUnlock()
	if found && time.Now().Before(hit.exp) {
		if hit.ok {
			return u, nil
		}
		return nil, hit.err
	}

	err = lookupAndCheck(host)

	cacheMu.Lock()
	if err == nil {
		cache[host] = cacheEntry{ok: true, exp: time.Now().Add(okTTL)}
	} else {
		cache[host] = cacheEntry{ok: false, err: err, exp: time.Now().Add(badTTL)}
	}
	cacheMu.Unlock()

	if err != nil {
		return nil, err
	}
	return u, nil
}

func lookupAndCheck(host string) error {
	// 直接给 IP 的地址：跳过 DNS，直接判断。
	if ip := net.ParseIP(host); ip != nil {
		if IsPrivateIP(ip) {
			return ErrPrivateIP
		}
		return nil
	}

	addrs, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("%w：%s", ErrLookupFail, host)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("%w：%s", ErrLookupFail, host)
	}

	// 任何一个解析结果落在内网就整体拒绝：攻击者可以用一个域名
	// 同时解析到公网与内网 IP，只检查第一个会被绕过。
	for _, ip := range addrs {
		if IsPrivateIP(ip) {
			return fmt.Errorf("%w（%s）", ErrPrivateIP, ip)
		}
	}
	return nil
}

// ClearCache 清空缓存。账号地址变更时调用，避免旧结果继续生效。
func ClearCache() {
	cacheMu.Lock()
	cache = map[string]cacheEntry{}
	cacheMu.Unlock()
}
