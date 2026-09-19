import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, clientIp, now, genAffCode, userToResponse } from "../utils.js";
import { authRequired, signToken } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { getBoolOption, getNumberOption } from "../config.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{2,32}$/;
// 不存在的账号也做一次 bcrypt 比对：否则响应时间差可枚举用户名。
// 固定 dummy hash 在启动时算一次，开销可接受。
const DUMMY_HASH = bcrypt.hashSync("ooapi-dummy-password", 10);

// bcryptjs 对超过 72 字节的输入会静默截断：超长密码只要前 72 字节相同即等价
function passwordTooLong(pwd) {
  return Buffer.byteLength(String(pwd || ""), "utf8") > 72;
}

// 登录/注册限流：防暴力破解与批量刷号
const loginLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "login" });
const registerLimit = rateLimit({ windowMs: 300_000, max: 5, keyPrefix: "register" });

router.post(
  "/login",
  loginLimit,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, "请输入用户名和密码");
    if (!getBoolOption("password_login_enabled")) return fail(res, "系统未开启密码登录", 403);
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [String(username).trim()]);
    const user = rows[0];
    const passOk = await bcrypt.compare(String(password), user?.password || DUMMY_HASH);
    if (!user || !passOk) {
      return fail(res, "用户名或密码错误", 401);
    }
    if (user.status !== 1) return fail(res, "账号已被禁用", 403);
    const ts = now();
    const ip = clientIp(req);
    await pool.query(
      "UPDATE users SET last_login_time = ?, last_login_ip = ?, login_count = login_count + 1 WHERE id = ?",
      [ts, ip, user.id]
    );
    await writeLog({ user, type: LOG_TYPE.LOGIN, content: "用户登录", ip });
    return ok(res, { token: signToken(user), user: userToResponse(user) }, "登录成功");
  })
);

router.post(
  "/register",
  registerLimit,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!getBoolOption("password_register_enabled")) return fail(res, "系统未开放注册", 403);
    const name = String(username || "").trim();
    if (!USERNAME_RE.test(name)) return fail(res, "用户名需为 2-32 位字母、数字或下划线");
    const pwd = String(password || "");
    if (pwd.length < 8) return fail(res, "密码长度至少 8 位");
    if (passwordTooLong(pwd)) return fail(res, "密码过长（最多 72 字节）");
    if (/^[0-9]+$/.test(pwd) || /^[a-zA-Z]+$/.test(pwd))
      return fail(res, "密码需同时包含字母和数字");
    const [dup] = await pool.query("SELECT id FROM users WHERE username = ?", [name]);
    if (dup.length) return fail(res, "用户名已被占用", 409);
    const hash = await bcrypt.hash(pwd, 10);
    const ts = now();
    const quota = getNumberOption("quota_for_new_user");
    const aff = genAffCode();
    let ret;
    try {
      [ret] = await pool.query(
        "INSERT INTO users (username, password, display_name, role, status, quota, aff_code, group_name, created_time, last_login_time, last_login_ip) VALUES (?,?,?,1,1,?,?,?, ?, ?, ?)",
        // group_name 留空 = 公共池（"default" 是已废弃的历史值，用了它会让日志里
        // 出现名为 default 的分组标签，且启动清理要等到下次重启才归一）
        [name, hash, name, quota, aff, "", ts, ts, clientIp(req)]
      );
    } catch (e) {
      // 并发注册同名用户：唯一键冲突返回 409，而不是把 500 抛给用户
      if (e?.code === "ER_DUP_ENTRY") return fail(res, "用户名已被占用", 409);
      throw e;
    }
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [ret.insertId]);
    const user = rows[0];
    await writeLog({ user, type: LOG_TYPE.MANAGE, content: `新用户注册，赠送额度 ${quota}`, ip: clientIp(req) });
    return ok(res, { token: signToken(user), user: userToResponse(user) }, "注册成功");
  })
);

router.get(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => ok(res, userToResponse(req.user)))
);

router.post("/logout", asyncHandler(async (req, res) => ok(res, null, "已退出登录")));

export default router;
