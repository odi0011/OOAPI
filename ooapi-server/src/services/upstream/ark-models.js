// 火山方舟（Volcano Ark）模型定义（OpenAI 兼容）
// ---------------------------------------------------------------------------
// 官方一手资料（2026-09-20 取自 docs.volcengine.com 的模型列表与定价页，更新至 2026-09-17）：
//   · 数据面端点：https://ark.cn-beijing.volces.com/api/v3
//   · 鉴权：**用 API Key 时 `model` 直接填 Model ID**（如 doubao-seed-2-1-pro-260628），
//     **不需要 ep-xxxx 接入点 ID**；只有用 Access Key(AK/SK) 签名时才必须填 Endpoint ID。
//     本平台只支持 API Key 鉴权，所以不存在 ep- 的问题。
//
// **协议差异（必须在适配器层处理，见 openai-compat.js 的 vendorPreset）**：
//   ① **模型可能被自动降级**：响应里的 `service_status.model_fallback` 会给出
//      `fallback_triggered` / `original_model` —— 方舟在容量紧张时会自动换模型跑。
//      计费与日志必须按**实际生效的模型**，否则「按 A 的价收了 B 的钱」。
//   ② 非标参数走 extra_body：`thinking: {type: enabled|disabled}`、`reasoning_effort`（到 max 档）。
//   ③ `max_completion_tokens` 与 `max_tokens` **不可同时设置**。
//
// 价格：人民币 ÷ 7.2。方舟按输入长度分档，这里取最常用档（短输入）并在 remark 注明。
// 第三方同名直连（deepseek-v4-pro / glm-5.3-flash 等）不在此登记 ——
// 它们与厂商官方模型同名，登记会与 deepseek/glm 的价格冲突（同一个模型名只能有一个价）。
export const REAL_MODELS = [
  {
    id: "doubao-seed-2-1-pro",
    label: "Doubao Seed 2.1 Pro",
    desc: "旗舰；≤1024 输入档，长输入价格上浮",
    vision: true,
    thinkingDefault: false,
  },
  { id: "doubao-seed-2-1-turbo", label: "Doubao Seed 2.1 Turbo", desc: "快速档", vision: true, thinkingDefault: false },
  { id: "doubao-seed-2-0-pro", label: "Doubao Seed 2.0 Pro", desc: "上一代旗舰（按输入长度分三档）", vision: true, thinkingDefault: false },
  { id: "doubao-seed-2-0-lite", label: "Doubao Seed 2.0 Lite", desc: "轻量档", vision: true, thinkingDefault: false },
  { id: "doubao-seed-2-0-mini", label: "Doubao Seed 2.0 Mini", desc: "最小档，成本最低", vision: true, thinkingDefault: false },
  { id: "doubao-seed-2-0-code", label: "Doubao Seed 2.0 Code", desc: "代码向", vision: false, thinkingDefault: false },
  { id: "doubao-seed-1.8", label: "Doubao Seed 1.8", desc: "上一代通用档", vision: true, thinkingDefault: false },
  { id: "doubao-seed-1.6", label: "Doubao Seed 1.6", desc: "经典档", vision: true, thinkingDefault: false },
  { id: "doubao-seed-1-6-flash", label: "Doubao Seed 1.6 Flash", desc: "经典高速档", vision: false, thinkingDefault: false },
  { id: "doubao-seed-1-6-vision", label: "Doubao Seed 1.6 Vision", desc: "视觉档", vision: true, thinkingDefault: false },
];

export const ALIASES = {
  // 带日期后缀的版本号与无后缀是同一个模型（方舟两者都收），
  // 统一到无后缀名，避免每个快照都要单独配价
  "doubao-seed-2-1-pro-260628": "doubao-seed-2-1-pro",
  "doubao-seed-2-1-pro-260915": "doubao-seed-2-1-pro",
  "doubao-seed-2-1-turbo-260628": "doubao-seed-2-1-turbo",
  "doubao-seed-2-0-pro-260215": "doubao-seed-2-0-pro",
  "doubao-seed-2-0-lite-260215": "doubao-seed-2-0-lite",
  "doubao-seed-2-0-lite-260428": "doubao-seed-2-0-lite",
  "doubao-seed-2-0-mini-260215": "doubao-seed-2-0-mini",
  "doubao-seed-2-0-mini-260428": "doubao-seed-2-0-mini",
  "doubao-seed-1-8-251228": "doubao-seed-1.8",
  "doubao-seed-1-6-250615": "doubao-seed-1.6",
  "doubao-seed-1-6-251015": "doubao-seed-1.6",
  // 老渠道里的简名（doubao-pro/doubao-lite 是早期登记名）继续可用
  "doubao-pro": "doubao-seed-2-0-pro",
  "doubao-lite": "doubao-seed-2-0-lite",
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  const resolved = ALIASES[raw] || raw || REAL_MODELS[0].id;
  return { model: resolved, thinking: false, search: false, vision: true, isReal: REAL_MODELS.some((m) => m.id === resolved) };
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
    supportsThinking: true,
  }));
}
