// 上游适配器：grok（xAI Grok 订阅 · OAuth device-code）
// ===========================================================================
// 协议来源：参考开源项目 CLIProxyAPI（router-for-me/CLIProxyAPI）的 xai 实现。
//
// 凭据（channels.other）：
//   · access_token / refresh_token / expires_at / email / sub
//   · auth_kind = "oauth"（订阅）；using_api=true 时改走官方 api.x.ai（可选）
//   · base_url 缺省：OAuth → https://cli-chat-proxy.grok.com/v1（CLI 通道）
//                     API Key → https://api.x.ai/v1
//
// 上游：POST {base}/responses（Responses API，SSE）
//   OAuth 走 CLI 通道时必须带 CLI 身份头（UA/x-grok-client-* 等），
//   否则极易被判定为非官方客户端。身份由统一指纹模块按渠道确定性派生。
//
// 注意：Grok 无 device code 的 refresh 不带 scope；403 bad-credentials 按 401 处理
//（刷新后重试一次）；429 free-usage-exhausted 冷却 24h（免费额度滚动窗口）。
// ---------------------------------------------------------------------------
import { grokIdentity } from "./cli-profile.js";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";

const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const CLI_BASE = "https://cli-chat-proxy.grok.com/v1";
const API_BASE = "https://api.x.ai/v1";
const REFRESH_LEAD_S = 300;
const MAX_SSE_BUF = 8 * 1024 * 1024;
const FREE_USAGE_COOLDOWN_SEC = 86400; // 免费额度按 24h 滚动窗口恢复

function tokenExpiredSoon(other) {
  const exp = Number(other?.expires_at || 0);
  if (!exp) return Boolean(other?.refresh_token);
  return exp - REFRESH_LEAD_S <= Math.floor(Date.now() / 1000);
}

function jwtPayload(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/** 兼容 CPA auth 文件（type:"xai"）/ sub2api 导出（credentials）/ 裸对象 */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 CPA/sub2api 的 Grok 凭据文件）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const t = j.credentials || j.token || j.tokens || j;
  const access_token = String(t.access_token || j.access_token || "").trim();
  const refresh_token = String(t.refresh_token || j.refresh_token || "").trim();
  const api_key = String(t.api_key || j.api_key || "").trim();
  const id_token = String(t.id_token || j.id_token || "").trim();
  const fromJwt = jwtPayload(id_token);
  const kind = String(t.auth_kind || j.auth_kind || "").toLowerCase();
  const isOauth = kind === "oauth" || (!!refresh_token && !api_key);
  if (!api_key && !access_token) {
    throw Object.assign(new Error("缺少 access_token / api_key"), { code: "LOGIN_BAD_PARAMS" });
  }
  if (isOauth && !refresh_token) {
    throw Object.assign(new Error("订阅渠道必须提供 refresh_token（用于自动续期）"), { code: "LOGIN_BAD_PARAMS" });
  }
  const exp = t.expired || t.expires_at || j.expired || j.expires_at || 0;
  const expNum = Number(exp);
  const expires_at = Number.isFinite(expNum) && expNum > 0
    ? Math.floor(expNum > 1e12 ? expNum / 1000 : expNum)
    : (exp ? Math.floor(Date.parse(String(exp)) / 1000) || 0 : 0);
  return {
    kind: isOauth ? "oauth" : "apikey",
    access_token,
    refresh_token,
    api_key,
    id_token,
    expires_at,
    email: String(t.email || j.email || fromJwt.email || "").trim(),
    sub: String(t.sub || j.sub || fromJwt.sub || "").trim(),
    base_url: String(t.base_url || j.base_url || "").trim(),
    using_api: t.using_api === true || j.using_api === true,
  };
}

export async function refreshAuth(channel, { force = false } = {}) {
  return withRefreshLock(channel.id, async () => {
    const fresh = await loadOther(channel.id);
    if (fresh) {
      const freshExp = Number(fresh.expires_at || 0);
      const valid = fresh.access_token && freshExp - REFRESH_LEAD_S > Math.floor(Date.now() / 1000);
      if (!force && valid) {
        channel.other = { ...(channel.other || {}), ...fresh };
        return { access_token: fresh.access_token, expires_at: freshExp };
      }
      channel.other = { ...(channel.other || {}), ...fresh };
    }
    const other = channel?.other || {};
    const refreshToken = String(other.refresh_token || "").trim();
    if (!refreshToken) {
      throw Object.assign(new Error("缺少 refresh_token，请重新导入 Grok 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`刷新 Grok 登录态失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("刷新响应不是 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
    }
    const fromJwt = jwtPayload(j.id_token);
    const patch = {
      access_token: j.access_token || other.access_token,
      refresh_token: j.refresh_token || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
    };
    if (j.id_token) patch.id_token = j.id_token;
    if (fromJwt.email) patch.email = fromJwt.email;
    if (fromJwt.sub) patch.sub = fromJwt.sub;
    await persistOtherPatch(channel.id, patch);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

function chatBase(channel) {
  const other = channel?.other || {};
  if (other.using_api === true) return String(other.base_url || API_BASE).replace(/\/+$/, "");
  const stored = String(other.base_url || "").trim();
  if (stored && !/^https:\/\/api\.x\.ai\/?$/.test(stored)) return stored.replace(/\/+$/, "");
  return CLI_BASE;
}

function isCliProxy(base) {
  return /cli-chat-proxy\.grok\.com/i.test(base);
}

async function ensureToken(channel) {
  if (!channel?.other?.access_token || tokenExpiredSoon(channel.other)) {
    await refreshAuth(channel).catch((e) => {
      if (!channel?.other?.access_token) throw e;
      console.warn(`[grok] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel.other?.access_token || "");
}

function buildHeaders(channel, token, identity, base) {
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    connection: "keep-alive",
    "x-grok-conv-id": identity.sessionId,
  };
  if (isCliProxy(base)) {
    // CLI 通道身份头：缺了会被上游当成非官方客户端
    headers["user-agent"] = identity.userAgent;
    headers["x-grok-client-version"] = identity.clientVersion;
    headers["x-grok-client-identifier"] = "grok-shell";
    headers["x-xai-token-auth"] = "xai-grok-cli";
    headers["x-authenticateresponse"] = "authenticate-response";
  }
  return headers;
}

/** 403 bad-credentials 按 401 处理：刷新后重试一次 */
async function fetchWithAuthRetry(channel, buildInit, url) {
  const token = await ensureToken(channel);
  const doFetch = (t) =>
    fetch(url, buildInit(t)).catch((e) => {
      if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
      throw Object.assign(new Error(`无法连接 Grok 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
    });
  let resp = await doFetch(token);
  let bodyText = "";
  if (resp.status === 401 || resp.status === 403) {
    bodyText = await resp.text().catch(() => "");
    const badCred =
      /bad-credentials|access token could not be validated|invalid[_ ]token/i.test(bodyText) || resp.status === 401;
    if (badCred) {
      console.warn("[grok] 凭据被拒，刷新登录态后重试一次");
      await refreshAuth(channel, { force: true }).catch(() => {});
      const retryToken = String(channel?.other?.access_token || token);
      if (retryToken && retryToken !== token) {
        resp = await doFetch(retryToken);
        if (resp.status === 403) bodyText = await resp.text().catch(() => "");
      }
    } else {
      resp = new Response(bodyText, { status: resp.status, headers: resp.headers });
    }
  }
  return { resp, bodyText };
}

function toResponsesInput(messages, images, fallbackPrompt) {
  const out = [];
  const use = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: fallbackPrompt }];
  for (const m of use) {
    if (!m || typeof m !== "object" || m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const contentType = role === "assistant" ? "output_text" : "input_text";
    out.push({ type: "message", role, content: [{ type: contentType, text: String(m.content ?? "") }] });
  }
  if (images?.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== "user") continue;
      for (const img of images) {
        out[i].content.push({ type: "input_image", image_url: `data:${img.mimeType || "image/png"};base64,${img.buffer.toString("base64")}` });
      }
      break;
    }
  }
  if (!out.length) out.push({ type: "message", role: "user", content: [{ type: "input_text", text: fallbackPrompt || "你好" }] });
  return out;
}

function instructionsOf(messages) {
  return (messages || []).filter((m) => m && m.role === "system").map((m) => String(m.content ?? "")).join("\n\n");
}

export async function chat({ channel, model, prompt, messages, thinkingOverride, images = [], onDelta, onReasoning, signal }) {
  const identity = grokIdentity(channel);
  const base = chatBase(channel);
  const body = {
    model,
    instructions: instructionsOf(messages) || "",
    input: toResponsesInput(messages, images, prompt),
    stream: true,
    store: false,
    prompt_cache_key: identity.sessionId,
    include: ["reasoning.encrypted_content"],
  };
  if (thinkingOverride === true) body.reasoning = { effort: "medium" };

  const buildInit = (token) => ({
    method: "POST",
    headers: buildHeaders(channel, token, identity, base),
    body: JSON.stringify(body),
    signal,
  });
  const { resp, bodyText } = await fetchWithAuthRetry(channel, buildInit, `${base}/responses`);
  if (!resp.ok) {
    const text = bodyText || (await resp.text().catch(() => ""));
    if (resp.status === 429 && /free-usage-exhausted|included free usage/i.test(text)) {
      throw Object.assign(new Error("Grok 免费额度已用尽（24 小时滚动恢复）"), {
        code: "CHANNEL_RATE_LIMIT",
        cooldownSec: FREE_USAGE_COOLDOWN_SEC,
      });
    }
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.error || j?.message || msg;
    } catch {
      /* 保留原始文本 */
    }
    const code =
      resp.status === 401
        ? "CHANNEL_AUTH_EXPIRED"
        : resp.status === 429
          ? "CHANNEL_RATE_LIMIT"
          : [400, 404, 409, 413, 422].includes(resp.status)
            ? "CHANNEL_BAD_REQUEST"
            : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Grok 上游 HTTP ${resp.status}：${msg}`), { code });
  }
  if (!resp.body) throw Object.assign(new Error("Grok 上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let finalOutput = "";
  let upstreamModel = model;

  const handleEvent = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const type = String(obj.type || "");
    if (obj.response?.model) upstreamModel = obj.response.model;
    if (type === "response.output_text.delta") {
      const d = String(obj.delta || "");
      if (d) {
        content += d;
        if (onDelta) onDelta(d);
      }
      return;
    }
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
      const d = String(obj.delta || "");
      if (d) {
        reasoning += d;
        if (onReasoning) onReasoning(d);
      }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.done") {
      const r = obj.response || {};
      if (r.model) upstreamModel = r.model;
      if (r.usage) {
        usage = {
          prompt_tokens: Number(r.usage.input_tokens ?? r.usage.prompt_tokens) || 0,
          completion_tokens: Number(r.usage.output_tokens ?? r.usage.completion_tokens) || 0,
          total_tokens: Number(r.usage.total_tokens) || 0,
          cached_tokens: Number(r.usage.input_tokens_details?.cached_tokens) || 0,
        };
      }
      const parts = [];
      for (const item of r.output || []) {
        for (const c of item?.content || []) {
          if (c?.type === "output_text" && c.text) parts.push(String(c.text));
        }
      }
      finalOutput = parts.join("");
      return;
    }
    if (type === "response.failed" || type === "error") {
      const msg = obj.response?.error?.message || obj.error?.message || obj.message || "Grok 上游返回错误事件";
      throw Object.assign(new Error(msg), { code: "CHANNEL_BIZ_ERROR" });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("Grok 数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      }
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        handleEvent(ev);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const finalContent = content || finalOutput;
  if (!finalContent) {
    throw Object.assign(new Error(reasoning ? "Grok 只返回了思考内容，没有正文" : "Grok 返回空内容"), {
      code: "CHANNEL_EMPTY",
    });
  }
  return { content: finalContent, reasoning, usage, upstreamModel };
}

/** 健康检查：最小 responses 请求，读首帧即断开 */
export async function verify(channel) {
  const started = Date.now();
  const identity = grokIdentity(channel);
  const base = chatBase(channel);
  const model = channel?.test_model || channel?.other?.test_model || "grok-4.5";
  const buildInit = (token) => ({
    method: "POST",
    headers: buildHeaders(channel, token, identity, base),
    body: JSON.stringify({
      model,
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
      stream: true,
      store: false,
      prompt_cache_key: identity.sessionId,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const { resp, bodyText } = await fetchWithAuthRetry(channel, buildInit, `${base}/responses`);
  if (!resp.ok) {
    const text = bodyText || (await resp.text().catch(() => ""));
    const code =
      resp.status === 401 ? "CHANNEL_AUTH_EXPIRED" : resp.status === 429 ? "CHANNEL_RATE_LIMIT" : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Grok 健康检查失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), { code });
  }
  try {
    const reader = resp.body?.getReader();
    if (reader) {
      await reader.read();
      await reader.cancel().catch(() => {});
    }
  } catch {
    /* 读取中断不影响「凭据有效」结论 */
  }
  return Date.now() - started;
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    auth_kind: cred.kind,
    email: cred.email,
    sub: cred.sub,
    base_url: cred.base_url,
    using_api: cred.using_api,
  };
  if (cred.kind === "oauth") {
    other.access_token = cred.access_token;
    other.refresh_token = cred.refresh_token;
    other.expires_at = cred.expires_at || 0;
    if (cred.id_token) other.id_token = cred.id_token;
  } else {
    other.api_key = cred.api_key;
  }
  return { token: cred.kind === "oauth" ? cred.access_token : cred.api_key, other, accountLabel: cred.email || cred.sub || "" };
}

export function loginModes() {
  return ["paste"];
}

/** 测试探针：真实发送自定义提示词（默认 hi），返回 AI 回复供管理端 tip 展示 */
export async function probe(channel, prompt = "hi") {
  const started = Date.now();
  const model = channel?.test_model || channel?.other?.test_model || "grok-4.5";
  const r = await chat({
    channel,
    model,
    prompt,
    messages: [{ role: "user", content: prompt }],
    images: [],
    onDelta: () => {},
    onReasoning: () => {},
  });
  return { ms: Date.now() - started, reply: r.content || "", model, usage: r.usage };
}

export function authHint() {
  return `xAI device-code 授权：${DEVICE_URL}（client_id=${CLIENT_ID}）；` +
    "推荐用官方 Grok CLI 完成登录后，把 CPA/sub2api 导出的凭据粘贴到这里。";
}
