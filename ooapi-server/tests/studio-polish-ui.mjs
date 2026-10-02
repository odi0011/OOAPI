// 本地公开界面验收：真实主题过渡、剪贴板和响应式布局，不调用付费上游。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:3012';
assert.ok(/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE), '仅允许本地预览');
const output = path.join(os.tmpdir(), 'ooapi-polish-review');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const errors = []; let checks = 0, writes = 0, upstream = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('  ok ' + label); };
const waitTheme = (page, mode) => page.waitForFunction(mode => document.documentElement.dataset.theme === mode && !document.querySelector('.oo-theme-toggle-switch.is-switching'), mode);
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.studio-window-scroll')].every(e => e.scrollWidth <= e.clientWidth + 1));
const revealQuickstart = async page => {
  await page.locator('#quickstart').evaluate(e => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('#quickstart')?.classList.contains('is-revealed'));
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('polish-initialized')) { localStorage.setItem('ooapi-color-mode', 'light'); localStorage.setItem('polish-initialized', '1'); }
    window.themeAnimations = [];
    window.previousThemes = [];
    new MutationObserver(records => records.forEach(r => { if (r.target === document.documentElement && r.attributeName === 'data-theme') previousThemes.push(r.oldValue); })).observe(document, { subtree: true, attributes: true, attributeOldValue: true });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (options?.pseudoElement) window.themeAnimations.push({ frames, options });
      return animate.call(this, frames, options);
    };
  });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/v1/')) upstream++; if (r.url().includes('/api/option') && r.method() !== 'GET') writes++; });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const toggle = page.locator('.oo-theme-toggle-switch');
  check('首页顶部提供主题切换而非暂停按钮', await toggle.count() === 1 && await page.locator('.studio-header').getByRole('button', { name: '暂停动效' }).count() === 0);
  check('滑块尺寸未被后台预览样式污染', await page.locator('.oo-theme-toggle-thumb').evaluate(e => { const r = e.getBoundingClientRect(); return r.width === 22 && r.height === 22; }));
  await toggle.click(); await waitTheme(page, 'dark');
  check('明暗切换实际执行圆形过渡动画', await page.evaluate(() => themeAnimations.some(a => a.options.pseudoElement === '::view-transition-new(root)' && a.options.duration >= 600 && a.frames[0].clipPath.includes('circle(0px'))));
  check('切换后同步加载夜景壁纸', await page.locator('.studio-desktop-wallpaper').getAttribute('data-wallpaper-mode') === 'dark');
  await page.reload({ waitUntil: 'networkidle' }); await waitTheme(page, 'dark');
  check('刷新后保留个人明暗偏好', await toggle.getAttribute('aria-pressed') === 'true');
  check('刷新首帧没有先闪回亮色', await page.evaluate(() => !previousThemes.includes('light')));
  const second = await ctx.newPage(); await second.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await toggle.click(); await waitTheme(page, 'light'); await waitTheme(second, 'light');
  check('个人主题在同一浏览器的其他标签同步', true); await second.close();
  await toggle.evaluate(e => { e.click(); e.click(); }); await waitTheme(page, 'dark');
  check('连续点击不会叠加切换动画', await toggle.getAttribute('aria-pressed') === 'true');
  await toggle.click(); await waitTheme(page, 'light');
  await revealQuickstart(page);
  const endpoint = await page.locator('.qs-endpoint code').innerText();
  for (const [language, expected] of [['cURL', 'Authorization: Bearer $OOAPI_API_KEY'], ['Python', 'client.models.list().data'], ['Node.js', 'await client.models.list()']]) {
    await page.locator('#quickstart').getByText(language, { exact: true }).click();
    await page.getByRole('button', { name: '复制示例', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(language + '复制完整示例且不包含行号', copied.includes(endpoint) && copied.includes(expected) && !/^1\s/.test(copied));
  }
  await page.getByRole('button', { name: '复制 API 地址', exact: true }).click();
  check('API 地址可单独复制', await page.evaluate(() => navigator.clipboard.readText()) === endpoint);
  await page.locator('#qs-tab-2').focus(); await page.keyboard.press('ArrowLeft');
  check('接入步骤支持键盘且切换代码内容', await page.locator('#qs-tab-1').getAttribute('aria-selected') === 'true' && !(await page.locator('.qs-code').innerText()).includes('models.list'));
  await page.locator('#qs-tab-0').click();
  check('准备步骤包含所选 SDK 的安装命令', (await page.locator('.qs-code').innerText()).includes('npm install openai'));
  await page.locator('#qs-tab-2').click(); await page.locator('#quickstart').getByText('Python', { exact: true }).click();
  await page.locator('.ant-message-notice').last().waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'quickstart-light.png'), animations: 'disabled' });
  await toggle.click(); await waitTheme(page, 'dark'); await revealQuickstart(page);
  await page.screenshot({ path: path.join(output, 'quickstart-dark.png'), animations: 'disabled' });
  for (const [route, mode] of [['login', 'light'], ['register', 'dark']]) {
    await page.goto(BASE + '/' + route, { waitUntil: 'networkidle' });
    if (await page.locator('html').getAttribute('data-theme') !== mode) { await toggle.click(); await waitTheme(page, mode); }
    const nav = page.getByRole('navigation', { name: '功能预览' });
    await nav.getByRole('button', { name: /令牌/ }).click();
    check(route + '左侧可预览应用令牌', await page.locator('.auth-token-preview').isVisible());
    await nav.getByRole('button', { name: /记录/ }).click();
    check(route + '左侧可预览调用记录', await page.locator('.auth-log-row').count() === 4);
    await nav.getByRole('button', { name: /对话/ }).click();
    check(route + '小猫透明素材不再附带卡片边框', await page.locator('.auth-mascot .studio-cat').evaluate(e => getComputedStyle(e).borderTopWidth === '0px'));
    check(route + '桌面布局没有横向溢出', await noOverflow(page));
    await page.screenshot({ path: path.join(output, route + '-' + mode + '.png'), animations: 'disabled' });
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['', 'login', 'register']) {
      await page.goto(BASE + '/' + route, { waitUntil: 'networkidle' });
      if (!route) { await revealQuickstart(page); await page.screenshot({ path: path.join(output, 'quickstart-' + width + '.png'), animations: 'disabled' }); }
      else await page.screenshot({ path: path.join(output, route + '-' + width + '.png'), fullPage: true, animations: 'disabled' });
      check(`${route || '首页接入指南'} ${width}px 无横向溢出`, await noOverflow(page));
    }
  }
  await ctx.close();
  for (const reduced of [true, false]) {
    const fallback = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    if (!reduced) await fallback.addInitScript(() => { document.startViewTransition = undefined; });
    const p = await fallback.newPage(); await p.goto(BASE, { waitUntil: 'networkidle' });
    const before = await p.locator('html').getAttribute('data-theme');
    await p.locator('.oo-theme-toggle-switch').click(); await waitTheme(p, before === 'dark' ? 'light' : 'dark');
    check(reduced ? '减少动态效果时仍可切换主题' : '无 View Transition 支持时可正常切换主题', true); await fallback.close();
  }
  check('交互不修改站点配置、不调用付费上游', writes === 0 && upstream === 0);
  check('公开页面无运行期错误', errors.length === 0);
  console.log(`Studio polish ${checks}/${checks} passed; ${output}`);
} finally { await browser.close(); }
