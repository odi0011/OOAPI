// 渠道弹窗的滚动行为验证（用户指出的问题）
// ---------------------------------------------------------------------------
// 用户原话：「这个弹窗，左侧这么多内容是不是应该设置左侧也可以单独滑动，
// 右侧如果过高也是右侧单独滑动啊」。
// 这个问题**能程序化验证**（不需要肉眼）：滚动左栏后，右栏的滚动位置不该变，
// 反之亦然。所以放进常规测试而不是只靠截图。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const { JWT_SECRET, pool } = await import("../src/db.js");

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) {
    pass += 1;
    console.log(`  ok  ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${n} ${extra}`);
  }
};

const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 820 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();

await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: /添加渠道|新增渠道/ }).first().click();
await page.waitForTimeout(1800);

// 选一个表单最长的厂商（Anthropic → Kiro 反代：带一键绑定 UI 与渠道特化输入），
// 这样右栏才会真正溢出 —— 短表单下「不能滚」是正常的，
// 拿短表单断言会把「内容没超出」误判成「滚动失效」。
const kiroProvider = page.locator('[role="button"][aria-label="选择厂商 Anthropic"]');
if (await kiroProvider.count()) {
  await kiroProvider.first().scrollIntoViewIfNeeded();
  await kiroProvider.first().click();
  await page.waitForTimeout(1200);
  const kiroMethod = page.getByText("Kiro 反代", { exact: false });
  if (await kiroMethod.count()) {
    await kiroMethod.first().click();
    await page.waitForTimeout(1500);
  }
}

/** 探针：左右两栏各自的滚动能力与实际滚动位置 */
const probe = () =>
  page.evaluate(() => {
    const left = document.querySelector(".oo-channel-add-providers");
    const right = document.querySelector(".oo-channel-add-config");
    const body = document.querySelector(".oo-channel-add-modal .ant-modal-body");
    const canScroll = (el) => Boolean(el) && el.scrollHeight > el.clientHeight + 4;
    return {
      left: left ? { can: canScroll(left), top: left.scrollTop, h: left.clientHeight, sh: left.scrollHeight } : null,
      right: right ? { can: canScroll(right), top: right.scrollTop, h: right.clientHeight, sh: right.scrollHeight } : null,
      body: body ? { can: canScroll(body), h: body.clientHeight, sh: body.scrollHeight } : null,
    };
  });

const before = await probe();
console.log(`      左栏 可滚=${before.left?.can} (${before.left?.h}/${before.left?.sh})  右栏 可滚=${before.right?.can} (${before.right?.h}/${before.right?.sh})  弹窗体 可滚=${before.body?.can}`);

ck("左栏（厂商列表）可独立滚动", before.left?.can === true, JSON.stringify(before.left));
ck("右栏在内容超出时可独立滚动（长表单）", before.right?.can === true && before.right?.sh > before.right?.h, JSON.stringify(before.right));
ck("弹窗体本身不滚（滚动交给两栏）", before.body?.can === false, JSON.stringify(before.body));

// 右栏最关键的一条：内容必须真的能滚到（截断是静默的，用户会以为表单没这一项）
const reachable = await page.evaluate(() => {
  const right = document.querySelector(".oo-channel-add-config");
  if (!right) return { ok: false };
  right.scrollTop = right.scrollHeight; // 滚到底
  const bottom = right.getBoundingClientRect().bottom;
  // 取右栏里所有可见文本节点，看有没有元素超出容器底边
  const clipped = [...right.querySelectorAll("div, input, textarea, .ant-select, button")].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.width === 0) return false;
    return r.bottom > bottom + 2;
  });
  return { ok: clipped.length === 0, clipped: clipped.length, scrolled: right.scrollTop };
});
ck("右栏滚到底后没有内容被裁切", reachable.ok, JSON.stringify(reachable));

// 滚左栏 → 右栏位置不动
const afterLeft = await page.evaluate(() => {
  const left = document.querySelector(".oo-channel-add-providers");
  const right = document.querySelector(".oo-channel-add-config");
  const r0 = right.scrollTop;
  left.scrollTop = 200;
  return { leftTop: left.scrollTop, rightTop: right.scrollTop, rightBefore: r0 };
});
ck("滚左栏不会带动右栏", afterLeft.leftTop > 0 && afterLeft.rightTop === afterLeft.rightBefore, JSON.stringify(afterLeft));

// 滚右栏 → 左栏位置不变
const afterRight = await page.evaluate(() => {
  const left = document.querySelector(".oo-channel-add-providers");
  const right = document.querySelector(".oo-channel-add-config");
  const l0 = left.scrollTop;
  right.scrollTop = 200;
  return { leftTop: left.scrollTop, leftBefore: l0, rightTop: right.scrollTop };
});
ck("滚右栏不会带动左栏", afterRight.rightTop > 0 && afterRight.leftTop === afterRight.leftBefore, JSON.stringify(afterRight));

// 自定义厂商排最后（用户要求：强制放最后一个）
const order = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll(".oo-provider-picker__item"));
  return items.map((el) => (el.getAttribute("aria-label") || "").replace("选择厂商 ", ""));
});
ck("自定义厂商在最后一位", order.length > 0 && /自定义/.test(order[order.length - 1] || ""), `最后一项=${order[order.length - 1]}；共 ${order.length} 家`);
console.log(`      厂商顺序：${order.slice(0, 5).join(" → ")} … → ${order[order.length - 1]}`);

// 新厂商图标必须加载成功（不能是平台 logo / 破图）
const icons = await page.evaluate(() => {
  const out = {};
  for (const el of Array.from(document.querySelectorAll(".oo-provider-picker__item"))) {
    const label = (el.getAttribute("aria-label") || "").replace("选择厂商 ", "");
    const img = el.querySelector("img");
    if (!label || !img) continue;
    out[label] = { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight };
  }
  return out;
});
for (const name of ["小米 MiMo", "MiniMax", "阶跃星辰 StepFun", "火山方舟"]) {
  const it = icons[name];
  ck(`「${name}」图标已加载（非破图/非平台 logo）`, Boolean(it && it.w > 0 && it.h > 0 && !/logo\.jpg/.test(it.src || "")), JSON.stringify(it));
}

await browser.close();
await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
