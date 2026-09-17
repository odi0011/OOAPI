// 上游适配器：glm（智谱 GLM 网页版 / Z.ai）
// ---------------------------------------------------------------------------
// 为什么用浏览器驱动：Z.ai 网页版有**一次性前端验证码**（FRONTEND_CAPTCHA_REQUIRED），
// 验证码参数由页面 JS + 阿里云 SDK 生成，且用一次即失效，纯 HTTP 无法复现。
// 因此本适配器：用真实浏览器承载会话（页面自己过验证码与签名），
// 引擎只注入参数（model / 思考 / 联网）并捕获响应流。
//
// 账号 = channels 表一行 type='glm'：
//   · api_key       → 登录态 token（可留空，浏览器会用自己 localStorage 里的游客 token）
//   · other.profile → 设备指纹（浏览器 profile 目录天然稳定）
//   · other.cookies → 可选，补充 cookie
// ---------------------------------------------------------------------------
import { createGlmParser } from "./glm-parser.js";
import { resolveModel, REAL_MODELS, friendlyId } from "./glm-models.js";
import { resolveProfile } from "./shared-profile.js";
import {
  getSession,
  installHook,
  setPatch,
  resetHook,
  fillInput,
  submit,
  streamCapture,
  withLock,
  closeSession,
  newConversation,
  markReady,
  isReady,
  prewarm,
  consumePrewarm,
} from "./browser-driver.js";

const ENTRY_URL = "https://chat.z.ai";
const MATCH_PATH = "/chat/completions";

// 捕获帧的包装：{"type":"chat:completion","data":{...}}
function unwrap(chunk) {
  try {
    const j = JSON.parse(chunk);
    return j?.data ?? j;
  } catch {
    return null;
  }
}

// 从捕获帧中判定错误（上游会把错误放在 data.error）
function detectError(frames) {
  for (const c of frames.slice(0, 6)) {
    const d = unwrap(c);
    const e = d?.error;
    if (!e) continue;
    const code = e.code || e.error_code || "";
    const detail = e.detail || e.message || "";
    if (/CAPTCHA/i.test(code) || /验证/i.test(detail)) {
      return { code: "CHANNEL_CAPTCHA", message: `上游要求人机验证：${detail || code}（请稍后重试或更换账号）` };
    }
    if (/rate|limit|频繁|too many/i.test(`${code}${detail}`)) {
      return { code: "CHANNEL_RATE_LIMIT", message: `请求过于频繁：${detail || code}` };
    }
    return { code: "CHANNEL_BIZ_ERROR", message: `上游错误：${detail || code || JSON.stringify(e).slice(0, 120)}` };
  }
  return null;
}

/** 健康检查：能否打开页面并拿到登录态 */
export async function verify(channel) {
  const started = Date.now();
  const { profile } = resolveProfile(channel, { vendor: "glm" });
  const session = await getSession({
    vendor: "glm",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile,
  });

  return withLock(session, async () => {
    const { page } = session;
    await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const tk = await page.evaluate(() => {
      try {
        return localStorage.getItem("token");
      } catch {
        return null;
      }
    });
    if (!tk) {
      throw Object.assign(new Error("未能获取登录态（页面未就绪或需要人工登录）"), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    // 有输入框才算页面真正可用
    const ready = await page.locator("textarea, [contenteditable='true']").first().count();
    if (!ready) {
      throw Object.assign(new Error("页面未就绪（找不到输入框），可能需要人工登录一次"), {
        code: "CHANNEL_NOT_READY",
      });
    }
    markReady("glm", channel.id);
    return Date.now() - started;
  });
}

/**
 * 执行一次对话
 * @returns {Promise<{reasoning,content,usage,upstreamModel}>}
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
  const upstreamId = resolved.upstream;

  if (images.length) {
    throw Object.assign(
      new Error("GLM 渠道暂不支持图片输入（网页版上传需登录账号且依赖前端组件），请改用文本"),
      { code: "VISION_NOT_SUPPORTED" }
    );
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
  }

  const { profile } = resolveProfile(channel, { vendor: "glm" });
  const session = await getSession({
    vendor: "glm",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile,
  });

  return withLock(session, async () => {
    const { page } = session;
    // 分段计时：把「我们的页面开销」和「上游首帧耗时」分开，
    // 否则首字慢时无法判断该优化哪一层（日志里看 [glm][timing]）。
    const T = {};
    const mark = (k) => { T[k] = Date.now(); };

    // 顺序很重要：先导航到干净对话页，再装 hook。
    // 页面导航会清空注入的 JS（hook 是页面级的），所以必须在导航之后装。
    // 若上一轮结束后已预热（空闲时提前导航+装 hook），这里直接命中，省掉约 1.8s。
    mark("t0");
    const prewarmed = consumePrewarm(session);
    if (!prewarmed) {
      await newConversation(page, ENTRY_URL);
      await installHook(page, MATCH_PATH);
    }
    mark("nav");
    await resetHook(page);

    // 校验 hook 真的生效（否则后面注入参数与捕获都会静默失效）
    const hooked = await page.evaluate(() => !String(window.fetch).includes("native code"));
    if (!hooked) {
      throw Object.assign(new Error("页面钩子注入失败（页面可能已重新加载）"), { code: "CHANNEL_NOT_READY" });
    }

    // 注入参数。
    // 实测约束（重要）：
    //   · 改 features 的子字段 ✅ 有效
    //   · 改顶层 model ❌ 上游返回 0 帧（页面默认档位即 GLM-5.3-Flash）
    //   · 整体替换 features 对象 ❌ 破坏签名
    // 所以只做 features 子字段的原地修改；模型档位交给页面默认值。
    const patchSet = {};
    if (thinking) {
      patchSet["features.enable_thinking"] = true;
      patchSet["features.reasoning_effort"] = "high";
    }
    if (search) patchSet["features.auto_web_search"] = true;

    await setPatch(page, { set: patchSet });
    mark("patch");

    // 输入 prompt（让页面自己算签名；必须真实键入）
    const filled = await fillInput(page, prompt);
    if (!filled) {
      throw Object.assign(new Error("找不到输入框，页面结构可能已变化（建议用抓包模式核对）"), {
        code: "CHANNEL_NOT_READY",
      });
    }
    mark("fill");

    // 触发发送（Z.ai 的发送按钮有专门 class）
    const submitted = await submit(page, { sendSelector: "button.sendMessageButton" });
    if (!submitted) {
      throw Object.assign(new Error("未能触发发送（页面结构可能已变化）"), { code: "CHANNEL_NOT_READY" });
    }
    mark("submit");

    const parser = createGlmParser();
    let earlyError = null;
    let firstFrameAt = 0;
    const early = [];

    // 边收边解析边转发：不整轮缓存，否则用户要等全部生成完才看到内容
    const res = await streamCapture(page, {
      timeoutMs: 180_000,
      signal,
      onChunk: (c) => {
        if (!firstFrameAt) firstFrameAt = Date.now();
        // 前几帧用于判定上游错误（验证码/限流），命中就提前结束，不必干等
        if (early.length < 6) {
          early.push(c);
          if (!earlyError) earlyError = detectError([c]);
        }
        const d = parser.push(c);
        if (!d) return;
        if (d.reasoning && onReasoning) onReasoning(d.reasoning);
        if (d.content && onDelta) onDelta(d.content);
      },
      shouldStop: () => Boolean(earlyError),
    });
    mark("streamEnd");

    // 首帧耗时（TTFT）才是用户感知的「等待」，整轮耗时是另一回事，分开记录
    const ttft = firstFrameAt ? firstFrameAt - T.submit : -1;
    console.log(
      `[glm][timing] 渠道#${channel.id} 准备阶段：导航 ${T.nav - T.t0}ms + 注入 ${T.patch - T.nav}ms + ` +
        `输入 ${T.fill - T.patch}ms + 发送 ${T.submit - T.fill}ms = ${T.submit - T.t0}ms；` +
        `上游首帧 ${ttft}ms；整轮 ${T.streamEnd - T.submit}ms`
    );

    if (res.patchError) {
      console.warn("[glm] 参数注入失败：", res.patchError);
    }
    if (earlyError) {
      throw Object.assign(new Error(earlyError.message), { code: earlyError.code });
    }
    if (res.error === "ABORTED" || signal?.aborted) {
      throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`等待响应超时（${res.error || "无数据"}）`), {
        code: "CHANNEL_TIMEOUT",
      });
    }

    if (parser.error) {
      // 错误帧与 FINISHED 同到也要报错，避免半截回答被当成功计费
      throw Object.assign(new Error(`上游返回错误：${parser.error}`), { code: "CHANNEL_STREAM_ERROR" });
    }
    if (!parser.answer) {
      // 空内容通常意味着页面层失败（如未登录、模型不可用）；只有思考没有正文也不能算成功
      throw Object.assign(new Error(parser.thinking ? "上游只返回了思考内容，没有正文" : "该账号返回空内容（可能未登录或被风控限制）"), {
        code: "CHANNEL_EMPTY",
      });
    }

    // 若上游实际用了别的模型（页面默认），记录以便排查
    const actualModel = res.lastBody?.model || upstreamId;

    // 本轮用的页面已经被消耗掉，趁空闲把下一轮的干净页面准备好（省下一轮 1.8s）
    prewarm(session, ENTRY_URL, MATCH_PATH);

    return {
      reasoning: parser.thinking,
      content: parser.answer,
      usage: parser.usage,
      upstreamModel: actualModel,
      upstreamModelFriendly: friendlyId(actualModel),
      firstTokenMs: firstFrameAt ? firstFrameAt - T.submit : 0,
    };
  });
}

// ---------- 登录方式 ----------
// Z.ai 的验证码由浏览器处理，所以本渠道**不需要粘贴 token**，
// 直接在后台“添加账号 → 打开浏览器登录一次”即可（游客也能用）。
export function loginModes() {
  return ["browser"];
}

/** 关闭该账号的浏览器会话（改配置/删除时用） */
export async function release(channelId) {
  return closeSession("glm", channelId);
}

export { REAL_MODELS };
