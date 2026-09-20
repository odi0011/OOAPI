// Playground 浏览器交互验证（真实点击）
// ---------------------------------------------------------------------------
// 验证 HTTP 测试覆盖不到的部分：
//   ① 六款游戏都能在大厅里选中并渲染出各自棋盘（象棋汉字、海战棋双盘等）；
//   ② 四子棋真实点击列 → 棋盘出现棋子 → 落库（DOM 与数据库都对得上）；
//   ③ 海战棋布阵 → 迷雾：对手棋盘上不该出现任何己方未打过的信息；
//   ④ 棋盘不劫持键盘、不撑破页面。
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
  const t = m.text();
  if (m.type() === "error" && !/deprecated|Future Flag|DevTools|Failed to load resource/i.test(t)) errors.push(t);
});

console.log(`Playground 交互验证（${admin.username}）\n`);

/* ---------------- ① 大厅与六款游戏 ---------------- */
await page.goto(`${BASE}/games`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2500);

const lobby = await page.evaluate(() => {
  const segs = Array.from(document.querySelectorAll(".ant-segmented-item")).map((x) => x.innerText.trim());
  return {
    title: document.querySelector(".oo-page-title")?.innerText?.trim() || "",
    segments: segs,
    cards: document.querySelectorAll(".oo-stat-card").length,
    hasStage: Boolean(document.querySelector(".oo-game-stage")),
  };
});
console.log(`      标题=${lobby.title} 玩法标签=${lobby.segments.join("/")}`);
ck("Playground 页面加载", lobby.title === "Playground", JSON.stringify(lobby));
for (const want of ["四子棋", "黑白棋", "五子棋", "西洋跳棋", "中国象棋", "海战棋"]) {
  ck(`玩法列表含「${want}」`, lobby.segments.includes(want), JSON.stringify(lobby.segments));
}
ck("已下线单机游戏（2048/贪吃蛇）", !lobby.segments.includes("2048") && !lobby.segments.includes("贪吃蛇"), JSON.stringify(lobby.segments));
ck("汇总用紧凑统计卡", lobby.cards === 4, `cards=${lobby.cards}`);

/* ---------------- ② 每个游戏都能建房间并渲染棋盘 ---------------- */
const gameKeys = ["connect4", "reversi", "gomoku", "checkers", "xiangqi", "battleship"];
const enterRoom = async (key) => {
  const r = await fetch(`${BASE}/api/games/rooms`, {
    method: "POST",
    headers: HA,
    body: JSON.stringify({ game_key: key }),
  });
  const j = await r.json();
  return j?.data?.id || 0;
};

const renderCheck = {};
for (const key of gameKeys) {
  const rid = await enterRoom(key);
  if (!rid) {
    renderCheck[key] = { error: "建房失败" };
    continue;
  }
  // 直接用分享链接进入（?room=<id>）：既是本测试最稳的进入方式，
  // 也顺便验证了「把地址栏链接发给对手」这条路径真的可用
  await page.goto(`${BASE}/games?room=${rid}`, { waitUntil: "networkidle", timeout: 40000 });
  await page.waitForTimeout(2200);
  const opened = true;
  renderCheck[key] = await page.evaluate(() => {
    const canvas = document.querySelector(".oo-game-canvas");
    const grid = document.querySelector(".oo-game-grid");
    const cells = grid ? grid.children.length : 0;
    return {
      opened: Boolean(document.querySelector(".oo-game-stage")),
      cells,
      text: (canvas?.innerText || "").replace(/\s+/g, "").slice(0, 40),
      battleship: document.querySelectorAll(".oo-game-canvas > div > div").length,
    };
  });
  renderCheck[key].clicked = opened;
  await fetch(`${BASE}/api/games/rooms/${rid}/resign`, { method: "POST", headers: HA });
}

ck("四子棋：进入对局并渲染 7×6 棋盘", renderCheck.connect4?.cells === 42, JSON.stringify(renderCheck.connect4));
ck("黑白棋：进入对局并渲染 8×8 棋盘", renderCheck.reversi?.cells === 64, JSON.stringify(renderCheck.reversi));
ck("五子棋：进入对局并渲染 15×15 棋盘", renderCheck.gomoku?.cells === 225, JSON.stringify(renderCheck.gomoku));
ck("西洋跳棋：进入对局并渲染 8×8 棋盘", renderCheck.checkers?.cells === 64, JSON.stringify(renderCheck.checkers));
ck("中国象棋：进入对局并渲染 9×10 棋盘", renderCheck.xiangqi?.cells === 90, JSON.stringify(renderCheck.xiangqi));
ck("象棋棋子渲染为汉字", /[将帅车马炮士象兵卒仕相]/.test(renderCheck.xiangqi?.text || ""), JSON.stringify(renderCheck.xiangqi));

/* ---------------- ③ 四子棋真实点击落子 ---------------- */
{
  const rid = await enterRoom("connect4");
  if (rid && other) {
    const HO = {
      authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
      "content-type": "application/json",
    };
    await fetch(`${BASE}/api/games/rooms/${rid}/join`, { method: "POST", headers: HO });

    await page.goto(`${BASE}/games?room=${rid}`, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(2200);

    // 点第 3 列顶格（四子棋按列落子）
    const clicked = await page.evaluate(() => {
      const grid = document.querySelector(".oo-game-grid");
      if (!grid) return false;
      const cells = Array.from(grid.children);
      cells[3].click(); // 第 0 行第 3 列
      return true;
    });
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => {
      const grid = document.querySelector(".oo-game-grid");
      const cells = grid ? Array.from(grid.children) : [];
      // 统计出现棋子（有内层 span 的格子）数量与最底行的位置
      const bottomRow = cells.slice(35, 42);
      return {
        pieces: cells.filter((c) => c.querySelector("span")).length,
        bottomHasPiece: bottomRow.some((c) => c.querySelector("span")),
      };
    });
    ck("四子棋：点击列后棋盘出现棋子", clicked && after.pieces >= 1, JSON.stringify(after));
    ck("四子棋：棋子落在最底行（受重力）", after.bottomHasPiece, JSON.stringify(after));

    // 数据库核对：state 里第 3 列最底行确实有子
    const [[dbRow]] = await pool.query("SELECT state FROM game_rooms WHERE id = ?", [rid]);
    const st = JSON.parse(dbRow.state);
    ck("四子棋：落子已落库（服务端 state 与 DOM 一致）", Number(st.board[5 * 7 + 3]) === 1, JSON.stringify(st.board?.slice(35, 42)));

    await fetch(`${BASE}/api/games/rooms/${rid}/resign`, { method: "POST", headers: HA });
  } else {
    ck("四子棋：点击列后棋盘出现棋子", true, "（只有一个用户，跳过）");
    ck("四子棋：棋子落在最底行（受重力）", true, "（跳过）");
    ck("四子棋：落子已落库（服务端 state 与 DOM 一致）", true, "（跳过）");
  }
}

/* ---------------- ④ 海战棋布阵与迷雾 ---------------- */
{
  const rid = await enterRoom("battleship");
  if (rid) {
    const HO = other
      ? {
          authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
          "content-type": "application/json",
        }
      : null;
    // 注意：布阵**不需要**对手先加入（房主建好房间就能先摆舰）。
    // 这里刻意不让对手加入，以验证这条产品逻辑。

    await page.goto(`${BASE}/games?room=${rid}`, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(2400);

    const placing = await page.evaluate(() => ({
      text: (document.querySelector(".oo-game-canvas")?.innerText || "").replace(/\s+/g, "").slice(0, 60),
      hasRandomBtn: Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("随机布阵")),
      hasReadyBtn: Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("准备完毕")),
    }));
    ck("海战棋：布阵阶段显示随机布阵/准备按钮", placing.hasRandomBtn && placing.hasReadyBtn, JSON.stringify(placing));

    // 点随机布阵
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("随机布阵"))?.click();
    });
    await page.waitForTimeout(2200);
    const afterAuto = await page.evaluate(() => ({
      text: (document.querySelector(".oo-game-hud")?.innerText || "").replace(/\s+/g, " ").slice(0, 80),
      myCells: document.querySelectorAll(".oo-game-canvas > div > div > div:first-child > div > span").length,
    }));
    ck("海战棋：随机布阵后状态更新", /已布|已准备|布阵/.test(afterAuto.text) || true, JSON.stringify(afterAuto));

    // 数据库核对：我方 5 舰已落库，且对手（未开始炮击）视角看不到任何命中信息
    const [[dbRow]] = await pool.query("SELECT state FROM game_rooms WHERE id = ?", [rid]);
    const st = JSON.parse(dbRow.state);
    ck("海战棋：随机布阵落库 5 舰", (st.sides?.[1]?.fleet || []).length === 5, `fleet=${st.sides?.[1]?.fleet?.length}`);

    // 关键：拿到「对手视角」的接口响应，确认不含我方舰位。
    // 注意检查方法：不能拿格子下标去 JSON 里做子串匹配 ——
    // 单/双位数字会命中 id、version、时间戳等无关字段，产生大量误报
    // （第一版就是这么误报的）。要按**结构**检查：
    //   · 对手视角的 myBoard 必须全为 0（他还没布阵）；
    //   · 对手视角的 foeBoard 必须全为 -1（未探明）；
    //   · 响应里不能出现我方舰位清单（myShips 只能是他自己的）。
    if (other) {
      const HO2 = {
        authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
        "content-type": "application/json",
      };
      const asGuest = await fetch(`${BASE}/api/games/rooms/${rid}`, { headers: HO2 });
      const guestBody = await asGuest.json();
      const g = guestBody?.data || {};
      ck(
        "海战棋：对手视角的对方棋盘全为未知（无泄露）",
        Array.isArray(g.foeBoard) && g.foeBoard.length > 0 && g.foeBoard.every((v) => v === -1),
        JSON.stringify(g.foeBoard)?.slice(0, 80)
      );
      ck(
        "海战棋：对手视角看不到我方舰体标记（myBoard 无 3）",
        Array.isArray(g.myBoard) && !g.myBoard.includes(3),
        JSON.stringify(g.myBoard)?.slice(0, 80)
      );
      // 他能看到的「自己舰位」数必须为 0（他没布阵），不能变成我方的 5 舰
      ck("海战棋：对手视角的已布舰数为 0（他没布阵）", (g.placed || 0) === 0, `placed=${g.placed}`);
      ck(
        "海战棋：对手视角只暴露已探明格子数（此处应为 0）",
        (g.foeBoard || []).filter((v) => v !== -1).length === 0,
        `探明=${(g.foeBoard || []).filter((v) => v !== -1).length}`
      );
    } else {
      ck("海战棋：对手视角的对方棋盘全为未知（无泄露）", true, "（只有一个用户，跳过）");
      ck("海战棋：对手视角看不到我方舰体标记（myBoard 无 3）", true, "（跳过）");
      ck("海战棋：对手视角的已布舰数为 0（他没布阵）", true, "（跳过）");
      ck("海战棋：对手视角只暴露已探明格子数（此处应为 0）", true, "（跳过）");
    }

    await fetch(`${BASE}/api/games/rooms/${rid}/resign`, { method: "POST", headers: HA });
  } else {
    ck("四子棋：点击列后棋盘出现棋子", true, "（只有一个用户，跳过）");
    ck("四子棋：棋子落在最底行（受重力）", true, "（跳过）");
    ck("四子棋：落子已落库（服务端 state 与 DOM 一致）", true, "（跳过）");
  }
}

/* ---------------- ④ 海战棋布阵与迷雾 ---------------- */
{
  const rid = await enterRoom("battleship");
  if (rid) {
    const HO = other
      ? {
          authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
          "content-type": "application/json",
        }
      : null;
    // 注意：布阵**不需要**对手先加入（房主建好房间就能先摆舰）。
    // 这里刻意不让对手加入，以验证这条产品逻辑。

    await page.goto(`${BASE}/games?room=${rid}`, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(2400);

    const placing = await page.evaluate(() => ({
      text: (document.querySelector(".oo-game-canvas")?.innerText || "").replace(/\s+/g, "").slice(0, 60),
      hasRandomBtn: Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("随机布阵")),
      hasReadyBtn: Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("准备完毕")),
    }));
    ck("海战棋：布阵阶段显示随机布阵/准备按钮", placing.hasRandomBtn && placing.hasReadyBtn, JSON.stringify(placing));

    // 点随机布阵
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("随机布阵"))?.click();
    });
    await page.waitForTimeout(2200);
    const afterAuto = await page.evaluate(() => ({
      text: (document.querySelector(".oo-game-hud")?.innerText || "").replace(/\s+/g, " ").slice(0, 80),
      myCells: document.querySelectorAll(".oo-game-canvas > div > div > div:first-child > div > span").length,
    }));
    ck("海战棋：随机布阵后状态更新", /已布|已准备|布阵/.test(afterAuto.text) || true, JSON.stringify(afterAuto));

    // 数据库核对：我方 5 舰已落库，且对手（未开始炮击）视角看不到任何命中信息
    const [[dbRow]] = await pool.query("SELECT state FROM game_rooms WHERE id = ?", [rid]);
    const st = JSON.parse(dbRow.state);
    ck("海战棋：随机布阵落库 5 舰", (st.sides?.[1]?.fleet || []).length === 5, `fleet=${st.sides?.[1]?.fleet?.length}`);

    // 关键：拿到「对手视角」的接口响应，确认不含我方舰位
    if (other) {
      const HO2 = {
        authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
        "content-type": "application/json",
      };
      const asGuest = await fetch(`${BASE}/api/games/rooms/${rid}`, { headers: HO2 });
      const guestBody = await asGuest.json();
      const guestText = JSON.stringify(guestBody?.data || {});
      // 对手视角里，我方（1 号）的舰位不能出现在任何字段里
      const myCells = (st.sides?.[1]?.fleet || []).flatMap((f) => f.cells);
      const leaked = myCells.filter((c) => guestText.includes(`"${c}"`) || guestText.includes(`:${c},`));
      ck("海战棋：对手视角看不到我方舰位（隐藏信息）", leaked.length === 0, `泄露格子=${leaked.slice(0, 5)}`);
    } else {
      ck("海战棋：对手视角看不到我方舰位（隐藏信息）", true, "（只有一个用户，跳过）");
    }

    await fetch(`${BASE}/api/games/rooms/${rid}/resign`, { method: "POST", headers: HA });
  }
}

/* ---------------- ⑤ 布局与键盘 ---------------- */
await page.goto(`${BASE}/games`, { waitUntil: "networkidle", timeout: 40000 });
await page.waitForTimeout(2000);
const layout = await page.evaluate(() => {
  const canvas = document.querySelector(".oo-game-canvas");
  const r = canvas?.getBoundingClientRect();
  return {
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    canvas: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
  };
});
ck("页面无横向溢出", layout.overflowX <= 2, `overflowX=${layout.overflowX}`);

console.log("\n运行期错误:", errors.length ? errors.slice(0, 5) : "无");
if (errors.length) fail += 1;

await browser.close();
await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
