// 用构建产物在真实浏览器里粘贴、提交。所有 API 都是隔离桩，不写生产库、不请求上游。
// 本测试与解析测试互补：Form.Item 子节点错误只有真正操作输入框才能发现。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { publicProviders } from "../src/services/channel-types.js";
import { cookieHeader } from "../src/services/upstream/cookie-input.js";
import { restoreCookies } from "../src/services/upstream/browser-driver.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ooapi-web/dist");
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const requested = path.resolve(root, "." + decodeURIComponent(pathname));
    if (!requested.startsWith(root + path.sep) && requested !== root) { res.writeHead(404).end(); return; }
    const filename = path.extname(pathname) ? requested : path.join(root, "index.html");
    const data = await readFile(filename);
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" })[path.extname(filename)] || "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const providers = publicProviders();
const adapters = { stepfun: "stepfun-web", mimo: "mimo-web", minimax: "minimax-web", kimi: "kimi", glm: "glm", doubao: "doubao", qwen: "qwen" };
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig";
const inputs = {
  stepfun: "Cookie: i18n=zh; Oasis-Webid=test-device; Oasis-Token=test-step==",
  mimo: "Cookie: xiaomichatbot_serviceToken=test-mimo; userId=test-user; xiaomichatbot_ph=test-ph",
  minimax: "Cookie: token=" + jwt + "; device=test-device",
  kimi: "Cookie: kimi-auth=" + jwt + "; device=test-device",
  glm: "Cookie: session=test-session; device=test-device",
  doubao: "Cookie: session=test-session; device=test-device",
  qwen: "Cookie: session=test-session; device=test-device",
};
let passed = 0;
try {
  for (const [label, width, mode] of [["desktop-light", 1440, "light"], ["desktop-dark", 1440, "dark"], ["mobile-light", 390, "light"]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 960 } });
    await ctx.addInitScript((theme) => {
      localStorage.setItem("ooapi-token", "isolated-ui-fixture");
      localStorage.setItem("ooapi-theme", theme);
    }, mode);
    const calls = [];
    const errors = [];
    let rejectNext = false;
    await ctx.route("**/api/**", async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      let data = {};
      if (pathname === "/api/channel/login") {
        const body = req.postDataJSON();
        calls.push(body);
        if (rejectNext) {
          rejectNext = false;
          await route.fulfill({ status: 400, json: { success: false, message: "隔离测试：登录态失效" } }); return;
        }
        const mod = await import("../src/services/upstream/" + adapters[body.type] + ".js");
        const parsed = await mod.importAuth(body);
        assert.ok(parsed.token || parsed.other?.cookies?.length, "提交内容应能够解析出实际凭据");
        data = { id: 0, name: body.name };
      } else if (req.method() !== "GET") {
        throw new Error("不允许测试写入其它接口：" + pathname);
      } else if (pathname === "/api/status") {
        data = { system_name: "OOAPI", unit_per_od: 10000, expose_pricing_to_user: true };
      } else if (pathname === "/api/user/self") {
        data = { id: 1, username: "isolated-admin", role: 1000, status: 1, quota: 10000 };
      } else if (pathname === "/api/channel/providers") data = providers;
      else if (pathname === "/api/channel/") data = [];
      else if (pathname === "/api/channel/groups") data = [];
      else if (pathname === "/api/channel/stats") data = { total: 0, enabled: 0, disabled: 0, byType: {} };
      else if (pathname.endsWith("/unread")) data = { count: 0 };
      await route.fulfill({ json: { success: true, data } });
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (dialog) => { errors.push("不应出现浏览器原生弹窗"); void dialog.dismiss(); });
    await page.goto(base + "/admin/channel");
    const open = page.getByRole("button", { name: /添加渠道/ });
    await open.waitFor();
    const dialog = page.getByRole("dialog");
    const choose = async (type) => {
      const provider = providers.find((p) => p.key === type);
      await dialog.getByRole("button", { name: "选择厂商 " + provider.name, exact: true }).click();
      await dialog.locator("#token").waitFor();
    };
    for (const type of Object.keys(inputs)) {
      await open.click();
      await choose(type);
      assert.equal(await dialog.locator("#token").inputValue(), "", "重开弹窗不得继承前一家 Cookie");
      await dialog.locator("#token").fill(inputs[type]);
      const before = calls.length;
      await dialog.getByRole("button", { name: /^添\s*加$/ }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(calls.length, before + 1, "真实输入框必须能提交");
      assert.equal(calls.at(-1).token, inputs[type], "Form 应提交用户粘贴的完整内容");
      assert.equal(calls.at(-1).type, type);
      passed++;
    }
    await open.click();
    await choose("stepfun");
    const before = calls.length;
    await dialog.getByRole("button", { name: /^添\s*加$/ }).click();
    await dialog.getByText("请先按上面的清单取到值再粘贴", { exact: true }).waitFor();
    assert.equal(calls.length, before, "空凭据不应提交");
    await dialog.locator("#token").fill(inputs.stepfun);
    await choose("mimo");
    assert.equal(await dialog.locator("#token").inputValue(), "", "切换厂商必须清除 Cookie");
    await choose("stepfun");
    await dialog.locator("#token").fill(inputs.stepfun);
    rejectNext = true;
    await dialog.getByRole("button", { name: /^添\s*加$/ }).click();
    await page.getByText("隔离测试：登录态失效", { exact: true }).waitFor();
    assert.equal(await dialog.locator("#token").inputValue(), inputs.stepfun, "请求失败后应保留输入供修正");
    await dialog.locator("#token").scrollIntoViewIfNeeded();
    const box = await dialog.locator("#token").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, "输入框应在可视区域内");
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "credential-" + label + ".png"), fullPage: true });
    }
    assert.deepEqual(errors, [], "无页面运行错误或原生弹窗");
    passed += 4;
    console.log("  ok " + label + "：7 个厂商提交、空值校验、切换清空、失败保留、布局");
    await ctx.close();
  }
  // 用真实 Chromium 验证无 domain 的 Cookie 确实能在首个导航请求中发送。
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let actualHeader;
  await ctx.route(base + "/cookie-check", async (route) => {
    actualHeader = await route.request().headerValue("cookie");
    await route.fulfill({ body: "cookie-check" });
  });
  await restoreCookies(ctx, page, [{ name: "session", value: "test-session" }], base);
  await page.goto(base + "/cookie-check");
  assert.equal(actualHeader, cookieHeader([{ name: "session", value: "test-session" }]));
  passed++;
  await ctx.close();
  console.log("凭据浏览器回归：" + passed + " 项通过");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
