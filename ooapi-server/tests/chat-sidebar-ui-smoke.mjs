// 真实浏览器 + 真实候选 HTTP：只操作本脚本创建的普通用户，不拦截 API 或调用模型。
// BASE=http://127.0.0.1:4125 SCREENSHOT_DIR=/var/tmp/chat-sidebar-ui xvfb-run -a node tests/chat-sidebar-ui-smoke.mjs
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import { chromium } from "playwright";
import { pool, JWT_SECRET } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:4125";
const output = process.env.SCREENSHOT_DIR;
let browser, lastPage, checks = 0;
const fixtures = [];
const check = (value, message) => { assert.ok(value, message); checks++; };
const eventually = async (predicate, message) => {
  for (let n = 0; n < 100; n++) {
    if (await predicate()) { check(true, message); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
};
const call = async (token, endpoint, { method = "GET", body } = {}) => {
  const response = await fetch(`${BASE}/api/chat${endpoint}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok && result.success !== false, `Candidate chat API failed: ${method} ${endpoint} (${response.status})`);
  return result.data;
};

try {
  // 防止复制命令时误把浏览器增删操作发到线上，且服务与数据库必须是同一候选环境。
  const origin = new URL(BASE);
  assert.equal(origin.hostname, "127.0.0.1", "Sidebar UI review requires the loopback candidate");
  assert.equal(origin.port, "4125", "Sidebar UI review uses the dedicated candidate port");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.match(database.name, /^ooapi_agent_gate_[a-f0-9]{8}$/, "Sidebar UI review requires the isolated candidate database");
  if (output) await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });

  for (const [name, width, mode] of [["desktop-light", 1440, "light"], ["desktop-dark", 1440, "dark"], ["mobile-light", 320, "light"], ["mobile-dark", 320, "dark"]]) {
    const before = checks, suffix = crypto.randomBytes(5).toString("hex"), username = `sidebar_ui_${suffix}`;
    const [created] = await pool.query("INSERT INTO users (username, password, role, status, quota, created_time) VALUES (?, ?, 1, 1, 10000, ?)",
      [username, "!disabled-fixture-login", Math.floor(Date.now() / 1000)]);
    const user = { id: created.insertId, username };
    fixtures.push(user);
    const token = jwt.sign({ id: user.id, role: 1, tv: 0 }, JWT_SECRET, { expiresIn: "20m" });
    const api = (endpoint, options) => call(token, endpoint, options);
    const selfResponse = await fetch(`${BASE}/api/user/self`, { headers: { Authorization: `Bearer ${token}` } });
    const self = await selfResponse.json();
    assert.ok(selfResponse.ok && self.success !== false && self.data?.id === user.id && self.data?.username === username,
      "Candidate HTTP authentication must identify the exact isolated fixture user before any API write");
    const seed = async (title, archived = false) => {
      const session = await api("/sessions", { method: "POST", body: {} });
      await api(`/sessions/${session.id}`, { method: "PUT", body: { title } });
      if (archived) await api("/sessions/batch", { method: "POST", body: { ids: [session.id], action: "archive" } });
      return { ...session, title, archived };
    };
    const standalone = await seed(`独立笔记 ${suffix}`);
    const childA = await seed(`资料笔记 ${suffix}`);
    const childB = await seed(`学习笔记 ${suffix}`);
    const archived = await seed(`归档记录 ${suffix}`, true);
    const preservedText = `保留的原始正文 ${suffix}`;
    await pool.query("INSERT INTO chat_messages (session_id, user_id, seq, role, parts, created_time) VALUES (?, ?, 1, 'user', ?, ?)",
      [childA.id, user.id, JSON.stringify([{ id: "sidebar-original", type: "text", text: preservedText }]), Math.floor(Date.now() / 1000)]);
    await pool.query("UPDATE chat_sessions SET message_count = 1 WHERE id = ? AND user_id = ?", [childA.id, user.id]);
    // 真实 API 必须识别同一个 fixture 用户，再让浏览器开始操作。
    check((await api("/sessions?archived=all")).sessions.length === 4, "Fixture token and candidate database refer to the same user");
    if (name === "desktop-light") {
      // 大量新归档曾把较早的活跃对话挤出 all/200 列表；夹具仅写本轮用户。
      await pool.query("UPDATE chat_sessions SET updated_time = 1 WHERE user_id = ? AND archived = 0", [user.id]);
      const now = Math.floor(Date.now() / 1000) - 60;
      const values = Array.from({ length: 200 }, (_, index) => [crypto.randomBytes(8).toString("hex"), user.id, `历史归档 ${index} ${suffix}`, 1, now, now]);
      await pool.query(`INSERT INTO chat_sessions (id, user_id, title, archived, created_time, updated_time) VALUES ${values.map(() => "(?,?,?,?,?,?)").join(",")}`, values.flat());
      check(!(await api("/sessions?archived=all")).sessions.some(item => item.id === standalone.id), "Fixture reproduces archived records crowding out active conversations");
    }

    const context = await browser.newContext({ viewport: { width, height: 940 } });
    await context.addInitScript(({ token, mode }) => { localStorage.clear(); localStorage.setItem("ooapi-token", token); localStorage.setItem("ooapi-color-mode", mode); }, { token, mode });
    const page = await context.newPage(), errors = [], requests = [];
    lastPage = page;
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => { errors.push(`Native ${dialog.type()} dialog`); dialog.dismiss(); });
    page.on("request", request => requests.push(new URL(request.url()).pathname));
    const shelf = page.locator(".bui-shelf"), mobile = width < 900;
    const openShelf = async () => {
      if (mobile && !await shelf.evaluate(el => el.classList.contains("is-open"))) await page.getByRole("button", { name: "会话列表", exact: true }).click();
      await shelf.getByRole("button", { name: "新建对话", exact: true }).waitFor({ state: "visible" });
      // 可点击不等于抽屉入场结束，截图必须等到真实不透明，避免误判为背景穿透。
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".bui-shelf")).opacity) >= 0.999);
    };
    const row = id => shelf.locator(`[data-session-id="${id}"]`);
    const menu = async label => {
      // AntD 子菜单单独挂在 body 下；同时覆盖主菜单和子菜单，仍按可见业务文字定位。
      const item = page.locator(".ant-dropdown:visible, .ant-dropdown-menu-submenu-popup:visible").getByText(label, { exact: true });
      await item.click();
    };
    const sessionMenu = async session => {
      await openShelf();
      await shelf.getByRole("button", { name: `对话更多操作：${session.title}`, exact: true }).click();
    };
    const select = async session => {
      await openShelf();
      await row(session.id).locator(".bui-shelf-item").click();
      await eventually(() => Promise.resolve(new URL(page.url()).searchParams.get("s") === session.id), "Selecting a conversation updates its URL");
      if (mobile) await eventually(() => shelf.evaluate(el => !el.classList.contains("is-open")), "Selecting a mobile conversation closes the sidebar");
    };
    const createFrom = async locator => {
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat/sessions" && response.request().method() === "POST"),
        locator.click(),
      ]);
      const result = await response.json();
      check(response.ok() && result.success !== false, "Conversation creation succeeds through the real HTTP endpoint");
      return { session: result.data, body: response.request().postDataJSON() };
    };

    await page.goto(`${BASE}/chat?s=${childA.id}`);
    await page.getByText(preservedText, { exact: true }).waitFor();
    await openShelf();
    check(await row(childA.id).count() === 1 && await row(childB.id).count() === 1 && await row(standalone.id).count() === 1, "All active conversations share one list");
    check(!await row(archived.id).count(), "Active list excludes archived conversations");
    check(!await shelf.getByRole("button", { name: /项目/ }).count(), "No project controls remain");
    const globalNew = await createFrom(shelf.getByRole("button", { name: "新建对话", exact: true }));
    check(!Object.hasOwn(globalNew.body, "projectId") && !Object.hasOwn(globalNew.session, "project_id"), "New conversation has no project binding");
    await openShelf();
    await eventually(async () => (await shelf.locator(".bui-shelf-tabs button").first().innerText()).replace(/\s/g, "") === `对话${(await api("/sessions")).counts.active}`, "New conversation updates the active count");
    await eventually(async () => await row(globalNew.session.id).count() === 1, "New conversation appears once");
    await sessionMenu(standalone); await menu("重命名对话");
    const nameDialog = page.getByRole("dialog", { name: "重命名对话", exact: true });
    standalone.title = `笔记已更名 ${suffix}`;
    await nameDialog.getByLabel("对话名称", { exact: true }).fill(standalone.title);
    await nameDialog.getByRole("button", { name: /保\s*存$/ }).click();
    await nameDialog.waitFor({ state: "hidden" });
    check((await api(`/sessions/${standalone.id}`)).session.title === standalone.title, "Rename persists on the server");
    await sessionMenu(childA); await menu("归档");
    await eventually(async () => (await api(`/sessions/${childA.id}`)).session.archived, "Archive persists");
    await eventually(async () => await row(childA.id).count() === 0, "Archived conversation leaves active list");
    await openShelf(); await shelf.locator(".bui-shelf-tabs").getByRole("button", { name: /^已归档/ }).click();
    await eventually(async () => await row(childA.id).count() === 1, "Archived conversation appears in archive list");
    await select(childA);
    check(await page.getByText(preservedText, { exact: true }).isVisible(), "Archive preserves message history");
    await sessionMenu(childA); await menu("取消归档");
    await eventually(async () => !(await api(`/sessions/${childA.id}`)).session.archived, "Unarchive persists");
    await openShelf(); await shelf.locator(".bui-shelf-tabs").getByRole("button", { name: /^对话/ }).click();
    await select(childB); await openShelf();
    await shelf.getByRole("button", { name: "命令面板", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "命令面板", exact: true });
    await palette.getByRole("textbox", { name: "搜索会话或操作", exact: true }).fill(childA.title);
    await eventually(async () => await palette.locator(".bui-palette-row").count() === 1, "Command search finds conversation");
    await palette.getByRole("textbox", { name: "搜索会话或操作", exact: true }).press("Enter");
    await palette.waitFor({ state: "hidden" });
    check(new URL(page.url()).searchParams.get("s") === childA.id, "Keyboard search opens conversation");
    await page.keyboard.press("Control+k");
    await palette.getByRole("textbox", { name: "搜索会话或操作", exact: true }).fill("新建对话");
    const commandNew = await createFrom(palette.locator(".bui-palette-row"));
    check(!Object.hasOwn(commandNew.body, "projectId"), "Command creates conversation without project binding");
    await sessionMenu(standalone); await menu("置顶");
    await eventually(async () => (await api(`/sessions/${standalone.id}`)).session.pinned, "Pin persists on the server");
    await openShelf();
    await shelf.getByRole("button", { name: "多选", exact: true }).click();
    await row(childB.id).getByRole("checkbox").check();
    await shelf.locator(".bui-shelf-batch").getByRole("button", { name: "归档", exact: true }).click();
    await eventually(async () => (await api(`/sessions/${childB.id}`)).session.archived, "Batch archive remains functional");
    await shelf.getByRole("button", { name: "退出多选", exact: true }).click();
    await select(childA);
    check(await page.getByText(preservedText, { exact: true }).isVisible(), "Original message remains readable");
    check(!requests.includes("/api/chat/projects"), "Page never requests retired project API");
    await page.getByRole("button", { name: "会话设定", exact: true }).click();
    const settings = page.locator(".ui-chat2-settings.ant-drawer-open");
    await settings.getByRole("button", { name: /取\s*消$/ }).waitFor();
    check(!await settings.getByText(/任务预算|最多执行步数|最长运行时间|最多模型调用/).count(), "Session settings expose no removed task budget controls");
    await settings.getByRole("button", { name: /取\s*消$/ }).click();
    await settings.waitFor({ state: "hidden" });
    check(!await page.getByRole("button", { name: /本地工作区|任务工作台|下载本地运行器|任务编排/ }).count(), "Chat exposes no removed runner or workbench controls");
    check(!requests.some(endpoint => endpoint.startsWith("/api/local-workspaces") || /^\/api\/chat\/sessions\/[^/]+\/work$/.test(endpoint)), "Ordinary sidebar never requests removed workspace or workbench APIs");
    check(!requests.includes("/api/chat/run"), "Sidebar review never invokes a model");
    check(errors.length === 0, `Sidebar has no browser runtime errors: ${errors.join("; ")}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Sidebar interactions fit the mobile viewport");
    await openShelf();
    await page.locator(".ant-message-notice").waitFor({ state: "hidden" }).catch(async () => { await page.waitForFunction(() => !document.querySelector(".ant-message-notice")); });
    if (output) await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    console.log(`ok sidebar ${name}: ${checks - before} checks (real isolated HTTP)`);
    await context.close();
  }
  console.log(`${checks} sidebar UI checks passed.`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    console.log("Sidebar failure state:", (await lastPage.locator(".bui-shelf").innerText().catch(() => "unavailable")).slice(0, 5000));
    if (output) await lastPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  if (browser) await browser.close();
  // fixture 用户专属清理：不会读取或删除站内已有用户的会话。
  for (const user of fixtures) {
    for (const table of ["chat_messages", "chat_agent_tasks", "chat_agent_runs", "chat_sessions"]) await pool.query(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
    await pool.query("DELETE FROM users WHERE id = ? AND username = ?", [user.id, user.username]);
  }
  await pool.end();
}
