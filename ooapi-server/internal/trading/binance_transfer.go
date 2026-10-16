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

默认是币安现货主机。若目标主机确实是币安（域名里带 binance）而客户端本身
不是实盘，就拒绝 —— 现货账本与合约账本是两套互不连通的系统，而本客户端
的密钥是配给合约主机的，拿它去打现货主机只会拿到鉴权失败。
与其让币安回一个看不懂的错误码，不如在发请求之前就说清楚。
非币安主机一律放行：那是单测的 mock。
*/
func (c *USDMClient) spotTarget() (string, error) {
	c.mu.Lock()
	base := c.spotBase
	c.mu.Unlock()
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		base = BinanceSpotLiveBase
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", invalid("现货主机地址不正确")
	}
	if strings.Contains(strings.ToLower(u.Hostname()), "binance") && c.baseNetwork() != ModeLive {
		return "", invalid("现货接口只在实盘可用：现货与合约是两套独立账本，测网不连通")
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
