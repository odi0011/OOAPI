// WorkBuddy / CodeBuddy（腾讯）模型定义
// ---------------------------------------------------------------------------
// 说明：这些模型是腾讯云托管同名档位（deepseek-* / glm-* / kimi-* / gpt-5.6-*），
// 不是 DeepSeek/智谱/Kimi 官方转发 —— 因此按独立厂商登记，避免与各厂官方价混算。
// 价格未收录官方数字前走默认兜底价并打告警，管理员可在「模型定价」补录。
//
// 例外（2026-09-29，用户确认）：deepseek-v4.1-flash 与官方 deepseek-flash 是**同一个
// 模型**（DeepSeek 官方把 V4.1-Flash 更名为 deepseek-flash），平台归一到规范名：
//   · 条目标 aliasOf（下拉/登记表不再当独立模型，定价并入 deepseek-flash 一行）；
//   · 上游清单仍是旧 id，发请求前的翻译见 vendor-quirks.js#UPSTREAM_MODEL_MAP。
export const REAL_MODELS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek Flash（腾讯托管）", desc: "与官方 deepseek-flash 同一模型（上游旧 id）", vision: false, thinkingDefault: false, aliasOf: "deepseek-flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（腾讯托管）", desc: "深度推理", vision: false, thinkingDefault: false },
  { id: "glm-5.3", label: "GLM-5.3（腾讯托管）", desc: "智谱档位", vision: false, thinkingDefault: false },
  { id: "kimi-k3", label: "Kimi K3（腾讯托管）", desc: "长上下文", vision: false, thinkingDefault: false },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna（腾讯托管）", desc: "OpenAI 档位", vision: false, thinkingDefault: false },
];

export const ALIASES = {
  // 注意：别名解析只有一跳（resolveAliasSync 不追链），必须直接指向**规范名**
  "codebuddy": "deepseek-flash",
  "workbuddy": "deepseek-flash",
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
    ...(m.aliasOf ? { aliasOf: m.aliasOf } : {}),
  }));
}
