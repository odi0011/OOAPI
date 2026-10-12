package handlers

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/models"
)

// 自动交易的配置在 trading_keys.go / trading_strategies.go，状态机在 trading_engine.go。
// 密钥加密落库，明文只在发单时解开。mode=live 可以保存，实盘发单仍要测网全绿。

type tradingError struct {
	Status  int
	Message string
	Code    string
}

func (e *tradingError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func writeTradingError(c *gin.Context, err *tradingError) {
	status := http.StatusBadRequest
	if err != nil && err.Status != 0 {
		status = err.Status
	}
	message, code := "请求不正确", "bad_request"
	if err != nil {
		message, code = err.Message, err.Code
	}
	fail(c, status, message, code)
}

func requireTradingUser(c *gin.Context) (*models.User, bool) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return nil, false
	}
	return user, true
}

func parseTradingID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		fail(c, http.StatusBadRequest, "ID 不正确", "bad_request")
		return 0, false
	}
	return id, true
}

func isNotFound(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}

func tradingTime(v sql.NullString) string {
	if !v.Valid {
		return ""
	}
	return strings.TrimSpace(v.String)
}
