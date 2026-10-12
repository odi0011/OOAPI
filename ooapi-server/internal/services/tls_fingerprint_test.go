package services

import (
	"testing"
)

/*
TLS 指纹的单元测试。

这里**不**去验证「指纹长得像不像 Chrome」—— 那需要抓包比对 ClientHello 字节，
单元测试做不到，也不该用一个「看起来对」的断言冒充。可测的只有：
名字解析、未知值被拒、缓存行为、以及关闭时确实不启用。
*/

func TestParseTLSProfile(t *testing.T) {
	cases := []struct {
		in      string
		want    TLSProfile
		wantErr bool
	}{
		{"", TLSProfileOff, false},
		{"  ", TLSProfileOff, false},
		{"chrome", TLSProfileChrome, false},
		{"Chrome", TLSProfileChrome, false},
		{" CHROME ", TLSProfileChrome, false},
		{"firefox", TLSProfileFirefox, false},
		{"safari", TLSProfileSafari, false},
		{"edge", TLSProfileEdge, false},
		{"random", TLSProfileRandom, false},
		{"ios", TLSProfileiOS, false},
		{"android", TLSProfileAndroid, false},
		// 拼错的名字必须报错：静默降级成「没有指纹」会让管理员
		// 以为生效了，实际一直在裸连 —— 那比不支持更糟。
		{"chrom", TLSProfileOff, true},
		{"chorme", TLSProfileOff, true},
		{"curl", TLSProfileOff, true},
		{"1.2.3", TLSProfileOff, true},
	}
	for _, tc := range cases {
		got, err := ParseTLSProfile(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("ParseTLSProfile(%q) 应当报错，却返回 %q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ParseTLSProfile(%q) 意外报错: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("ParseTLSProfile(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestTLSProfileNamesCoversAllValues(t *testing.T) {
	names := TLSProfileNames()
	seen := map[TLSProfile]bool{}
	for _, n := range names {
		profile, err := ParseTLSProfile(n)
		if err != nil {
			t.Fatalf("TLSProfileNames 里的 %q 无法解析: %v", n, err)
		}
		if seen[profile] {
			t.Fatalf("TLSProfileNames 重复列出 %q", n)
		}
		seen[profile] = true
	}
	for _, want := range []TLSProfile{
		TLSProfileOff, TLSProfileChrome, TLSProfileFirefox, TLSProfileSafari,
		TLSProfileEdge, TLSProfileRandom, TLSProfileiOS, TLSProfileAndroid,
	} {
		if !seen[want] {
			t.Fatalf("TLSProfileNames 缺少 %q", want)
		}
	}
}

func TestTLSFingerprintTransportOffReturnsNil(t *testing.T) {
	// 关闭时返回 nil，调用方继续走共享客户端 —— 行为与从前完全一致。
	if rt := TLSFingerprintTransport(TLSProfileOff); rt != nil {
		t.Fatal("关闭指纹时应返回 nil，让调用方沿用默认传输")
	}
}

func TestTLSFingerprintTransportCachesDeterministicProfiles(t *testing.T) {
	ResetTLSFingerprintTransports()
	defer ResetTLSFingerprintTransports()

	// 固定指纹复用同一个 Transport（复用连接池；每请求重新握手更像脚本行为）。
	a := TLSFingerprintTransport(TLSProfileChrome)
	b := TLSFingerprintTransport(TLSProfileChrome)
	if a == nil || b == nil {
		t.Fatal("固定指纹应当返回可用的 Transport")
	}
	if a != b {
		t.Fatal("同一固定指纹应复用同一个 Transport（连接池要共享）")
	}

	// random 不缓存：缓存住就退化成固定值，失去轮转的意义。
	r1 := TLSFingerprintTransport(TLSProfileRandom)
	r2 := TLSFingerprintTransport(TLSProfileRandom)
	if r1 == nil || r2 == nil {
		t.Fatal("random 指纹应当返回可用的 Transport")
	}
	if r1 == r2 {
		t.Fatal("random 指纹不应缓存 Transport")
	}
}

func TestTLSFingerprintTransportHasDialTLS(t *testing.T) {
	// 指纹生效的方式就是接管 DialTLSContext；没设等于没指纹。
	rt := TLSFingerprintTransport(TLSProfileChrome)
	if rt == nil {
		t.Fatal("应当返回 Transport")
	}
	if rt.DialTLSContext == nil {
		t.Fatal("启用指纹时必须设置 DialTLSContext，否则握手仍是标准库形状")
	}
	if rt.ForceAttemptHTTP2 {
		t.Fatal("启用指纹时不应强制 HTTP/2 —— ALPN 会改变可见特征")
	}
}
