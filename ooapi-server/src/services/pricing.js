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
// 来源：各厂商官方定价页（2026-09 调研）
//   · DeepSeek：官方定价页 2026-09-10 生效版（取高峰价；官方非高峰为半价）
//       deepseek-flash  $0.15 输入 / $0.60 输出 / $0.003 缓存命中（闲时）
//       deepseek-v4-pro $0.66 输入 / $1.98 输出 / $0.022 缓存命中（闲时）
//   · Claude：claude.com/pricing 官方
//   · GLM：docs.z.ai 官方（USD）
//   · Qwen / Kimi：官方 CNY 价 ÷ 7.3
//   · OpenAI / Gemini：官方页 403，采用公开挂牌价，需人工复核
export const DEFAULT_PRICES = [
  // --- DeepSeek 当前真实模型（本平台主渠道，走网页版反代）---
  // 官方高峰价（非高峰减半）；本表取高峰价以保守计费
  { model: "deepseek-flash", input: 0.30, output: 1.20, cache: 0.006, type: "deepseek", remark: "DeepSeek V4.1-Flash 官方高峰价（闲时半价）；原生多模态" },
  { model: "deepseek-v4-pro", input: 1.32, output: 3.96, cache: 0.044, type: "deepseek", remark: "DeepSeek V4-Pro 官方高峰价；不支持看图" },

  // --- 兼容别名（官方已停用旧 id，价格随目标模型）---
  { model: "deepseek-chat", input: 0.30, output: 1.20, cache: 0.006, type: "deepseek", remark: "官方已停用（2026-07-24），自动映射到 deepseek-flash" },
  { model: "deepseek-reasoner", input: 0.30, output: 1.20, cache: 0.006, type: "deepseek", remark: "官方已停用，映射到 deepseek-flash + 深度思考" },

  // --- OpenAI（待官方页复核）---
  { model: "gpt-4o", input: 2.50, output: 10.00, cache: 1.25, type: "openai", remark: "官方页 403，采用挂牌价" },
  { model: "gpt-4o-mini", input: 0.15, output: 0.60, cache: 0.075, type: "openai", remark: "同上" },
  { model: "gpt-5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "同上" },
  { model: "gpt-5-mini", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "同上" },
  { model: "gpt-5-nano", input: 0.05, output: 0.40, cache: 0.005, type: "openai", remark: "同上" },
  { model: "o3", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "同上" },
  { model: "o4-mini", input: 1.10, output: 4.40, cache: 0.275, type: "openai", remark: "同上" },

  // --- Anthropic（官方）---
  { model: "claude-opus-5", input: 5.00, output: 25.00, cache: 0.50, type: "claude", remark: "官方定价页" },
  { model: "claude-sonnet-5", input: 2.00, output: 10.00, cache: 0.20, type: "claude", remark: "官方定价页" },
  { model: "claude-haiku-4.5", input: 1.00, output: 5.00, cache: 0.10, type: "claude", remark: "官方定价页" },

  // --- Google（待官方页复核）---
  { model: "gemini-3.5-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "官方页超时，采用挂牌价" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.00, cache: 0.125, type: "gemini", remark: "同上" },
  { model: "gemini-2.5-flash", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "同上" },

  // --- 阿里通义（官方 CNY ÷ 7.3）---
  { model: "qwen3-max", input: 0.342, output: 1.370, cache: 0.034, type: "qwen", remark: "¥2.5/¥10 按 7.3 换算" },
  { model: "qwen-max", input: 0.329, output: 1.315, cache: 0, type: "qwen", remark: "¥2.4/¥9.6 按 7.3 换算" },
  { model: "qwen-plus", input: 0.110, output: 0.274, cache: 0, type: "qwen", remark: "¥0.8/¥2 按 7.3 换算" },
  { model: "qwen-turbo", input: 0.041, output: 0.082, cache: 0, type: "qwen", remark: "¥0.3/¥0.6 按 7.3 换算" },

  // --- 月之暗面（官方 CNY ÷ 7.3）---
  { model: "kimi-k3", input: 2.740, output: 13.699, cache: 0.274, type: "custom", remark: "¥20/¥100 按 7.3 换算" },
  { model: "kimi-k2.6", input: 0.890, output: 3.699, cache: 0.151, type: "custom", remark: "¥6.5/¥27 按 7.3 换算" },

  // --- 智谱（官方 USD）---
  { model: "glm-5.3", input: 1.40, output: 4.40, cache: 0.26, type: "custom", remark: "官方定价页" },
  { model: "glm-5.3-flash", input: 0.15, output: 0.50, cache: 0.03, type: "custom", remark: "官方定价页" },
  { model: "glm-4.7", input: 0.60, output: 2.20, cache: 0.11, type: "custom", remark: "官方定价页" },
];

// 价格缓存（避免每请求查库）
let priceCache = new Map();
let priceCacheAt = 0;
const PRICE_TTL_MS = 30_000;

export async function loadPrices() {
  if (Date.now() - priceCacheAt < PRICE_TTL_MS && priceCache.size) return priceCache;
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
export async function getPrice(model) {
  const prices = await loadPrices();
  const m = String(model || "").toLowerCase();
  if (prices.has(m)) return prices.get(m);
  // 模糊匹配：deepseek-chat-search → deepseek-chat
  for (const [k, v] of prices) {
    if (m.startsWith(k)) return v;
  }
  // 兜底：按 DeepSeek 档位计价，避免漏配导致零计费
  return { model, input: 0.30, output: 1.20, cache: 0.006, type: "", remark: "未配置价格，按默认档计价" };
}

// 计费：返回「厘」为单位的整数
export function computeCost({ price, promptTokens = 0, completionTokens = 0, cacheTokens = 0 }) {
  const base = promptTokens - cacheTokens > 0 ? promptTokens - cacheTokens : 0;
  const od =
    (base / 1e6) * price.input +
    (completionTokens / 1e6) * price.output +
    (cacheTokens / 1e6) * price.cache;
  return Math.max(1, Math.ceil(od * UNITS_PER_OD));
}

/**
 * 归一化上游 usage：
 *   · 对象（OpenAI 兼容渠道返回 {prompt_tokens, completion_tokens, cached_tokens}）
 *   · 数字（反代适配器只给总量）
 *   · null（完全不提供）
 * @returns {{promptTokens:number, completionTokens:number, cacheTokens:number, totalTokens:number, hasDetail:boolean}}
 */
export function normalizeUsage(u) {
  if (!u) return { promptTokens: 0, completionTokens: 0, cacheTokens: 0, totalTokens: 0, hasDetail: false };
  if (typeof u === "object") {
    const p = Math.max(0, Math.round(Number(u.prompt_tokens ?? u.input_tokens) || 0));
    const c = Math.max(0, Math.round(Number(u.completion_tokens ?? u.output_tokens) || 0));
    const cache = Math.max(
      0,
      Math.round(Number(u.cached_tokens ?? u.cache_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0)
    );
    const total = Math.max(0, Math.round(Number(u.total_tokens) || 0)) || p + c;
    return { promptTokens: p, completionTokens: c, cacheTokens: Math.min(cache, p), totalTokens: total, hasDetail: p + c > 0 };
  }
  const t = Math.max(0, Math.round(Number(u) || 0));
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
