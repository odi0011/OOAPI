// 上游适配器：Cline（cline.bot）
// ===========================================================================
// 调研结论（2026-09-23）：**Cline 官方就提供标准 OpenAI 兼容 API**，
// 所以这里是「薄适配器」而不是反代 —— 只需要补两件小事：
//   ① 官方要求的客户端标识头；
//   ② 兼容它可能存在的 `data` 包封（见下）。
//
// 官方协议（有据可查）：
//   · 端点 POST https://api.cline.bot/api/v1/chat/completions
//   · 认证 Authorization: Bearer <key>；Key 在 app.cline.bot → Settings → API Keys 创建
//     （与扩展登录得到的 account token 用同一套头格式，官方文档 api/authentication）
//   · GET {base}/models **公开无需鉴权**（实测 200 + 454 个模型）
//   · 模型 id 是 `vendor/model`（同 OpenRouter），另有 `:free` / `:batch` 后缀档
//
// **为什么不做社区那种 cline2api 反代**：官方既有标准 API、又有正式签发的 Key，
// 反代是多余的；且它违反其 ToS（§2.2「以官方提供之外的技术手段访问」、
// §7.3「不得让他人使用你的订阅」），并已被部分封堵（订阅档 `cline-pass/*`
// 直接 403 'only available via Cline product surfaces'）。用官方 Key 稳定且无封号风险。
import * as compat from "./openai-compat.js";

/**
 * 官方客户端标识头。
 *
 * 来源：Cline 开源源码 `sdk/packages/llms/src/providers/request-headers.ts`
 * （`DEFAULT_CLINE_REQUEST_HEADERS` + `buildClineRequestHeaders`）。
 * 官方文档把 HTTP-Referer / X-Title / X-Task-ID 标为「可选（用于统计）」，
 * 但社区实测报告：上游对**没有客户端标识**的请求会回
 * 403 `only available via Cline product surfaces`。
 *
 * 这里默认带上 —— 一方面是过那道校验，另一方面我们确实是「通过 API 调用」，
 * 标明来源比伪装成别的客户端更诚实（X-CLIENT-TYPE 用 cline-sdk，
 * 因为走的就是它发布的 HTTP 接口，不是 IDE 扩展）。
 */
export const CLINE_HEADERS = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "OOAPI",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "cline-sdk",
};

/** 给渠道补上客户端标识头（不覆盖渠道自己配的同名头） */
export function withClineHeaders(channel) {
  const o = channel?.other || {};
  const extra = o.extra_headers && typeof o.extra_headers === "object" ? o.extra_headers : {};
  const ua = String(o.client_user_agent || "").trim();
  return {
    ...channel,
    other: {
      ...o,
      extra_headers: {
        ...CLINE_HEADERS,
        // UA 若渠道指定则用渠道的（Cline 用 UA 里的版本号做过校验，必要时可覆盖）
        ...(ua ? { "user-agent": ua } : {}),
        // 渠道自定义头放最后：显式配置优先于我们的默认值
        ...extra,
      },
    },
  };
}

/**
 * 解包可能的 `data` 包封。
 *
 * 背景：Cline 官方 SDK 的 provider 定义里带 `responseEnvelope: "success-data"`，
 * 且社区 issue #12647 报告**非流式**回复会把 choices 包在 `data` 里
 * （`{success:true, data:{choices:[...]}}` 而不是 `{choices:[...]}`）。
 *
 * 我们始终用 `stream:true` 请求（openai-compat 的固定行为），受影响面很小；
 * 但这段解包成本极低、且能同时兼容两种形状 —— 与其等线上报错再查，
 * 不如一次写对。判定很保守：**只有顶层没有 choices、而 data 里有 choices 时**才解包。
 */
export function unwrapEnvelope(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj.choices)) return obj; // 标准形状，原样返回
  const inner = obj.data;
  if (inner && typeof inner === "object" && Array.isArray(inner.choices)) {
    // 保留外层可能带的 usage（有些实现把 usage 放外层）
    return { ...inner, usage: inner.usage ?? obj.usage };
  }
  return obj;
}

export async function chat(args) {
  return compat.chat({
    ...args,
    channel: withClineHeaders(args.channel),
    // 有需要时把 envelope 解包挂进适配器链路（见 openai-compat 的同名选项）
    unwrap: unwrapEnvelope,
  });
}

export async function verify(channel) {
  return compat.verify(withClineHeaders(channel));
}

export async function fetchUpstreamModels(channel) {
  // `/models` 无需鉴权，但带上 Key 也无妨（带 Key 时可能返回该账号可用的子集）
  return compat.fetchUpstreamModels(withClineHeaders(channel));
}

export function loginModes() {
  return ["api"];
}
