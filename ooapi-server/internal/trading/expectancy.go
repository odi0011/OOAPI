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
// known 为假表示没有回测样本，只保留原距离和 0.15% 下限，不因期望跳过。
// 有样本但上限内仍无法让 EV > 0 时返回 negative_expectancy。
// 普通开仓、加速开仓和强制开仓都用这个结果，GambleMode 不能绕开。
func ResolveTakeProfit(p float64, known bool, slDist, baseTp float64, fees RoundTripFees) (float64, string) {
	tp := baseTp
	if tp < MinScalpTpPct {
		tp = MinScalpTpPct
	}
	if !known {
		return tp, ""
	}
	if !(p > 0) || slDist <= 0 || math.IsNaN(p) || math.IsNaN(slDist) || math.IsNaN(tp) {
		return 0, ReasonNegativeExpectancy
	}
	if p > 1 {
		p = 1
	}
	if TradeExpectancy(p, tp, slDist, fees) > 0 {
		return tp, ""
	}
	cap := expectancyTpCap(baseTp)
	if !(TradeExpectancy(p, cap, slDist, fees) > 0) {
		return 0, ReasonNegativeExpectancy
	}
	need := positiveTpDistance(p, slDist, fees)
	if need < tp {
		need = tp
	}
	if need > cap {
		need = cap
	}
	if !(TradeExpectancy(p, need, slDist, fees) > 0) {
		return 0, ReasonNegativeExpectancy
	}
	return need, ""
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
// 没有样本时不拦。要跳过时加速候选也不会被标成可开，强制开仓同样进不来。
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
	return ResolveTakeProfit(p, known, slDist, baseTp, e.roundTripFees())
}

func takeFromDistance(side Side, entry, dist float64) float64 {
	if side == SideShort {
		return entry * (1 - dist)
	}
	return entry * (1 + dist)
}
