package trading

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// errInsufficientMargin 表示按可用余额缩保证金后名义价值不够，或者开仓被 -2019 拒绝。
var errInsufficientMargin = errors.New("insufficient margin")

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

// plannedMargin 是不考虑可用余额时的保证金。
// 单笔上限更小时用单笔上限，否则用组合上限本身。不能再把组合上限加进已用保证金。
func plannedMargin(cfg Config) float64 {
	return marginForBalance(cfg, 0, false, 0)
}

// marginForBalance 是下一张开仓单实际占用的保证金。
// known 为假时不看余额，避免行情还没读到就把开仓缩成 0。
// 余额项是 available*MarginAvailableFraction 减去开仓 taker 手续费再减去 MarginBalanceBufferUSDT。
// 手续费按这笔保证金的名义价值估算：fee = taker * margin * leverage，
// 所以 room = (available*0.95 - buffer) / (1 + taker*leverage)，再和两个上限取更小的。
func marginForBalance(cfg Config, available float64, known bool, takerFee float64) float64 {
	budget := cfg.MaxMarginUsdt
	if cap := cfg.marginCap(); cap > 0 && cap < budget {
		budget = cap
	}
	if known {
		if room := balanceMarginRoom(available, cfg.Leverage, takerFee); room < budget {
			budget = room
		}
	}
	if budget < 0 {
		return 0
	}
	return budget
}

// balanceMarginRoom 把可用余额换成还能安全占用的初始保证金。
func balanceMarginRoom(available float64, leverage int, takerFee float64) float64 {
	if available <= 0 || leverage < 1 {
		return 0
	}
	if takerFee < 0 {
		takerFee = 0
	}
	spendable := available*MarginAvailableFraction - MarginBalanceBufferUSDT
	if spendable <= 0 {
		return 0
	}
	denom := 1 + takerFee*float64(leverage)
	if denom <= 0 {
		return 0
	}
	return spendable / denom
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
