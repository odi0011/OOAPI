// 上游适配器：kiro（Anthropic 厂商的第三方工具反代 · Kiro / AWS Q / CodeWhisperer）
// ===========================================================================
// 协议来源：开源社区（kiro-gateway / kiro.rs / KiroGate / kirolink）逆向后的一致结论：
//   · 凭据：Kiro 的 kiro-auth-token.json（accessToken/refreshToken/region/profileArn 可选），
//     或 AWS SSO OIDC 形态（额外带 clientId/clientSecret）
//   · 刷新：桌面版 POST https://prod.{region}.auth.desktop.kiro.dev/refreshToken {refreshToken}
//           SSO   POST https://oidc.{region}.amazonaws.com/token {clientId,clientSecret,refreshToken,grantType}
//   · 对话：POST https://codewhisperer.{region}.amazonaws.com/generateAssistantResponse
//     头：x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse 等（见下方 headers）
//     响应：AWS EventStream 二进制帧（kiro-eventstream.js 解析）
//
// 说明：本适配器把 Kiro 暴露的 Claude 模型按 Anthropic 厂商计费；
// 由于 Kiro 的 modelId 命名与平台登记表不同，请求时做一次映射（映射不到就原样透传）。
import crypto from "node:crypto";
import { ToolCallBuffer, callOf } from "../tool-wire.js";
import { normalizeContentToText } from "./content-text.js";
import { persistOtherPatch, loadOther, withRefreshLock } from "./auth-store.js";
import { createAwsEventStreamParser } from "./kiro-eventstream.js";
import { parseAuthJson, kiroModelId, safeRegion } from "./kiro-auth.js";

const REFRESH_LEAD_S = 300;

function tokenExpiredSoon(other) {
  const exp = Number(other?.expires_at || 0);
  if (!exp) return Boolean(other?.refresh_token);
  return exp - REFRESH_LEAD_S <= Math.floor(Date.now() / 1000);
}

/** 刷新登录态；SSO（有 clientId/secret）与桌面版两条路径 */
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
    if (!refreshToken) throw Object.assign(new Error("缺少 refresh_token，请重新导入 Kiro 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
    // region 必须过白名单（不只是导入时校验）：本次加固前导入的渠道 other.region 可能是脏值，
    // 而它要拼进主机名 —— 脏值会把带 Bearer 令牌的请求打到攻击者/内网主机。
    const region = safeRegion(other.region);
    const sso = Boolean(other.client_id && other.client_secret);

    const url = sso
      ? `https://oidc.${region}.amazonaws.com/token`
      : `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
    const body = sso
      ? {
          clientId: other.client_id,
          clientSecret: other.client_secret,
          refreshToken,
          grantType: "refresh_token",
        }
      : { refreshToken };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`刷新 Kiro 登录态失败（HTTP ${resp.status}）：${text.slice(0, 180)}`), {
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
      access_token: j.accessToken || j.access_token || other.access_token,
      refresh_token: j.refreshToken || j.refresh_token || refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + (Number(j.expiresIn || j.expires_in) || 3600),
      region,
    };
    // 传入刷新发起时的凭据代次：若期间管理员人工换过凭据，写回会被丢弃（见 auth-store）
    await persistOtherPatch(channel.id, patch, Number(other?.cred_epoch) || 0);
    channel.other = { ...other, ...patch };
    return patch;
  });
}

async function ensureToken(channel) {
  const other = channel?.other || {};
  if (!other.access_token || tokenExpiredSoon(other)) {
    await refreshAuth(channel, { force: !other.access_token }).catch((e) => {
      if (!other.access_token) throw e;
      console.warn(`[kiro] 提前刷新失败（继续用现有 token）：${e.message}`);
    });
  }
  return String(channel?.other?.access_token || "");
}

function headers(channel, token) {
  const fp = crypto.createHash("sha256").update(`ooapi-${channel.id}`).digest("hex").slice(0, 40);
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "user-agent": `aws-sdk-js/1.0.27 ua/2.1 os/linux lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${fp}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fp}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=3",
    accept: "*/*",
  };
}

/** 组装 conversationState：历史 + 当前消息 */
export function buildBody(channel, model, prompt, messages, tools = [], sessionId = "") {
  const history = [];
  const list = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: prompt || "" }];
  const system = list.filter((m) => ["system", "developer"].includes(m?.role)).map((m) => normalizeContentToText(m.content)).filter(Boolean).join("\n\n");
  for (const m of list) {
    if (!m || ["system", "developer"].includes(m.role)) continue;
    const content = normalizeContentToText(m.content);
    if (m.role === "assistant") {
      const toolUses = (m.tool_calls || []).map((c) => { const v = callOf(c); return { toolUseId: v.id, name: v.name, input: JSON.parse(v.arguments) }; });
      history.push({ assistantResponseMessage: { content: content || " ", ...(toolUses.length ? { toolUses } : {}) } });
    } else {
      const toolResults = m.role === "tool" ? [{ toolUseId: m.tool_call_id, content: [{ text: content }], status: m.is_error ? "error" : "success" }] : [];
      const previous = history.at(-1)?.userInputMessage;
      if (previous) {
        if (m.role !== "tool" && content) previous.content += "\n" + content;
        if (toolResults.length) { previous.userInputMessageContext ||= {}; (previous.userInputMessageContext.toolResults ||= []).push(...toolResults); }
      } else history.push({ userInputMessage: { content: m.role === "tool" ? "工具执行结果如下。" : content || " ", modelId: kiroModelId(model), origin: "AI_EDITOR", ...(toolResults.length ? { userInputMessageContext: { toolResults } } : {}) } });
    }
  }
  let current = history.at(-1)?.userInputMessage ? history.pop().userInputMessage : { content: "继续", modelId: kiroModelId(model), origin: "AI_EDITOR" };
  // Kiro没有顶层system字段：必须把平台系统指令明确放入当前上下文，不能像旧实现直接丢弃。
  if (system) current.content = `<system_instructions>\n${system}\n</system_instructions>\n\n${current.content}`;
  if (tools.length) {
    current.userInputMessageContext ||= {};
    current.userInputMessageContext.tools = tools.map((t) => ({ toolSpecification: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } }));
  }
  const conversationState = { conversationId: sessionId ? crypto.createHash("sha256").update(`${channel.id}:${sessionId}`).digest("hex").slice(0, 32).replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5") : crypto.randomUUID(), chatTriggerType: "MANUAL", currentMessage: { userInputMessage: current }, history };
  return { conversationState, ...(channel?.other?.profile_arn ? { profileArn: String(channel.other.profile_arn) } : {}) };
}

export async function chat({
  tools = [], onToolCall, onUsage, sessionId,
  channel,
  model,
  prompt,
  messages,
  signal,
  onDelta,
  onReasoning,
}) {
  const region = safeRegion(channel?.other?.region);
  const url = `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`;
  const call = async (token) =>
    fetch(url, {
      method: "POST",
      headers: headers(channel, token),
      body: JSON.stringify(buildBody(channel, model, prompt, messages, tools, sessionId)),
      signal,
    });

  let token = await ensureToken(channel);
  let resp = await call(token).catch((e) => {
    if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    throw Object.assign(new Error(`无法连接 Kiro 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
  });

  // 403 → 强制刷新后重试一次（与开源实现一致）
  if (resp.status === 403) {
    await refreshAuth(channel, { force: true }).catch(() => {});
    token = String(channel?.other?.access_token || token);
    resp = await call(token).catch((e) => {
      if (e.name === "AbortError") throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
      throw Object.assign(new Error(`无法连接 Kiro 上游：${e.message}`), { code: "CHANNEL_NETWORK" });
    });
  }

  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`Kiro 登录态失效（HTTP ${resp.status}）：${text.slice(0, 180)}`), {
      code: "CHANNEL_AUTH_EXPIRED",
      cooldownSec: 3600,
    });
  }
  if (resp.status === 429) {
    throw Object.assign(new Error("Kiro 上游限流（429），稍后重试"), { code: "CHANNEL_RATE_LIMIT", cooldownSec: 300 });
  }
  if (resp.status >= 500) {
    throw Object.assign(new Error(`Kiro 上游错误（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw Object.assign(new Error(`Kiro 上游返回 HTTP ${resp.status}：${text.slice(0, 200)}`), {
      code: "CHANNEL_BAD_REQUEST",
    });
  }
  if (!resp.body) throw Object.assign(new Error("Kiro 未返回内容流"), { code: "CHANNEL_BAD_RESPONSE" });

  const parser = createAwsEventStreamParser();
  const reader = resp.body.getReader();
  let content = "";
  let reasoning = "";
  let usage = null;
  let upstreamError = null;
  const toolBuffer = new ToolCallBuffer(onToolCall);
  let currentToolId = "";
  const finishedTools = new Set();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let events;
      try {
        events = parser.push(value);
      } catch (e) {
        throw e;
      }
      for (const ev of events) {
        if (ev.messageType === "exception" || ev.messageType === "error") {
          upstreamError = ev.payload?.message || ev.payload?.reason || ev.type || "Kiro 上游异常";
          continue;
        }
        switch (ev.type) {
          case "assistantResponseEvent": {
            const text = String(ev.payload?.content || "");
            if (text) {
              content += text;
              if (onDelta) onDelta(text);
            }
            break;
          }
          case "reasoningContentEvent": {
            const text = String(ev.payload?.text || ev.payload?.content || "");
            if (text) {
              reasoning += text;
              if (onReasoning) onReasoning(text);
            }
            break;
          }
          case "toolUseEvent": {
            const p = ev.payload || {};
            currentToolId = p.toolUseId || currentToolId;
            if (!currentToolId) throw Object.assign(new Error("Kiro工具调用缺少编号"), { code: "CHANNEL_BAD_RESPONSE" });
            toolBuffer.add(currentToolId, { id: currentToolId, name: p.name, ...(p.input != null ? { arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input) } : {}) }, p.input != null && typeof p.input !== "string");
            if (p.stop === true) finishedTools.add(currentToolId);
            break;
          }
          case "messageMetadataEvent": {
            const u = ev.payload?.tokenUsage || ev.payload?.usage;
            if (u) {
              usage = {
                prompt_tokens: u.uncachedInputTokens != null ? Number(u.uncachedInputTokens) + Number(u.cacheReadInputTokens || 0) + Number(u.cacheWriteInputTokens || 0) : Number(u.inputTokens ?? u.prompt_tokens ?? 0),
                completion_tokens: Number(u.outputTokens || u.completion_tokens || 0),
                cached_tokens: Number(u.cacheReadInputTokens || u.cached_tokens || 0),
              };
              onUsage?.(usage);
            }
            break;
          }
          case "invalidStateEvent": {
            upstreamError = ev.payload?.reason || ev.payload?.message || "Kiro 会话状态异常";
            break;
          }
          default:
            break; // codeReference/contextUsage 等暂不处理
        }
      }
    }
  } catch (e) {
    throw Object.assign(new Error(e.message || "Kiro响应中断"), { code: typeof e.code === "string" ? e.code : signal?.aborted ? "CHANNEL_ABORTED" : "CHANNEL_STREAM_ERROR", content, reasoning, usage });
  } finally {
    reader.cancel().catch(() => {});
  }

  if (toolBuffer.size && finishedTools.size !== toolBuffer.size) throw Object.assign(new Error("Kiro工具响应未完成"), { code: "CHANNEL_STREAM_ERROR", content, reasoning, usage });
  if (upstreamError) {
    throw Object.assign(new Error(`Kiro 上游错误：${upstreamError}`), { code: "CHANNEL_BIZ_ERROR" });
  }
  if (!content && !toolBuffer.size) {
    throw Object.assign(new Error(reasoning ? "Kiro 只返回了思考内容，没有正文" : "Kiro 返回空内容"), {
      code: "CHANNEL_EMPTY",
    });
  }
  return { content, reasoning, usage, toolCalls: toolBuffer.finish(), upstreamModel: kiroModelId(model) };
}

/** 健康检查：只验证凭据可刷新（不消耗对话额度） */
export async function verify(channel) {
  const started = Date.now();
  await ensureToken(channel);
  return Date.now() - started;
}

/**
 * 拉取该 Kiro 账号可用的模型（`ListAvailableModels`）。
 * 返回的 modelId 是 Kiro 侧命名（claude-sonnet-4.5 等），与平台注册的 Claude 模型对应；
 * 这里**原样返回上游 id**，由管理员在模型范围里挑选（映射在 chat 时由 kiroModelId 完成）。
 */
export async function fetchUpstreamModels(channel) {
  const region = safeRegion(channel?.other?.region);
  const token = await ensureToken(channel);
  const profileArn = String(channel?.other?.profile_arn || channel?.other?.profileArn || "");
  const qs = new URLSearchParams({ origin: "AI_EDITOR", maxResults: "50" });
  if (profileArn) qs.set("profileArn", profileArn);
  const resp = await fetch(`https://codewhisperer.${region}.amazonaws.com/ListAvailableModels?${qs.toString()}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "x-amzn-codewhisperer-optout": "true",
      "user-agent": "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
      "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
    },
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
  const ids = arr.map((m) => String(m?.modelId || m?.modelName || m?.id || "").trim()).filter(Boolean);
  if (!ids.length) throw new Error("上游没有返回模型列表（Builder ID 账号可能不支持该接口）");
  return [...new Set(ids)].sort();
}

/** 导入凭据（管理端粘贴）：返回 { token, other, accountLabel } */
export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const other = {
    method: "kiro",
    access_token: cred.access_token,
    refresh_token: cred.refresh_token,
    region: cred.region,
    ...(cred.profile_arn ? { profile_arn: cred.profile_arn } : {}),
    ...(cred.client_id ? { client_id: cred.client_id } : {}),
    ...(cred.client_secret ? { client_secret: cred.client_secret } : {}),
    ...(cred.access_token ? { expires_at: Math.floor(Date.now() / 1000) + 1800 } : {}),
  };
  return { token: cred.access_token, other, accountLabel: cred.profile_arn || cred.region || "Kiro" };
}

export function authHint() {
  return "粘贴 Kiro 的 kiro-auth-token.json（或含 clientId/clientSecret 的 AWS SSO 凭据；也可只填 refreshToken）";
}
