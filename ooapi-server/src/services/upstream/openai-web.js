// 上游适配器：openai-web（OpenAI 网页版反代 · ChatGPT Web）
// ===========================================================================
// 协议来源：开源社区 chat2api / ChatGPT-to-API 系列（lanqian528、xqdoo00o 等）：
//   · 凭据：chatgpt.com 的 access_token（登录后 https://chatgpt.com/api/auth/session 获取）
//   · 对话：POST https://chatgpt.com/backend-api/conversation（SSE）
//   · 部分号需要 sentinel/arkose 校验（上游会 403），此适配器显式报错而不是假装成功
// access_token 过期（网页 token 约 10 天）后走「重新登录」找回；有 refresh_token 时自动续期。
import crypto from "node:crypto";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";
import { parseAuthJson, webModelId } from "./openai-web-parse.js";

const BASE = "https://chatgpt.com";
const REFRESH_URL = "https://auth0.openai.com/oauth/token";
// chat2api 使用的公开客户端（网页版刷新用；非机密）
const WEB_CLIENT_ID = "pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function jwtExp(accessToken) {
  try {
    const p = JSON.parse(Buffer.from(String(accessToken).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number(p.exp) || 0;
  } catch {
    return 0;
  }
}

/** 刷新网页版 token（有 refresh_token 时）；失败抛 CHANNEL_AUTH_EXPIRED 交给找回流程 */
export async function refreshAuth(channel, { force = false } = {}) {
  return withRefreshLock(channel.id, async () => {
    const fresh = await loadOther(channel.id);
    if (fresh) channel.other = { ...(channel.other || {}), ...fresh };
    const other = channel?.other || {};
    const exp = jwtExp(other.access_token);
    if (!force && other.access_token && exp && exp - 300 > Math.floor(Date.now() / 1000)) {
      return { access_token: other.access_token, expires_at: exp };
    }
    const rt = String(other.refresh_token || "").trim();
    if (!rt) {
      throw Object.assign(new Error("网页版 access_token 已过期，请用「重新登录」粘贴新的凭据"), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    const resp = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ client_id: WEB_CLIENT_ID, grant_type: "refresh_token", refresh_token: rt }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`刷新网页版登录态失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
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
      refresh_token: j.refresh_token || rt,
    };
    // 传入刷新发起时的凭据代次：若期间管理员人工换过凭据，写回会被丢弃（见 auth-store）
    await persistOtherPatch(channel.id, patch, Number(other?.cred_epoch) || 0);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

async function ensureToken(channel) {
  const exp = jwtExp(channel?.other?.access_token);
  if (!channel?.other?.access_token || (exp && exp - 300 <= Math.floor(Date.now() / 1000))) {
    await refreshAuth(channel, { force: true });
  }
  return String(channel?.other?.access_token || "");
}

function headers(token, deviceId) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": USER_AGENT,
    "oai-language": "zh-CN",
    "oai-device-id": deviceId,
    origin: BASE,
    referer: `${BASE}/`,
  };
}

export async function chat({ channel, model, prompt, messages, signal, onDelta }) {
  const token = await ensureToken(channel);
  const deviceId = String(channel?.other?.device_id || crypto.randomUUID());
  if (!channel?.other?.device_id) {
    await persistOtherPatch(channel.id, { device_id: deviceId }).catch(() => {});
  }

  // 多轮历史 → 网页版 messages
  const list = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object" || m.role === "system") continue;
    const content = typeof m.content === "string" ? m.content : String(m.content ?? "");
    if (!content) continue;
    list.push({
      id: crypto.randomUUID(),
      author: { role: m.role === "assistant" ? "assistant" : "user" },
      content: { content_type: "text", parts: [content] },
    });
  }
  if (!list.length || list[list.length - 1].author.role !== "user") {
    list.push({
      id: crypto.randomUUID(),
      author: { role: "user" },
      content: { content_type: "text", parts: [String(prompt || "")] },
    });
  }

  const resp = await fetch(`${BASE}/backend-api/conversation`, {
    method: "POST",
    headers: headers(token, deviceId),
    body: JSON.stringify({
      action: "next",
      messages: list,
      model: webModelId(model),
      parent_message_id: crypto.randomUUID(),
      conversation_mode: { kind: "primary_assistant" },
      timezone_offset_min: -480,
      history_and_training_disabled: false,
    }),
    signal,
  }).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 ChatGPT 网页版：${e.message}`), { code: "CHANNEL_NETWORK" });
  });

  if (resp.status === 401 || resp.status === 403) {
    // 403 常见于 sentinel/arkose 风控：明确告诉管理员换号或过风控，而不是静默失败
    const text = await resp.text().catch(() => "");
    const risk = resp.status === 403 && /unusual|verify|arkose|sentinel|flagged/i.test(text);
    throw Object.assign(
      new Error(
        risk
          ? "该 ChatGPT 账号触发网页版风控（sentinel/arkose 校验），请换号或先在网页完成一次人工验证"
          : `ChatGPT 网页版登录态失效（HTTP ${resp.status}）：${text.slice(0, 160)}`
      ),
      { code: risk ? "CHANNEL_WAF" : "CHANNEL_AUTH_EXPIRED", cooldownSec: risk ? 21600 : 3600 }
    );
  }
  if (resp.status === 429) throw Object.assign(new Error("ChatGPT 网页版限流（429）"), { code: "CHANNEL_RATE_LIMIT", cooldownSec: 300 });
  if (resp.status >= 500) throw Object.assign(new Error(`ChatGPT 网页版错误（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`ChatGPT 网页版返回 HTTP ${resp.status}：${text.slice(0, 200)}`), { code: "CHANNEL_BAD_REQUEST" });
  }
  if (!resp.body) throw Object.assign(new Error("ChatGPT 网页版未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let conversationId = "";
  let lastMessageId = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > 8 * 1024 * 1024) {
        throw Object.assign(new Error("ChatGPT 网页版数据帧异常（单块超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
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
        if (ev.conversation_id) conversationId = ev.conversation_id;
        if (ev.message?.id) lastMessageId = ev.message.id;
        // 增量补丁帧（v 字段）跳过，只在完整 message 帧取文本
        if (ev.message?.author?.role !== "assistant") continue;
        const parts = ev.message?.content?.parts;
        const text = Array.isArray(parts) ? parts.filter((p) => typeof p === "string").join("") : "";
        if (text && text !== content) {
          const delta = text.startsWith(content) ? text.slice(content.length) : text;
          content = text;
          if (delta && onDelta) onDelta(delta);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) throw Object.assign(new Error("ChatGPT 网页版返回空内容"), { code: "CHANNEL_EMPTY" });
  return {
    content,
    reasoning: "",
    usage: null,
    upstreamModel: webModelId(model),
    // 供上层做会话亲和（同网页会话复用）
    extra: { conversationId, messageId: lastMessageId },
  };
}

/** 健康检查：GET /backend-api/me（便宜、无额度消耗） */
export async function verify(channel) {
  const started = Date.now();
  const token = await ensureToken(channel);
  const resp = await fetch(`${BASE}/backend-api/me`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error(`ChatGPT 网页版凭据无效（HTTP ${resp.status}）`), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`ChatGPT 网页版健康检查失败（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  }
  return Date.now() - started;
}

/**
 * 拉取该网页版账号可用的模型（`GET /backend-api/models`）。
 * 这个接口返回的是**该账号档位可见**的模型清单（免费号拿不到付费档），
 * 正是「这个账号实际能用什么」的答案；拿不到由路由回退到平台注册表。
 */
export async function fetchUpstreamModels(channel) {
  const token = await ensureToken(channel);
  const resp = await fetch(`${BASE}/backend-api/models`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`拉取模型失败（HTTP ${resp.status}）：${text.slice(0, 160)}`), {
      code: resp.status === 401 || resp.status === 403 ? "CHANNEL_AUTH_EXPIRED" : "CHANNEL_HTTP_ERROR",
    });
  }
  const j = await resp.json().catch(() => null);
  const arr = Array.isArray(j?.models) ? j.models : Array.isArray(j?.data) ? j.data : [];
  const ids = arr
    .map((m) => String(m?.slug || m?.id || "").trim())
    .filter((s) => s && /^[a-z0-9][a-z0-9._-]*$/i.test(s));
  if (!ids.length) throw new Error("上游没有返回模型列表");
  return [...new Set(ids)].sort();
}

/** 导入凭据（管理端粘贴）：返回 { token, other, accountLabel } */
export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    method: "openai-web",
    access_token: cred.access_token,
    ...(cred.refresh_token ? { refresh_token: cred.refresh_token } : {}),
    ...(cred.email ? { email: cred.email } : {}),
    device_id: crypto.randomUUID(),
  };
  return { token: cred.access_token, other, accountLabel: cred.email || "ChatGPT 网页版" };
}

export function authHint() {
  return "登录 chatgpt.com 后打开 https://chatgpt.com/api/auth/session，复制 accessToken（有 refreshToken 更好，可自动续期）";
}
