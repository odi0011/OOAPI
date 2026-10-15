package trading

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 418 带解封时间：解析后熔断；熔断期间请求不再触网。
func TestBanGateStopsRequestsAfter418(t *testing.T) {
	banGate.reset()
	defer banGate.reset()

	var hits int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusTeapot)
		until := time.Now().Add(300 * time.Millisecond).UnixMilli()
		_, _ = w.Write([]byte(`{"code":-1003,"msg":"Way too many requests; IP(1.2.3.4) banned until ` +
			itoa(until) + `. Please use the websocket."}`))
	}))
	defer server.Close()

	c := NewUSDMClient(server.URL)

	// 第一次：真实到达服务器，拿到 418 → 熔断。
	if _, err := c.public(http.MethodGet, "/ping", nil); err == nil {
		t.Fatal("第一个请求应当失败")
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Fatalf("server hits = %d, want 1", got)
	}

	// 熔断期间：请求被本地挡下，不再触网。
	for i := 0; i < 20; i++ {
		_, err := c.public(http.MethodGet, "/ping", nil)
		if !errors.Is(err, ErrUpstreamBan) {
			t.Fatalf("熔断期错误 = %v, want ErrUpstreamBan", err)
		}
		var banErr *UpstreamBanError
		if !errors.As(err, &banErr) || banErr.Until.Before(time.Now()) {
			t.Fatalf("熔断错误缺少截止时间: %v", err)
		}
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Fatalf("熔断期间触网了：server hits = %d, want 1", got)
	}
}

// 418 未带解封时间：用兜底时长熔断。
func TestBanGateFallbackWhenNoUntil(t *testing.T) {
	banGate.reset()
	defer banGate.reset()

	var hits int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{"code":-1003,"msg":"Way too many requests."}`))
	}))
	defer server.Close()

	c := NewUSDMClient(server.URL)
	_, _ = c.public(http.MethodGet, "/ping", nil)

	until, blocked := banGate.blockedUntil(c.base)
	if !blocked {
		t.Fatal("没有熔断")
	}
	if time.Until(until) < banFallbackWait {
		t.Fatalf("兜底熔断时长过短: %v", time.Until(until))
	}
	_, err := c.public(http.MethodGet, "/ping", nil)
	if !errors.Is(err, ErrUpstreamBan) {
		t.Fatalf("err = %v, want ErrUpstreamBan", err)
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Fatalf("server hits = %d, want 1", got)
	}
}

// 429：冷却一段时间；成功后连续计数清零。
func TestBanGateRateLimitCooldownAndSuccessReset(t *testing.T) {
	banGate.reset()
	defer banGate.reset()

	var mode int64 // 0=429, 1=ok
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.LoadInt64(&mode) == 0 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"code":-1003,"msg":"Too many requests."}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	c := NewUSDMClient(server.URL)
	_, _ = c.public(http.MethodGet, "/ping", nil)

	if _, blocked := banGate.blockedUntil(c.base); !blocked {
		t.Fatal("429 后没有冷却")
	}
	// 直接清掉冷却模拟到期，然后成功一次 → 连续计数应为 0。
	banGate.reset()
	atomic.StoreInt64(&mode, 1)
	if _, err := c.public(http.MethodGet, "/ping", nil); err != nil {
		t.Fatalf("成功请求失败: %v", err)
	}
	if n := banGate.repeatCount(c.base); n != 0 {
		t.Fatalf("成功后连续计数 = %d, want 0", n)
	}
}

// 连续被封的额外冷却逐级加长。
func TestBanRepeatExtraEscalates(t *testing.T) {
	if banRepeatExtra(1) != 0 {
		t.Fatalf("第 1 次不应额外冷却")
	}
	if banRepeatExtra(2) <= 0 || banRepeatExtra(3) <= banRepeatExtra(2) || banRepeatExtra(5) <= banRepeatExtra(4) {
		t.Fatalf("额外冷却没有递增: %v %v %v %v", banRepeatExtra(2), banRepeatExtra(3), banRepeatExtra(4), banRepeatExtra(5))
	}
	if banRepeatExtra(100) > banRepeatWorst+1 {
		t.Fatalf("额外冷却没有上限: %v", banRepeatExtra(100))
	}
}

// 解析解封时间戳。
func TestParseBanUntil(t *testing.T) {
	ts := time.Now().Add(2 * time.Minute)
	body := []byte(`{"code":-1003,"msg":"Way too many requests; IP(154.36.184.56) banned until ` +
		itoa(ts.UnixMilli()) + `. Please use the websocket for live updates to avoid bans."}`)
	got := parseBanUntil(body)
	if got.IsZero() || got.UnixMilli() != ts.UnixMilli() {
		t.Fatalf("parseBanUntil = %v, want %v", got, ts)
	}
	if !parseBanUntil([]byte(`{"code":-1003,"msg":"no timestamp"}`)).IsZero() {
		t.Fatal("没有时间戳时应返回零值")
	}
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
