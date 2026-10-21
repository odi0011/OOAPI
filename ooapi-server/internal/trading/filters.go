package trading

import (
	"math"
	"time"
)

// ATRPeriod 是入场波动过滤用的真实波幅周期。
const ATRPeriod = 14

// atrCandles 优先用策略周期上已经收盘的 K 线。
// 样本不够时退回调用方给的整段，避免把「还没攒够 14 根」当成「波动为 0」。
func atrCandles(cfg Config, in StepInput) []Candle {
	candles := in.Candles
	if len(candles) == 0 || in.Now.IsZero() {
		return candles
	}
	closed := ClosedCandles(at(in.Now), TimeframeDuration(cfg.Timeframe), candles)
	if len(closed) >= ATRPeriod+1 {
		return closed
	}
	return candles
}

// ATRPct 是 ATR(period) / 最后一根收盘价，和 scalp_sl_pct 用同一套价格比例。
// 缺高低价或样本不够时 ok 为假：调用方不要把 0 当成「没有波动」。
func ATRPct(candles []Candle, period int) (float64, bool) {
	if period < 1 || len(candles) < period+1 {
		return 0, false
	}
	trs := make([]float64, 0, len(candles)-1)
	for i := 1; i < len(candles); i++ {
		tr, ok := trueRange(candles[i], candles[i-1].Close)
		if !ok {
			return 0, false
		}
		trs = append(trs, tr)
	}
	if len(trs) < period {
		return 0, false
	}
	sum := 0.0
	for i := 0; i < period; i++ {
		sum += trs[i]
	}
	atr := sum / float64(period)
	for i := period; i < len(trs); i++ {
		atr = (atr*float64(period-1) + trs[i]) / float64(period)
	}
	price := candles[len(candles)-1].Close
	if !(atr > 0) || !(price > 0) || math.IsNaN(atr) || math.IsInf(atr, 0) {
		return 0, false
	}
	return atr / price, true
}

func trueRange(bar Candle, prevClose float64) (float64, bool) {
	if !(bar.High > 0) || !(bar.Low > 0) || bar.High < bar.Low || !(prevClose > 0) {
		return 0, false
	}
	tr := bar.High - bar.Low
	if d := math.Abs(bar.High - prevClose); d > tr {
		tr = d
	}
	if d := math.Abs(bar.Low - prevClose); d > tr {
		tr = d
	}
	if !(tr > 0) || math.IsNaN(tr) || math.IsInf(tr, 0) {
		return 0, false
	}
	return tr, true
}

// plannedMovePcts 是这笔单会用的止损、止盈距离，相对价格。
// 赌一把用 scalp_sl_pct / scalp_tp_pct。其余模式用 stopR、takeProfitR 乘 1R，
// 因为那才是真正挂出去的距离。
func plannedMovePcts(cfg Config) (sl, tp float64) {
	cfg = cfg.Normalize()
	if cfg.GambleMode {
		return cfg.scalpPcts()
	}
	stopR := cfg.StopR
	if stopR <= 0 {
		stopR = DefaultStopR
	}
	takeR := cfg.TakeProfitR
	if takeR <= 0 {
		takeR = DefaultTakeProfitR
	}
	return stopR * cfg.oneRFraction(), takeR * cfg.oneRFraction()
}

// entryVolFeeReason 在回测门和期望门之后拦开仓。
// 止损落在噪声里、止盈远到 ATR 到不了、或者毛止盈盖不住往返 taker 手续费时返回原因。
// 算不出 ATR 时只做手续费比较，不把缺数据当成噪声。
func entryVolFeeReason(cfg Config, candles []Candle, roundTripTaker float64) string {
	cfg = cfg.Normalize()
	sl, tp := plannedMovePcts(cfg)
	if !(sl > 0) || !(tp > 0) || math.IsNaN(sl) || math.IsNaN(tp) {
		return ""
	}
	if atr, ok := ATRPct(candles, ATRPeriod); ok && atr > 0 {
		if sl < cfg.SlNoiseMult*atr {
			return ReasonSLInsideNoise
		}
		if tp > cfg.TpAtrMult*atr {
			return ReasonTPUnreachable
		}
	}
	if roundTripTaker < 0 || math.IsNaN(roundTripTaker) || math.IsInf(roundTripTaker, 0) {
		roundTripTaker = 0
	}
	if cfg.FeeEdgeMult > 0 && roundTripTaker > 0 && tp < cfg.FeeEdgeMult*roundTripTaker {
		return ReasonFeeEdgeTooSmall
	}
	return ""
}

// allowReverseExit 只在反向交叉同时满足最短持仓和快慢线张开时平仓。
// 任一条件不够就留给交易所止损止盈，不在这里市价出场。
// hold 为 0 时不看持仓时间，和改这个字段之前一样。
func allowReverseExit(cfg Config, side Side, cross Cross, price float64, opened, now time.Time, fastEMA, slowEMA float64, emaOK bool) bool {
	if side == SideLong && cross != CrossDeath {
		return false
	}
	if side == SideShort && cross != CrossGolden {
		return false
	}
	cfg = cfg.Normalize()
	hold := cfg.ReverseMinHoldBars
	if hold < 0 {
		hold = 0
	}
	if hold > 0 {
		tf := TimeframeDuration(cfg.Timeframe)
		if opened.IsZero() || now.IsZero() || tf <= 0 || now.Sub(opened) < time.Duration(hold)*tf {
			return false
		}
	}
	gap := cfg.ReverseMinGapPct
	if gap <= 0 {
		gap = DefaultReverseMinGapPct
	}
	if !emaOK || !(price > 0) {
		return false
	}
	sep := fastEMA - slowEMA
	if side == SideLong {
		sep = slowEMA - fastEMA
	}
	return sep+1e-12 >= gap*price
}

func emaPair(closes []float64, fastPeriod, slowPeriod int) (fast, slow float64, ok bool) {
	if fastPeriod < 1 || slowPeriod <= fastPeriod || len(closes) < slowPeriod {
		return 0, 0, false
	}
	fastE, err := EMA(closes, fastPeriod)
	if err != nil || len(fastE) == 0 {
		return 0, 0, false
	}
	slowE, err := EMA(closes, slowPeriod)
	if err != nil || len(slowE) == 0 {
		return 0, 0, false
	}
	i := len(closes) - 1
	fast, slow = fastE[i], slowE[i]
	if fast == 0 && slow == 0 {
		return 0, 0, false
	}
	return fast, slow, true
}

// closedBarsSince 数 (since, now] 里已经走完的 K 线根数。
// since 落在某根收盘时刻上时，那一根不算，从下一根收盘开始数。
func closedBarsSince(since, now time.Time, tf time.Duration) int {
	if tf <= 0 || since.IsZero() || !now.After(since) {
		return 0
	}
	since = since.UTC()
	now = now.UTC()
	next := since.Truncate(tf)
	if !next.After(since) {
		next = next.Add(tf)
	}
	if now.Before(next) {
		return 0
	}
	return int(now.Sub(next)/tf) + 1
}

// NetRealized 是价差盈亏减去开平两边的 taker 手续费。
// 数量按报价货币：手续费 = taker × (入场价 + 出场价) × 数量。
func NetRealized(side Side, entry, exit, qty, takerFee float64) float64 {
	gross := RealizedPnL(side, entry, exit, qty)
	if takerFee < 0 || math.IsNaN(takerFee) || math.IsInf(takerFee, 0) {
		takerFee = 0
	}
	if entry < 0 || math.IsNaN(entry) || math.IsInf(entry, 0) {
		entry = 0
	}
	if exit < 0 || math.IsNaN(exit) || math.IsInf(exit, 0) {
		exit = 0
	}
	if qty < 0 || math.IsNaN(qty) || math.IsInf(qty, 0) {
		qty = 0
	}
	return gross - takerFee*qty*(entry+exit)
}
