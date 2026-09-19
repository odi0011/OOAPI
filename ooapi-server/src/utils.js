import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

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
  // 统一走 req.ip（由 Express 依据 trust proxy 计算），
  // 不能直接信任客户端可伪造的 X-Forwarded-For 首值。
  const ip = req.ip || req.socket?.remoteAddress || "";
  return String(ip).replace("::ffff:", "").replace(/^::1$/, "127.0.0.1");
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

/**
 * 解析整数并限定范围；非法（NaN/Infinity/超界/非整数）返回 fallback（默认 null）。
 * mysql2 对 number 不加引号拼接，Infinity 会变成 `WHERE id = Infinity` 直接 500。
 */
export function safeInt(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * 解析路径参数中的正整数 id。
 * 非数字（/api/token/abc）时 mysql2 会把 NaN 转义成字面量 NaN，SQL 语法错误 → 500；
 * 返回 null 让调用方回 404。
 */
export function idParam(req, name = "id") {
  const n = Number(req.params?.[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 安全分页参数：防 NaN / Infinity / 超大页码。
 * 注意 Number("Infinity") 是合法数字，直接算 OFFSET 会让 mysql2 转义报错（500）。
 */
export function pageParams(query = {}, defaultSize = 20) {
  const rawP = Number(query.p);
  const rawS = Number(query.page_size);
  const p = Number.isSafeInteger(rawP) && rawP > 0 ? Math.min(rawP, 1_000_000) : 1;
  const size = Number.isSafeInteger(rawS) && rawS > 0 ? Math.min(rawS, 100) : defaultSize;
  return { p, size, offset: (p - 1) * size };
}

/**
 * 从 User-Agent 解析出可读设备串（零依赖：不需要 ua-parser 之类，日志展示够用）。
 * 为什么不用现成库：只在日志里展示「什么浏览器 + 什么系统」，
 * 引入完整 UA 库（含几万条设备指纹）对一个日志字段来说不划算。
 * @returns {string} 形如 "Chrome 131 · Windows"；识别不出时返回 "未知设备"
 */
export function deviceFromUa(ua) {
  const s = String(ua || "");
  if (!s) return "";
  // 浏览器：顺序敏感 —— Edge/OPR 的 UA 里都含 "Chrome"，必须先判它们
  let browser = "";
  let m;
  if ((m = /Edg(?:e|A|iOS)?\/([\d.]+)/.exec(s))) browser = `Edge ${m[1].split(".")[0]}`;
  else if ((m = /OPR\/([\d.]+)/.exec(s))) browser = `Opera ${m[1].split(".")[0]}`;
  else if ((m = /MicroMessenger\/([\d.]+)/.exec(s))) browser = `微信 ${m[1].split(".")[0]}`;
  else if ((m = /Firefox\/([\d.]+)/.exec(s))) browser = `Firefox ${m[1].split(".")[0]}`;
  else if ((m = /Chrome\/([\d.]+)/.exec(s))) browser = `Chrome ${m[1].split(".")[0]}`;
  else if ((m = /Version\/([\d.]+).*Safari/.exec(s))) browser = `Safari ${m[1].split(".")[0]}`;
  else if (/curl\//i.test(s)) browser = "curl";
  else if (/python-requests|python\/|httpx/i.test(s)) browser = "Python";
  else if (/node-fetch|undici|axios|node\//i.test(s)) browser = "Node.js";
  else if (/okhttp/i.test(s)) browser = "OkHttp";
  else if (/Go-http-client/i.test(s)) browser = "Go";
  else if (/PostmanRuntime/i.test(s)) browser = "Postman";

  // 系统
  let os = "";
  if (/Windows NT 10\.0/i.test(s)) os = "Windows";
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/CrOS/i.test(s)) os = "ChromeOS";
  else if (/Linux/i.test(s)) os = "Linux";

  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(" · ") : "未知设备";
}

export function safeJSONParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------- SSRF 防护（网关图片外链 / 渠道“拉取上游模型”共用）----------
export function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    // 按首 16 位数值判断网段：fe80::/10（链路本地，字符串匹配 "fe80:" 会漏掉 fe90:: 等）、
    // fc00::/7（唯一本地地址，仅匹配 "fc"/"fd" 开头会误判部分主机名式写法）
    const first = parseInt(v.split(":")[0] || "0", 16) || 0;
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xfe00) === 0xfc00) return true;
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return false;
  }
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // 保留 / 内网 / 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

/** 校验 URL 为公网 http(s)，拒绝内网/凭据/非 http 协议 */
export async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("协议不允许");
  if (u.username || u.password) throw new Error("不允许携带凭据");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("目标为内网地址");
  return u;
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
