import crypto from "node:crypto";

// 统一响应格式，与 new-api 风格一致
export function ok(res, data = undefined, message = "") {
  return res.json({ success: true, message, data });
}

export function fail(res, message = "操作失败", httpStatus = 400, data = undefined) {
  return res.status(httpStatus).json({ success: false, message, data });
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (
    req.socket?.remoteAddress === "::1" || req.socket?.remoteAddress === "::ffff:127.0.0.1"
      ? "127.0.0.1"
      : (req.socket?.remoteAddress || "").replace("::ffff:", "")
  );
}

export function randomString(len = 16) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export function genApiKey() {
  return "sk-" + crypto.randomBytes(24).toString("hex");
}

export function genAffCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function safeJSONParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// 返回给前端的用户对象（去除敏感字段）
export function userToResponse(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || u.username,
    role: u.role,
    status: u.status,
    email: u.email || "",
    quota: Number(u.quota),
    used_quota: Number(u.used_quota),
    request_count: u.request_count,
    aff_code: u.aff_code,
    group: u.group_name,
    setting: safeJSONParse(u.setting, {}),
    created_time: u.created_time,
    last_login_time: u.last_login_time,
  };
}

export function tokenToResponse(t) {
  return {
    id: t.id,
    name: t.name,
    key: t.key_str,
    status: t.status,
    created_time: t.created_time,
    accessed_time: t.accessed_time,
    expired_time: t.expired_time,
    remain_quota: Number(t.remain_quota),
    unlimited_quota: !!t.unlimited_quota,
    used_quota: Number(t.used_quota),
    model_limits: t.model_limits ? t.model_limits.split(",").filter(Boolean) : [],
    group: t.group_name || "",
  };
}
