// 小米 MiMo 网页版反代（aistudio.xiaomimimo.com）
// ===========================================================================
// 协议依据：wtz44/mimo-free-api（86★, MIT, Go）的 internal/mimo/web_client.go，
// 2026-09 检索。参考实现只保留网页端反代模式，与我们的做法一致。
//
// 为什么选**网页版**而不是桌面端：桌面端那套（Fly143/xiaomi-mimo-desktop-api 等）
// 走 OAuth + `mimo-x-preview` 头，且小米官方明确该模型只对桌面客户端开放；
// 网页版（MiMo Studio）走小米账号 SSO，凭据更稳定、也更符合本站「网页反代」的既有形态。
//
// 登录态：**纯 Cookie，无 token 字段**（三个值都是从 xiaomi 域带下来的）
//   · serviceToken        —— 主凭据
//   · userId              —— 用户标识（上游 API 也要用）
//   · xiaomichatbot_ph    —— 风控 ph token，**同时**要作为 URL query 参数带上
// 官方给的抓取方式就是它自己的 Chrome 扩展（扫 *mimo*/*xiaomi* 域取这三项），
// 说明凭据确实只有这三个。
//
// 协议特点（最干净的一家）：
//   · **零签名、零 PoW、零验证码** —— xiaomichatbot_ph 是登录时下发的静态值，之后纯复用
//   · 标准 SSE（`id:` / `event:` / `data:` 三行式）
//   · 对话端点 /open-apis/bot/chat?xiaomichatbot_ph=<ph>
import { randomUUID } from "node:crypto";
import { assertNoContentError } from "./content-error.js";
import { throwUpstreamHttpError } from "./http-error.js";

const SITE = "https://aistudio.xiaomimimo.com";
const API = `${SITE}/open-apis`;

/** 统一请求头（上游校验 Origin/Referer，缺失会被拒） */
function headers(channel, { sse = false } = {}) {
  const o = channel?.other || {};
  const cookie = [
    `serviceToken=${o.service_token || channel?.api_key || ""}`,
    `userId=${o.user_id || ""}`,
    `xiaomichatbot_ph=${o.ph || ""}`,
  ].join("; ");
  return {
    cookie,
    origin: SITE,
    referer: `${SITE}/`,
    "x-timezone": "Asia/Shanghai",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...(sse ? { accept: "text/event-stream" } : { accept: "application/json" }),
  };
}

/** 解析凭据：接受 JSON、裸 serviceToken、或浏览器 cookie 串 */
export function parseAuth(raw) {
  const text = String(raw || "").trim();
  if (!text) throw Object.assign(new Error("粘贴内容为空"), { code: "CHANNEL_BAD_PARAMS" });

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = null;
  }

  const pick = (...names) => {
    for (const n of names) {
      const v = obj?.[n] ?? obj?.cookies?.[n];
      if (v) return String(v).trim();
    }
    return "";
  };

  // 形态一：JSON（可能来自扩展导出或手工拼）
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const serviceToken = pick("serviceToken", "service_token", "token");
    // 也接受 "cookie": "a=b; c=d" 的形态
    const cookieStr = String(obj.cookie || obj.cookies_raw || "");
    if (!serviceToken && cookieStr) return parseCookieString(cookieStr);
    return {
      service_token: serviceToken,
      user_id: pick("userId", "user_id"),
      ph: pick("xiaomichatbot_ph", "ph"),
    };
  }

  // 形态二：浏览器里直接复制的 cookie 串
  if (/serviceToken=/.test(text) || text.includes(";")) return parseCookieString(text);

  // 形态三：只给了裸 serviceToken（最常见 —— 用户从 DevTools 里复制单个值）
  return { service_token: text, user_id: "", ph: "" };
}

/** 从 "a=b; c=d" 里取三个需要的值 */
function parseCookieString(str) {
  const get = (name) => {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "i").exec(str);
    return m ? decodeURIComponent(m[1].trim().replace(/^"|"$/g, "")) : "";
  };
  return {
    service_token: get("serviceToken"),
    user_id: get("userId"),
    ph: get("xiaomichatbot_ph"),
  };
}

/** 适配器契约：解析粘贴的凭据 */
export async function importAuth(input = {}) {
  // 取凭据文本：显式传 token/json 时用它，否则用 input 本身（可能是裸字符串）。
  // **对象形态下必须取字段** —— 直接把整个对象 String() 会得到 "[object Object]"，
  // 这种假凭据能通过校验并建成渠道，但永远 401（用户以为配好了）。
  const raw = typeof input === "string" ? input : (input.token ?? input.json ?? "");
  const cred = parseAuth(raw);
  if (!cred.service_token) {
    throw Object.assign(new Error("没有解析到 serviceToken，请确认复制的是小米 MiMo Studio 的登录态"), {
      code: "CHANNEL_BAD_PARAMS",
    });
  }
  return {
    // serviceToken 作为渠道 api_key（与其它网页反代渠道一致：api_key 存登录态）
    token: cred.service_token,
    other: {
      method: "mimo",
      service_token: cred.service_token,
      user_id: cred.user_id,
      ph: cred.ph,
    },
    accountLabel: cred.user_id ? `小米 MiMo（uid ${cred.user_id}）` : "小米 MiMo",
  };
}

export function authHint() {
  return "粘贴小米 MiMo Studio 的登录态：浏览器登录 aistudio.xiaomimimo.com 后，复制 Cookie 里的 serviceToken / userId / xiaomichatbot_ph（三个都要）";
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

/** SSE 单帧解析：上游是标准三行式（id/event/data） */
function parseSsePayload(line) {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;
  const payload = t.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * 从一帧里抽出正文与思考链。
 * MiMo 的字段形态在参考实现里是 `data.content`（流式增量）；
 * 这里同时兼容几种常见写法，避免上游小改版就整条链路失效。
 */
function extractDelta(ev) {
  if (!ev || typeof ev !== "object") return { text: "", reasoning: "" };
  const d = ev.data ?? ev;
  const text =
    (typeof d.content === "string" && d.content) ||
    (typeof d.text === "string" && d.text) ||
    (typeof d.delta === "string" && d.delta) ||
    (typeof ev.content === "string" && ev.content) ||
    "";
  const reasoning =
    (typeof d.reasoning_content === "string" && d.reasoning_content) ||
    (typeof d.reasoningContent === "string" && d.reasoningContent) ||
    (typeof d.thinking === "string" && d.thinking) ||
    "";
  return { text, reasoning };
}

export async function chat({ channel, model, prompt, thinkingOverride, images = [], onDelta, onReasoning, signal }) {
  const o = channel?.other || {};
  const ph = o.ph || "";
  const modelId = String(model || "mimo-v2.5").replace(/-(search|thinking)$/i, "");
  const thinking = thinkingOverride !== undefined ? Boolean(thinkingOverride) : /pro/i.test(modelId);

  if (images.length) {
    // 网页版上传链路未实现（参考实现也未覆盖图片）。
    // 明确报错而不是静默丢弃 —— 用户以为图发出去了但模型没看到是最坏的情况。
    throw Object.assign(new Error("MiMo 网页版反代暂不支持图片输入（上游上传链路未接入）"), {
      code: "VISION_NOT_SUPPORTED",
    });
  }

  const url = `${API}/bot/chat${ph ? `?xiaomichatbot_ph=${encodeURIComponent(ph)}` : ""}`;
  const body = {
    msgId: randomUUID(),
    conversationId: randomUUID(),
    query: prompt,
    messages: [],
    parentId: "0",
    save: true,
    isEditedQuery: false,
    source: "STATION",
    scene: "STATION",
    isLocal: false,
    modelConfig: {
      enableThinking: thinking,
      webSearchStatus: "disabled",
      model: modelId,
      temperature: 0.8,
      topP: 0.95,
    },
    multiMedias: [],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { ...headers(channel, { sse: true }), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
    // 三个码要分开处理：429=限流（可自愈）、403 可能是风控验证页或权限不足、
    // 401 才是真失效。原先一律按「凭据过期」抛，会让管理员对着好账号反复重抓
    // 也修不好（第 46 批复审点名）。分类与文案统一在 upstream/http-error.js。
    const eb = await resp.text().catch(() => "");
    throwUpstreamHttpError(resp.status, eb);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throwUpstreamHttpError(resp.status, t, "上游返回异常");
  }
  if (!resp.body) throw Object.assign(new Error("上游未返回流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const MAX_BUF = 8 * 1024 * 1024;
  let buf = "";
  let content = "";
  let reasoning = "";

  const handleLine = (line) => {
    const ev = parseSsePayload(line);
    if (!ev) return;
    const { text, reasoning: r } = extractDelta(ev);
    if (r) {
      reasoning += r;
      if (onReasoning) onReasoning(r);
    }
    if (text) {
      content += text;
      if (onDelta) onDelta(text);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_BUF) throw Object.assign(new Error("上游数据帧异常（单行超过 8MB）"), { code: "CHANNEL_BAD_RESPONSE" });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) {
    throw Object.assign(new Error(reasoning ? "上游只返回了思考内容，没有正文" : "上游返回空内容"), { code: "CHANNEL_EMPTY" });
  }
  // MiMo 网页版不返回 usage → 交给调用方估算（与其它反代渠道一致）
    // 上游可能用正常正文说错误（模型下线/权限不足），不能只看「有正文」就判成功
  assertNoContentError(content, "MiMo");
return { content, reasoning, usage: null, upstreamModel: modelId };
}

/** 只检测凭据有效性：拉用户信息（不产生生成费用） */
export async function verify(channel) {
  const resp = await fetch(`${API}/user/info`, { headers: headers(channel), signal: AbortSignal.timeout(15000) });
  if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
    // 三个码要分开处理：429=限流（可自愈）、403 可能是风控验证页或权限不足、
    // 401 才是真失效。原先一律按「凭据过期」抛，会让管理员对着好账号反复重抓
    // 也修不好（第 46 批复审点名）。分类与文案统一在 upstream/http-error.js。
    const eb = await resp.text().catch(() => "");
    throwUpstreamHttpError(resp.status, eb);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throwUpstreamHttpError(resp.status, t, "凭据检测失败");
  }
  const j = await resp.json().catch(() => null);
  const name = j?.data?.userName || j?.data?.nickname || j?.userName || "";
  return { ok: true, account: name ? `小米 MiMo（${name}）` : "小米 MiMo" };
}

/** 网页版反代不需要登录方式声明（走「抓取登录态」或粘贴） */
export function loginModes() {
  return ["paste", "capture"];
}

/** 抓取登录态的落地页 */
export const ENTRY_URL = "https://aistudio.xiaomimimo.com/";

/** 上游模型清单（网页版可选的模型） */
export function fetchUpstreamModels() {
  return [
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
  ];
}
