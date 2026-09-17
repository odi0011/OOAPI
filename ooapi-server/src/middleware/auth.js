import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { JWT_SECRET } from "../db.js";
import { fail } from "../utils.js";

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
}

function parseAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(h.slice(7), JWT_SECRET);
  } catch {
    return null;
  }
}

// 需要登录
// 注意：Express 4 不捕获 async 中间件的 rejection，这里必须自行 try/catch，
// 否则数据库抖动时请求会永久挂起（客户端无响应 + 仅剩一条 unhandledRejection 日志）。
export async function authRequired(req, res, next) {
  try {
    const payload = parseAuth(req);
    if (!payload) return fail(res, "未登录或登录已过期", 401);
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [payload.id]);
    const user = rows[0];
    if (!user) return fail(res, "用户不存在", 401);
    if (user.status !== 1) return fail(res, "账号已被禁用", 403);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// 需要管理员
export function adminRequired(req, res, next) {
  authRequired(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role < 100) return fail(res, "需要管理员权限", 403);
    next();
  });
}
