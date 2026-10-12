package services

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"

	"ooapi/internal/db"
)

// 币制：1 OD币 = 1 美元。额度以「单位」存储，1 OD = 10000 单位。
// 全站金额换算只能走本文件，避免各处口径不一致。
const DefaultUnitsPerOD = 10000

// ContextTier 是一个长上下文计费档位：当请求的输入 token 数达到
// min_input_tokens 时，整次调用改用该档的单价计费。
//
// 为什么是「整次重定价」而不是「超出部分加价」：主流厂商
// （Anthropic / OpenAI 的长上下文档）就是按整个请求切档计价的，
// 网关若自创分段算法，账单会与上游对不上。
type ContextTier struct {
	MinInputTokens int     `json:"min_input_tokens"`
	InputPrice     float64 `json:"input_price"`
	OutputPrice    float64 `json:"output_price"`
	CachedPrice    float64 `json:"cached_price"`
}

type ModelPrice struct {
	Model       string  `json:"model"`
	InputPrice  float64 `json:"input_price"`
	OutputPrice float64 `json:"output_price"`
	CachedPrice float64 `json:"cached_price"`
	// ContextTiers 是长上下文档位（按 min_input_tokens 升序）。
	// 空 = 只有基础价，行为与从前完全一致。
	ContextTiers []ContextTier `json:"context_tiers,omitempty"`
}

// ParseContextTiers 解析 context_tiers 列的 JSON。
//
// 返回错误只用于管理端写入前的校验；读取侧遇到脏数据时
// 由调用方决定忽略（退回基础价）而不是让整次计费失败。
func ParseContextTiers(raw string) ([]ContextTier, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return nil, nil
	}
	var tiers []ContextTier
	if err := json.Unmarshal([]byte(raw), &tiers); err != nil {
		return nil, err
	}
	if len(tiers) == 0 {
		return nil, nil
	}
	sort.Slice(tiers, func(i, j int) bool {
		return tiers[i].MinInputTokens < tiers[j].MinInputTokens
	})
	return tiers, nil
}

// EncodeContextTiers 把档位序列化成存库用的 JSON；空档位返回 NULL。
func EncodeContextTiers(tiers []ContextTier) any {
	if len(tiers) == 0 {
		return nil
	}
	sorted := make([]ContextTier, len(tiers))
	copy(sorted, tiers)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].MinInputTokens < sorted[j].MinInputTokens
	})
	raw, err := json.Marshal(sorted)
	if err != nil {
		return nil
	}
	return string(raw)
}

// PriceForTokens 按本次请求的输入 token 数选择计费档位。
//
// 规则：取 min_input_tokens <= promptTokens 中最大的那一档；
// 没有命中的档位时返回基础行（p 本身）。整个请求按选中档位的
// 单价重新计价 —— 与上游对长上下文「整次切档」的计费方式一致。
func PriceForTokens(p ModelPrice, promptTokens int) ModelPrice {
	if len(p.ContextTiers) == 0 {
		return p
	}
	var picked *ContextTier
	for i := range p.ContextTiers {
		tier := &p.ContextTiers[i]
		if tier.MinInputTokens <= promptTokens &&
			(picked == nil || tier.MinInputTokens > picked.MinInputTokens) {
			picked = tier
		}
	}
	if picked == nil {
		return p
	}
	out := p
	out.InputPrice = picked.InputPrice
	out.OutputPrice = picked.OutputPrice
	out.CachedPrice = picked.CachedPrice
	return out
}

// ListPricedModels 返回已配置价格的模型名（去重排序）。
func ListPricedModels() ([]string, error) {
	rows, err := db.DB.Query("SELECT DISTINCT model FROM model_prices ORDER BY model")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var models []string
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}

// ListPrices 返回全部模型价格，供定价页与管理端使用。
func ListPrices() ([]ModelPrice, error) {
	rows, err := db.DB.Query(
		`SELECT model, input_price, output_price, cached_price, COALESCE(context_tiers, '')
		 FROM model_prices ORDER BY model`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ModelPrice{}
	for rows.Next() {
		var (
			p        ModelPrice
			tiersRaw string
		)
		if err := rows.Scan(&p.Model, &p.InputPrice, &p.OutputPrice, &p.CachedPrice, &tiersRaw); err != nil {
			return nil, err
		}
		// 脏数据不阻断列表：忽略档位、退回基础价，并保持其余行可读。
		if tiers, perr := ParseContextTiers(tiersRaw); perr == nil {
			p.ContextTiers = tiers
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out, nil
}

// PriceOf 查某个模型的单价；未配置时返回 false，由调用方决定兜底策略。
func PriceOf(model string) (ModelPrice, bool) {
	var (
		p        ModelPrice
		tiersRaw string
	)
	// 未初始化数据库时按「没有定价」返回，而不是 panic：
	// 调用方（如别名判定、单元测试）需要一个可用的答案，
	// 崩溃会把一个可恢复的查询变成进程级故障。
	if db.DB == nil {
		return ModelPrice{}, false
	}
	err := db.DB.QueryRow(
		`SELECT model, input_price, output_price, cached_price, COALESCE(context_tiers, '')
		 FROM model_prices WHERE model = ?`,
		model,
	).Scan(&p.Model, &p.InputPrice, &p.OutputPrice, &p.CachedPrice, &tiersRaw)
	if err != nil {
		return ModelPrice{}, false
	}
	if tiers, perr := ParseContextTiers(tiersRaw); perr == nil {
		p.ContextTiers = tiers
	}
	return p, true
}

// PromptCostTokens 把「含缓存的总输入」拆成按输入价计的部分和按缓存价计的部分。
//
// OpenAI / 本站日志的 prompt_tokens 已经包含缓存命中。缓存 token 只按
// cached_price 计一次，必须从输入里扣掉，不能再按输入价加一遍。
// cached 大于 prompt（上报把缓存放在总输入之外）时，输入部分记 0，
// 缓存仍按自身数量计一次，避免出现负数或再叠加。
func PromptCostTokens(promptTokens, cachedTokens int) (input, cached int) {
	if promptTokens < 0 {
		promptTokens = 0
	}
	if cachedTokens < 0 {
		cachedTokens = 0
	}
	if cachedTokens > promptTokens {
		return 0, cachedTokens
	}
	return promptTokens - cachedTokens, cachedTokens
}

// CostExpression 是一次调用的未取整成本（货币，不是额度单位）。
//
// 调用方需要先按 PriceForTokens 选好档位。缓存 token 只进入缓存价这一项。
func CostExpression(promptTokens, completionTokens, cachedTokens int, price ModelPrice) float64 {
	input, cached := PromptCostTokens(promptTokens, cachedTokens)
	return float64(input)/1e6*price.InputPrice +
		float64(completionTokens)/1e6*price.OutputPrice +
		float64(cached)/1e6*price.CachedPrice
}

// CalcQuota 计算一次调用的额度消耗（单位）。
//
// 公式：(未缓存输入/1e6 × 输入价 + 补全/1e6 × 输出价 + 缓存/1e6 × 缓存价) × unitsPerOD
// 未缓存输入 = prompt_tokens − cached_tokens（prompt 含缓存时）。
// 结果为向上取整，单次最低 1 单位 —— 避免极小调用记成 0 导致免费刷量。
//
// 输入 token 数会先经过 PriceForTokens 选定长上下文档位：
// 请求量达到某档时整次按该档单价计价（与上游切档规则一致）。
func CalcQuota(promptTokens, completionTokens, cachedTokens int, price ModelPrice, unitsPerOD int) int64 {
	if unitsPerOD <= 0 {
		unitsPerOD = DefaultUnitsPerOD
	}
	price = PriceForTokens(price, promptTokens)

	quota := int64(math.Ceil(CostExpression(promptTokens, completionTokens, cachedTokens, price) * float64(unitsPerOD)))
	if quota < 1 {
		quota = 1
	}
	return quota
}

// LookupBillablePrice 解析出本次调用真正可用的定价。
//
// 顺序：显式映射 → 官方 id（注册表别名）→ 原名。命中一行还不够：
// 官方模型若三个单价都是 0，且不是注册表里标明的免费模型，视为没有可用定价
// （不能按 0 元放行）。非官方名字上管理员显式保存的 0 价行仍然有效。
func LookupBillablePrice(model string) (ModelPrice, bool) {
	var names []string
	add := func(name string) {
		key := normalizeModelKey(name)
		if key == "" {
			return
		}
		for _, existing := range names {
			if existing == key {
				return
			}
		}
		names = append(names, key)
	}
	resolved := ResolveModelForPricing(model, HasPrice)
	add(resolved)
	add(CanonicalModelName(model))
	add(CanonicalModelName(resolved))
	add(model)

	for _, name := range names {
		price, ok := PriceOf(name)
		if !ok || !priceRowUsable(price) {
			continue
		}
		return price, true
	}
	return ModelPrice{}, false
}

// priceRowUsable 判断一条已存在的定价能不能用来扣费。
func priceRowUsable(price ModelPrice) bool {
	if pricedComponents(price.InputPrice, price.OutputPrice, price.CachedPrice) {
		return true
	}
	for _, tier := range price.ContextTiers {
		if pricedComponents(tier.InputPrice, tier.OutputPrice, tier.CachedPrice) {
			return true
		}
	}
	real, isReal := LookupRealModel(price.Model)
	if !isReal {
		// 注册表之外的名字：管理员保存过这一行，0 价是显式选择。
		return true
	}
	return isFreeModel(real)
}

func pricedComponents(input, output, cached float64) bool {
	return input > 0 || output > 0 || cached > 0
}

// HasPrice 判断某个模型名是否配了定价。
//
// 走与 PriceOf 同一份缓存：模型映射需要它来判断
// 「这个上游模型名本站是否已有价格」，从而决定要不要套映射。
func HasPrice(model string) bool {
	_, ok := PriceOf(strings.ToLower(strings.TrimSpace(model)))
	return ok
}

// UpsertPrice 写入或更新一个模型的定价。
//
// 与 handlers 里的 upsert 同一语义（按模型名唯一），但放在 service 层，
// 让「绑定真实模型」这类非 HTTP 场景也能写价，不必绕到 handler。
func UpsertPrice(p ModelPrice) error {
	if db.DB == nil {
		return errors.New("数据库未初始化")
	}
	model := strings.ToLower(strings.TrimSpace(p.Model))
	if model == "" {
		return errors.New("模型名不能为空")
	}
	var tiers any
	if len(p.ContextTiers) > 0 {
		tiers = EncodeContextTiers(p.ContextTiers)
	}
	if _, err := db.DB.Exec(
		`INSERT INTO model_prices (model, input_price, output_price, cached_price, context_tiers)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   input_price = VALUES(input_price),
		   output_price = VALUES(output_price),
		   cached_price = VALUES(cached_price),
		   context_tiers = VALUES(context_tiers)`,
		model, p.InputPrice, p.OutputPrice, p.CachedPrice, tiers,
	); err != nil {
		return err
	}
	InvalidateModelMap()
	return nil
}
