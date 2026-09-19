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
import { solvePow, buildPowHeader } from "./deepseek-pow.js";
import { createDeepSeekParser } from "./deepseek-parser.js";
import { resolveModel, CHANNEL_MODELS } from "./deepseek-models.js";
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

// 风控/限流的冷却时长：风控通常需要人工处理（等待或换号），
// 给足时间让它真正"冷下来"，避免冷却一过就再撞一次把临时限制升级成封禁。
const WAF_COOLDOWN_SEC = 6 * 3600;      // 6 小时
const RATE_LIMIT_COOLDOWN_SEC = 15 * 60; // 15 分钟

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
    // 登录是管理员一次性操作，但也不能无限挂起占住请求
    resp = await fetch(`${API}/users/login`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
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
    // 冷却到上游解禁为止（上限 24h）；拿到 mute_until 时按它来，避免过早重试
    const waitSec = untilSec ? Math.max(60, untilSec - Math.floor(Date.now() / 1000)) : WAF_COOLDOWN_SEC;
    throw Object.assign(new Error(`该账号被风控限制，预计恢复 ${untilStr}`), {
      code: "CHANNEL_MUTED",
      bizCode,
      muteUntil: untilSec,
      cooldownSec: Math.min(24 * 3600, waitSec),
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
  // 单次请求硬超时：execute 的超时只会 abort 传入的 signal，而创建会话/PoW 等
  // 子请求如果不带 signal 就会无限挂起。这里每个子请求都要有自己的时限。
  const SUB_TIMEOUT = 60_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
    let resp;
    const ctrl = new AbortController();
    const sub = setTimeout(() => ctrl.abort(), SUB_TIMEOUT);
    const onOuter = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onOuter, { once: true });
    }
    try {
      const h = c.headers(token);
      if (body !== undefined) h["content-type"] = "application/json";
      resp = await fetch(API + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
      if (e.name === "AbortError") {
        lastErr = Object.assign(new Error(`上游请求超时（${SUB_TIMEOUT}ms）`), { code: "CHANNEL_TIMEOUT" });
        continue;
      }
      lastErr = Object.assign(new Error(`网络错误：${e.message}`), { code: "CHANNEL_NETWORK" });
      continue;
    } finally {
      clearTimeout(sub);
      if (signal) signal.removeEventListener("abort", onOuter);
    }
    const text = await resp.text();
    // WAF / 鉴权类响应必须在重试判断**之前**处理：
    // 它们代表「这个账号现在被上游盯上了」，连续重试只会加速封号。
    // 历史 bug：wafBlocked() 里含 403，导致下面的 403 → AUTH_EXPIRED 分支永远不可达，
    // 风控响应被当成可重试错误打了 3 次（冷却还只有 300s）。这里改成：命中即隔离。
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error(`上游拒绝鉴权（HTTP ${resp.status}），请在渠道管理中重新登录该账号`), {
        code: "CHANNEL_AUTH_EXPIRED",
        upstream: text.slice(0, 500),
      });
    }
    if (wafBlocked(resp, text)) {
      // 202/405/风控文案：不重试，交给 execute 换账号并长时间冷却
      throw Object.assign(new Error(`请求被上游风控拦截（HTTP ${resp.status}），该账号已暂停使用`), {
        code: "CHANNEL_WAF",
        cooldownSec: WAF_COOLDOWN_SEC,
        upstream: text.slice(0, 500),
      });
    }
    if (resp.status === 429) {
      // 限流同样不原地重试：同一账号连续打只会让限流升级为封禁
      throw Object.assign(new Error("上游频率限制（HTTP 429），该账号已临时冷却"), {
        code: "CHANNEL_RATE_LIMIT",
        cooldownSec: RATE_LIMIT_COOLDOWN_SEC,
      });
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

export async function uploadImage(channel, { buffer, filename, mimeType }, signal) {
  const pow = await powHeader(channel, "/api/v0/file/upload_file");
  const c = ctx(channel);
  const h = c.headers(channel.api_key);
  h["x-ds-pow-response"] = pow;
  delete h["content-type"]; // 由 fetch 生成 multipart boundary

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  // 上传必须有自己的时限并透传外层 signal，否则 execute 硬超时后子请求仍会挂住 socket
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  const onOuter = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  let resp;
  try {
    resp = await fetch(API + "/file/upload_file", { method: "POST", headers: h, body: form, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw Object.assign(new Error("图片上传超时或被取消"), { code: signal?.aborted ? "CHANNEL_ABORTED" : "CHANNEL_TIMEOUT" });
    }
    throw Object.assign(new Error(`图片上传失败：${e.message}`), { code: "CHANNEL_NETWORK" });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuter);
  }
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
    refFileIds.push(await uploadImage(channel, img, signal));
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
  let gotContent = false;

  const handleLine = (line) => {
    const t = line.replace(/\r$/, "");
    if (!t.startsWith("data:")) return;
    const d = parser.push(t.slice(5).trim());
    if (!d) return;
    if (d.reasoning) {
      reasoning += d.reasoning;
      if (onReasoning) onReasoning(d.reasoning);
    }
    if (d.content) {
      gotContent = true;
      content += d.content;
      if (onDelta) onDelta(d.content);
    }
  };

  const MAX_SSE_BUF = 8 * 1024 * 1024; // 单行缓冲上限，防异常上游撑爆内存
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("上游数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
  } finally {
    // 回调抛错/客户端断开都要归还连接，否则响应体悬挂
    reader.cancel().catch(() => {});
  }

  if (parser.searchStatus && onSearchStatus) onSearchStatus(parser.searchStatus);

  if (parser.error) {
    // 错误帧即使与 FINISHED 同到也要报错：吞掉会把半截回答当成功计费
    throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code: "CHANNEL_STREAM_ERROR" });
  }
  if (!gotContent) {
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

/**
 * 「上游可用模型」——网页版没有列模型的接口（模型档位由页面默认值决定，
 * 不在请求参数里），所以这里返回的是**本适配器能驱动的模型集合**。
 * 与订阅渠道的「问上游要清单」语义不同，前端会标注来源（capability vs upstream），
 * 避免管理员误以为这是账号的实际可见档位。
 */
export async function fetchUpstreamModels() {
  return CHANNEL_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
}
