package trading

import (
	"fmt"
	"strings"
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
	return c
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

// Validate 与策略接口的 v1 约束对齐：只做 XRPUSDT、逐仓、杠杆不超过 MaxLeverage。
func (c Config) Validate() error {
	c = c.Normalize()
	if c.Symbol != SymbolXRPUSDT {
		return invalid("v1 交易对只支持 XRPUSDT")
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
	return nil
}
