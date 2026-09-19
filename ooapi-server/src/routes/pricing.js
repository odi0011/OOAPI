// 模型定价管理路由（管理员）
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { invalidatePrices, DEFAULT_PRICES, describeRule } from "../services/pricing.js";
import { modelRegistry, invalidateModelRegistry } from "../services/models.js";

const router = Router();
router.use(adminRequired);

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
  return JSON.stringify({ offset, days: obj.days || [1, 2, 3, 4, 5], peak });
}

// 列表
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
      offIn = num(offpeak_input_price, "offpeak_input");
      offOut = num(offpeak_output_price, "offpeak_output");
      offCache = num(offpeak_cache_price, "offpeak_cache");
      ruleText = parseRuleInput(offpeak_rule);
    } catch (e) {
      return fail(res, e.message);
    }
    if (input == null || output == null) return fail(res, "输入/输出价格不能为空");
    await pool.query(
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
    );
    invalidatePrices();
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `保存模型定价「${m}」` });
    return ok(res, null, "定价已保存");
  })
);

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
      const optNum = (v, name) => {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        return num(v, name, false);
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
        accepted.set(model.toLowerCase(), {
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
              channel_type, remark, updated_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
            cache_price=VALUES(cache_price),
            offpeak_input_price=VALUES(offpeak_input_price), offpeak_output_price=VALUES(offpeak_output_price),
            offpeak_cache_price=VALUES(offpeak_cache_price), offpeak_rule=VALUES(offpeak_rule),
            channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time)`,
          [
            p.model, p.input, p.output, p.cache,
            p.offpeakInput, p.offpeakOutput, p.offpeakCache, p.offpeakRule,
            p.type, p.remark, ts,
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
// 同步内置价目表：按 DEFAULT_PRICES 覆盖更新（仅管理员主动点击时执行）
// ---------------------------------------------------------------------------
// 与启动时 seed 不同：这里会覆盖价格与来源说明，用于把被改乱/写错的历史数据拉回官方口径。
router.post(
  "/sync-defaults",
  asyncHandler(async (req, res) => {
    const ts = now();
    let updated = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const p of DEFAULT_PRICES) {
        await conn.query(
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
            p.model, p.input, p.output, p.cache,
            p.offpeakInput ?? null, p.offpeakOutput ?? null, p.offpeakCache ?? null,
            p.offpeakRule ? JSON.stringify(p.offpeakRule) : null,
            p.type, p.remark, ts,
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

export default router;
