// 统一模型层：聚合各厂商模型，提供模型名 → 渠道匹配所需的解析
// ---------------------------------------------------------------------------
// 设计原则（重要）：
//   网关/对话路由**只负责把用户请求的模型名透传**给渠道层匹配，
//   各厂商的别名映射由各自适配器内部完成。
//   这样新增厂商时无需改动网关代码。
import { VENDORS } from "./vendors.js";
import { DEFAULT_PRICES } from "./pricing.js";
import { pool } from "../db.js";

// 各厂商的模型定义（懒加载，避免循环依赖）
const VENDOR_MODEL_MODULES = {
  deepseek: () => import("./upstream/deepseek-models.js"),
  glm: () => import("./upstream/glm-models.js"),
  kimi: () => import("./upstream/kimi-models.js"),
  doubao: () => import("./upstream/doubao-models.js"),
  qwen: () => import("./upstream/qwen-models.js"),
  // 订阅型 OAuth 厂商（Codex / Claude Code / Antigravity / Grok）
  openai: () => import("./upstream/openai-models.js"),
  anthropic: () => import("./upstream/anthropic-models.js"),
  gemini: () => import("./upstream/gemini-models.js"),
  grok: () => import("./upstream/grok-models.js"),
};

/**
 * 聚合所有厂商的对外模型列表
 * @param {string[]|null} onlyTypes 限定厂商类型（null = 全部已启用）
 */
export async function allPublicModels(onlyTypes = null) {
  const types = onlyTypes || VENDORS.filter((v) => v.enabled !== false).map((v) => v.channelType);
  const out = [];
  for (const t of types) {
    const loader = VENDOR_MODEL_MODULES[t];
    if (!loader) continue;
    try {
      const mod = await loader();
      if (typeof mod.publicModels !== "function") continue;
      for (const m of mod.publicModels()) {
        out.push({ ...m, vendor: t, vendorName: VENDORS.find((v) => v.channelType === t)?.name || t });
      }
    } catch {
      /* 该厂商模型模块不可用时跳过 */
    }
  }
  return out;
}

/**
 * 渠道匹配用的模型名解析。
 * 注意：**不做跨厂商映射**，只把带能力后缀的名字归一化后原样返回，
 *      真正的别名映射（如 glm-4 → glm-4.7）在各适配器内部。
 * 这样 glm-5.3-flash 只会匹配声明了该模型的 GLM 渠道。
 */
export function modelForChannelMatch(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return "";
  // 去掉能力后缀（-search / -thinking）—— 渠道声明的是基础模型名
  return raw.replace(/-(search|thinking|agent|agent-swarm)$/i, "");
}

// ---------------------------------------------------------------------------
// 兼容别名解析（计费 / 渠道匹配共用）
// ---------------------------------------------------------------------------
// 历史问题：别名（kimi-latest、qwen-turbo、glm-4-flash…）由适配器 resolveModel
// 映射到真实模型，但计费与渠道匹配用的是请求原名 → 价格落到默认兜底档（偏差 3~10 倍），
// 别名请求也会因为渠道没声明别名而 NO_CHANNEL。
// 别名表从各厂商 *-models.js 的 ALIASES 汇总，启动时预热；未就绪时原样返回。
let aliasCache = null;
const LEGACY_ALIASES = {
  // DeepSeek 官方旧 ID 已停用，适配器兜底把这类名字落到 flash（见 deepseek-models.js）
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
};

export async function warmAliasMap() {
  const map = new Map();
  for (const t of Object.keys(VENDOR_MODEL_MODULES)) {
    try {
      const mod = await VENDOR_MODEL_MODULES[t]();
      for (const [alias, target] of Object.entries(mod.ALIASES || {})) {
        const k = String(alias).toLowerCase();
        if (!map.has(k)) map.set(k, String(target));
      }
    } catch {
      /* 该厂商模型模块不可用时跳过 */
    }
  }
  for (const [alias, target] of Object.entries(LEGACY_ALIASES)) map.set(alias, target);
  aliasCache = map;
  return map;
}

/** 同步解析兼容别名 → 真实模型（结果不带能力后缀）；未命中/未预热时原样返回 */
export function resolveAliasSync(requested) {
  const raw = String(requested || "").trim();
  if (!raw || !aliasCache) return raw;
  const base = raw.toLowerCase().replace(/-(search|thinking|agent|agent-swarm)$/i, "");
  return aliasCache.get(base) || raw;
}

/**
 * 校验模型是否属于某个厂商（用于管理端提示，不用于调度）
 */
export async function modelBelongsToVendor(model, channelType) {
  const loader = VENDOR_MODEL_MODULES[channelType];
  if (!loader) return false;
  try {
    const mod = await loader();
    if (typeof mod.publicModels !== "function") return false;
    const names = mod.publicModels().map((m) => m.id.toLowerCase());
    const m = String(model || "").toLowerCase().replace(/-(search|thinking)$/i, "");
    return names.some((n) => n === m);
  } catch {
    return false;
  }
}

/** 已注册的厂商类型 */
export function supportedVendorTypes() {
  return Object.keys(VENDOR_MODEL_MODULES);
}

// ---------------------------------------------------------------------------
// 模型登记表（用于定价导入的严格校验）
// ---------------------------------------------------------------------------
// 判定「真实存在」的口径（三者并集）：
//   1. 内置价目表里的模型（DEFAULT_PRICES，含各家官方模型与官方旧 ID 别名）
//   2. 各厂商模型模块 publicModels() 暴露的模型
//   3. 现有渠道 models 字段里声明的模型（覆盖 openai-compat 等自定义渠道）
// 不在登记表里的 = 垃圾数据，定价导入必须拒绝。
let registryCache = { at: 0, map: null };
const REGISTRY_TTL_MS = 60_000;

/** 拆分渠道 models 字段（逗号/换行/空格分隔，去空去重） */
function splitModelList(raw) {
  return String(raw || "")
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 返回 { modelLower: { model, type } } 的登记表。
 * type 为渠道类型（deepseek/openai/qwen…），供导入时校验/补全。
 */
export async function modelRegistry() {
  if (registryCache.map && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.map;
  const map = new Map();
  const put = (id, type) => {
    const k = String(id || "").toLowerCase().trim();
    if (!k || map.has(k)) return;
    map.set(k, { model: String(id).trim(), type: String(type || "") });
  };

  for (const p of DEFAULT_PRICES) put(p.model, p.type);
  for (const t of Object.keys(VENDOR_MODEL_MODULES)) {
    try {
      const mod = await VENDOR_MODEL_MODULES[t]();
      // 只登记真实模型：兼容别名（deprecated/aliasOf）可以继续被调用，
      // 但不作为独立模型出现在定价表/导入白名单里（否则历史别名会一直被当成"合法垃圾"）。
      if (typeof mod.publicModels === "function") {
        for (const m of mod.publicModels()) {
          if (m.deprecated || m.aliasOf) continue;
          put(m.id, t);
        }
      }
    } catch {
      /* 模块不可用时跳过 */
    }
  }
  try {
    const [rows] = await pool.query("SELECT type, models FROM channels");
    for (const r of rows) for (const m of splitModelList(r.models)) put(m, r.type);
  } catch {
    /* 表不存在/查询失败时不影响前两类 */
  }

  registryCache = { at: Date.now(), map };
  return map;
}

export function invalidateModelRegistry() {
  registryCache = { at: 0, map: null };
}
