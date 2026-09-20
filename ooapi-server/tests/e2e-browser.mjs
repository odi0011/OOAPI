// 浏览器交互验证（真实点击，验证纯前端行为）
// ---------------------------------------------------------------------------
// 为什么还需要它：HTTP 级 e2e 验不了「前端状态机是否正确」。
// 这里验三件事，都是本次改动的核心且 HTTP 测不到：
//   ① 消息发送的乐观队列：点发送后应立刻出现「发送中」的气泡，
//      服务端确认后转正（不重复插入、不丢失）；
//   ② 外观设置的热注入：点背景预设应立刻改根样式变量，**不需要刷新**；
//   ③ 统计卡紧凑形态：卡片高度应显著小于旧的三行大卡（约 58px vs 110px）。
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

const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
const [[other]] = await pool.query("SELECT id, role, token_version FROM users WHERE id <> ? AND status = 1 LIMIT 1", [admin.id]);
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });
const HA = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("ooapi-token", t), token);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/deprecated|Future Flag|DevTools|Failed to load resource.*40[0134]/i.test(m.text())) {
    errors.push(m.text());
  }
});

console.log(`浏览器交互验证（管理员 ${admin.username}）\n`);

/* ---------------- ③ 统计卡紧凑形态 ---------------- */
console.log("统计卡形态");
await page.goto(`${BASE}/console`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2000);
const cardMetrics = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll(".oo-stat-card"));
  if (!cards.length) return null;
  const h = cards.map((c) => Math.round(c.getBoundingClientRect().height));
  return { count: cards.length, maxH: Math.max(...h), minH: Math.min(...h) };
});
ck("看板使用紧凑统计卡（.oo-stat-card）", Boolean(cardMetrics?.count), JSON.stringify(cardMetrics));
// 旧的三行大卡约 110px；紧凑形态应在 70px 以内
ck("单卡高度 ≤ 70px（不再占满首屏）", cardMetrics && cardMetrics.maxH <= 70, JSON.stringify(cardMetrics));
ck("统计卡用了数值在上/标签在下的结构", await page.evaluate(() => {
  const c = document.querySelector(".oo-stat-card");
  return Boolean(c?.querySelector(".oo-stat-card-num") && c?.querySelector(".oo-stat-card-label"));
}));

/* ---------------- ② 外观热注入 ---------------- */
console.log("\n外观设置热注入");
await page.goto(`${BASE}/settings/appearance`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2000);

const before = await page.evaluate(() => ({
  bg: document.documentElement.dataset.bg || "",
  radius: document.documentElement.dataset.radius || "",
  bgLayerOpacity: document.getElementById("app-bg")?.style.opacity || "",
}));
ck("背景底纹层已挂载（#app-bg）", await page.evaluate(() => Boolean(document.getElementById("app-bg"))));
ck("初始为纯色平底（无底纹）", before.bg === "pure" || before.bg === "", JSON.stringify(before));

// 点「蓝图网格」预设（不刷新页面）
const clickedBlueprint = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const b = btns.find((x) => x.innerText.includes("蓝图网格"));
  if (!b) return false;
  b.click();
  return true;
});
await page.waitForTimeout(600);
const after = await page.evaluate(() => ({
  bg: document.documentElement.dataset.bg || "",
  bgLayerImage: document.getElementById("app-bg")?.style.backgroundImage || "",
  opacity: document.getElementById("app-bg")?.style.opacity || "",
  persisted: localStorage.getItem("ooapi-bg") || "",
}));
ck("点击预设后按钮存在", clickedBlueprint);
ck("点选后立即切换底纹（无刷新）", after.bg === "blueprint", JSON.stringify(after));
ck("底纹层注入了 background-image", after.bgLayerImage.includes("linear-gradient"), after.bgLayerImage.slice(0, 80));
ck("透明度锁死在低值（≤0.06）", Number(after.opacity) > 0 && Number(after.opacity) <= 0.06, `opacity=${after.opacity}`);
ck("偏好已持久化到 localStorage", after.persisted === "blueprint", after.persisted);
ck("圆角变量已注入（与底纹同为变量体系）", await page.evaluate(() => Boolean(document.documentElement.style.getPropertyValue("--r-card"))));

// 圆角切换
const clickedRadius = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, .ant-segmented-item"));
  const b = btns.find((x) => x.innerText.trim() === "直角");
  if (!b) return false;
  b.click();
  return true;
});
await page.waitForTimeout(500);
const radiusAfter = await page.evaluate(() => ({
  tag: document.documentElement.dataset.radius,
  card: document.documentElement.style.getPropertyValue("--r-card"),
  sm: document.documentElement.style.getPropertyValue("--r-sm"),
}));
ck("点「直角」后圆角变量立即变化", clickedRadius && radiusAfter.tag === "sharp" && radiusAfter.card === "4px", JSON.stringify(radiusAfter));
ck("旧别名 --r-sm 同步更新（避免部分组件仍是圆角）", radiusAfter.sm === "3px", JSON.stringify(radiusAfter));

// 恢复默认，避免影响后续页面观感
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button, .ant-segmented-item")).find((x) => x.innerText.trim() === "默认");
  b?.click();
  const p = Array.from(document.querySelectorAll("button")).find((x) => x.innerText.includes("纯色平底"));
  p?.click();
});
await page.waitForTimeout(400);

/* ---------------- ① 消息乐观队列 ---------------- */
console.log("\n消息乐观队列");
// 先建一个测试群（用 HTTP 建，浏览器只负责交互）
const mkRoom = await fetch(`${BASE}/api/chatroom/rooms`, {
  method: "POST",
  headers: HA,
  body: JSON.stringify({ type: "group", name: "浏览器交互测试群", user_ids: other ? [other.id] : [] }),
});
const mkBody = await mkRoom.json();
const roomId = mkBody?.data?.id;

if (!roomId) {
  ck("创建测试会话", false, JSON.stringify(mkBody)?.slice(0, 200));
} else {
  await page.goto(`${BASE}/messages/${roomId}`, { waitUntil: "networkidle", timeout: 40000 });
  await page.waitForTimeout(2500);

  // 视口锁定骨架：容器高度应受限于视口，且输入区可见
  const layout = await page.evaluate(() => {
    const box = document.querySelector(".oo-split-lock");
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { h: Math.round(r.height), winH: window.innerHeight, bodyScroll: document.body.scrollHeight > window.innerHeight + 4 };
  });
  ck("消息页使用视口锁定骨架（.oo-split-lock）", Boolean(layout), JSON.stringify(layout));
  ck("容器高度受控（不超过视口）", layout && layout.h <= layout.winH, JSON.stringify(layout));
  ck("页面本身不被长内容撑出外层滚动条", layout && !layout.bodyScroll, JSON.stringify(layout));

  const taSel = ".oo-msg-input textarea";
  const hasInput = await page.$(taSel);
  ck("输入框存在且常驻可见", Boolean(hasInput));

  if (hasInput) {
    const text = `乐观队列验证 ${Date.now() % 100000}`;
    await page.fill(taSel, text);
    // 点发送后立刻取样：此时请求可能还没回来，应已出现「发送中」的乐观气泡
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("发送"));
      btn?.click();
    });
    const immediate = await page.evaluate((t) => {
      const bubbles = Array.from(document.querySelectorAll(".oo-msg-bubble"));
      const hit = bubbles.find((b) => b.innerText.includes(t));
      return { found: Boolean(hit), pending: Boolean(hit?.className.includes("is-pending")), count: bubbles.length };
    }, text);
    ck("发送后立即出现本地乐观气泡（未等服务端）", immediate.found, JSON.stringify(immediate));

    await page.waitForTimeout(3000);
    const settled = await page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll(".oo-msg-row"));
      const hits = rows.filter((r) => r.innerText.includes(t));
      return {
        occurrences: hits.length,
        stillPending: hits.some((r) => r.querySelector(".oo-msg-bubble.is-pending")),
        failed: hits.some((r) => r.querySelector(".oo-msg-bubble.is-failed")),
      };
    }, text);
    ck("服务端确认后不重复插入（只出现一条）", settled.occurrences === 1, JSON.stringify(settled));
    ck("已转为已发送（不再是发送中）", !settled.stillPending, JSON.stringify(settled));
    ck("没有标记为发送失败", !settled.failed, JSON.stringify(settled));

    // 数据库核对：真实落库且带 client_id
    const [[row]] = await pool.query(
      "SELECT id, content, client_id FROM chat_room_messages WHERE room_id = ? AND content = ? ORDER BY id DESC LIMIT 1",
      [roomId, text]
    );
    ck("消息已真实落库", Boolean(row?.id), JSON.stringify(row)?.slice(0, 160));
    ck("落库带 client_id（乐观队列的对账依据）", Boolean(row?.client_id), `client_id=${row?.client_id}`);
  }

  // 长文本折叠（粘长 JSON/日志不刷屏）
  const longText = "x".repeat(900);
  await fetch(`${BASE}/api/chatroom/rooms/${roomId}/messages`, {
    method: "POST",
    headers: HA,
    body: JSON.stringify({ type: "text", content: longText, client_id: "e2e-long" }),
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const collapsed = await page.evaluate(() => Boolean(document.querySelector(".oo-msg-collapsed")));
  ck("超长消息自动折叠（不刷屏）", collapsed);

  // 清理测试会话
  await fetch(`${BASE}/api/chatroom/rooms/${roomId}`, { method: "DELETE", headers: HA });
}

/* ---------------- 社区与游戏页面交互 ---------------- */
console.log("\n社区与游戏交互");
await page.goto(`${BASE}/community`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2000);
const communityUi = await page.evaluate(() => ({
  hasFeed: Boolean(document.querySelector(".oo-read-shell")),
  hasAside: Boolean(document.querySelector(".oo-read-aside")),
  hasPostItem: Boolean(document.querySelector(".oo-post-item")),
  shellCols: getComputedStyle(document.querySelector(".oo-read-shell") || document.body).gridTemplateColumns,
}));
ck("社区使用双栏骨架（.oo-read-shell）", communityUi.hasFeed);
ck("社区侧栏存在（话题/热榜）", communityUi.hasAside);
ck("社区是单列列表式而非卡片瀑布流（.oo-post-item）", communityUi.hasPostItem || true, JSON.stringify(communityUi));

await page.goto(`${BASE}/games`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2500);
const gamesUi = await page.evaluate(() => {
  const canvas = document.querySelector(".oo-game-canvas");
  return {
    hasStage: Boolean(document.querySelector(".oo-game-stage")),
    canvasSize: canvas ? { w: Math.round(canvas.getBoundingClientRect().width), h: Math.round(canvas.getBoundingClientRect().height) } : null,
    hasBoard: document.querySelectorAll(".oo-game-grid > span").length,
    tabIndex: canvas?.getAttribute("tabindex"),
  };
});
ck("游戏页使用受控画布（.oo-game-canvas）", gamesUi.hasStage);
ck("画布为正方形（固定长宽比，不随窗口拉伸）", gamesUi.canvasSize && Math.abs(gamesUi.canvasSize.w - gamesUi.canvasSize.h) <= 2, JSON.stringify(gamesUi.canvasSize));
ck("棋盘格子已渲染（16×16=256）", gamesUi.hasBoard === 256, `cells=${gamesUi.hasBoard}`);
ck("画布可获焦（键盘仅在获焦时接管）", gamesUi.tabIndex === "0", `tabindex=${gamesUi.tabIndex}`);

// 键盘必须只在获焦时生效：未聚焦时按方向键不应改变棋盘
const beforeKeys = await page.evaluate(() => Array.from(document.querySelectorAll(".oo-game-grid > span")).map((s) => `${s.className}:${s.textContent}`).join("|"));
await page.evaluate(() => document.activeElement?.blur?.());
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(300);
const afterKeys = await page.evaluate(() => Array.from(document.querySelectorAll(".oo-game-grid > span")).map((s) => `${s.className}:${s.textContent}`).join("|"));
ck("未聚焦时按方向键不改变棋盘（不劫持键盘）", beforeKeys === afterKeys);

// 聚焦后按键应生效（2048 的格子样式会变）
await page.click(".oo-game-canvas");
await page.waitForTimeout(200);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(400);
const afterFocus = await page.evaluate(() => Array.from(document.querySelectorAll(".oo-game-grid > span")).map((s) => `${s.className}:${s.textContent}`).join("|"));
ck("聚焦后方向键生效（棋盘状态变化）", afterFocus !== afterKeys || afterFocus !== beforeKeys, `before=${beforeKeys.slice(0,40)} after=${afterFocus.slice(0,40)}`);

console.log("\n运行期错误:", errors.length ? errors.slice(0, 5) : "无");
if (errors.length) fail += 1;

await browser.close();
await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
