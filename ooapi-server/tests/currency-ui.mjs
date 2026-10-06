// 浏览器展示回归：仅拦截页面响应构造边界值，不改用户、余额或系统设置。
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
const base = process.env.BASE || 'http://127.0.0.1:4115';
const dir = process.env.CURRENCY_SCREENSHOTS || '/var/tmp/ooapi-currency-evidence';
const [[admin]] = await pool.query('SELECT id,role,token_version FROM users WHERE role >= 100 LIMIT 1');
assert(admin);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
await context.addInitScript(token => localStorage.setItem('ooapi-token', token), signToken(admin));
await fs.mkdir(dir, { recursive: true });
const p = await context.newPage(), errors = [];
p.on('pageerror', e => errors.push(e.message));
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log('  ok ' + label); };
const shot = name => p.screenshot({ path: `${dir}/${name}.png`, fullPage: true, animations: 'disabled' });
const cleanUnits = async (root = 'body') => check(!/OD\s*币/.test(await p.locator(root).innerText()), `${root} 无可见文字币种`);
const suffixes = async () => check(await p.locator('.oo-od-amount').evaluateAll(items => items.every(e => {
  const coin = e.querySelector('svg'); if (!coin) return !/\d/.test(e.textContent);
  const num = e.querySelector('.oo-num').getBoundingClientRect(), box = coin.getBoundingClientRect();
  return coin === e.lastElementChild && box.left >= num.right - 1;
})), '金额图标位于数字之后，未知值无假零');
try {
  await p.goto(base + '/admin/users', { waitUntil: 'networkidle' });
  await p.locator('.oo-user-identity').first().waitFor();
  check(await p.locator('.oo-user-identity > span').count() > 0, '实际用户列表包含统一头像');
  await cleanUnits(); await suffixes(); await shot('users-actual');
  check(await p.locator('.oo-sider-foot').count() === 0, '删除侧栏底部返回首页');
  check(await p.locator('.oo-brand').getAttribute('href') === '/', 'Logo 和标题为首页链接');
  await p.setViewportSize({ width: 1440, height: 640 });
  const nav = p.locator('.oo-sider .oo-nav');
  check(await nav.evaluate(e => getComputedStyle(e).scrollbarWidth === 'none' && getComputedStyle(e, '::-webkit-scrollbar').display === 'none'), '侧栏不显示滚动条');
  await nav.hover(); await p.mouse.wheel(0, 1500);
  await p.waitForFunction(() => document.querySelector('.oo-sider .oo-nav').scrollTop > 0);
  check(await nav.locator('.oo-nav-item').last().isVisible(), '低视口仍可滚动到末尾菜单');
  await p.locator('.oo-brand').focus(); await p.keyboard.press('Enter'); await p.waitForURL(base + '/');
  check(true, 'Logo 支持键盘回到首页');
  await p.setViewportSize({ width: 1680, height: 1000 });
  // 图片头像、小数精度、零、欠费、未知余额分别覆盖，fixture不会写回服务器。
  const fixture = { id: 91001, username: 'currency_fixture', display_name: '头像与精度验收', role: 1, status: 1, quota: 9999850, used_quota: 1, request_count: 1, created_time: 1750000000,
    avatar_url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" rx="15" fill="#2563eb"/></svg>') };
  await p.route('**/api/users/?*', route => route.fulfill({ json: { success: true, data: { total: 4, items: [fixture, { ...fixture, id: 91002, username: 'zero', display_name: '零值', avatar_url: '', quota: 0, used_quota: 0 }, { ...fixture, id: 91003, username: 'debt', display_name: '欠费', avatar_url: '/missing-avatar-fixture.png', quota: -1, used_quota: 10 }, { ...fixture, id: 91004, username: 'unknown', display_name: '未知', avatar_url: '', quota: null, used_quota: null }] } } }));
  await p.goto(base + '/admin/users', { waitUntil: 'networkidle' });
  const row = p.locator('tr[data-row-key="91001"]');
  await row.waitFor();
  check(await row.locator('.oo-user-identity img').evaluate(e => e.complete && e.naturalWidth > 0), '上传头像正确加载');
  check((await row.innerText()).includes('999.99') && (await row.innerText()).includes('0.0001'), '余额与已用精度保持');
  check(await p.locator('tr[data-row-key="91002"] .oo-user-identity img').count() === 0, '无头像使用统一默认头像');
  check(await p.locator('tr[data-row-key="91003"] .oo-user-identity img').count() === 0, '损坏头像回退默认头像');
  check((await p.locator('tr[data-row-key="91003"]').innerText()).includes('-0.0001'), '微小欠费保留精度，不显示负零');
  check(await p.locator('tr[data-row-key="91002"] .oo-od-amount svg').count() === 2, '零余额仍有单位图标');
  check(await p.locator('tr[data-row-key="91004"] .oo-od-amount svg').count() === 0, '未知余额不冒充零');
  await cleanUnits(); await suffixes(); await shot('users-boundaries-light');
  await row.getByRole('button', { name: '额度', exact: true }).click();
  await p.getByRole('dialog').waitFor();
  await p.waitForFunction(() => {
    const modal = document.querySelector('.oo-users-quota-modal');
    return modal && !modal.className.includes('ant-zoom') && getComputedStyle(modal).opacity === '1' && modal.getBoundingClientRect().width > 400;
  });
  check(await p.getByRole('dialog').locator('.ant-input-number-suffix .oo-od-coin').count() === 1, '调整额度输入框单位为末尾图标');
  await cleanUnits('.ant-modal-content'); await shot('quota-dialog');
  await p.getByRole('dialog').locator('.ant-modal-close').click();
  await p.evaluate(() => localStorage.setItem('ooapi-color-mode', 'dark'));
  await p.reload({ waitUntil: 'networkidle' }); await shot('users-boundaries-dark');
  await p.unroute('**/api/users/?*');
  await p.evaluate(() => localStorage.setItem('ooapi-color-mode', 'light'));
  for (const path of ['/console', '/admin/dashboard', '/token', '/pricing', '/admin/pricing', '/log', '/operation-log', '/profile', '/admin/monitor', '/admin/channel']) {
    await p.goto(base + path, { waitUntil: 'networkidle' });
    await cleanUnits(); await suffixes();
    if (path === '/log' && await p.getByRole('button', { name: '查看计费明细' }).count()) {
      await p.getByRole('button', { name: '查看计费明细' }).first().hover();
      await p.locator('.oo-billing-popover:visible').waitFor(); await cleanUnits('.oo-billing-popover:visible');
      await shot('billing-hover');
    }
  }
  // 对话正文将币名渲染成图标；代码和复制源文本保持原样。
  const session = { id: 'currency-fixture', title: '金额渲染验收', model: 'deepseek-flash', agent: 'general', settings: {}, todo: [], cost: 0.001, message_count: 1 };
  await p.route('**/api/chat/sessions?*', route => route.fulfill({ json: { success: true, data: { sessions: [session], counts: { active: 1, archived: 0 } } } }));
  await p.route('**/api/chat/sessions/currency-fixture', route => route.fulfill({ json: { success: true, data: { session, messages: [{ id: 1, seq: 1, role: 'assistant', status: 'success', cost: 0.001, tokens: { prompt: 10, completion: 10 }, parts: [{ id: 'text', type: 'text', text: '余额 **10 OD币**，消费 0.0001 OD。\n\n```txt\n10 OD币\n```' }, { id: 'account', type: 'tool', tool: 'account', name: '我的账号', status: 'done', args: { action: 'overview' }, output: '余额：10 OD币' }] }] } } }));
  await p.route('**/api/chat/sessions/currency-fixture/running', route => route.fulfill({ json: { success: true, data: { running: false } } }));
  await p.goto(base + '/chat?s=currency-fixture', { waitUntil: 'networkidle' });
  await p.locator('.prose').waitFor();
  check(await p.locator('.prose .oo-od-coin').count() === 2, '普通与加粗对话金额使用图标');
  check((await p.locator('.prose code').innerText()).includes('10 OD币'), '代码内容保留原文');
  await p.locator('.bui-toolchip-head').click();
  check(await p.locator('.bui-toolchip-body .oo-od-coin').count() === 1, '账号工具结果也使用统一图标');
  await cleanUnits('.bui-toolchip-body');
  await suffixes(); await shot('chat-currency');
  await p.goto(base + '/admin/settings?tab=billing', { waitUntil: 'networkidle' });
  check((await p.locator('.oo-admin-fixed-currency').innerText()).includes('OD币'), '系统计费设置保留币种文字');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(base + '/admin/users', { waitUntil: 'networkidle' }); await shot('users-mobile');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '移动端无整页横向溢出');
  await p.getByRole('button', { name: '打开导航' }).click();
  const mobileNav = p.locator('.ant-drawer .oo-nav'); await mobileNav.waitFor();
  check(await mobileNav.evaluate(e => getComputedStyle(e).scrollbarWidth === 'none'), '移动侧栏也隐藏滚动条');
  await mobileNav.locator('.oo-nav-item').last().focus();
  check(await mobileNav.evaluate(e => e.scrollTop > 0), '移动侧栏键盘聚焦自动滚动');
  await shot('sidebar-mobile');
  await p.locator('.ant-drawer .oo-brand').click(); await p.waitForURL(base + '/');
  check(await p.locator('.ant-drawer:visible').count() === 0, '移动 Logo 返回首页并关闭导航');
  check(errors.length === 0, '无浏览器运行错误');
  console.log(JSON.stringify({ passed: true, checks, screenshots: dir }));
} catch (error) {
  await shot('failure'); console.error(JSON.stringify({ failed: true, message: error.message, errors })); throw error;
} finally { await browser.close(); await pool.end(); }
