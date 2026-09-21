// 逐页 UI 巡检：量「实际占用宽度 vs 可用宽度」，并抓弹窗内每个图标真实 src。
// 结论必须来自**真实渲染**，不看代码推断 —— 上次就是只读代码没看页面才翻车。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = process.env.OUT || "/tmp/audit";
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

// 页面级宽度探针：在真实 DOM 里找出「谁在限宽」。
// 判定口径：只看相对 .oo-content 的可用宽度用了多少。
const PROBE = () => {
  const content = document.querySelector(".oo-content");
  if (!content) return { error: "no .oo-content" };
  const avail = content.clientWidth;
  const cb = content.getBoundingClientRect();
  const out = [];
  for (const el of content.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") continue;
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const mw = cs.maxWidth;
    // 只报「显式 px 限宽」且比可用宽度窄的容器 —— 这就是用户看到的留白来源
    if (/^\d+(\.\d+)?px$/.test(mw) && parseFloat(mw) < avail - 24) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 70),
        maxWidth: mw,
        width: Math.round(r.width),
      });
    }
  }
  // 页面实际用到的最右边界（相对 content 左边界）
  let minL = Infinity;
  let maxR = -Infinity;
  const walk = (el) => {
    for (const c of el.children) {
      const cs = getComputedStyle(c);
      if (cs.position === "fixed" || cs.display === "none") continue;
      const r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      minL = Math.min(minL, r.left - cb.left);
      maxR = Math.max(maxR, r.right - cb.left);
      walk(c);
    }
  };
  walk(content);
  return {
    avail: Math.round(avail),
    used: Math.round(maxR - minL),
    leftPad: Math.round(minL),
    rightGap: Math.round(avail - maxR),
    docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    limited: out.slice(0, 12),
  };
};

const ROUTES = [
  ["/console", "控制台"],
  ["/community", "社区大厅"],
  ["/messages", "消息"],
  ["/notifications", "通知"],
  ["/token", "API 令牌"],
  ["/log", "使用记录"],
  ["/operation-log", "操作日志"],
  ["/media", "媒体库"],
  ["/profile", "个人设置"],
  ["/settings/appearance", "外观"],
  ["/admin/channel", "渠道管理"],
  ["/admin/groups", "分组管理"],
  ["/admin/pricing", "模型定价"],
  ["/admin/users", "用户管理"],
  ["/admin/settings", "系统设置"],
  ["/admin/monitor", "运维监控"],
  ["/admin/dashboard", "数据看板"],
  ["/admin/community", "社区管理"],
];

const rows = [];
for (const [path, label] of ROUTES) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1800);
    const r = await page.evaluate(PROBE);
    const name = path.replace(/\//g, "_");
    await page.screenshot({ path: `${OUT}/${name}.png` });
    rows.push({ path, label, ...r });
  } catch (e) {
    rows.push({ path, label, error: String(e.message).slice(0, 100) });
  }
}

console.log("=========== 页面宽度巡检（可用 %d px） ===========", W);
for (const r of rows) {
  if (r.error) {
    console.log(`!! ${r.label.padEnd(6)} ${r.path}  ERROR ${r.error}`);
    continue;
  }
  const gap = r.rightGap + r.leftPad;
  const flag = gap > 60 ? "  ← 有留白" : "";
  console.log(
    `${r.label.padEnd(6)} ${r.path.padEnd(22)} 可用 ${String(r.avail).padStart(4)}  实用 ${String(r.used).padStart(4)}  左 ${String(r.leftPad).padStart(3)} 右空 ${String(r.rightGap).padStart(4)}${flag}`
  );
  for (const l of r.limited || []) {
    console.log(`        └ 限宽 max-width:${l.maxWidth} 实际 ${l.width}px  <${l.tag} class="${l.cls}">`);
  }
}

// ============ 渠道弹窗：图标真实 src + 左右栏滚动能力 ============
console.log("\n=========== 渠道弹窗 ===========");
await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /添加渠道|新增渠道|添加账号/ }).first().click();
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/_dialog.png` });

const dialog = await page.evaluate(() => {
  const body = document.body;
  const picker = body.querySelector(".oo-channel-add-layout");
  const left = body.querySelector(".oo-channel-add-providers");
  const right = body.querySelector(".oo-channel-add-config");
  const modalBody = body.querySelector(".oo-channel-add-modal .ant-modal-body") || body.querySelector(".ant-modal-body");
  const measure = (el, name) => {
    if (!el) return { name, missing: true };
    const cs = getComputedStyle(el);
    return {
      name,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      overflowY: cs.overflowY,
      canScroll: el.scrollHeight > el.clientHeight + 2,
      rectH: Math.round(el.getBoundingClientRect().height),
      rectW: Math.round(el.getBoundingClientRect().width),
    };
  };
  // 弹窗内每个厂商图标：文件名 + 是否加载成功 + 实际渲染尺寸
  const icons = [...body.querySelectorAll(".oo-provider-picker__item")].map((it) => {
    const img = it.querySelector("img");
    const nm = it.querySelector("div div");
    return {
      name: nm ? nm.textContent.trim() : "?",
      src: img ? img.getAttribute("src") : "(no img)",
      natW: img ? img.naturalWidth : 0,
      ok: img ? img.complete && img.naturalWidth > 0 : false,
    };
  });
  return {
    modalBody: measure(modalBody, "modal-body"),
    layout: measure(picker, "layout"),
    left: measure(left, "left(providers)"),
    right: measure(right, "right(config)"),
    icons,
  };
});

for (const k of ["modalBody", "layout", "left", "right"]) {
  const m = dialog[k];
  if (!m || m.missing) {
    console.log(`  ${k.padEnd(10)} 缺失`);
    continue;
  }
  console.log(
    `  ${k.padEnd(10)} h=${String(m.rectH).padStart(4)} client=${String(m.clientH).padStart(4)} scroll=${String(m.scrollH).padStart(4)} overflowY=${m.overflowY.padEnd(6)} 可滚动=${m.canScroll}`
  );
}
console.log(`  厂商图标 ${dialog.icons.length} 个：`);
const uniq = new Map();
for (const i of dialog.icons) uniq.set(i.src, (uniq.get(i.src) || 0) + 1);
for (const [src, n] of uniq) console.log(`    ${String(n).padStart(2)} × ${src}`);
const broken = dialog.icons.filter((i) => !i.ok);
if (broken.length) console.log(`  !! 加载失败的图标：${broken.map((b) => `${b.name}(${b.src})`).join(", ")}`);

// 左栏滚到底，确认右栏没跟着滚（独立滚动的判据）
try {
  const left = page.locator(".oo-channel-add-providers");
  const right = page.locator(".oo-channel-add-config");
  const before = await right.evaluate((e) => e.scrollTop);
  await left.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(400);
  const afterLeft = await left.evaluate((e) => e.scrollTop);
  const afterRight = await right.evaluate((e) => e.scrollTop);
  const outer = await page.evaluate(() => ({
    docY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    modalY: (() => {
      const m = document.querySelector(".oo-channel-add-modal .ant-modal-wrap") || document.querySelector(".ant-modal-wrap");
      return m ? m.scrollHeight - m.clientHeight : -1;
    })(),
  }));
  console.log(`  滚动联动测试：左栏 scrollTop → ${afterLeft}；右栏 ${before} → ${afterRight}`);
  console.log(`  外层可滚动量：文档 ${outer.docY}px，弹窗容器 ${outer.modalY}px`);
  await page.screenshot({ path: `${OUT}/_dialog-scrolled.png` });
} catch (e) {
  console.log(`  滚动测试失败：${e.message}`);
}

// ============ 系统设置页在宽屏下的实际占用 ============
console.log("\n=========== 系统设置（宽屏 1880）宽占用 ===========");
await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);
const st = await page.evaluate(() => {
  const p = document.querySelector(".oo-content .oo-panel");
  const c = document.querySelector(".oo-content");
  if (!p || !c) return null;
  const pr = p.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  return {
    avail: Math.round(c.clientWidth),
    panel: Math.round(pr.width),
    left: Math.round(pr.left - cr.left),
    gap: Math.round(cr.right - pr.right),
  };
});
if (st) console.log(`  可用 ${st.avail}px，面板 ${st.panel}px，左 ${st.left}，右空 ${st.gap}px`);

console.log("\n截图目录：", OUT);
await browser.close();
