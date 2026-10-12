package services

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"ooapi/internal/db"
)

// 账号分组。
//
// 每个密钥必须绑定一个分组 —— 已取消「无分组的公共池」，
// 因为「这把 Key 能调哪些模型、按什么倍率计费」必须由分组决定。
// 分组有两个作用：
//
//	rate   计费倍率（1 = 原价，0.8 = 八折，2 = 双倍）
//	models 模型白名单，空表示不限
type Group struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Remark    string    `json:"remark"`
	Rate      float64   `json:"rate"`
	Models    []string  `json:"models"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

var (
	ErrGroupNotFound  = errors.New("分组不存在")
	ErrGroupNameTaken = errors.New("该分组名已被使用")
	ErrGroupInUse     = errors.New("该分组下仍有密钥，无法删除")
	ErrBadRate        = errors.New("倍率需大于 0")
	ErrBadGroupName   = errors.New("分组名不能为空且最长 32 个字符")
)

// 分组配置缓存。
//
// 每次调用都查库会给网关加一次查询；分组配置变化极少，
// 因此缓存 30 秒。**变更时必须主动清理**（见 clearGroupCache），
// 否则管理员改完倍率要等最多 30 秒才生效，看起来像没保存成功。
type groupCacheEntry struct {
	group *Group
	at    time.Time
}

var (
	groupCacheMu sync.RWMutex
	groupCache   = map[string]groupCacheEntry{}
)

const groupCacheTTL = 30 * time.Second

func clearGroupCache() {
	groupCacheMu.Lock()
	groupCache = map[string]groupCacheEntry{}
	groupCacheMu.Unlock()
}

// ListGroups 返回全部分组，供管理端与密钥创建时的下拉使用。
func ListGroups() ([]Group, error) {
	rows, err := db.DB.Query(
		`SELECT id, name, remark, rate, models, created_at, updated_at
		 FROM channel_groups ORDER BY name`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, rows.Err()
}

// GroupByID 按 id 读单个分组。
func GroupByID(id int64) (*Group, error) {
	row := db.DB.QueryRow(
		`SELECT id, name, remark, rate, models, created_at, updated_at
		 FROM channel_groups WHERE id = ?`, id,
	)
	g, err := scanGroup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGroupNotFound
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

// GroupByName 按名读分组，带缓存。
// 密钥绑定的是分组名（名字全局唯一），网关侧每次调用都要用它算倍率与白名单。
func GroupByName(name string) (*Group, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrGroupNotFound
	}

	groupCacheMu.RLock()
	hit, ok := groupCache[name]
	groupCacheMu.RUnlock()
	if ok && time.Since(hit.at) < groupCacheTTL {
		return hit.group, nil
	}

	row := db.DB.QueryRow(
		`SELECT id, name, remark, rate, models, created_at, updated_at
		 FROM channel_groups WHERE name = ?`, name,
	)
	g, err := scanGroup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGroupNotFound
	}
	if err != nil {
		return nil, err
	}

	groupCacheMu.Lock()
	groupCache[name] = groupCacheEntry{group: g, at: time.Now()}
	groupCacheMu.Unlock()

	return g, nil
}

// CreateGroup 建分组。
func CreateGroup(name, remark string, rate float64, models []string) (*Group, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 32 {
		return nil, ErrBadGroupName
	}
	if rate <= 0 {
		return nil, ErrBadRate
	}

	// 查重后插入。唯一索引是最终防线，这里是为了给出可读提示。
	var exists int
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM channel_groups WHERE name = ?", name).Scan(&exists); err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, ErrGroupNameTaken
	}

	res, err := db.DB.Exec(
		"INSERT INTO channel_groups (name, remark, rate, models) VALUES (?, ?, ?, ?)",
		name, strings.TrimSpace(remark), rate, encodeModels(models),
	)
	if err != nil {
		// 并发建同名分组会走到这里
		if strings.Contains(err.Error(), "Duplicate entry") {
			return nil, ErrGroupNameTaken
		}
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	clearGroupCache()
	return GroupByID(id)
}

// UpdateGroup 改分组。
//
// 允许改名的同时，必须同步更新引用它的密钥与用户 ——
// 密钥绑定的是**分组名**而不是 id，改了名不同步就会出现
// 「密钥指向一个不存在的分组」，那把 Key 直接失效。
func UpdateGroup(id int64, name, remark string, rate float64, models []string) (*Group, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 32 {
		return nil, ErrBadGroupName
	}
	if rate <= 0 {
		return nil, ErrBadRate
	}

	old, err := GroupByID(id)
	if err != nil {
		return nil, err
	}

	if name != old.Name {
		var taken int
		if err := db.DB.QueryRow(
			"SELECT COUNT(*) FROM channel_groups WHERE name = ? AND id <> ?", name, id,
		).Scan(&taken); err != nil {
			return nil, err
		}
		if taken > 0 {
			return nil, ErrGroupNameTaken
		}
	}

	// 改名与引用更新放在一个事务里：中途失败会留下指向旧名的密钥。
	tx, err := db.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		"UPDATE channel_groups SET name = ?, remark = ?, rate = ?, models = ? WHERE id = ?",
		name, strings.TrimSpace(remark), rate, encodeModels(models), id,
	); err != nil {
		return nil, err
	}

	if name != old.Name {
		if _, err := tx.Exec("UPDATE tokens SET group_name = ? WHERE group_name = ?", name, old.Name); err != nil {
			return nil, err
		}
		if _, err := tx.Exec("UPDATE users SET group_name = ? WHERE group_name = ?", name, old.Name); err != nil {
			return nil, err
		}
		if _, err := tx.Exec("UPDATE channels SET group_name = ? WHERE group_name = ?", name, old.Name); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	clearGroupCache()
	return GroupByID(id)
}

// DeleteGroup 删分组。
//
// 有密钥还在用这个分组时拒绝删除 —— 直接删会让那些 Key 指向不存在的分组，
// 调用时无法判定倍率与白名单。
func DeleteGroup(id int64) error {
	g, err := GroupByID(id)
	if err != nil {
		return err
	}

	var inUse int
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM tokens WHERE group_name = ?", g.Name).Scan(&inUse); err != nil {
		return err
	}
	if inUse > 0 {
		return ErrGroupInUse
	}

	if _, err := db.DB.Exec("DELETE FROM channel_groups WHERE id = ?", id); err != nil {
		return err
	}

	clearGroupCache()
	return nil
}

// ApplyGroupRate 按分组倍率换算计费额度。
//
// 结果至少 1 单位：倍率小于 1 时向上取整可能得到 0，
// 那会让调用变成完全免费。
func ApplyGroupRate(units int64, rate float64) int64 {
	if rate <= 0 {
		rate = 1
	}
	if rate == 1 || units <= 0 {
		return units
	}
	out := int64(math.Round(float64(units) * rate))
	if out < 1 {
		out = 1
	}
	return out
}

// ModelAllowed 判断模型是否在该分组的白名单内。白名单为空表示不限。
//
// 白名单按**官方模型名**维护（用户看到、也是客户端调用的那个名字），
// 命中判断也在官方名上做 —— 否则「分组只放行 deepseek-flash」
// 会因为底层账号写的是上游叫法（deepseek-v4.1-flash）而永远不匹配。
func (g *Group) ModelAllowed(model string) bool {
	if g == nil || len(g.Models) == 0 {
		return true
	}
	target := CanonicalModelName(model)
	for _, m := range g.Models {
		// 支持末尾通配（如 "gpt-*"），便于把同系列一次放行。
		pattern := CanonicalModelName(m)
		if pattern == "" {
			continue
		}
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(target, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if target == pattern {
			return true
		}
	}
	return false
}

// ---------- 内部辅助 ----------

// rowScanner 让 scanGroup 同时接受 *sql.Row 与 *sql.Rows。
type rowScanner interface {
	Scan(dest ...any) error
}

func scanGroup(s rowScanner) (*Group, error) {
	var (
		g      Group
		models sql.NullString
	)
	if err := s.Scan(&g.ID, &g.Name, &g.Remark, &g.Rate, &models, &g.CreatedAt, &g.UpdatedAt); err != nil {
		return nil, err
	}
	g.Models = decodeModels(models.String)
	return &g, nil
}

// encodeModels 把模型白名单编码成 JSON 数组存储。
func encodeModels(models []string) string {
	clean := normalizeModelList(models)
	if len(clean) == 0 {
		return ""
	}
	b, err := json.Marshal(clean)
	if err != nil {
		log.Printf("[group] 序列化模型白名单失败: %v", err)
		return ""
	}
	return string(b)
}

// decodeModels 解析存储的模型白名单；任何异常都退化为「不限」而不是报错，
// 避免一条脏数据让整个分组不可用。
func decodeModels(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		log.Printf("[group] 解析模型白名单失败，按不限处理: %v", err)
		return []string{}
	}
	return normalizeModelList(arr)
}

func normalizeModelList(models []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, m := range models {
		v := strings.ToLower(strings.TrimSpace(m))
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
