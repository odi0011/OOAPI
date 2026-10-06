// 候选 dist 的数据看板浏览器验收；所有 HTTP 样本在 Playwright 内结束，不读 DB 或客户凭据。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { serveCandidate, installSmokeFixtures, smokeFixtureData, fixtureStatus } from "./ui-smoke-fixtures.mjs";
import { dashboardData, dashboardFilters, people, visibility } from "./dashboard-fixtures.mjs";

const output = process.env.SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
const server = await serveCandidate();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let passed = 0, lastPage;
const check = (condition, message) => { assert.ok(condition, message); passed++; };

async function open({ width = 1440, theme = "light", role = "admin", empty = false, denied = false, fail = false, missingRealtime = false, debt = false, truncatedAudience = false, unknownStatus = false, manyChannels = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript((mode) => localStorage.setItem("ooapi-color-mode", mode), theme);
  const control = { empty, denied, fail, missingRealtime, debt, truncatedAudience, unknownStatus, manyChannels, delays: {}, filterFail: false };
  const queries = [], errors = [];
  const rejected = await installSmokeFixtures(ctx, (pathname) => {
    if (pathname === "/api/status") return { ...fixtureStatus, user_data_visibility: denied ? Object.fromEntries(Object.keys(visibility).map((key) => [key, key === "version" ? 1 : false])) : visibility };
    if (pathname === "/api/user/self") return { ...people[0], avatar_url: "/icons/openai.svg?v=current-profile", role: role === "admin" ? 1000 : 1, status: 1, quota: 250000 };
    return smokeFixtureData(pathname);
  });
  // 详细 query 由专用路径处理；通用 fixture 仍为其余路由提供只读隔离数据。
  await ctx.route("**/api/dashboard/**", async (route) => {
    const url = new URL(route.request().url()), query = url.searchParams;
    if (route.request().method() !== "GET") throw new Error("看板专项意外发起 API 写入");
    queries.push({ path: url.pathname, range: query.get("range"), user: query.get("user_id"), token: query.get("token_id") });
    const delay = control.delays[query.get("range")];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (control.fail && url.pathname !== "/api/dashboard/filters" || control.filterFail && url.pathname === "/api/dashboard/filters") return route.fulfill({ json: { success: false, message: "隔离样本：暂时无法读取统计，请稍后重试" } });
    const body = url.pathname === "/api/dashboard/filters" ? dashboardFilters(query) : dashboardData(query, { ...control, personal: role !== "admin" });
    return route.fulfill({ json: { success: true, data: body } });
  });
  const page = await ctx.newPage(); lastPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.base + "/console", { waitUntil: "networkidle" });
  await page.locator(".oo-dashboard").waitFor();
  await page.waitForTimeout(250);
  return { ctx, page, control, queries, errors, rejected };
}

async function screenshot(page, name) {
  if (output) {
    await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
    await page.screenshot({ path: path.join(output, name + "-viewport.png") });
  }
}
async function overflow(page, name) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + "：页面没有横向溢出");
  check(!(await page.locator(".oo-dashboard").innerText()).match(/NaN|undefined|Infinity/), name + "：数字与来源没有无效占位值");
  const kpi = await page.locator(".oo-stat-card-num").evaluateAll((els) => els.map((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, text: el.innerText })));
  check(kpi.length === 4 && kpi.every((el) => el.scroll <= el.width + 1), name + "：四项关键数字完整显示，没有溢出或裁切 " + JSON.stringify(kpi));
}

// Arc 表格保留语义化 tbody；横滚属于 table 的直接父层，而不是 table 本身。
async function tableScroll(table) {
  return table.evaluate((element) => {
    const scroller = element.parentElement;
    scroller.scrollLeft = scroller.scrollWidth;
    const result = { width: scroller.clientWidth, scrollWidth: scroller.scrollWidth, scrollLeft: scroller.scrollLeft, overflowX: getComputedStyle(scroller).overflowX };
    scroller.scrollLeft = 0;
    return result;
  });
}

const modelNames = (models) => models.locator(".oo-dashboard-model > .arc-tooltip-anchor [data-model-name]").evaluateAll((labels) => labels.map((label) => label.dataset.modelName));
const activeAudience = (audience) => audience.locator('[role="tabpanel"][data-state="active"]');

try {
  if (process.env.DASHBOARD_CASE !== "channels") {
  // 同源样本先自验，避免用互相矛盾的假数据掩盖真正的呈现问题。
  const sample = dashboardData(new URLSearchParams("range=30d"));
  check(sample.totals.calls === sample.trend.reduce((total, row) => total + row.calls, 0), "调用趋势与区间总计自洽");
  check(sample.totals.units === sample.top_models.reduce((total, row) => total + row.units, 0), "模型消费与区间总计自洽");
  check(sample.totals.prompt_tokens - sample.totals.cache_tokens + sample.totals.cache_tokens + sample.totals.completion_tokens === sample.totals.total_tokens, "缓存只计入输入一次");
  check(sample.totals.successes + sample.totals.failed + sample.totals.stopped + sample.totals.partial === sample.totals.calls, "四种互斥状态合计等于全部请求");

  for (const role of ["admin", "user"]) for (const width of [1440, 1165, 390, 320]) for (const theme of ["light", "dark"]) {
    const test = await open({ width, theme, role });
    const { ctx, page, errors, rejected, queries } = test;
    const name = `dashboard-${role}-${width}-${theme}`;
    await overflow(page, name);
    check(await page.getByText("调用次数", { exact: true }).count() > 0 && await page.getByText("消费金额", { exact: true }).count() > 0 && await page.getByText("Token 用量", { exact: true }).count() > 0 && await page.getByText("请求成功率", { exact: true }).count() > 0, name + "：共同四项 KPI 语义一致");
    check(await page.locator(".oo-dashboard").innerText().then((text) => text.includes("北京时间") || text.includes("UTC+8")), name + "：范围明确标注统计时区");
    check(await page.getByText("服务状态快照", { exact: true }).count() === 0, name + "：历史用量不混入进程快照");
    const expectedData = dashboardData(new URLSearchParams("range=30d"), { personal: role !== "admin" });
    check(await page.locator(".oo-dashboard-metric").filter({ has: page.getByText("请求成功率", { exact: true }) }).locator(".oo-stat-card-num").innerText().then((text) => Math.abs(parseFloat(text) - expectedData.totals.success_rate) <= 0.051), name + "：成功率使用成功/全部调用，停止与部分失败不被算作成功");
    check(queries.some((query) => query.path === (role === "admin" ? "/api/dashboard/admin" : "/api/dashboard/self")), name + "：调用当前角色专属接口");
    check(!queries.some((query) => query.path === (role === "admin" ? "/api/dashboard/self" : "/api/dashboard/admin")), name + "：角色边界没有错误的统计接口请求");
    check(role === "admin" || !queries.some((query) => query.path === "/api/dashboard/filters"), name + "：普通用户不请求管理员过滤目录");
    const trend = page.locator(".oo-dashboard-main-chart"), models = page.locator(".oo-dashboard-model-table"), recent = page.locator(".oo-dashboard-recent");
    check(await trend.count() === 1 && await models.count() === 1 && await recent.count() === 1, name + "：趋势、模型表、最近记录都有明确区块");
    check(await models.locator(".arc-data-table").count() === 1, name + "：模型用量以可排序表格展示");
    check(await recent.locator(".arc-data-table").count() === 1, name + "：最近调用保持完整表格");
    check((await recent.innerText()).includes("首") || (await recent.innerText()).includes("耗时"), name + "：最近调用带首字与耗时信息");
    check(await recent.locator(".oo-model-label, .model-label").count() > 0 || await recent.locator("img").count() > 0, name + "：最近调用有模型标识");
    if (role === "admin") {
      const toolbar = await page.locator(".oo-dashboard-toolbar").evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: parseFloat(style.borderTopWidth), padding: parseFloat(style.paddingTop) };
      });
      check(toolbar.border === 0 && toolbar.padding === 0, name + "：筛选区不再套方形外框或重复内边距 " + JSON.stringify(toolbar));
      check(await page.locator(".oo-dashboard-channels .arc-data-table").count() === 1, name + "：管理员渠道表现有独立表格");
      const avatar = recent.locator("tbody td:nth-child(2) img");
      check(await avatar.count() > 0, name + "：管理员最近调用使用真实头像字段");
      check(await avatar.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), name + "：用户头像成功加载");
      const currentUserImages = recent.locator("tbody tr").filter({ hasText: "林同学" }).locator("td:nth-child(2) img");
      check(await currentUserImages.count() > 0 && await currentUserImages.evaluateAll((images) => images.every((image) => image.getAttribute("src").includes("v=current-profile"))), name + "：当前用户历史调用头像实时使用最新资料版本，不能被日志ID或旧URL覆盖");
      check(await page.locator('.oo-dashboard-audience [aria-expanded="true"]').count() === 0, name + "：用户与密钥分析默认折叠，避免拉长看板");
    } else check(await page.locator(".oo-dashboard-channels").count() === 0, name + "：个人看板不展示全站渠道数据");
    if (width <= 1165) {
      const scroll = await tableScroll(recent.locator("table"));
      check(scroll.scrollWidth > scroll.width && scroll.scrollLeft > 0 && scroll.overflowX === "auto", name + "：宽表只能在自身内部横滚，最后消费列可达 " + JSON.stringify(scroll));
    }
    if (width >= 1165) {
      const chartBox = await trend.boundingBox(), dashboardBox = await page.locator(".oo-dashboard").boundingBox();
      check(chartBox.width >= dashboardBox.width * 0.58, name + "：主趋势拥有至少58%可用宽度");
      check(chartBox.height <= 440, name + "：主趋势没有巨大的空白高度");
      const composition = await page.locator(".oo-dashboard-composition").evaluate((element) => {
        const body = element.querySelector("[data-arc-card-content]"), section = element.querySelector(".oo-dashboard-breakdown");
        const style = getComputedStyle(body);
        return { innerWidth: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), contentWidth: section.getBoundingClientRect().width };
      });
      check(composition.contentWidth >= composition.innerWidth * 0.9, name + "：用量构成内容撑满自身面板，没有被max-content挤成半栏 " + JSON.stringify(composition));
    }
    await screenshot(page, name);
    if (width === 1440 && theme === "light") {
      check(await recent.locator(".oo-model-origin").count() > 0, name + "：实际上游SKU映射用↳独立一行显示");
      check(await recent.locator("tbody > tr").count() === 8, name + "：最近调用明确限制为8条，不拉长整个页面");
      if (role === "admin") check((await recent.innerText()).includes("0.0001"), name + "：非零微量消费保留四位小数，不显示成0");
      const seenModels = new Set();
      for (let index = 1; index <= 3; index++) {
        if (index > 1) await models.getByRole("button", { name: `Page ${index}`, exact: true }).click();
        (await modelNames(models)).forEach((model) => seenModels.add(model));
      }
      check(seenModels.size === 14 && expectedData.top_models.every((record) => seenModels.has(record.model)), name + "：14个模型均可翻页查看，不提前丢弃排行尾部");
      await models.getByRole("button", { name: "Page 1", exact: true }).click();
      await models.getByText("按消费", { exact: true }).click();
      check((await modelNames(models))[0] === expectedData.top_models[0].model, name + "：按消费切换实际排序，最高消费模型排第一");
      await trend.getByText("Token", { exact: true }).click();
      check(await trend.locator(".arc-chart-legend > span").allTextContents().then((labels) => ["未缓存输入", "缓存读取", "输出"].every((label) => labels.some((text) => text.includes(label)))), name + "：Token趋势三项互不重叠且图例完整");
      await trend.getByText("消费", { exact: true }).click();
      check(await trend.locator(".arc-chart-legend > span").allTextContents().then((labels) => labels.length === 1 && labels[0] === "消费金额"), name + "：消费趋势只显示金额量纲，不与调用同轴");
      await trend.getByText("调用", { exact: true }).click();
      check(await trend.locator(".arc-chart-legend > span").allTextContents().then((labels) => labels.some((text) => text.includes("全部调用")) && labels.some((text) => text.includes("失败调用"))), name + "：调用趋势包含全部和失败曲线");
      const rowCounts = await page.getByRole("region", { name: "请求结果", exact: true }).locator("dd > span").allTextContents();
      check(rowCounts.length === 4 && rowCounts.reduce((sum, value) => sum + Number(value.replaceAll(",", "")), 0) === expectedData.totals.calls, name + "：可见结果构成分项精确合计全部调用");
      const tokenCounts = await page.getByRole("region", { name: "Token 构成", exact: true }).locator("dd > span").allTextContents();
      check(tokenCounts.length === 3 && tokenCounts.reduce((sum, value) => sum + Number(value.replaceAll(",", "")), 0) === expectedData.totals.total_tokens, name + "：可见Token构成缓存不会重复相加");
      const info = page.locator(".oo-dashboard-metric").filter({ has: page.getByText("调用次数", { exact: true }) });
      await info.hover();
      const tip = page.getByRole("tooltip");
      await tip.waitFor();
      check((await tip.innerText()).includes("主动停止") && (await tip.innerText()).includes("只计一次"), name + "：统计口径可直接悬浮查询");
      const colors = await tip.evaluate((element) => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
        const pixel = (color) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data); };
        const style = getComputedStyle(element);
        const token = getComputedStyle(document.documentElement);
        return { background: pixel(style.backgroundColor), foreground: pixel(style.color), expectedBackground: pixel(token.getPropertyValue("--foreground")), expectedForeground: pixel(token.getPropertyValue("--background")) };
      });
      check(colors.background.every((component, index) => component === colors.expectedBackground[index]) && colors.foreground.every((component, index) => component === colors.expectedForeground[index]), name + "：统计口径气泡遵循 Arc 逆色主题，正文与背景使用同一套 token " + JSON.stringify(colors));
      await page.mouse.move(width - 1, 1);
      if (role === "admin") {
        const audience = page.locator(".oo-dashboard-audience");
        await audience.getByText("用户与密钥分析", { exact: true }).click();
        check(await activeAudience(audience).locator("tbody > tr").count() === 4, "展开分析后展示当前范围4个活跃用户");
        await audience.getByRole("tab", { name: "密钥", exact: true }).click();
        check(await activeAudience(audience).locator("tbody > tr").count() === 8, "密钥标签展示当前范围8个真实Key，而非复用用户列表");
        await audience.getByText("用户与密钥分析", { exact: true }).click();
      }
    }
    check(errors.length === 0, name + "：浏览器运行期错误为零 " + errors.join("; "));
    check(rejected.length === 0, name + "：没有 API 写入");
    await ctx.close();
    console.log("  ok " + name);
  }

  for (const role of ["admin", "user"]) {
    const { page, ctx, errors } = await open({ role, empty: true, missingRealtime: true });
    await overflow(page, "empty-" + role);
    check(await page.getByText("暂无", { exact: false }).count() > 0 || await page.getByText("尚未", { exact: false }).count() > 0, "空数据有明确引导，而非空白图卡");
    check(await page.locator(".oo-dashboard-metric").filter({ has: page.getByText("请求成功率", { exact: true }) }).innerText().then((text) => text.includes("—") && !text.includes("100%")), "无样本成功率是未知，不能显示100%或0%");
    check(errors.length === 0, "空数据无运行期错误");
    await screenshot(page, "dashboard-" + role + "-empty");
    await ctx.close();
  }

  {
    const { ctx, page, errors } = await open({ role: "user", debt: true });
    check(await page.getByText("账户欠费", { exact: true }).count() === 1, "负余额账户明确显示欠费");
    check(await page.locator(".oo-account-balance strong.is-danger").count() === 1, "欠费数字保留语义颜色");
    check(await page.getByText("账户余额不足，补足欠费后恢复调用", { exact: true }).count() === 1, "欠费账户有恢复调用的可执行说明");
    check(errors.length === 0, "欠费状态不产生运行期异常");
    await screenshot(page, "dashboard-user-debt");
    await ctx.close();
  }

  { // 首次接口失败不能伪造零数据；重试应恢复到真实样本。
    const { ctx, page, control, errors } = await open({ fail: true });
    check(await page.getByRole("alert").count() > 0, "初次接口失败显示正文错误说明");
    check(await page.locator(".oo-dashboard-metric").count() === 0, "未加载成功前不显示伪造零指标");
    await screenshot(page, "dashboard-initial-failure");
    control.fail = false;
    await page.getByRole("button", { name: /^重\s*试$/ }).click();
    await page.locator(".oo-dashboard-metric").first().waitFor();
    check(await page.getByRole("alert").count() === 0, "重试成功移除错误状态");
    control.fail = true;
    await page.getByRole("button", { name: /刷新.*看板/ }).click();
    await page.getByRole("alert").waitFor();
    check(await page.locator(".oo-dashboard-metric").count() === 4, "刷新失败保留上一次成功数字");
    check(await page.getByRole("alert").innerText().then((text) => /上次|保留/.test(text)), "保留数据明确说明可能过期");
    check(errors.length === 0, "失败和重试无页面异常");
    await screenshot(page, "dashboard-refresh-failure");
    await ctx.close();
  }

  { // 旧筛选请求后返回，不能覆盖最新范围。
    const { ctx, page, control, queries } = await open();
    control.delays["7d"] = 500;
    control.delays["90d"] = 20;
    await page.getByText("7 天", { exact: true }).click();
    await page.getByText("90 天", { exact: true }).click();
    await page.waitForTimeout(700);
    check(queries.some((query) => query.range === "7d") && queries.some((query) => query.range === "90d"), "快速切换确实发起两个统计请求");
    const expected = dashboardData(new URLSearchParams("range=90d"));
    check(await page.locator(".oo-dashboard-context").innerText().then((text) => text.includes(expected.trend[0].day) && text.includes(expected.trend.at(-1).day)), "竞态结束后标注最新90天首末日期");
    const callText = await page.locator(".oo-dashboard-metric").filter({ has: page.getByText("调用次数", { exact: true }) }).locator(".oo-stat-card-num").innerText();
    check([String(expected.totals.calls), expected.totals.calls.toLocaleString(), `${(expected.totals.calls / 1000).toFixed(1)}k`].some((value) => callText.includes(value)), "较慢7天响应不能覆盖90天总调用");
    await screenshot(page, "dashboard-range-race");
    await ctx.close();
  }

  { // 被管理员关闭的数据权限不应在页面里被补回。
    const { ctx, page, errors, queries } = await open({ role: "user", denied: true });
    check(await page.locator(".oo-dashboard-metric").count() === 0, "个人权限关闭后不展示用量指标");
    check(await page.locator(".oo-dashboard-recent").count() === 0, "记录权限关闭后没有最近调用表");
    check(!queries.some((query) => query.path === "/api/dashboard/admin" || query.path === "/api/dashboard/filters"), "受限用户没有管理员请求");
    check(await page.locator(".oo-dashboard").innerText().then((text) => !text.includes("25.0000") && !text.includes("累计消费")), "余额和消费权限关闭后不泄露数值");
    check(errors.length === 0, "权限关闭无运行期异常");
    await screenshot(page, "dashboard-user-restricted");
    await ctx.close();
  }

  { // 管理员换用户时必须清除旧用户密钥，目录与数据分别验证。
    const { ctx, page, control, queries, errors } = await open();
    const visibleOptions = page.getByRole("option");
    const userSelect = page.getByRole("combobox", { name: "筛选用户", exact: true });
    const tokenSelect = page.getByRole("combobox", { name: "筛选密钥", exact: true });
    await userSelect.click();
    await visibleOptions.filter({ hasText: /^林同学$/ }).click();
    await page.waitForTimeout(200);
    await tokenSelect.click();
    await visibleOptions.filter({ hasText: /生产服务.*林同学/ }).click();
    await page.waitForTimeout(200);
    check(queries.some((query) => query.path === "/api/dashboard/admin" && query.user === "11" && query.token === "22"), "用户与所属Key共同进入统计query");
    await userSelect.click();
    await visibleOptions.filter({ hasText: /^研发团队$/ }).click();
    await page.waitForTimeout(250);
    const last = queries.filter((query) => query.path === "/api/dashboard/admin").at(-1);
    check(last.user === "13" && (last.token == null || last.token === ""), "切换用户后旧用户密钥清除，不会产生误导零数据");
    await tokenSelect.click();
    check(await visibleOptions.filter({ hasText: /林同学/ }).count() === 0 && await visibleOptions.filter({ hasText: /研发团队/ }).count() === 2, "新用户密钥目录只包含其所属密钥");
    await page.keyboard.press("Escape");
    check(errors.length === 0, "用户/密钥交叉筛选没有页面异常");
    await screenshot(page, "dashboard-user-key-filter");
    control.fail = true;
    await userSelect.click();
    await visibleOptions.filter({ hasText: /^运营账号的较长显示名称$/ }).click();
    await page.getByRole("alert").waitFor();
    check(await page.locator(".oo-dashboard-context").innerText().then((text) => text.includes("研发团队") && !text.includes("运营账号")), "筛选失败保留旧数据时，范围身份仍标旧用户，不冒充新用户统计");
    check(await page.locator(".oo-page-head .oo-page-tags").innerText() === "筛选用量", "已筛选数据刷新失败仍保留对应身份标签");
    await page.getByText("7 天", { exact: true }).click();
    await page.waitForTimeout(200);
    const kept = dashboardData(new URLSearchParams("range=30d&user_id=13"));
    check(await page.locator(".oo-dashboard-context").innerText().then((text) => text.includes(kept.trend[0].day) && text.includes(kept.trend.at(-1).day)), "新范围加载失败仍标旧响应首末日期");
    await screenshot(page, "dashboard-filter-failure-kept-scope");
    await ctx.close();
  }

  {
    const { ctx, page, errors } = await open({ unknownStatus: true });
    const first = page.locator(".oo-dashboard-recent tbody > tr").first();
    check((await first.innerText()).includes("其他状态") && !(await first.innerText()).includes("成功"), "未知非空状态不能借消费日志type2猜作成功");
    const expected = dashboardData(new URLSearchParams("range=30d"), { unknownStatus: true });
    const visibleResults = await page.getByRole("region", { name: "请求结果", exact: true }).locator("dd > span").allTextContents();
    check(visibleResults.length === 5 && visibleResults.reduce((sum, text) => sum + Number(text.replaceAll(",", "")), 0) === expected.totals.calls, "未知状态单列且所有构成仍合计总请求");
    check(await page.getByRole("region", { name: "请求结果", exact: true }).innerText().then((text) => text.includes("其他状态")), "请求构成明确展示其他状态数量");
    check(errors.length === 0, "未知旧状态兼容无运行错误");
    await screenshot(page, "dashboard-unknown-status");
    await ctx.close();
  }

  {
    const { ctx, page, errors } = await open({ truncatedAudience: true });
    const expected = dashboardData(new URLSearchParams("range=30d"), { truncatedAudience: true });
    const audience = page.locator(".oo-dashboard-audience");
    await audience.getByText("用户与密钥分析", { exact: true }).click();
    const percentages = async (rows) => {
      const displayed = await activeAudience(audience).locator("tbody > tr td:last-child").allTextContents();
      check(displayed.length === 2, "只返回两项时榜单展示对应两行");
      check(displayed.every((text, index) => Math.abs(parseFloat(text) - rows[index].units / expected.totals.units * 100) <= 0.51), "截断排行仍以区间全量消费为占比分母");
      check(displayed.reduce((sum, text) => sum + parseFloat(text), 0) < 90, "两项不被重新归一化成100%，不伪造全量覆盖");
    };
    await percentages(expected.top_users);
    await audience.getByRole("tab", { name: "密钥", exact: true }).click();
    await percentages(expected.top_tokens);
    check(errors.length === 0, "截断用户/密钥分析无页面异常");
    await screenshot(page, "dashboard-truncated-audience");
    await ctx.close();
  }
  }
  { // 渠道列表必须能查看Top12之后的渠道；卡片自己的横滚不能撑宽页面。
    const expected = dashboardData(new URLSearchParams("range=30d"), { manyChannels: true });
    check(expected.by_channel.length === 16, "专项样本含16个实际有调用的渠道");
    check(expected.by_channel.reduce((sum, channel) => sum + channel.calls, 0) === expected.totals.calls, "16渠道分项与全部调用总数相符");
    for (const width of [1440, 390]) {
      const { ctx, page, errors, rejected } = await open({ width, manyChannels: true });
      const channelCard = page.locator(".oo-dashboard-channels");
      check(await channelCard.locator("tbody > tr").count() === 6, `${width}px渠道页每页6行，不拉长卡片`);
      const seen = new Set();
      for (let pageIndex = 1; pageIndex <= 3; pageIndex++) {
        if (pageIndex > 1) await channelCard.getByRole("button", { name: `Page ${pageIndex}`, exact: true }).click();
        (await channelCard.locator(".oo-dashboard-channel b").allTextContents()).forEach((name) => seen.add(name.trim()));
      }
      check(seen.size === 16 && expected.by_channel.every((channel) => seen.has(channel.name)), `${width}px可完整翻页查看全部16渠道，不截掉Top12之后的数据`);
      check(await channelCard.locator("tbody > tr").count() === 4, `${width}px末页恰为剩余4渠道`);
      if (width === 390) {
        const scroll = await tableScroll(channelCard.locator("table"));
        check(scroll.scrollWidth > scroll.width && scroll.scrollLeft > 0 && scroll.overflowX === "auto", "手机渠道卡能内部横滚到费用列 " + JSON.stringify(scroll));
      }
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px渠道翻页与内部滚动不导致外层横向溢出`);
      check(errors.length === 0, `${width}px渠道分页无运行期错误`);
      check(rejected.length === 0, "渠道分页只读，不触发业务写入");
      await screenshot(page, `dashboard-16-channels-${width}`);
      await ctx.close();
    }
  }
  console.log(`数据看板隔离浏览器验收 ${passed} 项通过；API 写入、真实数据库及真实上游请求均为 0`);
} catch (error) {
  if (output && lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
