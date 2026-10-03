// 对真实组件的菜单点击和操作事件逐帧取样；除暂停动画取证外不修改 DOM/CSS。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE = process.env.BASE || "http://127.0.0.1:4115", OUT = process.env.EVIDENCE_DIR || "/var/tmp/ooapi-lele-locomotion";
const [[db]] = await pool.query("SELECT DATABASE() name"); assert.equal(db.name, "ooapi_lele_gate");
const [[admin]] = await pool.query("SELECT * FROM users WHERE role>=100 ORDER BY role DESC LIMIT 1");
const [[key]] = await pool.query("SELECT id FROM tokens WHERE user_id=? AND group_name=? LIMIT 1", [admin.id, "测试"]);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
page.on("pageerror", e => errors.push(e.message));
// 生产截图中模型目录很长；候选库只有少数模型，补充只读元信息以覆盖真实高度差。
await page.route("**/api/chat/meta*", async route => {
  const response = await route.fetch(), data = await response.json();
  const template = data.data.models[0];
  const extra = Array.from({ length: 24 }, (_, i) => ({ ...template, id: `motion-fixture-${i}`, label: `动作测试模型 ${i}` }));
  data.data.models.push(...extra);
  if (data.data.vendors?.[0]) data.data.vendors[0].models.push(...extra);
  await route.fulfill({ response, json: data });
});
await page.addInitScript(({ token, key }) => { localStorage.setItem("ooapi-token", token); localStorage.setItem("oo.chat.keyId", key); }, { token: signToken(admin), key: String(key.id) });
let checks = 0; const check = (v, label) => { assert.ok(v, label); checks++; console.log("PASS", label); };
const anchor = page.locator(".lele-perch-anchor");
async function frames(name) {
  const rows = [];
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 30));
  await anchor.evaluate(n => n.getAnimations({ subtree: true }).forEach(a => a.pause()));
  for (const f of [0, .16, .32, .48, .64, .79, .88, .99]) {
    await anchor.evaluate((n, f) => n.getAnimations({ subtree: true }).forEach(a => { a.currentTime = Number(a.effect.getTiming().duration) * f; }), f);
    const row = await anchor.evaluate(n => {
      const css = s => getComputedStyle(n.querySelector(s)), box = s => { const r = n.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom, right: r.right }; };
      return { bounds: box(".lele-edge-actor"), eyes: box(".cat-eyes"), cranium: box(".cat-cranium"), actor: css(".lele-edge-actor").transform, body: css(".cat-body").transform, head: css(".cat-cranium").transform, left: css(".cat-paw-left").transform, right: css(".cat-paw-right").transform, tail: css(".cat-tail").transform, paws: box(".cat-paws"), z: getComputedStyle(n).zIndex, clip: css(".lele-edge-viewport").overflowX, face: css(".cat-face").visibility, back: n.querySelector(".cat-head-back") ? css(".cat-head-back").visibility : "none" };
    });
    rows.push(row); await page.screenshot({ path: `${OUT}/${name}-${f}.png` });
  }
  for (const part of ["body", "head", "left", "right", "tail"]) check(new Set(rows.map(r => r[part])).size >= 3, `${name} ${part} 有独立姿态变化`);
  if (name.includes("fall") || name === "drop") check(rows.every(r => r.eyes.y > r.cranium.y + 6), name + " 惊讶时原有眼睛仍在脸上，不漂到耳朵或额头");
  await fs.writeFile(OUT + "/" + name + "-frames.json", JSON.stringify(rows));
  await page.clock.resume();
  return rows;
}
try {
  await fs.mkdir(OUT, { recursive: true }); await page.clock.install(); await page.goto(BASE + "/chat", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lele-action", { detail: "retry" })));
  await page.locator(".pose-spin").waitFor({ state: "attached" });
  const turn = await frames("turn");
  check(turn.some(r => r.back === "visible" && r.face === "hidden") && turn.some(r => r.face === "visible" && r.back === "hidden"), "转身有正面和背面，脸不会倒转到后脑勺");
  check(turn.every(r => r.actor === "none"), "转身不旋转整张猫图");
  await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__random = Math.random; Math.random = () => .1; });
  await page.locator(".lele-edge-actor").hover({ position: { x: 29, y: 20 }, force: true }); await page.mouse.move(1, 1); await page.waitForTimeout(1600);
  await page.evaluate(() => { Math.random = window.__random; });
  await page.getByRole("button", { name: "选择模型", exact: true }).click(); await page.locator(".pose-leap").waitFor({ state: "attached" });
  const leap = await frames("leap");
  check(leap.every(r => r.clip === "visible" && r.z === "30"), "起跳全过程保留完整身体和同一层级");
  await anchor.evaluate(n => n.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getTiming().iterations)).forEach(a => a.finish())); await page.waitForTimeout(100);
  const landing = await anchor.evaluate(n => { const p = n.querySelector(".cat-hindlegs").getBoundingClientRect(), m = document.querySelector("[data-promptbar-menu]").getBoundingClientRect(); return { bottom: p.bottom, top: m.top, clip: getComputedStyle(n.querySelector(".lele-edge-viewport")).overflowX, z: getComputedStyle(n).zIndex }; });
  check(Math.abs(landing.bottom - landing.top) < 2 && landing.clip === "visible" && landing.z === "30", "菜单落地脚掌贴边，结束帧不突然切半身或换层级");
  await page.getByRole("button", { name: "推理强度", exact: true }).click(); await page.locator(".pose-transfer.is-falling").waitFor({ state: "attached" });
  const transfer = await frames("transfer-fall");
  check(transfer.every(r => r.clip === "visible"), "从模型菜单落向推理菜单时身体完整可见");
  await anchor.evaluate(n => n.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getTiming().iterations)).forEach(a => a.finish())); await page.waitForTimeout(100);
  await page.keyboard.press("Escape"); await page.locator(".pose-drop").waitFor({ state: "attached" });
  await frames("drop"); check(await page.locator(".lele-exclaim").count() === 0, "掉落通过四肢和身体表现，不使用感叹号代替动作");
  await anchor.evaluate(n => n.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getTiming().iterations)).forEach(a => a.finish())); await page.waitForTimeout(100);
  const settled = await anchor.evaluate(n => ({ foot: Math.max(n.querySelector(".cat-hindlegs").getBoundingClientRect().bottom, n.querySelector(".cat-paws").getBoundingClientRect().bottom), edge: n.parentElement.getBoundingClientRect().top }));
  check(Math.abs(settled.foot - settled.edge) < 2, "落地恢复后所有脚掌落在输入框边上，不穿入框内");
  for (const label of ["选择模型", "推理强度", "选择模型", "推理强度"]) { await page.getByRole("button", { name: label, exact: true }).click(); await page.waitForTimeout(120); }
  await page.waitForTimeout(1500);
  check(await anchor.evaluate(n => Math.abs(n.querySelector(".cat-hindlegs").getBoundingClientRect().bottom - document.querySelector("[data-promptbar-menu]").getBoundingClientRect().top) < 2), "快速切换打断动作仍准确落到最后一个菜单");
  await page.screenshot({ path: OUT + "/final-menu.png" });
  await page.emulateMedia({ reducedMotion: "reduce" }); check(await anchor.evaluate(n => n.getAnimations({ subtree: true }).length === 0), "减少动态模式关闭身体和位移动画");
  check(errors.length === 0, "无浏览器异常"); console.log(`肢体动作与落点专项 ${checks} 项通过`);
} catch (e) { await page.screenshot({ path: OUT + "/failure.png" }).catch(() => {}); throw e; }
finally { await browser.close(); await pool.end(); }
