// 聚合目录只用于发现型号；计费同步仅采用已复核的厂商价，避免自动启用推测价格。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { invalidatePrices, loadPrices, DEFAULT_PRICES, consolidateModelPrices, storedPriceTiers } from "./pricing.js";
import { normalizeClineModel } from "./cline-prices.js";

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 25_000;

/** OpenRouter 的 id 前缀 → 我们的渠道类型（用于落 channel_type，前端按厂商筛选） */
const VENDOR_TO_TYPE = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  deepseek: "deepseek",
  qwen: "qwen",
  "x-ai": "grok",
  moonshotai: "kimi",
  "z-ai": "glm",
  minimax: "minimax",
  mistralai: "mistralai",
  "meta-llama": "meta",
  meta: "meta",
  nvidia: "nvidia",
  cohere: "cohere",
  amazon: "amazon",
  perplexity: "perplexity",
  tencent: "hunyuan",
  "bytedance-seed": "ark",
  bytedance: "ark",
  xiaomi: "mimo",
  stepfun: "stepfun",
  baidu: "baidu",
  meituan: "longcat",
  inclusionai: "inclusionai",
};

/** OpenRouter 的价格是「USD per token」字符串 → 我们的「OD/百万 token」数值 */
function toPerMillion(v) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toFixed(6));
}

/**
 * 拉取上游价目表并规范化。
 * @returns {Promise<Array<{model:string,input:number,output:number,cache:number,type:string,name:string,isFree:boolean}>>}
 */
export async function fetchUpstreamPriceList() {
  const { canonicalModelName } = await import("./models.js");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let j;
  try {
    const resp = await fetch(OPENROUTER_MODELS, {
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    j = await resp.json();
  } finally {
    clearTimeout(timer);
  }
  const list = Array.isArray(j?.data) ? j.data : [];
  if (!list.length) throw new Error("上游价目表为空");
  const byModel = new Map();
  for (const m of list) {
    const id = String(m.id || "").trim();
    if (!id) continue;
    const p = m.pricing || {};
    const input = toPerMillion(p.prompt);
    const output = toPerMillion(p.completion);
    const cache = toPerMillion(p.input_cache_read) ?? 0;
    if (input === null || output === null) continue; // 缺报价不是免费模型。
    const prefix = id.startsWith("~") ? id.slice(1) : id;
    const slash = prefix.indexOf("/");
    const vendor = slash > 0 ? prefix.slice(0, slash).toLowerCase() : "";
    const isFree = /:free$/i.test(id) || (input === 0 && output === 0);
    const normalized = canonicalModelName(id) || normalizeClineModel(id);
    const item = {
      model: normalized,
      input,
      output,
      cache,
      type: VENDOR_TO_TYPE[vendor] || vendor || "",
      name: String(m.name || id),
      // 上游标的「免费」模型（:free 后缀，价格本来就是 0）：这不是「漏配价」，
      // 而是上游真的按 0 计费，所以允许它落 0（与「不能猜 0」是两回事）。
      isFree,
      upstreamModel: id,
    };
    // :batch/:free 等变体只保留一条规范模型价；优先保留带实际非零挂牌价的条目，
    // 避免目录顺序恰好先返回 :free 就把原厂正常价覆盖成 0。
    const previous = byModel.get(normalized);
    const rank = (x) => (x.isFree ? 4 : 0) + (/:(free|batch|extended|thinking)$/i.test(x.upstreamModel) ? 2 : 0)
      + (canonicalModelName(x.upstreamModel) !== String(x.upstreamModel).replace(/^~?[^/]+\//, "").toLowerCase() ? 1 : 0);
    if (!previous || rank(item) < rank(previous) || (rank(item) === rank(previous) && id.localeCompare(previous.upstreamModel) < 0)) byModel.set(normalized, item);
  }
  // 只有 SKU、没有正常档报价时不能凭免费/批处理价生成原厂基准价。
  return [...byModel.values()].filter((p) => !/:(free|batch|extended|thinking)$/i.test(p.upstreamModel));
}

/**
 * 同步上游价目到 model_prices。
 *
 * @param {object} opts
 * @param {boolean} opts.overwrite 是否覆盖已存在的行（默认 false：保住管理员手工调过的价）
 * @param {string[]} opts.only     只同步这些模型（默认全部）
 * @returns {Promise<{fetched:number, inserted:number, updated:number, skipped:number, samples:Array}>}
 */
export async function syncUpstreamPrices({ overwrite = false, only = null } = {}) {
  const { canonicalModelName, invalidateModelRegistry } = await import("./models.js");
  await consolidateModelPrices();
  const discovered = await fetchUpstreamPriceList();
  // 已核实的原厂价格优先于聚合挂牌价，同时补入尚未进入聚合目录的新型号。
  const catalog = new Map();
  for (const p of DEFAULT_PRICES) {
    const model = canonicalModelName(p.model);
    if (model !== String(p.model).toLowerCase()) continue;
    catalog.set(model, { ...p, model, isFree: p.input === 0 && p.output === 0, officialRemark: p.remark });
  }
  const filter = Array.isArray(only) && only.length ? new Set(only.map(canonicalModelName)) : null;
  const [existing] = await pool.query("SELECT model FROM model_prices");
  const have = new Set(existing.map((r) => String(r.model)));

  const ts = now();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const samples = [];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of catalog.values()) {
      if (filter && !filter.has(String(p.model).toLowerCase())) continue;
      const existingModel = [...have].find((x) => String(x).toLowerCase() === String(p.model).toLowerCase());
      const exists = Boolean(existingModel);
      if (exists && !overwrite) {
        skipped += 1;
        continue;
      }
      const remark = (p.officialRemark || `聚合目录价（OpenRouter，USD/百万 token）；原路由 ${p.upstreamModel}`).slice(0, 250);
      if (exists) {
        await conn.query(
          `UPDATE model_prices SET input_price=?, output_price=?, cache_price=?, channel_type=?, remark=?, updated_time=?,
           offpeak_input_price=?, offpeak_output_price=?, offpeak_cache_price=?, offpeak_rule=?, price_tiers=?
           WHERE model=?`,
          [p.input, p.output, p.cache ?? 0, p.type, remark, ts, p.offpeakInput ?? null, p.offpeakOutput ?? null, p.offpeakCache ?? null, p.offpeakRule ? JSON.stringify(p.offpeakRule) : null, storedPriceTiers(p), existingModel]
        );
        updated += 1;
      } else {
        await conn.query(
          `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time,
           offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule, price_tiers)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.model, p.input, p.output, p.cache ?? 0, p.type, remark, ts, p.offpeakInput ?? null, p.offpeakOutput ?? null, p.offpeakCache ?? null, p.offpeakRule ? JSON.stringify(p.offpeakRule) : null, storedPriceTiers(p)]
        );
        inserted += 1;
      }
      if (samples.length < 12) {
        samples.push({ model: p.model, input: p.input, output: p.output, type: p.type, isFree: p.isFree });
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  if (inserted || updated) invalidatePrices();
  invalidateModelRegistry();
  return { fetched: catalog.size, discovered: discovered.length, unverified: discovered.filter(p => !catalog.has(p.model)).length, inserted, updated, skipped, samples };
}

/**
 * 找出「渠道声明了、但平台还没定价」的模型 —— 前端用它提示「有 N 个模型缺价」。
 * 与 pricing.pendingPricedModels 的区别：这里只回答「上游价目表里有没有」，用于同步前的预检。
 */
/**
 * 同步前的预检：哪些模型在库里没有确切价格。
 *
 * **判定必须与 routes/pricing.js 的 /attribution 完全一致** —— 两处不一致会给出
 * 互相矛盾的数字（实测踩过：体检面板显示「0 个缺价」，而本函数说「6 个缺价」，
 * 差别在于这里只认「精确命中」，而 attribution 还把「前缀命中」与「归属规则命中」
 * 都算作有价）。管理员看到两个页面报不同的数，只会两个都不信。
 * 所以这里复用同一套三级判定：精确 → 最长前缀 → 归属规则。
 */
export async function missingFromUpstream() {
  const { pendingPricedModels } = await import("./pricing.js");
  const { canonicalModelName } = await import("./models.js");
  const pending = await pendingPricedModels();
  const verified = new Set(DEFAULT_PRICES.map(p => canonicalModelName(p.model)));
  const missing = pending.models.map(p => p.model);
  return { declared: pending.count, missingInDb: missing, fixableBySync: missing.filter(m => verified.has(m)) };
}
