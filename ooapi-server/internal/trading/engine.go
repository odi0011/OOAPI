package trading

import (
	"fmt"
	"log"
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

// Candle 是一根已收盘的 5 分钟 K 线。信号只用收盘价。
type Candle struct {
	OpenTime time.Time `json:"openTime"`
	Close    float64   `json:"close"`
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
}

// Snapshot 是对外展示的运行状态。
type Snapshot struct {
	State           State   `json:"state"`
	Side            Side    `json:"side,omitempty"`
	EntryPrice      float64 `json:"entryPrice,omitempty"`
	StopPrice       float64 `json:"stopPrice,omitempty"`
	TakeProfitPrice float64 `json:"takeProfitPrice,omitempty"`
	Qty             float64 `json:"qty,omitempty"`
	DayRealized     float64 `json:"dayRealizedUsdt"`
	Halted          bool    `json:"halted"`
	LastError       string  `json:"lastError,omitempty"`
	Mode            string  `json:"mode"`
	TestnetGreen    bool    `json:"testnetGreen"`
	Running         bool    `json:"running"`
	LastAction      string  `json:"lastAction,omitempty"`
	LastReason      string  `json:"lastReason,omitempty"`
}

// Runtime 是可以跨进程恢复的风险状态。不保存持仓，避免重启后自动重开。
type Runtime struct {
	State     State
	Day       time.Time
	Capital   float64
	Realized  float64
	Halted    bool
	LastError string
}

type position struct {
	Side  Side
	Qty   float64
	Entry float64
	Stop  float64
	Take  float64
}

// Engine 把信号、风控和状态机串起来。调用方一次只推进一个线程。
type Engine struct {
	cfg         Config
	ex          Exchange
	log         Logger
	m           *Machine
	ledger      Ledger
	pos         position
	running     bool
	lastError   string
	lastAction  string
	lastReason  string
	lastBarKey  string
	rFraction   float64
	minNotional float64
	audit       []string
	secrets     SecretOpener
	secretOpens int
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
	return Snapshot{
		State:           e.State(),
		Side:            e.pos.Side,
		EntryPrice:      e.pos.Entry,
		StopPrice:       e.pos.Stop,
		TakeProfitPrice: e.pos.Take,
		Qty:             e.pos.Qty,
		DayRealized:     e.ledger.Realized,
		Halted:          e.ledger.Halted || e.State() == StateDailyHalt,
		LastError:       e.lastError,
		Mode:            e.cfg.Mode,
		TestnetGreen:    TestnetGreen(),
		Running:         e.running,
		LastAction:      e.lastAction,
		LastReason:      e.lastReason,
	}
}

func (e *Engine) Trace() []State { return e.m.Trace() }

func (e *Engine) Runtime() Runtime {
	return Runtime{
		State:     e.State(),
		Day:       e.ledger.Day,
		Capital:   e.ledger.Capital,
		Realized:  e.ledger.Realized,
		Halted:    e.ledger.Halted,
		LastError: e.lastError,
	}
}

// Restore 只恢复停机和错误，不恢复持仓。重启后的在途交易记为 Error，等待人工 Stop。
func (e *Engine) Restore(rt Runtime) {
	e.ledger = Ledger{
		Day:      rt.Day,
		Capital:  rt.Capital,
		Realized: rt.Realized,
		Halted:   rt.Halted,
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
		e.cancelAndFlatten()
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
func (e *Engine) Step(in StepInput) (Snapshot, error) {
	if err := e.gate(); err != nil {
		return e.Snapshot(), err
	}
	if e.State() == StateError {
		return e.Snapshot(), ErrNoAutoReopen
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
	cross, err := e.cross(in.Candles)
	if err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	if cross == CrossNone {
		e.note("none", "no cross")
		return e.Snapshot(), nil
	}
	if key := barKey(in.Candles); key != "" && key == e.lastBarKey {
		e.note("none", "same bar")
		return e.Snapshot(), nil
	}
	side := SideForCross(cross)
	price := mark(in)
	if price <= 0 {
		return e.Snapshot(), e.fail("mark price is required")
	}
	_, _, qty, err := SizePosition(e.cfg.MaxMarginUsdt, e.cfg.Leverage, price, e.minNotional)
	if err != nil {
		e.note("blocked", "notional_below_minimum")
		_ = e.m.Transition(Event{Kind: EventStartBlocked, Reason: "notional_below_minimum"})
		return e.Snapshot(), err
	}
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	if err := e.m.Transition(Event{Kind: EventEntrySignal, Reason: string(cross)}); err != nil {
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
		return e.Snapshot(), e.fail(err.Error())
	}
	e.lastBarKey = barKey(in.Candles)
	if fill.Status != StatusFilled {
		e.note("entry", "submitted")
		return e.Snapshot(), nil
	}
	return e.acceptFill(fill)
}

func (e *Engine) stepEntry(in StepInput) (Snapshot, error) {
	pos, err := e.ex.Position(e.cfg.Symbol)
	if err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	if !pos.Open {
		e.note("entry", "waiting")
		return e.Snapshot(), nil
	}
	if err := e.authorize(); err != nil {
		return e.Snapshot(), err
	}
	return e.acceptFill(Fill{Status: StatusFilled, Price: pos.Entry, Qty: pos.Qty, Side: pos.Side})
}

func (e *Engine) acceptFill(fill Fill) (Snapshot, error) {
	if err := e.m.Transition(Event{Kind: EventEntryFilled, Reason: "filled"}); err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	oneR := fill.Price * e.rFraction
	stop, take, err := ProtectionPrices(fill.Side, fill.Price, oneR, e.cfg.StopR, e.cfg.TakeProfitR)
	if err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	if err := e.ex.PlaceProtection(Protection{Symbol: e.cfg.Symbol, Stop: stop, Take: take}); err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	e.pos = position{Side: fill.Side, Qty: fill.Qty, Entry: fill.Price, Stop: stop, Take: take}
	e.note("entry", string(fill.Side))
	return e.Snapshot(), nil
}

func (e *Engine) stepPosition(in StepInput) (Snapshot, error) {
	price := mark(in)
	if price <= 0 {
		return e.Snapshot(), e.fail("mark price is required")
	}
	cross, err := e.cross(in.Candles)
	if err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	exit, reason, fillPrice := e.exitSignal(price, cross)
	if !exit {
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
			return e.Snapshot(), e.fail(err.Error())
		}
	}
	if e.State() != StateExitSubmitted {
		return e.Snapshot(), e.fail("exit is not in progress")
	}
	fill, err := e.ex.Close(CloseOrder{Symbol: e.cfg.Symbol, Price: fillPrice, Reason: reason})
	if err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	if err := e.m.Transition(Event{Kind: EventExitFilled, Reason: reason}); err != nil {
		return e.Snapshot(), e.fail(err.Error())
	}
	pnl := RealizedPnL(e.pos.Side, e.pos.Entry, fill.Price, e.pos.Qty)
	halted := e.ledger.Add(pnl, e.cfg.DailyLossPct)
	e.clearPos()
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
	e.note("exit", reason)
	if e.running {
		if err := e.m.Transition(Event{Kind: EventStartOK, Reason: "rearm"}); err != nil {
			return e.Snapshot(), err
		}
		e.note("armed", reason)
	}
	return e.Snapshot(), nil
}

func (e *Engine) cancelAndFlatten() {
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
		return
	}
	_, _ = e.ex.Close(CloseOrder{Symbol: e.cfg.Symbol, Price: price, Reason: "error_flatten"})
}

func (e *Engine) fail(reason string) error {
	e.cancelAndFlatten()
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
	if len(candles) == 0 {
		return ""
	}
	last := candles[len(candles)-1]
	return fmt.Sprintf("%d|%d|%.8f", len(candles), last.OpenTime.UTC().UnixNano(), last.Close)
}
