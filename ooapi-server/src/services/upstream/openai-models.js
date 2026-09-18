// OpenAI（ChatGPT 订阅 / Codex OAuth）模型定义
// ---------------------------------------------------------------------------
// 协议：Codex responses（见 upstream/codex.js）。
// 模型 id 必须与「模型定价」表对应；未登记的 id 会走默认兜底价并告警。
export const REAL_MODELS = [
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", desc: "线上实测可用（免费档）", vision: true, thinkingDefault: false },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", desc: "线上实测可用（免费档）", vision: true, thinkingDefault: false },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", desc: "旗舰档（订阅等级决定可用性）", vision: true, thinkingDefault: true },
  { id: "gpt-5.5", label: "GPT-5.5", desc: "主力模型", vision: true, thinkingDefault: true },
  { id: "codex-auto-review", label: "Codex Auto Review", desc: "代码审查用途", vision: false, thinkingDefault: false },
  // 保留旧 id：部分中转/历史渠道仍在使用
  { id: "gpt-5", label: "GPT-5", desc: "历史模型", vision: true, thinkingDefault: true },
  { id: "gpt-5-mini", label: "GPT-5 mini", desc: "历史轻量模型", vision: true, thinkingDefault: false },
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
