// 小米 MiMo 模型定义（OpenAI 兼容）
// ---------------------------------------------------------------------------
// 官方一手资料（2026-09-20 取自 mimo.mi.com/llms.txt → static/docs/*.md）：
//   · OpenAI 兼容端点：https://api.xiaomimimo.com/v1
//   · 鉴权：`api-key: <key>` 或 `Authorization: Bearer <key>` 都支持
//   · 另有 Anthropic 兼容端点 /anthropic（本项目用不到，走 OpenAI 那套）
//
// **已下线的模型不要登记**（2026-06-30 弃用）：mimo-v2-pro / v2-omni / v2-flash / v2-tts。
// 控制台横幅上的 MiMo-X-*-Preview 只对桌面客户端开放，**不在 API 模型表里**，登记了就是死链。
//
// 价格来自官方人民币价 ÷ 7.2（与全站其它国产厂商同一口径，见 pricing.js 的 CNY_PER_USD）。
export const REAL_MODELS = [
  {
    id: "mimo-v2.5-pro",
    label: "MiMo V2.5 Pro",
    desc: "1M 上下文 / 128K 输出；思考模式下忽略 temperature",
    vision: true,
    thinkingDefault: false,
  },
  {
    id: "mimo-v2.5",
    label: "MiMo V2.5",
    desc: "全模态理解，1M 上下文",
    vision: true,
    thinkingDefault: false,
  },
];

export const ALIASES = {
  // 已有别名指向（历史/习惯叫法），避免用户填旧名时匹配不到渠道
  "mimo-v2": "mimo-v2.5",
  "mimo-pro": "mimo-v2.5-pro",
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  const resolved = ALIASES[raw] || raw || REAL_MODELS[0].id;
  return { model: resolved, thinking: false, search: false, vision: true, isReal: REAL_MODELS.some((m) => m.id === resolved) };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  return REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    supportsSearch: false,
    supportsThinking: true,
  }));
}
