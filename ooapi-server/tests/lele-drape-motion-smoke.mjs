// 独立侧卧动作验收：只访问本地试映页，不读取数据库、凭据或调用模型。
// 先启动 ooapi-web 的 Vite；Chrome 路径可通过 PLAYWRIGHT_EXECUTABLE_PATH 指定。
// BASE=http://127.0.0.1:5173 EVIDENCE_DIR=<目录> node tests/lele-drape-motion-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.BASE || "http://127.0.0.1:5173");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "只允许本地组件预览");
assert.ok(["http:", "https:"].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash, "BASE 必须是不含凭据或查询参数的本地地址");
const OUT = path.resolve(process.env.EVIDENCE_DIR || path.join(os.tmpdir(), "ooapi-lele-drape-motion"));
const WIDTHS = [1440, 390, 320];
const PHASES = [["enter", "重播入场"], ["startle", "侧卧惊醒"], ["stretch", "侧卧伸展"]];
const report = { fixture: "/tests/lele-motion.html", widths: WIDTHS, phases: [], checks: [], runtimeErrorCount: 0 };
const pictures = [];
let browser, page;
const check = (passed, label, details = {}) => {
  report.checks.push({ passed: Boolean(passed), label, ...details });
  console.log(passed ? "PASS" : "FAIL", label);
};

async function selectDrape() {
  await page.getByRole("combobox", { name: "动作", exact: true }).fill("drape");
  await page.getByRole("option", { name: "drape", exact: true }).click();
  await page.locator('.director[data-pose="drape"]').waitFor();
}

async function clearSampler() {
  // 测试暂停后被 CSS 替换的旧动画仍可能保留；下一阶段前释放它们，避免覆盖真实新动画。
  await page.evaluate(() => { window.__leleDrapeSmoke?.animations.forEach(animation => animation.cancel()); delete window.__leleDrapeSmoke; });
}

async function prepareSampler(phase) {
  return page.locator(".director .lele-perch-anchor").evaluate(async (anchor, expectedPhase) => {
    if (anchor.dataset.phase !== expectedPhase) throw new Error("试映阶段与请求不一致");
    const animations = anchor.getAnimations({ subtree: true });
    animations.forEach(animation => animation.pause());
    await Promise.all(animations.map(animation => animation.ready));
    const cssAnimations = animations.filter(animation => animation instanceof CSSAnimation);
    const describe = animation => {
      const timing = animation.effect.getTiming();
      const computed = animation.effect.getComputedTiming();
      return {
        name: animation.animationName,
        target: animation.effect.target.getAttribute("class"),
        delay: timing.delay, duration: computed.duration,
        iterations: timing.iterations === Infinity ? "infinite" : timing.iterations,
        direction: timing.direction, easing: timing.easing, fill: timing.fill,
        endTime: Number.isFinite(computed.endTime) ? computed.endTime : null,
        activeDuration: Number.isFinite(computed.activeDuration) ? computed.activeDuration : null,
        keyframes: animation.effect.getKeyframes().map(frame => ({ offset: frame.computedOffset, easing: frame.easing, transform: frame.transform ?? null, clipPath: frame.clipPath ?? null })),
      };
    };
    const descriptors = cssAnimations.map(describe);
    const finite = descriptors.filter(animation => animation.endTime !== null && animation.endTime > 0);
    const actor = anchor.querySelector(".lele-edge-actor");
    const actorAnimation = cssAnimations.find(animation => animation.effect.target === actor && Number.isFinite(animation.effect.getComputedTiming().endTime));
    // 以实际阶段时钟采样，其他部位沿同一 elapsed time 运行，保留 delay/反向/局部时长。
    const duration = Math.max(0, ...finite.map(animation => animation.endTime));
    const shots = new Set([0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1]);
    for (const animation of finite) {
      for (const frame of animation.keyframes) {
        const offset = animation.direction === "reverse" || animation.direction === "alternate-reverse" ? 1 - frame.offset : frame.offset;
        const progress = (animation.delay + animation.duration * offset) / duration;
        if (progress >= 0 && progress <= 1) shots.add(Math.round(progress * 1e6) / 1e6);
      }
    }
    const torso = anchor.querySelector(".lounge-body");
    const firstPaths = selector => [...anchor.querySelector(selector).children].filter(child => child instanceof SVGGeometryElement).slice(0, 2);
    const shapes = {
      head: [...anchor.querySelector(".cat-head").children].filter(child => child instanceof SVGGeometryElement),
      body: firstPaths(".lounge-body"),
      front: firstPaths(".lounge-front-leg"), wrist: firstPaths(".lounge-wrist"),
      hind: firstPaths(".lounge-hind-leg"), hock: firstPaths(".lounge-hock"),
      tail: firstPaths(".lounge-tail"), folded: firstPaths(".lounge-folded-paw"),
    };
    const geometry = Object.fromEntries(Object.entries(shapes).map(([name, elements]) => [name, elements.map(element => {
      const length = element.getTotalLength();
      const count = Math.max(12, Math.min(192, Math.ceil(length * 2)));
      return { element, points: Array.from({ length: count + 1 }, (_, index) => element.getPointAtLength(length * index / count)) };
    })]));
    const svg = actor.querySelector("svg");
    const unit = parseFloat(getComputedStyle(svg).width) / svg.viewBox.baseVal.width;
    const center = element => {
      const bbox = element.getBBox(), matrix = element.getScreenCTM();
      const point = new DOMPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    const world = entries => entries.map(({ element, points }) => {
      const matrix = element.getScreenCTM();
      const inverse = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) > 1e-10 ? matrix.inverse() : null;
      const style = getComputedStyle(element), fill = style.fill !== "none", stroke = style.stroke !== "none";
      const padding = stroke ? parseFloat(style.strokeWidth) / 2 * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) : 0;
      const transformed = points.map(point => new DOMPoint(point.x, point.y).matrixTransform(matrix));
      const xs = transformed.map(point => point.x), ys = transformed.map(point => point.y);
      return { element, inverse, fill, stroke, points: transformed, box: { left: Math.min(...xs) - padding, right: Math.max(...xs) + padding, top: Math.min(...ys) - padding, bottom: Math.max(...ys) + padding } };
    });
    const bounds = entries => ({
      left: Math.min(...entries.map(entry => entry.box.left)), right: Math.max(...entries.map(entry => entry.box.right)),
      top: Math.min(...entries.map(entry => entry.box.top)), bottom: Math.max(...entries.map(entry => entry.box.bottom)),
    });
    const gap = (left, right) => {
      let nearest = Infinity;
      for (const a of left) for (const b of right) {
        const dx = Math.max(0, a.box.left - b.box.right, b.box.left - a.box.right);
        const dy = Math.max(0, a.box.top - b.box.bottom, b.box.top - a.box.bottom);
        if (Math.hypot(dx, dy) > nearest) continue;
        // 用真实路径点与填色区域检查接触，避免旋转后外包框重叠却实际断开。
        const painted = (entry, point) => (entry.fill && entry.element.isPointInFill(point)) || (entry.stroke && entry.element.isPointInStroke(point));
        if (b.inverse) for (const point of a.points) if (painted(b, point.matrixTransform(b.inverse))) return 0;
        if (a.inverse) for (const point of b.points) if (painted(a, point.matrixTransform(a.inverse))) return 0;
        for (const pointA of a.points) for (const pointB of b.points) nearest = Math.min(nearest, Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y));
      }
      return nearest;
    };
    window.__leleDrapeSmoke = {
      anchor, animations, duration,
      sample(progress) {
        // Chromium 的动画时钟会舍入；0.0001ms 仍可能触发 animationend，让截图前的 React 阶段变成 rest。
        // 留出 0.1ms 的余量，保留结束姿态且不越过阶段边界。
        const elapsed = progress === 1 && duration > 0 ? Math.max(0, duration - .1) : duration * progress;
        for (const animation of animations) animation.currentTime = elapsed;
        const bodyGeometry = Object.fromEntries(Object.entries(geometry).map(([name, entries]) => [name, world(entries)]));
        const head = center(anchor.querySelector(".cat-head"));
        const body = center(shapes.body[0]);
        const viewport = anchor.querySelector(".lele-edge-viewport"), viewportStyle = getComputedStyle(viewport), actorStyle = getComputedStyle(actor);
        const viewportBounds = viewport.getBoundingClientRect();
        const insets = viewportStyle.clipPath.match(/^inset\(([^)]*)\)/)?.[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
        const bottomInset = insets ? insets.length <= 2 ? insets[0] : insets[2] : "0px";
        const bottomInsetPixels = bottomInset.endsWith("%") ? parseFloat(bottomInset) / 100 * viewportBounds.height : parseFloat(bottomInset);
        const headBounds = bounds(bodyGeometry.head);
        const allBounds = bounds(Object.values(bodyGeometry).flat());
        return {
          progress, elapsed, head, body, unit, headBounds, bodyBounds: bounds(bodyGeometry.body), allBounds,
          joints: {
            neck: gap(bodyGeometry.head, bodyGeometry.body), shoulder: gap(bodyGeometry.body, bodyGeometry.front),
            elbow: gap(bodyGeometry.front, bodyGeometry.wrist), hip: gap(bodyGeometry.body, bodyGeometry.hind),
            hock: gap(bodyGeometry.hind, bodyGeometry.hock), tail: gap(bodyGeometry.body, bodyGeometry.tail),
          },
          legTops: ["front", "wrist", "hind", "hock", "folded"].map(name => bounds(bodyGeometry[name]).top),
          contactBottoms: ["front", "wrist", "hind", "hock", "folded", "tail"].map(name => bounds(bodyGeometry[name]).bottom),
          edge: anchor.getBoundingClientRect().top,
          edgeX: anchor.getBoundingClientRect().left,
          viewportBottom: viewportBounds.bottom, clipBottom: viewportBounds.bottom - bottomInsetPixels,
          clipPath: viewportStyle.clipPath, actorVisibility: actorStyle.visibility, actorOpacity: Number(actorStyle.opacity),
          actorTransform: actorStyle.transform, headTransform: getComputedStyle(anchor.querySelector(".cat-cranium")).transform,
          bodyTransform: getComputedStyle(torso).transform,
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
          phase: anchor.dataset.phase,
        };
      },
    };
    return { animations: descriptors, duration, screenshotProgress: [...shots].sort((a, b) => a - b), hasActorAnimation: Boolean(actorAnimation) };
  }, phase);
}

async function sample(progress) {
  return page.evaluate(value => window.__leleDrapeSmoke.sample(value), progress);
}

async function screenshot(label, phase, width, progress) {
  // 几何读取只保证布局已更新；必须等动画与绘制提交后再确认阶段及 Animation 身份，拒绝过期对象的截图。
  const rendered = await page.evaluate(async ({ phase, progress }) => {
    const sampler = window.__leleDrapeSmoke;
    await Promise.all(sampler.animations.map(animation => animation.ready));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!sampler.anchor.isConnected || sampler.anchor.dataset.phase !== phase) throw new Error("绘制时试映阶段已改变");
    const active = sampler.anchor.getAnimations({ subtree: true });
    const replaced = sampler.animations.filter(animation => animation instanceof CSSAnimation && (!active.includes(animation) || animation.playState !== "paused"));
    if (replaced.length) throw new Error(`绘制时采样动画已被替换：${replaced.map(animation => animation.animationName).join("、")}`);
    return sampler.sample(progress);
  }, { phase, progress });
  const anchor = await page.locator(".director .lele-perch-anchor").boundingBox();
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.floor(anchor.x - 135)), y = Math.max(0, Math.floor(anchor.y - 125));
  const clip = { x, y, width: Math.min(330, viewport.width - x), height: Math.min(255, viewport.height - y) };
  assert.ok(clip.width > 0 && clip.height > 0, "截图范围必须在当前视口内");
  const filename = `${width}-${phase}-${String(Math.round(progress * 1000000)).padStart(7, "0")}.png`;
  const options = { clip, animations: "allow" };
  let previous = await page.screenshot(options), data, stable = false;
  // 截图本身会请求 compositor 提交；连拍到像素一致再保存，防止得到上次 seek 的表面。
  for (let attempt = 0; attempt < 3; attempt++) {
    data = await page.screenshot(options);
    if (data.equals(previous)) { stable = true; break; }
    previous = data;
  }
  assert.ok(stable, `${width}px ${phase} ${progress} 截图绘制必须稳定`);
  const captured = await sample(progress);
  assert.equal(captured.phase, phase, "截图完成时阶段必须保持不变");
  for (const property of ["elapsed", "clipPath", "actorTransform", "headTransform", "bodyTransform"]) assert.deepEqual(captured[property], rendered[property], `截图完成时 ${property} 必须与采样一致`);
  await fs.writeFile(path.join(OUT, filename), data);
  pictures.push({ label, width, phase, progress, filename, captured });
}

function verifyPhase(width, phase, frames, rest) {
  const label = `${width}px ${phase}`;
  const unit = frames[0].unit;
  const maxStep = part => Math.max(...frames.slice(1).map((row, index) => Math.hypot(row[part].x - frames[index][part].x, row[part].y - frames[index][part].y)));
  // 1% 的邻帧位移不得超过猫宽的四分之一；只拒绝位置跳变，不评价速度或审美。
  const stepLimit = unit * 64 / 4;
  for (const part of ["head", "body"]) check(maxStep(part) <= stepLimit, `${label} ${part} 每1%位置连续`, { maxStep: maxStep(part), limit: stepLimit });
  for (const part of ["head", "body"]) {
    const distance = Math.hypot(frames[0][part].x - frames[0].edgeX - (rest[part].x - rest.edgeX), frames[0][part].y - frames[0].edge - (rest[part].y - rest.edge));
    if (phase !== "enter") check(distance <= unit * 1.5, `${label} ${part} 从休息姿态接续`, { distance, limit: unit * 1.5 });
  }
  const worstJoints = Object.fromEntries(Object.keys(frames[0].joints).map(name => [name, Math.max(...frames.map(row => row.joints[name]))]));
  // 留出不到三格像素的路径采样与描边误差，连接检查使用屏幕上的真实填色轮廓。
  check(Object.values(worstJoints).every(distance => Number.isFinite(distance) && distance <= unit * 2.5), `${label} 头、肩、肘、髋、跗、尾根保持相连`, { worstJoints, limit: unit * 2.5 });
  const legAboveHead = Math.max(...frames.map(row => row.headBounds.top - Math.min(...row.legTops)));
  check(legAboveHead <= unit, `${label} 腿不会甩到头顶`, { maxAboveHead: legAboveHead, limit: unit });
  check(frames.every(row => !row.overflow), `${label} 全段无横向溢出`);
  check(frames.every(row => row.phase === phase), `${label} 采样期间阶段稳定`);
  if (phase !== "enter") {
    const cover = frames.find((row, index) => index > 0 && row.clipBottom <= row.edge + unit && frames[index - 1].clipBottom > frames[index - 1].edge + unit);
    check(Boolean(cover) && Math.max(...cover.contactBottoms) <= cover.edge + unit, `${label} 收爪到框沿上方后才启用裁剪`, { progress: cover?.progress ?? null, contactBottom: cover ? Math.max(...cover.contactBottoms) : null, edge: cover?.edge ?? null });
    const last = frames.at(-1);
    check(last.actorVisibility === "hidden" || last.allBounds.top >= last.edge - unit, `${label} 最终整只猫退到输入边后`, { paintedTop: last.allBounds.top, edge: last.edge, visibility: last.actorVisibility });
  }
}

async function contactSheet() {
  const escape = value => String(value).replace(/[&<>\"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));
  const images = await Promise.all(pictures.map(async picture => ({ ...picture, data: (await fs.readFile(path.join(OUT, picture.filename))).toString("base64") })));
  const sheets = [{ filename: "contact-sheet", columns: 4, entries: images }];
  for (const [phase] of PHASES) sheets.push({ filename: `contact-sheet-${phase}`, columns: 3, entries: images.filter(picture => picture.width === 1440 && picture.phase === phase && Math.abs(picture.progress * 10 - Math.round(picture.progress * 10)) < 1e-6) });
  for (const { filename, columns, entries } of sheets) {
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>乐乐侧卧动作采样</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:#e9ece7;color:#26312b;font:14px system-ui,"Microsoft YaHei",sans-serif}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0 0 20px;max-width:1100px;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(${columns},330px);gap:12px}figure{margin:0;background:white;border:1px solid #c6cec7;border-radius:8px;overflow:hidden}figcaption{padding:8px 10px;font-size:12px}img{display:block;width:100%;height:255px;object-fit:contain;object-position:top;background:#f2f2ee}</style><h1>乐乐侧卧动作 · ${escape(filename)}</h1><p>截图来自真实 UI 选择与按钮；阶段时长和关键帧偏移均读取 CSSAnimation。自动检测只检查几何连接、连续性、退场与溢出，动作自然程度需要人工查看。每1%坐标与检测结果见 report.json。</p><div class="grid">${entries.map(picture => `<figure><figcaption>${escape(picture.label)} · ${picture.width}px · ${(picture.progress * 100).toFixed(2)}%</figcaption><img alt="${escape(picture.filename)}" src="data:image/png;base64,${picture.data}"></figure>`).join("")}</div></html>`;
    await fs.writeFile(path.join(OUT, `${filename}.html`), html);
    const sheet = await browser.newPage({ viewport: { width: columns * 342 + 40, height: 900 } });
    await sheet.setContent(html);
    await sheet.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
    await sheet.screenshot({ path: path.join(OUT, `${filename}.png`), fullPage: true });
    await sheet.close();
  }
}

await fs.mkdir(OUT, { recursive: true });
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 1100 }, reducedMotion: "no-preference" });
  // 报告不保存请求/响应、Storage、Cookie或浏览器报错原文。
  page.on("pageerror", () => { report.runtimeErrorCount++; });
  await page.goto(new URL(report.fixture, base).href, { waitUntil: "networkidle" });
  await selectDrape();
  for (const width of WIDTHS) {
    await clearSampler();
    await page.setViewportSize({ width, height: 1100 });
    await page.locator(".director .perch-demo").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "重播姿态", exact: true }).click();
    await prepareSampler("rest");
    const rest = await sample(0);
    await screenshot("休息", "rest", width, 0);
    check(!rest.overflow, `${width}px 休息姿态无横向溢出`);
    for (const [phase, button] of PHASES) {
      await clearSampler();
      await page.getByRole("button", { name: "重播姿态", exact: true }).click();
      await prepareSampler("rest");
      const phaseRest = await sample(0);
      await clearSampler();
      await page.getByRole("button", { name: button, exact: true }).click();
      const animation = await prepareSampler(phase);
      check(animation.hasActorAnimation && animation.duration > 0, `${width}px ${phase} 使用真实有限 CSS 阶段动画`);
      const frames = [];
      for (let percent = 0; percent <= 100; percent++) frames.push(await sample(percent / 100));
      report.phases.push({ width, phase, animation, rest: phaseRest, frames });
      for (const progress of animation.screenshotProgress) {
        await sample(progress);
        await screenshot(button, phase, width, progress);
      }
      verifyPhase(width, phase, frames, phaseRest);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  // 前面的逐帧采样会把 CSSAnimation pause 在页面上；重载后才测系统减少动态的冷启动语义，避免把旧 Animation 对象当成新动作。
  await page.reload({ waitUntil: "networkidle" });
  await selectDrape();
  for (const [, button] of PHASES) {
    await page.getByRole("button", { name: button, exact: true }).click();
    check(await page.locator(".director .lele-perch-anchor").evaluate(anchor => anchor.getAnimations({ subtree: true }).length === 0), `减少动态模式：${button} 不启动动画`);
  }
  check(report.runtimeErrorCount === 0, "试映页无运行异常", { count: report.runtimeErrorCount });
  await contactSheet();
} catch (error) {
  report.setupFailure = error instanceof Error ? error.name : "Error";
  if (page) await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => {});
  if (browser && pictures.length) await contactSheet().catch(() => {});
  throw error;
} finally {
  report.pictures = pictures;
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
}
console.log(`侧卧动作采样：${report.checks.filter(item => item.passed).length}/${report.checks.length} 项通过；证据目录 ${OUT}`);
assert.ok(report.checks.every(item => item.passed), "侧卧动作几何检查失败；请查看 report.json 与 contact-sheet.png");
