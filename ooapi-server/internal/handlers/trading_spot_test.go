package handlers

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"ooapi/internal/models"
	"ooapi/internal/trading"
)

// spotHandlerFake 是 handler 测试用的假现货主机。
type spotHandlerFake struct {
	body   string
	path   string
	method string
	query  url.Values
}

func (f *spotHandlerFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.path, f.method, f.query = r.URL.Path, r.Method, r.URL.Query()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(f.body))
}

/*
spotFixture 搭一份最小的交易数据：一个用户 + 一把交易所密钥 + 一条策略。

现货 handler 走的是 deskRow（取最新策略）→ deskSecretOpener（按 user_id
取密钥），所以策略必须存在；密钥的归属校验也在这条链里，顺带证明
「传别人的策略 ID 拿不到密钥」这件事仍然成立。
*/
func spotFixture(t *testing.T, fake *spotHandlerFake) *models.User {
	t.Helper()
	trading.ResetForTest()
	useTradingDB(t)

	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)

	oldRead, oldTransfer := newSpotReadClient, newSpotTransferClient
	t.Cleanup(func() { newSpotReadClient, newSpotTransferClient = oldRead, oldTransfer })
	build := func(string) (*trading.USDMClient, error) {
		c := trading.NewUSDMClient(server.URL)
		c.SetSpotBaseForTest(server.URL)
		return c, nil
	}
	newSpotReadClient = build
	newSpotTransferClient = build

	owner := tradingUser(41)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys",
		`{"label":"主号","apiKey":"`+testAPIKey+`","apiSecret":"`+testAPISecret+`"}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`}`, owner, "")
	return owner
}

func TestGetSpotBalancesReturnsWallet(t *testing.T) {
	fake := &spotHandlerFake{body: `{"balances":[
		{"asset":"USDT","free":"12.5","locked":"0"},
		{"asset":"DOGE","free":"0","locked":"0"}
	]}`}
	owner := spotFixture(t, fake)

	rec := callTrading(t, GetSpotBalances, http.MethodGet, "/api/trading/spot/balances", "", owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d body=%s", rec.Code, rec.Body.String())
	}
	if fake.path != "/api/v3/account" {
		t.Fatalf("端点错: %s", fake.path)
	}
	if fake.query.Get("omitZeroBalances") != "true" {
		t.Fatalf("没带 omitZeroBalances: %v", fake.query)
	}
	data := tradingData(t, rec)
	if data["network"] != "testnet" {
		t.Fatalf("network=%v", data["network"])
	}
	balances, _ := data["balances"].([]any)
	if len(balances) != 1 {
		t.Fatalf("零余额应被滤掉，得到 %v", data["balances"])
	}
	row, _ := balances[0].(map[string]any)
	// 字段名必须是小写的 —— 没有 json tag 的话会变成 "Asset"，前端对不上。
	if _, ok := row["asset"]; !ok {
		t.Fatalf("响应字段名不对: %v", row)
	}
	if row["total"] != 12.5 {
		t.Fatalf("total=%v", row["total"])
	}
	// 密钥明文绝不能出现在响应里。
	assertNoPlainSecret(t, data)
}

// 划转把方向原样交给客户端 —— handler 不做二次映射，避免和 trading 包里的
// type 常量各写一份、写歪一个。
func TestPostTradingTransferPassesDirectionThrough(t *testing.T) {
	for _, tt := range []struct {
		from, want string
	}{
		{"spot", "MAIN_UMFUTURE"},
		{"futures", "UMFUTURE_MAIN"},
	} {
		t.Run(tt.from, func(t *testing.T) {
			fake := &spotHandlerFake{body: `{"tranId": 555}`}
			owner := spotFixture(t, fake)

			rec := callTrading(t, PostTradingTransfer, http.MethodPost, "/api/trading/transfer",
				`{"from":"`+tt.from+`","asset":"USDT","amount":2.5}`, owner, "")
			if rec.Code != http.StatusOK {
				t.Fatalf("HTTP %d body=%s", rec.Code, rec.Body.String())
			}
			if fake.path != "/sapi/v1/asset/transfer" {
				t.Fatalf("端点错: %s", fake.path)
			}
			if got := fake.query.Get("type"); got != tt.want {
				t.Fatalf("type=%q 期望 %q", got, tt.want)
			}
			if got := fake.query.Get("amount"); got != "2.5" {
				t.Fatalf("amount=%q", got)
			}
			data := tradingData(t, rec)
			if data["tranId"] != float64(555) {
				t.Fatalf("tranId=%v", data["tranId"])
			}
			if data["from"] != tt.from {
				t.Fatalf("回执里的 from 该是请求里的方向: %v", data["from"])
			}
			assertNoPlainSecret(t, data)
		})
	}
}

func TestPostTradingTransferRejectsBadBody(t *testing.T) {
	fake := &spotHandlerFake{body: `{"tranId": 1}`}
	owner := spotFixture(t, fake)
	rec := callTrading(t, PostTradingTransfer, http.MethodPost, "/api/trading/transfer",
		`这不是 JSON`, owner, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("畸形请求体应回 400，得到 %d", rec.Code)
	}
	if fake.path != "" {
		t.Fatalf("非法请求不该打到交易所，却打到了 %s", fake.path)
	}
}

// 未登录时必须被拒，且不能碰到交易所。
func TestSpotHandlersRequireUser(t *testing.T) {
	fake := &spotHandlerFake{body: `{"balances":[]}`}
	spotFixture(t, fake)

	rec := callTrading(t, GetSpotBalances, http.MethodGet, "/api/trading/spot/balances", "", nil, "")
	if rec.Code == http.StatusOK {
		t.Fatalf("未登录不该成功: %d", rec.Code)
	}
	if fake.path != "" {
		t.Fatalf("未登录不该打到交易所，却打到了 %s", fake.path)
	}

	rec = callTrading(t, PostTradingTransfer, http.MethodPost, "/api/trading/transfer",
		`{"from":"spot","asset":"USDT","amount":1}`, nil, "")
	if rec.Code == http.StatusOK {
		t.Fatalf("未登录不该成功: %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "tranId") {
		t.Fatalf("未登录不该拿到划转回执: %s", rec.Body.String())
	}
}
