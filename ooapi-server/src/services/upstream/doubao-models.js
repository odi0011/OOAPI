// 豆包（字节）模型定义
// ---------------------------------------------------------------------------
// 协议要点（2026-09 调研）：
//   · 端点 /samantha/chat/completion（SSE，三层嵌套 JSON）
//   · 签名 a_bogus（SM3 + 自定义 base64 + RC4）—— 纯算法可复现，但实现复杂；
//     稳妥做法是浏览器驱动（页面 JS 自动注入 a_bogus/msToken）
//   · 凭据：cookie sessionid（必需）+ passport_csrf_token
//   · 模型由 bot_id 决定，非 model 字段
//   · 深度思考：completion_option.use_deep_think / use_auto_cot
export const REAL_MODELS = [
  {
    id: "doubao-pro",
    label: "豆包 Pro",
    desc: "字节豆包主力模型（Seed 系列）",
    botId: "7338286299411103781",
    thinkingDefault: false,
    vision: true,
  },
  {
    id: "doubao-lite",
    label: "豆包 Lite",
    desc: "轻量快速版",
    botId: "7338286299411103781",
    thinkingDefault: false,
    vision: true,
  },
];

export const ALIASES = {
  doubao: "doubao-pro",
  seed: "doubao-pro",
  "doubao-seed": "doubao-pro",
};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) {
    const d = REAL_MODELS[0];
    return { model: d.id, botId: d.botId, thinking: false, search: false, vision: d.vision };
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

  const real = REAL_MODELS.find((m) => m.id === base);
  if (real) return { model: real.id, botId: real.botId, thinking: thinking || real.thinkingDefault, search, vision: real.vision };

  const target = ALIASES[base];
  if (target) {
    const t = REAL_MODELS.find((m) => m.id === target) || REAL_MODELS[0];
    return { model: t.id, botId: t.botId, thinking: thinking || t.thinkingDefault, search, vision: t.vision };
  }

  const d = REAL_MODELS[0];
  return { model: d.id, botId: d.botId, thinking: /think|reason/i.test(base), search, vision: true };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  const list = REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    // 豆包适配器暂未实现搜索/思考参数注入：显式标记，前端不再显示无效开关
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
