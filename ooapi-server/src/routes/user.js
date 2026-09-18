import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, safeJSONParse, userToResponse, pageParams, idParam } from "../utils.js";
import { authRequired, adminRequired, signToken } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();

// ---------- 个人中心 ----------

router.put(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => {
    const { display_name, email } = req.body || {};
    // 按列宽截断（display_name 64 / email 128）：超长写库会 500
    await pool.query("UPDATE users SET display_name = ?, email = ? WHERE id = ?", [
      String(display_name ?? req.user.display_name ?? "").trim().slice(0, 64),
      String(email ?? req.user.email ?? "").trim().slice(0, 128),
      req.user.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    return ok(res, userToResponse(rows[0]), "保存成功");
  })
);

router.put(
  "/self/password",
  authRequired,
  // 防撞库：拿到 JWT 后也不能无限试旧密码（按用户维度限流）
  rateLimit({ windowMs: 60_000, max: 5, keyPrefix: "self-pwd", keyFn: (req) => req.user?.id || req.ip }),
  asyncHandler(async (req, res) => {
    const { new_password, old_password } = req.body || {};
    // 修改密码必须校验旧密码：仅有会话（或 CSRF）不足以永久接管账号。
    // 注意这里**始终**要求旧密码，不能因为字段缺省就跳过校验。
    if (!old_password) return fail(res, "请输入当前密码", 400);
    const okOld = await bcrypt.compare(String(old_password), req.user.password);
    if (!okOld) return fail(res, "当前密码不正确", 403);
    const pwd = String(new_password || "");
    if (pwd.length < 8) return fail(res, "新密码长度至少 8 位");
    if (/^[0-9]+$/.test(pwd) || /^[a-zA-Z]+$/.test(pwd)) return fail(res, "密码需同时包含字母和数字");
    const hash = await bcrypt.hash(pwd, 10);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [hash, req.user.id]);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: "修改密码" });
    return ok(res, null, "密码修改成功");
  })
);

router.put(
  "/self/settings",
  authRequired,
  asyncHandler(async (req, res) => {
    const setting = req.body || {};
    if (typeof setting !== "object" || Array.isArray(setting)) return fail(res, "参数错误");
    // setting 列是 TEXT(64KB)：限制体积防写库报错
    const json = JSON.stringify(setting);
    if (json.length > 16_000) return fail(res, "设置内容过大");
    await pool.query("UPDATE users SET setting = ? WHERE id = ?", [json, req.user.id]);
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
    const { p, size, offset } = pageParams(req.query);
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
      [...args, size, offset]
    );
    return ok(res, { items: rows.map(userToResponse), total, page: p, page_size: size });
  })
);

// ---------- 管理：用户操作 ----------

router.put(
  "/:id",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "用户不存在", 404);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    const { role, status, display_name, email } = req.body || {};
    if (role !== undefined) {
      // 不能改自己的角色：唯一管理员把自己降级后会永久失去后台入口（无 API 恢复路径）
      if (id === req.user.id) return fail(res, "不能修改自己的角色");
      // 角色上限 100（超级管理员），避免管理员把用户设成未定义的更高权限
      const r = Math.min(100, Math.max(1, Math.floor(Number(role)) || 1));
      if (user.role >= 100 && r < 100) {
        const [[{ admins }]] = await pool.query(
          "SELECT COUNT(*) AS admins FROM users WHERE role >= 100 AND status = 1 AND id <> ?",
          [id]
        );
        if (!admins) return fail(res, "必须至少保留一个启用的管理员");
      }
      await pool.query("UPDATE users SET role = ? WHERE id = ?", [r, id]);
    }
    if (status !== undefined) {
      const s = Number(status) === 2 ? 2 : 1;
      if (s === 2 && user.role >= 100) {
        if (id === req.user.id) return fail(res, "不能禁用自己的账号");
        const [[{ admins }]] = await pool.query(
          "SELECT COUNT(*) AS admins FROM users WHERE role >= 100 AND status = 1 AND id <> ?",
          [id]
        );
        if (!admins) return fail(res, "必须至少保留一个启用的管理员");
      }
      await pool.query("UPDATE users SET status = ? WHERE id = ?", [s, id]);
    }
    if (display_name !== undefined || email !== undefined) {
      await pool.query("UPDATE users SET display_name = ?, email = ? WHERE id = ?", [
        String(display_name ?? user.display_name ?? "").trim().slice(0, 64),
        String(email ?? user.email ?? "").trim().slice(0, 128),
        id,
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
    const id = idParam(req);
    if (!id) return fail(res, "用户不存在", 404);
    const quota = Math.floor(Number(req.body?.quota));
    if (!Number.isFinite(quota) || quota === 0) return fail(res, "额度变化量无效");
    // 上限：BIGINT 越界会直接 500，且这种量级的调整没有实际意义
    if (Math.abs(quota) > 1e15) return fail(res, "额度变化量无效");
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    // 单条原子更新：查询→计算→写回会在并发调整时丢更新
    await pool.query("UPDATE users SET quota = GREATEST(0, quota + ?) WHERE id = ?", [quota, id]);
    const [fresh] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const newQuota = Number(fresh[0].quota);
    await writeLog({
      user: req.user,
      // 扣除用「管理」类型、充值用「充值」类型：日志页按类型显示 +/- 符号
      type: quota > 0 ? LOG_TYPE.TOPUP : LOG_TYPE.MANAGE,
      content: `${quota > 0 ? "补充" : "扣除"} ${Math.abs(quota)} 额度给 ${user.username}（${user.display_name || user.username} 当前 ${newQuota}）`,
      quota: Math.abs(quota),
    });
    return ok(res, userToResponse(fresh[0]), "额度已调整");
  })
);

router.delete(
  "/:id",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "用户不存在", 404);
    if (id === req.user.id) return fail(res, "不能删除自己的账号");
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 404);
    // 不能删掉最后一个启用的管理员（否则后台失联、只能改库恢复）
    if (user.role >= 100) {
      const [[{ admins }]] = await pool.query(
        "SELECT COUNT(*) AS admins FROM users WHERE role >= 100 AND id <> ?",
        [id]
      );
      if (!admins) return fail(res, "必须至少保留一个管理员");
    }
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
    const id = idParam(req);
    if (!id) return fail(res, "用户不存在", 404);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    if (!rows[0]) return fail(res, "用户不存在", 404);
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: `以用户 #${id} 身份签发临时令牌` });
    return ok(res, { token: signToken(rows[0]) });
  })
);

export default router;
