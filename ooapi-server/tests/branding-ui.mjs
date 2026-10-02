// 真实浏览器验证管理员品牌配置；只操作本地隔离库，结束后恢复三个设置。
import 'dotenv/config';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
const BASE = process.env.BASE || 'http://127.0.0.1:3012';
const [[db]] = await pool.query('SELECT DATABASE() AS name');
assert.ok(/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE) && /^ooapi_home_/.test(db.name), '仅允许本地隔离候选库');
const [[admin]] = await pool.query('SELECT id,role,token_version FROM users WHERE role >= 1000 LIMIT 1');
const token = signToken(admin);
async function api(route, body) {
  const r = await fetch(BASE + '/api' + route, { method: body ? 'PUT' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await r.json(); assert.ok(r.ok && d.success, route); return d.data;
}
const options = await api('/option');
const saved = Object.fromEntries(['system_name', 'logo', 'favicon'].map(k => [k, options[k]]));
const logo = '/icons/openai.svg?studio-brand-check', favicon = '/icons/zhipu.svg?studio-icon-check';
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let checks = 0; const errors = [];
function check(label, value) { assert.ok(value, label); checks++; console.log('  ok ' + label); }
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(t => localStorage.setItem('ooapi-token', t), token);
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE + '/admin/settings?tab=site', { waitUntil: 'networkidle' });
  await p.getByRole('textbox', { name: '系统名称', exact: true }).fill('Studio QA');
  await p.getByRole('textbox', { name: 'Logo 地址', exact: true }).fill(logo);
  await p.getByRole('textbox', { name: '站点图标', exact: true }).fill(favicon);
  check('管理员修改 Logo 地址立即显示预览', await p.locator('.oo-admin-setting-row--image img').first().getAttribute('src') === logo);
  await p.getByRole('button', { name: '保存站点设置', exact: true }).click();
  await p.getByText('设置已保存', { exact: true }).waitFor();
  const stored = await api('/option');
  check('品牌名称与两个图标真实保存', stored.system_name === 'Studio QA' && stored.logo === logo && stored.favicon === favicon);
  check('后台导航同步新 Logo', await p.locator('.oo-brand img').getAttribute('src') === logo);
  check('浏览器 favicon 使用独立设置', await p.locator('link[rel=icon]').getAttribute('href') === favicon);
  await p.goto(BASE, { waitUntil: 'networkidle' });
  for (const selector of ['.studio-brand', '.studio-wordmark', '.studio-start-card', '.studio-flow-hub', '.bento-connector']) {
    check(selector + ' 使用统一 Logo', await p.locator(selector + ' [data-brand-logo]').getAttribute('src') === logo);
    check(selector + ' 使用配置的品牌名称', (await p.locator(selector).innerText()).includes('Studio QA'));
  }
  await p.getByRole('tab', { name: '选择模型与厂商' }).click();
  check('厂商网络中心使用站点 Logo', await p.locator('.studio-network-center img').getAttribute('src') === logo);
  check('第三方厂商保持独立品牌图标', await p.locator('.studio-network-node img').first().getAttribute('src') !== logo);
  const shortcut = p.locator('.studio-shortcuts a').first(); await shortcut.hover(); await p.waitForTimeout(700);
  check('两侧快捷入口白色且 hover 无矩形背景边框', await shortcut.evaluate(e => { const s = getComputedStyle(e); return s.color === 'rgb(255, 255, 255)' && s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.borderTopWidth === '0px'; }));
  check('悬停光晕与图标弹性位移生效', await shortcut.evaluate(e => getComputedStyle(e, '::before').opacity === '1' && getComputedStyle(e.firstElementChild).transform !== 'none'));
  const guest = await browser.newContext(); const auth = await guest.newPage(); auth.on('pageerror', e => errors.push(e.message));
  for (const route of ['/login', '/register']) { await auth.goto(BASE + route, { waitUntil: 'networkidle' }); check(route + ' 使用管理员品牌图', await auth.locator('.studio-brand img').getAttribute('src') === logo && await auth.locator('.studio-auth-scene-label').innerText().then(s => s.includes('Studio QA'))); }
  await api('/option', { favicon: '' }); await auth.reload({ waitUntil: 'networkidle' });
  check('清空独立 favicon 后回落当前 Logo', await auth.locator('link[rel=icon]').getAttribute('href') === logo);
  await auth.route('**/api/status', async route => { const res = await route.fetch(); const d = await res.json(); d.data.logo = '/missing-brand-fixture.png'; await route.fulfill({ json: d }); });
  await auth.reload({ waitUntil: 'networkidle' });
  await auth.waitForFunction(() => document.querySelector('.studio-brand img')?.getAttribute('src') === '/logo.jpg');
  check('坏图地址回落默认 Logo', true);
  await guest.close(); await ctx.close(); check('品牌配置无浏览器运行期错误', errors.length === 0);
  console.log(`Branding UI ${checks}/${checks} passed`);
} finally {
  await browser.close(); await api('/option', saved).catch(() => { console.error('恢复隔离库品牌配置失败'); process.exitCode = 1; }); await pool.end();
}
