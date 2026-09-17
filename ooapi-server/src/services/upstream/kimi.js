// 上游适配器：kimi（月之暗面 Kimi 网页版）
// ---------------------------------------------------------------------------
// 协议：Connect RPC over HTTP POST
//   端点：https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat
//   头：  Content-Type: application/connect+json
//         Connect-Protocol-Version: 1
//         Authorization: Bearer <JWT>
//         X-Msh-Platform / X-Msh-Device-Id / X-Msh-Session-Id（必需，19 位数字）
//   帧：  [1B flags][4B BE length][JSON]（请求与响应同格式）
//
// 账号 = channels 表一行 type='kimi'：
//   · api_key       → 登录态 JWT（来自 cookie kimi-auth）
//   · other.profile → 设备指纹（设备 id / session id 也在其中）
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { createKimiParser, createFrameDecoder } from "./kimi-parser.js";
import { resolveModel } from "./kimi-models.js";
import { resolveProfile, buildBrowserHeaders, buildCookie } from "./shared-profile.js";

const BASE = "https://www.kimi.com";
const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const MODELS_PATH = "/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 设备标识（19 位数字，持久化在 profile 里）----------
function deviceIds(profile) {
  // 由 profile.deviceId 确定性派生：同一账号每次请求设备号固定（随机变化是强风控信号）
  const seedHash = crypto.createHash("sha256").update(String(profile.deviceId || profile.userAgent || "kimi")).digest();
  const digits = (offset, prefix) => {
    let n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(seedHash[offset + i]);
    return prefix + (n % 10n ** 18n).toString().padStart(18, "0");
  };
  // 首次生成后写入 profile，之后复用（同一账号设备不变）
  if (!profile.mshDeviceId) profile.mshDeviceId = digits(0, "7");
  if (!profile.mshSessionId) profile.mshSessionId = digits(8, "1");
  return { deviceId: profile.mshDeviceId, sessionId: profile.mshSessionId };
}

// ---------- Connect 帧编码 ----------
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function ctx(channel) {
  const { profile, needPersist } = resolveProfile(channel, { vendor: "kimi" });
  const ids = deviceIds(profile);
  return { profile, needPersist, ids, cookie: buildCookie(channel) };
}

function headers(channel, profile, ids, cookie, { token, json = true, referer } = {}) {
  const h = buildBrowserHeaders(profile, {
    origin: BASE,
    referer: referer || BASE + "/",
    accept: "*/*",
    contentType: json ? "application/connect+json" : "application/json",
  });
  h["connect-protocol-version"] = "1";
  h["x-msh-platform"] = "web";
  h["x-msh-device-id"] = ids.deviceId;
  h["x-msh-session-id"] = ids.sessionId;
  h["r-timezone"] = profile.timezone || "Asia/Shanghai";
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  return h;
}

function wafBlocked(resp, text) {
  return (
    resp.status === 202 ||
    resp.status === 403 ||
    /Request Blocked|Rate Limit Reached|x-amzn-waf-action|captcha|verify/i.test(text)
  );
}

function isJwt(t) {
  return /^ey[A-Za-z0-9_-]+\./.test(String(t || ""));
}

// ---------- 健康检查 ----------
export async function verify(channel) {
  const started = Date.now();
  const token = channel.api_key;
  if (!token) throw Object.assign(new Error("渠道未配置登录态"), { code: "CHANNEL_AUTH_EXPIRED" });
  if (!isJwt(token)) {
    throw Object.assign(new Error("登录态格式不正确（需为 JWT，以 eyJ 开头）"), { code: "CHANNEL_AUTH_EXPIRED" });
  }

  const { profile, ids, cookie } = ctx(channel);
  const resp = await fetch(BASE + MODELS_PATH, {
    method: "POST",
    headers: headers(channel, profile, ids, cookie, { token }),
    body: encodeFrame({}),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  const text = buf.toString("utf8");

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效，请重新登录该账号"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (wafBlocked(resp, text)) {
    throw Object.assign(new Error(`请求被上游拦截（HTTP ${resp.status}）`), { code: "CHANNEL_WAF" });
  }
  if (!resp.ok && resp.status !== 200) {
    throw Object.assign(new Error(`上游 HTTP ${resp.status}：${text.slice(0, 150)}`), {
      code: "CHANNEL_HTTP_ERROR",
    });
  }
  return Date.now() - started;
}

// 拉取可用模型（用于后台展示）
export async function fetchUpstreamModels(channel) {
  const { profile, ids, cookie } = ctx(channel);
  const resp = await fetch(BASE + MODELS_PATH, {
    method: "POST",
    headers: headers(channel, profile, ids, cookie, { token: channel.api_key }),
    body: encodeFrame({}),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  const dec = createFrameDecoder();
  const events = dec.push(buf);
  const out = [];
  for (const ev of events) {
    const list = ev.availableModels || ev.models || [];
    for (const m of list) {
      if (m?.scenario) out.push({ scenario: m.scenario, name: m.displayName || m.scenario, thinking: m.thinking });
    }
  }
  return out;
}

/**
 * 执行一次对话
 */
export async function chat({
  channel,
  model,
  prompt,
  thinkingOverride,
  search = false,
  images = [],
  onDelta,
  onReasoning,
  signal,
}) {
  const resolved = resolveModel(model);
  const thinking = thinkingOverride !== undefined ? Boolean(thinkingOverride) : resolved.thinking;

  if (images.length) {
    throw Object.assign(
      new Error("Kimi 渠道暂不支持图片输入（上传需登录态且依赖前端组件），请改用文本"),
      { code: "VISION_NOT_SUPPORTED" }
    );
  }

  const token = channel.api_key;
  if (!token) throw Object.assign(new Error("渠道未配置登录态"), { code: "CHANNEL_AUTH_EXPIRED" });

  const { profile, ids, cookie } = ctx(channel);

  // 请求体（字段名按实测协议）
  const payload = {
    scenario: resolved.scenario,
    tools: search ? [{ type: "TOOL_TYPE_SEARCH", search: {} }] : [],
    message: {
      role: "user",
      blocks: [{ message_id: "", text: { content: prompt } }],
      scenario: resolved.scenario,
    },
    options: { thinking },
  };

  const resp = await fetch(BASE + CHAT_PATH, {
    method: "POST",
    headers: headers(channel, profile, ids, cookie, { token }),
    body: encodeFrame(payload),
    signal,
  });

  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效（401/403），请重新登录该账号"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (resp.status === 202 || ctype.includes("text/html")) {
    throw Object.assign(new Error(`对话请求被上游拦截（HTTP ${resp.status}）`), { code: "CHANNEL_WAF" });
  }
  if (!resp.ok && resp.status !== 200) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`上游 HTTP ${resp.status}：${t.slice(0, 160)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  if (!resp.body) throw Object.assign(new Error("上游未返回内容流"), { code: "CHANNEL_HTTP_ERROR" });

  // content-type 可能是 application/connect+json 或 application/json（错误）
  if (ctype.includes("application/json") && !ctype.includes("connect")) {
    const t = await resp.text().catch(() => "");
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      throw Object.assign(new Error(`上游返回异常：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
    }
    const msg = json?.message || json?.error?.message || JSON.stringify(json).slice(0, 160);
    throw Object.assign(new Error(`上游错误：${msg}`), { code: "CHANNEL_BIZ_ERROR" });
  }

  const decoder = createFrameDecoder();
  const parser = createKimiParser();
  const reader = resp.body.getReader();
  let got = false;

  const consume = (events) => {
    for (const ev of events) {
      const d = parser.handle(ev);
      if (!d) continue;
      if (d.reasoning) {
        got = true;
        if (onReasoning) onReasoning(d.reasoning);
      }
      if (d.content) {
        got = true;
        if (onDelta) onDelta(d.content);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(decoder.push(value));
    if (parser.finished) break;
  }
  consume(decoder.flush());

  if (parser.error) {
    throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code: "CHANNEL_STREAM_ERROR" });
  }
  if (!got) {
    throw Object.assign(new Error("该账号返回空内容（可能未登录或被风控限制）"), { code: "CHANNEL_EMPTY" });
  }

  return {
    reasoning: parser.reasoning,
    content: parser.content,
    usage: parser.usage,
    chatId: parser.chatId,
    profileNeedPersist: ctx(channel).needPersist,
    profile: ctx(channel).profile,
  };
}

// ---------- 登录方式 ----------
// Kimi 支持粘贴 cookie kimi-auth 的值（JWT），无需浏览器
export function loginModes() {
  return ["paste"];
}

/** 校验粘贴的登录态 */
export async function verifyPastedToken({ token }) {
  const t = String(token || "").trim();
  if (!t) throw Object.assign(new Error("请填写登录态 token"), { code: "LOGIN_BAD_PARAMS" });
  if (!isJwt(t)) {
    throw Object.assign(
      new Error("格式不正确：应填写浏览器 cookie 中 kimi-auth 的值（JWT，以 eyJ 开头）"),
      { code: "LOGIN_BAD_PARAMS" }
    );
  }
  const fake = { id: 0, api_key: t, other: {} };
  await verify(fake);
  let account = "已登录";
  try {
    const p = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString("utf8"));
    if (p.email) account = p.email;
    else if (p.id) account = `用户 ${String(p.id).slice(0, 8)}`;
  } catch {
    /* ignore */
  }
  return { token: t, account };
}
