// Kimi（月之暗面）模型定义
// ---------------------------------------------------------------------------
// 协议：Connect RPC over HTTP（Content-Type: application/connect+json）
//   body 是 JSON（非 protobuf），帧格式 = [1B flags][4B BE length][JSON]
// 模型：上游用 scenario 选择（SCENARIO_K2D5 等），对外暴露友好 id
export const REAL_MODELS = [
  {
    id: "kimi-k3",
    label: "Kimi K3",
    desc: "最新旗舰，支持深度思考与联网",
    scenario: "SCENARIO_K2D5",
    vision: true,
    thinkingDefault: false,
  },
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    desc: "高性价比通用模型",
    scenario: "SCENARIO_K2D5",
    vision: true,
    thinkingDefault: false,
  },
  {
    id: "kimi-k2",
    label: "Kimi K2",
    desc: "经典模型",
    scenario: "SCENARIO_K2",
    vision: false,
    thinkingDefault: false,
  },
];

export const ALIASES = {
  kimi: "kimi-k3",
  moonshot: "kimi-k3",
  "moonshot-v1-8k": "kimi-k2",
  "moonshot-v1-32k": "kimi-k2",
  "moonshot-v1-128k": "kimi-k2",
  "kimi-latest": "kimi-k3",
  "kimi-thinking": "kimi-k3",
};

/**
 * 解析模型名 → 执行参数
 * 后缀：-search（联网）、-thinking（深度思考）
 */
export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) {
    const d = REAL_MODELS[0];
    return { model: d.id, scenario: d.scenario, thinking: false, search: false, vision: d.vision };
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
  if (real) {
    return { model: real.id, scenario: real.scenario, thinking: thinking || real.thinkingDefault, search, vision: real.vision };
  }

  const aliasTarget = ALIASES[base];
  if (aliasTarget) {
    const t = REAL_MODELS.find((m) => m.id === aliasTarget) || REAL_MODELS[0];
    return { model: t.id, scenario: t.scenario, thinking: thinking || t.thinkingDefault, search, vision: t.vision };
  }

  // 未知：兜底旗舰，按名字推断能力
  const d = REAL_MODELS[0];
  return {
    model: d.id,
    scenario: d.scenario,
    thinking: thinking || /think|reason/i.test(base),
    search: search || /search/i.test(base),
    vision: true,
  };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  const list = REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
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
