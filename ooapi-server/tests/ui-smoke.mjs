// 前端页面健康检查（UI 冒烟）：真实浏览器加载每个路由，断言「有渲染内容 + 无运行期错误」
// ---------------------------------------------------------------------------
// 为什么必须有它（而不是只跑 vite build）：
//   `vite build` 成功**不代表页面能打开**。本项目已因此栽过两次：
//     ① MainLayout 模块顶层常量引用未导入的 HistoryOutlined → 全站白屏；
//     ② AdminChannelsPage 的 columns 数组引用了 370 行后才 useState 的变量
//        → const 暂时性死区 → /admin/channel 整页白屏。
//   两者构建期都不报错，只有真打开页面才会暴露。
//
// 用法（服务器上，需 xvfb）：
//   cd ooapi-server && xvfb-run -a node tests/ui-smoke.mjs
//   BASE=http://127.0.0.1:3999 xvfb-run -a node tests/ui-smoke.mjs   # 指定地址
//   UI_SMOKE_LOGIN=1：通过标准输入的一行 JSON 读取 username/password，走真实登录表单；不保存凭据。
import "dotenv/config";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const LOGIN_MODE = process.env.UI_SMOKE_LOGIN === "1";
const ROUTES = [
  ["/", "公开首页"],
  ["/login", "登录页"],
  ["/register", "注册页"],
  ["/console", "控制台"],
  ["/od-binance", "OD Binance"],
  ["/chat", "站内对话"],
  ["/community", "社区大厅"],
  ["/messages", "消息中心"],
  ["/notifications", "通知中心"],
  ["/token", "令牌管理"],
  ["/pricing", "模型价格"],
  ["/log", "使用记录"],
  ["/operation-log", "操作日志"],
  ["/media", "媒体库"],
  ["/settings/appearance", "外观设置"],
  ["/profile", "个人中心"],
  ["/u/1", "个人主页"],
  ["/admin/dashboard", "平台看板"],
  ["/admin/community", "社区管理"],
  ["/admin/channel", "渠道管理"],
  ["/admin/groups", "分组管理"],
  ["/admin/pricing", "模型管理"],
  ["/admin/agent", "旧编排地址转入对话"],
  ["/admin/users", "用户管理"],
  ["/admin/settings", "系统设置"],
  ["/admin/monitor", "运维监控"],
];

// 已知的无害告警（antd 内部 API 弃用提示等）不计为失败
const IGNORE = [
  /deprecated/i,
  /React Router Future Flag/i,
  /Download the React DevTools/i,
  /antd: Modal/i,
  /antd: Tabs/i,
];

async function readLoginCredentials() {
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw);
  // PTY 默认会回显输入；必须先关闭回显，再通知调用方可以发送凭据。
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding("utf8");
  let buffer = "";
  try {
    const line = await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };
      const finish = (error, value) => {
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onData = chunk => {
        buffer += chunk;
        if (buffer.includes("\u0003")) return finish(new Error("已取消登录输入"));
        if (buffer.length > 8192) return finish(new Error("登录输入过长"));
        const end = buffer.search(/[\r\n]/);
        if (end >= 0) finish(null, buffer.slice(0, end));
      };
      const onEnd = () => finish(null, buffer);
      const onError = () => finish(new Error("无法读取登录输入"));
      const timer = setTimeout(() => finish(new Error("等待登录输入超时")), 120000);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      input.resume();
      console.log("UI_SMOKE_LOGIN_READY");
    });
    let credentials;
    try { credentials = JSON.parse(line); }
    catch { throw new Error("登录输入必须是单行 JSON"); }
    if (!credentials || typeof credentials.username !== "string" || !credentials.username.trim() || typeof credentials.password !== "string" || !credentials.password) {
      throw new Error("登录输入缺少用户名或密码");
    }
    return credentials;
  } finally {
    buffer = "";
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
  }
}

let pool, token;
if (!LOGIN_MODE) {
  const [{ default: jwt }, db] = await Promise.all([import("jsonwebtoken"), import("../src/db.js")]);
  pool = db.pool;
  const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
  if (!admin) {
    console.error("数据库里没有管理员账号，无法检查管理页");
    await pool.end().catch(() => {});
    process.exit(1);
  }
  token = jwt.sign(
    { id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 },
    db.JWT_SECRET,
    { expiresIn: "20m" }
  );
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (LOGIN_MODE) {
  let credentials;
  const loginPage = await ctx.newPage();
  try {
    credentials = await readLoginCredentials();
    await loginPage.goto(BASE + "/login", { waitUntil: "networkidle", timeout: 40000 });
    await loginPage.getByLabel("用户名", { exact: true }).fill(credentials.username);
    await loginPage.getByLabel("密码", { exact: true }).fill(credentials.password);
    const [response] = await Promise.all([
      loginPage.waitForResponse(r => new URL(r.url()).pathname === "/api/user/login" && r.request().method() === "POST", { timeout: 30000 }),
      loginPage.getByRole("button", { name: "登录工作台" }).click(),
    ]);
    const result = await response.json();
    if (!response.ok() || result.success === false || Number(result.data?.user?.role) < 100 || !Number.isFinite(Number(result.data?.user?.role))) {
      throw new Error("登录未取得管理员权限");
    }
    await loginPage.waitForURL(url => !["/login", "/register"].includes(url.pathname), { timeout: 30000 });
    console.log("UI_SMOKE_LOGIN_OK");
  } catch {
    // Playwright 的调用日志可能带 fill 参数，登录失败时只输出固定提示。
    console.error("UI 冒烟登录失败：请检查登录输入、管理员权限与站点登录表单。");
    await browser.close();
    process.exit(1);
  } finally {
    if (credentials) { credentials.username = ""; credentials.password = ""; }
    await loginPage.close().catch(() => {});
  }
} else {
  await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
}

let failed = 0;
console.log(`UI 冒烟：${BASE}（管理员${LOGIN_MODE ? "表单登录" : "数据库认证"}）\n`);

for (const [route, label] of ROUTES) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 40000 });
  } catch (e) {
    errors.push(`加载失败: ${e.message}`);
  }
  await page.waitForTimeout(2000);
  if (!["/", "/login", "/register"].includes(route) && ["/login", "/register"].includes(new URL(page.url()).pathname)) {
    errors.push("认证失效：受保护页面退回登录入口");
  }

  const info = await page.evaluate(() => {
    const el = document.getElementById("root");
    return { len: (el?.innerHTML || "").length, text: (el?.innerText || "").trim().length };
  });
  const blank = info.len < 500;
  const ok = !blank && errors.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok " : "  FAIL"} ${route.padEnd(18)} ${label.padEnd(8)} 渲染=${String(info.len).padStart(6)} 文本=${String(info.text).padStart(5)}`);
  if (blank) console.log(`        ✗ 白屏（#root 几乎为空）—— 通常是 TDZ 或模块级引用错误`);
  for (const e of errors.slice(0, 3)) console.log(`        ERR: ${e.slice(0, 260)}`);
  await page.close();
}

await browser.close();
if (pool) await pool.end().catch(() => {});
console.log(`\n${failed === 0 ? "全部页面正常渲染" : `${failed} 个页面存在问题`}`);
process.exit(failed ? 1 : 0);
