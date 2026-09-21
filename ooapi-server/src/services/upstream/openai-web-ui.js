// 上游适配器：openai-web-ui（ChatGPT 网页版 · **浏览器 UI 驱动**）
// ===========================================================================
// 为什么需要它（与现有的 openai-web 适配器的根本区别）：
//
//   openai-web 走「Node 里组装 HTTP 请求」——登录后拿 access_token，
//   直接 POST /backend-api/conversation。这条路现在**走不通**：实测（2026-09）
//   该接口要求 sentinel 风控令牌，其中 `proofofwork` 可以纯 JS 解，
//   但 **`turnstile` 必须由 ChatGPT 页面自身的 JS 解开**，Node 端无解，
//   无论怎么补令牌都返回 403 `Unusual activity has been detected`。
//
//   而**驱动真实页面 UI**（在输入框里打字、按回车）完全正常：实测对话请求 200、
//   回复内容正确。页面自己会处理全部风控，我们只负责把回复取回来。
//
// 实现方式：复用平台已有的 browser-driver ——
//   · 登录：在服务器浏览器里自动填 邮箱 → 密码 → 2FA 动态码（TOTP 自己算）
//   · 对话：导航到干净对话页 → 装 fetch hook → 真实键入 → 回车 →
//           streamCapture 边收边转发（页面自己的请求带齐 sentinel 令牌）
//
// 已知约束（都是实测结论，不要"优化"掉）：
//   · 免费档 access_token **没有 refresh_token**，到期必须重新登录；
//     所以登录是一次性动作 + 持久化 token/device_id，绝不每请求重登
//     （连续登录约 5 次会被限流，提交按钮挂起 2~3 分钟）。
//   · 每轮对话结束要导航回干净页面：网页版是**有状态的会话**，
//     不重置会把上一轮的上下文带进下一轮（用户会看到莫名其妙的连贯回答）。
import {
  getSession,
  installHook,
  resetHook,
  submit,
  streamCapture,
  withLock,
  closeSession,
  newConversation,
  markReady,
  isReady,
} from "./browser-driver.js";
import { resolveProfile } from "./shared-profile.js";
import { loginWithCredentials, checkSession } from "./openai-web-login.js";
import { createOpenAiWebParser, detectOpenAiWebError } from "./openai-web-parser.js";
import { persistOtherPatch, loadOther } from "./auth-store.js";

const ENTRY_URL = "https://chatgpt.com/";
const MATCH_PATH = "/backend-api/conversation";
// 登录流程内部会跳 auth.openai.com，入口仍用 chatgpt.com 首页
const LOGIN_ENTRY = "https://chatgpt.com/";

/**
 * 打开（或复用）某个渠道的浏览器会话。
 *
 * 关键：把 other.cookies 传进 getSession —— 这是登录态的载体。
 * 漏传会表现为「渠道明明登录成功了，一测试就说登录态失效」，
 * 因为新会话是个干净的匿名浏览器。
 */
async function openChannelSession(channel) {
  const { profile } = resolveProfile(channel, { vendor: "openai-web-ui" });
  return getSession({
    vendor: "openai-web-ui",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile,
    cookies: Array.isArray(channel?.other?.cookies) ? channel.other.cookies : null,
  });
}

/**
 * 生成 2FA 密钥的提示文案（管理员最常犯的错是把 6 位数字码当密钥填）。
 */
export function authHint() {
  return "填 ChatGPT 账号的邮箱、密码与 2FA 密钥（验证器 App 里那串 base32 密钥，不是 6 位数字码；账号未开两步验证可留空）";
}

/** 登录模式声明：支持账号密码（含 2FA）。不支持粘贴 —— 粘贴的 token 过不了 UI 驱动这关 */
export function loginModes() {
  return ["password"];
}

// 登录用的固定会话 id。
// 为什么不是渠道 id：新建渠道时渠道还不存在（没有 id），profile 目录按 id 命名就没法落盘。
// 这里所有登录共用一个会话，登录成功后把 **cookies 提取出来**存进 channel.other，
// 真实渠道的会话启动时再注入（见 browser-driver 的 restoreCookies）——
// 比复制整个 profile 目录更干净，也不依赖登录期的 id 与最终 id 的关系。
const LOGIN_CHANNEL_ID = 0;

/**
 * 账号密码登录（含 2FA）。
 * 返回 token（access_token，作为渠道凭据摘要）+ other（cookies/device_id/account 等）。
 */
export async function loginWithPassword({ email, password, totpSecret, profileSeed }) {
  if (!email || !password) {
    throw Object.assign(new Error("请填写邮箱与密码"), { code: "LOGIN_BAD_PARAMS" });
  }
  // 用账号派生指纹：同一账号在 OpenAI 侧始终表现为"同一台浏览器"（防封基础）
  const { profile } = resolveProfile({ id: LOGIN_CHANNEL_ID, other: {} }, { vendor: "openai-web-ui" });
  if (!profile?.userAgent) {
    throw Object.assign(new Error("无法生成浏览器指纹"), { code: "LOGIN_BAD_PARAMS" });
  }

  // 登录前先关掉上一次登录留下的会话。
  //
  // 为什么必须显式关：所有登录共用一个 channelId（见 LOGIN_CHANNEL_ID 注释），
  // 而服务会按空闲时长保活浏览器会话 —— 上一次登录结束后会话可能还在，
  // 它的 Chromium 仍持有 profile 目录锁，第二次登录启动就会失败，
  // 报 Playwright 的 "Opening in existing browser session"。
  // 实测踩到：第一次登录成功建出渠道后，随后每次登录都失败。
  await closeSession("openai-web-ui", LOGIN_CHANNEL_ID).catch(() => {});

  const session = await getSession({
    vendor: "openai-web-ui",
    channelId: LOGIN_CHANNEL_ID,
    entryUrl: LOGIN_ENTRY,
    profile,
  });

  let r = null;
  let cookieList = [];
  try {
    r = await withLock(session, async () =>
      loginWithCredentials(session.page, { email, password, totpSecret })
    );

    // 提取完整 cookies（含 httpOnly）—— 这是可移植的登录态本体
    let cookies = [];
    try {
      cookies = await session.ctx.cookies("https://chatgpt.com");
    } catch {
      cookies = [];
    }
    cookieList = cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.httpOnly ? { httpOnly: true } : {}),
      ...(c.secure ? { secure: true } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
  } finally {
    // 无论成功失败都要关：登录会话的 profile 目录是登录专用的，
    // 留着会锁住目录导致**下一次登录必然失败** —— 失败路径更要清理，
    // 否则一次失败会级联影响后续所有尝试（实测踩过）。
    await closeSession("openai-web-ui", LOGIN_CHANNEL_ID).catch(() => {});
  }

  return {
    token: r.accessToken,
    profile,
    account: r.account,
    other: {
      // 登录态：cookies 是本体；access_token/device_id 用于展示与风控一致性
      ...(cookieList.length ? { cookies: cookieList } : {}),
      access_token: r.accessToken,
      device_id: r.deviceId,
      plan_type: r.planType,
      expires_at: r.expiresAt,
    },
  };
}

/** 渠道可用性验证：打开页面看登录态还在不在 */
export async function verify(channel) {
  const session = await openChannelSession(channel);
  return withLock(session, async () => {
    const r = await checkSession(session.page);
    if (!r.ok) {
      throw Object.assign(new Error("ChatGPT 网页版登录态已失效，请重新用邮箱+密码+2FA 登录"), {
        code: "CHANNEL_AUTH_EXPIRED",
      });
    }
    markReady("openai-web-ui", channel.id);
    return { ok: true, account: r.planType ? `套餐 ${r.planType}` : "" };
  });
}

/** 账号额度：网页版没有公开的额度接口，交给通用额度模块（返回空即"不支持"） */
export async function fetchUpstreamModels() {
  return [];
}

export async function release(channelId) {
  await closeSession("openai-web-ui", channelId).catch(() => {});
}

/**
 * 把提示词键入 ChatGPT 的输入框。
 *
 * 为什么不直接用 browser-driver 的 fillInput：ChatGPT 页面上**同时存在**两个候选 ——
 * 一个隐藏的 <textarea id="prompt-textarea">（旧版遗留）和一个可见的
 * ProseMirror contenteditable；两者共用同一个 id。
 * fillInput 按 INPUT_SELECTORS 顺序取「第一个可见的」，会命中 contenteditable，
 * 然后走 `el.fill("")` 清空 —— 而 **fill() 不支持 contenteditable**，
 * 直接挂到 30s 超时，报错只是 "locator.fill: Timeout 30000ms exceeded"，
 * 看不出真正原因（实测踩过，表现为「渠道测试超时 240s」）。
 *
 * 这里显式用 #prompt-textarea 精确定位可见的那个，并全程只做
 * click + 真实按键（pressSequentially）—— 让页面收到真实的 input 事件，
 * 它才会更新内部 state 并启用发送按钮。
 */
async function typePrompt(page, text) {
  // 精确锁到可见的 ProseMirror 输入区（隐藏 textarea 会被 :visible 过滤掉）
  const box = page.locator('#prompt-textarea[contenteditable="true"]:visible').first();
  let target = (await box.count()) > 0 ? box : page.locator('#prompt-textarea:visible').first();
  if ((await target.count()) === 0) {
    // 兜底：任意可见的 contenteditable（页面改版时仍可能可用）
    target = page.locator('[contenteditable="true"]:visible').first();
  }
  if ((await target.count()) === 0) return false;

  try {
    await target.click({ timeout: 5000 }).catch(() => {});
    // 清空：全选 + 删除（不能对 contenteditable 用 fill）
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.waitForTimeout(150);
    // 逐字符键入：短文本用 pressSequentially（真实按键事件），长文本用 insertText 提速
    if (text.length > 400) {
      await page.keyboard.insertText(text);
    } else {
      await page.keyboard.type(text, { delay: 18 });
    }
    // 等输入框真的出现内容（框架把 state 同步过去）
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector("#prompt-textarea");
          const v = el ? (el.tagName === "TEXTAREA" ? el.value : el.textContent) : "";
          return String(v || "").trim().length > 0;
        },
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
    await page.waitForTimeout(250);
    return true;
  } catch {
    return false;
  }
}

/**
 * 对话（UI 驱动）。
 *
 * 流程：干净页面 → 装 hook → 键入 → 回车 → 边收边转。
 * hook 装在导航之后（导航会清空页面注入的 JS，顺序反了 hook 就没了）。
 */
export async function chat({ channel, model, prompt, images = [], signal, onDelta }) {
  if (images?.length) {
    throw Object.assign(
      new Error("ChatGPT 网页版渠道暂不支持图片输入（网页上传依赖前端组件），请改用文本"),
      { code: "VISION_NOT_SUPPORTED" },
    );
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
  }

  const session = await openChannelSession(channel);

  return withLock(
    session,
    async () => {
      const { page } = session;

      // 每轮都从干净对话页开始：网页版是有状态会话，不重置会串上下文
      await newConversation(page, ENTRY_URL);
      await installHook(page, MATCH_PATH);
      await resetHook(page);

      // hook 必须真的生效：否则参数注入与流捕获都会静默失效（表现为"上游没反应"）
      const hooked = await page.evaluate(() => !String(window.fetch).includes("native code"));
      if (!hooked) {
        throw Object.assign(new Error("页面钩子注入失败（页面可能已重新加载）"), { code: "CHANNEL_NOT_READY" });
      }

      // 登录态兜底检查：过期就明确报错，而不是让用户等到超时
      const sess = await checkSession(page);
      if (!sess.ok) {
        throw Object.assign(new Error("ChatGPT 网页版登录态已失效，请重新登录该渠道"), {
          code: "CHANNEL_AUTH_EXPIRED",
        });
      }

      // 真实键入（页面自己算 sentinel；不用 patch 改模型 —— 页面档位由账号决定，
      // 强改会被上游拒绝，比"跑在别的档位"更糟）
      const filled = await typePrompt(page, prompt);
      if (!filled) {
        throw Object.assign(new Error("找不到输入框，ChatGPT 页面结构可能已变化"), { code: "CHANNEL_NOT_READY" });
      }

      // 发送：先试发送按钮（有稳定 data-testid），失败退回 Enter。
      //
      // 不能只靠 Enter：ChatGPT 的输入区是个表单，Enter 在部分状态下
      // （输入法组合中、或焦点被弹层抢走）不会提交；也不能只靠按钮 ——
      // 按钮在 state 未同步时是 disabled，submit() 会跳过它。
      // 两条路都留着，且 submit() 内部有「已点过一次就不再点下一个候选」的
      // 防重复保护（见其注释：重复发送会浪费额度且是明显的脚本特征）。
      const submitted = await submit(page, {
        sendSelector: 'button[data-testid="send-button"], button[aria-label*="发送"], button[aria-label*="Send"]',
      });
      if (!submitted) {
        throw Object.assign(new Error("未能触发发送（页面结构可能已变化）"), { code: "CHANNEL_NOT_READY" });
      }

      const parser = createOpenAiWebParser();
      let earlyError = null;
      const early = [];
      let firstFrameAt = 0;

      const res = await streamCapture(page, {
        // 网页版深度思考时首帧可能很晚；给足时间但不要无限等
        timeoutMs: 240_000,
        idleMs: 20_000,
        signal,
        onChunk: (c) => {
          if (!firstFrameAt) firstFrameAt = Date.now();
          if (early.length < 6) {
            early.push(c);
            if (!earlyError) earlyError = detectOpenAiWebError(early);
          }
          const d = parser.push(c);
          if (d?.content && onDelta) onDelta(d.content);
        },
        shouldStop: () => Boolean(earlyError),
      });

      if (earlyError) {
        throw Object.assign(new Error(earlyError.message), { code: earlyError.code });
      }

      const out = parser.result();
      if (out.upstreamError) {
        const msg = typeof out.upstreamError === "string" ? out.upstreamError : out.upstreamError.message || "上游返回错误";
        throw Object.assign(new Error(`ChatGPT 网页版返回错误：${msg}`), { code: "CHANNEL_BAD_RESPONSE" });
      }
      if (res.error === "TIMEOUT") {
        throw Object.assign(new Error("ChatGPT 网页版响应超时（可能仍在生成，请重试或缩短提问）"), {
          code: "CHANNEL_TIMEOUT",
        });
      }
      if (!out.content) {
        throw Object.assign(new Error("ChatGPT 网页版返回了空回复（可能被风控拦截，请在网页端确认账号状态）"), {
          code: "CHANNEL_EMPTY_RESPONSE",
        });
      }

      return {
        content: out.content,
        // 把上游真实档位回传：计费按"实际跑的档位"而不是请求的档位
        model: out.modelSlug || model,
      };
    },
    { signal },
  );
}

/** 会话是否已就绪（避免每次请求都重建浏览器） */
export function isSessionReady(channelId) {
  return isReady("openai-web-ui", channelId);
}
