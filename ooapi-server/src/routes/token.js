import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, genApiKey, tokenToResponse, randomString, idParam, safeInt } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();
router.use(authRequired);

// 可选分组列表（用户创建令牌时选；分组按厂商隔离，返回 type:name 作为绑定值）
router.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT type, name FROM channel_groups ORDER BY type, name");
    return ok(res, rows.map((g) => ({ type: g.type, name: g.name })));
  })
);

// 额度/时间上限：BIGINT 本身能存到 9e18，但应用层允许的额度远超实际意义，
// 上限校验防的是 1e20 这类会让写库直接越界 500 的值（expired_time 上限约到 2286 年）
const MAX_QUOTA = 1e15;
const MAX_EXPIRED = 9_999_999_999;

function getSetting(user) {
  return user?.setting ?? {};
}

// 列表（不返回完整 key）
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM tokens WHERE user_id = ? ORDER BY id DESC", [req.user.id]);
    const items = rows.map((t) => {
      const r = tokenToResponse(t);
      // 掩码只留前缀与后 4 位，避免泄露可用密钥
      return { ...r, key: r.key.slice(0, 3) + "******************" + r.key.slice(-4) };
    });
    return ok(res, items);
  })
);

// 获取单个令牌的完整 key
router.get(
  "/:id/key",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "令牌不存在", 404);
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!rows.length) return fail(res, "令牌不存在", 404);
    return ok(res, { key: rows[0].key_str });
  })
);

// 新建
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const {
      name = "",
      remain_quota = 0,
      unlimited_quota = true,
      expired_time = -1,
      model_limits = [],
      group_name = "",
    } = req.body || {};
    if (String(name).length > 64) return fail(res, "名称过长");
    // 数值严格校验：NaN/Infinity/负数一律拒绝（strict 模式下写库会直接 500）
    const remainVal = Number(remain_quota);
    const expiredVal = Number(expired_time);
    if (!Number.isFinite(remainVal) || remainVal < 0 || remainVal > MAX_QUOTA) return fail(res, "额度无效");
    if (!Number.isFinite(expiredVal) || expiredVal > MAX_EXPIRED) return fail(res, "过期时间无效");
    const key = genApiKey();
    const [ins] = await pool.query(
      `INSERT INTO tokens (user_id, name, key_str, status, created_time, accessed_time, expired_time,
        remain_quota, unlimited_quota, used_quota, model_limits, group_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        String(name).trim() || `令牌 ${randomString(4)}`,
        key,
        1,
        now(),
        0,
        Number(expiredVal),
        Number(remainVal),
        unlimited_quota ? 1 : 0,
        0,
        Array.isArray(model_limits) ? model_limits.join(",").slice(0, 2000) : "",
        String(group_name || "").slice(0, 32),
      ]
    );
    // 用 insertId 精确回查：按 user_id ORDER BY id DESC 并发时会返回别人刚建的令牌（含完整 Key）
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ?", [ins.insertId]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `新建令牌「${rows[0].name}」` });
    return ok(res, tokenToResponse(rows[0]), "令牌创建成功");
  })
);

// 更新
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const { id, name, status, remain_quota, unlimited_quota, expired_time, model_limits, group_name } =
      req.body || {};
    // Infinity/NaN 会被 mysql2 原样拼进 SQL；这里必须是安全整数
    const token = safeInt(id, { min: 1 });
    if (!token) return fail(res, "缺少令牌 id");
    const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [token, req.user.id]);
    if (!rows.length) return fail(res, "令牌不存在", 404);
    const cur = rows[0];
    // status 只能 1(启用)/2(禁用)/3(过期)；额度与过期时间必须为有限数字
    let statusVal = cur.status;
    if (status !== undefined) {
      statusVal = Number(status);
      if (![1, 2, 3].includes(statusVal)) return fail(res, "状态无效");
    }
    let remainVal = cur.remain_quota;
    if (remain_quota !== undefined) {
      remainVal = Number(remain_quota);
      if (!Number.isFinite(remainVal) || remainVal < 0 || remainVal > MAX_QUOTA) return fail(res, "额度无效");
    }
    let expiredVal = cur.expired_time;
    if (expired_time !== undefined) {
      expiredVal = Number(expired_time);
      if (!Number.isFinite(expiredVal) || expiredVal > MAX_EXPIRED) return fail(res, "过期时间无效");
    }
    await pool.query(
      `UPDATE tokens SET name = ?, status = ?, remain_quota = ?, unlimited_quota = ?, expired_time = ?,
        model_limits = ?, group_name = ? WHERE id = ? AND user_id = ?`,
      [
        name !== undefined ? String(name).trim().slice(0, 64) : cur.name,
        statusVal,
        remainVal,
        unlimited_quota !== undefined ? (unlimited_quota ? 1 : 0) : cur.unlimited_quota,
        expiredVal,
        Array.isArray(model_limits) ? model_limits.join(",").slice(0, 2000) : cur.model_limits,
        group_name !== undefined ? String(group_name).slice(0, 32) : cur.group_name,
        token,
        req.user.id,
      ]
    );
    const [fresh] = await pool.query("SELECT * FROM tokens WHERE id = ?", [token]);
    return ok(res, tokenToResponse(fresh[0]), "令牌已更新");
  })
);

// 删除
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const token = idParam(req);
    if (!token) return fail(res, "令牌不存在", 404);
    const [ret] = await pool.query("DELETE FROM tokens WHERE id = ? AND user_id = ?", [token, req.user.id]);
    if (!ret.affectedRows) return fail(res, "令牌不存在", 404);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `删除令牌 #${token}` });
    return ok(res, null, "令牌已删除");
  })
);

export default router;
