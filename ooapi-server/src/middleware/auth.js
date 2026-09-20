import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { JWT_SECRET } from "../db.js";
import { fail } from "../utils.js";

export function signToken(user) {
  // tv=令牌版本：改密时 +1，旧令牌立即失效（无状态 JWT 的最小吊销手段）
  return jwt.sign({ id: user.id, role: user.role, tv: Number(user.token_version) || 0 }, JWT_SECRET, { expiresIn: "30d" });
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

/** 轻量预鉴权：只验 JWT 签名、不查库。放在 express.json 之前挡掉匿名/伪造请求的大包解析。 */
export function preAuthJwt(req, res, next) {
  if (!parseAuth(req)) return fail(res, "未登录或登录已过期", 401);
  next();
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
    // 令牌版本不一致（改密/主动吊销后）→ 旧令牌全部失效
    if ((Number(payload.tv) || 0) !== (Number(user.token_version) || 0)) {
      return fail(res, "登录状态已失效，请重新登录", 401);
    }
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

/**
 * 角色分层（全站唯一口径，改动前先看这里）
 * ---------------------------------------------------------------------------
 *   1     普通用户 —— 只能操作自己的资源（令牌、对话、媒体、社区互动）
 *   100   管理员   —— 运营管理：渠道、分组、定价、用户（不能改角色）、
 *                     媒体库回收、社区内容审核、运维监控
 *   1000  超管     —— 系统配置与不可逆操作：站点/外观设置、在线更新、
 *                     管理员任免、清空历史、渠道凭据导出
 *
 * 为什么要有超管而不是「管理员就什么都能干」：
 *   管理员账号是日常运营用的（可能给多人），而「改站点配置 / 在线更新 /
 *   清空全部日志」这类操作出错是**不可逆**的。分层后，日常账号被盗或误操作
 *   也伤不到系统配置层面。role 值只增不减，历史库里的 100 依旧是管理员。
 */
export const ROLE = { USER: 1, ADMIN: 100, SUPER: 1000 };

// 需要超管
export function superRequired(req, res, next) {
  authRequired(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role < ROLE.SUPER) return fail(res, "需要超级管理员权限", 403);
    next();
  });
}

/**
 * 可选登录：带了合法令牌就填充 req.user，没带或无效就当匿名继续。
 *
 * 用在「既要支持登录访问、又要支持签名/公开访问」的端点上：
 * 例如媒体文件的 raw 流（<img> 带不了 Authorization，走签名 query）
 * 与公开头像。用 authRequired 会直接把匿名请求 401 掉，功能就废了。
 */
export async function optionalAuth(req, res, next) {
  const payload = parseAuth(req);
  if (!payload) return next(); // 匿名：交给端点自己的签名校验
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [payload.id]);
    const user = rows[0];
    if (user && user.status === 1 && (Number(payload.tv) || 0) === (Number(user.token_version) || 0)) {
      req.user = user;
    }
  } catch {
    /* 查库失败按匿名处理，由端点决定是否放行 */
  }
  next();
}
