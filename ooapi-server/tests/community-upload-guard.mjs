// T8 回归测试：发帖时「图片还在上传」必须被拦住（不能静默丢图）
// ---------------------------------------------------------------------------
// 为什么必须有它：
//   帖 1233 就是这样丢的图 —— 用编辑器工具栏的插图按钮选图，图还在传时点了发布，
//   帖子创建成功但 `media_ids=[]`，媒体行 1993 变成 ref_count=0 的孤儿文件。
//   当时 `vite build` 通过、页面也不报错，纯靠人工点才可能发现。
//
// 覆盖两条断言（对应任务书的验收标准）：
//   ① 上传进行中点「发布」→ 弹出「还有图片在上传中，请稍等片刻再发布」，且**不创建帖子**；
//   ② 等上传完成再点「发布」→ 帖子正常创建，且 `media_ids` 非空（图真的挂上了）。
//
// 为什么要**人为拖慢** POST /api/media：
//   本机 localhost 上传太快，人/脚本都来不及在窗口里点发布 —— 那样测的是「传完之后发布」，
//   根本碰不到竞态。这里把媒体上传响应延迟 4s，制造出确定的「传输进行中」窗口。
//
// 用法（服务器上，需 xvfb；与 ui-smoke.mjs 同款手动回归脚本，不在 npm test 里 ——
// 它要开真实浏览器、会往库里写一条帖子）：
//   cd ooapi-server && xvfb-run -a node tests/community-upload-guard.mjs
//   BASE=http://127.0.0.1:3001 xvfb-run -a node tests/community-upload-guard.mjs
//
// 测试自己会清理：结束时删掉本次创建的帖子（媒体行交给 runGc 回收）。
import "dotenv/config";
import { chromium } from "playwright";
import jwt from "jsonwebtoken";
import { JWT_SECRET, pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const SHOT = process.env.SHOT || "/root/chk_media.png";
const UPLOAD_DELAY_MS = 4000;

const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
const [[topic]] = await pool.query("SELECT id, name FROM community_topics ORDER BY id LIMIT 1");
if (!admin || !topic) {
  console.error("缺少管理员或话题，无法跑本测试");
  process.exit(1);
}
const token = jwt.sign(
  { id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 },
  JWT_SECRET,
  { expiresIn: "20m" }
);

// 本次跑出来的帖子标题：结束时按标题清理（包括**本该失败却创建成功**的那些 ——
// 验证「守卫失效时本测试会红」时会用到，那时场景①的帖子就是这么留下的）
const titles = [];
let failed = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${extra ? `  ${extra}` : ""}`);
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);

/** 打开社区页 → 打开发帖弹窗 → 填好必填项，返回 page（弹窗已就绪） */
async function openComposer(page) {
  await page.goto(`${BASE}/community`, { waitUntil: "networkidle", timeout: 40000 });
  // 先等按钮出现、再等首屏布局稳定（Noto 字体 + 侧栏 BuildLogCard 落位会引起 reflow，
  // 不等的话 Playwright 的「stable」检查会一直重试到超时）
  const fab = page.getByRole("button", { name: "发帖" }).first();
  await fab.waitFor({ state: "visible", timeout: 40000 });
  await page.waitForTimeout(800);
  await fab.click({ timeout: 20000 });
  await page.waitForSelector(".ant-modal-content textarea.oo-rich-textarea", { timeout: 15000 });
  await page.waitForTimeout(600); // 等 Modal 弹入动画结束，否则点击会被判为「不稳定」
  // 话题是 Select（必填）：点开下拉选第一个选项
  await page.locator("#topic_id").click();
  await page.waitForSelector(".ant-select-item-option", { timeout: 10000 });
  await page.locator(".ant-select-item-option").first().click();
  const title = `T8 竞态测试 ${Date.now()}`;
  titles.push(title);
  await page.fill("#title", title);
  await page.fill("textarea.oo-rich-textarea", "发帖配图竞态回归：正文与配图必须一起落地。");
  return title;
}

/** 点弹窗的「发布」，等一小会儿让请求/守卫生效 */
async function clickPublish(page) {
  const btn = page.locator(".ant-modal-footer button.ant-btn-primary");
  await btn.waitFor({ state: "visible", timeout: 10000 });
  await btn.click({ timeout: 15000 });
  await page.waitForTimeout(1200);
}

async function postCountByTitle(title) {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM community_posts WHERE title = ?", [title]);
  return Number(row.n || 0);
}

try {
  // ── 场景①：上传进行中点发布 → 必须被拦住 ──────────────────────────────
  console.log(`\n场景① 上传进行中发布（人为把 /api/media 延迟 ${UPLOAD_DELAY_MS}ms）`);
  {
    const page = await ctx.newPage();
    await page.route("**/api/media", async (route) => {
      // 只拖慢上传（POST）；媒体列表等 GET 请求照常，否则社区页自己会卡住
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, UPLOAD_DELAY_MS));
      await route.continue();
    });
    const title = await openComposer(page);

    // 用**编辑器工具栏的插图按钮**那条路径（就是帖 1233 丢图的那条）
    await page.setInputFiles(".oo-rich-editor input[type=\"file\"]", SHOT);
    await page.waitForTimeout(400); // 让「正在上传图片...」转出来，确认确实处在传输窗口内
    const spinner = await page.locator(".oo-rich-toolbar", { hasText: "正在上传图片" }).count();
    ok(spinner > 0, "点击发布前确实处于「正在上传图片」窗口内", `spinner=${spinner}`);

    await clickPublish(page);

    const notice = await page.locator(".ant-message-notice-content", { hasText: "还有图片在上传中" }).count();
    // 守卫失效时帖子会被创建出来，且 media_ids 为空（= 帖 1233 的现象）；这里把证据一并打出来
    const [[leaked]] = await pool.query(
      "SELECT id, media_ids FROM community_posts WHERE title = ? ORDER BY id DESC LIMIT 1",
      [title]
    );
    const n = await postCountByTitle(title);
    ok(notice > 0, "弹出了「还有图片在上传中，请稍等片刻再发布」");
    ok(n === 0, "没有创建帖子（图不会被静默丢弃）", n ? `posts=${n} media_ids=${leaked?.media_ids}（图静默丢了）` : "posts=0");
    ok(new URL(page.url()).pathname === "/community", "仍停在社区页（没有跳进新帖详情）", page.url());
    await page.close();
  }

  // ── 场景②：等上传完成再发布 → 必须带上图 ──────────────────────────────
  console.log("\n场景② 等上传完成再发布（同样延迟，但等到传完）");
  {
    const page = await ctx.newPage();
    await page.route("**/api/media", async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, UPLOAD_DELAY_MS));
      await route.continue();
    });
    const title = await openComposer(page);
    await page.setInputFiles(".oo-rich-editor input[type=\"file\"]", SHOT);
    // 等「正在上传图片...」消失 = 上传真正落地
    await page.locator(".oo-rich-toolbar", { hasText: "正在上传图片" }).waitFor({ state: "detached", timeout: 30000 });

    await clickPublish(page);

    const [[row]] = await pool.query(
      "SELECT id, media_ids FROM community_posts WHERE title = ? ORDER BY id DESC LIMIT 1",
      [title]
    );
    let mediaIds = [];
    try { mediaIds = JSON.parse(row?.media_ids || "[]"); } catch { /* 保持空数组 */ }
    ok(!!row, "帖子已创建");
    ok(Array.isArray(mediaIds) && mediaIds.length > 0, "帖子带上了配图（media_ids 非空）", `media_ids=${row?.media_ids}`);
    await page.close();
  }
} finally {
  await browser.close();
  if (titles.length) {
    // 清理本次测试造的帖子（媒体行 ref_count 归零后由 runGc 回收）
    const [rows] = await pool.query(
      `SELECT id FROM community_posts WHERE title IN (${titles.map(() => "?").join(",")})`,
      titles
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      await pool.query(`DELETE FROM community_posts WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      console.log(`\n已清理测试帖：${ids.join(", ")}`);
    }
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failed === 0 ? "T8 竞态守卫：全部通过" : `T8 竞态守卫：${failed} 项失败`}`);
process.exit(failed ? 1 : 0);
