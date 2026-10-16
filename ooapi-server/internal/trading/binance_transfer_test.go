package trading

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

// transferFake 是一个只认划转端点的假现货主机，记录它收到了什么。
type transferFake struct {
	path   string
	method string
	query  url.Values
	apiKey string
	tranID int64
}

func (f *transferFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.path = r.URL.Path
	f.method = r.Method
	f.query = r.URL.Query()
	f.apiKey = r.Header.Get("X-MBX-APIKEY")
	id := f.tranID
	if id == 0 {
		id = 987654321
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"tranId": ` + strconv.FormatInt(id, 10) + `}`))
}

func newTransferClient(t *testing.T) (*USDMClient, *transferFake) {
	t.Helper()
	fake := &transferFake{}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	c.SetSpotBaseForTest(server.URL)
	if err := c.UseCredentials(Credentials{APIKey: "tf-key", APISecret: "tf-secret", Network: ModeTestnet}); err != nil {
		t.Fatal(err)
	}
	return c, fake
}

/*
方向映射是这条路径上最危险的地方：写反了就是把钱往相反方向划。

币安用 type 常量区分方向 —— MAIN_UMFUTURE 是现货→合约，
UMFUTURE_MAIN 是合约→现货。名字本身不直观，所以这里逐个断言。
*/
func TestTransferMapsDirectionToTheRightEndpointType(t *testing.T) {
	for _, tt := range []struct {
		from, to, want string
	}{
		{WalletSpot, WalletFutures, "MAIN_UMFUTURE"},
		{WalletFutures, WalletSpot, "UMFUTURE_MAIN"},
		// 大小写与空白不该改变方向。
		{" Spot ", WalletFutures, "MAIN_UMFUTURE"},
		{"FUTURES", WalletSpot, "UMFUTURE_MAIN"},
	} {
		t.Run(tt.from+"→"+tt.to, func(t *testing.T) {
			c, fake := newTransferClient(t)
			got, err := c.Transfer(TransferRequest{From: tt.from, Asset: "usdt", Amount: 2})
			if err != nil {
				t.Fatalf("划转失败: %v", err)
			}
			if fake.method != http.MethodPost {
				t.Fatalf("划转必须是 POST，得到 %s", fake.method)
			}
			if fake.path != "/sapi/v1/asset/transfer" {
				t.Fatalf("端点错: %s", fake.path)
			}
			if got := fake.query.Get("type"); got != tt.want {
				t.Fatalf("type=%q 期望 %q —— 方向写反会把钱划到对面", got, tt.want)
			}
			if got := fake.query.Get("asset"); got != "USDT" {
				t.Fatalf("asset 应归一成大写，得到 %q", got)
			}
			if got := fake.query.Get("amount"); got != "2" {
				t.Fatalf("amount=%q", got)
			}
			// 回报里的方向要让调用方能直接展示，不能只靠入参。
			if got.From != strings.ToLower(strings.TrimSpace(tt.from)) {
				t.Fatalf("结果 From=%q", got.From)
			}
			if got.To != tt.to {
				t.Fatalf("结果 To=%q 期望 %q", got.To, tt.to)
			}
			if got.TranID != 987654321 {
				t.Fatalf("tranId 没解析出来: %d", got.TranID)
			}
			if fake.apiKey != "tf-key" {
				t.Fatalf("API Key 头缺失: %q", fake.apiKey)
			}
		})
	}
}

/*
签名必须覆盖**实际发出去的那串参数**。

如果签名用的 payload 和请求里的参数不一致，币安会回 -1022（签名不对），
而那种错误很难从日志里看出到底哪一段不同 —— 所以这里把收到的参数
重新 HMAC 一遍，逐字节比对。
*/
func TestTransferSignatureCoversTheSentParameters(t *testing.T) {
	c, fake := newTransferClient(t)
	if _, err := c.Transfer(TransferRequest{From: WalletSpot, Asset: "USDT", Amount: 1.25}); err != nil {
		t.Fatalf("划转失败: %v", err)
	}
	sig := fake.query.Get("signature")
	if sig == "" {
		t.Fatal("请求里没有 signature")
	}
	unsigned := url.Values{}
	for k, v := range fake.query {
		if k == "signature" {
			continue
		}
		unsigned[k] = v
	}
	if unsigned.Get("timestamp") == "" || unsigned.Get("recvWindow") == "" {
		t.Fatalf("签名参数不全: %v", unsigned)
	}
	mac := hmac.New(sha256.New, []byte("tf-secret"))
	mac.Write([]byte(unsigned.Encode()))
	if want := hex.EncodeToString(mac.Sum(nil)); want != sig {
		t.Fatalf("签名与实际参数对不上\n  参数: %s\n  期望: %s\n  实际: %s", unsigned.Encode(), want, sig)
	}
}

func TestTransferRejectsBadInput(t *testing.T) {
	for _, tt := range []struct {
		name string
		req  TransferRequest
	}{
		{"方向不合法", TransferRequest{From: "wallet", Asset: "USDT", Amount: 1}},
		{"方向为空", TransferRequest{Asset: "USDT", Amount: 1}},
		{"资产为空", TransferRequest{From: WalletSpot, Amount: 1}},
		{"数量为零", TransferRequest{From: WalletSpot, Asset: "USDT", Amount: 0}},
		{"数量为负", TransferRequest{From: WalletSpot, Asset: "USDT", Amount: -1}},
		{"数量为 NaN", TransferRequest{From: WalletSpot, Asset: "USDT", Amount: math.NaN()}},
		{"数量为 Inf", TransferRequest{From: WalletSpot, Asset: "USDT", Amount: math.Inf(1)}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, fake := newTransferClient(t)
			if _, err := c.Transfer(tt.req); err == nil {
				t.Fatal("非法入参必须被拒")
			}
			if fake.path != "" {
				t.Fatalf("被拒的请求不该发出去，却打到了 %s", fake.path)
			}
		})
	}
}

// 只读客户端（交易台读行情用的那种）不允许动钱。
func TestTransferRefusesReadOnlyClient(t *testing.T) {
	fake := &transferFake{}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	c := NewUSDMClient(server.URL)
	c.SetSpotBaseForTest(server.URL)
	c.readOnly = true
	if _, err := c.Transfer(TransferRequest{From: WalletSpot, Asset: "USDT", Amount: 1}); err == nil {
		t.Fatal("只读客户端必须拒绝划转")
	}
	if fake.path != "" {
		t.Fatalf("只读客户端不该发出请求，却打到了 %s", fake.path)
	}
}

/*
真币安现货主机 + 非实盘客户端必须被拒。

现货测网（testnet.binance.vision）与合约测网（testnet.binancefuture.com）
是两套互不连通的账本，划过去没有意义；与其让币安回一个看不懂的错误码，
不如在发请求之前就说清楚。判断依据是**目标主机**，不是客户端主机 ——
这样单测的 mock 主机仍然放行。
*/
func TestTransferRefusesRealBinanceSpotHostOnNonLiveClient(t *testing.T) {
	c, _ := newTransferClient(t)
	c.SetSpotBaseForTest(BinanceSpotLiveBase) // 真实现货主机，而客户端是测网
	_, err := c.Transfer(TransferRequest{From: WalletSpot, Asset: "USDT", Amount: 1})
	if err == nil {
		t.Fatal("测网客户端对真币安现货主机的划转必须被拒")
	}
	if !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("拒绝理由要能看懂（网络不一致），得到: %v", err)
	}
}

// 端点常量本身也要守住：MAIN_UMFUTURE / UMFUTURE_MAIN 是币安定的字符串，
// 改一个字就会划错方向或直接 400。
func TestTransferTypeConstants(t *testing.T) {
	if transferSpotToFutures != "MAIN_UMFUTURE" {
		t.Fatalf("现货→合约的方向常量被改动: %q", transferSpotToFutures)
	}
	if transferFuturesToSpot != "UMFUTURE_MAIN" {
		t.Fatalf("合约→现货的方向常量被改动: %q", transferFuturesToSpot)
	}
}
