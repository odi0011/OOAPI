package trading

import (
	"testing"
	"time"
)

/*
现货收到做空信号时**跳过**，不是把它翻成买入。

翻的话策略会在看跌的位置建立多头 —— 方向和信号完全相反，而且从界面上
看不出来（"开了仓、没报错"）。跳过是诚实的：这一步没有可执行的动作。
*/
func TestSpotSkipsShortSignal(t *testing.T) {
	cfg := testConfig()
	cfg.Market = MarketSpot
	eng := withSecrets(NewEngine(cfg, NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossDeath)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State == StateInPosition {
		t.Fatalf("现货不该在死叉上开仓: %+v", snap)
	}
	if snap.LastReason != ReasonSpotLongOnly {
		t.Fatalf("应报 %q 并保持空仓，得到 %+v", ReasonSpotLongOnly, snap)
	}
}

// 对照组：同一套行情在**合约**上照常开空 —— 证明上面被跳过的是"现货"，
// 而不是这条测试本身写错了。
func TestFuturesStillOpensShortInTheSameSetup(t *testing.T) {
	eng := withSecrets(NewEngine(testConfig(), NewPaper(), DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 2)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossDeath)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 2))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideShort {
		t.Fatalf("合约在死叉上应开空: %+v", snap)
	}
}

// 现货的金叉照常开多，而且杠杆记成 1（现货没有杠杆）。
func TestSpotOpensLongOnGoldenCross(t *testing.T) {
	cfg := testConfig()
	cfg.Market = MarketSpot
	// 现货没有杠杆，名义 = 保证金；默认的 1.7 够不到最小名义 5。
	cfg.MaxMarginUsdt = 10
	paper := NewPaper()
	eng := withSecrets(NewEngine(cfg, paper, DiscardLogger()))
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if err := eng.Start(calmStart(now, 20)); err != nil {
		t.Fatal(err)
	}
	candles := candlesUntil(t, CrossGolden)
	snap, err := eng.Step(stepAt(now, candles, candles[len(candles)-1].Close, 20))
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != StateInPosition || snap.Side != SideLong {
		t.Fatalf("现货金叉应开多: %+v", snap)
	}
	// 下单时用的杠杆必须是 1 —— 现货没有杠杆，名义得等于保证金。
	if paper.Leverage != 1 {
		t.Fatalf("现货下单杠杆必须是 1，得到 %d", paper.Leverage)
	}
	if !(snap.StopPrice < snap.EntryPrice) || !(snap.TakeProfitPrice > snap.EntryPrice) {
		t.Fatalf("多头保护价方向不对: %+v", snap)
	}
}

/*
market 是「合约还是现货」这条轴，与 mode（测网/实盘）**正交** ——
四种组合都成立。这里把归一与两个派生规则钉住。
*/
func TestNormalizeMarketDefaultsToFutures(t *testing.T) {
	for _, in := range []string{"", "  ", "futures", "FUTURES", " Futures "} {
		if got := NormalizeMarket(in); got != MarketFutures {
			t.Fatalf("NormalizeMarket(%q) = %q，空值与 futures 都应归一到 futures", in, got)
		}
	}
	for _, in := range []string{"spot", "SPOT", " Spot "} {
		if got := NormalizeMarket(in); got != MarketSpot {
			t.Fatalf("NormalizeMarket(%q) = %q", in, got)
		}
	}
	// 未知值兜成 futures：老库补列前读出来就是空串，那些是合约策略，
	// 不能因为多了个字段就让既有策略变成「未知市场」而拒绝启动。
	if got := NormalizeMarket("乱七八糟"); got != MarketFutures {
		t.Fatalf("未知值应兜成 futures，得到 %q", got)
	}
}

func TestConfigIsSpot(t *testing.T) {
	if (Config{}).IsSpot() {
		t.Fatal("空 market 不是现货")
	}
	if !(Config{Market: "spot"}).IsSpot() {
		t.Fatal("spot 应判为现货")
	}
	if (Config{Market: "futures"}).IsSpot() {
		t.Fatal("futures 不是现货")
	}
}

/*
现货没有杠杆：Normalize 把杠杆钉成 1。

这不是「顺便」——它同时保证两件事：
  · 名义 = 保证金（现货就是花掉多少买多少）；
  · IsolatedLiqPrice 算出 liq ≈ entry×0.005 ≈ 0，
    于是 StopWithinLiquidation 天然通过，**风控数学不用为现货改**。
*/
func TestSpotForcesLeverageToOne(t *testing.T) {
	c := Config{Market: MarketSpot, Leverage: 20}.Normalize()
	if c.Leverage != 1 {
		t.Fatalf("现货杠杆必须钉成 1，得到 %d", c.Leverage)
	}
	// 顺带确认强平价的退化，这是「不用改风控」的依据。
	liq, err := IsolatedLiqPrice(SideLong, 100, c.Leverage, DefaultMaintMarginRate)
	if err != nil {
		t.Fatal(err)
	}
	if !(liq > 0 && liq < 1) {
		t.Fatalf("leverage=1 时强平价应趋近 0，得到 %v", liq)
	}
	if !StopWithinLiquidation(SideLong, 100, 98, liq) {
		t.Fatalf("强平价趋近 0 时，正常止损应通过检查（liq=%v）", liq)
	}
}

// 合约的杠杆不能被顺手也改成 1。
func TestFuturesKeepsLeverage(t *testing.T) {
	for _, in := range []string{"", "futures"} {
		c := Config{Market: in, Leverage: 20}.Normalize()
		if c.Leverage != 20 {
			t.Fatalf("market=%q 时不该动杠杆，得到 %d", in, c.Leverage)
		}
	}
}

/*
NewExchange 按「市场 + 网络」两条轴各选一套。

现货必须拿到 SpotExchange —— 它只做多、无杠杆、保护单走 STOP_LOSS_LIMIT，
和合约客户端是两套语义。选错了就是把现货当合约下单。
*/
func TestNewExchangePicksSpotEngineForSpotMarket(t *testing.T) {
	ex, err := NewExchange(Config{Market: MarketSpot, Mode: ModeTestnet})
	if err != nil {
		t.Fatalf("现货测网应能建出交易所，得到 %v", err)
	}
	if _, ok := ex.(*SpotExchange); !ok {
		t.Fatalf("现货应建出 *SpotExchange，得到 %T", ex)
	}

	// 合约侧不受影响：仍然是合约客户端。
	fut, err := NewExchange(Config{Market: MarketFutures, Mode: ModeTestnet})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := fut.(*SpotExchange); ok {
		t.Fatal("合约不该建出 SpotExchange")
	}

	// 空 market（老策略）走的也是合约。
	legacy, err := NewExchange(Config{Mode: ModeTestnet})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := legacy.(*SpotExchange); ok {
		t.Fatal("空 market 的老策略必须仍走合约")
	}
}

// 未知网络仍然是错误，不能悄悄建出一个客户端。
func TestNewExchangeRejectsBadModeForBothMarkets(t *testing.T) {
	for _, market := range []string{MarketFutures, MarketSpot} {
		if _, err := NewExchange(Config{Market: market, Mode: "不存在的网络"}); err == nil {
			t.Fatalf("market=%s 时未知网络必须报错", market)
		}
	}
}

// 现货实盘同样受测网门闩约束 —— 现货实盘也是真钱。
func TestSpotLiveRespectsTestnetGate(t *testing.T) {
	SetTestnetGreen(false)
	t.Cleanup(ResetTestnetGreen)
	if _, err := NewExchange(Config{Market: MarketSpot, Mode: ModeLive}); err == nil {
		t.Fatal("测网门闩关着时，现货实盘也必须被拒")
	}
	// 门闩打开后应当能建出来，证明被拒的确实是门闩而不是别的原因。
	SetTestnetGreen(true)
	if _, err := NewExchange(Config{Market: MarketSpot, Mode: ModeLive}); err != nil {
		t.Fatalf("门闩打开后现货实盘应能建出交易所，得到 %v", err)
	}
}
