package services

/*
模型能力与参数配置（原项目 model-capabilities 的 Go 版）。

两类信息放在这里：
  1. **能力元数据**：上下文窗口、最大输出、输入/输出类型、是否支持工具调用
     /结构化输出/原生搜索。用途是「网关知道自己该给这个模型什么预算」——
     上下文压缩阈值、参数校验、以及对外的模型目录展示。
  2. **推理强度映射**：各家下发思维链的参数名与取值完全不同
     （OpenAI 是 `reasoning_effort`、Anthropic 是 `thinking.budget_tokens` /
     `output_config.effort`、Gemini 是 `thinkingConfig.thinkingBudget`、
     DeepSeek 是 `thinking.type`）。这里把它统一成「档位 → (参数名, 取值)」，
     请求时按上游协议生成正确的字段。

存储：options 表，键 `model_caps:<模型名>`，值是 JSON。
与模型映射一致，用 options 而不是新表 —— 纯配置、按模型名寻址、
已有的读写与缓存机制够用。

**未核实就是未核实**：`verification` 字段区分「实测确认」与「未核实」，
没有把握的参数留空（null），不编造。空值在运行时走保守预算，
而不是假装知道。这是原项目的明确取舍，照做。
*/

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"ooapi/internal/db"
)

// modelCapsPrefix 是 options 表里模型能力项的键前缀。
const modelCapsPrefix = "model_caps:"

// ReasoningParameters 是允许的推理参数映射目标。
//
// 只列真实存在的上游参数名：写错一个字符的后果是「参数静默丢弃」，
// 用户以为开了深度思考，实际按默认档跑。所以用白名单，不做自由文本。
var ReasoningParameters = []string{
	"", // 不映射（该模型不支持调档）
	"reasoning_effort",
	"reasoning.effort",
	"thinking.type",
	"thinking.budget_tokens",
	"enable_thinking",
	"thinking_budget",
	"thinkingConfig.thinkingBudget",
	"thinkingConfig.thinkingLevel",
	"output_config.effort",
}

// ModelReasoning 是推理强度映射配置。
type ModelReasoning struct {
	// Levels 是可选档位（如 none/low/medium/high）。
	Levels []string `json:"levels"`
	// DefaultLevel 是默认档（必须是 Levels 里的一个）。
	DefaultLevel string `json:"default_level"`
	// Parameter 是下发到上游的参数名（必须是 ReasoningParameters 之一）。
	Parameter string `json:"parameter"`
	// Values 是「档位 → 实际取值」，缺省时用档位名本身。
	Values map[string]any `json:"values"`
}

// ModelCapabilities 是一个模型的能力与参数配置。
type ModelCapabilities struct {
	Model string `json:"model"`
	// ContextWindow / MaxOutputTokens 为 0 表示未核实（运行时走保守预算）。
	ContextWindow   int      `json:"context_window"`
	MaxOutputTokens int      `json:"max_output_tokens"`
	InputTypes      []string `json:"input_types"`
	OutputTypes     []string `json:"output_types"`
	// Category 是模型类别（chat / image / embedding …）。
	Category string `json:"category"`
	// 三态能力项：true / false / nil（未核实）。
	StructuredOutput *bool `json:"structured_output"`
	NativeSearch     *bool `json:"native_search"`
	SystemMessages   *bool `json:"system_messages"`
	ToolCalling      *bool `json:"tool_calling"`
	// Reasoning 是推理强度映射。
	Reasoning ModelReasoning `json:"reasoning"`
	// Verification 是核实状态（verified / unverified）。
	Verification string `json:"verification"`
	// Notes 是备注（给管理员看的说明）。
	Notes string `json:"notes"`
	// Customized 表示这份配置是管理员改过的（而非仅有默认值）。
	Customized bool `json:"customized"`
}

// allowedTypes 是输入/输出类型的合法取值。
var allowedTypes = map[string]struct{}{
	"text": {}, "image": {}, "video": {}, "audio": {}, "pdf": {}, "embedding": {},
}

// allowedCategories 是模型类别的合法取值。
var allowedCategories = map[string]struct{}{
	"chat": {}, "image": {}, "video": {}, "audio": {},
	"embedding": {}, "rerank": {}, "decision": {},
}

// maxReasoningLevels 是单模型允许的档位数上限（档位是给「关/低/中/高」这类
// 少量区分用的，再多只会让映射难以复核）。
const maxReasoningLevels = 16

type modelCapsCacheEntry struct {
	values map[string]ModelCapabilities
	loaded time.Time
	ttl    time.Duration
	mu     sync.RWMutex
}

var modelCapsCache = &modelCapsCacheEntry{ttl: 10 * time.Second}

// defaultCapabilities 是「没有任何配置」时的保守默认。
//
// 上下文窗口给 0（未核实）：调用方据此走保守预算，而不是假装知道。
func defaultCapabilities(model string) ModelCapabilities {
	return ModelCapabilities{
		Model:        normalizeModelKey(model),
		InputTypes:   []string{"text"},
		OutputTypes:  []string{"text"},
		Category:     "chat",
		Reasoning:    ModelReasoning{Levels: []string{}, Values: map[string]any{}},
		Verification: "unverified",
	}
}

// ModelCapabilitiesOf 返回某个模型的能力配置（未配置时给保守默认）。
//
// 查找顺序：精确命中 → 经模型映射归一后的名字 → 默认。
// 「经映射归一」这一步是必要的：上游模型名（deepseek-v4.1-flash-sg）
// 与本站模型名（deepseek-v4.1-flash）可能是两个键，
// 站长只需要给本站模型配一次能力。
func ModelCapabilitiesOf(model string) ModelCapabilities {
	all := loadModelCapabilities()
	key := normalizeModelKey(model)
	if caps, ok := all[key]; ok {
		return caps
	}
	if mapped, ok := ModelMap()[key]; ok {
		if caps, ok := all[mapped]; ok {
			caps.Model = key
			return caps
		}
	}
	return defaultCapabilities(model)
}

// ModelCapabilitiesConfigured 只返回「站长显式配置过」的能力（不做映射回退）。
// 管理界面用它与「未配置」区分开。
func ModelCapabilitiesConfigured(model string) (ModelCapabilities, bool) {
	caps, ok := loadModelCapabilities()[normalizeModelKey(model)]
	return caps, ok
}

// AllModelCapabilities 返回全部已配置项，按键名排序。
func AllModelCapabilities() []ModelCapabilities {
	all := loadModelCapabilities()
	out := make([]ModelCapabilities, 0, len(all))
	for _, caps := range all {
		out = append(out, caps)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out
}

// loadModelCapabilities 读取（带缓存）全部能力配置。
func loadModelCapabilities() map[string]ModelCapabilities {
	modelCapsCache.mu.RLock()
	if modelCapsCache.values != nil && time.Since(modelCapsCache.loaded) < modelCapsCache.ttl {
		out := modelCapsCache.values
		modelCapsCache.mu.RUnlock()
		return out
	}
	modelCapsCache.mu.RUnlock()

	loaded := map[string]ModelCapabilities{}
	for key, raw := range allOptionsWithPrefix(modelCapsPrefix) {
		name := normalizeModelKey(strings.TrimPrefix(key, modelCapsPrefix))
		if name == "" || strings.TrimSpace(raw) == "" {
			continue
		}
		var caps ModelCapabilities
		if json.Unmarshal([]byte(raw), &caps) != nil {
			// 坏配置不能让整个模型目录失效：跳过它，用默认值兜底。
			continue
		}
		caps.Model = name
		caps.Customized = true
		if caps.Reasoning.Values == nil {
			caps.Reasoning.Values = map[string]any{}
		}
		if caps.InputTypes == nil {
			caps.InputTypes = []string{"text"}
		}
		if caps.OutputTypes == nil {
			caps.OutputTypes = []string{"text"}
		}
		loaded[name] = caps
	}

	modelCapsCache.mu.Lock()
	modelCapsCache.values = loaded
	modelCapsCache.loaded = time.Now()
	modelCapsCache.mu.Unlock()
	return loaded
}

// InvalidateModelCapabilities 清缓存（保存后调用，立即可见）。
func InvalidateModelCapabilities() {
	modelCapsCache.mu.Lock()
	modelCapsCache.loaded = time.Time{}
	modelCapsCache.mu.Unlock()
}

// ValidateModelCapabilities 校验并规范化一份能力配置。
//
// 校验失败必须报错而不是静默丢弃：管理员改的是「网关给这个模型多少预算、
// 思维链怎么下发」，写错了会导致请求被上游拒或预算算错，静默修正更难查。
func ValidateModelCapabilities(raw ModelCapabilities) (ModelCapabilities, error) {
	out := defaultCapabilities(raw.Model)
	out.Model = normalizeModelKey(raw.Model)
	if out.Model == "" {
		return out, errors.New("请填写模型名")
	}
	if len([]rune(out.Model)) > 128 {
		return out, errors.New("模型名最长 128 个字符")
	}

	if raw.ContextWindow < 0 || raw.ContextWindow > 10_000_000 {
		return out, errors.New("上下文窗口应为 0–10000000 的整数（0 = 未核实）")
	}
	if raw.MaxOutputTokens < 0 || raw.MaxOutputTokens > 10_000_000 {
		return out, errors.New("最大输出应为 0–10000000 的整数（0 = 未核实）")
	}
	if raw.ContextWindow > 0 && raw.MaxOutputTokens > raw.ContextWindow {
		return out, errors.New("最大输出不能超过上下文窗口")
	}
	out.ContextWindow = raw.ContextWindow
	out.MaxOutputTokens = raw.MaxOutputTokens

	out.InputTypes = normalizeTypeList(raw.InputTypes)
	if len(out.InputTypes) == 0 {
		out.InputTypes = []string{"text"}
	}
	if err := assertTypes(out.InputTypes); err != nil {
		return out, errors.New("输入类型：" + err.Error())
	}
	out.OutputTypes = normalizeTypeList(raw.OutputTypes)
	if len(out.OutputTypes) == 0 {
		out.OutputTypes = []string{"text"}
	}
	if err := assertTypes(out.OutputTypes); err != nil {
		return out, errors.New("输出类型：" + err.Error())
	}

	category := strings.ToLower(strings.TrimSpace(raw.Category))
	if category == "" {
		category = "chat"
	}
	if _, okCategory := allowedCategories[category]; !okCategory {
		return out, errors.New("模型类别无效（可选：chat / image / video / audio / embedding / rerank / decision）")
	}
	out.Category = category

	out.StructuredOutput = raw.StructuredOutput
	out.NativeSearch = raw.NativeSearch
	out.SystemMessages = raw.SystemMessages
	out.ToolCalling = raw.ToolCalling

	reasoning, err := validateReasoning(raw.Reasoning, out.MaxOutputTokens)
	if err != nil {
		return out, err
	}
	out.Reasoning = reasoning

	switch strings.ToLower(strings.TrimSpace(raw.Verification)) {
	case "verified":
		out.Verification = "verified"
	default:
		out.Verification = "unverified"
	}
	out.Notes = strings.TrimSpace(raw.Notes)
	if len([]rune(out.Notes)) > 1200 {
		out.Notes = string([]rune(out.Notes)[:1200])
	}
	out.Customized = true
	return out, nil
}

// normalizeTypeList 去空白、去重、保序。
func normalizeTypeList(raw []string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, item := range raw {
		value := strings.ToLower(strings.TrimSpace(item))
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func assertTypes(types []string) error {
	for _, item := range types {
		if _, okType := allowedTypes[item]; !okType {
			return errors.New("不支持的取值「" + item + "」（可选：text / image / video / audio / pdf / embedding）")
		}
	}
	return nil
}

// validateReasoning 校验推理映射。
//
// 三条硬规则（都在原项目踩过坑）：
//
//	· 档位名只能是小写英文标识 —— 它会被当成 key 下发或被映射；
//	· 参数名必须在白名单里 —— 拼错就是静默失效；
//	· 思考预算必须是小于最大输出的整数 —— 否则上游直接 400。
func validateReasoning(raw ModelReasoning, maxOutput int) (ModelReasoning, error) {
	out := ModelReasoning{Levels: []string{}, Values: map[string]any{}}

	seen := map[string]struct{}{}
	for _, level := range raw.Levels {
		value := strings.ToLower(strings.TrimSpace(level))
		if value == "" {
			continue
		}
		if !isLevelIdent(value) {
			return out, errors.New("推理档位「" + level + "」只能用小写英文、数字、下划线或连字符")
		}
		if _, dup := seen[value]; dup {
			return out, errors.New("推理档位「" + value + "」重复")
		}
		seen[value] = struct{}{}
		out.Levels = append(out.Levels, value)
	}
	if len(out.Levels) > maxReasoningLevels {
		return out, errors.New("推理档位最多 16 个")
	}

	parameter := strings.TrimSpace(raw.Parameter)
	known := false
	for _, allowed := range ReasoningParameters {
		if parameter == allowed {
			known = true
			break
		}
	}
	if !known {
		return out, errors.New("不支持的推理参数映射：" + parameter)
	}
	out.Parameter = parameter

	defaultLevel := strings.ToLower(strings.TrimSpace(raw.DefaultLevel))
	if defaultLevel != "" && !containsString(out.Levels, defaultLevel) {
		return out, errors.New("默认档位「" + defaultLevel + "」不在可选档位里")
	}
	out.DefaultLevel = defaultLevel

	for _, level := range out.Levels {
		value, okValue := raw.Values[level]
		if !okValue || value == nil {
			value = level
		}
		if err := validateReasoningValue(parameter, value, maxOutput); err != nil {
			return out, errors.New("档位「" + level + "」：" + err.Error())
		}
		out.Values[level] = value
	}
	return out, nil
}

func isLevelIdent(s string) bool {
	if s == "" || len(s) > 24 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// validateReasoningValue 校验单个档位的取值。
func validateReasoningValue(parameter string, value any, maxOutput int) error {
	switch parameter {
	case "thinking.budget_tokens", "thinking_budget", "thinkingConfig.thinkingBudget":
		budget, okNumber := toIntValue(value)
		if !okNumber {
			return errors.New("思考预算必须是整数")
		}
		if budget < 0 {
			return errors.New("思考预算不能为负")
		}
		if maxOutput > 0 && budget >= maxOutput {
			return errors.New("思考预算必须小于最大输出（" + strconv.Itoa(maxOutput) + "）")
		}
		return nil
	case "enable_thinking":
		if _, okBool := value.(bool); !okBool {
			return errors.New("enable_thinking 只能映射到 true / false")
		}
		return nil
	case "thinking.type":
		text, _ := value.(string)
		switch strings.ToLower(strings.TrimSpace(text)) {
		case "enabled", "disabled", "adaptive":
			return nil
		}
		return errors.New("thinking.type 只能是 enabled / disabled / adaptive")
	}
	// 其余参数（effort 类 / thinkingLevel）取值是短字符串或整数。
	switch v := value.(type) {
	case string:
		if len(v) > 32 {
			return errors.New("取值最长 32 个字符")
		}
		return nil
	case bool:
		return nil
	case float64:
		if v != float64(int(v)) {
			return errors.New("取值必须是整数")
		}
		return nil
	}
	return errors.New("取值只能是字符串、整数或布尔值")
}

func toIntValue(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		if v == float64(int(v)) {
			return int(v), true
		}
	case json.Number:
		if parsed, err := v.Int64(); err == nil {
			return int(parsed), true
		}
	}
	return 0, false
}

// SaveModelCapabilities 保存一份能力配置（校验后写库）。
func SaveModelCapabilities(raw ModelCapabilities) (ModelCapabilities, error) {
	value, err := ValidateModelCapabilities(raw)
	if err != nil {
		return ModelCapabilities{}, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ModelCapabilities{}, errors.New("配置序列化失败")
	}
	if err := SetOptions(map[string]string{modelCapsPrefix + value.Model: string(encoded)}); err != nil {
		return ModelCapabilities{}, err
	}
	InvalidateModelCapabilities()
	return value, nil
}

// DeleteModelCapabilities 删除某个模型的能力配置（回到未核实默认）。
func DeleteModelCapabilities(model string) error {
	name := normalizeModelKey(model)
	if name == "" {
		return errors.New("模型名不能为空")
	}
	if err := deleteOptionsWithPrefix(modelCapsPrefix + name); err != nil {
		return err
	}
	InvalidateModelCapabilities()
	return nil
}

/* ---------- 推理强度选择与请求体生成 ---------- */

// ReasoningSelection 是一次推理强度的解析结果。
type ReasoningSelection struct {
	Level     string `json:"level"`
	Parameter string `json:"parameter"`
	Value     any    `json:"value"`
	Disabled  bool   `json:"disabled"`
}

/*
SelectReasoning 把客户端请求的推理强度解析成「参数名 + 取值」。

规则（对齐原项目）：

	· 请求为空 / none / disabled / off → 关掉思考（若模型支持关闭）；
	· 请求命中配置的档位 → 用它；
	· 请求不认识 → 取**最强**档（用户说要思考，就给足资源）；
	· 模型没配映射 → 返回空，调用方不下发任何推理字段。

关闭时的特殊处理：DeepSeek 的 effort 只接受「开启后的档位」，
关掉必须用 thinking.type=disabled，不能传 effort=none。
*/
func SelectReasoning(model, requested string) ReasoningSelection {
	caps := ModelCapabilitiesOf(model)
	levels := caps.Reasoning.Levels
	parameter := caps.Reasoning.Parameter
	input := strings.ToLower(strings.TrimSpace(requested))

	if len(levels) == 0 || parameter == "" {
		return ReasoningSelection{}
	}

	// 关闭意图。
	if input == "" || input == "none" || input == "disabled" || input == "off" {
		for _, level := range levels {
			if level == "none" || level == "disabled" || level == "off" {
				return ReasoningSelection{Level: "none", Parameter: parameter,
					Value: caps.Reasoning.Values[level], Disabled: true}
			}
		}
		// 配置里没有「关闭」档：按参数类型给一个明确的关闭值。
		offParameter, offValue, ok := offReasoningFor(model, parameter)
		if !ok {
			return ReasoningSelection{}
		}
		return ReasoningSelection{Level: "none", Parameter: offParameter, Value: offValue, Disabled: true}
	}

	// 命中配置档位。
	if containsString(levels, input) {
		return ReasoningSelection{Level: input, Parameter: parameter, Value: caps.Reasoning.Values[input]}
	}

	// 不认识的档位：取最强。
	strongest := levels[0]
	for _, level := range levels {
		if reasoningRank(level) > reasoningRank(strongest) {
			strongest = level
		}
	}
	return ReasoningSelection{Level: strongest, Parameter: parameter, Value: caps.Reasoning.Values[strongest]}
}

// reasoningRank 给常见档位一个强弱序，用于「请求了但不认识」时选最强。
// 不认识的档位按字典序位置处理（保持配置顺序）。
func reasoningRank(level string) int {
	switch level {
	case "minimal":
		return 1
	case "low":
		return 2
	case "medium":
		return 3
	case "high":
		return 4
	case "xhigh":
		return 5
	case "max":
		return 6
	}
	return 0
}

/*
offReasoningFor 返回「关闭思考」该用什么参数与取值。

不同厂商的关闭方式不一样，猜错会被上游拒或静默无效：

	· DeepSeek：effort 只接受开启档位，关闭必须用 thinking.type=disabled；
	· Anthropic：thinking.type=disabled；
	· Gemini：thinkingConfig.thinkingBudget=0；
	· OpenAI 系：output_config.effort=disabled / reasoning_effort=none。
*/
func offReasoningFor(model, parameter string) (string, any, bool) {
	lower := normalizeModelKey(model)
	if strings.HasPrefix(lower, "deepseek") {
		// 实测：deepseek 系列传 effort=none 会被拒，只有 thinking.type 能关。
		return "thinking.type", "disabled", true
	}
	switch parameter {
	case "thinking.budget_tokens", "thinking_budget":
		return parameter, 0, true
	case "thinkingConfig.thinkingBudget":
		return parameter, 0, true
	case "enable_thinking":
		return parameter, false, true
	case "thinking.type":
		return parameter, "disabled", true
	case "reasoning_effort", "reasoning.effort", "output_config.effort":
		return "thinking.type", "disabled", true
	}
	return "", nil, false
}

/*
ReasoningBody 按上游协议生成推理相关的请求体片段。

protocol 取值：chat（OpenAI 兼容）/ responses / anthropic / gemini。
返回的 map 会被合并进上游请求体。

**不相容的映射不下发**：例如把 reasoning_effort 透传给 Anthropic 协议
会被上游以「未知字段」拒掉，或者更糟 —— 静默忽略而管理员以为生效了。
*/
func ReasoningBody(selection ReasoningSelection, protocol string) map[string]any {
	if selection.Parameter == "" || selection.Level == "" {
		return nil
	}
	parameter, value := selection.Parameter, selection.Value

	switch protocol {
	case "responses":
		if parameter == "reasoning_effort" || parameter == "reasoning.effort" {
			return map[string]any{"reasoning": map[string]any{"effort": value, "summary": "auto"}}
		}
		return nil

	case "gemini":
		if strings.HasPrefix(parameter, "thinkingConfig.") {
			field := strings.TrimPrefix(parameter, "thinkingConfig.")
			return map[string]any{"thinkingConfig": map[string]any{field: value, "includeThoughts": true}}
		}
		return nil

	case "anthropic":
		if parameter == "output_config.effort" {
			if selection.Disabled {
				return map[string]any{"thinking": map[string]any{"type": "disabled"}}
			}
			return map[string]any{
				"thinking":      map[string]any{"type": "adaptive"},
				"output_config": map[string]any{"effort": value},
			}
		}
		if parameter == "thinking.budget_tokens" {
			if selection.Disabled {
				return map[string]any{"thinking": map[string]any{"type": "disabled"}}
			}
			return map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": value}}
		}
		if parameter == "thinking.type" {
			return map[string]any{"thinking": map[string]any{"type": value}}
		}
		return nil

	default: // chat（OpenAI 兼容）
		switch parameter {
		case "reasoning_effort":
			return map[string]any{"reasoning_effort": value}
		case "reasoning.effort":
			return map[string]any{"reasoning": map[string]any{"effort": value}}
		case "enable_thinking":
			return map[string]any{"enable_thinking": value}
		case "thinking_budget":
			return map[string]any{"thinking_budget": value}
		case "thinking.type":
			return map[string]any{"thinking": map[string]any{"type": value}}
		case "thinking.budget_tokens":
			if selection.Disabled {
				return map[string]any{"thinking": map[string]any{"type": "disabled"}}
			}
			return map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": value}}
		case "thinkingConfig.thinkingBudget", "thinkingConfig.thinkingLevel":
			field := strings.TrimPrefix(parameter, "thinkingConfig.")
			return map[string]any{"thinkingConfig": map[string]any{field: value, "includeThoughts": true}}
		}
		return nil
	}
}

// ContextWindowOf 返回模型上下文窗口（未核实返回 0）。
func ContextWindowOf(model string) int {
	return ModelCapabilitiesOf(model).ContextWindow
}

// SupportsToolCalling 返回模型是否支持工具调用（未核实按支持处理）。
//
// 未核实为什么按支持：绝大多数 chat 模型都支持，按不支持会把功能关掉，
// 而站长看到的是「工具用不了」；按支持则最坏情况是上游回一句明确的错误。
func SupportsToolCalling(model string) bool {
	caps := ModelCapabilitiesOf(model)
	if caps.ToolCalling == nil {
		return true
	}
	return *caps.ToolCalling
}

/* ---------- 管理端辅助 ---------- */

// LoadUpstreamChannelModels 返回所有账号声明的上游模型名（去重前）。
//
// 用在校验与提示上：账号里配了、但本站定价表里没有的模型名，
// 会按 0 计费（免费），需要在管理界面提醒站长。
func LoadUpstreamChannelModels() ([]string, error) {
	if db.DB == nil {
		return nil, nil
	}
	rows, err := db.DB.Query("SELECT COALESCE(models, '') FROM channels")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			continue
		}
		for _, part := range strings.Split(raw, ",") {
			if v := strings.TrimSpace(part); v != "" {
				out = append(out, v)
			}
		}
	}
	return out, nil
}

// ListPriceModels 返回定价表里已有的模型名（供管理端做候选提示）。
func ListPriceModels() []string {
	if db.DB == nil {
		return nil
	}
	rows, err := db.DB.Query("SELECT model FROM model_prices ORDER BY model")
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var model string
		if err := rows.Scan(&model); err == nil {
			out = append(out, model)
		}
	}
	return out
}

/* ---------- 模型目录（管理端总览） ---------- */

// ModelCatalogChannel 是「某个模型被哪些账号支持」里的一个账号。
type ModelCatalogChannel struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Vendor string `json:"vendor"`
	Method string `json:"method"`
	Status int    `json:"status"`
}

// ModelCatalogEntry 是一个模型在管理端的完整视图。
type ModelCatalogEntry struct {
	Model string `json:"model"`
	// Channels 是声明支持该模型的账号。
	Channels []ModelCatalogChannel `json:"channels"`
	// Priced 表示本站定价表里有没有它（没有 = 按 0 计费）。
	Priced bool `json:"priced"`
	// Price 是当前生效的定价（已套用映射后的结果）。
	Price *ModelPrice `json:"price,omitempty"`
	// FollowTarget 是这个模型应该跟随的「已配置官模」。
	//   · 空串 = 它就是自己（已定价，或有独立配置）；
	//   · 非空且 Followed = true  → 已按官模结算；
	//   · 非空且 Followed = false → 检测到可以跟随，但还没配（界面提示一键跟随）。
	FollowTarget string `json:"follow_target,omitempty"`
	Followed     bool   `json:"followed"`
	// Capabilities 是能力配置；Customized 为 false 表示用的是预设/默认。
	Capabilities *ModelCapabilities `json:"capabilities,omitempty"`
}

// LoadModelCatalog 组装管理端的模型总览。
//
// 数据来源三处：账号声明的模型清单（谁支持什么）、定价表（多少钱）、
// 能力配置与映射表（怎么用）。合成的目的是让管理员在一屏里看清
// 「这个模型有没有人配过价、该跟随谁、被哪些账号支持」——
// 这三件事分散在三个页面时，漏配是常态。
func LoadModelCatalog() ([]ModelCatalogEntry, error) {
	if db.DB == nil {
		return []ModelCatalogEntry{}, nil
	}
	rows, err := db.DB.Query("SELECT id, name, vendor, method, status, COALESCE(models, '') FROM channels ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 模型 → 账号列表（保持声明顺序去重）。
	byModel := map[string]*ModelCatalogEntry{}
	order := []string{}
	for rows.Next() {
		var (
			id, status                      int64
			name, vendor, method, modelsRaw string
		)
		if err := rows.Scan(&id, &name, &vendor, &method, &status, &modelsRaw); err != nil {
			continue
		}
		seen := map[string]struct{}{}
		for _, part := range strings.Split(modelsRaw, ",") {
			raw := strings.TrimSpace(part)
			if raw == "" {
				continue
			}
			key := normalizeModelKey(raw)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}

			entry, okEntry := byModel[key]
			if !okEntry {
				entry = &ModelCatalogEntry{Model: key}
				byModel[key] = entry
				order = append(order, key)
			}
			entry.Channels = append(entry.Channels, ModelCatalogChannel{
				ID: id, Name: name, Vendor: vendor, Method: method, Status: int(status),
			})
		}
	}

	mapping := ModelMap()
	priced := map[string]ModelPrice{}
	if priceRows, priceErr := db.DB.Query("SELECT model, input_price, output_price, cached_price FROM model_prices"); priceErr == nil {
		for priceRows.Next() {
			var p ModelPrice
			if err := priceRows.Scan(&p.Model, &p.InputPrice, &p.OutputPrice, &p.CachedPrice); err == nil {
				priced[normalizeModelKey(p.Model)] = p
			}
		}
		priceRows.Close()
	}
	configured := loadModelCapabilities()

	out := make([]ModelCatalogEntry, 0, len(order))
	for _, key := range order {
		entry := *byModel[key]

		// 定价：先看自己，再看映射目标。
		if price, okPrice := priced[key]; okPrice {
			entry.Priced = true
			priceCopy := price
			entry.Price = &priceCopy
		} else if target, okMap := mapping[key]; okMap {
			if price, okPrice := priced[target]; okPrice {
				entry.Priced = true
				priceCopy := price
				entry.Price = &priceCopy
				entry.FollowTarget = target
				entry.Followed = true
			}
		}

		// 还没配映射时，检测「可以跟随谁」：已定价的更长前缀/短前缀命中。
		if entry.FollowTarget == "" && !entry.Priced {
			if target := suggestFollowTarget(key, priced); target != "" {
				entry.FollowTarget = target
			}
		}

		// 能力配置：自己的，或跟随目标那份（跟随是默认行为）。
		if caps, okCaps := configured[key]; okCaps {
			capsCopy := caps
			entry.Capabilities = &capsCopy
		} else if entry.FollowTarget != "" {
			if caps, okCaps := configured[entry.FollowTarget]; okCaps {
				capsCopy := caps
				entry.Capabilities = &capsCopy
			}
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	return out, nil
}

// suggestFollowTarget 检测「这个模型名是不是某个已定价模型的后缀/前缀变体」。
//
// 上游的模型名常带区域或版本后缀（deepseek-v4.1-flash-sg、
// gpt-5.5-2026-01-01），本质是同一个模型。这类名字如果没配映射就查不到价、
// 按 0 计费 —— 所以要主动识别出「它其实就是 X」，让管理员一键跟随。
//
// 只做「一个名字完整包含另一个」这一种判断，不做模糊匹配：
// 猜错会把请求按错误的价格结算，比不识别更糟。
func suggestFollowTarget(key string, priced map[string]ModelPrice) string {
	// 空名字必须先挡掉：任何字符串都以 "" 为前缀，
	// 不挡的话一个空模型名会「跟随」到随便某个定价上。
	if strings.TrimSpace(key) == "" {
		return ""
	}
	// 自己已经有价就不必跟随别人。调用方本来也是这么用的，
	// 但把判断放在函数内部，避免以后有人直接调它时拿到自相矛盾的结果
	// （「已定价」与「建议跟随」同时成立）。
	if _, priced := priced[key]; priced {
		return ""
	}
	best := ""
	for candidate := range priced {
		if candidate == key || candidate == "" {
			continue
		}
		if !strings.HasPrefix(key, candidate) && !strings.HasPrefix(candidate, key) {
			continue
		}
		// 取最长的候选：越长的前缀越具体（gpt-5.5 优于 gpt-5）。
		if len(candidate) > len(best) {
			best = candidate
		}
	}
	return best
}
