// 渠道弹窗截图：验证新增厂商与「一键绑定」UI 的真实渲染。
// 上次的教训是「断言全绿但页面丑」，所以涉及 UI 的改动必须截图自己看。
//
// 关键点：厂商列表有 19 项、弹窗内需要滚动，直接按文本找会找不到
// （第一次就是这么失败的）。改用 aria-label 精确定位 + scrollIntoViewIfNeeded。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const OUT = process.env.OUT || "/tmp/shots-ch";
const W = Number(process.env.W || 1880);
const H = Number(process.env.H || 900);

const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

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

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();

// ① 渠道列表
await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/01-channel-list.png` });

// ② 打开添加弹窗
await page.getByRole("button", { name: /添加渠道|新增渠道|添加账号/ }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/02-add-dialog-providers.png` });

// ③ 厂商清单完整性：逐个断言新增的 4 家都在（用 aria-label 定位，自动滚动）
const wanted = [
  ["小米 MiMo", "mimo"],
  ["MiniMax", "minimax"],
  ["阶跃星辰 StepFun", "stepfun"],
  ["火山方舟", "ark"],
];
const pickerCount = await page.locator('[role="button"][aria-label^="选择厂商"]').count();
console.log(`      弹窗内厂商数：${pickerCount}`);
ck("厂商选择器渲染了全部厂商（19 家）", pickerCount >= 19, `实际 ${pickerCount}`);

for (const [label] of wanted) {
  const el = page.locator(`[role="button"][aria-label="选择厂商 ${label}"]`);
  const n = await el.count();
  ck(`弹窗内有「${label}」`, n > 0, `找到 ${n} 个`);
}

// ④ 选 Kiro（一键绑定目标），验证绑定 UI
const kiro = page.locator('[role="button"][aria-label="选择厂商 Anthropic"]');
if (await kiro.count()) {
  await kiro.first().scrollIntoViewIfNeeded();
  await kiro.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/03-anthropic-methods.png` });

  // 切到 Kiro 反代方式。
  // 文案由 methodShortName 生成（形如「Kiro 反代（粘贴凭据）」），
  // 所以匹配 "Kiro 反代" 而不是早期写死的 "反代（Kiro）」——
  // 后者是改成短名之前的老文案，用它定位会永远找不到。
  const kiroMethod = page.getByText("Kiro 反代", { exact: false });
  if (await kiroMethod.count()) {
    await kiroMethod.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/04-kiro-selected.png`, fullPage: true });
    await page.screenshot({ path: `${OUT}/05-kiro-bind-ui.png`, fullPage: true });

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    ck("Kiro 弹窗内出现「一键绑定」", /一键绑定/.test(bodyText));
    const m = bodyText.match(/一键绑定[\s\S]{0,260}/);
    if (m) console.log(`       文案：${m[0].replace(/\s+/g, " ").slice(0, 220)}`);
    ck("Kiro 有区域/startUrl 输入（渠道特化）", /区域|startUrl/.test(bodyText));

    // 真实点一下「一键绑定」：验证接口连通（上游会返回用户码，或给出明确错误）
    const bindBtn = page.getByRole("button", { name: /一键绑定账号/ });
    if (await bindBtn.count()) {
      await bindBtn.first().click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: `${OUT}/06-kiro-bind-started.png`, fullPage: true });
      const after = await page.evaluate(() => document.body?.innerText || "");
      const hasCode = /在授权页输入代码/.test(after);
      const hasPending = /等待你在浏览器中确认/.test(after);
      const hasRegion = /region|region 注册失败|AWS SSO/.test(after);
      ck("点「一键绑定」后有明确反馈（用户码 / 等待中 / 明确错误）", hasCode || hasPending || hasRegion, after.slice(-300).replace(/\s+/g, " "));
      console.log(`       用户码出现：${hasCode}，等待中：${hasPending}`);
      const snip = (after.match(/等待你在浏览器中确认[\s\S]{0,80}/) || after.match(/AWS SSO[\s\S]{0,120}/) || [""])[0];
      if (snip) console.log(`       状态：${snip.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  } else {
    ck("Kiro 接入方式可见", false, "未找到「Kiro 反代」标签");
  }
} else {
  ck("厂商选择器含 Anthropic（Kiro 所在厂商）", false);
}

// ⑤ 顺带看 WorkBuddy / Qoder 的绑定 UI
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/07-after-bind.png` });

await browser.close();
await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
console.log(`截图已存到 ${OUT}`);
