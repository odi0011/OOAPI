// WorkBuddy / CodeBuddy（腾讯）模型定义
// ---------------------------------------------------------------------------
// 说明：这些模型是腾讯云托管同名档位（deepseek-* / glm-* / kimi-* / gpt-5.6-*），
// 不是 DeepSeek/智谱/Kimi 官方转发 —— 因此按独立厂商登记，避免与各厂官方价混算。
// 价格未收录官方数字前走默认兜底价并打告警，管理员可在「模型定价」补录。
export const REAL_MODELS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash（腾讯托管）", desc: "轻量快速", vision: false, thinkingDefault: false },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（腾讯托管）", desc: "深度推理", vision: false, thinkingDefault: false },
  { id: "glm-5.3", label: "GLM-5.3（腾讯托管）", desc: "智谱档位", vision: false, thinkingDefault: false },
  { id: "kimi-k3", label: "Kimi K3（腾讯托管）", desc: "长上下文", vision: false, thinkingDefault: false },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna（腾讯托管）", desc: "OpenAI 档位", vision: false, thinkingDefault: false },
];

export const ALIASES = {
  "codebuddy": "deepseek-v4.1-flash",
  "workbuddy": "deepseek-v4.1-flash",
};

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
