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

// UserTrade 是币安 /fapi/v1/userTrades 的一笔成交。同一 orderId 可以有多笔。
type UserTrade struct {
	Symbol          string
	TradeID         int64
	OrderID         string
	Side            string
	PositionSide    string
	Price           float64
	Qty             float64
	Commission      float64
	CommissionAsset string
	RealizedPnl     float64
	Time            time.Time
}

// UserTrades 读取 since 到 now 的成交。价格只认成交价，不读标记价。
func (c *USDMClient) UserTrades(symbol string, since, now time.Time) ([]UserTrade, error) {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	since = since.UTC()
	now = now.UTC()
	if symbol == "" || since.IsZero() {
		return nil, invalid("缺少成交起点")
	}
	if now.Before(since) {
		now = since
	}
	var all []UserTrade
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
			body, err := c.signed(http.MethodGet, "/fapi/v1/userTrades", q)
			if err != nil {
				return nil, err
			}
			rows, err := parseOrderTrades(body)
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

func parseOrderTrades(body []byte) ([]UserTrade, error) {
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	var raw []struct {
		Symbol          string          `json:"symbol"`
		ID              json.RawMessage `json:"id"`
		OrderID         json.RawMessage `json:"orderId"`
		Side            string          `json:"side"`
		PositionSide    string          `json:"positionSide"`
		Price           json.RawMessage `json:"price"`
		Qty             json.RawMessage `json:"qty"`
		Commission      json.RawMessage `json:"commission"`
		CommissionAsset string          `json:"commissionAsset"`
		RealizedPnl     json.RawMessage `json:"realizedPnl"`
		Time            json.RawMessage `json:"time"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, errors.New("成交数据无法解析")
	}
	out := make([]UserTrade, 0, len(raw))
	for _, row := range raw {
		price, err := rawFloat(row.Price)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		qty, err := rawFloat(row.Qty)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		commission, err := rawFloat(row.Commission)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		realized, err := rawFloat(row.RealizedPnl)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		whenMS, err := rawFloat(row.Time)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		tradeID, err := rawFloat(row.ID)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		orderID, err := rawFloat(row.OrderID)
		if err != nil {
			return nil, errors.New("成交数据无法解析")
		}
		out = append(out, UserTrade{
			Symbol:          strings.ToUpper(strings.TrimSpace(row.Symbol)),
			TradeID:         int64(tradeID),
			OrderID:         strconv.FormatInt(int64(orderID), 10),
			Side:            strings.ToUpper(strings.TrimSpace(row.Side)),
			PositionSide:    strings.ToUpper(strings.TrimSpace(row.PositionSide)),
			Price:           price,
			Qty:             qty,
			Commission:      commission,
			CommissionAsset: strings.ToUpper(strings.TrimSpace(row.CommissionAsset)),
			RealizedPnl:     realized,
			Time:            time.UnixMilli(int64(whenMS)).UTC(),
		})
	}
	return out, nil
}
