// 黑白棋 / 翻转棋（Reversi / Othello）—— 8×8
// ---------------------------------------------------------------------------
// 规则要点（实现时最容易漏的三条，都在下面逐一处理）：
//   ① **必须能翻转才可落子**：单纯有空位不够，落子后至少要夹住对方一子；
//      没有合法点时就跳过（这一条不做的话对局会卡死）；
//   ② **夹击可跨多子**：沿一个方向连着的对方棋子全部翻转，不是只翻相邻那颗；
//   ③ **两侧都要有己方棋子**：中间全是对方子且两端为己方才算夹住。
// 另外：一方无子可下而另一方还有 → 跳过；双方都无子可下 → 对局结束按子数判胜。
import { emptyBoard } from "./index.js";

const SIZE = 8;
const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** 从 (x,y) 沿方向找可翻转的对方棋子；找到返回坐标数组（不含己方端点） */
function flipsInDir(board, x, y, dx, dy, side) {
  const foe = side === 1 ? 2 : 1;
  const out = [];
  let nx = x + dx;
  let ny = y + dy;
  while (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && board[ny * SIZE + nx] === foe) {
    out.push(ny * SIZE + nx);
    nx += dx;
    ny += dy;
  }
  // 只有终点是己方棋子且中间至少夹了一颗，才算夹住
  if (!out.length) return [];
  if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return [];
  return board[ny * SIZE + nx] === side ? out : [];
}

/** 该点在 (x,y) 落 side 子会翻转的所有位置（空数组 = 非法落点） */
function flipsAt(board, pos, side) {
  const x = pos % SIZE;
  const y = Math.floor(pos / SIZE);
  if (board[pos] !== 0) return [];
  const all = [];
  for (const [dx, dy] of DIRS) all.push(...flipsInDir(board, x, y, dx, dy, side));
  return all;
}

/** 某一方所有合法落点（无点可下时要跳过，所以必须能枚举） */
function legalMoves(board, side) {
  const out = [];
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === 0 && flipsAt(board, i, side).length) out.push(i);
  }
  return out;
}

function countOf(board, side) {
  return board.filter((c) => c === side).length;
}

export default {
  key: "reversi",
  name: "黑白棋",
  brief: "落子夹住对方棋子即翻面，终局子多者胜",
  players: 2,
  meta: () => ({ rows: SIZE, cols: SIZE, render: "grid-stone", click: "cell", cell: "disc" }),

  init() {
    const board = emptyBoard(SIZE, SIZE);
    // 标准开局：棋盘正中十字摆放（白在 d4/e5，黑在 d5/e4，黑先）
    const mid = SIZE / 2;
    board[(mid - 1) * SIZE + (mid - 1)] = 2;
    board[mid * SIZE + mid] = 2;
    board[(mid - 1) * SIZE + mid] = 1;
    board[mid * SIZE + (mid - 1)] = 1;
    return { phase: "playing", board, turn: 1, lastPos: -1, passCount: 0 };
  },

  view(state) {
    // 合法落点下发给前端：让界面能提示「可落子处」，也避免用户白点
    return {
      board: state.board,
      lastPos: state.lastPos,
      turn: state.turn,
      legal: legalMoves(state.board, state.turn),
      score: { 1: countOf(state.board, 1), 2: countOf(state.board, 2) },
    };
  },

  move(state, { side, payload }) {
    if (state.phase !== "playing") return { error: "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };

    const pos = Math.floor(Number(payload?.position));
    if (!Number.isInteger(pos) || pos < 0 || pos >= SIZE * SIZE) return { error: "落子位置不合法" };
    if (state.board[pos] !== 0) return { error: "该位置已有棋子" };

    const flips = flipsAt(state.board, pos, side);
    if (!flips.length) return { error: "这个位置夹不住对方棋子，换个位置" };

    const board = state.board.slice();
    board[pos] = side;
    for (const f of flips) board[f] = side;

    const foe = side === 1 ? 2 : 1;
    let turn = foe;
    let note = "";
    let passCount = state.passCount || 0;
    // 对方无点可下 → 跳过（不能卡死，否则对局无法继续）
    if (!legalMoves(board, foe).length) {
      if (legalMoves(board, side).length) {
        turn = side;
        passCount += 1;
        note = "对方无子可下，跳过一手";
      } else {
        // 双方都无点可下 → 终局，按子数判定
        const mine = countOf(board, side);
        const theirs = countOf(board, foe);
        return {
          state: { phase: "finished", board, turn: state.turn, lastPos: pos, passCount },
          finished: true,
          winnerSide: mine > theirs ? side : theirs > mine ? foe : 0,
          note: `双方都无子可下，终局 ${mine}:${theirs}`,
        };
      }
    }

    return {
      state: { phase: "playing", board, turn, lastPos: pos, passCount },
      finished: false,
      winnerSide: 0,
      note: note ? `${note}（翻面 ${flips.length} 子）` : `翻面 ${flips.length} 子`,
    };
  },
};
