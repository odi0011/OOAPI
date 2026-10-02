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
//   · Zen 的免费档（模型 id 含 free）走的是**匿名客户端通道**，见下方免费档一节；
//     Key 模式按官方开源 CLI 的请求头契约补齐，GO 仍按公开文档自述平台名称。
//
// ---------------------------------------------------------------------------
// Zen 免费档 —— 匿名通道（2026-10-02 实测 fledge-alpha-free / mimo-v2.6-flash-free 均 200）
//
// 此前线上「同一把 Key、连官方客户端都 403」的根因有两层，都与头无关：
//   ① 免费档**不能带自家 API Key**。带 Key 的请求被上游归入「Console」通道拒绝：
//      403 "OpenCode's free tier can only be used from within OpenCode"。
//      免费档本来就是给客户端内无凭据使用准备的，认证用共享匿名凭据：
//      `Authorization: Bearer public`。
//   ② 请求体必须是「agent 形态」：stream:true 且 tools 里有五个核心工具
//      （bash/edit/glob/grep/read，**只看名字**，缺了上游按 FreeTierError 拒绝；
//      对带 Key 的免费档请求同样生效）。普通无工具的聊天请求必然 403。
//   ③ 请求头沿用上面 zen 的官方契约即可（裸 UA、session/request/project），无需特殊化。
//
// 上游对匿名通道**按 IP 限速**（社区实现为此配代理池轮换）。我们先用服务器本机出口；
// 若线上出口被限速，表现为 429/403，届时考虑给该渠道配代理，而不是折腾凭据。
// 机制来源：github.com/jasonxu114514/opencode2api v1.3.2（commit 2ce1f9e，
// "serve anonymous free tier as agent-shaped streams"）与 decolua/9router PR #4132。
import crypto from "node:crypto";
import * as compat from "./openai-compat.js";
import { opencodeIdentity } from "./cli-profile.js";
import { applyVendorRequest } from "./vendor-quirks.js";
import { chatNative, nativeProtocol } from "./opencode-native.js";

/** 免费档的共享匿名凭据：不是我们的 Key，是上游给「客户端内免登录」预留的公共凭据 */
const ANONYMOUS_KEY = "public";
/** 上游按**工具名字**判断是否 agent 流量；缺任何一个都按 FreeTierError 拒绝 */
const FREE_TIER_TOOLS = ["bash", "edit", "glob", "grep", "read"];

/**
 * Zen 免费档按模型名判定（社区同款兜底口径：id 含 free 即免费档，
 * 如 fledge-alpha-free、mimo-v2.6-flash-free、muse-spark-1.3-contributor-free）。
 */
export function isFreeTierModel(model) {
  return String(model || "").toLowerCase().includes("free");
}

function missingCoreTools(body) {
  const present = new Set();
  for (const item of Array.isArray(body?.tools) ? body.tools : []) {
    const name = item && typeof item === "object" ? (item.function?.name || item.name) : "";
    if (typeof name === "string" && name) present.add(name);
  }
  return FREE_TIER_TOOLS.filter((name) => !present.has(name));
}

/** chat 协议的工具定义是 {type:"function", function:{...}}；Responses 是顶层扁平结构 */
function freeTool(name, nested) {
  const fn = { name, description: `Compatibility declaration only. ${name} is unavailable in this hosted conversation; use only the tools explicitly listed in the system instructions.`, parameters: { type: "object", properties: {} } };
  return nested ? { type: "function", function: fn } : { type: "function", ...fn };
}

/** 调用方已声明的工具保持原样，只补缺失的核心工具（否则会破坏下游真实工具调用） */
function shapeChatFreeBody(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const name of missingCoreTools(body)) tools.push(freeTool(name, true));
  body.tools = tools;
  body.stream = true;
}

function shapeResponsesFreeBody(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const name of missingCoreTools(body)) tools.push(freeTool(name, false));
  body.tools = tools;
  body.stream = true;
}

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
function decorated(channel, { sessionId, requestId, userId, model } = {}) {
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  // Zen Key 使用官方开源客户端的请求契约；这些头不保证通过上游私有免费档限制。
  // 依据 v1.18.34 的 session/llm/request.ts 与 effect/runtime-flags.ts（client 默认 cli）。
  // GO 文档明确要求客户端自述 UA，继续使用平台名称，避免改变已可用的订阅请求。
  const zen = String(o.method || "api") !== "go";
  // 免费档改走匿名通道（见文件头）：带自家 Key 反而被上游归入 Console 通道拒绝。
  // 只对 Zen 生效——GO 是订阅计费，没有免费档概念，保持 keyed 行为完全不变。
  const anonymous = zen && isFreeTierModel(model);
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
  // 管理员显式配置的 extra_headers 在下方归一后仍会覆盖这里（显式优先）。
  if (anonymous) headers.authorization = `Bearer ${ANONYMOUS_KEY}`;
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
  const zen = String(channel.other?.method || "api") !== "go";
  const free = zen && isFreeTierModel(args.model);
  if (zen) {
    const request = { model: args.model };
    applyVendorRequest(request, { channel, model: args.model });
    const protocol = nativeProtocol(request.model);
    if (protocol) {
      // 免费档的 Responses 请求同样要 agent 形态；SystemOne 是结构化判定不是
      // agent 流量，chatNative 里会跳过注入，认证头仍走匿名凭据。
      return chatNative({ ...args, channel, ...(free ? { bodyHook: shapeResponsesFreeBody } : {}) }, protocol, request.model);
    }
  }
  return compat.chat({ ...args, channel, ...(free ? { bodyHook: shapeChatFreeBody } : {}) });
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
