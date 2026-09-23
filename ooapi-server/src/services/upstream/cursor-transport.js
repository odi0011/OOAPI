// Cursor 的 HTTP/2 + Connect 传输层
// ===========================================================================
// 为什么 Cursor 需要一层**独立的传输**（不能用项目里其它适配器共用的 fetch）：
//   它的后端 api2.cursor.sh **只讲 HTTP/2**，而且请求体是 Connect 协议帧
//   （`application/connect+json`）。实测（2026-09-23，全部在服务器上跑）：
//
//     · Node 全局 fetch（undici，走 h1.1）→ **HTTP 415**（content-type 不被接受）
//       连 `content-type: application/json` 也一样，因为那套端点只认 Connect 帧
//     · node:http2 + `application/connect+json` + **5 字节帧头** → **HTTP 200**
//       并进入业务层（带假 token 时返回 Connect 帧里的
//       `{"error":{"code":"unauthenticated","message":"Error",
//        "details":[{"debug":{"error":"ERROR_NOT_LOGGED_IN"}}]}}`）
//     · 不帧装（空 body）→ 帧里回 `protocol error: missing input message for
//       server-streaming method` —— 反过来证明帧是必需的
//     · 老社区项目打的 `StreamUnifiedChatWithTools` 现在 **404**（端点已下线），
//       现在可用的是 `aiserver.v1.AiService/StreamChat`（实测 200）
//
// 帧格式（Connect 的 "enveloped" 模式）：
//   [1 字节 flag=0][4 字节大端长度][UTF-8 JSON]
//   响应同构，可能多帧；错误帧的 flag=2。
//
// ⚠️ 这一层**不走 guardedFetch**（那是给 fetch 用的），所以 SSRF 防护必须自己做：
//   · 主机白名单（只允许 cursor.sh 及其子域）；
//   · 不允许跟随重定向（http2 默认不跟随，这里显式确认）；
//   · 超时上限。
import http2 from "node:http2";

/** 只允许 Cursor 自己的域（SSRF 防护：这一层绕过了项目共用的 guardedFetch） */
const ALLOWED_HOSTS = new Set(["api2.cursor.sh", "us.api2.cursor.sh", "api.cursor.com", "cursor.com", "www.cursor.com"]);

export function assertCursorHost(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw Object.assign(new Error(`地址不是合法 URL：${url}`), { code: "CHANNEL_NOT_READY" });
  }
  if (u.protocol !== "https:") {
    throw Object.assign(new Error("Cursor 只允许 https"), { code: "CHANNEL_NOT_READY" });
  }
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith(".cursor.sh")) {
    throw Object.assign(
      new Error(`只允许访问 Cursor 官方域（收到 ${host}）—— 凭据不能外发到第三方主机`),
      { code: "CHANNEL_NOT_READY" }
    );
  }
  return u;
}

/** 把一个对象打成 Connect 帧 */
export function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(5);
  head[0] = 0; // flag 0 = 数据帧
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * 解 Connect 帧（可能多帧，也可能收到半帧 —— 流式时最后一段常不完整）。
 * @returns {{frames: Array<{flag:number, json:any, raw:string}>, rest: Buffer}}
 *   rest = 还没收全的尾巴，调用方留着与下一段拼接
 */
export function decodeFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf[i];
    const len = buf.readUInt32BE(i + 1);
    // 防御：声明长度超过实际收到的（半帧）或离谱地大 → 停下等更多数据
    if (len > 64 * 1024 * 1024) break;
    if (i + 5 + len > buf.length) break;
    const raw = buf.subarray(i + 5, i + 5 + len).toString("utf8");
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    frames.push({ flag, json, raw });
    i += 5 + len;
  }
  return { frames, rest: buf.subarray(i) };
}

/**
 * 判断 Connect 错误帧。
 * 上游对**未认证**也返回 HTTP 200，错误在帧里（flag=2 或 {error:{...}}）——
 * 不解析就会把认证失败当成"空回复"（Qoder/Trae 都踩过同一类坑）。
 */
export function detectFrameError(json) {
  const err = json?.error;
  if (!err) return null;
  const code = String(err.code || "");
  const debug = err.details?.[0]?.debug?.error || "";
  const detail = err.details?.[0]?.debug?.details?.detail || err.details?.[0]?.debug?.details?.title || "";
  const message = String(err.message || "") + (detail ? `：${detail}` : "");
  if (code === "unauthenticated" || /NOT_LOGGED_IN|UNAUTHENTICATED/i.test(debug)) {
    return { code: "CHANNEL_AUTH_EXPIRED", message: `Cursor 认证失败（${debug || code}）：凭据无效或已过期，请重新获取` };
  }
  if (code === "permission_denied") {
    return { code: "CHANNEL_FORBIDDEN", message: `Cursor 权限不足：${message}` };
  }
  // 限流/额度：**三个来源都要看**（code 规范值 / debug 码 / message 文案）。
  // 只查前两个会漏掉上游用自然语言描述限流的情况（实测有 message 里带
  // "quota exceeded" 而 code 是个泛化值的时候），那会让限流被当成普通业务错误 ——
  // 后果是渠道不冷却、立刻重试，把临时限流打成更严的限流。
  if (code === "resource_exhausted" || /rate|quota|limit|too many/i.test(`${code} ${debug} ${message}`)) {
    return { code: "CHANNEL_RATE_LIMITED", message: `Cursor 限流/额度用尽：${message}` };
  }
  return { code: "CHANNEL_BIZ_ERROR", message: `Cursor 上游错误（${code || "?"}）：${message || debug}` };
}

/**
 * 发一个 Connect 帧请求，按流回调。
 * @param {object} o
 * @param {string} o.url            完整地址
 * @param {object} o.headers        请求头
 * @param {object} o.body           会被打成 Connect 帧
 * @param {(frames:Array)=>void} o.onFrames  每收到（解出的）帧就回调
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status:number, contentType:string}>}
 */
export function connectPost({ url, headers, body, onFrames, signal, timeoutMs = 120_000 }) {
  const u = assertCursorHost(url);
  return new Promise((resolve, reject) => {
    let client = null;
    let settled = false;
    let rest = Buffer.alloc(0);
    const cleanup = () => {
      try {
        client?.close();
      } catch {
        /* 已关闭 */
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error(`Cursor 请求超时（${timeoutMs}ms）`), { code: "CHANNEL_TIMEOUT" })), timeoutMs);
    const onAbort = () => fail(Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      client = http2.connect(`${u.protocol}//${u.host}`);
    } catch (e) {
      clearTimeout(timer);
      return fail(Object.assign(new Error(`无法连接 Cursor：${e.message}`), { code: "CHANNEL_NETWORK" }));
    }
    client.on("error", (e) => {
      clearTimeout(timer);
      fail(Object.assign(new Error(`Cursor 连接错误：${e.message}`), { code: "CHANNEL_NETWORK" }));
    });

    const req = client.request({
      ":method": "POST",
      ":path": u.pathname + u.search,
      // 这两个头是 Connect 协议的必需项（缺了上游按其它协议解析 → 415）
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      ...headers,
    });

    let status = 0;
    let contentType = "";
    req.on("response", (h) => {
      status = Number(h[":status"]) || 0;
      contentType = String(h["content-type"] || "");
    });
    req.on("data", (chunk) => {
      if (!onFrames) return;
      rest = Buffer.concat([rest, chunk]);
      const { frames, rest: tail } = decodeFrames(rest);
      rest = tail;
      if (frames.length) onFrames(frames);
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fail(Object.assign(new Error(`Cursor 请求失败：${e.message}`), { code: "CHANNEL_NETWORK" }));
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      cleanup();
      // 尾巴里可能还有一帧（没有结尾空行的实现）
      if (onFrames && rest.length >= 5) {
        const { frames } = decodeFrames(rest);
        if (frames.length) onFrames(frames);
      }
      resolve({ status, contentType });
    });
    req.end(encodeFrame(body));
  });
}

/** 一元调用（非流式）：收齐所有帧后返回合并结果 */
export async function connectUnary({ url, headers, body, signal, timeoutMs }) {
  const frames = [];
  const { status, contentType } = await connectPost({
    url,
    headers,
    body,
    onFrames: (fs) => frames.push(...fs),
    signal,
    timeoutMs,
  });
  // 一元调用也走 Connect 帧（实测 AvailableModels 用 h1 直接 415）
  const first = frames[0]?.json || null;
  const err = detectFrameError(first);
  if (err) throw Object.assign(new Error(err.message), { code: err.code });
  return { status, contentType, json: first, frames };
}
