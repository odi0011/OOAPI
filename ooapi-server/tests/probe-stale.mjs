// 验证发版提示：模拟「页面加载的是旧 bundle」——拦截 /api/status 返回一个不同的 build_id，
// 断言横幅出现、且点「立即刷新」会触发 reload。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = "/tmp/stale";
const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();

// ① 正常情况下不该出现横幅
await page.goto(`${BASE}/console`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2000);
const clean = await page.evaluate(() => ({
  has: Boolean(document.querySelector(".oo-stale-build")),
  buildId: document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute("src"),
}));
console.log("  当前加载:", clean.buildId);
ck("版本一致时不显示提示条", !clean.has);

// ② 伪造「服务器已更新」：拦截 status 返回别的 build_id，再导航触发
await page.route("**/api/status", async (route) => {
  const r = await route.fetch();
  const j = await r.json();
  j.data.build_id = "index-OLDVERSION0.js";
  await route.fulfill({ response: r, body: JSON.stringify(j) });
});
await page.goto(`${BASE}/console`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2500);
const stale = await page.evaluate(() => {
  const el = document.querySelector(".oo-stale-build");
  return { has: Boolean(el), text: el ? el.innerText.replace(/\s+/g, " ").slice(0, 120) : "" };
});
console.log("  提示条文本:", stale.text || "(无)");
ck("版本不一致时显示提示条", stale.has);
ck("提示条文案说明原因与操作", /旧版本|刷新/.test(stale.text), stale.text);
await page.screenshot({ path: `${OUT}/stale-banner.png` });

// ③ 点「立即刷新」应重载页面
let reloaded = false;
page.on("framenavigated", (f) => { if (f === page.mainFrame()) reloaded = true; });
const btn = page.getByRole("button", { name: "立即刷新" });
ck("有「立即刷新」按钮", await btn.count() > 0);
if (await btn.count()) {
  await btn.first().click();
  await page.waitForTimeout(3000);
  ck("点击后页面重载", reloaded);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
await browser.close();
await pool.end().catch(() => {});
process.exit(fail ? 1 : 0);
