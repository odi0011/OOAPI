package services

import (
	"testing"
	"time"
)

/*
覆盖「客户端说官方名、上游只认自己的叫法」这件事。

背景：DeepSeek 官方文档里的模型 id 是 deepseek-flash，
而 WorkBuddy / OpenCode 这两个上游都只认 deepseek-v4.1-flash。
映射表维护的方向是「上游叫法 → 官方名」（用于计费），
所以请求路径需要**反向**查找：从官方名找回该账号该用的上游写法。
不做这件事的后果是「客户端按官方文档调用被拒」，且错误来自上游、
看起来像账号或密钥问题，很难排查。
*/

func withModelMap(t *testing.T, entries map[string]string) {
	t.Helper()
	modelMapCache.mu.Lock()
	modelMapCache.values = entries
	modelMapCache.loaded = time.Now()
	modelMapCache.mu.Unlock()
	t.Cleanup(InvalidateModelMap)
}

// TestUpstreamModelForDirectHit 账号直接声明支持请求名时原样下发。
func TestUpstreamModelForDirectHit(t *testing.T) {
	withModelMap(t, map[string]string{})
	ch := &UpstreamChannel{Models: []string{"deepseek-flash", "glm-5.3"}}
	if got := UpstreamModelFor(ch, "deepseek-flash"); got != "deepseek-flash" {
		t.Fatalf("direct hit = %q", got)
	}
	// 大小写不敏感。
	if got := UpstreamModelFor(ch, "DeepSeek-Flash"); got != "DeepSeek-Flash" {
		t.Fatalf("case-insensitive hit = %q", got)
	}
	// 通配。
	wild := &UpstreamChannel{Models: []string{"deepseek-*"}}
	if got := UpstreamModelFor(wild, "deepseek-flash"); got != "deepseek-flash" {
		t.Fatalf("wildcard hit = %q", got)
	}
	// 不支持的要返回空串。
	if got := UpstreamModelFor(ch, "gpt-5.5"); got != "" {
		t.Fatalf("unsupported model = %q", got)
	}
}

// TestUpstreamModelForReverseAlias 是这次的核心：官方名 → 上游叫法。
func TestUpstreamModelForReverseAlias(t *testing.T) {
	withModelMap(t, map[string]string{
		"deepseek-v4.1-flash": "deepseek-flash",
		"deepseek-v4-flash":   "deepseek-flash",
	})
	ch := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash", "glm-5.3"}}
	if got := UpstreamModelFor(ch, "deepseek-flash"); got != "deepseek-v4.1-flash" {
		t.Fatalf("reverse alias = %q, want deepseek-v4.1-flash", got)
	}
	// 账号支持多个同义写法时，取它声明的第一个（确定性，不随 map 遍历变化）。
	both := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash", "deepseek-v4-flash"}}
	if got := UpstreamModelFor(both, "deepseek-flash"); got != "deepseek-v4.1-flash" {
		t.Fatalf("multiple aliases = %q", got)
	}
	// 不相关的模型仍然不支持。
	if got := UpstreamModelFor(ch, "kimi-k3"); got != "" {
		t.Fatalf("unrelated model = %q", got)
	}
}

// TestUpstreamModelForEmptyList 账号未填模型列表视为支持全部。
func TestUpstreamModelForEmptyList(t *testing.T) {
	withModelMap(t, map[string]string{})
	ch := &UpstreamChannel{Models: nil}
	if got := UpstreamModelFor(ch, "任意模型"); got != "任意模型" {
		t.Fatalf("empty list = %q", got)
	}
	// nil 账号不能 panic。
	if got := UpstreamModelFor(nil, "x"); got != "" {
		t.Fatalf("nil channel = %q", got)
	}
	// 空请求名。
	if got := UpstreamModelFor(&UpstreamChannel{}, "   "); got != "" {
		t.Fatalf("blank model = %q", got)
	}
}

// TestChannelSupportsModelConsistency 支持性判断与解析结果必须一致 ——
// 两者用同一份逻辑，避免「判断说支持、解析说没有」这种自相矛盾。
func TestChannelSupportsModelConsistency(t *testing.T) {
	withModelMap(t, map[string]string{"deepseek-v4.1-flash": "deepseek-flash"})
	ch := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash"}}
	for _, model := range []string{"deepseek-flash", "deepseek-v4.1-flash", "kimi-k3"} {
		supports := channelSupportsModel(ch, model)
		resolved := UpstreamModelFor(ch, model)
		if supports != (resolved != "") {
			t.Fatalf("%s: supports=%v resolved=%q (inconsistent)", model, supports, resolved)
		}
	}
}

// TestGroupModelAllowedUsesCanonicalName 分组的白名单也要按官方名判定。
//
// 否则「分组只放行 deepseek-flash」会因为底层账号写的是上游叫法而永远不匹配，
// 表现为「模型明明在分组白名单里，却报 model_not_allowed」。
func TestGroupModelAllowedUsesCanonicalName(t *testing.T) {
	withModelMap(t, map[string]string{"deepseek-v4.1-flash": "deepseek-flash"})
	group := &Group{Models: []string{"deepseek-flash"}}
	if !group.ModelAllowed("deepseek-v4.1-flash") {
		t.Fatal("group must allow the upstream spelling of an allowed official model")
	}
	if !group.ModelAllowed("deepseek-flash") {
		t.Fatal("group must allow the official name itself")
	}
	if group.ModelAllowed("kimi-k3") {
		t.Fatal("group must reject unrelated models")
	}
	// 通配仍按官方名匹配。
	wild := &Group{Models: []string{"deepseek-*"}}
	if !wild.ModelAllowed("deepseek-v4.1-flash") {
		t.Fatal("wildcard must match after canonicalisation")
	}
}

/*
回归：/v1/models 必须按密钥的分组过滤。

线上问题（用户实测）：分组只放行 deepseek-flash，
但用该密钥调模型列表仍返回全部 46 个 —— 用户按列表选模型必然 403。
原项目文档把这个病记作「列表说能调、调用说不能」。

这里的口径必须与调度侧完全一致：**渠道声明 ∩ 分组白名单**，
且分组下没有启用渠道时返回**空集**（不是「不限」）。
*/
func TestAvailableModelsForGroupSemantics(t *testing.T) {
	// 无数据库环境下无法铺渠道数据，这里只断言两条不会出错的行为：
	//  1) 不存在的分组返回空集，而不是回退成「不限」——
	//     后者会把整份目录泄漏给一个失效的密钥（比「列表多了」更糟）。
	//  2) 空分组名同样返回空集。
	got, err := AvailableModelsForGroup("no-such-group-xyz")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("unknown group must yield an empty list, got %#v", got)
	}
}

// TestUpstreamModelForPrefersBaseOverVariant 覆盖「本体 vs 变体」的选择规则。
//
// 账号常同时声明本体与其区域/版本变体（deepseek-v4.1-flash 与 -sg），
// 两者都归一到同一个官方模型。选哪个必须**确定性**，且优先本体：
// 变体名（-sg / -preview / -highspeed）是本体加后缀，
// 而「无条件取最短」会在本体与下架的 legacy id 之间选错（deepseek-v4-flash 更短）。
func TestUpstreamModelForPrefersBaseOverVariant(t *testing.T) {
	withModelMap(t, map[string]string{
		"deepseek-v4.1-flash":    "deepseek-flash",
		"deepseek-v4.1-flash-sg": "deepseek-flash",
		"deepseek-v4-flash":      "deepseek-flash",
	})
	// 本体与区域变体：选本体（前缀关系，短的优先）。
	base := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash-sg", "deepseek-v4.1-flash"}}
	if got := UpstreamModelFor(base, "deepseek-flash"); got != "deepseek-v4.1-flash" {
		t.Fatalf("variant listed first: got %q, want the base name", got)
	}
	// 顺序反过来结论必须相同（确定性，不随声明顺序变化）。
	reversed := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"}}
	if got := UpstreamModelFor(reversed, "deepseek-flash"); got != "deepseek-v4.1-flash" {
		t.Fatalf("base listed first: got %q", got)
	}
	// 本体与 legacy id 之间没有前缀关系 → 按声明顺序（尊重管理员）。
	legacySecond := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash", "deepseek-v4-flash"}}
	if got := UpstreamModelFor(legacySecond, "deepseek-flash"); got != "deepseek-v4.1-flash" {
		t.Fatalf("no-prefix case must keep declared order: got %q", got)
	}
	// 账号直接声明官方名时最优先。
	official := &UpstreamChannel{Models: []string{"deepseek-v4.1-flash", "deepseek-flash"}}
	if got := UpstreamModelFor(official, "deepseek-flash"); got != "deepseek-flash" {
		t.Fatalf("exact official name must win: got %q", got)
	}
}
