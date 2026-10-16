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
	body        string // /api/v3/account（现货）
	fundingBody string // /sapi/v1/asset/get-funding-asset（资金账户）
	path        string
	method      string
	query       url.Values
	paths       []string
}

func (f *spotHandlerFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.path, f.method, f.query = r.URL.Path, r.Method, r.URL.Query()
	f.paths = append(f.paths, r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	if strings.Contains(r.URL.Path, "get-funding-asset") {
		body := f.fundingBody
		if body == "" {
			body = `[]`
		}
		_, _ = w.Write([]byte(body))
		return
	}
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

/*
一次读两个钱包 —— 现货与资金账户。

只看现货会给出**错误的答案**：资金账户是另一个钱包，`/api/v3/account`
读不到它。"我账户里应该还有 4 刀"那次误判就是这么来的。
*/
func TestGetSpotBalancesReadsBothWallets(t *testing.T) {
	fake := &spotHandlerFake{
		body: `{"balances":[
			{"asset":"USDT","free":"12.5","locked":"0"},
			{"asset":"DOGE","free":"0","locked":"0"}
		]}`,
		fundingBody: `[{"asset":"USDT","free":"3.47","locked":"0","freeze":"0","withdrawing":"0"}]`,
	}
	owner := spotFixture(t, fake)

	rec := callTrading(t, GetSpotBalances, http.MethodGet, "/api/trading/spot/balances", "", owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d body=%s", rec.Code, rec.Body.String())
	}
	data := tradingData(t, rec)
	if data["network"] != "testnet" {
		t.Fatalf("network=%v", data["network"])
	}

	// 现货：零余额被滤掉，字段名是小写的（没 json tag 会变成 "Asset"）。
	spot, _ := data["spot"].([]any)
	if len(spot) != 1 {
		t.Fatalf("现货零余额应被滤掉，得到 %v", data["spot"])
	}
	row, _ := spot[0].(map[string]any)
	if _, ok := row["asset"]; !ok {
		t.Fatalf("响应字段名不对: %v", row)
	}
	if row["total"] != 12.5 {
		t.Fatalf("现货 total=%v", row["total"])
	}

	// 资金账户：钱在这里，必须一起读出来。
	funding, _ := data["funding"].([]any)
	if len(funding) != 1 {
		t.Fatalf("资金账户余额没读出来: %v（只读现货会得出错误的结论）", data["funding"])
	}
	frow, _ := funding[0].(map[string]any)
	if frow["asset"] != "USDT" || frow["total"] != 3.47 {
		t.Fatalf("资金账户余额不对: %v", frow)
	}
	// 两个钱包都要真的被访问过。
	visited := func(p string) bool {
		for _, item := range fake.paths {
			if item == p {
				return true
			}
		}
		return false
	}
	if !visited("/api/v3/account") || !visited("/sapi/v1/asset/get-funding-asset") {
		t.Fatalf("两个钱包的端点都该被访问: %v", fake.paths)
	}
	assertNoPlainSecret(t, data)
}

/*
资金账户读失败不拖垮整页：现货读到了就先给现货，把原因写在旁边。

一个钱包读不到（多半是密钥没开对应权限）不该让整个余额页打不开 ——
那样用户会以为"一个都没有"。
*/
func TestGetSpotBalancesSurvivesFundingFailure(t *testing.T) {
	fake := &spotHandlerFake{
		body:        `{"balances":[{"asset":"USDT","free":"1","locked":"0"}]}`,
		fundingBody: `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}`,
	}
	owner := spotFixture(t, fake)
	rec := callTrading(t, GetSpotBalances, http.MethodGet, "/api/trading/spot/balances", "", owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("现货读到了就该回 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	data := tradingData(t, rec)
	spot, _ := data["spot"].([]any)
	if len(spot) != 1 {
		t.Fatalf("现货余额应照常返回: %v", data["spot"])
	}
	if _, ok := data["fundingError"]; !ok {
		t.Fatal("资金账户读不到时应当写明原因")
	}
	funding, _ := data["funding"].([]any)
	if funding == nil || len(funding) != 0 {
		t.Fatalf("失败的资金账户应回空数组，得到 %v", data["funding"])
	}
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
