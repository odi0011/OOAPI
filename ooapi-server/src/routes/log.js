import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, pageParams } from "../utils.js";
import { authRequired, adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE_LABEL } from "../services/log.js";

const router = Router();

function mapLog(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    username: r.username,
    created_at: r.created_at,
    type: r.type,
    type_label: LOG_TYPE_LABEL[r.type] || "其他",
    content: r.content,
    quota: Number(r.quota),
    ip: r.ip,
  };
}

// 个人日志
router.get(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => {
    const { p, size, offset } = pageParams(req.query);
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM logs WHERE user_id = ?", [
      req.user.id,
    ]);
    const [rows] = await pool.query(
      "SELECT * FROM logs WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      [req.user.id, size, offset]
    );
    return ok(res, { items: rows.map(mapLog), total, page: p, page_size: size });
  })
);

// 管理：全部日志
router.get(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    const { p, size, offset } = pageParams(req.query);
    const type = Number(req.query.type) || 0;
    const kw = String(req.query.keyword || "").trim();
    const conds = [];
    const args = [];
    if (type) {
      conds.push("type = ?");
      args.push(type);
    }
    if (kw) {
      conds.push("(username LIKE ? OR content LIKE ?)");
      args.push(`%${kw}%`, `%${kw}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM logs ${where}`, args);
    const [rows] = await pool.query(
      `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...args, size, offset]
    );
    return ok(res, { items: rows.map(mapLog), total, page: p, page_size: size });
  })
);

// 管理：清空日志
router.delete(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM logs");
    await writeLog({ user: req.user, type: 3, content: "清空所有日志" });
    return ok(res, null, "日志已清空");
  })
);

export default router;
