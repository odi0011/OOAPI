// MiniMax 网页版反代（agent.minimaxi.com —— 原 chat.minimaxi.com 已 307 跳转）
// ===========================================================================
// 协议依据：snake-aabb-wtf/minimaxM3-web2api（GPLv3, 2026-06）的 sign.py / adapter.py，
// 该实现把签名算法完整逆向并通过真实网关验证（qwen3-max 返回 200 且有完成内容）。
//
// **签名是纯 MD5，无 PoW / 无 wasm / 无 SM3** —— 这是四家里唯一算法级可复刻的：
//   x-signature = MD5(timestamp_seconds + "I*7Cf%WZ#S&%1RlZJ&C2" + body_json)
//                 （硬编码静态密钥，**与 URL 无关**）
//   yy          = MD5(encodeURIComponent(full_url) + "_" + body_json
//                     + MD5(str(timestamp_ms)) + "ooui")
//   yy 还依赖一组运行时指纹参数（uuid/device_id/user_id/screen_* 等），
//   首次需要 HAR 抓一次，之后纯 HTTP 长期复用 —— 与本站「抓取登录态」的形态一致。
//
// 登录态：JWT `token`，**同时放请求头与 URL query**。
// 主机：agent.minimaxi.com（控制）/ agent-stream.minimaxi.com（流式）。
//
// 注意：**不要按 chat.minimaxi.com 规划** —— 实测该域名只剩 307 跳转，
// 实际入口是 agent.minimaxi.com（产品名 MiniMax Agent）。
import crypto from "node:crypto";

const SITE = "https://agent.minimaxi.com";
const STREAM_HOST = "https://agent-stream.minimaxi.com";
/** 硬编码静态密钥（来自前端 Webpack 模块 97516 的签名函数） */
const SIGN_KEY = "I*7Cf%WZ#S&%1RlZJ&C2";

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

/** 适配器契约：解析粘贴的凭据（token JWT + 可选指纹） */
export async function importAuth(input = {}) {
  const raw = String(input.token ?? input.json ?? input ?? "").trim();
  if (!raw) throw Object.assign(new Error("粘贴内容为空"), { code: "CHANNEL_BAD_PARAMS" });

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }

  // 三种形态：完整 JSON（含指纹）/ 只给 token / cookie 串
  let token = "";
  let fp = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    token = String(obj.token || obj.access_token || obj.accessToken || "").trim();
    fp = obj.fingerprint || obj.fp || obj;
  } else if (/token=/.test(raw)) {
    const m = /(?:^|;\s*)token=([^;]+)/i.exec(raw);
    token = m ? decodeURIComponent(m[1].trim().replace(/^"|"$/g, "")) : "";
  } else {
    token = raw;
  }
  if (!token) {
    throw Object.assign(new Error("没有解析到 token，请确认复制的是 agent.minimaxi.com 的登录态"), {
      code: "CHANNEL_BAD_PARAMS",
    });
  }

  // 指纹：缺省时用稳定派生值（随机变化是强风控信号，同一账号必须固定）
  const seed = md5(token);
  const hex = (n, len) => seed.slice(n, n + len);
  const pickStr = (names, fallback) => {
    for (const n of names) {
      const v = fp?.[n];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
    return fallback;
  };

  const other = {
    method: "minimax-web",
    token,
    fingerprint: {
      uuid: pickStr(["uuid"], `${hex(0, 8)}-${hex(8, 4)}-${hex(12, 4)}-${hex(16, 4)}-${hex(20, 12)}`),
      device_id: pickStr(["device_id", "deviceId"], hex(0, 32)),
      user_id: pickStr(["user_id", "userId"], ""),
      // 屏幕尺寸参与签名，抓包时的值一旦固定就不要改（改了 yy 会算错）
      screen_width: Number(pickStr(["screen_width", "screenWidth"], "1920")) || 1920,
      screen_height: Number(pickStr(["screen_height", "screenHeight"], "1080")) || 1080,
      device_memory: Number(pickStr(["device_memory", "deviceMemory"], "8")) || 8,
      cpu_core_num: Number(pickStr(["cpu_core_num", "hardwareConcurrency"], "8")) || 8,
    },
  };
  return { token, other, accountLabel: "MiniMax Agent" };
}

export function authHint() {
  return "粘贴 MiniMax Agent（agent.minimaxi.com）的登录态：复制 Cookie 里的 token（JWT），或粘贴抓包导出的 {token, fingerprint} JSON";
}

/** 构造带签名的请求头 */
function signedHeaders(channel, { url, body, sse = false }) {
  const o = channel?.other || {};
  const fp = o.fingerprint || {};
  const token = o.token || channel?.api_key || "";
  const bodyStr = body ? JSON.stringify(body) : "";
  const tsSec = Math.floor(Date.now() / 1000);
  const tsMs = Date.now();

  // x-signature：时间戳（秒）+ 静态密钥 + body
  const xSignature = md5(`${tsSec}${SIGN_KEY}${bodyStr}`);
  // yy：URL 编码后的完整地址 + "_" + body + MD5(毫秒时间戳) + "ooui"
  const yy = md5(`${encodeURIComponent(url)}_${bodyStr}${md5(String(tsMs))}ooui`);

  return {
    authorization: `Bearer ${token}`,
    "x-signature": xSignature,
    yy,
    "biz-id": "3",
    "app-id": "3001",
    "version-code": "22201",
    "device-platform": "web",
    "device-id": String(fp.device_id || ""),
    uuid: String(fp.uuid || ""),
    "user-id": String(fp.user_id || ""),
    "screen-width": String(fp.screen_width || 1920),
    "screen-height": String(fp.screen_height || 1080),
    "device-memory": String(fp.device_memory || 8),
    "cpu-core-num": String(fp.cpu_core_num || 8),
    "timezone-offset": String(new Date().getTimezoneOffset()),
    "os-name": "Windows",
    "browser-name": "Chrome",
    referer: `${SITE}/`,
    origin: SITE,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "content-type": "application/json",
    ...(sse ? { accept: "text/event-stream" } : { accept: "application/json" }),
  };
}

/** token 也要作为 query 参数带上（上游双校验） */
function withToken(url, channel) {
  const token = channel?.other?.token || channel?.api_key || "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** 建会话（每次对话前一次） */
async function createSession(channel, model, signal) {
  const url = withToken(`${SITE}/archon/api/v1/agent/1/session`, channel);
  const body = { team_mode_off: true, model: String(model || "").replace(/^minimax\//i, "") };
  const resp = await fetch(url, {
    method: "POST",
    headers: signedHeaders(channel, { url, body }),
    body: JSON.stringify(body),
    signal,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效（401/403），请重新抓取 MiniMax 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (resp.status === 409) {
    // 会话忙：重建（参考实现的做法）
    throw Object.assign(new Error("上游会话忙，请重试"), { code: "CHANNEL_RATE_LIMIT" });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`建会话失败（HTTP ${resp.status}）：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  const j = await resp.json().catch(() => null);
  const sid = j?.data?.session_id || j?.session_id || j?.data?.sessionId;
  if (!sid) throw Object.assign(new Error("上游未返回会话 id"), { code: "CHANNEL_BAD_RESPONSE" });
  return String(sid);
}

export async function chat({ channel, model, prompt, thinkingOverride, images = [], onDelta, onReasoning, signal }) {
  if (images.length) {
    throw Object.assign(new Error("MiniMax 网页版反代暂不支持图片输入（上传链路未接入）"), { code: "VISION_NOT_SUPPORTED" });
  }
  const modelId = String(model || "MiniMax-M2.7").replace(/-(search|thinking)$/i, "");
  const sessionId = await createSession(channel, modelId, signal);

  const url = withToken(`${STREAM_HOST}/archon/api/v1/session/${sessionId}/message`, channel);
  const body = {
    content: prompt,
    model: { provider_id: "minimax", model_id: modelId },
    turn_id: crypto.randomUUID(),
    worktreeMode: false,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: signedHeaders(channel, { url, body, sse: true }),
    body: JSON.stringify(body),
    signal,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效，请重新抓取 MiniMax 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`上游返回 HTTP ${resp.status}：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  if (!resp.body) throw Object.assign(new Error("上游未返回流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const MAX_BUF = 8 * 1024 * 1024;
  let buf = "";
  let content = "";
  let reasoning = "";

  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    // 参考实现的事件语义：type==6 → agent_message_chunk.msg_content
    //（同时兼容 type==2 的 agent_message.finish_reason 等形态）
    const chunk = ev.agent_message_chunk || ev.data?.agent_message_chunk;
    if (chunk) {
      const text = typeof chunk.msg_content === "string" ? chunk.msg_content : "";
      if (text) {
        content += text;
        if (onDelta) onDelta(text);
      }
      return;
    }
    const msg = ev.agent_message || ev.data?.agent_message;
    if (msg) {
      const r = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
      if (r) {
        reasoning += r;
        if (onReasoning) onReasoning(r);
      }
      const text = typeof msg.msg_content === "string" ? msg.msg_content : "";
      if (text && !content.endsWith(text)) {
        // agent_message 是「整段」而不是增量：只在内容还没被 chunk 累加时用它兜底
        if (!content) {
          content = text;
          if (onDelta) onDelta(text);
        }
      }
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
  return { content, reasoning, usage: null, upstreamModel: modelId };
}

/** 只检测凭据：查用户信息（不建会话、不产生生成费用） */
export async function verify(channel) {
  const url = withToken(`${SITE}/archon/api/v1/user/info`, channel);
  const resp = await fetch(url, { headers: signedHeaders(channel, { url }), signal: AbortSignal.timeout(15000) });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效，请重新抓取 MiniMax 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) throw Object.assign(new Error(`凭据检测失败（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  return { ok: true, account: "MiniMax Agent" };
}

export function loginModes() {
  return ["paste", "capture"];
}

export const ENTRY_URL = "https://agent.minimaxi.com/";

export function fetchUpstreamModels() {
  return [
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "MiniMax-M2.1", name: "MiniMax M2.1" },
  ];
}
