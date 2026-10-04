// 真实 ComposerCompanion 侧躺衔接回归：只加载本地预览，不读数据库或调用上游。
// BASE=http://127.0.0.1:5173 PLAYWRIGHT_EXECUTABLE_PATH=<Chrome> node tests/lele-drape-transitions-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.BASE || "http://127.0.0.1:5173");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "仅允许本地组件预览");
assert.ok(["http:", "https:"].includes(base.protocol) && !base.username && !base.password, "BASE 不能包含凭据");
const out = path.resolve(process.env.EVIDENCE_DIR || path.join(os.tmpdir(), "ooapi-lele-drape-transitions"));
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(executablePath ? { executablePath } : {}) });
const report = { fixture: "/tests/lele-motion.html", checks: [], stories: [], runtimeErrors: [] };
let page;
const check = (condition, label, details = {}) => {
  report.checks.push({ passed: Boolean(condition), label, ...details });
  assert.ok(condition, label);
  console.log("PASS", label);
};
const anchor = () => page.locator(".live .lele-perch-anchor");
const waitPhase = phase => page.waitForFunction(p => document.querySelector(".live .lele-perch-anchor")?.dataset.phase === p, phase, { timeout: 4000 });
const snapshot = () => anchor().evaluate(n => {
  const actor = n.querySelector(".lele-edge-actor");
  const motion = actor.getAnimations().find(a => a instanceof CSSAnimation && a.effect.target === actor);
  return { pose: n.dataset.pose, phase: n.dataset.phase, motion: motion?.animationName, startTime: motion?.startTime, time: Number(motion?.currentTime || 0), now: performance.now(), speech: Boolean(document.querySelector(".live .lele-speech")) };
});
async function newStory(name, drape = true) {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", error => report.runtimeErrors.push({ story: name, message: error.message }));
  await page.clock.install();
  await page.goto(new URL("/tests/lele-motion.html", base).href, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.mouse.move(2, 2);
  await page.locator(".live .bui-composer").evaluate(root => {
    window.__drapeTrace = [];
    const record = (kind, name) => {
      const n = root.querySelector(".lele-perch-anchor");
      window.__drapeTrace.push({ kind, name, pose: n.dataset.pose, phase: n.dataset.phase, time: performance.now() });
    };
    new MutationObserver(() => record("phase")).observe(root.querySelector(".lele-perch-anchor"), { attributes: true, attributeFilter: ["data-pose", "data-phase"] });
    for (const kind of ["animationstart", "animationend"]) root.addEventListener(kind, e => {
      if (e.target.classList.contains("lele-edge-actor")) record(kind, e.animationName);
    });
  });
  if (!drape) return;
  // 只控制调度器的随机选择：上沿、侧躺、居中、下一次间隔；不修改 React/DOM 状态。
  await page.evaluate(() => { const picks = [0, .82, .5, .5]; Math.random = () => picks.length ? picks.shift() : 0; });
  await page.clock.fastForward(35000);
  await page.clock.runFor(360);
  await page.waitForFunction(() => { const n = document.querySelector(".live .lele-perch-anchor"); return n?.dataset.pose === "drape" && n.dataset.phase === "enter"; }, null, { timeout: 2000 });
  check((await snapshot()).motion === "lele-drape-arrive", name + " 由真实随机调度进入侧躺");
}
async function saveStory(name) {
  report.stories.push({ name, trace: await page.evaluate(() => window.__drapeTrace), final: await snapshot() });
}
async function verifyCompletion(name, expectedPose) {
  const trace = await page.evaluate(() => window.__drapeTrace);
  const end = trace.findLast(e => e.kind === "animationend" && ["lele-drape-hop-hide", "lele-drape-stretch-hop"].includes(e.name));
  const next = end && trace.find(e => e.kind === "phase" && e.time >= end.time && (expectedPose === "asking" ? e.pose !== "drape" && e.phase === "enter" : e.pose === "drape" && e.phase === "hidden"));
  check(Boolean(end && next && next.time - end.time < 120), name + " 在真实动画结束后直接续接，没有额外等待空窗", { gapMs: next && end ? next.time - end.time : null });
  await saveStory(name);
}
async function pendingButton() { await page.getByRole("button", { name: /^询\s*问$/, exact: true }).click(); }
async function waitAsk() { await page.locator(".live .lele-speech.is-pending").waitFor({ state: "attached", timeout: 4500 }); }
const askTime = () => page.evaluate(() => window.__drapeTrace.findLast(e => e.kind === "phase" && e.pose !== "drape" && e.phase === "enter")?.time);

try {
  await fs.mkdir(out, { recursive: true });
  for (const interrupt of ["send", "menu", "pending"]) {
    const name = "入场中 " + interrupt;
    await newStory(name);
    await page.waitForTimeout(180);
    const before = await snapshot(), body = await anchor().locator(".lele-edge-actor").elementHandle();
    if (interrupt === "send") await page.getByRole("button", { name: "send", exact: true }).click();
    else if (interrupt === "menu") await page.getByRole("button", { name: "切换菜单", exact: true }).click();
    else await pendingButton();
    const after = await snapshot();
    check(after.pose === "drape" && after.phase === "enter" && after.startTime === before.startTime && after.time >= before.time && await body.evaluate(n => n.isConnected), name + " 保留原入场和身体身份");
    if (interrupt === "pending") check(!after.speech, "侧躺尚未收身时不提前展开审批气泡");
    await waitPhase("startle");
    const trace = await page.evaluate(() => window.__drapeTrace);
    check(trace.some(e => e.kind === "animationend" && e.name === "lele-drape-arrive") && trace.filter(e => e.kind === "animationstart" && e.name === "lele-drape-arrive").length === 1, name + " 等真实入场结束才惊醒，且入场没有重播");
    if (interrupt === "pending") await waitAsk();
    else await waitPhase("hidden");
    if (interrupt === "menu") check(await page.locator(".live [data-promptbar-menu]").count() === 1 && await anchor().getAttribute("data-phase") === "hidden", "侧躺收身避开菜单后保持隐藏");
    await verifyCompletion(name, interrupt === "pending" ? "asking" : "hidden");
  }

  await newStory("惊醒中审批");
  await waitPhase("rest");
  await page.getByRole("button", { name: "send", exact: true }).click();
  await waitPhase("startle");
  await page.waitForTimeout(550);
  const beforeStartle = await snapshot(), startleBody = await anchor().locator(".lele-edge-actor").elementHandle();
  await pendingButton();
  const afterStartle = await snapshot();
  check(afterStartle.phase === "startle" && afterStartle.startTime === beforeStartle.startTime && afterStartle.time >= beforeStartle.time && await startleBody.evaluate(n => n.isConnected), "惊醒中审批沿用剩余动作，不重播或倒回趴姿");
  await waitAsk();
  const startleRemaining = (await askTime()) - afterStartle.now;
  check(startleRemaining < 1400 - afterStartle.time + 220, "惊醒中审批按剩余时长续接，无重新整段等待", { waitMs: startleRemaining, remainingMs: 1400 - afterStartle.time });
  await verifyCompletion("惊醒中审批", "asking");

  await newStory("伸展中审批");
  await waitPhase("rest");
  // 只推进真实睡醒定时器，角色动画仍由浏览器正常播放。
  await page.clock.fastForward(28000);
  await waitPhase("stretch");
  await page.waitForTimeout(850);
  const beforeStretch = await snapshot(), stretchBody = await anchor().locator(".lele-edge-actor").elementHandle();
  await pendingButton();
  const afterStretch = await snapshot();
  check(afterStretch.phase === "stretch" && afterStretch.startTime === beforeStretch.startTime && afterStretch.time >= beforeStretch.time && await stretchBody.evaluate(n => n.isConnected), "伸展中审批保持当前伸展，不倒回惊醒");
  await waitAsk();
  const stretchRemaining = (await askTime()) - afterStretch.now;
  check(stretchRemaining < 2400 - afterStretch.time + 220, "伸展中审批完成余下退场即展开询问", { waitMs: stretchRemaining, remainingMs: 2400 - afterStretch.time });
  check(!(await page.evaluate(() => window.__drapeTrace)).some(e => e.kind === "animationstart" && e.name === "lele-drape-hop-hide"), "伸展衔接审批没有插入第二段惊醒");
  await verifyCompletion("伸展中审批", "asking");

  await newStory("普通 hover 快划", false);
  const initialPose = await anchor().getAttribute("data-pose"), ordinaryBody = await anchor().locator(".lele-edge-actor").elementHandle();
  const point = await anchor().evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x + 29, y: r.y - 16 }; });
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(45);
  await page.mouse.move(point.x + 90, point.y);
  await page.waitForTimeout(330);
  check(await anchor().getAttribute("data-hovered") === "false" && await anchor().getAttribute("data-pose") === initialPose && await ordinaryBody.evaluate(n => n.isConnected), "普通 hover 快划不换姿、不重挂载");
  await saveStory("普通 hover 快划");
  check(report.runtimeErrors.length === 0, "所有真实侧躺衔接无页面运行异常");
  await fs.writeFile(path.join(out, "transitions.json"), JSON.stringify(report, null, 2));
  console.log(`侧躺实际交互 ${report.checks.length} 项通过；报告 ${path.join(out, "transitions.json")}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
    await saveStory("failure").catch(() => {});
  }
  await fs.writeFile(path.join(out, "transitions.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally { await browser.close(); }
