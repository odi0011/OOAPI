// 仅在专用隔离数据库验证设置写入与调用链；拒绝误指向生产。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import { pool, JWT_SECRET } from "../src/db.js";
const base = process.env.BASE || "http://127.0.0.1:4225";
const [[db]] = await pool.query("SELECT DATABASE() AS name");
assert.equal(db.name, "ooapi_agent_gate", "Only the isolated Agent QA database is allowed");
assert.equal(new URL(base).hostname, "127.0.0.1");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role>=1000 LIMIT 1");
assert.ok(admin);
const sign = u => jwt.sign({ id: u.id, role: u.role, tv: Number(u.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });
const adminJwt = sign(admin);
const userName = `agent_qa_${crypto.randomBytes(4).toString("hex")}`;
const [insert] = await pool.query("INSERT INTO users (username,password,display_name,role,status,quota,group_name) VALUES (?,?,?,?,?,?,?)", [userName, "fixture-no-password-login", "Agent 测试用户", 1, 1, 1000000, "测试"]);
const userJwt = sign({ id: insert.insertId, role: 1 });
const key = crypto.randomBytes(24).toString("hex");
await pool.query("INSERT INTO tokens (user_id,name,key_str,status,unlimited_quota,group_name) VALUES (?,?,?,?,?,?)", [insert.insertId, "Agent QA fixture", key, 1, 1, "测试"]);
const api = async (path, auth = adminJwt, method = "GET", body) => {
  const r = await fetch(base + "/api" + path, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};
const call = async (agent, effort = "medium", extra = {}) => {
  const r = await fetch(base + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": agent, ...extra },
    body: JSON.stringify({ model: "deepseek-flash", input: "Describe the purpose of this isolated gateway test.", reasoning: { effort } }) });
  return { status: r.status, body: await r.json() };
};
const original = (await api("/option/")).body.data;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(t => localStorage.setItem("ooapi-token", t), adminJwt);
const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
const dir = process.env.EVIDENCE_DIR || "/var/tmp/ooapi-agent-evidence";
fs.mkdirSync(dir, { recursive: true });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log("ok", label); };
try {
  assert.equal((await api("/option/", adminJwt, "PUT", { gateway_agent_detection: "true", gateway_agent_rules: { version: 1, rules: [] } })).status, 200);
  const rejected = await call("ZCode/3.14.3 runtime/node.js/24");
  check(rejected.status === 400 && rejected.body.error.message.includes("思考强度"), "unsupported reasoning returns a useful 400");
  await page.goto(base + "/admin/settings?tab=gateway", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "添加 Agent 规则", exact: true }).click();
  await page.getByRole("switch", { name: "启用规则 1", exact: true }).click();
  await page.getByRole("combobox", { name: "规则 1 模型", exact: true }).fill("deepseek-flash");
  await page.getByRole("combobox", { name: "规则 1 模型", exact: true }).press("Enter");
  await page.getByRole("combobox", { name: "规则 1 思考强度", exact: true }).press("ArrowDown");
  await page.getByText("不支持的档位使用模型默认", { exact: true }).last().click();
  await page.getByRole("spinbutton", { name: "规则 1 重试", exact: true }).fill("0");
  await page.getByRole("button", { name: "保存网关设置", exact: true }).click();
  await page.getByText("设置已保存", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  check(await page.getByRole("switch", { name: "启用规则 1", exact: true }).getAttribute("aria-checked") === "true", "rule enabled state survives reload");
  const saved = JSON.parse((await api("/option/")).body.data.gateway_agent_rules);
  check(saved.rules[0].reasoning === "unsupported-default" && saved.rules[0].retries === 0, "UI writes actual routing configuration");
  const accepted = await call("ZCode/3.14.3 runtime/node.js/24");
  check(accepted.status === 200 && accepted.body.object === "response", "rule restores request while retaining Responses protocol");
  const conflicting = await call("opencode/1.18.31 runtime/node.js/24", "medium", { "x-ooapi-agent": "zcode" });
  check(conflicting.status === 400, "conflicting declaration cannot activate a rule");
  await call("opencode/1.18.31 runtime/node.js/24", "high");
  await call("codex_cli_rs/0.123.0 (Windows 10.0)", "high");
  const own = (await api("/log/usage?page_size=100", userJwt)).body.data.items;
  const success = own.find(r => r.client_agent?.id === "zcode" && r.status === "success");
  check(success?.reasoning_requested === "medium" && success?.reasoning_selected === "high" && success?.agent_routing?.id === saved.rules[0].id, "request, selected effort and rule recorded together");
  check(success?.device === "Node.js 24", "device runtime recognized");
  check(own.every(r => !("user_agent" in r) && !("upstream_endpoints" in r) && !("detail" in r)), "ordinary user gets no raw UA or upstream internals");
  check((await api("/option/", userJwt, "PUT", { gateway_agent_rules: saved })).status === 403, "ordinary user cannot edit routing");
  check((await api("/option/", adminJwt, "PUT", { gateway_agent_rules: { version: 1, rules: [{ ...saved.rules[0], retries: -1 }] } })).status === 400, "invalid rule is rejected before persistence");
  check((await api("/option/")).body.data.gateway_agent_rules === JSON.stringify(saved), "invalid write keeps the last valid rules");
  const ordinary = await browser.newContext(); await ordinary.addInitScript(t => localStorage.setItem("ooapi-token", t), userJwt);
  const userPage = await ordinary.newPage(); userPage.on("pageerror", e => errors.push(e.message));
  await userPage.goto(base + "/log", { waitUntil: "networkidle" });
  check(await userPage.locator('.oo-client-agent[data-agent="zcode"]').count() > 0, "ordinary usage page displays ZCode badge");
  await userPage.close(); await ordinary.close();
  for (const width of [1440, 390, 320]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1000 });
    await api("/option/", adminJwt, "PUT", { default_theme: theme });
    for (const [path, name] of [["/admin/settings?tab=gateway", "settings"], ["/log", "log"]]) {
      await page.goto(base + path, { waitUntil: "networkidle" });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} ${width} ${theme} fits viewport`);
      if (name === "log") {
        const badge = page.locator('.oo-client-agent[data-agent="zcode"]').first();
        await badge.scrollIntoViewIfNeeded();
        check(await badge.isVisible(), `Agent badge visible ${width} ${theme}`);
        const endpoint = badge.locator("..").locator(".oo-endpoint-row").first();
        const [a, b] = await Promise.all([badge.boundingBox(), endpoint.boundingBox()]);
        check(a && b && a.y + a.height <= b.y + 1, "Agent badge sits above inbound endpoint");
      } else await page.locator(".oo-agent-rule").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${dir}/${name}-${width}-${theme}.png`, fullPage: width === 1440 });
      const broken = await page.locator('.oo-client-agent img').evaluateAll(imgs => imgs.filter(i => !i.complete || !i.naturalWidth).length);
      check(broken === 0, "Agent icons load");
    }
  }
  await page.goto(base + "/admin/settings?tab=gateway", { waitUntil: "networkidle" });
  await page.getByRole("switch", { name: "启用规则 1", exact: true }).click();
  await page.getByRole("button", { name: "保存网关设置", exact: true }).click();
  await page.getByText("设置已保存", { exact: true }).waitFor();
  check((await call("ZCode/3.14.3 runtime/node.js/24")).status === 400, "disabling rule restores strict validation");
  check(errors.length === 0, "no browser runtime errors");
  console.log(`Agent UI and request chain: ${checks} checks passed`);
} finally {
  await api("/option/", adminJwt, "PUT", { gateway_agent_detection: original.gateway_agent_detection, gateway_agent_rules: original.gateway_agent_rules, default_theme: original.default_theme });
  await browser.close(); await pool.end();
}
