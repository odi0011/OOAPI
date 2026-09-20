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
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import { JWT_SECRET, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const ROUTES = [
  ["/", "公开首页"],
  ["/login", "登录页"],
  ["/console", "控制台"],
  ["/chat", "站内对话"],
  ["/community", "社区大厅"],
  ["/messages", "消息中心"],
  ["/notifications", "通知中心"],
  ["/games", "Playground"],
  ["/token", "令牌管理"],
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
  ["/admin/pricing", "模型定价"],
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

const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
if (!admin) {
  console.error("数据库里没有管理员账号，无法检查管理页");
  process.exit(1);
}
const token = jwt.sign(
  { id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 },
  JWT_SECRET,
  { expiresIn: "20m" }
);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);

let failed = 0;
console.log(`UI 冒烟：${BASE}（管理员 ${admin.username}）\n`);

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
await pool.end().catch(() => {});
console.log(`\n${failed === 0 ? "全部页面正常渲染" : `${failed} 个页面存在问题`}`);
process.exit(failed ? 1 : 0);
