// Qoder（阿里）模型定义
// ---------------------------------------------------------------------------
// 模型目录由 Qoder 网关动态下发（桥会实时拉取）；这里是启动兜底表，
// 实际可选模型以渠道「拉取模型」的结果为准。价格未收录走兜底价并告警。
export const REAL_MODELS = [
  { id: "Qwen3.8-Max-Preview", label: "Qwen3.8 Max Preview", desc: "最新基座", vision: true, thinkingDefault: false },
  { id: "Qwen3.7-Max", label: "Qwen3.7 Max", desc: "默认模型", vision: true, thinkingDefault: false },
  { id: "Qwen3.7-Plus", label: "Qwen3.7 Plus", desc: "均衡", vision: true, thinkingDefault: false },
  { id: "DeepSeek-V4-Pro", label: "DeepSeek V4 Pro（Qoder）", desc: "专家模型", vision: true, thinkingDefault: false },
  { id: "GLM-5.2", label: "GLM-5.2（Qoder）", desc: "智谱档位", vision: true, thinkingDefault: false },
  { id: "Kimi-K2.7-Code", label: "Kimi K2.7 Code（Qoder）", desc: "代码优化，256K", vision: true, thinkingDefault: false },
];

export const ALIASES = {
  qwen: "Qwen3.7-Plus",
  deepseek: "DeepSeek-V4-Pro",
  glm: "GLM-5.2",
  kimi: "Kimi-K2.7-Code",
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
    supportsSearch: false,
    supportsThinking: false,
  }));
}
