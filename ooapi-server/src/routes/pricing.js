// 模型定价管理路由（管理员）
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { invalidatePrices, UNITS_PER_OD, CURRENCY, loadPrices } from "../services/pricing.js";

const router = Router();
router.use(adminRequired);

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
        channel_type: r.channel_type || "",
        remark: r.remark || "",
        updated_time: Number(r.updated_time) || 0,
        // 折算展示：输入/输出各 1M token 的总价
        cost_1m_both: Number((Number(r.input_price) + Number(r.output_price)).toFixed(4)),
      }))
    );
  })
);

// 新增或更新
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const { model, input_price, output_price, cache_price, channel_type, remark } = req.body || {};
    const m = String(model || "").trim();
    if (!m) return fail(res, "缺少模型 ID");
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    if (num(input_price) < 0 || num(output_price) < 0 || num(cache_price) < 0) {
      return fail(res, "价格不能为负数");
    }
    await pool.query(
      `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
        cache_price=VALUES(cache_price), channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time)`,
      [m, num(input_price), num(output_price), num(cache_price), String(channel_type || ""), String(remark || ""), now()]
    );
    invalidatePrices();
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `保存模型定价「${m}」` });
    return ok(res, null, "定价已保存");
  })
);

// 删除
router.delete(
  "/:model",
  asyncHandler(async (req, res) => {
    const m = decodeURIComponent(req.params.model);
    const [ret] = await pool.query("DELETE FROM model_prices WHERE model = ?", [m]);
    if (!ret.affectedRows) return fail(res, "模型不存在", 404);
    invalidatePrices();
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `删除模型定价「${m}」` });
    return ok(res, null, "已删除");
  })
);

export default router;
