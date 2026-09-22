// MiniMax 模型定义（OpenAI 兼容）
// ---------------------------------------------------------------------------
// 官方一手资料（2026-09-20 取自 platform.minimax.io/docs/llms.txt 与国内站）：
//   · 国际端点：https://api.minimax.io/v1
//   · 国内端点：https://api.minimax.cn/v1（官方文档口径；账号归属区域决定用哪个）
//   · 鉴权：Authorization: Bearer <API Key>，无额外 header
//
// **协议差异（必须在适配器层处理，见 openai-compat.js 的 vendorPreset）**：
//   · `reasoning_split` 默认为 false 时，思维链以 <think> 标签**混在 content 里**；
//     不显式开启的话，下游会把思考内容当正文渲染。平台强制注入 true。
//   · `presence_penalty` / `frequency_penalty` / `logit_bias` 被静默忽略（不报错）。
//   · `temperature` 范围 [0,2]，越界直接报错（与 OpenAI 的宽松处理不同）。
//
// 价格：人民币价 ÷ 7.2（与全站国产厂商同口径）。
// M3 按输入长度分档（≤512k 半价），这里取常用档（≤512k）录入并在 remark 注明。
export const REAL_MODELS = [
  {
    id: "MiniMax-M3",
    label: "MiniMax M3",
    desc: "1M 上下文；支持图片/视频输入",
    vision: true,
    thinkingDefault: false,
  },
  { id: "MiniMax-M2.7", label: "MiniMax M2.7", desc: "204K 上下文", vision: false, thinkingDefault: false },
  {
    id: "MiniMax-M2.7-highspeed",
    label: "MiniMax M2.7 高速",
    desc: "204K；高速档，价格高于标准档",
    vision: false,
    thinkingDefault: false,
  },
  { id: "MiniMax-M2.5", label: "MiniMax M2.5", desc: "204K 上下文", vision: false, thinkingDefault: false },
  { id: "MiniMax-M2.1", label: "MiniMax M2.1", desc: "204K 上下文", vision: false, thinkingDefault: false },
  { id: "MiniMax-M2", label: "MiniMax M2", desc: "204K 上下文", vision: false, thinkingDefault: false },
];

export const ALIASES = {
  minimax: "MiniMax-M2.7",
  "abab6.5s-chat": "MiniMax-M2.1", // 上一代命名，保留兼容
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  // 模型名大小写敏感度：官方用 "MiniMax-M3" 这种混合大小写，
  // 用户可能填成全小写 → 按不区分大小写匹配回规范名（否则渠道匹配会落空）
  const hit = REAL_MODELS.find((m) => m.id.toLowerCase() === raw.toLowerCase());
  const resolved = hit ? hit.id : ALIASES[raw] || raw || REAL_MODELS[0].id;
  // vision **按具体模型**取，不能一律 true：M2.7/M2.5 这些纯文本档位
  // 上游不接图片，一律放行会让带图请求打到一个必然失败的模型上
  // （表现是上游报参数错误，而不是「不支持视觉」）。
  // 未登记的模型（用户自定义名）保守按不支持处理，由适配器显式报
  // VISION_NOT_SUPPORTED，让管理员看到明确原因而不是上游的含糊报错。
  const spec = REAL_MODELS.find((m) => m.id === resolved);
  return {
    model: resolved,
    thinking: false,
    search: false,
    vision: Boolean(spec?.vision),
    isReal: Boolean(spec),
  };
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
