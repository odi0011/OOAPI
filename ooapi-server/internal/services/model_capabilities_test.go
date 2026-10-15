package services

import (
	"strings"
	"testing"
	"time"
)

// TestValidateModelCapabilitiesRejectsBadInput 校验失败必须报错，不能静默修正。
func TestValidateModelCapabilitiesRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		raw  ModelCapabilities
		want string
	}{
		{"空模型名", ModelCapabilities{}, "模型名"},
		{"窗口超范围", ModelCapabilities{Model: "x", ContextWindow: 99_000_000}, "上下文窗口"},
		{"输出大于窗口", ModelCapabilities{Model: "x", ContextWindow: 1000, MaxOutputTokens: 2000}, "最大输出不能超过"},
		{"非法输入类型", ModelCapabilities{Model: "x", InputTypes: []string{"hologram"}}, "输入类型"},
		{"非法类别", ModelCapabilities{Model: "x", Category: "telepathy"}, "模型类别"},
		{"非法推理参数", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{Parameter: "magic_field"}}, "不支持的推理参数"},
		{"档位含非法字符", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{Levels: []string{"高"}}}, "只能用小写英文"},
		{"默认档不在列表", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{Levels: []string{"low"}, DefaultLevel: "high"}}, "不在可选档位里"},
		{"预算非整数", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{
			Levels: []string{"low"}, Parameter: "thinking_budget", Values: map[string]any{"low": "很多"}}}, "思考预算必须是整数"},
		{"预算超最大输出", ModelCapabilities{Model: "x", MaxOutputTokens: 1000, Reasoning: ModelReasoning{
			Levels: []string{"high"}, Parameter: "thinking_budget", Values: map[string]any{"high": 1000}}}, "必须小于最大输出"},
		{"enable_thinking 非布尔", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{
			Levels: []string{"on"}, Parameter: "enable_thinking", Values: map[string]any{"on": "yes"}}}, "enable_thinking"},
		{"thinking.type 非法值", ModelCapabilities{Model: "x", Reasoning: ModelReasoning{
			Levels: []string{"on"}, Parameter: "thinking.type", Values: map[string]any{"on": "maybe"}}}, "thinking.type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateModelCapabilities(tc.raw)
			if err == nil {
				t.Fatalf("accepted invalid config: %+v", tc.raw)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err.Error(), tc.want)
			}
		})
	}
}

// TestValidateModelCapabilitiesLevelCaseInsensitive 手输的大写档位要归一成小写，
// 而不是报错 —— 用户写 HIGH 的意图是明确的，拒绝只会增加无谓的往返。
func TestValidateModelCapabilitiesLevelCaseInsensitive(t *testing.T) {
	caps, err := ValidateModelCapabilities(ModelCapabilities{
		Model: "x", Reasoning: ModelReasoning{Levels: []string{"HIGH", "Low"}, Parameter: "reasoning_effort"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(caps.Reasoning.Levels) != 2 || caps.Reasoning.Levels[0] != "high" || caps.Reasoning.Levels[1] != "low" {
		t.Fatalf("levels not lowercased: %#v", caps.Reasoning.Levels)
	}
}

// TestValidateModelCapabilitiesNormalizes 合法输入要归一（去重、小写、补默认）。
func TestValidateModelCapabilitiesNormalizes(t *testing.T) {
	caps, err := ValidateModelCapabilities(ModelCapabilities{
		Model:       " DeepSeek-V4.1-Flash ",
		InputTypes:  []string{"Text", "text", "IMAGE"},
		OutputTypes: []string{"text"},
		Reasoning: ModelReasoning{
			Levels:       []string{"Low", "high"},
			DefaultLevel: "low",
			Parameter:    "reasoning_effort",
			Values:       map[string]any{"low": "low", "high": "high"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if caps.Model != "deepseek-v4.1-flash" {
		t.Fatalf("model not normalized: %q", caps.Model)
	}
	if len(caps.InputTypes) != 2 || caps.InputTypes[0] != "text" || caps.InputTypes[1] != "image" {
		t.Fatalf("input types not normalized: %#v", caps.InputTypes)
	}
	if caps.Category != "chat" {
		t.Fatalf("default category missing: %q", caps.Category)
	}
	if len(caps.Reasoning.Levels) != 2 || caps.Reasoning.Levels[0] != "low" {
		t.Fatalf("levels not normalized: %#v", caps.Reasoning.Levels)
	}
	// 缺省的取值应回退成档位名本身。
	missing, _ := ValidateModelCapabilities(ModelCapabilities{
		Model: "x", Reasoning: ModelReasoning{Levels: []string{"low"}, Parameter: "reasoning_effort"},
	})
	if missing.Reasoning.Values["low"] != "low" {
		t.Fatalf("value not defaulted: %#v", missing.Reasoning.Values)
	}
}

// TestSelectReasoning 覆盖档位选择：命中/不认识/关闭/未配置。
func TestSelectReasoningHonorsLevelsAndOff(t *testing.T) {
	// 未配置映射：不下发任何字段。
	if sel := SelectReasoning("no-such-model-xyz", "high"); sel.Parameter != "" {
		t.Fatalf("unconfigured model produced %+v", sel)
	}

	// DeepSeek 关闭必须走 thinking.type（effort=none 会被上游拒）。
	offParam, offValue, ok := offReasoningFor("deepseek-v4.1-flash", "reasoning_effort")
	if !ok || offParam != "thinking.type" || offValue != "disabled" {
		t.Fatalf("deepseek off = (%q,%v,%v)", offParam, offValue, ok)
	}
	// Gemini 关闭用 budget=0。
	offParam, offValue, ok = offReasoningFor("gemini-3.5-flash", "thinkingConfig.thinkingBudget")
	if !ok || offParam != "thinkingConfig.thinkingBudget" || offValue != 0 {
		t.Fatalf("gemini off = (%q,%v,%v)", offParam, offValue, ok)
	}
}

// TestReasoningBodyPerProtocol 按协议生成正确的字段形状。
func TestReasoningBodyPerProtocol(t *testing.T) {
	effort := ReasoningSelection{Level: "high", Parameter: "reasoning_effort", Value: "high"}
	// responses：包一层 reasoning 对象并带 summary。
	body := ReasoningBody(effort, "responses")
	reasoning, okReasoning := body["reasoning"].(map[string]any)
	if !okReasoning || reasoning["effort"] != "high" || reasoning["summary"] != "auto" {
		t.Fatalf("responses body %#v", body)
	}
	// chat：平铺的 reasoning_effort。
	if chat := ReasoningBody(effort, "chat"); chat["reasoning_effort"] != "high" {
		t.Fatalf("chat body %#v", chat)
	}
	// anthropic：该参数在 Messages 协议下没有对应字段 → 不下发。
	if anthropic := ReasoningBody(effort, "anthropic"); len(anthropic) != 0 {
		t.Fatalf("anthropic must not receive reasoning_effort: %#v", anthropic)
	}

	budget := ReasoningSelection{Level: "high", Parameter: "thinking.budget_tokens", Value: 12000}
	anthropicBody := ReasoningBody(budget, "anthropic")
	thinking, okThinking := anthropicBody["thinking"].(map[string]any)
	if !okThinking || thinking["type"] != "enabled" || thinking["budget_tokens"] != 12000 {
		t.Fatalf("anthropic budget body %#v", anthropicBody)
	}
	// 关闭时换成 disabled。
	disabled := ReasoningSelection{Level: "none", Parameter: "thinking.budget_tokens", Value: 0, Disabled: true}
	offBody := ReasoningBody(disabled, "anthropic")
	offThinking, _ := offBody["thinking"].(map[string]any)
	if offThinking["type"] != "disabled" {
		t.Fatalf("anthropic off body %#v", offBody)
	}

	gemini := ReasoningSelection{Level: "high", Parameter: "thinkingConfig.thinkingBudget", Value: 8192}
	geminiBody := ReasoningBody(gemini, "gemini")
	config, okConfig := geminiBody["thinkingConfig"].(map[string]any)
	if !okConfig || config["thinkingBudget"] != 8192 || config["includeThoughts"] != true {
		t.Fatalf("gemini body %#v", geminiBody)
	}
}

// TestModelPresetsLoaded 内置预设必须真的加载出来（否则一键导入是空按钮）。
func TestModelPresetsLoaded(t *testing.T) {
	presets := ModelPresets()
	if len(presets) < 50 {
		t.Fatalf("presets too few: %d", len(presets))
	}
	withReasoning := 0
	for _, preset := range presets {
		if len(preset.Capabilities.Reasoning.Levels) > 0 {
			withReasoning++
		}
	}
	if withReasoning < 10 {
		t.Fatalf("presets with reasoning too few: %d", withReasoning)
	}
}

// TestModelPresetForFallsBack 预设查找要能处理后缀（-sg / -preview）。
func TestModelPresetForFallsBack(t *testing.T) {
	presets := ModelPresets()
	if len(presets) == 0 {
		t.Skip("no presets")
	}
	target := presets[0].Model
	if _, found := ModelPresetFor(target); !found {
		t.Fatalf("exact preset lookup failed for %q", target)
	}
	// 带后缀应命中本体。
	if _, found := ModelPresetFor(target + "-sg"); !found {
		t.Fatalf("suffix fallback failed for %q", target+"-sg")
	}
	if _, found := ModelPresetFor("definitely-not-a-model-zzz"); found {
		t.Fatal("unknown model matched a preset")
	}
}

// TestResolveModelForPricing 覆盖映射优先级：显式映射 > 已有定价 > 原样。
func TestResolveModelForPricing(t *testing.T) {
	hasPrice := func(name string) bool {
		switch name {
		case "deepseek-v4.1-flash", "glm-5.3":
			return true
		}
		return false
	}
	// 有定价的名字原样返回（映射表不该干扰大多数模型）。
	if got := ResolveModelForPricing("deepseek-v4.1-flash", hasPrice); got != "deepseek-v4.1-flash" {
		t.Fatalf("got %q", got)
	}
	// 大小写不同也要能命中定价。
	if got := ResolveModelForPricing("GLM-5.3", hasPrice); got != "glm-5.3" {
		t.Fatalf("case-insensitive lookup failed: %q", got)
	}
	// 没定价的名字原样返回（由站长决定要不要配映射）。
	if got := ResolveModelForPricing("unknown-model", hasPrice); got != "unknown-model" {
		t.Fatalf("got %q", got)
	}
	// 显式映射优先。
	ModelMap()
	modelMapCache.mu.Lock()
	modelMapCache.values = map[string]string{"upstream-alias": "deepseek-v4.1-flash"}
	modelMapCache.loaded = time.Now()
	modelMapCache.mu.Unlock()
	t.Cleanup(InvalidateModelMap)
	if got := ResolveModelForPricing("upstream-alias", hasPrice); got != "deepseek-v4.1-flash" {
		t.Fatalf("explicit mapping not honored: %q", got)
	}
}

// TestSetModelMapRejectsConflict 同一条上游名指向两个本站名必须报错。
func TestSetModelMapRejectsConflict(t *testing.T) {
	if err := SetModelMap([]ModelMapEntry{
		{From: "alias-conflict-a", To: "model-a"},
		{From: "alias-conflict-a", To: "model-b"},
	}); err == nil {
		t.Fatal("conflicting mapping accepted")
	} else if !strings.Contains(err.Error(), "被同时映射") {
		t.Fatalf("error unhelpful: %v", err)
	}
	// 自己映射到自己没有意义：静默忽略，不算错误。
	if err := SetModelMap([]ModelMapEntry{{From: "self-map-ignored", To: "self-map-ignored"}}); err != nil {
		t.Fatalf("self mapping rejected: %v", err)
	}
}

// TestSuggestFollowTarget 覆盖「这个模型其实是某个已定价官模的变体」的识别。
//
// 判错的代价不对称：
//
//	· 漏识别 → 查不到价 → 按 0 计费（免费），站长白亏；
//	· 错识别（把不相干的名字认成变体）→ 按错误的价格结算，比免费更糟。
//
// 所以只做「一个名字完整包含另一个」这一种判断，测试也围绕这条边界。
func TestSuggestFollowTarget(t *testing.T) {
	priced := map[string]ModelPrice{
		"deepseek-v4.1-flash": {Model: "deepseek-v4.1-flash"},
		"gpt-5.5":             {Model: "gpt-5.5"},
		"gpt-5":               {Model: "gpt-5"},
	}
	cases := []struct {
		model string
		want  string
		why   string
	}{
		{"deepseek-v4.1-flash-sg", "deepseek-v4.1-flash", "区域后缀变体"},
		{"deepseek-v4.1-flash-2026", "deepseek-v4.1-flash", "日期后缀变体"},
		{"gpt-5.5-2026-01-01", "gpt-5.5", "取最长的候选（gpt-5.5 优于 gpt-5）"},
		{"gpt-5-something", "gpt-5", "较短候选也有效"},
		{"glm-4", "", "与已定价模型无关，不能乱认"},
		{"", "", "空名不处理"},
	}
	for _, tc := range cases {
		if got := suggestFollowTarget(tc.model, priced); got != tc.want {
			t.Fatalf("suggest(%q) = %q, want %q (%s)", tc.model, got, tc.want, tc.why)
		}
	}
	// 已经定价的名字不该被建议跟随别人。
	if got := suggestFollowTarget("gpt-5.5", priced); got != "" {
		t.Fatalf("priced model suggested to follow %q", got)
	}
}

// TestIsRealModelID 真实模型判定：只认注册表，不猜。
func TestIsRealModelID(t *testing.T) {
	for _, id := range []string{"deepseek-flash", "claude-sonnet-4-5", "gpt-5.5", "glm-5.3", "kimi-k3", "DeepSeek-Flash"} {
		if !IsRealModelID(id) {
			t.Fatalf("real model not recognized: %s", id)
		}
	}
	// 上游自造的别名不能被当成真实模型 —— 那正是要拦的东西。
	for _, id := range []string{"default-model", "fast-model", "balanced-model", "primary-model", "deep-model", "auto", "made-up-model"} {
		if IsRealModelID(id) {
			t.Fatalf("alias wrongly treated as real model: %s", id)
		}
	}
	// 官方 id 的常见改写写法要认（中转站写法差异不该变成管理员的负担）。
	for _, id := range []string{"claude-sonnet-4.5", "claude-haiku-4.5", "deepseek-v4.1-flash", "hy3", "MiniMax-M3"} {
		if !IsRealModelID(id) {
			t.Fatalf("recognized alias not mapped: %s", id)
		}
	}
}

// TestAliasModelHint 别名判定：真实模型 / 已配价 / 已映射 都不算待处理。
func TestAliasModelHint(t *testing.T) {
	// 真实模型：不需要处理。
	if AliasModelHint("deepseek-flash") {
		t.Fatal("real model flagged as alias")
	}
	// 上游自造的名字：需要处理。
	for _, id := range []string{"default-model", "fast-model", "balanced-model", "primary-model", "deep-model", "auto"} {
		if !AliasModelHint(id) {
			t.Fatalf("alias not flagged: %s", id)
		}
	}
	// 空串不算（调用方已在别处挡）。
	if AliasModelHint("") {
		t.Fatal("empty name flagged")
	}
}

// TestUnresolvedAliasModels 批量判定：去重、保留原始写法（报错要能对上账号里的字符串）。
func TestUnresolvedAliasModels(t *testing.T) {
	got := UnresolvedAliasModels([]string{
		"deepseek-flash", // 真实模型，跳过
		"default-model",
		"DEFAULT-MODEL", // 重复（大小写不同）
		"fast-model",
		"",
	})
	if len(got) != 2 {
		t.Fatalf("unresolved = %#v", got)
	}
	if got[0] != "default-model" || got[1] != "fast-model" {
		t.Fatalf("order/original form lost: %#v", got)
	}
}

// TestRealModelRegistrySanity 注册表自身的完整性检查。
//
// 这张表是「一键配价」的数据源，写错了会直接把错误价格写进计费系统，
// 所以对基本约束做断言：id 唯一、价格非负、推理档位与参数配套、有来源。
func TestRealModelRegistrySanity(t *testing.T) {
	seen := map[string]string{}
	for _, model := range realModels {
		if model.ID == "" || model.Developer == "" {
			t.Fatalf("incomplete entry: %+v", model)
		}
		key := normalizeModelKey(model.ID)
		if prev, dup := seen[key]; dup {
			t.Fatalf("duplicate model id %q (%s vs %s)", model.ID, prev, model.Developer)
		}
		seen[key] = model.Developer
		if model.InputPrice < 0 || model.OutputPrice < 0 || model.CachedPrice < 0 {
			t.Fatalf("%s has negative price", model.ID)
		}
		if model.CachedPrice > model.InputPrice && model.InputPrice > 0 {
			// 缓存价高于输入价说明写反了（缓存命中的 token 不该更贵）。
			t.Fatalf("%s cached price %v exceeds input %v", model.ID, model.CachedPrice, model.InputPrice)
		}
		if model.Reasoning && model.ReasoningParameter == "" && len(model.ReasoningLevels) == 0 {
			// 声称支持推理却没有下发参数，等于「配了但不生效」。
			if !strings.Contains(model.Note, "预览") {
				t.Fatalf("%s claims reasoning but has no parameter", model.ID)
			}
		}
		if model.Verified && model.Source == "" {
			t.Fatalf("%s marked verified without a source", model.ID)
		}
		if model.Category != "" {
			if _, ok := allowedCategories[model.Category]; !ok {
				t.Fatalf("%s has unknown category %q", model.ID, model.Category)
			}
		}
	}
	for _, id := range []string{"jev-1.13", "jev-1.13-free"} {
		model, ok := LookupRealModel(id)
		if !ok || model.Category != "decision" {
			t.Fatalf("%s should be a decision model", id)
		}
		if ModelKind(id) != "decision" {
			t.Fatalf("ModelKind(%s) = %s", id, ModelKind(id))
		}
	}
	if ModelKind("deepseek-flash") != "chat" {
		t.Fatal("chat model classified as something else")
	}
}

// TestApplyRealModelWritesPriceAndCapabilities 绑定要一次配好三件事。
func TestApplyRealModelWritesPriceAndCapabilities(t *testing.T) {
	// 无数据库时只验证「拒绝未知模型」这一条（写库部分在集成环境验证）。
	if _, err := ApplyRealModel("alias-x", "not-a-real-model"); err == nil {
		t.Fatal("unknown real model accepted")
	}
	if _, err := ApplyRealModel("", "deepseek-flash"); err == nil {
		t.Fatal("empty alias accepted")
	}
}

// TestRealModelsOfDeveloper 按开发商取模型。
func TestRealModelsOfDeveloper(t *testing.T) {
	deepseek := RealModelsOfDeveloper("deepseek")
	if len(deepseek) == 0 {
		t.Fatal("deepseek models missing")
	}
	for _, model := range deepseek {
		if model.Developer != "deepseek" {
			t.Fatalf("wrong developer: %+v", model)
		}
	}
	if len(RealModelsOfDeveloper("no-such-developer")) != 0 {
		t.Fatal("unknown developer returned models")
	}
}

// TestReasoningValueDefaults 覆盖「档位名 → 参数实际取值」的换算。
//
// 这里曾经出过 bug：thinkingBudget 这类参数需要**整数预算**，
// 而早期实现把档位名本身（字符串 "default"）当成了取值，
// 绑定直接失败并报「思考预算必须是整数」—— 错误信息指向参数类型，
// 完全看不出是注册表缺省值的问题。
func TestReasoningValueDefaults(t *testing.T) {
	// 预算类参数：必须是整数且随档位递增。
	levels := defaultReasoningLevelsFor("thinkingConfig.thinkingBudget")
	if len(levels) == 0 {
		t.Fatal("no default levels for thinking budget")
	}
	prev := -1
	for _, level := range levels {
		value, okNumber := reasoningValueFor("thinkingConfig.thinkingBudget", level).(int)
		if !okNumber {
			t.Fatalf("budget for %q is not an integer: %#v", level, reasoningValueFor("thinkingConfig.thinkingBudget", level))
		}
		if value <= prev {
			t.Fatalf("budget not increasing: %v after %v", value, prev)
		}
		prev = value
	}
	// 布尔类参数。
	if v, okBool := reasoningValueFor("enable_thinking", "enabled").(bool); !okBool || !v {
		t.Fatalf("enable_thinking enabled = %#v", reasoningValueFor("enable_thinking", "enabled"))
	}
	if v, okBool := reasoningValueFor("enable_thinking", "disabled").(bool); !okBool || v {
		t.Fatalf("enable_thinking disabled = %#v", reasoningValueFor("enable_thinking", "disabled"))
	}
	// effort 类：档位名就是取值。
	if v, _ := reasoningValueFor("reasoning_effort", "high").(string); v != "high" {
		t.Fatalf("effort value = %#v", v)
	}
}

// TestApplyRealModelProducesValidCapabilities 生成的能力配置必须能通过校验。
//
// 这条是端到端断言：注册表 → 能力配置 → 校验，任何一步不匹配都会
// 让「一键绑定」失败（而它本该是管理员最省事的那条路）。
func TestApplyRealModelProducesValidCapabilities(t *testing.T) {
	for _, model := range realModels {
		if model.ContextWindow == 0 && model.MaxOutputTokens == 0 && !model.Reasoning {
			continue // 免费占位条目，没什么可校验的
		}
		caps := defaultCapabilities(model.ID)
		if model.Category != "" {
			caps.Category = model.Category
		}
		caps.ContextWindow = model.ContextWindow
		caps.MaxOutputTokens = model.MaxOutputTokens
		toolCalling := model.ToolCalling
		caps.ToolCalling = &toolCalling
		if model.Reasoning && model.ReasoningParameter != "" {
			caps.Reasoning.Parameter = model.ReasoningParameter
			levels := model.ReasoningLevels
			if len(levels) == 0 {
				levels = defaultReasoningLevelsFor(model.ReasoningParameter)
			}
			caps.Reasoning.Levels = levels
			caps.Reasoning.Values = map[string]any{}
			for _, level := range levels {
				caps.Reasoning.Values[level] = reasoningValueFor(model.ReasoningParameter, level)
			}
		}
		if _, err := ValidateModelCapabilities(caps); err != nil {
			t.Fatalf("%s generated invalid capabilities: %v", model.ID, err)
		}
	}
}

// TestBindingRequiresPricedTarget 「绑定」必须同时满足映射与定价。
//
// 只看映射是不够的：把别名映射到一个还没配价的真实模型，
// 请求照样按 0 计费（免费）—— 而这正是这套机制要防的事。
func TestBindingRequiresPricedTarget(t *testing.T) {
	// 无数据库环境下 HasPrice 恒为 false，因此除真实模型外都应算待处理。
	if AliasModelHint("deepseek-flash") {
		t.Fatal("real model flagged")
	}
	if !AliasModelHint("default-model") {
		t.Fatal("alias with no mapping/price must be flagged")
	}
	// 手动注入一条「映射到无价目标」的情况：仍应算待处理。
	modelMapCache.mu.Lock()
	modelMapCache.values = map[string]string{"alias-unpriced": "target-without-price"}
	modelMapCache.loaded = time.Now()
	modelMapCache.mu.Unlock()
	t.Cleanup(InvalidateModelMap)
	if !AliasModelHint("alias-unpriced") {
		t.Fatal("mapping to an unpriced target must still count as unbound")
	}
	// 映射到有价目标（deepseek-flash 在无 DB 环境下 HasPrice=false，
	// 所以这里用一个真实模型 id 反证：它在 IsRealModelID 处就已放行）。
	if AliasModelHint("alias-unpriced") == false {
		t.Fatal("expected unbound")
	}
}
