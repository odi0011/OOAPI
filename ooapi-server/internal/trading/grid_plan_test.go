package trading

import (
	"errors"
	"math"
	"strings"
	"testing"
)

/*
网格计划的测试。

这里的每个用例都在验证一件**会在真钱上体现出来的事**：间距够不够盖住
手续费、每格够不够大让步长零头可以忽略、资金能不能撑住最坏情况。

下面反复出现两个数字，先解释清楚，后面读起来才顺：

	MinNotional      交易所的最小名义价值（DOGE 1 USDT、XRP 5 USDT）
	每格实际下限     max(MinNotional, 步长零头要求的下限)

后者经常是前者的一到两个数量级，因为币安现货的数量必须是步长的整数倍，
而买入到账量不是（手续费以基础币扣），于是每完成一次往返就有不到一个步长
的货卖不出去。这一条才是"网格要多少钱"的真正答案。
*/

// gridInput 是基准输入：DOGE 现货，用的是 exchangeInfo 上的真实参数
//（步长 1、精度 0.00001、最小名义 1）。
func gridInput() GridInput {
	return GridInput{
		Symbol:      "DOGEUSDT",
		Lower:       0.075,
		Upper:       0.085,
		Levels:      6,
		QuoteBudget: 22, // 刚好过零头门槛，见 TestMinimumCapitalForDogeGrid
		LastPrice:   0.0800,
		FeeRate:     SpotDefaultFeeRate,
		MinNotional: 1,
		StepSize:    1,
		MinQty:      1,
		TickSize:    0.00001,
	}
}

/*
几何网格的每一格百分比间距必须**完全相等**。

这正是选几何而不是等差的原因：手续费按比例收，只有等比例间距才能让
每一格赚到一样多的钱。等差网格底部那几格的百分比间距更宽、顶部更窄，
顶部那些格子可能连手续费都盖不住 —— 而那种网格看起来完全正常。
*/
func TestGridLinesAreGeometricallyEven(t *testing.T) {
	lines, _, err := GridLines(100, 121, 5, 0.01)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 5 {
		t.Fatalf("应有 5 条线，得到 %d", len(lines))
	}
	if lines[0] != 100 {
		t.Fatalf("首线应等于下沿，得到 %v", lines[0])
	}
	if lines[len(lines)-1] != 121 {
		t.Fatalf("末线应等于上沿，得到 %v", lines[len(lines)-1])
	}
	// 5 条线 = 4 段，每段比例是 1.21 的四次方根（≈1.0488），不是 1.1。
	//
	// 容差放宽到相对万分之一：网格线要对齐 tickSize，向下取整会让每段
	// 差一丁点。这个量级的偏差远小于任何有意义的手续费或滑点，
	// 但断言不能假装它不存在。
	want := math.Pow(1.21, 0.25)
	for i := 1; i < len(lines); i++ {
		got := lines[i] / lines[i-1]
		if math.Abs(got-want)/want > 1e-4 {
			t.Fatalf("第 %d 段比例 %v，期望 %v（相对偏差 %.2e）", i, got, want, math.Abs(got-want)/want)
		}
	}
}

// 网格线必须对齐到价格精度。带尾数的价格会被币安以 -1111 拒掉，
// 而在几十条线里定位是哪一条超了精度非常费劲。
func TestGridLinesAlignToTickSize(t *testing.T) {
	lines, _, err := GridLines(0.075, 0.085, 6, 0.00001)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range lines {
		scaled := p / 0.00001
		if math.Abs(scaled-math.Round(scaled)) > 1e-6 {
			t.Fatalf("第 %d 条线 %v 没对齐到 0.00001", i, p)
		}
	}
}

// 价格精度相对区间太粗时，取整会把两条线压成同一个价 —— 那两线之间没有
// 价差，成交一次白付手续费。必须报错，而且理由要说"区间太窄"。
func TestGridLinesRejectDuplicatesFromCoarseTick(t *testing.T) {
	_, _, err := GridLines(100, 100.5, 10, 1)
	if err == nil {
		t.Fatal("区间过窄 + 粗精度必须被拒")
	}
	if !strings.Contains(err.Error(), "区间太窄") {
		t.Fatalf("理由应指出是区间太窄，得到: %v", err)
	}
}

/*
间距盖不住手续费时报错，且带上机器可读的原因。

这是整个网格里最容易被忽略、后果又最难受的一条：间距太密的网格
**看起来在不停地成交**，用户以为在赚钱，实际上每笔都在给交易所交手续费。
所以这条不能只是"返回个错误"，要能让前端按原因高亮。
*/
func TestBuildGridPlanRejectsSpacingBelowFees(t *testing.T) {
	in := gridInput()
	in.Lower, in.Upper, in.Levels = 1.0, 1.01, 20 // 每格约 0.05%，远低于 0.2% 的双边手续费
	_, err := BuildGridPlan(in)
	if err == nil {
		t.Fatal("间距低于手续费必须被拒")
	}
	var re *ReasonError
	if !errors.As(err, &re) || re.Reason != ReasonGridSpacingTooTight {
		t.Fatalf("原因应是 %s，得到 %v", ReasonGridSpacingTooTight, err)
	}
	// 文案里要有具体数字 —— 只说"太密"用户没法调。
	if !strings.Contains(err.Error(), "%") {
		t.Fatalf("文案应带具体百分比，得到: %v", err)
	}
}

/*
资金不够时必须报出**最少需要多少**。

只说一句"资金不足"，用户只能靠猜把数字调来调去，这是最差的报错。
*/
func TestBuildGridPlanReportsMinimumBudget(t *testing.T) {
	in := gridInput()
	in.QuoteBudget = 0.5
	_, err := BuildGridPlan(in)
	if err == nil {
		t.Fatal("资金不足必须被拒")
	}
	var re *ReasonError
	if !errors.As(err, &re) || re.Reason != ReasonGridBudgetTooSmall {
		t.Fatalf("原因应是 %s，得到 %v", ReasonGridBudgetTooSmall, err)
	}
	if !strings.Contains(err.Error(), "USDT") {
		t.Fatalf("文案应给出所需金额，得到: %v", err)
	}

	// 资金这道门和零头那道门是**两回事**，所以这里要明确跨过两道：
	// 先按零头门槛反推每格名义，再乘上条数。只过最小名义那道线是不够的
	//（那正是本用例前半段被拒的原因）。
	lines, _, lerr := GridLines(in.Lower, in.Upper, in.Levels, in.TickSize)
	if lerr != nil {
		t.Fatal(lerr)
	}
	sum := 0.0
	for _, p := range lines {
		sum += p
	}
	netPct := GridSpacing(lines) - 2*in.FeeRate
	needQty := AlignQuantityCeil((in.StepSize*lines[0]/netPct)/lines[0], in.StepSize)
	in.QuoteBudget = needQty * sum * 1.05
	if _, err := BuildGridPlan(in); err != nil {
		t.Fatalf("资金够的时候不该被拒: %v", err)
	}

	/*
		预算再压下去，被拒的理由会是"资金不够"或"每格太小"中的一个 ——
		哪一个是实现细节（取决于压到哪一档），所以这里只断言
		**两者都带具体金额**。文案措辞由
		TestBuildGridPlanRejectsStepDustEatingTheEdge 单独钉住。
	*/
	in.QuoteBudget = needQty * sum * 0.3
	_, err = BuildGridPlan(in)
	if err == nil {
		t.Fatal("预算低于零头门槛时必须被拒")
	}
	var re2 *ReasonError
	if !errors.As(err, &re2) ||
		(re2.Reason != ReasonGridBudgetTooSmall && re2.Reason != ReasonGridStepTooCoarse) {
		t.Fatalf("原因应是资金不够或每格太小，得到 %v", err)
	}
	if !strings.Contains(err.Error(), "USDT") {
		t.Fatalf("报错要带具体金额，得到: %v", err)
	}
}

/*
**步长零头**：每格必须足够大，否则一次往返被卡住的零头就吃光收益。

这是这份计划里最不直观、也最值钱的一条约束。成因链条：

	币安现货数量必须是 stepSize 的整数倍（DOGE 是 1）
	  → 买入手续费以 DOGE 收取，到账量不是整数倍（买 44 个到手 43.956 个）
	    → 卖单只能挂 43 个，剩下 0.956 个卖不出去

按比例算：0.956 × 0.075 / 每格名义。每格 1.05 USDT 时是 **6.8%**，
而每格毛赚只有 2.3% —— 一份"看起来每格赚 2.3%"的网格实际是**净亏**。

所以这个门槛必须硬拦，而且报错要说清是零头吃掉的，
不然用户只会去调区间和条数，而那两个都不是原因。
*/
func TestBuildGridPlanRejectsStepDustEatingTheEdge(t *testing.T) {
	in := gridInput()
	in.QuoteBudget = 7 // 每格 14 个 DOGE，名义 1.05 USDT
	_, err := BuildGridPlan(in)
	if err == nil {
		t.Fatal("零头吃光收益的网格必须被拒")
	}
	var re *ReasonError
	if !errors.As(err, &re) || re.Reason != ReasonGridStepTooCoarse {
		t.Fatalf("原因应是 %s，得到 %v", ReasonGridStepTooCoarse, err)
	}
	// 文案必须点名是"价格精度"，并给出每格至少要多大。
	if !strings.Contains(err.Error(), "精度") || !strings.Contains(err.Error(), "每格名义") {
		t.Fatalf("报错要说清是步长零头的问题，得到: %v", err)
	}
	if !strings.Contains(err.Error(), "USDT") {
		t.Fatalf("报错要给出每格所需的名义价值，得到: %v", err)
	}
}

// 每格数量的下限由**最低那一条线**决定，不是平均值。
// 价格越低，同样的钱买到的数量越少、名义价值越小 —— 最低那一格最先触线。
func TestQtyRespectsMinNotionalAtTheLowestLine(t *testing.T) {
	plan, err := BuildGridPlan(gridInput())
	if err != nil {
		t.Fatal(err)
	}
	for i, level := range plan.Lines {
		notional := plan.QtyPerLevel * level.Buy
		if notional+1e-9 < 1 {
			t.Fatalf("第 %d 条线（价 %v）名义只有 %.4f，低于交易所下限 1",
				i, level.Buy, notional)
		}
	}
}

// 每格的买卖价必须是**相邻两条线**：在 p_i 买、在 p_{i+1} 卖。
// 最后一条线没有更高的线可卖，卖价必须是 0（不挂卖单）。
func TestLevelsPairBuyWithNextLineSell(t *testing.T) {
	plan, err := BuildGridPlan(gridInput())
	if err != nil {
		t.Fatal(err)
	}
	for i, level := range plan.Lines {
		if level.Index != i {
			t.Fatalf("线号应就是下标，得到 %d", level.Index)
		}
		if i+1 < len(plan.Lines) {
			if level.Sell != plan.Lines[i+1].Buy {
				t.Fatalf("第 %d 线的卖价应等于下一条线的买价: %v vs %v",
					i, level.Sell, plan.Lines[i+1].Buy)
			}
		} else if level.Sell != 0 {
			t.Fatalf("最后一条线不该有卖价，得到 %v", level.Sell)
		}
	}
}

// 净收益必须是扣完双边手续费之后的数 —— 计划里的这个数会直接展示给用户，
// 把毛收益当净收益报出去就是在骗人。
func TestNetProfitIsAfterFees(t *testing.T) {
	in := gridInput()
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	want := plan.SpacingPct - 2*in.FeeRate
	if math.Abs(plan.NetProfitPct-want) > 1e-9 {
		t.Fatalf("净收益应是 %.6f（毛 %.6f 减双边手续费 %.6f），得到 %.6f",
			want, plan.SpacingPct, 2*in.FeeRate, plan.NetProfitPct)
	}
	if plan.NetProfitPct <= 0 {
		t.Fatalf("这份网格的净收益应为正，得到 %.6f", plan.NetProfitPct)
	}
}

/*
有效收益 = 手续费后收益 − 步长零头。

这是用户真正拿到手的那个数，必须比 NetProfitPct 更显眼：
NetProfitPct 看起来是 2.3%（还行），而有效收益在每格 3.3 USDT 时
只剩 0.05% —— 那才是真相。
*/
func TestEffectiveProfitSubtractsStepDust(t *testing.T) {
	in := gridInput()
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	wantDust := in.StepSize * plan.Lower / plan.NotionalPerLevel
	if math.Abs(plan.StepDustPct-wantDust) > 1e-12 {
		t.Fatalf("零头比例应是 一个步长×最低线价 / 每格名义 = %.6f，得到 %.6f",
			wantDust, plan.StepDustPct)
	}
	if math.Abs(plan.EffectiveNetPct-(plan.NetProfitPct-plan.StepDustPct)) > 1e-12 {
		t.Fatalf("有效收益应等于 净收益 − 零头")
	}
	if plan.EffectiveNetPct >= plan.NetProfitPct {
		t.Fatal("有效收益必须严格小于净收益 —— 零头是真实成本")
	}
	// 每格真实净收益 = 有效比例 × 每格名义。
	if math.Abs(plan.EffectiveNetPerLevel-plan.EffectiveNetPct*plan.NotionalPerLevel) > 1e-9 {
		t.Fatalf("每格有效收益与比例对不上")
	}
}

// 计划要告诉用户"每格得多大才让零头可以忽略" —— 那个数经常比
// 交易所的最小名义大一到两个数量级，是真正的资金门槛。
func TestMinNotionalForDustIsWellAboveExchangeFloor(t *testing.T) {
	in := gridInput()
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	if plan.MinNotionalForDust <= in.MinNotional {
		t.Fatalf("DOGE 步长 1，零头要求的每格名义（%.2f）必然远高于交易所下限（%.2f）",
			plan.MinNotionalForDust, in.MinNotional)
	}
	// 按这个名义算，零头应恰好占收益的一成。
	notional := plan.MinNotionalForDust
	dust := in.StepSize * plan.Lower / notional
	if math.Abs(dust-plan.NetProfitPct*GridMaxDustShare) > 1e-9 {
		t.Fatalf("零头应恰好占收益的 %.0f%%，算出来是 %.4f（收益 %.4f）",
			GridMaxDustShare*100, dust, plan.NetProfitPct)
	}
}

// 止损价在下沿之下，而且是按比例定的。
func TestStopPriceSitsBelowLower(t *testing.T) {
	in := gridInput()
	in.StopPct = 0.03
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	want := plan.Lower * 0.97
	if math.Abs(plan.StopPrice-want) > 1e-9 {
		t.Fatalf("止损价应是下沿的 97%%（%v），得到 %v", want, plan.StopPrice)
	}
	if plan.StopPrice >= plan.Lower {
		t.Fatal("止损必须在区间之外 —— 区间内的价格本来就是网格要接的")
	}
}

// 最坏亏损必须为正数，而且不能超过资金需求（亏损不可能比本金还大）。
func TestWorstLossIsPositiveAndWithinBudget(t *testing.T) {
	plan, err := BuildGridPlan(gridInput())
	if err != nil {
		t.Fatal(err)
	}
	if plan.WorstLossUSDT <= 0 {
		t.Fatalf("最坏亏损应为正，得到 %v", plan.WorstLossUSDT)
	}
	if plan.WorstLossUSDT >= plan.QuoteNeeded {
		t.Fatalf("最坏亏损 %.4f 不该达到资金需求 %.4f", plan.WorstLossUSDT, plan.QuoteNeeded)
	}
}

/*
建网时只有**低于当前价**的线才挂买单。

高于当前价的线如果也挂买单，会立刻以高于市价的限价成交 ——
等于一开局就自愿买贵。所以那些线要等价格自己涨上去、再由上一格的
卖单把它们引出来。
*/
func TestInitialBuysOnlyCoverLinesBelowPrice(t *testing.T) {
	in := gridInput()
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	want := 0
	for _, level := range plan.Lines {
		if level.Buy < in.LastPrice {
			want++
		}
	}
	if plan.InitialBuys != want {
		t.Fatalf("初始买单应是 %d 条，得到 %d", want, plan.InitialBuys)
	}
	if plan.InitialBuys == 0 || plan.InitialBuys == plan.Levels {
		t.Fatalf("参考价落在区间内时，初始买单应是部分而不是全部：%d/%d",
			plan.InitialBuys, plan.Levels)
	}
}

/*
参考价落在区间**外面**时的两种极端，计划层只如实算，不报错 ——
"这个区间能不能开"是引擎的判断。

 · 价格在**上沿之上**：所有线都在市价之下，全部挂买单；
 · 价格在**下沿之下**：所有线都在市价之上，**一张买单都不能挂** ——
   挂出去就是以高于市价的限价买入，等于开局自愿买贵。
*/
func TestInitialBuysAtBothPriceExtremes(t *testing.T) {
	above := gridInput()
	above.LastPrice = 0.09
	plan, err := BuildGridPlan(above)
	if err != nil {
		t.Fatal(err)
	}
	if plan.InitialBuys != plan.Levels {
		t.Fatalf("价格在上沿之上时所有线都该挂买单，得到 %d/%d", plan.InitialBuys, plan.Levels)
	}

	below := gridInput()
	below.LastPrice = 0.05
	plan, err = BuildGridPlan(below)
	if err != nil {
		t.Fatal(err)
	}
	if plan.InitialBuys != 0 {
		t.Fatalf("价格在下沿之下时一张买单都不该挂，得到 %d", plan.InitialBuys)
	}
}

// 数量要落到步长上。DOGE 的 LOT_SIZE 步长是 1，买 43.9 个是不合法的。
func TestQtyAlignsToStepSize(t *testing.T) {
	plan, err := BuildGridPlan(gridInput())
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(plan.QtyPerLevel-math.Round(plan.QtyPerLevel)) > 1e-9 {
		t.Fatalf("每格数量 %v 没落到步长 1 上", plan.QtyPerLevel)
	}
}

/*
网格线数的上限反推。

用户脑子里的诉求是"每格至少赚 0.5%"，界面上填的却是网格线数量。
与其让他一次次试，不如直接算出这个区间最多能放多少条 —— 下面同时验证
"按这个数算出来的间距确实不小于要求的间距"，以及"再多一条就不够"。
*/
func TestGridLevelsForSpacingRespectsTheFloor(t *testing.T) {
	levels := GridLevelsForSpacing(0.075, 0.085, 0.005, 0.00001)
	if levels < GridMinLevels {
		t.Fatalf("反推结果不该低于下限：%d", levels)
	}
	lines, _, err := GridLines(0.075, 0.085, levels, 0.00001)
	if err != nil {
		t.Fatal(err)
	}
	if got := GridSpacing(lines); got+1e-9 < 0.005 {
		t.Fatalf("按反推的 %d 条线算出来的间距是 %.5f，低于要求的 0.005", levels, got)
	}
	// 再多一条就应该不够了 —— 否则"最多多少条"这个说法就是假的。
	if lines, _, err := GridLines(0.075, 0.085, levels+1, 0.00001); err == nil {
		if got := GridSpacing(lines); got >= 0.005 {
			t.Fatalf("多一条线间距仍有 %.5f，说明反推的 %d 不是最大条数", got, levels)
		}
	}
}

// 只支持 USDT 现货对。传合约代码或垃圾串要立刻被拒，
// 而不是等挂单时才由交易所报一个看不懂的错。
func TestBuildGridPlanRejectsNonUsdtSymbols(t *testing.T) {
	for _, symbol := range []string{"", "DOGE", "DOGEBTC", "doge/usdt"} {
		in := gridInput()
		in.Symbol = symbol
		if _, err := BuildGridPlan(in); err == nil {
			t.Fatalf("%q 应被拒", symbol)
		}
	}
}

// 间距宽到没有意义的网格也要拦 —— 那不是网格，是"在不同价位各买一笔"。
func TestBuildGridPlanRejectsTooWideSpacing(t *testing.T) {
	in := gridInput()
	in.Lower, in.Upper = 1, 10 // 每格翻倍
	_, err := BuildGridPlan(in)
	if err == nil {
		t.Fatal("间距过宽必须被拒")
	}
	if !strings.Contains(err.Error(), "太大") {
		t.Fatalf("理由应指出间距过大，得到: %v", err)
	}
}

// 最小间距随手续费率变化：手续费越贵，格子必须越宽。
func TestMinGridSpacingGrowsWithFees(t *testing.T) {
	cheap := MinGridSpacing(0.0002) // VIP 档
	dear := MinGridSpacing(0.001)   // 普通 0.1%
	if !(dear > cheap) {
		t.Fatalf("手续费更贵时最小间距必须更大：%v vs %v", dear, cheap)
	}
	if MinGridSpacing(0) != MinGridSpacing(SpotDefaultFeeRate) {
		t.Fatalf("费率为 0 时应回退到**现货**默认费率 %v，而不是合约那个 %v",
			SpotDefaultFeeRate, TakerFeeRate)
	}
}

// InspectGridRange 是给前端即时提示用的，它必须和 BuildGridPlan 的判定一致 ——
// 两边不一致的话，界面会显示"没问题"而保存时被拒。
func TestInspectGridRangeAgreesWithBuild(t *testing.T) {
	in := gridInput()
	in.Lower, in.Upper, in.Levels = 1.0, 1.01, 20
	info := InspectGridRange(in.Lower, in.Upper, in.Levels, in.TickSize, in.FeeRate)
	if info.OK {
		t.Fatal("过密的区间在 Inspect 里也该是不合格")
	}
	if info.Reason != ReasonGridSpacingTooTight {
		t.Fatalf("原因应是 %s，得到 %q", ReasonGridSpacingTooTight, info.Reason)
	}
	if _, err := BuildGridPlan(in); err == nil {
		t.Fatal("Build 也必须拒 —— 两边判定不一致")
	}

	good := gridInput()
	info = InspectGridRange(good.Lower, good.Upper, good.Levels, good.TickSize, good.FeeRate)
	if !info.OK || info.Message != "" {
		t.Fatalf("正常区间应通过，得到 %+v", info)
	}
	if _, err := BuildGridPlan(good); err != nil {
		t.Fatalf("Build 也必须过: %v", err)
	}
}

/*
下面两个用例把**答给用户的数字**钉在测试里。

用户问的是"跑网格最少要多少钱"。这个数不能是随手估的 ——
它由两条线共同决定，取大的那个：

	交易所最小名义 × 条数        （挂得出去）
	零头门槛对应的每格名义 × 条数 （划得来）

在 DOGE 上第二条比第一条大一个数量级，所以答案由它决定。
参数用的是真实 exchangeInfo：DOGEUSDT 步长 1、最小名义 1；
XRPUSDT 步长 0.1、最小名义 5。
*/
func TestMinimumCapitalForDogeGrid(t *testing.T) {
	in := gridInput()
	in.QuoteBudget = 1
	_, err := BuildGridPlan(in)
	if err == nil {
		t.Fatal("1 USDT 不可能撑起 6 条线的网格")
	}
	t.Logf("DOGE 6 线 0.075–0.085 资金不足的报错: %v", err)

	// 反推所需的钱：每格名义要到 零头/净收益，再换算成数量、乘上所有线之和。
	lines, _, lerr := GridLines(in.Lower, in.Upper, in.Levels, in.TickSize)
	if lerr != nil {
		t.Fatal(lerr)
	}
	sum := 0.0
	for _, p := range lines {
		sum += p
	}
	netPct := GridSpacing(lines) - 2*in.FeeRate
	needNotional := in.StepSize * lines[0] / netPct
	needQty := AlignQuantityCeil(needNotional/lines[0], in.StepSize)
	need := needQty * sum
	t.Logf("DOGE 6 线：每格名义至少要 %.2f USDT（每格 %.0f 个），整份网格最少 %.2f USDT",
		needNotional, needQty, need)

	in.QuoteBudget = need * 1.05
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatalf("刚好够的时候不该被拒: %v", err)
	}
	if plan.EffectiveNetPct <= 0 {
		t.Fatalf("过线之后有效收益应为正，得到 %.6f", plan.EffectiveNetPct)
	}
	t.Logf("每格 %.0f 个（名义 %.2f USDT）：毛赚 %.3f%%、零头 %.3f%%、有效 %.3f%%，最坏占用 %.2f USDT",
		plan.QtyPerLevel, plan.NotionalPerLevel,
		plan.NetProfitPct*100, plan.StepDustPct*100, plan.EffectiveNetPct*100, plan.QuoteNeeded)

	// 这个量级必须被钉住：DOGE 步长是 1，零头门槛把 6 条线推到 20 USDT 上下，
	// 而不是"1 USDT × 6 = 6 USDT"。数字变了就说明公式被改动了。
	if need < 15 || need > 40 {
		t.Fatalf("DOGE 6 线的最少资金应落在 15–40 USDT 之间，算出来 %.2f", need)
	}
	// 让零头只占收益一成所需的每格规模，比交易所下限大一个数量级 ——
	// 这才是"跑得舒服"的资金门槛。
	sane := plan.MinNotionalForDust * float64(plan.Levels)
	t.Logf("若要让零头不超过收益的一成，整份网格要约 %.0f USDT", sane)
	if sane < plan.QuoteNeeded {
		t.Fatalf("「零头≤一成收益」的门槛（%.2f）必须高于「勉强能跑」的门槛（%.2f）",
			sane, plan.QuoteNeeded)
	}
}

func TestMinimumCapitalForXrpGrid(t *testing.T) {
	in := GridInput{
		Symbol: "XRPUSDT", Lower: 2.00, Upper: 2.20, Levels: 6,
		QuoteBudget: 200, LastPrice: 2.10, FeeRate: SpotDefaultFeeRate,
		MinNotional: 5, StepSize: 0.1, MinQty: 0.1, TickSize: 0.0001,
	}
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("XRP 6 线 2.00–2.20：每格 %.1f 个（名义 %.2f USDT），最坏占用 %.2f USDT",
		plan.QtyPerLevel, plan.NotionalPerLevel, plan.QuoteNeeded)
	if plan.NotionalPerLevel < 5 {
		t.Fatalf("每格名义 %.2f 应不低于 5 USDT", plan.NotionalPerLevel)
	}

	// 25 USDT（很多人会凭直觉填的数）撑不起 6 条线。
	in.QuoteBudget = 25
	if _, err := BuildGridPlan(in); err == nil {
		t.Fatal("25 USDT 撑不起 6 条 5 USDT 最小名义的网格，必须被拒")
	} else {
		t.Logf("XRP 6 线资金不足的报错: %v", err)
	}
}
