package handlers

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/models"
	"ooapi/internal/services"
	"ooapi/internal/trading"
)

// 交易台只读。状态条走引擎快照加当前策略；行情、持仓、委托另开 GET。
// 公开行情不签名。持仓和委托用已绑定账户的密钥签名，用完不写日志。
// 这些接口不下单，也不改 TRADING_TESTNET_GREEN。

const (
	deskKlineDefault = 100
	deskKlineMax     = 500
)

// 测试换成假交易所。生产实现只发 GET。
var newDeskBook = trading.NewDeskBook

type deskLevels struct {
	EntryPrice      float64 `json:"entryPrice,omitempty"`
	StopPrice       float64 `json:"stopPrice,omitempty"`
	LiqPrice        float64 `json:"liqPrice,omitempty"`
	TakeProfitPrice float64 `json:"takeProfitPrice,omitempty"`
}

type deskMarketView struct {
	StrategyID int64                `json:"strategyId"`
	Symbol     string               `json:"symbol"`
	Timeframe  string               `json:"timeframe"`
	Limit      int                  `json:"limit"`
	MarkPrice  float64              `json:"markPrice"`
	Klines     []trading.DeskCandle `json:"klines"`
	Levels     *deskLevels          `json:"levels,omitempty"`
}

// GetTradingMarket 返回当前策略周期上的公开 K 线和标记价。
// 引擎内存里有仓时带上入场、止损、止盈，供图上画参考线。
func GetTradingMarket(c *gin.Context) {
	_, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	limit, limErr := deskLimit(c)
	if limErr != nil {
		writeEngineErr(c, limErr)
		return
	}
	book, err := newDeskBook(row.Record.Mode)
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	symbol := strings.ToUpper(row.Record.Symbol)
	klines, err := book.Klines(symbol, row.Record.Timeframe, limit)
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	mark, err := book.MarkPrice(symbol)
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	if klines == nil {
		klines = []trading.DeskCandle{}
	}
	ok(c, deskMarketView{
		StrategyID: row.ID,
		Symbol:     symbol,
		Timeframe:  row.Record.Timeframe,
		Limit:      limit,
		MarkPrice:  mark,
		Klines:     klines,
		Levels:     deskPriceLevels(c, row.ID),
	})
}

// GetTradingPosition 读交易所 positionRisk。没有仓位时 open 为 false。
func GetTradingPosition(c *gin.Context) {
	user, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	book, okBook := signedDesk(c, user.ID, row)
	if !okBook {
		return
	}
	risk, err := book.PositionRisk(row.Record.Symbol)
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	symbol := strings.ToUpper(row.Record.Symbol)
	if !risk.Open {
		ok(c, gin.H{
			"strategyId": row.ID,
			"symbol":     symbol,
			"network":    row.Record.Mode,
			"open":       false,
		})
		return
	}
	ok(c, gin.H{
		"strategyId":    row.ID,
		"symbol":        symbol,
		"network":       row.Record.Mode,
		"open":          true,
		"side":          risk.Side,
		"qty":           risk.Qty,
		"entryPrice":    risk.EntryPrice,
		"markPrice":     risk.MarkPrice,
		"unrealizedPnl": risk.UnrealizedPnl,
		"leverage":      risk.Leverage,
		"margin":        risk.Margin,
		"marginMode":    risk.MarginMode,
	})
}

// GetTradingOrders 合并普通挂单和 algo 条件单。items 为空即无挂单。
func GetTradingOrders(c *gin.Context) {
	user, row, okRow := deskRow(c)
	if !okRow {
		return
	}
	book, okBook := signedDesk(c, user.ID, row)
	if !okBook {
		return
	}
	symbol := strings.ToUpper(row.Record.Symbol)
	orders, err := book.OpenOrders(symbol)
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	algos, err := book.OpenAlgoOrders(symbol)
	if err != nil {
		writeDeskErr(c, err)
		return
	}
	items := make([]trading.DeskOrder, 0, len(orders)+len(algos))
	items = append(items, orders...)
	items = append(items, algos...)
	entries := strategyEntries(user.ID, row.ID)
	if snap, found := trading.DefaultHub().State(user.ID, row.ID); found && snap.Entry != nil {
		for i := range items {
			if items[i].Kind != trading.OrderKindEntry {
				continue
			}
			stamp := *snap.Entry
			items[i].Entry = &stamp
		}
	}
	ok(c, gin.H{
		"strategyId": row.ID,
		"symbol":     symbol,
		"network":    row.Record.Mode,
		"items":      items,
		"empty":      len(items) == 0,
		"entries":    entries,
	})
}

func deskRow(c *gin.Context) (*models.User, strategyRow, bool) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return nil, strategyRow{}, false
	}
	row, err := loadEngineStrategy(c, user.ID, engineRequest{})
	if err != nil {
		writeEngineErr(c, err)
		return nil, strategyRow{}, false
	}
	return user, row, true
}

func signedDesk(c *gin.Context, userID int64, row strategyRow) (trading.DeskBook, bool) {
	if terr := ensureEngineKey(row); terr != nil {
		writeEngineErr(c, terr)
		return nil, false
	}
	book, err := newDeskBook(row.Record.Mode)
	if err != nil {
		writeEngineErr(c, err)
		return nil, false
	}
	creds, err := deskSecretOpener(userID, row)()
	if err != nil {
		writeEngineErr(c, err)
		return nil, false
	}
	if err := book.UseReadCredentials(creds); err != nil {
		writeEngineErr(c, err)
		return nil, false
	}
	return book, true
}

// deskSecretOpener 在持仓或委托读取前解开密钥。测网和实盘都可以读，仍不下单。
func deskSecretOpener(userID int64, row strategyRow) trading.SecretOpener {
	keyID := row.Record.ExchangeKeyID
	mode := row.Record.Mode
	return func() (trading.Credentials, error) {
		stored, err := loadExchangeKey(keyID, userID)
		if isNotFound(err) || (err == nil && stored.Status != exchangeKeyActive) {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		if err != nil {
			return trading.Credentials{}, err
		}
		if stored.Network != mode || (stored.Network != networkTestnet && stored.Network != networkLive) {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		apiKey, err := services.OpenExchangeSecret(stored.APIKey)
		if err != nil {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		apiSecret, err := services.OpenExchangeSecret(stored.APISecret)
		if err != nil {
			return trading.Credentials{}, trading.ErrKeyNotUsable
		}
		return trading.Credentials{APIKey: apiKey, APISecret: apiSecret, Network: stored.Network}, nil
	}
}

func deskLimit(c *gin.Context) (int, error) {
	raw := strings.TrimSpace(c.Query("limit"))
	if raw == "" {
		return deskKlineDefault, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > deskKlineMax {
		return 0, &tradingError{Status: http.StatusBadRequest, Message: "limit 需要是 1 到 500 的整数", Code: "bad_request"}
	}
	return n, nil
}

func deskPriceLevels(c *gin.Context, strategyID int64) *deskLevels {
	user, okUser := currentUser(c)
	if !okUser {
		return nil
	}
	snap, found := trading.DefaultHub().State(user.ID, strategyID)
	if !found {
		return nil
	}
	inPos := snap.Qty > 0 || snap.State == trading.StateInPosition || snap.State == trading.StateExitSubmitted
	planned := snap.StopPrice > 0 || snap.LiqPrice > 0
	if !inPos && !planned {
		return nil
	}
	if snap.EntryPrice <= 0 && snap.StopPrice <= 0 && snap.TakeProfitPrice <= 0 && snap.LiqPrice <= 0 {
		return nil
	}
	return &deskLevels{
		EntryPrice:      snap.EntryPrice,
		StopPrice:       snap.StopPrice,
		LiqPrice:        snap.LiqPrice,
		TakeProfitPrice: snap.TakeProfitPrice,
	}
}

func writeDeskErr(c *gin.Context, err error) {
	if err == nil {
		return
	}
	var te *tradingError
	if errors.As(err, &te) {
		writeTradingError(c, te)
		return
	}
	var ve *trading.ValidationError
	if errors.As(err, &ve) ||
		errors.Is(err, trading.ErrKeyNotUsable) ||
		errors.Is(err, trading.ErrLiveGateClosed) ||
		errors.Is(err, trading.ErrLiveTransportDisabled) ||
		errors.Is(err, trading.ErrBadMode) {
		writeEngineErr(c, err)
		return
	}
	log.Printf("[trading] 交易台读取失败: %s", deskErrText(err))
	fail(c, http.StatusBadGateway, "读取交易所失败", "exchange_unavailable")
}

func deskErrText(err error) string {
	msg := err.Error()
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "signature") || strings.Contains(msg, "://") || strings.Contains(lower, "x-mbx") {
		return "交易所请求失败"
	}
	return msg
}
