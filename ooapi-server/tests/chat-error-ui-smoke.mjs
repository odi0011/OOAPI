// 只允许隔离库；覆盖历史读取、SSE 终态和 HTTP 拒绝三个实际页面入口。
import "dotenv/config";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import { appendMessage } from "../src/services/harness/sessions.js";

const BASE = process.env.BASE || "http://127.0.0.1:4285";
const [[db]] = await pool.query("SELECT DATABASE() name");
assert.equal(db.name, "ooapi_gemini_gate");
assert.equal(new URL(BASE).hostname, "127.0.0.1");
const [[admin]] = await pool.query("SELECT * FROM users WHERE role >= 1000 AND status = 1 LIMIT 1");
const [[key]] = await pool.query("SELECT id FROM tokens WHERE user_id = ? AND status = 1 ORDER BY id LIMIT 1", [admin.id]);
const token = signToken(admin), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const api = async (path, body) => {
  const res = await fetch(`${BASE}/api/chat${path}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const json = await res.json();
  assert(res.ok && json.success !== false, json.message);
  return json.data;
};
const meta = await api(`/meta?keyId=${key.id}`);
assert(meta.models.length, "fixture must provide a chat model");
const model = meta.models[0].id, sessions = [];
const newSession = async () => {
  const session = await api("/sessions", { model, settings: { tools: [] } });
  sessions.push(session.id);
  return session;
};
const diagnostics = {
  code: "CHANNEL_BAD_REQUEST", http_status: 400, upstream_error_code: "INVALID_ARGUMENT",
  upstream_response: { error: { code: 400, status: "INVALID_ARGUMENT", message: 'Unknown field. <img src=x onerror="window.fixtureUnsafe=true"> [link](javascript:alert(1))' } },
};
let browser;
try {
  const history = await newSession();
  const append = (data) => appendMessage({ sessionId: history.id, userId: admin.id, role: "assistant", model, status: "error", elapsedMs: 444, ...data });
  await append({ parts: [{ id: "zero", type: "error", message: "上游不接受当前工具参数", ...diagnostics }] });
  await append({ parts: [{ id: "paid", type: "error", message: "部分输出后中断", ...diagnostics }], cost: 0.002, promptTokens: 10, completionTokens: 5 });
  await append({ parts: [{ id: "free", type: "text", text: "免费模型有实际用量" }], promptTokens: 3, completionTokens: 2, status: "success" });
  await append({ parts: [{ id: "legacy", type: "error", message: "历史记录只包含失败原因" }] });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(({ token, keyId }) => {
    localStorage.setItem("ooapi-token", token);
    localStorage.setItem("oo.chat.keyId", String(keyId));
    localStorage.setItem("ooapi-color-mode", "light");
  }, { token, keyId: key.id });
  const row = (text) => page.locator(".ui-msg-ai").filter({ hasText: text });
  const checkPlain = async (message) => {
    const item = row(message);
    await item.locator(".ui-msg-error-reason").waitFor();
    assert.equal(await item.locator(".ant-alert").count(), 0);
    assert.equal(await item.locator(".ui-msg-error-response img, .ui-msg-error-response a, .ui-msg-error-response script").count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.fixtureUnsafe)), false);
    const style = await item.locator(".ui-msg-error").evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
    assert.equal(style.background, "rgba(0, 0, 0, 0)");
    assert.equal(style.border, "0px");
    return item;
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/chat?s=${history.id}`, { waitUntil: "networkidle" });
    const zero = await checkPlain("上游不接受当前工具参数");
    assert.equal(await zero.locator(".ui-msg-cost, .ui-msg-token-stat").count(), 0);
    assert((await zero.locator(".ui-msg-error-response").innerText()).includes('"status": "INVALID_ARGUMENT"'));
    assert.equal(await zero.getByRole("button", { name: "重试本轮" }).count(), 1);
    const paid = await checkPlain("部分输出后中断");
    assert.equal(await paid.locator(".ui-msg-cost").count(), 1);
    assert.equal(await paid.locator(".ui-msg-token-stat").innerText(), "15 Tokens");
    const free = row("免费模型有实际用量");
    assert.equal(await free.locator(".ui-msg-cost").count(), 0);
    assert.equal(await free.locator(".ui-msg-token-stat").innerText(), "5 Tokens");
    const legacy = await checkPlain("历史记录只包含失败原因");
    assert.equal(await legacy.locator(".ui-msg-error-response").count(), 0);
    assert(await zero.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "error must wrap on mobile");
    await page.screenshot({ path: `/var/tmp/ooapi-chat-error-history-${width}.png`, fullPage: true });

    for (const mode of ["sse-persisted", "sse-bare", "http-rejected"]) {
      const session = await newSession(), message = `${mode} 失败原因`;
      await page.route("**/api/chat/run", async (route) => {
        if (mode === "http-rejected") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ success: false, message, data: { accepted: false, ...diagnostics } }) });
        const event = mode === "sse-bare" ? { type: "error", message, ...diagnostics } : {
          type: "error", message: { role: "assistant", seq: 2, status: "error", cost: 0, tokens: { prompt: 0, completion: 0, cache: 0 }, elapsedMs: 444, parts: [{ id: "failure", type: "error", message, ...diagnostics }] },
        };
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: [{ type: "start" }, event].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") });
      });
      await page.goto(`${BASE}/chat?s=${session.id}`, { waitUntil: "networkidle" });
      await page.getByRole("textbox", { name: "消息内容" }).fill("检查错误正文");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const item = await checkPlain(message);
      assert((await item.locator(".ui-msg-error-meta").innerText()).includes("HTTP 400"));
      assert((await item.locator(".ui-msg-error-response").innerText()).includes("Unknown field"));
      if (mode === "sse-bare") {
        assert.equal(await item.locator(".ui-msg-cost").count(), 1, "unconfirmed cost remains visible");
        assert.equal(await item.locator(".ui-msg-token-stat").innerText(), "用量待确认");
      } else assert.equal(await item.locator(".ui-msg-cost, .ui-msg-token-stat").count(), 0, "known zero usage is hidden");
      await item.getByRole("button", { name: "重试本轮" }).click();
      await page.getByText("重试这一轮？", { exact: true }).waitFor();
      await page.getByRole("button", { name: /^取\s*消$/ }).last().click();
      await page.unroute("**/api/chat/run");
    }
    console.log(`PASS ${width}px: historical/SSE/HTTP errors, readable response, zero/nonzero/unknown usage, retry and safe text`);
  }
  assert.deepEqual(errors, []);
} finally {
  if (sessions.length) await api("/sessions/batch", { ids: sessions, action: "archive" });
  await browser?.close();
  await pool.end();
}
