package services

/*
上游模型名 → 本站模型名的映射。

为什么需要它：同一个模型在不同上游的**名字不一样**，而本站是按「本站模型名」
定价与计费的 —— 用户在我们的模型目录里看到的是 `deepseek-v4.1-flash`，
它的价格也是按这个键配的。但某种上游（如 WorkBuddy）返回/接受的名字可能
带后缀（`deepseek-v4.1-flash-sg`）或写法不同。这时如果直接拿上游名去查价，
会查不到、按 0 计费 —— 用户白用，站长白亏，而且没人会立刻发现。

映射表存在 options 表里，一行一条，格式：

	model_map:<上游模型名> = <本站模型名>

用 options 而不是新表：这就是一份纯配置（键值对），
options 已有的读写与缓存机制正好够用，加一张表只会多一套迁移与校验。

**方向性很重要**：映射只影响「计费与展示口径」，
不改变发给上游的模型名 —— 上游只认它自己的名字。
所以 lookup 用在两处：
  1. 计费前把上游/请求的模型名归一成本站模型名再查价；
  2. 日志的 pricing_model 字段记归一后的名字，事后对账能看懂。
*/

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// modelMapPrefix 是 options 表里映射项的键前缀。
const modelMapPrefix = "model_map:"

type modelMapCacheEntry struct {
	values map[string]string
	loaded time.Time
	ttl    time.Duration
	mu     sync.RWMutex
}

var modelMapCache = &modelMapCacheEntry{ttl: 10 * time.Second}

// normalizeModelKey 归一模型名的比较形式：小写、去首尾空白。
// 上游大小写不统一（有的返回 GLM-5.3、有的返回 glm-5.3），
// 归一后才能稳定命中。
func normalizeModelKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// ModelMap 返回当前的映射表副本（键与值都已归一为小写）。
func ModelMap() map[string]string {
	modelMapCache.mu.RLock()
	if modelMapCache.values != nil && time.Since(modelMapCache.loaded) < modelMapCache.ttl {
		out := make(map[string]string, len(modelMapCache.values))
		for k, v := range modelMapCache.values {
			out[k] = v
		}
		modelMapCache.mu.RUnlock()
		return out
	}
	modelMapCache.mu.RUnlock()

	loaded := map[string]string{}
	for key, value := range allOptionsWithPrefix(modelMapPrefix) {
		from := normalizeModelKey(strings.TrimPrefix(key, modelMapPrefix))
		to := normalizeModelKey(value)
		if from == "" || to == "" || from == to {
			continue
		}
		loaded[from] = to
	}

	modelMapCache.mu.Lock()
	modelMapCache.values = loaded
	modelMapCache.loaded = time.Now()
	modelMapCache.mu.Unlock()

	out := make(map[string]string, len(loaded))
	for k, v := range loaded {
		out[k] = v
	}
	return out
}

// InvalidateModelMap 清掉缓存（设置变动后立即调用，避免 10 秒内不生效）。
func InvalidateModelMap() {
	modelMapCache.mu.Lock()
	modelMapCache.loaded = time.Time{}
	modelMapCache.mu.Unlock()
}

/*
ResolveModelForPricing 把任意来源的模型名归一成本站用于查价的名字。

规则（顺序不能变）：
 1. 映射表命中 → 用映射后的名字（站长显式指定的优先级最高）；
 2. 直接能在定价表里查到 → 用它自己（不需要映射）；
 3. 都不命中 → 原样返回。

第 2 步很重要：映射表通常只配少数几条别名，
大多数模型本来就用本站名字，不该被映射表干扰。
*/
func ResolveModelForPricing(model string, hasPrice func(string) bool) string {
	trimmed := strings.TrimSpace(model)
	if trimmed == "" {
		return trimmed
	}
	if mapped, ok := ModelMap()[normalizeModelKey(trimmed)]; ok {
		return mapped
	}
	if hasPrice != nil && hasPrice(trimmed) {
		return trimmed
	}
	// 大小写不同但确实是同一个模型时也要能查到（定价存的是小写）。
	lower := normalizeModelKey(trimmed)
	if hasPrice != nil && hasPrice(lower) {
		return lower
	}
	return trimmed
}

// ModelMapEntries 返回排序后的映射项，供管理界面展示。
func ModelMapEntries() []ModelMapEntry {
	raw := ModelMap()
	out := make([]ModelMapEntry, 0, len(raw))
	for from, to := range raw {
		out = append(out, ModelMapEntry{From: from, To: to})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].From < out[j].From })
	return out
}

// ModelMapEntry 是一条映射（上游名 → 本站名）。
type ModelMapEntry struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// SetModelMap 整表替换映射关系（管理端保存）。
//
// 整表替换而不是逐条增删：界面就是一张可编辑的表，
// 逐条同步会在并发编辑时留下删不掉的孤儿项。
func SetModelMap(entries []ModelMapEntry) error {
	kv := map[string]string{}
	seen := map[string]string{}
	for _, entry := range entries {
		from := normalizeModelKey(entry.From)
		to := normalizeModelKey(entry.To)
		if from == "" || to == "" {
			continue
		}
		if from == to {
			continue
		}
		// 同一个上游名指向两个不同的本站名是配置错误，必须挡住 ——
		// 否则「计费按哪个价」取决于遍历顺序，账单会不可复现。
		if prev, dup := seen[from]; dup && prev != to {
			return &modelMapConflictError{From: from, A: prev, B: to}
		}
		seen[from] = to
		kv[modelMapPrefix+from] = to
	}
	// 先删掉旧的全部映射项，再写入新的 —— 否则被移除的条目会留在库里。
	if err := deleteOptionsWithPrefix(modelMapPrefix); err != nil {
		return err
	}
	if err := SetOptions(kv); err != nil {
		return err
	}
	InvalidateModelMap()
	return nil
}

// modelMapConflictError 表示同一条上游名被指向了多个本站模型。
type modelMapConflictError struct {
	From string
	A    string
	B    string
}

func (e *modelMapConflictError) Error() string {
	return "模型「" + e.From + "」被同时映射到「" + e.A + "」和「" + e.B + "」，请只保留一条"
}
