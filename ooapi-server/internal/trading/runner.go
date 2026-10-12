package trading

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// RunSpec 是调度器跟踪的一条运行中策略。
type RunSpec struct {
	UserID  int64
	Config  Config
	Secrets SecretOpener
}

// Market 是推进一根 K 线时从交易所读到的公开数据和账户余额。
type Market struct {
	Candles     []Candle
	Higher      []Candle
	Mark        float64
	MinNotional float64
	Wallet      float64
	Available   float64
	WalletKnown bool
}

// MarketFunc 读取行情。测试可以换成固定数据。
type MarketFunc func(cfg Config, secrets SecretOpener, now time.Time) (Market, error)

// Runner 为每条 running 策略起一个循环，在 K 线收盘后调用与手工 step 相同的逻辑。
type Runner struct {
	hub     *Hub
	now     func() time.Time
	market  MarketFunc
	step    func(spec RunSpec, in StepInput) (Snapshot, error)
	mu      sync.Mutex
	started bool
	onStop  func(strategyID int64)
	jobs    map[int64]context.CancelFunc
	cache   map[int64]BacktestSummary
}

func NewRunner(hub *Hub) *Runner {
	if hub == nil {
		hub = NewHub()
	}
	r := &Runner{
		hub:   hub,
		now:   func() time.Time { return time.Now().UTC() },
		jobs:  map[int64]context.CancelFunc{},
		cache: map[int64]BacktestSummary{},
	}
	r.market = defaultMarket
	r.step = r.hubStep
	return r
}

func (r *Runner) SetClock(now func() time.Time) {
	if now != nil {
		r.now = now
	}
}

func (r *Runner) SetMarket(fn MarketFunc) {
	if fn != nil {
		r.market = fn
	}
}

func (r *Runner) SetStep(fn func(spec RunSpec, in StepInput) (Snapshot, error)) {
	if fn != nil {
		r.step = fn
	}
}

// SetStop 在余额触底或交易对冲突时把策略标成不再运行。
func (r *Runner) SetStop(fn func(strategyID int64)) {
	r.mu.Lock()
	r.onStop = fn
	r.mu.Unlock()
}

// Start 标记调度器已启用。调用方随后 Sync 或 Ensure。
func (r *Runner) Start() {
	r.mu.Lock()
	r.started = true
	r.mu.Unlock()
}

func (r *Runner) Started() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.started
}

// Ensure 在调度器已启动时为这条策略拉起循环。重复调用不会再开一条。
func (r *Runner) Ensure(spec RunSpec) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.started || spec.Config.ID <= 0 {
		return
	}
	if _, ok := r.jobs[spec.Config.ID]; ok {
		return
	}
	r.launchLocked(spec)
}

// Remove 停掉某条策略的循环。
func (r *Runner) Remove(strategyID int64) {
	r.mu.Lock()
	cancel := r.jobs[strategyID]
	delete(r.jobs, strategyID)
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Sync 让循环集合和当前 running 策略对齐。
func (r *Runner) Sync(specs []RunSpec) {
	want := map[int64]RunSpec{}
	for _, spec := range specs {
		if spec.Config.ID > 0 {
			want[spec.Config.ID] = spec
		}
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
	}
	for id, spec := range want {
		if _, ok := r.jobs[id]; ok {
			continue
		}
		r.launchLocked(spec)
	}
}

func (r *Runner) launchLocked(spec RunSpec) {
	ctx, cancel := context.WithCancel(context.Background())
	r.jobs[spec.Config.ID] = cancel
	go r.loop(ctx, spec)
}

func (r *Runner) loop(ctx context.Context, spec RunSpec) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[trading] runner strategy %d panic: %v", spec.Config.ID, rec)
		}
	}()
	r.runOnce(ctx, spec)
	for {
		tf := TimeframeDuration(spec.Config.Timeframe)
		wait := NextBarClose(r.now(), tf).Sub(r.now())
		if wait < time.Second {
			wait = time.Second
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			r.runOnce(ctx, spec)
		}
	}
}

func (r *Runner) runOnce(ctx context.Context, spec RunSpec) {
	if ctx.Err() != nil {
		return
	}
	now := r.now()
	mkt, err := r.market(spec.Config, spec.Secrets, now)
	if err != nil {
		log.Printf("[trading] runner strategy %d market: %v", spec.Config.ID, err)
		return
	}
	if mkt.WalletKnown && mkt.Wallet <= BalanceFloorUSDT {
		_, _ = r.step(spec, StepInput{
			Now: now, Wallet: mkt.Wallet, Available: mkt.Available, WalletKnown: true,
		})
		r.stopSpec(spec.Config.ID)
		return
	}
	if err := r.ensureStarted(spec, mkt); err != nil {
		log.Printf("[trading] runner strategy %d start: %v", spec.Config.ID, err)
		if errors.Is(err, ErrSymbolInUse) {
			r.stopSpec(spec.Config.ID)
		}
		return
	}
	in := StepInput{
		Now:            now,
		Candles:        mkt.Candles,
		Higher:         mkt.Higher,
		MarkPrice:      mkt.Mark,
		FundingRate:    0,
		LiqDistancePct: -1,
		EquityUSDT:     mkt.Wallet,
		MinNotional:    mkt.MinNotional,
		Wallet:         mkt.Wallet,
		Available:      mkt.Available,
		WalletKnown:    mkt.WalletKnown,
	}
	if sum, ok := r.backtest(spec.Config, mkt, now); ok {
		in.Backtest = &sum
	} else if spec.Config.Normalize().MinWinRate > 0 {
		in.Backtest = &BacktestSummary{}
	}
	snap, err := r.step(spec, in)
	if err != nil {
		log.Printf("[trading] runner strategy %d step: %v", spec.Config.ID, err)
	}
	if snap.LastReason == ReasonBalanceFloor {
		r.stopSpec(spec.Config.ID)
	}
}

func (r *Runner) stopSpec(strategyID int64) {
	r.mu.Lock()
	fn := r.onStop
	r.mu.Unlock()
	if fn != nil {
		fn(strategyID)
	}
	r.Remove(strategyID)
}

func (r *Runner) ensureStarted(spec RunSpec, mkt Market) error {
	snap, ok := r.hub.State(spec.UserID, spec.Config.ID)
	if ok {
		switch snap.State {
		case StateArmed, StateEntrySubmitted, StateInPosition, StateExitSubmitted, StateDailyHalt, StateError, StateBlocked:
			return nil
		}
		if snap.Running {
			return nil
		}
	}
	if !mkt.WalletKnown || mkt.Wallet <= 0 {
		return invalid("还没有读到账户权益")
	}
	_, err := r.hub.Start(spec.UserID, spec.Config.ID, spec.Config, StartInput{
		Now:            r.now(),
		FundingRate:    0,
		LiqDistancePct: -1,
		EquityUSDT:     mkt.Wallet,
	}, spec.Secrets)
	return err
}

func (r *Runner) backtest(cfg Config, mkt Market, now time.Time) (BacktestSummary, bool) {
	cfg = cfg.Normalize()
	r.mu.Lock()
	cached, ok := r.cache[cfg.ID]
	r.mu.Unlock()
	if ok && !cached.At.IsZero() && now.Sub(cached.At) < BacktestEvery {
		return cached, true
	}
	if len(mkt.Candles) == 0 {
		return BacktestSummary{}, false
	}
	res, err := Backtest(cfg, mkt.Candles, mkt.Higher)
	if err != nil {
		log.Printf("[trading] runner strategy %d backtest: %v", cfg.ID, err)
		return BacktestSummary{}, false
	}
	sum := res.Summary(now)
	r.mu.Lock()
	r.cache[cfg.ID] = sum
	r.mu.Unlock()
	return sum, true
}

func (r *Runner) hubStep(spec RunSpec, in StepInput) (Snapshot, error) {
	return r.hub.Step(spec.UserID, spec.Config.ID, spec.Config, in, spec.Secrets)
}

func defaultMarket(cfg Config, secrets SecretOpener, now time.Time) (Market, error) {
	cfg = cfg.Normalize()
	since := now.Add(-9 * 24 * time.Hour)
	candles, err := LoadCandles(cfg.Mode, cfg.Symbol, cfg.Timeframe, since, now)
	if err != nil {
		return Market{}, err
	}
	higher, err := LoadCandles(cfg.Mode, cfg.Symbol, HigherTimeframe, since, now)
	if err != nil {
		return Market{}, err
	}
	var mkt Market
	mkt.Candles = candles
	mkt.Higher = higher
	if n := len(candles); n > 0 {
		mkt.Mark = candles[n-1].Close
	}
	client := PublicClient(cfg.Mode)
	if rules, err := client.Rules(cfg.Symbol); err == nil && rules.MinNotional > 0 {
		mkt.MinNotional = rules.MinNotional
	}
	if secrets != nil {
		if creds, err := secrets(); err == nil {
			if err := client.UseCredentials(creds); err == nil {
				if wallet, available, err := client.USDTBalance(); err == nil {
					mkt.Wallet = wallet
					mkt.Available = available
					mkt.WalletKnown = true
				}
			}
		}
	}
	return mkt, nil
}
