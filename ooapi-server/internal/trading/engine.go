package trading

import (
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// Logger 是引擎审计出口。实现不得写入密钥。
type Logger interface {
	Printf(format string, args ...any)
}

type discardLog struct{}

func (discardLog) Printf(string, ...any) {}

func DiscardLogger() Logger { return discardLog{} }

type stdLog struct{}

func (stdLog) Printf(format string, args ...any) { log.Printf(format, args...) }

// StdLogger 把引擎审计写进进程日志。Hub 用它，避免保护单失败被丢掉。
func StdLogger() Logger { return stdLog{} }

// Candle 是一根已收盘 K 线。信号用收盘价；trend 模式还看成交量。
type Candle struct {
	OpenTime time.Time `json:"openTime"`
	Close    float64   `json:"close"`
	Volume   float64   `json:"volume,omitempty"`
}

// StartInput 是启动时能看到的账户与市场环境。
type StartInput struct {
	Now            time.Time
	FundingRate    float64
	LiqDistancePct float64
	EquityUSDT     float64
}

// StepInput 是推进一根 K 线所需的市场快照。
type StepInput struct {
	Now            time.Time
	Candles        []Candle
	MarkPrice      float64
	FundingRate    float64
	LiqDistancePct float64
	EquityUSDT     float64
	// Higher 是已经收盘的高周期 K 线（trend 模式用 15m）。
	Higher []Candle `json:"higherCandles,omitempty"`
	// MinNotional 来自交易所 filters。0 时用默认 5 USDT 做预检，真正下单仍走 Rules。
	MinNotional float64 `json:"-"`
	// Backtest 是最近一次回测。有值且低于策略 minWinRate 时不开新仓。
	Backtest *BacktestSummary `json:"-"`
	// SkipReason 由 Hub 在共享锁里算完组合约束后填入，只拦截开仓。
	SkipReason string `json:"-"`
	// Wallet / Available 是同一把密钥的钱包余额。暂停线用它，0.5U 停机不用它。
	Wallet      float64 `json:"-"`
	Available   float64 `json:"-"`
	WalletKnown bool    `json:"-"`
	// AccountEquity 是钱包余额加全部持仓的未实现盈亏。EquityKnown 为真才参与 0.5U 停机。
	AccountEquity float64 `json:"-"`
	EquityKnown   bool    `json:"-"`
	// Positions 是这把密钥的 positionRisk 快照，只含仍有持仓量的合约。
	// PositionsKnown 为真才参与组合保证金；空切片表示交易所已经确认空仓。
	Positions      []KeyPosition `json:"-"`
	PositionsKnown bool          `json:"-"`
	// LivePeerIDs 是加速窗口里仍在武装、可以开仓的实盘策略（含自己）。
	// 为空时加速门只比较已经报告过的信号。
	LivePeerIDs []int64 `json:"-"`
}

// Snapshot 是对外展示的运行状态。
type Snapshot struct {
	State           State   `json:"state"`
	Side            Side    `json:"side,omitempty"`
	EntryPrice      float64 `json:"entryPrice,omitempty"`
	StopPrice       float64 `json:"stopPrice,omitempty"`
	LiqPrice        float64 `json:"liqPrice,omitempty"`
	TakeProfitPrice float64 `json:"takeProfitPrice,omitempty"`
	Qty             float64 `json:"qty,omitempty"`
	// DayRealized 来自币安 income（已实现、手续费、资金费），按 Asia/Shanghai 自然日。
	DayRealized float64 `json:"dayRealizedUsdt"`
	// CumulativeRealized 与当日同一来源，从策略创建时间起算。日切后当日归零、累计保留。
	// 重启后重新向币安读取，不靠进程内逐笔账本。
	CumulativeRealized float64 `json:"cumulativeRealizedUsdt"`
	Halted             bool    `json:"halted"`
	LastError          string  `json:"lastError,omitempty"`
	Mode               string  `json:"mode"`
	TestnetGreen       bool    `json:"testnetGreen"`
	Running            bool    `json:"running"`
	LastAction         string  `json:"lastAction,omitempty"`
	LastReason         string  `json:"lastReason,omitempty"`
	PauseReason        string  `json:"pauseReason,omitempty"`
	// PauseEntries 为真时这一拍不会开新仓。已有仓和止损止盈不受影响。
	PauseEntries  bool             `json:"pauseEntries"`
	MarkPrice     float64          `json:"markPrice,omitempty"`
	UnrealizedPnl float64          `json:"unrealizedPnl,omitempty"`
	LastBacktest  *BacktestSummary `json:"lastBacktest,omitempty"`
	// Entry 是当前持仓开仓时记下的分数和回测。平仓后清空，历史仍在开仓日志里。
	Entry *EntryStamp `json:"entry,omitempty"`
}

// Runtime 是可以跨进程恢复的风险状态。不保存持仓，避免重启后自动重开。
// Cumulative 是会话累计已实现；旧数据没有该字段时，恢复逻辑用当日已实现兜底。
type Runtime struct {
	State      State
	Day        time.Time
	Capital    float64
	Realized   float64
	Cumulative float64
	Halted     bool
	LastError  string
}

type position struct {
	Side     Side
	Qty      float64
	Entry    float64
	Stop     float64
	Take     float64
	Liq      float64
	OpenedAt time.Time
}

// entryDraft 是提交开仓时先记下的分数和回测。成交后才写成开仓记录。
type entryDraft struct {
	set      bool
	score    int
	minScore int
	boost    bool
	forced   bool
	sum      BacktestSummary
	hasSum   bool
}

// Engine 把信号、风控和状态机串起来。调用方一次只推进一个线程。
type Engine struct {
	cfg    Config
	ex     Exchange
	log    Logger
	m      *Machine
	ledger Ledger
	// incomeBooked 为真时当日和累计已实现来自币安账单，日亏停机看上海当日这一个数。
	incomeBooked bool
	pos          position
	running      bool
	lastError    string
	lastAction   string
	lastReason   string
	lastEntry    float64
	lastStop     float64
	lastLiq      float64
	lastBarKey   string
	lastMark     float64
	lastBacktest *BacktestSummary
	openEntry    *EntryStamp
	pendingEntry entryDraft
	justOpened   *EntryStamp
	stepAt       time.Time
	userID       int64
	// openEntryID 是这笔持仓在 trading_entries 里的行。平仓时用它补上出场。
	openEntryID int64
	// closedSide 是刚平掉的方向。快照清掉持仓后，事件仍要写明是哪一边。
	closedSide   Side
	rFraction    float64
	minNotional  float64
	audit        []string
	secrets      SecretOpener
	secretOpens  int
	lossStreak   int
	pausedReason string
	onPause      func(reason string)
	// startedAt 是本次武装的时间。策略没有创建时间时，累计已实现才退回到这里。
	startedAt time.Time
	// incomeAt 是上一份币安账单的读取时间。IncomeRefresh 之内不再请求。
	incomeAt     time.Time
	incomeSince  time.Time
	incomeSymbol string
	incomeDay    float64
	incomeCum    float64
	incomeOK     bool
	// lastDetail 是最近一次交易所错误原文，写进事件 msg，不替代机器可读的 LastReason。
	lastDetail string
}

func NewEngine(cfg Config, ex Exchange, logger Logger) *Engine {
	if logger == nil {
		logger = discardLog{}
	}
	if ex == nil {
		ex = NewPaper()
	}
	return &Engine{
		cfg:         cfg,
		ex:          ex,
		log:         logger,
		m:           NewMachine(),
		rFraction:   DefaultRFraction,
		minNotional: MinNotionalUSDT,
	}
}

func (e *Engine) State() State {
	if e == nil || e.m == nil {
		return StateIdle
	}
	return e.m.State
}

func (e *Engine) Busy() bool {
	switch e.State() {
	case StateEntrySubmitted, StateInPosition, StateExitSubmitted:
		return true
	default:
		return false
	}
}

func (e *Engine) Audit() []string {
	out := make([]string, len(e.audit))
	copy(out, e.audit)
	return out
}

func (e *Engine) Snapshot() Snapshot {
	entry, stop, liq := e.pos.Entry, e.pos.Stop, e.pos.Liq
	if entry <= 0 {
		entry = e.lastEntry
	}
	if stop <= 0 {
		stop = e.lastStop
	}
	if liq <= 0 {
		liq = e.lastLiq
	}
	return Snapshot{
		State:              e.State(),
		Side:               e.pos.Side,
		EntryPrice:         entry,
		StopPrice:          stop,
		LiqPrice:           liq,
		TakeProfitPrice:    e.pos.Take,
		Qty:                e.pos.Qty,
		DayRealized:        e.ledger.Realized,
		CumulativeRealized: e.ledger.Cumulative,
		Halted:             e.ledger.Halted || e.State() == StateDailyHalt,
		LastError:          e.lastError,
		Mode:               e.cfg.Mode,
		TestnetGreen:       TestnetGreen(),
		Running:            e.running,
		LastAction:         e.lastAction,
		LastReason:         e.lastReason,
		PauseReason:        e.pausedReason,
		PauseEntries:       e.cfg.PauseEntries,
		MarkPrice:          e.lastMark,
		UnrealizedPnl:      e.unrealized(e.lastMark),
		LastBacktest:       e.lastBacktest,
		Entry:              e.openEntry,
	}
}

// SetUser 记下这台引擎属于哪个用户，开仓记录按它归档。
func (e *Engine) SetUser(id int64) {
	if e == nil {
		return
	}
	e.userID = id
}

func (e *Engine) Trace() []State { return e.m.Trace() }

func (e *Engine) Runtime() Runtime {
	return Runtime{
		State:      e.State(),
		Day:        e.ledger.Day,
		Capital:    e.ledger.Capital,
		Realized:   e.ledger.Realized,
		Cumulative: e.ledger.Cumulative,
		Halted:     e.ledger.Halted,
		LastError:  e.lastError,
	}
}

// Restore 只恢复停机和错误，不恢复持仓。重启后的在途交易记为 Error，等待人工 Stop。
func (e *Engine) Restore(rt Runtime) {
	cumulative := rt.Cumulative
	if cumulative == 0 {
		cumulative = rt.Realized
	}
	e.ledger = Ledger{
		Day:        rt.Day,
		Capital:    rt.Capital,
		Realized:   rt.Realized,
		Cumulative: cumulative,
		Halted:     rt.Halted,
	}
	e.lastError = rt.LastError
	switch {
	case rt.Halted:
		e.m.Restore(StateDailyHalt, "restored daily halt")
		e.running = true
	case rt.State == StateError || rt.State == StateEntrySubmitted || rt.State == StateInPosition || rt.State == StateExitSubmitted:
		e.running = false
		msg := rt.LastError
		if msg == "" {
			msg = "restarted during a trade; auto-reopen suppressed"
		}
		e.lastError = msg
		e.m.Restore(StateError, msg)
	default:
		e.m.Restore(StateIdle, "restored idle")
	}
}

func (e *Engine) UpdateConfig(cfg Config) error {
	if e.Busy() {
		return ErrConfigLocked
	}
	return e.storeConfig(cfg)
}

// storeConfig 写入策略参数。热更新可以在持仓期间调用，已挂上的止损止盈不改。
// 序号更旧的快照不会盖掉刚保存的配置。
func (e *Engine) storeConfig(cfg Config) error {
	if e == nil {
		return invalid("缺少引擎")
	}
	cfg = cfg.Normalize()
	if e.cfg.Revision > 0 && (cfg.Revision == 0 || cfg.Revision < e.cfg.Revision) {
		return nil
	}
	if cfg.CreatedAt.IsZero() {
		cfg.CreatedAt = e.cfg.CreatedAt
	}
	e.cfg = cfg
	if !e.incomeSince.IsZero() && !e.incomeSince.Equal(e.incomeSinceTime()) {
		e.incomeOK = false
	}
	return nil
}

func (e *Engine) incomeSinceTime() time.Time {
	if e == nil {
		return time.Time{}
	}
	if !e.cfg.CreatedAt.IsZero() {
		return e.cfg.CreatedAt.UTC()
	}
	return e.startedAt
}

func (e *Engine) UseExchange(ex Exchange) error {
	if e.Busy() {
		return ErrConfigLocked
	}
	if ex == nil {
		return invalid("缺少交易所客户端")
	}
	e.ex = ex
	return nil
}

func (e *Engine) SetSecrets(fn SecretOpener) { e.secrets = fn }

func (e *Engine) SecretOpens() int { return e.secretOpens }

// authorize 在发单或平仓前解开密钥。实盘门闩没开时连解开都不做。
func (e *Engine) authorize() error {
	if err := e.gate(); err != nil {
		return err
	}
	if e.secrets == nil {
		return invalid("下单前需要解开交易所密钥")
	}
	creds, err := e.secrets()
	if err != nil {
		return err
	}
	if creds.APIKey == "" || creds.APISecret == "" {
		return invalid("交易所密钥是空的")
	}
	if sink, ok := e.ex.(interface{ UseCredentials(Credentials) error }); ok {
		if err := sink.UseCredentials(creds); err != nil {
			return err
		}
	}
	e.secretOpens++
	return nil
}

func (e *Engine) note(action, reason string) {
	e.lastAction = action
	e.lastReason = reason
}

func (e *Engine) gate() error {
	if e.cfg.Mode == ModeLive && !TestnetGreen() {
		return ErrLiveGateClosed
	}
	return nil
}

// Start 做启动前检查。通过后进入 Armed；不在这里下单。
func (e *Engine) Start(in StartInput) error {
	if err := e.gate(); err != nil {
		return err
	}
	if err := e.cfg.Validate(); err != nil {
		return err
	}
	if e.State() == StateError {
		return ErrNoAutoReopen
	}
	now := at(in.Now)
	if in.EquityUSDT <= 0 {
		return ErrEquityRequired
	}
	e.ledger.Roll(now, in.EquityUSDT)
	if e.ledger.Halted {
		e.enterHalt()
		return ErrDailyHalt
	}
	if e.State() == StateDailyHalt {
		if err := e.m.Transition(Event{Kind: EventNextUTCDay, Reason: "utc day rolled"}); err != nil {
			return err
		}
	}
	if e.pausedReason != "" {
		return ErrPaused
	}
	if e.Busy() {
		return ErrAlreadyRunning
	}
	if blocked, reason := StartBlocked(in.FundingRate, in.LiqDistancePct); blocked {
		e.note("blocked", reason)
		if e.State() != StateBlocked && e.State() != StateArmed && e.State() != StateIdle {
			return withReason(ErrBlocked, reason)
		}
		if err := e.m.Transition(Event{Kind: EventStartBlocked, Reason: reason}); err != nil {
			return err
		}
		return withReason(ErrBlocked, reason)
	}
	if e.State() == StateArmed {
		e.running = true
		e.markStarted(now)
		e.note("armed", "already")
		return nil
	}
	if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "start"}); err != nil {
		return err
	}
	e.forgetPlan()
	e.running = true
	e.markStarted(now)
	e.note("armed", "start")
	return nil
}

func (e *Engine) markStarted(now time.Time) {
	if e == nil || !e.startedAt.IsZero() {
		return
	}
	e.startedAt = now.UTC()
}

func (e *Engine) enterHalt() {
	e.note("halt", "daily_loss")
	if e.State() == StateDailyHalt {
		return
	}
	_ = e.m.Transition(Event{Kind: EventDailyHalt, Reason: "daily_loss"})
}

// Stop 撤掉挂单并平掉持仓，然后回到 Idle。Error 只在这里离开。
func (e *Engine) Stop(in StepInput) error {
	e.running = false
	switch e.State() {
	case StateIdle:
		return nil
	case StateDailyHalt:
		if e.ex != nil {
			_ = e.ex.CancelOpen(e.cfg.Symbol)
		}
		return nil
	case StateError:
		e.cancelAndFlatten("error_flatten")
		e.clearPos()
		return e.m.Transition(Event{Kind: EventStop, Reason: "operator_stop"})
	case StateBlocked, StateArmed:
		if e.ex != nil {
			_ = e.ex.CancelOpen(e.cfg.Symbol)
		}
		e.clearPos()
		return e.m.Transition(Event{Kind: EventStop, Reason: "operator_stop"})
	case StateEntrySubmitted:
		pos, err := e.ex.Position(e.cfg.Symbol)
		if err != nil {
			return e.fail(err.Error())
		}
		if !pos.Open {
			_ = e.ex.CancelOpen(e.cfg.Symbol)
			e.clearStagedEntry()
			e.clearPos()
			return e.m.Transition(Event{Kind: EventStop, Reason: "operator_stop"})
		}
		if err := e.m.Transition(Event{Kind: EventEntryFilled, Reason: "filled before stop"}); err != nil {
			e.clearStagedEntry()
			return e.fail(err.Error())
		}
		e.pos = position{Side: pos.Side, Qty: pos.Qty, Entry: pos.Entry}
		e.commitEntry(Fill{Status: StatusFilled, Price: pos.Entry, Qty: pos.Qty, Side: pos.Side})
		return e.flatten(in, "operator_stop")
	case StateInPosition, StateExitSubmitted:
		return e.flatten(in, "operator_stop")
	default:
		return nil
	}
}

// Step 推进一次。测网撮合在同一次调用里完成成交；同一根 K 线不会连着反手。
func (e *Engine) Step(in StepInput) (snap Snapshot, err error) {
	if e != nil {
		e.lastDetail = ""
		e.justOpened = nil
		e.stepAt = at(in.Now)
	}
	defer func() {
		if e == nil {
			return
		}
		e.syncExchangeBooks(at(in.Now))
		snap = e.Snapshot()
		e.recordTick(in, snap, err)
	}()
	if err = e.gate(); err != nil {
		snap = e.Snapshot()
		return snap, err
	}
	if e.State() == StateError {
		return e.Snapshot(), ErrNoAutoReopen
	}
	if in.Backtest != nil {
		e.rememberBacktest(*in.Backtest)
	}
	if price := mark(in); price > 0 {
		e.lastMark = price
	}
	now := at(in.Now)
	if in.EquityUSDT > 0 {
		e.ledger.Roll(now, in.EquityUSDT)
	} else if !e.ledger.Day.IsZero() {
		e.ledger.Roll(now, e.ledger.Capital)
	}
	// 先对上上海当日账单，再决定能不能开仓。重启后的内存计数不参与这道判断。
	e.syncExchangeBooks(now)
	if e.State() == StateDailyHalt && !e.ledger.Halted {
		if err := e.m.Transition(Event{Kind: EventNextUTCDay, Reason: "utc day rolled"}); err != nil {
			return e.Snapshot(), err
		}
		if e.running {
			_ = e.m.Transition(Event{Kind: EventStartOK, Reason: "rearm"})
		}
		e.note("idle", "utc day rolled")
		return e.Snapshot(), nil
	}
	if snap, stop, err := e.holdIfPaused(in); stop {
		return snap, err
	}
	switch e.State() {
	case StateArmed:
		if e.ledger.Halted {
			e.enterHalt()
			return e.Snapshot(), ErrDailyHalt
		}
		return e.stepArmed(in)
	case StateEntrySubmitted:
		return e.stepEntry(in)
	case StateInPosition:
		return e.stepPosition(in)
	case StateExitSubmitted:
		return e.finishExit(in, e.lastReason)
	case StateDailyHalt:
		return e.Snapshot(), ErrDailyHalt
	default:
		return e.Snapshot(), ErrNotRunning
	}
}

func (e *Engine) stepArmed(in StepInput) (Snapshot, error) {
	// 暂停新开仓只挡这一拍的开仓。不撤保护单，不平已有仓，对账仍在 Step 的收尾里跑。
	if e.cfg.PauseEntries {
		e.note("pause_entries", ReasonEntriesPaused)
		return e.Snapshot(), nil
	}
	if blocked, reason := StartBlocked(in.FundingRate, in.LiqDistancePct); blocked {
		e.note("blocked", reason)
		if err := e.m.Transition(Event{Kind: EventStartBlocked, Reason: reason}); err != nil {
			return e.Snapshot(), err
		}
		return e.Snapshot(), withReason(ErrBlocked, reason)
	}
	// 同一根已收盘 K 线只决定一次开仓。平仓检查不走这里，止损止盈仍会在持仓步里触发。
	// 加速窗口内同一根未收盘 K 线的价格还在变，不能靠 bar key 把后续扫描吃掉。
	if key := barKey(in.Candles); key != "" && key == e.lastBarKey && !e.boosting(in) {
		return e.Snapshot(), nil
	}
	if !e.running {
		return e.Snapshot(), ErrNotRunning
	}
	boosting := e.boosting(in)
	wr := signalWinRate(in, e.lastBacktest)
	emaSide := Side("")
	emaScore := 0
	if boosting {
		got, sc, serr := TrendDirection(e.cfg, in.Candles, in.Higher)
		if serr != nil {
			return e.failed(serr.Error())
		}
		emaSide, emaScore = got, sc
	}
	side, signal, err := e.entrySide(in)
	if err != nil {
		return e.failed(err.Error())
	}
	gateReason := ""
	if e.cfg.GambleMode || e.cfg.MinWinRate > 0 || strings.EqualFold(e.cfg.Mode, ModeLive) {
		sum := in.Backtest
		if sum == nil {
			sum = e.lastBacktest
		}
		gateReason = BacktestGate(e.cfg, sum)
	}
	need := e.cfg.Normalize().MinScore
	score := emaScore
	if !boosting {
		if _, sc, serr := ScoreTrend(e.cfg, in.Candles, in.Higher); serr == nil {
			score = sc
		}
	}
	openSide := side
	if boosting && openSide == "" {
		openSide = emaSide
	}
	if boosting {
		candSide := openSide
		reason := signal
		if gateReason != "" {
			reason = gateReason
		}
		eligible := gateReason == "" && candSide != ""
		boostState.note(e.cfg.ID, wr, eligible)
		boostState.consider(boostCand{
			id:      e.cfg.ID,
			symbol:  e.cfg.Symbol,
			side:    string(candSide),
			score:   emaScore,
			need:    need,
			winrate: wr,
			reason:  reason,
			passes:  eligible,
			clears:  side != "",
		})
	}
	if openSide == "" {
		e.note("none", signal)
		return e.Snapshot(), nil
	}
	if in.SkipReason == "" && in.PositionsKnown && symbolHasPosition(e.cfg.Symbol, in.Positions) {
		in.SkipReason = ReasonSymbolHeld
	}
	blockBoost := func() {
		if boosting {
			boostState.block(e.cfg.ID)
		}
	}
	if in.SkipReason != "" {
		blockBoost()
		e.note("skip", in.SkipReason)
		return e.Snapshot(), nil
	}
	floor := e.floorNotional(in)
	if e.cfg.Leverage > 0 && e.marginBudget()*float64(e.cfg.Leverage)+1e-9 < floor {
		blockBoost()
		e.note("skip", ReasonBelowMinNotional)
		return e.Snapshot(), nil
	}
	if gateReason != "" {
		e.note("skip", gateReason)
		return e.Snapshot(), nil
	}
	price := mark(in)
	if price <= 0 {
		return e.failed("mark price is required")
	}
	qty, err := e.entryQty(price)
	if err != nil {
		if errors.Is(err, ErrNotionalBelowMin) {
			blockBoost()
			e.note("skip", ReasonBelowMinNotional)
			return e.Snapshot(), nil
		}
		return e.Snapshot(), err
	}
	stop, _, liq, err := e.quoteProtection(openSide, price)
	if err != nil {
		return e.failed(err.Error())
	}
	if !StopWithinLiquidation(openSide, price, stop, liq) {
		blockBoost()
		return e.blockStop(price, stop, liq)
	}
	reserved := false
	forced := false
	if boosting {
		allow, reason := boostState.allow(e.cfg.ID, in.LivePeerIDs, at(in.Now))
		if !allow {
			e.note("skip", reason)
			return e.Snapshot(), nil
		}
		reserved = true
		forced = boostState.openingForced(e.cfg.ID)
		if forced {
			signal = "boost_forced"
		} else {
			signal = "boost_entry"
		}
	}
	e.stageEntry(in, score, need, boosting, forced)
	releaseBoost := func() {
		if reserved {
			boostState.release(e.cfg.ID)
			reserved = false
		}
	}
	if err := e.authorize(); err != nil {
		e.clearStagedEntry()
		releaseBoost()
		return e.Snapshot(), err
	}
	if err := e.m.Transition(Event{Kind: EventEntrySignal, Reason: signal}); err != nil {
		e.clearStagedEntry()
		releaseBoost()
		return e.Snapshot(), err
	}
	fill, err := e.ex.PlaceEntry(EntryOrder{
		Symbol:     e.cfg.Symbol,
		Side:       openSide,
		Qty:        qty,
		Price:      price,
		Leverage:   e.cfg.Leverage,
		MarginMode: e.cfg.MarginMode,
	})
	if err != nil {
		e.clearStagedEntry()
		releaseBoost()
		return e.failed(err.Error())
	}
	if reserved {
		boostState.commit(e.cfg.ID)
		reserved = false
	}
	e.lastBarKey = barKey(in.Candles)
	return e.finishEntry(fill, boosting, forced, wr, score, need)
}

func (e *Engine) finishEntry(fill Fill, boosting, forced bool, wr float64, score, need int) (Snapshot, error) {
	if fill.Status != StatusFilled {
		e.note("entry", "submitted")
	} else {
		snap, err := e.acceptFill(fill)
		if err != nil {
			return snap, err
		}
	}
	if !boosting {
		return e.Snapshot(), nil
	}
	action := "boost_entry"
	if forced {
		action = "boost_forced"
	}
	e.note(action, fmt.Sprintf("winrate %.4f score %d/%d", wr, score, need))
	return e.Snapshot(), nil
}

func symbolHasPosition(symbol string, positions []KeyPosition) bool {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if symbol == "" {
		return false
	}
	for _, pos := range positions {
		if pos.Qty > 0 && strings.EqualFold(pos.Symbol, symbol) {
			return true
		}
	}
	return false
}

func (e *Engine) stepEntry(in StepInput) (Snapshot, error) {
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	pos, err := e.ex.Position(e.cfg.Symbol)
	if err != nil {
		return e.failed(err.Error())
	}
	if !pos.Open {
		e.note("entry", "waiting")
		return e.Snapshot(), nil
	}
	return e.acceptFill(Fill{Status: StatusFilled, Price: pos.Entry, Qty: pos.Qty, Side: pos.Side})
}

func (e *Engine) acceptFill(fill Fill) (Snapshot, error) {
	if err := e.m.Transition(Event{Kind: EventEntryFilled, Reason: "filled"}); err != nil {
		e.clearStagedEntry()
		return e.failed(err.Error())
	}
	stop, take, liq, err := e.quoteProtection(fill.Side, fill.Price)
	if err != nil {
		e.clearStagedEntry()
		return e.failed(err.Error())
	}
	e.rememberPlan(fill.Price, stop, liq)
	if err := e.ensureProtection(fill.Side, fill.Price, stop, take, liq); err != nil {
		e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take, Liq: liq}
		e.clearStagedEntry()
		if errors.Is(err, ErrBlocked) {
			e.log.Printf("[trading] %s entry=%.8f stop=%.8f liq=%.8f", ReasonStopBeyondLiquidation, fill.Price, stop, liq)
			log.Printf("[trading] %s entry=%.8f stop=%.8f liq=%.8f", ReasonStopBeyondLiquidation, fill.Price, stop, liq)
			return e.failed(ReasonStopBeyondLiquidation)
		}
		e.log.Printf("[trading] %s: %v stop=%.8f liq=%.8f", ReasonProtectiveOrdersFailed, err, stop, liq)
		log.Printf("[trading] %s: %v stop=%.8f liq=%.8f", ReasonProtectiveOrdersFailed, err, stop, liq)
		return e.failed(ReasonProtectiveOrdersFailed)
	}
	e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take, Liq: liq}
	e.log.Printf("[trading] entry %s entry=%.8f stop=%.8f liq=%.8f", fill.Side, fill.Price, stop, liq)
	e.note("entry", string(fill.Side))
	e.commitEntry(fill)
	return e.Snapshot(), nil
}

func (e *Engine) stepPosition(in StepInput) (Snapshot, error) {
	// 暂停新开仓时不补保护单，也不按信号平仓。交易所已经空仓时仍走对账。
	if e.cfg.PauseEntries {
		return e.holdPausedPosition(in)
	}
	// 止盈条件单可以在两根 K 线之间成交。收盘时这里再核对一次。
	// 调度器在持仓期间另外按 FlatReconcileInterval 调用 ReconcileFlat，
	// 不把空仓发现推迟到下一根收盘。
	if e.syncsPosition() {
		if err := e.authorize(); err != nil {
			return e.Snapshot(), err
		}
		pos, err := e.livePosition()
		if err != nil {
			return e.Snapshot(), err
		}
		if !pos.Open {
			return e.finishExchangeFlat(in)
		}
		e.pos.Qty = pos.Qty
		if pos.Entry > 0 {
			e.pos.Entry = pos.Entry
		}
	}
	price := mark(in)
	if price <= 0 {
		return e.failed("mark price is required")
	}
	cross, err := e.cross(in.Candles)
	if err != nil {
		return e.failed(err.Error())
	}
	exit, reason, fillPrice := e.exitSignal(price, cross)
	if !exit {
		if e.syncsPosition() && e.pos.Stop > 0 && e.pos.Take > 0 {
			if err := e.ex.PlaceProtection(Protection{
				Symbol: e.cfg.Symbol, Stop: e.pos.Stop, Take: e.pos.Take, Side: e.pos.Side,
			}); err != nil {
				return e.Snapshot(), err
			}
		}
		e.note("hold", string(e.pos.Side))
		return e.Snapshot(), nil
	}
	if cross != CrossNone {
		e.lastBarKey = barKey(in.Candles)
	}
	return e.finishExit(in, reason, fillPrice)
}

// holdPausedPosition 只观察持仓。不补保护单，不按信号平仓，避免碰到已挂的止损止盈。
// 交易所已经空仓时只改本地状态，不发撤单。
func (e *Engine) holdPausedPosition(in StepInput) (Snapshot, error) {
	if e.syncsPosition() {
		if err := e.authorize(); err != nil {
			return e.Snapshot(), err
		}
		pos, err := e.livePosition()
		if err != nil {
			return e.Snapshot(), err
		}
		if !pos.Open {
			if _, ok := e.ex.(interface {
				CancelProtective(symbol string, side Side) ([]int64, error)
			}); ok {
				return e.finishExchangeFlat(in)
			}
			return e.settleWithoutOrders(in, ReasonExchangeFlat)
		}
		e.pos.Qty = pos.Qty
		if pos.Entry > 0 {
			e.pos.Entry = pos.Entry
		}
		if pos.Side != "" {
			e.pos.Side = pos.Side
		}
	}
	e.note("pause_entries", ReasonEntriesPaused)
	return e.Snapshot(), nil
}

// settleWithoutOrders 在交易所已经空仓时结束本地持仓，不调用平仓和撤单。
func (e *Engine) settleWithoutOrders(in StepInput, reason string) (Snapshot, error) {
	if e.State() == StateInPosition {
		if err := e.m.Transition(Event{Kind: EventExitSignal, Reason: reason}); err != nil {
			return e.failed(err.Error())
		}
	}
	if e.State() != StateExitSubmitted {
		return e.failed("exit is not in progress")
	}
	if err := e.m.Transition(Event{Kind: EventExitFilled, Reason: reason}); err != nil {
		return e.failed(err.Error())
	}
	e.clearPos()
	e.forgetPlan()
	if err := e.m.Transition(Event{Kind: EventBooked, Reason: reason}); err != nil {
		return e.Snapshot(), err
	}
	e.markBar(in)
	e.note("flat", reason)
	if e.running {
		if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "rearm"}); err != nil {
			return e.Snapshot(), err
		}
	}
	return e.Snapshot(), nil
}

func (e *Engine) exitSignal(price float64, cross Cross) (bool, string, float64) {
	if e.pos.Side == SideLong {
		if price <= e.pos.Stop {
			return true, "stop_loss", e.pos.Stop
		}
		if price >= e.pos.Take {
			return true, "take_profit", e.pos.Take
		}
		if cross == CrossDeath {
			return true, "reverse_signal", price
		}
		return false, "", 0
	}
	if price >= e.pos.Stop {
		return true, "stop_loss", e.pos.Stop
	}
	if price <= e.pos.Take {
		return true, "take_profit", e.pos.Take
	}
	if cross == CrossGolden {
		return true, "reverse_signal", price
	}
	return false, "", 0
}

func (e *Engine) flatten(in StepInput, reason string) error {
	price := mark(in)
	if price <= 0 {
		price = e.pos.Entry
	}
	_, err := e.finishExit(in, reason, price)
	return err
}

func (e *Engine) finishExit(in StepInput, reason string, price ...float64) (Snapshot, error) {
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	fillPrice := mark(in)
	if len(price) > 0 && price[0] > 0 {
		fillPrice = price[0]
	}
	if fillPrice <= 0 {
		fillPrice = e.pos.Entry
	}
	if e.State() == StateInPosition {
		if err := e.m.Transition(Event{Kind: EventExitSignal, Reason: reason}); err != nil {
			return e.failed(err.Error())
		}
	}
	if e.State() != StateExitSubmitted {
		return e.failed("exit is not in progress")
	}
	fill, err := e.ex.Close(CloseOrder{Symbol: e.cfg.Symbol, Price: fillPrice, Reason: reason})
	if err != nil {
		return e.failed(err.Error())
	}
	if err := e.m.Transition(Event{Kind: EventExitFilled, Reason: reason}); err != nil {
		return e.failed(err.Error())
	}
	pnl := RealizedPnL(e.pos.Side, e.pos.Entry, fill.Price, e.pos.Qty)
	var halted bool
	if e.incomeBooked {
		halted = e.ledger.Halted || DailyHaltBreached(e.ledger.Capital, e.ledger.Realized, e.cfg.DailyLossPct)
	} else {
		halted = e.ledger.Add(pnl, e.cfg.DailyLossPct)
	}
	e.clearPos()
	e.forgetPlan()
	if halted {
		e.enterHalt()
		return e.Snapshot(), nil
	}
	if err := e.m.Transition(Event{Kind: EventBooked, Reason: reason}); err != nil {
		return e.Snapshot(), err
	}
	e.markBar(in)
	if pnl < 0 {
		e.lossStreak++
	} else if pnl > 0 {
		e.lossStreak = 0
	}
	e.note("exit", reason)
	if e.pausedReason != "" {
		e.note("pause", e.pausedReason)
		return e.Snapshot(), nil
	}
	if limit := e.lossLimit(); limit > 0 && e.lossStreak >= limit {
		return e.applyPause(ReasonConsecutiveLosses), nil
	}
	if e.running {
		if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "rearm"}); err != nil {
			return e.Snapshot(), err
		}
		e.note("armed", reason)
	}
	return e.Snapshot(), nil
}

func (e *Engine) cancelAndFlatten(reason string) {
	if e.ex == nil || e.cfg.Symbol == "" {
		return
	}
	_ = e.ex.CancelOpen(e.cfg.Symbol)
	pos, err := e.ex.Position(e.cfg.Symbol)
	if err != nil || !pos.Open {
		return
	}
	price := pos.Entry
	if price <= 0 {
		price = e.pos.Entry
	}
	if price <= 0 {
		price = e.lastEntry
	}
	if price <= 0 {
		return
	}
	if reason == "" {
		reason = "error_flatten"
	}
	if _, err := e.ex.Close(CloseOrder{Symbol: e.cfg.Symbol, Price: price, Reason: reason}); err != nil {
		e.log.Printf("[trading] flatten %s failed: %v", reason, err)
		log.Printf("[trading] flatten %s failed: %v", reason, err)
	}
	e.syncExchangeBooks(time.Now().UTC())
}

// failed 先落错误状态，再拍快照。同一条 return 里先拍快照会丢掉停机后的状态。
func (e *Engine) failed(reason string) (Snapshot, error) {
	err := e.fail(reason)
	return e.Snapshot(), err
}

func (e *Engine) fail(reason string) error {
	e.cancelAndFlatten(reason)
	e.running = false
	e.clearPos()
	e.lastError = reason
	detail := strings.TrimSpace(e.lastDetail)
	line := fmt.Sprintf("error: %s; open orders canceled; auto-reopen suppressed", reason)
	if detail != "" {
		line = fmt.Sprintf("error: %s: %s; open orders canceled; auto-reopen suppressed", reason, detail)
	}
	e.audit = append(e.audit, line)
	e.log.Printf("[trading] %s", line)
	log.Printf("[trading] %s", line)
	e.note("error", reason)
	if e.cfg.ID > 0 {
		boostState.noteFlattened(e.cfg.ID, reason)
	}
	if e.State() == StateError {
		return ErrNoAutoReopen
	}
	if err := e.m.Transition(Event{Kind: EventFail, Reason: reason}); err != nil {
		return err
	}
	return withReason(ErrNoAutoReopen, reason)
}

func (e *Engine) clearPos() {
	e.pos = position{}
	e.openEntry = nil
	e.openEntryID = 0
}

func (e *Engine) rememberPlan(entry, stop, liq float64) {
	e.lastEntry = entry
	e.lastStop = stop
	e.lastLiq = liq
}

func (e *Engine) forgetPlan() {
	e.lastEntry = 0
	e.lastStop = 0
	e.lastLiq = 0
}

// quoteProtection 用入场价的固定比例算 1R，再换成止损、止盈和逐仓强平价。
// 1R = entry * DefaultRFraction（默认 0.8%）。止损距离 = stopR * 1R。
// 赌一把模式改用相对入场价的剥头皮距离，止盈不会低于 MinScalpTpPct。
func (e *Engine) quoteProtection(side Side, entry float64) (stop, take, liq float64, err error) {
	stop, take, err = stopTake(e.cfg, side, entry)
	if err != nil {
		return 0, 0, 0, err
	}
	liq, err = IsolatedLiqPrice(side, entry, e.cfg.Leverage, e.maintMarginRate())
	if err != nil {
		return 0, 0, 0, err
	}
	return stop, take, liq, nil
}

func (e *Engine) maintMarginRate() float64 {
	type lookup interface {
		MaintMarginRate(symbol string, leverage int) (float64, bool)
	}
	if src, ok := e.ex.(lookup); ok {
		if rate, ok := src.MaintMarginRate(e.cfg.Symbol, e.cfg.Leverage); ok && rate > 0 && rate < 1 {
			return rate
		}
	}
	return DefaultMaintMarginRate
}

func (e *Engine) blockStop(entry, stop, liq float64) (Snapshot, error) {
	e.rememberPlan(entry, stop, liq)
	e.note("blocked", ReasonStopBeyondLiquidation)
	line := fmt.Sprintf("%s entry=%.8f stop=%.8f liq=%.8f", ReasonStopBeyondLiquidation, entry, stop, liq)
	e.audit = append(e.audit, line)
	e.log.Printf("[trading] %s", line)
	if err := e.m.Transition(Event{Kind: EventStartBlocked, Reason: ReasonStopBeyondLiquidation}); err != nil {
		return e.Snapshot(), err
	}
	return e.Snapshot(), withReason(ErrBlocked, ReasonStopBeyondLiquidation)
}

// SeedPositionForTest 写入内存持仓和参考价，方便交易台读入场、止损、止盈。
// 只给测试用，不访问交易所，也不会发单。
func (e *Engine) SeedPositionForTest(side Side, qty, entry, stop, take float64) {
	if e == nil {
		return
	}
	e.pos = position{Side: side, Qty: qty, Entry: entry, Stop: stop, Take: take}
	e.running = true
	e.m.Restore(StateInPosition, "test position")
}

func (e *Engine) syncsPosition() bool {
	syncer, ok := e.ex.(interface{ SyncsPosition() bool })
	return ok && syncer.SyncsPosition()
}

// SetPauseHook 在自动暂停时回调。实现只许写库，不能再进 Hub。
func (e *Engine) SetPauseHook(fn func(reason string)) {
	if e == nil {
		return
	}
	e.onPause = fn
}

// ClearPause 供手动 resume 清掉暂停，允许再次 Start。
func (e *Engine) ClearPause() {
	if e == nil {
		return
	}
	e.pausedReason = ""
	e.lossStreak = 0
}

func (e *Engine) marginBudget() float64 {
	return plannedMargin(e.cfg)
}

func (e *Engine) lossLimit() int {
	return e.cfg.lossPauseCount()
}

func (e *Engine) pauseBalance() float64 {
	return e.cfg.balancePauseLine()
}

// protectionAttempts 是止损止盈挂单失败后的总次数。中间失败不平仓。
const protectionAttempts = 3

// protectionRetryGap 是两次保护单尝试之间的间隔。测试可以改成 0。
var protectionRetryGap = 300 * time.Millisecond

// ensureProtection 每次尝试前都确认止损仍在强平价之前，并且只补缺的那一腿。
// 三次都失败才把错误交回去，由调用方先撤掉已挂上的那一腿再平仓。
func (e *Engine) ensureProtection(side Side, entry, stop, take, liq float64) error {
	var last error
	for attempt := 1; attempt <= protectionAttempts; attempt++ {
		if !StopWithinLiquidation(side, entry, stop, liq) {
			return withReason(ErrBlocked, ReasonStopBeyondLiquidation)
		}
		err := e.ex.PlaceProtection(Protection{Symbol: e.cfg.Symbol, Stop: stop, Take: take, Side: side})
		if err == nil {
			e.lastDetail = ""
			return nil
		}
		last = err
		e.lastDetail = err.Error()
		e.log.Printf("[trading] protection %s attempt %d/%d: %v", e.cfg.Symbol, attempt, protectionAttempts, err)
		log.Printf("[trading] protection %s attempt %d/%d: %v", e.cfg.Symbol, attempt, protectionAttempts, err)
		if attempt < protectionAttempts {
			time.Sleep(protectionRetryGap)
		}
	}
	return last
}

// noteLiveFlags 每一拍都写进暂停开仓、余额暂停线和创建时间。持仓期间也能改，不碰已挂的止损止盈。
func (e *Engine) noteLiveFlags(cfg Config) {
	if e == nil {
		return
	}
	e.cfg.PauseEntries = cfg.PauseEntries
	e.cfg.PauseBalanceUsdt = cfg.PauseBalanceUsdt
	if !cfg.CreatedAt.IsZero() {
		e.cfg.CreatedAt = cfg.CreatedAt.UTC()
	}
}

// syncExchangeBooks 与 captureIncome 是同一条对账。Step 的收尾和开仓前都走它。
func (e *Engine) syncExchangeBooks(now time.Time) {
	e.captureIncome(now)
}

// captureIncome 用币安账单覆盖当日和累计已实现，并把每张 orderId 对成一行。
// 当日从 Asia/Shanghai 0 点起，累计从策略创建时间起。读失败时保留上一份成功的结果。
// 日亏停机看这份上海当日数字，不看重启后清零的内存计数。
func (e *Engine) captureIncome(now time.Time) {
	if e == nil || e.ex == nil || strings.TrimSpace(e.cfg.Symbol) == "" {
		return
	}
	since := e.incomeSinceTime()
	if since.IsZero() {
		return
	}
	now = at(now)
	symbol := strings.ToUpper(strings.TrimSpace(e.cfg.Symbol))
	if e.incomeOK && e.incomeSince.Equal(since) && e.incomeSymbol == symbol && !now.Before(e.incomeAt) && now.Sub(e.incomeAt) < IncomeRefresh {
		e.ledger.Realized = e.incomeDay
		e.ledger.Cumulative = e.incomeCum
		e.incomeBooked = true
		e.applyIncomeHalt()
		return
	}
	day, cumulative, events, ok := e.readIncome(symbol, since, now)
	if !ok {
		return
	}
	e.incomeOK = true
	e.incomeAt = now
	e.incomeSince = since
	e.incomeSymbol = symbol
	e.incomeDay = day
	e.incomeCum = cumulative
	e.ledger.Realized = day
	e.ledger.Cumulative = cumulative
	e.incomeBooked = true
	e.applyIncomeHalt()
	e.bookOrderRows(events, since, now)
}

func (e *Engine) readIncome(symbol string, since, now time.Time) (day, cumulative float64, events []IncomeEvent, ok bool) {
	if hist, ready := e.ex.(interface {
		IncomeHistory(symbol string, since, now time.Time) ([]IncomeEvent, error)
		CredentialsReady() bool
	}); ready && hist.CredentialsReady() {
		rows, err := hist.IncomeHistory(symbol, since, now)
		if err != nil {
			log.Printf("[trading] income %s: %v", symbol, err)
			return 0, 0, nil, false
		}
		day, cumulative = SumSymbolIncome(rows, symbol, since, now)
		return day, cumulative, rows, true
	}
	src, ready := e.ex.(interface {
		RealizedIncome(symbol string, since, now time.Time) (day, cumulative float64, err error)
		CredentialsReady() bool
	})
	if !ready || !src.CredentialsReady() {
		return 0, 0, nil, false
	}
	day, cumulative, err := src.RealizedIncome(symbol, since, now)
	if err != nil {
		log.Printf("[trading] income %s: %v", symbol, err)
		return 0, 0, nil, false
	}
	return day, cumulative, nil, true
}

func (e *Engine) bookOrderRows(events []IncomeEvent, since, now time.Time) {
	src, ok := e.ex.(interface {
		UserTrades(symbol string, since, now time.Time) ([]UserTrade, error)
		CredentialsReady() bool
	})
	if !ok || !src.CredentialsReady() {
		return
	}
	trades, err := src.UserTrades(e.cfg.Symbol, since, now)
	if err != nil {
		log.Printf("[trading] userTrades %s: %v", e.cfg.Symbol, err)
		return
	}
	rows := BuildOrderRows(trades, events, e.lastMark)
	for i := range rows {
		if rows[i].Symbol == "" {
			rows[i].Symbol = e.cfg.Symbol
		}
	}
	book := currentOrderBook()
	if book == nil || e.userID <= 0 || e.cfg.ID <= 0 || len(rows) == 0 {
		return
	}
	if err := book.Upsert(e.userID, e.cfg.ID, rows); err != nil {
		log.Printf("[trading] order book %s: %v", e.cfg.Symbol, err)
	}
}

// applyIncomeHalt 用上海当日的币安净已实现决定日亏停机。
// 对账平仓后停机原因写成 daily_loss，不再留着 exchange_flat。
func (e *Engine) applyIncomeHalt() {
	if e == nil || !e.incomeBooked {
		return
	}
	if !DailyHaltBreached(e.ledger.Capital, e.ledger.Realized, e.cfg.DailyLossPct) {
		e.ledger.Halted = false
		return
	}
	e.ledger.Halted = true
	switch e.State() {
	case StateInPosition, StateEntrySubmitted, StateExitSubmitted, StateError:
		return
	default:
		e.enterHalt()
	}
}

func (e *Engine) holdIfPaused(in StepInput) (Snapshot, bool, error) {
	if limit := e.pauseBalance(); e.pausedReason == "" && limit > 0 && in.WalletKnown && in.Wallet > BalanceFloorUSDT && in.Wallet < limit {
		e.applyPause(ReasonBalanceBelowPause)
	}
	if e.pausedReason == "" {
		return Snapshot{}, false, nil
	}
	e.note("pause", e.pausedReason)
	switch e.State() {
	case StateInPosition:
		snap, err := e.stepPosition(in)
		return snap, true, err
	case StateExitSubmitted:
		snap, err := e.finishExit(in, e.pausedReason)
		return snap, true, err
	default:
		return e.Snapshot(), true, nil
	}
}

func (e *Engine) applyPause(reason string) Snapshot {
	first := e.pausedReason == ""
	if first {
		e.pausedReason = reason
		e.running = false
		if e.State() == StateArmed || e.State() == StateBlocked {
			_ = e.m.Transition(Event{Kind: EventStop, Reason: reason})
		}
	}
	e.note("pause", e.pausedReason)
	if first && e.onPause != nil {
		e.onPause(e.pausedReason)
	}
	return e.Snapshot()
}

func (e *Engine) entryQty(price float64) (float64, error) {
	minNotional := e.minNotional
	var step, minQty float64
	if info, ok := e.ex.(interface {
		Rules(symbol string) (MarketRules, error)
	}); ok {
		rules, err := info.Rules(e.cfg.Symbol)
		if err != nil {
			return 0, err
		}
		if rules.MinNotional > 0 {
			minNotional = rules.MinNotional
		}
		step, minQty = rules.StepSize, rules.MinQty
	}
	_, _, qty, err := SizePosition(e.marginBudget(), e.cfg.Leverage, price, minNotional)
	if err != nil {
		return 0, err
	}
	qty = AlignQuantity(qty, step, minQty)
	if qty <= 0 || qty*price+1e-9 < minNotional {
		return 0, withReason(ErrNotionalBelowMin, "notional_below_minimum")
	}
	return qty, nil
}

func (e *Engine) entrySide(in StepInput) (Side, string, error) {
	return entrySide(e.cfg, in.Candles, in.Higher)
}

func (e *Engine) floorNotional(in StepInput) float64 {
	if in.MinNotional > 0 {
		return in.MinNotional
	}
	if e.minNotional > 0 {
		return e.minNotional
	}
	return MinNotionalUSDT
}

func (e *Engine) rememberBacktest(sum BacktestSummary) {
	copied := sum.WithExpectancy()
	e.lastBacktest = &copied
}

func (e *Engine) stageEntry(in StepInput, score, minScore int, boost, forced bool) {
	draft := entryDraft{set: true, score: score, minScore: minScore, boost: boost, forced: forced}
	if in.Backtest != nil {
		draft.sum = in.Backtest.WithExpectancy()
		draft.hasSum = true
	} else if e.lastBacktest != nil {
		draft.sum = e.lastBacktest.WithExpectancy()
		draft.hasSum = true
	}
	e.pendingEntry = draft
}

func (e *Engine) clearStagedEntry() {
	e.pendingEntry = entryDraft{}
}

// commitEntry 在保护单挂上之后写下开仓记录。写库失败不改变持仓。
func (e *Engine) commitEntry(fill Fill) {
	if e == nil {
		return
	}
	opened := e.stepAt
	if opened.IsZero() {
		opened = time.Now().UTC()
	}
	if e.pos.OpenedAt.IsZero() {
		e.pos.OpenedAt = opened
	}
	if !e.pendingEntry.set {
		return
	}
	draft := e.pendingEntry
	e.pendingEntry = entryDraft{}
	oneR := PositionOneRUSDT(fill.Price, fill.Qty, e.cfg.StopR)
	expR := 0.0
	if draft.hasSum {
		expR = draft.sum.ExpectancyR
	}
	stamp := EntryStamp{
		Score:          draft.score,
		MinScore:       draft.minScore,
		Boost:          draft.boost,
		Forced:         draft.forced,
		WinRate:        draft.sum.WinRate,
		Trades:         draft.sum.Trades,
		NetR:           draft.sum.NetR,
		ExpectancyR:    expR,
		OneRUSDT:       oneR,
		ExpectancyUSDT: expR * oneR,
	}
	if !draft.hasSum {
		stamp.WinRate = 0
		stamp.Trades = 0
		stamp.NetR = 0
	}
	e.openEntry = &stamp
	copied := stamp
	e.justOpened = &copied
	if draft.boost && (e.lastAction == "entry" || e.lastAction == "") {
		action := "boost_entry"
		if draft.forced {
			action = "boost_forced"
		}
		e.note(action, fmt.Sprintf("score %d/%d", draft.score, draft.minScore))
	}
	id, _ := SaveEntry(EntryRecord{
		UserID:     e.userID,
		StrategyID: e.cfg.ID,
		Symbol:     e.cfg.Symbol,
		Side:       string(fill.Side),
		EntryPrice: fill.Price,
		Qty:        fill.Qty,
		OpenedAt:   e.pos.OpenedAt,
		EntryStamp: stamp,
	})
	e.openEntryID = id
}

func (e *Engine) markBar(in StepInput) {
	if key := barKey(in.Candles); key != "" {
		e.lastBarKey = key
	}
}

func (e *Engine) unrealized(mark float64) float64 {
	if e.pos.Qty <= 0 || e.pos.Entry <= 0 || mark <= 0 || e.pos.Side == "" {
		return 0
	}
	return RealizedPnL(e.pos.Side, e.pos.Entry, mark, e.pos.Qty)
}

func (e *Engine) cross(candles []Candle) (Cross, error) {
	closes := make([]float64, len(candles))
	for i, c := range candles {
		closes[i] = c.Close
	}
	return LastCross(closes, e.cfg.EmaFast, e.cfg.EmaSlow)
}

func at(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t.UTC()
}

func mark(in StepInput) float64 {
	if in.MarkPrice > 0 {
		return in.MarkPrice
	}
	if n := len(in.Candles); n > 0 && in.Candles[n-1].Close > 0 {
		return in.Candles[n-1].Close
	}
	return 0
}

func barKey(candles []Candle) string {
	if len(candles) == 0 || candles[len(candles)-1].OpenTime.IsZero() {
		return ""
	}
	return strconv.FormatInt(candles[len(candles)-1].OpenTime.UTC().UnixNano(), 10)
}

func (e *Engine) boosting(in StepInput) bool {
	return e != nil && strings.EqualFold(e.cfg.Mode, ModeLive) && BoostActive(at(in.Now))
}

func signalWinRate(in StepInput, last *BacktestSummary) float64 {
	if in.Backtest != nil {
		return in.Backtest.WinRate
	}
	if last != nil {
		return last.WinRate
	}
	return 0
}

func (e *Engine) recordTick(in StepInput, snap Snapshot, err error) {
	side, score := "", 0
	if e.closedSide != "" {
		side = string(e.closedSide)
		e.closedSide = ""
	} else if got, sc, serr := ScoreTrend(e.cfg, in.Candles, in.Higher); serr == nil {
		side, score = string(got), sc
	}
	if side == "" && snap.Side != "" {
		side = string(snap.Side)
	}
	msg := snap.LastReason
	if detail := strings.TrimSpace(e.lastDetail); detail != "" {
		if msg != "" {
			msg += ": "
		}
		msg += detail
	}
	if err != nil && msg == "" {
		msg = err.Error()
	}
	ev := DetectionEvent{
		TS:                 at(in.Now),
		Symbol:             e.cfg.Symbol,
		Side:               side,
		Score:              score,
		WinRate:            signalWinRate(in, e.lastBacktest),
		Action:             snap.LastAction,
		Msg:                msg,
		DayRealized:        snap.DayRealized,
		CumulativeRealized: snap.CumulativeRealized,
	}
	if e.justOpened != nil && (snap.LastAction == "entry" || snap.LastAction == "boost_entry" || snap.LastAction == "boost_forced") {
		ev.Entry = e.justOpened
		ev.Score = e.justOpened.Score
		ev.WinRate = e.justOpened.WinRate
	}
	e.justOpened = nil
	AddEvent(ev)
}
