import { chromium } from "file:///opt/ooapi/ooapi-server/node_modules/playwright/index.mjs";
import fs from "node:fs";

const JWT = process.env.QA_JWT;
const OUT = "/tmp/qa/shots";
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript((t) => { try { localStorage.setItem("ooapi-token", t); } catch (e) {} }, JWT);
await p.goto("http://127.0.0.1:3001/admin/channel", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3500);

await p.getByRole("button", { name: /添加渠道/ }).first().click();
await p.waitForTimeout(1200);
await p.waitForSelector(".oo-channel-add-config", { timeout: 15000 });

const measure = async () => p.evaluate(() => {
  const panel = document.querySelector(".oo-channel-add-config");
  const pr = panel.getBoundingClientRect();
  const pcs = getComputedStyle(panel);
  const panelInfo = {
    rect: { left: +pr.left.toFixed(1), right: +pr.right.toFixed(1), top: +pr.top.toFixed(1), bottom: +pr.bottom.toFixed(1), w: +pr.width.toFixed(1), h: +pr.height.toFixed(1) },
    padding: pcs.paddingTop + " " + pcs.paddingRight + " " + pcs.paddingBottom + " " + pcs.paddingLeft,
    overflow: pcs.overflowX + "/" + pcs.overflowY,
    clientW: panel.clientWidth, scrollW: panel.scrollWidth,
    clientH: panel.clientHeight, scrollH: panel.scrollHeight,
  };
  const clipL = pr.left + (parseFloat(pcs.borderLeftWidth) || 0);
  const clipR = pr.right - (parseFloat(pcs.borderRightWidth) || 0);
  const clipT = pr.top + (parseFloat(pcs.borderTopWidth) || 0);
  const clipB = pr.bottom - (parseFloat(pcs.borderBottomWidth) || 0);
  const contentL = clipL + (parseFloat(pcs.paddingLeft) || 0);
  const contentR = clipR - (parseFloat(pcs.paddingRight) || 0);

  const ancestorsClip = (el) => {
    let cl = -Infinity, cr = Infinity, ct = -Infinity, cb = Infinity, who = [];
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const hid = (v) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
      if (hid(cs.overflowX) || hid(cs.overflowY)) {
        const r = n.getBoundingClientRect();
        cl = Math.max(cl, r.left + (parseFloat(cs.borderLeftWidth) || 0));
        cr = Math.min(cr, r.right - (parseFloat(cs.borderRightWidth) || 0));
        ct = Math.max(ct, r.top + (parseFloat(cs.borderTopWidth) || 0));
        cb = Math.min(cb, r.bottom - (parseFloat(cs.borderBottomWidth) || 0));
        who.push(String(n.className || n.tagName).slice(0, 55));
      }
      n = n.parentElement;
    }
    return { cl, cr, ct, cb, who };
  };

  const controls = [];
  const sel = "input:not([type=hidden]), textarea, .ant-select-selector, .ant-radio-button-wrapper, .ant-input-number, .ant-switch, button";
  for (const el of panel.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const a = ancestorsClip(el);
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    controls.push({
      tag, cls, ph: el.getAttribute("placeholder") || "",
      rect: { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) },
      ringGapL: +(r.left - 2 - a.cl).toFixed(1),
      ringGapR: +(a.cr - (r.right + 2)).toFixed(1),
      panelGapL: +(r.left - 2 - clipL).toFixed(1),
      panelGapR: +(clipR - (r.right + 2)).toFixed(1),
      panelContentGapL: +(r.left - contentL).toFixed(1),
      panelContentGapR: +(contentR - r.right).toFixed(1),
    });
  }

  const clipped = [];
  for (const el of panel.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const hasDirectText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length);
    if (!hasDirectText) continue;
    const hx = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const hy = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const sx = el.scrollWidth - el.clientWidth, sy = el.scrollHeight - el.clientHeight;
    if (hx && sx > 1 && cs.textOverflow !== "ellipsis")
      clipped.push({ kind: "text-x", cls: String(el.className || "").slice(0, 60), txt: el.textContent.trim().slice(0, 45), sw: el.scrollWidth, cw: el.clientWidth, over: sx });
    if (hy && sy > 1 && el.clientHeight > 0)
      clipped.push({ kind: "text-y", cls: String(el.className || "").slice(0, 60), txt: el.textContent.trim().slice(0, 45), sh: el.scrollHeight, ch: el.clientHeight, over: sy });
  }

  const outside = [];
  for (const el of panel.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "absolute") continue;
    if (r.right > clipR + 0.5 || r.left < clipL - 0.5) {
      outside.push({ cls: String(el.className || el.tagName).slice(0, 60), tag: el.tagName.toLowerCase(), l: +r.left.toFixed(1), r: +r.right.toFixed(1), out: r.left < clipL ? +(clipL - r.left).toFixed(1) : +(r.right - clipR).toFixed(1) });
    }
  }

  let bottomGap = null, lastCtl = null;
  const vis = controls.filter((c) => c.rect.b >= clipT - 1 && c.rect.t <= clipB + 1);
  if (vis.length) {
    const last = vis.reduce((m, c) => (c.rect.b > m.rect.b ? c : m));
    bottomGap = +(clipB - last.rect.b).toFixed(1);
    lastCtl = { tag: last.tag, cls: last.cls, b: last.rect.b };
  }

  const first = panel.querySelector("input.ant-input, textarea.ant-input");
  let focused = null;
  if (first) {
    const r = first.getBoundingClientRect();
    const a = ancestorsClip(first);
    focused = {
      ph: first.getAttribute("placeholder"),
      ringGapL: +(r.left - 2 - a.cl).toFixed(1),
      ringGapR: +(a.cr - (r.right + 2)).toFixed(1),
      panelRingGapL: +(r.left - 2 - clipL).toFixed(1),
      panelRingGapR: +(clipR - (r.right + 2)).toFixed(1),
      clipAncestors: a.who,
    };
  }
  return { panelInfo, controls, clipped, outside, bottomGap, lastCtl, focused,
    paddingLeft: parseFloat(pcs.paddingLeft), paddingRight: parseFloat(pcs.paddingRight), paddingBottom: parseFloat(pcs.paddingBottom) };
});

const shotPanel = async (file) => {
  const box = await p.evaluate(() => {
    const el = document.querySelector(".oo-channel-add-config");
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 6), width: Math.min(r.width + 16, 1580), height: Math.min(r.height + 12, 990) };
  });
  await p.screenshot({ path: OUT + "/" + file, clip: box });
};

const results = [];
const provNames = await p.$$eval(".oo-provider-picker__item", (els) => els.map((e) => e.textContent.trim().split("\n")[0].trim()));
console.log("PROVIDER COUNT: " + provNames.length);
console.log("PROVIDERS: " + JSON.stringify(provNames));

for (let i = 0; i < provNames.length; i++) {
  const name = provNames[i];
  const items = await p.$$(".oo-provider-picker__item");
  if (!items[i]) { results.push({ provider: name, error: "item gone" }); continue; }
  await items[i].scrollIntoViewIfNeeded().catch(() => {});
  await items[i].click({ timeout: 6000 }).catch(async () => { await items[i].click({ force: true }).catch(() => {}); });
  await p.waitForTimeout(650);

  const tabs = await p.$$eval(".oo-channel-add-config .ant-radio-group .ant-radio-button-wrapper", (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  const safe = name.replace(/[^A-Za-z0-9\u4e00-\u9fa5-]/g, "_").slice(0, 22);

  if (tabs.length === 0) {
    const m = await measure();
    await shotPanel("add__" + safe + "__t0.png");
    results.push(Object.assign({ provider: name, tab: "(single)" }, m));
  } else {
    for (let t = 0; t < tabs.length; t++) {
      const rads = await p.$$(".oo-channel-add-config .ant-radio-group .ant-radio-button-wrapper");
      if (!rads[t]) continue;
      await rads[t].scrollIntoViewIfNeeded().catch(() => {});
      await rads[t].click({ force: true }).catch(() => {});
      await p.waitForTimeout(420);
      const m = await measure();
      await shotPanel("add__" + safe + "__t" + t + ".png");
      results.push(Object.assign({ provider: name, tab: tabs[t].replace(/\n/g, " ").slice(0, 26), tabIndex: t, tabCount: tabs.length }, m));
    }
  }
}

fs.writeFileSync("/tmp/qa/addchannel.json", JSON.stringify(results, null, 1));
console.log("ROWS: " + results.length);
await b.close();
