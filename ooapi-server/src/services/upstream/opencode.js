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
//   · Zen（按量付费）的文档里没有这条要求，但发这个头对它无害，
//     所以两个接入方式统一注入，行为一致、少一个分支。
import crypto from "node:crypto";
import * as compat from "./openai-compat.js";

/**
 * 该渠道的会话标识（稳定值，同一渠道永远相同）。
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
 * 这里只加 openai-compat 不会设置的那两个头。
 */
function decorated(channel) {
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  return {
    ...channel,
    other: {
      ...o,
      extra_headers: {
        // 客户端自述标识：文档点名要求「用自己的 user agent，而不是通用 SDK/库名」。
        // 不设的话 Node fetch 会发 `node`，正是它说的那种通用库名。
        "user-agent": String(o.client_user_agent || "OOAPI-Gateway/1.0"),
        "x-opencode-session": sessionIdOf(channel),
        // 放在最后：渠道配置里的 extra_headers 是**更明确的用户意图**，
        // 同名键应当覆盖上面的默认值（顺序反了会让用户显式指定的 session 失效）
        ...extra,
      },
    },
  };
}

export async function chat(args) {
  return compat.chat({ ...args, channel: decorated(args.channel) });
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
