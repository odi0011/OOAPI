package trading

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
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
	// Equity 是钱包余额加全部持仓未实现盈亏。EquityKnown 为假时不开新仓。
	Equity         float64
	EquityKnown    bool
	Positions      []KeyPosition
	PositionsKnown bool
}

// MarketFunc 读取行情。测试可以换成固定数据。
type MarketFunc func(cfg Config, secrets SecretOpener, now time.Time) (Market, error)

// Runner 为每条 running 策略起一个循环，在 K 线收盘后调用与手工 step 相同的逻辑。
// 实盘加速窗口内改为大约每 BoostScanInterval 推进一次，并改用正在走的那根 K 线。
type Runner struct {
	hub     *Hub
	now     func() time.Time
	market  MarketFunc
	step    func(spec RunSpec, in StepInput) (Snapshot, error)
	mu      sync.Mutex
	started bool
	onStop  func(strategyID int64)
	// entriesPaused 每一拍从库里读暂停新开仓。读失败时沿用内存里的值。
	entriesPaused func(strategyID int64) (bool, error)
	// pauseBalance 每一拍从库里读余额暂停线。读失败时沿用内存里的值。
	pauseBalance func(strategyID int64) (float64, error)
	jobs         map[int64]context.CancelFunc
	specs        map[int64]RunSpec
	cache        map[int64]backtestCache
	boostEvery   time.Duration
	// flatGap 是测试用的空仓核对间隔。0 表示用 FlatReconcileInterval。
	flatGap time.Duration
	// bookGap 是测试用的开仓回补间隔。0 表示用 EntryBookInterval。
	bookGap time.Duration
}

func NewRunner(hub *Hub) *Runner {
	if hub == nil {
		hub = NewHub()
	}
	r := &Runner{
		hub:   hub,
		now:   func() time.Time { return time.Now().UTC() },
		jobs:  map[int64]context.CancelFunc{},
		specs: map[int64]RunSpec{},
		cache: map[int64]backtestCache{},
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

// SetBoostEvery 只给测试缩短加速扫描间隔。0 表示用 BoostScanInterval。
func (r *Runner) SetBoostEvery(d time.Duration) {
	r.mu.Lock()
	r.boostEvery = d
	r.mu.Unlock()
}

// SetFlatEvery 只给测试缩短持仓期间的空仓核对间隔。0 表示用 FlatReconcileInterval。
func (r *Runner) SetFlatEvery(d time.Duration) {
	r.mu.Lock()
	r.flatGap = d
	r.mu.Unlock()
}

// SetBookEvery 只给测试缩短开仓回补间隔。0 表示用 EntryBookInterval。
func (r *Runner) SetBookEvery(d time.Duration) {
	r.mu.Lock()
	r.bookGap = d
	r.mu.Unlock()
}

// SetEntriesPaused 安装每一拍读取「暂停新开仓」的函数。
func (r *Runner) SetEntriesPaused(fn func(strategyID int64) (bool, error)) {
	r.mu.Lock()
	r.entriesPaused = fn
	r.mu.Unlock()
}

// SetPauseBalance 安装每一拍读取余额暂停线的函数。保存后下一拍生效，不用重启循环。
func (r *Runner) SetPauseBalance(fn func(strategyID int64) (float64, error)) {
	r.mu.Lock()
	r.pauseBalance = fn
	r.mu.Unlock()
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
	delete(r.specs, strategyID)
	delete(r.cache, strategyID)
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Reload 换成最新策略参数，不取消正在跑的循环。下一拍以及之后的推进都用新配置。
func (r *Runner) Reload(spec RunSpec) {
	if r == nil || spec.Config.ID <= 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.jobs[spec.Config.ID]; !ok {
		return
	}
	if r.specs == nil {
		r.specs = map[int64]RunSpec{}
	}
	r.specs[spec.Config.ID] = spec
	delete(r.cache, spec.Config.ID)
}

// Sync 让循环集合和当前 running 策略对齐。
func (r *Runner) Sync(specs []RunSpec) {
	want := map[int64]RunSpec{}
	for _, spec := range specs {
		if spec.Config.ID <= 0 || strings.TrimSpace(spec.Config.PauseReason) != "" {
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
	}
	for id, spec := range want {
		if _, ok := r.jobs[id]; ok {
			if r.specs == nil {
				r.specs = map[int64]RunSpec{}
			}
			r.specs[id] = spec
			delete(r.cache, id)
			continue
		}
		r.launchLocked(spec)
	}
}

func (r *Runner) launchLocked(spec RunSpec) {
	if r.specs == nil {
		r.specs = map[int64]RunSpec{}
	}
	r.specs[spec.Config.ID] = spec
	ctx, cancel := context.WithCancel(context.Background())
	r.jobs[spec.Config.ID] = cancel
	go r.loop(ctx, spec)
}

func (r *Runner) liveSpec(spec RunSpec) RunSpec {
	r.mu.Lock()
	defer r.mu.Unlock()
	if next, ok := r.specs[spec.Config.ID]; ok {
		return next
	}
	return spec
}

func (r *Runner) loop(ctx context.Context, spec RunSpec) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[trading] runner strategy %d panic: %v", spec.Config.ID, rec)
		}
	}()
	spec = r.liveSpec(spec)
	r.bookEntries(ctx, spec)
	r.runOnce(ctx, spec)
	for {
		if ctx.Err() != nil {
			return
		}
		spec = r.liveSpec(spec)
		// 窗口在睡眠期间结束时，下一次醒来先把 boost_end 写进事件流。
		emitBoostEnd(r.now())
		live := strings.EqualFold(spec.Config.Mode, ModeLive)
		// 先订阅再计算等待。加速若赶在两者之间打开，这次拿到的通道会被关掉，select 立刻返回。
		notify := boostPing.C()
		wait := r.nextWait(spec.Config.Timeframe, live)
		timer := time.NewTimer(wait)
		// 持仓时另开一只短时钟。止盈可以在 K 线中间成交，不能等到下一根收盘才发现已经空仓。
		var recTimer *time.Timer
		var recC <-chan time.Time
		if gap := r.flatEvery(); gap > 0 && r.holding(spec) {
			recTimer = time.NewTimer(gap)
			recC = recTimer.C
		}
		var bookTimer *time.Timer
		var bookC <-chan time.Time
		if gap := r.bookEvery(); gap > 0 {
			bookTimer = time.NewTimer(gap)
			bookC = bookTimer.C
		}
		select {
		case <-ctx.Done():
			timer.Stop()
			stopTimer(recTimer)
			stopTimer(bookTimer)
			return
		case <-timer.C:
			stopTimer(recTimer)
			stopTimer(bookTimer)
			spec = r.liveSpec(spec)
			r.runOnce(ctx, spec)
		case <-notify:
			timer.Stop()
			stopTimer(recTimer)
			stopTimer(bookTimer)
			spec = r.liveSpec(spec)
			if live && BoostActive(r.now()) {
				r.runOnce(ctx, spec)
			}
		case <-recC:
			timer.Stop()
			stopTimer(bookTimer)
			spec = r.liveSpec(spec)
			r.reconcileOnce(ctx, spec)
		case <-bookC:
			timer.Stop()
			stopTimer(recTimer)
			spec = r.liveSpec(spec)
			r.bookEntries(ctx, spec)
		}
	}
}

func stopTimer(t *time.Timer) {
	if t == nil {
		return
	}
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
}

func (r *Runner) flatEvery() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.flatGap > 0 {
		return r.flatGap
	}
	return FlatReconcileInterval
}

func (r *Runner) bookEvery() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.bookGap > 0 {
		return r.bookGap
	}
	return EntryBookInterval
}

// bookEntries 补上交易所已经打平、库里却还开着的记录。
// 没有未平记录时不访问交易所。引擎是否还停在 InPosition 不影响这里。
func (r *Runner) bookEntries(ctx context.Context, spec RunSpec) {
	if ctx.Err() != nil || r == nil || spec.Config.ID <= 0 {
		return
	}
	spec = r.liveSpec(spec)
	rows, err := OpenEntries(spec.UserID, spec.Config.ID)
	if err != nil {
		log.Printf("[trading] runner strategy %d entries: %v", spec.Config.ID, err)
		return
	}
	if len(rows) == 0 {
		return
	}
	src := r.entryBook(spec)
	if src == nil {
		log.Printf("[trading] runner strategy %d entries: no exchange book", spec.Config.ID)
		return
	}
	n, err := CloseFlatEntries(src, rows, r.now())
	if err != nil {
		log.Printf("[trading] runner strategy %d book: %v", spec.Config.ID, err)
		return
	}
	if n > 0 {
		log.Printf("[trading] runner strategy %d booked %d flat entries", spec.Config.ID, n)
	}
}

func (r *Runner) entryBook(spec RunSpec) EntryBook {
	var creds Credentials
	have := false
	if spec.Secrets != nil {
		if got, err := spec.Secrets(); err == nil {
			creds = got
			have = true
		}
	}
	if r.hub != nil {
		if ex := r.hub.boundExchange(spec.UserID, spec.Config.ID); ex != nil {
			if have {
				if sink, ok := ex.(interface{ UseCredentials(Credentials) error }); ok {
					_ = sink.UseCredentials(creds)
				}
			}
			if book, ok := ex.(EntryBook); ok && exchangeReady(ex) {
				return book
			}
		}
	}
	if !have {
		return nil
	}
	client := PublicClient(spec.Config.Mode)
	if err := client.UseCredentials(creds); err != nil {
		return nil
	}
	return client
}

func exchangeReady(ex Exchange) bool {
	ready, ok := ex.(interface{ CredentialsReady() bool })
	if !ok {
		return true
	}
	return ready.CredentialsReady()
}

func (r *Runner) holding(spec RunSpec) bool {
	if r == nil || r.hub == nil {
		return false
	}
	snap, ok := r.hub.State(spec.UserID, spec.Config.ID)
	return ok && snap.State == StateInPosition
}

func (r *Runner) reconcileOnce(ctx context.Context, spec RunSpec) {
	if ctx.Err() != nil || r == nil || r.hub == nil {
		return
	}
	spec = r.liveSpec(spec)
	if _, err := r.hub.ReconcileFlat(spec.UserID, spec.Config.ID, r.now(), spec.Secrets); err != nil {
		log.Printf("[trading] runner strategy %d reconcile: %v", spec.Config.ID, err)
	}
}

func (r *Runner) nextWait(timeframe string, live bool) time.Duration {
	r.mu.Lock()
	every := r.boostEvery
	r.mu.Unlock()
	return scanWaitEvery(r.now(), timeframe, live, every)
}

func (r *Runner) runOnce(ctx context.Context, spec RunSpec) {
	if ctx.Err() != nil {
		return
	}
	spec = r.liveSpec(spec)
	spec.Config.PauseEntries = r.readEntriesPaused(spec)
	spec.Config.PauseBalanceUsdt = r.readPauseBalance(spec)
	now := r.now()
	mkt, err := r.market(spec.Config, spec.Secrets, now)
	if err != nil {
		log.Printf("[trading] runner strategy %d market: %v", spec.Config.ID, err)
		return
	}
	if mkt.EquityKnown && mkt.Equity <= BalanceFloorUSDT {
		_, _ = r.step(spec, StepInput{
			Now: now, Wallet: mkt.Wallet, Available: mkt.Available, WalletKnown: mkt.WalletKnown,
			AccountEquity: mkt.Equity, EquityKnown: true,
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
		AccountEquity:  mkt.Equity,
		EquityKnown:    mkt.EquityKnown,
		Positions:      mkt.Positions,
		PositionsKnown: mkt.PositionsKnown,
	}
	if !mkt.EquityKnown && in.SkipReason == "" {
		in.SkipReason = ReasonEquityUnknown
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
	switch snap.LastReason {
	case ReasonBalanceFloor, ReasonConsecutiveLosses, ReasonBalanceBelowPause:
		r.stopSpec(spec.Config.ID)
	}
}

func (r *Runner) readEntriesPaused(spec RunSpec) bool {
	r.mu.Lock()
	fn := r.entriesPaused
	r.mu.Unlock()
	if fn == nil || spec.Config.ID <= 0 {
		return spec.Config.PauseEntries
	}
	paused, err := fn(spec.Config.ID)
	if err != nil {
		log.Printf("[trading] runner strategy %d pause entries: %v", spec.Config.ID, err)
		return spec.Config.PauseEntries
	}
	r.rememberEntriesPaused(spec.Config.ID, paused)
	return paused
}

func (r *Runner) readPauseBalance(spec RunSpec) float64 {
	r.mu.Lock()
	fn := r.pauseBalance
	r.mu.Unlock()
	if fn == nil || spec.Config.ID <= 0 {
		return spec.Config.PauseBalanceUsdt
	}
	line, err := fn(spec.Config.ID)
	if err != nil {
		log.Printf("[trading] runner strategy %d pause balance: %v", spec.Config.ID, err)
		return spec.Config.PauseBalanceUsdt
	}
	if line > 0 && line < BalanceFloorUSDT {
		line = BalanceFloorUSDT
	}
	r.rememberPauseBalance(spec.Config.ID, line)
	return line
}

func (r *Runner) rememberPauseBalance(id int64, line float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.specs[id]
	if !ok {
		return
	}
	cur.Config.PauseBalanceUsdt = line
	r.specs[id] = cur
}

// rememberEntriesPaused 记下最近一次读库成功的开关。下一拍读失败时 liveSpec 仍带着它。
func (r *Runner) rememberEntriesPaused(id int64, paused bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.specs[id]
	if !ok {
		return
	}
	cur.Config.PauseEntries = paused
	r.specs[id] = cur
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
	if !mkt.EquityKnown || mkt.Equity <= BalanceFloorUSDT {
		return invalid("还没有读到账户权益")
	}
	capital := mkt.Wallet
	if capital <= 0 {
		capital = mkt.Equity
	}
	_, err := r.hub.Start(spec.UserID, spec.Config.ID, spec.Config, StartInput{
		Now:            r.now(),
		FundingRate:    0,
		LiqDistancePct: -1,
		EquityUSDT:     capital,
	}, spec.Secrets)
	return err
}

// backtestCache 记下上次回测和它吃过的已收盘数据。
// 同一批已收盘 K 线在 BacktestEvery 内直接复用，避免加速扫描改写胜率。
// 新 K 线收盘或行情变了就重算，不再只在引擎启动时算一次。
type backtestCache struct {
	Sum BacktestSummary
	Key string
}

func (r *Runner) backtest(cfg Config, mkt Market, now time.Time) (BacktestSummary, bool) {
	cfg = cfg.Normalize()
	// 信号可以用未收盘 K 线，回测门仍只吃已收盘的，避免加速扫描改写胜率。
	candles := ClosedCandles(now, TimeframeDuration(cfg.Timeframe), mkt.Candles)
	higher := ClosedCandles(now, TimeframeDuration(HigherTimeframe), mkt.Higher)
	key := backtestDataKey(cfg, candles, higher)
	r.mu.Lock()
	cached, ok := r.cache[cfg.ID]
	r.mu.Unlock()
	fresh := ok && !cached.Sum.At.IsZero() && now.Sub(cached.Sum.At) < BacktestEvery
	if fresh && (len(candles) == 0 || cached.Key == key) {
		return cached.Sum, true
	}
	if len(candles) == 0 {
		return BacktestSummary{}, false
	}
	res, err := Backtest(cfg, candles, higher)
	if err != nil {
		log.Printf("[trading] runner strategy %d backtest: %v", cfg.ID, err)
		// 窗口内算失败时沿用上一份成功的结果，避免一次计算错误把开仓门改成空回测。
		if fresh {
			return cached.Sum, true
		}
		return BacktestSummary{}, false
	}
	sum := res.Summary(now)
	r.mu.Lock()
	r.cache[cfg.ID] = backtestCache{Sum: sum, Key: key}
	r.mu.Unlock()
	return sum, true
}

// backtestDataKey 把策略配置和已收盘 K 线收成一个键。
// 键变了说明来了新数据，或策略参数变了，回测要重算。
func backtestDataKey(cfg Config, candles, higher []Candle) string {
	cfg = cfg.Normalize()
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%s|%s|%d|%d|%d|%.6f|%.6f|%d|%t|%.6f|%.6f|%.4f|%.4f|%.4f|%.4f|%.8f|%.4f|%.8f|%.8f|%t|%.6f|%.4f",
		cfg.Symbol, cfg.Timeframe, cfg.EntryMode, cfg.Leverage, cfg.EmaFast, cfg.EmaSlow,
		cfg.StopR, cfg.TakeProfitR, cfg.MinScore, cfg.GambleMode, cfg.ScalpTpPct, cfg.ScalpSlPct,
		cfg.RSILongMin, cfg.RSILongMax, cfg.RSIShortMin, cfg.RSIShortMax,
		cfg.oneRFraction(), cfg.expectancyCapR(), cfg.takerFee(), cfg.makerFee(), cfg.ExpectancyGate,
		cfg.MaxMarginUsdt, cfg.DailyLossPct)
	writeCandleKey(&b, "c", candles)
	writeCandleKey(&b, "h", higher)
	return b.String()
}

func writeCandleKey(b *strings.Builder, label string, candles []Candle) {
	fmt.Fprintf(b, "|%s:%d", label, len(candles))
	if len(candles) == 0 {
		return
	}
	last := candles[len(candles)-1]
	fmt.Fprintf(b, ":%d:%.8f", last.OpenTime.UTC().UnixNano(), last.Close)
}

func (r *Runner) hubStep(spec RunSpec, in StepInput) (Snapshot, error) {
	return r.hub.Step(spec.UserID, spec.Config.ID, spec.Config, in, spec.Secrets)
}

func defaultMarket(cfg Config, secrets SecretOpener, now time.Time) (Market, error) {
	cfg = cfg.Normalize()
	since := now.Add(-9 * 24 * time.Hour)
	includeOpen := strings.EqualFold(cfg.Mode, ModeLive) && BoostActive(now)
	candles, err := loadCandles(cfg.Mode, cfg.Symbol, cfg.Timeframe, since, now, includeOpen)
	if err != nil {
		return Market{}, err
	}
	higher, err := loadCandles(cfg.Mode, cfg.Symbol, HigherTimeframe, since, now, includeOpen)
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
				if eq, err := client.ReadEquity(); err != nil {
					log.Printf("[trading] runner strategy %d equity: %v", cfg.ID, err)
				} else {
					mkt.Wallet = eq.Wallet
					mkt.Available = eq.Available
					mkt.WalletKnown = true
					mkt.Equity = eq.Equity
					mkt.EquityKnown = true
				}
				positions, err := client.AccountPositions()
				if err != nil {
					return Market{}, err
				}
				mkt.Positions = positions
				mkt.PositionsKnown = true
			}
		}
	}
	return mkt, nil
}
