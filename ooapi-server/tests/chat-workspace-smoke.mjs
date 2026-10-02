// 只能在独立候选库运行：审批与布局用可控上游，绝不向生产插入测试用户。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE = process.env.BASE || "http://127.0.0.1:4115";
const [[db]] = await pool.query("SELECT DATABASE() name");
assert.equal(db.name, "ooapi_chat_gate");
assert.equal(new URL(BASE).hostname, "127.0.0.1");
const [[admin]] = await pool.query("SELECT * FROM users WHERE role>=100 LIMIT 1");
const [[key]] = await pool.query("SELECT id FROM tokens WHERE user_id=? AND group_name=? LIMIT 1", [admin.id, "测试"]);
const token = signToken(admin);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path, body, method = body ? "POST" : "GET", auth = token) {
  const r = await fetch(BASE + "/api/chat" + path, { method, headers: { ...headers, authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, ...await r.json() };
}
let browser, checks = 0;
const check = (value, text) => { assert.ok(value, text); checks++; console.log("ok", text); };
try {
  const session = (await api("/sessions", { model: "deepseek-flash", settings: { tools: ["account"], permissionMode: "ask", maxSteps: 1 } })).data;
  const events = [];
  const stream = (async () => {
    const r = await fetch(BASE + "/api/chat/run", { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, keyId: key.id, text: "CHAT_WORKSPACE_FIXTURE", model: "deepseek-flash" }) });
    check(r.ok, "对话接受请求");
    const reader = r.body.getReader(), decoder = new TextDecoder();let buffer = "";
    for (;;) { const { done, value } = await reader.read();if (done) break;buffer += decoder.decode(value, { stream: true });let end;while ((end = buffer.indexOf("\n\n")) >= 0) { const chunk = buffer.slice(0, end);buffer = buffer.slice(end + 2);for (const line of chunk.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch {} } } }
  })();
  for (let i = 0; i < 100 && !events.some(e => e.part?.type === "approval"); i++) await new Promise(r => setTimeout(r, 100));
  const approval = events.find(e => e.part?.type === "approval")?.part;
  check(approval?.status === "pending", "工具执行前等待审批");
  check(!events.some(e => e.patch?.output?.includes("余额")), "审批前没有取得账号数据");
  check((await api(`/sessions/${session.id}/approvals/${approval.id}`, { decision: "approved" }, "POST", signToken({ id: 999999, role: 1, token_version: 0 }))).status >= 400, "其他身份不能审批");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(t => localStorage.setItem("ooapi-token", t), token);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE + "/chat?s=" + session.id, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "仅允许这次", exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "仅允许这次", exact: true }).click();
  await stream;
  check(events.some(e => e.type === "done"), "刷新后审批恢复，完成工具与最终回答");
  check((await api(`/sessions/${session.id}/approvals/${approval.id}`, { decision: "approved" })).status === 409, "重复审批被拒绝");
  await page.locator(".message-chart").waitFor();
  check(await page.locator(".md-table th").count() >= 2, "表格按统一样式渲染");
  check(await page.locator(".oo-code-lights").count() >= 1, "代码使用用户提供的三灯卡片");
  check(await page.locator(".agent-trajectory-list").count() === 0, "已完成轨迹默认折叠");
  await page.locator(".agent-trajectory-toggle").click();
  check(await page.locator(".agent-trajectory-list li").count() >= 1, "工具轨迹按单列展示");
  await fs.mkdir("/var/tmp/ooapi-chat-evidence", { recursive: true });
  await page.screenshot({ animations: "disabled", path: "/var/tmp/ooapi-chat-evidence/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "会话设定", exact: true }).click();
  await page.waitForTimeout(400);
  check(await page.getByText("每次执行前询问", { exact: true }).isVisible(), "会话设置提供审批模式");
  await page.screenshot({ animations: "disabled", path: "/var/tmp/ooapi-chat-evidence/settings.png", fullPage: true });
  await page.locator(".ant-drawer-close").click();
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "手机页面没有横向溢出");
  const sendBounds = await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox();
  check(sendBounds && sendBounds.x >= 0 && sendBounds.x + sendBounds.width <= 390, "手机发送按钮不会被密钥或模型名称挤出");
  check(await page.locator(".chat-mascot .cat-eyes").first().evaluate(el => getComputedStyle(el).animationName === "none"), "减少动画模式停用猫咪动画");
  await page.screenshot({ animations: "disabled", path: "/var/tmp/ooapi-chat-evidence/mobile.png", fullPage: true });
  check(errors.length === 0, "对话与审批无运行期异常");
  const stored = (await api(`/sessions/${session.id}`)).data;
  check(stored.messages.some(m => m.parts?.some(p => p.type === "approval" && p.status === "approved")), "审批轨迹已持久化");
  console.log(`聊天工作台 HTTP / 浏览器回归 ${checks} 项通过`);
} finally { await browser?.close(); await pool.end(); }
