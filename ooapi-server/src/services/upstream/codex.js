// 上游适配器：codex（OpenAI ChatGPT 订阅 · Codex OAuth）
// ===========================================================================
// 协议来源：参考开源项目 CLIProxyAPI（router-for-me/CLIProxyAPI）的 codex 实现，
// 只保留服务端需要的部分（OAuth 刷新 + responses 流式对话）。
//
// 凭据（channels.other）：
//   · access_token   OAuth 访问令牌
//   · refresh_token  刷新令牌（必需，access_token 一小时左右过期）
//   · account_id     ChatGPT 账号 id（从 id_token 的
//                    https://api.openai.com/auth.chatgpt_account_id 解析）
//   · email / expires_at
//
// 上游接口：
//   POST https://chatgpt.com/backend-api/codex/responses
//   头：Authorization Bearer / Originator: codex-tui / Chatgpt-Account-Id / session_id
//   SSE 事件：response.output_text.delta、response.reasoning_summary_text.delta、response.completed
// ---------------------------------------------------------------------------
import { codexIdentity } from "./cli-profile.js";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";

const AUTH_BASE = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const API_BASE = "https://chatgpt.com/backend-api/codex";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const REFRESH_LEAD_S = 300;
const MAX_SSE_BUF = 8 * 1024 * 1024;

function tokenExpiredSoon(other) {
  const exp = Number(other?.expires_at || 0);
  // 无过期信息：有 refresh_token 就先刷一次（刷新后会写入真实 expires_at）
  if (!exp) return Boolean(other?.refresh_token);
  return exp - REFRESH_LEAD_S <= Math.floor(Date.now() / 1000);
}

/** 解析 id_token（不验签，与 CLIProxyAPI 一致）：取 account_id / email */
export function parseIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] || {};
    return {
      account_id: auth.chatgpt_account_id || payload.chatgpt_account_id || "",
      email: payload.email || "",
      plan_type: auth.chatgpt_plan_type || "",
    };
  } catch {
    return {};
  }
}

/** 兼容多种常见导出格式（Codex CLI auth.json / CPA auth 文件 / 裸 token 对象） */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 Codex auth.json 的完整内容）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const t = j.tokens || j.token || j.token_data || j;
  const access_token = String(t.access_token || j.access_token || "").trim();
  const refresh_token = String(t.refresh_token || j.refresh_token || "").trim();
  const id_token = String(t.id_token || j.id_token || "").trim();
  const fromJwt = parseIdToken(id_token);
  const account_id = String(t.account_id || j.account_id || fromJwt.account_id || "").trim();
  const email = String(j.email || t.email || fromJwt.email || "").trim();
  if (!access_token) throw Object.assign(new Error("缺少 access_token"), { code: "LOGIN_BAD_PARAMS" });
  if (!refresh_token) throw Object.assign(new Error("缺少 refresh_token（订阅渠道必须能自动续期）"), { code: "LOGIN_BAD_PARAMS" });
  return { access_token, refresh_token, id_token, account_id, email, plan_type: fromJwt.plan_type || "" };
}

/** 刷新 access_token（表单请求，无需 client_secret）。
 * 并发说明：同一渠道的刷新用 withRefreshLock 合并；刷新前重读 DB 复用别人的结果。 */
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
      // 用最新的 refresh_token（旧快照可能导致 refresh_token_reused）
      channel.other = { ...(channel.other || {}), ...fresh };
    }
    const other = channel?.other || {};
    const refreshToken = String(other.refresh_token || "").trim();
    if (!refreshToken) {
      throw Object.assign(new Error("缺少 refresh_token，请重新导入 Codex 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const reused = /refresh_token_reused|invalid_grant/.test(text);
      throw Object.assign(
        new Error(reused ? "刷新令牌已被使用或失效，请重新登录 Codex" : `刷新 Codex 登录态失败（HTTP ${resp.status}）`),
        { code: "CHANNEL_AUTH_EXPIRED" }
      );
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("刷新响应不是 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
    }
    const patch = {
      access_token: j.access_token || other.access_token,
      refresh_token: j.refresh_token || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
    };
    if (j.id_token) {
      const info = parseIdToken(j.id_token);
      patch.id_token = j.id_token;
      if (info.account_id) patch.account_id = info.account_id;
      if (info.email) patch.email = info.email;
    }
    await persistOtherPatch(channel.id, patch);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

async function ensureToken(channel) {
  if (!channel?.other?.access_token || tokenExpiredSoon(channel.other)) {
    await refreshAuth(channel).catch(async (e) => {
      // 没有 refresh_token 且还有 access_token 时，先让请求自己撞 401 再报错
      if (!channel?.other?.access_token) throw e;
      console.warn(`[codex] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel.other?.access_token || "");
}

/** 带 401 自动刷新重试的请求包装 */
async function fetchWithAuthRetry(channel, buildInit, url) {
  const token = await ensureToken(channel);
  let resp = await fetch(url, buildInit(token)).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 Codex 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  });
  if (resp.status === 401 && channel?.other?.refresh_token) {
    console.warn("[codex] 上游 401，刷新登录态后重试一次");
    await refreshAuth(channel, { force: true }).catch(() => {});
    const retryToken = String(channel?.other?.access_token || token);
    if (retryToken && retryToken !== token) {
      resp = await fetch(url, buildInit(retryToken)).catch((e) => {
        if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
        throw Object.assign(new Error(`无法连接 Codex 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
      });
    }
  }
  return resp;
}

/** 导入凭据（管理端「粘贴凭据」）：返回 { token, other, accountLabel } */
export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    account_id: cred.account_id,
    email: cred.email,
    plan_type: cred.plan_type,
    expires_at: 0, // 未知：首次请求前会刷新一次
  };
  if (cred.id_token) other.id_token = cred.id_token;
  return { token: cred.access_token, other, accountLabel: cred.email || cred.account_id || "" };
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function toResponsesInput(messages, images) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") continue; // 系统提示走 instructions
    const role = m.role === "assistant" ? "assistant" : "user";
    const contentType = role === "assistant" ? "output_text" : "input_text";
    out.push({ type: "message", role, content: [{ type: contentType, text: String(m.content ?? "") }] });
  }
  if (images?.length) {
    // 图片挂在最后一条 user 消息上
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        for (const img of images) {
          const mime = img.mimeType || "image/png";
          out[i].content.push({
            type: "input_image",
            image_url: `data:${mime};base64,${img.buffer.toString("base64")}`,
          });
        }
        break;
      }
    }
  }
  return out.length ? out : [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }];
}

function extractInstructions(messages) {
  const sys = (messages || []).filter((m) => m && m.role === "system").map((m) => String(m.content ?? ""));
  return sys.join("\n\n");
}

export async function chat({
  channel,
  model,
  prompt,
  messages,
  thinkingOverride,
  images = [],
  onDelta,
  onReasoning,
  signal,
}) {
  const identity = codexIdentity(channel);
  const input = messages?.length
    ? toResponsesInput(messages, images)
    : toResponsesInput([{ role: "user", content: prompt }], images);
  const body = {
    model,
    instructions: extractInstructions(messages) || "",
    input,
    stream: true,
    store: false,
    prompt_cache_key: identity.sessionId,
    client_metadata: {
      "x-codex-installation-id": identity.installationId,
      "x-codex-window-id": identity.windowId,
    },
  };
  // 深度思考：显式开启时请求推理摘要（默认交给上游模型默认档）
  if (thinkingOverride === true) body.reasoning = { effort: "medium", summary: "auto" };

  const buildInit = (token) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      originator: "codex-tui",
      "user-agent": identity.userAgent,
      session_id: identity.sessionId,
      ...(channel?.other?.account_id ? { "chatgpt-account-id": String(channel.other.account_id) } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const resp = await fetchWithAuthRetry(channel, buildInit, `${API_BASE}/responses`);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || msg;
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
    throw Object.assign(new Error(`Codex 上游 HTTP ${resp.status}：${msg}`), { code });
  }
  if (!resp.body) throw Object.assign(new Error("Codex 上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

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
    if (type === "response.reasoning_summary_text.delta") {
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
          prompt_tokens: Number(r.usage.input_tokens) || 0,
          completion_tokens: Number(r.usage.output_tokens) || 0,
          total_tokens: Number(r.usage.total_tokens) || 0,
          cached_tokens: Number(r.usage.input_tokens_details?.cached_tokens) || 0,
        };
      }
      // 兜底：某些中转/网关不发 delta，只在 completed 里带完整 output
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
      const msg = obj.response?.error?.message || obj.error?.message || obj.message || "Codex 上游返回错误事件";
      throw Object.assign(new Error(msg), { code: "CHANNEL_BIZ_ERROR" });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("Codex 数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
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
    if (buf.trim().startsWith("data:")) {
      try {
        handleEvent(JSON.parse(buf.trim().slice(5).trim()));
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const finalContent = content || finalOutput;
  if (!finalContent) {
    throw Object.assign(new Error(reasoning ? "Codex 只返回了思考内容，没有正文" : "Codex 返回空内容"), {
      code: "CHANNEL_EMPTY",
    });
  }
  return { content: finalContent, reasoning, usage, upstreamModel };
}

/** 健康检查：确认能取到凭据并完成一次最小请求 */
export async function verify(channel) {
  const started = Date.now();
  const identity = codexIdentity(channel);
  const buildInit = (token) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      originator: "codex-tui",
      "user-agent": identity.userAgent,
      session_id: identity.sessionId,
      ...(channel?.other?.account_id ? { "chatgpt-account-id": String(channel.other.account_id) } : {}),
    },
    body: JSON.stringify({
      model: channel?.other?.test_model || "gpt-5-mini",
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
      stream: true,
      store: false,
      prompt_cache_key: identity.sessionId,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const resp = await fetchWithAuthRetry(channel, buildInit, `${API_BASE}/responses`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const code =
      resp.status === 401 ? "CHANNEL_AUTH_EXPIRED" : resp.status === 429 ? "CHANNEL_RATE_LIMIT" : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Codex 健康检查失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), { code });
  }
  // 读掉首帧即可确认凭据有效，然后立即断开
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

/** 该适配器支持的登录方式：订阅渠道统一用「粘贴凭据 JSON」 */
export function loginModes() {
  return ["paste"];
}

/** 可选的官方 OAuth 授权地址（管理端提示管理员在官方 CLI 登录后复制 auth.json） */
export function authHint() {
  return `官方 OAuth 授权入口：${AUTH_BASE}/oauth/authorize（client_id=${CLIENT_ID}，redirect_uri=${REDIRECT_URI}）。` +
    "推荐做法：本机运行 Codex CLI 登录后，把 ~/.codex/auth.json 内容粘贴到这里。";
}

export { REFRESH_LEAD_S };
