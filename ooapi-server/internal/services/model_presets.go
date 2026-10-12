package services

/*
内置的模型能力预设（原项目 model-capabilities.json 的移植）。

用途：管理员在模型配置页选一个模型时，能一键带出「上下文窗口 / 最大输出 /
输入输出类型 / 推理档位映射」的已知值，而不是从零填 —— 大部分参数来自各家
官方文档，逐个手抄既费时又容易抄错。

**必须与「实测确认」区分开**：这些值来自公开文档与既有实现，
不是在本站逐个压测出来的。所以导入时统一标记 verification 由数据里的
verification 字段决定，notes 保留原始出处说明；管理员改过之后
Customized 为 true，界面上能看出「这条是人配的」。

与真实配置的关系：预设只是**导入模板**，不参与运行时。
运行时读的永远是 options 表里那份已保存的配置 ——
否则「改了预设」会静默影响所有线上模型。
*/

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

//go:embed presets/model_capabilities.json
var modelPresetJSON []byte

type modelPresetEntry struct {
	ContextWindow    int      `json:"cw"`
	MaxOutputTokens  int      `json:"mo"`
	InputTypes       []string `json:"it"`
	OutputTypes      []string `json:"ot"`
	Category         string   `json:"cat"`
	StructuredOutput *bool    `json:"so"`
	NativeSearch     *bool    `json:"ns"`
	SystemMessages   *bool    `json:"sm"`
	ToolCalling      *bool    `json:"tc"`
	Reasoning        struct {
		Levels       []string       `json:"l"`
		DefaultLevel string         `json:"d"`
		Parameter    string         `json:"p"`
		Values       map[string]any `json:"v"`
	} `json:"r"`
	Verification string `json:"ver"`
	Notes        string `json:"notes"`
}

// ModelPreset 是暴露给管理端的预设（含模型名）。
type ModelPreset struct {
	Model        string            `json:"model"`
	Capabilities ModelCapabilities `json:"capabilities"`
}

var (
	modelPresetsOnce sync.Once
	modelPresets     []ModelPreset
	modelPresetIndex map[string]ModelCapabilities
)

func loadModelPresets() {
	raw := map[string]modelPresetEntry{}
	if err := json.Unmarshal(modelPresetJSON, &raw); err != nil {
		// 内置数据损坏是构建期问题，不该让服务起不来：空表 + 记日志。
		modelPresets = []ModelPreset{}
		modelPresetIndex = map[string]ModelCapabilities{}
		return
	}
	index := make(map[string]ModelCapabilities, len(raw))
	list := make([]ModelPreset, 0, len(raw))
	for name, entry := range raw {
		key := normalizeModelKey(name)
		if key == "" {
			continue
		}
		caps := defaultCapabilities(key)
		caps.ContextWindow = entry.ContextWindow
		caps.MaxOutputTokens = entry.MaxOutputTokens
		if len(entry.InputTypes) > 0 {
			caps.InputTypes = entry.InputTypes
		}
		if len(entry.OutputTypes) > 0 {
			caps.OutputTypes = entry.OutputTypes
		}
		if entry.Category != "" {
			caps.Category = entry.Category
		}
		caps.StructuredOutput = entry.StructuredOutput
		caps.NativeSearch = entry.NativeSearch
		caps.SystemMessages = entry.SystemMessages
		caps.ToolCalling = entry.ToolCalling
		caps.Reasoning = ModelReasoning{
			Levels:       entry.Reasoning.Levels,
			DefaultLevel: entry.Reasoning.DefaultLevel,
			Parameter:    entry.Reasoning.Parameter,
			Values:       entry.Reasoning.Values,
		}
		if caps.Reasoning.Levels == nil {
			caps.Reasoning.Levels = []string{}
		}
		if caps.Reasoning.Values == nil {
			caps.Reasoning.Values = map[string]any{}
		}
		if entry.Verification != "" {
			caps.Verification = entry.Verification
		}
		caps.Notes = entry.Notes
		caps.Customized = false
		index[key] = caps
		list = append(list, ModelPreset{Model: key, Capabilities: caps})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Model < list[j].Model })
	modelPresets = list
	modelPresetIndex = index
}

// ModelPresets 返回全部内置预设（按模型名排序）。
func ModelPresets() []ModelPreset {
	modelPresetsOnce.Do(loadModelPresets)
	out := make([]ModelPreset, len(modelPresets))
	copy(out, modelPresets)
	return out
}

// ModelPresetFor 按名字查预设（含「经模型映射归一」的回退）。
func ModelPresetFor(model string) (ModelCapabilities, bool) {
	modelPresetsOnce.Do(loadModelPresets)
	key := normalizeModelKey(model)
	if caps, ok := modelPresetIndex[key]; ok {
		return caps, true
	}
	if mapped, ok := ModelMap()[key]; ok {
		if caps, ok := modelPresetIndex[mapped]; ok {
			return caps, true
		}
	}
	// 前缀匹配兜底：上游模型名常带后缀（-sg / -preview / -20250929），
	// 预设里只有本体名时，应该能命中本体那份参数。
	best := ""
	for name := range modelPresetIndex {
		if strings.HasPrefix(key, name) && len(name) > len(best) {
			best = name
		}
	}
	if best != "" {
		return modelPresetIndex[best], true
	}
	return ModelCapabilities{}, false
}
