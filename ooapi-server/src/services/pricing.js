// OD 币计价
// ---------------------------------------------------------------------------
// 币制：1 OD 币 = 1 美元（1:1）。额度以「厘」为最小单位存储，
//       1 OD 币 = 10000 厘（即支持 0.0001 OD 币精度）。
// 价格：model_prices 表按模型存「OD 币 / 百万 token」，含缓存命中档，
//       与 new-api 的 model_ratio 思路一致但更直观（直接存价格而非倍率）。
// 公式：
//   cost = (prompt_tokens/1e6 * input_price
//         + completion_tokens/1e6 * output_price
//         + cache_tokens/1e6 * cache_price) * UNITS_PER_OD
//   向上取整，最低 1 厘（避免零计费刷量）。
import { pool } from "../db.js";
import { now } from "../utils.js";

export const UNITS_PER_OD = 10000; // 1 OD 币 = 10000 厘
export const CURRENCY = "OD币";

// 默认价格表（OD 币 / 百万 token，1 OD = $1）
// ---------------------------------------------------------------------------
// 维护规则（重要）：
//   · 每条 remark 必须写清【官方来源】，禁止「同上」「官方定价页」这类无意义描述；
//   · 只收录真实存在的模型 ID（以官方文档为准）。能力（思考/联网/看图）是请求参数，
//     不是模型，禁止再造 deepseek-vision 之类的"能力模型"；
//   · 官方只公布人民币价的（qwen/kimi），按固定汇率折算 USD 并写明折算口径；
//   · 本表只用于「缺该模型时插入」，绝不覆盖管理员改过的价格。
// 来源（2026-09 复核）：
//   · DeepSeek 官方定价页 https://api-docs.deepseek.com/quick_start/pricing/
//       deepseek-flash  高峰 $0.30 输入 / $1.20 输出 / $0.006 缓存命中（闲时减半）
//       deepseek-v4-pro 高峰 $1.32 / $3.96 / $0.044（闲时减半）
//   · OpenAI https://openai.com/api/pricing/（官方页对爬虫 403，价格需人工复核）
//   · Anthropic https://www.anthropic.com/pricing
//   · Google https://ai.google.dev/gemini-api/docs/pricing
//   · 阿里云百炼 https://help.aliyun.com/zh/model-studio/models（人民币价）
//   · Moonshot https://platform.moonshot.cn/docs/pricing（人民币价）
//   · 智谱 https://docs.z.ai/guides/overview/pricing（美元价）
const CNY_PER_USD = 7.2; // 官方人民币价折算美元用（平台币制固定 1 OD = 1 USD）
export const DEFAULT_PRICES = [
  // --- DeepSeek（当前只有这两个真实模型，网页反代输出的也是 flash）---
  {
    model: "deepseek-flash",
    input: 0.30,
    output: 1.20,
    cache: 0.006,
    type: "deepseek",
    remark: "官方高峰价（闲时半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },
  {
    model: "deepseek-v4-pro",
    input: 1.32,
    output: 3.96,
    cache: 0.044,
    type: "deepseek",
    remark: "官方高峰价（闲时半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },
  // --- DeepSeek 旧 ID 兼容别名（2026-07-24 官方停用，自动映射到 flash）---
  {
    model: "deepseek-chat",
    input: 0.30,
    output: 1.20,
    cache: 0.006,
    type: "deepseek",
    remark: "官方已停用的旧 ID，实际由 deepseek-flash 承接；价格随 flash",
  },
  {
    model: "deepseek-reasoner",
    input: 0.30,
    output: 1.20,
    cache: 0.006,
    type: "deepseek",
    remark: "官方已停用的旧 ID，实际由 deepseek-flash + 深度思考承接；价格随 flash",
  },

  // --- OpenAI（价格需对照官方页人工复核）---
  { model: "gpt-4o", input: 2.50, output: 10.00, cache: 1.25, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-4o-mini", input: 0.15, output: 0.60, cache: 0.075, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-mini", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-nano", input: 0.05, output: 0.40, cache: 0.005, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o3", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o4-mini", input: 1.10, output: 4.40, cache: 0.275, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },

  // --- Anthropic ---
  { model: "claude-opus-5", input: 5.00, output: 25.00, cache: 0.50, type: "claude", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-sonnet-5", input: 2.00, output: 10.00, cache: 0.20, type: "claude", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-haiku-4.5", input: 1.00, output: 5.00, cache: 0.10, type: "claude", remark: "官方定价；来源 anthropic.com/pricing" },

  // --- Google ---
  { model: "gemini-3.5-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.00, cache: 0.125, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },

  // --- 阿里通义（官方人民币价 ÷ 7.2 折算）---
  { model: "qwen3-max", input: 0.347, output: 1.389, cache: 0.035, type: "qwen", remark: `官方 ¥2.5/¥10（百万 token）÷ ${CNY_PER_USD} 折算；来源 help.aliyun.com/zh/model-studio/models` },
  { model: "qwen-max", input: 0.333, output: 1.333, cache: 0, type: "qwen", remark: `官方 ¥2.4/¥9.6 ÷ ${CNY_PER_USD} 折算；来源 help.aliyun.com/zh/model-studio/models` },
  { model: "qwen-plus", input: 0.111, output: 0.278, cache: 0, type: "qwen", remark: `官方 ¥0.8/¥2 ÷ ${CNY_PER_USD} 折算；来源 help.aliyun.com/zh/model-studio/models` },
  { model: "qwen-turbo", input: 0.042, output: 0.083, cache: 0, type: "qwen", remark: `官方 ¥0.3/¥0.6 ÷ ${CNY_PER_USD} 折算；来源 help.aliyun.com/zh/model-studio/models` },

  // --- 月之暗面（官方人民币价 ÷ 7.2 折算）---
  { model: "kimi-k3", input: 2.778, output: 13.889, cache: 0.278, type: "custom", remark: `官方 ¥20/¥100 ÷ ${CNY_PER_USD} 折算；来源 platform.moonshot.cn/docs/pricing` },
  { model: "kimi-k2.6", input: 0.903, output: 3.750, cache: 0.153, type: "custom", remark: `官方 ¥6.5/¥27 ÷ ${CNY_PER_USD} 折算；来源 platform.moonshot.cn/docs/pricing` },

  // --- 智谱（官方美元价）---
  { model: "glm-5.3", input: 1.40, output: 4.40, cache: 0.26, type: "custom", remark: "官方定价；来源 docs.z.ai/guides/overview/pricing" },
  { model: "glm-5.3-flash", input: 0.15, output: 0.50, cache: 0.03, type: "custom", remark: "官方定价；来源 docs.z.ai/guides/overview/pricing" },
  { model: "glm-4.7", input: 0.60, output: 2.20, cache: 0.11, type: "custom", remark: "官方定价；来源 docs.z.ai/guides/overview/pricing" },
];

// 价格缓存（避免每请求查库）
let priceCache = new Map();
let priceCacheAt = 0;
const PRICE_TTL_MS = 30_000;

export async function loadPrices() {
  // 注意用时间戳判断而不是 size：空表也是合法结果，否则每次调用都会查库
  if (Date.now() - priceCacheAt < PRICE_TTL_MS) return priceCache;
  const [rows] = await pool.query("SELECT * FROM model_prices");
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.model).toLowerCase(), {
      model: r.model,
      input: Number(r.input_price) || 0,
      output: Number(r.output_price) || 0,
      cache: Number(r.cache_price) || 0,
      type: r.channel_type || "",
      remark: r.remark || "",
    });
  }
  priceCache = m;
  priceCacheAt = Date.now();
  return m;
}

export function invalidatePrices() {
  priceCacheAt = 0;
}

// 取模型价格：精确匹配 → 前缀通配 → 默认
const warnedModels = new Set();
export async function getPrice(model) {
  const prices = await loadPrices();
  const m = String(model || "").toLowerCase();
  if (prices.has(m)) return prices.get(m);
  // 模糊匹配：deepseek-chat-search → deepseek-chat
  for (const [k, v] of prices) {
    if (m.startsWith(k)) return v;
  }
  // 兜底：按 DeepSeek 档位计价，避免漏配导致零计费；同时打告警，让漏配可被发现
  if (m && !warnedModels.has(m)) {
    warnedModels.add(m);
    console.warn(`[pricing] 模型「${model}」未配置价格，暂按默认档（DeepSeek 价）计费，请在「模型定价」中补充`);
  }
  return { model, input: 0.30, output: 1.20, cache: 0.006, type: "", remark: "未配置价格，按默认档计价" };
}

// 计费：返回「厘」为单位的整数
export function computeCost({ price, promptTokens = 0, completionTokens = 0, cacheTokens = 0 }) {
  // 缓存命中不能超过输入总量（上游字段异常时按输出去重，避免负基数）
  const cache = Math.max(0, Math.min(Number(cacheTokens) || 0, Number(promptTokens) || 0));
  const base = Math.max(0, (Number(promptTokens) || 0) - cache);
  const od =
    (base / 1e6) * price.input +
    (completionTokens / 1e6) * price.output +
    (cache / 1e6) * price.cache;
  // 先做微小的浮点校正再向上取整，避免 0.0001 的表示误差多收 1 厘
  const units = od * UNITS_PER_OD;
  return Math.max(1, Math.ceil(Math.round(units * 1e6) / 1e6));
}

/**
 * 归一化上游 usage：
 *   · 对象（OpenAI 兼容渠道返回 {prompt_tokens, completion_tokens, cached_tokens}）
 *   · 数字（反代适配器只给总量）
 *   · null（完全不提供）
 * @returns {{promptTokens:number, completionTokens:number, cacheTokens:number, totalTokens:number, hasDetail:boolean}}
 */
// 单次 usage 上限：正常对话不可能超过 1 亿 token（约 3 亿字符）。
// 上游返回异常值（如 1e15）时不至于把用户额度与日志一次拉爆。
const MAX_USAGE = 1e8;
const clampUsage = (n) => Math.max(0, Math.min(MAX_USAGE, Math.round(Number(n) || 0)));

export function normalizeUsage(u) {
  if (!u) return { promptTokens: 0, completionTokens: 0, cacheTokens: 0, totalTokens: 0, hasDetail: false };
  if (typeof u === "object") {
    const p = clampUsage(u.prompt_tokens ?? u.input_tokens);
    const c = clampUsage(u.completion_tokens ?? u.output_tokens);
    const cache = clampUsage(
      u.cached_tokens ?? u.cache_tokens ?? u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens
    );
    const total = clampUsage(u.total_tokens) || p + c;
    return { promptTokens: p, completionTokens: c, cacheTokens: Math.min(cache, p), totalTokens: total, hasDetail: p + c > 0 };
  }
  const t = clampUsage(u);
  return { promptTokens: 0, completionTokens: 0, cacheTokens: 0, totalTokens: t, hasDetail: false };
}

// token 估算（仅在拿不到上游明细时使用）
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  // 中文约 1.5 字符/token，英文约 4 字符/token，取折中
  return Math.max(1, Math.ceil(s.length / 3));
}

// 拆分计费 token：
//   有上游明细 → 直接精确计费（含缓存命中）
//   只有总量   → 按估算比例拆分
//   什么都没有 → 全按估算
export function splitTokens({ prompt, output, upstreamTotal }) {
  const u = normalizeUsage(upstreamTotal);
  if (u.hasDetail) {
    return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, cacheTokens: u.cacheTokens };
  }
  const estP = estimateTokens(prompt);
  const estC = estimateTokens(output);
  if (u.totalTokens > 0 && estP + estC > 0) {
    const p = Math.max(1, Math.round((u.totalTokens * estP) / (estP + estC)));
    return { promptTokens: p, completionTokens: Math.max(1, u.totalTokens - p), cacheTokens: 0 };
  }
  return { promptTokens: estP, completionTokens: estC, cacheTokens: 0 };
}

// 金额展示（OD 币）
export function unitsToOd(units) {
  return Number(units || 0) / UNITS_PER_OD;
}

export function formatOd(units, digits = 4) {
  return `${unitsToOd(units).toFixed(digits)} ${CURRENCY}`;
}

// 扣费：用户额度 + 令牌额度 + 计数 + 日志
export async function charge({ user, token, units, model, meta = {}, ip = "", requestId = "" }) {
  await pool.query(
    "UPDATE users SET quota = GREATEST(0, quota - ?), used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
    [units, units, user.id]
  );
  if (!token.unlimited_quota) {
    await pool.query("UPDATE tokens SET remain_quota = GREATEST(0, remain_quota - ?) WHERE id = ?", [units, token.id]);
  }
  await pool.query("UPDATE tokens SET used_quota = used_quota + ?, accessed_time = ? WHERE id = ?", [
    units,
    now(),
    token.id,
  ]);
  return units;
}

/**
 * 写入内置默认价格（仅在 model_prices 缺该模型时插入，绝不覆盖管理员改过的价格）。
 * 全新安装由启动流程调用，避免所有模型都落到「未配置价格」兜底档导致漏计费。
 */
export async function seedDefaultPrices() {
  const ts = now();
  let added = 0;
  for (const p of DEFAULT_PRICES) {
    const [ret] = await pool.query(
      `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE model = model`,
      [p.model, p.input, p.output, p.cache, p.type, p.remark, ts]
    );
    if (ret.affectedRows === 1) added += 1;
  }
  if (added) {
    invalidatePrices();
    console.log(`[init] 已写入默认模型价格 ${added} 条（可在「模型定价」中调整）`);
  }
}
