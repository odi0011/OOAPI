package handlers

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

/*
使用记录与操作日志的查询。

两者共用一张 logs 表，按类型切开：
  - 使用记录：type IN (2, 3, 4) —— 调用成功、请求失败、账号尝试失败
  - 操作日志：type IN (1, 5)    —— 管理操作、登录

数据归属在服务端强制：
有 log:view_all 的角色看全站（可按用户筛选），其余人只能看自己的 ——
把过滤放在前端等于没放，改一个查询参数就能读到别人的记录。
*/

// logQueryScope 解析当前请求能看到的数据范围。
// admin 为 true 时不受 user_id 限制。
func logQueryScope(c *gin.Context) (userID int64, admin bool, okScope bool) {
	user, okUser := currentUser(c)
	if !okUser || user == nil {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return 0, false, false
	}
	role, okRole := currentRole(c)
	if !okRole {
		role = authz.RoleUser
	}
	return user.ID, authz.Can(role, authz.PermLogViewAll), true
}

// logTimeFilter 解析时间范围。
//
// days 与 from/to 二选一：days 是「最近 N 天」（0 = 不限），
// from/to 是精确区间（详情页排障时用得上）。都不给时默认最近 30 天 ——
// 全表扫描在日志量上来后会让页面永远转圈。
func logTimeFilter(c *gin.Context, alias string) (string, []any) {
	col := "created_at"
	if alias != "" {
		col = alias + ".created_at"
	}

	from := strings.TrimSpace(c.Query("from"))
	to := strings.TrimSpace(c.Query("to"))
	if from != "" || to != "" {
		clause := ""
		args := []any{}
		if from != "" {
			clause += " AND " + col + " >= ?"
			args = append(args, from)
		}
		if to != "" {
			clause += " AND " + col + " <= ?"
			args = append(args, to)
		}
		return clause, args
	}

	days := 30
	if v, err := strconv.Atoi(c.DefaultQuery("days", "30")); err == nil {
		switch {
		case v <= 0:
			days = 0
		case v > 365:
			days = 365
		default:
			days = v
		}
	}
	if days == 0 {
		return "", nil
	}
	return " AND " + col + " >= DATE_SUB(NOW(), INTERVAL ? DAY)", []any{days}
}

// usageStatusFilter 把前端的语义化状态映射成 type 条件。
func usageStatusFilter(status string) (string, bool) {
	switch strings.TrimSpace(status) {
	case "success":
		return " AND l.type = " + strconv.Itoa(LogTypeCall), true
	case "error":
		return " AND l.type = " + strconv.Itoa(LogTypeFailed), true
	case "attempt":
		return " AND l.type = " + strconv.Itoa(LogTypeChannelFail), true
	default:
		return "", false
	}
}

// buildUsageWhere 拼出使用记录的全部过滤条件（不含 LIMIT）。
// 返回的片段都带 l. 前缀，调用方必须用别名 l。
func buildUsageWhere(c *gin.Context, userID int64, admin bool) (string, []any) {
	where := usageFilter
	args := []any{}

	timeClause, timeArgs := logTimeFilter(c, "l")
	where += timeClause
	args = append(args, timeArgs...)

	// 数据归属：非管理员无条件锁到自己；管理员可用 user_id 筛选。
	if !admin {
		where += " AND l.user_id = ?"
		args = append(args, userID)
	} else if uid := strings.TrimSpace(c.Query("user_id")); uid != "" {
		if n, err := strconv.ParseInt(uid, 10, 64); err == nil && n > 0 {
			where += " AND l.user_id = ?"
			args = append(args, n)
		}
	}

	if model := strings.TrimSpace(c.Query("model")); model != "" {
		where += " AND l.model = ?"
		args = append(args, model)
	}
	if tid := strings.TrimSpace(c.Query("token_id")); tid != "" {
		if n, err := strconv.ParseInt(tid, 10, 64); err == nil && n > 0 {
			where += " AND l.token_id = ?"
			args = append(args, n)
		}
	}
	// 账号筛选仅管理员可用：普通用户请求体里带上 channel_id
	// 也不能看到账号维度的切分（那是基础设施信息）。
	if admin {
		if cid := strings.TrimSpace(c.Query("channel_id")); cid != "" {
			if n, err := strconv.ParseInt(cid, 10, 64); err == nil && n > 0 {
				where += " AND l.channel_id = ?"
				args = append(args, n)
			}
		}
		if group := strings.TrimSpace(c.Query("group")); group != "" {
			where += " AND l.token_id IN (SELECT id FROM tokens WHERE group_name = ?)"
			args = append(args, group)
		}
	}
	if clause, okStatus := usageStatusFilter(c.Query("status")); okStatus {
		where += clause
	}

	// 关键词：搜模型与错误详情。
	// 管理员额外搜用户名 —— 「这个报错是谁触发的」是最常见的排障诉求。
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		like := "%" + escapeLike(kw) + "%"
		if admin {
			where += " AND (l.model LIKE ? ESCAPE '\\\\' OR l.detail LIKE ? ESCAPE '\\\\' OR u.username LIKE ? ESCAPE '\\\\' OR u.display_name LIKE ? ESCAPE '\\\\')"
			args = append(args, like, like, like, like)
		} else {
			where += " AND (l.model LIKE ? ESCAPE '\\\\' OR l.detail LIKE ? ESCAPE '\\\\')"
			args = append(args, like, like)
		}
	}
	return where, args
}

// escapeLike 转义 LIKE 的通配符，避免用户输入 % 时把整表都匹配上。
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "%", "\\%")
	s = strings.ReplaceAll(s, "_", "\\_")
	return s
}

// usageBilling 是账单快照的计算辅助，让前端不必自己套公式。
//
// 注意：本站计费公式里 prompt_tokens 是「含缓存命中」的总输入，
// 缓存另按 cached_tokens 单独计价（与部分实现「从输入里扣缓存」不同）。
// 这里原样回放当时写入的快照值，只附带换算比例，不做任何重算。
type usageBilling struct {
	InputPrice  float64 `json:"input_price"`
	OutputPrice float64 `json:"output_price"`
	CachedPrice float64 `json:"cached_price"`
	RawCost     float64 `json:"raw_cost"`
	BaseQuota   int64   `json:"base_quota"`
	GroupRate   float64 `json:"group_rate"`
	Quota       int64   `json:"quota"`
	// UnitsPerUnit：1 单位货币 = 多少内部额度单位（展示换算用）。
	UnitsPerUnit int `json:"units_per_unit"`
	// Recorded 表示这条记录带计费快照。老记录没有，前端不能把 0 读成免费。
	Recorded bool `json:"recorded"`
}

type usageLogItem struct {
	ID               int64   `json:"id"`
	UserID           int64   `json:"user_id"`
	Username         string  `json:"username"`
	DisplayName      string  `json:"display_name"`
	AvatarURL        string  `json:"avatar_url"`
	TokenID          int64   `json:"token_id"`
	TokenName        string  `json:"token_name"`
	ChannelID        int64   `json:"channel_id"`
	ChannelName      string  `json:"channel_name"`
	Type             int     `json:"type"`
	Model            string  `json:"model"`
	RequestedModel   string  `json:"requested_model"`
	UpstreamModel    string  `json:"upstream_model"`
	PricingModel     string  `json:"pricing_model"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	CachedTokens     int     `json:"cached_tokens"`
	InputPrice       float64 `json:"input_price"`
	OutputPrice      float64 `json:"output_price"`
	CachedPrice      float64 `json:"cached_price"`
	GroupRate        float64 `json:"group_rate"`
	BaseQuota        int64   `json:"base_quota"`
	RawCost          float64 `json:"raw_cost"`
	Quota            int64   `json:"quota"`
	LatencyMs        int     `json:"latency_ms"`
	FirstTokenMs     int     `json:"first_token_ms"`
	IP               string  `json:"ip"`
	UserAgent        string  `json:"user_agent,omitempty"`
	CallerClient     string  `json:"caller_client"`
	Detail           string  `json:"detail"`
	CreatedAt        string  `json:"created_at"`
	// Billing 是上面各分项的聚合视图，前端直接展示即可。
	Billing *usageBilling `json:"billing"`
}

// buildUsageBilling 把一行的快照字段组装成账单辅助对象。
func buildUsageBilling(it usageLogItem, unitsPerUnit int) *usageBilling {
	return &usageBilling{
		InputPrice:   it.InputPrice,
		OutputPrice:  it.OutputPrice,
		CachedPrice:  it.CachedPrice,
		RawCost:      it.RawCost,
		BaseQuota:    it.BaseQuota,
		GroupRate:    it.GroupRate,
		Quota:        it.Quota,
		UnitsPerUnit: unitsPerUnit,
		// 倍率恒 > 0（分组校验保证），0 只可能是功能上线前的历史记录。
		Recorded: it.GroupRate > 0,
	}
}

// usageLogDetailItem 是详情页的一行：在用记录字段之外再带上原文快照。
//
// 原文只在详情接口返回 —— 列表每条都带上会让响应体膨胀几十倍，
// 而列表页根本用不到它们。
type usageLogDetailItem struct {
	usageLogItem
	InputText  string `json:"input_text"`
	PromptText string `json:"prompt_text"`
	OutputText string `json:"output_text"`
	// Recorded 标记区分「这次调用确实没有文本」与「该记录没保存文本」。
	// 老日志（本功能上线前）三个字段都是 NULL，前端必须能如实说明，
	// 而不能把「未记录」显示成「没有文本」。
	InputRecorded  bool `json:"input_recorded"`
	PromptRecorded bool `json:"prompt_recorded"`
	OutputRecorded bool `json:"output_recorded"`
	TextTruncated  bool `json:"text_truncated"`
}

// UsageLogs 使用记录查询。
//
// 联查用户、密钥、账号名：日志表里只有 id，页面上要显示「谁、用哪把钥匙、
// 走了哪个账号」—— 渲染时逐条回查会打成 N+1。
func UsageLogs(c *gin.Context) {
	userID, admin, okScope := logQueryScope(c)
	if !okScope {
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if size < 1 || size > 200 {
		size = 20
	}
	offset := (page - 1) * size

	where, args := buildUsageWhere(c, userID, admin)

	var total int64
	countArgs := append([]any{}, args...)
	if err := db.DB.QueryRow(
		`SELECT COUNT(*) FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE `+where, countArgs...,
	).Scan(&total); err != nil {
		log.Printf("[logs] 统计失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询使用记录失败", "server_error")
		return
	}

	queryArgs := append(append([]any{}, args...), size, offset)
	rows, err := queryRows(
		`SELECT l.id, l.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		        l.token_id, COALESCE(t.name, ''), l.channel_id, COALESCE(ch.name, ''),
		        l.type, l.model, l.requested_model, l.upstream_model, l.pricing_model,
		        l.prompt_tokens, l.completion_tokens, l.cached_tokens,
		        l.input_price, l.output_price, l.cached_price, l.group_rate, l.base_quota, l.raw_cost,
		        l.quota, l.latency_ms, l.first_token_ms, COALESCE(l.ip, ''),
		        COALESCE(l.user_agent, ''), COALESCE(l.caller_client, ''), COALESCE(l.detail, ''),
		        DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s')
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 LEFT JOIN tokens t ON t.id = l.token_id
		 LEFT JOIN channels ch ON ch.id = l.channel_id
		 WHERE `+where+`
		 ORDER BY l.id DESC LIMIT ? OFFSET ?`,
		queryArgs...,
	)
	if err != nil {
		log.Printf("[logs] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询使用记录失败", "server_error")
		return
	}
	defer rows.Close()

	unitsPerUnit := services.GetCurrency().UnitsPerUnit
	out := []usageLogItem{}
	for rows.Next() {
		var it usageLogItem
		if err := rows.Scan(
			&it.ID, &it.UserID, &it.Username, &it.DisplayName, &it.AvatarURL,
			&it.TokenID, &it.TokenName, &it.ChannelID, &it.ChannelName,
			&it.Type, &it.Model, &it.RequestedModel, &it.UpstreamModel, &it.PricingModel,
			&it.PromptTokens, &it.CompletionTokens, &it.CachedTokens,
			&it.InputPrice, &it.OutputPrice, &it.CachedPrice, &it.GroupRate, &it.BaseQuota, &it.RawCost,
			&it.Quota, &it.LatencyMs, &it.FirstTokenMs, &it.IP,
			&it.UserAgent, &it.CallerClient, &it.Detail, &it.CreatedAt,
		); err != nil {
			continue
		}
		it.UserAgent = sanitizeCallerUserAgent(it.UserAgent)
		if it.CallerClient == "" {
			// 迁移前的旧日志没有 caller_client 列，从保存的 UA 补推。
			it.CallerClient = callerClientFromUserAgent(it.UserAgent)
		}
		// 原始 UA 含工作站/版本细节：始终参与推断，但只回传给管理员。
		if !admin {
			it.UserAgent = ""
			// 账号名属于基础设施信息，普通用户只保留 id 供关联。
			it.ChannelName = ""
		}
		it.Billing = buildUsageBilling(it, unitsPerUnit)
		out = append(out, it)
	}

	ok(c, gin.H{
		"items":     out,
		"total":     total,
		"page":      page,
		"size":      size,
		"admin":     admin,
		"can_view_channel": admin,
	})
}

// UsageLogDetail 使用记录详情：单条记录的完整快照（含原文）。
//
// 权限与列表完全一致：有 log:view_all 看全站，其余人只能看自己的 ——
// 不是自己的记录一律 404 而不是 403：403 会泄露「这条记录存在」。
//
// 字段裁剪规则：
//   - 管理员：全部字段，包括拼装后的 prompt_text 与原始 UA；
//   - 普通用户（只能是自己的记录）：input_text / output_text 可见，
//     但 prompt_text 置空（那是网关拼装后发给上游的完整上下文），
//     原始 UA、账号名与列表同样不回传。
func UsageLogDetail(c *gin.Context) {
	userID, admin, okScope := logQueryScope(c)
	if !okScope {
		return
	}

	id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		fail(c, http.StatusNotFound, "记录不存在", "not_found")
		return
	}

	var (
		it     usageLogDetailItem
		input  sql.NullString
		prompt sql.NullString
		output sql.NullString
	)
	err = queryRow(
		`SELECT l.id, l.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		        l.token_id, COALESCE(t.name, ''), l.channel_id, COALESCE(ch.name, ''),
		        l.type, l.model, l.requested_model, l.upstream_model, l.pricing_model,
		        l.prompt_tokens, l.completion_tokens, l.cached_tokens,
		        l.input_price, l.output_price, l.cached_price, l.group_rate, l.base_quota, l.raw_cost,
		        l.quota, l.latency_ms, l.first_token_ms, COALESCE(l.ip, ''),
		        COALESCE(l.user_agent, ''), COALESCE(l.caller_client, ''), COALESCE(l.detail, ''),
		        l.input_text, l.prompt_text, l.output_text, l.text_truncated,
		        DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s')
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 LEFT JOIN tokens t ON t.id = l.token_id
		 LEFT JOIN channels ch ON ch.id = l.channel_id
		 WHERE l.id = ? AND `+usageFilter,
		id,
	).Scan(
		&it.ID, &it.UserID, &it.Username, &it.DisplayName, &it.AvatarURL,
		&it.TokenID, &it.TokenName, &it.ChannelID, &it.ChannelName,
		&it.Type, &it.Model, &it.RequestedModel, &it.UpstreamModel, &it.PricingModel,
		&it.PromptTokens, &it.CompletionTokens, &it.CachedTokens,
		&it.InputPrice, &it.OutputPrice, &it.CachedPrice, &it.GroupRate, &it.BaseQuota, &it.RawCost,
		&it.Quota, &it.LatencyMs, &it.FirstTokenMs, &it.IP,
		&it.UserAgent, &it.CallerClient, &it.Detail,
		&input, &prompt, &output, &it.TextTruncated,
		&it.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, http.StatusNotFound, "记录不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[logs] 查询使用记录详情失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询使用记录失败", "server_error")
		return
	}
	// 归属校验在读取之后：不是自己的记录按「不存在」处理。
	if !admin && it.UserID != userID {
		fail(c, http.StatusNotFound, "记录不存在", "not_found")
		return
	}

	it.InputText = input.String
	it.PromptText = prompt.String
	it.OutputText = output.String
	// NULL 与空串含义不同：NULL 是「该记录没保存过」，空串是「确实没有文本」。
	it.InputRecorded = input.Valid
	it.PromptRecorded = prompt.Valid
	it.OutputRecorded = output.Valid

	it.UserAgent = sanitizeCallerUserAgent(it.UserAgent)
	if it.CallerClient == "" {
		it.CallerClient = callerClientFromUserAgent(it.UserAgent)
	}
	if !admin {
		it.UserAgent = ""
		it.ChannelName = ""
		it.PromptText = ""
	}
	it.Billing = buildUsageBilling(it.usageLogItem, services.GetCurrency().UnitsPerUnit)

	ok(c, it)
}

// UsageLogSummary 使用记录的区间汇总（页面顶部的统计条）。
//
// 条件与明细完全一致（同一套 buildUsageWhere），否则会出现
// 「筛选后剩 3 条，汇总还写着 500 次」这种对不上账的显示。
func UsageLogSummary(c *gin.Context) {
	userID, admin, okScope := logQueryScope(c)
	if !okScope {
		return
	}
	where, args := buildUsageWhere(c, userID, admin)

	var (
		calls, errors, attempts       int64
		cost                          int64
		promptTokens, completionTokens, cachedTokens int64
		avgFirst, avgLatency          sqlNullFloat
	)
	err := db.DB.QueryRow(
		`SELECT COUNT(*),
		        COALESCE(SUM(l.type = `+strconv.Itoa(LogTypeFailed)+`), 0),
		        COALESCE(SUM(l.type = `+strconv.Itoa(LogTypeChannelFail)+`), 0),
		        COALESCE(SUM(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.quota END), 0),
		        COALESCE(SUM(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.prompt_tokens END), 0),
		        COALESCE(SUM(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.completion_tokens END), 0),
		        COALESCE(SUM(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.cached_tokens END), 0),
		        AVG(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` AND l.first_token_ms > 0 THEN l.first_token_ms END),
		        AVG(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` AND l.latency_ms > 0 THEN l.latency_ms END)
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE `+where,
		args...,
	).Scan(&calls, &errors, &attempts, &cost, &promptTokens, &completionTokens, &cachedTokens, &avgFirst, &avgLatency)
	if err != nil {
		log.Printf("[logs] 汇总失败: %v", err)
		fail(c, http.StatusInternalServerError, "统计使用记录失败", "server_error")
		return
	}

	ok(c, gin.H{
		"calls":             calls,
		"errors":            errors,
		"attempts":          attempts,
		"cost":              cost,
		"prompt_tokens":     promptTokens,
		"completion_tokens": completionTokens,
		"cached_tokens":     cachedTokens,
		"avg_first_token_ms": round2(avgFirst.Float64),
		"avg_latency_ms":     round2(avgLatency.Float64),
	})
}

// UsageLogFilters 筛选下拉的可选项（模型 / 密钥 / 账号）。
// 只统计当前范围内出现过的值，并带条数 ——
// 下拉里列出从没出现的模型只会让筛选变难用。
func UsageLogFilters(c *gin.Context) {
	userID, admin, okScope := logQueryScope(c)
	if !okScope {
		return
	}
	timeClause, timeArgs := logTimeFilter(c, "l")

	scope := ""
	scopeArgs := []any{}
	if !admin {
		scope = " AND l.user_id = ?"
		scopeArgs = append(scopeArgs, userID)
	}

	models := []gin.H{}
	rows, err := queryRows(
		`SELECT l.model, COUNT(*) FROM logs l
		 WHERE `+usageFilter+` AND l.model <> ''`+timeClause+scope+`
		 GROUP BY l.model ORDER BY COUNT(*) DESC LIMIT 100`,
		append(append([]any{}, timeArgs...), scopeArgs...)...,
	)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				name  string
				count int64
			)
			if rows.Scan(&name, &count) == nil {
				models = append(models, gin.H{"value": name, "count": count})
			}
		}
	}

	tokens := []gin.H{}
	trows, terr := queryRows(
		`SELECT l.token_id, COALESCE(t.name, ''), COUNT(*) FROM logs l
		 LEFT JOIN tokens t ON t.id = l.token_id
		 WHERE `+usageFilter+` AND l.token_id > 0`+timeClause+scope+`
		 GROUP BY l.token_id, t.name ORDER BY COUNT(*) DESC LIMIT 100`,
		append(append([]any{}, timeArgs...), scopeArgs...)...,
	)
	if terr == nil {
		defer trows.Close()
		for trows.Next() {
			var (
				id    int64
				name  string
				count int64
			)
			if trows.Scan(&id, &name, &count) == nil {
				tokens = append(tokens, gin.H{"id": id, "name": name, "count": count})
			}
		}
	}

	// 账号维度只给管理员。
	channels := []gin.H{}
	if admin {
		crows, cerr := queryRows(
			`SELECT l.channel_id, COALESCE(ch.name, ''), COUNT(*) FROM logs l
			 LEFT JOIN channels ch ON ch.id = l.channel_id
			 WHERE `+usageFilter+` AND l.channel_id > 0`+timeClause+`
			 GROUP BY l.channel_id, ch.name ORDER BY COUNT(*) DESC LIMIT 100`,
			timeArgs...,
		)
		if cerr == nil {
			defer crows.Close()
			for crows.Next() {
				var (
					id    int64
					name  string
					count int64
				)
				if crows.Scan(&id, &name, &count) == nil {
					channels = append(channels, gin.H{"id": id, "name": name, "count": count})
				}
			}
		}
	}

	ok(c, gin.H{"models": models, "tokens": tokens, "channels": channels})
}

// operationLogItem 是操作日志的一行。model 列存的是动作名。
type operationLogItem struct {
	ID           int64  `json:"id"`
	UserID       int64  `json:"user_id"`
	Username     string `json:"username"`
	DisplayName  string `json:"display_name"`
	AvatarURL    string `json:"avatar_url"`
	Type         int    `json:"type"`
	Action       string `json:"action"`
	Detail       string `json:"detail"`
	Quota        int64  `json:"quota"`
	IP           string `json:"ip"`
	UserAgent    string `json:"user_agent,omitempty"`
	CallerClient string `json:"caller_client"`
	CreatedAt    string `json:"created_at"`
}

// OperationLogs 操作日志查询：管理操作(type=1) + 登录(type=5)。
//
// 与使用记录同一套归属规则：管理员看全站，普通用户只看自己的 ——
// 「谁在什么时候把我禁用了」这类问题普通用户也应该能自查。
func OperationLogs(c *gin.Context) {
	userID, admin, okScope := logQueryScope(c)
	if !okScope {
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if size < 1 || size > 200 {
		size = 20
	}
	offset := (page - 1) * size

	where := operationFilter
	args := []any{}

	timeClause, timeArgs := logTimeFilter(c, "l")
	where += timeClause
	args = append(args, timeArgs...)

	if !admin {
		where += " AND l.user_id = ?"
		args = append(args, userID)
	} else if uid := strings.TrimSpace(c.Query("user_id")); uid != "" {
		if n, err := strconv.ParseInt(uid, 10, 64); err == nil && n > 0 {
			where += " AND l.user_id = ?"
			args = append(args, n)
		}
	}

	if t := strings.TrimSpace(c.Query("type")); t != "" {
		if n, err := strconv.Atoi(t); err == nil && n > 0 {
			where += " AND l.type = ?"
			args = append(args, n)
		}
	}
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		like := "%" + escapeLike(kw) + "%"
		where += " AND (l.model LIKE ? ESCAPE '\\\\' OR l.detail LIKE ? ESCAPE '\\\\' OR u.username LIKE ? ESCAPE '\\\\')"
		args = append(args, like, like, like)
	}

	var total int64
	countArgs := append([]any{}, args...)
	if err := db.DB.QueryRow(
		`SELECT COUNT(*) FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE `+where, countArgs...,
	).Scan(&total); err != nil {
		log.Printf("[logs] 操作日志统计失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询操作日志失败", "server_error")
		return
	}

	queryArgs := append(append([]any{}, args...), size, offset)
	rows, err := queryRows(
		`SELECT l.id, l.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		        l.type, l.model, COALESCE(l.detail, ''), l.quota, COALESCE(l.ip, ''),
		        COALESCE(l.user_agent, ''), COALESCE(l.caller_client, ''),
		        DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s')
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE `+where+`
		 ORDER BY l.id DESC LIMIT ? OFFSET ?`,
		queryArgs...,
	)
	if err != nil {
		log.Printf("[logs] 操作日志查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询操作日志失败", "server_error")
		return
	}
	defer rows.Close()

	out := []operationLogItem{}
	for rows.Next() {
		var it operationLogItem
		if err := rows.Scan(
			&it.ID, &it.UserID, &it.Username, &it.DisplayName, &it.AvatarURL,
			&it.Type, &it.Action, &it.Detail, &it.Quota, &it.IP,
			&it.UserAgent, &it.CallerClient, &it.CreatedAt,
		); err != nil {
			continue
		}
		it.UserAgent = sanitizeCallerUserAgent(it.UserAgent)
		if it.CallerClient == "" {
			it.CallerClient = callerClientFromUserAgent(it.UserAgent)
		}
		// 与使用记录同一条规则：UA 原文只回传给管理员。
		if !admin {
			it.UserAgent = ""
		}
		out = append(out, it)
	}

	ok(c, gin.H{"items": out, "total": total, "page": page, "size": size, "admin": admin})
}
