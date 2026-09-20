// 上游适配器：WorkBuddy / CodeBuddy（腾讯）
// ===========================================================================
// 机制来源（社区逆向，qoder2api 同期调研的 workbuddy2api / codebuddy2openai）：
//   · 后端 `copilot.tencent.com`（国际版 `www.workbuddy.ai`）的
//     `POST /v2/chat/completions` **本身就是标准 OpenAI 协议**（含 tools / SSE）；
//   · 鉴权 = `Authorization: Bearer <桌面端 access_token>` +
//     风控头 `X-User-Id` / `X-Enterprise-Id` / `X-Device-Token`；
//   · 模型为腾讯云托管同名档位（deepseek-* / glm-* / kimi-* / gpt-5.6-*），
//     不是 DeepSeek/智谱官方转发（计价按独立厂商处理）。
//
// 本适配器只做两件事：解析桌面端凭据（importAuth）→ 注入鉴权头后复用
// openai-compat 的对话实现（协议完全一致，无需另写流式解析）。
// 凭据形态（粘贴 JSON，兼容几种常见导出）：
//   {
//     "access_token": "...",            // 必填；也接受 accessToken/token/auth_token/Bearer
//     "device_token": "...",            // 建议填（X-Device-Token，腾讯 Turing Shield 设备头）
//     "user_id": "...",                 // 建议填（X-User-Id）
//     "enterprise_id": "...",           // 可选（X-Enterprise-Id）
//     "endpoint": "https://copilot.tencent.com"  // 可选，默认国内端点
//   }
// 说明：桌面端刷新 token 的接口未公开稳定（ttl 不固定），token 过期时本适配器
// 直接透出上游 401，管理员重新粘贴凭据即可；不做猜测性刷新。
import * as compat from "./openai-compat.js";

const CN_BASE = "https://copilot.tencent.com";
const GLOBAL_BASE = "https://www.workbuddy.ai";

/** 兼容多种导出形态的凭据解析 */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    // 也接受「直接粘贴一整个 token 字符串」
    if (text && !text.startsWith("{")) {
      return { access_token: text, refresh_token: "", device_token: "", user_id: "", enterprise_id: "", endpoint: "" };
    }
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 WorkBuddy 桌面端凭据）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const t = j.tokens || j.token_data || j.credentials || j;
  const access_token = String(
    t.access_token || t.accessToken || t.token || t.auth_token || j.access_token || j.accessToken || j.token || ""
  ).trim();
  const refresh_token = String(t.refresh_token || t.refreshToken || j.refresh_token || j.refreshToken || "").trim();
  const device_token = String(
    t.device_token || t.deviceToken || j.device_token || j.deviceToken || j["X-Device-Token"] || ""
  ).trim();
  const user_id = String(t.user_id || t.userId || j.user_id || j.userId || j.uid || j["X-User-Id"] || "").trim();
  const enterprise_id = String(
    t.enterprise_id || t.enterpriseId || j.enterprise_id || j.enterpriseId || j["X-Enterprise-Id"] || ""
  ).trim();
  const endpoint = String(t.endpoint || j.endpoint || j.base_url || j.baseUrl || "").trim().replace(/\/+$/, "");
  if (!access_token) {
    throw Object.assign(new Error("缺少 access_token（桌面端登录后的 Bearer Token）"), { code: "LOGIN_BAD_PARAMS" });
  }
  return { access_token, refresh_token, device_token, user_id, enterprise_id, endpoint };
}

/** 导入凭据（管理端「粘贴凭据」）：返回 { token, other, accountLabel } */
export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  const base = cred.endpoint || (cred.endpoint === GLOBAL_BASE ? GLOBAL_BASE : CN_BASE);
  return {
    token: cred.access_token,
    other: {
      access_token: cred.access_token,
      refresh_token: cred.refresh_token,
      device_token: cred.device_token,
      user_id: cred.user_id,
      enterprise_id: cred.enterprise_id,
      endpoint: base,
    },
    accountLabel: cred.user_id ? `WorkBuddy · ${cred.user_id}` : "WorkBuddy",
  };
}

/** 把渠道凭据装饰成 openai-compat 需要的形态（Base URL + Bearer + 风控头） */
function decorated(channel) {
  const o = channel?.other || {};
  const extra_headers = {
    ...(o.user_id ? { "X-User-Id": String(o.user_id) } : {}),
    ...(o.enterprise_id ? { "X-Enterprise-Id": String(o.enterprise_id) } : {}),
    ...(o.device_token ? { "X-Device-Token": String(o.device_token) } : {}),
  };
  return {
    ...channel,
    base_url: channel?.base_url || o.endpoint || CN_BASE,
    api_key: o.access_token || channel?.api_key || "",
    other: { ...o, extra_headers },
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

/** 该适配器支持的登录方式：订阅型凭据统一「粘贴 JSON」 */
export function loginModes() {
  return ["paste"];
}

export function authHint() {
  return (
    "凭据获取：登录 WorkBuddy/CodeBuddy 桌面端后，从本机登录文件（workbuddy-desktop.info 等）" +
    "复制 Bearer Token；若上游要求设备校验，请一并粘贴 X-Device-Token（设备头）。" +
    `国内端点 ${CN_BASE}，国际版 ${GLOBAL_BASE}（可在凭据里用 endpoint 指定）。`
  );
}
