// 通用设备指纹（多厂商共用）
// ---------------------------------------------------------------------------
// 目的：让每个账号在厂商侧表现为"一台固定的真实浏览器"，且账号之间互不相同。
// 关键原则（防封基础）：
//   1. 指纹持久化在 channel.other.profile，同一账号永不变化
//      —— 同一账号 UA/平台/版本频繁变化本身就是强风控信号
//   2. UA / sec-ch-ua / sec-ch-ua-platform 必须内部自洽，不造不存在的组合
//   3. deviceId / 设备名等标识由 seed 确定性派生，重启后仍一致
import crypto from "node:crypto";

// 真实存在的浏览器环境组合
const ENVIRONMENTS = [
  {
    platform: "Windows",
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    chUa: (v) => `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
    chUaPlatform: '"Windows"',
    chUaMobile: "?0",
    osName: "Windows",
    cores: [8, 12, 16],
    memory: [8, 16],
  },
  {
    platform: "Windows",
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
    chUa: (v) => `"Chromium";v="${v}", "Not_A Brand";v="24", "Microsoft Edge";v="${v}"`,
    chUaPlatform: '"Windows"',
    chUaMobile: "?0",
    osName: "Windows",
    cores: [8, 12, 16],
    memory: [8, 16],
  },
  {
    platform: "macOS",
    ua: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    chUa: (v) => `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
    chUaPlatform: '"macOS"',
    chUaMobile: "?0",
    osName: "Mac OS X",
    cores: [8, 10, 12],
    memory: [8, 16],
  },
];

const CHROME_VERSIONS = ["139", "140", "141", "142", "143"];

const LOCALES = [
  { locale: "zh-CN", acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8", lang: "zh", timezone: "Asia/Shanghai", tzOffset: "-480" },
  { locale: "zh-CN", acceptLanguage: "zh-CN,zh;q=0.9", lang: "zh", timezone: "Asia/Shanghai", tzOffset: "-480" },
  { locale: "zh-CN", acceptLanguage: "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7", lang: "zh", timezone: "Asia/Shanghai", tzOffset: "-480" },
];

const SCREENS = ["1920x1080", "2560x1440", "1536x864", "1440x900", "1366x768"];

const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

/**
 * 由 seed 确定性生成指纹（同 seed → 同结果，便于账号恢复）
 */
export function generateProfile(seed) {
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const rnd = (i) => hash[i % hash.length] / 255;

  const env = ENVIRONMENTS[Math.floor(rnd(0) * ENVIRONMENTS.length) % ENVIRONMENTS.length];
  const version = pick(CHROME_VERSIONS, rnd(1));
  const loc = pick(LOCALES, rnd(2));

  return {
    platform: env.platform,
    osName: env.osName,
    chromeVersion: version,
    userAgent: env.ua(version),
    secChUa: env.chUa(version),
    secChUaPlatform: env.chUaPlatform,
    secChUaMobile: env.chUaMobile,
    locale: loc.locale,
    acceptLanguage: loc.acceptLanguage,
    lang: loc.lang,
    timezone: loc.timezone,
    timezoneOffset: loc.tzOffset,
    hardwareConcurrency: pick(env.cores, rnd(3)),
    deviceMemory: pick(env.memory, rnd(4)),
    screen: pick(SCREENS, rnd(5)),
    // 设备唯一标识（16 进制，部分厂商用）
    deviceId: crypto.createHash("md5").update(hash).digest("hex"),
    createdAt: Date.now(),
  };
}

/**
 * 取账号指纹：已有则复用，没有则生成
 * @returns {{profile: object, needPersist: boolean}}
 */
export function resolveProfile(channel, { vendor = "" } = {}) {
  const existing = channel?.other?.profile;
  if (existing?.userAgent && (existing.deviceId || existing.kimiDeviceId)) {
    return { profile: existing, needPersist: false };
  }
  const seed = `${vendor}:${channel?.id ?? ""}:${(channel?.api_key || "").slice(0, 24)}`;
  return { profile: generateProfile(seed), needPersist: true };
}

/**
 * 浏览器通用请求头（厂商可在其上追加自己的头）
 * 顺序尽量贴近 Chrome 实际发送顺序
 */
export function buildBrowserHeaders(profile, { origin, referer, accept = "*/*", contentType = null, sse = false } = {}) {
  const h = {};
  h.accept = sse ? "text/event-stream" : accept;
  h["accept-language"] = profile.acceptLanguage;
  h["accept-encoding"] = "gzip, deflate, br, zstd";
  h["sec-ch-ua"] = profile.secChUa;
  h["sec-ch-ua-mobile"] = profile.secChUaMobile;
  h["sec-ch-ua-platform"] = profile.secChUaPlatform;
  h["user-agent"] = profile.userAgent;
  h["sec-fetch-dest"] = "empty";
  h["sec-fetch-mode"] = "cors";
  h["sec-fetch-site"] = "same-origin";
  h.priority = "u=1, i";
  if (origin) h.origin = origin;
  if (referer) h.referer = referer;
  if (contentType) h["content-type"] = contentType;
  return h;
}

/** cookie 串（保持浏览器原始顺序） */
export function buildCookie(channel) {
  const list = channel?.other?.cookies;
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** 归一化 cookie（登录响应里 Set-Cookie 是整串，需解析成对象数组） */
export function parseSetCookie(setCookies) {
  const out = [];
  for (const raw of setCookies || []) {
    const [pair] = String(raw).split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}
