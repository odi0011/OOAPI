// 上游适配器：claude-oauth（Anthropic Claude 订阅 · Claude Code OAuth）
// ===========================================================================
// 协议来源：参考开源项目 CLIProxyAPI（router-for-me/CLIProxyAPI）的 Claude Code 实现。
//
// 凭据（channels.other）：
//   · access_token / refresh_token / expires_at
//   · account_uuid / email（来自 /api/oauth/profile）
//   · device_id / session_id 由统一指纹模块按渠道种子派生（不落盘，稳定不变）
//
// 上游：POST https://api.anthropic.com/v1/messages?beta=true
//   —— 必须带 anthropic-beta: claude-code-20250219,oauth-2025-04-20 且注入
//      "You are Claude Code, Anthropic's official CLI for Claude." 身份提示词，
//      否则订阅 OAuth 会被拒绝（这是官方 CLI 的协议要求）。
// ---------------------------------------------------------------------------
import { normalizeContentToText } from "./content-text.js";
import crypto from "node:crypto";
import { claudeIdentity, CLI_VERSIONS } from "./cli-profile.js";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const API_BASE = "https://api.anthropic.com";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_LEAD_S = 300;
const MAX_SSE_BUF = 8 * 1024 * 1024;
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// 与官方 CLI 一致的 axios 头（OAuth 控制面请求）
function axiosHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": `axios/${CLI_VERSIONS.axios}`,
    "accept-encoding": "gzip, compress, deflate, br",
    connection: "close",
  };
}

function tokenExpiredSoon(other) {
  const exp = Number(other?.expires_at || 0);
  if (!exp) return Boolean(other?.refresh_token); // 无过期信息：先刷一次拿真实过期时间
  return exp - REFRESH_LEAD_S <= Math.floor(Date.now() / 1000);
}

/** 把各种来源的时间戳统一成秒：毫秒（>1e12）、ISO 字符串都兼容 */
function toEpochSeconds(raw) {
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 Claude Code 的凭据文件内容）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  // 兼容官方凭据文件（claudeAiOauth）、裸对象与 sub2api 导出（credentials 对象）
  const t = j.claudeAiOauth || j.oauth || j.credentials || j.token || j;
  // 官方 CLI 是 camelCase（accessToken/refreshToken/expiresAt），也兼容 snake_case 与整体凭据文件
  const access_token = String(t.accessToken || t.access_token || j.accessToken || j.access_token || "").trim();
  const refresh_token = String(t.refreshToken || t.refresh_token || j.refreshToken || j.refresh_token || "").trim();
  if (!access_token) throw Object.assign(new Error("缺少 access_token"), { code: "LOGIN_BAD_PARAMS" });
  if (!refresh_token) throw Object.assign(new Error("缺少 refresh_token（订阅渠道必须能自动续期）"), { code: "LOGIN_BAD_PARAMS" });
  return {
    access_token,
    refresh_token,
    expires_at: toEpochSeconds(t.expiresAt || t.expires_at || j.expires_at),
    email: String(j.email || t.email || "").trim(),
    account_uuid: String(j.account_uuid || j.accountUuid || t.accountUuid || "").trim(),
    organization_uuid: String(j.organization_uuid || t.organizationUuid || "").trim(),
  };
}

/** 刷新登录态（JSON 请求，官方 CLI 同款头）；并发用 withRefreshLock 合并 */
export async function refreshAuth(channel, { force = false } = {}) {
  return withRefreshLock(channel, async () => {
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
      throw Object.assign(new Error("缺少 refresh_token，请重新导入 Claude 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
    }
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: axiosHeaders(),
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`刷新 Claude 登录态失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("刷新响应不是 JSON"), { code: "CHANNEL_BAD_RESPONSE" });
    }
    const patch = {
      access_token: j.access_token || other.access_token,
      // 响应可能不带新的 refresh_token，此时沿用旧的
      refresh_token: j.refresh_token || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
    };
    if (j.account?.uuid) patch.account_uuid = j.account.uuid;
    if (j.organization?.uuid) patch.organization_uuid = j.organization.uuid;
    if (j.account?.email_address) patch.email = j.account.email_address;
    // 传入刷新发起时的凭据代次：若期间管理员人工换过凭据，写回会被丢弃（见 auth-store）
    await persistOtherPatch(channel.id, patch, Number(other?.cred_epoch) || 0);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

async function ensureToken(channel) {
  if (!channel?.other?.access_token || tokenExpiredSoon(channel.other)) {
    await refreshAuth(channel).catch((e) => {
      if (!channel?.other?.access_token) throw e;
      console.warn(`[claude-oauth] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel.other?.access_token || "");
}

/** 带 401 自动刷新重试的请求包装 */
async function fetchWithAuthRetry(channel, buildInit, url) {
  const token = await ensureToken(channel);
  let resp = await fetch(url, buildInit(token)).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 Claude 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  });
  if (resp.status === 401 && channel?.other?.refresh_token) {
    console.warn("[claude-oauth] 上游 401，刷新登录态后重试一次");
    await refreshAuth(channel, { force: true }).catch(() => {});
    const retryToken = String(channel?.other?.access_token || token);
    if (retryToken && retryToken !== token) {
      resp = await fetch(url, buildInit(retryToken)).catch((e) => {
        if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
        throw Object.assign(new Error(`无法连接 Claude 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
      });
    }
  }
  return resp;
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    expires_at: cred.expires_at || 0,
    email: cred.email,
    account_uuid: cred.account_uuid,
    organization_uuid: cred.organization_uuid,
  };
  return { token: cred.access_token, other, accountLabel: cred.email || cred.account_uuid || "" };
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function buildClaudeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    // 注意：system 消息由 systemBlocks() 单独处理，这里跳过
    if (!m || typeof m !== "object" || m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = normalizeContentToText(m.content);
    // Anthropic 要求首条为 user 且 user/assistant 严格交替：合并连续同角色
    if (!out.length && role !== "user") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  if (!out.length) out.push({ role: "user", content: "你好" });
  if (out[out.length - 1].role === "assistant") out.push({ role: "user", content: "继续" });
  return out;
}

function injectImages(blocks, images) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role !== "user") continue;
    const arr = Array.isArray(blocks[i].content)
      ? blocks[i].content
      : [{ type: "text", text: normalizeContentToText(blocks[i].content) }];
    for (const img of images) {
      arr.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType || "image/png",
          data: img.buffer.toString("base64"),
        },
      });
    }
    blocks[i].content = arr;
    break;
  }
}

function systemBlocks(messages, model) {
  const blocks = [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }];
  const sys = (messages || []).filter((m) => m && m.role === "system").map((m) => normalizeContentToText(m.content));
  const joined = sys.join("\n\n");
  if (joined) blocks.push({ type: "text", text: joined });
  // Fable 5 要求附带产出说明块（协议要求，非本平台业务）
  if (/fable-5-1/i.test(String(model || ""))) {
    blocks.push({ type: "text", text: "# Reporting outcomes\nReport outcomes faithfully." });
  }
  return blocks;
}

const BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "extended-cache-ttl-2025-04-11",
];

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
  const identity = claudeIdentity(channel);
  const useMessages = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: prompt }];
  const msgBlocks = buildClaudeMessages(useMessages);
  if (images?.length) injectImages(msgBlocks, images);

  const thinking = thinkingOverride === true;
  const body = {
    model,
    max_tokens: thinking ? 16000 : 8192,
    stream: true,
    system: systemBlocks(useMessages, model),
    messages: msgBlocks.length ? msgBlocks : [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    metadata: { user_id: identity.userId },
  };
  if (thinking) body.thinking = { type: "enabled", budget_tokens: 12000 };

  const buildInit = (token) => ({
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_BASE.join(","),
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-lang": "js",
      "x-stainless-async": "async",
      "x-stainless-timeout": "600",
      "x-stainless-package-version": CLI_VERSIONS.claudeStainless,
      "x-stainless-runtime-version": CLI_VERSIONS.claudeRuntime,
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-claude-code-session-id": identity.sessionId,
      // 官方 CLI 每请求生成新的 request id；这个值不用于身份派生
      "x-client-request-id": crypto.randomUUID(),
      accept: "application/json",
      "user-agent": identity.userAgent,
    },
    body: JSON.stringify(body),
    signal,
  });
  const resp = await fetchWithAuthRetry(channel, buildInit, `${API_BASE}/v1/messages?beta=true`);

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
    throw Object.assign(new Error(`Claude 上游 HTTP ${resp.status}：${msg}`), { code });
  }
  if (!resp.body) throw Object.assign(new Error("Claude 上游未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let upstreamModel = model;

  const handleEvent = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const type = String(obj.type || "");
    if (type === "message_start" && obj.message) {
      if (obj.message.model) upstreamModel = obj.message.model;
      const u = obj.message.usage || {};
      const input = Number(u.input_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;
      const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
      usage = {
        // Anthropic 的 input_tokens 不含缓存命中/写入；OpenAI 语义的 prompt 需要相加，
        // 否则缓存命中的长上下文会被少计费（normalizeUsage 还会把 cache 截断到 prompt）
        prompt_tokens: input + cacheRead + cacheCreate,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: cacheRead,
      };
      return;
    }
    if (type === "content_block_delta" && obj.delta) {
      const d = obj.delta;
      if (d.type === "text_delta" && d.text) {
        content += d.text;
        if (onDelta) onDelta(d.text);
      } else if (d.type === "thinking_delta" && d.thinking) {
        reasoning += d.thinking;
        if (onReasoning) onReasoning(d.thinking);
      }
      return;
    }
    if (type === "message_delta") {
      const u = obj.usage || {};
      const outTokens = Number(u.output_tokens);
      if (Number.isFinite(outTokens)) {
        const prompt = usage?.prompt_tokens || 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: outTokens,
          total_tokens: prompt + outTokens,
          cached_tokens: usage?.cached_tokens || 0,
        };
      }
      return;
    }
    if (type === "error") {
      const msg = obj.error?.message || "Claude 上游返回错误事件";
      throw Object.assign(new Error(msg), { code: "CHANNEL_BIZ_ERROR" });
    }
    // ping / message_stop / content_block_start 等无需处理
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUF) {
        throw Object.assign(new Error("Claude 数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
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
    // 收尾：最后一段不带换行符的残帧（常见于 message_delta 的 usage）不能丢，否则少计费
    const tail = buf.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          handleEvent(JSON.parse(payload));
        } catch {
          /* 非 JSON 残帧忽略 */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) {
    throw Object.assign(new Error(reasoning ? "Claude 只返回了思考内容，没有正文" : "Claude 返回空内容"), {
      code: "CHANNEL_EMPTY",
    });
  }
  return { content, reasoning, usage, upstreamModel };
}

/** 健康检查：最小的 messages 调用 */
export async function verify(channel) {
  const started = Date.now();
  const identity = claudeIdentity(channel);
  const body = {
    model: channel?.test_model || channel?.other?.test_model || "claude-haiku-4.5",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
    metadata: { user_id: identity.userId },
  };
  const buildInit = (token) => ({
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_BASE.join(","),
      "x-app": "cli",
      "user-agent": identity.userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const resp = await fetchWithAuthRetry(channel, buildInit, `${API_BASE}/v1/messages?beta=true`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const code =
      resp.status === 401 ? "CHANNEL_AUTH_EXPIRED" : resp.status === 429 ? "CHANNEL_RATE_LIMIT" : "CHANNEL_HTTP_ERROR";
    throw Object.assign(new Error(`Claude 健康检查失败（HTTP ${resp.status}）：${text.slice(0, 200)}`), { code });
  }
  return Date.now() - started;
}

export function loginModes() {
  return ["paste"];
}

/**
 * 拉取该 Claude 订阅账号可用的模型（`GET /v1/models`，与官方 CLI 同一端点）。
 * 必须带 oauth beta 头 —— 缺了会被当成普通 API Key 请求而 401。
 */
export async function fetchUpstreamModels(channel) {
  const token = await ensureToken(channel);
  const resp = await fetch(`${API_BASE}/v1/models?limit=100`, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": claudeIdentity(channel).userAgent,
      "x-app": "cli",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`拉取模型失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
      code: resp.status === 401 ? "CHANNEL_AUTH_EXPIRED" : "CHANNEL_HTTP_ERROR",
    });
  }
  const j = await resp.json().catch(() => null);
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const ids = arr.map((m) => String(m?.id || m?.model || "").trim()).filter(Boolean);
  if (!ids.length) throw new Error("上游没有返回模型列表");
  return [...new Set(ids)].sort();
}

/** 测试探针：真实发送自定义提示词（默认 hi），返回 AI 回复供管理端 tip 展示 */
export async function probe(channel, prompt = "hi") {
  const started = Date.now();
  const model = channel?.test_model || channel?.other?.test_model || "claude-haiku-4.5";
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
