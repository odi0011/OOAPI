// 隔离候选 UI 验收：长名称、省略号、价格分档与汇总密度；不读取真实账号或数据库。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { serveCandidate, installSmokeFixtures, smokeFixtureData, fixtureUser } from "./ui-smoke-fixtures.mjs";
import { dashboardData, dashboardFilters, visibility } from "./dashboard-fixtures.mjs";

const output = process.env.SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
const longName = "这是一个用于检查省略号的超长用户显示名称abcdefghijklmnopqrstuvwxyz";
const person = { ...fixtureUser, id: 2, display_name: longName, username: "long-username-abcdefghijklmnopqrstuvwxyz", email: "long-address-abcdefghijklmnopqrstuvwxyz@example.invalid", avatar_url: "/icons/openai.svg" };
const price = { model: "deepseek-flash", input: .3, output: 1.2, cache: .006, offpeakInput: .15, offpeakOutput: .6, offpeakCache: .003, offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"]] }, remark: "官方价格来源与配置依据的超长文字，用来检查省略号abcdefghijklmnop" };
const caps = { model: price.model, vendor: "deepseek", category: "chat", contextWindow: 1000000, maxOutputTokens: 384000, inputTypes: ["text", "image"], outputTypes: ["text"], reasoning: { levels: ["low", "high", "max"] }, pricing: price, verification: "official", documentationUrl: "https://example.invalid/docs" };
const items = [caps, { ...caps, model: "claude-opus-5-5", vendor: "anthropic", contextWindow: 200000, maxOutputTokens: 64000, reasoning: { levels: ["low", "medium", "high", "max"] }, pricing: { input: 5, output: 25, cache: .5, tiers: [{ minInputTokens: 128000, input: 10, output: 37.5, cache: 1 }] } }, { model: "vendor/very-long-unconfigured-model-abcdefghijklmnopqrstuvwxyz", vendor: "custom", category: "decision", reasoning: {} }];
const log = { user_id: person.id, ...person, id: 10, model: caps.model, original_model: "deepseek-v4.1-flash-free", channel_type: "deepseek", model_vendor: "deepseek", source_vendors: ["deepseek"], status: "success", type: 2, created_at: 1791259200, prompt_tokens: 12345, completion_tokens: 1234, cache_tokens: 9000, units: 3, first_token_ms: 2345, elapsed_ms: 12500, reasoning_effort: "high", actual_reasoning_effort: "high", inbound_endpoint: "/v1/responses", upstream_endpoint: "/v1/chat/completions" };
const list = item => ({ items: [item], total: 1, page_size: 20, p: 1 });
function data(pathname) {
  if (pathname === "/api/status") return { ...smokeFixtureData(pathname), user_data_visibility: visibility };
  if (pathname === "/api/pricing/capabilities") return { items, reasoningParameters: [], presets: [] };
  if (pathname === "/api/pricing/") return items.filter(row => row.pricing).map(row => ({ ...row.pricing, model: row.model }));
  if (pathname === "/api/pricing/attribution") return { models: [], aliases: [] };
  if (pathname === "/api/pricing/public") return { models: items.filter(row => row.pricing).map(row => ({ ...row.pricing, model: row.model, vendor: row.vendor })), vendors: [], groups: [] };
  if (pathname === "/api/token/") return [{ id: 1, name: longName, key: "masked-ui-fixture", status: 1, group: "default", created_time: 1791259200, remain_quota: 10000, used_quota: 0 }];
  if (pathname === "/api/users/") return list(person);
  if (pathname === "/api/log/usage" || pathname === "/api/log/operation") return list({ ...log, content: longName, username: person.username, display_name: person.display_name });
  if (pathname === "/api/channel/groups") return [{ name: longName, rate: 1, models: [caps.model], remark: longName, channels: [1] }];
  if (pathname === "/api/channel/") return [{ id: 1, name: longName, type: "deepseek", models: caps.model, status: 1, group: longName, priority: 0, weight: 1 }];
  if (pathname === "/api/community/posts") return list({ id: 1, title: longName, summary: longName, author: person, created_time: log.created_at, status: 1 });
  if (pathname === "/api/media/") return list({ id: 1, user_id: 2, orig_name: longName + ".pdf", kind: "document", size: 12345, created_time: log.created_at, ref_count: 1 });
  if (pathname === "/api/media/stats") return { count: 1, bytes: 12345, quota_bytes: 1048576, by_kind: { document: 1 } };
  return smokeFixtureData(pathname);
}

const server = await serveCandidate();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let passed = 0, lastPage;
function check(value, message) { assert.ok(value, message); passed++; }
try {
  for (const width of [1920, 1440, 390]) for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await ctx.addInitScript(mode => localStorage.setItem("ooapi-color-mode", mode), theme);
    const rejected = await installSmokeFixtures(ctx, data);
    await ctx.route("**/api/dashboard/**", route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: { success: true, data: url.pathname === "/api/dashboard/filters" ? dashboardFilters(url.searchParams) : dashboardData(url.searchParams) } });
    });
    const page = await ctx.newPage(), errors = []; lastPage = page;
    page.on("pageerror", error => errors.push(error.message));
    const routes = ["/admin/pricing", "/log", "/admin/users", "/operation-log", "/admin/groups", "/admin/community", "/media", "/console", "/admin/channel", "/profile", "/notifications", "/admin/monitor", "/od-binance", "/token", "/pricing", "/u/1", "/admin/dashboard"];
    for (const route of routes) {
      await page.goto(server.base + route, { waitUntil: "networkidle" });
      check(await page.locator(".oo-page, .oo-dashboard, .oo-binance").count() > 0, `${route}: 页面正常渲染`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} ${width}: 整页不能横向溢出`);
      const stats = await page.locator(".oo-stat-card").evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, display: getComputedStyle(node).display })));
      check(stats.every(stat => stat.height <= 28 && ["flex", "inline-flex"].includes(stat.display)), `${route} ${width}: 统计使用小标签 ${JSON.stringify(stats)}`);
      if (["/log", "/operation-log", "/admin/community"].includes(route)) {
        const names = await page.locator(".arc-data-table td .oo-user-label > .oo-truncate").evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, title: node.title, overflow: node.scrollWidth > node.clientWidth, ellipsis: getComputedStyle(node).textOverflow })));
        check(names.length > 0 && names.every(name => name.overflow && name.ellipsis === "ellipsis" && name.title === name.text), `${route}: 长用户名称必须省略并保留全名`);
      }
      if (route === "/admin/pricing") {
        const table = page.locator(".oo-model-management-panel");
        if (width >= 768) {
          for (const header of ["上下文", "最大输出", "推理", "输入 / 输出", "价格 / 百万 Token"]) check(await table.getByRole("columnheader", { name: header, exact: true }).count() === 1, `模型独立列 ${header}`);
        } else {
          check(await table.locator(".oo-model-mobile-row").count() === 3, "手机各模型采用完整信息行");
          check(await table.locator("table").evaluate(node => node.parentElement.scrollWidth <= node.parentElement.clientWidth + 1), "手机模型列表不需要横向滚动");
        }
        check(!(await page.locator("body").innerText()).includes("每个模型的价格与参数能力"), "删除冗余说明");
        const lines = await table.locator(".oo-model-price-matrix").first().locator(".oo-model-price-label").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        check(lines.length === 3 && lines[0] < lines[1] && lines[1] < lines[2], "价格按输入输出缓存纵向排版");
        const values = await table.locator(".oo-model-price-matrix").first().locator(".oo-model-price-value").allTextContents();
        check(values.join(" ").includes("0.15") && values.join(" ").includes("0.003"), "闲时价格与峰时并排可见");
        check(await table.getByRole("columnheader", { name: "≥ 128K", exact: true }).count() === 1 && (await table.locator(".oo-model-price-matrix").nth(1).innerText()).includes("37.5"), "长上下文档位与基础价格并排可见");
        await table.getByRole("button", { name: /配\s*置/ }).first().click();
        await page.locator(".oo-model-config-drawer .arc-drawer-body").waitFor();
        check(Number(await page.locator("#price_input").inputValue()) === .3, "价格表单保留既有值");
        check(await page.getByRole("link", { name: "厂商文档" }).count() === 1, "厂商文档仍可访问");
        await page.locator(".oo-model-config-drawer").getByRole("button", { name: "关闭", exact: true }).click();
        await page.locator(".oo-model-config-drawer").waitFor({ state: "hidden" });
      }
      if (output && ["/admin/pricing", "/log", "/admin/users", "/console", "/admin/monitor"].includes(route)) {
        await page.locator(".arc-data-table table").evaluateAll(nodes => nodes.forEach(node => { node.parentElement.scrollLeft = 0; }));
        await page.screenshot({ path: path.join(output, `${route.replaceAll("/", "-").slice(1)}-${width}-${theme}.png`), fullPage: true });
      }
      check(errors.length === 0, `${route}: 无浏览器运行错误 ${errors.join(",")}`);
    }
    check(rejected.every(write => write.method === "POST" && write.pathname === "/api/monitor/stream-ticket"), `只能拦截预期的监控订阅申请，不得触发配置或计费写入：${JSON.stringify(rejected)}`);
    console.log(`  ok ${width}px ${theme}: ${routes.length} 个入口，长名称与价格档位`);
    await ctx.close();
  }
  console.log(`表格与汇总 UI：${passed} 项通过，1920/1440/390px 明暗主题，隔离样本。`);
} catch (error) {
  if (output && lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); await server.close(); }
