package trading

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// EnvBoostToken 是加速接口的 Bearer 令牌。未设置时接口一律拒绝。
	EnvBoostToken = "OOAPI_BOOST_TOKEN"
	// BoostWindow 是一次加速的持续时间和再次加速的最短间隔。
	BoostWindow = 2 * time.Minute
	// BoostScanInterval 是加速期间实盘调度的扫描间隔，短于 K 线收盘。
	BoostScanInterval = 5 * time.Second
	// EventCapacity 是检测事件环形缓冲的容量。
	EventCapacity = 200
)

// DetectionEvent 是一次引擎推进记下的检测结果。
type DetectionEvent struct {
	TS      time.Time `json:"ts"`
	Symbol  string    `json:"symbol"`
	Side    string    `json:"side"`
	Score   int       `json:"score"`
	WinRate float64   `json:"winrate"`
	Action  string    `json:"action"`
	Msg     string    `json:"msg"`
}

type eventRing struct {
	mu   sync.Mutex
	buf  []DetectionEvent
	next int
	full bool
}

func newEventRing(n int) *eventRing {
	if n < 1 {
		n = EventCapacity
	}
	return &eventRing{buf: make([]DetectionEvent, n)}
}

func (r *eventRing) add(ev DetectionEvent) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf[r.next] = ev
	r.next = (r.next + 1) % len(r.buf)
	if r.next == 0 {
		r.full = true
	}
}

func (r *eventRing) snapshot() []DetectionEvent {
	if r == nil {
		return []DetectionEvent{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.full && r.next == 0 {
		return []DetectionEvent{}
	}
	if !r.full {
		out := make([]DetectionEvent, r.next)
		copy(out, r.buf[:r.next])
		return out
	}
	out := make([]DetectionEvent, len(r.buf))
	n := copy(out, r.buf[r.next:])
	copy(out[n:], r.buf[:r.next])
	return out
}

func (r *eventRing) reset() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.buf {
		r.buf[i] = DetectionEvent{}
	}
	r.next = 0
	r.full = false
}

type boostSeen struct {
	winrate float64
	passes  bool
}

// boostCand 是加速窗口里见过的最好候选，用来在窗口结束时说明为什么没开仓。
type boostCand struct {
	symbol string
	side   string
	score  int
	need   int
	reason string
}

type boostGate struct {
	mu         sync.Mutex
	until      time.Time
	started    time.Time
	opened     bool
	endEmitted bool
	bestSet    bool
	best       boostCand
	pending    int64
	seen       map[int64]boostSeen
}

// boostSignal 把「加速已打开」广播给正在睡到下一根 K 线收盘的调度循环。
// 关掉当前通道再换一条新的，已经在 select 里等的循环会被叫醒，后来的等待拿到新通道。
type boostSignal struct {
	mu sync.Mutex
	ch chan struct{}
}

func newBoostSignal() *boostSignal {
	return &boostSignal{ch: make(chan struct{})}
}

func (s *boostSignal) C() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ch
}

func (s *boostSignal) ping() {
	s.mu.Lock()
	defer s.mu.Unlock()
	close(s.ch)
	s.ch = make(chan struct{})
}

func newBoostGate() *boostGate {
	return &boostGate{seen: map[int64]boostSeen{}}
}

var (
	boostState = newBoostGate()
	eventLog   = newEventRing(EventCapacity)
	boostPing  = newBoostSignal()
)

// ResetBoostForTest 清掉加速窗口和检测事件，避免测试互相污染。
func ResetBoostForTest() {
	boostState.reset()
	eventLog.reset()
}

func (b *boostGate) reset() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.until = time.Time{}
	b.started = time.Time{}
	b.opened = false
	b.endEmitted = false
	b.bestSet = false
	b.best = boostCand{}
	b.pending = 0
	b.seen = map[int64]boostSeen{}
}

// GrantBoost 打开两分钟加速窗口。窗口还没结束时返回 limited，不延长截止时间。
// 新窗口会记下 boost_start，并叫醒已经睡到下一根 K 线收盘的实盘调度。
func GrantBoost(now time.Time) (until time.Time, limited bool) {
	until, limited = boostState.grant(now)
	if limited {
		return until, true
	}
	AddEvent(DetectionEvent{
		TS:     now.UTC(),
		Action: "boost_start",
		Msg:    "live scan every 5s",
	})
	boostPing.ping()
	return until, false
}

func (b *boostGate) grant(now time.Time) (time.Time, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now = now.UTC()
	if !b.until.IsZero() && now.Before(b.until) {
		return b.until, true
	}
	b.until = now.Add(BoostWindow)
	b.started = now
	b.opened = false
	b.endEmitted = false
	b.bestSet = false
	b.best = boostCand{}
	b.pending = 0
	b.seen = map[int64]boostSeen{}
	return b.until, false
}

// BoostActive 表示 now 落在当前加速窗口内。
func BoostActive(now time.Time) bool {
	return boostState.active(now)
}

func (b *boostGate) active(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.until.IsZero() && now.UTC().Before(b.until)
}

// BoostUntil 返回当前窗口的截止时间。没有窗口时是零值。
func BoostUntil() time.Time {
	boostState.mu.Lock()
	defer boostState.mu.Unlock()
	return boostState.until
}

func (b *boostGate) note(id int64, winrate float64, passes bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.seen == nil {
		b.seen = map[int64]boostSeen{}
	}
	b.seen[id] = boostSeen{winrate: winrate, passes: passes}
}

// consider 记住窗口内分数最高的候选。分数相同则留先看到的那个。
func (b *boostGate) consider(c boostCand) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.bestSet || c.score > b.best.score {
		b.best = c
		b.bestSet = true
	}
}

// allow 在加速窗口内只放行预测胜率最高、且通过阈值的那一个信号。
// peers 里的实盘策略都报告过一次之后才开仓；过了一个扫描间隔仍有人没报告，就用已经看到的最高胜率。
func (b *boostGate) allow(id int64, peers []int64, now time.Time) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now = now.UTC()
	if b.until.IsZero() || !now.Before(b.until) {
		return true, ""
	}
	if b.opened {
		return false, ReasonBoostFilled
	}
	if b.pending != 0 && b.pending != id {
		return false, ReasonBoostWait
	}
	best, ok := b.bestPassing()
	if !ok || best != id {
		return false, ReasonBoostWait
	}
	if !b.peersSeen(peers) && now.Sub(b.started) < BoostScanInterval {
		return false, ReasonBoostWait
	}
	b.pending = id
	return true, ""
}

func (b *boostGate) bestPassing() (int64, bool) {
	var id int64
	var wr float64
	found := false
	for key, seen := range b.seen {
		if !seen.passes {
			continue
		}
		if !found || seen.winrate > wr || (seen.winrate == wr && key < id) {
			found = true
			id = key
			wr = seen.winrate
		}
	}
	return id, found
}

func (b *boostGate) peersSeen(peers []int64) bool {
	if len(peers) == 0 {
		return true
	}
	for _, id := range peers {
		if _, ok := b.seen[id]; !ok {
			return false
		}
	}
	return true
}

func (b *boostGate) commit(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == id || b.pending == 0 {
		b.opened = true
		b.pending = 0
	}
}

func (b *boostGate) release(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == id {
		b.pending = 0
	}
}

// AddEvent 写入一条检测事件。超过容量时丢掉最旧的。
func AddEvent(ev DetectionEvent) {
	eventLog.add(ev)
}

// RecentEvents 按时间从旧到新返回环形缓冲里的事件。
func RecentEvents() []DetectionEvent {
	return eventLog.snapshot()
}

// MatchToken 用固定长度摘要做常数时间比较。令牌未配置时一律拒绝。
func MatchToken(got, want string) bool {
	want = strings.TrimSpace(want)
	if want == "" {
		return false
	}
	sumGot := sha256.Sum256([]byte(got))
	sumWant := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(sumGot[:], sumWant[:]) == 1
}

// scanWait 是调度器睡到下一次推进的时长。实盘加速窗口内改为固定短间隔。
func scanWait(now time.Time, timeframe string, live bool) time.Duration {
	return scanWaitEvery(now, timeframe, live, BoostScanInterval)
}

func scanWaitEvery(now time.Time, timeframe string, live bool, boostEvery time.Duration) time.Duration {
	if boostEvery <= 0 {
		boostEvery = BoostScanInterval
	}
	if live && BoostActive(now) {
		return boostEvery
	}
	tf := TimeframeDuration(timeframe)
	wait := NextBarClose(now, tf).Sub(now)
	if wait < time.Second {
		return time.Second
	}
	return wait
}

// emitBoostEnd 在窗口结束后写一条 boost_end。没有任何信号过门时，msg 带上最高候选分。
// 多次调用只记第一条。
func emitBoostEnd(now time.Time) bool {
	ev, ok := boostState.takeEnd(now)
	if !ok {
		return false
	}
	AddEvent(ev)
	return true
}

func (b *boostGate) takeEnd(now time.Time) (DetectionEvent, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now = now.UTC()
	if b.until.IsZero() || b.endEmitted || now.Before(b.until) {
		return DetectionEvent{}, false
	}
	b.endEmitted = true
	ev := DetectionEvent{
		TS:     now,
		Action: "boost_end",
		Msg:    b.endMsgLocked(),
	}
	if b.bestSet {
		ev.Symbol = b.best.symbol
		ev.Side = b.best.side
		ev.Score = b.best.score
	}
	return ev, true
}

func (b *boostGate) endMsgLocked() string {
	if b.opened {
		return "position opened"
	}
	for _, seen := range b.seen {
		if seen.passes {
			return "signal cleared thresholds"
		}
	}
	if !b.bestSet {
		return "no signal cleared thresholds; best score 0"
	}
	return formatBoostMiss(b.best)
}

func formatBoostMiss(c boostCand) string {
	need := c.need
	if need <= 0 {
		need = DefaultMinScore
	}
	target := strings.TrimSpace(c.symbol)
	if side := strings.TrimSpace(c.side); side != "" {
		if target != "" {
			target += " " + side
		} else {
			target = side
		}
	}
	if target == "" {
		target = "candidate"
	}
	reason := strings.TrimSpace(c.reason)
	if reason == "" {
		reason = "below_threshold"
	}
	return fmt.Sprintf("no signal cleared thresholds; best %s score %d/%d (%s)", target, c.score, need, reason)
}
