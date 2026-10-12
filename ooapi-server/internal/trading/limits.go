package trading

import (
	"os"
	"strconv"
	"strings"
)

// 下面四道限制默认关闭。策略字段大于 0 时用策略值；否则读环境变量；仍为 0 则不生效。
// 钱包余额跌破 BalanceFloorUSDT、止损必须在强平价之前、一币一引擎、止损止盈必须挂上，都不走这里。
const (
	EnvMaxOpenPositions      = "OOAPI_MAX_OPEN_POSITIONS"
	EnvMaxMarginPerTradeUSDT = "OOAPI_MAX_MARGIN_PER_TRADE_USDT"
	EnvMaxConsecutiveLosses  = "OOAPI_MAX_CONSECUTIVE_LOSSES"
	EnvPauseBalanceUSDT      = "OOAPI_PAUSE_BALANCE_USDT"
)

// OpenPositionLimit 是同一把密钥下允许的同时持仓数。0 表示不限制。
func (c Config) OpenPositionLimit() int {
	if c.MaxOpenPositions > 0 {
		return c.MaxOpenPositions
	}
	return envPositiveInt(EnvMaxOpenPositions)
}

func (c Config) marginCap() float64 {
	if c.MaxMarginPerTradeUsdt > 0 {
		return c.MaxMarginPerTradeUsdt
	}
	return envPositiveFloat(EnvMaxMarginPerTradeUSDT)
}

// plannedMargin 是下一张开仓单实际占用的保证金。
// 单笔上限更小时用单笔上限，否则用组合上限本身。不能再把组合上限加进已用保证金。
func plannedMargin(cfg Config) float64 {
	budget := cfg.MaxMarginUsdt
	if cap := cfg.marginCap(); cap > 0 && cap < budget {
		budget = cap
	}
	if budget < 0 {
		return 0
	}
	return budget
}

func (c Config) lossPauseCount() int {
	if c.MaxConsecutiveLosses > 0 {
		return c.MaxConsecutiveLosses
	}
	return envPositiveInt(EnvMaxConsecutiveLosses)
}

func (c Config) balancePauseLine() float64 {
	line := c.PauseBalanceUsdt
	if line <= 0 {
		line = envPositiveFloat(EnvPauseBalanceUSDT)
	}
	if line > 0 && line < BalanceFloorUSDT {
		return BalanceFloorUSDT
	}
	return line
}

func envPositiveInt(key string) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func envPositiveFloat(key string) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}
