// 浏览器驱动引擎（通用）
// ---------------------------------------------------------------------------
// 适用场景：厂商网页版有一次性前端验证码 / 复杂签名，纯 HTTP 无法复现时，
//          用真实浏览器承载会话，页面自己完成验证码与签名；
//          引擎只做三件事：注入参数 → 触发发送 → 捕获响应流。
//
// 为什么能改参数：多数厂商的签名只覆盖 prompt 文本（不含 model/features），
//   因此在请求发出前改写 model / 开关字段不会破坏签名。prompt 本身通过
//   UI 输入（让页面自己算签名）。
//
// 关键设计：
//   1. 每账号一个常驻浏览器上下文（持久化 profile 目录），指纹天然稳定一致
//   2. 同账号请求串行，不并发（并发是非人类特征）
//   3. 闲置自动回收，避免长期占用内存
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync, rmSync, cpSync, renameSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertPublicUrl } from "../../utils.js";
import { getProvider } from "../channel-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_ROOT = path.join(__dirname, "..", "..", "..", "data", "browser-profiles");

const IDLE_MS = 10 * 60 * 1000;
const NAV_TIMEOUT = 60_000;
// 单个请求持有会话锁的硬上限：正常一次对话远小于它（execute 默认 10 分钟硬截止）。
// Playwright 的 evaluate/fill 不响应 abort，底层调用一旦挂死，队列头永远不 settle，
// 后续请求会全部堵在这个渠道上。看门狗到点强关 context 强制解除并在下次重建会话。
const QUEUE_STUCK_MS = 15 * 60 * 1000;

// 浏览器登录成功标记。profile 目录在首次 open 时就会被创建，
// 所以「目录存在」不能代表已登录；用显式标记文件判断。
const READY_MARKER = ".ooapi-logged-in";

const sessions = new Map();
// 正在首建的会话（key -> Promise），用于合并并发启动请求
const pending = new Map();

/**
 * 某个渠道的 profile 目录（不存在则创建）。
 * 导出给适配器用：他们需要在目录里放/读自己的标记文件
 * （例如 openai-web-ui 用它记录「已从哪份登录 profile 复制而来」）。
 */
export function profileDir(vendor, channelId) {
  const d = path.join(PROFILE_ROOT, `${vendor}-${channelId}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 清理「无主的」profile 单例锁。
 *
 * Chromium 在 profile 目录里放 SingletonLock（指向 hostname-pid 的符号链接）
 * 来防止同一 profile 被并发打开。进程被强杀时会留下它，而下次启动并不会
 * 自动忽略 —— 直接报 "Opening in existing browser session"。
 *
 * **安全性**：只有确认「锁指向的 pid 已不存在」才删。如果那个进程还活着，
 * 说明确实有另一个实例在用这个 profile（我们不该抢），此时不动它，
 * 让 Playwright 自己报错 —— 抢锁会破坏另一个会话的数据。
 */
function clearStaleProfileLock(vendor, channelId, dir) {
  const lock = path.join(dir, "SingletonLock");
  let target = "";
  try {
    target = readlinkSync(lock);
  } catch {
    return; // 没有锁（正常情况），无需处理
  }
  // 格式：<hostname>-<pid>；同机情况下 hostname 匹配才有意义
  const m = String(target).match(/-(\d+)$/);
  const pid = m ? Number(m[1]) : 0;
  if (pid > 0) {
    try {
      process.kill(pid, 0); // 只探测存在性，不发信号
      return; // 进程还活着：锁是有效的，不去动它
    } catch (e) {
      if (e?.code !== "ESRCH") return; // EPERM 等：无法确认，保守不动
    }
  }
  try {
    rmSync(lock, { force: true });
    rmSync(path.join(dir, "SingletonCookie"), { force: true });
    rmSync(path.join(dir, "SingletonSocket"), { force: true });
    console.warn(`[browser-driver] 清理了无主的 profile 锁（${vendor}-${channelId}，指向 pid ${pid || "未知"}）`);
  } catch {
    /* 删不掉就交给 Playwright 报错，至少我们试过了 */
  }
}

/** 标记该渠道的浏览器会话已经登录就绪 */
export function markReady(vendor, channelId) {
  try {
    writeFileSync(path.join(profileDir(vendor, channelId), READY_MARKER), new Date().toISOString());
  } catch {
    /* 标记失败不影响主流程 */
  }
}

/** 该渠道是否已有可用的浏览器登录态 */
export function isReady(vendor, channelId) {
  try {
    return existsSync(path.join(PROFILE_ROOT, `${vendor}-${channelId}`, READY_MARKER));
  } catch {
    return false;
  }
}

/** 删除渠道时清掉 profile 目录，避免占用磁盘 */
export async function removeProfile(vendor, channelId) {
  await closeSession(vendor, channelId).catch(() => {});
  try {
    rmSync(path.join(PROFILE_ROOT, `${vendor}-${channelId}`), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 把「引导登录」用的 profile 复制成某个渠道的 profile。
 * 添加浏览器登录类渠道时：先在独立的 onboarding 会话里完成登录（扫码/验证码），
 * 落库拿到渠道 id 后再把这份已登录的 profile 复制过去，渠道即可直接使用。
 * 复制走「临时目录 + rename」：覆盖目标时不会出现半份 profile；目标会话先关掉，避免 EBUSY。 */
export async function copyProfile(vendor, fromId, toId) {
  await closeSession(vendor, fromId).catch(() => {});
  await closeSession(vendor, toId).catch(() => {});
  const src = path.join(PROFILE_ROOT, `${vendor}-${fromId}`);
  const dst = path.join(PROFILE_ROOT, `${vendor}-${toId}`);
  const tmp = `${dst}.copying-${Date.now()}`;
  if (!existsSync(src)) return false;
  try {
    cpSync(src, tmp, { recursive: true });
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    renameSync(tmp, dst);
    return true;
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
}

// ---------- 会话生命周期 ----------
// 重要：必须使用 headful 模式（headless:false）+ 窗口移到屏幕外。
// 实测 Z.ai 在 headless:true 与 --headless=new 下都检测得到，表现为
// "发送按钮可点但请求发不出去"（非常隐蔽）。Linux 服务器需 xvfb 提供虚拟显示。
export async function getSession({ vendor, channelId, entryUrl, profile, visible = false, cookies = null }) {
  const key = `${vendor}:${channelId}`;
  const exist = sessions.get(key);
  // 存活判定必须同时看 ctx 和 page：
  // 渲染进程崩溃、页面被 window.close() 或导航到 about:blank 之后 context 仍然活着，
  // 但 s.page 已经是个死对象 —— 此时如果直接返回该会话，后续每个请求都会在第一步
  // 抛 Playwright 原生错误（无 code），execute 当成基础设施故障换渠道，
  // 该渠道会一直失败到 15 分钟看门狗才重建。这里主动判定并重建页面。
  if (exist?.ctx) {
    if (isPageUsable(exist.page)) {
      exist.lastUsed = Date.now();
      return exist;
    }
    // 页面已死但 context 还在：下面走「复用浏览器、只重建页面」（快好几秒）
  }

  // 并发首建保护：两个请求同时打来且会话还没建好时，若各建各的，
  // 会对同一个 profile 目录启动两个 Chromium（Chromium 直接报「正在使用」）。
  // 这里让后来者复用第一个启动 Promise，等它完成即可。
  const inflight = pending.get(key);
  if (inflight) return inflight;

  // cookies：可移植的登录态（见 restoreCookies 注释）。只在**新建会话**时注入 ——
  // 已存在的会话里已经有登录态，重复注入没有意义还可能覆盖页面自己刷新的值。
  const p = createSession({ vendor, channelId, key, entryUrl, profile, visible, reuse: exist, cookies }).finally(() => {
    if (pending.get(key) === p) pending.delete(key);
  });
  pending.set(key, p);
  return p;
}

/** 页面是否还能用（isClosed 可能抛错：死对象上调用时） */
function isPageUsable(page) {
  if (!page) return false;
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

/**
 * 取一个可用页面；页面死了就地重建（复用浏览器进程）。
 * 管理端接口（截图/远程操作/抓登录态）都直接解引用 session.page，
 * 而 attachPageWatch 会把死页面置空 —— 不兜这一层的话，
 * 页面崩过之后这些接口会抛无 code 的 TypeError（前端只看到 500）。
 *
 * entryUrl 允许为空：为空时自动从 providers 注册表里按厂商查，
 * 这样 13 个调用点不必各自传参（它们分布在 channel.js 的多个路由里，很容易漏）。
 */
async function usablePage(session, { vendor, channelId, entryUrl = "" }) {
  if (isPageUsable(session.page)) return session.page;
  const url = entryUrl || entryUrlOf(vendor);
  if (!url) {
    throw Object.assign(new Error(`渠道 ${vendor} 未配置登录入口地址，无法重建页面`), { code: "CHANNEL_NOT_READY" });
  }
  await rebuildPage(session, { vendor, channelId, entryUrl: url });
  if (!isPageUsable(session.page)) {
    throw Object.assign(new Error("浏览器页面不可用且重建失败，请关闭该渠道的浏览器后重试"), {
      code: "CHANNEL_NOT_READY",
    });
  }
  return session.page;
}

/** 从渠道类型注册表里查该厂商的登录入口地址（用于页面重建后的导航） */
function entryUrlOf(vendor) {
  try {
    const p = getProvider(vendor);
    if (!p) return "";
    for (const m of p.methods || []) {
      if (m.entryUrl) return m.entryUrl;
    }
  } catch {
    /* 注册表异常时返回空，由调用方报错 */
  }
  return "";
}

/** 只重建页面（复用浏览器进程），失败则抛错由调用方决定是否重建整个会话 */
async function rebuildPage(session, { vendor, channelId, entryUrl }) {
  const fresh = await createSession({
    vendor,
    channelId,
    key: `${vendor}:${channelId}`,
    entryUrl,
    profile: null,
    reuse: session,
  });
  return fresh;
}

/**
 * 把外部保存的 cookies 注入会话（登录态可移植）。
 *
 * 为什么需要：有些厂商（ChatGPT 网页版）的自动登录要跑一整套浏览器流程，
 * 而登录时渠道可能还不存在（新建渠道时没有 id，profile 目录无法按真实 id 落盘）。
 * 有了它，登录可以在**任意会话**里做，把 cookies 提取出来存进 channel.other，
 * 之后真实渠道的会话启动时再注入 —— 不必复制整个 profile 目录。
 *
 * cookies 支持两种形态：
 *   · [{ name, value }]                      ← 其它反代渠道的既有形态
 *   · [{ name, value, domain, path, ... }]   ← ctx.cookies() 的完整对象
 * 缺 domain/path 时按 url 补全（用页面当前 URL 推断）。
 */
export async function restoreCookies(ctx, page, cookies) {
  const list = Array.isArray(cookies) ? cookies.filter((c) => c && c.name) : [];
  if (!list.length) return 0;
  let fallbackUrl = "";
  try {
    fallbackUrl = page?.url?.() || "";
  } catch {
    fallbackUrl = "";
  }
  const normalized = list.map((c) => ({
    name: String(c.name),
    value: String(c.value ?? ""),
    ...(c.domain ? { domain: String(c.domain) } : { url: c.url || fallbackUrl }),
    ...(c.path ? { path: String(c.path) } : {}),
    ...(c.expires !== undefined && Number(c.expires) > 0 ? { expires: Number(c.expires) } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: Boolean(c.httpOnly) } : {}),
    ...(c.secure !== undefined ? { secure: Boolean(c.secure) } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  }));
  try {
    await ctx.addCookies(normalized);
    return normalized.length;
  } catch (e) {
    // 个别 cookie 的 sameSite/domain 组合会被 Chromium 拒绝：逐个重试，
    // 能注入多少算多少 —— 登录态缺一两个次要 cookie 通常仍可用，
    // 整批失败才是真的不可用（那会由后续的会话检查报出来）。
    let ok = 0;
    for (const c of normalized) {
      await ctx.addCookies([c]).then(() => { ok += 1; }).catch(() => {});
    }
    if (!ok) {
      throw Object.assign(new Error(`登录态 cookies 注入失败：${e?.message || e}`), { code: "CHANNEL_NOT_READY" });
    }
    return ok;
  }
}

async function createSession({ vendor, channelId, key, entryUrl, profile, visible = false, reuse = null, cookies = null }) {
  // 页面死了但浏览器还活着：只重建页面，省掉一次完整启动（几秒）。
  if (reuse?.ctx && !isPageUsable(reuse.page)) {
    try {
      const page = await reuse.ctx.newPage();
      await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(4000);
      reuse.page = page;
      reuse.lastUsed = Date.now();
      attachPageWatch(reuse, key);
      console.log(`[browser-driver] 会话 ${key} 的页面已失效，已重建页面（复用浏览器进程）`);
      return reuse;
    } catch (e) {
      // 连新建页面都失败：说明 context 也不健康了，落到下面走完整重建
      console.warn(`[browser-driver] 会话 ${key} 重建页面失败，改为重启浏览器：${e.message}`);
      await reuse.ctx.close().catch(() => {});
      if (sessions.get(key) === reuse) sessions.delete(key);
    }
  }

  // 窗口位置：把窗口放到屏幕可视区之外，但**不要**用 -32000。
  // 原因是页面 JS 能读到 window.screenX/screenY —— 恰好 -32000 是自动化环境的
  // 教科书级特征，真实用户不可能把窗口拖到那个坐标。
  // 这里改为「常见分辨率下位于屏幕右下方之外」的坐标（数值本身不异常），
  // 并按账号做小幅散布，避免所有账号共用同一个窗口坐标。
  // visible=true（人工登录抓取）：窗口放在屏幕内，noVNC 实时画面才能看到并操作。
  const spread = (n, base, span) => base + (Math.abs(Number(n) || 0) % span);
  const winX = visible ? 0 : spread(channelId, 1600, 400);
  const winY = visible ? 0 : spread((Number(channelId) || 0) * 7 + 3, 900, 200);
  const dir = profileDir(vendor, channelId);
  // 清掉可能残留的 profile 单例锁。
  // Chromium 用 SingletonLock 阻止同一 profile 被两个进程同时打开；
  // 进程被强杀（OOM、部署重启、看门狗 kill）时会留下这个锁，
  // 之后每次启动都失败并报 Playwright 的
  // "Opening in existing browser session" —— 渠道永久不可用，
  // 而原因只是磁盘上一个没人持有的符号链接。
  // 注意只在**确认没有活进程**时才清（见 clearStaleProfileLock）。
  clearStaleProfileLock(vendor, channelId, dir);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: profile?.locale || "zh-CN",
    ...(profile?.timezone ? { timezoneId: profile.timezone } : {}),
    ...(profile?.userAgent ? { userAgent: profile.userAgent } : {}),
    // 去掉 Playwright 默认注入的 --enable-automation：它会让页面看到
    // navigator.webdriver === true，是最容易被识别的自动化信号。
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--window-position=${winX},${winY}`,
      "--window-size=1440,900",
      // 语言与 UA/navigator.languages 保持一致，避免三者互相矛盾
      `--lang=${String(profile?.locale || "zh-CN").replace("_", "-")}`,
    ],
  });

  let page;
  try {
    page = ctx.pages()[0] || (await ctx.newPage());
    // 先注入保存的登录态再导航：顺序反了会先以未登录状态请求一次页面，
    // 有些站会据此写下"匿名访客"的 cookie，把真正的登录态盖掉。
    if (cookies?.length) {
      await restoreCookies(ctx, page, cookies).catch((e) => {
        console.warn(`[browser-driver] 会话 ${key} 注入登录态失败：${e?.message || e}`);
      });
    }
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(4000);
  } catch (e) {
    // 中途失败必须关掉已启动的浏览器，否则进程泄漏（profile 目录保留即可）
    await ctx.close().catch(() => {});
    throw e;
  }

  const s = { ctx, page, lastUsed: Date.now(), queue: Promise.resolve(), vendor, channelId };
  sessions.set(key, s);
  // Chromium 崩溃/被系统关闭时 sessions 里的引用会变成死 context：
  // 监听 close 事件主动摘除，后续请求会重新建会话（否则该渠道会一直失败到重启）。
  ctx.on("close", () => {
    if (sessions.get(key) === s) sessions.delete(key);
  });
  attachPageWatch(s, key);
  scheduleIdleCleanup();
  return s;
}

/**
 * 监听页面崩溃/被关闭：把 s.page 标记为不可用（置空），
 * 下一次 getSession 会据此重建页面，而不是拿着死对象一直失败。
 * 只摘页面不摘会话 —— 浏览器进程还是好的，重建页面比重启浏览器快得多。
 */
function attachPageWatch(session, key) {
  const page = session.page;
  if (!page || typeof page.on !== "function") return;
  const mark = (why) => {
    if (session.page !== page) return; // 已经换过页面，忽略旧页面的迟到事件
    session.page = null;
    console.warn(`[browser-driver] 会话 ${key} 的页面${why}，下次请求将重建页面`);
  };
  page.on("close", () => mark("已关闭"));
  page.on("crash", () => mark("已崩溃"));
}

let cleanupTimer = null;
function scheduleIdleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      // 有任务正在跑/排队时不能回收：lastUsed 可能停在入队那刻，会把流式中的会话腰斩
      if (s.inFlight) continue;
      if (now - s.lastUsed > IDLE_MS) {
        try {
          await s.ctx.close();
        } catch {
          /* ignore */
        }
        sessions.delete(key);
        console.log(`[browser-driver] 回收闲置会话 ${key}`);
      }
    }
    if (!sessions.size) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 60_000);
  cleanupTimer.unref?.();
}

export async function closeSession(vendor, channelId) {
  const key = `${vendor}:${channelId}`;
  // 若首次启动还在进行中（pending），先等它落地，否则会漏关刚启动的浏览器
  if (pending.has(key)) await pending.get(key).catch(() => {});
  const s = sessions.get(key);
  if (!s) return false;
  try {
    await s.ctx.close();
  } catch {
    /* ignore */
  }
  sessions.delete(key);
  return true;
}

export async function closeAll() {
  // 等待所有首建中的会话落地，避免漏关
  await Promise.allSettled([...pending.values()]);
  for (const [, s] of sessions) {
    try {
      await s.ctx.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}

// ---------- 远程人工登录辅助 ----------
// 服务器没有桌面，管理员没法直接看浏览器。这里截图回传，
// 用于「扫码登录」「输验证码」这类必须人工介入的场景。
export async function screenshot(vendor, channelId, { fullPage = false, quality = 70, entryUrl = "" } = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const page = await usablePage(s, { vendor, channelId, entryUrl });
    const buf = await page.screenshot({ type: "jpeg", quality, fullPage });
    return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, url: page.url() };
  });
}

/** 只取当前页面 URL（给「检测 OAuth 回调是否到达」轮询用，比整页截图便宜得多） */
export function currentUrl(vendor, channelId) {
  const s = sessions.get(`${vendor}:${channelId}`);
  try {
    return s?.page?.url() || "";
  } catch {
    return "";
  }
}

// ---------- 远程人工登录：交互与凭据抓取 ----------
// 用途：添加渠道时不想让管理员自己开控制台翻 localStorage。这里在服务器端
// 打开厂商登录页截图回传，管理员在弹窗里点选/输入完成登录（支持扫码），
// 然后由 credentials() 直接把登录态读出来回填表单。
/**
 * 在会话页面上执行一次远程操作，返回操作后的截图。
 * @param {object} op { action: "click"|"type"|"key"|"scroll"|"goto", x?, y?, text?, key?, dx?, dy?, url? }
 */
export async function act(vendor, channelId, op = {}, { entryUrl = "" } = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const page = await usablePage(s, { vendor, channelId, entryUrl });
    const action = String(op.action || "");
    if (action === "click") {
      await page.mouse.click(Number(op.x) || 0, Number(op.y) || 0);
    } else if (action === "type") {
      await page.keyboard.type(String(op.text ?? ""), { delay: 25 });
    } else if (action === "key") {
      await page.keyboard.press(String(op.key || "Enter"));
    } else if (action === "scroll") {
      await page.mouse.wheel(Number(op.dx) || 0, Number(op.dy) || 0);
    } else if (action === "goto") {
      const url = String(op.url || "");
      if (!/^https:\/\//i.test(url)) throw Object.assign(new Error("只允许跳转 https 地址"), { code: "BAD_URL" });
      // 与出站抓取同一套 SSRF 校验：否则可把服务器浏览器导航到内网地址并截图回传
      try {
        await assertPublicUrl(url);
      } catch (e) {
        throw Object.assign(new Error(`不允许跳转到该地址：${e.message}`), { code: "BAD_URL" });
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
    } else {
      throw new Error("未知的远程操作");
    }
    await page.waitForTimeout(400);
    const buf = await page.screenshot({ type: "jpeg", quality: 70 });
    return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, url: page.url() };
  });
}

/**
 * 抓取当前登录态：cookies 串 + localStorage 候选 token（按与 token/auth 的相关性排序）。
 * 注意：不同厂商存放字段不同（deepseek 是 userToken、GLM 是 token…），
 * 所以这里返回候选列表交给管理员确认，不擅自假设某一个键。
 */
export async function credentials(vendor, channelId, { entryUrl = "" } = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const page = await usablePage(s, { vendor, channelId, entryUrl });
    const cookies = await s.ctx.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const entries = await page
      .evaluate(() => {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            out.push([k, localStorage.getItem(k) || ""]);
          }
        } catch {
          /* 页面跨域/未就绪时忽略 */
        }
        return out;
      })
      .catch(() => []);
    const scoreOf = (k) => {
      const s1 = String(k || "");
      let n = 0;
      if (/token|auth|access|session|credential/i.test(s1)) n += 2;
      if (/^(userToken|token|access_token|auth_token)$/i.test(s1)) n += 2;
      return n;
    };
    const tokens = [];
    for (const [k, raw] of entries) {
      const v = String(raw || "");
      if (!v || v.length < 8 || v.length > 4096) continue;
      // 有些站点把 token 包在 JSON 里（如 {"value":"..."}），展开 value 作为候选
      let plain = v;
      if (/^\{/.test(v.trim())) {
        try {
          const obj = JSON.parse(v);
          if (typeof obj?.value === "string" && obj.value.length >= 8) plain = obj.value;
        } catch {
          continue; // 无法解析的 JSON 不是凭据
        }
      }
      if (plain.length < 8 || plain.length > 4096) continue;
      tokens.push({ key: k, value: plain, score: scoreOf(k) });
    }
    tokens.sort((a, b) => b.score - a.score);
    // Cookie 也可能是登录态本体（例如 Kimi 的 kimi-auth 就是 JWT），
    // 一并作为候选返回，前端优先展示 localStorage 命中，其次 cookie 命中。
    const cookieCandidates = cookies
      .filter((c) => c.value && c.value.length >= 8 && c.value.length <= 4096 && /token|auth|session/i.test(c.name))
      .map((c) => ({ key: `cookie:${c.name}`, value: c.value, score: scoreOf(c.name) + 1 }));
    cookieCandidates.sort((a, b) => b.score - a.score);
    return { cookies: cookieStr, url: page.url(), tokens: [...tokens.slice(0, 20), ...cookieCandidates.slice(0, 10)] };
  });
}

// ---------- 请求钩子 ----------
/**
 * 在已登录的页面里请求指定同源接口（相对路径），返回响应文本。
 * 用途：网页版渠道的凭据不在 localStorage，只能问站点自己的会话接口
 * （如 chatgpt.com 的 /api/auth/session）；在页面内 fetch 天然带 cookie 与
 * 正确的 CSRF/同源头，比在服务端拼 cookie 更稳，也不会泄露到外部。
 */
export async function apiFetch(vendor, channelId, apiPath, { entryUrl = "" } = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  const path = String(apiPath || "");
  if (!path.startsWith("/")) return null;
  return withLock(s, async () => {
    const page = await usablePage(s, { vendor, channelId, entryUrl });
    return page
      .evaluate(async (p) => {
        try {
          const r = await fetch(p, { credentials: "include", headers: { accept: "application/json" } });
          return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 200_000) };
        } catch (e) {
          return { ok: false, status: 0, text: String(e?.message || e) };
        }
      }, path)
      .catch(() => null);
  });
}

/**
 * 安装 fetch 钩子：按 __ooPatch 改写请求 body，并捕获响应流
 * @param {string} matchPath 匹配的 URL 片段
 */
export async function installHook(page, matchPath) {
  await page.evaluate((match) => {
    // 支持多条匹配路径：路径注册表 + fetch 只包装一次，
    // 否则第二个 MATCH_PATHS 永远不会被挂钩。
    window.__ooHookedPaths = window.__ooHookedPaths || [];
    if (!window.__ooHookedPaths.includes(match)) window.__ooHookedPaths.push(match);
    window.__ooPatch = window.__ooPatch || null;
    if (!window.__ooCap) window.__ooCap = { chunks: [], done: false, error: null, startedAt: 0 };
    window.__ooLastBody = null;
    if (window.__ooFetchWrapped) return;
    window.__ooFetchWrapped = true;

    // 按 "a.b.c" 路径原地写值。
    // 关键：必须原地修改，不能整体替换子对象 —— 上游签名覆盖了 body 的
    // 结构（实测整体替换 features / 改顶层 model 都会导致上游返回 0 帧）。
    function setPath(obj, dotted, value) {
      const parts = dotted.split(".");
      let o = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (o[parts[i]] === undefined || o[parts[i]] === null || typeof o[parts[i]] !== "object") return false;
        o = o[parts[i]];
      }
      const last = parts[parts.length - 1];
      if (!(last in o)) return false; // 只改已存在的字段，不新增（新增会改变结构）
      o[last] = value;
      return true;
    }

    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      if (!(window.__ooHookedPaths || []).some((m) => url.includes(m))) return origFetch.call(this, input, init);

      // 改写 body
      let finalInit = init;
      const patch = window.__ooPatch;
      if (patch && init?.body && typeof init.body === "string") {
        try {
          const b = JSON.parse(init.body);
          const failed = [];
          for (const [k, v] of Object.entries(patch.set || {})) {
            if (!setPath(b, k, v)) failed.push(k);
          }
          if (failed.length) window.__ooPatchSkipped = failed;
          for (const k of patch.delete || []) {
            const parts = k.split(".");
            let o = b;
            for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]];
            if (o) delete o[parts[parts.length - 1]];
          }
          init = { ...init, body: JSON.stringify(b) };
          window.__ooLastBody = b;
          finalInit = init;
        } catch (e) {
          window.__ooPatchError = String(e);
        }
      }

      // 每次请求用独立闭包持有自己的捕获对象：旧请求的读取循环即使没停，
      // 也只能写进它自己的 cap，不会污染下一轮（以前写 window.__ooCap 会串轮）。
      const cap = { chunks: [], done: false, error: null, startedAt: Date.now(), url, stop: false };
      window.__ooCap = cap;

      const resp = await origFetch.call(this, input, finalInit);
      try {
        const clone = resp.clone();
        (async () => {
          let reader = null;
          try {
            reader = clone.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            let total = 0;
            const MAX_CHUNKS = 20000;
            const MAX_CHARS = 8 * 1024 * 1024;
            for (;;) {
              if (cap.stop) {
                await reader.cancel().catch(() => {});
                return;
              }
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line.startsWith("data:")) {
                  const data = line.slice(5).trim();
                  total += data.length;
                  cap.chunks.push(data);
                }
              }
              if (cap.chunks.length >= MAX_CHUNKS || total >= MAX_CHARS) {
                cap.error = "捕获缓冲超过上限，已截断";
                await reader.cancel().catch(() => {});
                break;
              }
            }
            if (buf.trim().startsWith("data:")) cap.chunks.push(buf.trim().slice(5).trim());
            cap.done = true;
          } catch (e) {
            cap.error = String(e?.message || e);
            cap.done = true;
          }
        })();
      } catch (e) {
        cap.error = String(e);
        cap.done = true;
      }
      return resp;
    };
  }, matchPath);
}

/** 设置下一次请求的参数改写规则 */
export async function setPatch(page, patch) {
  await page.evaluate((p) => {
    window.__ooPatch = p;
  }, patch);
}

/** 清空捕获缓冲（每次对话前调用） */
export async function resetHook(page) {
  await page.evaluate(() => {
    // 通知上一轮可能仍在跑的读取循环停止，避免它继续把帧推进新对象
    if (window.__ooCap) window.__ooCap.stop = true;
    window.__ooCap = { chunks: [], done: false, error: null, startedAt: 0, stop: false };
    window.__ooPatchError = null;
  });
}

// ---------- UI 交互 ----------
/** 输入框选择器（fillInput 与 newConversation 共用，避免两处不一致） */
const INPUT_SELECTORS = [
  "textarea",
  '[contenteditable="true"]',
  'div[role="textbox"]',
];

/**
 * 在输入框填入文本。
 *
 * 两个关键点：
 *  1. 必须模拟真实键入（pressSequentially），因为 React/Vue 受控组件只监听真实
 *     input 事件；page.fill() 直接赋值不会更新框架内部 state，发送按钮会保持
 *     禁用状态（踩过这个坑）。
 *  2. 定位用「一次 evaluate 找到并打标记」，而不是每个选择器都往返
 *     count()/isVisible()。三个选择器逐个探测要 6 次 CDP 往返，实测占了
 *     输入阶段的大部分耗时（约 1.5s），而这纯粹是我们的开销，不是上游的。
 */
export async function fillInput(page, text) {
  const found = await page.evaluate((sels) => {
    for (const s of sels) {
      const el = [...document.querySelectorAll(s)].find((e) => {
        const st = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      });
      if (el) {
        el.setAttribute("data-oo-input", "1");
        return { tag: el.tagName.toLowerCase() };
      }
    }
    return null;
  }, INPUT_SELECTORS);

  if (!found) return false;

  const loc = page.locator('[data-oo-input="1"]').first();
  try {
    await loc.click({ timeout: 3000 }).catch(() => {});

    if (found.tag === "textarea") {
      await loc.fill(""); // 先清空
      // 长文本用 insertText 提速，短文本逐字符更真实
      if (text.length > 200) {
        await page.keyboard.insertText(text);
      } else {
        await loc.pressSequentially(text, { delay: 15 });
      }
    } else {
      // contenteditable：聚焦后清空再整体插入
      await loc.evaluate((el) => {
        el.focus();
        el.textContent = "";
      });
      await page.keyboard.insertText(text);
    }
    // 留一点时间让框架把 state 同步到发送按钮的可用状态
    await page.waitForTimeout(200);
    return true;
  } finally {
    await page.evaluate(() => document.querySelector('[data-oo-input="1"]')?.removeAttribute("data-oo-input")).catch(() => {});
  }
}

/** 输入框是否已就绪（供 fillInput 之外的就绪判断复用） */
export async function hasInput(page) {
  return page.evaluate((sels) =>
    sels.some((s) => [...document.querySelectorAll(s)].some((e) => {
      const st = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
    })), INPUT_SELECTORS);
}

/**
 * 触发发送。
 * 用 DOM 原生 click() 而非 Playwright locator.click()：
 * 这类 SPA 的输入区常有浮动层/动画，locator 的可交互性检查容易判定失败，
 * 或点到不可用实例；DOM click() 直接触发框架合成事件，实测更可靠。
 */
export async function submit(page, { sendSelector } = {}) {
  const SELECTORS = [
    ...(sendSelector ? [sendSelector] : []),
    "button.sendMessageButton",
    'button[type="submit"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
  ];

  const started = () => page.evaluate(() => Boolean(window.__ooCap?.startedAt));

  // 点击后请求可能要数秒才发出（页面要先做验证码/签名），
  // 所以点击与确认之间必须有足够长的等待，否则会误判为失败。
  const WAIT_AFTER_CLICK = 6000;

  // 已经点过一次就不能再点下一个候选：
  // hook 没观察到「已发出」不代表真的没发出去（页面改用 XHR、端点路径变了、
  // 请求在 hook 装好前就发生了，都会出现这种「发了但没看到」）。
  // 旧实现会继续点剩余候选、最后再按一次 Enter，单请求最多点几十次，
  // 结果是把同一条 prompt 发出去多条：既浪费账号额度，短时间内两条完全相同的
  // 消息本身就是明显的脚本特征（更容易被风控命中）。
  let clickedAny = false;
  for (const sel of SELECTORS) {
    if (clickedAny) break;
    const clicked = await page
      .evaluate((s) => {
        const bs = [...document.querySelectorAll(s)].filter((b) => {
          const st = getComputedStyle(b);
          return st.display !== "none" && st.visibility !== "hidden" && !b.disabled;
        });
        if (!bs.length) return 0;
        // 发送按钮通常位于输入框之后，从后往前点
        bs[bs.length - 1].click();
        return bs.length;
      }, sel)
      .catch(() => 0);

    if (!clicked) continue;
    clickedAny = true;

    // 等待请求发出（轮询，最长 WAIT_AFTER_CLICK）。
    // 轮询间隔决定了「请求已经发出但我们还没察觉」的空等时间，
    // 500ms 会平白多等半秒，150ms 足够（每次 evaluate 开销远小于此）。
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_AFTER_CLICK) {
      await page.waitForTimeout(150);
      if (await started()) return true;
    }
    // 点过但没等到信号：不再尝试其他选择器（会重复发送），
    // 直接交给下面的「输入框是否已清空」二次确认
    if (await sentByUiState(page)) return true;
    return false;
  }

  // 一个候选都没点上（选择器全不匹配）：退化为回车
  await page.keyboard.press("Enter");
  const t1 = Date.now();
  while (Date.now() - t1 < WAIT_AFTER_CLICK) {
    await page.waitForTimeout(150);
    if (await started()) return true;
  }
  return sentByUiState(page);
}

/**
 * 二次确认「消息是否真的发出去了」。
 * 页面侧的 hook 可能因为上游改了请求方式（XHR 代替 fetch、端点路径变化）
 * 而看不到请求，但 DOM 会如实反映：输入框被清空、或出现了新的用户消息气泡。
 * 有它才能安全地「只点一次」，而不是靠反复点击碰运气。
 */
async function sentByUiState(page) {
  try {
    return await page.evaluate(() => {
      const cap = window.__ooCap || {};
      // 输入框已清空（发送后页面通常会立刻清空）
      const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((e) => {
        const st = getComputedStyle(e);
        return st.display !== "none" && st.visibility !== "hidden";
      });
      const emptied = boxes.length > 0 && boxes.every((e) => {
        const v = e.tagName === "TEXTAREA" ? e.value : e.textContent;
        return !String(v || "").trim();
      });
      return emptied || Boolean(cap.startedAt);
    });
  } catch {
    return false;
  }
}

/**
 * 边收边读：等待流结束的同时，把新到的帧立刻交给 onChunk。
 *
 * 为什么需要它：原先的写法是 waitForStream() 等整轮结束、再 readCapture()
 * 一次性解析，结果是用户要盯着 loading 很久，然后思考链和正文「一起」蹦出来
 * —— 完全不是流式体验（浏览器路径本来可以边收边转发的）。
 * 这里改成轮询增量游标，每有新帧就即时回调，首字延迟从「整轮耗时」降到「首帧耗时」。
 *
 * @param {object} opts
 * @param {Function} opts.onChunk 每收到一个新帧调用一次（按到达顺序，不重复）
 * @param {Function} opts.shouldStop 返回 true 时提前结束（如已判定上游报错）
 * @param {AbortSignal} opts.signal 调用方取消
 */
export async function streamCapture(page, {
  timeoutMs = 180_000,
  pollMs = 120,
  // 帧数静止多久判定为「流已结束」。必须是**时间**而不是轮询次数：
  // 次数会随 pollMs 变化而失真（pollMs 从 1000 调到 120 时，
  // 5 次的含义会从 5 秒变成 0.6 秒，导致模型思考间隙被误判成结束、
  // 答案还没吐出来就收工，返回空内容。这个坑踩过一次，别再改回计数）。
  // 兜底：流没标记结束，但帧数已经静止 idleMs，视为已结束。
  // 必须先从「首帧到达」开始算，否则等待首帧的那几秒会被当成静止。
  // idleMs 默认 15s：深度思考的停顿可能很长，宁可多等，也不要把长回答截断
  // （截断会被当成成功计费，用户拿到半截答案还照样扣钱）。
  idleMs = 15_000,
  onChunk,
  shouldStop,
  signal,
} = {}) {
  const t0 = Date.now();
  let cursor = 0;          // 已消费的帧数
  let lastTotal = -1;      // 上一轮看到的帧总数
  let lastGrowthAt = 0;    // 帧数最后一次增长的时间
  let lastBody = null;
  let patchError = null;
  // 被跳过的注入字段：setPatch 只改已存在的字段，页面结构一变就会静默跳过
  // （表现为「开了 search/thinking 或换了 model，上游却按默认跑」，用户仍按
  // 所请求的模型计费）。把跳过的字段名带回给调用方，由适配器决定告警或报错。
  let patchSkipped = null;

  // 客户端取消时主动让**页面内**的请求停下来。
  // 只跳出轮询是不够的：页面里的 fetch 会继续生成并消耗账号额度，
  // 捕获缓冲也会一直涨到上限才自己停。这里设置 hook 的 stop 标志，
  // 由页面侧的 ReadableStream 取消上游请求。
  const abortUpstream = () => {
    page.evaluate(() => {
      if (window.__ooCap) window.__ooCap.stop = true;
    }).catch(() => {});
  };

  for (;;) {
    if (signal?.aborted) {
      abortUpstream();
      return { ok: false, error: "ABORTED", frames: cursor };
    }
    if (Date.now() - t0 > timeoutMs) {
      abortUpstream();
      return { ok: false, error: "TIMEOUT", frames: cursor, lastBody, patchError, patchSkipped };
    }

    await page.waitForTimeout(pollMs);

    const st = await page.evaluate((from) => ({
      chunks: (window.__ooCap?.chunks || []).slice(from),
      total: window.__ooCap?.chunks?.length || 0,
      done: Boolean(window.__ooCap?.done),
      err: window.__ooCap?.error || null,
      started: window.__ooCap?.startedAt || 0,
      patchError: window.__ooPatchError || null,
      patchSkipped: window.__ooPatchSkipped || null,
      lastBody: window.__ooLastBody || null,
    }), cursor);

    if (st.patchError) patchError = st.patchError;
    if (Array.isArray(st.patchSkipped) && st.patchSkipped.length) patchSkipped = st.patchSkipped;
    if (st.lastBody) lastBody = st.lastBody;
    if (st.err) return { ok: false, error: st.err, frames: cursor, lastBody, patchError, patchSkipped };

    // 先把这一轮新到的帧全部吐出去
    for (const c of st.chunks) {
      cursor++;
      if (onChunk) onChunk(c);
    }
    if (st.total > lastTotal) lastGrowthAt = Date.now();
    lastTotal = st.total;

    if (shouldStop?.()) return { ok: true, frames: cursor, stopped: true, lastBody, patchError, patchSkipped };
    // 流已结束就立即返回；0 帧说明上游返回了空流（如错误体），不能死等到超时
    if (st.done) return { ok: cursor > 0, frames: cursor, empty: cursor === 0, lastBody, patchError, patchSkipped };

    // 兜底：流没标记结束，但帧数已经静止 idleMs，视为已结束。
    // 必须先从「首帧到达」开始算，否则等待首帧的那几秒会被当成静止。
    if (cursor > 0 && lastGrowthAt && Date.now() - lastGrowthAt > idleMs) {
      return { ok: true, frames: cursor, endedByIdle: true, lastBody, patchError, patchSkipped };
    }
  }
}

/** 同账号串行执行（带卡死看门狗，见 QUEUE_STUCK_MS 注释） */
export function withLock(session, task, { signal } = {}) {
  const prev = session.queue || Promise.resolve();
  let watchdog = null;
  const guarded = (async () => {
    // 前一个任务失败（或被看门狗强关）都不能阻断后续任务
    await prev.catch(() => {});
    // 看门狗触发后旧会话已被判定不可用：排队的任务直接失败，等下一个请求重建会话，
    // 否则它们会继续在一个已经没人持有的队列上执行，HTTP 请求无限悬挂。
    if (session.failed) {
      throw Object.assign(new Error("会话已因超时被重建，请重试"), { code: "CHANNEL_TIMEOUT" });
    }
    // 排队期间客户端已经断开：直接放弃，不要把消息发到上游。
    // 否则用户点了「停止」之后，账号仍会消耗额度、网页会话里还会多出一条
    // 用户根本不想发的消息（多轮之后这些「幽灵消息」还会打断正在进行的生成）。
    if (signal?.aborted) {
      throw Object.assign(new Error("请求已取消"), { code: "CHANNEL_ABORTED" });
    }
    // 真正开始干活才刷新空闲时间（排队期间不算活跃）
    session.lastUsed = Date.now();
    session.inFlight = (session.inFlight || 0) + 1;
    // 看门狗从「真正持有会话」开始计时：如果从入队就算，排队等待会被算进硬上限，
    // 后面的请求还没开始干活就会被强关（上一版实现的回归）
    watchdog = setTimeout(() => {
      console.warn("[browser-driver] 会话任务超时未释放，强制重建会话以恢复该渠道可用性");
      session.failed = true;
      // 必须等 close 真正完成再让下一个请求用同一个 profile 目录重建：
      // 旧进程还持有 user-data-dir 单例锁时，新启动会失败，而失败发生在
      // launchPersistentContext（无 code）→ 渠道会陷入「每次请求都新建都失败」的循环。
      // 这里先摘除会话（让新请求走重建路径），再等关闭收尾。
      for (const [k, s] of sessions) {
        if (s === session) sessions.delete(k);
      }
      try {
        const closing = session.ctx?.close?.();
        if (closing && typeof closing.catch === "function") {
          // 最多再等 10s，超时就不再阻塞（进程残留由系统的进程回收兜底）
          Promise.race([closing.catch(() => {}), new Promise((r) => setTimeout(r, 10000).unref?.())]).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }, QUEUE_STUCK_MS);
    watchdog.unref?.();
    try {
      return await task();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      session.inFlight = Math.max(0, (session.inFlight || 1) - 1);
      session.lastUsed = Date.now();
    }
  })();
  session.queue = guarded;
  return guarded;
}

/**
 * 预热下一个对话页。
 *
 * 每次请求都要「重新导航到干净页面 + 装 hook」，实测约 1.8s，
 * 而这段时间完全在请求路径上，是首字延迟里最大的一块固定开销。
 * 既然每轮结束后页面必然要重置，不如在**空闲时**提前做好，
 * 下一轮请求直接命中预热结果（命中就省掉 1.8s）。
 *
 * 它只是把同一套「导航 + 装 hook」提前做，语义没变：每轮依然是全新干净页面。
 * 通过同一个 session.queue 串行，所以不会和正在进行的请求抢页面。
 */
export function prewarm(session, entryUrl, matchPath) {
  if (session.prewarmed || session.prewarming) return;
  session.prewarming = true;
  withLock(session, async () => {
    try {
      // 页面可能在空闲期间崩掉（attachPageWatch 会置空）：这时直接放弃预热，
      // 别在死对象上操作。下一个真实请求会自行重建页面，代价只是少省一次导航。
      if (!isPageUsable(session.page)) return;
      await newConversation(session.page, entryUrl);
      await installHook(session.page, matchPath);
      await resetHook(session.page);
      session.prewarmed = true;
    } catch (e) {
      session.prewarmed = false;
      console.warn("[browser-driver] 预热失败：", e?.message || e);
    } finally {
      session.prewarming = false;
    }
  });
}

/** 消费预热结果：已预热则跳过导航，返回 true */
export function consumePrewarm(session) {
  if (!session.prewarmed) return false;
  session.prewarmed = false;
  return true;
}

/**
 * 建立一个干净对话（清空上下文，避免上一轮污染本轮）。
 *
 * 原来是「goto + 固定睡 2500ms」，无论页面多快都要等满 2.5 秒 ——
 * 这是首字延迟里最大的一段固定开销。改成等「输入框真正出现」这一可观测条件：
 * 页面快时提前返回，页面慢时反而更稳（固定睡眠在网络抖动时容易睡过头或不够）。
 */
export async function newConversation(page, entryUrl) {
  await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
  await page
    .waitForSelector(INPUT_SELECTORS.join(", "), { timeout: 20_000, state: "visible" })
    .catch(() => {});
  // 输入框可见到真正可交互之间还有一小段框架水合时间，留一点余量即可
  await page.waitForTimeout(400);
}
