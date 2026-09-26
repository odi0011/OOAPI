// 上游适配器：ZCode（智谱 CLI 工具凭据反代）
// ===========================================================================
// 接入形态（与 WorkBuddy / Trae 同类的「工具凭据反代」）：
//   用户在本机装 ZCode CLI 并登录 Z.ai 账号，凭据落在
//   `%USERPROFILE%\.zcode\v2\credentials.json`（macOS/Linux: ~/.zcode/v2/credentials.json）。
//   该文件是**扁平键值对**（键名带冒号），实测（2026-09-26，本机 CLI）关键字段：
//     · `account-provider:coding-plan:account:<plan>:account:<uuid>:api-key`
//       —— GLM Coding Plan 的 API Key（**长期有效，推荐优先用**）
//     · `oauth:zai:access_token` —— Z.ai OAuth 的 JWT（会过期）
//     · `zcodejwttoken` —— CLI 自己的会话 JWT（会过期）
//
// 上游是 **Z.ai 官方 OpenAI 兼容 API**，coding plan 走专用前缀：
//   POST {base}/chat/completions        对话（openai-compat 自行拼接）
//   GET  {base}/models                  模型清单
// 默认 base = https://api.z.ai/api/coding/paas/v4（国际站）；
// 2026-09-26 匿名实测 GET /models 返回 401「Authentication parameter not received」
// —— 路径存在、仅缺鉴权，地址确认（平台惯例的端点探测法）。
// 国内 bigmodel 的同形端点（open.bigmodel.cn/api/coding/paas/v4）同样实测存在，
// 凭据 JSON 里用 endpoint 字段即可切换，无需改代码。
//
// 与 WorkBuddy 的关键差异：这里是**官方 API 面**，没有设备风控头 / 双段 UA 那些
// 私有指纹要求 —— 薄适配器只做「凭据解析 + 默认端点」，对话复用 openai-compat。
//
// 续期：coding-plan 的 api-key 长期有效，不需要刷新逻辑；只有 oauth access_token 的
// 凭据过期后需重新粘贴（粘贴指引里已写明优先用 api-key）。
import * as compat from "./openai-compat.js";

const DEFAULT_ENDPOINT = "https://api.z.ai/api/coding/paas/v4";
const CN_ENDPOINT = "https://open.bigmodel.cn/api/coding/paas/v4";

/**
 * 从粘贴内容里挑出可用的凭据。
 *
 * 优先级：coding-plan 的 api-key（长期有效）> oauth:zai 的 access_token >
 * zcodejwttoken > 任意叫 access_token/token 的字段 > 裸串本身。
 * 为什么要挑：credentials.json 里两类凭据并存，OAuth JWT 过期会先失效，
 * 默认拿它会让「明明有长期 key」的账号莫名 401。
 */
export function pickCredential(obj) {
  const entries = Object.entries(obj || {});
  const planKeys = entries.filter(([k]) => /coding-plan/.test(k) && /:api-key$/.test(k));
  if (planKeys.length) {
    // 多个计划（individual/team）都在时取第一个非空值 —— 平台不关心用户在哪个计划档
    for (const [, v] of planKeys) {
      const s = String(v || "").trim();
      if (s) return { token: s, kind: "coding-plan" };
    }
  }
  const oauth = entries.find(([k]) => k === "oauth:zai:access_token");
  if (oauth && String(oauth[1] || "").trim()) return { token: String(oauth[1]).trim(), kind: "oauth" };
  const jwt = entries.find(([k]) => k === "zcodejwttoken");
  if (jwt && String(jwt[1] || "").trim()) return { token: String(jwt[1]).trim(), kind: "jwt" };
  // 兜底：常见的通用字段名（也覆盖用户手工整理过的 JSON）
  for (const k of ["access_token", "accessToken", "api_key", "apiKey", "token"]) {
    const hit = entries.find(([key]) => key === k || key.endsWith(`:${k}`));
    if (hit && String(hit[1] || "").trim()) return { token: String(hit[1]).trim(), kind: k };
  }
  return null;
}

/** 兼容多种粘贴形态：整份凭据文件（扁平 KV）/ 普通 JSON / 裸 token 串 */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  if (text && !text.startsWith("{")) {
    return { token: text, kind: "raw", endpoint: "" };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（请粘贴 ZCode 的 credentials.json 内容）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const picked = pickCredential(j);
  if (!picked) {
    throw Object.assign(
      new Error("凭据里没有可用字段（需要 coding-plan 的 api-key，或 oauth:zai:access_token）"),
      { code: "LOGIN_BAD_PARAMS" }
    );
  }
  // endpoint 别名都认：用户可能粘 endpoint / base_url / baseUrl（与 WorkBuddy 同一套约定）
  const endpoint = String(j.endpoint || j.base_url || j.baseUrl || "").trim().replace(/\/+$/, "");
  return { ...picked, endpoint };
}

/** 渠道凭据 → { token, endpoint }（落库形态见 importAuth） */
function credsOf(channel) {
  const o = channel?.other || {};
  const token = String(channel?.api_key || o.access_token || "").trim();
  // 老渠道没有 other.endpoint 时用默认端点；显式存了就照用户的来
  const endpoint = String(o.endpoint || "").trim() || DEFAULT_ENDPOINT;
  return { token, endpoint, kind: String(o.credential_kind || "") };
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  return {
    token: cred.token,
    other: {
      method: "zcode",
      // 存「挑了哪类凭据」而不存整份原文：credentials.json 里可能同时有多把 key
      //（含其它计划的），落库只需要生效的那一把 + 够排错的元信息
      credential_kind: cred.kind,
      endpoint: cred.endpoint || DEFAULT_ENDPOINT,
    },
    accountLabel: `ZCode · ${cred.kind}`,
  };
}

/**
 * 装饰成 openai-compat 需要的形态。
 * 上游是标准 OpenAI 兼容 API，不需要额外头 —— 这里**刻意不注入**任何
 * user-agent / 指纹头：Z.ai 官方 API 面没有 WorkBuddy 那类客户端识别要求，
 * 多加的头反而会在上游调整时变成莫名 403 的来源。
 */
function decorated(channel) {
  const c = credsOf(channel);
  return {
    ...channel,
    base_url: c.endpoint,
    api_key: c.token,
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

/** 该接入方式的登录方式：粘贴凭据（凭据在本机 CLI 的文件里，无法服务端抓取） */
export function loginModes() {
  return ["paste"];
}

/** 国内 bigmodel 同形端点（供凭据 JSON 的 endpoint 字段参考；导出以便测试引用） */
export const CN_FALLBACK_ENDPOINT = CN_ENDPOINT;
