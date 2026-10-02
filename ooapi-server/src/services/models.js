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
  workbuddy: () => import("./upstream/workbuddy-models.js"),
  qoder: () => import("./upstream/qoder-models.js"),
  // 国产厂商直连（OpenAI 兼容，2026-09 接入）
  mimo: () => import("./upstream/mimo-models.js"),
  minimax: () => import("./upstream/minimax-models.js"),
  stepfun: () => import("./upstream/stepfun-models.js"),
  ark: () => import("./upstream/ark-models.js"),
  opencode: () => import("./upstream/opencode-models.js"),
  openrouter: () => import("./upstream/openrouter-models.js"),
  siliconflow: () => import("./upstream/siliconflow-models.js"),
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

// 展示层用品牌名；订阅/OAuth 等接入方式只属于渠道，不属于模型厂商名称。
const MODEL_VENDOR_NAMES = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  deepseek: "DeepSeek",
  glm: "智谱 GLM",
  qwen: "阿里通义千问",
  kimi: "Moonshot Kimi",
  doubao: "字节豆包",
  minimax: "MiniMax",
  stepfun: "阶跃星辰",
  mimo: "小米 MiMo",
  ark: "火山方舟",
  qoder: "Qoder",
  workbuddy: "WorkBuddy / CodeBuddy",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  siliconflow: "SiliconFlow",
  custom: "自定义渠道",
  other: "其他厂商",
};

export function modelVendorName(type) {
  const key = String(type || "").trim().toLowerCase();
  return MODEL_VENDOR_NAMES[key] || VENDORS.find((v) => v.channelType === key)?.name || key || MODEL_VENDOR_NAMES.other;
}

// 原厂条目可以提供未单独定价的新型号。聚合供应商支持同名模型，不能因此覆盖原厂
// 的展示归属与完整能力信息（例如 OpenCode 的 Luna 曾覆盖 OpenAI 并隐藏思考开关）。
const ORIGINAL_MODEL_VENDORS = new Set([
  "deepseek", "glm", "kimi", "doubao", "qwen", "openai", "anthropic", "gemini", "grok",
  "mimo", "minimax", "stepfun", "ark",
]);
const DEFAULT_MODEL_VENDORS = new Map();
// 官网已发布但尚未核定 OD 单价的新型号，只用于管理目录，不扩大渠道能力。
export const OFFICIAL_UNPRICED_MODELS = [
  { model: "doubao-seed-evolving", type: "ark", source: "https://www.volcengine.com/docs/82379/1544106" },
  { model: "doubao-seed-2-1-lite-260915", type: "ark", source: "https://www.volcengine.com/docs/82379/1544106" },
  { model: "doubao-seed-character-260628", type: "ark", source: "https://www.volcengine.com/docs/82379/1544106" },
  { model: "doubao-seed-translation-250915", type: "ark", source: "https://www.volcengine.com/docs/82379/1544106" },
];
for (const p of DEFAULT_PRICES) {
  const id = String(p.model || "").trim().toLowerCase();
  const type = String(p.type || "").trim().toLowerCase();
  if (id && type && !DEFAULT_MODEL_VENDORS.has(id)) DEFAULT_MODEL_VENDORS.set(id, type);
}

/**
 * 公开模型的展示元信息：小写原始 ID → 平台归属对应的完整条目。
 * 优先默认价表明确登记的厂商，其次原厂模块；同优先级按稳定内容排序，避免加载顺序
 * 决定归属。只生成拷贝，不合并能力、不改渠道支持集合，也不把别名改成另一个 ID。
 * 未出现在公开库的渠道模型不在此表中，由调用方从当前可用渠道取来源。
 */
export function publicModelMetadataMap(publicModels) {
  const selected = new Map();
  for (const m of Array.isArray(publicModels) ? publicModels : []) {
    const id = String(m?.id || "").trim().toLowerCase();
    if (!id) continue;
    const vendor = String(m.vendor || "").trim().toLowerCase();
    const canonical = canonicalModelName(id);
    const preferred = DEFAULT_MODEL_VENDORS.get(canonical) || DEFAULT_MODEL_VENDORS.get(id);
    const rank = preferred && vendor === preferred ? 0 : ORIGINAL_MODEL_VENDORS.has(vendor) ? 1 : 2;
    const stableKey = JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    const previous = selected.get(id);
    if (previous && (previous.rank < rank || (previous.rank === rank && previous.stableKey <= stableKey))) continue;
    selected.set(id, { rank, stableKey, model: { ...m, vendor, vendorName: modelVendorName(vendor) } });
  }
  // 原厂规范条目优先于聚合目录的同模型条目，供渠道别名查元信息时复用。
  for (const [id, entry] of [...selected]) {
    const canonical = canonicalModelName(id);
    if (!canonical || canonical === id) continue;
    const current = selected.get(canonical);
    if (!current || entry.rank < current.rank) selected.set(canonical, entry);
  }
  return new Map([...selected].map(([id, entry]) => [id, entry.model]));
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
  // 此处保留聚合路由 SKU，真实上游仍可能需要它；身份归一走 canonicalModelName。
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
let confirmedAliases = new Map();
const LEGACY_ALIASES = {
  // DeepSeek 官方旧 ID 已停用，适配器兜底把这类名字落到 flash（见 deepseek-models.js）
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
  // 官方定价页明确：旧 V4 Flash ID 仍接受，但已由 V4.1-Flash 服务并按 Flash 计价。
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  // 聚合目录给同一档位加的商品名；只列已确认的名字，不泛化删除 -pro。
  "gpt-6-sol-pro": "gpt-6-sol",
  "gpt-6-luna-pro": "gpt-6-luna",
  "gpt-6-astra-pro": "gpt-6-astra",
  "gpt-5.6-terra-pro": "gpt-5.6-terra",
  // MiniMax 官方 priority 是 service_tier；旧目录曾误当独立模型登记。
  "minimax-m3-priority": "MiniMax-M3",
  // 旧目录用小数点写版本，Anthropic 官方 API/SDK 使用连字符。
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-fable-5.1": "claude-fable-5-1",
  "claude-opus-5.5": "claude-opus-5-5",
  "claude-sonnet-5.5": "claude-sonnet-5-5",
};

/** 去掉聚合供应商前缀、SKU 后缀与能力别名，得到模型身份。 */
export function modelIdentity(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("~")) s = s.slice(1);
  const slash = s.lastIndexOf("/");
  // 动态路由保留供应商命名空间；不能因SKU/能力后缀再次串成裸auto。
  const namespace = slash >= 0 ? s.slice(0, slash) : "";
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/:(free|batch|extended|thinking)$/i, "");
  s = s.replace(/-(search|thinking|agent|agent-swarm)$/i, "");
  if (namespace && /^(auto|default|latest)$/i.test(s)) return `${namespace}/${s}`;
  return s;
}

export async function warmAliasMap() {
  const map = new Map();
  for (const t of Object.keys(VENDOR_MODEL_MODULES)) {
    try {
      const mod = await VENDOR_MODEL_MODULES[t]();
      for (const [alias, target] of Object.entries(mod.ALIASES || {})) {
        const k = modelIdentity(alias).toLowerCase();
        // 网页适配器会把旧档降级/兜底到新档；已独立登记的官方型号不能因此
        // 丧失自己的身份和价格。只有明确的官方旧ID更名由 LEGACY_ALIASES 覆盖。
        if (DEFAULT_MODEL_VENDORS.has(k) && k !== modelIdentity(target).toLowerCase() && !LEGACY_ALIASES[k]) continue;
        if (!map.has(k)) map.set(k, String(target));
      }
    } catch {
      /* 该厂商模型模块不可用时跳过 */
    }
  }
  for (const [alias, target] of Object.entries(LEGACY_ALIASES)) map.set(modelIdentity(alias).toLowerCase(), target);
  const [approved] = await pool.query("SELECT alias,model FROM model_attributions").catch((e) => {
    if (e.code === "ER_NO_SUCH_TABLE") return [[]];
    throw e;
  });
  confirmedAliases = new Map(approved.map(r => [String(r.alias).toLowerCase(), String(r.model).toLowerCase()]));
  aliasCache = map;
  return map;
}

/** 同步解析兼容别名 → 真实模型（结果不带能力后缀）；未命中/未预热时原样返回 */
export function resolveAliasSync(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return raw;
  const base = modelIdentity(raw).toLowerCase();
  const approved = confirmedAliases.get(raw.toLowerCase()) || confirmedAliases.get(base);
  if (approved) return approved;
  return aliasCache?.get(base) || LEGACY_ALIASES[base] || raw;
}

/**
 * 权限判定用的**规范模型名**：解析兼容别名 + 去掉能力后缀，统一小写。
 *
 * 为什么权限判定必须用它，而不是直接拿请求里的字符串比：
 * 路由层在匹配渠道前会先做 `modelForChannelMatch()`（把 `-thinking`/`-search`
 * 这类能力后缀去掉）。如果白名单/密钥限制拿**原始名**做前缀匹配，
 * 就会出现「明明限制了 deepseek-v4.1-flash，却放行了 deepseek-v4.1-flash-thinking」
 * 这种不一致 —— 黑盒测试实测到这条（分组只勾了 2 个模型，`...-thinking`
 * 能调通并正常计费，而 `/v1/models` 里根本没有这个名字）。
 *
 * 归一化之后两边都在同一坐标系里比，语义变成：
 *   · `deepseek-v4.1-flash-thinking` → 规范名 `deepseek-flash`
 *     → 命中白名单（正确：它就是那个被允许的模型，只是开了思考）；
 *   · `deepseek-v4.1-flash-super`（上游将来新增的**另一个**模型）
 *     → 规范名原样保留，**不再**被 `deepseek-v4.1-flash` 的前缀蒙混放行。
 */
export function canonicalModelName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const resolved = modelForChannelMatch(resolveAliasSync(raw));
  return String(modelIdentity(resolved) || "").toLowerCase();
}

/**
 * 白名单匹配（分组模型限制 / 密钥模型限制共用一套判定）。
 *
 * 支持的写法（与分组管理页的说明一致）：
 *   · 空列表      → 不限制，全部放行
 *   · `*`         → 全部放行
 *   · `deepseek-*`→ 前缀通配（管理员显式写的，是**有意**的宽松）
 *   · 其他        → **精确**匹配规范名（不再隐式前缀匹配）
 *
 * 关键点：通配只能由管理员**显式**写出来。旧实现是 `model.startsWith(白名单项)`，
 * 意味着白名单里写 `deepseek-v4.1-flash` 就等于免费附送 `deepseek-v4.1-flash-*`
 * 整个前缀空间 —— 上游哪天新增一个更贵的同名前缀模型，会被静默授权。
 */
export function modelInAllowList(patterns, requested) {
  const list = (Array.isArray(patterns) ? patterns : []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!list.length) return true;
  const m = canonicalModelName(requested);
  if (!m) return false;
  return list.some((p) => {
    const raw = p.toLowerCase();
    if (raw === "*") return true;
    if (raw.endsWith("*")) return m.startsWith(raw.slice(0, -1));
    // 白名单项本身也走归一化：写 `deepseek-chat` 等同于写它实际落到的 `deepseek-flash`
    return (canonicalModelName(p) || raw) === m;
  });
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
let typeModelsCache = { at: 0, map: null };
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
  // 按厂商的「可服务模型集合」：vendorModelSet（渠道 models 留空的判定）用它。
  // 与名字登记表分开维护 —— 别名条目不再是独立模型（不进名字表），但它的
  // **规范名仍属于该厂商**（workbuddy 托管 deepseek 档 aliasOf 官方 deepseek-flash，
  //  该厂商空白声明的渠道必须继续能服务这个模型）。
  const byType = new Map();
  const addTyped = (t, id) => {
    const tt = String(t || "");
    const k = String(id || "").toLowerCase().trim();
    if (!tt || !k) return;
    if (!byType.has(tt)) byType.set(tt, new Set());
    byType.get(tt).add(k);
    byType.get(tt).add(canonicalModelName(k));
  };
  const put = (id, type) => {
    const k = String(id || "").toLowerCase().trim();
    if (!k || map.has(k)) return;
    const identity = canonicalModelName(k);
    const owner = DEFAULT_MODEL_VENDORS.get(identity) || String(type || "");
    const entry = { model: identity || String(id).trim(), type: owner };
    map.set(k, entry);
    if (identity && !map.has(identity)) map.set(identity, entry);
  };

  for (const p of DEFAULT_PRICES) {
    put(p.model, p.type);
    addTyped(p.type, p.model);
  }
  for (const p of OFFICIAL_UNPRICED_MODELS) put(p.model, p.type);
  for (const t of Object.keys(VENDOR_MODEL_MODULES)) {
    try {
      const mod = await VENDOR_MODEL_MODULES[t]();
      // 只登记真实模型：兼容别名（deprecated/aliasOf）可以继续被调用，
      // 但不作为独立模型出现在定价表/导入白名单里（否则历史别名会一直被当成"合法垃圾"）。
      if (typeof mod.publicModels === "function") {
        for (const m of mod.publicModels()) {
          if (m.deprecated || m.aliasOf) {
            // 别名条目：把它的**规范名**记到该厂商名下（上面的 put 不含它）
            if (m.aliasOf) addTyped(t, m.aliasOf);
            continue;
          }
          put(m.id, t);
          addTyped(t, m.id);
        }
      }
    } catch {
      /* 模块不可用时跳过 */
    }
  }
  try {
    const [rows] = await pool.query("SELECT type, models FROM channels");
    for (const r of rows) {
      for (const m of splitModelList(r.models)) {
        put(m, r.type);
        addTyped(r.type, m);
      }
    }
  } catch {
    /* 表不存在/查询失败时不影响前两类 */
  }

  registryCache = { at: Date.now(), map };
  typeModelsCache = { at: Date.now(), map: byType };
  return map;
}

export function invalidateModelRegistry() {
  // stale-while-revalidate：**保留旧 map**，只标记过期并异步重建。
  // 为什么不能直接置 null：调度层用同步快照（modelRegistrySync）判断「该模型是否属于该厂商」，
  // 置 null 会让所有 models 留空的渠道在重建完成前（约 200ms+）被误判为不可用 ——
  // 而渠道/定价的每次写操作都会触发失效，等于把「管理员点一下保存」变成「短暂全站 503」。
  registryCache.at = 0;
  typeModelsCache.at = 0;
  scheduleRegistryWarmup();
}

/**
 * 同步读取「某厂商的可服务模型集合」（含其别名条目的规范名）。
 * 供 router.js#vendorModelSet 判定「models 留空的渠道支持哪些模型」；
 * 未预热时返回 null（调用方按「厂商表未就绪」保守处理）。
 */
export function vendorModelsSync(type) {
  const t = String(type || "").toLowerCase();
  if (!t || !typeModelsCache.map) return null;
  return typeModelsCache.map.get(t) || null;
}

let registryWarmupTimer = null;
function scheduleRegistryWarmup() {
  if (registryWarmupTimer) return;
  registryWarmupTimer = setTimeout(() => {
    registryWarmupTimer = null;
    modelRegistry().catch(() => {});
  }, 200);
  registryWarmupTimer.unref?.();
}

/**
 * 同步读取登记表（未预热时返回 null）。
 * 用途：调度路径（selectChannels → channelSupportsModel）判断「该模型是否属于该厂商」，
 * 不能在那里 await 加载模块（会给每个请求加上模块加载延迟）。
 */
export function modelRegistrySync() {
  return registryCache.map || null;
}
