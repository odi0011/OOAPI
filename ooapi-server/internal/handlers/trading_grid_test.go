package handlers

import (
	"net/http"
	"testing"

	"ooapi/internal/trading"
)

/*
网格接口的测试。

重点放在 **preview** 上：它是这个模块里唯一一个"只算不下单"的接口，
而它要回答的正是用户真正的问题 —— "我这个账户到底能不能跑、要多少钱"。
CRUD 的其余部分靠的是已经过测的 SQL 路径和 trading 包里的引擎，
而引擎本身在 trading 包里有完整的撮合测试。

建出口用内存撮合（trading.PaperGrid），所以这些用例不碰网络。
*/

func gridPreviewClient(t *testing.T, price float64) {
	t.Helper()
	old := newGridExchange
	t.Cleanup(func() { newGridExchange = old })
	rules := trading.GridRules{
		BaseAsset: "DOGE", QuoteAsset: "USDT",
		StepSize: 1, MinQty: 1, TickSize: 0.00001, MinNotional: 1,
	}
	paper := trading.NewPaperGrid(rules, price, 100)
	paper.SetFee(trading.SpotDefaultFeeRate)
	newGridExchange = func(string) (trading.GridExchange, error) { return paper, nil }
}

/*
preview 要给出两个资金档位，并且说清门槛是被哪一项顶起来的。

这两个数是这个模块对用户最有价值的输出：

	MinBudget          刚刚能跑（收益可能薄得看不见）
	ComfortableBudget  零头不超过收益的一成

只说一个都不行 —— 前者会让用户按那个数充钱然后发现白忙，
后者会让他以为门槛高得离谱。
*/
func TestGridPreviewReportsCapitalRequirement(t *testing.T) {
	useTradingDB(t)
	trading.ResetGridForTest()
	gridPreviewClient(t, 0.0800)
	owner := tradingUser(21)

	rec := callTrading(t, PostGridPreview, http.MethodPost, "/api/trading/grids/preview", `{
		"symbol":"DOGEUSDT","lower":0.075,"upper":0.085,"levels":6,
		"quoteBudget":22,"mode":"testnet"
	}`, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d body=%s", rec.Code, rec.Body.String())
	}
	data := tradingData(t, rec)
	if data["ok"] != true {
		t.Fatalf("这份计划应当可行: %v", data["message"])
	}

	need, ok := data["requirement"].(map[string]any)
	if !ok {
		t.Fatalf("响应里应有资金门槛: %v", data)
	}
	minBudget, _ := need["minBudget"].(float64)
	comfortable, _ := need["comfortableBudget"].(float64)
	if minBudget <= 0 || comfortable <= 0 {
		t.Fatalf("两个档位都要有正数: %v", need)
	}
	if comfortable <= minBudget {
		t.Fatalf("舒服档（%.2f）必须高于最低档（%.2f）", comfortable, minBudget)
	}
	// DOGE 的步长是 1，零头门槛会把"最少要多少钱"顶到 20 USDT 上下，
	// 而不是"最小名义 1 × 6 条线 = 6 USDT"。这个差别是这整个模块
	// 最反直觉的一条，必须钉住。
	if minBudget < 15 || minBudget > 40 {
		t.Fatalf("DOGE 6 线的最低资金应在 15–40 USDT，得到 %.2f", minBudget)
	}
	if need["limitedBy"] != trading.GridLimitedByDust {
		t.Fatalf("DOGE 的门槛应由步长零头顶起，得到 %v", need["limitedBy"])
	}
	// 过线之后有效收益应当**很小但为正** —— 那正是"能跑但薄"的含义。
	eff, _ := need["effectivePctAtMin"].(float64)
	if eff <= 0 {
		t.Fatalf("过线之后有效收益应为正，得到 %v", eff)
	}
	if eff > 0.01 {
		t.Fatalf("刚过线时有效收益不该有 1%% 那么多，得到 %v", eff)
	}
}

// 资金不够时 preview 不报 500，而是**如实回一份不可行的说明** ——
// 用户调参数的每一次尝试都会打这个接口，它不该以"服务器错误"收场。
func TestGridPreviewExplainsWhyNotViable(t *testing.T) {
	useTradingDB(t)
	trading.ResetGridForTest()
	gridPreviewClient(t, 0.0800)
	owner := tradingUser(22)

	rec := callTrading(t, PostGridPreview, http.MethodPost, "/api/trading/grids/preview", `{
		"symbol":"DOGEUSDT","lower":0.075,"upper":0.085,"levels":6,
		"quoteBudget":3,"mode":"testnet"
	}`, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("不可行不是服务器错误，HTTP %d body=%s", rec.Code, rec.Body.String())
	}
	data := tradingData(t, rec)
	if data["ok"] != false {
		t.Fatal("3 USDT 撑不起 6 条线，ok 应为 false")
	}
	msg, _ := data["message"].(string)
	if msg == "" {
		t.Fatal("不可行时必须给出原因文案")
	}
	// 机器可读的原因码要一并给出，前端才能按原因高亮。
	if data["reason"] != trading.ReasonGridStepTooCoarse && data["reason"] != trading.ReasonGridBudgetTooSmall {
		t.Fatalf("应给出可判定的原因码，得到 %v（文案：%s）", data["reason"], msg)
	}
	// 即使计划不合法，资金门槛也要能算出来 —— 那正是用户此刻最需要看的数。
	if _, ok := data["requirement"].(map[string]any); !ok {
		t.Fatalf("不可行时也要给出该区间的资金门槛: %v", data)
	}
}

// 过密的区间要被拦下，而且原因要说"太密"，不是笼统的参数不对。
func TestGridPreviewRejectsTooTightSpacing(t *testing.T) {
	useTradingDB(t)
	trading.ResetGridForTest()
	gridPreviewClient(t, 1.005)
	owner := tradingUser(23)

	rec := callTrading(t, PostGridPreview, http.MethodPost, "/api/trading/grids/preview", `{
		"symbol":"DOGEUSDT","lower":1.0,"upper":1.01,"levels":30,
		"quoteBudget":1000,"mode":"testnet"
	}`, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d body=%s", rec.Code, rec.Body.String())
	}
	data := tradingData(t, rec)
	if data["ok"] != false {
		t.Fatal("每格 0.05%% 盖不住 0.2%% 的手续费，必须不可行")
	}
	if data["reason"] != trading.ReasonGridSpacingTooTight {
		t.Fatalf("原因应是 %s，得到 %v：%v",
			trading.ReasonGridSpacingTooTight, data["reason"], data["message"])
	}
}

// 未登录必须被拒，且不能碰交易对规则（那是一次网络请求）。
func TestGridPreviewRequiresUser(t *testing.T) {
	useTradingDB(t)
	trading.ResetGridForTest()
	called := false
	old := newGridExchange
	t.Cleanup(func() { newGridExchange = old })
	newGridExchange = func(string) (trading.GridExchange, error) {
		called = true
		return nil, trading.ErrBadMode
	}
	rec := callTrading(t, PostGridPreview, http.MethodPost, "/api/trading/grids/preview",
		`{"symbol":"DOGEUSDT","lower":0.075,"upper":0.085,"levels":6,"mode":"testnet"}`, nil, "")
	if rec.Code == http.StatusOK {
		t.Fatalf("未登录不该成功: %d", rec.Code)
	}
	if called {
		t.Fatal("未登录不该走到交易所那一步")
	}
}

// 畸形请求体要被拦在本地，不是拿一个空 symbol 去打交易所。
func TestGridPreviewRejectsBadBody(t *testing.T) {
	useTradingDB(t)
	trading.ResetGridForTest()
	gridPreviewClient(t, 0.08)
	owner := tradingUser(24)
	rec := callTrading(t, PostGridPreview, http.MethodPost, "/api/trading/grids/preview",
		`这不是 JSON`, owner, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("畸形请求体应回 400，得到 %d", rec.Code)
	}
}
