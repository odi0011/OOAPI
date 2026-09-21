// 三项验收：① 页面全宽 ② 渠道图标 ③ 弹窗左右独立滚动。
// 上一版滚动测试的漏洞：右栏内容比容器短（scrollHeight == clientHeight），
// 于是「右栏没滚动」既可能是独立滚动的正确表现，也可能是它根本没得滚。
// 这一版**先选中一个表单很长的厂商**，让两侧都确定有溢出量，再验证互不联动。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = process.env.OUT || "/tmp/verify3";
const W = Number(process.env.W || 1880);
const H = Number(process.env.H || 900);

const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) {
    pass += 1;
    console.log(`  ok   ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${n} ${extra}`);
  }
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();

// ============ ① 各页区块宽度：统计卡行必须铺满 ============
console.log("=== ① 页面宽度（统计卡行是否铺满）===");
const ROUTES = ["/console", "/notifications", "/media", "/profile", "/admin/settings",
  "/admin/pricing", "/admin/dashboard", "/admin/community", "/admin/monitor"];

for (const path of ROUTES) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1600);
  const r = await page.evaluate(() => {
    const content = document.querySelector(".oo-content");
    const cs = getComputedStyle(content);
    const avail = content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // 「统计卡行」：oo-stats-cards / oo-grid 这类网格容器，量它的实际占用宽度
    const grids = [...document.querySelectorAll(".oo-content .oo-stats-cards, .oo-content .oo-grid")];
    const rows = grids.map((g) => ({
      cls: String(g.className).split(" ").slice(0, 2).join("."),
      w: Math.round(g.getBoundingClientRect().width),
      kids: g.children.length,
      kidW: g.children.length ? Math.round(g.children[0].getBoundingClientRect().width) : 0,
    }));
    // 面板限宽（>120px 的显式 max-width 就是问题）
    const limited = [...document.querySelectorAll(".oo-content *")]
      .filter((el) => {
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return /^\d+px$/.test(s.maxWidth) && parseFloat(s.maxWidth) > 120
          && parseFloat(s.maxWidth) < avail - 40 && b.height > 40 && b.width > 200;
      })
      .map((el) => `${String(el.className).split(" ")[0]} maxW=${getComputedStyle(el).maxWidth}`);
    return { avail: Math.round(avail), rows, limited: [...new Set(limited)].slice(0, 6) };
  });
  const bad = r.rows.filter((x) => x.w < r.avail * 0.9);
  const detail = r.rows.map((x) => `${x.cls}:${x.w}/${x.kids}卡`).join(" ");
  console.log(`  ${path.padEnd(21)} 可用 ${r.avail}  ${detail}`);
  if (r.limited.length) console.log(`        限宽：${r.limited.join(" | ")}`);
  ck(`${path} 无窄区块`, bad.length === 0 && r.limited.length === 0,
    bad.length ? `${bad.map((b) => b.cls + "=" + b.w).join(",")}` : r.limited.join(","));
}

// ============ ② 渠道图标 ============
console.log("\n=== ② 渠道图标 ===");
await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1600);
await page.getByRole("button", { name: /添加渠道|新增渠道|添加账号/ }).first().click();
await page.waitForTimeout(1500);

// 逐个厂商：滚动到可见 → 截图它的图标区域 → 记录 src 与自然尺寸
const icons = await page.evaluate(() => {
  return [...document.querySelectorAll(".oo-provider-picker__item")].map((it) => {
    const img = it.querySelector("img");
    const nm = it.querySelector("div div");
    return {
      name: nm ? nm.textContent.trim() : "?",
      src: img ? img.getAttribute("src") : "(none)",
      nat: img ? img.naturalWidth : 0,
      ok: img ? img.complete && img.naturalWidth > 0 : false,
    };
  });
});
const byName = Object.fromEntries(icons.map((i) => [i.name, i]));
const expect = {
  "小米 MiMo": "/icons/mimo.png",
  MiniMax: "/icons/minimax.png",
  "阶跃星辰 StepFun": "/icons/stepfun.png",
  火山方舟: "/icons/ark.png",
  "OpenCode Zen": "/icons/opencode.png",
  OpenRouter: "/icons/openrouter.svg",
  硅基流动: "/icons/siliconflow.ico",
};
for (const [name, src] of Object.entries(expect)) {
  const got = byName[name];
  ck(`${name} 图标 = ${src}`, got && got.src === src && got.ok, got ? `实际 ${got.src} ok=${got.ok}` : "未找到");
}
const logoCount = icons.filter((i) => i.src.includes("logo.jpg")).length;
ck("只有「自定义」用平台 logo", logoCount === 1, `实际 ${logoCount} 个`);
await page.screenshot({ path: `${OUT}/dialog.png` });

// ============ ③ 左右独立滚动 ============
console.log("\n=== ③ 弹窗左右独立滚动 ===");
// 选一个配置项多的厂商（Anthropic 有 3 种凭据方式），让右栏确定有内容
await page.locator('.oo-provider-picker__item:has-text("Anthropic")').first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/dialog-anthropic.png` });

const m = await page.evaluate(() => {
  const g = (s) => document.body.querySelector(s);
  const info = (el) => (el ? {
    client: el.clientHeight, scroll: el.scrollHeight, over: getComputedStyle(el).overflowY,
  } : null);
  const left = g(".oo-channel-add-providers");
  const right = g(".oo-channel-add-config");
  return {
    left: info(left),
    right: info(right),
    layout: info(g(".oo-channel-add-layout")),
    body: info(g(".oo-channel-add-modal .ant-modal-body")),
    docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    wrapScroll: (() => {
      const w = document.querySelector(".oo-channel-add-modal .ant-modal-wrap") || document.querySelector(".ant-modal-wrap");
      return w ? w.scrollHeight - w.clientHeight : -1;
    })(),
  };
});
console.log(`  左栏 client=${m.left?.client} scroll=${m.left?.scroll} over=${m.left?.over}`);
console.log(`  右栏 client=${m.right?.client} scroll=${m.right?.scroll} over=${m.right?.over}`);
console.log(`  外层：文档 ${m.docScroll}px，弹窗容器 ${m.wrapScroll}px`);

ck("左栏可滚动", m.left && m.left.scroll > m.left.client + 2, JSON.stringify(m.left));
ck("外层不滚动（文档）", m.docScroll === 0, `文档可滚 ${m.docScroll}px`);
ck("外层不滚动（弹窗容器）", m.wrapScroll <= 0, `弹窗容器可滚 ${m.wrapScroll}px`);

// 滚左栏 → 右栏与页面都不该动
const a = await page.evaluate(() => {
  const l = document.body.querySelector(".oo-channel-add-providers");
  const r = document.body.querySelector(".oo-channel-add-config");
  const y0 = window.scrollY;
  l.scrollTop = 9999;
  return { left: l.scrollTop, right: r.scrollTop, win: window.scrollY - y0 };
});
ck("滚左栏时右栏不动", a.right === 0, `右栏 scrollTop=${a.right}`);
ck("滚左栏时页面不动", a.win === 0, `window 位移 ${a.win}`);

// 滚右栏 → 左栏与页面都不该动
const b = await page.evaluate(() => {
  const l = document.body.querySelector(".oo-channel-add-providers");
  const r = document.body.querySelector(".oo-channel-add-config");
  const l0 = l.scrollTop;
  const y0 = window.scrollY;
  r.scrollTop = 9999;
  return { leftMoved: l.scrollTop - l0, right: r.scrollTop, win: window.scrollY - y0, rightMax: r.scrollHeight - r.clientHeight };
});
ck("滚右栏时左栏不动", b.leftMoved === 0, `左栏位移 ${b.leftMoved}`);
ck("滚右栏时页面不动", b.win === 0, `window 位移 ${b.win}`);
console.log(`  右栏溢出量 ${b.rightMax}px，滚到 ${b.right}`);
await page.screenshot({ path: `${OUT}/dialog-scrolled-right.png` });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log("截图：", OUT);
await browser.close();
process.exit(fail ? 1 : 0);
