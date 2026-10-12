package handlers

import (
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
)

/*
看板与消费分析的聚合统计。

只用一个接口而不是按图表拆成七八个请求：
这些查询走的是同一张 logs 表、同一个时间窗，
一次拿回去既省往返，也让「同一屏里的数字来自同一时刻」天然成立。

数据范围随权限自动收口：拥有 log:view_all 的角色拿到全站数据，
其余人只拿到自己的 —— 因此普通用户也能打开看板，
看到的是「我自己的用量」，而不是一片空白或别人的数据。
*/

// statScope 描述统计的数据范围。
type statScope struct {
	global bool
	userID int64
}

// cond 返回范围过滤的 SQL 片段与参数。
// alias 用于联表查询（如 l.user_id），传空串则直接写列名。
func (s statScope) cond(alias string) (string, []any) {
	if s.global {
		return "", nil
	}
	col := "user_id"
	if alias != "" {
		col = alias + ".user_id"
	}
	return " AND " + col + " = ?", []any{s.userID}
}

type statsSummary struct {
	Requests         int64   `json:"requests"`
	Failed           int64   `json:"failed"`
	SuccessRate      float64 `json:"success_rate"`
	Cost             float64 `json:"cost"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	CachedTokens     int64   `json:"cached_tokens"`
	AvgLatencyMs     float64 `json:"avg_latency_ms"`
	AvgFirstTokenMs  float64 `json:"avg_first_token_ms"`
}

// statsTrendPoint 是走势里的一个点（按天）。
type statsTrendPoint struct {
	Date         string  `json:"date"`
	Requests     int64   `json:"requests"`
	Failed       int64   `json:"failed"`
	SuccessRate  float64 `json:"success_rate"`
	Cost         float64 `json:"cost"`
	Tokens       int64   `json:"tokens"`
	AvgLatencyMs float64 `json:"avg_latency_ms"`
}

type statsModelRow struct {
	Model    string  `json:"model"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	Cost     float64 `json:"cost"`
}

type statsChannelRow struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	Vendor        string  `json:"vendor"`
	Status        int     `json:"status"`
	Priority      int     `json:"priority"`
	Weight        int     `json:"weight"`
	CooldownUntil string  `json:"cooldown_until"`
	TTFTMs        int     `json:"ttft_ms"`
	LastError     string  `json:"last_error"`
	Requests      int64   `json:"requests"`
	Failed        int64   `json:"failed"`
	SuccessRate   float64 `json:"success_rate"`
	Cost          float64 `json:"cost"`
	AvgLatencyMs  float64 `json:"avg_latency_ms"`
	// Latency 是最近若干次调用的耗时采样，供迷你走势与分布图使用。
	Latency []int `json:"latency"`
}

type statsEvent struct {
	Time   string `json:"time"`
	Type   int    `json:"type"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

type statsUserRow struct {
	UserID      int64   `json:"user_id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	AvatarURL   string  `json:"avatar_url"`
	Requests    int64   `json:"requests"`
	Cost        float64 `json:"cost"`
}

// statsTokenRow 是密钥维度的排行行。
type statsTokenRow struct {
	TokenID  int64   `json:"token_id"`
	Name     string  `json:"name"`
	Owner    string  `json:"owner"`
	Requests int64   `json:"requests"`
	Cost     float64 `json:"cost"`
}

// statsRecentRow 是「最近调用」表格的一行。
type statsRecentRow struct {
	ID               int64   `json:"id"`
	CreatedAt        string  `json:"created_at"`
	UserID           int64   `json:"user_id"`
	Username         string  `json:"username"`
	DisplayName      string  `json:"display_name"`
	AvatarURL        string  `json:"avatar_url"`
	Model            string  `json:"model"`
	Type             int     `json:"type"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	Cost             float64 `json:"cost"`
	FirstTokenMs     int     `json:"first_token_ms"`
	LatencyMs        int     `json:"latency_ms"`
}

type statsActivityDay struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

// AdminStats 返回看板与消费分析所需的全部聚合数据。
func AdminStats(c *gin.Context) {
	user, ok1 := currentUser(c)
	role, ok2 := currentRole(c)
	if !ok1 || !ok2 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	days := 30
	if v, err := strconv.Atoi(c.DefaultQuery("days", "30")); err == nil {
		switch {
		case v < 1:
			days = 1
		case v > 90:
			days = 90
		default:
			days = v
		}
	}

	// global 为 true 时统计全站；否则只统计当前用户自己的记录。
	scope := statScope{global: authz.Can(role, authz.PermLogViewAll), userID: user.ID}

	now := time.Now()
	// 起点取「今天 00:00 往前 days-1 天」，让最后一格正好是今天，
	// 否则白天调用时今天的柱子永远是半截的。
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	start := today.AddDate(0, 0, -(days - 1))
	prevStart := start.AddDate(0, 0, -days)

	summary := computeSummary(scope, start, time.Time{})
	// 上一等长窗口：没有对照就没有「在变好还是变坏」。
	prev := computeSummary(scope, prevStart, start)

	trend := computeTrend(scope, start, days)

	hourly := computeHourly(scope, start)
	weekday := computeWeekday(scope, start)

	// 账号的耗时采样要回填到账号行上。
	samples := computeLatencySamples(scope, start)
	channels := computeChannels(scope, start, samples)

	// 成功率：没有任何调用时按 100 展示，而不是 0 ——
	// 0% 会被读成「全挂了」，而事实是「还没有数据」。
	if summary.Requests > 0 {
		summary.SuccessRate = round2(float64(summary.Requests-summary.Failed) / float64(summary.Requests) * 100)
	} else {
		summary.SuccessRate = 100
	}
	for i := range trend {
		if trend[i].Requests > 0 {
			trend[i].SuccessRate = round2(float64(trend[i].Requests-trend[i].Failed) / float64(trend[i].Requests) * 100)
		} else {
			trend[i].SuccessRate = 100
		}
	}
	for i := range channels {
		if channels[i].Requests > 0 {
			channels[i].SuccessRate = round2(float64(channels[i].Requests-channels[i].Failed) / float64(channels[i].Requests) * 100)
		} else {
			channels[i].SuccessRate = 100
		}
	}

	// 额度占用：全站口径取所有用户的额度和，个人口径取自己的。
	quotaTotal, quotaUsed := user.Quota, user.UsedQuota
	if scope.global {
		quotaTotal, quotaUsed = 0, 0
		if err := db.DB.QueryRow(
			"SELECT COALESCE(SUM(quota), 0), COALESCE(SUM(used_quota), 0) FROM users",
		).Scan(&quotaTotal, &quotaUsed); err != nil {
			log.Printf("[stats] 统计额度占用失败: %v", err)
		}
	}

	// 消费用户排行只对全站范围有意义。
	topUsers := []statsUserRow{}
	if scope.global {
		topUsers = computeTopUsers(start)
	}

	// 密钥排行与最近调用：两者都是「成本归因」的入口，
	// 密钥排行收口到全站（个人自己看没有意义），最近调用跟随范围。
	topTokens := []statsTokenRow{}
	if scope.global {
		topTokens = computeTopTokens(start)
	}
	recent := computeRecentCalls(scope, start)

	// 区间内的活跃用户数与模型数 —— 顶部摘要条要用。
	activeUsers := int64(0)
	if scope.global {
		_ = db.DB.QueryRow(
			`SELECT COUNT(DISTINCT user_id) FROM logs
			 WHERE `+callFilter+` AND created_at >= ?`,
			start.Format("2006-01-02 15:04:05"),
		).Scan(&activeUsers)
	}

	// 缓存命中率：命中读取 / 输入总量。输入为 0 时不显示（避免 0/0 报 100%）。
	cacheRate := 0.0
	if summary.PromptTokens > 0 {
		cacheRate = round2(float64(summary.CachedTokens) / float64(summary.PromptTokens) * 100)
	}

	scopeName := "self"
	if scope.global {
		scopeName = "global"
	}

	// 没有 channel:view 的人看不到上游账号身份，也看不到没被自己用过的账号。
	channels = presentChannels(channels, authz.Can(role, authz.PermChannelView))

	ok(c, gin.H{
		"scope":        scopeName,
		"days":         days,
		"summary":      summary,
		"prev":         prev,
		"quota":        gin.H{"total": quotaTotal, "used": quotaUsed},
		"trend":        trend,
		"models":       computeModels(scope, start),
		"channels":     channels,
		"hourly":       hourly,
		"weekday":      weekday,
		"activity":     computeActivity(scope, today),
		"events":       computeEvents(scope),
		"top_users":    topUsers,
		"top_tokens":   topTokens,
		"recent":       recent,
		"active_users": activeUsers,
		"cache_rate":   cacheRate,
		"generated":    now.Format("2006-01-02 15:04:05"),
	})
}

// DashboardFilters 返回看板顶部筛选器的可选项（用户 / 密钥）。
//
// 只有具备 user:view 的角色才会拿到用户下拉 —— 普通用户看自己的看板，
// 不需要也不能枚举全站用户。
func DashboardFilters(c *gin.Context) {
	user, okUser := currentUser(c)
	role, _ := currentRole(c)
	if !okUser {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	users := []gin.H{}
	if authz.Can(role, authz.PermUserView) {
		rows, err := queryRows(
			`SELECT id, username, display_name FROM users ORDER BY id DESC LIMIT 500`,
		)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var (
					id       int64
					username string
					display  string
				)
				if rows.Scan(&id, &username, &display) == nil {
					users = append(users, gin.H{"id": id, "username": username, "display_name": display})
				}
			}
		}
	}

	tokens := []gin.H{}
	tokenQuery := `SELECT id, name, user_id FROM tokens WHERE user_id = ? ORDER BY id DESC LIMIT 500`
	tokenArgs := []any{user.ID}
	// 全站密钥名只给能看全部日志的角色。普通用户只看到自己的。
	if authz.Can(role, authz.PermLogViewAll) {
		tokenQuery = `SELECT id, name, user_id FROM tokens ORDER BY id DESC LIMIT 500`
		tokenArgs = nil
	}
	rows, err := queryRows(tokenQuery, tokenArgs...)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id   int64
				name string
				uid  int64
			)
			if rows.Scan(&id, &name, &uid) == nil {
				tokens = append(tokens, gin.H{"id": id, "name": name, "user_id": uid})
			}
		}
	}

	ok(c, gin.H{"users": users, "tokens": tokens})
}

// computeTopTokens 按消费额排出消耗最多的密钥（仅全站范围调用）。
func computeTopTokens(start time.Time) []statsTokenRow {
	out := []statsTokenRow{}
	rows, err := db.DB.Query(
		`SELECT l.token_id, COALESCE(t.name, ''), COALESCE(u.username, ''),
		        COUNT(*), COALESCE(SUM(l.quota), 0) AS cost
		 FROM logs l
		 LEFT JOIN tokens t ON t.id = l.token_id
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE l.type = `+strconv.Itoa(LogTypeCall)+` AND l.created_at >= ? AND l.token_id > 0
		 GROUP BY l.token_id, t.name, u.username
		 ORDER BY cost DESC LIMIT 10`,
		start.Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		log.Printf("[stats] 密钥排行统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var r statsTokenRow
		if err := rows.Scan(&r.TokenID, &r.Name, &r.Owner, &r.Requests, &r.Cost); err != nil {
			continue
		}
		r.Cost = round2(r.Cost)
		out = append(out, r)
	}
	return out
}

// computeRecentCalls 取最近 8 条调用（成功与失败都算），
// 给看板的「最近调用」表用 —— 它回答的是「平台此刻在忙什么」。
func computeRecentCalls(scope statScope, start time.Time) []statsRecentRow {
	where, args := whereRange(scope, "l", start, time.Time{})
	args = append(args, 8)

	out := []statsRecentRow{}
	rows, err := db.DB.Query(
		`SELECT l.id, DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s'),
		        l.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		        l.model, l.type,
		        l.prompt_tokens, l.completion_tokens, l.quota,
		        l.first_token_ms, l.latency_ms
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE `+callFilter+where+`
		 ORDER BY l.id DESC LIMIT ?`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 最近调用统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var r statsRecentRow
		if err := rows.Scan(
			&r.ID, &r.CreatedAt, &r.UserID, &r.Username, &r.DisplayName, &r.AvatarURL,
			&r.Model, &r.Type,
			&r.PromptTokens, &r.CompletionTokens, &r.Cost, &r.FirstTokenMs, &r.LatencyMs,
		); err != nil {
			continue
		}
		r.Cost = round2(r.Cost)
		out = append(out, r)
	}
	return out
}

func round2(v float64) float64 {
	if v < 0 {
		return -float64(int64(-v*100+0.5)) / 100
	}
	return float64(int64(v*100+0.5)) / 100
}

// whereRange 拼出「时间窗 + 数据范围」的公共 WHERE 片段。
// until 为零值时只限制下界。
func whereRange(scope statScope, alias string, since, until time.Time) (string, []any) {
	clause := " AND created_at >= ?"
	args := []any{since.Format("2006-01-02 15:04:05")}
	if !until.IsZero() {
		clause += " AND created_at < ?"
		args = append(args, until.Format("2006-01-02 15:04:05"))
	}
	cond, condArgs := scope.cond(alias)
	return clause + cond, append(args, condArgs...)
}

// computeSummary 统计一个时间窗内的汇总指标。
func computeSummary(scope statScope, since, until time.Time) statsSummary {
	where, args := whereRange(scope, "", since, until)

	var (
		requests, failed, promptTokens, completionTokens, cachedTokens int64
		cost, avgLatency, avgFirstToken                                float64
	)
	err := db.DB.QueryRow(
		`SELECT COUNT(*),
		        COALESCE(SUM(type = `+strconv.Itoa(LogTypeFailed)+`), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN quota END), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN prompt_tokens END), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN completion_tokens END), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN cached_tokens END), 0),
		        COALESCE(AVG(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN latency_ms END), 0),
		        COALESCE(AVG(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` AND first_token_ms > 0 THEN first_token_ms END), 0)
		 FROM logs
		 WHERE type IN (`+strconv.Itoa(LogTypeCall)+`, `+strconv.Itoa(LogTypeFailed)+`)`+where,
		args...,
	).Scan(&requests, &failed, &cost, &promptTokens, &completionTokens, &cachedTokens, &avgLatency, &avgFirstToken)
	if err != nil {
		log.Printf("[stats] 汇总统计失败: %v", err)
	}

	return statsSummary{
		Requests:         requests,
		Failed:           failed,
		Cost:             cost,
		PromptTokens:     promptTokens,
		CompletionTokens: completionTokens,
		CachedTokens:     cachedTokens,
		AvgLatencyMs:     round2(avgLatency),
		AvgFirstTokenMs:  round2(avgFirstToken),
		SuccessRate:      100,
	}
}

// computeTrend 按天聚合，并把没有调用的日子补成 0 ——
// 缺口会让折线把两个不相邻的日期连起来，读起来像连续增长的假象。
func computeTrend(scope statScope, start time.Time, days int) []statsTrendPoint {
	where, args := whereRange(scope, "", start, time.Time{})

	type row struct {
		requests     int64
		failed       int64
		cost         float64
		tokens       int64
		avgLatencyMS float64
	}
	byDate := map[string]row{}

	rows, err := db.DB.Query(
		`SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d,
		        COUNT(*),
		        COALESCE(SUM(type = `+strconv.Itoa(LogTypeFailed)+`), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN quota END), 0),
		        COALESCE(SUM(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN prompt_tokens + completion_tokens END), 0),
		        COALESCE(AVG(CASE WHEN type = `+strconv.Itoa(LogTypeCall)+` THEN latency_ms END), 0)
		 FROM logs
		 WHERE type IN (`+strconv.Itoa(LogTypeCall)+`, `+strconv.Itoa(LogTypeFailed)+`)`+where+`
		 GROUP BY d ORDER BY d`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 走势统计失败: %v", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var (
				d string
				r row
			)
			if err := rows.Scan(&d, &r.requests, &r.failed, &r.cost, &r.tokens, &r.avgLatencyMS); err != nil {
				continue
			}
			byDate[d] = r
		}
	}

	out := make([]statsTrendPoint, 0, days)
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i)
		key := d.Format("2006-01-02")
		r := byDate[key]
		out = append(out, statsTrendPoint{
			Date:         key,
			Requests:     r.requests,
			Failed:       r.failed,
			Cost:         round2(r.cost),
			Tokens:       r.tokens,
			AvgLatencyMs: round2(r.avgLatencyMS),
			SuccessRate:  100,
		})
	}
	return out
}

// computeModels 按模型聚合调用量、token 与消费。
func computeModels(scope statScope, start time.Time) []statsModelRow {
	where, args := whereRange(scope, "", start, time.Time{})

	out := []statsModelRow{}
	rows, err := db.DB.Query(
		`SELECT model, COUNT(*),
		        COALESCE(SUM(prompt_tokens + completion_tokens), 0),
		        COALESCE(SUM(quota), 0) AS cost
		 FROM logs
		 WHERE type = `+strconv.Itoa(LogTypeCall)+` AND model <> ''`+where+`
		 GROUP BY model ORDER BY cost DESC, model ASC LIMIT 20`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 模型统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var r statsModelRow
		if err := rows.Scan(&r.Model, &r.Requests, &r.Tokens, &r.Cost); err != nil {
			continue
		}
		r.Cost = round2(r.Cost)
		out = append(out, r)
	}
	return out
}

// computeLatencySamples 取最近的调用耗时，按账号分组。
//
// 耗时分布图需要的是「一批观测值」而不是平均值：
// 平均值 800ms 可能是稳定 800ms，也可能是 200 与 1400 各半，
// 这两种情况的运维含义完全不同。
func computeLatencySamples(scope statScope, start time.Time) map[int64][]int {
	where, args := whereRange(scope, "", start, time.Time{})

	// 按 id 倒序取最近若干条，再在内存里按账号倒回来，
	// 这样每个账号拿到的都是「最近的」采样，而不是窗口最早那批。
	rows, err := db.DB.Query(
		`SELECT channel_id, latency_ms FROM logs
		 WHERE type = `+strconv.Itoa(LogTypeCall)+` AND channel_id > 0 AND latency_ms > 0`+where+`
		 ORDER BY id DESC LIMIT 800`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 耗时采样失败: %v", err)
		return map[int64][]int{}
	}
	defer rows.Close()

	const perChannel = 60
	out := map[int64][]int{}
	for rows.Next() {
		var (
			channelID int64
			latency   int
		)
		if err := rows.Scan(&channelID, &latency); err != nil {
			continue
		}
		if len(out[channelID]) >= perChannel {
			continue
		}
		out[channelID] = append(out[channelID], latency)
	}
	// 翻回时间正序，走势才是从左到右。
	for id, values := range out {
		for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
			values[i], values[j] = values[j], values[i]
		}
		out[id] = values
	}
	return out
}

// presentChannels 按身份裁剪账号行。
// 没有 channel:view 时不返回名称、厂商、状态，也不列出零调用的上游账号，
// 避免看板变成一份全站账号目录。
func presentChannels(rows []statsChannelRow, canView bool) []statsChannelRow {
	if canView {
		return rows
	}
	out := make([]statsChannelRow, 0, len(rows))
	for _, row := range rows {
		if row.Requests == 0 && row.Failed == 0 {
			continue
		}
		row.ID = int64(len(out) + 1)
		row.Name = "账号"
		row.Vendor = ""
		row.Status = 0
		row.Priority = 0
		row.Weight = 0
		row.CooldownUntil = ""
		row.LastError = ""
		row.TTFTMs = 0
		out = append(out, row)
	}
	return out
}

// computeChannels 聚合各账号在窗口内的调用表现。
//
// 用 LEFT JOIN 而不是 INNER：没有任何调用的账号也要出现在列表里，
// 否则「刚建好还没接过流量」的账号会凭空消失，看起来像被删了。
func computeChannels(scope statScope, start time.Time, samples map[int64][]int) []statsChannelRow {
	joinScope, joinScopeArgs := scope.cond("l")

	args := []any{start.Format("2006-01-02 15:04:05")}
	args = append(args, joinScopeArgs...)

	out := []statsChannelRow{}
	rows, err := db.DB.Query(
		`SELECT c.id, c.name, c.vendor, c.status, c.priority, c.weight,
		        COALESCE(DATE_FORMAT(c.cooldown_until, '%Y-%m-%d %H:%i:%s'), ''),
		        c.ttft_ms, c.last_error,
		        COALESCE(SUM(l.type = `+strconv.Itoa(LogTypeCall)+`), 0),
		        COALESCE(SUM(l.type = `+strconv.Itoa(LogTypeChannelFail)+`), 0),
		        COALESCE(SUM(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.quota END), 0),
		        COALESCE(AVG(CASE WHEN l.type = `+strconv.Itoa(LogTypeCall)+` THEN l.latency_ms END), 0)
		 FROM channels c
		 LEFT JOIN logs l
		   ON l.channel_id = c.id
		  AND l.created_at >= ?
		  AND l.type IN (`+strconv.Itoa(LogTypeCall)+`, `+strconv.Itoa(LogTypeChannelFail)+`)`+joinScope+`
		 GROUP BY c.id, c.name, c.vendor, c.status, c.priority, c.weight,
		          c.cooldown_until, c.ttft_ms, c.last_error
		 ORDER BY COUNT(l.id) DESC, c.priority DESC, c.id ASC
		 LIMIT 50`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 账号统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var r statsChannelRow
		if err := rows.Scan(
			&r.ID, &r.Name, &r.Vendor, &r.Status, &r.Priority, &r.Weight,
			&r.CooldownUntil, &r.TTFTMs, &r.LastError,
			&r.Requests, &r.Failed, &r.Cost, &r.AvgLatencyMs,
		); err != nil {
			continue
		}
		r.Cost = round2(r.Cost)
		r.AvgLatencyMs = round2(r.AvgLatencyMs)
		r.SuccessRate = 100
		r.Latency = samples[r.ID]
		if r.Latency == nil {
			r.Latency = []int{}
		}
		out = append(out, r)
	}
	return out
}

// computeHourly 把窗口内的调用按「一天中的第几小时」聚合。
// 整窗聚合而不是只看今天：今天刚开服时那根柱子毫无参考价值。
func computeHourly(scope statScope, start time.Time) []int64 {
	where, args := whereRange(scope, "", start, time.Time{})

	out := make([]int64, 24)
	rows, err := db.DB.Query(
		`SELECT HOUR(created_at) AS h, COUNT(*) FROM logs
		 WHERE `+callFilter+where+` GROUP BY h`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 时段统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var (
			h int
			n int64
		)
		if err := rows.Scan(&h, &n); err != nil {
			continue
		}
		if h >= 0 && h < 24 {
			out[h] = n
		}
	}
	return out
}

// computeWeekday 按星期聚合，返回顺序固定为周一 → 周日。
func computeWeekday(scope statScope, start time.Time) []int64 {
	where, args := whereRange(scope, "", start, time.Time{})

	out := make([]int64, 7)
	rows, err := db.DB.Query(
		`SELECT DAYOFWEEK(created_at) AS w, COUNT(*) FROM logs
		 WHERE `+callFilter+where+` GROUP BY w`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 星期统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var (
			w int
			n int64
		)
		if err := rows.Scan(&w, &n); err != nil {
			continue
		}
		// DAYOFWEEK：1 = 周日 … 7 = 周六。转成「周一 = 0」的索引。
		idx := (w + 5) % 7
		out[idx] = n
	}
	return out
}

// computeActivity 返回最近 371 天（约一年）的每日调用量，
// 供热力图使用。空白的日子补 0，而不是跳过。
func computeActivity(scope statScope, today time.Time) []statsActivityDay {
	const span = 371
	from := today.AddDate(0, 0, -(span - 1))

	where, args := whereRange(scope, "", from, time.Time{})

	byDate := map[string]int64{}
	rows, err := db.DB.Query(
		`SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) FROM logs
		 WHERE `+callFilter+where+` GROUP BY d`,
		args...,
	)
	if err != nil {
		log.Printf("[stats] 活跃度统计失败: %v", err)
	} else {
		defer rows.Close()
		for rows.Next() {
			var (
				d string
				n int64
			)
			if err := rows.Scan(&d, &n); err != nil {
				continue
			}
			byDate[d] = n
		}
	}

	out := make([]statsActivityDay, 0, span)
	for i := 0; i < span; i++ {
		key := from.AddDate(0, 0, i).Format("2006-01-02")
		out = append(out, statsActivityDay{Date: key, Count: byDate[key]})
	}
	return out
}

// computeEvents 取最近的关键事件：失败调用与管理操作。
//
// 成功的调用不进来 —— 每几秒就有一条「调用成功」把时间线刷满，
// 真正的异常反而被挤出去看不见了。
func computeEvents(scope statScope) []statsEvent {
	cond, condArgs := scope.cond("")

	out := []statsEvent{}
	rows, err := db.DB.Query(
		`SELECT type, model, COALESCE(detail, ''), DATE_FORMAT(created_at, '%m-%d %H:%i')
		 FROM logs
		 WHERE type IN (`+strconv.Itoa(LogTypeFailed)+`, `+strconv.Itoa(LogTypeAdmin)+`)`+cond+`
		 ORDER BY id DESC LIMIT 8`,
		condArgs...,
	)
	if err != nil {
		log.Printf("[stats] 事件统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var e statsEvent
		var model string
		if err := rows.Scan(&e.Type, &model, &e.Detail, &e.Time); err != nil {
			continue
		}
		if e.Type == LogTypeAdmin {
			e.Title = model
		} else {
			e.Title = "调用失败"
			if model != "" {
				e.Title += " · " + model
			}
		}
		out = append(out, e)
	}
	return out
}

// computeTopUsers 按消费额排出消耗最多的用户（仅全站范围调用）。
func computeTopUsers(start time.Time) []statsUserRow {
	out := []statsUserRow{}
	rows, err := db.DB.Query(
		`SELECT l.user_id, COALESCE(u.username, '(已注销)'),
		        COALESCE(u.display_name, ''), COALESCE(u.avatar_url, ''),
		        COUNT(*), COALESCE(SUM(l.quota), 0) AS cost
		 FROM logs l
		 LEFT JOIN users u ON u.id = l.user_id
		 WHERE l.type = `+strconv.Itoa(LogTypeCall)+` AND l.created_at >= ?
		 GROUP BY l.user_id, u.username, u.display_name, u.avatar_url
		 ORDER BY cost DESC LIMIT 10`,
		start.Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		log.Printf("[stats] 用户排行统计失败: %v", err)
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var r statsUserRow
		if err := rows.Scan(&r.UserID, &r.Username, &r.DisplayName, &r.AvatarURL, &r.Requests, &r.Cost); err != nil {
			continue
		}
		r.Cost = round2(r.Cost)
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Cost > out[j].Cost })
	return out
}
