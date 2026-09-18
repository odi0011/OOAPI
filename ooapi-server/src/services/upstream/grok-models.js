// xAI Grok 模型定义（订阅 OAuth / API Key 共用）
// ---------------------------------------------------------------------------
// 协议：Responses API（见 upstream/grok.js）。
// 定价说明：本项目价目表暂未收录 Grok 官方价（避免录入未经核对的数字），
// 未配置价格的模型会走默认兜底价并打一次告警；管理员可在「模型定价」补录。
// remark 规则要求官方来源，补录时写 x.ai 官方定价页。
export const REAL_MODELS = [
  { id: "grok-4.6", label: "Grok 4.6", desc: "最新旗舰，支持深度思考与联网", vision: true, thinkingDefault: false },
  { id: "grok-4.5", label: "Grok 4.5", desc: "主力模型，支持深度思考", vision: true, thinkingDefault: false },
  { id: "grok-4.3", label: "Grok 4.3", desc: "上一代模型", vision: false, thinkingDefault: false },
  { id: "grok-3-mini", label: "Grok 3 mini", desc: "轻量快速", vision: false, thinkingDefault: false },
];

export const ALIASES = {
  grok: "grok-4.6",
  "grok-latest": "grok-4.6",
  "grok-4": "grok-4.5",
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  return { model: raw || REAL_MODELS[0].id, thinking: false, search: false, vision: true, isReal: false };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  return REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    supportsSearch: true, // xAI 提供 web_search / x_search 工具能力
    supportsThinking: true,
  }));
}
