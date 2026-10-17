package trading

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

/*
网格的调度。

和趋势引擎的 Runner 是**两条独立的循环**，不是同一个加上 if 分支。
差别在节拍上：

	趋势引擎   每根 K 线收盘推进一次（5 分钟），持仓时另开一只短时钟
	网格引擎   每 GridScanInterval 推进一次（默认 5 秒），一直如此

网格没有"K 线收盘"这个概念 —— 它看的是**盘口**：哪张单成交了、
现在的价格在哪一格附近。用 K 线节拍去驱动，五分钟一次的轮询意味着
价格穿过一整段区间时只能看到两端，中间那些该成交的格子全部错过。

默认 5 秒这个数是有代价的：一次推进要拉一次挂单列表（外加每笔成交一次
查单），所以每个网格每秒约 0.2 个请求。币安现货的权重上限是每分钟 6000，
十几条网格完全够用 —— 但这也意味着**不该开几百条网格**。
*/

// GridScanInterval 是网格两次推进之间的间隔。
//
// 5 秒是权衡的结果：更短会让"挂上一张会立即成交的单"更容易被拒
//（价格在两次轮询之间跑掉），更长则会让价格穿过区间时错过中间的格子。
var GridScanInterval = 5 * time.Second

// GridRunSpec 是调度器跟踪的一条运行中的网格。
type GridRunSpec struct {
	UserID  int64
	Config  GridConfig
	Secrets SecretOpener
}

// GridMarketFunc 读当前价。测试可以换成固定数据。
type GridMarketFunc func(cfg GridConfig, secrets SecretOpener, now time.Time) (float64, error)

/*
GridHub 保存进程内所有网格引擎。

刻意和 Hub 分开而不是塞进去：Hub 里所有方法都带 strategyID 和
组合风控（保证金、symbol 冲突），而网格不占保证金、也不和趋势引擎
抢同一个交易对（建网时校验）。共用一张表会让 Hub 的每个方法都要
先问"这是哪种引擎"，而那个分支没有任何一处是简单的。
*/
type GridHub struct {
	mu      sync.Mutex
	engines map[int64]*GridEngine
	snaps   map[int64]GridSnapshot
}

func NewGridHub() *GridHub {
	return &GridHub{engines: map[int64]*GridEngine{}, snaps: map[int64]GridSnapshot{}}
}

var defaultGridHub = NewGridHub()

// DefaultGridHub 是进程内唯一的网格表。
func DefaultGridHub() *GridHub { return defaultGridHub }

// ResetGridForTest 清空网格表，避免测试互相污染。
func ResetGridForTest() {
	defaultGridHub = NewGridHub()
	resetGridFillsForTest()
}

// Put 把一台已经建好的引擎放进表里（建网格、认领网格时用）。
func (h *GridHub) Put(eng *GridEngine) error {
	if h == nil || eng == nil {
		return invalid("缺少网格引擎")
	}
	if eng.cfg.ID <= 0 {
		return invalid("网格引擎缺少 ID")
	}
	h.mu.Lock()
	h.engines[eng.cfg.ID] = eng
	h.storeLocked(eng)
	h.mu.Unlock()
	return nil
}

// Get 返回某条网格的引擎。调用方拿到的指针**不能跨线程用**，
// 要先在这台引擎自己的锁里操作（GridEngine 的方法自带锁）。
func (h *GridHub) Get(gridID int64) (*GridEngine, bool) {
	if h == nil || gridID <= 0 {
		return nil, false
	}
	h.mu.Lock()
	eng, ok := h.engines[gridID]
	h.mu.Unlock()
	return eng, ok
}

// Remove 把某条网格从表里拿走。
func (h *GridHub) Remove(gridID int64) {
	if h == nil {
		return
	}
	h.mu.Lock()
	delete(h.engines, gridID)
	delete(h.snaps, gridID)
	h.mu.Unlock()
}

// Tracking 报告某条网格是否已经在表里。
func (h *GridHub) Tracking(gridID int64) bool {
	_, ok := h.Get(gridID)
	return ok
}

/*
Snapshot 返回某条网格的运行状态。

**内存里没有时返回 ok=false**，而不是去建一台 —— 建引擎要读交易对规则
（一次网络请求），在"只是想看看状态"的路径上做这件事，会让一个
列表页把每个网格都拉一遍规则。调用方拿到 false 时应当显示
"未运行"。
*/
func (h *GridHub) Snapshot(gridID int64) (GridSnapshot, bool) {
	eng, ok := h.Get(gridID)
	if !ok || eng == nil {
		return GridSnapshot{}, false
	}
	eng.mu.Lock()
	snap := eng.snapshot()
	eng.mu.Unlock()
	h.mu.Lock()
	h.snaps[gridID] = snap
	h.mu.Unlock()
	return snap, true
}

// Cached 返回最近一次推进留下的快照，不去碰引擎的锁。
func (h *GridHub) Cached(gridID int64) (GridSnapshot, bool) {
	if h == nil {
		return GridSnapshot{}, false
	}
	h.mu.Lock()
	snap, ok := h.snaps[gridID]
	h.mu.Unlock()
	return snap, ok
}

// UserSnapshots 返回某个用户全部网格的内存快照，键是网格 ID。
func (h *GridHub) UserSnapshots(userID int64) map[int64]GridSnapshot {
	out := map[int64]GridSnapshot{}
	if h == nil || userID <= 0 {
		return out
	}
	h.mu.Lock()
	for id, eng := range h.engines {
		if eng == nil || eng.cfg.UserID != userID {
			continue
		}
		if snap, ok := h.snaps[id]; ok {
			out[id] = snap
			continue
		}
		if eng.mu.TryLock() {
			out[id] = eng.snapshot()
			eng.mu.Unlock()
		}
	}
	h.mu.Unlock()
	return out
}

func (h *GridHub) storeLocked(eng *GridEngine) {
	eng.mu.Lock()
	snap := eng.snapshot()
	eng.mu.Unlock()
	if h.snaps == nil {
		h.snaps = map[int64]GridSnapshot{}
	}
	h.snaps[eng.cfg.ID] = snap
}

/*
Step 推进一条网格。

价格由调用方（调度器）读好传进来，不在这里读 —— 读行情属于
market 那一步，测试要能把它换成固定值。
*/
func (h *GridHub) Step(gridID int64, now time.Time, price float64) (GridSnapshot, error) {
	eng, ok := h.Get(gridID)
	if !ok || eng == nil {
		return GridSnapshot{}, ErrNotRunning
	}
	// 配置在建立引擎时就固定了。改区间/条数要重建引擎（计划是算出来的），
	// 所以这里不热更新 cfg —— 只推进。
	eng.mu.Lock()
	snap, err := eng.Step(now, price)
	eng.mu.Unlock()
	h.mu.Lock()
	h.snaps[gridID] = snap
	h.mu.Unlock()
	return snap, err
}

/*
GridRunner 为每条 running 网格起一个循环。

它与 Runner 的另一处差别：**网格不需要 SetMarket 那种"读一整套"
的回调**，只要一个价格。挂单、余额、成交这些引擎自己按需去交易所读，
因为它们的读取时机和节拍不是一回事（挂单每一拍都要对齐，
成交只有在某张单消失时才查）。
*/
type GridRunner struct {
	hub      *GridHub
	now      func() time.Time
	market   GridMarketFunc
	build    func(spec GridRunSpec, price float64) (*GridEngine, error)
	mu       sync.Mutex
	started  bool
	jobs     map[int64]context.CancelFunc
	wakes    map[int64]chan struct{}
	specs    map[int64]GridRunSpec
	interval time.Duration
	onStop   func(gridID, userID int64)
}

func NewGridRunner(hub *GridHub) *GridRunner {
	if hub == nil {
		hub = NewGridHub()
	}
	r := &GridRunner{
		hub:    hub,
		now:    func() time.Time { return time.Now().UTC() },
		market: defaultGridMarket,
		jobs:   map[int64]context.CancelFunc{},
		wakes:  map[int64]chan struct{}{},
		specs:  map[int64]GridRunSpec{},
	}
	r.build = r.defaultBuild
	return r
}

// SetClock 换掉时钟。测试用。
func (r *GridRunner) SetClock(now func() time.Time) {
	if now != nil {
		r.now = now
	}
}

// SetMarket 换掉读价函数。测试用。
func (r *GridRunner) SetMarket(fn GridMarketFunc) {
	if fn != nil {
		r.market = fn
	}
}

// SetInterval 换掉推进间隔。0 表示用 GridScanInterval。测试用。
func (r *GridRunner) SetInterval(d time.Duration) {
	r.mu.Lock()
	r.interval = d
	r.mu.Unlock()
}

// SetStop 在网格自己停机时回调（写库用）。实现只许写库，不能再进 Hub。
//
// 回调必须带 userID：落库的 UPDATE 带用户条件，传 0 会一行都更新不到，
// 而且不报错 —— 网格自停机后 running 仍是 1，服务一重启它就"复活"，
// 本地还按旧成交历史重建出已经不存在的持仓（实盘已复现）。
func (r *GridRunner) SetStop(fn func(gridID, userID int64)) {
	r.mu.Lock()
	r.onStop = fn
	r.mu.Unlock()
}

// Start 标记调度器已启用。
func (r *GridRunner) Start() {
	r.mu.Lock()
	r.started = true
	r.mu.Unlock()
}

func (r *GridRunner) Started() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started
}

// Sync 让循环集合和当前 running 网格对齐。
func (r *GridRunner) Sync(specs []GridRunSpec) {
	want := map[int64]GridRunSpec{}
	for _, spec := range specs {
		if spec.Config.ID <= 0 || !spec.Config.Running {
			continue
		}
		want[spec.Config.ID] = spec
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.started {
		return
	}
	for id, cancel := range r.jobs {
		if _, ok := want[id]; ok {
			continue
		}
		cancel()
		delete(r.jobs, id)
		delete(r.wakes, id)
		delete(r.specs, id)
	}
	for id, spec := range want {
		if _, ok := r.jobs[id]; ok {
			r.specs[id] = spec
			continue
		}
		r.launchLocked(spec)
	}
}

// Ensure 为一条网格拉起循环。重复调用只更新参数并唤醒。
func (r *GridRunner) Ensure(spec GridRunSpec) {
	r.mu.Lock()
	if !r.started || spec.Config.ID <= 0 {
		r.mu.Unlock()
		return
	}
	if _, ok := r.jobs[spec.Config.ID]; ok {
		r.specs[spec.Config.ID] = spec
		wakeC := r.wakes[spec.Config.ID]
		r.mu.Unlock()
		ping(wakeC)
		return
	}
	r.launchLocked(spec)
	r.mu.Unlock()
}

// Wake 立刻唤醒一条网格的循环推进一次。
func (r *GridRunner) Wake(gridID int64) {
	if r == nil || gridID <= 0 {
		return
	}
	r.mu.Lock()
	wakeC := r.wakes[gridID]
	r.mu.Unlock()
	ping(wakeC)
}

// Remove 停掉一条网格的循环。
func (r *GridRunner) Remove(gridID int64) {
	r.mu.Lock()
	cancel := r.jobs[gridID]
	delete(r.jobs, gridID)
	delete(r.wakes, gridID)
	delete(r.specs, gridID)
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *GridRunner) launchLocked(spec GridRunSpec) {
	r.specs[spec.Config.ID] = spec
	wakeC := make(chan struct{}, 1)
	r.wakes[spec.Config.ID] = wakeC
	ctx, cancel := context.WithCancel(context.Background())
	r.jobs[spec.Config.ID] = cancel
	go r.loop(ctx, spec.Config.ID, wakeC)
}

func ping(ch chan struct{}) {
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (r *GridRunner) liveSpec(id int64) (GridRunSpec, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	spec, ok := r.specs[id]
	return spec, ok
}

func (r *GridRunner) every() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.interval > 0 {
		return r.interval
	}
	return GridScanInterval
}

func (r *GridRunner) loop(ctx context.Context, id int64, wakeC <-chan struct{}) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[grid] runner %d panic: %v", id, rec)
		}
	}()
	// 起来先推一拍：不然新开的网格要等一个完整间隔才第一次挂单，
	// 而那个间隔里它看起来"在跑"但盘口上什么都没有。
	r.tick(ctx, id)
	for {
		timer := time.NewTimer(r.every())
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-wakeC:
			timer.Stop()
		case <-timer.C:
		}
		if ctx.Err() != nil {
			return
		}
		r.tick(ctx, id)
	}
}

// tick 推进一拍。任何错误都只记日志，**不打断循环** ——
// 一次网络抖动不该让一条网格从此不再运行。
func (r *GridRunner) tick(ctx context.Context, id int64) {
	if ctx.Err() != nil {
		return
	}
	spec, ok := r.liveSpec(id)
	if !ok || !spec.Config.Running {
		return
	}
	now := r.now()
	eng, tracked := r.hub.Get(id)
	if !tracked {
		price, err := r.market(spec.Config, spec.Secrets, now)
		if err != nil {
			log.Printf("[grid] %d 读价失败: %v", id, err)
			return
		}
		eng, err = r.build(spec, price)
		if err != nil {
			log.Printf("[grid] %d 建立失败: %v", id, err)
			r.stop(id)
			return
		}
		r.hub.mu.Lock()
		r.hub.engines[id] = eng
		r.hub.storeLocked(eng)
		r.hub.mu.Unlock()
		// 已经建过一次却还在表外（进程重启）时走认领：先把盘口上
		// 上一次运行留下的单撤干净，再按成交历史重建持仓。
		if err := eng.Adopt(now); err != nil {
			log.Printf("[grid] %d 认领失败: %v", id, err)
			return
		}
	}
	price, err := r.market(spec.Config, spec.Secrets, now)
	if err != nil {
		log.Printf("[grid] %d 读价失败: %v", id, err)
		return
	}
	eng.mu.Lock()
	snap, serr := eng.Step(now, price)
	eng.mu.Unlock()
	r.hub.mu.Lock()
	r.hub.snaps[id] = snap
	r.hub.mu.Unlock()
	if serr != nil {
		log.Printf("[grid] %d 推进失败: %v", id, serr)
	}
	if snap.State == GridStopped || snap.State == GridError {
		r.stop(id)
	}
}

// stop 通知调用方（写库），并停掉循环。
func (r *GridRunner) stop(id int64) {
	r.mu.Lock()
	fn := r.onStop
	userID := r.specs[id].UserID
	r.mu.Unlock()
	if fn != nil {
		fn(id, userID)
	}
	r.Remove(id)
}

// defaultBuild 建一台网格引擎。价格由调用方读好。
func (r *GridRunner) defaultBuild(spec GridRunSpec, price float64) (*GridEngine, error) {
	ex, err := GridExchangeFactory(spec.Config)
	if err != nil {
		return nil, err
	}
	if spec.Secrets != nil {
		creds, cerr := spec.Secrets()
		if cerr != nil {
			return nil, cerr
		}
		if uerr := ex.UseCredentials(creds); uerr != nil {
			return nil, uerr
		}
	}
	return BuildGridEngine(spec.Config, price, ex, currentGridFillLog(), StdLogger())
}

/*
defaultGridMarket 读当前价。

用最新成交价（/api/v3/ticker/price）而不是买一卖一中间价：
网格判断"哪些线在当前价之下"用的是**上一笔成交**，与挂单价格
同一条口径。用中间价的话，买卖价差大的币种上会算出偏乐观的
"价格在线上"，于是挂出一张会立即成交的买单（被 -2010 拒掉），
每一拍都白跑一次。
*/
func defaultGridMarket(cfg GridConfig, secrets SecretOpener, now time.Time) (float64, error) {
	symbol := strings.ToUpper(strings.TrimSpace(cfg.Symbol))
	if symbol == "" {
		return 0, invalid("网格缺少交易对")
	}
	client, err := GridExchangeFactory(cfg)
	if err != nil {
		return 0, err
	}
	return spotLastPrice(client, symbol)
}

// spotLastPrice 从现货出口读最新成交价。
//
// 走的是**公开**接口，不需要密钥 —— 读价失败不该和"密钥没配好"混在一起。
func spotLastPrice(ex GridExchange, symbol string) (float64, error) {
	type lastPricer interface {
		LastPrice(symbol string) (float64, error)
	}
	if src, ok := ex.(lastPricer); ok {
		return src.LastPrice(symbol)
	}
	return 0, invalid("这个交易所出口读不了现货价格")
}

// GridSpecsFromRows 把库里的行转成调度用的 spec。由接口层调用。
func GridSpecsFromRows(rows []GridConfig, opener func(userID, keyID int64) (SecretOpener, error)) []GridRunSpec {
	out := make([]GridRunSpec, 0, len(rows))
	for _, cfg := range rows {
		if !cfg.Running || cfg.ID <= 0 {
			continue
		}
		spec := GridRunSpec{UserID: cfg.UserID, Config: cfg}
		if opener != nil {
			if fn, err := opener(cfg.UserID, cfg.ExchangeKeyID); err == nil {
				spec.Secrets = fn
			}
		}
		out = append(out, spec)
	}
	return out
}

// GridKey 是日志里标识一条网格的短串。
func GridKey(userID, gridID int64) string {
	return fmt.Sprintf("%d:%d", userID, gridID)
}
