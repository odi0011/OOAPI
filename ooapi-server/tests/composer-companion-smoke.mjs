// 独立候选库 + 受控上游 LELE_INQUIRY_FIXTURE；真实审批、布局与鼠标/键盘交互。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE = process.env.BASE || "http://127.0.0.1:4115", OUT = "/var/tmp/ooapi-lele-inquiry-evidence";
const [[db]] = await pool.query("SELECT DATABASE() name");
assert.equal(db.name, "ooapi_lele_gate"); assert.equal(new URL(BASE).hostname, "127.0.0.1");
const [[admin]] = await pool.query("SELECT * FROM users WHERE role>=100 AND status=1 ORDER BY role DESC LIMIT 1");
const [[key]] = await pool.query("SELECT id FROM tokens WHERE user_id=? AND group_name=? LIMIT 1", [admin.id, "测试"]);
const token = signToken(admin), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(BASE + "/api/chat" + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json(); assert.ok(r.ok && j.success !== false, path + ": " + j.message); return j.data;
}
const sessions = [], errors = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({ token, key }) => { localStorage.setItem("ooapi-token", token); localStorage.setItem("oo.chat.keyId", key); }, { token, key: String(key.id) });
const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; console.log("PASS", label); };
const geometry = () => page.evaluate(() => {
  const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  return { composer: rect(".bui-composer"), anchor: rect(".lele-perch-anchor"), body: rect(".lele-edge-viewport"), grip: rect(".lele-edge-grip"), bubble: rect(".lele-speech"), tail: rect(".lele-speech-tail"), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
});
async function begin(text) {
  const s = await api("/sessions", { model: "deepseek-flash", settings: { permissionMode: "ask" } }); sessions.push(s.id);
  await page.goto(BASE + "/chat?s=" + s.id, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "消息内容" }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator(".lele-speech.is-pending").waitFor(); await page.waitForTimeout(1700);
  return s;
}
try {
  await fs.mkdir(OUT, { recursive: true });
  const session = await begin("LELE_INQUIRY_FIXTURE");
  const question = await page.locator(".lele-speech-heading h3").innerText();
  await page.screenshot({ path: OUT + "/first-inquiry.png", fullPage: true });
  check((await page.locator(".lele-speech").innerText()).includes("最近 7 天"), "用量询问显示真实时间范围");
  check((await page.locator(".lele-speech").innerText()).includes("按日期 · 按模型"), "用量询问显示统计内容");
  check(!(await page.locator(".lele-speech").innerText()).includes("usage"), "不展示原始 action 值");
  check(await page.locator(".lele-speech .chat-mascot").count() === 0, "气泡共用输入框乐乐，没有第二只猫");
  check(await page.locator(".lele-perch-anchor.is-questioning.at-top .is-asking").count() === 1, "询问状态在上沿切换为专用表情");
  await page.mouse.move(1, 1);
  const first = await page.locator(".lele-perch-anchor").getAttribute("data-pose");
  await page.waitForFunction(p => document.querySelector(".lele-perch-anchor").dataset.pose !== p, first, { timeout: 12000 });
  await page.waitForTimeout(950);
  check(await page.locator(".lele-perch-anchor.at-top").count() === 1, "询问期间自动换姿势仍留在上沿");
  let g = await geometry();
  check(Math.abs(g.tail.x + 22 - g.anchor.x - 29) < 2, "气泡尾尖跟随乐乐头顶锚点");
  check(Math.abs(g.body.bottom - g.composer.y) < 1, "身体裁剪边与输入框上边严密相接");
  check(Math.abs(g.grip.y - g.composer.y + 3) < 1, "爪子实际握住边线，没有悬空间距");
  await page.locator(".lele-speech").hover();
  const frozen = await page.locator(".lele-perch-anchor").getAttribute("data-pose");
  await page.waitForTimeout(10300);
  check(await page.locator(".lele-perch-anchor").getAttribute("data-pose") === frozen, "鼠标进入询问框停止换位");
  await page.getByRole("button", { name: "拒绝", exact: true }).focus(); await page.mouse.move(1, 1);
  await page.waitForTimeout(10300);
  check(await page.locator(".lele-perch-anchor").getAttribute("data-pose") === frozen, "键盘焦点位于按钮时停止换位");
  for (const width of [1440, 768, 390, 320]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await page.evaluate(t => localStorage.setItem("ooapi-color-mode", t), theme);
      await page.reload({ waitUntil: "domcontentloaded" }); await page.locator(".lele-speech").waitFor(); await page.waitForTimeout(1500);
      g = await geometry();
      check(!g.overflow && g.bubble.x >= 0 && g.bubble.right <= width + 1 && g.bubble.y >= 0, `${width}/${theme} 气泡完整位于视口内`);
      check(await page.locator(".lele-speech-content,.lele-operation-fields").evaluateAll(ns => ns.every(n => n.scrollWidth <= n.clientWidth + 1)), `${width}/${theme} 无横向滚动`);
      check(await page.locator(".lele-speech-heading h3").innerText() === question, `${width}/${theme} 刷新文案稳定`);
      await page.screenshot({ path: `${OUT}/pending-${width}-${theme}.png`, fullPage: true });
    }
  }
  await page.route("**/approvals/*", r => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, message: "临时送达失败，请重试" }) }));
  await page.getByRole("button", { name: "仅允许这次", exact: true }).click(); await page.getByRole("alert").filter({ hasText: "临时送达失败" }).waitFor();
  check(await page.locator(".lele-speech.is-pending").count() === 1, "提交失败保留询问和重试按钮");
  await page.unroute("**/approvals/*");
  await page.getByRole("button", { name: "仅允许这次", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor(); await page.waitForTimeout(500);
  check(await page.locator(".lele-speech").count() === 0, "决定后气泡收回并卸载");
  const stored = await api("/sessions/" + session.id), parts = stored.messages.flatMap(m => m.parts || []);
  const completed = parts.find(p => p.type === "tool" && p.tool === "account" && p.status === "done");
  check(Boolean(completed?.presentation?.capsulePhrases.length), "工具完成记录保存独立胶囊文案");
  check(completed.presentation.capsulePhrases.includes(await page.locator('[data-execution-type="tool"] .execution-pill-toggle .execution-pill-label').innerText()), "实际胶囊使用该方法的完成短句");
  await begin("LELE_INQUIRY_FIXTURE LONG_QUERY");
  check(await page.locator(".lele-operation-fields").evaluate(n => n.scrollWidth <= n.clientWidth + 1), "长检索内容在 320px 自然换行");
  await page.screenshot({ path: OUT + "/long-query-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "拒绝", exact: true }).click(); await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  check(await page.locator(".lele-speech.is-pending").count() === 0, "拒绝能继续对话并移除询问");
  await page.emulateMedia({ reducedMotion: "reduce" });
  check(await page.locator(".lele-edge-actor").evaluate(n => getComputedStyle(n).animationName === "none"), "减少动画模式静止显示完整姿态");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.mouse.move(1, 1);
  await page.waitForFunction(() => !document.querySelector(".lele-perch-anchor").classList.contains("at-top"), null, { timeout: 14000 });
  await page.waitForTimeout(1700);
  const edgeGeometry = await page.locator(".lele-perch-anchor").evaluate(n => {
    const c = document.querySelector(".bui-composer").getBoundingClientRect(), b = n.querySelector(".lele-edge-viewport").getBoundingClientRect();
    return { touches: n.classList.contains("at-left") ? Math.abs(b.right - c.left) : n.classList.contains("at-right") ? Math.abs(b.left - c.right) : Math.abs(b.top - c.bottom), opacity: getComputedStyle(n).opacity };
  });
  check(edgeGeometry.touches < 1 && edgeGeometry.opacity === "1", "实际随机换位后身体仍只在边界外，无整只透明度切换");
  await page.screenshot({ path: OUT + "/idle-edge-desktop.png", fullPage: true });
  // 同一份生产 DOM/CSS 的静态姿态与动画分帧检查台，只存在于测试浏览器。
  await page.evaluate(() => {
    const source = document.querySelector(".lele-perch-anchor"), board = document.createElement("section"); board.id = "motion-review";
    board.style.cssText = "position:relative;z-index:9999;background:var(--page);color:var(--ink);display:grid;grid-template-columns:repeat(3,320px);gap:70px 80px;padding:70px;width:max-content";
    const cases = [["top","peek"],["top","wave"],["top","sleep"],["top","paws"],["top","stretch"],["top","curl"],["left","look"],["right","wave"],["bottom","peek"]];
    for (const [edge, pose] of cases) {
      const box = document.createElement("div"); box.className = "motion-case"; box.style.cssText = "position:relative;height:88px;box-sizing:border-box;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;font-size:12px";
      box.textContent = edge + " / " + pose;
      const cat = source.cloneNode(true); cat.className = `lele-perch-anchor at-${edge} pose-${pose} phase-rest`;
      cat.style.cssText = edge === "left" || edge === "right" ? "top:50%" : "left:calc(70% - 29px)";
      cat.querySelector(".chat-mascot").setAttribute("class", "chat-mascot is-idle gesture-" + pose);
      box.append(cat); board.append(box);
    }
    document.body.append(board);
  });
  await page.locator("#motion-review").screenshot({ path: OUT + "/edge-poses.png" });
  const animationKinds = await page.locator("#motion-review .lele-perch-anchor").evaluateAll(ns => ns.slice(0, 3).map(n => {
    n.classList.replace("phase-rest", "phase-enter"); const actor = n.querySelector(".lele-edge-actor"); const name = getComputedStyle(actor).animationName;
    const animation = actor.getAnimations()[0]; if (animation) { animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * .6; }
    return name;
  }));
  check(new Set(animationKinds).size === 3, "探头、招呼、入睡具有各自的出场轨迹");
  await page.locator("#motion-review").screenshot({ path: OUT + "/entry-frames.png" });
  const exitKinds = await page.locator("#motion-review .lele-perch-anchor").evaluateAll(ns => ns.slice(0, 3).map(n => { n.classList.replace("phase-enter", "phase-exit"); return getComputedStyle(n.querySelector(".lele-edge-actor")).animationName; }));
  check(new Set(exitKinds).size === 3, "探头、招呼、入睡具有各自的离场轨迹");
  await page.locator("#motion-review").evaluate(n => n.remove());
  check(errors.length === 0, "全过程没有页面运行异常");
  console.log(`询问气泡专项 ${checks} 项通过`);
} catch (e) {
  await page.screenshot({ path: OUT + "/failure.png", fullPage: true }).catch(() => {});
  console.log("failure-state", await page.locator(".bui-promptbar").innerText().catch(() => "missing composer"));
  throw e;
} finally {
  for (const id of sessions) { try { await api(`/sessions/${id}/stop`, {}, "POST"); } catch {} }
  try { await api("/sessions/batch", { ids: sessions, action: "archive" }); } catch {}
  await browser.close(); await pool.end();
}
