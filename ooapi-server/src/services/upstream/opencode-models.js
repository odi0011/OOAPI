// OpenCode Zen 模型定义（OpenAI 兼容网关）
// 价格未收录官方数字前走默认兜底价并打告警，管理员可在「模型定价」补录。
export const REAL_MODELS = [
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", desc: "OpenCode Zen 通道", vision: true, thinkingDefault: false },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", desc: "Anthropic 档位", vision: true, thinkingDefault: false },
  { id: "qwen3-coder", label: "Qwen3 Coder", desc: "代码优化", vision: false, thinkingDefault: false },
  { id: "grok-code", label: "Grok Code", desc: "xAI 代码档位", vision: false, thinkingDefault: false },
  { id: "kimi-k2", label: "Kimi K2", desc: "长上下文", vision: false, thinkingDefault: false },
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
    supportsSearch: false,
    supportsThinking: false,
  }));
}
