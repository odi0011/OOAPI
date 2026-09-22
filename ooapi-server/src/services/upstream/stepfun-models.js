// 阶跃星辰 StepFun 模型定义（OpenAI 兼容）
// ---------------------------------------------------------------------------
// 官方一手资料（2026-09-20 取自 platform.stepfun.com/docs/zh/*）：
//   · 端点：https://api.stepfun.com/v1
//   · 鉴权：Authorization: Bearer <API Key>
//   · 订阅通道另有 /step_plan/v1（只接受 step-router-v1，且不支持图片/文档/联网）——
//     本项目按标准 API 通道接入，不用订阅通道（它的使用限制与网关用法冲突）。
//
// **已下线不要登记**（2026-07-08 弃用）：step-1-*、step-1v-*、step-2-mini、step-2-16k、step-3。
// **即将下线**（2026-10-10）：step-image-edit-2、step-2x-large —— 属图像模型，本就不登记。
//
// 协议差异：响应同时返回 `reasoning` 与 `reasoning_content` 两个思维链字段；
// `reasoning_effort` 的 `step-3.5-flash-2603` 只接受 low/high（传 medium 报错）——
// 适配器层做参数裁剪（见 openai-compat.js 的 vendorPreset）。
export const REAL_MODELS = [
  {
    id: "step-5-preview",
    label: "Step 5 Preview",
    desc: "旗舰；支持文本/图片/视频输入，拒绝 web_search 内置工具",
    vision: true,
    thinkingDefault: false,
  },
  { id: "step-3.7-flash", label: "Step 3.7 Flash", desc: "多模态推理（图片/视频）", vision: true, thinkingDefault: false },
  { id: "step-3.5-flash", label: "Step 3.5 Flash", desc: "仅文本，性价比档", vision: false, thinkingDefault: false },
  { id: "step-3.5-flash-2603", label: "Step 3.5 Flash (2603)", desc: "仅文本；reasoning_effort 只接受 low/high", vision: false, thinkingDefault: false },
];

export const ALIASES = {
  "step-3": "step-3.7-flash", // 已下线，映射到官方建议的迁移目标
  "step-router-v1": "step-5-preview", // 订阅通道的路由模型，本平台走标准通道
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  const resolved = ALIASES[raw] || raw || REAL_MODELS[0].id;
  // vision 按具体模型取（step-3.5-flash 系列仅文本）。一律 true 会把带图请求
  // 送到不支持视觉的档位上，上游报的是含糊的参数错误而不是「不支持图片」。
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
