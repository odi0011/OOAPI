package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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
	ErrBadScheme  = errors.New("只支持 http 与 https 地址")
	ErrHasCreds   = errors.New("地址中不允许携带用户名或密码")
	ErrPrivateIP  = errors.New("该地址指向内网，出于安全考虑已拒绝")
	ErrBadHost    = errors.New("地址格式不正确")
	ErrLookupFail = errors.New("域名解析失败")
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

// allowLoopback 只给测试里的 httptest 服务器放行回环地址。
// 生产路径保持 false：127.0.0.1 与 ::1 仍然算内网。
var allowLoopback atomic.Bool

// SetAllowLoopbackForTest 在测试中放行回环地址。元数据与私网网段不受影响。
func SetAllowLoopbackForTest(on bool) { allowLoopback.Store(on) }

// IsPrivateIP 判断是否为私有/保留地址。
func IsPrivateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if allowLoopback.Load() && ip.IsLoopback() {
		return false
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
//
// 命中时连同当时校验过的公网 IP 一起返回。转发拨号必须钉在这些 IP 上，
// 不能再做一次解析 —— 否则检查与拨号之间 DNS 被改到内网（重绑定）就能绕过。
type cacheEntry struct {
	ips []net.IP
	err error
	exp time.Time
}

var (
	cacheMu sync.RWMutex
	cache   = map[string]cacheEntry{}

	// lookupIP 与 dialFn 抽出来是为了测试能替换解析与拨号，
	// 不必真的连到公网或元数据地址。
	lookupIP = net.LookupIP
	dialFn   = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
	}
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
	if _, err := resolvePublic(host); err != nil {
		return nil, err
	}
	return u, nil
}

// resolvePublic 返回已确认的公网 IP。结果（含 IP 列表）按主机缓存。
func resolvePublic(host string) ([]net.IP, error) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil, ErrBadHost
	}

	cacheMu.RLock()
	hit, found := cache[host]
	cacheMu.RUnlock()
	if found && time.Now().Before(hit.exp) {
		if hit.err != nil {
			return nil, hit.err
		}
		return append([]net.IP(nil), hit.ips...), nil
	}

	ips, err := lookupPublic(host)

	cacheMu.Lock()
	if err == nil {
		cache[host] = cacheEntry{ips: append([]net.IP(nil), ips...), exp: time.Now().Add(okTTL)}
	} else {
		cache[host] = cacheEntry{err: err, exp: time.Now().Add(badTTL)}
	}
	cacheMu.Unlock()

	if err != nil {
		return nil, err
	}
	return ips, nil
}

func lookupPublic(host string) ([]net.IP, error) {
	// 直接给 IP 的地址：跳过 DNS，直接判断。
	if ip := net.ParseIP(host); ip != nil {
		if IsPrivateIP(ip) {
			return nil, ErrPrivateIP
		}
		return []net.IP{ip}, nil
	}

	addrs, err := lookupIP(host)
	if err != nil {
		return nil, fmt.Errorf("%w：%s", ErrLookupFail, host)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%w：%s", ErrLookupFail, host)
	}

	// 任何一个解析结果落在内网就整体拒绝：攻击者可以用一个域名
	// 同时解析到公网与内网 IP，只检查第一个会被绕过。
	out := make([]net.IP, 0, len(addrs))
	for _, ip := range addrs {
		if IsPrivateIP(ip) {
			return nil, fmt.Errorf("%w（%s）", ErrPrivateIP, ip)
		}
		out = append(out, ip)
	}
	return out, nil
}

// DialPublic 只拨号到已经校验过的公网 IP。
//
// addr 是标准库传入的 host:port。这里不再把主机名交给系统解析器，
// 而是拨 resolvePublic 返回的那组 IP —— 保存时的 netguard 检查挡不住
// 转发当下的 DNS 重绑定，必须在拨号这一步钉死。
func DialPublic(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, ErrBadHost
	}
	ips, err := resolvePublic(host)
	if err != nil {
		return nil, err
	}

	var first error
	for _, ip := range ips {
		conn, dialErr := dialFn(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		if first == nil {
			first = dialErr
		}
	}
	if first == nil {
		first = ErrLookupFail
	}
	return nil, first
}

// CheckRedirect 在跟随重定向之前再验一次目标。
// 上游 302 到 169.254.169.254 或内网时必须停住，不能沿用「保存时地址是公网」的结论。
func CheckRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("重定向次数过多")
	}
	if req == nil || req.URL == nil {
		return ErrBadHost
	}
	if _, err := AssertPublicURL(req.URL.String()); err != nil {
		return err
	}
	return nil
}

// PublicTransport 是带公网拨号钉扎的传输。克隆默认传输，只替换拨号。
func PublicTransport() *http.Transport {
	var t *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok && base != nil {
		t = base.Clone()
	} else {
		t = &http.Transport{}
	}
	t.DialContext = DialPublic
	return t
}

// ClearCache 清空缓存。账号地址变更时调用，避免旧结果继续生效。
func ClearCache() {
	cacheMu.Lock()
	cache = map[string]cacheEntry{}
	cacheMu.Unlock()
}
