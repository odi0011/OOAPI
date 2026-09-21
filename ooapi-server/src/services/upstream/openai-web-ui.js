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
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  copyProfile,
  profileDir,
  removeProfile,
} from "./browser-driver.js";
import { resolveProfile } from "./shared-profile.js";
import { loginWithCredentials, checkSession } from "./openai-web-login.js";
import { createOpenAiWebParser, detectOpenAiWebError } from "./openai-web-parser.js";
import { persistOtherPatch, loadOther } from "./auth-store.js";

const ENTRY_URL = "https://chatgpt.com/";
// 匹配路径：实测（捕获一次完整发送的全部 /backend-api 请求）确认，
// 当前网页版真正发送对话的端点是 **POST /backend-api/f/conversation**，
// 不是社区文档里的 /backend-api/conversation —— 后者在页面上根本不会出现，
// 写成它会导致 hook 一帧都捕不到（现象是 Enter 发出去了但 chunks=0）。
//
// 同时必须注意不能写成 "/backend-api/conversation"：
// hook 用 includes() 匹配，那个前缀会同时命中
// `/backend-api/conversations?offset=0&limit=28`（左侧会话列表，页面加载时就发），
// 于是列表请求被当成对话捕获、真正的对话请求反被覆盖。
// "/f/conversation" 这个片段同时避开了上述两者。
const MATCH_PATH = "/backend-api/f/conversation";
// 同前缀的「准备」端点：先于对话发出、返回的是小 JSON 而非 SSE，
// 必须在匹配时排除掉（见 installHook 的 exclude 说明）。
const MATCH_EXCLUDE = ["/backend-api/f/conversation/prepare"];
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
  // 首次使用某渠道时，把「登录时那份已登录的 profile」整目录复制过来。
  //
  // 为什么是复制目录而不是注入 cookies：登录态不只在 cookie 里 ——
  // 实测把 18 个 cookie（含 __Secure-next-auth.session-token.0/.1）完整注入
  // 一个干净浏览器后，/api/auth/session 依旧返回空，页面仍是未登录营销页。
  // 网页版还依赖 localStorage / IndexedDB 里的设备与会话状态，
  // 只搬 cookie 不够。而平台已有的 copyProfile 正是为此设计的
  // （浏览器登录类渠道一直这么用），这里复用同一套机制。
  await maybeAdoptLoginProfile(channel);
  const { profile: fresh } = resolveProfile(channel, { vendor: "openai-web-ui" });
  return getSession({
    vendor: "openai-web-ui",
    channelId: channel.id,
    entryUrl: ENTRY_URL,
    profile: fresh || profile,
  });
}

/**
 * 把登录 profile 认领到该渠道（幂等）。
 *
 * 登录时渠道还不存在（没有 id），所以登录在 `openai-web-ui-login-<时间戳>`
 * 这个独立 profile 里做；渠道建好后第一次使用时把那份目录复制成
 * `openai-web-ui-<channelId>`。用标记文件记下「已从哪份登录复制而来」，
 * 因此：重复调用不会重复复制（省一次 30MB 拷贝），
 * 而管理员重新登录（新的 login 目录）后会自动重新认领。
 */
/**
 * 认领互斥表：channelId → Promise。
 *
 * 为什么必需：认领要做「拷贝整个 profile 目录 + 删源目录」，
 * 而 copyProfile 内部会先 closeSession(目标) 再删目标目录 ——
 * 两个并发请求同时认领同一个渠道时，第二个会把第一个刚拷好的目录删掉，
 * 于是报「登录态文件复制失败」。
 * 实测踩到：测试渠道与网关对话几乎同时发起，一个成功一个失败（间歇性 4/7 vs 7/7）。
 * 没有这把锁，生产上「首次调用并发」必然命中。
 */
const adopting = new Map();

async function maybeAdoptLoginProfile(channel) {
  const src = String(channel?.other?.browserProfile || "");
  if (!src) return; // 老渠道/非登录型：不需要

  const key = String(channel.id);
  const inflight = adopting.get(key);
  if (inflight) return inflight; // 已有认领在进行：等它，不要重复拷

  const task = (async () => {
    // 拿到锁后**再查一次标记**：前一个并发可能刚认领完，这时直接复用
    const marker = path.join(profileDir("openai-web-ui", channel.id), ".oo-login-profile");
    try {
      if (existsSync(marker) && readFileSync(marker, "utf8").trim() === src) return;
    } catch {
      /* 读不到标记就当没认领过 */
    }
    const ok = await copyProfile("openai-web-ui", src, String(channel.id)).catch(() => false);
    if (!ok) {
      throw Object.assign(new Error("登录态文件复制失败，请重新登录该渠道"), { code: "CHANNEL_NOT_READY" });
    }
    try {
      writeFileSync(marker, src);
    } catch {
      /* 标记写不了只是会多复制一次，不影响功能 */
    }
    // 复制完就删掉登录期的临时 profile。
    // 不删的话每建一个渠道就永久留一份 ~30MB 的目录，长期跑下来会占满磁盘；
    // 而且删掉后 other.browserProfile 指向的目录不存在，
    // 重新登录也不会被误认成"已经认领过"（标记文件才是认领依据）。
    await removeProfile("openai-web-ui", src).catch(() => {});
  })().finally(() => {
    if (adopting.get(key) === task) adopting.delete(key);
  });

  adopting.set(key, task);
  return task;
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

// 每个渠道 id 对应一个 profile 目录（browser-driver 的约定）。
// 登录时记录成 other.browserProfile，渠道首次使用时由 maybeAdoptLoginProfile
// 把那份已登录目录复制成 profileDir("openai-web-ui", <channelId>)。
let loginSeq = 0;
const nextLoginId = () => `login-${Date.now().toString(36)}-${(loginSeq += 1)}`;

/**
 * 账号密码登录（含 2FA）。
 * 返回 token（access_token，作为渠道凭据摘要）+ other（cookies/device_id/account 等）。
 */
export async function loginWithPassword({ email, password, totpSecret, profileSeed }) {
  if (!email || !password) {
    throw Object.assign(new Error("请填写邮箱与密码"), { code: "LOGIN_BAD_PARAMS" });
  }
  // 每次登录用**独立的** profile 目录（按时间戳命名）。
  //
  // 为什么不是固定一个：固定目录的话，第二次登录会撞上上次留下的
  // Chromium 进程持有的目录锁（Playwright 报 "Opening in existing browser session"），
  // 而且旧会话的 cookie 会让 /auth/login 重定向回首页、邮箱框永远不出现。
  // 独立目录天然避开这两点，代价只是每次登录多几十 MB 临时目录（认领后即删）。
  const loginId = nextLoginId();
  const { profile } = resolveProfile({ id: loginId, other: {} }, { vendor: "openai-web-ui" });
  if (!profile?.userAgent) {
    throw Object.assign(new Error("无法生成浏览器指纹"), { code: "LOGIN_BAD_PARAMS" });
  }

  const session = await getSession({
    vendor: "openai-web-ui",
    channelId: loginId,
    entryUrl: LOGIN_ENTRY,
    profile,
  });

  let r = null;
  let cookieList = [];
  try {
    r = await withLock(session, async () =>
      loginWithCredentials(session.page, { email, password, totpSecret })
    );

    // 再抓一份 cookies 存 other：**只用于展示与排查**（登录态本体是
    // profile 目录）。实测单独注入这些 cookie 到干净浏览器并不足以登录
    // —— 网页版还依赖 localStorage/IndexedDB 里的会话与设备状态。
    try {
      const list = await session.ctx.cookies("https://chatgpt.com");
      cookieList = list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    } catch {
      cookieList = [];
    }
  } finally {
    // 必须关掉会话：否则它的 Chromium 进程会一直占着这个 profile 目录，
    // 后续 copyProfile 会因目录被占用而失败（EBUSY / 半份拷贝）。
    await closeSession("openai-web-ui", loginId).catch(() => {});
  }

  return {
    token: r.accessToken,
    profile,
    account: r.account,
    other: {
      // 登录态本体：这份已登录的 profile 目录名。
      // 渠道首次使用时由 maybeAdoptLoginProfile 复制成该渠道的目录。
      browserProfile: loginId,
      // cookies 仅作展示/排查（单靠它们不能恢复登录态，见上）
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
let lastPageState = null;

async function typePrompt(page, text) {
  // 输入区有两种形态，**都要接受** —— 实测同一站点在不同登录状态下给的不一样：
  //   · 登录态：可见的 <textarea id="prompt-textarea">（宽度撑满、可直接 fill/type）
  //   · 未登录/部分版本：可见的 div#prompt-textarea[contenteditable]（ProseMirror）
  // 只认 contenteditable 会在登录态下报「找不到输入框」，
  // 而错误信息里明明显示「已登录=true 可见输入框=[textarea]」（实测踩过）。
  //
  // **必须等待而不是立即查一次**：newConversation 只等到「任意输入区可见」就返回，
  // 而 ChatGPT 首页水合有先后 —— 那一瞬间严格带 :visible 的选择器可能还匹配不到，
  // 立即 count() 就会是 0，几秒后（诊断信息里）它又明明在。
  // 实测踩过：同一渠道时好时坏，报「找不到输入框」但诊断显示输入框可见。
  const CANDIDATES = [
    'textarea#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    '#prompt-textarea',
    'textarea',
    '[contenteditable="true"]',
  ];
  let target = null;
  for (const sel of CANDIDATES) {
    const loc = page.locator(`${sel}:visible`).first();
    // 每个候选给 3s：命中即用，全部落空也只为最后一个付满等待
    const ok = await loc
      .waitFor({ state: "visible", timeout: target ? 1500 : 6000 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      target = loc;
      break;
    }
  }
  // 清空方式按元素类型区分：fill("") 只对 input/textarea 有效，
  // 对 contenteditable 会挂到 30s 超时（实测踩过）。
  const inputTag = await target.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
  if (!target) {
    // 把页面实况带出去：这类失败以后还会遇到（上游改版/登录态丢失/停在弹窗），
    // 错误里没有现场就只能靠猜。
    try {
      const st = await page.evaluate(async () => {
        const vis = [...document.querySelectorAll("textarea, [contenteditable], div[role='textbox']")]
          .filter((e) => {
            const s = getComputedStyle(e);
            const b = e.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0;
          })
          .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.getAttribute("contenteditable") ? "[ce]" : ""}`);
        let planned = "";
        try {
          const j = await (await fetch("/api/auth/session", { credentials: "include" })).json();
          planned = j?.account?.planType || "";
        } catch { /* ignore */ }
        return {
          url: location.href,
          loggedIn: Boolean(planned),
          plan: planned,
          visibleInputs: vis,
          head: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 120),
        };
      });
      lastPageState = st;
    } catch { /* 取不到就算了 */ }
    return false;
  }

  try {
    await target.click({ timeout: 5000 }).catch(() => {});
    if (inputTag === "textarea" || inputTag === "input") {
      await target.fill("").catch(() => {});
    } else {
      // contenteditable 不能 fill：走全选 + 删除
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
    }
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
      // 排除 /prepare：它与对话端点同前缀，会在对话之前先发出，
      // 被 includes() 匹配到就会抢占捕获位（真正的流一帧都收不到）。
      await installHook(page, MATCH_PATH, { exclude: MATCH_EXCLUDE });
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
      lastPageState = null;
      const filled = await typePrompt(page, prompt);
      if (!filled) {
        const st = lastPageState;
        const detail = st
          ? `；页面实况：url=${st.url} 已登录=${st.loggedIn}${st.plan ? `(${st.plan})` : ""} 可见输入框=[${st.visibleInputs.join(", ") || "无"}] 正文开头="${st.head}"`
          : "";
        throw Object.assign(
          new Error(`找不到 ChatGPT 输入框（页面结构可能已变化）${detail}`),
          { code: "CHANNEL_NOT_READY" },
        );
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
        // 空回复有多种成因（风控 / 登录态 / 钩子没挂上 / 发送没成功），
        // 报错必须带上现场，否则只能靠猜（本轮已因此多轮往返）：
        //   frames=0 且 capturedUrl 为空 → 钩子没捕到任何请求（发送没发出/端点变了）
        //   frames>0 但 seenTypes 里没有 patch → 帧格式又变了
        let diag = "";
        try {
          const st = await page.evaluate(() => ({
            capturedUrl: window.__ooCap?.url || "",
            started: Boolean(window.__ooCap?.startedAt),
            chunks: window.__ooCap?.chunks?.length || 0,
            err: window.__ooCap?.error || "",
            hooked: window.__ooHookedPaths || [],
            excl: window.__ooHookedExclude || [],
            url: location.href,
          }));
          diag = `；现场：捕获URL=${st.capturedUrl || "(空)"} 已开始=${st.started} 帧数=${st.chunks}`
            + `${st.err ? ` 捕获错误=${st.err}` : ""} 钩子=${st.hooked.join(",")}`
            + ` 排除=${st.excl.join(",") || "无"} 页面=${st.url}`;
        } catch { /* 取不到就不带 */ }
        throw Object.assign(
          new Error(
            `ChatGPT 网页版返回了空回复${diag}；解析器见过的帧类型=[${(out.seenTypes || []).join(",") || "无"}]`,
          ),
          { code: "CHANNEL_EMPTY_RESPONSE" },
        );
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
