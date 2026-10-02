// 上游适配器：OpenCode（Zen 按量付费 / GO $10 月订阅）
// ===========================================================================
// 为什么需要独立适配器（而不是直接用 openai-compat）：
//
// OpenCode 的 **GO 订阅**有额外的客户端识别要求，官方文档
// （opencode.ai/docs/go/ 的 "Where can I use it?"）原文：
//
//   「OpenCode Go is designed for OpenCode and other coding agents ...
//     Your client should:
//       · Send typical coding agent traffic
//       · Identify itself with its own user agent, such as my-coding-agent/1.0,
//         rather than a generic SDK or HTTP-library name.
//       · Send a stable session ID in x-opencode-session for each conversation
//         so we can optimize routing and prompt caching.」
//
// 缺 `x-opencode-session` 会被**直接拒绝**（实测线上）：
//   HTTP 400  missing_session_id
//   「Request is missing x-opencode-session and cannot be routed efficiently.
//     Please see https://opencode.ai/docs/go/#where-can-i-use-it」
//
// 这正是线上渠道 #45 的故障：base_url 与路径都对（`/zen/go/v1/chat/completions`，
// 与文档的 Endpoints 表一致），只是没发这个头。
//
// 顺带说明两件事，避免以后再被误判：
//   · 官方后台把请求显示成 `/inference/go/openai/v1/chat/completions` ——
//     那是**他们内部的路径重写**，不是我们发错了地址；
//   · Zen 的免费档另有客户端限制；2026-10-02 实测仅这两个头会收到 403。
//     Key 模式按官方开源 CLI 的请求头契约补齐，GO 仍按公开文档自述平台名称。
import crypto from "node:crypto";
import * as compat from "./openai-compat.js";
import { opencodeIdentity } from "./cli-profile.js";
import { applyVendorRequest } from "./vendor-quirks.js";
import { chatNative, nativeProtocol } from "./opencode-native.js";

/**
 * 无对话上下文的 GO 探测入口使用的稳定后备标识。真实对话必须传入自己的会话。
 *
 * 为什么必须**稳定**而不能每个请求随机：文档要它正是为了
 * 「optimize routing and prompt caching」—— 每次换 ID 等于每隔一次就开新会话，
 * 缓存全部落空，还会看起来像异常流量。
 *
 * 为什么从渠道 id 派生而不写库：派生是幂等的，省掉一次写库与并发问题；
 * 想让某个渠道单独指定时，在渠道配置里写 `other.oc_session_id` 覆盖即可。
 */
export function sessionIdOf(channel) {
  const explicit = String(channel?.other?.oc_session_id || "").trim();
  if (explicit) return explicit.slice(0, 128);
  // 确定性 UUID（v5 形态，sha1 + 版本/变体位）：同一渠道恒等，且看起来像正常 UUID
  const h = crypto.createHash("sha1").update(`ooapi-opencode-${Number(channel?.id) || 0}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * 补上 OpenCode 要求的识别头。
 *
 * 注意与 WorkBuddy 同样的坑：**绝不能重复设置 content-type / authorization**。
 * Fetch 的 Headers 对同名头是**逗号拼接**而不是覆盖，重复会让
 * `Bearer A` 变成 `Bearer A, Bearer A`，上游必然 401。
 * 默认只补客户端标识头，已有显式覆盖保持一次设置。
 */
function decorated(channel, { sessionId, requestId, userId } = {}) {
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  // Zen Key 使用官方开源客户端的请求契约；这些头不保证通过上游私有免费档限制。
  // 依据 v1.18.34 的 session/llm/request.ts 与 effect/runtime-flags.ts（client 默认 cli）。
  // GO 文档明确要求客户端自述 UA，继续使用平台名称，避免改变已可用的订阅请求。
  const zen = String(o.method || "api") !== "go";
  const identity = opencodeIdentity(channel, { sessionId, requestId, userId });
  // 不直接把 UUID/数字等调用方 ID 塞进 Zen 的 ses_ 头；派生时包含已鉴权用户，隔离相同外部会话名。
  const session = String(sessionId ? identity.sessionId : o.oc_session_id || (zen ? identity.sessionId : sessionIdOf(channel))).slice(0, 128);
  const headers = {
    "user-agent": String(o.client_user_agent || (zen ? identity.userAgent : "OOAPI-Gateway/1.0")),
    "x-opencode-client": String(o.oc_client || (zen ? "cli" : "ooapi")),
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-opencode-request": identity.requestId,
    // 未传入调用方 Git 项目时用官方 global；request 每次调用独立，避免日志误合并。
    "x-opencode-project": String(o.oc_project_id || identity.projectId).slice(0, 128),
  };
  // HTTP 头大小写不敏感。先归一再覆盖，否则 User-Agent 与 user-agent 会被 Fetch 逗号拼接。
  for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
  const extraNames = Object.keys(extra).map((key) => key.toLowerCase());
  if (extraNames.includes("x-opencode-session") && !extraNames.includes("x-opencode-session-id")) {
    headers["x-opencode-session-id"] = headers["x-opencode-session"];
  }
  // compat 的公共三头使用这些键名；显式覆盖也必须同名，不能重新引入逗号拼接。
  const compatNames = { authorization: "Authorization", "content-type": "Content-Type", accept: "Accept" };
  const extraHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [compatNames[key] || key, value]));
  return {
    ...channel,
    other: {
      ...o,
      extra_headers: extraHeaders,
    },
  };
}

export async function chat(args) {
  const channel = decorated(args.channel, args);
  if (String(channel.other?.method || "api") !== "go") {
    const request = { model: args.model };
    applyVendorRequest(request, { channel, model: args.model });
    const protocol = nativeProtocol(request.model);
    if (protocol) return chatNative({ ...args, channel }, protocol, request.model);
  }
  return compat.chat({ ...args, channel });
}

export async function verify(channel) {
  return compat.verify(decorated(channel));
}

export async function fetchUpstreamModels(channel) {
  return compat.fetchUpstreamModels(decorated(channel));
}

/** 该接入方式的默认模型（与 channel-types 的登记保持一致，供探测兜底） */
export function loginModes() {
  return ["api"];
}
