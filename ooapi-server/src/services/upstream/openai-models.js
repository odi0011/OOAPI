// OpenAI（ChatGPT 订阅 / Codex OAuth）模型定义
// ---------------------------------------------------------------------------
// 协议：Codex responses（见 upstream/codex.js）。
// 模型 id 必须与「模型定价」表对应；未登记的 id 会走默认兜底价并告警。
export const REAL_MODELS = [
  { id: "gpt-5", label: "GPT-5", desc: "订阅主力模型，支持推理与图片输入", vision: true, thinkingDefault: true },
  { id: "gpt-5-mini", label: "GPT-5 mini", desc: "轻量快速", vision: true, thinkingDefault: false },
  { id: "o3", label: "o3", desc: "推理模型", vision: true, thinkingDefault: true },
  { id: "o4-mini", label: "o4-mini", desc: "轻量推理", vision: true, thinkingDefault: true },
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
    supportsSearch: false, // Codex 协议未接入联网工具
    supportsThinking: true,
  }));
}
