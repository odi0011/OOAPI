package services

import (
	"errors"
	"sort"
	"strings"
)

/*
真实模型注册表。

解决的问题：账号从上游拿到的模型清单里混着**上游自己的别名**
（WorkBuddy 的 default-model / fast-model、Kiro 的 auto），
以及聚合站的转售价。这些名字：
  · 不是任何真实模型开发商的模型 id，用户看不懂它到底是什么；
  · 没有对应定价时按 0 计费（免费），站长白亏且不报错。

所以本站的原则是：**对外只能存在真实模型开发商的真实模型 id**。
别名必须先绑定到一个真实模型（本文件给出的目录），才能保存账号、才能被调用。

本文件同时充当「一键配价」的数据源：每条的官方单价都是 USD / 百万 token，
而本站的 OD 币与美元 1:1，因此直接写入 model_prices 即可，无需换算。
人民币定价的厂商优先取其国际站（美元定价）；没有国际站的按注明的汇率换算，
并在 Note 里写清楚来源，避免以后无法复核。

数据来源与核实状态写在每条的 Source / Verified 字段里：
  · Verified = true  → 官方定价页或官方 SDK 类型定义可佐证；
  · Verified = false → 来自多个第三方注册表交叉比对，官方页未能直接读取。
**未核实的价格不会自动写入**（见 ApplyRealModel 的说明），
宁可让管理员自己填，也不把第三方数字伪装成官方价。
*/

// RealModel 是一个真实模型开发商发布的模型。
type RealModel struct {
	// ID 是 API 调用时使用的模型名（各厂商官方写法）。
	ID string `json:"id"`
	// Developer 是真实模型开发商（deepseek / anthropic / openai / google …），
	// 与「上游厂商」（workbuddy / kiro / opencode 这类聚合或转售方）区分开。
	Developer string `json:"developer"`
	// Label 是人类可读名（界面上显示）。
	Label string `json:"label"`
	// 官方单价（USD / 百万 token）。0 表示免费或未公布。
	InputPrice  float64 `json:"input_price"`
	OutputPrice float64 `json:"output_price"`
	CachedPrice float64 `json:"cached_price"`
	// ContextWindow / MaxOutputTokens：0 表示未公布。
	ContextWindow   int `json:"context_window"`
	MaxOutputTokens int `json:"max_output_tokens"`
	// 能力
	Vision      bool `json:"vision"`
	ToolCalling bool `json:"tool_calling"`
	Reasoning   bool `json:"reasoning"`
	// ReasoningParameter / ReasoningLevels：下发思考强度用的参数名与档位。
	ReasoningParameter string   `json:"reasoning_parameter,omitempty"`
	ReasoningLevels    []string `json:"reasoning_levels,omitempty"`
	// Note 是定价口径说明（阶梯价、峰谷价、促销等），界面上要显示。
	Note string `json:"note,omitempty"`
	/*
		Aliases 是上游常用的等价写法。

		官方 id 与上游实际返回的字符串经常不同（Anthropic 官方写
		claude-sonnet-4-5，而不少中转写 claude-sonnet-4.5；OpenAI 的
		gpt-5.3-codex 有的站写成 gpt-5-3-codex）。这些写法指向同一个
		真实模型，若不在注册表里就会落进「未绑定别名」被拦下 ——
		对管理员是纯粹的噪音。列在这里的写法直接认定为该真实模型。

		只列「指向明确、不会与别的模型混淆」的写法；有歧义的不列，
		留给管理员手动绑定。
	*/
	Aliases []string `json:"aliases,omitempty"`
	// Source 是主要依据的链接。
	Source string `json:"source,omitempty"`
	// Verified 表示官方页面可佐证（false = 第三方交叉比对，需谨慎）。
	Verified bool `json:"verified"`
}

// realModels 是内置目录。按开发商分组维护，方便核对。
//
// 维护约定：
//
//	· 价格单位统一 USD / 百万 token（OD 与美元 1:1，直接用）；
//	· 阶梯定价写基础档（最小上下文的单价），并在 Note 里说明档位，
//	  因为本站的 model_prices 有独立的 context_tiers 字段负责阶梯；
//	· 促销价要在 Note 里写「促销」，避免促销结束后悄悄按旧价计费。
var realModels = []RealModel{
	/* ---------- DeepSeek（api-docs.deepseek.com，官方美元定价，峰谷两档） ---------- */
	{
		ID: "deepseek-flash", Developer: "deepseek", Label: "DeepSeek V4.1 Flash",
		// -sg 是亚太区部署的同一个模型（上游清单里很常见），
		// 归一到本体才能查到价 —— 这类「官方的区域/版本后缀」属于
		// 全局可判定的等价写法，放注册表；上游自造的名字（default-model）
		// 才是账号级绑定要处理的对象。
		Aliases:    []string{"deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4.1-flash-sg", "deepseek-chat", "deepseek-reasoner"},
		InputPrice: 0.15, OutputPrice: 0.60, CachedPrice: 0.003,
		ContextWindow: 1000000, MaxOutputTokens: 384000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinking.type", ReasoningLevels: []string{"enabled", "disabled"},
		Note: "官方峰谷两档：低谷 0.15/0.60，高峰 0.30/1.20（UTC 周一至周五 01:00-04:00 与 06:00-10:00）。此处记低谷价，高峰时段请自行按 2 倍调整。", Source: "https://api-docs.deepseek.com/quick_start/pricing", Verified: true,
	},
	{
		ID: "deepseek-v4-pro", Developer: "deepseek", Label: "DeepSeek V4 Pro",
		InputPrice: 0.66, OutputPrice: 1.98, CachedPrice: 0.022,
		ContextWindow: 1000000, MaxOutputTokens: 384000,
		ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinking.type", ReasoningLevels: []string{"enabled", "disabled"},
		Note:   "低谷价 0.66/1.98，高峰 1.32/3.96。纯文本，不支持看图。",
		Source: "https://api-docs.deepseek.com/quick_start/pricing", Verified: true,
	},

	/* ---------- Anthropic（claude.com/pricing） ---------- */
	{
		ID: "claude-opus-5-5", Developer: "anthropic", Label: "Claude Opus 5.5",
		Aliases:    []string{"claude-opus-5.5"},
		InputPrice: 4.00, OutputPrice: 20.00, CachedPrice: 0.20,
		ContextWindow: 1000000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"}, Source: "https://claude.com/pricing", Verified: true,
	},
	{
		ID: "claude-sonnet-5-5", Developer: "anthropic", Label: "Claude Sonnet 5.5",
		Aliases:    []string{"claude-sonnet-5.5"},
		InputPrice: 2.00, OutputPrice: 10.00, CachedPrice: 0.10,
		ContextWindow: 1000000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"}, Source: "https://claude.com/pricing", Verified: true,
	},
	{
		ID: "claude-haiku-5-5", Developer: "anthropic", Label: "Claude Haiku 5.5",
		Aliases:    []string{"claude-haiku-5.5"},
		InputPrice: 0.10, OutputPrice: 0.50, CachedPrice: 0.01,
		ContextWindow: 200000, MaxOutputTokens: 64000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"},
		Note: "输入超 100K 后按 0.50/2.50 计费（阶梯价，可用定价页的长上下文档位配置）。", Source: "https://claude.com/pricing", Verified: true,
	},
	{
		ID: "claude-opus-5", Developer: "anthropic", Label: "Claude Opus 5",
		Aliases:    []string{"claude-opus-5.0"},
		InputPrice: 5.00, OutputPrice: 25.00, CachedPrice: 0.50,
		ContextWindow: 1000000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"}, Source: "https://claude.com/pricing", Verified: true,
	},
	{
		ID: "claude-sonnet-4-5", Developer: "anthropic", Label: "Claude Sonnet 4.5",
		Aliases:    []string{"claude-sonnet-4.5", "claude-sonnet-4-5-20250929"},
		InputPrice: 3.00, OutputPrice: 15.00, CachedPrice: 0.30,
		ContextWindow: 200000, MaxOutputTokens: 64000,
		Vision: true, ToolCalling: true, Reasoning: true,
		Note: "超 200K 输入按 6.00/22.50。", ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"},
		Source: "https://claude.com/pricing", Verified: true,
	},
	{
		ID: "claude-haiku-4-5", Developer: "anthropic", Label: "Claude Haiku 4.5",
		Aliases:    []string{"claude-haiku-4.5", "claude-haiku-4-5-20251001"},
		InputPrice: 1.00, OutputPrice: 5.00, CachedPrice: 0.10,
		ContextWindow: 200000, MaxOutputTokens: 64000,
		Vision: true, ToolCalling: true, Reasoning: true, ReasoningParameter: "output_config.effort", ReasoningLevels: []string{"low", "medium", "high", "xhigh", "max"},
		Source: "https://claude.com/pricing", Verified: true,
	},

	/* ---------- OpenAI（developers.openai.com，长上下文阶梯） ---------- */
	{
		ID: "gpt-6-astra", Developer: "openai", Label: "GPT-6 Astra",
		InputPrice: 10.00, OutputPrice: 50.00, CachedPrice: 1.00,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Note:   "超 272K 输入按 20/75。",
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-6-sol", Developer: "openai", Label: "GPT-6 Sol",
		InputPrice: 2.00, OutputPrice: 10.00, CachedPrice: 0.20,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-6-luna", Developer: "openai", Label: "GPT-6 Luna",
		InputPrice: 0.10, OutputPrice: 0.50, CachedPrice: 0.01,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.6-sol", Developer: "openai", Label: "GPT-5.6 Sol",
		InputPrice: 4.00, OutputPrice: 20.00, CachedPrice: 0.40,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Note:   "促销价，官方保证至 2026-11-21；超 272K 按 8/30。",
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.6-terra", Developer: "openai", Label: "GPT-5.6 Terra",
		InputPrice: 2.00, OutputPrice: 12.00, CachedPrice: 0.20,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.6-luna", Developer: "openai", Label: "GPT-5.6 Luna",
		InputPrice: 0.20, OutputPrice: 1.20, CachedPrice: 0.02,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.5", Developer: "openai", Label: "GPT-5.5",
		InputPrice: 5.00, OutputPrice: 30.00, CachedPrice: 0.50,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.4", Developer: "openai", Label: "GPT-5.4",
		InputPrice: 2.50, OutputPrice: 15.00, CachedPrice: 0.25,
		ContextWindow: 1050000, MaxOutputTokens: 128000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"},
		Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},
	{
		ID: "gpt-5.3-codex", Developer: "openai", Label: "GPT-5.3 Codex",
		Aliases:    []string{"gpt-5-3-codex"},
		InputPrice: 1.75, OutputPrice: 14.00, CachedPrice: 0.175,
		ContextWindow: 400000, MaxOutputTokens: 128000,
		ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"minimal", "low", "medium", "high"}, Source: "https://developers.openai.com/api/docs/pricing", Verified: true,
	},

	/* ---------- Google Gemini ---------- */
	{
		ID: "gemini-3.8-flash", Developer: "google", Label: "Gemini 3.8 Flash",
		Aliases:    []string{"gemini-3-8-flash"},
		InputPrice: 0.75, OutputPrice: 3.75, CachedPrice: 0.075,
		ContextWindow: 1048576, MaxOutputTokens: 65536,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinkingConfig.thinkingBudget",
		Source:             "https://ai.google.dev/gemini-api/docs/pricing", Verified: false,
	},
	{
		ID: "gemini-3.5-flash", Developer: "google", Label: "Gemini 3.5 Flash",
		Aliases:    []string{"gemini-3-5-flash"},
		InputPrice: 1.50, OutputPrice: 9.00, CachedPrice: 0.15,
		ContextWindow: 1048576, MaxOutputTokens: 65536,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinkingConfig.thinkingBudget",
		Source:             "https://ai.google.dev/gemini-api/docs/pricing", Verified: false,
	},
	{
		ID: "gemini-3.5-flash-lite", Developer: "google", Label: "Gemini 3.5 Flash Lite",
		InputPrice: 0.30, OutputPrice: 2.50, CachedPrice: 0.03,
		ContextWindow: 1048576, MaxOutputTokens: 65536,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinkingConfig.thinkingBudget",
		Source:             "https://ai.google.dev/gemini-api/docs/pricing", Verified: false,
	},
	{
		ID: "gemini-3.1-pro-preview", Developer: "google", Label: "Gemini 3.1 Pro (预览)",
		InputPrice: 2.00, OutputPrice: 12.00, CachedPrice: 0.20,
		ContextWindow: 1048576, MaxOutputTokens: 65536,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "thinkingConfig.thinkingBudget",
		Note:               "预览版，价格可能变动。",
		Source:             "https://ai.google.dev/gemini-api/docs/pricing", Verified: false,
	},

	/* ---------- Moonshot / Kimi（platform.moonshot.ai 国际站，美元） ---------- */
	{
		ID: "kimi-k3", Developer: "moonshot", Label: "Kimi K3",
		InputPrice: 3.00, OutputPrice: 15.00, CachedPrice: 0.30,
		ContextWindow: 1048576,
		Vision:        true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"}, Source: "https://platform.moonshot.ai/docs/pricing", Verified: true,
	},
	{
		ID: "kimi-k2.7-code", Developer: "moonshot", Label: "Kimi K2.7 Code",
		InputPrice: 0.95, OutputPrice: 4.00, CachedPrice: 0.19,
		ContextWindow: 262144,
		Vision:        true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://platform.moonshot.ai/docs/pricing", Verified: true,
	},
	{
		ID: "kimi-k2.6", Developer: "moonshot", Label: "Kimi K2.6",
		InputPrice: 0.95, OutputPrice: 4.00, CachedPrice: 0.16,
		ContextWindow: 262144,
		Vision:        true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://platform.moonshot.ai/docs/pricing", Verified: true,
	},

	/* ---------- 智谱 GLM（docs.z.ai 国际站，美元） ---------- */
	{
		ID: "glm-5.3", Developer: "zhipu", Label: "GLM-5.3",
		InputPrice: 1.40, OutputPrice: 4.40, CachedPrice: 0.26,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.z.ai/guides/overview/pricing", Verified: true,
	},
	{
		ID: "glm-5.3-flash", Developer: "zhipu", Label: "GLM-5.3 Flash",
		Aliases:    []string{"glm-5.3-flashx"},
		InputPrice: 0.15, OutputPrice: 0.50, CachedPrice: 0.03,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		Vision: true, ToolCalling: true, ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.z.ai/guides/overview/pricing", Verified: true,
	},
	{
		ID: "glm-5", Developer: "zhipu", Label: "GLM-5",
		InputPrice: 1.00, OutputPrice: 3.20, CachedPrice: 0.20,
		ContextWindow: 200000,
		ToolCalling:   true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.z.ai/guides/overview/pricing", Verified: true,
	},
	{
		ID: "glm-5.2", Developer: "zhipu", Label: "GLM-5.2",
		InputPrice: 1.40, OutputPrice: 4.40, CachedPrice: 0.26,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.z.ai/guides/overview/pricing", Verified: true,
	},

	/* ---------- xAI Grok ---------- */
	{
		ID: "grok-4.7", Developer: "xai", Label: "Grok 4.7",
		InputPrice: 2.00, OutputPrice: 6.00, CachedPrice: 0.50,
		ContextWindow: 500000, MaxOutputTokens: 500000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.x.ai/docs/models", Verified: false,
	},
	{
		ID: "grok-4.6", Developer: "xai", Label: "Grok 4.6",
		InputPrice: 2.00, OutputPrice: 6.00, CachedPrice: 0.50,
		ContextWindow: 500000, MaxOutputTokens: 500000,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://docs.x.ai/docs/models", Verified: false,
	},

	/* ---------- MiniMax（platform.minimax.io 国际站，美元） ---------- */
	{
		ID: "minimax-m3", Developer: "minimax", Label: "MiniMax M3",
		Aliases:    []string{"MiniMax-M3"},
		InputPrice: 0.30, OutputPrice: 1.20, CachedPrice: 0.06,
		ContextWindow: 1000000, MaxOutputTokens: 512000,
		Vision: true, ToolCalling: true, Reasoning: true,
		Note: "官方标注永久五折（原价 0.60/1.20 档）。", ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://platform.minimax.io/docs/guides/pricing-paygo", Verified: true,
	},
	{
		ID: "minimax-m2.5", Developer: "minimax", Label: "MiniMax M2.5",
		InputPrice: 0.30, OutputPrice: 1.20, CachedPrice: 0.03,
		ContextWindow: 200000,
		ToolCalling:   true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://platform.minimax.io/docs/guides/pricing-paygo", Verified: true,
	},
	{
		ID: "longcat-2.0", Developer: "longcat", Label: "LongCat 2.0",
		InputPrice: 0.30, OutputPrice: 1.20, CachedPrice: 0.006,
		ContextWindow: 200000,
		ToolCalling:   true,
		Note:          "价格来自第三方注册表交叉比对，官方页面未能直接读取。",
		Source:        "https://openrouter.ai/api/v1/models", Verified: false,
	},
	{
		ID: "deepseek-3.2", Developer: "deepseek", Label: "DeepSeek V3.2（官方已下架）",
		InputPrice: 0.26, OutputPrice: 0.42,
		ContextWindow: 128000,
		ToolCalling:   true, Reasoning: true,
		ReasoningParameter: "thinking.type", ReasoningLevels: []string{"enabled", "disabled"},
		Note:   "DeepSeek 官方已下架，现仅第三方渠道在售；价格取自第三方注册表。",
		Source: "https://openrouter.ai/api/v1/models", Verified: false,
	},
	{
		ID: "minimax-m2.7", Developer: "minimax", Label: "MiniMax M2.7",
		InputPrice: 0.30, OutputPrice: 1.20, CachedPrice: 0.06,
		ContextWindow: 204800,
		ToolCalling:   true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://platform.minimax.io/docs/guides/pricing-paygo", Verified: true,
	},

	/* ---------- 阿里 Qwen（国际站 Model Studio，美元） ---------- */
	{
		ID: "qwen3.8-max", Developer: "qwen", Label: "Qwen3.8 Max",
		InputPrice: 2.00, OutputPrice: 6.00, CachedPrice: 0.25,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing", Verified: true,
	},
	{
		ID: "qwen3.8-flash", Developer: "qwen", Label: "Qwen3.8 Flash",
		InputPrice: 0.15, OutputPrice: 0.47, CachedPrice: 0.016,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing", Verified: true,
	},
	{
		ID: "qwen3-coder-next", Developer: "qwen", Label: "Qwen3 Coder Next",
		InputPrice: 0.30, OutputPrice: 1.50,
		ContextWindow: 256000,
		ToolCalling:   true, Reasoning: true,
		Note:               "阶梯价：≤32K 0.30/1.50，≤128K 0.50/2.50，≤256K 0.80/4.00。",
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing", Verified: true,
	},

	/* ---------- 腾讯混元（hy3 / hy4 是混元三代、四代预览） ---------- */
	{
		ID: "hunyuan-2.0-thinking", Developer: "hunyuan", Label: "腾讯混元 2.0 Thinking",
		Aliases:    []string{"hy3", "hunyuan-turbos", "hunyuan-t1"},
		InputPrice: 0.14, OutputPrice: 0.58, CachedPrice: 0.035,
		ContextWindow: 256000,
		ToolCalling:   true, Reasoning: true,
		Note: "腾讯多家渠道价格不一致（部分渠道免费），此处取公开转售价，请按实际渠道核对。", ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://cloud.tencent.com/document/product/1729", Verified: false,
	},
	{
		ID: "hunyuan-4-preview", Developer: "hunyuan", Label: "腾讯混元 4（预览）",
		Aliases:    []string{"hy4-preview", "hy4"},
		InputPrice: 0.834, OutputPrice: 2.501, CachedPrice: 0.042,
		ContextWindow: 1000000,
		ToolCalling:   true, Reasoning: true,
		Note: "预览版；价格取自公开渠道转售价，官方未公布。", ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://cloud.tencent.com/document/product/1729", Verified: false,
	},

	/* ---------- 小米 MiMo ---------- */
	{
		ID: "mimo-v2.6-pro", Developer: "mimo", Label: "小米 MiMo V2.6 Pro",
		InputPrice: 0.435, OutputPrice: 0.87, CachedPrice: 0.0036,
		ContextWindow: 1000000,
		ToolCalling:   true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://mimo.mi.com/docs/", Verified: false,
	},

	/* ---------- Meta Muse Spark ---------- */
	{
		ID: "muse-spark-1.3", Developer: "meta", Label: "Meta Muse Spark 1.3",
		InputPrice: 1.25, OutputPrice: 4.25, CachedPrice: 0.15,
		ContextWindow: 1000000, MaxOutputTokens: 131072,
		Vision: true, ToolCalling: true, Reasoning: true,
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://dev.meta.ai/", Verified: false,
	},

	/* ---------- Mistral ---------- */
	{
		ID: "mistral-large-4", Developer: "mistral", Label: "Mistral Large 4",
		InputPrice: 1.36, OutputPrice: 4.18, CachedPrice: 0.07,
		ContextWindow: 1000000, MaxOutputTokens: 262144,
		Vision: true, ToolCalling: true, Reasoning: true,
		Note:               "当前五折促销 0.68/2.09，此处记原价；促销结束后无需改动。",
		ReasoningParameter: "reasoning_effort", ReasoningLevels: []string{"low", "high", "max"},
		Source: "https://mistral.ai/pricing", Verified: false,
	},

	/* ---------- 免费模型（上游明确标注免费，定价 0 是正确值而非漏配） ---------- */
	{
		ID: "space-bunny-free", Developer: "opencode", Label: "Space Bunny（免费）",
		ContextWindow: 200000, Verified: true,
		Note:   "上游免费模型，定价 0 是正确值。",
		Source: "https://opencode.ai/docs/zen/",
	},
	{
		ID: "longcat-2.5-preview-free", Developer: "longcat", Label: "LongCat 2.5 预览（免费）",
		ContextWindow: 200000, Verified: true,
		Note:   "上游限时免费，定价 0 是正确值。",
		Source: "https://opencode.ai/docs/zen/",
	},
	{
		ID: "step-5-preview-free", Developer: "stepfun", Label: "Step 5 预览（免费）",
		ContextWindow: 200000, Verified: true,
		Note:   "上游限时免费，定价 0 是正确值。",
		Source: "https://opencode.ai/docs/zen/",
	},
}

// realModelIndex 是 ID（含等价写法）→ 条目的索引（小写键）。
var realModelIndex = func() map[string]RealModel {
	index := make(map[string]RealModel, len(realModels))
	for _, model := range realModels {
		index[normalizeModelKey(model.ID)] = model
		for _, alias := range model.Aliases {
			key := normalizeModelKey(alias)
			if key == "" {
				continue
			}
			// 别名冲突时保留先注册的：注册表里先写的是官方 id 那条，
			// 后来的条目不该悄悄覆盖它。
			if _, exists := index[key]; !exists {
				index[key] = model
			}
		}
	}
	return index
}()

// LookupRealModel 按 id 查真实模型（大小写不敏感）。
func LookupRealModel(id string) (RealModel, bool) {
	model, found := realModelIndex[normalizeModelKey(id)]
	return model, found
}

// IsRealModelID 判断一个名字是否是真实模型开发商发布的模型 id。
//
// 「真实」的判定只看注册表 —— 不猜、不做模糊匹配。
// 猜错的后果是「一个上游别名被当成真实模型放行」，那正是要防的事。
func IsRealModelID(id string) bool {
	_, found := LookupRealModel(id)
	return found
}

// RealModelList 返回全部真实模型（按开发商、id 排序）。
func RealModelList() []RealModel {
	out := make([]RealModel, len(realModels))
	copy(out, realModels)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Developer != out[j].Developer {
			return out[i].Developer < out[j].Developer
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// RealModelsOfDeveloper 返回某个开发商的全部模型。
func RealModelsOfDeveloper(developer string) []RealModel {
	key := strings.ToLower(strings.TrimSpace(developer))
	out := []RealModel{}
	for _, model := range realModels {
		if model.Developer == key {
			out = append(out, model)
		}
	}
	return out
}

/*
AliasModelHint 判断一个模型名是否是「上游自造的别名」。

别名特征（满足任一即认为需要绑定真实模型）：

	· 不在真实模型注册表里，且本站也没有它的定价。

判据只看「全局可知的信息」。**账号级绑定不在这一层判断** ——
绑定是账号自己的属性（同一个 default-model 在不同上游是不同的模型），
所以「某个名字对该账号算不算已绑定」必须由调用方拿着账号来问，
见 UnresolvedAliasModelsFor。

为什么不看「通用别名清单」（default-model / fast-model 之类）：
名字长得像不像别名没有意义，重要的是它有没有身份。
一个叫 default-model 却已配好价的名字可以正常计费，
而一个叫 gpt-9-turbo 却谁也不认识的名字必须被拦下。
*/
func AliasModelHint(model string) bool {
	key := normalizeModelKey(model)
	if key == "" {
		return false
	}
	if IsRealModelID(key) {
		return false
	}
	// 有定价说明这个身份是配过的（管理员按自己的价目表处理过）。
	return !HasPrice(key)
}

/*
UnresolvedAliasModelsFor 返回一组模型里「该账号还没有绑定真实模型」的那些。

与 UnresolvedAliasModels 的区别：**把账号的绑定算进来**。
以账号的视角判断一个名字认不认识：

	· 是注册表里的真实模型 → 认识；
	· 虽然不在注册表里，但**该账号把它绑到了**一个真实模型 → 认识
	  （这是账号级绑定的全部意义）；
	· 否则 → 不认识，需要绑定。

调用方（账号保存、请求校验）据此拦截：未绑定的别名既看不懂、
又会被按 0 计费，必须先处理。

绑定目标**不要求「已定价」**：定价由 ApplyRealModel 在绑定时一并写入，
而它可能因注册表尚未核实价格而不写。那种情况下该模型仍需要管理员
手动补价（在定价页），但**绑定这件事本身已经完成了** ——
把它继续算作「未绑定」会让用户反复绑同一个模型却怎么都存不上。
（早先的判据要求目标已定价，正是这个坑。）
*/
func UnresolvedAliasModelsFor(bindings map[string]string, models []string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, raw := range models {
		key := normalizeModelKey(raw)
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}

		if !AliasModelHint(key) {
			continue
		}
		// 该账号的绑定能否救它：绑定目标必须是注册表里的真实模型。
		if realID, okBind := bindings[key]; okBind && IsRealModelID(realID) {
			continue
		}
		out = append(out, raw)
	}
	return out
}

/*
UnresolvedAliasModels 返回一组模型里「全局层面还没有身份」的那些。

保留它是为了不打断既有调用点（它们大多是「扫一眼还有哪些没配」的
管理侧统计，不针对具体账号）。账号保存这种需要精确判断的地方
必须用 UnresolvedAliasModelsFor。
*/
func UnresolvedAliasModels(models []string) []string {
	return UnresolvedAliasModelsFor(nil, models)
}

/*
ApplyRealModel 把官方定价与能力参数写入（绑定本身由账号保存）。

**它不再写全局映射**：绑定是账号级的（channels.model_bindings），
由调用方（AdminBindRealModel）负责更新那个账号的记录。
这里只做「绑到某个真实模型之后，全局该有的东西」：

  1. 官方定价（按真实模型 id 写进 model_prices）—— 计费要查到价；
  2. 能力参数（上下文、多模态、推理档位）—— 请求要发对形状。

顺带修掉一个过去的隐患：全局映射那种写法会让「账号 A 的 default-model」
和「账号 B 的 default-model」互相覆盖 —— 两个账号绑到不同模型时，
谁最后保存谁赢，而另一个账号就静默按错误的价计费了。
绑定改成账号级之后这类冲突不存在。

定价与能力参数都是按**真实模型 id** 存的（全局共用一份），
这与绑定是账号级不冲突：同一个真实模型的价格与能力在哪都一样。
*/
func ApplyRealModel(model, realID string) (AppliedRealModel, error) {
	target, found := LookupRealModel(realID)
	if !found {
		return AppliedRealModel{}, errors.New("未知的真实模型：" + realID)
	}
	key := normalizeModelKey(model)
	if key == "" {
		return AppliedRealModel{}, errors.New("请填写模型名")
	}

	/*
		定价：有数字就写，不因为「未核实」而跳过。

		取舍说明：第三方交叉比对的价格不像官方页那样权威，但它**远好过 0**——
		不写就按 0 计费（免费），站长白亏且不报错；写了则最多是单价有偏差，
		而偏差在账面上看得见、可修正。核实状态记在能力配置的
		verification / notes 里，管理界面会显示出来，供人工复核。
	*/
	priced := false
	if target.InputPrice > 0 || target.OutputPrice > 0 || isFreeModel(target) {
		price := ModelPrice{
			Model:       target.ID,
			InputPrice:  target.InputPrice,
			OutputPrice: target.OutputPrice,
			CachedPrice: target.CachedPrice,
		}
		if err := UpsertPrice(price); err != nil {
			return AppliedRealModel{}, err
		}
		priced = true
	}

	// 能力参数：从注册表生成一份（含推理档位）。
	caps := defaultCapabilities(target.ID)
	caps.ContextWindow = target.ContextWindow
	caps.MaxOutputTokens = target.MaxOutputTokens
	types := []string{"text"}
	if target.Vision {
		types = append(types, "image")
	}
	caps.InputTypes = types
	caps.OutputTypes = []string{"text"}
	toolCalling := target.ToolCalling
	caps.ToolCalling = &toolCalling
	if target.Reasoning && target.ReasoningParameter != "" {
		caps.Reasoning.Parameter = target.ReasoningParameter
		levels := target.ReasoningLevels
		if len(levels) == 0 {
			levels = defaultReasoningLevelsFor(target.ReasoningParameter)
		}
		caps.Reasoning.Levels = levels
		caps.Reasoning.Values = map[string]any{}
		for _, level := range levels {
			caps.Reasoning.Values[level] = reasoningValueFor(target.ReasoningParameter, level)
		}
	}
	if target.Verified {
		caps.Verification = "verified"
	}
	caps.Notes = target.Note
	capsaved, err := SaveModelCapabilities(caps)
	if err != nil {
		return AppliedRealModel{}, err
	}

	return AppliedRealModel{
		Model:        key,
		RealModel:    target.ID,
		Priced:       priced,
		Capabilities: capsaved,
	}, nil
}

// isFreeModel 判断注册表条目是否是「官方免费」模型。
//
// 免费模型的价格全为 0，与「未核实所以价格是 0」看起来一样，
// 靠 Note/Source 之外还需要一个显式判据：注册表里列出且标了免费说明的，
// 才允许按 0 写入定价。
func isFreeModel(model RealModel) bool {
	return model.InputPrice == 0 && model.OutputPrice == 0 && strings.Contains(model.Note, "免费")
}

// AppliedRealModel 是一次「绑定真实模型」的结果。
type AppliedRealModel struct {
	Model        string            `json:"model"`
	RealModel    string            `json:"real_model"`
	Priced       bool              `json:"priced"`
	Capabilities ModelCapabilities `json:"capabilities"`
}

/*
defaultReasoningLevelsFor 返回某参数下的默认档位名。

档位名与取值是两回事：thinkingBudget 这类参数要的是**整数预算**，
而档位名必须是小写英文标识（校验规则如此）。所以档位统一用
minimal/low/medium/high，取值由 reasoningValueFor 换算成预算数字。

早期这里只给一个 "default" 档位、取值又等于档位名本身（字符串），
于是校验直接报「思考预算必须是整数」—— 绑定失败，而且错误信息
指向参数类型，看不出是注册表缺省值的问题。
*/
func defaultReasoningLevelsFor(parameter string) []string {
	switch parameter {
	case "thinkingConfig.thinkingBudget", "thinking_budget", "thinking.budget_tokens":
		return []string{"minimal", "low", "medium", "high"}
	case "enable_thinking", "thinking.type":
		return []string{"enabled", "disabled"}
	default:
		return []string{"low", "medium", "high"}
	}
}

// reasoningValueFor 把档位名换算成该参数真正接受的取值。
func reasoningValueFor(parameter, level string) any {
	switch parameter {
	case "thinkingConfig.thinkingBudget", "thinking_budget", "thinking.budget_tokens":
		switch level {
		case "minimal":
			return 1024
		case "low":
			return 4096
		case "medium":
			return 16384
		case "high":
			return 32768
		}
		return 8192
	case "enable_thinking":
		return level == "enabled"
	case "thinking.type":
		return level
	}
	// effort 类参数：档位名就是取值。
	return level
}
