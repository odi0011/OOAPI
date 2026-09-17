// DeepSeek 网页版客户端（集成进 ooapi）
// 负责：创建会话 → 获取并求解 PoW → 请求 completion → 解析 SSE（新旧双格式）
// 请求头按官方前端 bundle 还原，含 x-client-* 家族与浏览器 cookies 指纹。
import { solvePow, buildPowHeader } from "./pow.js";
import { withAccountRateLimit, markMuted, markUnusable } from "./accounts.js";

const BASE = "https://chat.deepseek.com";
const API = BASE + "/api/v0";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function clientHeaders(token, { sse = false } = {}) {
  const h = {
    "user-agent": UA,
    accept: sse ? "text/event-stream" : "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: BASE,
    referer: BASE + "/",
    "sec-ch-ua": '"Chromium";v="138", "Google Chrome";v="138", "Not?A_Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-client-bundle-id": "chat_web",
    "x-client-platform": "web",
    "x-client-version": "2.4.0",
    "x-client-locale": "zh_CN",
    "x-client-timezone-offset": "28800",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function cookieHeader(account) {
  const list = Array.isArray(account?.cookies) ? account.cookies : [];
  return list
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function isWafBlocked(resp, text) {
  return (
    resp.status === 202 ||
    resp.status === 403 ||
    resp.status === 405 ||
    text.includes("Request Blocked") ||
    text.includes("Rate Limit Reached") ||
    text.includes("x-amzn-waf-action") ||
    text.includes("The request could not be satisfied")
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertBiz(json, what, account) {
  const bizCode = json?.data?.biz_code ?? json?.code;
  if (bizCode !== 0 && bizCode !== undefined) {
    const bizData = json?.data?.biz_data ?? {};
    // token 失效 / 权限失效
    if (bizCode === 40002 || bizCode === 40003 || bizCode === 401) {
      if (account) {
        markUnusable(account, 6 * 3600, `token 无效（biz_code=${bizCode}）`).catch(() => {});
      }
      throw Object.assign(new Error(`${what} 失败：账号 token 已失效，请在后台更新该账号`), {
        code: "AUTH_EXPIRED",
        bizCode,
      });
    }
    // 被禁言（风控）
    if (bizCode === 5 || bizData.is_muted === 1 || /muted/i.test(json?.data?.biz_msg ?? "")) {
      const untilSec = Number(bizData.mute_until || 0);
      if (account) markMuted(account, untilSec).catch(() => {});
      const untilStr = untilSec
        ? new Date(untilSec * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : "未知";
      throw Object.assign(
        new Error(`该 DeepSeek 账号已被风控禁言，解禁时间约 ${untilStr}（系统已自动切换到其他账号）`),
        { code: "ACCOUNT_MUTED", bizCode }
      );
    }
    throw Object.assign(
      new Error(`${what} 失败：${json?.data?.biz_msg ?? json?.msg ?? "未知错误"}（biz_code=${bizCode}）`),
      { code: "BIZ_ERROR", bizCode }
    );
  }
}

async function dsFetch(path, { method = "GET", body, account, maxRetries = 3 } = {}) {
  const token = account?.token;
  if (!token) {
    throw Object.assign(new Error("账号缺少 token"), { code: "NO_AUTH" });
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1500 * Math.pow(2.7, attempt - 1));
    let resp;
    try {
      resp = await fetch(API + path, {
        method,
        headers: { ...clientHeaders(token), cookie: cookieHeader(account) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      lastErr = Object.assign(new Error(`网络错误：${e.message}`), { code: "NETWORK_ERROR" });
      continue;
    }
    const text = await resp.text();
    if (isWafBlocked(resp, text)) {
      lastErr = Object.assign(
        new Error(`请求被 DeepSeek WAF 拦截（HTTP ${resp.status}），已重试 ${attempt + 1} 次`),
        { code: "WAF_BLOCKED" }
      );
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`接口返回非 JSON（HTTP ${resp.status}）`), { code: "BAD_RESPONSE" });
    }
    return { status: resp.status, json };
  }
  throw lastErr;
}

// 创建会话
export async function createSession(account) {
  const { json } = await dsFetch("/chat_session/create", { method: "POST", body: {}, account });
  assertBiz(json, "创建会话", account);
  const biz = json.data?.biz_data ?? {};
  const id = biz.id ?? biz.chat_session?.id;
  if (!id) {
    throw Object.assign(new Error("创建会话失败：响应缺少会话 ID"), { code: "BAD_RESPONSE" });
  }
  return id;
}

// 获取 PoW 挑战并本地求解
export async function getPowHeader(account, targetPath = "/api/v0/chat/completion") {
  const { json } = await dsFetch("/chat/create_pow_challenge", {
    method: "POST",
    body: { target_path: targetPath },
    account,
  });
  assertBiz(json, "获取 PoW 挑战", account);
  const challenge = json.data?.biz_data?.challenge;
  if (!challenge) {
    throw Object.assign(new Error("PoW 挑战响应异常"), { code: "BAD_CHALLENGE" });
  }
  challenge.target_path = targetPath;
  const answer = await solvePow(challenge);
  return buildPowHeader(challenge, answer);
}

// 上传图片（视觉链路），返回 file id；buffer 全程内存中转，不落盘
export async function uploadFile({ buffer, filename, mimeType, account }) {
  const powHeader = await getPowHeader(account, "/api/v0/file/upload_file");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const headers = { ...clientHeaders(account.token), "x-ds-pow-response": powHeader, cookie: cookieHeader(account) };
  delete headers["content-type"]; // 让 fetch 自动生成带 boundary 的 multipart 头
  const resp = await fetch(API + "/file/upload_file", { method: "POST", headers, body: form });
  const text = await resp.text();
  if (isWafBlocked(resp, text)) {
    throw Object.assign(new Error("图片上传被 WAF 拦截"), { code: "WAF_BLOCKED" });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("图片上传返回异常"), { code: "BAD_RESPONSE" });
  }
  assertBiz(json, "上传图片", account);
  const biz = json.data?.biz_data ?? {};
  const id = biz.id ?? biz.file_id ?? biz.file?.id;
  if (!id) {
    throw Object.assign(new Error("图片上传失败：响应缺少文件 ID"), { code: "BAD_RESPONSE" });
  }
  return id;
}

// ---------- SSE 解析状态机（兼容官方新旧两种格式） ----------
export function createSseParser() {
  let currentPath = "";
  let lastFragType = null;
  let finished = false;
  let errorMessage = null;
  let accumulatedUsage = 0; // 上游累计 token 用量

  const isThink = (t) => t === "THINK";

  function handleFragments(frags, emit) {
    for (const frag of frags) {
      if (!frag || typeof frag !== "object") continue;
      if (frag.type) lastFragType = frag.type;
      if (isThink(frag.type)) emit({ reasoning: frag.content ?? "" });
      else if (frag.type === "RESPONSE" || frag.type === "ANSWER") emit({ content: frag.content ?? "" });
      else if (typeof frag.content === "string") emit({ content: frag.content });
    }
  }

  function extract(patch, emit) {
    if (patch && typeof patch === "object" && "v" in patch) {
      if ("p" in patch && typeof patch.p === "string") currentPath = patch.p;
      const v = patch.v;

      if (typeof currentPath === "string" && currentPath.startsWith("response/fragments")) {
        if (typeof v === "string") {
          if (isThink(lastFragType)) emit({ reasoning: v });
          else emit({ content: v });
          return;
        }
        handleFragments(Array.isArray(v) ? v : [v], emit);
        return;
      }

      if (currentPath === "response/thinking_content") emit({ reasoning: String(v) });
      else if (currentPath === "response/content") emit({ content: String(v) });
      else if (currentPath === "response/accumulated_token_usage") {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) accumulatedUsage = n;
      } else if (currentPath === "response/status") {
        if (v === "FINISHED" || v === "STATUS_FINISHED" || v === "finished") finished = true;
      } else if (currentPath === "response/error" || patch.type === "error") {
        errorMessage = typeof v === "string" ? v : JSON.stringify(v);
      }
      return;
    }
    if (patch && patch.type === "error") {
      errorMessage = patch.content ?? JSON.stringify(patch);
    }
  }

  return {
    push(jsonText) {
      if (jsonText === "[DONE]") {
        finished = true;
        return null;
      }
      let frame;
      try {
        frame = JSON.parse(jsonText);
      } catch {
        return null;
      }
      let out = null;
      const emit = (delta) => {
        if (!out) out = { reasoning: "", content: "" };
        if (delta.reasoning) out.reasoning += delta.reasoning;
        if (delta.content) out.content += delta.content;
      };

      if (frame && typeof frame === "object" && "v" in frame) {
        const v = frame.v;
        if (v && typeof v === "object" && v.response && !v.response.fragments) {
          // ready 帧，无增量
        } else if (v && typeof v === "object" && v.response?.fragments) {
          handleFragments(v.response.fragments, emit);
        } else {
          extract(frame, emit);
        }
      } else if (Array.isArray(frame)) {
        for (const p of frame) extract(p, emit);
      } else {
        extract(frame, emit);
      }
      return out;
    },
    get finished() {
      return finished;
    },
    get error() {
      return errorMessage;
    },
    get usage() {
      return accumulatedUsage;
    },
  };
}

// 发送消息并流式返回增量（整个会话创建 + PoW + completion 套一次账号限速）
export async function streamCompletion({
  prompt,
  thinkingEnabled = false,
  searchEnabled = false,
  refFileIds = [],
  account,
  onDelta,
  onUsage,
  signal,
}) {
  return withAccountRateLimit(account, async () => {
    const sessionId = await createSession(account);

    // 视觉请求：先上传图片拿 ref_file_ids
    const fileIds = [...refFileIds];
    if (fileIds.length === 0) {
      // 图片由调用方预先上传（见 gateway）
    }

    const powHeader = await getPowHeader(account, "/api/v0/chat/completion");
    const body = {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: fileIds,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
    };
    if (fileIds.length > 0) body.model_type = "vision";

    const headers = clientHeaders(account.token, { sse: true });
    headers["x-ds-pow-response"] = powHeader;
    headers.cookie = cookieHeader(account);

    const resp = await fetch(API + "/chat/completion", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    const probe = (resp.headers.get("content-type") || "").toLowerCase();
    if (resp.status === 202 || resp.status === 403 || probe.includes("text/html")) {
      throw Object.assign(new Error(`completion 被 WAF 拦截（HTTP ${resp.status}）`), { code: "WAF_BLOCKED" });
    }
    if (resp.status === 401) {
      if (account) markUnusable(account, 6 * 3600, "HTTP 401 token 失效").catch(() => {});
      throw Object.assign(new Error("该账号登录态已失效（401），请在后台更新 token"), { code: "AUTH_EXPIRED" });
    }
    if (!resp.ok && resp.status !== 200) {
      const text = await resp.text().catch(() => "");
      throw Object.assign(new Error(`completion 请求失败 HTTP ${resp.status}：${text.slice(0, 160)}`), {
        code: "HTTP_ERROR",
      });
    }
    // 业务错误（如禁言）会返回 200 + JSON
    if (probe.includes("application/json")) {
      const text = await resp.text().catch(() => "");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw Object.assign(new Error("completion 返回异常内容"), { code: "BAD_RESPONSE" });
      }
      assertBiz(json, "发送消息", account);
      throw Object.assign(new Error("completion 返回未知响应"), { code: "BAD_RESPONSE" });
    }
    if (!resp.body) {
      throw Object.assign(new Error("上游没有返回内容流"), { code: "HTTP_ERROR" });
    }

    const parser = createSseParser();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedAny = false;

    const handleLine = (line) => {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      const delta = parser.push(payload);
      if (delta && (delta.reasoning || delta.content)) {
        receivedAny = true;
        if (onDelta) onDelta(delta);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());

    if (parser.error && !parser.finished) {
      throw Object.assign(new Error(`DeepSeek 返回错误：${parser.error}`), { code: "STREAM_ERROR" });
    }
    if (!receivedAny) {
      throw Object.assign(
        new Error("该账号返回了空回复（通常是被风控限制），请稍后重试"),
        { code: "EMPTY_STREAM" }
      );
    }
    // 上游真实用量（用于计费），拿不到则由调用方估算
    if (onUsage && parser.usage > 0) {
      onUsage({ total: parser.usage });
    }
    return { finished: parser.finished };
  });
}

// 校验账号可用性（后台测试用）
export async function verifyAccount(account) {
  const sessionId = await createSession(account);
  return Boolean(sessionId);
}
