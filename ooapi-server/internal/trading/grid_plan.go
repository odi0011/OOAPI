package trading

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

/*
现货网格的计划计算。

网格和趋势是**两套东西**，共用不了状态机：趋势是「一个仓位、一次开平」，
网格是「N 张同时挂着的限价单 + 一份底仓」。所以网格从这一层起就是独立的。

这一层只做数学：不碰网络、不碰数据库、不读时钟。理由很直接 ——
计划算错是这个模块里代价最大的一类错误（把真金白银铺在错误的价位上，
或者算出根本挂不出去的格子），所以它必须能被纯粹的单元测试穷尽覆盖。

几何网格（等比例）而不是等差网格：
	等差网格每两线的百分比间距不一样 —— 底部宽、顶部窄。同样每格赚
	1 美元，底部那格要涨 1.2%、顶部那格只要涨 0.6%，而手续费是按
	比例收的，于是底部那些格子可能连手续费都盖不住。几何网格的
	**每格百分比间距是常数**，每格赚的钱一样多，手续费占比也一样。
*/

// 网格计划的边界。取值不是为了好看，每一条都对应一类真实的坏计划。
const (
	// GridMinLevels 是网格线的最少条数。3 条 = 2 个区间 —— 再少就不叫网格了，
	// 那是「挂两张单」。
	GridMinLevels = 3
	// GridMaxLevels 是上限。币安对单个交易对的挂单数有上限（现货 200 单），
	// 而且每多一条线就多一次请求；200 条以上没有实际意义。
	GridMaxLevels = 200

	// GridMinSpacingPct 是相邻两线的最小百分比间距（0.1%）。
	GridMinSpacingPct = 0.001
	// GridMaxSpacingPct 是最大间距（20%）。间距比这还大就不是网格了，
	// 那是「在不同价位各买一笔」。
	GridMaxSpacingPct = 0.20

	// GridFeeEdgePct 是每格往返必须留下的、扣掉手续费之后的净边际（0.05%）。
	// 低于它，网格就算一直成交也赚不到钱 —— 白忙。
	GridFeeEdgePct = 0.0005

	// GridDefaultStopPct 是默认止损：跌破下沿之后再跌 2% 就清仓停机。
	GridDefaultStopPct = 0.02
	// GridMaxStopPct 是止损距离上限，50%。再远就不叫止损了。
	GridMaxStopPct = 0.50

	// GridDefaultSlippagePct 是止损市价卖出时假定的滑点。
	// 算「最少需要多少钱」时要把它算进去，否则会在最坏的时候差一点点。
	GridDefaultSlippagePct = 0.0005

	/*
		SpotDefaultFeeRate 是币安现货基础档的单边费率（0.1%）。

		**它不是 TakerFeeRate。** 那个常量 0.0005 是 USDT-M 合约的 taker 费，
		而网格跑在现货上 —— 拿合约的费率去估现货的成本，会让每格的净收益
		多算 0.1 个百分点，足以把一份亏钱的网格算成赚钱的。
		真实费率由接口层从 /api/v3/account 读出来，这个只是读不到时的兜底。
	*/
	SpotDefaultFeeRate = 0.001
)

// 网格不能开起来的原因。写成常量是为了前端能按原因分支展示，而不是去比对文案。
const (
	ReasonGridSpacingTooTight = "grid_spacing_too_tight"
	ReasonGridBudgetTooSmall  = "grid_budget_too_small"
	ReasonGridRangeInvalid    = "grid_range_invalid"
	ReasonGridPriceOutOfRange = "grid_price_out_of_range"
	ReasonGridBelowStop       = "grid_below_stop"
	ReasonGridAboveUpper      = "grid_above_upper"
	ReasonGridNotRunning      = "grid_not_running"
	ReasonGridOrderFailed     = "grid_order_failed"
	ReasonGridExchangeFlat    = "grid_exchange_flat"
	// ReasonGridStepTooCoarse 表示价格精度的零头吃掉了每格的全部收益。
	ReasonGridStepTooCoarse = "grid_step_too_coarse"
)

// GridMaxDustShare 是步长零头允许占掉的收益比例（一成）。
// 超过它，说明每格还不够大 —— 交易所的最小名义不再是真正的门槛。
const GridMaxDustShare = 0.10

/*
GridLevel 是一条网格线。

买和卖是**同一条线**的两面：在 p_i 买入，就在 p_{i+1} 卖出。
不是「p_i 既挂买又挂卖」—— 那样两边会互相打架（同一格刚买进就被自己的
卖单卖掉，赚不到任何价差，还白付两次手续费）。

Sell 只在 i 不是最后一条线时有意义；最后一条线的 Sell 为 0
（没有更高的线可以卖，所以那条线上不会挂卖单）。
*/
type GridLevel struct {
	Index int     `json:"index"`
	Buy   float64 `json:"buy"`
	Sell  float64 `json:"sell"`
}

/*
GridPlan 是一份已经算好的、可以直接照着挂单的网格。

QuoteNeeded 是**最坏情况下**需要的计价币：所有网格线上都持有一格。
这个数是网格的资金上限 —— 引擎拿它跟账户余额比，不够就不该开。
（实际占用通常低于它：价格在上沿时只有下沿那些格子持有现货。）
*/
type GridPlan struct {
	Symbol      string      `json:"symbol"`
	Lower       float64     `json:"lower"`
	Upper       float64     `json:"upper"`
	Levels      int         `json:"levels"`
	SpacingPct  float64     `json:"spacingPct"`
	QtyPerLevel float64     `json:"qtyPerLevel"`
	Lines       []GridLevel `json:"lines"`
	// QuoteNeeded 是全部网格线都持有现货时要花掉的计价币（含手续费与滑点）。
	QuoteNeeded float64 `json:"quoteNeeded"`
	// NotionalPerLevel 是最低那一格的每格名义价值 —— 也就是「每格多少钱」。
	NotionalPerLevel float64 `json:"notionalPerLevel"`
	// NetProfitPct 是每格往返扣掉双边手续费后的净收益比例。
	NetProfitPct float64 `json:"netProfitPct"`
	// NetProfitPerLevel 是每格往返的净收益（计价币）。一格成交一次就是这个数。
	NetProfitPerLevel float64 `json:"netProfitPerLevel"`
	// WorstLossUSDT 是止损被打掉时的最坏亏损（计价币）。
	// 它和 QuoteNeeded 是两个不同的数：QuoteNeeded 是"要占多少钱"，
	// WorstLossUSDT 是"最坏会亏多少"。
	WorstLossUSDT float64 `json:"worstLossUsdt"`
	StopPrice     float64 `json:"stopPrice"`
	/*
		StepDustPct 是**步长零头**吃掉的比例，每完成一次往返吃一次。

		这一项最容易被忽略，而它经常比手续费还大。成因：

		  · 币安现货的数量必须是 stepSize 的整数倍；
		  · 买入的手续费以**基础币**收取，所以到账量不是整数倍
		    （DOGE 步长 1，买 14 个到手 13.986 个）；
		  · 卖单只能挂 13 个，剩下 0.986 个卖不出去，沉在账户里。

		算成比例：dust ≈ stepSize × 价格 / 每格名义。DOGE 步长 1、价 0.08，
		每格名义 1.05 USDT 时，这一项高达 **7.6%** —— 是双边手续费
		（0.2%）的 38 倍。一份"每格赚 2.5%"的网格，实际每格只剩负数。

		所以这个数必须算出来、必须显示：它才是"账户最低要多少钱"背后的
		真正约束 —— 不是能不能挂满格子，是**每格必须足够大**，
		大到那一个步长的零头可以忽略。
	*/
	StepDustPct float64 `json:"stepDustPct"`
	// EffectiveNetPct 是扣掉双边手续费**和**步长零头之后，每格往返
	// 真正落到口袋里的比例。它才是"这个网格赚不赚钱"的答案。
	EffectiveNetPct float64 `json:"effectiveNetPct"`
	// EffectiveNetPerLevel 是每格往返的真实净收益（计价币）。
	EffectiveNetPerLevel float64 `json:"effectiveNetPerLevel"`
	// DustQtyPerLevel 是每次往返预计被卡住的数量（最坏一个步长）。
	DustQtyPerLevel float64 `json:"dustQtyPerLevel"`
	// MinNotionalForDust 是「让零头不超过收益的一成」所需的每格名义价值。
	// 它经常比交易所的最小名义大得多 —— 账户门槛取两者之中大的那个。
	MinNotionalForDust float64 `json:"minNotionalForDust"`
	// LastPrice 是建网时的参考价，用来判断哪些线在该价之下（只有这些线会先挂买单）。
	LastPrice float64 `json:"lastPrice"`
	// InitialBuys 是建网那一刻会立刻挂出去的买单条数（价格低于参考价的那几条线）。
	InitialBuys int `json:"initialBuys"`
}

// GridInput 是算一份网格计划需要知道的一切。全部是纯输入。
type GridInput struct {
	Symbol string
	Lower  float64
	Upper  float64
	Levels int
	// QuoteBudget 是最多愿意投进去的计价币。计划的资金需求超过它时会报错，
	// 并给出「最少需要多少」。
	QuoteBudget float64
	// LastPrice 是建网时的参考价。0 表示不做「哪些线先挂买单」的判断。
	LastPrice float64
	// FeeRate 是单边手续费率（0.001 = 0.1%）。买卖各收一次。
	FeeRate float64
	// SlippagePct 是止损市价卖出的滑点假设。
	SlippagePct float64

	MinNotional float64
	StepSize    float64
	MinQty      float64
	TickSize    float64

	// StopPct 是跌破下沿之后继续下跌多少就清仓。0 用 GridDefaultStopPct。
	StopPct float64
}

// GridLines 算出几何网格的全部网格线价格，从低到高。
//
// 比率是 (Upper/Lower)^(1/(Levels-1))：Levels 条线把区间切成 Levels-1 段，
// 每段的**比例**相同。之所以严格取整到 TickSize，是因为挂单价格带小数尾巴
// 会被币安以 -1111（精度超限）拒掉，而那种错误在几百条线里很难定位。
func GridLines(lower, upper float64, levels int, tickSize float64) ([]float64, float64, error) {
	if !finitePositive(lower) || !finitePositive(upper) {
		return nil, 0, invalid("网格上下沿必须是正数")
	}
	if lower >= upper {
		return nil, 0, invalid("网格下沿必须小于上沿")
	}
	if levels < GridMinLevels || levels > GridMaxLevels {
		return nil, 0, invalid(fmt.Sprintf("网格线要在 %d 到 %d 条之间", GridMinLevels, GridMaxLevels))
	}
	ratio := math.Pow(upper/lower, 1/float64(levels-1))
	if !finitePositive(ratio) || ratio <= 1 {
		return nil, 0, invalid("网格上下沿算不出有效的间距")
	}
	lines := make([]float64, levels)
	for i := 0; i < levels; i++ {
		price := lower * math.Pow(ratio, float64(i))
		if i == levels-1 {
			// 末线直接用 upper，避免浮点误差让它差一点（例如 0.08499999999999）。
			price = upper
		}
		price = alignPriceDown(price, tickSize)
		if !finitePositive(price) {
			return nil, 0, invalid("网格线价格算出来不是正数")
		}
		lines[i] = price
	}
	/*
		取整之后相邻两条线可能变成同一个价（tickSize 相对区间太粗）。
		那样这两条线之间没有价差，成交一次白付手续费 —— 必须拦下，
		而且要说清是"区间太窄"，不是笼统的"参数不对"。
	*/
	for i := 1; i < len(lines); i++ {
		if lines[i] <= lines[i-1] {
			return nil, 0, invalid(fmt.Sprintf(
				"区间太窄：价格精度是 %g，而 %d 条网格线里出现了重复价位。请放宽区间或减少网格线",
				tickSize, levels))
		}
	}
	return lines, ratio, nil
}

// GridSpacing 返回相邻两线的最小百分比间距。
//
// 取**最小**而不是平均：几何网格取整之后每段会有微小差异，
// 而「能不能盖住手续费」取决于最窄的那一段 —— 用平均值会把一段不够宽的
// 网格判成合格。
func GridSpacing(lines []float64) float64 {
	if len(lines) < 2 {
		return 0
	}
	worst := math.Inf(1)
	for i := 1; i < len(lines); i++ {
		if lines[i-1] <= 0 {
			continue
		}
		step := lines[i]/lines[i-1] - 1
		if step < worst {
			worst = step
		}
	}
	if math.IsInf(worst, 0) {
		return 0
	}
	return worst
}

/*
MinGridSpacing 是网格间距的下限：双边手续费 + 一点净边际。

手续费是按**比例**收的，所以间距也是按比例比。往返两次手续费是 2×fee，
再留 GridFeeEdgePct 的净赚头 —— 否则网格一直成交也只是给交易所打工。
*/
func MinGridSpacing(feeRate float64) float64 {
	if !(feeRate > 0) {
		feeRate = SpotDefaultFeeRate
	}
	min := 2*feeRate + GridFeeEdgePct
	if min < GridMinSpacingPct {
		min = GridMinSpacingPct
	}
	return min
}

/*
BuildGridPlan 算出一份可以直接执行的网格。

这里做的事，顺序不能换：

 1. 算网格线（几何、对齐 tickSize）；
 2. 检查**最窄的那一段**能不能盖住手续费 —— 盖不住的话后面算多少钱都没意义；
 3. 按预算反推每格数量；
 4. 检查每格名义价值过不过交易所下限（看最低那一格，它最吃亏）；
 5. 反算「最少需要多少预算」，并跟用户给的比。

第 5 步是刻意保留的：资金不够时**必须告诉用户差多少**，
只说一句"资金不足"，用户只能靠猜把数字调来调去。
*/
func BuildGridPlan(in GridInput) (GridPlan, error) {
	var plan GridPlan
	in.Symbol = strings.ToUpper(strings.TrimSpace(in.Symbol))
	if in.Symbol == "" {
		return plan, invalid("缺少交易对")
	}
	if !AllowedSymbol(in.Symbol) {
		return plan, invalid("网格只支持 USDT 现货交易对，例如 DOGEUSDT")
	}
	fee := gridFeeRate(in.FeeRate)
	stopPct := in.StopPct
	if !(stopPct > 0) || math.IsInf(stopPct, 0) {
		stopPct = GridDefaultStopPct
	}
	if stopPct > GridMaxStopPct {
		return plan, invalid(fmt.Sprintf("止损离下沿不能超过 %g%%", GridMaxStopPct*100))
	}
	slip := in.SlippagePct
	if !(slip >= 0) {
		slip = GridDefaultSlippagePct
	}

	lines, _, err := GridLines(in.Lower, in.Upper, in.Levels, in.TickSize)
	if err != nil {
		return plan, err
	}
	spacing := GridSpacing(lines)
	minSpacing := MinGridSpacing(fee)
	if spacing < minSpacing {
		return plan, withReason(invalid(fmt.Sprintf(
			"网格太密：每格间距 %.3f%%，而往返手续费要 %.3f%%，至少要 %.3f%% 才有得赚。请把区间放宽或把网格线减少",
			spacing*100, 2*fee*100, minSpacing*100)), ReasonGridSpacingTooTight)
	}
	if spacing > GridMaxSpacingPct {
		return plan, invalid(fmt.Sprintf("每格间距 %.2f%% 太大，网格线之间形同孤立，请收窄区间或增加网格线", spacing*100))
	}

	sum := 0.0
	for _, p := range lines {
		sum += p
	}
	if !finitePositive(sum) {
		return plan, invalid("网格线价格之和不是正数")
	}

	minNotional := in.MinNotional
	if !(minNotional > 0) {
		minNotional = MinNotionalUSDT
	}
	/*
		每格数量的下限来自**最低那一格**：价格越低，同样的钱买到的数量越少，
		也就是名义价值最小、最容易触线。用最低那一格来卡，全网格都不会不够。
	*/
	qtyFloor := minNotional / lines[0]
	qty := qtyFloor
	if in.QuoteBudget > 0 {
		qty = in.QuoteBudget / sum
	}
	qty = AlignQuantity(qty, in.StepSize, in.MinQty)
	if qty <= 0 {
		need := qtyFloor * sum
		return plan, withReason(invalid(fmt.Sprintf(
			"资金不够：这个区间最少需要 %.2f USDT（%d 条网格线 × 每格 %.2f USDT），当前 %.2f USDT",
			need, len(lines), minNotional, in.QuoteBudget)), ReasonGridBudgetTooSmall)
	}
	// 兜底：即使 qty 大于 0，也要确认**最低那一格**的名义价值真的过线。
	// 步长取整可能把它压到线下面去（例如每格 13.9 个 DOGE，步长 1 → 13 个）。
	if qty*lines[0] < minNotional {
		needQty := AlignQuantityCeil(qtyFloor, in.StepSize)
		return plan, withReason(invalid(fmt.Sprintf(
			"资金不够：每格至少要 %.8g（最低那一格名义 %.2f USDT）才过交易所下限，这个区间最坏要占用 %.2f USDT，当前给了 %.2f USDT",
			needQty, minNotional, needQty*sum, in.QuoteBudget)), ReasonGridBudgetTooSmall)
	}

	// 预算上限：最坏情况（每条网格线上都持有一格）不能超过用户给的钱。
	if in.QuoteBudget > 0 && qty*sum > in.QuoteBudget+1e-9 {
		return plan, withReason(invalid(fmt.Sprintf(
			"资金不够：这份网格最坏要占用 %.2f USDT，当前给了 %.2f USDT",
			qty*sum, in.QuoteBudget)), ReasonGridBudgetTooSmall)
	}

	levels := make([]GridLevel, len(lines))
	for i, p := range lines {
		level := GridLevel{Index: i, Buy: p}
		if i+1 < len(lines) {
			level.Sell = lines[i+1]
		}
		levels[i] = level
	}

	/*
		每格的净收益按**买价买入、下一条线的卖价卖出**算，扣掉两次手续费。

		毛收益取的是 spacing（所有相邻段里**最窄**的那一段），不是
		lines[1]/lines[0]。取整会让每段间距有微小差异，报最好看的那一段
		等于把一个只会在幸运段落里成立的数字印在界面上；报最窄的那一段，
		用户看到的就是"最差情况下每格赚多少"，而每格实际赚的只会更多。

		卖的是限价单（maker），但这里一律按 taker 费率算 —— 保守。
		币安现货的 maker 费通常便宜一半，但那省下的是运气，不该写进计划里。
	*/
	netPct := spacing - 2*fee
	notional := qty * lines[0]
	netPerLevel := netPct * notional

	/*
		最坏情况下这套网格会亏多少。

		不是"上沿到止损"那一段 —— 价格从下沿跌到止损时，手里持有的是
		**全部**网格线的现货（最坏时刻），所以在止损价上卖出时，成本按
		所有网格线的均价算。这个数是用户真正在承担的风险敞口，
		资金需求（QuoteNeeded）说的是另一回事，两个都要露出来。
	*/
	stopPrice := lines[0] * (1 - stopPct)
	avgCost := sum / float64(len(lines))
	worstLoss := 0.0
	if finitePositive(avgCost) {
		exit := stopPrice * (1 - slip)
		worstLoss = (avgCost - exit) / avgCost * qty * sum
		if worstLoss < 0 {
			worstLoss = 0
		}
	}

	/*
		步长零头：每完成一次往返，最多有一个 stepSize 的量卖不出去。

		最坏情况按**整整一个步长**算，不是半个 —— 买入到账量不是步长的
		整数倍时，向下取整最多丢掉不到一个步长，而估风险就该按最大估。
		（DOGE 步长 1、每格 13.986 个 → 只能挂 13 个 → 丢掉 0.986 个。）
	*/
	dustQty := in.StepSize
	if !(dustQty > 0) {
		dustQty = 0
	}
	dustPerLevel := dustQty * lines[0]
	dustPct := 0.0
	if notional > 0 {
		dustPct = dustPerLevel / notional
	}
	effectivePct := netPct - dustPct
	effectivePerLevel := effectivePct * notional

	/*
		零头吃掉全部收益就直接拒绝。

		必须报出来而不是让它跑：一份每格"净赚 0"的网格会不停地成交、
		不停地产生手续费，界面上看是"一直在工作"，实际在一格一格地亏。
		文案要说清是**哪一项**吃掉的 —— 否则用户只会去调区间和条数，
		而那两个都不是原因。
	*/
	if dustPct > 0 && effectivePct <= 0 {
		needNotional := dustPerLevel
		if netPct > 0 {
			needNotional = dustPerLevel / netPct
		}
		needQty := AlignQuantityCeil(needNotional/lines[0], in.StepSize)
		return plan, withReason(invalid(fmt.Sprintf(
			"每格太小：价格精度是 %g 的一个零头就要 %.3f%%（每格赚 %.3f%%）。"+
				"每格名义至少要 %.2f USDT、整份网格约 %.2f USDT 才划得来（当前每格 %.2f USDT）",
			in.StepSize, dustPct*100, netPct*100, needNotional, needQty*sum, notional)),
			ReasonGridStepTooCoarse)
	}

	// 让零头不超过收益的一成 —— 过了这条线，约束就不再是交易所的最小名义，
	// 而是"每格必须足够大"。
	minNotionalForDust := 0.0
	if netPct > 0 {
		minNotionalForDust = dustPerLevel / (netPct * GridMaxDustShare)
	}

	initialBuys := len(lines)
	if in.LastPrice > 0 {
		initialBuys = 0
		for _, p := range lines {
			if p < in.LastPrice {
				initialBuys++
			}
		}
	}

	plan = GridPlan{
		Symbol:               in.Symbol,
		Lower:                lines[0],
		Upper:                lines[len(lines)-1],
		Levels:               len(lines),
		SpacingPct:           spacing,
		QtyPerLevel:          qty,
		Lines:                levels,
		QuoteNeeded:          qty * sum,
		NotionalPerLevel:     notional,
		NetProfitPct:         netPct,
		NetProfitPerLevel:    netPerLevel,
		StepDustPct:          dustPct,
		EffectiveNetPct:      effectivePct,
		EffectiveNetPerLevel: effectivePerLevel,
		DustQtyPerLevel:      dustQty,
		MinNotionalForDust:   minNotionalForDust,
		WorstLossUSDT:        worstLoss,
		StopPrice:            stopPrice,
		LastPrice:            in.LastPrice,
		InitialBuys:          initialBuys,
	}
	return plan, nil
}

// alignPriceDown 把价格向下取整到 tickSize 的整数倍。
//
// 向下而不是四舍五入（同包里已有的 roundToTick 是四舍五入）：取整之后
// 网格线只会更保守 —— 买得更低、卖得更低 —— 不会因为取整把某条线抬到区间外面去。
//
// 最后按 tick 的小数位截断，是因为浮点乘法会带出尾数（0.1 × 7 = 0.7000000000000001），
// 而挂单价格是按字符串发给币安的，那串尾数会被判成精度超限（-1111）。
func alignPriceDown(price, tick float64) float64 {
	if !(tick > 0) || math.IsInf(tick, 0) {
		return price
	}
	out := math.Floor(price/tick+1e-9) * tick
	raw := strconv.FormatFloat(tick, 'f', -1, 64)
	digits := decimalPlaces(raw)
	if digits <= 0 {
		return math.Floor(out + 1e-9)
	}
	if digits > 12 {
		digits = 12
	}
	scale := math.Pow(10, float64(digits))
	return math.Floor(out*scale+1e-9) / scale
}

// AlignQuantityCeil 按步长**向上**取整。只在报错文案里用：
// 告诉用户"最少要买这么多"，宁可多说一点也不要让他差一个步长又被打回来。
func AlignQuantityCeil(qty, step float64) float64 {
	if !finitePositive(qty) {
		return 0
	}
	if !(step > 0) || math.IsInf(step, 0) {
		return qty
	}
	return math.Ceil(qty/step-1e-9) * step
}

// GridStopPrice 按止损比例算清仓价。stopPct <= 0 时用默认值。
func GridStopPrice(lower, stopPct float64) float64 {
	if !finitePositive(lower) {
		return 0
	}
	if !(stopPct > 0) || math.IsInf(stopPct, 0) {
		stopPct = GridDefaultStopPct
	}
	if stopPct > GridMaxStopPct {
		stopPct = GridMaxStopPct
	}
	return lower * (1 - stopPct)
}

// GridRangeInfo 是给前端做「这个区间合不合理」提示用的摘要。
type GridRangeInfo struct {
	Levels       int     `json:"levels"`
	SpacingPct   float64 `json:"spacingPct"`
	MinSpacingPct float64 `json:"minSpacingPct"`
	OK           bool    `json:"ok"`
	Reason       string  `json:"reason,omitempty"`
	Message      string  `json:"message,omitempty"`
}

// InspectGridRange 只判断区间和网格数合不合理，不涉及资金。
// 前端在用户调滑块时调它，能立刻看到"太密了"而不是等到保存才被拒。
func InspectGridRange(lower, upper float64, levels int, tickSize, feeRate float64) GridRangeInfo {
	info := GridRangeInfo{Levels: levels, MinSpacingPct: MinGridSpacing(feeRate)}
	lines, _, err := GridLines(lower, upper, levels, tickSize)
	if err != nil {
		info.Reason = ReasonGridRangeInvalid
		info.Message = err.Error()
		return info
	}
	info.SpacingPct = GridSpacing(lines)
	if info.SpacingPct < info.MinSpacingPct {
		info.Reason = ReasonGridSpacingTooTight
		info.Message = fmt.Sprintf("每格 %.3f%%，往返手续费就要 %.3f%%，至少要 %.3f%%",
			info.SpacingPct*100, 2*defaultFeeRateFor(feeRate)*100, info.MinSpacingPct*100)
		return info
	}
	if info.SpacingPct > GridMaxSpacingPct {
		info.Reason = ReasonGridRangeInvalid
		info.Message = fmt.Sprintf("每格 %.2f%% 太宽，建议收窄区间或增加网格线", info.SpacingPct*100)
		return info
	}
	info.OK = true
	return info
}

func defaultFeeRateFor(fee float64) float64 { return gridFeeRate(fee) }

// GridLevelsForSpacing 反推：想让每格至少有 spacing 的间距，这个区间最多能放多少条线。
//
// 用户最常见的诉求是"我想让每格赚 X%"，而界面上填的是网格线数量。
// 与其让他一次次试，不如直接算出上限。
//
// 解析解 + 验证收紧两步，缺一不可：
//
//	解析解：区间切成 intervals 段时每段比例是 exp(span/intervals)，
//	        要它 ≥ 1+spacing 就得 intervals ≤ span/step。
//	验证：  网格线还要对齐 tickSize，而**向下取整每条线最多丢掉一个 tick**。
//	        ln 算出来的理想间距扣掉这点损耗，就可能刚好差一点点
//	        （26 条线算出来 0.493%，比要求的 0.5% 低）—— 于是逐条收紧，
//	        直到用真实的 GridSpacing 量出来达标为止。
//
// 只信解析解而跳过验证，会让这个函数给出一个"差一丝"的答案，
// 而它唯一的用途就是别让用户差那一丝。
func GridLevelsForSpacing(lower, upper, spacing, tickSize float64) int {
	if !finitePositive(lower) || !finitePositive(upper) || upper <= lower || !finitePositive(spacing) {
		return 0
	}
	span := math.Log(upper / lower)
	step := math.Log(1 + spacing)
	if step <= 0 {
		return 0
	}
	intervals := int(math.Floor(span / step))
	if intervals < 1 {
		intervals = 1
	}
	levels := intervals + 1
	if levels > GridMaxLevels {
		levels = GridMaxLevels
	}
	for levels > GridMinLevels {
		lines, _, err := GridLines(lower, upper, levels, tickSize)
		if err == nil && GridSpacing(lines)+1e-12 >= spacing {
			break
		}
		levels--
	}
	if levels < GridMinLevels {
		levels = GridMinLevels
	}
	return levels
}


/*
GridRequirement 是一条网格的**资金门槛**，两个档位。

	MinBudget          刚刚能跑：每格刚好压过交易所最小名义和步长零头
	                   两者之中更大的那一个。过线之后每格的净收益可能
	                   只剩千分之几 —— 能跑，但基本是在给交易所打工。
	ComfortableBudget  零头不超过收益的一成。这才是"跑得舒服"的规模。

两个数都要给。只报 MinBudget，用户会按那个数充钱，然后发现收益薄得
看不见；只报 ComfortableBudget，用户会以为这东西门槛高得离谱。
中间那条线是他自己该做的选择，但**两边都得先摆在桌上**。

即使这份计划本身不合法（区间太密、条数太多）也能算 —— 只要网格线
画得出来。这正是它的用途：用户调滑块的时候，界面要实时显示
"这个区间最少要多少钱"，而不是等他点保存才被拒。
*/
type GridRequirement struct {
	MinBudget           float64 `json:"minBudget"`
	ComfortableBudget   float64 `json:"comfortableBudget"`
	PerLevelNotionalMin float64 `json:"perLevelNotionalMin"`
	PerLevelNotionalOK  float64 `json:"perLevelNotionalOk"`
	Levels              int     `json:"levels"`
	SpacingPct          float64 `json:"spacingPct"`
	NetPct              float64 `json:"netPct"`
	// LimitedBy 说明门槛是被哪一项顶起来的：notional（交易所最小名义）
	// 还是 dust（步长零头）。两者的解法完全不同 —— 前者换交易对没用，
	// 后者换一个步长更细的交易对立刻就好了。
	LimitedBy  string  `json:"limitedBy"`
	DustPctAtMin float64 `json:"dustPctAtMin"`
	EffectivePctAtMin float64 `json:"effectivePctAtMin"`
}

// 门槛由哪一项决定。
const (
	GridLimitedByNotional = "notional"
	GridLimitedByDust     = "dust"
)

// GridRequirementFor 算出一份网格的资金门槛。
func GridRequirementFor(in GridInput) (GridRequirement, error) {
	var out GridRequirement
	lines, _, err := GridLines(in.Lower, in.Upper, in.Levels, in.TickSize)
	if err != nil {
		return out, err
	}
	sum := 0.0
	for _, p := range lines {
		sum += p
	}
	fee := gridFeeRate(in.FeeRate)
	netPct := GridSpacing(lines) - 2*fee
	if netPct <= 0 {
		return out, withReason(invalid(fmt.Sprintf(
			"每格间距 %.3f%% 盖不住双边手续费 %.3f%%，这样的网格成交越多亏越多",
			GridSpacing(lines)*100, 2*fee*100)), ReasonGridSpacingTooTight)
	}
	minNotional := in.MinNotional
	if !(minNotional > 0) {
		minNotional = MinNotionalUSDT
	}
	step := in.StepSize
	if !(step > 0) {
		step = 0
	}

	// 交易所最小名义对应的每格数量。
	qtyByNotional := minNotional / lines[0]
	// 步长零头不能超过每格收益 —— 过线即"每格亏"。
	qtyByDust := 0.0
	if step > 0 {
		qtyByDust = (step * lines[0] / netPct) / lines[0]
	}
	limitedBy := GridLimitedByNotional
	qtyMin := qtyByNotional
	if qtyByDust > qtyByNotional {
		limitedBy = GridLimitedByDust
		qtyMin = qtyByDust
	}
	qtyMin = AlignQuantityCeil(qtyMin, step)
	if qtyMin <= 0 {
		return out, invalid("算不出每格数量")
	}
	perLevelMin := qtyMin * lines[0]

	// 舒服档：零头不超过收益的一成。
	qtyOK := qtyMin
	if step > 0 {
		need := (step * lines[0] / (netPct * GridMaxDustShare)) / lines[0]
		if need > qtyByNotional {
			qtyOK = AlignQuantityCeil(need, step)
		}
	}
	if qtyOK < qtyMin {
		qtyOK = qtyMin
	}
	perLevelOK := qtyOK * lines[0]

	out = GridRequirement{
		MinBudget:           qtyMin * sum,
		ComfortableBudget:   qtyOK * sum,
		PerLevelNotionalMin: perLevelMin,
		PerLevelNotionalOK:  perLevelOK,
		Levels:              len(lines),
		SpacingPct:          GridSpacing(lines),
		NetPct:              netPct,
		LimitedBy:           limitedBy,
	}
	if perLevelMin > 0 && step > 0 {
		out.DustPctAtMin = step * lines[0] / perLevelMin
	}
	out.EffectivePctAtMin = netPct - out.DustPctAtMin
	return out, nil
}
