package handlers

/*
模型配置（能力参数 + 上游名映射）的管理接口。

两块配置放在同一个页面下，因为它们服务同一件事：**让网关知道
这个模型该怎么用、该按哪个价算**。
  · 能力参数：上下文窗口 / 最大输出 / 输入输出类型 / 推理档位映射；
  · 名字映射：上游模型名 → 本站模型名（计费与展示口径）。
*/

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// AdminListModelConfigs 返回全部模型配置：已配置的 + 内置预设目录。
//
// 一次返回两者，管理端不用发两个请求；预设只作导入模板，
// 与已配置项在界面上分组展示。
func AdminListModelConfigs(c *gin.Context) {
	ok(c, gin.H{
		"items":   services.AllModelCapabilities(),
		"presets": services.ModelPresets(),
	})
}

// AdminGetModelConfig 返回单个模型的配置（未配置时给预设或保守默认）。
func AdminGetModelConfig(c *gin.Context) {
	model := strings.TrimSpace(c.Param("model"))
	if model == "" {
		fail(c, http.StatusBadRequest, "缺少模型名", "bad_request")
		return
	}
	if caps, found := services.ModelCapabilitiesConfigured(model); found {
		ok(c, gin.H{"item": caps, "source": "customized"})
		return
	}
	if preset, found := services.ModelPresetFor(model); found {
		ok(c, gin.H{"item": preset, "source": "preset"})
		return
	}
	ok(c, gin.H{"item": services.ModelCapabilitiesOf(model), "source": "default"})
}

// AdminSaveModelConfig 保存一个模型的能力配置，需要 pricing:edit。
func AdminSaveModelConfig(c *gin.Context) {
	var req struct {
		Model            string   `json:"model"`
		ContextWindow    int      `json:"context_window"`
		MaxOutputTokens  int      `json:"max_output_tokens"`
		InputTypes       []string `json:"input_types"`
		OutputTypes      []string `json:"output_types"`
		Category         string   `json:"category"`
		StructuredOutput *bool    `json:"structured_output"`
		NativeSearch     *bool    `json:"native_search"`
		SystemMessages   *bool    `json:"system_messages"`
		ToolCalling      *bool    `json:"tool_calling"`
		Reasoning        struct {
			Levels       []string       `json:"levels"`
			DefaultLevel string         `json:"default_level"`
			Parameter    string         `json:"parameter"`
			Values       map[string]any `json:"values"`
		} `json:"reasoning"`
		Verification string `json:"verification"`
		Notes        string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	caps, err := services.SaveModelCapabilities(services.ModelCapabilities{
		Model:            req.Model,
		ContextWindow:    req.ContextWindow,
		MaxOutputTokens:  req.MaxOutputTokens,
		InputTypes:       req.InputTypes,
		OutputTypes:      req.OutputTypes,
		Category:         req.Category,
		StructuredOutput: req.StructuredOutput,
		NativeSearch:     req.NativeSearch,
		SystemMessages:   req.SystemMessages,
		ToolCalling:      req.ToolCalling,
		Reasoning: services.ModelReasoning{
			Levels:       req.Reasoning.Levels,
			DefaultLevel: req.Reasoning.DefaultLevel,
			Parameter:    req.Reasoning.Parameter,
			Values:       req.Reasoning.Values,
		},
		Verification: req.Verification,
		Notes:        req.Notes,
	})
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_capabilities")
		return
	}
	auditLog(c, "保存模型配置", caps.Model)
	ok(c, gin.H{"item": caps})
}

// AdminDeleteModelConfig 删除配置（回到预设 / 保守默认）。
func AdminDeleteModelConfig(c *gin.Context) {
	model := strings.TrimSpace(c.Param("model"))
	if err := services.DeleteModelCapabilities(model); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "delete_failed")
		return
	}
	auditLog(c, "删除模型配置", model)
	ok(c, gin.H{"model": model})
}

// AdminListModelMap 返回上游模型名到本站模型名的映射表。
func AdminListModelMap(c *gin.Context) {
	ok(c, gin.H{"items": services.ModelMapEntries()})
}

// AdminSaveModelMap 整表替换映射关系，需要 pricing:edit。
func AdminSaveModelMap(c *gin.Context) {
	var req struct {
		Items []services.ModelMapEntry `json:"items"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	if err := services.SetModelMap(req.Items); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_model_map")
		return
	}
	auditLog(c, "保存模型映射", "共 "+itoa(len(req.Items))+" 条")
	ok(c, gin.H{"items": services.ModelMapEntries()})
}

// AdminModelMapCandidates 返回「可能该配映射」的候选：
// 账号里有、但本站定价表里没有的模型名。
//
// 这一条是给管理员的提示 —— 没定价的模型会按 0 计费（免费），
// 与其等着对账时发现问题，不如在这里列出来。
func AdminModelMapCandidates(c *gin.Context) {
	all, err := services.LoadUpstreamChannelModels()
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取账号模型失败", "server_error")
		return
	}
	missing := []string{}
	seen := map[string]struct{}{}
	for _, model := range all {
		key := strings.ToLower(strings.TrimSpace(model))
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		if services.HasPrice(key) {
			continue
		}
		if _, mapped := services.ModelMap()[key]; mapped {
			continue
		}
		missing = append(missing, model)
	}
	ok(c, gin.H{"items": missing, "priced": services.ListPriceModels()})
}

// itoa 是本文件用的极短整数转字符串（避免为一个调用引入 strconv 的
// 可读性代价）；值域只有「映射条数」这种小整数。
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	out := []byte{}
	for v > 0 {
		out = append([]byte{byte('0' + v%10)}, out...)
		v /= 10
	}
	return string(out)
}

// AdminModelCatalog 返回「全部模型」总览：每个模型被哪些账号支持、
// 有没有定价、该跟随哪个官模、能力配置是什么。
//
// 合成视图而不是让前端拉三个接口自己拼：三处数据（账号模型清单、
// 定价、能力/映射）口径必须一致，分开拼很容易出现「这个列表显示已配价、
// 那个页面显示未配」的矛盾。
func AdminModelCatalog(c *gin.Context) {
	items, err := services.LoadModelCatalog()
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取模型目录失败", "server_error")
		return
	}
	/*
		这个接口只要求 pricing:view，而普通用户也持有该能力点（见 authz 里
		RoleUser 的授予）。账号名/厂商/接入方式属于基础设施信息 —— 别处
		（统计的 presentChannels、日志查询）都只对有 channel:view 的人展示，
		这里保持同一口径。否则任意登录用户就能把每个上游账号的
		id / 名称 / 厂商 / 接入方式 / 启停状态列出来。
	*/
	role, _ := currentRole(c)
	ok(c, gin.H{"items": redactCatalogChannels(items, authz.Can(role, authz.PermChannelView))})
}

// redactCatalogChannels 对没有 channel:view 的调用者抹掉账号身份，
// 只保留「这个模型被哪些账号支持」这个事实（数量），与 presentChannels 同口径。
func redactCatalogChannels(items []services.ModelCatalogEntry, canView bool) []services.ModelCatalogEntry {
	if canView {
		return items
	}
	for i := range items {
		for j := range items[i].Channels {
			items[i].Channels[j] = services.ModelCatalogChannel{ID: int64(j + 1), Name: "账号"}
		}
	}
	return items
}

// AdminModelFollow 让一个模型「跟随」某个已配置的官模。
//
// 一键完成两件事：
//  1. 写入映射（计费按官模的价格结算）；
//  2. 若该模型自己没有能力配置，把那套参数也抄过来一份。
//
// 为什么要抄能力而不是让运行时动态继承：能力配置里含推理档位映射，
// 而档位映射必须按「实际发给上游的模型名」来选 —— 抄一份之后
// 这个模型可以独立调整（上游对变体的支持未必与本体完全一致），
// 不会出现「改本体把一堆变体一起改坏」。
func AdminModelFollow(c *gin.Context) {
	var req struct {
		Model  string `json:"model"`
		Target string `json:"target"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	model := strings.ToLower(strings.TrimSpace(req.Model))
	target := strings.ToLower(strings.TrimSpace(req.Target))
	if model == "" || target == "" {
		fail(c, http.StatusBadRequest, "请指定要跟随的模型与目标模型", "bad_request")
		return
	}
	if model == target {
		fail(c, http.StatusBadRequest, "不能跟随自己", "invalid_input")
		return
	}
	if !services.HasPrice(target) {
		fail(c, http.StatusBadRequest, "目标模型「"+target+"」还没有定价，请先给它配价", "target_unpriced")
		return
	}

	// 写映射：保留已有的其它映射项，只增改这一条。
	entries := services.ModelMapEntries()
	replaced := false
	for i := range entries {
		if entries[i].From == model {
			entries[i].To = target
			replaced = true
		}
	}
	if !replaced {
		entries = append(entries, services.ModelMapEntry{From: model, To: target})
	}
	if err := services.SetModelMap(entries); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_model_map")
		return
	}

	// 能力：自己没有就抄一份；有则不动（管理员自己配的优先）。
	inherited := false
	if _, hasOwn := services.ModelCapabilitiesConfigured(model); !hasOwn {
		if caps, found := services.ModelCapabilitiesConfigured(target); found {
			caps.Model = model
			caps.Customized = true
			if _, err := services.SaveModelCapabilities(caps); err == nil {
				inherited = true
			}
		} else if preset, found := services.ModelPresetFor(target); found {
			preset.Model = model
			if _, err := services.SaveModelCapabilities(preset); err == nil {
				inherited = true
			}
		}
	}

	auditLog(c, "模型跟随官模", model+" → "+target)
	ok(c, gin.H{"model": model, "target": target, "inherited_capabilities": inherited})
}

// AdminModelUnfollow 解除某个模型的跟随（只删映射，保留能力配置）。
func AdminModelUnfollow(c *gin.Context) {
	model := strings.ToLower(strings.TrimSpace(c.Param("model")))
	if model == "" {
		fail(c, http.StatusBadRequest, "缺少模型名", "bad_request")
		return
	}
	entries := services.ModelMapEntries()
	kept := make([]services.ModelMapEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.From != model {
			kept = append(kept, entry)
		}
	}
	if err := services.SetModelMap(kept); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_model_map")
		return
	}
	auditLog(c, "解除模型跟随", model)
	ok(c, gin.H{"model": model})
}

// AdminRealModels 返回内置的真实模型目录（官方 id、代理写法与官方定价）。
//
// 管理端用它做「绑定真实模型」的选择器与一键配价的数据源。
func AdminRealModels(c *gin.Context) {
	items := services.RealModelList()
	developers := []string{}
	seen := map[string]struct{}{}
	for _, item := range items {
		if _, dup := seen[item.Developer]; dup {
			continue
		}
		seen[item.Developer] = struct{}{}
		developers = append(developers, item.Developer)
	}
	ok(c, gin.H{"items": items, "developers": developers})
}

/*
AdminBindRealModel 把某个账号里的一个上游别名绑定到真实模型。

**绑定是账号级的**（写进 channels.model_bindings），不是全局映射：
同一个 default-model 在 WorkBuddy 与别的上游是完全不同的模型，
做成全局映射会把它们混成一回事（早先那版就是全局 model_map）。

顺带做三件全局的事（按真实模型 id）：写官方定价、生成能力参数。
定价与能力参数本来就与账号无关 —— 同一个真实模型在哪都是那个价。

请求体：

	{ "model": "default-model", "real_id": "glm-5.3", "channel_id": 7 }

channel_id 必填：没有账号就无从确定这个别名属于谁 ——
而「哪个别名对应哪个真实模型」恰恰是账号自己的属性。
*/
func AdminBindRealModel(c *gin.Context) {
	var req struct {
		Model     string `json:"model"`
		RealID    string `json:"real_id"`
		ChannelID int64  `json:"channel_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	model := strings.ToLower(strings.TrimSpace(req.Model))
	if model == "" {
		fail(c, http.StatusBadRequest, "缺少要绑定的模型名", "bad_request")
		return
	}
	realID := strings.TrimSpace(req.RealID)
	if realID == "" {
		fail(c, http.StatusBadRequest, "请选择要绑定的真实模型", "bad_request")
		return
	}
	if req.ChannelID <= 0 {
		fail(c, http.StatusBadRequest, "缺少账号 ID：绑定是账号级的，必须指明绑在哪个账号上", "bad_request")
		return
	}

	// 先确认账号存在，避免绑到一个不存在的 ID 而静默什么都不发生。
	var exists int
	if err := db.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE id = ?`, req.ChannelID).Scan(&exists); err != nil || exists == 0 {
		fail(c, http.StatusNotFound, "账号不存在", "channel_not_found")
		return
	}

	// 写绑定（账号级）。
	raw, err := loadChannelBindingsRaw(req.ChannelID)
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取账号绑定失败", "server_error")
		return
	}
	bindings := services.ParseModelBindings(raw)

	// 绑定的目标必须是真实模型 —— 先在注册表里确认，再落库。
	// 这样库里永远不会存进「指向另一个别名」的坏绑定。
	if !services.IsRealModelID(realID) {
		fail(c, http.StatusBadRequest, "未知的真实模型："+realID, "unknown_real_model")
		return
	}
	bindings[model] = strings.ToLower(strings.TrimSpace(realID))
	if _, err := db.DB.Exec(
		`UPDATE channels SET model_bindings = ? WHERE id = ?`,
		services.SerializeModelBindings(bindings), req.ChannelID,
	); err != nil {
		fail(c, http.StatusInternalServerError, "保存绑定失败", "server_error")
		return
	}
	services.MarkChannelsDirty()

	// 再写全局的定价与能力参数（按真实模型 id）；这一步失败要如实报出来 ——
	// 绑定已经落库了，但没定价就还是按 0 计费，等于绑定没生效。
	applied, err := services.ApplyRealModel(model, realID)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "bind_failed")
		return
	}
	auditLog(c, "绑定真实模型", model+" → "+applied.RealModel)
	ok(c, gin.H{"item": applied})
}

// AdminRealModelPresetNames 给某个上游别名建议几个「真实模型名」选项。
//
// 用途：账号里存着 default-model 这类完全看不出内容的别名时，
// 管理员需要给它挑一个真实模型 id 当名字。这里按该账号的厂商给出
// 「同厂商下已配置好的模型」作为候选，避免每次都从空开始想名字。
func AdminRealModelPresetNames(c *gin.Context) {
	vendor := strings.ToLower(strings.TrimSpace(c.Query("vendor")))
	// 同厂商已配置过的模型名（按厂商判定），最多给几个样例。
	entries, err := services.LoadModelCatalog()
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取模型目录失败", "server_error")
		return
	}
	presets := []string{}
	for _, entry := range entries {
		if !entry.Priced {
			continue
		}
		presets = append(presets, entry.Model)
	}
	// 厂商维度优先：该上游厂商真实提供过的模型排前面。
	if vendor != "" {
		ordered := []string{}
		for _, entry := range entries {
			if !entry.Priced {
				continue
			}
			for _, ch := range entry.Channels {
				if strings.EqualFold(ch.Vendor, vendor) {
					ordered = append(ordered, entry.Model)
					break
				}
			}
		}
		if len(ordered) > 0 {
			presets = ordered
		}
	}
	// 去重并截断（界面只展示几个候选，多了反而难选）。
	out := []string{}
	seen := map[string]struct{}{}
	for _, name := range presets {
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
		if len(out) >= 8 {
			break
		}
	}
	ok(c, gin.H{"items": out})
}
