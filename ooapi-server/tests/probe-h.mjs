// 量消息页的高度构成，精确算出 calc 该减多少。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
for (const [w, h] of [[1440, 900], [1880, 900], [1440, 1080], [1366, 768]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/messages`, { waitUntil: "networkidle", timeout: 40000 });
  await page.waitForTimeout(1800);
  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cs = (s) => { const e = q(s); return e ? getComputedStyle(e) : null; };
    const content = q(".oo-content");
    const ccs = getComputedStyle(content);
    const head = q(".oo-content > .oo-page > .oo-page-head") || q(".oo-page-head");
    const lock = q(".oo-split-lock");
    const pageEl = q(".oo-content > .oo-page");
    return {
      vh: window.innerHeight,
      contentPadT: ccs.paddingTop, contentPadB: ccs.paddingBottom,
      headH: head ? Math.round(head.getBoundingClientRect().height) : 0,
      pageGap: pageEl ? getComputedStyle(pageEl).rowGap : "",
      lockH: lock ? Math.round(lock.getBoundingClientRect().height) : 0,
      lockTop: lock ? Math.round(lock.getBoundingClientRect().top) : 0,
      docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  console.log(`${w}x${h}  vh=${r.vh} 内容区pad=${r.contentPadT}/${r.contentPadB} 页头=${r.headH} 页面gap=${r.pageGap} 锁定容器=${r.lockH}(top ${r.lockTop}) 外层溢出=${r.docOver}`);
  await ctx.close();
}
await browser.close();
await pool.end().catch(() => {});
process.exit(0);
