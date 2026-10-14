package trading

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const incomeWindow = 7 * 24 * time.Hour

// IncomeRefresh 是向币安重拉已实现盈亏的间隔。两次之间沿用上一份成功的结果。
const IncomeRefresh = 45 * time.Second

// shanghaiLoc 是 Asia/Shanghai，无夏令时，固定 UTC+8。
var shanghaiLoc = time.FixedZone("Asia/Shanghai", 8*60*60)

// shanghai 与 shanghaiLoc 是同一个时区，测试和汇总都用它。
var shanghai = shanghaiLoc

// IncomeEvent 是币安 /fapi/v1/income 的一行。
type IncomeEvent struct {
	Symbol     string
	Asset      string
	IncomeType string
	Income     float64
	Time       time.Time
}

// ShanghaiDayStart 返回 now 所在 Asia/Shanghai 自然日的 0 点。
func ShanghaiDayStart(now time.Time) time.Time {
	return shanghaiDayStart(now)
}

// SumSymbolIncome 把该交易对的 REALIZED_PNL、COMMISSION、FUNDING_FEE 加总。
// day 从上海当日 0 点（不早于 since）到 now，cumulative 从 since 到 now。两端都含。
func SumSymbolIncome(rows []IncomeEvent, symbol string, since, now time.Time) (day, cumulative float64) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return 0, 0
	}
	if now.Before(since) {
		now = since
	}
	dayStart := shanghaiDayStart(now)
	if since.After(dayStart) {
		dayStart = since
	}
	for _, row := range rows {
		if !incomeTypes[strings.ToUpper(strings.TrimSpace(row.IncomeType))] {
			continue
		}
		if row.Symbol != "" && !strings.EqualFold(row.Symbol, symbol) {
			continue
		}
		when := row.Time.UTC()
		if when.Before(since) || when.After(now) {
			continue
		}
		cumulative += row.Income
		if !when.Before(dayStart) {
			day += row.Income
		}
	}
	return day, cumulative
}

// incomeTypes 是净已实现要加总的账单类型。转入转出不计入。
var incomeTypes = map[string]bool{
	"REALIZED_PNL": true,
	"COMMISSION":   true,
	"FUNDING_FEE":  true,
}

type incomeRow struct {
	Symbol     string
	Asset      string
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
// day 只含 now 所在 Asia/Shanghai 自然日（且不早于 since）的合计，cumulative 含 since 之后的全部。
// since 用策略创建时间，不用本次进程的启动时间。转入转出不计入。
func (c *USDMClient) RealizedIncome(symbol string, since, now time.Time) (day, cumulative float64, err error) {
	rows, err := c.IncomeHistory(symbol, since, now)
	if err != nil {
		return 0, 0, err
	}
	day, cumulative = SumSymbolIncome(rows, symbol, since, now)
	return day, cumulative, nil
}

// IncomeHistory 读 since 到 now 的账单。调用方自己决定哪些类型入账。
func (c *USDMClient) IncomeHistory(symbol string, since, now time.Time) ([]IncomeEvent, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return nil, invalid("缺少收益起点")
	}
	if now.Before(since) {
		now = since
	}
	rows, err := c.incomeRows(symbol, since, now)
	if err != nil {
		return nil, err
	}
	out := make([]IncomeEvent, len(rows))
	for i, row := range rows {
		out[i] = IncomeEvent{
			Symbol:     row.Symbol,
			Asset:      row.Asset,
			IncomeType: row.IncomeType,
			Income:     row.Income,
			Time:       row.Time,
		}
	}
	return out, nil
}

// AccountIncomeHistory 读账户级账单（不带 symbol）。看板今日盈亏用它。
//
// 走 30 秒缓存：账单接口权重是普通行情接口的数倍，而看板每轮刷新都读它；
// 键含凭据指纹与起点 —— 不同账号、不同窗口的账单不能互相命中。
// since 是上海日切起点，一天之内稳定；窗口尾部的 30 秒延迟对当日累计展示无影响。
func (c *USDMClient) AccountIncomeHistory(since, now time.Time) ([]IncomeEvent, error) {
	since = since.UTC()
	now = now.UTC()
	if since.IsZero() {
		return nil, invalid("缺少收益起点")
	}
	if now.Before(since) {
		now = since
	}
	key := marketCacheKey(c.base, "income", c.credentialFingerprint(), since.Format(time.RFC3339))
	return incomeCache.get(key, func() ([]IncomeEvent, error) {
		rows, err := c.incomeRows("", since, now)
		if err != nil {
			return nil, err
		}
		out := make([]IncomeEvent, len(rows))
		for i, row := range rows {
			out[i] = IncomeEvent{
				Symbol:     row.Symbol,
				Asset:      row.Asset,
				IncomeType: row.IncomeType,
				Income:     row.Income,
				Time:       row.Time,
			}
		}
		return out, nil
	})
}

// TodayTradePnL 是上海日切后 USDT 的交易盈亏（已实现+手续费+资金费），不含划转。
// allIncome 含当日全部 USDT 流水（含划转），用来反推日初钱包。
func TodayTradePnL(rows []IncomeEvent, now time.Time) (tradePnL, allIncome float64) {
	dayStart := shanghaiDayStart(now)
	now = now.UTC()
	for _, row := range rows {
		asset := strings.ToUpper(strings.TrimSpace(row.Asset))
		if asset != "" && asset != "USDT" {
			continue
		}
		when := row.Time.UTC()
		if when.Before(dayStart) || when.After(now) {
			continue
		}
		allIncome += row.Income
		if incomeTypes[strings.ToUpper(strings.TrimSpace(row.IncomeType))] {
			tradePnL += row.Income
		}
	}
	return tradePnL, allIncome
}

// IncomeParts 是一笔持仓期间账单里要计入净已实现的三项。转入转出不在里面。
// HasRealized 表示窗口里已经有 REALIZED_PNL 行，金额可以是 0。
type IncomeParts struct {
	RealizedPnL float64
	Commission  float64
	FundingFee  float64
	Rows        int
	HasRealized bool
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
			parts.HasRealized = true
		case "COMMISSION":
			parts.Commission += row.Income
		case "FUNDING_FEE":
			parts.FundingFee += row.Income
		}
		parts.Rows++
	}
	return parts, nil
}

// shanghaiDayStart 是 t 所在 Asia/Shanghai 自然日的 00:00。
func shanghaiDayStart(t time.Time) time.Time {
	if t.IsZero() {
		t = time.Now()
	}
	local := t.In(shanghaiLoc)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, shanghaiLoc)
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
			if symbol != "" {
				q.Set("symbol", symbol)
			}
			q.Set("startTime", strconv.FormatInt(cursor.UnixMilli(), 10))
			q.Set("endTime", strconv.FormatInt(end.UnixMilli(), 10))
			q.Set("limit", "1000")
			body, err := c.signedGET("/fapi/v1/income", q)
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
		Asset      string          `json:"asset"`
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
			Asset:      strings.ToUpper(strings.TrimSpace(row.Asset)),
			IncomeType: strings.ToUpper(strings.TrimSpace(row.IncomeType)),
			Income:     amount,
			Time:       time.UnixMilli(int64(whenMS)).UTC(),
		})
	}
	return out, nil
}
