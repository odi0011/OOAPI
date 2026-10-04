// 真开构建产物并操作工作台；全部 API 在浏览器隔离替身中处理，不写数据库或访问上游。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ooapi-web/dist"));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const requested = path.resolve(root, "." + decodeURIComponent(pathname));
    if (requested !== root && !requested.startsWith(root + path.sep)) return res.writeHead(404).end();
    if (pathname.startsWith("/api/")) return res.writeHead(500).end("API must be intercepted");
    const filename = path.extname(pathname) ? requested : path.join(root, "index.html");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" })[path.extname(filename)] || "application/octet-stream");
    res.end(await readFile(filename));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const token = "isolated-work-panel-fixture";
const focus = process.env.UI_FOCUS || "";
let assertions = 0;
let lastPage;
const check = (value, message) => { assert.ok(value, message); assertions++; };
const wait = async fn => { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("fixture state did not settle"); };

try {
  for (const [name, width, mode] of [["desktop-light", 1440, "light"], ["desktop-dark", 1440, "dark"], ["mobile-light", 320, "light"], ["mobile-dark", 320, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height: 940 }, acceptDownloads: true });
    await context.addInitScript(({ token, mode }) => { localStorage.setItem("ooapi-token", token); localStorage.setItem("ooapi-color-mode", mode); localStorage.setItem("oo.chat.keyId", "7"); }, { token, mode });
    const page = await context.newPage(), errors = [], calls = [];
    lastPage = page;
    page.on("pageerror", e => errors.push(e.message));
    const session = { id: "work-fixture", title: "整理项目资料", model: "sample-model", agent: "general", settings: { maxSteps: 12, permissionMode: "ask", instructions: "", budget: { maxWallTimeMs: 1800000, maxModelCalls: 64, maxTokens: 1000000 } }, message_count: 2 };
    const policyMaxSteps = focus === "budget" ? ({ "desktop-light": 96, "desktop-dark": 7, "mobile-light": 96, "mobile-dark": 256 })[name] : 256;
    if (focus === "budget") {
      if (name.endsWith("dark")) session.settings.maxSteps = 256;
      if (name === "mobile-light") delete session.settings.maxSteps;
    }
    let savedText = "已保存的正文", binding = null, paired = false, rejectPair = true, rejectMessage = true, emptyStart = false, emptyCreates = 0;
    const run = { id: "run-fixture", status: "paused", resumable: true, local: false, budget: { modelCalls: 3, tokens: 987, od: .0123 } };
    const tasks = [{ id: "task-fixture", label: "核对文件清单", status: "paused", summary: "已完成第一部分" }];
    const workspace = { id: "workspace-fixture", deviceId: "device-fixture", label: "本机资料目录", online: true, capabilities: { read: true, write: false, exec: false } };
    const alternate = { ...workspace, id: "alternate-workspace", deviceId: "alternate-device", label: "其他工作目录" };
    if (focus === "device") { paired = true; binding = workspace; run.status = name === "desktop-dark" ? "completed" : name === "mobile-light" ? "waiting_local" : name === "mobile-dark" ? "interrupted" : "paused"; }
    const messages = () => [{ id: "u-fixture", seq: 1, role: "user", parts: [{ id: "u-text", type: "text", text: "帮我整理资料" }] }, { id: "a-fixture", seq: 2, role: "assistant", status: run.status, parts: [{ id: "a-text", type: "text", text: savedText }, { id: "pause-note", type: "error", code: run.status === "waiting_local" ? "WAITING_LOCAL" : "HARNESS_PAUSED", message: "任务进度已保存" }] }];
    await context.route("**/api/**", async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname, method = req.method();
      const body = req.postData() ? req.postDataJSON() : null;
      calls.push({ pathname, method, body, auth: await req.headerValue("authorization"), url: req.url() });
      let data = {};
      const reject = message => route.fulfill({ status: 400, json: { success: false, message } });
      if (pathname === "/api/status") data = { system_name: "OOAPI", unit_per_od: 10000, chat_enabled: true };
      else if (pathname === "/api/user/self") data = { id: 81, username: "fixture-user", role: 1, status: 1, quota: 10000 };
      else if (pathname === "/api/chat/meta") data = { models: [{ id: "sample-model", name: "示例模型", vendor: "openai", capabilities: { reasoning: false, vision: true } }], keys: [{ id: 7, name: "示例密钥", status: 1, usable: true }], active_key_id: 7, agents: [{ id: "general", name: "通用助手" }], defaults: { agent: "general", maxSteps: Math.min(96, policyMaxSteps), maxStepsLimit: policyMaxSteps, hardMaxStepsLimit: 256 } };
      else if (pathname === "/api/chat/projects") data = { projects: [] };
      else if (pathname === "/api/chat/sessions") {
        if (method === "POST") {
          if (emptyStart && emptyCreates++ === 0) return reject("隔离测试：首次创建会话失败");
          emptyStart = false; data = session;
        } else data = { sessions: emptyStart ? [] : [session], counts: { active: emptyStart ? 0 : 1, archived: 0, byProject: {} } };
      }
      else if (pathname === "/api/chat/sessions/work-fixture") {
        if (method === "PUT") { Object.assign(session, body); if (body.instructions != null) session.settings.instructions = body.instructions; }
        data = { session, messages: messages() };
        if (method === "PUT") data = session;
      } else if (pathname.endsWith("/running")) data = { running: false, longRun: run };
      else if (pathname.endsWith("/work")) data = { run, tasks };
      else if (pathname === "/api/local-workspaces/workspaces") data = { workspaces: paired ? focus === "device" ? [workspace, alternate] : [workspace] : [] };
      else if (pathname === "/api/local-workspaces/sessions/work-fixture") { if (method === "PUT") binding = body.workspaceId ? workspace : null; data = binding; }
      else if (pathname === "/api/local-workspaces/pair/confirm") {
        if (rejectPair) { rejectPair = false; return reject("隔离测试：配对码失效"); }
        paired = true; data = { deviceId: workspace.deviceId };
      } else if (pathname === `/api/local-workspaces/devices/${workspace.deviceId}` && method === "DELETE") {
        paired = false; binding = null; data = { revoked: true };
      } else if (pathname === "/api/local-workspaces/download") {
        await route.fulfill({ contentType: "application/zip", headers: { "Content-Disposition": "attachment; filename=ooapi-companion.zip" }, body: Buffer.from("isolated-download-fixture") }); return;
      } else if (pathname.endsWith("/message")) {
        if (rejectMessage) { rejectMessage = false; return reject("隔离测试：暂时未保存"); }
        data = { accepted: true };
      } else if (pathname.endsWith("/cancel")) { tasks[0].status = "cancelled"; data = { cancelled: true }; }
      else if (pathname.endsWith("/pause")) { run.status = "paused"; run.resumable = true; data = { paused: true }; }
      else if (pathname.endsWith("/stop")) { run.status = "stopped"; run.resumable = false; data = { stopped: true }; }
      else if (pathname === "/api/chat/run") {
        assert.equal(body.resume, true, "继续必须恢复已有任务"); assert.equal(body.keyId, 7);
        savedText += "，继续后的正文"; run.status = "waiting_local"; run.resumable = true;
        const events = [{ type: "start" }, { type: "snapshot", parts: messages()[1].parts }, { type: "waiting_local", message: messages()[1], session }];
        await route.fulfill({ contentType: "text/event-stream", body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") }); return;
      } else if (pathname.endsWith("/unread")) data = { count: 0 };
      else if (method !== "GET") throw new Error(`unexpected write ${pathname}`);
      await route.fulfill({ json: { success: true, data } });
    });

    await page.goto(base + "/chat?s=work-fixture");
    await page.getByRole("button", { name: "任务工作台", exact: true }).waitFor();
    await page.getByText("已保存的正文", { exact: true }).waitFor();
    if (focus === "budget") {
      await page.getByRole("button", { name: "会话设定", exact: true }).click();
      let sheet = page.locator(".ui-chat2-settings.ant-drawer-open [role=dialog]");
      await sheet.getByText("任务预算", { exact: true }).click();
      const steps = sheet.locator("#maxSteps");
      await steps.waitFor({ state: "visible" });
      check(await steps.getAttribute("aria-valuemax") === String(policyMaxSteps), "步数输入上限使用当前管理员策略");
      check(await sheet.getByText(`平台最多 ${policyMaxSteps} 步`, { exact: true }).isVisible(), "明确说明平台实际执行上限");
      check(await steps.inputValue() === String(Math.min(session.settings.maxSteps || 96, policyMaxSteps)), "旧12保持、大预算降至上限、新默认96");
      await steps.fill(String(policyMaxSteps + 1)); await steps.press("Tab");
      check(await steps.inputValue() === String(policyMaxSteps), "输入超出上限时回落到平台上限");
      await sheet.getByRole("button", { name: /^保\s*存$/ }).click(); await page.locator(".ui-chat2-settings .ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      check(session.settings.maxSteps === policyMaxSteps, "保存的预算不会超过策略");
      await page.getByRole("button", { name: "会话设定", exact: true }).click();
      sheet = page.locator(".ui-chat2-settings.ant-drawer-open [role=dialog]");
      await sheet.locator("#maxSteps").fill("1"); await sheet.getByRole("button", { name: /^保\s*存$/ }).click(); await page.locator(".ui-chat2-settings .ant-drawer-content-wrapper").waitFor({ state: "hidden" });
      check(session.settings.maxSteps === 1 && calls.filter(c => c.pathname.endsWith("/work-fixture") && c.method === "PUT").at(-1)?.body.settings.maxSteps === 1, "低预算1步实际提交保存");
      check(errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "预算界面无错误或窄屏溢出");
      console.log(`ok budget ${name}: policy cap / old12 / default96 / save1`);
      await context.close(); continue;
    }
    if (focus === "device") {
      await page.getByRole("button", { name: "本地工作区", exact: true }).click();
      const drawer = page.locator(".agent-work-drawer.ant-drawer-open [role=dialog]");
      await drawer.getByRole("button", { name: "已选择", exact: true }).waitFor();
      const protectedRun = run.status !== "completed";
      check(await drawer.getByRole("button", { name: "用于此对话", exact: true }).isDisabled() === protectedRun, "未完成任务不能更换绑定，完成态可调整");
      check(await drawer.getByRole("button", { name: "解除此对话的绑定", exact: true }).isDisabled() === protectedRun, "暂停等待和中断时不能解除绑定");
      if (protectedRun) check(await drawer.getByText("任务结束或停止后可调整绑定。", { exact: true }).isVisible(), "绑定限制文案与后端一致");
      check(await drawer.getByText(/所需片段会临时交给云端模型处理/).isVisible() && await drawer.getByText(/主动上传的附件仍走普通云端上传/).isVisible(), "隐私说明区分本地内容和普通上传");
      const revoke = drawer.getByRole("button", { name: "撤销设备连接", exact: true }).first();
      check(await revoke.isEnabled(), "暂停或完成态仍可以撤销设备");
      await revoke.click(); await page.getByText("撤销这个设备的连接？", { exact: true }).waitFor();
      // Popconfirm 测量时先短暂可见，再开始 scale(0) 入场；等待按钮可交互后检查文案。
      await page.getByRole("button", { name: "保留连接", exact: true }).click({ trial: true });
      check(await page.getByText(/已派发的操作可能已经执行/).isVisible() && await page.getByText(/撤销不会删除本机文件/).isVisible(), "撤销确认说明整个设备及已派发操作");
      await page.getByRole("button", { name: "保留连接", exact: true }).click();
      check(!calls.some(c => c.method === "DELETE"), "取消撤销不会发送请求");
      await revoke.click(); await page.getByText("撤销这个设备的连接？", { exact: true }).waitFor();
      await page.locator(".ant-popconfirm").getByRole("button", { name: "撤销连接", exact: true }).click();
      await drawer.getByText("还没有连接本机", { exact: true }).waitFor();
      check(calls.filter(c => c.method === "DELETE").length === 1 && calls.some(c => c.method === "DELETE" && c.pathname === `/api/local-workspaces/devices/${workspace.deviceId}`), "确认只发送一个正确deviceId DELETE");
      check(!await drawer.getByRole("button", { name: "解除此对话的绑定", exact: true }).count(), "刷新后清除已撤销设备的绑定");
      await drawer.getByRole("button", { name: /关闭|close/i }).click();
      await page.reload(); await page.getByRole("button", { name: "本地工作区", exact: true }).click();
      await page.locator(".agent-work-drawer.ant-drawer-open").getByText("还没有连接本机", { exact: true }).waitFor();
      check(!await page.locator(".agent-work-drawer.ant-drawer-open").getByRole("button", { name: "解除此对话的绑定", exact: true }).count(), "页面重载不恢复撤销绑定");
      check(errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "设备管理无错误或窄屏溢出");
      console.log(`ok device ${name}: binding guard / privacy / cancel / revoke / reload`);
      await context.close(); continue;
    }
    await page.getByText("任务进度已保存，可以继续。", { exact: true }).waitFor();
    check(await page.getByText("任务进度已保存，可以继续。", { exact: true }).isVisible(), "刷新能识别可继续任务");
    check(await page.getByRole("status", { name: "任务已暂停", exact: true }).isVisible() && !await page.getByRole("button", { name: "重试本轮", exact: true }).count() && !await page.getByRole("status", { name: "调用失败详情", exact: true }).count(), "可恢复控制状态显示暂停说明并隐藏重试本轮");
    run.status = "completed"; run.resumable = false;
    await page.getByRole("button", { name: "本地工作区", exact: true }).click();
    let drawer = page.locator(".agent-work-drawer.ant-drawer-open [role=dialog]");
    await drawer.getByText("还没有连接本机", { exact: true }).waitFor();
    const pair = drawer.getByRole("textbox", { name: "本地工作区配对码" });
    await pair.fill("ABCDE-12345"); await drawer.getByRole("button", { name: "确认连接", exact: true }).click();
    await drawer.getByText("隔离测试：配对码失效", { exact: true }).waitFor();
    check(await pair.inputValue() === "ABCDE-12345", "配对失败保留输入");
    await drawer.getByText("确认连接", { exact: true }).click();
    await drawer.getByRole("button", { name: "用于此对话", exact: true }).waitFor();
    check(await pair.inputValue() === "", "配对成功清空一次性码");
    await drawer.getByRole("button", { name: "用于此对话", exact: true }).click();
    await drawer.getByRole("button", { name: "已选择", exact: true }).waitFor();
    check(calls.some(c => c.method === "PUT" && c.body?.workspaceId === workspace.id), "选择工作区发送实际绑定");
    await drawer.getByRole("button", { name: "解除此对话的绑定", exact: true }).click();
    await drawer.getByRole("button", { name: "用于此对话", exact: true }).waitFor();
    check(calls.some(c => c.method === "PUT" && c.body?.workspaceId === null), "解除绑定发送 null");
    const download = page.waitForEvent("download"); await drawer.getByRole("button", { name: "下载本地运行器", exact: true }).click();
    check((await download).suggestedFilename() === "ooapi-companion.zip", "运行器下载能实际触发");
    const dcall = calls.find(c => c.pathname === "/api/local-workspaces/download");
    check(dcall?.auth === `Bearer ${token}` && !dcall.url.includes(token), "下载使用请求头鉴权，不把 token 放在 URL");
    check(!await drawer.locator("input[placeholder*=目录]").count(), "网页不收真实本地路径");
    check((await drawer.getByLabel("本地运行器启动命令").textContent()).includes("--allow-http-localhost"), "开发 HTTP 指引与运行器一致");
    await drawer.getByText("需要修改文件或运行命令", { exact: true }).click();
    check(await drawer.getByText(/执行命令需要 Docker 和本机已有镜像/).isVisible(), "无 Docker 时明确执行命令的先决条件");
    if (process.env.SCREENSHOT_DIR) { await mkdir(process.env.SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `workspace-${name}.png`) }); }
    await drawer.getByRole("button", { name: /关闭|close/i }).click();

    run.status = "paused"; run.resumable = true;
    await page.getByRole("button", { name: "任务工作台", exact: true }).click();
    drawer = page.locator(".agent-work-drawer.ant-drawer-open [role=dialog]");
    await drawer.getByText("核对文件清单", { exact: true }).waitFor();
    run.status = "running"; run.resumable = false;
    await drawer.getByRole("button", { name: "刷新任务", exact: true }).click();
    await drawer.getByRole("button", { name: "暂停任务", exact: true }).waitFor();
    await drawer.getByRole("button", { name: "暂停任务", exact: true }).click();
    await drawer.getByRole("button", { name: "继续任务", exact: true }).waitFor();
    check(calls.some(c => c.pathname.endsWith("/pause") && c.method === "POST"), "运行任务可以显式暂停");
    const supplemental = drawer.getByRole("textbox", { name: "给任务补充要求" });
    await supplemental.fill("优先完成清单"); await drawer.getByRole("button", { name: "发送补充要求", exact: true }).click();
    await drawer.getByText("隔离测试：暂时未保存", { exact: true }).waitFor();
    check(await supplemental.inputValue() === "优先完成清单", "补充失败保留草稿");
    await drawer.getByRole("button", { name: "发送补充要求", exact: true }).click();
    await wait(async () => await supplemental.inputValue() === "");
    check(calls.some(c => c.body?.message === "优先完成清单"), "补充要求发送真实内容");
    check(await drawer.getByRole("button", { name: "取消子任务", exact: true }).isDisabled(), "主任务暂停时不能取消尚未恢复的子任务");
    run.status = "running"; run.resumable = false;
    await drawer.getByRole("button", { name: "刷新任务", exact: true }).click();
    await wait(async () => await drawer.getByRole("button", { name: "取消子任务", exact: true }).isEnabled());
    await drawer.getByRole("button", { name: "取消子任务", exact: true }).click();
    await page.getByRole("button", { name: "取消子任务", exact: true }).last().click();
    await drawer.getByText("已取消", { exact: true }).waitFor();
    check(calls.some(c => c.pathname.endsWith("/tasks/task-fixture/cancel")), "子任务取消使用正确 id");
    await drawer.getByRole("button", { name: "暂停任务", exact: true }).click();
    await drawer.getByRole("button", { name: "继续任务", exact: true }).waitFor();
    await drawer.getByRole("button", { name: "继续任务", exact: true }).click();
    await drawer.getByText("等待本地连接", { exact: true }).waitFor();
    check(await page.getByText("已保存的正文，继续后的正文", { exact: true }).count() === 1, "恢复保留正文且不生成重复气泡");
    check(await page.getByText("本地连接暂时不可用，任务进度已保存。", { exact: true }).count() === 1, "waiting_local 成为可继续状态");
    check(!await page.getByText(/连接已断开|连接中断|正在恢复已有生成/).count(), "暂停终态没有伪连接错误");
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `tasks-${name}.png`) });
    const bounds = await drawer.boundingBox(); check(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, "抽屉适配窄屏");
    await drawer.getByRole("button", { name: /关闭|close/i }).click();
    await page.reload(); await page.getByText("已保存的正文，继续后的正文", { exact: true }).waitFor();
    await page.getByText("本地连接暂时不可用，任务进度已保存。", { exact: true }).waitFor();
    check(await page.getByText("本地连接暂时不可用，任务进度已保存。", { exact: true }).isVisible(), "刷新等待连接仍可继续");
    const composer = page.getByRole("textbox", { name: "消息内容", exact: true });
    await composer.fill("保留原文格式"); await composer.press("Enter");
    await wait(async () => await composer.inputValue() === "");
    check(calls.some(c => c.pathname.endsWith("/message") && c.body?.message === "保留原文格式"), "暂停期间主输入框发送补充要求");
    check(calls.filter(c => c.pathname === "/api/chat/run").length === 1, "补充文字不误发新一轮任务");
    await page.getByRole("button", { name: "会话设定", exact: true }).click();
    const settings = page.locator(".ui-chat2-settings.ant-drawer-open [role=dialog]");
    await settings.getByText("任务预算", { exact: true }).click();
    await settings.locator("#maxSteps").fill("256"); await settings.locator("#maxMinutes").fill("45");
    await settings.locator("#maxModelCalls").fill("128"); await settings.locator("#maxTokens").fill("2000000"); await settings.locator("#maxOd").fill("0.25");
    await settings.getByRole("button", { name: /^保\s*存$/ }).click();
    await settings.waitFor({ state: "hidden" });
    check(session.settings.maxSteps === 256 && session.settings.budget.maxWallTimeMs === 2700000 && session.settings.budget.maxModelCalls === 128 && session.settings.budget.maxTokens === 2000000 && session.settings.budget.maxOd === .25, "高级预算按分钟转换并完整保存");
    check(session.settings.permissionMode === "ask", "预算保存保留工具询问偏好");
    await page.getByRole("button", { name: "任务工作台", exact: true }).click();
    drawer = page.locator(".agent-work-drawer.ant-drawer-open [role=dialog]");
    await drawer.getByRole("button", { name: "停止任务", exact: true }).click();
    await page.getByRole("button", { name: "停止任务", exact: true }).last().click();
    await drawer.getByText("已停止", { exact: true }).waitFor();
    check(calls.some(c => c.pathname.endsWith("/stop")) && !await drawer.getByRole("button", { name: "继续任务", exact: true }).count(), "暂停任务可以显式停止，停止后不能再继续");
    await drawer.getByRole("button", { name: /关闭|close/i }).click();
    if (name === "desktop-light") {
      emptyStart = true;
      await page.reload(); await page.getByText("隔离测试：首次创建会话失败", { exact: true }).waitFor();
      check(await page.getByRole("button", { name: "本地工作区", exact: true }).isEnabled(), "无会话时工作区入口仍可重试");
      await page.getByRole("button", { name: "本地工作区", exact: true }).click();
      await page.locator(".agent-work-drawer.ant-drawer-open").getByText("本机资料目录", { exact: true }).waitFor();
      check(emptyCreates === 2, "工作区创建空会话时复用单次在途操作，没有重复创建");
      await page.locator(".agent-work-drawer.ant-drawer-open").getByRole("button", { name: /关闭|close/i }).click();
    }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "页面没有横向溢出");
    check(errors.length === 0, `无页面运行错误：${errors.join("; ")}`);
    console.log(`ok ${name}: connection / download / failure retention / task messages / cancellation / SSE resume / refresh / layout`);
    await context.close();
  }
  console.log(`${assertions} assertions passed (all APIs isolated).`);
} catch (e) {
  if (lastPage && !lastPage.isClosed()) {
    console.log("fixture failure buttons", await lastPage.locator("[role=dialog] button").allTextContents());
    if (await lastPage.locator(".agent-work-drawer.ant-drawer-open").count()) console.log("fixture failure aria", await lastPage.locator(".agent-work-drawer.ant-drawer-open").ariaSnapshot());
    console.log("fixture failure state", (await lastPage.locator("[role=dialog]").allTextContents()).join("\n").slice(-6000));
    if (process.env.SCREENSHOT_DIR) { await mkdir(process.env.SCREENSHOT_DIR, { recursive: true }); await lastPage.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "work-panel-failure.png") }); }
  }
  throw e;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
