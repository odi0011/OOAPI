package trading

import (
	"os"
	"strings"
	"sync"
)

// 实盘门闩不写进 trading_strategies。mode=live 可以保存，
// 但在环境变量或显式标记打开之前，引擎拒绝发实盘单。
// TRADING_TESTNET_GREEN=1 表示测网已经全绿。

var (
	greenMu       sync.RWMutex
	greenExplicit bool
	greenFlag     bool
)

// SetTestnetGreen 打开或关闭进程内门闩。显式设置后不再读环境变量。
func SetTestnetGreen(passed bool) {
	greenMu.Lock()
	greenExplicit = true
	greenFlag = passed
	greenMu.Unlock()
}

// ResetTestnetGreen 清掉进程内标记，恢复为只看环境变量。测试用。
func ResetTestnetGreen() {
	greenMu.Lock()
	greenExplicit = false
	greenFlag = false
	greenMu.Unlock()
}

// TestnetGreen 表示允许进入实盘下单路径。默认关闭。
func TestnetGreen() bool {
	greenMu.RLock()
	explicit, flag := greenExplicit, greenFlag
	greenMu.RUnlock()
	if explicit {
		return flag
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TRADING_TESTNET_GREEN"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
