package services

import (
	"sync"
	"time"
)

// 账号级限流（内存实现）。
//
// 存在的理由：某些上游账号（尤其是网页反代/订阅号）对请求密度非常敏感，
// 并发一高或间隔太密就会返回 429、甚至触发风控封号。
// 因此允许管理员给单个账号配置三项保护：
//
//	concurrency  同时进行的最大请求数（0 = 不限）
//	min_gap_ms   同一账号两次请求的最小间隔，毫秒（0 = 不限）
//	max_per_min  每分钟最大请求数，滚动 60 秒（0 = 不限）
//
// 与参考实现（默认 1 / 1200ms / 20）刻意不同：**本站默认全部为 0（不限）**。
// 参考实现的默认值是给反代账号兜底的，但本站大量账号是普通 API Key 网关，
// 若照搬 20 次/分钟会瞬间把正常业务限死 —— 既有账号必须行为完全不变，
// 只有管理员显式配置（> 0）时才启用对应的限制。
//
// 状态只放内存、不落库：限流是「此刻」的调度决策，重启后清零即可，
// 落库反而会引入额外的写放大与一致性问题。

// channelRateState 是一个账号的运行时限流状态。
type channelRateState struct {
	// inflight 是当前已在途的请求数（TryAcquire/Begin 到 Release/End 之间）。
	inflight int
	// lastAt 是最近一次放行（发车）的时刻，用于最小间隔判断。
	lastAt time.Time
	// window 是最近 60 秒内的发车时刻，用于滚动每分钟上限。
	window []time.Time
	// touched 是该条目最近被使用的时刻，用于惰性清理。
	touched time.Time
}

const (
	// rateWindow 是「每分钟上限」的滚动窗口长度。
	rateWindow = 60 * time.Second
	// rateStateTTL 是空闲状态条目的保留时长：
	// 10 分钟没碰过的账号直接丢弃，内存占用与账号数同阶而不是与历史请求数同阶。
	rateStateTTL = 10 * time.Minute
	// ratePruneInterval 限制全表清扫的频率：最多每分钟一次，
	// 避免每个请求都对整张状态表做一次遍历。
	ratePruneInterval = time.Minute
	// rateWindowHardCap 是单账号窗口的硬上限（与 max_per_min 校验上限一致）。
	// 正常情况下窗口长度被 max_per_min 卡住，这里是防止直接调用 Begin
	// 绕开检查时内存无界增长。
	rateWindowHardCap = 100_000
)

var (
	rateLimitMu      sync.Mutex
	rateLimitStates  = map[int64]*channelRateState{}
	rateLimitPruned  time.Time
	rateLimitClockMu sync.RWMutex
)

// rateLimitNow 取当前时间。抽成变量是为了让测试注入假时钟 ——
// 滚动窗口的验证不能靠 sleep 60 秒。
var rateLimitNow = time.Now

// SetRateLimitClock 替换限流器时钟（仅供测试；传 nil 恢复系统时钟）。
func SetRateLimitClock(fn func() time.Time) {
	rateLimitClockMu.Lock()
	if fn == nil {
		rateLimitNow = time.Now
	} else {
		rateLimitNow = fn
	}
	rateLimitClockMu.Unlock()
}

// nowUnderLock 读取当前时间；测试注入时钟时用读写锁保证安全。
func nowUnderLock() time.Time {
	rateLimitClockMu.RLock()
	fn := rateLimitNow
	rateLimitClockMu.RUnlock()
	return fn()
}

// Allow 判断账号当前是否允许再发一个请求。
//
// 纯检查，不改动任何状态 —— SelectChannels 用它做候选过滤；
// 真正要「占名额」请用 TryAcquire（检查 + 登记原子完成）。
// 任一配置为 0 表示该项不限制；三项都为 0 时直接放行（既有账号行为不变）。
func Allow(channelID int64, concurrency, minGapMs, maxPerMin int) bool {
	if channelID <= 0 {
		return true
	}
	if concurrency <= 0 && minGapMs <= 0 && maxPerMin <= 0 {
		return true
	}

	rateLimitMu.Lock()
	defer rateLimitMu.Unlock()

	now := nowUnderLock()
	pruneStatesLocked(now)

	s := rateLimitStates[channelID]
	if s == nil {
		return true
	}
	return limitOK(s, concurrency, minGapMs, maxPerMin, now)
}

// limitOK 是三项限制的共同判定，调用方必须持有 rateLimitMu。
func limitOK(s *channelRateState, concurrency, minGapMs, maxPerMin int, now time.Time) bool {
	if concurrency > 0 && s.inflight >= concurrency {
		return false
	}
	if minGapMs > 0 && !s.lastAt.IsZero() &&
		now.Sub(s.lastAt) < time.Duration(minGapMs)*time.Millisecond {
		return false
	}
	if maxPerMin > 0 {
		// 顺手把超过 60 秒的旧时刻写回去：访问即修剪，
		// 长期无请求的账号窗口不会一直挂着过期时间戳。
		s.window = pruneWindow(s.window, now)
		if len(s.window) >= maxPerMin {
			return false
		}
	}
	return true
}

// Begin 登记一次发车：在途 +1，并记录时刻（供最小间隔与滚动窗口使用）。
// 必须与 End 成对出现；网关主链路请用 TryAcquire/Release（原子版）。
func Begin(channelID int64) {
	if channelID <= 0 {
		return
	}
	rateLimitMu.Lock()
	defer rateLimitMu.Unlock()

	now := nowUnderLock()
	pruneStatesLocked(now)
	s := stateLocked(channelID)
	s.touched = now
	s.inflight++
	s.lastAt = now
	s.window = appendWindow(s.window, now)
}

// End 结束一次发车：在途 -1。多余调用会安全地钳到 0。
func End(channelID int64) {
	if channelID <= 0 {
		return
	}
	rateLimitMu.Lock()
	defer rateLimitMu.Unlock()

	s := rateLimitStates[channelID]
	if s == nil {
		return
	}
	if s.inflight > 0 {
		s.inflight--
	}
	s.touched = nowUnderLock()
}

// TryAcquire 原子地「检查 + 占名额」：通过时返回 true 并已登记在途，
// 调用方之后必须调用 Release。
//
// 为什么需要原子版本：SelectChannels 的过滤（Allow）与实际发车之间
// 可能有并发请求抢走名额；分开「检查」与「Begin」会让并发上限被突破
// （参考实现里也专门修过这个漏洞：名额必须在同步路径上占好）。
func TryAcquire(ch *UpstreamChannel) bool {
	if ch == nil || ch.ID <= 0 {
		return true
	}
	c, gap, perMin := ch.Concurrency, ch.MinGapMs, ch.MaxPerMin
	if c <= 0 && gap <= 0 && perMin <= 0 {
		// 未配置任何限制：不建状态，直接放行（热路径）。
		return true
	}

	rateLimitMu.Lock()
	defer rateLimitMu.Unlock()

	now := nowUnderLock()
	pruneStatesLocked(now)
	s := stateLocked(ch.ID)
	if !limitOK(s, c, gap, perMin, now) {
		return false
	}

	s.touched = now
	s.inflight++
	s.lastAt = now
	s.window = appendWindow(s.window, now)
	return true
}

// Release 结束一次占用（与 TryAcquire 成对）。nil 安全。
func Release(ch *UpstreamChannel) {
	if ch == nil {
		return
	}
	End(ch.ID)
}

// RateLimitAcquire 是网关主链路的入口名：原子地「检查 + 登记发车」。
// 与 TryAcquire 同一实现，命名上明确「这是限流器」，
// 便于调用方一眼看出失败原因是限流而不是别的校验。
func RateLimitAcquire(ch *UpstreamChannel) bool { return TryAcquire(ch) }

// RateLimitRelease 与 RateLimitAcquire 成对，nil 安全。
func RateLimitRelease(ch *UpstreamChannel) { Release(ch) }

// Reset 清空某个账号的限流状态（测试用；账号被删除时也会随之自然过期）。
func Reset(channelID int64) {
	rateLimitMu.Lock()
	delete(rateLimitStates, channelID)
	rateLimitMu.Unlock()
}

// ResetAll 清空全部限流状态（仅供测试）：不依赖任何环境或数据库，
// 让「并发 / 最小间隔 / 滚动窗口」的用例彼此隔离。
func ResetAll() {
	rateLimitMu.Lock()
	rateLimitStates = map[int64]*channelRateState{}
	rateLimitPruned = time.Time{}
	rateLimitMu.Unlock()
}

// stateLocked 取或建账号状态，调用方必须持有 rateLimitMu。
func stateLocked(channelID int64) *channelRateState {
	s := rateLimitStates[channelID]
	if s == nil {
		s = &channelRateState{}
		rateLimitStates[channelID] = s
	}
	return s
}

// pruneWindow 返回裁剪后的窗口（只保留最近 60 秒），不修改原切片。
func pruneWindow(window []time.Time, now time.Time) []time.Time {
	cut := 0
	for cut < len(window) && now.Sub(window[cut]) >= rateWindow {
		cut++
	}
	return window[cut:]
}

// appendWindow 追加一个发车时刻并裁剪旧条目，同时兜住硬上限。
func appendWindow(window []time.Time, now time.Time) []time.Time {
	window = pruneWindow(window, now)
	if len(window) >= rateWindowHardCap {
		// 只有绕过限流检查疯狂发车才可能走到这里：
		// 丢掉最旧的一条，保证内存有界。
		window = window[1:]
	}
	return append(window, now)
}

// pruneStatesLocked 惰性清理：丢弃 10 分钟没碰过、且没有在途请求的状态。
// 全表扫描最多每分钟一次，单账号状态自然随 TTL 过期。
func pruneStatesLocked(now time.Time) {
	if now.Sub(rateLimitPruned) < ratePruneInterval {
		return
	}
	rateLimitPruned = now
	for id, s := range rateLimitStates {
		if s.inflight <= 0 && now.Sub(s.touched) >= rateStateTTL {
			delete(rateLimitStates, id)
		}
	}
}
