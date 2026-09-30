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
//   旧的 deepseek-chat / deepseek-reasoner 等名字不再作为模型登记，
//   调用时会经 resolveModel 的兜底逻辑自动落到 flash（reasoner 类名称自动开思考），
//   因此老客户端不改代码也能继续用，但平台对外只暴露 2 个真实模型。

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

/**
 * 解析请求的模型名 → 执行参数
 * 支持：
 *   1. 真实模型名：deepseek-flash / deepseek-v4-pro
 *   2. 历史旧名（deepseek-chat / deepseek-reasoner / r1 / thinker …）：
 *      不在注册表里，走下方兜底逻辑落到 flash，并按名字推断是否开思考
 * 返回 { model, thinking, search, vision, isReal }
 */
export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return { model: "deepseek-flash", thinking: false, search: false, vision: true, isReal: false };

  const search = /-search$/i.test(raw);
  const base = raw.replace(/-search$/i, "").toLowerCase();

  // 未知模型：按前缀猜测能力（保持宽容，避免直接报错）
  const real = REAL_MODELS.find((m) => base.startsWith(m.id) || m.id.startsWith(base.slice(0, 12)));
  if (real) {
    return { model: real.id, thinking: Boolean(real.thinkingDefault), search, vision: real.vision, isReal: false };
  }

  // 完全未知（含历史旧名）：落到 flash，并按名字推断思考
  return {
    model: "deepseek-flash",
    thinking: /reason|think|r1|pro|expert/i.test(base),
    search,
    vision: true,
    isReal: false,
  };
}

// 平台对外暴露的模型名（/v1/models 与前端选择器）—— 只有真实的 2 个
export function publicModels() {
  return REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    context: m.context,
    maxOutput: m.maxOutput,
    supportsSearch: true,
    supportsThinking: true,
  }));
}

// 渠道应声明的模型（供渠道管理默认值）
export const CHANNEL_MODELS = "deepseek-flash,deepseek-v4-pro";

/**
 * 兼容别名 → 平台规范名。
 * DeepSeek 官方已把 V4.1-Flash 更名为 deepseek-flash（2026-09 官方公告，
 * 用户确认"v4.1f 实际就是 flash"）—— 但 WorkBuddy / OpenCode 等托管上游的
 * 模型清单仍是旧 id deepseek-v4.1-flash，用户与渠道两侧都会出现旧名。
 * 这里把旧名归一到规范名：计费、白名单、渠道匹配都按 deepseek-flash 走
 * （渠道匹配的别名感知见 router.js#channelSupportsModel；
 *   托管上游只认旧 id 的发请求前翻译见 vendor-quirks.js#UPSTREAM_MODEL_MAP）。
 */
export const ALIASES = {
  "deepseek-v4.1-flash": "deepseek-flash",
};
