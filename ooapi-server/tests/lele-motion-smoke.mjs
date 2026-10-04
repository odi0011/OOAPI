// 独立组件验收不读数据库、不请求模型；浏览器加载与产品相同的 React/SVG/CSS。
// 先启动 ooapi-web 的 Vite，再设置 BASE=http://127.0.0.1:5173 执行本文件。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(BASE).hostname), '仅允许本地组件预览');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let count = 0;
const check = (condition, label) => { assert.ok(condition, label); count++; console.log('PASS', label); };
const anchor = page.locator('.live .lele-perch-anchor');
const director = page.locator('.director .lele-perch-anchor');
async function pose(value) {
  await page.getByRole('combobox', { name: '动作', exact: true }).fill(value);
  await page.getByRole('option', { name: value, exact: true }).click();
  await page.waitForTimeout(620);
}
async function visibleEyes(root) {
  return root.evaluate(n => [...n.querySelectorAll('.cat-eyes,.cat-happy-eyes,.cat-sleep-eyes,.cat-drowse-eyes')].filter(e => getComputedStyle(e).display !== 'none' && Number(getComputedStyle(e).opacity) > .8).length);
}
try {
  await page.goto(BASE + '/tests/lele-motion.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const original = await anchor.getAttribute('data-pose');
  const point = await anchor.evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x + 29, y: r.y - 16 }; });
  // 真正触发 pointerenter/leave：短暂划过不应触发任何姿态切换。
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(45);
  await page.mouse.move(point.x + 90, point.y);
  await page.waitForTimeout(330);
  check(await anchor.getAttribute('data-hovered') === 'false' && await anchor.getAttribute('data-pose') === original, '快速划过保持姿态');
  const actor = await anchor.locator('.lele-edge-actor').elementHandle();
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(750);
  check(await anchor.getAttribute('data-hovered') === 'true', '停留后才回应抚摸');
  check(await anchor.getAttribute('data-pose') === original, '抚摸不换动作');
  check(await actor.evaluate(n => n.isConnected), '抚摸不卸载角色 DOM');
  const samples = await anchor.evaluate(async n => {
    const result = [];
    for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); const r = n.querySelector('.cat-cranium').getBoundingClientRect(); result.push({ x: r.x, y: r.y }); }
    return result;
  });
  check(samples.every((r, i) => !i || Math.hypot(r.x - samples[i - 1].x, r.y - samples[i - 1].y) < 2), '抚摸停留期间逐帧无跳动');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(800);
  check(await anchor.getAttribute('data-hovered') === 'false', '移出后平稳恢复');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('乐乐在听');
  await page.waitForTimeout(550);
  const at = await anchor.getAttribute('style');
  await input.pressSequentially('，慢慢把故事讲完。', { delay: 80 });
  check(await anchor.getAttribute('data-pose') === 'listen' && await anchor.getAttribute('style') === at, '连续输入在原位置倾听');
  check(await actor.evaluate(n => n.isConnected), '连续输入不重挂载角色');
  await page.waitForTimeout(2400);
  check(await anchor.getAttribute('data-pose') === 'peek' && await anchor.getAttribute('data-phase') === 'rest', '输入停顿后原地休息');
  for (const action of ['copy', 'send', 'retry', 'attach']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.waitForTimeout(120);
    check(await actor.evaluate(n => n.isConnected), action + ' 保留角色身份');
  }
  await page.waitForTimeout(2100);
  const menuHead = await anchor.locator('.cat-cranium').elementHandle();
  await page.getByRole('button', { name: '切换菜单', exact: true }).click();
  await page.waitForTimeout(1450);
  check(await anchor.getAttribute('data-companion-state') === 'menu', '菜单打开进入避让状态');
  const landed = () => anchor.evaluate(n => { const cat = n.querySelector('.cat-hindlegs'), menu = document.querySelector('[data-promptbar-menu]'); return cat && menu ? Math.abs(cat.getBoundingClientRect().bottom - menu.getBoundingClientRect().top) : null; });
  check((await landed()) < 2, '菜单落地脚掌贴合边沿');
  for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '切换菜单', exact: true }).click(); await page.waitForTimeout(100); }
  await page.waitForTimeout(1500);
  check((await landed()) < 2, '快速切换菜单后准确落地');
  check(await actor.evaluate(n => n.isConnected && n === document.querySelector('.live .lele-edge-actor')) && await menuHead.evaluate(n => n.isConnected && n === document.querySelector('.live .cat-cranium')), '菜单跳起及快速切换保留角色和头部 DOM');
  // 在真实飞行的尾段切换菜单：原路线结束时，新路线仍应继续播放。
  await page.getByRole('button', { name: '切换菜单', exact: true }).click();
  await anchor.evaluate(async n => {
    const flight = n.querySelector('.lele-edge-actor').getAnimations().find(a => /^lele-(jump|fall)-route$/.test(a.animationName));
    if (!flight) throw new Error('菜单转移没有启动真实飞行动画');
    const end = flight.effect.getComputedTiming().endTime;
    const started = performance.now();
    while (flight.currentTime < end - 110 && performance.now() - started < end + 500) await new Promise(requestAnimationFrame);
    if (flight.currentTime < end - 110) throw new Error('菜单飞行动画未进入尾段');
  });
  await page.getByRole('button', { name: '切换菜单', exact: true }).click();
  await page.waitForTimeout(200);
  const lateFlightContinues = await anchor.getAttribute('data-phase') === 'enter';
  await page.waitForTimeout(1100);
  check(lateFlightContinues && await anchor.getAttribute('data-phase') === 'rest' && (await landed()) < 2, '飞行尾段切换菜单不会被旧结束事件提前终止，最终准确落地');
  await page.getByRole('button', { name: '关闭菜单', exact: true }).click();
  await page.waitForTimeout(1500);
  check(await anchor.getAttribute('data-phase') === 'rest', '关闭菜单后落回框沿');
  await page.getByRole('button', { name: '询 问', exact: true }).click();
  const approval = page.getByRole('region', { name: '这一步交给我看看，好吗？', exact: true });
  await approval.waitFor();
  await page.waitForTimeout(750);
  const approvalBox = await approval.boundingBox();
  await page.waitForTimeout(1000);
  check(JSON.stringify(approvalBox) === JSON.stringify(await approval.boundingBox()), '询问气泡固定，保留阅读和点击位置');
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await approval.waitFor({ state: 'hidden' });
  check(true, '确认入口可正常关闭');
  const ordinary = ['peek', 'curious', 'listen', 'shy', 'wave', 'invite', 'paws', 'look', 'cute', 'proud', 'pop', 'walk', 'spin', 'chase', 'toy', 'belly', 'lick', 'groom', 'wash', 'stretch', 'wink', 'curl', 'sleep', 'zzz', 'knead', 'shake', 'loaf', 'yawn', 'drowsy', 'pawtap'];
  for (const gesture of ordinary) {
    await pose(gesture);
    check(await visibleEyes(director) === 1, gesture + ' 仅显示一套眼形');
    const defined = await director.evaluate(n => {
      const frames = new Set([...document.styleSheets].flatMap(s => { try { return [...s.cssRules].filter(r => r.type === CSSRule.KEYFRAMES_RULE).map(r => r.name); } catch { return []; } }));
      return [...n.querySelectorAll('*')].every(el => getComputedStyle(el).animationName.split(',').every(name => name.trim() === 'none' || frames.has(name.trim())));
    });
    check(defined, gesture + ' 的所有动画都有关键帧');
  }
  await pose('wink');
  const winkRatios = await director.evaluate(async n => {
    const ratios = [];
    const started = performance.now();
    while (performance.now() - started < 2600) {
      await new Promise(requestAnimationFrame);
      ratios.push(n.querySelector('.cat-eye-right').getBoundingClientRect().height / n.querySelector('.cat-eye-left').getBoundingClientRect().height);
    }
    return ratios;
  });
  check(Math.min(...winkRatios) < .3 && Math.max(...winkRatios) > .95, `wink 只闭合一只眼睛并自然睁开 (${Math.min(...winkRatios).toFixed(2)}–${Math.max(...winkRatios).toFixed(2)})`);
  await pose('sleep');
  for (const state of ['attentive', 'thinking', 'working', 'loading', 'compressing', 'waiting', 'asking', 'success', 'sad']) {
    await page.getByRole('combobox', { name: '业务状态', exact: true }).fill(state);
    await page.getByRole('option', { name: state, exact: true }).click();
    await page.waitForTimeout(650);
    check(await visibleEyes(director) === 1 && await director.locator('.lele-sleep').evaluate(n => Number(getComputedStyle(n).opacity) === 0), state + ' 反馈不会被先前睡眠表情盖住');
  }
  await page.getByRole('combobox', { name: '业务状态', exact: true }).fill('idle');
  await page.getByRole('option', { name: 'idle', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await pose('peek');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), width + 'px 无横向溢出');
    if (process.env.EVIDENCE_DIR) { await fs.mkdir(process.env.EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/lele-${width}.png`, fullPage: true }); }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  check(await page.locator('.chat-mascot').evaluateAll(nodes => nodes.every(n => n.getAnimations({ subtree: true }).length === 0)), '减少动态关闭所有角色动画');
  assert.deepEqual(errors, [], '组件预览不能出现运行异常');
  check(true, '全部交互无页面运行异常');
  console.log(`乐乐动作连续性：${count} 项通过`);
} finally { await browser.close(); }
