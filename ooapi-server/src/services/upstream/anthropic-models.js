// Anthropic（Claude 订阅 / Claude Code OAuth）模型定义
// ---------------------------------------------------------------------------
// 协议：/v1/messages（见 upstream/claude-oauth.js）。
export const REAL_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5", desc: "旗舰模型，长上下文与工具调用", vision: true, thinkingDefault: true },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", desc: "均衡主力", vision: true, thinkingDefault: false },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", desc: "轻量快速", vision: true, thinkingDefault: false },
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
    supportsSearch: false, // 未接入服务端联网工具
    supportsThinking: true,
  }));
}
