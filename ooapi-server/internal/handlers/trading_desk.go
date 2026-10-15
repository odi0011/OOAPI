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
	/*
		Quote 是交易所的 24h 统计（真实涨跌幅、成交量、高低价），
		Factors 是从真实 K 线算出的多因子画像。

		两者都可能缺（接口失败 / 样本不足），前端必须按「没有就不显示」处理 ——
		早先这两个数字是前端硬编码的，页面上会一直显示 -42% 这种
		「拿实时价除以几周前的死基准」算出来的假涨跌。
	*/
	Quote   *deskQuoteView        `json:"quote,omitempty"`
	Factors *trading.FactorScores `json:"factors,omitempty"`
}

// deskQuoteView 是 24h 统计的对外形状（去掉内部字段，保持数值类型）。
type deskQuoteView struct {
	LastPrice     float64 `json:"lastPrice"`
	OpenPrice     float64 `json:"openPrice"`
	HighPrice     float64 `json:"highPrice"`
	LowPrice      float64 `json:"lowPrice"`
	PriceChange   float64 `json:"priceChange"`
	ChangePercent float64 `json:"changePercent"`
	QuoteVolume   float64 `json:"quoteVolume"`
	// FundingRate 是最新资金费率（批量标记价接口顺带返回，不额外花钱）。
	FundingRate float64 `json:"fundingRate"`
}

// GetTradingMarket 返回当前策略周期上的公开 K 线和标记价。
// 引擎内存里有仓时带上入场、止损、止盈，供图上画参考线。
// 支持按 strategyId 查询，也支持多币种宫格看板按 symbol 直接拉取公开 K 线。
func GetTradingMarket(c *gin.Context) {
	if strings.TrimSpace(c.Query("strategyId")) == "" && strings.TrimSpace(c.Query("symbol")) != "" {
		getTradingMarketBySymbol(c)
		return
	}
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
		Quote:      deskQuoteFor(book, symbol),
		Factors:    deskFactorsFor(klines),
	})
}

/*
deskQuoteFor 读 24h 统计。失败返回 nil —— 让前端不显示这一项。

为什么不报错：K 线与标记价已经拿到了，页面其余部分可以正常用。
因为「涨跌幅读不到」就让整屏行情失败，是把可选信息当成了必需项。
*/
func deskQuoteFor(book trading.DeskBook, symbol string) *deskQuoteView {
	if book == nil {
		return nil
	}
	/*
		优先走**全市场批量**接口，再按交易对查表。

		逐个币种调 ticker/24hr 的权重是 40，8 个币种就是 320；
		批量端点一次拉全部交易对也是 40 —— 差 8 倍，而看板每 5 秒刷新一轮。
		实测中逐币查询把服务器 IP 打成了币安 418 封禁。
	*/
	if bulk, okBulk := book.(interface {
		AllTickers() (map[string]trading.Ticker24h, error)
		AllMarkQuotes() (map[string]trading.MarkQuoteView, error)
	}); okBulk {
		if all, errAll := bulk.AllTickers(); errAll == nil {
			if quote, found := all[strings.ToUpper(symbol)]; found {
				out := &deskQuoteView{
					LastPrice:     quote.LastPrice,
					OpenPrice:     quote.OpenPrice,
					HighPrice:     quote.HighPrice,
					LowPrice:      quote.LowPrice,
					PriceChange:   quote.PriceChange,
					ChangePercent: quote.ChangePercent,
					QuoteVolume:   quote.QuoteVolume,
				}
				// 资金费率来自同批的标记价接口（已缓存，不会多打一次上游）
				if marks, errMarks := bulk.AllMarkQuotes(); errMarks == nil {
					if mv, foundMark := marks[strings.ToUpper(symbol)]; foundMark {
						out.FundingRate = mv.Funding
					}
				}
				return out
			}
			// 批量拿到了但没有这个交易对：说明上游根本没有它，
			// 不必再去单独查一次（省一次必失败的请求）
			return nil
		}
	}
	// 批量不可用时退回单币查询（有缓存兜底）
	quote, err := book.Ticker24h(symbol)
	if err != nil {
		log.Printf("[desk] 读取 %s 的 24h 行情失败: %v", symbol, err)
		return nil
	}
	return &deskQuoteView{
		LastPrice:     quote.LastPrice,
		OpenPrice:     quote.OpenPrice,
		HighPrice:     quote.HighPrice,
		LowPrice:      quote.LowPrice,
		PriceChange:   quote.PriceChange,
		ChangePercent: quote.ChangePercent,
		QuoteVolume:   quote.QuoteVolume,
	}
}

// deskFactorsFor 从 K 线算多因子画像。样本不足返回 nil（不显示，不编造）。
func deskFactorsFor(klines []trading.DeskCandle) *trading.FactorScores {
	scores, okFactors := trading.ComputeFactorScores(klines)
	if !okFactors {
		return nil
	}
	return &scores
}

func getTradingMarketBySymbol(c *gin.Context) {
	user, okUser := requireTradingUser(c)
	if !okUser {
		return
	}
	limit, limErr := deskLimit(c)
	if limErr != nil {
		writeEngineErr(c, limErr)
		return
	}
	symbol := strings.ToUpper(strings.TrimSpace(c.Query("symbol")))
	if symbol == "" {
		fail(c, http.StatusBadRequest, "缺少交易对参数", "bad_request")
		return
	}
	timeframe := strings.TrimSpace(c.Query("timeframe"))
	if timeframe == "" {
		timeframe = defaultTimeframe
	}
	if _, okTf := strategyTimeframes[timeframe]; !okTf {
		fail(c, http.StatusBadRequest, "K 线周期只支持 1s、1m、3m、5m、15m", "bad_request")
		return
	}
	mode := strings.ToLower(strings.TrimSpace(c.Query("mode")))
	if mode != networkTestnet && mode != networkLive {
		mode = networkTestnet
	}

	var matchedID int64
	if rows, err := listUserStrategies(user.ID); err == nil {
		if len(rows) > 0 && strings.TrimSpace(c.Query("mode")) == "" {
			mode = rows[0].Record.Mode
		}
		for _, r := range rows {
			if strings.EqualFold(r.Record.Symbol, symbol) {
				matchedID = r.ID
				if strings.TrimSpace(c.Query("timeframe")) == "" && r.Record.Timeframe != "" {
					timeframe = r.Record.Timeframe
				}
				if strings.TrimSpace(c.Query("mode")) == "" && r.Record.Mode != "" {
					mode = r.Record.Mode
				}
				break
			}
		}
	}

	book, err := newDeskBook(mode)
	if err != nil {
		writeEngineErr(c, err)
		return
	}
	klines, err := book.Klines(symbol, timeframe, limit)
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
	var levels *deskLevels
	if matchedID > 0 {
		levels = deskPriceLevels(c, matchedID)
	}
	ok(c, deskMarketView{
		StrategyID: matchedID,
		Symbol:     symbol,
		Timeframe:  timeframe,
		Limit:      limit,
		MarkPrice:  mark,
		Klines:     klines,
		Levels:     levels,
		Quote:      deskQuoteFor(book, symbol),
		Factors:    deskFactorsFor(klines),
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
	// 熔断期间不逐条刷日志：熔断本身已经记过一条，
	// 看板每个轮询都打一行会把日志淹掉（真实事故里 7 分钟几万行）。
	if errors.Is(err, trading.ErrUpstreamBan) {
		fail(c, http.StatusBadGateway, deskErrText(err), "exchange_banned")
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
