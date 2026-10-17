package trading

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

/*
网格引擎的测试全部跑在 PaperGrid 上。

这不是图省事：网格真正容易错的地方是**状态推进** ——
"买单成交后卖单挂到哪一格""部分成交之后这一格算多少""撤单之后下一拍
会不会补回来"。这些在真实交易所上要等行情配合才复现，一次调试就是一天；
而在内存撮合里可以把价格路径一行行写出来，每一步都断言。

下面每个用例的价格路径都是手写的一串 Tick，读起来就是"行情怎么走、
引擎该做什么"。
*/

const (
	gridTestSymbol = "DOGEUSDT"
	gridTestLower  = 0.075
	gridTestUpper  = 0.085
	gridTestStart  = 0.0800
)

func gridTestRules() GridRules {
	return GridRules{
		BaseAsset: "DOGE", QuoteAsset: "USDT",
		StepSize: 1, MinQty: 1, TickSize: 0.00001, MinNotional: 1,
	}
}

/*
gridFixture 搭一台跑在内存撮合上的网格。

预算 22 USDT 是**被零头门槛逼出来的**，不是随手挑的：DOGE 步长 1、
价 0.075，每格名义低于约 3.23 USDT 时，一次往返被卡住的零头就超过
每格赚的钱，计划层会直接拒绝建网（ReasonGridStepTooCoarse）。
22 USDT 摊到 6 条线上每格约 3.4 USDT，刚好过线。

这个数字本身就是这份代码要回答的问题之一：跑 DOGE 网格，
**6 条线最少要 20 USDT 上下**，而不是"1 USDT 最小名义 × 6 = 6 USDT"。
*/
func gridFixture(t *testing.T, price, quote float64) (*GridEngine, *PaperGrid, *memoryGridFillLog) {
	t.Helper()
	paper := NewPaperGrid(gridTestRules(), price, quote)
	paper.SetFee(0.001)
	log := newMemoryGridFillLog()
	cfg := GridConfig{
		ID: 1, UserID: 7, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
		QuoteBudget: 22, FeeRate: 0.001,
	}
	eng, err := BuildGridEngine(cfg, price, paper, log, DiscardLogger())
	if err != nil {
		t.Fatalf("建网格失败: %v", err)
	}
	if err := eng.Start(time.Now().UTC()); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	return eng, paper, log
}

// pump 是测试的时钟：先把价格推给撮合（触发成交），再让引擎推进一拍。
// 顺序不能反 —— 引擎捞成交是靠"比对盘口"，撮合得先发生。
func pump(t *testing.T, eng *GridEngine, paper *PaperGrid, price float64, at time.Time) GridSnapshot {
	t.Helper()
	paper.Tick(price)
	snap, err := eng.Step(at, price)
	if err != nil {
		t.Fatalf("推进失败（价格 %g）: %v", price, err)
	}
	return snap
}

/*
开局只挂**低于当前价**的买单。

高于当前价的买入限价单会立刻成交（等于一开局就自愿买贵），所以
那几条线要空着，等价格自己涨上去、由上一格的卖单把它们引出来。
*/
func TestGridPlacesBuysOnlyBelowMarket(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()

	snap := pump(t, eng, paper, gridTestStart, now)

	// 基准计划：0.075 / 0.07690 / 0.07885 / 0.08084 / 0.08289 / 0.085
	if snap.Levels != 6 {
		t.Fatalf("应有 6 条网格线，得到 %d", snap.Levels)
	}
	if len(snap.Resting) != 3 {
		t.Fatalf("0.08 之下应有 3 条线，得到 %d 张挂单: %+v", len(snap.Resting), snap.Resting)
	}
	for _, r := range snap.Resting {
		if r.Side != SpotBuy {
			t.Fatalf("开局只该挂买单，得到 %s", r.Side)
		}
		if r.Price >= gridTestStart {
			t.Fatalf("买单挂价 %g 不低于市价 %g —— 会立刻成交，等于开局买贵",
				r.Price, gridTestStart)
		}
	}
	// 挂出去的每一张都得真的在盘口上。
	if got := paper.OpenCount(); got != 3 {
		t.Fatalf("盘口上应有 3 张单，得到 %d", got)
	}
}

/*
这一条是网格的核心动作：**在 p_i 买到，就把卖单挂到 p_{i+1}**。

挂到 p_i 上是这个模块最容易犯的错 —— 刚买到的立刻按原价卖回去，
价差为零、白付两次手续费，而且从界面上完全看不出来（那一格确实
"有买有卖"，看起来很正常）。
*/
func TestBuyFillPlacesSellOneLineUp(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	// 价格落到第三条线 0.07885，那一格的买单成交。
	snap := pump(t, eng, paper, 0.07885, now.Add(time.Minute))

	holds := eng.HoldingsView()
	if len(holds) != 1 {
		t.Fatalf("应恰好有一格买到货，得到 %v", holds)
	}
	var level int
	for l := range holds {
		level = l
	}
	if level != 2 {
		t.Fatalf("成交的应是第 2 条线（0.07885），得到第 %d 条", level)
	}

	sell, ok := eng.resting[level+1]
	if !ok {
		t.Fatalf("买到货之后应在第 %d 条线挂卖单，实际挂单: %+v", level+1, snap.Resting)
	}
	if sell.Side != SpotSell {
		t.Fatalf("第 %d 条线上应是卖单，得到 %s", level+1, sell.Side)
	}
	if math.Abs(sell.Price-0.08084) > 1e-9 {
		t.Fatalf("卖价应挂在第 %d 条线 0.08084，得到 %g", level+1, sell.Price)
	}
	// 买到货的那一格不能同时挂着买单 —— 不然同一格既有货又想买货。
	if _, dup := eng.resting[level]; dup {
		t.Fatalf("已持有的第 %d 格不该再挂买单", level)
	}
	// 低于市价的另外两条线仍是买单。
	if _, ok := eng.resting[0]; !ok {
		t.Fatal("第 0 格买单应在成交后保留")
	}
}

// 卖单成交之后，同样的货要在下一格重新买回来 —— 网格靠这个循环反复吃同一段震荡。
func TestSellFillBuysBackOneLineDown(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute))   // 买单成交
	pump(t, eng, paper, 0.08084, now.Add(2*time.Minute)) // 卖单成交

	if got := len(eng.HoldingsView()); got != 0 {
		t.Fatalf("卖完之后不该还有持仓，得到 %v", eng.HoldingsView())
	}
	buy, ok := eng.resting[2]
	if !ok {
		t.Fatalf("卖完之后应在第 2 格重新挂买单，实际: %+v", eng.resting)
	}
	if buy.Side != SpotBuy || math.Abs(buy.Price-0.07885) > 1e-9 {
		t.Fatalf("重挂的应是第 2 格买单 0.07885，得到 %s @%g", buy.Side, buy.Price)
	}
	if snap := eng.Snapshot(); snap.RoundTrips != 1 {
		t.Fatalf("应完成 1 次往返，得到 %d", snap.RoundTrips)
	}
}

/*
一次完整往返的已实现盈亏必须**和计划里印出来的那个数对得上**。

计划里的 NetProfitPerLevel 是展示给用户的（"每格赚多少"），
引擎算出来的 realized 是实际账。两者对不上，说明要么计划在骗人、
要么账记错了 —— 两种都不能接受。

这里用的是 PaperGrid，它的撮合刻意做成最保守的一种：
限价单只有被穿过才成交，成交价就是挂单价，不给"成交在更好价位"的便宜。
所以实际值略低于计划值是正常的，但**不能低于一半**（那说明差了一个数量级，
多半是把手续费算重了或者买卖价搞反了）。
*/
func TestRoundTripProfitMatchesPlan(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute))
	pump(t, eng, paper, 0.08084, now.Add(2*time.Minute))

	snap := eng.Snapshot()
	want := snap.NetProfitPerLevel
	if snap.RealizedUSDT <= 0 {
		t.Fatalf("一次往返之后已实现盈亏应为正，得到 %.8f", snap.RealizedUSDT)
	}
	if want <= 0 {
		t.Fatalf("计划里的每格收益应为正，得到 %.8f", want)
	}
	ratio := snap.RealizedUSDT / want
	if ratio < 0.5 || ratio > 1.5 {
		t.Fatalf("实际已实现 %.8f 与计划每格收益 %.8f 差了 %.1f 倍 —— 计划或账记错了",
			snap.RealizedUSDT, want, ratio)
	}
	/*
		账面上还该能复算出同一个数。

		**买入的手续费不能再减一次。** 它以基础币收取，已经体现在
		"到账量比成交额少"上，于是被摊进了持仓成本价里；再按计价币
		减一遍就是重复计算。所以这里的口径是：

				已实现 = Σ卖出(成交额 − 卖出手续费) − Σ买入成交额 + 手上还压着的成本

		最后一项不能省：这一轮卖的是 44 个，而持有的是 44.955 个 ——
		剩下那 0.955 个（不到一个步长，卖不出去）的成本没有结转，
		不减掉它，复算出来的数会比真实已实现少一截。持仓完全清零
		时这一项自然为 0，公式退化成"净收入 − 总支出"。
	*/
	fills, _ := log2(t, eng)
	var spent, netProceeds float64
	for _, f := range fills {
		if f.Side == SpotBuy {
			spent += f.Quote
			continue
		}
		netProceeds += f.Quote - f.FeeQuote
	}
	replayed := netProceeds - spent + snap.InventoryCost
	if math.Abs(replayed-snap.RealizedUSDT) > 1e-9 {
		t.Fatalf("逐笔复算的盈亏 %.8f 与快照里的已实现 %.8f 对不上（手上成本 %.8f）",
			replayed, snap.RealizedUSDT, snap.InventoryCost)
	}
}

// log2 取出这台引擎已经落账的成交。
func log2(t *testing.T, eng *GridEngine) ([]GridFill, error) {
	t.Helper()
	rows, err := eng.fills.List(eng.cfg.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	// List 返回的是新的在前，复算要按时间正序。
	out := make([]GridFill, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		out = append(out, rows[i])
	}
	return out, nil
}

/*
跌破止损价：清仓 + 停机，原因写成 stop_loss。

清仓而不是"撤单走人"：网格停在一半意味着手里压着货、盘口上没有
对应的卖单 —— 那是一个没有任何保护的裸仓。用户说停的时候要的是
"把钱拿回来"，不是"把钱换成一堆币放着"。
*/
func TestStopLossFlattensAndStops(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	// 逐级下探，把低位的买单都打满。
	for i, p := range []float64{0.07885, 0.07690, 0.07500} {
		pump(t, eng, paper, p, now.Add(time.Duration(i+1)*time.Minute))
	}
	if eng.qtyHeld <= 0 {
		t.Fatalf("下探过程中应该接到货，实际持仓 %v", eng.qtyHeld)
	}

	stop := eng.Plan().StopPrice
	if stop <= 0 {
		t.Fatal("止损价没算出来")
	}
	snap := pump(t, eng, paper, stop, now.Add(10*time.Minute))

	if snap.State != GridStopped {
		t.Fatalf("跌破止损应停机，得到 %s", snap.State)
	}
	if snap.LastReason != ReasonGridStopLoss {
		t.Fatalf("停机原因应是 %s，得到 %q", ReasonGridStopLoss, snap.LastReason)
	}
	// 停机时每一格都该是空的。InventoryQty 里可能还留着零头，
	// 所以这里看的是**逐格持仓**，不是总量。
	if holds := eng.HoldingsView(); len(holds) != 0 {
		t.Fatalf("停机时应已清仓，仍有格子持有 %v", holds)
	}
	if paper.OpenCount() != 0 {
		t.Fatalf("停机时盘口上不该还有挂单，剩 %d 张", paper.OpenCount())
	}
	/*
		清仓之后基础币只剩"零头"。

		清不干净**不是 bug**：币安现货的数量必须是步长的整数倍，
		而持仓量（13.986 × 3）本来就不是。卖 41 个之后剩的 0.958 个
		连一张合法的卖单都挂不出来 —— 只能留在账户里等币安的小额兑换。
		所以这里断言的是"剩下的不够一个步长"，不是"归零"。
	*/
	base, _ := paper.Balances()
	if base >= gridTestRules().StepSize {
		t.Fatalf("清仓后剩下的必须小于一个步长，实际剩 %g", base)
	}
	if snap.DustQty <= 0 {
		t.Fatalf("零头要如实报在快照里，得到 %g", snap.DustQty)
	}
}

// 涨过上沿：这是**赚钱**的离场，原因要和止损分开写 ——
// 两者在界面上、在复盘时是完全不同的两件事。
func TestUpperBreakoutTakesProfitAndStops(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute)) // 先接一格
	snap := pump(t, eng, paper, gridTestUpper, now.Add(2*time.Minute))

	if snap.State != GridStopped {
		t.Fatalf("涨过上沿应停机，得到 %s", snap.State)
	}
	if snap.LastReason != ReasonGridTakeProfit {
		t.Fatalf("停机原因应是 %s，得到 %q", ReasonGridTakeProfit, snap.LastReason)
	}
	if snap.InventoryQty > 0 {
		t.Fatalf("停机时应已清仓，仍持有 %g", snap.InventoryQty)
	}
	if paper.OpenCount() != 0 {
		t.Fatalf("停机时盘口上不该还有挂单，剩 %d 张", paper.OpenCount())
	}
}

/*
出界判定必须**发生在补挂之前**。

顺序反了的话，价格已经跌穿止损时引擎会先把该挂的单挂上、
再去清仓 —— 那些单在清仓的市价卖之前可能就成交了，
于是"停机时的持仓"比"该有的持仓"多，用户看到的亏损比实际更大，
而且多出来的货是在最坏的价位接的。
*/
func TestOutOfRangeCheckedBeforePlacing(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	before := len(paper.Placements())

	pump(t, eng, paper, eng.Plan().StopPrice, now.Add(time.Minute))

	if after := len(paper.Placements()); after != before {
		t.Fatalf("出界那一拍不该再挂任何新单，多了 %d 张", after-before)
	}
}

/*
只做 maker 被拒（穿价）不是错误。

行情在两次轮询之间跳过了这一格，那一格这一拍就不该挂 —— 这是网格的
**正常分支**。把它当错误会让引擎每一拍都报一次错、日志被正常情况刷屏，
真正的故障反而被埋掉。但它要计数：这个数持续偏大说明轮询太慢。
*/
func TestLimitMakerRejectionIsNotAnError(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	// 先撤掉第 0 格，制造一个"这一拍需要重新挂单"的格。
	// 不制造的话这一拍没有任何挂单动作，RejectNext 根本不会被消费 ——
	// 测试会"通过"，但它什么都没验证。
	if err := paper.Cancel(gridTestSymbol, eng.resting[0].Client); err != nil {
		t.Fatal(err)
	}
	paper.RejectNextPlace(&ExchangeError{Status: 400, Code: -2010,
		Msg: "Order would immediately match and take. LIMIT_MAKER"})
	snap, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err != nil {
		t.Fatalf("穿价被拒不该让引擎报错: %v", err)
	}
	if snap.PlaceFailed != 1 {
		t.Fatalf("应记下 1 次穿价跳过，得到 %d", snap.PlaceFailed)
	}
	if snap.State != GridRunning {
		t.Fatalf("穿价不该让网格停机，得到 %s", snap.State)
	}
	// 下一拍应把没挂上的那格补回来 —— 自愈。
	next, err := eng.Step(now.Add(2*time.Minute), gridTestStart)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Resting) != 3 {
		t.Fatalf("下一拍应补回 3 张挂单，得到 %d", len(next.Resting))
	}
}

// 别的错误（签名不对、权限不够）必须原样透出 —— 那才是真出事了。
func TestHardExchangeErrorSurfaces(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	if err := paper.Cancel(gridTestSymbol, eng.resting[0].Client); err != nil {
		t.Fatal(err)
	}
	paper.RejectNextPlace(&ExchangeError{Status: 401, Code: -2015,
		Msg: "Invalid API-key, IP, or permissions for action."})
	_, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err == nil {
		t.Fatal("权限错误必须透出，不能被当成穿价吞掉")
	}
	var ex *ExchangeError
	if !errors.As(err, &ex) || ex.Code != -2015 {
		t.Fatalf("应保留币安错误码，得到 %v", err)
	}
}

/*
挂单被撤之后，下一拍必须把它补回来。

把它当成"没成交、不用管"，本地就会一直以为这一格挂着单、再也不补，
盘口上那一格永远空着 —— 网格少一条腿，而界面上看起来一切正常。
*/
func TestCancelledOrderIsReplacedNextTick(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	// 手工撤掉第 0 格的单（模拟外部干预 / 交易所侧过期）。
	if _, ok := eng.resting[0]; !ok {
		t.Fatal("第 0 格本该挂着买单")
	}
	if err := paper.Cancel(gridTestSymbol, eng.resting[0].Client); err != nil {
		t.Fatal(err)
	}
	if paper.OpenCount() != 2 {
		t.Fatalf("撤掉一张后盘口上应剩 2 张，得到 %d", paper.OpenCount())
	}

	snap, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Resting) != 3 {
		t.Fatalf("撤掉的挂单应被补回，得到 %d 张", len(snap.Resting))
	}
	if _, ok := eng.resting[0]; !ok {
		t.Fatal("第 0 格应重新挂上买单")
	}
}

/*
查单失败时**不能**清掉本地记账。

网络抖一下和"这张单不存在"在本地看起来是一样的，而猜错的后果是单向的：
把已成交当成没成交，于是重复挂单、重复建仓。所以查不到就保持原样、
下一拍再查 —— 宁可多查几次。
*/
func TestQueryFailureKeepsLocalRecord(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	client := eng.resting[0].Client
	paper.Tick(0.07885) // 第 2 格成交，盘口上少一张
	if err := paper.Cancel(gridTestSymbol, client); err != nil {
		t.Fatal(err)
	}
	paper.RejectNextQuery(&ExchangeError{Status: 502, Code: -1001, Msg: "网络超时"})

	if _, err := eng.Step(now.Add(time.Minute), 0.07885); err != nil {
		t.Fatalf("查单失败不该让整拍失败: %v", err)
	}
	if _, ok := eng.resting[0]; !ok {
		t.Fatal("查单失败时本地记账必须保留 —— 清掉会让我们重复挂单")
	}
}

/*
重启认领：成交历史是唯一的事实来源。

重启后内存里的持仓表是空的，而交易所上可能还挂着卖单、账上还有货。
不知道哪些格持有货，就不知道该在哪儿挂卖单 —— 那些货会一直压在手里
没有任何出口。所以 holdings 必须能从成交历史原样还原。
*/
func TestHoldingsRestoredFromFillLog(t *testing.T) {
	eng, paper, flog := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute))
	if len(eng.HoldingsView()) != 1 {
		t.Fatalf("应有一格持仓，得到 %v", eng.HoldingsView())
	}
	before := eng.HoldingsView()

	// 模拟进程重启：同样的配置、同一份成交历史，全新的引擎。
	cfg := GridConfig{
		ID: 1, UserID: 7, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
		QuoteBudget: 22, FeeRate: 0.001,
	}
	revived, err := BuildGridEngine(cfg, gridTestStart, paper, flog, DiscardLogger())
	if err != nil {
		t.Fatal(err)
	}
	after := revived.HoldingsView()
	if len(after) != len(before) {
		t.Fatalf("重启后持仓没还原: 之前 %v，之后 %v", before, after)
	}
	for level, qty := range before {
		if math.Abs(after[level]-qty) > 1e-9 {
			t.Fatalf("第 %d 格数量不对: 之前 %g，之后 %g", level, qty, after[level])
		}
	}
}

/*
认领时先撤掉盘口上**这个交易对的全部挂单**，包括不认识的。

进程重启后本地记账是空的，盘口上留着上一次运行挂的单。那些单不认识
也得撤 —— 网格独占一个交易对是它的前提（Hub 的 symbolTaken 保证），
混进来的单会让同一格既有旧单又有新单，成交之后数量就对不上了。
*/
func TestAdoptCancelsForeignOrders(t *testing.T) {
	paper := NewPaperGrid(gridTestRules(), gridTestStart, 50)
	paper.SetFee(0.001)
	// 一张"上次运行留下的"单，客户单号不在本引擎的记账里。
	if _, err := paper.PlaceLimit(gridTestSymbol, SpotBuy, 14, 0.07690, "oo-g1-L1-999"); err != nil {
		t.Fatal(err)
	}
	if paper.OpenCount() != 1 {
		t.Fatalf("前置条件：盘口上应有 1 张外来单，得到 %d", paper.OpenCount())
	}
	cfg := GridConfig{
		ID: 1, UserID: 7, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
		QuoteBudget: 22, FeeRate: 0.001,
	}
	eng, err := BuildGridEngine(cfg, gridTestStart, paper, newMemoryGridFillLog(), DiscardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.Adopt(time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if paper.OpenCount() != 0 {
		t.Fatalf("认领时应把外来挂单撤干净，剩 %d 张", paper.OpenCount())
	}
	if len(paper.Cancelled()) != 1 {
		t.Fatalf("应撤掉 1 张，得到 %v", paper.Cancelled())
	}
}

/*
部分成交：成交的那一份坐实，剩下的撤掉。

继续等它成交，意味着这一格的数量在成交那一刻还没定下来，而卖单是按
"已经买到的量"挂的 —— 一旦买入量后来涨了，就会出现"卖掉的数量超过
为它挂的卖单"，账从此对不上。所以宁可少买一点，也要让数量当场定死。
*/
func TestPartialFillBooksExecutedAndCancelsRest(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	target := eng.resting[2].Client
	// 成交 30 个（挂单量是 45）。挑 30 而不是 6：成交太少的话，
	// 剩下的量加上手续费扣减之后挂不出一张合法卖单，那是另一条分支
	//（已被 TestUnsellableRemainderBecomesDust 覆盖）。
	if err := paper.PartialFill(target, 30); err != nil {
		t.Fatal(err)
	}
	snap, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err != nil {
		t.Fatal(err)
	}
	held := eng.HoldingsView()[2]
	// 到账量是 30 扣掉以 DOGE 收取的手续费（30 × 0.1% = 0.03）。
	if math.Abs(held-29.97) > 1e-6 {
		t.Fatalf("第 2 格应记到账 29.97 个（30 扣手续费），得到 %g", held)
	}
	// 剩下的必须被撤掉，不能还挂在盘口上。
	for _, o := range paperOpenRows(t, paper) {
		if o.ClientOrderID == target {
			t.Fatal("部分成交之后剩余部分必须撤掉 —— 留着会让这一格的数量漂移")
		}
	}
	// 卖单按**实际持有量**挂，不是计划里的 14 —— 挂 14 会被币安以余额不足拒掉。
	sell, ok := eng.resting[3]
	if !ok {
		t.Fatalf("部分成交后应在第 3 格挂卖单，实际: %+v", snap.Resting)
	}
	// 卖出数量按实际持有量向下取到步长：29.97 → 29。
	if math.Abs(sell.Qty-29) > 1e-9 {
		t.Fatalf("卖单数量应按实际持有 29.97 取整到 29，得到 %g", sell.Qty)
	}
}

/*
部分成交的竞态：撤单请求发出去之后、交易所真正撤掉之前，还会再成交。

测试网实盘复现过：WIF 空头第 9 格的快照是 201.2，撤单过程中又成交
25.7；旧实现按快照入账后就把挂单记录删了，本地永久少记 25.7，
随后被持仓漂移守卫连续三拍抓到、整条网格停机清仓。

这个测试让纸面交易所在 Cancel 里再成交 5 个，验证入账用的是撤单后的
终态（35），而不是撤单前的快照（30）。
*/
type lateFillPaper struct {
	*PaperGrid
	lateQty float64
	fired   bool
}

func (p *lateFillPaper) Cancel(symbol, clientID string) error {
	if !p.fired && p.lateQty > 0 {
		p.fired = true
		if err := p.PaperGrid.PartialFill(clientID, p.lateQty); err != nil {
			return err
		}
	}
	return p.PaperGrid.Cancel(symbol, clientID)
}

func TestPartialFillBooksFillsThatLandDuringCancel(t *testing.T) {
	paper := NewPaperGrid(gridTestRules(), gridTestStart, 50)
	paper.SetFee(0.001)
	log := newMemoryGridFillLog()
	ex := &lateFillPaper{PaperGrid: paper, lateQty: 5}
	cfg := GridConfig{
		ID: 1, UserID: 7, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
		QuoteBudget: 22, FeeRate: 0.001,
	}
	eng, err := BuildGridEngine(cfg, gridTestStart, ex, log, DiscardLogger())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := eng.Start(now); err != nil {
		t.Fatal(err)
	}
	pump(t, eng, paper, gridTestStart, now)

	target := eng.resting[2].Client
	if err := paper.PartialFill(target, 30); err != nil {
		t.Fatal(err)
	}
	snap, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err != nil {
		t.Fatal(err)
	}
	held := eng.HoldingsView()[2]
	want := 35 - 35*0.001
	if math.Abs(held-want) > 1e-6 {
		t.Fatalf("撤单过程中成交的 5 个也要入账：期望 %g，得到 %g", want, held)
	}
	if snap.State != GridRunning {
		t.Fatalf("这只是记账竞态，不该停机：state=%s reason=%s", snap.State, snap.LastReason)
	}
}

/*
查到的还不是终态时，settle 不能记账、也不能删除挂单记录。

OpenOrders 的某一拍快照可能暂时不包含一张仍在撮合的单；如果这时
QueryOrder 返回 PARTIALLY_FILLED，按快照量入账并删记录，后续成交
就永远丢了 —— 测试网 WIF 空头第二次停机就是这么来的：平仓单在撤单
竞态里多成交 25.4 张，交易所 613.3 / 本地 638.7，漂移守卫三拍后清仓。
*/
func TestSettleWaitsForFinalStatus(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	rest := eng.resting[2]
	if rest == nil {
		t.Fatal("第 2 格应有挂单")
	}
	if err := paper.PartialFill(rest.Client, 30); err != nil {
		t.Fatal(err)
	}
	state := SpotOrderState{
		ClientOrderID: rest.Client, OrderID: rest.OrderID,
		Side: rest.Side, Price: rest.Price, OrigQty: rest.Qty,
		ExecutedQty: 10, Status: SpotStatusPartial,
	}
	if err := eng.settle(rest, state); err != nil {
		t.Fatal(err)
	}
	if eng.resting[2] == nil {
		t.Fatal("非终态不能删除挂单记录 —— 这张单还可能继续成交")
	}
	if held := eng.HoldingsView()[2]; held != 0 {
		t.Fatalf("非终态不能入账，得到 %g", held)
	}

	state.ExecutedQty = 30
	state.Status = SpotStatusCanceled
	if err := eng.settle(rest, state); err != nil {
		t.Fatal(err)
	}
	if eng.resting[2] != nil {
		t.Fatal("终态应删除挂单记录")
	}
	if held := eng.HoldingsView()[2]; math.Abs(held-29.97) > 1e-6 {
		t.Fatalf("终态应按成交 30 入账（扣基础币手续费），得到 %g", held)
	}
}

/*
成交回放里遇到清仓单（level -1）必须把此前持仓清零。

实盘踩过：空头网格因持仓漂移停机，清仓单平掉了 530.7；进程重启后
按成交历史重建持仓时，旧实现把清仓单过滤掉了（它不属于任何一格），
于是本地又"持有" 505，而交易所是空的。回放必须按时间顺序，遇到
清仓单就清零；清零之后新开的仓仍然要能正常重建。
*/
func TestHoldingsReplayClearsOnFlatten(t *testing.T) {
	log := newMemoryGridFillLog()
	save := func(level int, side SpotSide, qty float64) {
		t.Helper()
		if _, err := log.Save(GridFill{
			GridID: 1, Symbol: gridTestSymbol, Level: level,
			Side: side, Qty: qty, Price: 1, FilledAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}

	save(8, SpotSell, 303.8)
	save(9, SpotSell, 201.2)
	holds, err := log.Holdings(1, GridShort)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(holds[8]-303.8) > 1e-9 || math.Abs(holds[9]-201.2) > 1e-9 {
		t.Fatalf("清仓前的持仓应重建为 303.8/201.2，得到 %v", holds)
	}

	save(-1, SpotBuy, 530.7)
	holds, err = log.Holdings(1, GridShort)
	if err != nil {
		t.Fatal(err)
	}
	if len(holds) != 0 {
		t.Fatalf("清仓单之后不应再有持仓，得到 %v", holds)
	}

	// 清仓之后重新开仓：新成交要能正常重建。
	save(10, SpotSell, 100)
	holds, err = log.Holdings(1, GridShort)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(holds[10]-100) > 1e-9 {
		t.Fatalf("清仓后的新开仓应重建为 100，得到 %v", holds)
	}
}

/*
部分成交剩得太少、连一张合法卖单都挂不出时，把这一格关掉、零头转入 dust。

不这么做的话这一格会永远卡住：卖单挂不出去 → 引擎每一拍都失败 →
那一格再也不挂买单，而界面上它只是显示"持有一点货"。
*/
func TestUnsellableRemainderBecomesDust(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)

	target := eng.resting[2].Client
	if err := paper.PartialFill(target, 3); err != nil {
		t.Fatal(err)
	}
	snap, err := eng.Step(now.Add(time.Minute), gridTestStart)
	if err != nil {
		t.Fatalf("卖不出去的零头不该让整拍失败: %v", err)
	}
	if _, stuck := eng.HoldingsView()[2]; stuck {
		t.Fatal("挂不出去的那一格必须被关掉，否则它会永远卡住")
	}
	if snap.DustQty <= 0 {
		t.Fatalf("卖不掉的零头要计入 dust，得到 %g", snap.DustQty)
	}
	if _, hasSell := eng.resting[3]; hasSell {
		t.Fatal("零头不该挂出卖单")
	}
}

func paperOpenRows(t *testing.T, paper *PaperGrid) []SpotOrderState {
	t.Helper()
	rows, err := paper.OpenOrders(gridTestSymbol)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

/*
最后一条线永远不挂买单。

它上面没有线可以卖，在那里买入就是把货砸在自己手里 —— 网格的每一格
都必须有出口。这一条约束是设计的一部分，不是经验法则。
*/
func TestTopLineNeverGetsBuyOrder(t *testing.T) {
	/*
		价格贴近区间上沿（0.0849，高于第 4 条线 0.08289，仍在上沿 0.085 之下）。

		不能拿"高于区间"去测这一条 —— 那会直接触发上沿止盈停机，
		引擎一张单都不会挂，这个测试就变成了在验证另一件事。
		贴在上沿内侧才能看出"第 0..4 条挂买单、第 5 条不挂"。
	*/
	const nearTop = 0.0849
	eng, paper, _ := gridFixture(t, nearTop, 50)
	snap := pump(t, eng, paper, nearTop, time.Now().UTC())

	top := snap.Levels - 1
	if _, ok := eng.resting[top]; ok {
		t.Fatalf("最后一条线（第 %d 条）不该有买单 —— 它上面没有线可以卖", top)
	}
	if len(snap.Resting) != snap.Levels-1 {
		t.Fatalf("应挂 %d 张买单（最后一条除外），得到 %d",
			snap.Levels-1, len(snap.Resting))
	}
}

// 每一格的买卖数量必须落在交易所步长上 —— 带小数的数量会被币安拒掉。
func TestOrderQtyAlignsToStep(t *testing.T) {
	// 价格贴着上沿内侧（0.0849）：高于上沿会被 Start 直接拒掉，
	// 那样这个用例就变成在验证另一件事了。
	const nearTop = 0.0849
	eng, paper, _ := gridFixture(t, nearTop, 50)
	pump(t, eng, paper, nearTop, time.Now().UTC())
	for _, o := range paperOpenRows(t, paper) {
		if math.Abs(o.OrigQty-math.Round(o.OrigQty)) > 1e-9 {
			t.Fatalf("数量 %g 没落到步长 1 上", o.OrigQty)
		}
	}
}

/*
挂单量永不超出余额。

网格每一格卖的是"已经买到的货"，而账上的基础币余额可能因为手续费、
外部干预而略少于记录。卖超过余额的单会被币安以 -2010 拒掉，
那个错误码看不出是"余额不够"还是"单太小"，很难查。
*/
func TestSellNeverExceedsBalance(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute))

	base, _ := paper.Balances()
	for _, o := range paperOpenRows(t, paper) {
		if o.Side == SpotSell && o.OrigQty > base+1e-9 {
			t.Fatalf("卖单 %g 超过余额 %g —— 会被币安拒掉", o.OrigQty, base)
		}
	}
}

// 停机之后不再推进：所有动作都该停下来，不再挂单。
func TestStepAfterStopIsNoop(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	if err := eng.Stop(now, ReasonGridStoppedByUser); err != nil {
		t.Fatal(err)
	}
	before := len(paper.Placements())
	if _, err := eng.Step(now.Add(time.Minute), gridTestStart); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("停机后推进应返回 ErrNotRunning，得到 %v", err)
	}
	if after := len(paper.Placements()); after != before {
		t.Fatalf("停机后不该再挂单，多了 %d 张", after-before)
	}
	if paper.OpenCount() != 0 {
		t.Fatalf("停机后盘口上不该有挂单，剩 %d 张", paper.OpenCount())
	}
}

/*
多轮震荡下来，网格应该**积累**出正的已实现盈亏。

这是对"网格到底赚不赚钱"最直接的验证：让价格在同一段区间里来回走，
每一格来回一次就赚一次价差。走十轮还是零（或者负），说明
买卖配对或者手续费算错了。
*/
func TestOscillationAccumulatesProfit(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()

	// 先走一拍建网 —— 不然第一轮只是在挂初始单，不产生往返，
	// 计数会差一轮（9 次而不是 10 次），而那看起来像引擎漏了一次。
	pump(t, eng, paper, gridTestStart, now)

	// 0.07885 ↔ 0.08084 之间来回：第 2 格买、第 3 格卖，反复吃同一段价差。
	path := []float64{0.07885, 0.08084}
	step := 0
	for round := 0; round < 10; round++ {
		for _, p := range path {
			step++
			pump(t, eng, paper, p, now.Add(time.Duration(step)*time.Minute))
		}
	}
	snap := eng.Snapshot()
	if snap.RoundTrips < 10 {
		t.Fatalf("来回 10 轮该完成至少 10 次往返，得到 %d", snap.RoundTrips)
	}
	if snap.RealizedUSDT <= 0 {
		t.Fatalf("震荡 10 轮之后应累计正收益，得到 %.8f（买卖配对或手续费算错了）", snap.RealizedUSDT)
	}
	// 收益应该和"每格净收益 × 往返次数"在同一个量级。
	want := snap.NetProfitPerLevel * float64(snap.RoundTrips)
	if snap.RealizedUSDT < want*0.5 {
		t.Fatalf("累计收益 %.8f 远低于「每格 %.8f × %d 次」= %.8f",
			snap.RealizedUSDT, snap.NetProfitPerLevel, snap.RoundTrips, want)
	}
}

// 挂到盘口就成交（对手方同一 tick 吃掉）时，必须走正常入账路径，
// 而不是当成"还挂着" —— 后者下一拍会再入账一次。
func TestFilledOnPlaceIsBookedOnce(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	before := len(eng.HoldingsView())

	paper.SettleFilledOnPlace(true)
	pump(t, eng, paper, gridTestStart, now.Add(time.Minute))

	holds := eng.HoldingsView()
	if len(holds) > before+1 {
		t.Fatalf("当场成交不该凭空多出多格持仓: 之前 %d 格，之后 %v", before, holds)
	}
	// 再推一拍，数量不能因为"又查了一次"而变化。
	snapshotQty := eng.qtyHeld
	pump(t, eng, paper, gridTestStart, now.Add(2*time.Minute))
	if math.Abs(eng.qtyHeld-snapshotQty) > 1e-9 {
		t.Fatalf("持仓又变了：%g → %g（多半是同一笔成交被入账了两次）", snapshotQty, eng.qtyHeld)
	}
}

// 网格线的状态要能一眼看出"挂着买单 / 挂着卖单 / 已买到等卖 / 空着"。
func TestLevelViewsReflectEngineState(t *testing.T) {
	eng, paper, _ := gridFixture(t, gridTestStart, 50)
	now := time.Now().UTC()
	pump(t, eng, paper, gridTestStart, now)
	pump(t, eng, paper, 0.07885, now.Add(time.Minute))

	snap := eng.Snapshot()
	if len(snap.LevelsView) != snap.Levels {
		t.Fatalf("每个网格线都该有一行，得到 %d/%d", len(snap.LevelsView), snap.Levels)
	}
	byIndex := map[int]GridLevelView{}
	for _, v := range snap.LevelsView {
		byIndex[v.Index] = v
	}
	if got := byIndex[0].State; got != GridLineBuy {
		t.Fatalf("第 0 格应显示 %q，得到 %q", GridLineBuy, got)
	}
	if got := byIndex[2].State; got != GridLineHolding {
		t.Fatalf("第 2 格是买到的货，应显示 holding，得到 %q", got)
	}
	if got := byIndex[3].State; got != GridLineSell {
		t.Fatalf("第 3 格应显示挂着卖单，得到 %q", got)
	}
}

/*
价格不在区间里时**拒绝启动**，而不是让它空转。

这是最阴险的一种失败：价格在下沿之下时，所有网格线都在市价之上，
一张买单都挂不出去；而现货只能做多、手里也没货可卖 —— 于是网格
"运行"着，盘口上一张单都没有，界面上看起来一切正常。等到有人发现
的时候，可能已经过去几天了。

价格在上沿之上同样拦：那会立刻触发上沿止盈，等于刚启动就清仓停机。
*/
func TestStartRefusesPriceOutsideRange(t *testing.T) {
	for _, tt := range []struct {
		name  string
		price float64
	}{
		{"价格在下沿之下", 0.070},
		{"价格正好撞上下沿", gridTestLower},
		{"价格在上沿之上", 0.090},
		{"价格正好撞上上沿", gridTestUpper},
	} {
		t.Run(tt.name, func(t *testing.T) {
			paper := NewPaperGrid(gridTestRules(), tt.price, 200)
			paper.SetFee(0.001)
			cfg := GridConfig{
				ID: 1, UserID: 7, ExchangeKeyID: 3,
				Symbol: gridTestSymbol, Mode: ModeTestnet,
				Lower: gridTestLower, Upper: gridTestUpper, Levels: 6,
				QuoteBudget: 22, FeeRate: 0.001,
			}
			eng, err := BuildGridEngine(cfg, tt.price, paper, newMemoryGridFillLog(), DiscardLogger())
			if err != nil {
				t.Fatalf("构造不该失败（拦的是启动）: %v", err)
			}
			startErr := eng.Start(time.Now().UTC())
			if startErr == nil {
				t.Fatalf("价格 %g 不在区间 %g–%g 里，启动必须被拒",
					tt.price, gridTestLower, gridTestUpper)
			}
			var re *ReasonError
			if !errors.As(startErr, &re) || re.Reason != ReasonGridPriceOutOfRange {
				t.Fatalf("原因应是 %s，得到 %v", ReasonGridPriceOutOfRange, startErr)
			}
			// 报错要带上当前价和区间 —— 只说"不在区间内"用户还得自己去对。
			if !strings.Contains(startErr.Error(), "区间") {
				t.Fatalf("报错要说清区间，得到: %v", startErr)
			}
			if eng.Running() {
				t.Fatal("被拒之后不该处于运行状态")
			}
		})
	}
}

// 价格落在区间内时必须能启动 —— 上面那条不能把正常情况一起拦掉。
func TestStartAcceptsPriceInsideRange(t *testing.T) {
	eng, _, _ := gridFixture(t, gridTestStart, 50)
	if !eng.Running() {
		t.Fatal("价格在区间内时应能启动")
	}
}

// 计划算不出来时构造就要失败，不能跑到第一拍才炸 ——
// 那时可能已经有钱在交易所上了。
func TestBuildGridEngineRejectsBadPlan(t *testing.T) {
	paper := NewPaperGrid(gridTestRules(), gridTestStart, 50)
	cfg := GridConfig{
		ID: 1, UserID: 7, ExchangeKeyID: 3,
		Symbol: gridTestSymbol, Mode: ModeTestnet,
		Lower: 1.0, Upper: 1.01, Levels: 30, // 每格 0.034%，远低于手续费
		QuoteBudget: 1000, FeeRate: 0.001,
	}
	if _, err := BuildGridEngine(cfg, 1.005, paper, newMemoryGridFillLog(), DiscardLogger()); err == nil {
		t.Fatal("过密的网格必须在构造时就被拒")
	}
}
