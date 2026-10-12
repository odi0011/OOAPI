package handlers

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

// PostTradingEngineBoost 打开两分钟实盘加速。令牌未配置或比对失败时一律拒绝。
// 两分钟内再次调用返回 429，不延长窗口。
func PostTradingEngineBoost(c *gin.Context) {
	if !allowBoostToken(c) {
		return
	}
	until, limited := trading.GrantBoost(time.Now().UTC())
	body := gin.H{"ok": !limited, "until": until.UTC().Format(time.RFC3339)}
	if limited {
		c.JSON(http.StatusTooManyRequests, body)
		return
	}
	c.JSON(http.StatusOK, body)
}

// GetTradingEngineEvents 返回最近的检测事件。鉴权与加速接口相同。
func GetTradingEngineEvents(c *gin.Context) {
	if !allowBoostToken(c) {
		return
	}
	c.JSON(http.StatusOK, trading.RecentEvents())
}

func allowBoostToken(c *gin.Context) bool {
	want := os.Getenv(trading.EnvBoostToken)
	if strings.TrimSpace(want) == "" || !trading.MatchToken(boostBearer(c), want) {
		fail(c, http.StatusUnauthorized, "加速令牌无效", "unauthorized")
		return false
	}
	return true
}

func boostBearer(c *gin.Context) string {
	header := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
