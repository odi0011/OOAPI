package trading

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

// 字段与已上线的 /api/trading/strategies 一致。
// 策略存在 trading_strategies，密钥存在 exchange_keys；本包不另建配置表。
const (
	SymbolXRPUSDT       = "XRPUSDT"
	MarginIsolated      = "isolated"
	Timeframe5m         = "5m"
	ModeTestnet         = "testnet"
	ModeLive            = "live"
	ExchangeBinanceUSDM = "binance_usdm"

	DefaultLeverage      = 3
	DefaultEmaFast       = 9
	DefaultEmaSlow       = 21
	DefaultStopR         = 1.0
	DefaultTakeProfitR   = 1.5
	DefaultDailyLossPct  = 4.0
	DefaultMaxMarginUSDT = 1.7

	// MinNotionalUSDT 是 USDT-M 名义价值下限（约 5U）。
	// 1.7U 保证金 × 3 倍 = 5.1U，能过线；1.6U × 3 = 4.8U，会被拒绝。
	MinNotionalUSDT = 5.0

	// DefaultRFraction 是 1R 的价格距离，按入场价的比例计。
	// 止损距离 = stopR × 入场价 × DefaultRFraction。不是 ATR，也不是 K 线高低点。
	DefaultRFraction = 0.008

	// ExtremeFundingAbs 是拦截开仓的资金费率绝对值（0.10%/次）。
	ExtremeFundingAbs = 0.001

	// MinLiqDistancePct 是允许开仓的最小强平距离。负数表示没有持仓。
	MinLiqDistancePct = 0.015

	// MaxLeverage 是逐仓杠杆上限。开仓、风控和策略校验只认这一个常量。
	MaxLeverage = 20

	// DailyLossOffPct 及以上视为关闭日亏停机。校验仍接受该值，停机代码保留。
	DailyLossOffPct = 100

	// DefaultMaintMarginRate 是还没拉到杠杆档位时用的维持保证金率。
	DefaultMaintMarginRate = 0.005

	// MaxStopToLiqFraction 要求止损距离严格小于强平距离的这个比例。
	MaxStopToLiqFraction = 0.8

	ReasonStopBeyondLiquidation  = "stop_beyond_liquidation"
	ReasonProtectiveOrdersFailed = "protective_orders_failed"

	EntryModeCross = "cross"
	EntryModeTrend = "trend"

	// DefaultMinScore 是 trend 模式的默认及格分。四项信号都要过。
	DefaultMinScore = 4
	// DefaultMinWinRate 是允许开仓的近期回测胜率下限。0 表示关闭这道门。
	DefaultMinWinRate = 0.5
	// DefaultMinTrades 是这道门要求的最少样本笔数。
	DefaultMinTrades = 30
	// DefaultMaxMarginPerTradeUSDT 是新建策略的单笔保证金上限。
	// 0 表示关闭，不再额外收紧 MaxMarginUsdt。环境变量可以再打开。
	DefaultMaxMarginPerTradeUSDT = 0
	// DefaultMaxConsecutiveLosses 是新建策略的连亏暂停次数。0 表示关闭。
	DefaultMaxConsecutiveLosses = 0
	// DefaultPauseBalanceUSDT 是新建策略的余额暂停线，也是这道线的下限。
	// 低于 BalanceFloorUSDT 的值会被接口拒绝。账户权益跌到地板时仍然停掉该密钥下的全部引擎。
	DefaultPauseBalanceUSDT = 0.5

	// TrendGapFraction 是快慢线至少要拉开的距离，按价格的 0.05% 计。
	TrendGapFraction = 0.0005
	RSIPeriod        = 14
	VolumeLookback   = 20
	HigherTimeframe  = "15m"

	ReasonBelowMinNotional    = "below_min_notional"
	ReasonWinRateBelow        = "winrate_below_threshold"
	ReasonInsufficientSamples = "insufficient_samples"
	ReasonNetRNotPositive     = "netr_not_positive"
	ReasonPortfolioLimit      = "portfolio_limit"
	ReasonBalanceFloor        = "balance_floor"
	ReasonEquityUnknown       = "equity_unknown"
	ReasonConsecutiveLosses   = "consecutive_losses"
	ReasonBalanceBelowPause   = "balance_below_pause"
	ReasonBoostWait           = "boost_wait"
	ReasonBoostFilled         = "boost_filled"
	ReasonSymbolHeld          = "symbol_has_position"
	// ReasonExchangeFlat 表示仓位已在交易所被条件单打平，引擎这才跟着回到待命。
	ReasonExchangeFlat = "exchange_flat"
	// ReasonEntriesPaused 表示策略关掉了新开仓。已有仓和止损止盈保持不动。
	ReasonEntriesPaused = "entries_paused"
	// ReasonNegativeExpectancy 表示在回测胜率下，止盈放到允许上限后期望仍不为正。
	// 加速开仓和强制开仓同样记这个原因并跳过，不会只把止损挂上。
	ReasonNegativeExpectancy = "negative_expectancy"
	// ReasonInsufficientMargin 表示按可用余额缩过保证金后，名义价值仍低于交易所下限，
	// 或者开仓被币安以 -2019 拒绝且没有任何成交。引擎留在 Armed。
	ReasonInsufficientMargin = "insufficient_margin"

	// DefaultScalpPct 是赌一把模式下止损和止盈相对入场价的默认距离（0.3%）。
	DefaultScalpPct = 0.003
	// MinScalpTpPct 是止盈距离下限（0.15%）。手续费往返约 0.1%，再留一点滑点。
	// 配置更小时下单仍按这个距离抬上去。期望门可以在这个下限之上再放宽，但不会低于它。
	MinScalpTpPct = 0.0015
	// ExpectancyTpCapR 是为了让手续费后的期望为正，止盈最多放到几 R。
	// 1R = DefaultRFraction。再远就不在回测能支持的范围里，信号直接跳过。
	ExpectancyTpCapR = 3
	// MarginAvailableFraction 是可用余额里拿来当保证金的比例。
	MarginAvailableFraction = 0.95
	// MarginBalanceBufferUSDT 是扣掉开仓 taker 手续费后再留的一点余额，避免刚好打满 availableBalance。
	MarginBalanceBufferUSDT = 0.02

	// MaxMarginFraction 不再作为开仓门。大约 2U 的账户上，可用余额的 80% 低于
	// 策略的组合保证金上限，空仓也会被判超。开仓门用 MaxMarginUsdt 作为这把密钥的总额上限。
	MaxMarginFraction = 0.80
	// BalanceFloorUSDT 是账户权益的停机线。权益 = 钱包余额 + 全部持仓未实现盈亏。
	// 触及后该密钥下的引擎全部停止。读不到权益时不开新仓。
	// 同时持仓笔数没有硬编码上限；需要时用策略字段或 OOAPI_MAX_OPEN_POSITIONS 打开。
	BalanceFloorUSDT = 0.5

	// TakerFeeRate 与 SlippageRate 都按单边名义价值计，回测开平各算一次。
	// 读不到 commissionRate 时，期望门和开仓保证金估算也用它。
	TakerFeeRate = 0.0005
	// MakerFeeRate 是读不到 commissionRate 时的 maker 费率。止盈按 maker 出场。
	MakerFeeRate  = 0.0002
	SlippageRate  = 0.0002
	BacktestEvery = 3 * time.Hour
)

// Config 是从 trading_strategies 读出的一份策略。
// 实盘门闩不在这张表里，见 TestnetGreen。
type Config struct {
	ID            int64   `json:"id,omitempty"`
	Symbol        string  `json:"symbol"`
	Leverage      int     `json:"leverage"`
	MarginMode    string  `json:"marginMode"`
	EmaFast       int     `json:"emaFast"`
	EmaSlow       int     `json:"emaSlow"`
	Timeframe     string  `json:"timeframe"`
	StopR         float64 `json:"stopR"`
	TakeProfitR   float64 `json:"takeProfitR"`
	DailyLossPct  float64 `json:"dailyLossPct"`
	MaxMarginUsdt float64 `json:"maxMarginUsdt"`
	ExchangeKeyID int64   `json:"exchangeKeyId"`
	Mode          string  `json:"mode"`
	// EntryMode 为 cross（只在交叉那根 K 开仓）或 trend（趋势分数够了就开）。
	// 空值按 cross 处理，避免旧配置突然改语义。
	EntryMode  string  `json:"entryMode,omitempty"`
	MinScore   int     `json:"minScore,omitempty"`
	MinWinRate float64 `json:"minWinRate,omitempty"`
	// MinTrades 是回测样本笔数下限。0 在开仓门里按 DefaultMinTrades。
	MinTrades int `json:"minTrades,omitempty"`
	// MaxMarginPerTradeUsdt 是单笔开仓保证金上限。0 表示策略不收紧，再看环境变量。
	MaxMarginPerTradeUsdt float64 `json:"maxMarginPerTradeUsdt,omitempty"`
	// MaxConsecutiveLosses 连亏达到次数后暂停。0 表示策略不启用，再看环境变量。
	MaxConsecutiveLosses int `json:"maxConsecutiveLosses,omitempty"`
	// PauseBalanceUsdt 是钱包余额暂停线。引擎每一拍读库里的最新值，不用重启。
	// 合法值从 BalanceFloorUSDT 起。0 只留给还没写过这道线的旧行，新的保存不能再写成 0。
	PauseBalanceUsdt float64 `json:"pauseBalanceUsdt,omitempty"`
	// MaxOpenPositions 是同一把密钥下同时持仓的上限。0 表示策略不限制。
	MaxOpenPositions int `json:"maxOpenPositions,omitempty"`
	// PauseReason 非空表示已自动暂停，重启不会恢复。
	PauseReason string `json:"pauseReason,omitempty"`
	// PauseEntries 为真时本拍不开新仓。与 PauseBalanceUsdt 无关，已有仓和保护单保持原样。
	// 引擎每一拍用库里的值覆盖内存，不靠重启。
	PauseEntries bool `json:"pauseEntries,omitempty"`
	// RSI 多空允许区间。两端都为 0 时用 50–70 / 30–50。
	RSILongMin  float64 `json:"rsiLongMin,omitempty"`
	RSILongMax  float64 `json:"rsiLongMax,omitempty"`
	RSIShortMin float64 `json:"rsiShortMin,omitempty"`
	RSIShortMax float64 `json:"rsiShortMax,omitempty"`
	// GambleMode 打开后跳过回测胜率、样本和净 R 这道门。minScore 仍按配置（1–4）。
	// 加速强制开仓同样不再要求那道回测门。止损止盈改用剥头皮距离。
	// 手续费后的期望门不在豁免里：普通开仓、加速开仓和强制开仓都要让
	// EV = p*(tpDist-feeWin)-(1-p)*(slDist+feeLoss) > 0，否则 lastReason=negative_expectancy。
	GambleMode bool `json:"gambleMode,omitempty"`
	// ScalpTpPct / ScalpSlPct 是赌一把模式相对入场价的止盈、止损距离。
	// 0 表示用 DefaultScalpPct。止盈执行时不会低于 MinScalpTpPct。
	// 期望门可以在这个距离之上放宽，上限是 ExpectancyTpCapR，不会把它改小。
	ScalpTpPct float64 `json:"scalpTpPct,omitempty"`
	ScalpSlPct float64 `json:"scalpSlPct,omitempty"`
	// Revision 是热更新序号。更新的配置不会被更旧的调度快照盖掉。不入库。
	Revision int64 `json:"-"`
	// CreatedAt 是策略创建时间。累计已实现从这里起算，进程重启后仍用它。
	CreatedAt time.Time `json:"-"`
}

func DefaultConfig() Config {
	return Config{
		Symbol:        SymbolXRPUSDT,
		Leverage:      DefaultLeverage,
		MarginMode:    MarginIsolated,
		EmaFast:       DefaultEmaFast,
		EmaSlow:       DefaultEmaSlow,
		Timeframe:     Timeframe5m,
		StopR:         DefaultStopR,
		TakeProfitR:   DefaultTakeProfitR,
		DailyLossPct:  DefaultDailyLossPct,
		MaxMarginUsdt: DefaultMaxMarginUSDT,
		Mode:          ModeTestnet,
	}
}

func (c Config) Normalize() Config {
	c.Symbol = strings.ToUpper(strings.TrimSpace(c.Symbol))
	c.MarginMode = strings.ToLower(strings.TrimSpace(c.MarginMode))
	c.Timeframe = strings.TrimSpace(c.Timeframe)
	c.Mode = strings.ToLower(strings.TrimSpace(c.Mode))
	c.EntryMode = strings.ToLower(strings.TrimSpace(c.EntryMode))
	if c.EntryMode == "" {
		c.EntryMode = EntryModeCross
	}
	if c.MinScore <= 0 {
		c.MinScore = DefaultMinScore
	}
	return c
}

// AllowedSymbol 接受币安 USDT 永续的交易对代码，例如 XRPUSDT、DOGEUSDT。
func AllowedSymbol(symbol string) bool {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	if len(symbol) < 6 || len(symbol) > 24 || !strings.HasSuffix(symbol, "USDT") {
		return false
	}
	for _, r := range symbol {
		if !unicode.IsDigit(r) && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}

func allowedTimeframe(v string) bool {
	switch v {
	case "1m", "3m", "5m", "15m":
		return true
	default:
		return false
	}
}

func invalidLeverage() error {
	return invalid(fmt.Sprintf("杠杆必须是 1 到 %d 的整数", MaxLeverage))
}

// Validate 与策略接口对齐：USDT 永续、逐仓、杠杆不超过 MaxLeverage。
func (c Config) Validate() error {
	c = c.Normalize()
	if !AllowedSymbol(c.Symbol) {
		return invalid("交易对必须是 USDT 永续代码，例如 XRPUSDT、DOGEUSDT")
	}
	if c.MarginMode != MarginIsolated {
		return invalid("v1 只允许逐仓（isolated）")
	}
	if c.Leverage < 1 || c.Leverage > MaxLeverage {
		return invalidLeverage()
	}
	if !allowedTimeframe(c.Timeframe) {
		return invalid("K 线周期只支持 1m、3m、5m、15m")
	}
	if c.EmaFast < 2 || c.EmaFast > 50 || c.EmaSlow < 3 || c.EmaSlow > 200 || c.EmaFast >= c.EmaSlow {
		return invalid("快线要小于慢线，且落在允许范围内")
	}
	if c.StopR <= 0 || c.StopR > 20 || c.TakeProfitR <= 0 || c.TakeProfitR > 20 {
		return invalid("止损和止盈要大于 0 且不超过 20")
	}
	if c.DailyLossPct <= 0 || c.DailyLossPct > DailyLossOffPct {
		return invalid(fmt.Sprintf("日亏停机阈值要大于 0 且不超过 %g", float64(DailyLossOffPct)))
	}
	if c.MaxMarginUsdt <= 0 || c.MaxMarginUsdt > 1_000_000 {
		return invalid("单笔保证金上限要大于 0")
	}
	if c.Mode != ModeTestnet && c.Mode != ModeLive {
		return invalid("mode 只能是 testnet 或 live")
	}
	if c.ExchangeKeyID <= 0 {
		return invalid("请先绑定一把未作废的交易所密钥")
	}
	if c.EntryMode != EntryModeCross && c.EntryMode != EntryModeTrend {
		return invalid("entryMode 只能是 cross 或 trend")
	}
	if c.MinScore < 1 || c.MinScore > DefaultMinScore {
		return invalid("minScore 要在 1 到 4 之间")
	}
	if sl, tp := c.scalpPcts(); sl <= 0 || sl > 0.2 || tp <= 0 || tp > 0.2 {
		return invalid("剥头皮止损和止盈要大于 0 且不超过 20%")
	}
	if c.MinWinRate < 0 || c.MinWinRate > 1 {
		return invalid("minWinRate 要在 0 到 1 之间")
	}
	if c.MinTrades < 0 || c.MinTrades > 10000 {
		return invalid("minTrades 要在 0 到 10000 之间")
	}
	if c.MaxMarginPerTradeUsdt < 0 || c.MaxMarginPerTradeUsdt > 1_000_000 {
		return invalid("单笔保证金上限要在 0 到 1000000 之间")
	}
	if c.MaxConsecutiveLosses < 0 || c.MaxConsecutiveLosses > 1000 {
		return invalid("连亏暂停次数要在 0 到 1000 之间")
	}
	if c.PauseBalanceUsdt < 0 || c.PauseBalanceUsdt > 1_000_000 {
		return invalid("暂停余额要在 0 到 1000000 之间")
	}
	if c.PauseBalanceUsdt > 0 && c.PauseBalanceUsdt < BalanceFloorUSDT {
		return invalid("暂停余额不能低于 0.5")
	}
	if c.MaxOpenPositions < 0 || c.MaxOpenPositions > 10000 {
		return invalid("同时持仓上限要在 0 到 10000 之间")
	}
	if err := validRSIPair(c.RSILongMin, c.RSILongMax); err != nil {
		return err
	}
	if err := validRSIPair(c.RSIShortMin, c.RSIShortMax); err != nil {
		return err
	}
	return nil
}

func validRSIPair(min, max float64) error {
	if min == 0 && max == 0 {
		return nil
	}
	if min < 0 || max > 100 || min >= max {
		return invalid("RSI 区间要落在 0 到 100，且下限小于上限")
	}
	return nil
}

// rsiBand 是 trend 打分用的 RSI 区间。未设置时保持原来的 50–70 / 30–50。
func (c Config) rsiBand() (longMin, longMax, shortMin, shortMax float64) {
	longMin, longMax = 50, 70
	shortMin, shortMax = 30, 50
	if c.RSILongMax > c.RSILongMin {
		longMin, longMax = c.RSILongMin, c.RSILongMax
	}
	if c.RSIShortMax > c.RSIShortMin {
		shortMin, shortMax = c.RSIShortMin, c.RSIShortMax
	}
	return longMin, longMax, shortMin, shortMax
}
