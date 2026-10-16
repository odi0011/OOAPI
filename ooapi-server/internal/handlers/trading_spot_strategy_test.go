package handlers

import (
	"net/http"
	"testing"

	"ooapi/internal/trading"
)

/*
market 这条轴的落库与校验。

最要紧的是「现货落库杠杆必须是 1」：引擎侧本来也会归一（NewEngine 那次），
所以不钉也不会下错单；但**库里留着用户填的 20，界面就会显示"现货 20 倍杠杆"**
—— 一个不存在的设置，比多写三行更容易误导人。
*/
func TestStrategyMarketStoredAndSpotForcesLeverage(t *testing.T) {
	trading.ResetForTest()
	useTradingDB(t)
	owner := tradingUser(61)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys",
		`{"label":"主号","apiKey":"`+testAPIKey+`","apiSecret":"`+testAPISecret+`"}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))

	// ---- 现货：填 20 倍杠杆，落库必须被钉成 1 ----
	rec := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`,"market":"spot","leverage":20}`, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("创建现货策略失败: %d %s", rec.Code, rec.Body.String())
	}
	spot := tradingData(t, rec)
	if spot["market"] != "spot" {
		t.Fatalf("market 没落库: %v", spot["market"])
	}
	if spot["leverage"] != float64(1) {
		t.Fatalf("现货落库杠杆必须是 1，得到 %v（库里留 20 会让界面显示不存在的设置）", spot["leverage"])
	}

	// ---- 未知 market 必须被拒，而不是悄悄兜成 futures ----
	bad := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`,"market":"期货"}`, owner, "")
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("未知 market 应回 400，得到 %d %s", bad.Code, bad.Body.String())
	}

	// ---- 合约不受影响：杠杆原样保留 ----
	fut := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`,"market":"futures","leverage":20}`, owner, "")
	if fut.Code != http.StatusOK {
		t.Fatalf("创建合约策略失败: %d %s", fut.Code, fut.Body.String())
	}
	fd := tradingData(t, fut)
	if fd["leverage"] != float64(20) {
		t.Fatalf("合约杠杆不该被改，得到 %v", fd["leverage"])
	}
	if fd["market"] != "futures" {
		t.Fatalf("market 应为 futures，得到 %v", fd["market"])
	}

	// ---- 老策略不带 market：必须仍按合约，杠杆不变 ----
	legacy := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`,"leverage":20}`, owner, "")
	if legacy.Code != http.StatusOK {
		t.Fatalf("创建老式策略失败: %d %s", legacy.Code, legacy.Body.String())
	}
	ld := tradingData(t, legacy)
	if ld["market"] != "futures" {
		t.Fatalf("不带 market 的老策略应回 futures，得到 %v", ld["market"])
	}
	if ld["leverage"] != float64(20) {
		t.Fatalf("老策略杠杆不该被动，得到 %v", ld["leverage"])
	}
}
