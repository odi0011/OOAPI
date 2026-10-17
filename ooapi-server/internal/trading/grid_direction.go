package trading

import "strings"

/*
网格方向。

多头网格（long）跑在现货上，也可以跑在合约上；空头网格（short）
**必须**跑在 USDT-M 合约上 —— 现货没有做空，这是交易所的产品边界，
不是实现选择。

两个方向是严格镜像的：

	                多头                    空头
	开仓            BUY  @ 第 i 格          SELL @ 第 i 格
	平仓            SELL @ 第 i+1 格        BUY  @ 第 i-1 格
	第 i 格持有时    在 i+1 挂卖            在 i-1 挂买
	第 i 格为空且    价格 > 线 i 挂买        价格 < 线 i 挂卖
	永不挂单的边界    最上面那条线不买        最下面那条线不卖
	止损              下沿 × (1-stopPct)     上沿 × (1+stopPct)
	止盈              涨过上沿               跌破下沿

“永不挂单的边界”是对称的来源：多头网格最上面那条线买进来就没有更高的
线可以卖；空头网格最下面那条线卖出去就没有更低的线可以买回。
*/
type GridDirection string

const (
	GridLong  GridDirection = "long"
	GridShort GridDirection = "short"
)

// 网格跑在哪个市场上。
const (
	GridMarketSpot    = "spot"
	GridMarketFutures = "futures"
)

/*
FuturesDefaultGridFeeRate 是合约网格读不到真实费率时的兜底（0.02%）。

**与现货兜底值刻意不同。** 现货网格的兜底是 0.1%/边（SpotDefaultFeeRate），
而合约网格的每一张单都用 GTX（post-only）挂出去 —— 吃单会被交易所直接
拒掉，所以成交的一定是 maker。用合约的 taker 费（0.05%）当兜底会把每格
净收益少算 0.06 个百分点，一份本来有得赚的网格会被显示成亏的；反过来
用现货的 0.1% 会把它算成赚的。两个方向都是错的，只有 maker 费率对。
*/
const FuturesDefaultGridFeeRate = MakerFeeRate

// NormalizeDirection 补齐默认值。空值和拼错的值一律按多头处理 ——
// 多头是老的、已经在跑的路径，默认值必须保持向后兼容。
func NormalizeDirection(v GridDirection) GridDirection {
	switch GridDirection(strings.ToLower(strings.TrimSpace(string(v)))) {
	case GridShort:
		return GridShort
	default:
		return GridLong
	}
}

// NormalizeGridMarket 补齐市场。空值按现货处理（向后兼容）。
func NormalizeGridMarket(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case GridMarketFutures:
		return GridMarketFutures
	default:
		return GridMarketSpot
	}
}

// Short 报告是不是空头网格。
func (d GridDirection) Short() bool { return NormalizeDirection(d) == GridShort }

// OpenSide 是**建立持仓**的那一边。
func (d GridDirection) OpenSide() SpotSide {
	if d.Short() {
		return SpotSell
	}
	return SpotBuy
}

// CloseSide 是**了结持仓**的那一边。
func (d GridDirection) CloseSide() SpotSide { return d.OpenSide().Opposite() }

/*
ClosedLevel 返回一张平仓单成交后，它减的是哪一格的持仓。

多头：i 格的货在 i+1 格卖出 → 平仓单在第 L 格，减 L-1 格。
空头：i 格的空在 i-1 格买回 → 平仓单在第 L 格，减 L+1 格。

开仓单（多头 BUY / 空头 SELL）直接落在自己那一格，不需要这个换算。
*/
func (d GridDirection) ClosedLevel(orderLevel int) int {
	if d.Short() {
		return orderLevel + 1
	}
	return orderLevel - 1
}

// StopPriceFor 算止损价。多头在下沿之下，空头在上沿之上。
func StopPriceFor(direction GridDirection, lower, upper, stopPct float64) float64 {
	if direction.Short() {
		return upper * (1 + stopPct)
	}
	return lower * (1 - stopPct)
}

// TakeProfitPriceFor 算止盈边界。多头是上沿，空头是下沿。
func TakeProfitPriceFor(direction GridDirection, lower, upper float64) float64 {
	if direction.Short() {
		return lower
	}
	return upper
}

// GridFeeFallback 是读不到真实费率时的兜底值（现货 0.1%，合约 maker 0.02%）。
// 接口层要把同一个数写进配置，否则界面显示、计划计算、存库会用三个不同的数。
func GridFeeFallback(market string) float64 { return gridFeeRateFor(market, 0) }

// gridFeeRateFor 按市场取兜底费率。传入的 v 合法时原样返回。
func gridFeeRateFor(market string, v float64) float64 {
	if v > 0 && v <= 0.01 {
		return v
	}
	if NormalizeGridMarket(market) == GridMarketFutures {
		return FuturesDefaultGridFeeRate
	}
	return SpotDefaultFeeRate
}
