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

// SpotBalance 是现货钱包里的一个币种。
type SpotBalance struct {
	Asset  string
	Free   float64
	Locked float64
	Total  float64
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
