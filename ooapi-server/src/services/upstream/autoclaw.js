// 上游适配器：AutoClaw（智谱的 OpenClaw 一键部署工具，凭据反代）
// ===========================================================================
// 调研结论（2026-09-26，公开资料）：
//   AutoClaw 是智谱推出的开源部署工具，封装 OpenClaw 智能体框架
//  （预编译 Python 运行时 + 国内模型镜像代理 + CLI/WebUI）。
//   它初始化时要求填的凭据就是**智谱开放平台的 API Key**
//  （open.bigmodel.cn → 用户中心 → API Keys，形如 `id.secret`）——
//   所谓「国内模型镜像代理」就是 bigmodel 开放平台本身。
//
// 所以上游 = 智谱开放平台的标准 OpenAI 兼容 API：
//   POST {base}/chat/completions      对话（openai-compat 自行拼接）
//   GET  {base}/models                模型清单
// 默认 base = https://open.bigmodel.cn/api/paas/v4（国内）；
// 2026-09-26 匿名实测 GET /models 返回 401「Header中未收到Authorization参数」
// —— 路径存在、仅缺鉴权，地址确认。国际账号可用凭据 JSON 的 endpoint 字段
// 切到 https://api.z.ai/api/paas/v4（同样实测存在）。
//
// 与 GLM 厂商下 api 方式（同样走 bigmodel）的关系：模型与计费完全同源（vendor 归
// zhipu），区别只在**凭据的来历** —— 这里的 Key 来自 AutoClaw 工具的初始化配置，
// 与 ZCode 同属「工具凭据反代」一类；独立成厂商是产品口径（用户按工具找渠道），
// 不是协议差异。
import * as compat from "./openai-compat.js";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4";
const INTL_ENDPOINT = "https://api.z.ai/api/paas/v4";

/**
 * 兼容三种粘贴形态：
 *   ① 裸 Key 串（id.secret，AutoClaw 初始化时填的那种）；
 *   ② { "api_key": "..." } / { "apiKey": "..." }（推荐格式，见粘贴指引）；
 *   ③ 其它带 token 字段的 JSON（用户从别的工具导出的配置）。
 */
export function parseAuthJson(raw) {
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw || {});
  if (text && !text.startsWith("{")) {
    if (!text) {
      throw Object.assign(new Error("凭据为空：请粘贴智谱开放平台的 API Key"), {
        code: "LOGIN_BAD_PARAMS",
      });
    }
    return { token: text, endpoint: "" };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("凭据不是合法 JSON（可只粘 API Key 本身，或 { \"api_key\": \"...\" }）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const token = String(j.api_key || j.apiKey || j.token || j.access_token || j.accessToken || "").trim();
  if (!token) {
    throw Object.assign(new Error("凭据里没有 api_key（智谱开放平台的 API Key，形如 id.secret）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  const endpoint = String(j.endpoint || j.base_url || j.baseUrl || "").trim().replace(/\/+$/, "");
  return { token, endpoint };
}

/** 渠道凭据 → { token, endpoint } */
function credsOf(channel) {
  const o = channel?.other || {};
  const token = String(channel?.api_key || o.access_token || "").trim();
  const endpoint = String(o.endpoint || "").trim() || DEFAULT_ENDPOINT;
  return { token, endpoint };
}

export async function importAuth(input = {}) {
  const raw = input.token ?? input.auth ?? input.json ?? input;
  const cred = parseAuthJson(raw);
  return {
    token: cred.token,
    other: {
      method: "autoclaw",
      endpoint: cred.endpoint || DEFAULT_ENDPOINT,
    },
    accountLabel: "AutoClaw · 智谱开放平台",
  };
}

/**
 * 装饰成 openai-compat 需要的形态。
 * 标准官方 API 面，与 zcode.js 同理：**不注入**任何额外指纹头。
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

export function loginModes() {
  return ["paste"];
}

/** 国际端点（供凭据 JSON 的 endpoint 字段参考；导出以便测试引用） */
export const INTL_FALLBACK_ENDPOINT = INTL_ENDPOINT;
