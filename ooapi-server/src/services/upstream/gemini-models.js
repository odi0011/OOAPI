// Google（Gemini 订阅 / Antigravity OAuth）模型定义
// ---------------------------------------------------------------------------
// 协议：v1internal streamGenerateContent（见 upstream/antigravity.js）。
export const REAL_MODELS = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", desc: "快速旗舰", vision: true, thinkingDefault: false },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", desc: "推理与长上下文", vision: true, thinkingDefault: true },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", desc: "轻量快速", vision: true, thinkingDefault: false },
];

export const ALIASES = {};

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
    supportsSearch: false, // 未接入 web_search requestType
    supportsThinking: true,
  }));
}
