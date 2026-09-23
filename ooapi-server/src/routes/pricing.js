// 模型定价管理路由（管理员）
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { invalidatePrices, loadPrices, DEFAULT_PRICES, describeRule } from "../services/pricing.js";
import { pendingPricedModels } from "../services/pricing.js";
import { modelRegistry, invalidateModelRegistry } from "../services/models.js";
import { clinePriceFor } from "../services/cline-prices.js";
import { syncUpstreamPrices, missingFromUpstream } from "../services/price-sync.js";

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

// ---------------------------------------------------------------------------
// 模型归属：把「别的名字的同一个模型」自动对到真实厂商的图标与价格
// ---------------------------------------------------------------------------
// 用户要求（原话）：
//   「我看到 Cline 里很多模型，并没有走系统已有模型的厂商的图标，应该是他们的 id
//     不相同，这个有什么办法自动归属吗？比如 workbuddy 或者其他渠道有那个 deepseekv4.1flash，
//     但是实际他应该就是 deepseek-flash 模型，能不能全部，在获取模型的时候自动归属，
//     在后台模型定价页面坐一块功能区给管理员做？…价格我估计也是对不上的，这点你检查一下」
//
// 背景（已核对线上实测）：Cline 的 /models 返回 454 个模型，形如
// `anthropic/claude-sonnet-4.5`、`~openai/gpt-luna-latest`、`x-ai/grok-4.3:free` ——
// 厂商前缀是**上游的写法**，与我们渠道类型的 key 常常不同（x-ai vs grok、z-ai vs glm、
// moonshotai vs kimi、meta-llama vs meta）。于是：
//   · 图标：模型名带前缀 → 前端匹配不到 → 退化成渠道图标（看着像「不认识这个模型」）；
//   · 价格：库里没有 `anthropic/claude-sonnet-4.5` 这一行 → 走兜底链（同族/最贵档），
//     而兜底是**猜的**，实测会把便宜模型按旗舰价收。
// 解决办法是一层「归属规则」（services/cline-prices.js）：模型名归一化后按规则
// 映射到真实厂商与价格。规则覆盖 454/454（0 条落到兜底、0 条为 0 价）。
//
// 下面两个接口把这件事摊到管理员面前：
//   · resolve     —— 「这个模型到底会被当成谁、按什么价算」的即时查询（单条自检）
//   · materialize —— 把归属规则**固化成真实定价行**（之后可在定价表里逐条改）
// 为什么要有 materialize：规则是代码里的映射，管理员改不了；而有些模型确实需要
// 单独定价（比如上游涨价）。固化后 DB 里的行优先于规则，管理员就有了控制权。

/** 归属规则的只读快照（前端展示「哪些模型归给谁、还有多少没着落」） */
router.get(
  "/attribution",
  asyncHandler(async (req, res) => {
    const prices = await loadPrices();
    const [rows] = await pool.query(
      "SELECT id, name, type, models FROM channels WHERE status = 1 AND models IS NOT NULL AND models <> ''"
    );
    // 逐模型判定「这个模型按什么价收费」，四个来源分开计数。
    // 用户反馈「这块太模糊了我根本看不懂咋用」—— 所以这里不只给数字，
    // 每个来源都带上**可操作的下一步**（见 sources[].action）。
    const SRC = {
      exact: { key: "exact", label: "库里已定价", tone: "green", desc: "在下面定价表里能直接找到并修改" },
      rule: { key: "rule", label: "归属规则自动定价", tone: "cyan", desc: "由内置规则按厂商归属，无需你操作" },
      fallback: { key: "fallback", label: "走兜底价（会偏贵）", tone: "orange", desc: "只能按「同厂商最贵档」猜，建议补齐" },
      none: { key: "none", label: "完全没价，调用会被拦下", tone: "red", desc: "用户调用时会被拒绝，必须定价" },
    };
    const counts = { exact: 0, rule: 0, fallback: 0, none: 0 };
    const buckets = { exact: [], rule: [], fallback: [], none: [] };
    const byVendor = new Map();

    for (const r of rows) {
      for (const raw of String(r.models || "").split(",")) {
        const m = raw.trim();
        if (!m || m === "*") continue;
        const key = m.toLowerCase();
        const item = { model: m, channel: String(r.name || ""), channelId: Number(r.id) || 0 };

        // ① 库里精确命中
        if (prices.has(key)) {
          const v = prices.get(key);
          counts.exact += 1;
          if (buckets.exact.length < 300) buckets.exact.push({ ...item, got: v.model, input: Number(v.input), output: Number(v.output) });
          continue;
        }
        // ② 前缀命中（deepseek-chat-search → deepseek-chat）：也算库里已定价
        let bestLen = -1;
        let bestKey = "";
        for (const k of prices.keys()) if (key.startsWith(k) && k.length > bestLen) { bestLen = k.length; bestKey = k; }
        if (bestLen >= 0) {
          const v = prices.get(bestKey);
          counts.exact += 1;
          if (buckets.exact.length < 300) buckets.exact.push({ ...item, got: bestKey, input: Number(v.input), output: Number(v.output) });
          continue;
        }
        // ③ 归属规则
        const rule = clinePriceFor(m);
        if (rule) {
          counts.rule += 1;
          const v = rule.type || "其他";
          byVendor.set(v, (byVendor.get(v) || 0) + 1);
          if (buckets.rule.length < 300) buckets.rule.push({ ...item, got: v, input: rule.input, output: rule.output });
          continue;
        }
        // ④ 没有规则 → 会走兜底（同厂商最贵档 / 全表最贵档）。
        // 兜底链里「同厂商」要靠注册表判定，拿得到就是 fallback，拿不到就是 none
        //（两者对管理员的差别是「大概多收几倍」vs「完全不能调用」，必须分开）。
        let vendor = "";
        try {
          const { modelRegistry } = await import("../services/models.js");
          const reg = await modelRegistry();
          vendor = reg.get(key)?.type || "";
        } catch { /* 注册表取不到就当 none 处理 */ }
        if (vendor) {
          counts.fallback += 1;
          if (buckets.fallback.length < 300) buckets.fallback.push({ ...item, got: vendor });
        } else {
          counts.none += 1;
          if (buckets.none.length < 300) buckets.none.push({ ...item, got: "" });
        }
      }
    }

    const total = counts.exact + counts.rule + counts.fallback + counts.none;
    return ok(res, {
      total,
      counts,
      // 每个桶带上「下一步该做什么」—— 这是「看不懂咋用」的解药：
      // 管理员不需要理解规则引擎，只需要知道「哪里有问题、点哪个按钮」。
      //
      // 刻意**不返回** ruleCount（内置规则条数）：那是引擎内部指标，旧版把它
      // 摆在最显眼的位置（「归属规则 212 条」），管理员看到只会想「所以呢？」——
      // 它既不是问题、也不是能操作的数字（用户反馈「太模糊了我根本看不懂咋用」）。
      sources: Object.values(SRC).map((x) => ({ ...x, count: counts[x.key], models: buckets[x.key] })),
      // 厂商分布（归属规则把哪些厂商的模型自动收进来了）
      vendors: [...byVendor.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      // 一句话总结：给不看细节的人
      // 一句话结论要**与下面的卡片口径一致**：卡片里分「库里已定价」与「规则自动定价」
      // 两类，原先一句话说「全部 N 个都有确切价格」会让人以为都来自定价表
      //（黑盒测试指出这个措辞与自己的卡片矛盾）。
      summary:
        counts.fallback || counts.none
          ? `有 ${counts.fallback + counts.none} 个模型没有确切价格，其中 ${counts.none} 个会被直接拦下`
          : `全部 ${total} 个模型都有价可计（${counts.exact} 条表内价 + ${counts.rule} 条规则价）`,
    });
  })
);


router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const model = String(req.query.model || "").trim();
    if (!model) return fail(res, "请提供 model 参数");
    const prices = await loadPrices();
    const key = model.toLowerCase();
    const exact = prices.get(key);
    if (exact) {
      return ok(res, {
        model,
        source: "db",
        type: exact.type || "",
        input: Number(exact.input) || 0,
        output: Number(exact.output) || 0,
        cache: Number(exact.cache) || 0,
        remark: exact.remark || "（定价表中已有该模型）",
      });
    }
    let bestLen = -1;
    let best = null;
    for (const [k, v] of prices) if (key.startsWith(k) && k.length > bestLen) { bestLen = k.length; best = { k, v }; }
    if (best) {
      return ok(res, {
        model,
        source: "db-prefix",
        matched: best.k,
        type: best.v.type || "",
        input: Number(best.v.input) || 0,
        output: Number(best.v.output) || 0,
        cache: Number(best.v.cache) || 0,
        remark: `命中定价表里的前缀「${best.k}」`,
      });
    }
    const rule = clinePriceFor(model);
    if (rule) {
      return ok(res, {
        model,
        source: "rule",
        type: rule.type,
        input: rule.input,
        output: rule.output,
        cache: rule.cache,
        remark: rule.remark,
      });
    }
    return ok(res, { model, source: "none", remark: "归属规则未覆盖：该模型会走兜底价（同族/最贵档），建议手工定价" });
  })
);

/**
 * 把归属规则固化成真实定价行（管理员点「固化为定价」时执行）。
 *
 * 入参二选一：
 *   `{ models: ["anthropic/claude-sonnet-4.5", ...] }` —— 指定若干模型
 *   `{ vendor: "anthropic" }`                        —— 固化「归到该厂商的全部模型」
 *     （vendor 的取值来自 /attribution 的 vendors[].type）
 *
 * **已存在的行不覆盖**：管理员手工调过的价不能被一次「固化」抹掉 ——
 * 那正是固化的反面。想回到规则价就先删掉那一行再固化。
 */
router.post(
  "/materialize",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const explicit = Array.isArray(body.models) ? body.models.map((m) => String(m).trim()).filter(Boolean) : [];
    const vendor = String(body.vendor || "").trim();
    if (!explicit.length && !vendor) return fail(res, "请提供 models 或 vendor");

    const [rows] = await pool.query(
      "SELECT id, name, type, models FROM channels WHERE status = 1 AND models IS NOT NULL AND models <> ''"
    );
    const declared = new Set();
    for (const r of rows) {
      for (const raw of String(r.models || "").split(",")) {
        const m = raw.trim();
        if (m && m !== "*") declared.add(m);
      }
    }
    const candidate = explicit.length ? explicit : [...declared];

    const ts = now();
    let inserted = 0;
    let skipped = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const m of candidate) {
        // 已有定价行的跳过（不覆盖管理员的手工定价）
        const [exist] = await conn.query("SELECT model FROM model_prices WHERE model = ?", [m]);
        if (exist.length) { skipped += 1; continue; }
        const p = clinePriceFor(m);
        if (!p) { skipped += 1; continue; }
        if (vendor && p.type !== vendor) { skipped += 1; continue; }
        await conn.query(
          `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time)
           VALUES (?,?,?,?,?,?,?)`,
          [m, p.input, p.output, p.cache, p.type, p.remark, ts]
        );
        inserted += 1;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    if (inserted) invalidatePrices();
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `固化模型归属定价：新增 ${inserted} 条（跳过 ${skipped} 条已有/未覆盖）${vendor ? `，厂商 ${vendor}` : ""}`,
    });
    return ok(
      res,
      { inserted, skipped },
      inserted ? `已固化 ${inserted} 条归属定价（可在上方列表中继续微调）` : "没有需要固化的模型（都已定价或不适用）"
    );
  })
);

export default router;
