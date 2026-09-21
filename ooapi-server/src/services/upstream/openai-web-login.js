// ChatGPT 网页版「邮箱 + 密码 + 2FA」自动登录
// ===========================================================================
// 实测依据（2026-09-21，线上服务器真实浏览器）：
//   · chatgpt.com 对 curl 返回 403（cf-mitigated: challenge），但**真实浏览器正常** ——
//     那是 Cloudflare 的 JS 挑战，不是 IP 封禁。
//   · 登录是**两步式**：先填邮箱 → 跳 auth.openai.com/log-in/password 再填密码 →
//     可能再跳 mfa-challenge 填动态码。每步之后页面 URL 会变。
//   · 表单是 React 受控组件：`fill()` 直接赋值不会更新框架 state，
//     点「继续」会**停在原步不前进**（页面不报错、看着像卡住）。
//     必须 click → 清空 → 逐字符 type，让每次按键触发 onChange。
//   · 连续登录约 5 次后提交按钮会**一直转圈挂起**（OpenAI 限流），
//     2~3 分钟后自行恢复。所以登录必须是一次性动作 + 持久化，不能每请求重登。
import { totpFresh, totpRemaining } from "../totp.js";

const LOGIN_URL = "https://chatgpt.com/auth/login";
const NAV_TIMEOUT = 60_000;

/** 页面已离开某个步骤的判定（轮询条件） */
const onPasswordStep = () => /log-in\/password|auth0\.openai\.com.*password/i.test(location.href);
const onMfaStep = () => /mfa|mfa-challenge/i.test(location.href);
const onLoggedIn = () =>
  /^https:\/\/chatgpt\.com\/?(?:[?#].*)?$/.test(location.href) && !/auth\/login/i.test(location.href);

/**
 * 填一个输入框并提交。
 * 逐字符输入是硬要求（React 受控组件要靠真实按键事件更新 state）；
 * 输入后再等 value 落盘，最后点提交按钮。
 */
async function fillAndSubmit(page, selector, value, label, { submitSelector = 'button[type="submit"]' } = {}) {
  const el = await page.waitForSelector(selector, { timeout: 25_000, state: "visible" }).catch(() => null);
  if (!el) {
    throw Object.assign(new Error(`未找到${label}输入框，登录页结构可能已变化`), { code: "LOGIN_PAGE_CHANGED" });
  }
  await el.click().catch(() => {});
  // 清空：先全选再删除，避免残留内容触发校验
  await el.fill("").catch(() => {});
  await el.type(value, { delay: 25 });
  // 等值真的落到输入框上（type 是异步逐字符，早提交会发出空表单）
  await page.waitForFunction(
    (sel) => {
      const n = document.querySelector(sel);
      return n && String(n.value ?? n.textContent ?? "").length > 0;
    },
    selector,
    { timeout: 8_000 },
  ).catch(() => {});
  await page.waitForTimeout(500);
  await page.click(submitSelector).catch(async () => {
    await page.keyboard.press("Enter");
  });
  return true;
}

/** 轮询等某个条件成立（比固定 sleep 稳：页面快时提前返回，慢时不误判） */
async function waitFor(page, fn, { timeout = 30_000, label = "页面状态" } = {}) {
  try {
    await page.waitForFunction(fn, null, { timeout, polling: 300 });
    return true;
  } catch {
    console.warn(`[openai-web-login] 等待「${label}」超时（${timeout}ms），当前 URL: ${page.url()}`);
    return false;
  }
}

/**
 * 执行登录，成功后返回 { accessToken, deviceId, account, planType, expiresAt }。
 *
 * @param {object} page      browser-driver 给出的 Playwright 页面
 * @param {object} creds     { email, password, totpSecret }
 */
export async function loginWithCredentials(page, { email, password, totpSecret }) {
  if (!email || !password) {
    throw Object.assign(new Error("请填写邮箱与密码"), { code: "LOGIN_BAD_PARAMS" });
  }
  if (totpSecret && !/^[A-Za-z2-7\s-]+=*$/.test(String(totpSecret).trim())) {
    throw Object.assign(new Error("2FA 密钥格式不正确（应为 base32 字符串，如 ABCD2345…）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }

  // 先清掉可能存在的旧会话。
  // 否则访问 /auth/login 会被重定向回首页（已登录状态），邮箱框永远不出现 ——
  // 表现为「登录页加载失败」，而页面其实完全正常。
  // 实测踩过：第一次登录成功留下的 profile 会让第二次登录直接失败。
  await page.context().clearCookies().catch(() => {});

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  // 首屏要过 Cloudflare 挑战，等输入框真正出现而不是固定睡眠
  const emailReady = await page
    .waitForSelector("input#email, input[name='email']", { timeout: 45_000, state: "visible" })
    .catch(() => null);
  if (!emailReady) {
    // 区分两种失败：真的打不开页面，还是被重定向走了（清 cookie 没生效）
    const url = page.url();
    const onLoginPage = /auth\/login|\/log-in/i.test(url);
    throw Object.assign(
      new Error(
        onLoginPage
          ? "ChatGPT 登录页加载失败（可能是 Cloudflare 挑战未通过或网络不可达）"
          : `ChatGPT 登录页被重定向到 ${url}（旧会话未清干净，请重试）`,
      ),
      { code: "LOGIN_PAGE_UNAVAILABLE" },
    );
  }

  // ① 邮箱
  await fillAndSubmit(page, "input#email", email, "邮箱");

  // ② 密码（若该账号已记住登录态则可能直接跳过）
  const gotPassword = await waitFor(page, onPasswordStep, { timeout: 30_000, label: "密码页" });
  let gotMfa;
  if (gotPassword) {
    await fillAndSubmit(page, 'input[type="password"]', password, "密码");
    gotMfa = await waitFor(page, onMfaStep, { timeout: 30_000, label: "2FA 页" });
  } else if (await waitFor(page, onMfaStep, { timeout: 5_000, label: "2FA 页（跳过密码）" })) {
    gotMfa = true;
  }

  // ③ 2FA 动态码（账号没开 2FA 时不会出现这一步）
  if (gotMfa) {
    if (!totpSecret) {
      throw Object.assign(new Error("该账号已开启两步验证，请填写 2FA 密钥（验证器里那串 base32 密钥，不是 6 位数字）"), {
        code: "LOGIN_NEED_2FA",
      });
    }
    // 动态码 30 秒一换：剩余不足时等下一个窗口，否则请求在路上就过期，
    // 上游报「验证码错误」，会让人误以为密钥填错。
    const left = totpRemaining();
    if (left < 5) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
    const code = await totpFresh(totpSecret, { minRemaining: 0 });
    const mfaReady = await page
      .waitForSelector('input[name="code"], input#code, input[autocomplete="one-time-code"]', {
        timeout: 15_000,
        state: "visible",
      })
      .catch(() => null);
    if (!mfaReady) {
      throw Object.assign(new Error("未找到两步验证码输入框，登录页结构可能已变化"), { code: "LOGIN_PAGE_CHANGED" });
    }
    await mfaReady.click().catch(() => {});
    await mfaReady.fill("").catch(() => {});
    await mfaReady.type(code, { delay: 30 });
    await page.waitForTimeout(500);
    await page.click('button[type="submit"]').catch(async () => {
      await page.keyboard.press("Enter");
    });
  }

  // ④ 等落到已登录首页
  const ok = await waitFor(page, onLoggedIn, { timeout: 45_000, label: "登录成功页" });
  if (!ok) {
    // 报错必须指出**卡在哪一步**：只写「登录失败」时，管理员无法区分
    // 「密码错」「动态码错」「被风控」，只能靠自己猜（实测踩过）。
    const url = page.url();
    const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200)).catch(() => "");
    const at = /log-in\/password/i.test(url)
      ? "停在密码页（邮箱或密码不正确）"
      : /mfa|challenge/i.test(url)
        ? "停在两步验证页（动态码未被接受，检查 2FA 密钥是否正确、与本账号匹配）"
        : /auth\/login/i.test(url)
          ? "仍在登录页（邮箱未被接受，或登录被限流）"
          : `停在 ${url}`;
    throw Object.assign(
      new Error(`ChatGPT 登录失败：${at}${body ? `。页面提示：${body.slice(0, 120)}` : ""}`),
      { code: "LOGIN_FAILED", step: url },
    );
  }

  // ⑤ 取 access_token 与 device_id —— 后者是网页版的设备指纹，
  //    换设备/换值都是明显的异常信号，必须与登录会话一起持久化。
  const info = await page.evaluate(async () => {
    const s = await (await fetch("/api/auth/session", { credentials: "include" })).json().catch(() => null);
    const did = (document.cookie.match(/oai-did=([^;]+)/) || [])[1] || "";
    return {
      accessToken: s?.accessToken || "",
      planType: s?.account?.planType || "",
      email: s?.user?.email || "",
      expires: s?.expires || "",
      deviceId: did,
    };
  });

  if (!info.accessToken) {
    throw Object.assign(new Error("登录成功了但没取到 access_token，请在网页端确认账号状态"), {
      code: "LOGIN_NO_TOKEN",
    });
  }

  return {
    accessToken: info.accessToken,
    deviceId: info.deviceId,
    account: info.email || email,
    planType: info.planType,
    expiresAt: info.expires,
  };
}

/**
 * 登录态是否仍有效（供「测试渠道」与定时检测用）。
 * 只看浏览器会话即可：能拿到 accessToken 就说明 cookie 还没过期。
 */
export async function checkSession(page) {
  const r = await page.evaluate(async () => {
    try {
      const s = await (await fetch("/api/auth/session", { credentials: "include" })).json();
      return { ok: Boolean(s?.accessToken), planType: s?.account?.planType || "", len: (s?.accessToken || "").length };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  return r;
}
