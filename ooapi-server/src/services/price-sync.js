// 上游价目同步 —— 「同步官方价目」按钮的数据源
// ===========================================================================
// 用户反馈（原话）：
//   「模型定价页面里点击同步官方价目没用啊？比如 anthropic 今天出了新模型也没同步到啊？」
//
// 原因很直接：原来的「同步官方价目」只做了一件事 —— 把我们**硬编码在 pricing.js 里的
// DEFAULT_PRICES 数组**写回数据库。那是一张人肉维护的静态表，Anthropic 今天发新模型，
// 它当然不会自己长出来。等于按一下按钮只把旧数据重写一遍，看起来当然「没用」。
//
// 改成真正从上游取价：OpenRouter 的 /api/v1/models 是**公开只读**的模型目录接口
// （454 个模型，实测与我们渠道里 Cline 那份目录完全同源），每条都带真实价格：
//   pricing.prompt / pricing.completion           → 输入 / 输出（USD per token）
//   pricing.input_cache_read                      → 缓存读
// 转成平台口径就是 × 1e6（USD/百万 token，1 OD = 1 USD 直接落库）。
//
// 为什么用 OpenRouter 而不是逐个厂商官网：
//   · 厂商官网没有统一接口（多数是 HTML 价目页，抓取脆弱且会被改版打断）；
//   · OpenRouter 的目录**已经包含**这些厂商的模型，且是机器可读的稳定 JSON；
//   · 实测覆盖：anthropic 28 / openai 99 / google 41 / qwen 53 / deepseek 16 /
//     x-ai 8 / moonshotai 8 / z-ai 18 / minimax 8 …（我们接入的厂商全在）。
//   · 它带 `:batch` / `:free` 等变体，与 Cline 返回的 id 完全对得上 ——
//     这正是「Cline 的模型价格对不上」要解决的那件事。
//
// 边界（必须说清，否则管理员会误以为它是万能的）：
//   · 它给的是 OpenRouter 的挂牌价，通常等于厂商官方价，但不保证永远同步
//     （中转站可能加价）。所以落库时把来源写进 remark，管理员能看到这是哪来的价；
//   · 库里**已有的行默认不覆盖** —— 管理员手工调过的价不能被一次同步抹掉。
//     要强制覆盖得显式传 `overwrite: true`（前端用「覆盖已有价」开关表达）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { invalidatePrices, loadPrices } from "./pricing.js";

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
  if (!Number.isFinite(n) || n < 0) return 0;
  return Number((n * 1e6).toFixed(6));
}

/**
 * 拉取上游价目表并规范化。
 * @returns {Promise<Array<{model:string,input:number,output:number,cache:number,type:string,name:string,isFree:boolean}>>}
 */
export async function fetchUpstreamPriceList() {
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
  const out = [];
  for (const m of list) {
    const id = String(m.id || "").trim();
    if (!id) continue;
    const p = m.pricing || {};
    const input = toPerMillion(p.prompt);
    const output = toPerMillion(p.completion);
    const cache = toPerMillion(p.input_cache_read);
    const prefix = id.startsWith("~") ? id.slice(1) : id;
    const slash = prefix.indexOf("/");
    const vendor = slash > 0 ? prefix.slice(0, slash).toLowerCase() : "";
    out.push({
      model: id,
      input,
      output,
      cache,
      type: VENDOR_TO_TYPE[vendor] || vendor || "",
      name: String(m.name || id),
      // 上游标的「免费」模型（:free 后缀，价格本来就是 0）：这不是「漏配价」，
      // 而是上游真的按 0 计费，所以允许它落 0（与「不能猜 0」是两回事）。
      isFree: /:free$/i.test(id) || (input === 0 && output === 0),
    });
  }
  return out;
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
  const upstream = await fetchUpstreamPriceList();
  const filter = Array.isArray(only) && only.length ? new Set(only.map((s) => String(s).trim())) : null;
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
    for (const p of upstream) {
      if (filter && !filter.has(p.model)) continue;
      const exists = have.has(p.model);
      if (exists && !overwrite) {
        skipped += 1;
        continue;
      }
      const remark = `上游价目同步（OpenRouter 挂牌价，USD/百万 token）；上游模型名 ${p.name}`.slice(0, 250);
      if (exists) {
        await conn.query(
          `UPDATE model_prices SET input_price=?, output_price=?, cache_price=?, channel_type=?, remark=?, updated_time=?
           WHERE model=?`,
          [p.input, p.output, p.cache, p.type, remark, ts, p.model]
        );
        updated += 1;
      } else {
        await conn.query(
          `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time)
           VALUES (?,?,?,?,?,?,?)`,
          [p.model, p.input, p.output, p.cache, p.type, remark, ts]
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
  return { fetched: upstream.length, inserted, updated, skipped, samples };
}

/**
 * 找出「渠道声明了、但平台还没定价」的模型 —— 前端用它提示「有 N 个模型缺价」。
 * 与 pricing.pendingPricedModels 的区别：这里只回答「上游价目表里有没有」，用于同步前的预检。
 */
export async function missingFromUpstream() {
  const [rows] = await pool.query(
    "SELECT models FROM channels WHERE status = 1 AND models IS NOT NULL AND models <> ''"
  );
  const declared = new Set();
  for (const r of rows) {
    for (const raw of String(r.models || "").split(",")) {
      const m = raw.trim();
      if (m && m !== "*") declared.add(m);
    }
  }
  const prices = await loadPrices();
  const upstream = await fetchUpstreamPriceList();
  const upstreamIds = new Set(upstream.map((u) => u.model));
  const missing = [...declared].filter((m) => !prices.has(m.toLowerCase()) && !prices.has(m));
  return {
    declared: declared.size,
    missingInDb: missing,
    // 其中能从上游价目表直接补上的（= 点同步就能解决）
    fixableBySync: missing.filter((m) => upstreamIds.has(m)),
  };
}
