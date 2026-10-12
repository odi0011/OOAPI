package trading

import (
	"strings"
	"time"
)

// BacktestSummary 是引擎和列表接口上挂的最近一次回测。
type BacktestSummary struct {
	WinRate float64   `json:"winRate"`
	Trades  int       `json:"trades"`
	NetR    float64   `json:"netR"`
	At      time.Time `json:"at,omitempty"`
}

// BacktestTrade 是一笔按实盘同一套开平规则复盘的交易，盈亏已扣手续费和滑点。
type BacktestTrade struct {
	Side       Side      `json:"side"`
	OpenedAt   time.Time `json:"openedAt"`
	ClosedAt   time.Time `json:"closedAt"`
	EntryPrice float64   `json:"entryPrice"`
	ExitPrice  float64   `json:"exitPrice"`
	Reason     string    `json:"reason"`
	NetR       float64   `json:"netR"`
}

// BacktestResult 是一段 K 线的复盘结果。
type BacktestResult struct {
	Symbol     string          `json:"symbol"`
	Timeframe  string          `json:"timeframe"`
	Days       int             `json:"days"`
	Trades     []BacktestTrade `json:"trades"`
	TradeCount int             `json:"tradeCount"`
	Wins       int             `json:"wins"`
	WinRate    float64         `json:"winRate"`
	NetR       float64         `json:"netR"`
	TakerFee   float64         `json:"takerFee"`
	Slippage   float64         `json:"slippage"`
}

func (r BacktestResult) Summary(at time.Time) BacktestSummary {
	return BacktestSummary{WinRate: r.WinRate, Trades: r.TradeCount, NetR: r.NetR, At: at}
}

// BacktestGate 是开仓前的回测门。测网 minWinRate 为 0 时整道门关闭。
// 实盘不允许用 minWinRate<=0 跳过胜率校验，至少要到 DefaultMinWinRate。
// 打开后要同时满足胜率、样本笔数和扣费后的净 R。
// GambleMode 整道门跳过。止损仍须在强平价之前，与这道门无关。
func BacktestGate(cfg Config, sum *BacktestSummary) string {
	if cfg.GambleMode {
		return ""
	}
	live := strings.EqualFold(cfg.Mode, ModeLive)
	floor := cfg.MinWinRate
	if live && floor < DefaultMinWinRate {
		floor = DefaultMinWinRate
	}
	if !live && floor <= 0 {
		return ""
	}
	if sum == nil || sum.WinRate+1e-12 < floor {
		return ReasonWinRateBelow
	}
	need := cfg.MinTrades
	if need <= 0 || (live && need < DefaultMinTrades) {
		need = DefaultMinTrades
	}
	if sum.Trades < need {
		return ReasonInsufficientSamples
	}
	if sum.NetR <= 0 {
		return ReasonNetRNotPositive
	}
	return ""
}

// WindowStats 统计开仓时间落在 [from, until) 的回测成交。胜负按扣费后的净 R。
func WindowStats(trades []BacktestTrade, from, until time.Time) BacktestSummary {
	var sum BacktestSummary
	wins := 0
	for _, trade := range trades {
		if trade.OpenedAt.Before(from) || !trade.OpenedAt.Before(until) {
			continue
		}
		sum.Trades++
		sum.NetR += trade.NetR
		if trade.NetR > 0 {
			wins++
		}
	}
	if sum.Trades > 0 {
		sum.WinRate = float64(wins) / float64(sum.Trades)
	}
	return sum
}

// SweepPass 标出一组参数是否同时通过样本内三道门，并且后一段净 R 为正。
func SweepPass(inSample, outSample BacktestSummary) bool {
	cfg := Config{MinWinRate: DefaultMinWinRate, MinTrades: DefaultMinTrades}
	if BacktestGate(cfg, &inSample) != "" {
		return false
	}
	return outSample.NetR > 0
}

// Backtest 用与引擎相同的开平规则重放 K 线。
// 成交价在信号价上叠加单边滑点，再扣双边 taker 手续费。netR 以扣费后的盈亏除以 1R。
func Backtest(cfg Config, candles, higher []Candle) (BacktestResult, error) {
	return backtest(cfg, candles, higher, TakerFeeRate, SlippageRate)
}

func backtest(cfg Config, candles, higher []Candle, fee, slip float64) (BacktestResult, error) {
	cfg = cfg.Normalize()
	if cfg.Leverage < 1 {
		cfg.Leverage = DefaultLeverage
	}
	out := BacktestResult{
		Symbol:    cfg.Symbol,
		Timeframe: cfg.Timeframe,
		Trades:    []BacktestTrade{},
		TakerFee:  fee,
		Slippage:  slip,
	}
	tf := TimeframeDuration(cfg.Timeframe)
	var (
		side    Side
		qty     = 1.0
		entry   float64
		stop    float64
		take    float64
		opened  time.Time
		lastBar time.Time
	)
	flat := true
	for i := range candles {
		window := candles[:i+1]
		bar := window[len(window)-1]
		htf := closedHigher(higher, bar, tf)
		if !flat {
			cross, err := LastCross(closesOf(window), cfg.EmaFast, cfg.EmaSlow)
			if err != nil {
				return BacktestResult{}, err
			}
			exit, reason, raw := backtestExit(side, bar.Close, stop, take, cross)
			if !exit {
				continue
			}
			fill := slipPrice(side, raw, slip, false)
			trade := settleTrade(side, entry, fill, qty, fee, cfg, opened, bar.OpenTime, reason)
			out.Trades = append(out.Trades, trade)
			out.NetR += trade.NetR
			if trade.NetR > 0 {
				out.Wins++
			}
			flat = true
			side = ""
			lastBar = bar.OpenTime
			continue
		}
		if !bar.OpenTime.IsZero() && bar.OpenTime.Equal(lastBar) {
			continue
		}
		got, signal, err := entrySide(cfg, window, htf)
		if err != nil {
			return BacktestResult{}, err
		}
		if got == "" {
			continue
		}
		rawEntry := bar.Close
		fill := slipPrice(got, rawEntry, slip, true)
		stopPx, takePx, err := stopTake(cfg, got, fill)
		if err != nil {
			continue
		}
		liq, err := IsolatedLiqPrice(got, fill, cfg.Leverage, DefaultMaintMarginRate)
		if err != nil || !StopWithinLiquidation(got, fill, stopPx, liq) {
			continue
		}
		_ = signal
		flat = false
		side = got
		entry = fill
		stop = stopPx
		take = takePx
		opened = bar.OpenTime
		lastBar = bar.OpenTime
	}
	out.TradeCount = len(out.Trades)
	if out.TradeCount > 0 {
		out.WinRate = float64(out.Wins) / float64(out.TradeCount)
	}
	return out, nil
}

func stopTake(cfg Config, side Side, entry float64) (float64, float64, error) {
	if cfg.GambleMode {
		sl, tp := cfg.scalpPcts()
		return ScalpProtection(side, entry, sl, tp)
	}
	return ProtectionPrices(side, entry, entry*DefaultRFraction, cfg.StopR, cfg.TakeProfitR)
}

func entrySide(cfg Config, candles, higher []Candle) (Side, string, error) {
	if cfg.EntryMode == EntryModeTrend {
		side, score, err := ScoreTrend(cfg, candles, higher)
		if err != nil {
			return "", "", err
		}
		need := cfg.MinScore
		if need <= 0 {
			need = DefaultMinScore
		}
		if side == "" || score < need {
			return "", "score_below_min", nil
		}
		return side, "trend", nil
	}
	cross, err := LastCross(closesOf(candles), cfg.EmaFast, cfg.EmaSlow)
	if err != nil {
		return "", "", err
	}
	if cross == CrossNone {
		return "", "no cross", nil
	}
	return SideForCross(cross), string(cross), nil
}

func backtestExit(side Side, price, stop, take float64, cross Cross) (bool, string, float64) {
	if side == SideLong {
		if price <= stop {
			return true, "stop_loss", stop
		}
		if price >= take {
			return true, "take_profit", take
		}
		if cross == CrossDeath {
			return true, "reverse_signal", price
		}
		return false, "", 0
	}
	if price >= stop {
		return true, "stop_loss", stop
	}
	if price <= take {
		return true, "take_profit", take
	}
	if cross == CrossGolden {
		return true, "reverse_signal", price
	}
	return false, "", 0
}

func slipPrice(side Side, price, slip float64, entry bool) float64 {
	if price <= 0 || slip <= 0 {
		return price
	}
	worseUp := (entry && side == SideLong) || (!entry && side == SideShort)
	if worseUp {
		return price * (1 + slip)
	}
	return price * (1 - slip)
}

func settleTrade(side Side, entry, exit, qty, fee float64, cfg Config, opened, closed time.Time, reason string) BacktestTrade {
	gross := RealizedPnL(side, entry, exit, qty)
	fees := fee*entry*qty + fee*exit*qty
	net := gross - fees
	oneR := entry * DefaultRFraction * cfg.StopR * qty
	var r float64
	if oneR > 0 {
		r = net / oneR
	}
	return BacktestTrade{
		Side:       side,
		OpenedAt:   opened,
		ClosedAt:   closed,
		EntryPrice: entry,
		ExitPrice:  exit,
		Reason:     reason,
		NetR:       r,
	}
}

// closedHigher 只保留在信号 K 线收盘时已经走完的高周期 K 线。
func closedHigher(higher []Candle, bar Candle, tf time.Duration) []Candle {
	if len(higher) == 0 {
		return nil
	}
	if tf <= 0 {
		tf = 5 * time.Minute
	}
	barClose := bar.OpenTime.Add(tf)
	out := make([]Candle, 0, len(higher))
	for _, h := range higher {
		if !h.OpenTime.Add(15 * time.Minute).After(barClose) {
			out = append(out, h)
		}
	}
	return out
}

// TimeframeDuration 把策略周期换成时长。不认识的周期按 5 分钟。
func TimeframeDuration(tf string) time.Duration {
	switch tf {
	case "1m":
		return time.Minute
	case "3m":
		return 3 * time.Minute
	case "5m":
		return 5 * time.Minute
	case "15m":
		return 15 * time.Minute
	default:
		return 5 * time.Minute
	}
}

// NextBarClose 返回 now 之后最近一根 K 线收盘后再等一小会儿的时刻。
func NextBarClose(now time.Time, tf time.Duration) time.Time {
	if tf <= 0 {
		tf = 5 * time.Minute
	}
	u := now.UTC()
	slot := u.Truncate(tf).Add(tf)
	return slot.Add(2 * time.Second)
}

// ClosedCandles 丢掉还没收盘的最后一根。
func ClosedCandles(now time.Time, tf time.Duration, candles []Candle) []Candle {
	if tf <= 0 {
		tf = 5 * time.Minute
	}
	out := make([]Candle, 0, len(candles))
	for _, c := range candles {
		if !c.OpenTime.Add(tf).After(now) {
			out = append(out, c)
		}
	}
	return out
}
