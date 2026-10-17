package trading

import (
	"math"
	"testing"
	"time"
)

/*
做空网格的测试。

用与多头网格同一组价位（0.075–0.085、6 条线），这样两边的期望值可以直接
对照 —— 镜像逻辑写错时，最容易发现的信号就是"多头的某个断言在空头这里
数值不对"。

价格路径全部手写：每条 Tick 就是"行情走到哪、引擎该挂什么"。
*/

const (
	shortTestSymbol = "DOGEUSDT"
	shortTestLower  = 0.075
	shortTestUpper  = 0.085
	shortTestStart  = 0.0800
	shortTestBudget = 12.0 // 保证金；3 倍杠杆 → 36 USDT 名义
	shortTestLev    = 3
)

func shortGridFixture(t *testing.T, price float64) (*GridEngine, *PaperFuturesGrid, *memoryGridFillLog) {
	t.Helper()
	paper := NewPaperFuturesGrid(gridTestRules(), price, GridShort, FuturesDefaultGridFeeRate)
	log := newMemoryGridFillLog()
	cfg := GridConfig{
		ID: 2, UserID: 7, ExchangeKeyID: 3,
		Symbol: shortTestSymbol, Mode: ModeTestnet,
		Direction: GridShort, Market: GridMarketFutures, Leverage: shortTestLev,
		Lower: shortTestLower, Upper: shortTestUpper, Levels: 6,
		QuoteBudget: shortTestBudget, FeeRate: FuturesDefaultGridFeeRate,
	}
	eng, err := BuildGridEngine(cfg, price, paper, log, DiscardLogger())
	if err != nil {
		t.Fatalf("建空头网格失败: %v", err)
	}
	if err := eng.Start(time.Now().UTC()); err != nil {
		t.Fatalf("启动空头网格失败: %v", err)
	}
	return eng, paper, log
}

func shortPump(t *testing.T, eng *GridEngine, paper *PaperFuturesGrid, price float64, at time.Time) GridSnapshot {
	t.Helper()
	paper.Tick(price)
	snap, err := eng.Step(at, price)
	if err != nil {
		t.Fatalf("推进失败（价格 %g）: %v", price, err)
	}
	return snap
}

// 开局只挂**高于当前价**的卖单；最下面那条线永远不卖。
func TestShortGridPlacesSellsOnlyAboveMarket(t *testing.T) {
	eng, paper, _ := shortGridFixture(t, shortTestStart)
	now := time.Now().UTC()

	snap := shortPump(t, eng, paper, shortTestStart, now)

	if snap.Direction != string(GridShort) || snap.Market != GridMarketFutures {
		t.Fatalf("快照方向/市场不对: %+v", snap)
	}
	if snap.Levels != 6 {
		t.Fatalf("应有 6 条网格线，得到 %d", snap.Levels)
	}
	// 0.08 之上有 0.080862 / 0.082908 / 0.085 三条线。
	if len(snap.Resting) != 3 {
		t.Fatalf("0.08 之上应有 3 条线，得到 %d 张挂单: %+v", len(snap.Resting), snap.Resting)
	}
	for _, r := range snap.Resting {
		if r.Side != SpotSell {
			t.Fatalf("开局只该挂卖单，得到 %s", r.Side)
		}
		if r.Price <= shortTestStart {
			t.Fatalf("卖单挂价 %g 不高于市价 %g —— 会立刻成交，等于开局卖便宜",
				r.Price, shortTestStart)
		}
		if r.Level == 0 {
			t.Fatalf("最下面那条线不该挂卖单（下面没有线可以买回）")
		}
	}
	if got := paper.OpenCount(); got != 3 {
		t.Fatalf("盘口上应有 3 张单，得到 %d", got)
	}
	// 还没有持仓时不该有保护单：币安的 closePosition 条件单要求有持仓。
	if got := paper.ProtectionTrigger(); got != 0 {
		t.Fatalf("空仓时不该挂保护单，得到触发价 %g", got)
	}
}

// 卖开 → 低一档买平，完成一次往返；重启后持仓能从成交流水里还原。
func TestShortGridRoundTripAndRestart(t *testing.T) {
	eng, paper, log := shortGridFixture(t, shortTestStart)
	now := time.Now().UTC()

	shortPump(t, eng, paper, shortTestStart, now)

	// 价格涨到第 3 条线（0.080862），卖单成交 → 第 3 格持空。
	sellPrice := eng.Plan().Lines[3].Buy
	shortPump(t, eng, paper, sellPrice, now.Add(time.Minute))

	if got := paper.Position(); got >= 0 {
		t.Fatalf("卖出后合约持仓应为负（空头），得到 %g", got)
	}
	if h := eng.HoldingsView()[3]; h <= 0 {
		t.Fatalf("第 3 格应持有空头，得到 %g", h)
	}
	// 有持仓之后，同一拍就应该把交易所侧止损挂上。
	if got := paper.ProtectionTrigger(); math.Abs(got-eng.Plan().StopPrice) > 1e-9 {
		t.Fatalf("有持仓后应挂出止损 %g，得到 %g", eng.Plan().StopPrice, got)
	}

	// 价格跌到第 2 条线 → 挂在上面的买单成交，往返完成。
	buyPrice := eng.Plan().Lines[2].Buy
	snap := shortPump(t, eng, paper, buyPrice, now.Add(2*time.Minute))

	if snap.RoundTrips != 1 {
		t.Fatalf("应完成 1 次往返，得到 %d", snap.RoundTrips)
	}
	if math.Abs(paper.Position()) > 1e-9 {
		t.Fatalf("往返之后合约持仓应为 0，得到 %g", paper.Position())
	}
	if snap.RealizedUSDT <= 0 {
		t.Fatalf("做空网格在下跌一档后应赚钱，得到已实现 %.8f", snap.RealizedUSDT)
	}

	// 重启：用同一份成交账本重新建引擎，持仓应能还原。
	// 先制造一个未平仓的空头。
	shortPump(t, eng, paper, sellPrice, now.Add(3*time.Minute))
	openQty := paper.Position()
	if openQty >= 0 {
		t.Fatalf("应重新持有空头，得到 %g", openQty)
	}

	cfg := GridConfig{
		ID: 2, UserID: 7, ExchangeKeyID: 3,
		Symbol: shortTestSymbol, Mode: ModeTestnet,
		Direction: GridShort, Market: GridMarketFutures, Leverage: shortTestLev,
		Lower: shortTestLower, Upper: shortTestUpper, Levels: 6,
		QuoteBudget: shortTestBudget, FeeRate: FuturesDefaultGridFeeRate,
	}
	restarted, err := BuildGridEngine(cfg, sellPrice, paper, log, DiscardLogger())
	if err != nil {
		t.Fatalf("重启建引擎失败: %v", err)
	}
	holds := restarted.HoldingsView()
	if len(holds) != 1 || holds[3] <= 0 {
		t.Fatalf("重启后应从成交流水还原出第 3 格的空头，得到 %+v", holds)
	}
}

// 涨过上沿再涨 stopPct → 止损，市价买回清仓。
func TestShortGridStopAboveUpper(t *testing.T) {
	eng, paper, _ := shortGridFixture(t, shortTestStart)
	now := time.Now().UTC()

	shortPump(t, eng, paper, shortTestStart, now)
	sellPrice := eng.Plan().Lines[3].Buy
	shortPump(t, eng, paper, sellPrice, now.Add(time.Minute))
	if paper.Position() >= 0 {
		t.Fatalf("应先持有空头")
	}

	stop := eng.Plan().StopPrice
	snap := shortPump(t, eng, paper, stop, now.Add(2*time.Minute))
	if snap.State != GridStopped {
		t.Fatalf("价格穿过止损后应停机，得到 %s", snap.State)
	}
	if snap.LastReason != ReasonGridStopLoss {
		t.Fatalf("停机原因应是 %s，得到 %s", ReasonGridStopLoss, snap.LastReason)
	}
	if math.Abs(paper.Position()) > 1e-9 {
		t.Fatalf("止损后合约持仓应清零，得到 %g", paper.Position())
	}
	if got := paper.ProtectionTrigger(); got != 0 {
		t.Fatalf("清仓后应撤掉交易所侧保护单，得到触发价 %g", got)
	}
}

// 跌破下沿 → 空头止盈，市价买回清仓。
func TestShortGridTakeProfitAtLower(t *testing.T) {
	eng, paper, _ := shortGridFixture(t, shortTestStart)
	now := time.Now().UTC()

	shortPump(t, eng, paper, shortTestStart, now)
	sellPrice := eng.Plan().Lines[3].Buy
	shortPump(t, eng, paper, sellPrice, now.Add(time.Minute))

	snap := shortPump(t, eng, paper, shortTestLower, now.Add(2*time.Minute))
	if snap.State != GridStopped {
		t.Fatalf("跌破下沿后应停机，得到 %s", snap.State)
	}
	if snap.LastReason != ReasonGridTakeProfit {
		t.Fatalf("停机原因应是 %s，得到 %s", ReasonGridTakeProfit, snap.LastReason)
	}
	if math.Abs(paper.Position()) > 1e-9 {
		t.Fatalf("止盈后合约持仓应清零，得到 %g", paper.Position())
	}
}

// 计划层：预算按保证金算，名义是它的杠杆倍；止损在上沿之上。
func TestBuildGridPlanShortMirrorsLong(t *testing.T) {
	in := GridInput{
		Symbol: shortTestSymbol, Direction: GridShort, Market: GridMarketFutures, Leverage: shortTestLev,
		Lower: shortTestLower, Upper: shortTestUpper, Levels: 6,
		QuoteBudget: shortTestBudget, LastPrice: shortTestStart,
		FeeRate: FuturesDefaultGridFeeRate,
		MinNotional: 1, StepSize: 1, MinQty: 1, TickSize: 0.00001,
		StopPct: GridDefaultStopPct,
	}
	plan, err := BuildGridPlan(in)
	if err != nil {
		t.Fatalf("空头计划应合法: %v", err)
	}
	if plan.Direction != GridShort || plan.Market != GridMarketFutures || plan.Leverage != shortTestLev {
		t.Fatalf("计划方向/市场/杠杆不对: %+v", plan)
	}
	wantStop := shortTestUpper * (1 + GridDefaultStopPct)
	if math.Abs(plan.StopPrice-wantStop) > 1e-9 {
		t.Fatalf("空头止损应在上沿之上 %g，得到 %g", wantStop, plan.StopPrice)
	}
	if math.Abs(plan.TakeProfitPrice-shortTestLower) > 1e-9 {
		t.Fatalf("空头止盈边界应是下沿 %g，得到 %g", shortTestLower, plan.TakeProfitPrice)
	}
	if math.Abs(plan.NotionalNeeded-plan.QuoteNeeded*shortTestLev) > 1e-6 {
		t.Fatalf("名义应为保证金的 %d 倍：名义 %g 保证金 %g",
			shortTestLev, plan.NotionalNeeded, plan.QuoteNeeded)
	}
	if plan.QuoteNeeded > shortTestBudget+1e-6 {
		t.Fatalf("保证金 %.4f 超过预算 %.2f", plan.QuoteNeeded, shortTestBudget)
	}
	if plan.InitialSells != 3 || plan.InitialBuys != 0 {
		t.Fatalf("开局应有 3 张卖单、0 张买单，得到 %d/%d", plan.InitialSells, plan.InitialBuys)
	}
	if plan.WorstLossUSDT <= 0 {
		t.Fatalf("空头止损必然有亏损，得到 %.6f", plan.WorstLossUSDT)
	}
}

// 做空跑在现货上是产品层面的错误，计划层必须直接拒绝。
func TestShortGridRequiresFutures(t *testing.T) {
	_, err := BuildGridPlan(GridInput{
		Symbol: shortTestSymbol, Direction: GridShort, Market: GridMarketSpot,
		Lower: shortTestLower, Upper: shortTestUpper, Levels: 6,
		QuoteBudget: 50, LastPrice: shortTestStart, FeeRate: 0.001,
		MinNotional: 1, StepSize: 1, MinQty: 1, TickSize: 0.00001,
	})
	if err == nil {
		t.Fatalf("现货做空应被拒绝")
	}
}
