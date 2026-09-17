// 通义千问（阿里）模型定义
// ---------------------------------------------------------------------------
// 两套协议（2026-09 调研）：
//   · CN 网页版（qianwen.com）：/dialog/conversation，凭据 cookie tongyi_sso_ticket
//   · 国际版（chat.qwen.ai）：/api/v2/chat/completions，凭据 cookie token（JWT）
// 两者都有阿里风控（umidToken / ssxmod 指纹 / doQwenAuth 签名），
// 纯 HTTP 复现困难 —— 本适配器走浏览器驱动（与 GLM 同策略）。
//
// 国际版模型（实测 /api/models）：
//   qwen3.8-max、qwen3.7-plus（含 vision/thinking/search 能力）
export const REAL_MODELS = [
  {
    id: "qwen3.8-max",
    label: "通义千问 3.8 Max",
    desc: "旗舰模型，支持深度思考、联网与视觉",
    vision: true,
    thinkingDefault: false,
    upstream: "qwen3.8-max",
  },
  {
    id: "qwen3.7-plus",
    label: "通义千问 3.7 Plus",
    desc: "高性价比通用模型",
    vision: true,
    thinkingDefault: false,
    upstream: "qwen3.7-plus",
  },
  {
    id: "qwen3-max",
    label: "通义千问 3 Max",
    desc: "上一代旗舰",
    vision: false,
    thinkingDefault: false,
    upstream: "qwen3-max",
  },
  {
    id: "qwen-plus",
    label: "通义千问 Plus",
    desc: "经典通用模型",
    vision: false,
    thinkingDefault: false,
    upstream: "qwen-plus",
  },
];

export const ALIASES = {
  qwen: "qwen3.8-max",
  tongyi: "qwen3.8-max",
  "qwen-max": "qwen3-max",
  "qwen-max-latest": "qwen3-max",
  "qwen-turbo": "qwen-plus",
  "qwen-flash": "qwen3.7-plus",
  "qwen3.7-max": "qwen3.8-max",
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) {
    const d = REAL_MODELS[0];
    return { model: d.id, upstream: d.upstream, thinking: false, search: false, vision: d.vision };
  }

  let base = raw.toLowerCase();
  let search = false;
  let thinking = false;
  if (/-search$/.test(base)) {
    search = true;
    base = base.replace(/-search$/, "");
  }
  if (/-thinking$/.test(base)) {
    thinking = true;
    base = base.replace(/-thinking$/, "");
  }

  const real = REAL_MODELS.find((m) => m.id.toLowerCase() === base);
  if (real) {
    return { model: real.id, upstream: real.upstream, thinking: thinking || real.thinkingDefault, search, vision: real.vision };
  }

  const target = ALIASES[base];
  if (target) {
    const t = REAL_MODELS.find((m) => m.id === target) || REAL_MODELS[0];
    return { model: t.id, upstream: t.upstream, thinking: thinking || t.thinkingDefault, search, vision: t.vision };
  }

  const d = REAL_MODELS[0];
  return { model: d.id, upstream: d.upstream, thinking: /think|reason/i.test(base), search, vision: true };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  const list = REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    // 通义适配器暂未实现搜索/思考参数注入：显式标记，前端不再显示无效开关
    supportsSearch: false,
    supportsThinking: false,
  }));
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (REAL_MODELS.some((m) => m.id === alias)) continue;
    const t = REAL_MODELS.find((m) => m.id === target);
    list.push({
      id: alias,
      label: `${alias}（兼容别名）`,
      desc: `自动映射到 ${target}`,
      aliasOf: target,
      vision: t?.vision ?? false,
      deprecated: true,
    });
  }
  return list;
}
