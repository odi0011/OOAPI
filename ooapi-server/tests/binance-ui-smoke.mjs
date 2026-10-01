// 只在隔离候选库运行：真实普通用户、HTTP 公网来源及浏览器交易/配置流程。
// 模拟盘使用受控行情，交易引擎仍真实写独立数据库；禁止向生产库或实盘账户测试。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { chromium } from "playwright";
import { pool, JWT_SECRET } from "../src/db.js";
import { TOOLS } from "../src/services/harness/tools.js";

const BASE = process.env.BASE || "http://127.0.0.1:3999";
const origin = new URL(BASE);
const BROWSER_BASE = `http://ooapi-review.invalid:${origin.port || 80}`;
const screenshots = process.env.BINANCE_REVIEW_SCREENSHOTS || "/var/tmp/ooapi-binance-review";
const [[database]] = await pool.query("SELECT DATABASE() AS name");
assert.match(database.name, /^ooapi_.*gate$/, "Binance review requires an isolated gate database");
assert.equal(origin.hostname, "127.0.0.1", "Candidate server must bind to loopback");
await fs.mkdir(screenshots, { recursive: true });
const suffix = crypto.randomBytes(5).toString("hex");
const password = crypto.randomBytes(24).toString("hex");
const hash = await bcrypt.hash(password, 10);
const users = [];
for (let index = 0; index < 2; index++) {
  const [result] = await pool.query("INSERT INTO users (username, password, role, status, quota, created_time) VALUES (?, ?, 1, 1, 0, ?)", [`binance_review_${suffix}_${index}`, hash, Date.now()]);
  users.push({ id: result.insertId, role: 1, tv: 0 });
}
const token = jwt.sign(users[0], JWT_SECRET, { expiresIn: "30m" });
const secondToken = jwt.sign(users[1], JWT_SECRET, { expiresIn: "30m" });
const api = async (endpoint, { method = "GET", body, authorization = token } = {}) => {
  const response = await fetch(`${BASE}/api/binance${endpoint}`, { method, headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json();
  return { status: response.status, data: json.data, message: json.message };
};
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--host-resolver-rules=MAP ooapi-review.invalid 127.0.0.1"], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((value) => localStorage.setItem("ooapi-token", value), token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => { errors.push(`Native dialog: ${dialog.type()}`); dialog.dismiss(); });
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };
const waitForData = async (predicate) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await predicate()) return;
    await page.waitForTimeout(200);
  }
  throw new Error("Candidate data did not reach the expected state");
};
const tab = async (name) => { await page.getByRole("tab", { name, exact: true }).first().click(); };
const modal = () => page.getByRole("dialog");
try {
  check((await api("/accounts", { authorization: "invalid-test-only" })).status === 401, "Unauthenticated requests must fail");
  await page.goto(`${BROWSER_BASE}/od-binance?view=settings`, { waitUntil: "networkidle" });
  check(await page.evaluate(() => !window.isSecureContext && typeof crypto.randomUUID !== "function"), "Review must reproduce public HTTP crypto restrictions");
  check(await page.locator(".oo-sider").getByText("OD Binance", { exact: true }).count() > 0, "Ordinary user needs navigation entry");
  check(await page.getByRole("button", { name: "添加账户", exact: true }).count() === 1, "Empty state must offer account creation");
  const names = [`审查账户 A ${suffix}`, `审查账户 B ${suffix}`];
  for (const name of names) {
    await page.getByRole("button", { name: "添加账户", exact: true }).click();
    await modal().getByLabel("名称", { exact: true }).fill(name);
    await modal().getByRole("button", { name: /^保\s*存$/ }).click();
    await modal().waitFor({ state: "hidden" });
    await page.getByRole("cell", { name, exact: true }).waitFor();
  }
  const accounts = (await api("/accounts")).data;
  check(accounts.length === 2 && accounts.every((row) => row.environment === "demo"), "Only owned demo accounts may exist");
  check((await api("/accounts", { authorization: secondToken })).data.length === 0, "Another user must not see these accounts");
  check((await api(`/risk/${accounts[0].id}`, { authorization: secondToken })).status === 404, "Another user cannot read risk settings by ID");
  await page.locator(".oo-binance-account-select .ant-select-selector").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: names[0] }).click();
  await tab("仓位");
  await page.getByRole("button", { name: "市价下单", exact: true }).click();
  await modal().getByLabel("数量", { exact: true }).fill("1");
  await modal().getByRole("button", { name: /^确\s*认$/ }).click();
  await modal().waitFor({ state: "hidden" });
  await waitForData(async () => (await api(`/positions?account_id=${accounts.find((row) => row.name === names[0]).id}`)).data.length === 1);
  check(await page.getByRole("cell", { name: "BTCUSDT", exact: true }).count() === 1, "Paper order needs a visible position on public HTTP");
  await page.getByRole("button", { name: /^保\s*护$/ }).click();
  await modal().getByLabel("止损价", { exact: true }).fill("90");
  await modal().getByLabel("止盈价", { exact: true }).fill("110");
  await modal().getByRole("button", { name: /^确\s*认$/ }).click();
  await modal().waitFor({ state: "hidden" });
  await page.getByText("90.00 / 110.00", { exact: true }).waitFor();
  check(true, "Protection must persist and render");
  await page.getByRole("button", { name: /^平\s*仓$/ }).click();
  await modal().getByLabel("平仓比例 %", { exact: true }).fill("50");
  await modal().getByRole("button", { name: "确认平仓", exact: true }).click();
  await modal().waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: "0.5", exact: true }).waitFor();
  check(true, "Partial close must refresh quantity");
  await tab("策略");
  await page.getByRole("button", { name: "新建策略", exact: true }).click();
  await modal().getByLabel("名称", { exact: true }).fill(`审查策略 ${suffix}`);
  await modal().getByLabel("目标仓位数量", { exact: true }).fill("1");
  await modal().getByLabel("按信号自动下单").check();
  await modal().getByRole("button", { name: /^保\s*存$/ }).click();
  await modal().waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^启\s*动$/ }).click();
  await modal().getByText("启动自动下单策略？", { exact: true }).last().waitFor();
  await modal().getByRole("button", { name: /^取\s*消$/ }).click();
  check((await api("/strategies")).data[0].status === "paused", "Canceling confirmation cannot start automation");
  await page.getByRole("button", { name: /^启\s*动$/ }).click();
  await modal().getByRole("button", { name: "确认启动", exact: true }).click();
  await page.getByRole("button", { name: /^暂\s*停$/ }).waitFor();
  await page.getByRole("button", { name: /^暂\s*停$/ }).click();
  await page.getByRole("button", { name: /^启\s*动$/ }).waitFor();
  await tab("回测");
  await page.getByLabel("策略", { exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: `审查策略 ${suffix}` }).click();
  await page.getByRole("button", { name: "运行回测", exact: true }).click();
  await page.getByText("回测权益曲线", { exact: true }).waitFor({ timeout: 30000 });
  check((await api("/backtests")).data.length === 1, "Backtest must persist to the real isolated engine");
  await page.screenshot({ path: path.join(screenshots, "desktop-backtest.png"), fullPage: true });
  await tab("订单");
  await page.getByRole("cell", { name: "已成交", exact: true }).first().waitFor();
  check((await api("/orders")).data.length === 2, "Order ledger must include opening and partial close");
  check((await api("/orders", { authorization: secondToken })).data.length === 0, "Order ledger ownership cannot be bypassed");
  process.env.OD_BINANCE_URL = process.env.BINANCE_REVIEW_ENGINE_URL || "http://127.0.0.1:8002";
  const analysisAccount = accounts.find((row) => row.name === names[0]);
  const analysis = await TOOLS.binance.run({ action: "analysis", account_id: analysisAccount.id }, { user: users[0] });
  check(analysis.ok && JSON.parse(analysis.output).positions[0]?.quantity === 0.5, "Agent tool must read the real user's persisted position");
  check(!(await TOOLS.binance.run({ action: "analysis", account_id: analysisAccount.id }, { user: users[1] })).ok, "Agent tool cannot read another user's account");
  await tab("配置");
  await tab("风控");
  await page.getByLabel("单笔金额 · USDT", { exact: true }).fill("750");
  await page.locator(".oo-binance .oo-panel-head button.ant-btn-primary").click();
  const ownerAccount = accounts.find((row) => row.name === names[0]);
  await waitForData(async () => Number((await api(`/risk/${ownerAccount.id}`)).data.max_order_notional) === 750);
  check(true, "Risk save needs persistence");
  await tab("连接");
  // 交易引擎的真实 451 处理另由 Python 回归验证；这里控制错误返回，检查用户能看到原因。
  await page.route("**/api/binance/platform/network", async (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ success: true, data: {
      live: { connected: false, error: "币安不接受当前服务器地区的请求（HTTP 451）" },
      testnet: { connected: false, error: "币安不接受当前服务器地区的请求（HTTP 451）" },
    } }),
  }));
  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await page.getByText("币安不接受当前服务器地区的请求（HTTP 451）", { exact: true }).first().waitFor();
  check(true, "Connection failure must retain a visible HTTP reason");
  await page.screenshot({ path: path.join(screenshots, "desktop-connection-error.png"), fullPage: true });
  await page.unroute("**/api/binance/platform/network");
  await page.getByLabel("实盘交易", { exact: true }).click();
  await page.locator(".oo-binance .oo-panel-head button.ant-btn-primary").click();
  await modal().getByText("启用本用户的实盘交易？", { exact: true }).last().waitFor();
  await modal().getByRole("button", { name: /^取\s*消$/ }).click();
  check((await api("/platform")).data.allow_live_trading === false, "Canceling live confirmation must preserve disabled state");
  await tab("总览");
  check(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('14px "ZCOOL KuaiLe"'); }), "Local Chinese font must load");
  await page.screenshot({ path: path.join(screenshots, "desktop-overview.png"), fullPage: true });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => localStorage.setItem("ooapi-theme", value), mode);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    check((await page.locator(".oo-binance-account-select .ant-select-selection-item").textContent()) === names[0], `${mode} reload must preserve the selected account`);
    check((await api(`/positions?account_id=${ownerAccount.id}`)).data[0]?.quantity === 0.5, `${mode} reload must preserve the traded position`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${mode} mobile document must not overflow`);
    await page.screenshot({ path: path.join(screenshots, `mobile-${mode}.png`), fullPage: true });
    await tab("仓位");
    await page.getByRole("button", { name: "市价下单", exact: true }).click();
    await modal().waitFor({ state: "visible" });
    check(await modal().isVisible(), `${mode} mobile order form must open`);
    await modal().getByLabel("数量", { exact: true }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(screenshots, `mobile-${mode}-order.png`), fullPage: true, animations: "disabled" });
    const dialogBox = await modal().boundingBox();
    check(dialogBox && dialogBox.width > 300 && dialogBox.height > 100 && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 391 && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 845, `${mode} mobile order dialog must fit in the viewport`);
    await modal().getByRole("button", { name: /^取\s*消$/ }).click();
    await tab("总览");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Agent 分析", exact: true }).click();
  await page.waitForURL(/\/chat\?binance_account=/);
  check((await page.locator("textarea").first().inputValue()).includes("binance 工具"), "Agent handoff must preserve the actual account prompt");
  check(errors.length === 0, `Browser runtime errors: ${errors.join("; ")}`);
  console.log(`BINANCE_UI_PASS: ${checks} checks, ordinary-user CRUD/order/protection/backtest/isolation, insecure HTTP and mobile themes`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failed-flow.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await pool.end();
}
