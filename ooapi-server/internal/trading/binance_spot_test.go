package trading

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// spotFake 是只认 /api/v3/account 的假现货主机。
type spotFake struct {
	body   string
	path   string
	method string
	query  url.Values
	apiKey string
	status int
}

func (f *spotFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.path = r.URL.Path
	f.method = r.Method
	f.query = r.URL.Query()
	f.apiKey = r.Header.Get("X-MBX-APIKEY")
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(f.body))
}

func newSpotClient(t *testing.T, body string) (*USDMClient, *spotFake) {
	t.Helper()
	fake := &spotFake{body: body}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	c.SetSpotBaseForTest(server.URL)
	if err := c.UseCredentials(Credentials{APIKey: "sp-key", APISecret: "sp-secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	return c, fake
}

/*
现货把金额写成字符串，合约写成数字 —— 同一个字段两种形状都出现过。

这条测试用一份混合的响应：free 是字符串、locked 是数字、还有一个用
科学计数法，全部都要能解析出来。解析整包失败会把一个正常响应变成
「余额读取失败」，那是最难查的一类故障。
*/
func TestSpotBalancesParsesMixedAmountShapes(t *testing.T) {
	c, fake := newSpotClient(t, `{
		"makerCommission": 10,
		"balances": [
			{"asset":"usdt","free":"472.79900000","locked":"0.00000000"},
			{"asset":"DOGE","free":123.5,"locked":0.25},
			{"asset":"BTC","free":"1e-8","locked":"0"}
		]
	}`)
	got, err := c.SpotBalances()
	if err != nil {
		t.Fatalf("读余额失败: %v", err)
	}
	if fake.path != "/api/v3/account" || fake.method != http.MethodGet {
		t.Fatalf("端点/方法错: %s %s", fake.method, fake.path)
	}
	if fake.query.Get("omitZeroBalances") != "true" {
		t.Fatalf("没带 omitZeroBalances: %v", fake.query)
	}
	if fake.query.Get("signature") == "" {
		t.Fatal("私有账户读必须签名")
	}
	if fake.apiKey != "sp-key" {
		t.Fatalf("API Key 头缺失: %q", fake.apiKey)
	}

	byAsset := map[string]SpotBalance{}
	for _, b := range got {
		byAsset[b.Asset] = b
	}
	if b := byAsset["USDT"]; b.Free != 472.799 || b.Total != 472.799 {
		t.Fatalf("字符串金额没解析对: %+v", b)
	}
	if b := byAsset["DOGE"]; b.Free != 123.5 || b.Locked != 0.25 || b.Total != 123.75 {
		t.Fatalf("数字金额没解析对: %+v", b)
	}
	if b := byAsset["BTC"]; b.Total != 1e-8 {
		t.Fatalf("科学计数法没解析对: %+v", b)
	}
	// 资产名归一成大写，免得调用方要自己处理大小写。
	for _, b := range got {
		if b.Asset != strings.ToUpper(b.Asset) {
			t.Fatalf("资产名应大写: %q", b.Asset)
		}
	}
	// 金额大的排前面 —— 界面上第一眼要看到主资产。
	if len(got) < 2 || got[0].Total < got[1].Total {
		t.Fatalf("应按金额降序: %+v", got)
	}
}

func TestSpotBalancesDropsZeroRows(t *testing.T) {
	// 即使币安忽略了 omitZeroBalances 参数把空余额也回了，本地也要滤掉。
	c, _ := newSpotClient(t, `{"balances":[
		{"asset":"USDT","free":"0.00000000","locked":"0.00000000"},
		{"asset":"DOGE","free":"0","locked":"0"},
		{"asset":"XRP","free":"3","locked":"0"},
		{"asset":"","free":"9","locked":"0"}
	]}`)
	got, err := c.SpotBalances()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Asset != "XRP" {
		t.Fatalf("零余额与空资产名都应被滤掉，得到 %+v", got)
	}
}

func TestSpotBalancesEmptyIsEmptyNotNil(t *testing.T) {
	c, _ := newSpotClient(t, `{"balances":[]}`)
	got, err := c.SpotBalances()
	if err != nil {
		t.Fatal(err)
	}
	// 返回 nil 会让 JSON 序列化成 null，前端 .map 会炸。
	if got == nil {
		t.Fatal("空余额应回空切片而不是 nil")
	}
	if len(got) != 0 {
		t.Fatalf("应无余额: %+v", got)
	}
}

func TestSpotBalancesRejectsMalformedBody(t *testing.T) {
	c, _ := newSpotClient(t, `{"balances": "不是数组"}`)
	if _, err := c.SpotBalances(); err == nil {
		t.Fatal("畸形响应必须报错，不能当空余额返回")
	}
}

func TestSpotBalancesSurfacesBinanceError(t *testing.T) {
	fake := &spotFake{body: `{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}`, status: http.StatusUnauthorized}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	c.SetSpotBaseForTest(server.URL)
	if err := c.UseCredentials(Credentials{APIKey: "sp-key", APISecret: "sp-secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	_, err := c.SpotBalances()
	if err == nil {
		t.Fatal("币安报错时必须把错误透出")
	}
	// -2015 是「密钥没开现货权限」，管理员要能一眼看出来。
	if !strings.Contains(err.Error(), "-2015") && !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("错误信息应保留币安的码或原文: %v", err)
	}
}

// 真币安现货主机 + 非实盘客户端 = 拒绝（密钥是配给合约主机的，去了也白去）。
func TestSpotBalancesRefusesRealBinanceHostOnNonLiveClient(t *testing.T) {
	c, _ := newSpotClient(t, `{"balances":[]}`)
	c.SetSpotBaseForTest(BinanceSpotLiveBase)
	_, err := c.SpotBalances()
	if err == nil {
		t.Fatal("测网客户端不该去打真币安现货主机")
	}
	if !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("拒绝理由要能看懂（网络不一致）: %v", err)
	}
}

// 没配凭据时不给出发请求，直接报「密钥不可用」。
func TestSpotBalancesRequiresCredentials(t *testing.T) {
	fake := &spotFake{body: `{"balances":[]}`}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	c.SetSpotBaseForTest(server.URL)
	if _, err := c.SpotBalances(); err == nil {
		t.Fatal("无凭据必须被拒")
	}
	if fake.path != "" {
		t.Fatalf("无凭据不该发出请求，却打到了 %s", fake.path)
	}
}
