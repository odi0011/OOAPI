// 上游适配器：doubao（字节豆包网页版）
// ---------------------------------------------------------------------------
// 为什么用浏览器驱动：豆包有 a_bogus 请求签名（SM3 + 自定义 base64 + RC4），
// 纯算法复现维护成本高；而页面 JS 会自动注入 a_bogus / msToken。
// 采用与 GLM 相同的策略：浏览器承载会话，页面自己算签名。
//
// 账号 = channels 表一行 type='doubao'：
//   · api_key       → 可留空（浏览器用自己 cookie 里的 sessionid）
//   · other.profile → 设备指纹（浏览器 profile 天然稳定）
// ---------------------------------------------------------------------------
import { createDoubaoParser} from "./doubao-parser.js";
import { resolveModel, CHANNEL_MODELS } from "./doubao-models.js";
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
  markReady} from "./browser-driver.js";

const ENTRY_URL = "https://www.doubao.com/chat/";
// 两个可能的端点都监听（不同版本页面用不同接口）
const MATCH_PATHS = ["/samantha/chat/completion", "/chat/completion"];

// 页面上的输入框与发送按钮选择器
const SEND_SELECTORS = [
  '[data-testid="chat_input_send_button"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  ".send-btn",
];

/** 健康检查：能打开页面并找到输入框 */
export async function verify(channel) {
  const started = Date.now();
  const { profile } = resolveProfile(channel, { vendor: "doubao" });
  const session = await getSession({
    vendor: "doubao",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile});

  return withLock(session, async () => {
    const { page } = session;
    await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    const ready = await page.locator("textarea, [contenteditable='true'], div[role='textbox']").first().count();
    if (!ready) {
      throw Object.assign(
        new Error("页面未就绪（找不到输入框），可能需要在服务器上人工登录一次豆包账号"),
        { code: "CHANNEL_NOT_READY" }
      );
    }
    markReady("doubao", channel.id);
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
  signal}) {
  const resolved = resolveModel(model);
  const thinking = thinkingOverride !== undefined ? Boolean(thinkingOverride) : resolved.thinking;

  if (images.length) {
    throw Object.assign(new Error("豆包渠道暂不支持图片输入，请改用文本"), { code: "VISION_NOT_SUPPORTED" });
  }
  // 适配器暂未实现这两个参数注入，显式报错好于静默忽略（前端已按能力标记隐藏开关）
  if (search) {
    throw Object.assign(new Error("豆包渠道暂不支持联网搜索，请去掉 search 参数"), { code: "CHANNEL_UNSUPPORTED" });
  }
  if (thinkingOverride === true && !resolved.thinking) {
    throw Object.assign(new Error("豆包渠道暂不支持深度思考开关"), { code: "CHANNEL_UNSUPPORTED" });
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
  }

  const { profile } = resolveProfile(channel, { vendor: "doubao" });
  const session = await getSession({
    vendor: "doubao",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile});

  return withLock(session, async () => {
    const { page } = session;

    // 先导航到干净页面，再装 hook（导航会清掉注入的 JS）
    await newConversation(page, ENTRY_URL);
    for (const p of MATCH_PATHS) await installHook(page, p);
    await resetHook(page);

    const hooked = await page.evaluate(() => !String(window.fetch).includes("native code"));
    if (!hooked) {
      throw Object.assign(new Error("页面钩子注入失败（页面可能已重新加载）"), { code: "CHANNEL_NOT_READY" });
    }

    // 输入并发送（豆包同样需要真实键入才能触发 React state）
    const filled = await fillInput(page, prompt);
    if (!filled) {
      throw Object.assign(new Error("找不到输入框，页面结构可能已变化（建议用抓包模式核对）"), {
        code: "CHANNEL_NOT_READY"});
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

    // 解析（边收边转发，避免整轮缓存导致「思考+结果一起蹦出来」）
    const parser = createDoubaoParser();
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
      shouldStop: () => Boolean(parser.error || parser.finished)});

    if (res.error === "ABORTED" || signal?.aborted) {
      throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`等待响应超时（${res.error || "无数据"}）`), { code: "CHANNEL_TIMEOUT" });
    }

    if (parser.error) {
      const code = /710022004|验证|verify/i.test(parser.error)
        ? "CHANNEL_CAPTCHA"
        : /710022002|rate|频繁/i.test(parser.error)
          ? "CHANNEL_RATE_LIMIT"
          : /710012001|过期/i.test(parser.error)
            ? "CHANNEL_AUTH_EXPIRED"
            : "CHANNEL_STREAM_ERROR";
      throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code });
    }
    if (!parser.content) {
      throw Object.assign(
        new Error(parser.reasoning ? "上游只返回了思考内容，没有正文" : "该账号返回空内容（可能未登录或被风控限制）"),
        { code: "CHANNEL_EMPTY" }
      );
    }

    return {
      reasoning: parser.reasoning,
      content: parser.content,
      usage: parser.usage,
      conversationId: parser.conversationId,
      upstreamModel: `${resolved.model}(bot:${resolved.botId})`};
  });
}

// ---------- 登录方式 ----------
// 豆包需扫码或账密登录（含风控），由浏览器承载
export function loginModes() {
  return ["browser"];
}

/** 「上游可用模型」：网页版没有列模型接口，返回本适配器能驱动的模型（前端标注来源） */
export async function fetchUpstreamModels() {
  return CHANNEL_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function release(channelId) {
  return closeSession("doubao", channelId);
}
