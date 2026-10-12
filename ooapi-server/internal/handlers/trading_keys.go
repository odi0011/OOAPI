package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// 交易所密钥与用户 API Key 同一条加密路径：写入时 Seal，列表只回打码值，
// 明文只走 reveal。作废只改 status，不删密文，策略因此不能再选它。

const (
	exchangeKeyActive  = 1
	exchangeKeyRevoked = 0
	exchangeBinance    = "binance_usdm"
	networkTestnet     = "testnet"
	networkLive        = "live"
	maxExchangeLabel   = 64
)

const exchangeKeySelectCols = `id, label, exchange, network, api_key, api_secret, status, revoked_at, created_at, updated_at`

const exchangeKeyInsertSQL = `
INSERT INTO exchange_keys (user_id, label, exchange, network, api_key, api_secret, status)
VALUES (?, ?, ?, ?, ?, ?, ?)`

const exchangeKeyListSQL = `
SELECT ` + exchangeKeySelectCols + `
FROM exchange_keys
WHERE user_id = ?
ORDER BY id DESC`

const exchangeKeyByIDSQL = `
SELECT ` + exchangeKeySelectCols + `
FROM exchange_keys
WHERE id = ? AND user_id = ?`

const exchangeKeyRevokeSQL = `
UPDATE exchange_keys
SET status = ?, revoked_at = ?
WHERE id = ? AND user_id = ?`

const exchangeKeyMetaSQL = `
SELECT id, network, status
FROM exchange_keys
WHERE id = ? AND user_id = ?`

type exchangeKeyWrite struct {
	Label     string `json:"label"`
	Name      string `json:"name"`
	Exchange  string `json:"exchange"`
	Network   string `json:"network"`
	APIKey    string `json:"apiKey"`
	APISecret string `json:"apiSecret"`
}

type exchangeKeyView struct {
	ID              int64  `json:"id"`
	Label           string `json:"label"`
	Exchange        string `json:"exchange"`
	Network         string `json:"network"`
	APIKeyMasked    string `json:"apiKeyMasked"`
	APISecretMasked string `json:"apiSecretMasked"`
	Revoked         bool   `json:"revoked"`
	RevokedAt       string `json:"revokedAt,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

type exchangeKeyRow struct {
	ID        int64
	Label     string
	Exchange  string
	Network   string
	APIKey    string
	APISecret string
	Status    int
	RevokedAt sql.NullString
	CreatedAt string
	UpdatedAt string
}

func (row exchangeKeyRow) view() exchangeKeyView {
	return exchangeKeyView{
		ID:              row.ID,
		Label:           row.Label,
		Exchange:        row.Exchange,
		Network:         row.Network,
		APIKeyMasked:    services.MaskExchangeSecret(row.APIKey),
		APISecretMasked: services.MaskExchangeSecret(row.APISecret),
		Revoked:         row.Status != exchangeKeyActive,
		RevokedAt:       tradingTime(row.RevokedAt),
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
	}
}

func scanExchangeKey(s scanner) (exchangeKeyRow, error) {
	var row exchangeKeyRow
	err := s.Scan(
		&row.ID, &row.Label, &row.Exchange, &row.Network, &row.APIKey, &row.APISecret,
		&row.Status, &row.RevokedAt, &row.CreatedAt, &row.UpdatedAt,
	)
	return row, err
}

// scanner 覆盖 *sql.Row 与 *sql.Rows。
type scanner interface {
	Scan(dest ...any) error
}

// ListExchangeKeys 列出当前用户的交易所密钥。明文不出现在这里。
func ListExchangeKeys(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	rows, err := queryRows(exchangeKeyListSQL, user.ID)
	if err != nil {
		log.Printf("[trading] 查询交易所密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询交易所密钥失败", "server_error")
		return
	}
	defer rows.Close()

	items := []exchangeKeyView{}
	for rows.Next() {
		row, err := scanExchangeKey(rows)
		if err != nil {
			log.Printf("[trading] 读取交易所密钥行失败: %v", err)
			continue
		}
		items = append(items, row.view())
	}
	if err := rows.Err(); err != nil {
		log.Printf("[trading] 遍历交易所密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询交易所密钥失败", "server_error")
		return
	}
	ok(c, gin.H{"items": items})
}

// CreateExchangeKey 加密保存一把币安 USDT 合约密钥。响应只含打码值。
func CreateExchangeKey(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	var req exchangeKeyWrite
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	label, exchange, network, apiKey, apiSecret, fieldErr := normalizeExchangeKeyWrite(req)
	if fieldErr != nil {
		writeTradingError(c, fieldErr)
		return
	}
	storedKey, err := services.SealExchangeSecret(apiKey)
	if err != nil {
		log.Printf("[trading] 加密 API Key 失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存交易所密钥失败", "server_error")
		return
	}
	storedSecret, err := services.SealExchangeSecret(apiSecret)
	if err != nil {
		log.Printf("[trading] 加密 API Secret 失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存交易所密钥失败", "server_error")
		return
	}
	res, err := exec(exchangeKeyInsertSQL, user.ID, label, exchange, network, storedKey, storedSecret, exchangeKeyActive)
	if err != nil {
		log.Printf("[trading] 写入交易所密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存交易所密钥失败", "server_error")
		return
	}
	id, err := res.LastInsertId()
	if err != nil || id <= 0 {
		fail(c, http.StatusInternalServerError, "保存交易所密钥失败", "server_error")
		return
	}
	row, err := loadExchangeKey(id, user.ID)
	if err != nil {
		now := time.Now().Format(tradingTimeLayout)
		ok(c, exchangeKeyView{
			ID:              id,
			Label:           label,
			Exchange:        exchange,
			Network:         network,
			APIKeyMasked:    services.MaskExchangeSecret(storedKey),
			APISecretMasked: services.MaskExchangeSecret(storedSecret),
			CreatedAt:       now,
			UpdatedAt:       now,
		})
		return
	}
	log.Printf("[trading] 用户 %s 绑定交易所密钥 id=%d network=%s", user.Username, row.ID, row.Network)
	ok(c, row.view())
}

// RevealExchangeKey 返回当前用户这把密钥的明文。列表接口不会给明文。
func RevealExchangeKey(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadExchangeKey(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "交易所密钥不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[trading] 读取交易所密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取交易所密钥失败", "server_error")
		return
	}
	apiKey, err := services.OpenExchangeSecret(row.APIKey)
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取交易所密钥失败", "server_error")
		return
	}
	apiSecret, err := services.OpenExchangeSecret(row.APISecret)
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取交易所密钥失败", "server_error")
		return
	}
	log.Printf("[trading] 用户 %s 查看了交易所密钥 id=%d 的完整值", user.Username, id)
	ok(c, gin.H{"apiKey": apiKey, "apiSecret": apiSecret})
}

// RevokeExchangeKey 把密钥标成已作废。DELETE 与 POST /revoke 都走这里。
// 已作废的密钥不能再被策略选中；密文仍留在库里，便于审计。
func RevokeExchangeKey(c *gin.Context) {
	user, ok1 := requireTradingUser(c)
	if !ok1 {
		return
	}
	id, okID := parseTradingID(c)
	if !okID {
		return
	}
	row, err := loadExchangeKey(id, user.ID)
	if isNotFound(err) {
		fail(c, http.StatusNotFound, "交易所密钥不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[trading] 读取交易所密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "作废交易所密钥失败", "server_error")
		return
	}
	if row.Status == exchangeKeyActive {
		revokedAt := time.Now().Format(tradingTimeLayout)
		res, err := exec(exchangeKeyRevokeSQL, exchangeKeyRevoked, revokedAt, id, user.ID)
		if err != nil {
			log.Printf("[trading] 作废交易所密钥失败: %v", err)
			fail(c, http.StatusInternalServerError, "作废交易所密钥失败", "server_error")
			return
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			fail(c, http.StatusNotFound, "交易所密钥不存在", "not_found")
			return
		}
		row, err = loadExchangeKey(id, user.ID)
		if err != nil {
			log.Printf("[trading] 回读已作废密钥失败: %v", err)
			fail(c, http.StatusInternalServerError, "作废交易所密钥失败", "server_error")
			return
		}
	}
	log.Printf("[trading] 用户 %s 作废交易所密钥 id=%d", user.Username, id)
	ok(c, row.view())
}

func loadExchangeKey(id, userID int64) (exchangeKeyRow, error) {
	return scanExchangeKey(queryRow(exchangeKeyByIDSQL, id, userID))
}

func normalizeExchangeKeyWrite(req exchangeKeyWrite) (label, exchange, network, apiKey, apiSecret string, err *tradingError) {
	label = strings.TrimSpace(req.Label)
	if label == "" {
		label = strings.TrimSpace(req.Name)
	}
	if len([]rune(label)) > maxExchangeLabel {
		return "", "", "", "", "", &tradingError{http.StatusBadRequest, "名称最长 64 个字符", "invalid_label"}
	}
	exchange, err = normalizeExchange(req.Exchange)
	if err != nil {
		return "", "", "", "", "", err
	}
	network, err = normalizeNetwork(req.Network)
	if err != nil {
		return "", "", "", "", "", err
	}
	apiKey, err = normalizeExchangeCredential(req.APIKey, "API Key")
	if err != nil {
		return "", "", "", "", "", err
	}
	apiSecret, err = normalizeExchangeCredential(req.APISecret, "API Secret")
	if err != nil {
		return "", "", "", "", "", err
	}
	return label, exchange, network, apiKey, apiSecret, nil
}

func normalizeExchange(raw string) (string, *tradingError) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" || v == "binance" || v == exchangeBinance {
		return exchangeBinance, nil
	}
	return "", &tradingError{http.StatusBadRequest, "v1 只支持币安 USDT 合约（binance_usdm）", "invalid_exchange"}
}

func normalizeNetwork(raw string) (string, *tradingError) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return networkTestnet, nil
	}
	if v != networkTestnet && v != networkLive {
		return "", &tradingError{http.StatusBadRequest, "network 只能是 testnet 或 live", "invalid_network"}
	}
	return v, nil
}

func normalizeExchangeCredential(raw, label string) (string, *tradingError) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", &tradingError{http.StatusBadRequest, label + "不能为空", "invalid_secret"}
	}
	if len(v) < 8 || len(v) > 512 || strings.ContainsAny(v, " \t\r\n") {
		return "", &tradingError{http.StatusBadRequest, label + "长度不正确或包含空白", "invalid_secret"}
	}
	return v, nil
}

const tradingTimeLayout = "2006-01-02 15:04:05"
