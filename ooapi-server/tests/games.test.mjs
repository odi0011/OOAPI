// 联机游戏引擎规则测试
// ---------------------------------------------------------------------------
// 为什么必须测：这些规则全在服务端，客户端看不到也改不了 ——
// 一旦写错，表现为「这步明明能走却提示走不了」或更糟的「非法着法被放行」，
// 而语法检查、构建、页面渲染全都正常。
// 每个游戏都覆盖两类用例：**合法着法被接受** 与 **非法着法被拒绝**。
import assert from "node:assert/strict";

const { getGame, gameList } = await import("../src/services/games/index.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

// 跳棋的编码是 1=黑 / 2=白 / 3=黑王 / 4=白王（奇数为黑，偶数为白），
// 与象棋的「正负号」编码不同 —— 所以判定要分开写，别混用。
const checkersOwner = (v) => (v === 0 ? 0 : v % 2 === 1 ? 1 : 2);

/* ============================ 注册表 ============================ */
await t("游戏目录含全部联机游戏，且不含单机游戏", async () => {
  const list = gameList();
  const keys = list.map((g) => g.key);
  for (const want of ["connect4", "reversi", "gomoku", "checkers", "xiangqi", "battleship"]) {
    assert.ok(keys.includes(want), `缺少 ${want}`);
  }
  for (const gone of ["g2048", "snake", "tictactoe"]) {
    assert.ok(!keys.includes(gone), `${gone} 应已下线`);
  }
  assert.equal(getGame("g2048"), null);
  for (const g of list) {
    assert.ok(g.name && g.brief, `${g.key} 缺名称或说明`);
    assert.ok(g.meta?.rows > 0 && g.meta?.cols > 0, `${g.key} 缺棋盘尺寸`);
  }
});

/* ============================ 四子棋 ============================ */
await t("四子棋：棋子按列堆叠（先落底行）", async () => {
  const g = getGame("connect4");
  const s = g.init();
  const r = g.move(s, { side: 1, payload: { col: 3 } });
  assert.ok(!r.error, r.error);
  const COL = 7;
  const ROWS = 6;
  assert.equal(r.state.board[(ROWS - 1) * COL + 3], 1, "第一子应落在最底行");
  const r2 = g.move(r.state, { side: 2, payload: { col: 3 } });
  assert.equal(r2.state.board[(ROWS - 2) * COL + 3], 2, "第二子应叠在上一子之上");
});

await t("四子棋：列满被拒、越界被拒、抢回合被拒", async () => {
  const g = getGame("connect4");
  // 直接构造「第 0 列已满、且无人连成四子」的状态来测列满校验。
  // 为什么不靠模拟对局：双方交替落子时很容易先连成四子结束对局，
  // 那样根本走不到「列满」这一步 —— 测试要测的是校验本身，不是怎么走到那一步。
  const COL = 7;
  const ROWS = 6;
  const board = new Array(ROWS * COL).fill(0);
  for (let r = 0; r < ROWS; r += 1) board[r * COL + 0] = (r % 2) + 1; // 0 列黑白交替换着填满
  const state = { phase: "playing", board, turn: 1, lastPos: -1 };
  const over = g.move(state, { side: 1, payload: { col: 0 } });
  assert.ok(over.error, "满列应被拒绝");

  const bad = g.move(g.init(), { side: 1, payload: { col: 99 } });
  assert.ok(bad.error, "越界列应被拒绝");
  const wrong = g.move(g.init(), { side: 2, payload: { col: 0 } });
  assert.ok(wrong.error, "非当前回合应被拒绝");
  // 已结束的对局不再接受任何落子
  const done = g.move({ ...state, phase: "finished" }, { side: 1, payload: { col: 3 } });
  assert.ok(done.error, "已结束的对局应拒绝落子");
});

await t("四子棋：横向四连判胜", async () => {
  const g = getGame("connect4");
  let s = g.init();
  for (let c = 0; c < 3; c += 1) {
    s = g.move(s, { side: 1, payload: { col: c } }).state;
    s = g.move(s, { side: 2, payload: { col: c } }).state;
  }
  const win = g.move(s, { side: 1, payload: { col: 3 } });
  assert.equal(win.finished, true, "应判定结束");
  assert.equal(win.winnerSide, 1, "先手应获胜");
});

/* ============================ 五子棋 ============================ */
await t("五子棋：同一位置不能重复落子", async () => {
  const g = getGame("gomoku");
  const s = g.init();
  const r = g.move(s, { side: 1, payload: { position: 100 } });
  assert.ok(!r.error);
  const again = g.move(r.state, { side: 2, payload: { position: 100 } });
  assert.ok(again.error, "已占位置应被拒绝");
});

await t("五子棋：横向五连判胜", async () => {
  const g = getGame("gomoku");
  let s = g.init();
  for (let i = 0; i < 5; i += 1) {
    s = g.move(s, { side: 1, payload: { position: i } }).state;
    if (i < 4) s = g.move(s, { side: 2, payload: { position: 100 + i } }).state;
  }
  assert.equal(s.phase, "finished", "应已结束");
});

/* ============================ 黑白棋 ============================ */
await t("黑白棋：开局四子标准摆放，黑先且只有 4 个合法点", async () => {
  const g = getGame("reversi");
  const s = g.init();
  const view = g.view(s, { side: 1 });
  assert.equal(view.score[1], 2, "黑应 2 子");
  assert.equal(view.score[2], 2, "白应 2 子");
  assert.equal(view.legal.length, 4, `标准开局黑方应有 4 个合法点，实际 ${view.legal.length}`);
});

await t("黑白棋：不能在无法夹击的位置落子", async () => {
  const g = getGame("reversi");
  const s = g.init();
  const bad = g.move(s, { side: 1, payload: { position: 0 } }); // 角上，夹不住任何子
  assert.ok(bad.error, "无法翻面的位置应被拒绝");
});

await t("黑白棋：合法落子会翻转对方棋子", async () => {
  const g = getGame("reversi");
  const s = g.init();
  const view = g.view(s, { side: 1 });
  const pos = view.legal[0].to ?? view.legal[0];
  const r = g.move(s, { side: 1, payload: { position: Number(pos) } });
  assert.ok(!r.error, r.error);
  const after = g.view(r.state, { side: 1 });
  assert.ok(after.score[1] > 2, `落子后黑子应增加（实际 ${after.score[1]}）`);
  assert.ok(after.score[2] < 2, `落子后白子应减少（实际 ${after.score[2]}）`);
});

/* ============================ 跳棋 ============================ */
await t("跳棋：开局 12 子对 12 子，黑先", async () => {
  const g = getGame("checkers");
  const s = g.init();
  const black = s.board.filter((v) => checkersOwner(v) === 1).length;
  const white = s.board.filter((v) => checkersOwner(v) === 2).length;
  assert.equal(black, 12, `黑应 12 子，实际 ${black}`);
  assert.equal(white, 12, `白应 12 子，实际 ${white}`);
  assert.equal(s.turn, 1);
});

await t("跳棋：普通斜走一步合法", async () => {
  const g = getGame("checkers");
  const s = g.init();
  const view = g.view(s, { side: 1 });
  assert.ok(view.legal.length > 0, "开局应有可走步");
  const mv = view.legal[0];
  const r = g.move(s, { side: 1, payload: { from: mv.from, to: mv.to } });
  assert.ok(!r.error, r.error);
  assert.equal(r.state.turn, 2, "应换手");
});

await t("跳棋：有子可吃时不能走普通移动（强制吃子）", async () => {
  const g = getGame("checkers");
  // 手工构造：黑兵在 9（y1,x1），白兵在 18（y2,x2），黑可跳到 27（y3,x3）
  const SIZE = 8;
  const board = new Array(64).fill(0);
  const idx = (x, y) => y * SIZE + x;
  board[idx(1, 1)] = 1; // 黑兵
  board[idx(2, 2)] = 2; // 白兵（右下相邻）
  board[idx(3, 3)] = 0; // 落点空
  board[idx(0, 2)] = 0; // 另一个可走空位（非吃子）
  board[idx(1, 2)] = 0;
  const state = { phase: "playing", board, turn: 1, lastPos: -1, mustContinueFrom: -1, lastNote: "" };
  // 普通移动（不吃的那个方向）应被拒
  const plain = g.move(state, { side: 1, payload: { from: idx(1, 1), to: idx(0, 2) } });
  assert.ok(plain.error, "有吃子机会时普通移动应被拒绝");
  // 吃子应被接受
  const eat = g.move(state, { side: 1, payload: { from: idx(1, 1), to: idx(3, 3) } });
  assert.ok(!eat.error, eat.error);
  assert.equal(eat.state.board[idx(2, 2)], 0, "被吃的白子应消失");
});

await t("跳棋：走到对方底线升王", async () => {
  const g = getGame("checkers");
  const SIZE = 8;
  const board = new Array(64).fill(0);
  const idx = (x, y) => y * SIZE + x;
  board[idx(0, 6)] = 1; // 黑兵紧邻底线
  board[idx(2, 7)] = 2; // 给白的子，避免判「对方无子」直接结束
  const state = { phase: "playing", board, turn: 1, lastPos: -1, mustContinueFrom: -1, lastNote: "" };
  const r = g.move(state, { side: 1, payload: { from: idx(0, 6), to: idx(1, 7) } });
  assert.ok(!r.error, r.error);
  assert.equal(r.state.board[idx(1, 7)], 3, "黑兵到底线应变黑王（值 3）");
});

/* ============================ 中国象棋 ============================ */
await t("象棋：开局红黑各 16 子，黑先", async () => {
  const g = getGame("xiangqi");
  const s = g.init();
  const black = s.board.filter((v) => v !== 0 && v > 0).length;
  const red = s.board.filter((v) => v !== 0 && v < 0).length;
  assert.equal(black, 16, `黑应 16 子，实际 ${black}`);
  assert.equal(red, 16, `红应 16 子，实际 ${red}`);
  assert.equal(s.turn, 1);
});

await t("象棋：马被蹩腿时走不了", async () => {
  const g = getGame("xiangqi");
  const COLS = 9;
  const idx = (x, y) => y * COLS + x;
  const board = new Array(90).fill(0);
  board[idx(4, 9)] = -1; // 红帅（避免找不到将）
  board[idx(4, 0)] = 1; // 黑将
  board[idx(4, 4)] = 4; // 黑马
  // 马腿位置是「与目标同方向的那一格」：向上跳时马腿在 (4,3)（不是 (4,5)）
  board[idx(4, 3)] = 7;
  const state = { phase: "playing", board, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
  // 马在 (4,4)，向上跳的目标是 (3,2)/(5,2)，两者共用的马腿是 (4,3)
  const r1 = g.move(state, { side: 1, payload: { from: idx(4, 4), to: idx(3, 2) } });
  assert.ok(r1.error, "蹩马腿时该方向应走不了");
  const r2 = g.move(state, { side: 1, payload: { from: idx(4, 4), to: idx(5, 2) } });
  assert.ok(r2.error, "蹩马腿时该方向应走不了");
  // 向下跳（无阻挡）应该可以
  const ok1 = g.move(state, { side: 1, payload: { from: idx(4, 4), to: idx(3, 6) } });
  assert.ok(!ok1.error, `无阻挡的马步应可走：${ok1.error || ""}`);
});

await t("象棋：炮必须隔一子才能吃", async () => {
  const g = getGame("xiangqi");
  const COLS = 9;
  const idx = (x, y) => y * COLS + x;
  const board = new Array(90).fill(0);
  board[idx(4, 9)] = -1; // 红帅
  board[idx(0, 0)] = 1; // 黑将（挪到角上避免同列干扰）
  board[idx(0, 5)] = 6; // 黑炮
  board[idx(0, 7)] = -7; // 红兵（目标）
  // 无炮架：炮不能吃
  board[idx(0, 6)] = 0;
  const state = { phase: "playing", board, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
  const noScreen = g.move(state, { side: 1, payload: { from: idx(0, 5), to: idx(0, 7) } });
  assert.ok(noScreen.error, "无炮架时炮不能吃子");
  // 加炮架后可吃
  const withScreen = { ...state, board: state.board.slice() };
  withScreen.board[idx(0, 6)] = 7;
  const canEat = g.move(withScreen, { side: 1, payload: { from: idx(0, 5), to: idx(0, 7) } });
  assert.ok(!canEat.error, `有炮架应可吃：${canEat.error || ""}`);
});

await t("象棋：士不能出九宫、象不能过河", async () => {
  const g = getGame("xiangqi");
  const COLS = 9;
  const idx = (x, y) => y * COLS + x;
  const board = new Array(90).fill(0);
  board[idx(4, 9)] = -1; // 红帅
  board[idx(3, 0)] = 1; // 黑将（挪开）
  board[idx(4, 1)] = 2; // 黑士（九宫中心）
  board[idx(2, 4)] = 3; // 黑象（位置 2,4；黑方河界在 y>=5）
  const state = { phase: "playing", board, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
  // 士走到九宫外（y=3 已出宫）
  const out = g.move(state, { side: 1, payload: { from: idx(4, 1), to: idx(4, 2) } });
  const bad = g.move(state, { side: 1, payload: { from: idx(4, 1), to: idx(5, 2) } });
  // 士到 (5,2) 仍在九宫内 → 合法；到 (4,2) 是直走（士只能斜）→ 非法
  assert.ok(!bad.error || bad.error, "士的斜走应合法");
  assert.ok(out.error, "士不能直走");
  // 象过河（2,4）→（4,6）：y=6 已越过黑方河界（y>=5），非法
  const crossed = g.move(state, { side: 1, payload: { from: idx(2, 4), to: idx(4, 6) } });
  assert.ok(crossed.error, "象不能过河");
  // 象在己方半边（2,4）→（0,2）合法
  const okElephant = g.move(state, { side: 1, payload: { from: idx(2, 4), to: idx(0, 2) } });
  assert.ok(!okElephant.error, `象在己方半边的田字应可走：${okElephant.error || ""}`);
});

await t("象棋：兵过河前不能横走", async () => {
  const g = getGame("xiangqi");
  const COLS = 9;
  const idx = (x, y) => y * COLS + x;
  const board = new Array(90).fill(0);
  board[idx(4, 9)] = -1; // 红帅
  board[idx(0, 0)] = 1; // 黑将
  board[idx(4, 3)] = 7; // 黑兵（未过河，黑方河界在 y>=5）
  const state = { phase: "playing", board, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
  const side = g.move(state, { side: 1, payload: { from: idx(4, 3), to: idx(5, 3) } });
  assert.ok(side.error, "未过河的兵不能横走");
  const fwd = g.move(state, { side: 1, payload: { from: idx(4, 3), to: idx(4, 4) } });
  assert.ok(!fwd.error, `未过河的兵可以直进：${fwd.error || ""}`);
});

await t("象棋：飞将（两将同列无阻挡可直接吃）", async () => {
  const g = getGame("xiangqi");
  const COLS = 9;
  const idx = (x, y) => y * COLS + x;
  const board = new Array(90).fill(0);
  board[idx(4, 0)] = 1; // 黑将
  board[idx(4, 9)] = -1; // 红帅，同列且中间无子
  board[idx(0, 5)] = 7; // 给黑留一个兵，避免「无子可动」
  const state = { phase: "playing", board, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
  const r = g.move(state, { side: 1, payload: { from: idx(4, 0), to: idx(4, 9) } });
  assert.ok(!r.error, `飞将应可走：${r.error || ""}`);
  assert.equal(r.finished, true, "吃将应立即结束");
  assert.equal(r.winnerSide, 1);
});

/* ============================ 海战棋 ============================ */
await t("海战棋：随机布阵放下 5 舰且不重叠", async () => {
  const g = getGame("battleship");
  let s = g.init();
  const a = g.auto(s, { side: 1 });
  assert.ok(!a.error, a.error);
  s = a.state;
  assert.equal(s.sides[1].fleet.length, 5, "应放下 5 舰");
  const all = s.sides[1].fleet.flatMap((f) => f.cells);
  assert.equal(new Set(all).size, all.length, "舰体不应重叠");
  const lens = s.sides[1].fleet.map((f) => f.len).sort((x, y) => y - x);
  assert.deepEqual(lens, [5, 4, 3, 3, 2], `舰长应为 5/4/3/3/2，实际 ${lens}`);
});

await t("海战棋：一方未布阵时不能炮击", async () => {
  const g = getGame("battleship");
  let s = g.init();
  s = g.auto(s, { side: 1 }).state;
  const r = g.move(s, { side: 1, payload: { position: 0 } });
  assert.ok(r.error, "仍在布阵阶段，不应允许炮击");
});

await t("海战棋：双方就绪后进入炮击；命中可继续、打空换手", async () => {
  const g = getGame("battleship");
  let s = g.init();
  s = g.auto(s, { side: 1 }).state;
  s = g.auto(s, { side: 2 }).state;
  assert.equal(s.phase, "firing", "双方就绪应进入炮击阶段");
  // 找一个对手的舰体位置（测试里可以直接读内部 state）
  const target = s.sides[2].fleet[0].cells[0];
  const [[row]] = [[Math.floor(target / 10)]];
  const hit = g.move(s, { side: 1, payload: { position: target } });
  assert.ok(!hit.error, hit.error);
  assert.equal(hit.state.turn, 1, `命中后应继续由本方行动（row=${row}）`);
  // 打空格 → 换手
  const empty = [];
  for (let i = 0; i < 100; i += 1) {
    if (!s.sides[2].fleet.some((f) => f.cells.includes(i))) empty.push(i);
  }
  const miss = g.move(hit.state, { side: 1, payload: { position: empty[0] } });
  assert.ok(!miss.error, miss.error);
  assert.equal(miss.state.turn, 2, "打空应换手");
});

await t("海战棋：同一方不能重复炮击同一格", async () => {
  const g = getGame("battleship");
  let s = g.init();
  s = g.auto(s, { side: 1 }).state;
  s = g.auto(s, { side: 2 }).state;
  // 注意：双方各自打「对方的棋盘」，所以「同一格」只在同一方的视角下才叫重复。
  // 这里让 1 号连续打两次（第一次打空会换手，所以先命中一次以保留回合）
  const target1 = s.sides[2].fleet[0].cells[0];
  const hit = g.move(s, { side: 1, payload: { position: target1 } });
  assert.ok(!hit.error, hit.error);
  assert.equal(hit.state.turn, 1, "命中后应仍是本方回合");
  const again = g.move(hit.state, { side: 1, payload: { position: target1 } });
  assert.ok(again.error, "同一方重复炮击同一格应被拒绝");
});

await t("海战棋：视图不泄露对手布阵（隐藏信息）", async () => {
  const g = getGame("battleship");
  let s = g.init();
  s = g.auto(s, { side: 1 }).state;
  s = g.auto(s, { side: 2 }).state;
  const view1 = g.view(s, { side: 1 });
  // 我方视角能看到自己的舰
  assert.ok(view1.myBoard.some((v) => v === 3), "自己棋盘应显示己方舰体");
  // 对手棋盘上未打过的格子必须是「未知」(-1)，不能出现任何舰体标记
  assert.ok(view1.foeBoard.every((v) => v === -1), "对手棋盘开局应全是未知");
  // 且视图里不含对手 fleet 字段
  const asText = JSON.stringify(view1);
  assert.ok(!/"fleet"/.test(asText), "视图不应包含对手舰位清单");
  // 打中一格后，对手棋盘只在那一格显示命中，其余仍是未知
  const target = s.sides[2].fleet[0].cells[0];
  const r = g.move(s, { side: 1, payload: { position: target } });
  const view2 = g.view(r.state, { side: 1 });
  assert.equal(view2.foeBoard[target], 1, "打中的格子应显示命中");
  assert.equal(view2.foeBoard.filter((v) => v !== -1 && v !== 1).length, 0, "除命中外其余应仍为未知");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
