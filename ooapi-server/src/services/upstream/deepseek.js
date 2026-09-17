// 上游适配器：deepseek（DeepSeek —— 平台特色能力）
// ---------------------------------------------------------------------------
// 一个 DeepSeek 账号 = channels 表一行 type='deepseek'：
//   · api_key          → 登录态 token（平台内登录后自动写入）
//   · other.profile    → 设备指纹（持久化，同一账号永不变）
//   · other.cookies    → 浏览器 cookies
//   · other.credentials→ 可选：账号密码，用于描述来源（不存明文密码）
//
// 对外即 deepseek-flash，价格与官方一致。能力：
//   · 原生多模态（直接传图，无需专用视觉模型）
//   · thinking_enabled 深度思考开关
//   · search_enabled   联网搜索开关
// ---------------------------------------------------------------------------
import { solvePow, buildPowHeader } from "../deepseek/pow.js";
import { createDeepSeekParser } from "./deepseek-parser.js";
import { resolveModel } from "./deepseek-models.js";
import { resolveProfile, buildHeaders, buildCookie, generateProfile } from "./deepseek-profile.js";

const BASE = "https://chat.deepseek.com";
const API = BASE + "/api/v0";

function wafBlocked(resp, text) {
  return (
    resp.status === 202 ||
    resp.status === 403 ||
    resp.status === 405 ||
    text.includes("Request Blocked") ||
    text.includes("Rate Limit Reached") ||
    text.includes("x-amzn-waf-action") ||
    text.includes("The request could not be satisfied")
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 指纹上下文
function ctx(channel) {
  const { profile, needPersist } = resolveProfile(channel);
  const cookie = buildCookie(channel);
  return {
    profile,
    needPersist,
    cookie,
    headers: (token, opts) => {
      const h = buildHeaders(channel, profile, token, opts);
      if (cookie) h.cookie = cookie;
      return h;
    },
  };
}

// ---------- 平台内登录（账号密码）----------
// 管理员在后台填手机/邮箱 + 密码即可登录，无需手动去浏览器抓登录态。
export async function loginWithPassword({ mobile, email, password, areaCode = "+86", profileSeed }) {
  if (!password) throw Object.assign(new Error("请填写密码"), { code: "LOGIN_BAD_PARAMS" });
  if (!mobile && !email) throw Object.assign(new Error("请填写手机号或邮箱"), { code: "LOGIN_BAD_PARAMS" });

  const seed = profileSeed || email || `${areaCode}${mobile}`;
  const profile = generateProfile(seed);

  const body = {
    email: email || "",
    mobile: mobile || "",
    area_code: areaCode || "+86",
    password,
    device_id: profile.deviceId,
    os: "web",
  };

  const headers = buildHeaders({ other: {} }, profile, null, { referer: `${BASE}/sign_in` });
  headers["content-type"] = "application/json";

  let resp;
  try {
    resp = await fetch(`${API}/users/login`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw Object.assign(new Error(`登录请求失败：${e.message}`), { code: "LOGIN_NETWORK" });
  }

  const text = await resp.text();
  if (wafBlocked(resp, text)) {
    throw Object.assign(new Error(`登录被 WAF 拦截（HTTP ${resp.status}），请稍后重试`), { code: "LOGIN_WAF" });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`登录返回异常（HTTP ${resp.status}）`), { code: "LOGIN_BAD_RESPONSE" });
  }

  const code = json?.data?.biz_code ?? json?.code;
  const msg = json?.data?.biz_msg ?? json?.msg ?? "";

  if (code !== 0 && code !== undefined) {
    const needCaptcha = /captcha|验证码|verify|风控|risk/i.test(msg);
    const hint = needCaptcha
      ? "（触发了验证码/风控，请改用「粘贴登录态」方式添加）"
      : /password|密码|account/i.test(msg)
        ? "（账号或密码不正确）"
        : "";
    throw Object.assign(new Error(`登录失败：${msg || "未知原因"}${hint}`), {
      code: needCaptcha ? "LOGIN_CAPTCHA" : "LOGIN_FAILED",
      bizCode: code,
    });
  }

  const token = json?.data?.biz_data?.user?.token ?? json?.data?.biz_data?.token;
  if (!token) {
    throw Object.assign(new Error("登录成功但未返回 token，请改用「粘贴登录态」方式"), { code: "LOGIN_NO_TOKEN" });
  }

  let cookies = [];
  try {
    cookies = resp.headers.getSetCookie?.() ?? [];
  } catch {
    cookies = [];
  }
  // getSetCookie 返回 "name=value; Path=/; ..." 形式的整串，这里解析成对象数组
  const cookieList = cookies
    .map((c) => {
      const [pair] = String(c).split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) return null;
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter(Boolean);

  return { token, profile, cookies: cookieList, user: json?.data?.biz_data?.user ?? null };
}

// ---------- 业务错误 ----------
function assertBiz(json, what) {
  const bizCode = json?.data?.biz_code ?? json?.code;
  if (bizCode === 0 || bizCode === undefined) return;
  const bizData = json?.data?.biz_data ?? {};

  if (bizCode === 40002 || bizCode === 40003 || bizCode === 401) {
    throw Object.assign(new Error(`${what}失败：登录态已失效，请在渠道管理中重新登录该账号`), {
      code: "CHANNEL_AUTH_EXPIRED",
      bizCode,
    });
  }
  if (bizCode === 5 || bizData.is_muted === 1 || /muted/i.test(json?.data?.biz_msg ?? "")) {
    const untilSec = Number(bizData.mute_until || 0);
    const untilStr = untilSec
      ? new Date(untilSec * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "未知";
    throw Object.assign(new Error(`该账号被风控限制，预计恢复 ${untilStr}`), {
      code: "CHANNEL_MUTED",
      bizCode,
      muteUntil: untilSec,
    });
  }
  throw Object.assign(
    new Error(`${what}失败：${json?.data?.biz_msg ?? json?.msg ?? "未知错误"}（${bizCode}）`),
    { code: "CHANNEL_BIZ_ERROR", bizCode }
  );
}

async function dsFetch(channel, path, { method = "GET", body, maxRetries = 2, signal } = {}) {
  const token = channel.api_key;
  if (!token) throw Object.assign(new Error("渠道未配置登录态"), { code: "CHANNEL_AUTH_EXPIRED" });

  const c = ctx(channel);
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
    let resp;
    try {
      const h = c.headers(token);
      if (body !== undefined) h["content-type"] = "application/json";
      resp = await fetch(API + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
      }
      lastErr = Object.assign(new Error(`网络错误：${e.message}`), { code: "CHANNEL_NETWORK" });
      continue;
    }
    const text = await resp.text();
    if (wafBlocked(resp, text)) {
      lastErr = Object.assign(new Error(`请求被上游拦截（HTTP ${resp.status}）`), { code: "CHANNEL_WAF" });
      continue;
    }
    // 按 HTTP 状态映射为可重试错误（否则 429/5xx 会被当成业务错误而不换渠道）
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error(`上游拒绝鉴权（HTTP ${resp.status}），请在渠道管理中重新登录该账号`), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    if (resp.status === 429) {
      lastErr = Object.assign(new Error("上游频率限制（HTTP 429）"), { code: "CHANNEL_RATE_LIMIT" });
      continue;
    }
    if (resp.status >= 500) {
      lastErr = Object.assign(new Error(`上游异常（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`上游返回非 JSON（HTTP ${resp.status}）`), { code: "CHANNEL_BAD_RESPONSE" });
    }
    return json;
  }
  throw lastErr;
}

export async function createSession(channel) {
  const json = await dsFetch(channel, "/chat_session/create", { method: "POST", body: {} });
  assertBiz(json, "创建会话");
  const biz = json.data?.biz_data ?? {};
  const id = biz.id ?? biz.chat_session?.id;
  if (!id) throw Object.assign(new Error("创建会话失败：缺少会话 ID"), { code: "CHANNEL_BAD_RESPONSE" });
  return id;
}

async function powHeader(channel, targetPath) {
  const json = await dsFetch(channel, "/chat/create_pow_challenge", {
    method: "POST",
    body: { target_path: targetPath },
  });
  assertBiz(json, "获取验证挑战");
  const challenge = json.data?.biz_data?.challenge;
  if (!challenge) throw Object.assign(new Error("验证挑战响应异常"), { code: "CHANNEL_BAD_RESPONSE" });
  challenge.target_path = targetPath;
  return buildPowHeader(challenge, await solvePow(challenge));
}

// 页面预热：模拟真实用户打开页面时的配置请求。
// 纯 API 客户端从不请求这些接口，是可被识别的特征。
export async function warmup(channel) {
  try {
    await dsFetch(channel, "/client/settings", { method: "GET", maxRetries: 0 });
  } catch {
    /* 预热失败不影响主流程 */
  }
}

export async function uploadImage(channel, { buffer, filename, mimeType }) {
  const pow = await powHeader(channel, "/api/v0/file/upload_file");
  const c = ctx(channel);
  const h = c.headers(channel.api_key);
  h["x-ds-pow-response"] = pow;
  delete h["content-type"]; // 由 fetch 生成 multipart boundary

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const resp = await fetch(API + "/file/upload_file", { method: "POST", headers: h, body: form });
  const text = await resp.text();
  if (wafBlocked(resp, text)) {
    throw Object.assign(new Error("图片上传被上游拦截"), { code: "CHANNEL_WAF" });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("图片上传返回异常"), { code: "CHANNEL_BAD_RESPONSE" });
  }
  assertBiz(json, "上传图片");
  const biz = json.data?.biz_data ?? {};
  const id = biz.id ?? biz.file_id ?? biz.file?.id;
  if (!id) throw Object.assign(new Error("图片上传失败：缺少文件 ID"), { code: "CHANNEL_BAD_RESPONSE" });
  return id;
}

/**
 * 执行一次完整对话
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
  onSearchStatus,
  signal,
}) {
  const resolved = resolveModel(model);
  const thinking = thinkingOverride !== undefined ? Boolean(thinkingOverride) : resolved.thinking;

  if (images.length && !resolved.vision) {
    throw Object.assign(
      new Error(`模型 ${resolved.model} 不支持图片输入，请改用 deepseek-flash（原生多模态）`),
      { code: "VISION_NOT_SUPPORTED" }
    );
  }

  await warmup(channel);
  const sessionId = await createSession(channel);

  const refFileIds = [];
  for (const img of images) {
    refFileIds.push(await uploadImage(channel, img));
  }

  const pow = await powHeader(channel, "/api/v0/chat/completion");
  const c = ctx(channel);

  const body = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt,
    ref_file_ids: refFileIds,
    thinking_enabled: thinking,
    search_enabled: Boolean(search),
    model_type: resolved.model === "deepseek-v4-pro" ? "expert" : "default",
  };

  const h = c.headers(channel.api_key, { sse: true });
  h["x-ds-pow-response"] = pow;
  h["content-type"] = "application/json";

  const resp = await fetch(API + "/chat/completion", {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
    signal,
  });

  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (resp.status === 202 || resp.status === 403 || ctype.includes("text/html")) {
    throw Object.assign(new Error(`对话请求被上游拦截（HTTP ${resp.status}）`), { code: "CHANNEL_WAF" });
  }
  if (resp.status === 401) {
    throw Object.assign(new Error("登录态已失效（401）"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (resp.status === 422 || ctype.includes("application/json") || ctype.includes("octet-stream")) {
    const t = await resp.text().catch(() => "");
    try {
      const json = JSON.parse(t);
      assertBiz(json, "发送消息");
    } catch (e) {
      if (e.code) throw e;
      throw Object.assign(new Error(`上游返回异常：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
    }
    throw Object.assign(new Error("上游返回未知响应"), { code: "CHANNEL_BAD_RESPONSE" });
  }
  if (!resp.ok && resp.status !== 200) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`上游 HTTP ${resp.status}：${t.slice(0, 160)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  if (!resp.body) throw Object.assign(new Error("上游未返回内容流"), { code: "CHANNEL_HTTP_ERROR" });

  const parser = createDeepSeekParser();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = "";
  let content = "";
  let got = false;

  const handleLine = (line) => {
    const t = line.replace(/\r$/, "");
    if (!t.startsWith("data:")) return;
    const d = parser.push(t.slice(5).trim());
    if (!d) return;
    if (d.reasoning) {
      got = true;
      reasoning += d.reasoning;
      if (onReasoning) onReasoning(d.reasoning);
    }
    if (d.content) {
      got = true;
      content += d.content;
      if (onDelta) onDelta(d.content);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());

  if (parser.searchStatus && onSearchStatus) onSearchStatus(parser.searchStatus);

  if (parser.error && !parser.finished) {
    throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code: "CHANNEL_STREAM_ERROR" });
  }
  if (!got) {
    throw Object.assign(new Error("该账号返回空内容（可能被风控限制）"), { code: "CHANNEL_EMPTY" });
  }

  return {
    reasoning,
    content,
    usage: parser.usage,
    modelType: parser.modelType || body.model_type,
    profileNeedPersist: c.needPersist,
    profile: c.profile,
  };
}

// 健康检查
export async function verify(channel) {
  const started = Date.now();
  await createSession(channel);
  return Date.now() - started;
}

// 组装登录后要写回渠道 other 字段的内容
export function buildOtherAfterLogin({ profile, cookies, account }) {
  const other = { profile: profile || null };
  if (Array.isArray(cookies) && cookies.length) other.cookies = cookies;
  if (account) other.account = account; // 记录登录用的手机/邮箱（脱敏展示用），不存密码
  return other;
}
