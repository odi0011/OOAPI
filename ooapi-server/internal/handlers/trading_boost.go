package handlers

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/middleware"
	"ooapi/internal/trading"
)

// PostTradingEngineBoost 打开两分钟实盘加速。
// 允许 OOAPI_BOOST_TOKEN，或已登录且具备 option:edit 的管理员 JWT。
// 两分钟内再次调用返回 429，不延长窗口。
func PostTradingEngineBoost(c *gin.Context) {
	if !allowBoostAccess(c) {
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
	if !allowBoostAccess(c) {
		return
	}
	c.JSON(http.StatusOK, trading.EventsWithEntries())
}

func allowBoostAccess(c *gin.Context) bool {
	want := os.Getenv(trading.EnvBoostToken)
	if strings.TrimSpace(want) != "" && trading.MatchToken(boostBearer(c), want) {
		return true
	}
	if user, ok := middleware.CurrentUser(c); ok && user != nil {
		role := authz.ParseRole(user.Role)
		if authz.Can(role, authz.PermOptionEdit) {
			return true
		}
	}
	fail(c, http.StatusUnauthorized, "加速令牌无效", "unauthorized")
	return false
}

// allowBoostToken 保留给旧测试名；行为与 allowBoostAccess 相同。
func allowBoostToken(c *gin.Context) bool {
	return allowBoostAccess(c)
}

func boostBearer(c *gin.Context) string {
	header := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
