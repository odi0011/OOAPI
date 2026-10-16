package trading

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

/*
现货 ↔ USDT-M 合约的钱包划转。

端点 `POST /sapi/v1/asset/transfer` 只在**现货主机**（api.binance.com）上，
合约主机 fapi.binance.com 没有这个接口 —— 所以这里不走 c.base，
而是显式打到现货主机（spotBase）。

测网不可用：现货测网（testnet.binance.vision）与合约测网
（testnet.binancefuture.com）是两套互不连通的账本，划转没有意义。
目标主机是真币安主机、而客户端本身不是实盘时会直接拒绝；单测用的
非币安主机（mock）放行，好让这条路径可测。

API Key 需要勾选「统一划转」权限，否则币安返回 -2015
（Invalid API-key, IP, or permissions for action）。那个错误原样透出，
不在这里改写成含糊的提示 —— 管理员要能一眼看出是权限没开。
*/

// BinanceSpotLiveBase 是现货 API 的主机，划转端点在这里。
const BinanceSpotLiveBase = "https://api.binance.com"

// BinanceSpotTestnetBase 是现货测网。它与合约测网
// （testnet.binancefuture.com）是**两套独立系统**：各有各的主机、账号与余额，
// 互不连通，所以现货测网的密钥在合约测网上用不了，反之亦然。
const BinanceSpotTestnetBase = "https://testnet.binance.vision"

// 钱包方向。
const (
	WalletSpot    = "spot"
	WalletFutures = "futures"
)

// 币安 universal transfer 的方向常量。写反了会把钱划到对面，所以用常量而不是字符串字面量。
const (
	transferSpotToFutures = "MAIN_UMFUTURE"
	transferFuturesToSpot = "UMFUTURE_MAIN"
)

// TransferRequest 一次划转请求。
type TransferRequest struct {
	From   string  // WalletSpot | WalletFutures
	Asset  string  // 例如 "USDT"
	Amount float64 // 正数
}

// TransferResult 币安对成功划转的回报。TranID 可用于对账。
type TransferResult struct {
	TranID int64
	Asset  string
	Amount float64
	From   string
	To     string
}

// SetSpotBaseForTest 把划转出口指到 mock 主机。生产不要调用。
func (c *USDMClient) SetSpotBaseForTest(base string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.spotBase = strings.TrimRight(strings.TrimSpace(base), "/")
	c.mu.Unlock()
}

/*
spotTarget 决定这次现货请求打到哪个主机。

取值顺序：
  1. spotBase（划转与现货余额用的显式出口，测试可以覆盖）；
  2. 否则，客户端自己的 base —— 现货交易客户端的 base 就是现货主机；
  3. 再否则，币安现货主机。

**网络必须一致**：密钥是按网络配的（testnet 的密钥在实盘主机上必然鉴权失败）。
目标若是真币安现货主机而客户端网络对不上，就在发请求之前说清楚，
而不是让币安回一个看不懂的错误码 —— 何况合约测网与现货测网本就是
两套互不连通的系统，跨过去也没有意义。

非币安主机一律放行：那是单测的 mock。
*/
func (c *USDMClient) spotTarget() (string, error) {
	if c == nil {
		return "", invalid("交易所客户端未初始化")
	}
	c.mu.Lock()
	spotBase := c.spotBase
	ownBase := c.base
	c.mu.Unlock()

	base := strings.TrimRight(strings.TrimSpace(spotBase), "/")
	if base == "" {
		own := strings.TrimRight(strings.TrimSpace(ownBase), "/")
		if u, err := url.Parse(own); err == nil && u.Host != "" {
			host := u.Hostname()
			/*
				两种情况下客户端自己的 base 就是现货出口，直接用它：
				  · 它本来就是现货主机 —— 现货交易客户端就是这么建的；
				  · 它不是币安主机 —— 单测的 mock。**这一条不能漏**：
				    漏了就会回落到真币安现货主机，测试会去打生产（或者在
				    真正的故障里悄悄换了出口）。
				只有「客户端在合约主机上、又没显式给现货出口」才回落到币安现货主机。
			*/
			if spotHostNetwork(host) != "" || !strings.Contains(strings.ToLower(host), "binance") {
				base = own
			}
		}
	}
	if base == "" {
		base = BinanceSpotLiveBase
	}

	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", invalid("现货主机地址不正确")
	}
	if want := spotHostNetwork(u.Hostname()); want != "" && c.baseNetwork() != want {
		return "", invalid("现货主机与客户端网络不一致：密钥按网络配置，跨网络请求只会鉴权失败")
	}
	return base, nil
}

// Transfer 在现货与 USDT-M 合约钱包之间划转。
//
// 刻意不做本地取整：数量精度由交易所校验，本地 round 错了会**静默少划**，
// 而宁可让币安报错也不要把用户的金额改掉。
func (c *USDMClient) Transfer(req TransferRequest) (TransferResult, error) {
	out := TransferResult{Asset: strings.ToUpper(strings.TrimSpace(req.Asset)), Amount: req.Amount}
	if c == nil {
		return out, invalid("交易所客户端未初始化")
	}
	// 只读客户端（交易台读行情用的那种）不允许动钱。
	if c.readOnly {
		return out, ErrLiveTransportDisabled
	}
	if err := c.guard(); err != nil {
		return out, err
	}
	target, err := c.spotTarget()
	if err != nil {
		return out, err
	}

	from := strings.ToLower(strings.TrimSpace(req.From))
	switch from {
	case WalletSpot:
		out.From, out.To = WalletSpot, WalletFutures
	case WalletFutures:
		out.From, out.To = WalletFutures, WalletSpot
	default:
		return out, invalid("划转方向只能是 spot 或 futures")
	}
	if out.Asset == "" {
		return out, invalid("划转必须指定资产")
	}
	if math.IsNaN(req.Amount) || math.IsInf(req.Amount, 0) || req.Amount <= 0 {
		return out, invalid("划转数量必须是有限正数")
	}

	kind := transferSpotToFutures
	if from == WalletFutures {
		kind = transferFuturesToSpot
	}
	params := url.Values{}
	params.Set("type", kind)
	params.Set("asset", out.Asset)
	params.Set("amount", strconv.FormatFloat(req.Amount, 'f', -1, 64))

	c.mu.Lock()
	creds := c.creds
	c.mu.Unlock()
	body, err := c.doAt(target, http.MethodPost, "/sapi/v1/asset/transfer", params, creds)
	if err != nil {
		return out, err
	}
	var resp struct {
		TranID int64 `json:"tranId"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return out, errors.New("划转返回无法解析")
	}
	out.TranID = resp.TranID
	return out, nil
}
