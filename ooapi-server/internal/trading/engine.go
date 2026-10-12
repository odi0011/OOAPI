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
	// Wallet / Available 是同一把密钥的账户余额。WalletKnown 为真才参与停机和仓位上限。
	Wallet      float64 `json:"-"`
	Available   float64 `json:"-"`
	WalletKnown bool    `json:"-"`
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
	DayRealized     float64 `json:"dayRealizedUsdt"`
	// CumulativeRealized 与当日盈亏同一来源，日切后当日归零、累计保留。没有会话时为 0，不另造数。
	CumulativeRealized float64          `json:"cumulativeRealizedUsdt"`
	Halted             bool             `json:"halted"`
	LastError          string           `json:"lastError,omitempty"`
	Mode               string           `json:"mode"`
	TestnetGreen       bool             `json:"testnetGreen"`
	Running            bool             `json:"running"`
	LastAction         string           `json:"lastAction,omitempty"`
	LastReason         string           `json:"lastReason,omitempty"`
	PauseReason        string           `json:"pauseReason,omitempty"`
	MarkPrice          float64          `json:"markPrice,omitempty"`
	UnrealizedPnl      float64          `json:"unrealizedPnl,omitempty"`
	LastBacktest       *BacktestSummary `json:"lastBacktest,omitempty"`
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
	Side  Side
	Qty   float64
	Entry float64
	Stop  float64
	Take  float64
	Liq   float64
}

// Engine 把信号、风控和状态机串起来。调用方一次只推进一个线程。
type Engine struct {
	cfg          Config
	ex           Exchange
	log          Logger
	m            *Machine
	ledger       Ledger
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
	rFraction    float64
	minNotional  float64
	audit        []string
	secrets      SecretOpener
	secretOpens  int
	lossStreak   int
	pausedReason string
	onPause      func(reason string)
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
		MarkPrice:          e.lastMark,
		UnrealizedPnl:      e.unrealized(e.lastMark),
		LastBacktest:       e.lastBacktest,
	}
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
	e.cfg = cfg
	return nil
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
		e.note("armed", "already")
		return nil
	}
	if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "start"}); err != nil {
		return err
	}
	e.forgetPlan()
	e.running = true
	e.note("armed", "start")
	return nil
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
			e.clearPos()
			return e.m.Transition(Event{Kind: EventStop, Reason: "operator_stop"})
		}
		if err := e.m.Transition(Event{Kind: EventEntryFilled, Reason: "filled before stop"}); err != nil {
			return e.fail(err.Error())
		}
		e.pos = position{Side: pos.Side, Qty: pos.Qty, Entry: pos.Entry}
		return e.flatten(in, "operator_stop")
	case StateInPosition, StateExitSubmitted:
		return e.flatten(in, "operator_stop")
	default:
		return nil
	}
}

// Step 推进一次。测网撮合在同一次调用里完成成交；同一根 K 线不会连着反手。
func (e *Engine) Step(in StepInput) (snap Snapshot, err error) {
	defer func() {
		if e != nil {
			e.recordTick(in, snap, err)
		}
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
	if blocked, reason := StartBlocked(in.FundingRate, in.LiqDistancePct); blocked {
		e.note("blocked", reason)
		if err := e.m.Transition(Event{Kind: EventStartBlocked, Reason: reason}); err != nil {
			return e.Snapshot(), err
		}
		return e.Snapshot(), withReason(ErrBlocked, reason)
	}
	// 同一根已收盘 K 线只决定一次开仓。平仓检查不走这里，止损止盈仍会在持仓步里触发。
	if key := barKey(in.Candles); key != "" && key == e.lastBarKey {
		return e.Snapshot(), nil
	}
	if !e.running {
		return e.Snapshot(), ErrNotRunning
	}
	wr := signalWinRate(in, e.lastBacktest)
	noted := false
	noteBoost := func(passes bool) {
		if noted || !e.boosting(in) {
			return
		}
		noted = true
		boostState.note(e.cfg.ID, wr, passes)
	}
	defer noteBoost(false)
	side, signal, err := e.entrySide(in)
	if err != nil {
		return e.failed(err.Error())
	}
	if side == "" {
		e.note("none", signal)
		return e.Snapshot(), nil
	}
	if in.SkipReason != "" {
		e.note("skip", in.SkipReason)
		return e.Snapshot(), nil
	}
	floor := e.floorNotional(in)
	if e.cfg.Leverage > 0 && e.marginBudget()*float64(e.cfg.Leverage)+1e-9 < floor {
		e.note("skip", ReasonBelowMinNotional)
		return e.Snapshot(), nil
	}
	if e.cfg.MinWinRate > 0 || strings.EqualFold(e.cfg.Mode, ModeLive) {
		sum := in.Backtest
		if sum == nil {
			sum = e.lastBacktest
		}
		if reason := BacktestGate(e.cfg, sum); reason != "" {
			e.note("skip", reason)
			return e.Snapshot(), nil
		}
	}
	price := mark(in)
	if price <= 0 {
		return e.failed("mark price is required")
	}
	qty, err := e.entryQty(price)
	if err != nil {
		if errors.Is(err, ErrNotionalBelowMin) {
			e.note("skip", ReasonBelowMinNotional)
			return e.Snapshot(), nil
		}
		return e.Snapshot(), err
	}
	stop, _, liq, err := e.quoteProtection(side, price)
	if err != nil {
		return e.failed(err.Error())
	}
	if !StopWithinLiquidation(side, price, stop, liq) {
		return e.blockStop(price, stop, liq)
	}
	reserved := false
	if e.boosting(in) {
		noteBoost(true)
		allow, reason := boostState.allow(e.cfg.ID, in.LivePeerIDs, at(in.Now))
		if !allow {
			e.note("skip", reason)
			return e.Snapshot(), nil
		}
		reserved = true
	}
	releaseBoost := func() {
		if reserved {
			boostState.release(e.cfg.ID)
			reserved = false
		}
	}
	if err := e.authorize(); err != nil {
		releaseBoost()
		return e.Snapshot(), err
	}
	if err := e.m.Transition(Event{Kind: EventEntrySignal, Reason: signal}); err != nil {
		releaseBoost()
		return e.Snapshot(), err
	}
	fill, err := e.ex.PlaceEntry(EntryOrder{
		Symbol:     e.cfg.Symbol,
		Side:       side,
		Qty:        qty,
		Price:      price,
		Leverage:   e.cfg.Leverage,
		MarginMode: e.cfg.MarginMode,
	})
	if err != nil {
		releaseBoost()
		return e.failed(err.Error())
	}
	if reserved {
		boostState.commit(e.cfg.ID)
		reserved = false
	}
	e.lastBarKey = barKey(in.Candles)
	if fill.Status != StatusFilled {
		e.note("entry", "submitted")
		return e.Snapshot(), nil
	}
	return e.acceptFill(fill)
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
		return e.failed(err.Error())
	}
	stop, take, liq, err := e.quoteProtection(fill.Side, fill.Price)
	if err != nil {
		return e.failed(err.Error())
	}
	e.rememberPlan(fill.Price, stop, liq)
	if !StopWithinLiquidation(fill.Side, fill.Price, stop, liq) {
		e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take, Liq: liq}
		e.log.Printf("[trading] %s entry=%.8f stop=%.8f liq=%.8f", ReasonStopBeyondLiquidation, fill.Price, stop, liq)
		return e.failed(ReasonStopBeyondLiquidation)
	}
	if err := e.ex.PlaceProtection(Protection{Symbol: e.cfg.Symbol, Stop: stop, Take: take, Side: fill.Side}); err != nil {
		e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take, Liq: liq}
		e.log.Printf("[trading] %s: %v stop=%.8f liq=%.8f", ReasonProtectiveOrdersFailed, err, stop, liq)
		return e.failed(ReasonProtectiveOrdersFailed)
	}
	e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take, Liq: liq}
	e.log.Printf("[trading] entry %s entry=%.8f stop=%.8f liq=%.8f", fill.Side, fill.Price, stop, liq)
	e.note("entry", string(fill.Side))
	return e.Snapshot(), nil
}

func (e *Engine) stepPosition(in StepInput) (Snapshot, error) {
	if e.syncsPosition() {
		if err := e.authorize(); err != nil {
			return e.Snapshot(), err
		}
		pos, err := e.ex.Position(e.cfg.Symbol)
		if err != nil {
			return e.Snapshot(), err
		}
		if !pos.Open {
			return e.finishExit(in, "exchange_flat", mark(in))
		}
		e.pos.Qty = pos.Qty
		if pos.Entry > 0 {
			e.pos.Entry = pos.Entry
		}
		if pos.Side != "" {
			e.pos.Side = pos.Side
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
	halted := e.ledger.Add(pnl, e.cfg.DailyLossPct)
	e.clearPos()
	e.forgetPlan()
	if halted {
		if err := e.m.Transition(Event{Kind: EventDailyHalt, Reason: "daily_loss"}); err != nil {
			return e.Snapshot(), err
		}
		e.note("halt", reason)
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
	}
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
	line := fmt.Sprintf("error: %s; open orders canceled; auto-reopen suppressed", reason)
	e.audit = append(e.audit, line)
	e.log.Printf("[trading] %s", line)
	e.note("error", reason)
	if e.State() == StateError {
		return ErrNoAutoReopen
	}
	if err := e.m.Transition(Event{Kind: EventFail, Reason: reason}); err != nil {
		return err
	}
	return withReason(ErrNoAutoReopen, reason)
}

func (e *Engine) clearPos() { e.pos = position{} }

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
func (e *Engine) quoteProtection(side Side, entry float64) (stop, take, liq float64, err error) {
	oneR := entry * e.rFraction
	stop, take, err = ProtectionPrices(side, entry, oneR, e.cfg.StopR, e.cfg.TakeProfitR)
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
	budget := e.cfg.MaxMarginUsdt
	if cap := e.cfg.marginCap(); cap > 0 && cap < budget {
		budget = cap
	}
	return budget
}

func (e *Engine) lossLimit() int {
	return e.cfg.lossPauseCount()
}

func (e *Engine) pauseBalance() float64 {
	return e.cfg.balancePauseLine()
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
	copied := sum
	e.lastBacktest = &copied
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

// marginInUse 是当前持仓占用的保证金。Hub 在共享锁里汇总同一密钥下的仓位。
func (e *Engine) marginInUse() float64 {
	if e == nil || !e.Busy() || e.pos.Qty <= 0 || e.pos.Entry <= 0 || e.cfg.Leverage < 1 {
		return 0
	}
	return e.pos.Qty * e.pos.Entry / float64(e.cfg.Leverage)
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
	if got, sc, serr := ScoreTrend(e.cfg, in.Candles, in.Higher); serr == nil {
		side, score = string(got), sc
	}
	if side == "" && snap.Side != "" {
		side = string(snap.Side)
	}
	msg := snap.LastReason
	if err != nil && msg == "" {
		msg = err.Error()
	}
	AddEvent(DetectionEvent{
		TS:      at(in.Now),
		Symbol:  e.cfg.Symbol,
		Side:    side,
		Score:   score,
		WinRate: signalWinRate(in, e.lastBacktest),
		Action:  snap.LastAction,
		Msg:     msg,
	})
}
