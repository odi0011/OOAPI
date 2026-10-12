package trading

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const incomeWindow = 7 * 24 * time.Hour

// incomeTypes 是净已实现要加总的账单类型。转入转出不计入。
var incomeTypes = map[string]bool{
	"REALIZED_PNL": true,
	"COMMISSION":   true,
	"FUNDING_FEE":  true,
}

type incomeRow struct {
	Symbol     string
	IncomeType string
	Income     float64
	Time       time.Time
}

// CredentialsReady 表示签名读账户已经带上密钥。没有密钥时不去打已实现盈亏。
func (c *USDMClient) CredentialsReady() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.creds.APIKey != "" && c.creds.APISecret != ""
}

// RealizedIncome 汇总 since 之后该交易对的已实现盈亏、手续费和资金费。
// day 只含 now 所在 UTC 日（且不早于 since）的合计，cumulative 含 since 之后的全部。
func (c *USDMClient) RealizedIncome(symbol string, since, now time.Time) (day, cumulative float64, err error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return 0, 0, invalid("缺少收益起点")
	}
	if now.Before(since) {
		now = since
	}
	rows, err := c.incomeRows(symbol, since, now)
	if err != nil {
		return 0, 0, err
	}
	dayStart := utcDay(now)
	if since.After(dayStart) {
		dayStart = since
	}
	for _, row := range rows {
		if !incomeTypes[row.IncomeType] {
			continue
		}
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		if row.Time.Before(since) {
			continue
		}
		cumulative += row.Income
		if !row.Time.Before(dayStart) {
			day += row.Income
		}
	}
	return day, cumulative, nil
}

// IncomeParts 是一笔持仓期间账单里要计入净已实现的三项。转入转出不在里面。
type IncomeParts struct {
	RealizedPnL float64
	Commission  float64
	FundingFee  float64
	Rows        int
}

// Net 是已实现盈亏、手续费和资金费的合计。
func (p IncomeParts) Net() float64 {
	return p.RealizedPnL + p.Commission + p.FundingFee
}

// IncomeParts 汇总 since 到 now 该交易对的三项账单。Rows 只数这三项，用来判断成交是否已经入账。
func (c *USDMClient) IncomeParts(symbol string, since, now time.Time) (IncomeParts, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return IncomeParts{}, invalid("缺少收益起点")
	}
	if now.Before(since) {
		now = since
	}
	rows, err := c.incomeRows(symbol, since, now)
	if err != nil {
		return IncomeParts{}, err
	}
	var parts IncomeParts
	for _, row := range rows {
		if !incomeTypes[row.IncomeType] {
			continue
		}
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		if row.Time.Before(since) || row.Time.After(now) {
			continue
		}
		switch row.IncomeType {
		case "REALIZED_PNL":
			parts.RealizedPnL += row.Income
		case "COMMISSION":
			parts.Commission += row.Income
		case "FUNDING_FEE":
			parts.FundingFee += row.Income
		}
		parts.Rows++
	}
	return parts, nil
}

func (c *USDMClient) incomeRows(symbol string, since, now time.Time) ([]incomeRow, error) {
	var all []incomeRow
	for win := since; !win.After(now); {
		end := win.Add(incomeWindow)
		if end.After(now) {
			end = now
		}
		cursor := win
		for page := 0; page < 20; page++ {
			q := url.Values{}
			q.Set("symbol", symbol)
			q.Set("startTime", strconv.FormatInt(cursor.UnixMilli(), 10))
			q.Set("endTime", strconv.FormatInt(end.UnixMilli(), 10))
			q.Set("limit", "1000")
			body, err := c.signed(http.MethodGet, "/fapi/v1/income", q)
			if err != nil {
				return nil, err
			}
			rows, err := parseIncome(body)
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				break
			}
			all = append(all, rows...)
			if len(rows) < 1000 {
				break
			}
			next := rows[len(rows)-1].Time.Add(time.Millisecond)
			if !next.After(cursor) {
				break
			}
			cursor = next
		}
		if !end.Before(now) {
			break
		}
		win = end.Add(time.Millisecond)
	}
	return all, nil
}

func parseIncome(body []byte) ([]incomeRow, error) {
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var raw []struct {
		Symbol     string          `json:"symbol"`
		IncomeType string          `json:"incomeType"`
		Income     json.RawMessage `json:"income"`
		Time       json.RawMessage `json:"time"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, errors.New("收益数据无法解析")
	}
	out := make([]incomeRow, 0, len(raw))
	for _, row := range raw {
		amount, err := rawFloat(row.Income)
		if err != nil {
			return nil, errors.New("收益数据无法解析")
		}
		whenMS, err := rawFloat(row.Time)
		if err != nil {
			return nil, errors.New("收益数据无法解析")
		}
		out = append(out, incomeRow{
			Symbol:     strings.ToUpper(strings.TrimSpace(row.Symbol)),
			IncomeType: strings.ToUpper(strings.TrimSpace(row.IncomeType)),
			Income:     amount,
			Time:       time.UnixMilli(int64(whenMS)).UTC(),
		})
	}
	return out, nil
}
