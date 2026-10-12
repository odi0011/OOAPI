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
	Positions      []KeyPosition
	PositionsKnown bool
}

// Hub 按用户和策略 ID 保存多台引擎。组合风控在同一把锁里汇总。
type Hub struct {
	mu       sync.Mutex
	engines  map[string]*Engine
	accounts map[int64]accountSnap
	onRun    RunHook
	onPause  func(strategyID int64, reason string)
}

func NewHub() *Hub {
	return &Hub{engines: map[string]*Engine{}, accounts: map[int64]accountSnap{}}
}

var defaultHub = NewHub()

// DefaultHub 是进程内唯一的引擎表。
func DefaultHub() *Hub { return defaultHub }

// ResetForTest 清空引擎和实盘门闩，避免测试互相污染。
func ResetForTest() {
	defaultHub = NewHub()
	ResetTestnetGreen()
	ResetBoostForTest()
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

// ClearPause 清掉内存里的暂停标记，供手动 resume 之后再 Start。
func (h *Hub) ClearPause(userID, strategyID int64) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng != nil {
		eng.ClearPause()
	}
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
			return eng.Snapshot(), err
		}
		return Snapshot{}, err
	}
	err = eng.Start(in)
	return eng.Snapshot(), err
}

func (h *Hub) Step(userID, strategyID int64, cfg Config, in StepInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cfg = cfg.Normalize()
	cfg.ID = strategyID
	if in.PositionsKnown {
		h.notePositionsLocked(cfg.ExchangeKeyID, in.Positions)
	}
	if in.WalletKnown {
		h.noteAccountLocked(cfg.ExchangeKeyID, in.Wallet, in.Available)
		if in.Wallet <= BalanceFloorUSDT {
			h.haltKeyLocked(cfg.ExchangeKeyID, ReasonBalanceFloor)
			eng := h.engines[sessionKey(userID, strategyID)]
			if eng == nil || !eng.Busy() {
				if eng == nil {
					return Snapshot{LastReason: ReasonBalanceFloor}, nil
				}
				return eng.Snapshot(), nil
			}
		}
	}
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{}, ErrNotRunning
	}
	if !eng.Busy() {
		if err := eng.UpdateConfig(cfg); err != nil {
			return eng.Snapshot(), err
		}
		ex, err := NewExchange(cfg)
		if err != nil {
			return eng.Snapshot(), err
		}
		if err := eng.UseExchange(ex); err != nil {
			return eng.Snapshot(), err
		}
		if in.SkipReason == "" {
			in.SkipReason = h.entrySkipLocked(cfg, eng)
		}
		if strings.EqualFold(cfg.Mode, ModeLive) {
			in.LivePeerIDs = h.liveArmedIDsLocked()
		}
	}
	eng.SetSecrets(secrets)
	if in.Backtest == nil && cfg.MinWinRate > 0 && len(in.Candles) > cfg.EmaSlow+1 {
		if res, err := Backtest(cfg, in.Candles, in.Higher); err == nil {
			sum := res.Summary(at(in.Now))
			in.Backtest = &sum
		}
	}
	return eng.Step(in)
}

func (h *Hub) Stop(userID, strategyID int64, in StepInput, secrets SecretOpener) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{State: StateIdle}, nil
	}
	eng.SetSecrets(secrets)
	err := eng.Stop(in)
	if eng.cfg.ID > 0 && h.onRun != nil {
		h.onRun(eng.cfg.ID, false)
	}
	return eng.Snapshot(), err
}

// ApplyConfig 把刚保存的策略写进正在跑的引擎，不重启、不平仓。
// 已挂上的止损止盈保持原价；下一笔开仓用新参数。
func (h *Hub) ApplyConfig(userID, strategyID int64, cfg Config) {
	if h == nil || strategyID <= 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return
	}
	cfg = cfg.Normalize()
	cfg.ID = strategyID
	if cfg.Revision == 0 {
		cfg.Revision = time.Now().UnixNano()
	}
	_ = eng.storeConfig(cfg)
}

// Config 返回内存里的策略参数。没有这台引擎时 ok 为 false。
func (h *Hub) Config(userID, strategyID int64) (Config, bool) {
	if h == nil {
		return Config{}, false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Config{}, false
	}
	return eng.cfg, true
}

// PutForTest 把一台引擎放进内存表，供交易台读取快照。只给测试用。
func (h *Hub) PutForTest(userID, strategyID int64, eng *Engine) {
	if h == nil || eng == nil {
		return
	}
	h.mu.Lock()
	eng.cfg.ID = strategyID
	h.engines[sessionKey(userID, strategyID)] = eng
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

func (h *Hub) State(userID, strategyID int64) (Snapshot, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	eng := h.engines[sessionKey(userID, strategyID)]
	if eng == nil {
		return Snapshot{}, false
	}
	return eng.Snapshot(), true
}

// Sessions 返回某个用户在内存里的全部引擎快照。
func (h *Hub) Sessions(userID int64) map[int64]Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	prefix := fmt.Sprintf("%d:", userID)
	out := map[int64]Snapshot{}
	for key, eng := range h.engines {
		if !strings.HasPrefix(key, prefix) || eng == nil {
			continue
		}
		out[eng.cfg.ID] = eng.Snapshot()
	}
	return out
}

func (h *Hub) prepare(userID, strategyID int64, cfg Config, secrets SecretOpener) (*Engine, error) {
	key := sessionKey(userID, strategyID)
	eng := h.engines[key]
	if eng != nil && eng.State() == StateError {
		eng.SetSecrets(secrets)
		return eng, ErrNoAutoReopen
	}
	if eng != nil && eng.Busy() {
		eng.SetSecrets(secrets)
		return eng, nil
	}
	ex, err := NewExchange(cfg)
	if err != nil {
		return eng, err
	}
	if eng == nil {
		eng = NewEngine(cfg, ex, nil)
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
	for _, eng := range h.engines {
		if eng == nil || !eng.running || eng.cfg.ID == strategyID {
			continue
		}
		if eng.cfg.ExchangeKeyID == cfg.ExchangeKeyID && strings.EqualFold(eng.cfg.Symbol, symbol) {
			return true
		}
	}
	return false
}

// entrySkipLocked 必须在 h.mu 下调用。
// 组合保证金只认这把密钥的 positionRisk，不认内存里的旧仓，也不认没在跑的策略。
// 正在判断的这台引擎也不从账本里扣除：交易所上还开着的仓都要占额度。
func (h *Hub) entrySkipLocked(cfg Config, _ *Engine) string {
	if acc, ok := h.accounts[cfg.ExchangeKeyID]; ok && acc.Known && acc.Wallet <= BalanceFloorUSDT {
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
	for _, eng := range h.engines {
		if eng == nil || !eng.running || eng.cfg.ID <= 0 {
			continue
		}
		if !strings.EqualFold(eng.cfg.Mode, ModeLive) || eng.State() != StateArmed {
			continue
		}
		ids = append(ids, eng.cfg.ID)
	}
	return ids
}

func (h *Hub) haltKeyLocked(keyID int64, reason string) {
	var ids []int64
	for _, eng := range h.engines {
		if eng == nil || eng.cfg.ExchangeKeyID != keyID {
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
	}
	if h.onRun != nil {
		for _, id := range ids {
			h.onRun(id, false)
		}
	}
}
