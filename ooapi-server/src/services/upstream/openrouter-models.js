// OpenRouter 模型定义（OpenAI 兼容聚合，模型名保持 vendor/model 形式）
// 价格随上游浮动，未收录前走默认兜底价并打告警；管理员可「拉取模型」同步目录。
export const REAL_MODELS = [
  { id: "openai/gpt-5.5", label: "OpenAI GPT-5.5", desc: "OpenRouter 转发", vision: true, thinkingDefault: false },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", desc: "OpenRouter 转发", vision: true, thinkingDefault: false },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", desc: "OpenRouter 转发", vision: true, thinkingDefault: false },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", desc: "OpenRouter 转发", vision: false, thinkingDefault: false },
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
