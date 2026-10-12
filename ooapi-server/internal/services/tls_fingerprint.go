package services

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"

	"ooapi/internal/netguard"
)

/*
TLS 指纹模拟。

背景：上游（订阅型渠道）会按 TLS 握手的特征判断「这是不是官方客户端」。
Go 标准库的 ClientHello 特征非常明显（套件顺序、扩展集合、GREASE 缺失），
与官方 CLI（Node/Rust 实现，底层 BoringSSL/rustls）不同。
账号是管理员自己的、凭据也是自己的，这里只是让出站握手的形状
与官方 CLI 一致，避免被误判成脚本流量。

实现方式：用 uTLS 替换 Transport 的 DialTLSContext，
在明文 TCP 连接上用 uTLS 完成握手，再把握手后的连接交给标准库的 HTTP 客户端。
HTTP 层（头、协议、超时、连接池）全部保持不变 —— 只换握手。

**不做**的事：不伪造 SNI 指向他人域名、不篡改证书校验（仍走系统根证书）、
不改动 HTTP 层语义。也就是说这是「同样的请求、更像官方客户端的握手」，
不是中间人。
*/

// TLSProfile 是一个命名的握手指纹。
type TLSProfile string

const (
	// TLSProfileOff 关闭模拟，使用 Go 标准库默认握手（与从前完全一致）。
	TLSProfileOff TLSProfile = ""
	// TLSProfileChrome 模拟 Chrome 的 ClientHello。
	TLSProfileChrome TLSProfile = "chrome"
	// TLSProfileFirefox 模拟 Firefox 的 ClientHello。
	TLSProfileFirefox TLSProfile = "firefox"
	// TLSProfileSafari 模拟 Safari 的 ClientHello。
	TLSProfileSafari TLSProfile = "safari"
	// TLSProfileEdge 模拟 Edge 的 ClientHello。
	TLSProfileEdge TLSProfile = "edge"
	// TLSProfileRandom 每次握手随机挑一个已实现的指纹（用于降低跨请求的稳定性）。
	TLSProfileRandom TLSProfile = "random"
	// TLSProfileiOS 模拟 iOS 上的 Safari 握手。
	TLSProfileiOS TLSProfile = "ios"
	// TLSProfileAndroid 模拟 Android 上的 Chrome 握手。
	TLSProfileAndroid TLSProfile = "android"
)

// TLSProfileNames 返回所有可用指纹名，供管理端下拉使用。
func TLSProfileNames() []string {
	return []string{
		string(TLSProfileOff),
		string(TLSProfileChrome),
		string(TLSProfileFirefox),
		string(TLSProfileSafari),
		string(TLSProfileEdge),
		string(TLSProfileRandom),
		string(TLSProfileiOS),
		string(TLSProfileAndroid),
	}
}

// ParseTLSProfile 校验并归一指纹名；不认识的返回错误（而不是静默降级成关闭 ——
// 管理员配了个拼错的名字，应该立刻知道，而不是以为生效了）。
func ParseTLSProfile(raw string) (TLSProfile, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return TLSProfileOff, nil
	case string(TLSProfileChrome):
		return TLSProfileChrome, nil
	case string(TLSProfileFirefox):
		return TLSProfileFirefox, nil
	case string(TLSProfileSafari):
		return TLSProfileSafari, nil
	case string(TLSProfileEdge):
		return TLSProfileEdge, nil
	case string(TLSProfileRandom):
		return TLSProfileRandom, nil
	case string(TLSProfileiOS):
		return TLSProfileiOS, nil
	case string(TLSProfileAndroid):
		return TLSProfileAndroid, nil
	default:
		return TLSProfileOff, fmt.Errorf("不支持的 TLS 指纹 %q", raw)
	}
}

// deterministicProfiles 是除 random 之外的具体指纹集合。
var deterministicProfiles = []TLSProfile{
	TLSProfileChrome, TLSProfileFirefox, TLSProfileSafari,
	TLSProfileEdge, TLSProfileiOS, TLSProfileAndroid,
}

var profileSequence struct {
	sync.Mutex
	next int
}

// pickProfile 把命名的指纹映射到 uTLS 的 ClientHelloID。
//
// random 用进程内的轮转而不是真随机：轮转能保证「相邻两个请求用不同指纹」，
// 比真随机更容易出现连续命中同一个（真随机会，轮转不会）。
func pickProfile(p TLSProfile) (utls.ClientHelloID, bool) {
	switch p {
	case TLSProfileChrome:
		return utls.HelloChrome_Auto, true
	case TLSProfileFirefox:
		return utls.HelloFirefox_Auto, true
	case TLSProfileSafari:
		return utls.HelloSafari_Auto, true
	case TLSProfileEdge:
		return utls.HelloEdge_Auto, true
	case TLSProfileiOS:
		return utls.HelloIOS_Auto, true
	case TLSProfileAndroid:
		return utls.HelloAndroid_11_OkHttp, true
	case TLSProfileRandom:
		profileSequence.Lock()
		pick := deterministicProfiles[profileSequence.next%len(deterministicProfiles)]
		profileSequence.next++
		profileSequence.Unlock()
		switch pick {
		case TLSProfileChrome:
			return utls.HelloChrome_Auto, true
		case TLSProfileFirefox:
			return utls.HelloFirefox_Auto, true
		case TLSProfileSafari:
			return utls.HelloSafari_Auto, true
		case TLSProfileEdge:
			return utls.HelloEdge_Auto, true
		case TLSProfileiOS:
			return utls.HelloIOS_Auto, true
		default:
			return utls.HelloAndroid_11_OkHttp, true
		}
	default:
		return utls.ClientHelloID{}, false
	}
}

// tlsFingerprintTransports 缓存「指纹 → Transport」。
//
// Transport 复用连接池，因此同一账号的多次请求会复用已建立的 TLS 连接 ——
// 每个请求都重新握手反而更像脚本行为。键是指纹名。
var tlsFingerprintTransports = struct {
	sync.Mutex
	m map[TLSProfile]*http.Transport
}{m: map[TLSProfile]*http.Transport{}}

// tlsDialer 抽象出实际拨号，测试可替换。
var tlsDialer = func(ctx context.Context, network, addr string, cfg *tls.Config, profile utls.ClientHelloID) (net.Conn, error) {
	raw, err := netguard.DialPublic(ctx, network, addr)
	if err != nil {
		return nil, err
	}

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	uconn := utls.UClient(raw, &utls.Config{
		ServerName:         host,
		RootCAs:            cfg.RootCAs,
		InsecureSkipVerify: cfg.InsecureSkipVerify,
		MinVersion:         cfg.MinVersion,
	}, profile)

	if err := uconn.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return uconn, nil
}

// TLSFingerprintTransport 返回配置了指纹的 Transport；profile 为空时返回 nil
// （调用方继续用默认传输，行为与从前完全一致）。
func TLSFingerprintTransport(profile TLSProfile) *http.Transport {
	if profile == TLSProfileOff {
		return nil
	}
	hello, ok := pickProfile(profile)
	if !ok {
		return nil
	}

	// random 不缓存：每次请求都该在不同指纹之间轮转，缓存住就退化成固定值。
	if profile != TLSProfileRandom {
		tlsFingerprintTransports.Lock()
		if rt, found := tlsFingerprintTransports.m[profile]; found {
			tlsFingerprintTransports.Unlock()
			return rt
		}
		tlsFingerprintTransports.Unlock()
	}

	rt := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           netguard.DialPublic,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// 关键：用 uTLS 完成握手，HTTP 语义仍在标准库手里。
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// 传进来的 cfg 里已经有 ServerName 与证书校验设置（由标准库填好）。
			cfg := &tls.Config{}
			return tlsDialer(ctx, network, addr, cfg, hello)
		},
	}
	// ForceAttemptHTTP2 保持 false：ALPN 由 uTLS 的指纹决定，
	// 开着会在 h2 协商成功后改变可见特征。

	if profile != TLSProfileRandom {
		tlsFingerprintTransports.Lock()
		tlsFingerprintTransports.m[profile] = rt
		tlsFingerprintTransports.Unlock()
	}
	return rt
}

// ResetTLSFingerprintTransports 清空缓存（测试与配置变更时用）。
func ResetTLSFingerprintTransports() {
	tlsFingerprintTransports.Lock()
	tlsFingerprintTransports.m = map[TLSProfile]*http.Transport{}
	tlsFingerprintTransports.Unlock()
}
