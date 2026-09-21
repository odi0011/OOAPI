// 阶跃星辰 StepFun 网页版反代（chat.stepfun.com）
// ===========================================================================
// 协议依据：dijiaozhibei-top/step2api（2026-05）的 src/step2api/stepfun/{auth,chat,client}.py。
// 该实现是目前唯一公开的 StepFun 网页版反代，**验证较弱（2★、4 个月未更新）**，
// 所以下面每个假设都标注了置信度；私有 proto 字段可能漂移，接入后需实测核对。
//
// 重要更正（2026-09 实测）：
//   · **不要用「跃问」做接入点** —— yuewen.cn 的 TLS 证书已过期且返回 403，
//     stepfun.com 首页也零处提及该品牌，属于已退役。
//   · 接入点应是 **chat.stepfun.com**（Next.js SPA，手机号短信登录）。
//
// 协议特点：**零签名、零 PoW、零验证码**（源码层确认）——
// 全部难点只有两处：① Connect RPC 分帧；② 短信登录流程。
//
// 传输：Connect RPC（不是 SSE）
//   Content-Type: application/connect+json
//   connect-protocol-version: 1
//   分帧：[1B flags][4B BE length][JSON]；0x00=消息，0x02=end-stream
//   额外头：oasis-appid: 10200 / oasis-platform: web / oasis-language: zh / canary: false
//
// 登录态：**纯 HTTP Cookie**（passport 服务下发，domain=stepfun.com），无 token 字段。
//   流程：RegisterDevice → SendSmsCode → LoginBySmsCode → RefreshToken → GetUser
//   端点：POST https://www.stepfun.com/passport/proto.api.passport.v1.PassportService/{Method}
import crypto from "node:crypto";

const SITE = "https://www.stepfun.com";
const API = `${SITE}/api`;
const PASSPORT = `${SITE}/passport/proto.api.passport.v1.PassportService`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Connect 帧编码（请求与响应用同一格式） */
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * Connect 帧解码器（流式）。
 * 与 kimi 的帧格式相同，但**不能直接复用 kimi-parser**：
 * 那边解析的是 Kimi 自己的业务字段，这里只需要「切出 JSON 帧」这一层。
 */
function createFrameDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 5) return;
      const flags = buf[0];
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) return;
      const payload = buf.slice(5, 5 + len);
      buf = buf.slice(5 + len);
      if (flags === 0x02) continue; // end-stream：无 body
      let json = null;
      try {
        json = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      onMessage(json);
    }
  };
}

/** 统一请求头 */
function headers(channel, { connect = true, cookie } = {}) {
  const ck = cookie !== undefined ? cookie : (channel?.other?.cookies || "");
  return {
    "content-type": connect ? "application/connect+json" : "application/json",
    ...(connect ? { "connect-protocol-version": "1" } : {}),
    "oasis-appid": "10200",
    "oasis-platform": "web",
    "oasis-language": "zh",
    canary: "false",
    origin: SITE,
    referer: `${SITE}/`,
    "user-agent": UA,
    ...(ck ? { cookie: ck } : {}),
  };
}

/** cookie 串 → 对象数组（与其它反代渠道的 other.cookies 形态一致） */
function parseCookies(str) {
  return String(str || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return i > 0 ? { name: pair.slice(0, i), value: pair.slice(i + 1) } : null;
    })
    .filter(Boolean);
}
function cookieStr(list) {
  if (typeof list === "string") return list;
  return (Array.isArray(list) ? list : []).map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 适配器契约：解析粘贴的凭据 */
export async function importAuth(input = {}) {
  // 同 mimo-web：对象形态下只取字段，避免 String({}) → "[object Object]" 混进渠道
  const raw = String(typeof input === "string" ? input : (input.token ?? input.json ?? "")).trim();
  if (!raw) throw Object.assign(new Error("粘贴内容为空"), { code: "CHANNEL_BAD_PARAMS" });

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }
  let ck = "";
  if (obj && typeof obj === "object") {
    ck = Array.isArray(obj.cookies) ? cookieStr(obj.cookies) : String(obj.cookie || obj.cookies || "").trim();
  } else {
    ck = raw;
  }
  // cookie 串必须至少含一个 `name=value` —— 否则用户多半粘错了东西
  // （比如把密码或别家的 token 粘进来，那种情况要在提交时就拒绝，不能等到调用时才报错）
  if (!/=/.test(ck)) {
    throw Object.assign(new Error("没有解析到 Cookie，请复制 chat.stepfun.com 的登录态（形如 a=b; c=d）"), {
      code: "CHANNEL_BAD_PARAMS",
    });
  }
  return {
    // 与其它网页反代渠道一致：api_key 存「登录态」（这里是 cookie 串）
    token: ck,
    other: { method: "stepfun-web", cookies: parseCookies(ck) },
    accountLabel: "阶跃星辰 StepFun",
  };
}

export function authHint() {
  return "粘贴 chat.stepfun.com 的登录态：浏览器登录后复制 Cookie（含 stepfun 域下的会话 cookie）";
}

/** 建会话（每次对话前一次） */
async function createSession(channel, signal) {
  const resp = await fetch(`${API}/agent/capy.agent.v1.AgentService/CreateChatSession`, {
    method: "POST",
    headers: headers(channel),
    body: encodeFrame({}),
    signal,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效（401/403），请重新抓取 StepFun 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`建会话失败（HTTP ${resp.status}）：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  let sid = "";
  createFrameDecoder((j) => {
    sid = sid || j?.chatSession?.chatSessionId || j?.chatSessionId || "";
  })(buf);
  if (!sid) throw Object.assign(new Error("上游未返回会话 id"), { code: "CHANNEL_BAD_RESPONSE" });
  return sid;
}

export async function chat({ channel, model, prompt, thinkingOverride, images = [], onDelta, onReasoning, signal }) {
  if (images.length) {
    throw Object.assign(new Error("StepFun 网页版反代暂不支持图片输入（上传链路未接入）"), { code: "VISION_NOT_SUPPORTED" });
  }
  const modelId = String(model || "step-auto").replace(/^stepfun\//i, "");
  const enableReasoning = thinkingOverride !== undefined ? Boolean(thinkingOverride) : true;

  const sessionId = await createSession(channel, signal);

  const body = {
    message: {
      chatSessionId: sessionId,
      content: { userMessage: { qa: { content: prompt } } },
    },
    // 注意：参考实现用的是 "step-auto"；这里透传用户选的模型，
    // 上游不认识时会自己回落到默认档（私有 proto，字段可能漂移，已标注需实测）
    config: { model: modelId, enableReasoning },
  };

  const resp = await fetch(`${API}/agent/capy.agent.v1.AgentService/ChatStream`, {
    method: "POST",
    headers: headers(channel),
    body: encodeFrame(body),
    signal,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效，请重新抓取 StepFun 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw Object.assign(new Error(`上游返回 HTTP ${resp.status}：${t.slice(0, 200)}`), { code: "CHANNEL_HTTP_ERROR" });
  }
  if (!resp.body) throw Object.assign(new Error("上游未返回流"), { code: "CHANNEL_BAD_RESPONSE" });

  const reader = resp.body.getReader();
  let content = "";
  let reasoning = "";

  // 流事件（参考实现）：reasoningEvent.text / textEvent.text / messageDoneEvent / doneEvent
  const handleFrame = (j) => {
    if (!j || typeof j !== "object") return;
    const r = j.reasoningEvent?.text;
    if (typeof r === "string" && r) {
      reasoning += r;
      if (onReasoning) onReasoning(r);
    }
    const t = j.textEvent?.text;
    if (typeof t === "string" && t) {
      content += t;
      if (onDelta) onDelta(t);
    }
  };
  const decode = createFrameDecoder(handleFrame);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      decode(Buffer.from(value));
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content) {
    throw Object.assign(new Error(reasoning ? "上游只返回了思考内容，没有正文" : "上游返回空内容"), { code: "CHANNEL_EMPTY" });
  }
  return { content, reasoning, usage: null, upstreamModel: modelId };
}

/** 只检测凭据：拉模型配置（不建会话、不产生生成费用） */
export async function verify(channel) {
  const resp = await fetch(`${API}/agent/capy.agent.v1.AgentService/GetChatConfig`, {
    method: "POST",
    headers: headers(channel),
    body: encodeFrame({}),
    signal: AbortSignal.timeout(20000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error("登录态已失效，请重新抓取 StepFun 凭据"), { code: "CHANNEL_AUTH_EXPIRED" });
  }
  if (!resp.ok) throw Object.assign(new Error(`凭据检测失败（HTTP ${resp.status}）`), { code: "CHANNEL_HTTP_ERROR" });
  return { ok: true, account: "阶跃星辰 StepFun" };
}

export function loginModes() {
  return ["paste", "capture"];
}

export const ENTRY_URL = "https://chat.stepfun.com/";

export function fetchUpstreamModels() {
  return [
    { id: "step-5-preview", name: "Step 5 Preview" },
    { id: "step-3.7-flash", name: "Step 3.7 Flash" },
    { id: "step-3.5-flash", name: "Step 3.5 Flash" },
  ];
}
