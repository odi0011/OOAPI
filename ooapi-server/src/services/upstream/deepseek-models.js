// DeepSeek 网页版能力定义（依据 2026-09 官方与实测）
// ---------------------------------------------------------------------------
// 事实依据：
//   · 官方开放平台当前仅两个 model id：deepseek-flash（V4.1-Flash）、deepseek-v4-pro
//   · deepseek-chat / deepseek-reasoner 已于 2026-07-24 官方停用
//   · V4.1-Flash 原生多模态：直接传图即可识别，无需专用视觉模型（已实测验证）
//   · 深度思考是同一模型上的开关（thinking_enabled），不是独立模型
//   · 联网搜索是网页版产品功能（search_enabled），API 侧无对应参数
//
// 因此本平台的设计是：
//   模型 = 真实的 2 个（flash / v4-pro）
//   能力 = 请求参数（thinking / search），可任意组合，不占用模型名
//   同时保留对旧模型名的兼容映射，避免已有客户端直接报错。

// 真实模型（网页版 model_type → 平台模型）
export const REAL_MODELS = [
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    desc: "新架构旗舰，原生多模态，支持看图",
    vision: true,
    thinkingDefault: true,
    context: "1M",
    maxOutput: "384K",
    // 网页版档位：default 即 V4.1-Flash
    webModelType: "default",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    desc: "上一代旗舰，纯文本（不支持看图）",
    vision: false,
    thinkingDefault: true,
    context: "1M",
    maxOutput: "384K",
    webModelType: "expert",
  },
];

// 兼容别名：官方已停用的旧 id → 映射到当前真实模型 + 能力
// 目的：老客户端不改代码也能继续用
export const ALIASES = {
  "deepseek-chat": { model: "deepseek-flash", thinking: false },
  "deepseek-reasoner": { model: "deepseek-flash", thinking: true },
  "deepseek-r1": { model: "deepseek-flash", thinking: true },
  "deepseek-thinker": { model: "deepseek-flash", thinking: true },
  "deepseek-flash": { model: "deepseek-flash" },
  "deepseek-v4-pro": { model: "deepseek-v4-pro" },
  "deepseek-v4-flash": { model: "deepseek-flash" },
  "deepseek-v4-flash-vision-exp": { model: "deepseek-flash" },
};

/**
 * 解析请求的模型名 → 执行参数
 * 支持：
 *   1. 真实模型名：deepseek-flash / deepseek-v4-pro
 *   2. 旧别名：deepseek-chat / deepseek-reasoner …（自动映射 + 设定思考）
 *   3. 能力后缀：任意模型名 + -search（联网）
 * 返回 { model, thinking, search, vision, isReal }
 */
export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return { model: "deepseek-flash", thinking: false, search: false, vision: true, isReal: false };

  const search = /-search$/i.test(raw);
  const base = raw.replace(/-search$/i, "").toLowerCase();

  const alias = ALIASES[base];
  if (alias) {
    const real = REAL_MODELS.find((m) => m.id === alias.model) || REAL_MODELS[0];
    return {
      model: real.id,
      thinking: alias.thinking !== undefined ? alias.thinking : Boolean(real.thinkingDefault),
      search,
      vision: real.vision,
      isReal: base === real.id,
    };
  }

  // 未知模型：按前缀猜测能力（保持宽容，避免直接报错）
  const real = REAL_MODELS.find((m) => base.startsWith(m.id) || m.id.startsWith(base.slice(0, 12)));
  if (real) {
    return { model: real.id, thinking: Boolean(real.thinkingDefault), search, vision: real.vision, isReal: false };
  }

  // 完全未知：落到 flash，并按名字推断思考
  return {
    model: "deepseek-flash",
    thinking: /reason|think|r1|pro|expert/i.test(base),
    search,
    vision: true,
    isReal: false,
  };
}

// 平台对外暴露的模型名（/v1/models 与前端选择器）
export function publicModels() {
  const list = REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    context: m.context,
    maxOutput: m.maxOutput,
  }));
  // 兼容别名也列出，便于老客户端平迁移
  for (const [alias, cfg] of Object.entries(ALIASES)) {
    if (REAL_MODELS.some((m) => m.id === alias)) continue;
    list.push({
      id: alias,
      label: `${alias}（兼容别名）`,
      desc: `官方已停用，自动映射到 ${cfg.model}`,
      aliasOf: cfg.model,
      vision: REAL_MODELS.find((m) => m.id === cfg.model)?.vision ?? false,
      deprecated: true,
    });
  }
  return list;
}

// 渠道应声明的模型（供渠道管理默认值）
export const CHANNEL_MODELS = "deepseek-flash,deepseek-v4-pro";
