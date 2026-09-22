// 上游适配器：Qoder（阿里）—— 经本地桥接入
// ===========================================================================
// 现状说明（调研结论，见 AI协作.md 第 7.5 节）：
//   · Qoder 推理协议（`api2.qoder.sh/algo/...`）要求 22 个 Cosy-* 签名头 +
//     请求体经官方内嵌 WASM 加密，服务端无法在不内嵌 WASM 的前提下直连；
//   · 社区标准做法是本地桥（qoder2api / qoder-proxy）：桥持有 PAT，
//     在本机暴露 **OpenAI 兼容** 的 `/v1/chat/completions`，Bearer 直接用 PAT。
//
// 本适配器把「Qoder 桥」作为一等接入方式：
//   · 凭据 = Qoder PAT（`pt-...`，qoder.com → 服务集成 → 创建个人访问令牌）；
//   · Base URL = 桥地址（默认 qoder2api 的 http://127.0.0.1:8963）；
//   · 对话/健康检查/拉模型全部复用 openai-compat（桥就是标准 OpenAI 协议）。
//
// 若后续要做「服务端直连 Qoder」（不依赖本地桥），需要移植 qoder2api 的
// WASM 签名/加密链路（RSA+AES+自定义 Base64），属独立工程，单独立项。
import * as compat from "./openai-compat.js";

const DEFAULT_BRIDGE = "http://127.0.0.1:8963";

/**
 * 允许的桥地址白名单（host:port）。
 *
 * 为什么必须白名单：桥地址来自**凭据 JSON 的 endpoint**，而它随后就是
 * openai-compat 的 base_url、Bearer（Qoder PAT）随请求发出。若不做限制，
 * 一份 `{"personal_token":"pt-真实PAT","endpoint":"https://evil.example"}`
 * 就能把 PAT 送到攻击者主机；填内网地址则是 SSRF。这与「管理员本来就能填
 * 任意 base_url」不同：那是**显式配置**，而凭据是被导入的、看起来只是数据。
 *
 * 桥的正当形态只有本机（qoder2api 默认 127.0.0.1:8963），所以默认白名单就是
 * 本机两个写法；部署在多机时用 QODER_BRIDGE_ALLOWLIST 追加（逗号分隔 host:port），
 * 且只认服务端运维配置的值 —— 绝不接受请求里指定的地址。
 */
function bridgeAllowlist() {
  const extra = String(process.env.QODER_BRIDGE_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(["127.0.0.1:8963", "localhost:8963", "[::1]:8963", ...extra]);
}

/** 校验桥地址（导入时、每次请求前都调用） */
export function assertBridgeAllowed(raw) {
  const url = String(raw || "").trim() || DEFAULT_BRIDGE;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw Object.assign(new Error(`桥地址不是合法 URL：${url}`), { code: "LOGIN_BAD_PARAMS" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw Object.assign(new Error("桥地址只允许 http/https"), { code: "LOGIN_BAD_PARAMS" });
  }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const key = `${u.hostname.toLowerCase()}:${port}`;
  if (!bridgeAllowlist().has(key)) {
    throw Object.assign(
      new Error(
        `桥地址 ${key} 不在白名单内：Qoder 桥必须与网关同机（或由运维在 QODER_BRIDGE_ALLOWLIST 登记）。` +
          `不接受凭据自带的任意地址，避免 PAT 被外送到第三方主机`
      ),
      { code: "LOGIN_BAD_PARAMS" }
    );
  }
  return url;
}

export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  if (text && !text.startsWith("{")) {
    // 直接粘贴 PAT 字符串
    return { personal_token: text, endpoint: DEFAULT_BRIDGE };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（可直接粘贴 PAT，或 { personal_token, endpoint }）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const personal_token = String(
    j.personal_token || j.personalToken || j.access_token || j.accessToken || j.token || j.pat || ""
  ).trim();
  const endpoint = String(j.endpoint || j.bridge || j.base_url || j.baseUrl || "").trim().replace(/\/+$/, "");
  if (!personal_token) throw Object.assign(new Error("缺少 PAT（personal_token）"), { code: "LOGIN_BAD_PARAMS" });
  if (endpoint) assertBridgeAllowed(endpoint);
  return { personal_token, endpoint };
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  return {
    token: cred.personal_token,
    other: {
      // 桥地址单独存：channel.base_url 会被表单覆盖，这里保存默认值
      endpoint: cred.endpoint || DEFAULT_BRIDGE,
      bridge: true,
      // 明示允许内网上游（openai-compat 据此跳过公网校验）。
      // 安全性由上面的 assertBridgeAllowed 白名单保证 —— 两者必须成对出现：
      // 有豁免没白名单就是 SSRF，有白名单没豁免桥会被公网校验挡掉。
      allow_private_upstream: true,
    },
    accountLabel: `Qoder PAT · ${cred.personal_token.slice(0, 6)}…`,
  };
}

function decorated(channel) {
  const o = channel?.other || {};
  return {
    ...channel,
    base_url: assertBridgeAllowed(channel?.base_url || o.endpoint || DEFAULT_BRIDGE),
    api_key: channel?.api_key || o.access_token || "",
    // 老渠道 other 里没有这个字段，每次请求补上（否则公网校验会挡掉本地桥）
    other: { ...o, allow_private_upstream: true },
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

export function loginModes() {
  return ["paste"];
}

export function authHint() {
  return (
    `Qoder 推理协议需官方 WASM 签名，服务端不能直连；请先用 qoder2api / qoder-proxy 在本地起桥` +
    `（默认 ${DEFAULT_BRIDGE}），把桥地址填到渠道「接口地址」，凭据粘贴 Qoder PAT（pt-...）。`
  );
}
