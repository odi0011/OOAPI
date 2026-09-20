// 视觉检查：把关键页面截图存盘，供人（或 AI）肉眼审阅。
// 为什么要它：DOM 结构断言查不出「丑」—— 栅格拉满、图表过大、留白失衡
// 这些都是纯视觉问题，只有真的看图才能发现。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = process.env.OUT || "/tmp/shots";
const W = Number(process.env.W || 1880);
const H = Number(process.env.H || 900);

const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();

/** 每个页面：路径、文件名、可选的准备动作（点开折叠区等） */
const PAGES = [
  ["/media", "01-media"],
  ["/log", "02-log", async (p) => {
    // 展开使用分析（默认收起）
    const btn = p.locator("text=展开分析");
    if (await btn.count()) await btn.first().click();
    await p.waitForTimeout(1500);
  }],
  ["/console", "03-console"],
  ["/admin/dashboard", "04-admin-dashboard"],
  ["/community", "05-community"],
  ["/community/1", "06-post-detail"],
  ["/messages", "07-messages"],
  ["/games", "08-games"],
  ["/u/1", "09-profile"],
  ["/notifications", "10-notifications"],
  ["/admin/community", "11-admin-community"],
  ["/settings/appearance", "12-appearance"],
  ["/token", "13-token"],
  ["/admin/channel", "14-admin-channel"],
];

for (const [path, name, prep] of PAGES) {
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(1800);
    if (prep) await prep(page);
    // 视口截图（与用户实际看到的一致），另存一张整页图便于看整体节奏
    await page.screenshot({ path: `${OUT}/${name}-view.png` });
    await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
    console.log(`  ok  ${path}`);
  } catch (e) {
    console.log(`  FAIL ${path}: ${e.message}`);
  }
}

await browser.close();
await pool.end().catch(() => {});
console.log(`\n截图已存到 ${OUT}`);
