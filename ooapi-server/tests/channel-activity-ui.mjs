// 使用候选构建产物与受控 HTTP 样本做真实浏览器审查；不读凭据，不连 DB 或上游。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { publicProviders } from "../src/services/channel-types.js";
import { serveCandidate, installSmokeFixtures, smokeFixtureData } from "./ui-smoke-fixtures.mjs";

const sec = (iso) => Date.parse(iso) / 1000;
const generatedAt = sec("2026-10-05T05:30:00Z");
const midnight = sec("2026-10-04T16:00:00Z");
const byHour = Array.from({ length: 30 * 24 }, (_, i) => ({ time: midnight - 29 * 86400 + i * 3600, tokens: (i % 17) * 310 * (Math.floor(i / 24) % 7 + 1), calls: i % 5 })).filter((h) => h.time <= generatedAt);
const byDay = Array.from({ length: 365 }, (_, i) => ({ day: new Date((midnight - (364 - i) * 86400 + 8 * 3600) * 1000).toISOString().slice(0, 10), tokens: i >= 335 ? (i % 7 + 1) * 10000 : 0, calls: i >= 335 ? i % 7 + 1 : 0, units: 0, cacheTokens: 0, avgElapsed: 1000 }));
const channel = { id: 7, name: "隔离热力图渠道", type: "openai", status: 1, models: ["gpt-test"], groups: [], recent_calls: [], has_credential: true, isApiKey: true, priority: 0, weight: 1, totals: { calls: 10, tokens: 3000, units: 0 } };
const recent = Array.from({ length: 10 }, (_, i) => ({ t: generatedAt - i * 60, ok: true, m: "gpt-test", b: "gpt-test-upstream", k: "chat", ms: 1000 + i * 500, ft: 1000 + i * 500, p: "隔离测试提示词", r: "仅使用内存样本，无真实上游调用", u: { n: "测试用户", a: "/icons/openai.svg" } }));
const hourly = Array.from({ length: 7 }, (_, wd) => Array.from({ length: 24 }, (_, hour) => ({ hour, calls: (wd + hour) % 5, units: 0 })));
const server = await serveCandidate();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const output = process.env.SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
let passed = 0, lastPage;
const check = (value, message) => { assert.ok(value, message); passed++; };
try {
  for (const width of [1440, 1165, 390, 320]) for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await ctx.addInitScript((mode) => localStorage.setItem("ooapi-color-mode", mode), theme);
    let empty = false;
    const rejected = await installSmokeFixtures(ctx, (pathname) => {
      if (pathname === "/api/channel/") return [channel];
      if (pathname === "/api/channel/providers") return publicProviders();
      if (pathname === "/api/channel/stats") return { total: 1, enabled: 1, disabled: 0, byType: { openai: 1 } };
      if (pathname === "/api/channel/7/stats") return { generatedAt, timezone: "Asia/Shanghai", days: 365, channel, byHour: empty ? [] : byHour, byDay, recent, series: [{ model: "gpt-test", values: byDay.map((d) => d.tokens) }], totals: { calls: 10, tokens: 3000, units: 0, od: 0 } };
      if (pathname === "/api/log/usage/analysis") return { byDay: byDay.slice(-7), byModel: [{ model: "gpt-test", calls: 10, units: 0 }], hourly, modelSeries: [] };
      return smokeFixtureData(pathname);
    });
    const page = await ctx.newPage(); lastPage = page;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.base + "/admin/channel", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "隔离热力图渠道 用量统计", exact: true }).click();
    const activity = page.locator(".oo-channel-activity");
    await activity.waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".oo-stats-modal")).opacity) > 0.99);
    check(await activity.locator(".oo-heat-grid, .oo-heat-cell").count() === 0, "渠道活动图不继承旧共享 heat class");
    for (const [mode, count, columns] of [["每日", 24, 6], ["每周", 7, 7], ["每月", 30, 7]]) {
      await activity.getByText(mode, { exact: true }).click();
      const cells = activity.locator(".oo-channel-activity-grid button");
      check(await cells.count() === count, `${width} ${theme} ${mode}: 实际格子数 ${count}`);
      const dimensions = await cells.evaluateAll((nodes) => nodes.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
      check(dimensions.every((r) => Math.abs(r.width - r.height) < 0.1 && r.width >= 15), `${mode} 格子是正方形`);
      check(dimensions.every((r) => r.x >= 0 && r.x + r.width <= width + 1), `${width} ${mode} 每个格子在视口内`);
      const css = await activity.locator(".oo-channel-activity-grid").evaluate((el) => ({ columns: getComputedStyle(el).gridTemplateColumns.split(" ").length, rowGap: parseFloat(getComputedStyle(el).rowGap), width: el.clientWidth, overflow: el.scrollWidth }));
      check(css.columns === columns && css.rowGap >= 8 && css.overflow <= css.width + 1, `${width} ${mode} 上下间距 >=8px 且网格不溢出 ${JSON.stringify(css)}`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${mode} 页面不横向溢出`);
      const target = cells.first();
      await target.scrollIntoViewIfNeeded();
      await target.focus();
      await target.press("Tab");
      check(await cells.nth(1).evaluate((el) => el === document.activeElement), "格子键盘 Tab 顺序正确");
      await cells.nth(1).focus();
      const focusedStyle = await cells.nth(1).evaluate((el) => getComputedStyle(el).outlineWidth);
      check(parseFloat(focusedStyle) >= 2, "键盘焦点有明显外框");
      const focusedTip = page.locator(".ant-tooltip:not(.ant-tooltip-hidden)").last();
      await focusedTip.waitFor();
      check((await focusedTip.innerText()).includes("UTC+8"), "键盘聚焦也显示时段明细");
      await target.hover();
      const tip = page.locator(".ant-tooltip:not(.ant-tooltip-hidden)").last();
      await tip.waitFor();
      const text = await tip.innerText();
      check(text.includes("UTC+8") && text.includes("tokens") && text.includes("次调用"), `${mode} 悬浮含真实窗口/token/调用数`);
      const bg = await tip.locator(".ant-tooltip-inner").evaluate((el) => {
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
      });
      check(theme === "dark" || bg.slice(0, 3).every((v) => v >= 248), "浅色 tooltip 为白色背景");
      await page.mouse.move(width - 1, 1);
      await page.locator(".oo-stats-modal .ant-modal-title").click();
      await page.waitForTimeout(350); // 截图需等 Segmented 滑块、Tooltip 退出过渡结束。
      if (mode === "每月") {
        check(await activity.locator(".oo-channel-activity-weekdays span").allTextContents().then((labels) => labels.join("") === "一二三四五六日"), "月视图星期头周一至周日");
        check(await activity.locator(".oo-channel-activity-grid > span[aria-hidden]").count() === 6, "月视图日期按星期对齐");
      }
      if (output) await page.screenshot({ path: path.join(output, `channel-activity-${width}-${theme}-${mode}.png`), fullPage: true });
    }
    await activity.getByText("每日", { exact: true }).click();
    check(await activity.locator("button.is-future").count() === 10, "北京13:30之后10个未来小时单独标记");
    const future = activity.locator("button.is-future").first();
    check((await future.getAttribute("aria-label")).includes("尚未到此时段"), "未来时段无误导消费提示");
    const closeBox = await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).boundingBox();
    check(closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= 1000, "长弹窗关闭按钮始终在视口内");
    if (width === 1440 && theme === "light") {
      await page.setViewportSize({ width, height: 720 });
      await activity.getByText("每月", { exact: true }).click();
      await activity.locator(".oo-channel-activity-grid button").last().scrollIntoViewIfNeeded();
      const scrolls = await page.locator(".oo-stats-layout").evaluate((el) => {
        const data = el.querySelector(".oo-stats-layout-data"), recent = el.querySelector(".oo-stats-layout-recent");
        data.scrollTop = data.scrollHeight;
        return { data: getComputedStyle(data).overflowY, recent: getComputedStyle(recent).overflowY, leftScroll: data.scrollTop, recentScroll: recent.scrollTop, leftScrollbar: getComputedStyle(data).scrollbarWidth };
      });
      check(scrolls.data === "auto" && scrolls.leftScroll > 0 && scrolls.leftScrollbar === "none" && scrolls.recentScroll === 0, "720px桌面左侧独立滚动且隐藏滚动条，不联动右侧");
      const shortClose = await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).boundingBox();
      check(shortClose && shortClose.y >= 0 && shortClose.y + shortClose.height <= 720, "720px桌面滚动后关闭按钮在视口内");
      if (output) await page.screenshot({ path: path.join(output, "channel-activity-1440-720-light.png"), fullPage: true });
      await page.setViewportSize({ width, height: 430 });
      const rightScroll = await page.locator(".oo-stats-layout").evaluate((el) => {
        const data = el.querySelector(".oo-stats-layout-data"), recent = el.querySelector(".oo-stats-recent");
        const before = data.scrollTop;
        recent.scrollTop = recent.scrollHeight;
        return { after: data.scrollTop, before, right: recent.scrollTop, overflow: getComputedStyle(recent).overflowY };
      });
      check(rightScroll.right > 0 && rightScroll.after === rightScroll.before && rightScroll.overflow === "auto", "430px短窗口右侧记录独立滚动，不联动左侧");
      if (output) await page.screenshot({ path: path.join(output, "channel-activity-1440-430-light.png"), fullPage: true });
      await page.setViewportSize({ width, height: 1000 });
    }
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    empty = true;
    await page.getByRole("button", { name: "隔离热力图渠道 用量统计", exact: true }).click();
    await activity.getByText("此时间范围暂无调用", { exact: true }).waitFor();
    check(await activity.locator(".oo-channel-activity-grid button.lv0").count() === 24, "空数据依然显示24个空时段");
    await page.goto(server.base + "/log", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "展开分析", exact: true }).click();
    const usageGrid = page.locator(".oo-analysis .oo-heat-grid");
    await usageGrid.waitFor();
    check(await usageGrid.locator(".oo-heat-cell").count() === 168, "原 UsageAnalysis 7×24 图保留全部168格");
    const gridCss = await usageGrid.evaluate((el) => ({ cols: getComputedStyle(el).gridTemplateColumns.split(" ").length, flow: getComputedStyle(el).gridAutoFlow, rows: getComputedStyle(el).gridTemplateRows.split(" ").length }));
    check(gridCss.cols === 25 && gridCss.flow === "row" && gridCss.rows === 8, "使用分析图独立25列/8行，不受旧yeargrid column流污染");
    await usageGrid.locator(".oo-heat-cell").first().hover();
    check((await page.locator(".oo-analysis .oo-heat-foot").innerText()).includes("周一 00:00"), "使用分析图悬浮显示正确时段");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} 使用分析没有页面横向溢出`);
    check(!(await page.locator(".oo-page").innerText()).includes("NaN"), "完整 summary 夹具不会产生无效数字");
    if (output) await page.screenshot({ path: path.join(output, `usage-analysis-${width}-${theme}.png`), fullPage: true });
    check(errors.length === 0, "无页面运行错误：" + errors.join("; "));
    check(rejected.length === 0, "专项只有 GET，不触发写入");
    console.log(`  ok 隔离 Chromium ${width}px ${theme}: 三种活动窗口、悬浮、键盘、空数据、使用分析`);
    await ctx.close();
  }
  console.log(`渠道活动浏览器回归 ${passed} 项通过；真实数据库/上游请求 0`);
} catch (error) {
  if (output && lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
