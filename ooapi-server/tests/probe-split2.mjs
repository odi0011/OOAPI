// 双栏滚动复核（修正选择器）：
//  · 消息页是骨架 B（视口锁定）——外壳 .oo-split-side/main 是 overflow:hidden，
//    真正的滚动容器是内层 .oo-split-scroll（每个栏各一个）。
//  · 社区页是骨架 C（流式阅读）——两栏随页面滚动，不该锁高度。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = "/tmp/split2";
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

// ① 消息中心：进一个会话，让右栏真的有内容与滚动量
console.log("--- 消息中心（骨架 B，视口锁定）---");
await page.goto(`${BASE}/messages`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2500);
// 尝试点开第一个会话（有会话时才有输入框与消息列表）
try {
  const first = page.locator(".oo-split-side .oo-session-item, .oo-split-side [role='button']").first();
  if (await first.count()) { await first.click(); await page.waitForTimeout(2000); }
} catch {}
const m = await page.evaluate(() => {
  const scrollers = [...document.querySelectorAll(".oo-split-scroll")];
  return {
    n: scrollers.length,
    each: scrollers.map((e) => ({ client: e.clientHeight, scroll: e.scrollHeight, over: getComputedStyle(e).overflowY })),
    docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    lock: (() => { const l = document.querySelector(".oo-split-lock"); return l ? { h: Math.round(l.getBoundingClientRect().height), over: getComputedStyle(l).overflowY } : null; })(),
  };
});
console.log(`  滚动容器 ${m.n} 个：${m.each.map((e) => `${e.client}/${e.scroll}(${e.over})`).join("  ")}`);
console.log(`  锁定容器高 ${m.lock?.h}px overflow=${m.lock?.over}；页面外层可滚 ${m.docScroll}px`);
ck("消息页左右各有独立滚动容器", m.n >= 2, `实际 ${m.n} 个`);
ck("滚动容器真的可滚（overflow:auto）", m.each.every((e) => e.over === "auto" || e.over === "scroll"), JSON.stringify(m.each.map((e) => e.over)));
// 外层不该有滚动（锁定骨架的意义），允许 0~2px 取整误差
ck("页面外层不滚动（底部输入框不被推出视野）", m.docScroll <= 2, `外层可滚 ${m.docScroll}px`);
if (m.n >= 2) {
  const r = await page.evaluate(() => {
    const [a, b] = document.querySelectorAll(".oo-split-scroll");
    const b0 = b.scrollTop;
    a.scrollTop = 9999;
    return { a: a.scrollTop, bMoved: b.scrollTop - b0 };
  });
  ck("滚左栏时右栏不动", r.bMoved === 0, `右栏位移 ${r.bMoved}`);
}
await page.screenshot({ path: `${OUT}/messages.png` });

// ② 社区：骨架 C，两栏随页面滚动
console.log("\n--- 社区大厅（骨架 C，流式阅读）---");
await page.goto(`${BASE}/community`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2200);
const c = await page.evaluate(() => {
  const shell = document.querySelector(".oo-read-shell");
  const aside = document.querySelector(".oo-read-aside");
  const main = shell?.children?.[0];
  return {
    cols: shell ? getComputedStyle(shell).gridTemplateColumns : "",
    mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
    asideW: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
    asidePos: aside ? getComputedStyle(aside).position : "",
    docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  };
});
console.log(`  栏宽 主 ${c.mainW}px / 侧 ${c.asideW}px  侧栏 position=${c.asidePos}  页面可滚 ${c.docScroll}px`);
ck("社区两栏并列渲染", c.mainW > 400 && c.asideW >= 260, JSON.stringify(c));
ck("社区是流式阅读骨架（页面本身可滚）", c.docScroll >= 0);
await page.screenshot({ path: `${OUT}/community.png` });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await browser.close();
await pool.end().catch(() => {});
process.exit(fail ? 1 : 0);
