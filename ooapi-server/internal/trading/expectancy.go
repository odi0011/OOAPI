package trading

import (
	"errors"
	"math"
	"strings"
)

// expectancyRoundSlack 加在临界止盈上，避免浮点和 tick 四舍五入把期望打回 0。
const expectancyRoundSlack = 0.0001

// errNegativeExpectancy 表示这笔信号在允许的止盈范围内期望不为正。
// 开仓前记成 skip。已经成交之后不能跳过，调用方要平仓。
var errNegativeExpectancy = errors.New("negative expectancy")

// RoundTripFees 是按价格比例计的往返手续费。
// 盈利那笔：开仓 taker，止盈 maker。亏损那笔：开仓 taker，止损 taker。
type RoundTripFees struct {
	Win  float64
	Loss float64
}

// FeesFromRates 把 commissionRate 的 maker/taker 收成两笔往返成本。
// 止盈出场用 maker，开仓和止损出场用 taker。
func FeesFromRates(maker, taker float64) RoundTripFees {
	if maker < 0 {
		maker = 0
	}
	if taker < 0 {
		taker = 0
	}
	return RoundTripFees{Win: taker + maker, Loss: taker + taker}
}

// TradeExpectancy 是 EV = p*(tpDist-feeWin) - (1-p)*(slDist+feeLoss)。
// 距离和手续费都是价格的比例，不是报价货币。
func TradeExpectancy(p, tpDist, slDist float64, fees RoundTripFees) float64 {
	if p < 0 {
		p = 0
	}
	if p > 1 {
		p = 1
	}
	return p*(tpDist-fees.Win) - (1-p)*(slDist+fees.Loss)
}

// ResolveTakeProfit 在 [max(base, MinScalpTpPct), cap] 里找让期望严格为正的止盈距离。
// 回测胜率是在原来的止盈、止损距离上测到的。距离放宽之后先按新障碍重算胜率，再用新胜率算 EV。
// known 为假表示没有回测样本，只保留原距离和 0.15% 下限，不因期望跳过。
// 有样本但 ExpectancyTpCapR 以内仍无法让 EV > 0 时返回 negative_expectancy。
// 普通开仓、加速开仓、强制开仓和 GambleMode 都用这个结果，不能绕开。
func ResolveTakeProfit(p float64, known bool, slDist, baseTp float64, fees RoundTripFees) (float64, string) {
	dist, _, reason := ResolveLiveTakeProfit(p, known, slDist, baseTp, fees)
	return dist, reason
}

// ResolveLiveTakeProfit 同时给出放行后的止盈距离和该距离上的实盘期望。
// liveEV 是价格比例，不是回测的 expectancyR。没放行时距离为 0，liveEV 是上限内见到的最高期望（不大于 0）。
func ResolveLiveTakeProfit(p float64, known bool, slDist, baseTp float64, fees RoundTripFees) (dist, liveEV float64, reason string) {
	tp := baseTp
	if tp < MinScalpTpPct {
		tp = MinScalpTpPct
	}
	if !known {
		return tp, 0, ""
	}
	if !(p > 0) || !(slDist > 0) || math.IsNaN(p) || math.IsNaN(slDist) || math.IsNaN(tp) {
		return 0, 0, ReasonNegativeExpectancy
	}
	if p > 1 {
		p = 1
	}
	cap := expectancyTpCap(baseTp)
	if tp > cap {
		cap = tp
	}
	theta := impliedBarrierTheta(p, tp, slDist)
	evAt := func(d float64) float64 {
		ev := TradeExpectancy(winRateForTheta(p, theta, tp, slDist, d), d, slDist, fees)
		if math.IsNaN(ev) || math.IsInf(ev, 0) {
			return -1
		}
		return ev
	}
	baseEV := evAt(tp)
	if baseEV > 0 {
		return tp, baseEV, ""
	}
	bestEV := baseEV
	if !(cap > tp) {
		return 0, bestEV, ReasonNegativeExpectancy
	}
	const steps = 256
	prev := tp
	for i := 1; i <= steps; i++ {
		d := tp + (cap-tp)*float64(i)/float64(steps)
		ev := evAt(d)
		if ev > bestEV {
			bestEV = ev
		}
		if ev > 0 {
			chosen := slackenTakeProfit(evAt, bisectPositiveTakeProfit(evAt, prev, d), cap)
			chosenEV := evAt(chosen)
			if chosenEV > 0 {
				return chosen, chosenEV, ""
			}
		}
		prev = d
	}
	return 0, bestEV, ReasonNegativeExpectancy
}

// WinRateAtDistance 把在 (baseTp, sl) 上观察到的胜率，换算成止盈改到 tp 之后的胜率。
// 价格按带漂移的布朗运动处理：先用原距离反解漂移，再算哪一边的障碍先被碰到。
// 止盈与原距离相同时原样返回，不改样本胜率。
func WinRateAtDistance(p, baseTp, sl, tp float64) float64 {
	if math.IsNaN(p) || math.IsNaN(tp) {
		return 0
	}
	p = clamp01(p)
	if !(baseTp > 0) || !(sl > 0) || !(tp > 0) {
		return p
	}
	return winRateForTheta(p, impliedBarrierTheta(p, baseTp, sl), baseTp, sl, tp)
}

func winRateForTheta(sample, theta, base, sl, tp float64) float64 {
	if !(tp > 0) || math.Abs(tp-base) <= 1e-15*math.Max(1, math.Abs(base)) {
		return clamp01(sample)
	}
	if math.IsInf(theta, 1) {
		return 1
	}
	if math.IsInf(theta, -1) {
		return 0
	}
	return barrierWinRate(theta, tp, sl)
}

// barrierWinRate 是从现价出发，先碰到上方 tp 而不是下方 sl 的概率。
// theta 是 2μ/σ²。theta 为 0 时等于 sl/(tp+sl)。
func barrierWinRate(theta, tp, sl float64) float64 {
	if !(sl > 0) || math.IsNaN(tp) || math.IsNaN(sl) || math.IsNaN(theta) {
		return 0
	}
	if tp < 0 {
		tp = 0
	}
	if math.Abs(theta) <= 1e-8 {
		return sl / (tp + sl)
	}
	if theta < 0 {
		phi := -theta
		num := -math.Expm1(-phi * sl)
		den := -math.Expm1(-phi * (tp + sl))
		if !(den > 0) || math.IsInf(num, 0) || math.IsInf(den, 0) {
			return 0
		}
		return clamp01(math.Exp(-phi*tp) * num / den)
	}
	num := -math.Expm1(-theta * sl)
	den := -math.Expm1(-theta * (tp + sl))
	if !(den > 0) || math.IsInf(den, 0) {
		return 1
	}
	return clamp01(num / den)
}

// impliedBarrierTheta 用原距离上的胜率反解漂移。解不出来时用正负无穷表示必胜或必败。
func impliedBarrierTheta(p, tp, sl float64) float64 {
	if !(tp > 0) || !(sl > 0) || math.IsNaN(p) {
		return 0
	}
	if p <= 0 {
		return math.Inf(-1)
	}
	if p >= 1 {
		return math.Inf(1)
	}
	if math.Abs(p-sl/(tp+sl)) <= 1e-12 {
		return 0
	}
	lo, hi := -1.0, 1.0
	for i := 0; i < 60 && barrierWinRate(lo, tp, sl) > p; i++ {
		lo *= 2
	}
	for i := 0; i < 60 && barrierWinRate(hi, tp, sl) < p; i++ {
		hi *= 2
	}
	if barrierWinRate(hi, tp, sl) < p {
		return math.Inf(1)
	}
	if barrierWinRate(lo, tp, sl) > p {
		return math.Inf(-1)
	}
	for i := 0; i < 80; i++ {
		mid := (lo + hi) / 2
		if barrierWinRate(mid, tp, sl) < p {
			lo = mid
		} else {
			hi = mid
		}
	}
	return (lo + hi) / 2
}

func bisectPositiveTakeProfit(evAt func(float64) float64, lo, hi float64) float64 {
	for n := 0; n < 60; n++ {
		mid := (lo + hi) / 2
		if evAt(mid) > 0 {
			hi = mid
		} else {
			lo = mid
		}
	}
	return hi
}

// slackenTakeProfit 在刚穿过 0 的距离上再加一点，避免报价四舍五入把期望打回去。
// 加完之后若新胜率下的期望不再为正，就留在原来那个已经为正的距离。
func slackenTakeProfit(evAt func(float64) float64, chosen, cap float64) float64 {
	nudged := chosen + expectancyRoundSlack
	if nudged > cap {
		nudged = cap
	}
	if evAt(nudged) > 0 {
		return nudged
	}
	return chosen
}

func clamp01(p float64) float64 {
	if math.IsNaN(p) || p < 0 {
		return 0
	}
	if p > 1 {
		return 1
	}
	return p
}

// positiveTpDistance 是让 EV 刚好穿过 0 的止盈距离，再加一点余量。
// 闭式解 EV = 0 时的 tp 还不算严格为正。
func positiveTpDistance(p, slDist float64, fees RoundTripFees) float64 {
	need := fees.Win + ((1-p)/p)*(slDist+fees.Loss) + expectancyRoundSlack
	if !(TradeExpectancy(p, need, slDist, fees) > 0) {
		need = math.Nextafter(need, math.Inf(1))
	}
	return need
}

func expectancyTpCap(baseTp float64) float64 {
	cap := ExpectancyTpCapR * DefaultRFraction
	if baseTp > cap {
		cap = baseTp
	}
	if cap < MinScalpTpPct {
		cap = MinScalpTpPct
	}
	return cap
}

func (e *Engine) sampleWinRate() (float64, bool) {
	if e == nil || e.lastBacktest == nil || e.lastBacktest.Trades <= 0 {
		return 0, false
	}
	return e.lastBacktest.WinRate, true
}

func (e *Engine) roundTripFees() RoundTripFees {
	if e == nil {
		return FeesFromRates(MakerFeeRate, TakerFeeRate)
	}
	if e.feeReady {
		return e.feeRound
	}
	maker, taker := MakerFeeRate, TakerFeeRate
	type rates interface {
		CommissionRates(symbol string) (float64, float64, error)
	}
	if src, ok := e.ex.(rates); ok && strings.TrimSpace(e.cfg.Symbol) != "" {
		if m, t, err := src.CommissionRates(e.cfg.Symbol); err == nil {
			maker, taker = m, t
		}
	}
	e.feeRound = FeesFromRates(maker, taker)
	e.feeReady = true
	return e.feeRound
}

// tpExpectancyReason 在开仓前用配置距离和回测胜率判断期望。
// 止盈被放宽时，胜率按新距离重算。没有样本时不拦。
// 要跳过时加速候选也不会被标成可开，强制开仓和赌一把同样进不来。
func (e *Engine) tpExpectancyReason() string {
	if e == nil {
		return ""
	}
	stop, take, err := stopTake(e.cfg, SideLong, 1)
	if err != nil || !(stop > 0) || !(take > 0) {
		return ""
	}
	_, reason := e.adjustTakeDistance(math.Abs(1-stop), math.Abs(take-1))
	return reason
}

func (e *Engine) adjustTakeDistance(slDist, baseTp float64) (float64, string) {
	p, known := e.sampleWinRate()
	dist, live, reason := ResolveLiveTakeProfit(p, known, slDist, baseTp, e.roundTripFees())
	if e != nil {
		e.liveExpectancy = live
		if reason == "" {
			e.takeProfitDist = dist
		} else {
			e.takeProfitDist = 0
		}
	}
	return dist, reason
}

func takeFromDistance(side Side, entry, dist float64) float64 {
	if side == SideShort {
		return entry * (1 - dist)
	}
	return entry * (1 + dist)
}
