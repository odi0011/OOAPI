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
//   · 只收录真实存在的模型 ID（以官方文档为准），且与各厂商模型注册表
//     （services/upstream/*-models.js）严格一一对应。能力（思考/联网/看图）是请求参数，
//     不是模型，禁止再造 deepseek-vision 之类的"能力模型"；
//   · 官方只公布人民币价的（GLM/千问/豆包），按固定汇率折算 USD 并写明折算口径；
//     官方直接给美元价的（DeepSeek/Kimi/OpenAI/Anthropic/Google）直接使用；
//   · 本表只用于「缺该模型时插入」，绝不覆盖管理员改过的价格。
// 来源（2026-09 复核）：
//   · DeepSeek https://api-docs.deepseek.com/quick_start/pricing/（美元，高峰价）
//   · 智谱 https://open.bigmodel.cn/pricing（人民币）
//   · Kimi https://platform.kimi.com/docs/pricing/chat（美元）
//   · 阿里云百炼 https://help.aliyun.com/zh/model-studio/（人民币）
//   · 火山方舟 https://ai.volcengine.com/model（人民币）
//   · OpenAI https://openai.com/api/pricing/ · Anthropic https://www.anthropic.com/pricing
//   · Google https://ai.google.dev/gemini-api/docs/pricing
const CNY_PER_USD = 7.2; // 官方人民币价折算美元用（平台币制固定 1 OD = 1 USD）
export const DEFAULT_PRICES = [
  // --- DeepSeek：官方当前只有这两个模型（网页反代输出的也是 flash）---
  // 官方按钟点差异定价（2026-09 官方定价页脚注原文：Off-peak rates are half of the peak rates.
  // Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday），
  // 即北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，其余时段（含整个周末）半价。
  // 注意：阿里百炼 / 火山方舟上托管的 DeepSeek 窗口不同（百炼是每天 22:00-08:00 闲时），
  // 若接的是那两家的通道，需要在该渠道对应的模型价格里单独改 offpeak_rule。
  {
    model: "deepseek-flash",
    input: 0.30,
    output: 1.20,
    cache: 0.006,
    offpeakInput: 0.15,
    offpeakOutput: 0.60,
    offpeakCache: 0.003,
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]] },
    type: "deepseek",
    remark: "官方峰谷价（高峰=北京时间工作日 9-12/14-18，其余半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },
  {
    model: "deepseek-v4-pro",
    input: 1.32,
    output: 3.96,
    cache: 0.044,
    offpeakInput: 0.66,
    offpeakOutput: 1.98,
    offpeakCache: 0.022,
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]] },
    type: "deepseek",
    remark: "官方峰谷价（高峰=北京时间工作日 9-12/14-18，其余半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },

  // --- 智谱 GLM（官方人民币价 ÷ 7.2；来源 open.bigmodel.cn/pricing）---
  { model: "glm-5.3", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `官方 ¥8/¥28/缓存 ¥2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5.3-flash", input: 0.111, output: 0.389, cache: 0.032, type: "glm", remark: `官方 ¥0.8/¥2.8/缓存 ¥0.23 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5.2", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `官方 ¥8/¥28/缓存 ¥2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5v-turbo", input: 0.694, output: 3.056, cache: 0.167, type: "glm", remark: `官方 ≤32K 档 ¥5/¥22/缓存 ¥1.2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.7", input: 0.278, output: 1.111, cache: 0.056, type: "glm", remark: `官方 ¥2/¥8/缓存 ¥0.4 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.5", input: 0.111, output: 0.278, cache: 0, type: "glm", remark: `官方 ¥0.8/¥2（官方公告即将下线）÷ ${CNY_PER_USD}；来源 docs.bigmodel.cn` },
  { model: "glm-4.5-air", input: 0.111, output: 0.278, cache: 0.022, type: "glm", remark: `官方 ¥0.8/¥2/缓存 ¥0.16 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },

  // --- Kimi（官方美元价；来源 platform.kimi.com/docs/pricing/chat）---
  { model: "kimi-k3", input: 3.00, output: 15.00, cache: 0.30, type: "kimi", remark: "官方定价，1M 上下文；来源 platform.kimi.com/docs/pricing/chat-k3" },
  { model: "kimi-k2.6", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "官方定价；来源 platform.kimi.com/docs/pricing/chat" },
  // kimi-k2 是仍在注册表里的经典档（网页反代 SCENARIO_K2 会用到）。
  // 缺这一行会让它落到「同厂商最高档兜底」= 按 k3 旗舰价（3.00/15.00）计费，
  // 相对 k2.6 档最多多收约 3 倍。
  { model: "kimi-k2", input: 0.55, output: 2.20, cache: 0.10, type: "kimi", remark: "经典档，按上一代官方价录入（待官方页复核）；来源 platform.kimi.com/docs/pricing/chat" },

  // --- 通义千问（官方人民币价 ÷ 7.2；来源 help.aliyun.com/zh/model-studio）---
  { model: "qwen3.8-max", input: 1.667, output: 5.000, cache: 0.208, type: "qwen", remark: `官方 ¥12/¥36/缓存 ¥1.5 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio/qwen3-8-max` },
  { model: "qwen3.7-plus", input: 0.278, output: 1.111, cache: 0.044, type: "qwen", remark: `官方 ¥2/¥8/缓存 ¥0.32 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen3-max", input: 0.347, output: 1.389, cache: 0, type: "qwen", remark: `官方 ¥2.5/¥10（未公布缓存档）÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-plus", input: 0.111, output: 0.278, cache: 0, type: "qwen", remark: `官方 ¥0.8/¥2（≤128K 档）÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },

  // --- 豆包（本平台 doubao-pro/lite 为通用档位，价格对应官方 Seed 2.0 Pro/Lite ≤32K 档）---
  { model: "doubao-pro", input: 0.444, output: 2.222, cache: 0.089, type: "doubao", remark: `对应官方 Seed-2.0-Pro ≤32K：¥3.2/¥16/缓存 ¥0.64 ÷ ${CNY_PER_USD}；来源 ai.volcengine.com/model` },
  { model: "doubao-lite", input: 0.083, output: 0.500, cache: 0.017, type: "doubao", remark: `对应官方 Seed-2.0-Lite ≤32K：¥0.6/¥3.6/缓存 ¥0.12 ÷ ${CNY_PER_USD}；来源 ai.volcengine.com/model` },

  // --- OpenAI（美元牌价；官方页对爬虫 403，录入后需人工复核）---
  { model: "gpt-4o", input: 2.50, output: 10.00, cache: 1.25, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-4o-mini", input: 0.15, output: 0.60, cache: 0.075, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-mini", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-nano", input: 0.05, output: 0.40, cache: 0.005, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o3", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o4-mini", input: 1.10, output: 4.40, cache: 0.275, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  // 订阅/网页版反代产出的型号：按 OpenAI 同档次官方价录入（订阅渠道按 token 折算成本，
  // 平台侧不区分「订阅额度已付」与「按量付费」，统一用官方牌价口径）。
  // 缺少这些行会让 gpt-5.6-* 落到兜底档（比官方价低 3~8 倍 = 系统性少计费）。
  { model: "gpt-5.6-sol", input: 1.75, output: 14.00, cache: 0.175, type: "openai", remark: "对标 gpt-5.x 旗舰档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.6-terra", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "对标 gpt-5.x 主力档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.6-luna", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "对标 gpt-5.x mini 档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "对标 gpt-5 官方价；来源 openai.com/api/pricing/" },
  { model: "codex-auto-review", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "代码审查档，对标 gpt-5-mini 官方价；来源 openai.com/api/pricing/" },

  // --- Anthropic（美元牌价）--- 渠道类型统一用 anthropic（与 channel-types 的接入方式一致，
  // 之前写 "claude" 会和模型登记表/定价导入校验打架）
  { model: "claude-opus-5", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-sonnet-5", input: 2.00, output: 10.00, cache: 0.20, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-haiku-4.5", input: 1.00, output: 5.00, cache: 0.10, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },

  // --- Google（美元牌价）---
  { model: "gemini-3.5-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.00, cache: 0.125, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },

  // --- xAI Grok（美元牌价，取自 docs.x.ai 页面内嵌的 __XAI_PUBLIC_MODELS__ 官方价表；
  //     价格为「每百万 token」，页面单位是 1e-4 美元）---
  { model: "grok-4.6", input: 2.00, output: 6.00, cache: 0.50, type: "grok", remark: "官方价表（长上下文档 $2.2/$6.6）；来源 docs.x.ai/docs/models" },
  { model: "grok-4.5", input: 2.00, output: 6.00, cache: 0.30, type: "grok", remark: "官方价表；来源 docs.x.ai/docs/models" },
  { model: "grok-4.3", input: 1.25, output: 2.50, cache: 0.20, type: "grok", remark: "官方价表；来源 docs.x.ai/docs/models" },
  { model: "grok-3-mini", input: 0.30, output: 0.50, cache: 0.03, type: "grok", remark: "轻量档，按官方 4.3 档一半估录入，待官方页复核；来源 docs.x.ai/docs/models" },
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
      // 闲时价：NULL 表示不启用分时（与改造前行为一致）
      offpeakInput: r.offpeak_input_price === null ? null : Number(r.offpeak_input_price),
      offpeakOutput: r.offpeak_output_price === null ? null : Number(r.offpeak_output_price),
      offpeakCache: r.offpeak_cache_price === null ? null : Number(r.offpeak_cache_price),
      offpeakRule: r.offpeak_rule || "",
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

// ---------------------------------------------------------------------------
// 分时（峰谷）定价
// ---------------------------------------------------------------------------
// 背景：多数厂商按时段统一定价，但 DeepSeek 官方按钟点差异定价
// （高峰=北京时间周一至周五 9:00-12:00、14:00-18:00，其余时段半价；
// 阿里百炼托管的 DeepSeek 窗口不同，是每天 22:00-08:00 为闲时）。
// 因此规则必须可配，不能写死窗口。
//
// 为什么用固定 UTC 偏移而不是 Intl/timeZone：
//   中国无夏令时，偏移运算不依赖 ICU，跨平台（不同 Node 构建）行为完全一致。
// 规则 JSON：{ "offset": 8, "days": [1,2,3,4,5], "peak": [["09:00","12:00"],["14:00","18:00"]] }
//   offset = 相对 UTC 的小时偏移（8 = 北京时间）
//   days   = 视作「工作日」的星期（1=周一 … 7=周日）；不在其中 = 全天闲时
//   peak   = 高峰窗口；窗口之外均为闲时（与官方「其余为空闲时段」表述一致）
// 跨零点窗口（如 22:00-08:00）也支持：起 > 止时按「跨天」处理。

function parseRule(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":");
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh)) return null;
  return hh * 60 + (Number.isFinite(mm) ? mm : 0);
}

/** 给定时刻是否处于高峰时段（规则缺失时一律视为高峰 = 用基准价，保持向后兼容） */
export function isPeakAt(rule, atMs) {
  const r = parseRule(rule);
  if (!r || !Array.isArray(r.peak) || !r.peak.length) return true;
  const offset = Number(r.offset) || 0;
  // 先偏移到规则所在时区，再用 UTC 取值：避免依赖进程时区设置
  const d = new Date(Number(atMs) + offset * 3600_000);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (Array.isArray(r.days) && r.days.length && !r.days.includes(day)) return false;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return r.peak.some(([a, b]) => {
    const s = toMinutes(a);
    const e = toMinutes(b);
    if (s === null || e === null) return false;
    // 起 > 止 = 跨零点（如 22:00-08:00）
    return s <= e ? min >= s && min < e : min >= s || min < e;
  });
}

/**
 * 取「该时刻生效的单价」。
 * 必须返回**新对象**：getPrice 返回的是 30s 缓存里的同一个引用，
 * 就地改 input/output 会污染同缓存周期内的所有请求。
 * @returns {{price: object, phase: "peak"|"offpeak"|"flat"}}
 */
export function effectivePrice(price, atMs = Date.now()) {
  const hasOff = price?.offpeakInput != null || price?.offpeakOutput != null || price?.offpeakCache != null;
  // 没配闲时价 → 全时段按基准价（flat），与改造前逐厘一致
  if (!hasOff) return { price, phase: "flat" };
  if (isPeakAt(price.offpeakRule, atMs)) return { price, phase: "peak" };
  return {
    phase: "offpeak",
    price: {
      ...price,
      input: price.offpeakInput ?? price.input,
      output: price.offpeakOutput ?? price.output,
      cache: price.offpeakCache ?? price.cache,
    },
  };
}

/** 给人看的规则摘要（管理端展示；识别不出规则时返回空串） */
export function describeRule(rule) {
  const r = parseRule(rule);
  if (!r || !Array.isArray(r.peak) || !r.peak.length) return "";
  const offset = Number(r.offset) || 0;
  const tz = offset === 8 ? "北京" : offset === 0 ? "UTC" : `UTC${offset >= 0 ? "+" : ""}${offset}`;
  const days = Array.isArray(r.days) && r.days.length ? (r.days.length === 7 ? "每天" : `周${r.days.join("/")}`) : "每天";
  const wins = r.peak.map(([a, b]) => `${a}-${b}`).join("、");
  return `${tz}时间 ${days} ${wins} 为高峰，其余半价`;
}

// 取模型价格：精确匹配 → 最长前缀匹配 → 同厂商兜底 → 全局兜底
const warnedModels = new Set();
const MAX_WARNED_MODELS = 500;
export async function getPrice(model) {
  const prices = await loadPrices();
  const m = String(model || "").toLowerCase();
  if (prices.has(m)) return prices.get(m);
  // 模糊匹配：deepseek-chat-search → deepseek-chat。
  // 必须取「命中长度最长」的前缀，不能取 Map 里第一个命中的：
  // 短前缀可能贵 10 倍（如 glm-5.3-flash-search 先命中 glm-5.3 而不是 glm-5.3-flash）。
  let best = null;
  let bestLen = -1;
  for (const [k, v] of prices) {
    if (k.length > bestLen && m.startsWith(k)) {
      best = v;
      bestLen = k.length;
    }
  }
  if (best) return best;
  // 同族匹配：请求名是某个已配价模型名的前缀（kimi-k2 → kimi-k2.6、deepseek-v4 → deepseek-v4-pro）。
  // 取「最短的那个」（最贴近的族），比直接跳到「同厂商最贵档」准确得多 ——
  // 按最贵档兜底会让上一代/中端模型被按旗舰价收（kimi-k2 落到 kimi-k3 就是 3 倍）。
  let family = null;
  let familyLen = Infinity;
  for (const [k, v] of prices) {
    if (k.length < m.length) continue; // 只考虑比请求名更长的
    if (k.startsWith(m) && k.length < familyLen) {
      family = v;
      familyLen = k.length;
    }
  }
  if (family) return { ...family, model, remark: `${family.model} 同族兜底（原模型未单独定价）` };
  // 兜底不能一律按 DeepSeek 价：反代/订阅渠道产出的模型（gpt-5.6-*、grok-* 等）单价是
  // DeepSeek flash 的 3~10 倍，一律按它算等于系统性少计费。这里再退一步按「同厂商最贵档」
  // （宁可高估不可漏收），真的连厂商都判定不出来才退回 DeepSeek 档。
  const vendor = await vendorOfModel(model);
  const vendorPrice = vendor ? priciestOfVendor(prices, vendor) : null;
  // 告警集合设上限：渠道声明 models="*" 时，调用方可用任意模型名无限撑大内存。
  if (m && !warnedModels.has(m) && warnedModels.size < MAX_WARNED_MODELS) {
    warnedModels.add(m);
    console.warn(
      `[pricing] 模型「${model}」未配置价格，暂按${vendor ? `同厂商（${vendor}）最高档` : "默认档（DeepSeek 价）"}计费，请在「模型定价」中补充`
    );
  }
  if (vendorPrice) {
    return { ...vendorPrice, model, remark: `未配置价格，按同厂商（${vendor}）最高档兜底` };
  }
  return { model, input: 0.30, output: 1.20, cache: 0.006, type: "", remark: "未配置价格，按默认档计价" };
}

/** 该模型归属的厂商（渠道类型）——复用模型登记表，避免定价与归属两处口径分裂 */
async function vendorOfModel(model) {
  try {
    const { modelRegistry } = await import("./models.js");
    const reg = await modelRegistry();
    return reg.get(String(model || "").toLowerCase())?.type || "";
  } catch {
    return "";
  }
}

/** 某厂商已登记的最贵档价格（按输出价排序；同价取输入价更高的） */
function priciestOfVendor(prices, vendor) {
  let best = null;
  for (const v of prices.values()) {
    if (String(v.type || "") !== String(vendor)) continue;
    if (!best) {
      best = v;
      continue;
    }
    const out = Number(v.output) || 0;
    const bestOut = Number(best.output) || 0;
    if (out > bestOut || (out === bestOut && (Number(v.input) || 0) > (Number(best.input) || 0))) best = v;
  }
  return best;
}

// 计费：返回「厘」为单位的整数
/**
 * @param {object} p
 * @param {object} p.price            生效单价（已套峰谷）
 * @param {number} p.promptTokens
 * @param {number} p.completionTokens
 * @param {number} p.cacheTokens
 * @param {string} [p.contextBilling] 账号级计费口径（渠道 other.context_billing）：
 *   auto/full  = 输入+输出 都计（默认）
 *   input_only = 只计输入（上游按上下文长度计费、不按生成量计费的账号；
 *                **会改变用户实际扣费**，仅在该账号确实如此计费时才设）
 */
export function computeCost({ price, promptTokens = 0, completionTokens = 0, cacheTokens = 0, contextBilling = "auto" }) {
  // 缓存命中不能超过输入总量（上游字段异常时按输出去重，避免负基数）
  const cache = Math.max(0, Math.min(Number(cacheTokens) || 0, Number(promptTokens) || 0));
  const base = Math.max(0, (Number(promptTokens) || 0) - cache);
  // 未配置缓存价（NULL/0）时回退输入价：直接按 0 计费等于对缓存命中部分免单
  const cachePrice = Number(price.cache) > 0 ? Number(price.cache) : Number(price.input) || 0;
  const outTokens = contextBilling === "input_only" ? 0 : Number(completionTokens) || 0;
  const od =
    (base / 1e6) * price.input +
    (outTokens / 1e6) * price.output +
    (cache / 1e6) * cachePrice;
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

// 扣费：用户额度 + 令牌额度 + 计数。（历史函数已删除：路由统一用各自的原子扣费逻辑）

/**
 * 写入内置默认价格（仅在 model_prices 缺该模型时插入，绝不覆盖管理员改过的价格）。
 * 全新安装由启动流程调用，避免所有模型都落到「未配置价格」兜底档导致漏计费。
 */
export async function seedDefaultPrices() {
  const ts = now();
  let added = 0;
  for (const p of DEFAULT_PRICES) {
    const [ret] = await pool.query(
      `INSERT INTO model_prices
         (model, input_price, output_price, cache_price,
          offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
          channel_type, remark, updated_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE model = model`,
      [
        p.model,
        p.input,
        p.output,
        p.cache,
        p.offpeakInput ?? null,
        p.offpeakOutput ?? null,
        p.offpeakCache ?? null,
        p.offpeakRule ? JSON.stringify(p.offpeakRule) : null,
        p.type,
        p.remark,
        ts,
      ]
    );
    if (ret.affectedRows === 1) added += 1;
  }
  if (added) {
    invalidatePrices();
    console.log(`[init] 已写入默认模型价格 ${added} 条（可在「模型定价」中调整）`);
  }
}
