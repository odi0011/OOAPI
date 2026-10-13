package trading

import (
	"math"
	"time"
)

// Side 是持仓方向。空字符串表示空仓。
type Side string

const (
	SideLong  Side = "long"
	SideShort Side = "short"
)

// ProtectionPrices 按 R 计算止损和止盈价。
// oneR 是 1R 的价格距离；stopR / takeProfitR 是倍数。
// 多单止损在下方、止盈在上方；空单相反。价格必须保持为正。
func ProtectionPrices(side Side, entry, oneR, stopR, takeProfitR float64) (stop, take float64, err error) {
	if !finitePositive(entry) || !finitePositive(oneR) || !finitePositive(stopR) || !finitePositive(takeProfitR) {
		return 0, 0, invalid("入场价、R 距离、止损倍数和止盈倍数都必须大于 0")
	}
	risk := stopR * oneR
	reward := takeProfitR * oneR
	switch side {
	case SideLong:
		stop = entry - risk
		take = entry + reward
	case SideShort:
		stop = entry + risk
		take = entry - reward
	default:
		return 0, 0, invalid("持仓方向只能是 long 或 short")
	}
	if !finitePositive(stop) || !finitePositive(take) {
		return 0, 0, invalid("止损或止盈价计算后不是正数")
	}
	return stop, take, nil
}

// ScalpProtection 按入场价的百分比计算止损和止盈。
// 止盈距离低于 MinScalpTpPct 时抬到该下限，用来盖住往返手续费和滑点。
func ScalpProtection(side Side, entry, slPct, tpPct float64) (stop, take float64, err error) {
	if !finitePositive(entry) || !finitePositive(slPct) || !finitePositive(tpPct) {
		return 0, 0, invalid("入场价和剥头皮止损止盈比例都必须大于 0")
	}
	if tpPct < MinScalpTpPct {
		tpPct = MinScalpTpPct
	}
	switch side {
	case SideLong:
		stop = entry * (1 - slPct)
		take = entry * (1 + tpPct)
	case SideShort:
		stop = entry * (1 + slPct)
		take = entry * (1 - tpPct)
	default:
		return 0, 0, invalid("持仓方向只能是 long 或 short")
	}
	if !finitePositive(stop) || !finitePositive(take) {
		return 0, 0, invalid("止损或止盈价计算后不是正数")
	}
	return stop, take, nil
}

// scalpPcts 把 0 当成默认 0.3%。调用方仍要在止盈上执行 MinScalpTpPct。
func (c Config) scalpPcts() (sl, tp float64) {
	sl, tp = c.ScalpSlPct, c.ScalpTpPct
	if !(sl > 0) || math.IsInf(sl, 0) {
		sl = DefaultScalpPct
	}
	if !(tp > 0) || math.IsInf(tp, 0) {
		tp = DefaultScalpPct
	}
	return sl, tp
}

// SizePosition 用保证金上限和杠杆计算数量。
// 名义价值低于交易所下限时拒绝，不会为了凑够下限而突破保证金上限。
func SizePosition(maxMargin float64, leverage int, price, minNotional float64) (margin, notional, qty float64, err error) {
	if !finitePositive(maxMargin) || !finitePositive(price) || !finitePositive(minNotional) {
		return 0, 0, 0, invalid("保证金、价格和最小名义价值都必须大于 0")
	}
	if leverage < 1 || leverage > MaxLeverage {
		return 0, 0, 0, invalidLeverage()
	}
	margin = maxMargin
	notional = margin * float64(leverage)
	if notional+1e-9 < minNotional {
		return 0, 0, 0, withReason(ErrNotionalBelowMin, "notional_below_minimum")
	}
	qty = notional / price
	if !finitePositive(qty) {
		return 0, 0, 0, invalid("计算出的数量不是正数")
	}
	return margin, notional, qty, nil
}

// AlignQuantity 按交易所步长向下取整。取整后不够最小数量时返回 0，调用方按名义价值不足拒绝。
func AlignQuantity(qty, step, minQty float64) float64 {
	if !(qty > 0) || math.IsInf(qty, 0) {
		return 0
	}
	if step > 0 && !math.IsInf(step, 0) {
		qty = math.Floor((qty/step)+1e-9) * step
	}
	if !(qty > 0) || (minQty > 0 && qty+1e-12 < minQty) {
		return 0
	}
	return qty
}

// IsolatedLiqPrice 估算逐仓强平价。
// 多单：entry * (1 - 1/leverage + maintMarginRate)
// 空单：entry * (1 + 1/leverage - maintMarginRate)
// maintMarginRate <= 0 时用 DefaultMaintMarginRate。
func IsolatedLiqPrice(side Side, entry float64, leverage int, maintMarginRate float64) (float64, error) {
	if !finitePositive(entry) || leverage < 1 {
		return 0, invalid("入场价和杠杆都必须大于 0")
	}
	if !(maintMarginRate > 0) || math.IsInf(maintMarginRate, 0) {
		maintMarginRate = DefaultMaintMarginRate
	}
	if maintMarginRate >= 1 {
		return 0, invalid("维持保证金率必须小于 1")
	}
	inv := 1 / float64(leverage)
	var liq float64
	switch side {
	case SideLong:
		liq = entry * (1 - inv + maintMarginRate)
	case SideShort:
		liq = entry * (1 + inv - maintMarginRate)
	default:
		return 0, invalid("持仓方向只能是 long 或 short")
	}
	if !finitePositive(liq) {
		return 0, invalid("强平价计算后不是正数")
	}
	return liq, nil
}

// StopWithinLiquidation 要求止损严格落在入场价和强平价之间，
// 并且止损距离严格小于强平距离的 MaxStopToLiqFraction。
func StopWithinLiquidation(side Side, entry, stop, liq float64) bool {
	if !finitePositive(entry) || !finitePositive(stop) || !finitePositive(liq) {
		return false
	}
	var stopDist, liqDist float64
	switch side {
	case SideLong:
		if !(liq < stop && stop < entry) {
			return false
		}
		stopDist = entry - stop
		liqDist = entry - liq
	case SideShort:
		if !(entry < stop && stop < liq) {
			return false
		}
		stopDist = stop - entry
		liqDist = liq - entry
	default:
		return false
	}
	if !(liqDist > 0) || math.IsInf(liqDist, 0) {
		return false
	}
	return stopDist < MaxStopToLiqFraction*liqDist
}

// DailyHaltBreached 判断当日净已实现盈亏是否触及日亏上限。
// dailyLossPct 是百分数：4 表示资本的 4%。盈利会抵消亏损。
// dailyLossPct >= DailyLossOffPct 时视为关闭停机，本函数返回 false，调用方仍会走到这里。
func DailyHaltBreached(capital, realizedNet, dailyLossPct float64) bool {
	if !finitePositive(capital) || !(dailyLossPct > 0) || math.IsInf(dailyLossPct, 0) || dailyLossPct >= DailyLossOffPct {
		return false
	}
	if math.IsNaN(realizedNet) || math.IsInf(realizedNet, 0) {
		return false
	}
	loss := -realizedNet
	if loss < 0 {
		return false
	}
	return loss >= capital*dailyLossPct/100
}

// StartBlocked 在启动前检查资金费率和强平距离。
// liqDistancePct < 0 表示没有可测量的持仓，不因强平拦截。
func StartBlocked(fundingRate, liqDistancePct float64) (bool, string) {
	if fundingRate < 0 {
		fundingRate = -fundingRate
	}
	if fundingRate >= ExtremeFundingAbs {
		return true, "funding_extreme"
	}
	if liqDistancePct >= 0 && liqDistancePct < MinLiqDistancePct {
		return true, "liquidation_too_close"
	}
	return false, ""
}

// Ledger 记录一个 UTC 日的已实现盈亏。资本取当日第一次见到的权益。
// Cumulative 是本会话累计已实现，日切只清零 Realized，不把历史盈亏抹掉。
type Ledger struct {
	Day        time.Time
	Capital    float64
	Realized   float64
	Cumulative float64
	Halted     bool
}

func utcDay(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}

// Roll 跨过 UTC 日界时清零当日盈亏并解除停机。同一天重复调用不改资本。
func (l *Ledger) Roll(now time.Time, equity float64) {
	day := utcDay(now)
	if !l.Day.IsZero() && l.Day.Equal(day) {
		return
	}
	l.Day = day
	l.Capital = equity
	l.Realized = 0
	l.Halted = false
}

// Add 计入一笔已实现盈亏。当日和累计一起加。返回值表示这次记账之后是否处于停机。
func (l *Ledger) Add(pnl, dailyLossPct float64) bool {
	if math.IsNaN(pnl) || math.IsInf(pnl, 0) {
		return l.Halted
	}
	l.Realized += pnl
	l.Cumulative += pnl
	if DailyHaltBreached(l.Capital, l.Realized, dailyLossPct) {
		l.Halted = true
	}
	return l.Halted
}

// RealizedPnL 按方向计算平仓盈亏（报价货币）。
func RealizedPnL(side Side, entry, exit, qty float64) float64 {
	if !finitePositive(entry) || !finitePositive(exit) || !finitePositive(qty) {
		return 0
	}
	if side == SideShort {
		return (entry - exit) * qty
	}
	return (exit - entry) * qty
}

// finitePositive 要求有限正数。NaN / ±Inf / ≤0 一律拒绝，避免熔断器 fail-open。
func finitePositive(x float64) bool {
	return x > 0 && !math.IsInf(x, 0)
}
