// 最终视觉确认：铺满相关页面 + 弹窗，1880 宽。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = process.env.OUT || "/tmp/final";
const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1880, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();
for (const [p, n] of [["/admin/settings", "settings"], ["/profile", "profile"], ["/media", "media"], ["/notifications", "notifications"]]) {
  await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${n}.png` });
}
// 弹窗：滚到新厂商区
await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /添加渠道|新增渠道|添加账号/ }).first().click();
await page.waitForTimeout(1200);
await page.evaluate(() => { document.body.querySelector(".oo-channel-add-providers").scrollTop = 420; });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/dialog-new-vendors.png` });
await browser.close();
await pool.end().catch(() => {});
process.exit(0);
