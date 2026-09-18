// GLM（智谱 / Z.ai）模型定义
// ---------------------------------------------------------------------------
// 模型 id 来自实测（GET https://chat.z.ai/api/models，2026-09）。
// 注意：上游 id 与展示名不一致（如 GLM-5.3-Flash 的真实 id 是 x-preview-l），
//      本文件维护映射，对外暴露友好的模型名。
// 能力声明必须与适配器实现一致：GLM 适配器尚未实现图片上传，
// 所有模型 vision 必须为 false（否则前端会展示看图能力，调用却报 VISION_NOT_SUPPORTED）
export const REAL_MODELS = [
  {
    id: "glm-5.3",
    upstream: "glm-5.3",
    label: "GLM-5.3",
    desc: "旗舰模型，支持深度思考与联网",
    vision: false,
    thinkingDefault: false,
    search: true,
    caps: ["agent_mode", "file_qa", "mcp", "reasoning_effort", "returnFc", "returnThink", "think", "web_search"],
  },
  {
    id: "glm-5.3-flash",
    upstream: "x-preview-l",
    label: "GLM-5.3 Flash",
    desc: "轻量旗舰（原生多模态、支持看图）",
    vision: false,
    thinkingDefault: false,
    search: true,
    caps: ["agent_mode", "file_qa", "reasoning_effort", "returnFc", "returnThink", "think", "vision", "web_search"],
  },
  {
    id: "glm-5.2",
    upstream: "glm-5.2",
    label: "GLM-5.2",
    desc: "上一代旗舰",
    vision: false,
    thinkingDefault: false,
    search: true,
    caps: ["agent_mode", "file_qa", "mcp", "reasoning_effort", "think", "web_search"],
  },
  {
    id: "glm-4.7",
    upstream: "glm-4.7",
    label: "GLM-4.7",
    desc: "经典高性能模型",
    vision: false,
    thinkingDefault: false,
    search: true,
    caps: ["file_qa", "mcp", "think", "web_search"],
  },
  {
    id: "glm-5v-turbo",
    upstream: "GLM-5v-Turbo",
    label: "GLM-5V Turbo",
    desc: "视觉模型，适合图像理解",
    vision: false,
    thinkingDefault: false,
    search: true,
    caps: ["agent_mode", "citations", "file_qa", "think", "vision", "vlm_tools_enable", "web_search"],
  },
  {
    id: "glm-4.5",
    upstream: "0727-360B-API",
    label: "GLM-4.5",
    desc: "高性价比通用模型",
    vision: false,
    thinkingDefault: false,
    search: false,
    caps: ["file_qa", "mcp", "think"],
  },
  {
    id: "glm-4.5-air",
    upstream: "0727-106B-API",
    label: "GLM-4.5 Air",
    desc: "轻量通用模型",
    vision: false,
    thinkingDefault: false,
    search: false,
    caps: ["file_qa", "mcp", "think"],
  },
];

// 兼容别名 → 真实模型 id
export const ALIASES = {
  glm: "glm-5.3",
  zhipu: "glm-5.3",
  chatglm: "glm-4.7",
  "glm-5": "glm-5.3",
  "glm-5.1": "glm-5.2",
  "glm-4": "glm-4.7",
  "glm-4-plus": "glm-5.3",
  "glm-4-flash": "glm-5.3-flash",
  "glm-4-flashx": "glm-5.3-flash",
  "glm-4-air": "glm-4.5-air",
  "glm-4.5-airx": "glm-4.5-air",
  "glm-4.6": "glm-5.2",
  "glm-4.5-x": "glm-5.2",
  "glm-4v": "glm-5v-turbo",
  "glm-4.6v": "glm-5v-turbo",
  "glm-5v": "glm-5v-turbo",
};

/**
 * 解析请求的模型名 → 执行参数
 * 支持后缀：-search（联网）、-thinking（深度思考）
 */
export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  if (!raw) {
    const d = REAL_MODELS[0];
    return { model: d.id, upstream: d.upstream, thinking: d.thinkingDefault, search: false, vision: d.vision, isReal: false };
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
    return {
      model: real.id,
      upstream: real.upstream,
      thinking: thinking || real.thinkingDefault,
      search: real.search ? search : false,
      vision: real.vision,
      isReal: true,
    };
  }

  const aliasTarget = ALIASES[base];
  if (aliasTarget) {
    const t = REAL_MODELS.find((m) => m.id === aliasTarget) || REAL_MODELS[0];
    return {
      model: t.id,
      upstream: t.upstream,
      thinking: thinking || t.thinkingDefault,
      search: t.search ? search : false,
      vision: t.vision,
      isReal: false,
    };
  }

  // 未知：兜底旗舰，按名字猜思考
  const d = REAL_MODELS[0];
  return {
    model: d.id,
    upstream: d.upstream,
    thinking: thinking || /think|reason/i.test(base),
    search,
    vision: false, // 适配器不支持图片，不能按名字推断（否则声明与实现不一致）
    isReal: false,
  };
}

// 渠道默认声明的模型
export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

// 对外公开列表（含兼容别名）
export function publicModels() {
  const list = REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    supportsSearch: m.search,
    supportsThinking: true,
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

// 上游 id → 平台友好 id（后台展示/调试用）
export function friendlyId(upstreamId) {
  const m = REAL_MODELS.find((x) => x.upstream === upstreamId);
  return m ? m.id : upstreamId;
}
