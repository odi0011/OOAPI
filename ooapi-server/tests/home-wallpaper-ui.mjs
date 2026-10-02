// 保存 / 明暗切换 / 坏图回退走真实接口与浏览器，只在本地隔离库运行并恢复设置。
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3012';
const [[db]] = await pool.query('SELECT DATABASE() AS name');
assert.ok(/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE) && /^ooapi_home_/.test(db.name), '仅允许本地隔离候选库');
const [[admin]] = await pool.query('SELECT id,role,token_version FROM users WHERE role >= 100 LIMIT 1');
assert.ok(admin, '隔离候选库需有管理员');
const token = signToken(admin);
async function request(body, auth = token) {
  const res = await fetch(BASE + '/api/option/', { method: body ? 'PUT' : 'GET', headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, ...await res.json() };
}
async function save(body) { const res = await request(body); assert.ok(res.success, res.message); return res.data; }
const opts = await save();
const saved = Object.fromEntries(['home_background_light', 'home_background_dark', 'default_theme'].map(k => [k, opts[k]]));
const light = '/illustrations/home-day.webp?custom-light', dark = '/illustrations/home-night.webp?custom-dark';
const output = path.join(os.tmpdir(), 'ooapi-wallpaper-review'); fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let checks = 0; const errors = [];
let ownedUserId = null;
function check(label, value) { assert.ok(value, label); checks++; console.log('  ok ' + label); }
async function wallpaper(page, source, mode) {
  await page.waitForFunction(({ source, mode }) => {
    const img = document.querySelector('.studio-desktop-wallpaper img');
    return img?.getAttribute('src') === source && img.complete && img.naturalWidth > 0 && img.parentElement.dataset.wallpaperMode === mode;
  }, { source, mode });
}
try {
  const [created] = await pool.query('INSERT INTO users (username,password,role,status) VALUES (?,?,1,1)', ['wallpaper_' + crypto.randomUUID(), '!login-disabled-fixture']);
  ownedUserId = created.insertId;
  const member = { id: ownedUserId, role: 1, token_version: 0 };
  check('匿名无法修改首页背景', (await request({ home_background_light: light }, '')).status === 401);
  check('普通用户无法修改站点背景', (await request({ home_background_light: light }, signToken(member))).status === 403);
  await save({ home_background_light: '', home_background_dark: '', default_theme: 'light' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  await ctx.addInitScript(t => localStorage.setItem('ooapi-token', t), token);
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE + '/admin/settings?tab=appearance', { waitUntil: 'networkidle' });
  check('后台展示两个独立的背景预览', await p.locator('.oo-wallpaper-preview img').count() === 2);
  await p.getByRole('textbox', { name: '亮色主题背景', exact: true }).fill(light);
  await p.getByRole('textbox', { name: '暗色主题背景', exact: true }).fill(dark);
  await p.waitForFunction(() => [...document.querySelectorAll('.oo-wallpaper-preview img')].every(i => i.complete && i.naturalWidth > 0));
  check('两个自定义地址分别用于预览', await p.locator('.oo-wallpaper-preview img').first().getAttribute('src') === light && await p.locator('.oo-wallpaper-preview img').last().getAttribute('src') === dark);
  await p.getByRole('button', { name: /保存外观/ }).click();
  await p.getByText('外观已保存，全站生效', { exact: true }).waitFor();
  const stored = await save(); check('管理员表单真实持久化两个背景地址', stored.home_background_light === light && stored.home_background_dark === dark);
  const status = await fetch(BASE + '/api/status').then(r => r.json());
  check('公开状态下发已保存的两个背景地址', status.data.home_background_light === light && status.data.home_background_dark === dark);
  await p.locator('.oo-wallpaper-fields').scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(output, 'settings-desktop.png') });
  await p.goto(BASE, { waitUntil: 'networkidle' }); await wallpaper(p, light, 'light');
  check('亮色首页加载自定义白天图', true);
  await p.screenshot({ path: path.join(output, 'home-day.png') });
  await save({ default_theme: 'dark' }); await p.reload({ waitUntil: 'networkidle' }); await wallpaper(p, dark, 'dark');
  check('暗色首页加载自定义夜景图', true);
  check('夜景不再套用压暗滤镜', await p.locator('.studio-desktop-wallpaper').evaluate(e => getComputedStyle(e).filter === 'none'));
  await p.screenshot({ path: path.join(output, 'home-night.png') });
  await save({ default_theme: 'system' }); await p.reload({ waitUntil: 'networkidle' }); await wallpaper(p, light, 'light');
  await p.emulateMedia({ colorScheme: 'dark' }); await wallpaper(p, dark, 'dark');
  check('跟随系统无需刷新即可切换夜景', true);
  await p.emulateMedia({ colorScheme: 'light' }); await wallpaper(p, light, 'light');
  check('系统切回亮色时恢复白天图', true);
  for (const invalid of ['javascript:void(0)', 'data:text/html,test', '//example.com/image.png', 'https://user:pass@example.com/image.png']) {
    check('拒绝非法背景地址 ' + invalid.split(':')[0], !(await request({ home_background_light: invalid, home_background_dark: '/should-not-save.webp' })).success);
  }
  check('非法批量设置不会部分落库', (await save()).home_background_dark === dark);
  await save({ home_background_light: '/missing-wallpaper-fixture.png', home_background_dark: '' });
  await p.reload({ waitUntil: 'networkidle' }); await wallpaper(p, '/illustrations/home-day.webp', 'light');
  check('自定义坏图自动回退同主题默认背景', true);
  await p.emulateMedia({ colorScheme: 'dark' }); await wallpaper(p, '/illustrations/home-night.webp', 'dark');
  check('暗色留空独立回退夜景背景', true);
  await p.goto(BASE + '/admin/settings?tab=appearance', { waitUntil: 'networkidle' });
  await p.getByText('图片无法加载，请检查地址', { exact: true }).waitFor();
  check('设置页坏图显示可读错误', true);
  await p.getByRole('textbox', { name: '亮色主题背景', exact: true }).fill(light);
  await p.waitForFunction(() => document.querySelector('.oo-wallpaper-preview img')?.naturalWidth > 0);
  check('修正地址后预览恢复', !(await p.getByText('图片无法加载，请检查地址', { exact: true }).count()));
  await p.getByRole('button', { name: '恢复默认', exact: true }).first().click();
  await p.getByRole('button', { name: /保存外观/ }).click();
  await p.getByText('外观已保存，全站生效', { exact: true }).waitFor();
  check('恢复默认操作保存为空值', (await save()).home_background_light === '');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator('.oo-wallpaper-fields').scrollIntoViewIfNeeded();
  check('手机后台背景配置无横向溢出', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await p.screenshot({ path: path.join(output, 'settings-mobile.png') });
  for (const mode of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: mode }); await p.goto(BASE, { waitUntil: 'networkidle' });
    await wallpaper(p, `/illustrations/home-${mode === 'dark' ? 'night' : 'day'}.webp`, mode);
    check('手机 ' + mode + ' 背景覆盖视口且无溢出', await p.locator('.studio-desktop-wallpaper').evaluate(e => { const r = e.getBoundingClientRect(); return r.width === innerWidth && r.height >= innerHeight && document.documentElement.scrollWidth <= innerWidth; }));
    await p.screenshot({ path: path.join(output, `home-mobile-${mode}.png`) });
  }
  check('首页与后台无浏览器运行期错误', errors.length === 0);
  console.log(`Wallpaper UI ${checks}/${checks} passed`);
} finally {
  await browser.close(); await save(saved).catch(() => { console.error('恢复隔离背景设置失败'); process.exitCode = 1; });
  if (ownedUserId) await pool.query('DELETE FROM users WHERE id = ?', [ownedUserId]);
  await pool.end();
}
