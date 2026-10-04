// 模型定价管理路由（管理员）
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired, optionalAuth } from "../middleware/auth.js";
import { userDataVisibility } from "../services/user-data-visibility.js";
import { sourceVendors } from "../services/model-sources.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { invalidatePrices, loadPrices, getPrice, DEFAULT_PRICES, describeRule, parsePriceTiers, storedPriceTiers, modelPricePreset, validateModelPricing, saveModelPricing } from "../services/pricing.js";
import { pendingPricedModels } from "../services/pricing.js";
import { modelRegistry, invalidateModelRegistry, canonicalModelName, modelIdentity, OFFICIAL_UNPRICED_MODELS } from "../services/models.js";
import { syncUpstreamPrices, missingFromUpstream } from "../services/price-sync.js";
import { modelCapabilities, modelCapabilityPresets, modelCapabilityDocumentation, validateCapabilities, saveModelCapabilities, REASONING_PARAMETERS } from "../services/model-capabilities.js";
import { withConfigPrecondition } from "../services/config-precondition.js";

const router = Router();

// ---------------------------------------------------------------------------
// 公开价格表（只读，给用户端比价用）
// ---------------------------------------------------------------------------
// 人格实测报的（独立开发者，正在给自己项目选网关）：
//   「价格表完全找不到 —— /pricing、/models、/console/pricing、/price 全被弹回首页，
//     /api/pricing 要管理员权限。所以我只能反推实际扣费，
//     无法核对『标价』与『实收』是否一致。对一个会认真比价的用户来说这是硬伤。」
//
// 而后台设置项 `expose_pricing_to_user`（默认 **true**）早就存在、
// 也早在 /api/status 里下发了 —— 只是**没有任何前端页面用它**。
// 这个端点把「展示什么价格」的开关接上：开关关掉就 403（保持管理员可配）。
//
// **必须声明在 router.use(adminRequired) 之前** —— Express 按声明顺序匹配中间件，
// 放在后面会被管理员门禁拦住（与 token.js 里 /reconcile 被 /:id 吞掉是同一类坑）。
router.get(
  "/public",
  optionalAuth,
  asyncHandler(async (req, res) => {
    if (!userDataVisibility(req.user).pricing) {
      return fail(res, "本站未开放价格查询", 403);
    }
    const prices = await loadPrices();
    // 只回**单价**，不回成本、倍率、上游来源这些管理端信息
    const items = [...prices.values()]
      .map((p) => ({
        model: p.model,
        input: p.input, // 每百万 input token 单价（OD币，1 OD = $1）
        output: p.output,
        ...(p.tiers?.length ? { tiers: p.tiers } : {}),
        ...(p.cache ? { cache: p.cache } : {}),
        ...(p.type ? { vendor: p.type } : {}),
      }))
      .sort((a, b) => String(a.model).localeCompare(String(b.model)));
    return ok(res, { items, currency: "OD", note: "单价按每百万 token 计，1 OD币 = 1 美元" });
  })
);

router.use(adminRequired);

router.get("/capabilities", asyncHandler(async (req, res) => {
  const registry = await modelRegistry();
  const prices = await loadPrices(), requested = req.query.model ? canonicalModelName(req.query.model) : "";
  const capabilityItems = await Promise.all([...new Map([...registry.values()].filter(m => !requested || m.model === requested).map(m => [m.model, m])).values()]
    .map(async (m) => {
      const pricing = prices.get(m.model) || await getPrice(m.model);
      return { ...modelCapabilities(m.model), vendor: m.type, documentationUrl: modelCapabilityDocumentation(m.model, m.type), pricing: pricing?.exact === false ? null : pricing };
    }));
  return ok(res, {
    items: capabilityItems,
    reasoningParameters: REASONING_PARAMETERS,
    presets: modelCapabilityPresets().map(p => ({ ...p, pricing: modelPricePreset(p.model) })),
  });
}));
router.put("/capabilities", asyncHandler(async (req, res) => {
  const model = canonicalModelName(req.body?.model), registry = await modelRegistry();
  if (!registry.has(model)) return fail(res, "请先在渠道中登记模型", 400);
  let capabilities, pricing;
  try {
    capabilities = validateCapabilities(req.body?.capabilities);
    if (req.body?.pricing !== undefined) {
      pricing = validateModelPricing(req.body.pricing);
      if (pricing.presetModel && !modelCapabilityPresets().some(p => p.model === pricing.presetModel)) throw new Error("价格预设不可用");
    }
  }
  catch (e) { return fail(res, e.message, 400); }
  const value = await saveModelCapabilities(model, capabilities, pricing ? connection => saveModelPricing(connection, model, registry.get(model).type, pricing) : undefined);
  if (pricing) invalidatePrices();
  await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `更新模型${pricing ? "能力与价格" : "能力"}：${model}` });
  return ok(res, { ...value, pricing: (await loadPrices()).get(model) || null });
}));

// 闲时规则入参校验：只接受 JSON 字符串或对象，且必须是可解析的结构。
// 为什么要在这里校验而不是留给计费时兜底：计费失败的代价是「用户被多扣费」，
// 宁可保存时就拒绝，也不要让一条坏规则进库。
function parseRuleInput(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  let obj = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      throw new Error("闲时规则不是合法 JSON");
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("闲时规则必须是 JSON 对象");
  const peak = obj.peak;
  if (!Array.isArray(peak) || !peak.length) throw new Error("闲时规则缺少 peak 窗口");
  // 时刻必须严格合法（00:00-23:59）：放宽到 \d{1,2}:\d{2} 会让 "99:00" 通过，
  // 而它永远匹配不上任何时刻 → 该模型全天按闲时价（通常半价）计费且界面看不出来。
  const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
  for (const w of peak) {
    if (!Array.isArray(w) || w.length !== 2 || !HHMM.test(String(w[0])) || !HHMM.test(String(w[1]))) {
      throw new Error('peak 窗口格式应为 [["09:00","12:00"]]（00:00-23:59）');
    }
  }
  if (obj.days !== undefined && (!Array.isArray(obj.days) || obj.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) {
    throw new Error("days 应为 1-7 的星期数组（1=周一）");
  }
  const offset = Number(obj.offset || 0);
  if (!Number.isFinite(offset) || offset < -12 || offset > 14) throw new Error("offset 应为 -12 ~ 14 的小时偏移");
  if (obj.offpeakDates !== undefined) {
    const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!Array.isArray(obj.offpeakDates) || obj.offpeakDates.length > 100 || obj.offpeakDates.some((r) => !Array.isArray(r) || r.length !== 2 || !r.every(validDate) || r[0] > r[1])) throw new Error("offpeakDates 应为有效日期范围数组，例如 [[\"2026-10-01\",\"2026-10-07\"]]");
  }
  return JSON.stringify({ offset, days: obj.days || [1, 2, 3, 4, 5], peak, ...(obj.offpeakDates ? { offpeakDates: obj.offpeakDates } : {}) });
}

// 列表
// 待定价模型清单（后台左侧「模型定价」的红色徽标用它）
//
// 放在 "/" 之前：Express 的路由按注册顺序匹配，"/pending" 若不先注册，
// 会被某些通配写法拦住 —— 这里虽然都是字面量路径不冲突，但保持「具体路径在前」
// 是好习惯，免得以后有人加 "/:id" 时被吞掉。
router.get(
  "/pending",
  asyncHandler(async (req, res) => {
    const out = await pendingPricedModels();
    return ok(res, out);
  })
);

router.get("/catalog-pending", asyncHandler(async (req, res) => {
  const prices = await loadPrices();
  return ok(res, OFFICIAL_UNPRICED_MODELS.filter((m) => !prices.has(canonicalModelName(m.model))));
}));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conds = [];
    const args = [];
    if (req.query.keyword) {
      conds.push("(model LIKE ? OR remark LIKE ?)");
      args.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`);
    }
    if (req.query.type) {
      conds.push("channel_type = ?");
      args.push(String(req.query.type));
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT * FROM model_prices ${where} ORDER BY channel_type ASC, input_price ASC, model ASC`,
      args
    );
    return ok(
      res,
      rows.map((r) => ({
        model: r.model,
        input_price: Number(r.input_price),
        output_price: Number(r.output_price),
        cache_price: Number(r.cache_price),
        tiers: parsePriceTiers(r.price_tiers),
        // 闲时价（NULL = 该模型不分时）
        offpeak_input_price: r.offpeak_input_price === null ? null : Number(r.offpeak_input_price),
        offpeak_output_price: r.offpeak_output_price === null ? null : Number(r.offpeak_output_price),
        offpeak_cache_price: r.offpeak_cache_price === null ? null : Number(r.offpeak_cache_price),
        offpeak_rule: r.offpeak_rule || "",
        offpeak_text: describeRule(r.offpeak_rule),
        channel_type: r.channel_type || "",
        remark: r.remark || "",
        updated_time: Number(r.updated_time) || 0,
        // 折算展示：输入/输出各 1M token 的总价
        cost_1m_both: Number((Number(r.input_price) + Number(r.output_price)).toFixed(4))}))
    );
  })
);

// 新增或更新（单条，管理员手动）
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const {
      model, input_price, output_price, cache_price, channel_type, remark,
      offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule} = req.body || {};
    const m = String(model || "").trim();
    if (!m) return fail(res, "缺少模型 ID");
    // 与导入同一套严格口径：只允许平台已注册的模型
    invalidateModelRegistry();
    const registry = await modelRegistry();
    const reg = registry.get(m.toLowerCase());
    if (!reg) return fail(res, `模型「${m}」未在平台注册（请先在渠道中声明该模型）`);
    const num = (v, name) => {
      const n = Number(v);
      if (String(v ?? "").trim() === "") return null;
      if (!Number.isFinite(n)) throw new Error(`${name} 不是有效数字`);
      if (n < 0) throw new Error(`${name} 不能为负数`);
      if (n > MAX_PRICE) throw new Error(`${name} 超出上限（${MAX_PRICE}）`);
      return Number(n.toFixed(6));
    };
    let input; let output; let cache; let offIn; let offOut; let offCache; let ruleText;
    try {
      input = num(input_price, "input");
      output = num(output_price, "output");
      cache = num(cache_price, "cache");
      // 闲时价：显式 0 等同于「未配置」。0 会被 effectivePrice 当成有效的闲时单价，
      // 闲时段（约一周 70% 时间）就变成兜底 1 单位/次，与基准价差上万倍，
      // 而界面上只是把闲时价显示成 0，看不出任何异常。
      const optNum = (v, name) => {
        const n = num(v, name);
        return Number(n) === 0 ? null : n;
      };
      offIn = optNum(offpeak_input_price, "offpeak_input");
      offOut = optNum(offpeak_output_price, "offpeak_output");
      offCache = optNum(offpeak_cache_price, "offpeak_cache");
      ruleText = parseRuleInput(offpeak_rule);
    } catch (e) {
      return fail(res, e.message);
    }
    if (input == null || output == null) return fail(res, "输入/输出价格不能为空");
    const hasOffpeakPrice = offIn !== null || offOut !== null || offCache !== null;
    if (ruleText && !hasOffpeakPrice) return fail(res, "配置了闲时规则但未提供任何闲时价格");
    if (!ruleText && hasOffpeakPrice) {
      return fail(res, "配置了闲时价格但缺少闲时规则，闲时价永远不会生效；请补上规则或清空闲时价");
    }
    try { await withConfigPrecondition(pool, "pricing", String(reg.model).slice(0, 128), req.body?._internal_expected, connection => connection.query(
      `INSERT INTO model_prices
         (model, input_price, output_price, cache_price,
          offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
          channel_type, remark, updated_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
        cache_price=VALUES(cache_price),
        offpeak_input_price=VALUES(offpeak_input_price), offpeak_output_price=VALUES(offpeak_output_price),
        offpeak_cache_price=VALUES(offpeak_cache_price), offpeak_rule=VALUES(offpeak_rule),
        channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time)`,
      [
        String(reg.model).slice(0, 128),
        input,
        output,
        cache ?? 0,
        offIn,
        offOut,
        offCache,
        ruleText,
        String(channel_type || reg.type || "").slice(0, 32),
        String(remark || "").slice(0, 255),
        now(),
      ]
    )); } catch (e) { if (e.code === "CONFIG_CHANGED") return fail(res, e.message, 409); throw e; }
    invalidatePrices();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `保存模型定价「${m}」` });
    return ok(res, null, "定价已保存");
  })
);

router.delete("/attribution", asyncHandler(async (req, res) => {
  const alias = String(req.body?.alias || "").trim().toLowerCase();
  await pool.query("DELETE FROM model_attributions WHERE alias=?", [alias]);
  const { warmAliasMap } = await import("../services/models.js");
  await warmAliasMap(); invalidatePrices(); invalidateModelRegistry();
  return ok(res, { alias });
}));

// 删除
router.delete(
  "/:model",
  asyncHandler(async (req, res) => {
    const m = String(req.params.model || "");
    if (!m) return fail(res, "缺少模型 ID");
    const [ret] = await pool.query("DELETE FROM model_prices WHERE model = ?", [m]);
    if (!ret.affectedRows) return fail(res, "模型不存在", 404);
    invalidatePrices();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `删除模型定价「${m}」` });
    return ok(res, null, "已删除");
  })
);

// ---------------------------------------------------------------------------
// 一键导入（管理员上传文件 → 前端读取文本 → POST 到这里）
// ---------------------------------------------------------------------------
// 严格校验（垃圾数据零容忍）：
//   1. 模型 ID 必须存在于「模型登记表」（内置价目表 ∪ 厂商模型模块 ∪ 现有渠道声明）；
//   2. 渠道类型若填写，必须与登记表推断出的厂商一致；
//   3. 价格必须为有限数字且 0 ≤ 价格 ≤ 100000；
//   4. 同一文件内重复模型以最后一条为准。
// 支持 JSON（数组或 {prices:[]}）与 CSV（含表头，逗号分隔）。
const MAX_PRICE = 100000;

/** 极简 CSV 解析（支持双引号包裹、逗号与换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const HEADER_ALIASES = {
  model: "model", model_id: "model", 模型: "model", 模型id: "model", 模型_id: "model",
  input: "input", input_price: "input", 输入: "input", 输入价: "input",
  output: "output", output_price: "output", 输出: "output", 输出价: "output",
  cache: "cache", cache_price: "cache", cached: "cache", 缓存: "cache", 缓存价: "cache",
  // 分时定价（可选列）：闲时价 + 规则
  offpeak_input: "offpeak_input", offpeak_input_price: "offpeak_input", 闲时输入: "offpeak_input",
  offpeak_output: "offpeak_output", offpeak_output_price: "offpeak_output", 闲时输出: "offpeak_output",
  offpeak_cache: "offpeak_cache", offpeak_cache_price: "offpeak_cache", 闲时缓存: "offpeak_cache",
  offpeak_rule: "offpeak_rule", 闲时规则: "offpeak_rule",
  type: "type", channel_type: "type", 类型: "type",
  remark: "remark", source: "remark", 来源: "remark", 备注: "remark"};

function parseEntries(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("文件内容为空");
  if (text.startsWith("[") || text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("JSON 解析失败，请检查文件格式");
    }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.prices) ? data.prices : null;
    if (!arr) throw new Error("JSON 必须是价格数组，或形如 { \"prices\": [...] }");
    return arr.map((e, i) => ({ line: i + 1, entry: e || {} }));
  }
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV 至少需要表头 + 1 行数据");
  const header = rows[0].map((h) => HEADER_ALIASES[String(h).trim().toLowerCase()] || null);
  if (!header.includes("model")) throw new Error("CSV 表头缺少 model（模型 ID）列");
  return rows.slice(1).map((r, i) => {
    const o = {};
    header.forEach((key, idx) => {
      if (key) o[key] = r[idx];
    });
    return { line: i + 2, entry: o };
  });
}

router.post(
  "/import",
  asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text) return fail(res, "缺少文件内容");

    let parsed;
    try {
      parsed = parseEntries(text);
    } catch (e) {
      return fail(res, e.message);
    }
    if (!parsed.length) return fail(res, "文件里没有任何数据行");
    if (parsed.length > 2000) return fail(res, "单次最多导入 2000 条");

    // 登记表现查（渠道可能刚改过）
    invalidateModelRegistry();
    const registry = await modelRegistry();

    const accepted = new Map(); // modelLower -> row
    const rejected = [];
    for (const { line, entry } of parsed) {
      const model = String(entry.model ?? entry.model_id ?? "").trim();
      if (!model) {
        rejected.push({ line, model: "", reason: "缺少模型 ID" });
        continue;
      }
      const reg = registry.get(model.toLowerCase());
      if (!reg) {
        rejected.push({ line, model, reason: "模型未注册（垃圾数据）：平台内无此模型 ID" });
        continue;
      }
      const type = String(entry.type ?? entry.channel_type ?? "").trim();
      if (type && reg.type && type.toLowerCase() !== reg.type.toLowerCase()) {
        rejected.push({ line, model, reason: `渠道类型不匹配：登记为 ${reg.type}，文件写的是 ${type}` });
        continue;
      }
      const num = (v, name, required) => {
        if (v === undefined || v === null || String(v).trim() === "") {
          if (required) throw new Error(`${name} 不能为空`);
          return 0;
        }
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${name} 不是有效数字`);
        if (n < 0) throw new Error(`${name} 不能为负数`);
        if (n > MAX_PRICE) throw new Error(`${name} 超出上限（${MAX_PRICE}）`);
        return Number(n.toFixed(6));
      };
      // 闲时价与上面的「可空数字」语义不同：空必须落 NULL 而不是 0。
      // 落 0 会被 effectivePrice 当成「配了闲时价 0」，闲时段直接按 0 计费（兜底 1 厘/次），
      // 属于静默少计费；NULL 才是「该模型不分时」的正确表达。
      //
      // 注意：显式写 0 也必须当「未配置」处理。CSV/Excel 导出里把闲时列留成 0 很常见
      // （而不是留空），若原样入库，闲时段（占一周约 70% 时间）就变成 1 单位一次，
      // 与基准价相比差了一万多倍，而管理界面上「分时」列只是正常显示 0，完全看不出异常。
      const optNum = (v, name) => {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        const n = num(v, name, false);
        if (Number(n) === 0) return null;
        return n;
      };
      try {
        const offpeakInput = optNum(entry.offpeak_input ?? entry.offpeak_input_price, "offpeak_input");
        const offpeakOutput = optNum(entry.offpeak_output ?? entry.offpeak_output_price, "offpeak_output");
        const offpeakCache = optNum(entry.offpeak_cache ?? entry.offpeak_cache_price, "offpeak_cache");
        const offpeakRule = parseRuleInput(entry.offpeak_rule);
        // 有规则但没有任何闲时价 = 规则无意义（判档了却拿不到闲时单价），直接拒绝
        if (offpeakRule && offpeakInput === null && offpeakOutput === null && offpeakCache === null) {
          throw new Error("配置了闲时规则但未提供任何闲时价格");
        }
        // 反向：配了闲时价却没有规则 → 闲时价永远不生效，界面显示两档价但全天按基准价收费
        // （用户被多收），且没有任何提示。这种情况必须拒绝，否则就是又一个「设置了不生效」。
        if (!offpeakRule && (offpeakInput !== null || offpeakOutput !== null || offpeakCache !== null)) {
          throw new Error("配置了闲时价格但缺少闲时规则，闲时价永远不会生效；请补上规则或清空闲时价");
        }
        accepted.set(canonicalModelName(reg.model), {
          model: reg.model,
          input: num(entry.input ?? entry.input_price, "input", true),
          output: num(entry.output ?? entry.output_price, "output", true),
          cache: num(entry.cache ?? entry.cache_price, "cache", false),
          // 闲时价（可选）：留空 = 该模型不分时
          offpeakInput,
          offpeakOutput,
          offpeakCache,
          offpeakRule,
          type: reg.type || type,
          remark: String(entry.remark ?? entry.source ?? "").slice(0, 255)});
      } catch (e) {
        rejected.push({ line, model, reason: e.message });
      }
    }

    if (!accepted.size) {
      return fail(res, `全部 ${rejected.length} 条均未通过校验，请检查文件（模型 ID 必须与平台已注册模型严格一致）`);
    }

    const ts = now();
    const conn = await pool.getConnection();
    let inserted = 0;
    let updated = 0;
    try {
      await conn.beginTransaction();
      for (const p of accepted.values()) {
        const [ret] = await conn.query(
          `INSERT INTO model_prices
             (model, input_price, output_price, cache_price,
              offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
              channel_type, remark, updated_time, price_tiers)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
            cache_price=VALUES(cache_price),
            offpeak_input_price=VALUES(offpeak_input_price), offpeak_output_price=VALUES(offpeak_output_price),
            offpeak_cache_price=VALUES(offpeak_cache_price), offpeak_rule=VALUES(offpeak_rule),
            channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time), price_tiers=COALESCE(VALUES(price_tiers),price_tiers)`,
          [
            p.model, p.input, p.output, p.cache ?? 0,
            p.offpeakInput, p.offpeakOutput, p.offpeakCache, p.offpeakRule,
            p.type, p.remark, ts,
            p.tiers ? JSON.stringify(p.tiers) : null,
          ]
        );
        if (ret.affectedRows === 1) inserted += 1;
        else updated += 1;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    invalidatePrices();
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `导入模型定价：新增 ${inserted} 条、更新 ${updated} 条、拒绝 ${rejected.length} 条`});
    return ok(res, { total: parsed.length, inserted, updated, rejected }, `导入完成：新增 ${inserted}，更新 ${updated}，拒绝 ${rejected.length}`);
  })
);

// ---------------------------------------------------------------------------
// 清理无效定价：模型不在登记表里的行直接删除（一键清垃圾）
// ---------------------------------------------------------------------------
router.post(
  "/prune",
  asyncHandler(async (req, res) => {
    invalidateModelRegistry();
    const registry = await modelRegistry();
    const [rows] = await pool.query("SELECT model FROM model_prices");
    const dead = rows.map((r) => r.model).filter((m) => !registry.has(String(m).toLowerCase()));
    if (dead.length) {
      await pool.query(`DELETE FROM model_prices WHERE model IN (${dead.map(() => "?").join(",")})`, dead);
      invalidatePrices();
    }
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `清理无效定价 ${dead.length} 条${dead.length ? `：${dead.slice(0, 10).join("、")}` : ""}`});
    return ok(res, { removed: dead }, dead.length ? `已删除 ${dead.length} 条无效定价` : "没有发现无效定价");
  })
);

// ---------------------------------------------------------------------------
// 同步上游价目表：**真的去线上取价**（OpenRouter 公开模型目录），而不是重写内置表
// ---------------------------------------------------------------------------
// 用户反馈：「点击同步官方价目没用啊？比如 anthropic 今天出了新模型也没同步到啊？」
// —— 老实现只把硬编码的 DEFAULT_PRICES 写回库，那是一张人肉维护的静态表，
// 上游发新模型它当然不会自己出现。现在换成 services/price-sync.js 的真实取价。
//
// `overwrite` 默认 false：库里已有的行不覆盖（保住管理员手工调过的价）。
// 前端用「覆盖已有价」开关表达这个意图 —— 它是个危险操作，必须显式选。
router.post(
  "/sync-upstream",
  asyncHandler(async (req, res) => {
    const overwrite = req.body?.overwrite === true;
    try {
      const r = await syncUpstreamPrices({ overwrite });
      await writeLog({
        req,
        user: req.user,
        type: LOG_TYPE.MANAGE,
        content: `同步上游价目：新增 ${r.inserted}、更新 ${r.updated}、跳过 ${r.skipped}${overwrite ? "（含覆盖）" : ""}`,
      });
      const bits = [];
      if (r.inserted) bits.push(`新增 ${r.inserted}`);
      if (r.updated) bits.push(`更新 ${r.updated}`);
      if (r.skipped) bits.push(`跳过 ${r.skipped}（已有价，未开启覆盖）`);
      return ok(
        res,
        { ...r },
        `已从上游同步 ${r.fetched} 条价目${bits.length ? `，${bits.join("、")}` : ""}`
      );
    } catch (e) {
      return fail(res, `同步失败：${e.message}`);
    }
  })
);

/** 同步前预检：渠道声明了但库里没价的模型，其中多少能靠同步补上 */
router.get(
  "/sync-precheck",
  asyncHandler(async (req, res) => {
    try {
      const r = await missingFromUpstream();
      return ok(res, r);
    } catch (e) {
      return fail(res, `预检失败：${e.message}`);
    }
  })
);

// ---------------------------------------------------------------------------
// 同步内置价目表：按 DEFAULT_PRICES 覆盖更新（仅管理员主动点击时执行）
// ---------------------------------------------------------------------------
// 与启动时 seed 不同：这里会覆盖价格与来源说明，用于把被改乱/写错的历史数据拉回官方口径。
// 注意它**不会**发现新模型（数据源就是代码里那张静态表）；要拿上游新模型用 /sync-upstream。
router.post(
  "/sync-defaults",
  asyncHandler(async (req, res) => {
    const ts = now();
    let updated = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const p of DEFAULT_PRICES) {
        if (canonicalModelName(p.model) !== String(p.model).toLowerCase()) continue;
        await conn.query(
          `INSERT INTO model_prices
             (model, input_price, output_price, cache_price,
              offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
              channel_type, remark, updated_time, price_tiers)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
            cache_price=VALUES(cache_price),
            offpeak_input_price=VALUES(offpeak_input_price), offpeak_output_price=VALUES(offpeak_output_price),
            offpeak_cache_price=VALUES(offpeak_cache_price), offpeak_rule=VALUES(offpeak_rule),
            channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time), price_tiers=VALUES(price_tiers)`,
          [
            p.model, p.input, p.output, p.cache ?? 0,
            p.offpeakInput ?? null, p.offpeakOutput ?? null, p.offpeakCache ?? null,
            p.offpeakRule ? JSON.stringify(p.offpeakRule) : null,
            p.type, p.remark, ts,
            storedPriceTiers(p),
          ]
        );
        updated += 1;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    invalidatePrices();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `同步内置价目表 ${updated} 条` });
    return ok(res, { updated }, `已按内置价目表同步 ${updated} 条（来源均为官方页面）`);
  })
);

// 管理员确认的归属才影响权限、显示与价格；候选只是提示。
router.get("/attribution", asyncHandler(async (req, res) => {
  const pending = await pendingPricedModels();
  const [aliases] = await pool.query("SELECT alias,model,confirmed_by,updated_time FROM model_attributions ORDER BY alias");
  return ok(res, { ...pending, aliases });
}));

router.post("/attribution", asyncHandler(async (req, res) => {
  const alias = String(req.body?.alias || "").trim().toLowerCase();
  const target = String(req.body?.model || "").trim().toLowerCase();
  if (!alias || alias.length > 128 || !target || target.length > 128 || /[\s*]/.test(alias + target)) return fail(res, "请提供有效的型号与归属模型");
  if ([alias,target].some(m => /^(?:\d+-auto|auto|default|latest)$/.test(modelIdentity(m).split("/").pop()))) return fail(res, "动态路由不能建立固定模型归属；请配置渠道独立价格");
  const prices = await loadPrices();
  if (!prices.has(target) || canonicalModelName(target) !== target || canonicalModelName(target) === alias) return fail(res, "归属目标必须是已定价的独立模型，不能循环归属");
  const registry = await modelRegistry();
  if (!registry.has(alias)) return fail(res, "只能归属平台已登记的型号");
  const [dependents] = await pool.query("SELECT alias FROM model_attributions WHERE model=?", [alias]);
  if (dependents.length) return fail(res, "该型号仍是其他归属的目标，请先调整这些归属");
  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('ooapi:model-attribution', 10) acquired");
    if (!lock.acquired) return fail(res, "归属正在更新，请稍后重试", 409);
    await conn.beginTransaction();
    const [links] = await conn.query("SELECT alias FROM model_attributions WHERE alias=? OR model=? FOR UPDATE", [target,alias]);
    if (links.length) { await conn.rollback(); return fail(res, "归属关系已变化，请刷新后重试", 409); }
    await conn.query("INSERT INTO model_attributions (alias,model,confirmed_by,updated_time) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE model=VALUES(model),confirmed_by=VALUES(confirmed_by),updated_time=VALUES(updated_time)", [alias,target,req.user.id,now()]);
    await conn.commit();
  } catch(e) { await conn.rollback(); throw e; } finally { await conn.query("SELECT RELEASE_LOCK('ooapi:model-attribution')").catch(() => {}); conn.release(); }
  const { warmAliasMap } = await import("../services/models.js");
  await warmAliasMap(); invalidatePrices(); invalidateModelRegistry();
  await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `确认模型归属「${alias}」→「${target}」` });
  return ok(res, { alias, model: target });
}));
router.get("/resolve", asyncHandler(async (req, res) => {
  const model = String(req.query.model || "").trim();
  const matched = canonicalModelName(model), price = (await loadPrices()).get(matched);
  return ok(res, price ? { ...price, matched, source: "db" } : { model, source: "none", remark: "未定价，禁止调用" });
}));
router.post("/materialize", (req, res) => fail(res, "推测规则已停用，请确认模型归属或明确配置价格", 400));

export default router;
