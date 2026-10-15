package trading

/*
币安上游熔断器。

**为什么必须有**：币安 418（-1003）的语义是「本机 IP 已被封禁」，
并且**封禁期间再发请求会继续延长封禁**。而看板与引擎的每一次行情读取
都是一次真实请求 —— 一旦被封，每次轮询都会变成「延长封禁的请求」，
失败又不进缓存（见 market_cache.go 的「失败不缓存」设计），
于是形成正反馈：越读越封、越封越读。

真实事故：看板在 09:15 打开后进入请求风暴，把 IP 打成 418；
09:22–09:28 期间每个失败请求都在续封，7 分钟发了几万次。

**熔断语义**：收到 418/429 后记下解封时间，在此时间之前
所有请求直接返回 UpstreamBanError，**绝不接触网络**、也绝不进日志风暴。
解封后第一次请求自然重试；若仍被封会拿到新的解封时间并重新熔断。

连续被封（说明解封后第一次探测仍是封禁状态）会递增叠加额外的冷却，
避免「探测→续封→探测」的死循环。
*/

import (
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// ErrUpstreamBan 是熔断错误的哨兵，调用方用 errors.Is 判断是否需要特别处理
// （例如看板请求在熔断期间不再逐条写日志，只返回错误给前端）。
var ErrUpstreamBan = errors.New("upstream banned")

// banUntilPattern 从币安 418 消息里取解封时间戳（毫秒），如 "banned until 1792034458455"。
var banUntilPattern = regexp.MustCompile(`banned until (\d{10,16})`)

const (
	// banFallbackWait 是 418 没带解封时间时的兜底熔断时长。
	banFallbackWait = 2 * time.Minute
	// rateLimitWait 是 429（超过请求配额，非封禁）的冷却时长。
	rateLimitWait = 60 * time.Second
	// banGrace 在解封时间之后再多等一点，避免卡在边界上再撞一次。
	banGrace = 2 * time.Second
	// 连续被封的额外冷却阶梯（第 1 次不额外加，之后逐级加长）。
	banRepeatWorst = 60 * time.Minute
)

// UpstreamBanError 表示请求被本地熔断挡下：币安封禁尚未解除。
// 它是普通错误，不是 ExchangeError —— 熔断期间没有任何网络交互。
type UpstreamBanError struct {
	Base  string
	Until time.Time
}

func (e *UpstreamBanError) Error() string {
	if e == nil {
		return ""
	}
	left := time.Until(e.Until)
	if left < 0 {
		left = 0
	}
	return fmt.Sprintf("已本地熔断：币安封禁至 %s（剩余 %s），期间不再发起请求",
		e.Until.In(shanghaiLoc).Format("15:04:05"), left.Truncate(time.Second))
}

// Is 让 errors.Is(err, ErrUpstreamBan) 成立。
func (e *UpstreamBanError) Is(target error) bool { return target == ErrUpstreamBan }

// upstreamGate 是按 base 主机维护的熔断器。
type upstreamGate struct {
	mu    sync.Mutex
	until map[string]time.Time
	// repeats 记录连续被封次数，成功一次即清零。用于逐级加长冷却。
	repeats map[string]int
	// nowFn 便于测试替换时钟。
	nowFn func() time.Time
}

func newUpstreamGate() *upstreamGate {
	return &upstreamGate{
		until:   map[string]time.Time{},
		repeats: map[string]int{},
		nowFn:   time.Now,
	}
}

func (g *upstreamGate) now() time.Time {
	if g.nowFn != nil {
		return g.nowFn()
	}
	return time.Now()
}

// blockedUntil 返回该主机的熔断截止时间；未熔断返回 false。
func (g *upstreamGate) blockedUntil(base string) (time.Time, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.until[base]
	if !ok {
		return time.Time{}, false
	}
	if g.now().After(t) {
		delete(g.until, base)
		return time.Time{}, false
	}
	return t, true
}

// noteBan 记下一次封禁（418）或配额超限（429），返回最终熔断截止时间。
// hardBan 为真表示 418：按解封时间 + 连续被封的额外冷却。
func (g *upstreamGate) noteBan(base string, until time.Time, hardBan bool) time.Time {
	now := g.now()
	if !until.After(now) {
		if hardBan {
			until = now.Add(banFallbackWait)
		} else {
			until = now.Add(rateLimitWait)
		}
	}
	extra := time.Duration(0)
	if hardBan {
		g.mu.Lock()
		g.repeats[base]++
		n := g.repeats[base]
		g.mu.Unlock()
		extra = banRepeatExtra(n)
	}
	final := until.Add(banGrace + extra)
	g.mu.Lock()
	if cur, ok := g.until[base]; !ok || final.After(cur) {
		g.until[base] = final
	}
	g.mu.Unlock()
	return final
}

// noteSuccess 在请求成功时清零连续封禁计数。
func (g *upstreamGate) noteSuccess(base string) {
	g.mu.Lock()
	if g.repeats[base] != 0 {
		g.repeats[base] = 0
	}
	g.mu.Unlock()
}

// banRepeatExtra 是第 n 次连续被封额外叠加的冷却；第 1 次不叠加。
func banRepeatExtra(n int) time.Duration {
	switch {
	case n <= 1:
		return 0
	case n == 2:
		return 2 * time.Minute
	case n == 3:
		return 5 * time.Minute
	case n == 4:
		return 15 * time.Minute
	default:
		return 30 * time.Minute
	}
}

func (g *upstreamGate) reset() {
	g.mu.Lock()
	g.until = map[string]time.Time{}
	g.repeats = map[string]int{}
	g.mu.Unlock()
}

var banGate = newUpstreamGate()

// parseBanUntil 从 418 响应体里解析解封时间；解析不出返回零值。
func parseBanUntil(body []byte) time.Time {
	m := banUntilPattern.FindSubmatch(body)
	if len(m) != 2 {
		return time.Time{}
	}
	ms, err := strconv.ParseInt(string(m[1]), 10, 64)
	if err != nil || ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// noteUpstreamBan 在 roundTrip 收到响应后调用：418/429 记入熔断，其它错误不动。
// 成功响应清零连续计数。
func (c *USDMClient) noteUpstreamBan(status int, body []byte, err error) {
	if err == nil {
		banGate.noteSuccess(c.base)
		return
	}
	switch status {
	case 418:
		until := parseBanUntil(body)
		final := banGate.noteBan(c.base, until, true)
		log.Printf("[trading] 币安 418：本地熔断至 %s（连续第 %d 次），解封前不再发送任何请求",
			final.In(shanghaiLoc).Format("15:04:05"), banGate.repeatCount(c.base))
	case 429:
		final := banGate.noteBan(c.base, time.Time{}, false)
		log.Printf("[trading] 币安 429：冷却至 %s，期间不再发送请求",
			final.In(shanghaiLoc).Format("15:04:05"))
	}
}

func (g *upstreamGate) repeatCount(base string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.repeats[base]
}
