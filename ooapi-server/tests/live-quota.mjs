// 线上验证额度条：拦截渠道列表接口注入 quota 快照（不动数据库），看表格真实渲染。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";

const OUT = "/opt/ooapi-preview";
const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1880, height: 900 }, deviceScaleFactor: 2 });

const SAMPLES = [
  {
    windows: [
      { label: "5 小时窗口", tag: "5h", windowSeconds: 18000, usedPercent: 12, resetAfterSeconds: 10800 },
      { label: "7 天窗口", tag: "7d", windowSeconds: 604800, usedPercent: 45, resetAfterSeconds: 172800 },
    ],
    plan: "plus", account: "user@example.com",
  },
  {
    windows: [
      { label: "5 小时窗口", tag: "5h", windowSeconds: 18000, usedPercent: 78, resetAfterSeconds: 3600 },
      { label: "7 天窗口", tag: "7d", windowSeconds: 604800, usedPercent: 94, resetAfterSeconds: 21600 },
    ],
    plan: "pro", limitReached: true,
  },
  { windows: [{ label: "30 天窗口", tag: "30d", windowSeconds: 2592000, usedPercent: 0, resetAfterSeconds: 2592000 }], plan: "free" },
  { windows: [{ label: "5h", tag: "5h", windowSeconds: 18000, usedPercent: 33, resetAfterSeconds: 7200 }], credits: { balance: "128.50", prepaidBalance: 12 } },
];

await ctx.route("**/api/channel/**", async (route) => {
  const url = route.request().url();
  if (!/\/api\/channel\/?\?|list=1/.test(url)) return route.continue();
  try {
    const resp = await route.fetch();
    const j = await resp.json();
    const rows = j?.data?.items || j?.data?.list || j?.data || [];
    if (Array.isArray(rows)) rows.forEach((r, i) => { if (i < SAMPLES.length) r.quota = SAMPLES[i]; });
    await route.fulfill({ response: resp, body: JSON.stringify(j) });
  } catch {
    await route.continue();
  }
});

await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:3001/admin/channel", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3500);

const info = await page.evaluate(() => {
  const heads = [...document.querySelectorAll(".ant-table-thead th")].map((t) => t.innerText.trim());
  const qi = heads.findIndex((h) => /额度/.test(h));
  const rows = [...document.querySelectorAll(".ant-table-tbody tr.ant-table-row")];
  const cells = rows.map((tr) => {
    const td = tr.children[qi];
    return td ? td.innerText.split("\n").join(" | ").trim() : "";
  });
  // 胶囊与进度条的实际渲染尺寸
  const bars = [...document.querySelectorAll(".ant-table-tbody span")].filter((s) => {
    const st = getComputedStyle(s);
    return st.height === "4px" && st.borderRadius === "2px";
  }).map((s) => ({ w: Math.round(s.getBoundingClientRect().width), bg: getComputedStyle(s).backgroundColor }));
  const pills = [...document.querySelectorAll(".ant-table-tbody span")].filter((s) => {
    const st = getComputedStyle(s);
    return st.borderRadius === "5px" && parseFloat(st.paddingLeft) >= 4;
  }).map((s) => ({ t: s.innerText.trim(), bg: getComputedStyle(s).backgroundColor, fg: getComputedStyle(s).color }));
  return { heads, qi, cells, bars, pills };
});

console.log("表头:", info.heads.join(" / "));
console.log("额度列索引:", info.qi);
console.log("额度列内容：");
info.cells.forEach((c, i) => console.log(`  [${i}] ${c}`));
console.log("进度条:", JSON.stringify(info.bars));
console.log("胶囊:", JSON.stringify(info.pills));

await page.screenshot({ path: `${OUT}/live-quota.png`, clip: { x: 240, y: 90, width: 1620, height: 620 } });
await browser.close();
await pool.end().catch(() => {});
process.exit(0);
