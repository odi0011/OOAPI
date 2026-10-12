package handlers

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// ---------- 额度上限 ----------
//
// BIGINT 本身能存到 9e18，但应用层允许的额度远超实际意义，
// 上限校验防的是 1e20 这类会让写库直接越界报错的值。
const (
	maxTokenQuota = int64(1) << 53 // 约 9e15，足够覆盖任何真实用量
	maxTokenName  = 64
)

type tokenRequest struct {
	Name string `json:"name"`
	// Quota 为 -1 或省略表示不限额度（跟随账号余额）。
	// 用单独的 Unlimited 字段明确语义，避免 0 被当成无限。
	Quota     *int64   `json:"quota"`
	Unlimited *bool    `json:"unlimited_quota"`
	Models    []string `json:"models"`
	GroupName string   `json:"group_name"`
	// ExpiredAt 为 RFC3339 时间字符串，空表示永不过期。
	ExpiredAt *string `json:"expired_at"`
}

// ListMyTokens 列出自己的密钥。
func ListMyTokens(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	rows, err := queryRows(
		`SELECT id, name, api_key, status, quota, unlimited_quota, used_quota,
		        group_name, models, expired_at, created_at, accessed_at
		 FROM tokens WHERE user_id = ? ORDER BY id DESC`, user.ID,
	)
	if err != nil {
		log.Printf("[token] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询密钥失败", "server_error")
		return
	}
	defer rows.Close()

	type item struct {
		ID             int64    `json:"id"`
		Name           string   `json:"name"`
		APIKey         string   `json:"api_key"`
		Status         int      `json:"status"`
		Quota          int64    `json:"quota"`
		UnlimitedQuota bool     `json:"unlimited_quota"`
		UsedQuota      int64    `json:"used_quota"`
		GroupName      string   `json:"group_name"`
		Models         []string `json:"models"`
		ExpiredAt      string   `json:"expired_at"`
		CreatedAt      string   `json:"created_at"`
		AccessedAt     string   `json:"accessed_at"`
	}

	out := []item{}
	for rows.Next() {
		var (
			t          item
			apiKey     string
			models     sql.NullString
			expiredAt  sql.NullString
			accessedAt sql.NullString
			createdAt  string
		)
		if err := rows.Scan(&t.ID, &t.Name, &apiKey, &t.Status, &t.Quota, &t.UnlimitedQuota,
			&t.UsedQuota, &t.GroupName, &models, &expiredAt, &createdAt, &accessedAt); err != nil {
			continue
		}
		// 列表里密钥打码：展示完整密钥没有必要，徒增泄露面。
		// 需要完整值时走「查看密钥」接口（记录操作日志）。
		// 库里是密文，先还原再打码，避免把密文尾部当成密钥提示。
		plainKey, openErr := services.OpenTokenKey(apiKey)
		if openErr != nil {
			plainKey = ""
		}
		t.APIKey = auth.MaskAPIKey(plainKey)
		t.Models = splitModelList(models.String)
		if expiredAt.Valid {
			t.ExpiredAt = expiredAt.String
		}
		if accessedAt.Valid {
			t.AccessedAt = accessedAt.String
		}
		t.CreatedAt = createdAt
		out = append(out, t)
	}

	ok(c, gin.H{"items": out})
}

// RevealMyToken 返回某把密钥的完整值。
//
// 单独开接口而不是在列表里返回：查看完整密钥是敏感操作，
// 单独入口便于将来加审计日志与二次验证。
func RevealMyToken(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var apiKey string
	// 带 user_id 条件：防止越权查看他人的密钥。
	err := db.DB.QueryRow(
		"SELECT api_key FROM tokens WHERE id = ? AND user_id = ?", c.Param("id"), user.ID,
	).Scan(&apiKey)
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, http.StatusNotFound, "密钥不存在", "not_found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取密钥失败", "server_error")
		return
	}

	plainKey, openErr := services.OpenTokenKey(apiKey)
	if openErr != nil || plainKey == "" {
		fail(c, http.StatusInternalServerError, "读取密钥失败", "server_error")
		return
	}

	log.Printf("[token] 用户 %s 查看了密钥 id=%s 的完整值", user.Username, c.Param("id"))
	ok(c, gin.H{"api_key": plainKey})
}

// CreateMyToken 创建密钥。
//
// 三条硬约束：
//  1. 必须绑定一个已存在的分组（已取消无分组的公共池）
//  2. 额度语义明确 —— 显式传 unlimited_quota 就听它的；否则传了 quota 就是有限额度；
//     两者都没传才是无限。原实现把默认值写死为「无限」，导致传了额度也被静默忽略。
//  3. 模型白名单必须落在分组白名单之内，不能被用户用来绕过分组限制
func CreateMyToken(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var req tokenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	name := strings.TrimSpace(req.Name)
	if len([]rune(name)) > maxTokenName {
		fail(c, http.StatusBadRequest, "名称最长 64 个字符", "invalid_name")
		return
	}
	if name == "" {
		name = "密钥 " + randomSuffix()
	}

	// ---- 分组校验：必须绑定一个真实存在的分组 ----
	groupName := strings.TrimSpace(req.GroupName)
	if groupName == "" {
		fail(c, http.StatusBadRequest, "请为该密钥选择一个分组", "group_required")
		return
	}
	group, err := services.GroupByName(groupName)
	if err != nil {
		fail(c, http.StatusBadRequest, "所选分组不存在，请重新选择", "group_not_found")
		return
	}

	// ---- 额度语义 ----
	unlimited := false
	var quota int64

	switch {
	case req.Unlimited != nil:
		// 显式指定了就听它的
		unlimited = *req.Unlimited
		if !unlimited {
			if req.Quota == nil {
				fail(c, http.StatusBadRequest, "限定额度时必须给出额度值", "quota_required")
				return
			}
			quota = *req.Quota
		}
	case req.Quota != nil:
		// 没显式说无限，但给了额度 —— 按有限额度处理
		unlimited = false
		quota = *req.Quota
	default:
		// 两者都没给才是无限
		unlimited = true
	}

	if !unlimited {
		if quota < 0 || quota > maxTokenQuota {
			fail(c, http.StatusBadRequest, "额度无效", "invalid_quota")
			return
		}
		// 不能超过账号可用额度：否则用户可以给自己签发一把超过余额的钥匙，
		// 而实际调用时会因余额不足失败，体验上像是系统坏了。
		available := user.Quota - user.UsedQuota
		if quota > available {
			fail(c, http.StatusBadRequest, "密钥额度不能超过账号可用额度", "quota_exceeded")
			return
		}
	}

	// ---- 模型白名单：必须落在分组白名单内 ----
	models := normalizeModelList(req.Models)
	if len(models) > 0 && len(group.Models) > 0 {
		for _, m := range models {
			if !group.ModelAllowed(m) {
				fail(c, http.StatusBadRequest,
					"模型 "+m+" 不在该分组的可用范围内，请先调整分组或改选模型", "model_not_in_group")
				return
			}
		}
	}

	// ---- 有效期 ----
	var expiredAt *time.Time
	if req.ExpiredAt != nil && strings.TrimSpace(*req.ExpiredAt) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(*req.ExpiredAt))
		if err != nil {
			fail(c, http.StatusBadRequest, "有效期格式不正确", "invalid_expiry")
			return
		}
		if t.Before(time.Now()) {
			fail(c, http.StatusBadRequest, "有效期不能早于当前时间", "invalid_expiry")
			return
		}
		expiredAt = &t
	}

	apiKey, err := auth.NewAPIKey()
	if err != nil {
		log.Printf("[token] 生成密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建密钥失败", "server_error")
		return
	}

	storedKey, keyHash, err := services.SealTokenKey(apiKey)
	if err != nil {
		log.Printf("[token] 加密密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建密钥失败", "server_error")
		return
	}

	res, err := exec(
		`INSERT INTO tokens (user_id, name, api_key, key_hash, status, quota, unlimited_quota,
		                    group_name, models, expired_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		user.ID, name, storedKey, keyHash, quota, unlimited, group.Name, strings.Join(models, ","), expiredAt,
	)
	if err != nil {
		log.Printf("[token] 插入失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建密钥失败", "server_error")
		return
	}

	id, err := res.LastInsertId()
	if err != nil {
		fail(c, http.StatusInternalServerError, "创建密钥失败", "server_error")
		return
	}

	/*
		用 insertId 精确回查，而不是「按 user_id 排序取第一条」。

		并发场景下后者会返回**别人刚建的密钥**（含完整明文），
		这是原仓库踩过的真实缺陷。这里虽然直接把 apiKey 变量回传即可，
		但回查能保证返回值与库中真实状态一致（例如触发器改写过的字段）。
	*/
	var (
		gotName    string
		gotKey     string
		gotGroup   string
		gotCreated string
		gotUnlimit bool
		gotQuota   int64
	)
	err = db.DB.QueryRow(
		`SELECT name, api_key, group_name, unlimited_quota, quota, created_at
		 FROM tokens WHERE id = ?`, id,
	).Scan(&gotName, &gotKey, &gotGroup, &gotUnlimit, &gotQuota, &gotCreated)
	if err != nil {
		// 回查失败不影响创建结果，用已知值返回
		gotName, gotKey, gotGroup, gotUnlimit, gotQuota = name, apiKey, group.Name, unlimited, quota
	} else if plain, openErr := services.OpenTokenKey(gotKey); openErr == nil && plain != "" {
		gotKey = plain
	}

	log.Printf("[token] 用户 %s 创建密钥「%s」分组 %s 无限额度=%v", user.Username, gotName, gotGroup, gotUnlimit)

	// 完整密钥只在创建时返回一次 —— 之后列表只给打码版本。
	ok(c, gin.H{
		"id":              id,
		"name":            gotName,
		"api_key":         gotKey,
		"group_name":      gotGroup,
		"unlimited_quota": gotUnlimit,
		"quota":           gotQuota,
		"models":          models,
		"created_at":      gotCreated,
	})
}

// UpdateMyToken 修改密钥（改名、改额度、改白名单、启停、改分组）。
func UpdateMyToken(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "密钥 ID 不正确", "bad_request")
		return
	}

	// 先确认这把密钥属于当前用户，并取出当前值。
	var (
		curName    string
		curGroup   string
		curStatus  int
		curQuota   int64
		curUnlimit bool
	)
	err = db.DB.QueryRow(
		`SELECT name, group_name, status, quota, unlimited_quota
		 FROM tokens WHERE id = ? AND user_id = ?`, id, user.ID,
	).Scan(&curName, &curGroup, &curStatus, &curQuota, &curUnlimit)
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, http.StatusNotFound, "密钥不存在", "not_found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取密钥失败", "server_error")
		return
	}

	var req struct {
		Name      *string  `json:"name"`
		Status    *int     `json:"status"`
		GroupName *string  `json:"group_name"`
		Quota     *int64   `json:"quota"`
		Unlimited *bool    `json:"unlimited_quota"`
		Models    []string `json:"models"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	updates := map[string]any{}

	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" || len([]rune(n)) > maxTokenName {
			fail(c, http.StatusBadRequest, "名称不能为空且最长 64 个字符", "invalid_name")
			return
		}
		updates["name"] = n
	}

	if req.Status != nil {
		if *req.Status != 0 && *req.Status != 1 {
			fail(c, http.StatusBadRequest, "状态只能是 0 或 1", "invalid_status")
			return
		}
		updates["status"] = *req.Status
	}

	// 分组变更需要重新校验，并把白名单裁剪到新分组范围内。
	targetGroup := curGroup
	if req.GroupName != nil {
		g, err := services.GroupByName(strings.TrimSpace(*req.GroupName))
		if err != nil {
			fail(c, http.StatusBadRequest, "所选分组不存在", "group_not_found")
			return
		}
		targetGroup = g.Name
		updates["group_name"] = g.Name
	}

	if len(req.Models) > 0 || req.Models != nil {
		models := normalizeModelList(req.Models)
		if len(models) > 0 {
			g, err := services.GroupByName(targetGroup)
			if err == nil && len(g.Models) > 0 {
				for _, m := range models {
					if !g.ModelAllowed(m) {
						fail(c, http.StatusBadRequest,
							"模型 "+m+" 不在该分组的可用范围内", "model_not_in_group")
						return
					}
				}
			}
		}
		updates["models"] = strings.Join(models, ",")
	}

	// 额度：显式指定优先；否则沿用原值。
	unlimited := curUnlimit
	quota := curQuota
	if req.Unlimited != nil {
		unlimited = *req.Unlimited
		if !unlimited && req.Quota == nil {
			// 从无限改为有限但没给额度 —— 视为沿用当前值（当前是不限，取账号可用额度）
			quota = user.Quota - user.UsedQuota
			if quota < 0 {
				quota = 0
			}
		}
	}
	if req.Quota != nil {
		if *req.Quota < 0 || *req.Quota > maxTokenQuota {
			fail(c, http.StatusBadRequest, "额度无效", "invalid_quota")
			return
		}
		quota = *req.Quota
		if req.Unlimited == nil {
			unlimited = false
		}
	}
	if !unlimited {
		available := user.Quota - user.UsedQuota
		if quota > available {
			fail(c, http.StatusBadRequest, "密钥额度不能超过账号可用额度", "quota_exceeded")
			return
		}
	}
	if req.Unlimited != nil || req.Quota != nil {
		updates["unlimited_quota"] = unlimited
		updates["quota"] = quota
	}

	if len(updates) == 0 {
		fail(c, http.StatusBadRequest, "没有需要更新的字段", "nothing_to_update")
		return
	}

	// 拼动态 SET 子句：字段名来自上面的白名单 map，不是用户输入，因此安全。
	sets := make([]string, 0, len(updates))
	args := make([]any, 0, len(updates)+2)
	for k, v := range updates {
		sets = append(sets, k+" = ?")
		args = append(args, v)
	}
	args = append(args, id, user.ID)

	_, err = exec("UPDATE tokens SET "+strings.Join(sets, ", ")+" WHERE id = ? AND user_id = ?", args...)
	if err != nil {
		log.Printf("[token] 更新失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新密钥失败", "server_error")
		return
	}

	log.Printf("[token] 用户 %s 更新密钥 %d", user.Username, id)
	ok(c, gin.H{"id": id})
}

// DeleteMyToken 删除密钥。
func DeleteMyToken(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	res, err := exec("DELETE FROM tokens WHERE id = ? AND user_id = ?", c.Param("id"), user.ID)
	if err != nil {
		fail(c, http.StatusInternalServerError, "删除失败", "server_error")
		return
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		fail(c, http.StatusNotFound, "密钥不存在", "not_found")
		return
	}

	log.Printf("[token] 用户 %s 删除密钥 %s", user.Username, c.Param("id"))
	ok(c, gin.H{"id": c.Param("id")})
}

// ReconcileTokens 密钥对账。
//
// 解决的问题：删密钥是物理删除，但已用额度记在账号上 ——
// 被删那把 Key 花过的钱不再属于任何现存行，于是「所有可见密钥的已用之和」
// 小于「账号的已用额度」。钱确实花了，但用户看不见差额就会当成系统算错了。
//
// 这个接口把差额显式报出来，前端在密钥页顶部提示「另有已删除密钥花掉 X」。
func ReconcileTokens(c *gin.Context) {
	user, ok1 := currentUser(c)
	if !ok1 {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}

	var existingUsed int64
	if err := db.DB.QueryRow(
		"SELECT COALESCE(SUM(used_quota), 0) FROM tokens WHERE user_id = ?", user.ID,
	).Scan(&existingUsed); err != nil {
		fail(c, http.StatusInternalServerError, "对账失败", "server_error")
		return
	}

	accountUsed := user.UsedQuota
	var deleted int64
	if accountUsed > existingUsed {
		deleted = accountUsed - existingUsed
	}

	ok(c, gin.H{
		"account_used":  accountUsed,
		"existing_used": existingUsed,
		"deleted_used":  deleted,
		"consistent":    deleted == 0,
	})
}

// ---------- 辅助 ----------

func randomSuffix() string {
	key, err := auth.NewAPIKey()
	if err != nil {
		return "0000"
	}
	// 取密钥尾部的 4 位做后缀，避免额外引入随机源
	if len(key) >= 4 {
		return key[len(key)-4:]
	}
	return "0000"
}

func splitModelList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		v := strings.TrimSpace(part)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
