package trading

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

/*
现货（Spot）读取。

现货与合约是**两套主机、两套账本**：行情与账户在 api.binance.com，
合约在 fapi.binance.com。所以这里和划转一样走 spotTarget()，不碰 c.base。

余额上也是分开的 —— 合约钱包里的钱不会出现在现货余额里，要用 Transfer 划过去。
所以这一步必须能读：划转前后要对得上账，否则「划过去了没有」只能靠猜。
*/

// flexFloat 解析币安的金额字段。
//
// 现货接口把数量写成**字符串**（"472.799"），少数接口写成数字；
// 两种都要能吃下，否则解析整包失败会把一个正常的响应变成"余额读取失败"。
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(data []byte) error {
	if f == nil {
		return errors.New("nil")
	}
	text := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if text == "" || text == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return fmt.Errorf("金额字段无法解析: %s", data)
	}
	*f = flexFloat(v)
	return nil
}

// usdmBaseFor 按网络返回合约主机。现货接口复用它来定位同一把密钥所在的网络 ——
// 现货主机是固定的，网络只决定这把密钥该配哪台合约主机。
func usdmBaseFor(network string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(network)) {
	case ModeTestnet:
		return BinanceUSDMTestnetBase, nil
	case ModeLive:
		return BinanceUSDMLiveBase, nil
	default:
		return "", ErrBadMode
	}
}

// NewSpotReadClient 打开只读现货客户端：余额读取用它，不下单也不动钱。
func NewSpotReadClient(network string) (*USDMClient, error) {
	base, err := usdmBaseFor(network)
	if err != nil {
		return nil, err
	}
	client := NewUSDMClient(base)
	client.readOnly = true
	return client, nil
}

// NewSpotTransferClient 打开可写现货客户端，**只给钱包划转用**。
//
// 与 NewSpotReadClient 的唯一区别是它不是只读的 —— 划转要 POST，
// 只读客户端会被 doAt 直接拒掉。调用点只许调 Transfer。
func NewSpotTransferClient(network string) (*USDMClient, error) {
	base, err := usdmBaseFor(network)
	if err != nil {
		return nil, err
	}
	return NewUSDMClient(base), nil
}

// SpotBalance 是现货钱包里的一个币种。带 json tag —— 这个结构体会直接
// 出现在 API 响应里，没有 tag 的话字段名是大写的。
type SpotBalance struct {
	Asset  string  `json:"asset"`
	Free   float64 `json:"free"`
	Locked float64 `json:"locked"`
	Total  float64 `json:"total"`
}

/*
SpotBalances 读现货钱包的非零余额，金额大的排前面。

只回非零：币安给每个上架币种都开一行，全量回给调用方没有意义。
请求里带 omitZeroBalances，客户端再筛一遍 —— 万一币安忽略了这个参数
（或返回了零行），本地这一遍仍然保证调用方拿到的是干净数据。
*/
func (c *USDMClient) SpotBalances() ([]SpotBalance, error) {
	if c == nil {
		return nil, invalid("交易所客户端未初始化")
	}
	target, err := c.spotTarget()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	creds := c.creds
	c.mu.Unlock()
	if creds.APIKey == "" || creds.APISecret == "" {
		return nil, ErrKeyNotUsable
	}
	params := url.Values{}
	params.Set("omitZeroBalances", "true")
	body, err := c.doAt(target, http.MethodGet, "/api/v3/account", params, creds)
	if err != nil {
		return nil, err
	}
	return parseSpotBalances(body)
}

/*
readOnlyPostPaths 是「只读、但币安要求 POST」的端点白名单。

列在这里的每一个都必须**只读**。加新条目时要问一句：它会不会动钱或下单？
会的话就不能加 —— 只读客户端是靠这个白名单挡住写操作的。
*/
var readOnlyPostPaths = map[string]struct{}{
	"/sapi/v1/asset/get-funding-asset": {},
}

func readOnlyPostPath(path string) bool {
	_, ok := readOnlyPostPaths[path]
	return ok
}

/*
FundingBalances 读**资金账户**（Funding wallet）的余额。

它和现货账户是**两个钱包**：资金账户是 P2P、币安支付、部分划转的落点，
`/api/v3/account` 读不到它。只看现货会得出错误的结论 —— 这正是之前
「我账户里应该还有 4 刀」那次误判的来源：钱在资金账户里，而我只读了现货。

端点 `POST /sapi/v1/asset/get-funding-asset`，注意两点都与现货账户不同：

	· 是 **POST**（不是 GET）；
	· 返回的是一个**数组**，不是带 `balances` 键的对象。

公开参数可以不传（查全部资产）。
*/
func (c *USDMClient) FundingBalances() ([]SpotBalance, error) {
	if c == nil {
		return nil, invalid("交易所客户端未初始化")
	}
	target, err := c.spotTarget()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	creds := c.creds
	c.mu.Unlock()
	if creds.APIKey == "" || creds.APISecret == "" {
		return nil, ErrKeyNotUsable
	}
	body, err := c.doAt(target, http.MethodPost, "/sapi/v1/asset/get-funding-asset", url.Values{}, creds)
	if err != nil {
		return nil, err
	}
	return parseFundingBalances(body)
}

// parseFundingBalances 从资金账户的响应里取出非零余额。
//
// 字段比现货多三个：freeze / withdrawing / btcValuation。
// 前两个仍是用户的钱（只是被冻结或在提现途中），所以计入 total ——
// 「我还有多少」问的是总额，把冻结的扣掉会给出偏小的答案。
func parseFundingBalances(body []byte) ([]SpotBalance, error) {
	var rows []struct {
		Asset       string    `json:"asset"`
		Free        flexFloat `json:"free"`
		Locked      flexFloat `json:"locked"`
		Freeze      flexFloat `json:"freeze"`
		Withdrawing flexFloat `json:"withdrawing"`
	}
	if json.Unmarshal(body, &rows) != nil {
		return nil, errors.New("资金账户余额返回无法解析")
	}
	out := make([]SpotBalance, 0, len(rows))
	for _, row := range rows {
		asset := strings.ToUpper(strings.TrimSpace(row.Asset))
		if asset == "" {
			continue
		}
		free, locked := float64(row.Free), float64(row.Locked)
		total := free + locked + float64(row.Freeze) + float64(row.Withdrawing)
		if total <= 0 {
			continue
		}
		out = append(out, SpotBalance{Asset: asset, Free: free, Locked: locked, Total: total})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Total != out[j].Total {
			return out[i].Total > out[j].Total
		}
		return out[i].Asset < out[j].Asset
	})
	return out, nil
}

// parseSpotBalances 从 /api/v3/account 的响应里取出非零余额。
func parseSpotBalances(body []byte) ([]SpotBalance, error) {
	var resp struct {
		Balances []struct {
			Asset  string    `json:"asset"`
			Free   flexFloat `json:"free"`
			Locked flexFloat `json:"locked"`
		} `json:"balances"`
	}
	if json.Unmarshal(body, &resp) != nil {
		return nil, errors.New("现货余额返回无法解析")
	}
	out := make([]SpotBalance, 0, len(resp.Balances))
	for _, row := range resp.Balances {
		asset := strings.ToUpper(strings.TrimSpace(row.Asset))
		if asset == "" {
			continue
		}
		free, locked := float64(row.Free), float64(row.Locked)
		total := free + locked
		if total <= 0 {
			continue
		}
		out = append(out, SpotBalance{Asset: asset, Free: free, Locked: locked, Total: total})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Total != out[j].Total {
			return out[i].Total > out[j].Total
		}
		return out[i].Asset < out[j].Asset
	})
	return out, nil
}
