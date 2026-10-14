package trading

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Credentials 是下单瞬间解开的交易所密钥。不得写入日志或策略响应。
type Credentials struct {
	APIKey    string
	APISecret string
	// Network 必须与客户端主机一致：testnet 或 live。
	Network string
}

// SecretOpener 只在发单或管理挂单时调用，启动和空转不会调用。
type SecretOpener func() (Credentials, error)

// RunHook 在运行标记变化时回调。实现只许写库，不能再进 Hub，否则会死锁。
type RunHook func(strategyID int64, running bool)

type accountSnap struct {
	Wallet         float64
	Available      float64
	Known          bool
	Equity         float64
	EquityKnown    bool
	Positions      []KeyPosition
	PositionsKnown bool
}

// Hub 按用户和策略 ID 保存多台引擎。组合风控在同一把锁里汇总。
type Hub struct {
	mu       sync.Mutex
	engines  map[string]*Engine
	snaps    map[string]Snapshot
	accounts map[int64]accountSnap
	onRun    RunHook
	onPause  func(strategyID int64, reason string)
}

func NewHub() *Hub {
	return &Hub{
		engines:  map[string]*Engine{},
		snaps:    map[string]Snapshot{},
		accounts: map[int64]accountSnap{},
	}
}

var defaultHub = NewHub()

// DefaultHub 是进程内唯一的引擎表。
func DefaultHub() *Hub { return defaultHub }

// ResetForTest 清空引擎和实盘门闩，避免测试互相污染。
func ResetForTest() {
	defaultHub = NewHub()
	ResetTestnetGreen()
	ResetBoostForTest()
	resetEntriesForTest()
}

// SetRunHook 注册运行标记回调。测试和进程启动都会换 Hub，回调要重新挂上。
// SetPauseHook 在单条策略自动暂停时回调。实现只许写库，不能再进 Hub。
func (h *Hub) SetPauseHook(fn func(strategyID int64, reason string)) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.onPause = fn
	h.mu.Unlock()
}

// SetPauseEntries 立刻改内存里的新开仓开关。下一拍以及持仓中的这一拍都认它。
func (h *Hub) SetPauseEntries(userID, strategyID int64, paused bool) {
	if h == nil {
		return
	}
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	if snap, ok := h.snaps[key]; ok {
		snap.PauseEntries = paused
		h.snaps[key] = snap
	}
	h.mu.Unlock()
	if eng == nil {
		return
	}
	eng.mu.Lock()
	eng.cfg.PauseEntries = paused
	snap := eng.Snapshot()
	eng.mu.Unlock()
	h.mu.Lock()
	h.snaps[key] = snap
	h.mu.Unlock()
}

// ClearPause 清掉内存里的暂停标记，供手动 resume 之后再 Start。
func (h *Hub) ClearPause(userID, strategyID int64) {
	if h == nil {
		return
	}
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	h.mu.Unlock()
	if eng != nil {
		eng.mu.Lock()
		eng.ClearPause()
		snap := eng.Snapshot()
		eng.mu.Unlock()
		h.mu.Lock()
		h.snaps[key] = snap
		h.mu.Unlock()
	}
}

// boundExchange 返回这台引擎正在用的交易所客户端。没有引擎时为 nil。
func (h *Hub) boundExchange(userID, strategyID int64) Exchange {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	eng := h.engines[sessionKey(userID, strategyID)]
	h.mu.Unlock()
	if eng == nil {
		return nil
	}
	eng.mu.Lock()
	defer eng.mu.Unlock()
	return eng.ex
}

func (h *Hub) SetRunHook(fn RunHook) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.onRun = fn
	h.mu.Unlock()
}

func sessionKey(userID, strategyID int64) string {
	return fmt.Sprintf("%d:%d", userID, strategyID)
}

func (h *Hub) Start(userID, strategyID int64, cfg Config, in StartInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cfg = cfg.Normalize()
	cfg.ID = strategyID
	if h.symbolTakenLocked(cfg, strategyID) {
		return Snapshot{}, ErrSymbolInUse
	}
	eng, err := h.prepare(userID, strategyID, cfg, secrets)
	if err != nil {
		if eng != nil {
			eng.mu.Lock()
			snap := eng.Snapshot()
			eng.mu.Unlock()
			h.storeSnapLocked(sessionKey(userID, strategyID), snap)
			return snap, err
		}
		return Snapshot{}, err
	}
	eng.mu.Lock()
	err = eng.Start(in)
	snap := eng.Snapshot()
	eng.mu.Unlock()
	h.storeSnapLocked(sessionKey(userID, strategyID), snap)
	return snap, err
}

func (h *Hub) Step(userID, strategyID int64, cfg Config, in StepInput, secrets SecretOpener) (Snapshot, error) {
	key := sessionKey(userID, strategyID)
	cfg = cfg.Normalize()
	cfg.ID = strategyID

	h.mu.Lock()
	if in.PositionsKnown {
		h.notePositionsLocked(cfg.ExchangeKeyID, in.Positions)
	}
	if in.WalletKnown {
		h.noteAccountLocked(cfg.ExchangeKeyID, in.Wallet, in.Available)
	}
	if in.EquityKnown {
		h.noteEquityLocked(cfg.ExchangeKeyID, in.AccountEquity)
		if in.AccountEquity <= BalanceFloorUSDT {
			h.haltKeyLocked(cfg.ExchangeKeyID, ReasonBalanceFloor)
			eng := h.engines[key]
			if eng == nil {
				h.mu.Unlock()
				return Snapshot{LastReason: ReasonBalanceFloor}, nil
			}
			snap, hasSnap := h.snaps[key]
			h.mu.Unlock()
			eng.mu.Lock()
			busy := eng.Busy()
			if !busy {
				snap = eng.Snapshot()
				eng.mu.Unlock()
				h.mu.Lock()
				h.storeSnapLocked(key, snap)
				h.mu.Unlock()
				return snap, nil
			}
			eng.mu.Unlock()
			_ = hasSnap
		} else {
			h.mu.Unlock()
		}
	} else {
		h.mu.Unlock()
	}

	h.mu.Lock()
	eng := h.engines[key]
	if eng == nil {
		h.mu.Unlock()
		return Snapshot{}, ErrNotRunning
	}
	skipReason := in.SkipReason
	if skipReason == "" {
		skipReason = h.entrySkipLocked(cfg, eng)
	}
	var livePeers []int64
	if strings.EqualFold(cfg.Mode, ModeLive) {
		livePeers = h.liveArmedIDsLocked()
	}
	h.mu.Unlock()

	eng.mu.Lock()
	// 每一拍都吃进策略参数。持仓中也写入，已挂上的止损止盈不改价，下一笔开仓用新参数。
	eng.noteLiveFlags(cfg)
	if err := eng.storeConfig(cfg); err != nil {
		snap := eng.Snapshot()
		eng.mu.Unlock()
		h.mu.Lock()
		h.storeSnapLocked(key, snap)
		h.mu.Unlock()
		return snap, err
	}
	if !eng.Busy() {
		ex, err := NewExchange(cfg)
		if err != nil {
			snap := eng.Snapshot()
			eng.mu.Unlock()
			h.mu.Lock()
			h.storeSnapLocked(key, snap)
			h.mu.Unlock()
			return snap, err
		}
		if err := eng.UseExchange(ex); err != nil {
			snap := eng.Snapshot()
			eng.mu.Unlock()
			h.mu.Lock()
			h.storeSnapLocked(key, snap)
			h.mu.Unlock()
			return snap, err
		}
		if in.SkipReason == "" {
			in.SkipReason = skipReason
		}
		if strings.EqualFold(cfg.Mode, ModeLive) {
			in.LivePeerIDs = livePeers
		}
	}
	eng.SetUser(userID)
	eng.SetSecrets(secrets)
	if in.Backtest == nil && cfg.MinWinRate > 0 && len(in.Candles) > cfg.EmaSlow+1 {
		if res, err := Backtest(cfg, in.Candles, in.Higher); err == nil {
			sum := res.Summary(at(in.Now))
			in.Backtest = &sum
		}
	}
	snap, err := eng.Step(in)
	eng.mu.Unlock()

	h.mu.Lock()
	h.storeSnapLocked(key, snap)
	h.mu.Unlock()
	return snap, err
}

// ReconcileFlat 在持仓期间核对交易所是否已经空仓。不跑开仓信号，也不改风控门。
func (h *Hub) ReconcileFlat(userID, strategyID int64, now time.Time, secrets SecretOpener) (Snapshot, error) {
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	h.mu.Unlock()
	if eng == nil {
		return Snapshot{}, nil
	}
	eng.mu.Lock()
	eng.SetSecrets(secrets)
	snap, err := eng.ReconcileFlat(now)
	eng.mu.Unlock()
	h.mu.Lock()
	h.storeSnapLocked(key, snap)
	h.mu.Unlock()
	return snap, err
}

func (h *Hub) Stop(userID, strategyID int64, in StepInput, secrets SecretOpener) (Snapshot, error) {
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	onRun := h.onRun
	h.mu.Unlock()
	if eng == nil {
		return Snapshot{State: StateIdle}, nil
	}
	eng.mu.Lock()
	eng.SetSecrets(secrets)
	err := eng.Stop(in)
	sid := eng.cfg.ID
	snap := eng.Snapshot()
	eng.mu.Unlock()
	h.mu.Lock()
	h.storeSnapLocked(key, snap)
	h.mu.Unlock()
	if sid > 0 && onRun != nil {
		onRun(sid, false)
	}
	return snap, err
}

// ApplyConfig 把刚保存的策略写进正在跑的引擎，不重启、不平仓。
// 已挂上的止损止盈保持原价；下一笔开仓用新参数。
func (h *Hub) ApplyConfig(userID, strategyID int64, cfg Config) {
	if h == nil || strategyID <= 0 {
		return
	}
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	h.mu.Unlock()
	if eng == nil {
		return
	}
	cfg = cfg.Normalize()
	cfg.ID = strategyID
	if cfg.Revision == 0 {
		cfg.Revision = time.Now().UnixNano()
	}
	eng.mu.Lock()
	_ = eng.storeConfig(cfg)
	snap := eng.Snapshot()
	eng.mu.Unlock()
	h.mu.Lock()
	h.storeSnapLocked(key, snap)
	h.mu.Unlock()
}

// Config 返回内存里的策略参数。没有这台引擎时 ok 为 false。
func (h *Hub) Config(userID, strategyID int64) (Config, bool) {
	if h == nil {
		return Config{}, false
	}
	h.mu.Lock()
	eng := h.engines[sessionKey(userID, strategyID)]
	h.mu.Unlock()
	if eng == nil {
		return Config{}, false
	}
	eng.mu.Lock()
	defer eng.mu.Unlock()
	return eng.cfg, true
}

// PutForTest 把一台引擎放进内存表，供交易台读取快照。只给测试用。
func (h *Hub) PutForTest(userID, strategyID int64, eng *Engine) {
	if h == nil || eng == nil {
		return
	}
	key := sessionKey(userID, strategyID)
	eng.mu.Lock()
	eng.cfg.ID = strategyID
	snap := eng.Snapshot()
	eng.mu.Unlock()
	h.mu.Lock()
	h.engines[key] = eng
	h.storeSnapLocked(key, snap)
	h.mu.Unlock()
}

// SetAccount 记下某把密钥的钱包余额和可用余额。
func (h *Hub) SetAccount(keyID int64, wallet, available float64) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.noteAccountLocked(keyID, wallet, available)
	h.mu.Unlock()
}

// EntrySkip 在共享锁里计算组合限制。self 不计入已有持仓。
func (h *Hub) EntrySkip(cfg Config) string {
	if h == nil {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.entrySkipLocked(cfg.Normalize(), nil)
}

// SymbolRunning 报告这把密钥下是否已有另一条策略在跑这个交易对。
func (h *Hub) SymbolRunning(keyID int64, symbol string, exceptStrategy int64) bool {
	if h == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.symbolTakenLocked(Config{ID: exceptStrategy, ExchangeKeyID: keyID, Symbol: symbol}, exceptStrategy)
}

func (h *Hub) storeSnapLocked(key string, snap Snapshot) {
	if h.snaps == nil {
		h.snaps = map[string]Snapshot{}
	}
	h.snaps[key] = snap
}

func (h *Hub) State(userID, strategyID int64) (Snapshot, bool) {
	key := sessionKey(userID, strategyID)
	h.mu.Lock()
	eng := h.engines[key]
	if eng == nil {
		h.mu.Unlock()
		return Snapshot{}, false
	}
	cached, hasCached := h.snaps[key]
	h.mu.Unlock()
	if eng.mu.TryLock() {
		snap := eng.Snapshot()
		eng.mu.Unlock()
		h.mu.Lock()
		h.storeSnapLocked(key, snap)
		h.mu.Unlock()
		return snap, true
	}
	if hasCached {
		cached.TestnetGreen = TestnetGreen()
		return cached, true
	}
	eng.mu.Lock()
	snap := eng.Snapshot()
	eng.mu.Unlock()
	return snap, true
}

// Sessions 返回某个用户在内存里的全部引擎快照。
func (h *Hub) Sessions(userID int64) map[int64]Snapshot {
	h.mu.Lock()
	prefix := fmt.Sprintf("%d:", userID)
	type item struct {
		key string
		eng *Engine
		cached Snapshot
		hasCached bool
	}
	var items []item
	for key, eng := range h.engines {
		if !strings.HasPrefix(key, prefix) || eng == nil {
			continue
		}
		cached, ok := h.snaps[key]
		items = append(items, item{key: key, eng: eng, cached: cached, hasCached: ok})
	}
	h.mu.Unlock()
	out := map[int64]Snapshot{}
	for _, it := range items {
		var id int64
		if _, err := fmt.Sscanf(it.key, "%d:%d", &userID, &id); err != nil || id <= 0 {
			continue
		}
		if it.eng.mu.TryLock() {
			snap := it.eng.Snapshot()
			it.eng.mu.Unlock()
			out[id] = snap
		} else if it.hasCached {
			s := it.cached
			s.TestnetGreen = TestnetGreen()
			out[id] = s
		} else {
			it.eng.mu.Lock()
			out[id] = it.eng.Snapshot()
			it.eng.mu.Unlock()
		}
	}
	return out
}

func (h *Hub) prepare(userID, strategyID int64, cfg Config, secrets SecretOpener) (*Engine, error) {
	key := sessionKey(userID, strategyID)
	eng := h.engines[key]
	if eng != nil {
		eng.mu.Lock()
		defer eng.mu.Unlock()
		if eng.State() == StateError {
			eng.SetSecrets(secrets)
			return eng, ErrNoAutoReopen
		}
		if eng.Busy() {
			eng.SetSecrets(secrets)
			return eng, nil
		}
	}
	ex, err := NewExchange(cfg)
	if err != nil {
		return eng, err
	}
	if eng == nil {
		eng = NewEngine(cfg, ex, StdLogger())
		h.engines[key] = eng
	} else {
		if err := eng.UpdateConfig(cfg); err != nil {
			return eng, err
		}
		if err := eng.UseExchange(ex); err != nil {
			return eng, err
		}
	}
	eng.cfg.ID = strategyID
	eng.SetUser(userID)
	eng.SetSecrets(secrets)
	sid := strategyID
	eng.SetPauseHook(func(reason string) {
		if h.onPause != nil && sid > 0 {
			h.onPause(sid, reason)
		}
	})
	return eng, nil
}

func (h *Hub) noteAccountLocked(keyID int64, wallet, available float64) {
	if keyID <= 0 {
		return
	}
	if h.accounts == nil {
		h.accounts = map[int64]accountSnap{}
	}
	snap := h.accounts[keyID]
	snap.Wallet = wallet
	snap.Available = available
	snap.Known = true
	h.accounts[keyID] = snap
}

func (h *Hub) noteEquityLocked(keyID int64, equity float64) {
	if keyID <= 0 {
		return
	}
	if h.accounts == nil {
		h.accounts = map[int64]accountSnap{}
	}
	snap := h.accounts[keyID]
	snap.Equity = equity
	snap.EquityKnown = true
	h.accounts[keyID] = snap
}

// SetPositions 记下这把密钥最新的 positionRisk。空切片表示交易所确认空仓。
func (h *Hub) SetPositions(keyID int64, positions []KeyPosition) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.notePositionsLocked(keyID, positions)
	h.mu.Unlock()
}

func (h *Hub) notePositionsLocked(keyID int64, positions []KeyPosition) {
	if keyID <= 0 {
		return
	}
	if h.accounts == nil {
		h.accounts = map[int64]accountSnap{}
	}
	snap := h.accounts[keyID]
	snap.Positions = append([]KeyPosition(nil), positions...)
	snap.PositionsKnown = true
	h.accounts[keyID] = snap
}

func (h *Hub) symbolTakenLocked(cfg Config, strategyID int64) bool {
	symbol := strings.ToUpper(strings.TrimSpace(cfg.Symbol))
	if cfg.ExchangeKeyID <= 0 || symbol == "" {
		return false
	}
	for key, eng := range h.engines {
		if eng == nil {
			continue
		}
		if eng.mu.TryLock() {
			running := eng.running
			id := eng.cfg.ID
			keyID := eng.cfg.ExchangeKeyID
			sym := eng.cfg.Symbol
			eng.mu.Unlock()
			if !running || id == strategyID {
				continue
			}
			if keyID == cfg.ExchangeKeyID && strings.EqualFold(sym, symbol) {
				return true
			}
			continue
		}
		if snap, ok := h.snaps[key]; ok {
			if !snap.Running {
				continue
			}
			var uid, sid int64
			_, _ = fmt.Sscanf(key, "%d:%d", &uid, &sid)
			if sid == strategyID {
				continue
			}
			if eng.cfg.ExchangeKeyID == cfg.ExchangeKeyID && strings.EqualFold(eng.cfg.Symbol, symbol) {
				return true
			}
		}
	}
	return false
}

// entrySkipLocked 必须在 h.mu 下调用。
// 组合保证金只认这把密钥的 positionRisk，不认内存里的旧仓，也不认没在跑的策略。
// 正在判断的这台引擎也不从账本里扣除：交易所上还开着的仓都要占额度。
func (h *Hub) entrySkipLocked(cfg Config, _ *Engine) string {
	if acc, ok := h.accounts[cfg.ExchangeKeyID]; ok && acc.EquityKnown && acc.Equity <= BalanceFloorUSDT {
		return ReasonBalanceFloor
	}
	var positions []KeyPosition
	if acc, ok := h.accounts[cfg.ExchangeKeyID]; ok && acc.PositionsKnown {
		positions = acc.Positions
	}
	open, margin := liveBookMargin(positions)
	if limit := cfg.OpenPositionLimit(); limit > 0 && open >= limit {
		return ReasonPortfolioLimit
	}
	planned := plannedMargin(cfg)
	if acc, ok := h.accounts[cfg.ExchangeKeyID]; ok && acc.Known {
		planned = marginForBalance(cfg, acc.Available, true, TakerFeeRate)
	}
	if cfg.MaxMarginUsdt > 0 && margin+planned > cfg.MaxMarginUsdt+1e-9 {
		return ReasonPortfolioLimit
	}
	return ""
}

func liveBookMargin(positions []KeyPosition) (open int, margin float64) {
	for _, pos := range positions {
		if pos.Qty <= 0 {
			continue
		}
		open++
		margin += pos.InitialMargin()
	}
	return open, margin
}

// liveArmedIDsLocked 收集仍在武装、可以开新仓的实盘策略。必须在 h.mu 下调用。
func (h *Hub) liveArmedIDsLocked() []int64 {
	ids := make([]int64, 0)
	for key, eng := range h.engines {
		if eng == nil {
			continue
		}
		if eng.mu.TryLock() {
			ok := eng.running && eng.cfg.ID > 0 && strings.EqualFold(eng.cfg.Mode, ModeLive) && eng.State() == StateArmed
			id := eng.cfg.ID
			eng.mu.Unlock()
			if ok {
				ids = append(ids, id)
			}
			continue
		}
		if snap, ok := h.snaps[key]; ok && snap.Running && strings.EqualFold(snap.Mode, ModeLive) && snap.State == StateArmed {
			var uid, sid int64
			if _, err := fmt.Sscanf(key, "%d:%d", &uid, &sid); err == nil && sid > 0 {
				ids = append(ids, sid)
			}
		}
	}
	return ids
}

func (h *Hub) haltKeyLocked(keyID int64, reason string) {
	var ids []int64
	for key, eng := range h.engines {
		if eng == nil {
			continue
		}
		if eng.mu.TryLock() {
			if eng.cfg.ExchangeKeyID != keyID {
				eng.mu.Unlock()
				continue
			}
			eng.running = false
			eng.note("stop", reason)
			switch eng.State() {
			case StateArmed, StateBlocked:
				_ = eng.m.Transition(Event{Kind: EventStop, Reason: reason})
			}
			if eng.cfg.ID > 0 {
				ids = append(ids, eng.cfg.ID)
			}
			snap := eng.Snapshot()
			eng.mu.Unlock()
			h.storeSnapLocked(key, snap)
		}
	}
	if h.onRun != nil {
		for _, id := range ids {
			h.onRun(id, false)
		}
	}
}
