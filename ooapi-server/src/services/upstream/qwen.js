// 上游适配器：qwen（阿里通义千问网页版）
// ---------------------------------------------------------------------------
// 为什么用浏览器驱动：阿里系有较重的风控（Baxia umidToken、ssxmod 指纹、
// doQwenAuth HMAC 签名），其中 umidToken 与签名算法都在闭源 SDK 内，
// 纯 HTTP 复现不可行。因此与 GLM 同策略：浏览器承载会话，页面自己过风控。
//
// 账号 = channels 表一行 type='qwen'：
//   · api_key       → 可留空（浏览器用自己 cookie 里的登录态）
//   · other.profile → 设备指纹
// ---------------------------------------------------------------------------
import { createQwenParser, extractQwenSseData } from "./qwen-parser.js";
import { resolveModel } from "./qwen-models.js";
import { resolveProfile } from "./shared-profile.js";
import {
  getSession,
  installHook,
  resetHook,
  fillInput,
  submit,
  streamCapture,
  withLock,
  closeSession,
  newConversation,
  markReady,
} from "./browser-driver.js";

// 国际版与 CN 版的入口
const ENTRY_URL = "https://chat.qwen.ai/";
const MATCH_PATHS = ["/api/v2/chat/completions", "/dialog/conversation"];

const SEND_SELECTORS = [
  'button[type="submit"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
];

/** 健康检查 */
export async function verify(channel) {
  const started = Date.now();
  const { profile } = resolveProfile(channel, { vendor: "qwen" });
  const session = await getSession({
    vendor: "qwen",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile,
  });

  return withLock(session, async () => {
    const { page } = session;
    await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // WAF 挑战页检测（阿里云 AliyunCaptcha）
    const body = await page.locator("body").innerText().catch(() => "");
    if (/captcha|验证|滑块|aliyun_waf/i.test(body.slice(0, 2000))) {
      throw Object.assign(
        new Error("页面被阿里云 WAF 拦截（需人机验证），请在服务器上人工过一次验证"),
        { code: "CHANNEL_CAPTCHA" }
      );
    }

    const ready = await page.locator("textarea, [contenteditable='true'], div[role='textbox']").first().count();
    if (!ready) {
      throw Object.assign(
        new Error("页面未就绪（找不到输入框），可能需要在服务器上人工登录一次通义账号"),
        { code: "CHANNEL_NOT_READY" }
      );
    }
    markReady("qwen", channel.id);
    return Date.now() - started;
  });
}

/**
 * 执行一次对话
 */
export async function chat({
  channel,
  model,
  prompt,
  thinkingOverride,
  search = false,
  images = [],
  onDelta,
  onReasoning,
  signal,
}) {
  const resolved = resolveModel(model);
  const thinking = thinkingOverride !== undefined ? Boolean(thinkingOverride) : resolved.thinking;

  if (images.length) {
    throw Object.assign(new Error("通义千问渠道暂不支持图片输入，请改用文本"), { code: "VISION_NOT_SUPPORTED" });
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
  }

  const { profile } = resolveProfile(channel, { vendor: "qwen" });
  const session = await getSession({
    vendor: "qwen",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile,
  });

  return withLock(session, async () => {
    const { page } = session;

    await newConversation(page, ENTRY_URL);
    for (const p of MATCH_PATHS) await installHook(page, p);
    await resetHook(page);

    const hooked = await page.evaluate(() => !String(window.fetch).includes("native code"));
    if (!hooked) {
      throw Object.assign(new Error("页面钩子注入失败（页面可能已重新加载）"), { code: "CHANNEL_NOT_READY" });
    }

    const filled = await fillInput(page, prompt);
    if (!filled) {
      throw Object.assign(new Error("找不到输入框，页面结构可能已变化（建议用抓包模式核对）"), {
        code: "CHANNEL_NOT_READY",
      });
    }

    let submitted = false;
    for (const sel of SEND_SELECTORS) {
      submitted = await submit(page, { sendSelector: sel });
      if (submitted) break;
    }
    if (!submitted) submitted = await submit(page);
    if (!submitted) {
      throw Object.assign(new Error("未能触发发送（页面结构可能已变化）"), { code: "CHANNEL_NOT_READY" });
    }

    // 边收边转发（CN 版是累积全文，解析器内部会做 diff，但必须逐帧喂才能出增量）
    const parser = createQwenParser();
    const pump = (chunk) => {
      const d = parser.push(chunk);
      if (!d) return;
      if (d.reasoning && onReasoning) onReasoning(d.reasoning);
      if (d.content && onDelta) onDelta(d.content);
    };

    const res = await streamCapture(page, {
      timeoutMs: 180_000,
      signal,
      onChunk: pump,
      shouldStop: () => Boolean(parser.error),
    });

    if (res.error === "ABORTED" || signal?.aborted) {
      throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`等待响应超时（${res.error || "无数据"}）`), { code: "CHANNEL_TIMEOUT" });
    }

    if (parser.error) {
      const code = /captcha|验证|NOT_LOGIN/i.test(parser.error)
        ? /NOT_LOGIN/i.test(parser.error)
          ? "CHANNEL_AUTH_EXPIRED"
          : "CHANNEL_CAPTCHA"
        : "CHANNEL_STREAM_ERROR";
      throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code });
    }
    if (!parser.content && !parser.reasoning) {
      throw Object.assign(new Error("该账号返回空内容（可能未登录或被风控限制）"), { code: "CHANNEL_EMPTY" });
    }

    return {
      reasoning: parser.reasoning,
      content: parser.content,
      usage: parser.usage,
      upstreamModel: resolved.upstream,
    };
  });
}

// ---------- 登录 ----------
// 风控重，由浏览器承载
export function loginModes() {
  return ["browser"];
}

export async function release(channelId) {
  return closeSession("qwen", channelId);
}
