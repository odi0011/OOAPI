package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/db"
	"ooapi/internal/services"
)

// ---------- 模型定价 ----------

type priceRequest struct {
	Model       string  `json:"model"`
	InputPrice  float64 `json:"input_price"`
	OutputPrice float64 `json:"output_price"`
	CachedPrice float64 `json:"cached_price"`
	// ContextTiers 是长上下文计费档位（可选）。
	// 用 RawMessage 接收：需要区分「没传」（保持原档位不动）与
	// 「传了 null / []」（清空档位），并且能对格式错误给出明确的报错，
	// 而不是被绑定层统一吞成「请求格式不正确」。
	ContextTiers json.RawMessage `json:"context_tiers"`
}

// maxContextTiers 是单模型允许的长上下文档位数。
// 档位是给「128k / 200k / 1M」这种少量分界用的，8 档足够，
// 再多只会让计费规则难以复核。
const maxContextTiers = 8

// AdminListPrices 定价列表，需要 pricing:view。
func AdminListPrices(c *gin.Context) {
	prices, err := services.ListPrices()
	if err != nil {
		log.Printf("[pricing] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询定价失败", "server_error")
		return
	}
	ok(c, gin.H{"items": prices})
}

// AdminUpsertPrice 新增或更新一个模型的定价，需要 pricing:edit。
//
// 用 upsert 而不是分开的「新建/编辑」两个接口：
// 定价是按模型唯一的，管理员的心智是「把这个模型的价格设成这样」，
// 而不是「先判断它存不存在再决定调哪个接口」。
func AdminUpsertPrice(c *gin.Context) {
	var req priceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	model := strings.TrimSpace(req.Model)
	if model == "" {
		fail(c, http.StatusBadRequest, "请填写模型名", "invalid_model")
		return
	}
	if len(model) > 128 {
		fail(c, http.StatusBadRequest, "模型名最长 128 个字符", "invalid_model")
		return
	}

	// 价格为负会让计费算出负数，等于给用户倒贴钱。
	for name, v := range map[string]float64{
		"输入价": req.InputPrice, "输出价": req.OutputPrice, "缓存价": req.CachedPrice,
	} {
		if err := validatePriceValue(name, v); err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_price")
			return
		}
	}

	/*
		长上下文档位（可选）。

		三种状态必须区分清楚：
		  - 没传字段：保持库里原有档位不动。旧版管理界面不认这个字段，
		    若把「没传」当成清空，管理员改一次价格就会把档位静默抹掉。
		  - 传 null 或 []：显式清空档位（回到只有基础价）。
		  - 传数组：校验后整组替换。
	*/
	hasTiers := false
	var tiersValue any
	if len(req.ContextTiers) > 0 {
		tiers, err := parseContextTiersInput(req.ContextTiers)
		if err != nil {
			fail(c, http.StatusBadRequest, "长上下文档位不正确："+err.Error(), "invalid_context_tiers")
			return
		}
		hasTiers = true
		tiersValue = services.EncodeContextTiers(tiers)
	}

	var execErr error
	if hasTiers {
		_, execErr = exec(
			`INSERT INTO model_prices (model, input_price, output_price, cached_price, context_tiers)
			 VALUES (?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
			   input_price = VALUES(input_price),
			   output_price = VALUES(output_price),
			   cached_price = VALUES(cached_price),
			   context_tiers = VALUES(context_tiers)`,
			model, req.InputPrice, req.OutputPrice, req.CachedPrice, tiersValue,
		)
	} else {
		_, execErr = exec(
			`INSERT INTO model_prices (model, input_price, output_price, cached_price)
			 VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
			   input_price = VALUES(input_price),
			   output_price = VALUES(output_price),
			   cached_price = VALUES(cached_price)`,
			model, req.InputPrice, req.OutputPrice, req.CachedPrice,
		)
	}
	if execErr != nil {
		log.Printf("[pricing] 保存失败: %v", execErr)
		fail(c, http.StatusInternalServerError, "保存定价失败", "server_error")
		return
	}

	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 设置模型「%s」定价 输入=%v 输出=%v", operator.Username, model, req.InputPrice, req.OutputPrice)
	}
	ok(c, gin.H{"model": model})
}

// validatePriceValue 校验单个价格：非负且不超过 $1,000,000 / 1M tokens。
func validatePriceValue(name string, v float64) error {
	if v < 0 {
		return errors.New(name + "不能为负")
	}
	if v > 1_000_000 {
		return errors.New(name + "超出合理范围")
	}
	return nil
}

// parseContextTiersInput 校验并解析请求里的 context_tiers。
//
// 规则（与计费侧 PriceForTokens 的假设一一对应）：
//   - 必须是 JSON 数组（null 由调用方在更外层处理为「清空」）
//   - 每档 min_input_tokens >= 1；单价非负
//   - 最多 maxContextTiers 档
//   - 存储前按 min_input_tokens 升序排序（价格选档依赖有序）
func parseContextTiersInput(raw json.RawMessage) ([]services.ContextTier, error) {
	var tiers []services.ContextTier
	if err := json.Unmarshal(raw, &tiers); err != nil {
		return nil, errors.New("应为 JSON 数组，元素形如 {\"min_input_tokens\":200000,\"input_price\":2,\"output_price\":4,\"cached_price\":0.5}")
	}
	if len(tiers) == 0 {
		return nil, nil
	}
	if len(tiers) > maxContextTiers {
		return nil, errors.New("最多 " + strconv.Itoa(maxContextTiers) + " 档")
	}
	for i := range tiers {
		tier := &tiers[i]
		if tier.MinInputTokens < 1 {
			return nil, errors.New("每档的 min_input_tokens 至少为 1")
		}
		if err := validatePriceValue("输入价", tier.InputPrice); err != nil {
			return nil, err
		}
		if err := validatePriceValue("输出价", tier.OutputPrice); err != nil {
			return nil, err
		}
		if err := validatePriceValue("缓存价", tier.CachedPrice); err != nil {
			return nil, err
		}
	}
	sort.Slice(tiers, func(i, j int) bool {
		return tiers[i].MinInputTokens < tiers[j].MinInputTokens
	})
	// 相邻档位门槛相同会让「选哪一档」变得不确定，直接拒绝。
	for i := 1; i < len(tiers); i++ {
		if tiers[i].MinInputTokens == tiers[i-1].MinInputTokens {
			return nil, errors.New("存在重复的 min_input_tokens：" + strconv.Itoa(tiers[i].MinInputTokens))
		}
	}
	return tiers, nil
}

// AdminDeletePrice 删除定价，需要 pricing:edit。
func AdminDeletePrice(c *gin.Context) {
	model := strings.TrimSpace(c.Param("model"))
	if model == "" {
		fail(c, http.StatusBadRequest, "模型名不能为空", "invalid_model")
		return
	}

	res, err := exec("DELETE FROM model_prices WHERE model = ?", model)
	if err != nil {
		fail(c, http.StatusInternalServerError, "删除失败", "server_error")
		return
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		fail(c, http.StatusNotFound, "该模型没有配置定价", "not_found")
		return
	}

	ok(c, gin.H{"model": model})
}

// PublicPrices 定价列表的公开版本（首页与文档展示用）。
func PublicPrices(c *gin.Context) {
	prices, err := services.ListPrices()
	if err != nil {
		log.Printf("[pricing] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询定价失败", "server_error")
		return
	}
	ok(c, gin.H{"items": prices})
}

// ---------- 日志查询 ----------
// 使用记录与操作日志的实现在 logs_query.go。

// ---------- 运行状态 ----------

// AdminStatus 运行状态体检，需要 option:view。
//
// 汇总「服务是否正常」的几个关键指标：数据库连通性、账号健康、
// 表规模与近 24 小时调用情况 —— 出问题时应一眼看出是哪一层。
func AdminStatus(c *gin.Context) {
	report := gin.H{}

	// 数据库
	dbOK := true
	dbErr := ""
	if err := db.DB.Ping(); err != nil {
		dbOK = false
		dbErr = err.Error()
	}
	report["database"] = gin.H{"ok": dbOK, "error": dbErr}

	// 账号统计
	var (
		totalChannels, activeChannels, coolingChannels, disabledByAuto int
	)
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM channels").Scan(&totalChannels)
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM channels WHERE status = 1").Scan(&activeChannels)
	_ = db.DB.QueryRow(
		"SELECT COUNT(*) FROM channels WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()",
	).Scan(&coolingChannels)
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM channels WHERE disabled_by = 'auto'").Scan(&disabledByAuto)

	report["channels"] = gin.H{
		"total":         totalChannels,
		"active":        activeChannels,
		"cooling":       coolingChannels,
		"auto_disabled": disabledByAuto,
	}

	// 近 24 小时调用
	var (
		calls24h   int64
		errors24h  int64
		quota24h   int64
		avgLatency sqlNullFloat
	)
	_ = db.DB.QueryRow(
		"SELECT COUNT(*) FROM logs WHERE type = 2 AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)",
	).Scan(&calls24h)
	_ = db.DB.QueryRow(
		"SELECT COUNT(*) FROM logs WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY) AND detail LIKE '%错误=%'",
	).Scan(&errors24h)
	_ = db.DB.QueryRow(
		"SELECT COALESCE(SUM(quota), 0) FROM logs WHERE type = 2 AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)",
	).Scan(&quota24h)
	_ = db.DB.QueryRow(
		"SELECT AVG(latency_ms) FROM logs WHERE type = 2 AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)",
	).Scan(&avgLatency)

	report["calls_24h"] = gin.H{
		"calls":       calls24h,
		"errors":      errors24h,
		"quota":       quota24h,
		"avg_latency": avgLatency.Float64,
	}

	// 表规模
	type tableInfo struct {
		Name  string `json:"name"`
		Count int64  `json:"count"`
	}
	tables := []tableInfo{}
	for _, t := range []string{"users", "tokens", "channels", "channel_groups", "logs", "model_prices"} {
		var n int64
		if err := db.DB.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&n); err == nil {
			tables = append(tables, tableInfo{Name: t, Count: n})
		}
	}
	report["tables"] = tables

	// 分组与密钥
	var groups, tokens int64
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM channel_groups").Scan(&groups)
	_ = db.DB.QueryRow("SELECT COUNT(*) FROM tokens WHERE status = 1").Scan(&tokens)

	report["groups"] = groups
	report["active_tokens"] = tokens

	ok(c, report)
}

// sqlNullString / sqlNullFloat 是 database/sql 里常见空值类型的短别名，
// 让上面的扫描代码不必反复写 sql.NullString。
type sqlNullString = sql.NullString
type sqlNullFloat = sql.NullFloat64
