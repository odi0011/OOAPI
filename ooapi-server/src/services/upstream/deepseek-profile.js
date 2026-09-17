// DeepSeek 账号设备指纹
// ---------------------------------------------------------------------------
// 目的：让每个账号在 DeepSeek 侧表现为"一台固定的真实浏览器"，
//       且不同账号之间指纹互不相同 —— 这是降低风控识别概率的核心。
// 关键点：
//   1. 指纹一旦生成就持久化在 channel.other.profile，绝不每次请求随机
//      （同一账号 UA/平台/版本频繁变化本身就是强风控信号）
//   2. UA、sec-ch-ua、sec-ch-ua-platform、x-client-* 必须内部自洽
//   3. device_id 是 DeepSeek 登录接口的必填字段，需要与账号绑定
import crypto from "node:crypto";

// 可选的浏览器环境池（真实存在的组合，避免造出不存在的版本）
const ENVIRONMENTS = [
  {
    platform: "Windows",
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    chUa: (v) => `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="24"`,
    chUaPlatform: '"Windows"',
    chUaMobile: "?0",
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [8, 16],
  },
  {
    platform: "Windows",
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
    chUa: (v) => `"Microsoft Edge";v="${v}", "Chromium";v="${v}", "Not?A_Brand";v="24"`,
    chUaPlatform: '"Windows"',
    chUaMobile: "?0",
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [8, 16],
  },
  {
    platform: "macOS",
    ua: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    chUa: (v) => `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="24"`,
    chUaPlatform: '"macOS"',
    chUaMobile: "?0",
    hardwareConcurrency: [8, 10, 12],
    deviceMemory: [8, 16],
  },
];

// 当前主流 Chrome 版本区间（与实际发布时间匹配，避免用未来版本）
const CHROME_VERSIONS = ["139", "140", "141"];

// 时区/语言池（同一账号固定）
const LOCALES = [
  { locale: "zh_CN", browserLocale: "zh-CN", acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8", tzOffset: "28800" },
  { locale: "zh_CN", browserLocale: "zh-CN", acceptLanguage: "zh-CN,zh;q=0.9", tzOffset: "28800" },
  { locale: "en_US", browserLocale: "en-US", acceptLanguage: "en-US,en;q=0.9,zh-CN;q=0.8", tzOffset: "28800" },
];

function pick(arr, rand) {
  return arr[Math.floor(rand * arr.length) % arr.length];
}

/**
 * 生成一个稳定的账号指纹
 * @param {string|number} seed 账号标识（用 channel id / token 摘要，保证可复现）
 */
export function generateProfile(seed) {
  // 用 seed 派生确定性随机源：同一账号每次生成结果一致，便于恢复
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const rnd = (i) => hash[i % hash.length] / 255;

  const env = ENVIRONMENTS[Math.floor(rnd(0) * ENVIRONMENTS.length) % ENVIRONMENTS.length];
  const version = pick(CHROME_VERSIONS, rnd(1));
  const loc = LOCALES[Math.floor(rnd(2) * LOCALES.length) % LOCALES.length];

  return {
    platform: env.platform,
    chromeVersion: version,
    userAgent: env.ua(version),
    secChUa: env.chUa(version),
    secChUaPlatform: env.chUaPlatform,
    secChUaMobile: env.chUaMobile,
    locale: loc.locale,
    browserLocale: loc.browserLocale,
    acceptLanguage: loc.acceptLanguage,
    timezoneOffset: loc.tzOffset,
    hardwareConcurrency: pick(env.hardwareConcurrency, rnd(3)),
    deviceMemory: pick(env.deviceMemory, rnd(4)),
    // DeepSeek 登录接口必填的设备标识：由 seed 确定性派生，保证同账号固定
    deviceId: crypto.createHash("sha256").update(hash).digest("base64").replace(/[^A-Za-z0-9+/=]/g, "").slice(0, 24),
    // 屏幕尺寸（部分上报接口会带）
    screen: pick(["1920x1080", "2560x1440", "1536x864", "1440x900"], rnd(5)),
    createdAt: Date.now(),
  };
}

/**
 * 取账号指纹：已有则复用，没有则生成并返回 needPersist 标记
 */
export function resolveProfile(channel) {
  const existing = channel?.other?.profile;
  if (existing && existing.userAgent && existing.deviceId) {
    return { profile: existing, needPersist: false };
  }
  const seed = `${channel?.id ?? ""}:${(channel?.api_key || "").slice(0, 24)}`;
  return { profile: generateProfile(seed), needPersist: true };
}

/**
 * 构造与真实浏览器一致的请求头（顺序按 Chrome 实际发送顺序排列）
 */
export function buildHeaders(channel, profile, token, { sse = false, referer } = {}) {
  const h = {};
  // Chrome 的实际发送顺序：host → connection → sec-ch-ua → ... → user-agent → accept → ...
  h["sec-ch-ua"] = profile.secChUa;
  h["sec-ch-ua-mobile"] = profile.secChUaMobile;
  h["sec-ch-ua-platform"] = profile.secChUaPlatform;
  h["upgrade-insecure-requests"] = "1";
  h["user-agent"] = profile.userAgent;
  h.accept = sse
    ? "text/event-stream"
    : "application/json, text/plain, */*";
  h["sec-fetch-site"] = "same-origin";
  h["sec-fetch-mode"] = "cors";
  h["sec-fetch-dest"] = "empty";
  h["accept-encoding"] = "gzip, deflate, br, zstd";
  h["accept-language"] = profile.acceptLanguage;
  h.origin = "https://chat.deepseek.com";
  if (referer !== null) h.referer = referer || "https://chat.deepseek.com/";
  h["x-client-bundle-id"] = "chat_web";
  h["x-client-platform"] = "web";
  h["x-client-version"] = "2.4.0";
  h["x-client-locale"] = profile.locale;
  h["x-client-timezone-offset"] = profile.timezoneOffset;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * cookie 串（保持浏览器里的顺序，避免顺序变化被识别）
 */
export function buildCookie(channel) {
  const list = channel?.other?.cookies;
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
