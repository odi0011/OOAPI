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
import { FONT_FAMILIES } from "../../ooapi-web/src/theme/presets.js";

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
let restoreTheme = null, administratorToken = null;
const setThemeMode = async (value) => {
  const response = await fetch(`${BASE}/api/option/`, { method: "PUT", headers: { Authorization: `Bearer ${administratorToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ key: "default_theme", value }) });
  const result = await response.json();
  assert(response.ok && result.success, "Isolated administrator needs to set or restore system theme");
};
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
  const [[administrator]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 AND status = 1 ORDER BY role DESC LIMIT 1");
  assert(administrator, "Isolated theme fixture requires an administrator");
  administratorToken = jwt.sign({ id: administrator.id, role: administrator.role, tv: Number(administrator.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });
  const status = await (await fetch(`${BASE}/api/status`)).json();
  restoreTheme = status.data.default_theme;
  await setThemeMode("system");
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
  // 不由页面预填账号，直接验证系统对话工具面对真实隔离引擎的缺省多账户读取。
  const toolRead = async (action, user = users[0]) => {
    const result = await TOOLS.binance.run({ action }, { user });
    check(result.ok, `Read-only Binance ${action} needs a valid result`);
    return JSON.parse(result.output);
  };
  const listed = await toolRead("accounts");
  check(listed.accounts.length === 2 && listed.accounts.every((row) => accounts.some((owned) => owned.id === row.id)), "Natural account question must list both owned accounts without page selection");
  const currentPositions = await toolRead("positions");
  check(currentPositions.positions.length === 1 && currentPositions.positions[0].quantity === 0.5 && currentPositions.positions[0].accountId === analysisAccount.id, "Natural position question must read persisted owned positions");
  const recentOrders = await toolRead("orders");
  check(recentOrders.orders.length === 2 && recentOrders.orders.every((row) => row.accountId === analysisAccount.id), "Natural recent-order question must read the own persisted ledger");
  const currentStrategies = await toolRead("strategies");
  check(currentStrategies.strategies.length === 1 && currentStrategies.strategies[0].accountId === analysisAccount.id, "Natural strategy question must read the owned paused strategy");
  const overview = await toolRead("overview");
  check(overview.snapshots.length === 2 && overview.snapshots.every((row) => row.status !== "not_recorded") && Number.isFinite(overview.summary.totalEquity), "Multi-account overview must use saved engine snapshots");
  const empty = await toolRead("analysis", users[1]);
  check(empty.status === "no_accounts" && empty.summary === null && empty.positions.length === 0, "New user's empty tool result cannot expose the first user's balance or positions");
  const isolatedName = `隔离账户 ${suffix}`;
  const isolatedAccount = await api("/accounts", { method: "POST", body: { name: isolatedName, environment: "demo" }, authorization: secondToken });
  check(isolatedAccount.status === 200 && isolatedAccount.data.environment === "demo", "Second user's fixture is confined to a demo account");
  const secondListed = await toolRead("accounts", users[1]);
  check(secondListed.accounts.length === 1 && secondListed.accounts[0].name === isolatedName, "Second user must list exactly its own account");
  const stillOwned = await toolRead("accounts");
  check(stillOwned.accounts.length === 2 && !stillOwned.accounts.some((row) => row.id === isolatedAccount.data.id), "First user's directory cannot include the second user's account");
  for (const [action, field] of [["positions", "positions"], ["orders", "orders"], ["strategies", "strategies"]]) {
    const ownEmpty = await toolRead(action, users[1]);
    check(ownEmpty[field].length === 0 && ownEmpty.accounts.length === 1, `Second user's ${action} cannot include first-user resources`);
    const foreign = await TOOLS.binance.run({ action, account_id: isolatedAccount.data.id }, { user: users[0] });
    check(!foreign.ok, `First user cannot read second-user ${action} by explicit ID`);
  }
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
  const fontPreset = FONT_FAMILIES.find((font) => font.key === status.data.appearance.font_family);
  check(!!fontPreset, "Public site status must select a supported font preset");
  await page.waitForFunction((key) => document.documentElement.dataset.fontFamily === key, fontPreset.key);
  const fontState = await page.evaluate(async (preset) => {
    const sample = "币安账户 USDT", shorthand = `14px ${preset.css}`;
    const faces = await document.fonts.load(shorthand, sample);
    await document.fonts.ready;
    return { key: document.documentElement.dataset.fontFamily, css: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim(),
      loaded: document.fonts.check(shorthand, sample), faces: faces.map((face) => ({ family: face.family, status: face.status })),
      localPlayful: performance.getEntriesByType("resource").some((entry) => { const url = new URL(entry.name); return url.origin === location.origin && url.pathname === "/fonts/zcool-kuaile.woff2"; }) };
  }, fontPreset);
  check(fontState.key === fontPreset.key && fontState.css === fontPreset.css && fontState.loaded, "Actual font preset and loaded font must follow the saved site appearance");
  if (fontPreset.key === "playful") check(fontState.faces.some((face) => face.family.includes("ZCOOL KuaiLe") && face.status === "loaded") && fontState.localPlayful, "Playful preset must load the bundled local Chinese font");
  await page.screenshot({ path: path.join(screenshots, "desktop-overview.png"), fullPage: true });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, mode);
    check(await page.evaluate((expected) => document.documentElement.dataset.theme === expected, mode), `${mode} mobile theme must follow the emulated system preference`);
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
  check(await page.getByRole("button", { name: "Agent 分析", exact: true }).count() === 0, "Binance page must use the common system chat rather than a separate analysis entry");
  check(errors.length === 0, `Browser runtime errors: ${errors.join("; ")}`);
  console.log(`BINANCE_UI_PASS: ${checks} checks, ordinary-user CRUD/order/protection/backtest/isolation, insecure HTTP and mobile themes`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failed-flow.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try {
    await browser.close();
    if (restoreTheme !== null && administratorToken) await setThemeMode(restoreTheme);
  } finally { await pool.end(); }
}
