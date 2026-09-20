// 硅基流动（SiliconFlow）模型定义（OpenAI 兼容聚合）
// 价格未收录前走默认兜底价并打告警；管理员可「拉取模型」同步目录。
export const REAL_MODELS = [
  { id: "deepseek-ai/DeepSeek-V3.2", label: "DeepSeek V3.2", desc: "硅基流动托管", vision: false, thinkingDefault: false },
  { id: "Qwen/Qwen3-235B-A22B", label: "Qwen3 235B", desc: "通义千问", vision: false, thinkingDefault: false },
  { id: "zai-org/GLM-4.6", label: "GLM-4.6", desc: "智谱", vision: false, thinkingDefault: false },
  { id: "moonshotai/Kimi-K2", label: "Kimi K2", desc: "长上下文", vision: false, thinkingDefault: false },
];

export const ALIASES = {};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  return { model: raw || REAL_MODELS[0].id, thinking: false, search: false, vision: false, isReal: false };
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
