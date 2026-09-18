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
import { mkdirSync, existsSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

function profileDir(vendor, channelId) {
  const d = path.join(PROFILE_ROOT, `${vendor}-${channelId}`);
  mkdirSync(d, { recursive: true });
  return d;
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
 * 添加浏览器登录类渠道时：先在共享的 onboarding 会话里完成登录（扫码/验证码），
 * 落库拿到渠道 id 后再把这份已登录的 profile 复制过去，渠道即可直接使用。 */
export async function copyProfile(vendor, fromId, toId) {
  await closeSession(vendor, fromId).catch(() => {});
  const src = path.join(PROFILE_ROOT, `${vendor}-${fromId}`);
  const dst = path.join(PROFILE_ROOT, `${vendor}-${toId}`);
  if (!existsSync(src)) return false;
  try {
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ---------- 会话生命周期 ----------
// 重要：必须使用 headful 模式（headless:false）+ 窗口移到屏幕外。
// 实测 Z.ai 在 headless:true 与 --headless=new 下都检测得到，表现为
// "发送按钮可点但请求发不出去"（非常隐蔽）。Linux 服务器需 xvfb 提供虚拟显示。
export async function getSession({ vendor, channelId, entryUrl, profile }) {
  const key = `${vendor}:${channelId}`;
  const exist = sessions.get(key);
  if (exist?.ctx) {
    exist.lastUsed = Date.now();
    return exist;
  }

  // 并发首建保护：两个请求同时打来且会话还没建好时，若各建各的，
  // 会对同一个 profile 目录启动两个 Chromium（Chromium 直接报「正在使用」）。
  // 这里让后来者复用第一个启动 Promise，等它完成即可。
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = createSession({ vendor, channelId, key, entryUrl, profile }).finally(() => {
    if (pending.get(key) === p) pending.delete(key);
  });
  pending.set(key, p);
  return p;
}

async function createSession({ vendor, channelId, key, entryUrl, profile }) {
  // 窗口位置：把窗口放到屏幕可视区之外，但**不要**用 -32000。
  // 原因是页面 JS 能读到 window.screenX/screenY —— 恰好 -32000 是自动化环境的
  // 教科书级特征，真实用户不可能把窗口拖到那个坐标。
  // 这里改为「常见分辨率下位于屏幕右下方之外」的坐标（数值本身不异常），
  // 并按账号做小幅散布，避免所有账号共用同一个窗口坐标。
  const spread = (n, base, span) => base + (Math.abs(Number(n) || 0) % span);
  const winX = spread(channelId, 1600, 400);
  const winY = spread((Number(channelId) || 0) * 7 + 3, 900, 200);
  const ctx = await chromium.launchPersistentContext(profileDir(vendor, channelId), {
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
  scheduleIdleCleanup();
  return s;
}

let cleanupTimer = null;
function scheduleIdleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [key, s] of sessions) {
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
export async function screenshot(vendor, channelId, { fullPage = false, quality = 70 } = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const buf = await s.page.screenshot({ type: "jpeg", quality, fullPage });
    return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, url: s.page.url() };
  });
}

// ---------- 远程人工登录：交互与凭据抓取 ----------
// 用途：添加渠道时不想让管理员自己开控制台翻 localStorage。这里在服务器端
// 打开厂商登录页截图回传，管理员在弹窗里点选/输入完成登录（支持扫码），
// 然后由 credentials() 直接把登录态读出来回填表单。
/**
 * 在会话页面上执行一次远程操作，返回操作后的截图。
 * @param {object} op { action: "click"|"type"|"key"|"scroll"|"goto", x?, y?, text?, key?, dx?, dy?, url? }
 */
export async function act(vendor, channelId, op = {}) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const page = s.page;
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
export async function credentials(vendor, channelId) {
  const s = sessions.get(`${vendor}:${channelId}`);
  if (!s) return null;
  return withLock(s, async () => {
    const cookies = await s.ctx.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const entries = await s.page
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
    return { cookies: cookieStr, url: s.page.url(), tokens: [...tokens.slice(0, 20), ...cookieCandidates.slice(0, 10)] };
  });
}

// ---------- 请求钩子 ----------
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

      window.__ooCap = { chunks: [], done: false, error: null, startedAt: Date.now(), url };

      const resp = await origFetch.call(this, input, finalInit);
      try {
        const clone = resp.clone();
        (async () => {
          try {
            const reader = clone.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line.startsWith("data:")) window.__ooCap.chunks.push(line.slice(5).trim());
              }
            }
            if (buf.trim().startsWith("data:")) window.__ooCap.chunks.push(buf.trim().slice(5).trim());
            window.__ooCap.done = true;
          } catch (e) {
            window.__ooCap.error = String(e?.message || e);
            window.__ooCap.done = true;
          }
        })();
      } catch (e) {
        window.__ooCap.error = String(e);
        window.__ooCap.done = true;
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
    window.__ooCap = { chunks: [], done: false, error: null, startedAt: 0 };
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

  for (const sel of SELECTORS) {
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

    // 等待请求发出（轮询，最长 WAIT_AFTER_CLICK）。
    // 轮询间隔决定了「请求已经发出但我们还没察觉」的空等时间，
    // 500ms 会平白多等半秒，150ms 足够（每次 evaluate 开销远小于此）。
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_AFTER_CLICK) {
      await page.waitForTimeout(150);
      if (await started()) return true;
    }
  }

  await page.keyboard.press("Enter");
  const t1 = Date.now();
  while (Date.now() - t1 < WAIT_AFTER_CLICK) {
    await page.waitForTimeout(150);
    if (await started()) return true;
  }
  return false;
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

  for (;;) {
    if (signal?.aborted) return { ok: false, error: "ABORTED", frames: cursor };
    if (Date.now() - t0 > timeoutMs) return { ok: false, error: "TIMEOUT", frames: cursor, lastBody, patchError };

    await page.waitForTimeout(pollMs);

    const st = await page.evaluate((from) => ({
      chunks: (window.__ooCap?.chunks || []).slice(from),
      total: window.__ooCap?.chunks?.length || 0,
      done: Boolean(window.__ooCap?.done),
      err: window.__ooCap?.error || null,
      started: window.__ooCap?.startedAt || 0,
      patchError: window.__ooPatchError || null,
      lastBody: window.__ooLastBody || null,
    }), cursor);

    if (st.patchError) patchError = st.patchError;
    if (st.lastBody) lastBody = st.lastBody;
    if (st.err) return { ok: false, error: st.err, frames: cursor, lastBody, patchError };

    // 先把这一轮新到的帧全部吐出去
    for (const c of st.chunks) {
      cursor++;
      if (onChunk) onChunk(c);
    }
    if (st.total > lastTotal) lastGrowthAt = Date.now();
    lastTotal = st.total;

    if (shouldStop?.()) return { ok: true, frames: cursor, stopped: true, lastBody, patchError };
    // 流已结束就立即返回；0 帧说明上游返回了空流（如错误体），不能死等到超时
    if (st.done) return { ok: cursor > 0, frames: cursor, empty: cursor === 0, lastBody, patchError };

    // 兜底：流没标记结束，但帧数已经静止 idleMs，视为已结束。
    // 必须先从「首帧到达」开始算，否则等待首帧的那几秒会被当成静止。
    if (cursor > 0 && lastGrowthAt && Date.now() - lastGrowthAt > idleMs) {
      return { ok: true, frames: cursor, endedByIdle: true, lastBody, patchError };
    }
  }
}

/** 同账号串行执行（带卡死看门狗，见 QUEUE_STUCK_MS 注释） */
export function withLock(session, task) {
  const prev = session.queue || Promise.resolve();
  let watchdog = null;
  const guarded = (async () => {
    // 前一个任务失败（或被看门狗强关）都不能阻断后续任务
    await prev.catch(() => {});
    // 看门狗从「真正持有会话」开始计时：如果从入队就算，排队等待会被算进硬上限，
    // 后面的请求还没开始干活就会被强关（上一版实现的回归）
    watchdog = setTimeout(() => {
      console.warn("[browser-driver] 会话任务超时未释放，强制重建会话以恢复该渠道可用性");
      try {
        session.ctx?.close?.().catch?.(() => {});
      } catch {
        /* ignore */
      }
      for (const [k, s] of sessions) {
        if (s === session) sessions.delete(k);
      }
    }, QUEUE_STUCK_MS);
    watchdog.unref?.();
    try {
      return await task();
    } finally {
      if (watchdog) clearTimeout(watchdog);
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
