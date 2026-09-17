import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, safeJSONParse, userToResponse } from "../utils.js";
import { authRequired, adminRequired, signToken } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();

// ---------- 个人中心 ----------

router.put(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => {
    const { display_name, email } = req.body || {};
    await pool.query("UPDATE users SET display_name = ?, email = ? WHERE id = ?", [
      String(display_name ?? req.user.display_name ?? "").trim(),
      String(email ?? req.user.email ?? "").trim(),
    ]);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    return ok(res, userToResponse(rows[0]), "保存成功");
  })
);

router.put(
  "/self/password",
  authRequired,
  asyncHandler(async (req, res) => {
    const { new_password } = req.body || {};
    const pwd = String(new_password || "");
    if (pwd.length < 8) return fail(res, "新密码长度至少 8 位");
    if (/^[0-9]+$/.test(pwd) || /^[a-zA-Z]+$/.test(pwd)) return fail(res, "密码需同时包含字母和数字");
    const hash = await bcrypt.hash(pwd, 10);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [hash]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: "修改密码" });
    return ok(res, null, "密码修改成功");
  })
);

router.put(
  "/self/settings",
  authRequired,
  asyncHandler(async (req, res) => {
    const setting = req.body || {};
    if (typeof setting !== "object") return fail(res, "参数错误");
    await pool.query("UPDATE users SET setting = ? WHERE id = ?", [JSON.stringify(setting)]);
    return ok(res, setting, "设置已保存");
  })
);

// ---------- 数据统计 ----------

router.get(
  "/data/self",
  authRequired,
  asyncHandler(async (req, res) => {
    const [[sum]] = await pool.query(
      "SELECT COALESCE(SUM(CASE WHEN type = 2 THEN quota ELSE 0 END),0) AS consume FROM logs WHERE user_id = ?",
      [req.user.id]
    );
    // 近 30 天按天聚合消费
    const [daily] = await pool.query(
      `SELECT FROM_UNIXTIME(created_at, '%Y-%m-%d') AS day,
              COALESCE(SUM(CASE WHEN type = 2 THEN quota ELSE 0 END),0) AS quota,
              COUNT(*) AS calls
       FROM logs
       WHERE user_id = ? AND type = 2 AND created_at >= UNIX_TIMESTAMP() - 30 * 86400
       GROUP BY day ORDER BY day`,
      [req.user.id]
    );
    return ok(res, {
      quota: Number(req.user.quota),
      used_quota: Number(req.user.used_quota),
      request_count: req.user.request_count,
      consume_in_logs: Number(sum.consume),
      daily,
    });
  })
);

// ---------- 管理：用户列表 ----------

router.get(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    const p = Math.max(1, Number(req.query.p) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.page_size) || 20));
    const kw = String(req.query.keyword || "").trim();
    let where = "";
    const args = [];
    if (kw) {
      where = "WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?";
      const like = `%${kw}%`;
      args.push(like, like, like);
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, args);
    const [rows] = await pool.query(
      `SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...args, size, (p - 1) * size]
    );
    return ok(res, { items: rows.map(userToResponse), total, page: p, page_size: size });
  })
);

// ---------- 管理：用户操作 ----------

router.put(
  "/:id",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    const { role, status, display_name, email } = req.body || {};
    if (role !== undefined) {
      await pool.query("UPDATE users SET role = ? WHERE id = ?", [Math.max(1, Number(role))]);
    }
    if (status !== undefined) {
      const s = Number(status) === 2 ? 2 : 1;
      if (user.role >= 100 && s === 2 && id === req.user.id) return fail(res, "不能禁用自己的账号");
      await pool.query("UPDATE users SET status = ? WHERE id = ?", [s]);
    }
    if (display_name !== undefined || email !== undefined) {
      await pool.query("UPDATE users SET display_name = ?, email = ? WHERE id = ?", [
        String(display_name ?? user.display_name ?? "").trim(),
        String(email ?? user.email ?? "").trim(),
      ]);
    }
    await writeLog({
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `编辑用户 #${id}（${user.username}）`,
    });
    const [fresh] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    return ok(res, userToResponse(fresh[0]), "已更新");
  })
);

router.post(
  "/:id/quota",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const quota = Math.floor(Number(req.body?.quota));
    if (!Number.isFinite(quota) || quota === 0) return fail(res, "额度变化量无效");
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    const newQuota = Math.max(0, Number(user.quota) + quota);
    await pool.query("UPDATE users SET quota = ? WHERE id = ?", [newQuota, id]);
    await writeLog({
      user: req.user,
      type: LOG_TYPE.TOPUP,
      content: `${quota > 0 ? "补充" : "扣除"} ${Math.abs(quota)} 额度给 ${user.username}（${user.username} 当前 ${newQuota}）`,
      quota: Math.abs(quota),
    });
    const [fresh] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    return ok(res, userToResponse(fresh[0]), "额度已调整");
  })
);

router.delete(
  "/:id",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return fail(res, "不能删除自己的账号");
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    await pool.query("DELETE FROM users WHERE id = ?", [id]);
    await pool.query("DELETE FROM tokens WHERE user_id = ?", [id]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `删除用户 #${id}（${user.username}）` });
    return ok(res, null, "用户已删除");
  })
);

// 管理员生成临时 token（查看用户用），返回登录态
router.post(
  "/:id/token",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    if (!rows[0]) return fail(res, "用户不存在", 404);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `以用户 #${id} 身份签发临时令牌` });
    return ok(res, { token: signToken(rows[0]) });
  })
);

export default router;
