// 中国象棋（Xiangqi）—— 9 列 × 10 行
// ---------------------------------------------------------------------------
// 这是本批规则最多的游戏，逐条实现（每一条都对应一类常见漏判）：
//   · 车：直线无阻挡；炮：直线且**恰好吃子时中间必须有一枚棋子（炮架）**；
//   · 马：走日字，**蹩马腿**（马腿位置有子则不能走）；
//   · 象/相：走田字，**塞象眼**（田心位置有子则不能走）且**不过河**；
//   · 士/仕：斜走一格，**只能在自己九宫内**；
//   · 将/帅：直走一格，**只能在九宫内**；**飞将**（两将同列且中间无子时，
//     可以直接「吃」对方的将）；
//   · 兵/卒：**过河前只能向前**，过河后可左右横走，永不后退。
//
// 编码：0 空；黑方（上，side1）用 1..7，白…不，红方（下，side2）用 11..17。
// 十位表示归属（1=黑 1x，红 2x…）→ 改用「值 1-7 为黑，11-17 为红」不好认，
// 这里用**符号**：正数=黑，负数=红，绝对值 1..7 表示兵种。
//   1 将/帅 2 士 3 象 4 马 5 车 6 炮 7 兵/卒
// 这样 owner(v) = v > 0 ? 黑 : 红，读起来直观，也不会出现「忘了取模」的错。
import { emptyBoard } from "./shared.js";

const COLS = 9;
const ROWS = 10;
const K = { KING: 1, ADVISOR: 2, ELEPHANT: 3, HORSE: 4, CHARIOT: 5, CANNON: 6, PAWN: 7 };

const idx = (x, y) => y * COLS + x;
const xy = (pos) => ({ x: pos % COLS, y: Math.floor(pos / COLS) });
/** 归属：1 = 黑（上），2 = 红（下）。用符号区分，避免再多一个数组。 */
const owner = (v) => (v === 0 ? 0 : v > 0 ? 1 : 2);
const sign = (side) => (side === 1 ? 1 : -1);
/** 九宫范围（列 3-5；黑 0-2 行，红 7-9 行） */
function inPalace(x, y, side) {
  if (x < 3 || x > 5) return false;
  return side === 1 ? y >= 0 && y <= 2 : y >= 7 && y <= 9;
}
/** 是否已过河（黑在上，过河 = y >= 5；红在下，过河 = y <= 4） */
function crossedRiver(y, side) {
  return side === 1 ? y >= 5 : y <= 4;
}

/** 标准开局摆子 */
function initialState() {
  const b = emptyBoard(ROWS, COLS);
  const back = [K.CHARIOT, K.HORSE, K.ELEPHANT, K.ADVISOR, K.KING, K.ADVISOR, K.ELEPHANT, K.HORSE, K.CHARIOT];
  for (let x = 0; x < COLS; x += 1) {
    b[idx(x, 0)] = back[x]; // 黑方底排
    b[idx(x, 9)] = -back[x]; // 红方底排
  }
  b[idx(1, 2)] = K.CANNON;
  b[idx(7, 2)] = K.CANNON;
  b[idx(1, 7)] = -K.CANNON;
  b[idx(7, 7)] = -K.CANNON;
  for (const x of [0, 2, 4, 6, 8]) {
    b[idx(x, 3)] = K.PAWN;
    b[idx(x, 6)] = -K.PAWN;
  }
  return { phase: "playing", board: b, turn: 1, lastPos: -1, lastNote: "", checkSide: 0 };
}

/** 直线可走点：车/炮/将帅飞将共用（炮有特殊规则，单独处理） */
function slide(board, from, dir, out) {
  const { x, y } = xy(from);
  let nx = x + dir[0];
  let ny = y + dir[1];
  while (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
    const p = idx(nx, ny);
    const v = board[p];
    if (!v) out.push({ from, to: p, capture: -1 });
    else {
      // 己方棋子阻挡且不可吃；对方棋子可吃但挡住后续
      out.push({ from, to: p, capture: p, blocked: true, enemy: true, stop: true, blocked_at: p });
      break;
    }
    nx += dir[0];
    ny += dir[1];
  }
  return out;
}

/** 生成单枚棋子的全部伪合法着法（不考虑「走后自己被将军」，见 filterSelfCheck） */
function pseudoMoves(board, from) {
  const v = board[from];
  if (!v) return [];
  const side = owner(v);
  const kind = Math.abs(v);
  const { x, y } = xy(from);
  const out = [];
  const push = (to, capture = -1) => out.push({ from, to, capture });

  if (kind === K.CHARIOT) {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + d[0];
      let ny = y + d[1];
      while (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
        const p = idx(nx, ny);
        if (!board[p]) push(p);
        else {
          if (owner(board[p]) !== side) push(p, p);
          break;
        }
        nx += d[0];
        ny += d[1];
      }
    }
  } else if (kind === K.CANNON) {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + d[0];
      let ny = y + d[1];
      // 炮架之前的空格都可走
      while (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !board[idx(nx, ny)]) {
        push(idx(nx, ny));
        nx += d[0];
        ny += d[1];
      }
      // 越过炮架后遇到的第一个棋子才可吃（这是炮的核心规则）
      if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
        nx += d[0];
        ny += d[1];
        while (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
          const p = idx(nx, ny);
          if (board[p]) {
            if (owner(board[p]) !== side) push(p, p);
            break;
          }
          nx += d[0];
          ny += d[1];
        }
      }
    }
  } else if (kind === K.HORSE) {
    // 8 个日字；每个方向有固定的马腿
    const legs = [
      { dx: 1, dy: 2, lx: 0, ly: 1 }, { dx: -1, dy: 2, lx: 0, ly: 1 },
      { dx: 1, dy: -2, lx: 0, ly: -1 }, { dx: -1, dy: -2, lx: 0, ly: -1 },
      { dx: 2, dy: 1, lx: 1, ly: 0 }, { dx: 2, dy: -1, lx: 1, ly: 0 },
      { dx: -2, dy: 1, lx: -1, ly: 0 }, { dx: -2, dy: -1, lx: -1, ly: 0 },
    ];
    for (const L of legs) {
      const tx = x + L.dx;
      const ty = y + L.dy;
      const mx = x + L.lx;
      const my = y + L.ly;
      if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
      if (board[idx(mx, my)]) continue; // 蹩马腿
      const p = idx(tx, ty);
      if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
    }
  } else if (kind === K.ELEPHANT) {
    // 田字，塞象眼，且不过河
    for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) continue;
      if (board[idx(x + dx / 2, y + dy / 2)]) continue; // 塞象眼
      if (crossedRiver(ty, side)) continue; // 象不过河
      const p = idx(tx, ty);
      if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
    }
  } else if (kind === K.ADVISOR) {
    // 斜走一格，限九宫内
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inPalace(tx, ty, side)) continue;
      const p = idx(tx, ty);
      if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
    }
  } else if (kind === K.KING) {
    // 直走一格，限九宫内
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inPalace(tx, ty, side)) continue;
      const p = idx(tx, ty);
      if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
    }
    // 飞将：同列且中间无子 → 可将死对方的将（视为一步吃子）
    const foeSide = side === 1 ? 2 : 1;
    for (let ny = y + (side === 1 ? 1 : -1); ny >= 0 && ny < ROWS; ny += side === 1 ? 1 : -1) {
      const p = idx(x, ny);
      const pv = board[p];
      if (!pv) continue;
      if (pv === sign(foeSide) * K.KING) push(p, p);
      break; // 遇到任意棋子就停
    }
  } else if (kind === K.PAWN) {
    const forward = side === 1 ? 1 : -1; // 黑向下走，红向上走
    const ty = y + forward;
    if (ty >= 0 && ty < ROWS) {
      const p = idx(x, ty);
      if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
    }
    // 过河后才能左右横走（不能后退）
    if (crossedRiver(y, side)) {
      for (const dx of [-1, 1]) {
        const tx = x + dx;
        if (tx < 0 || tx >= COLS) continue;
        const p = idx(tx, y);
        if (owner(board[p]) !== side) push(p, board[p] ? p : -1);
      }
    }
  }
  return out;
}

/** 找某方的将/帅位置（0 = 已被吃） */
function findKing(board, side) {
  const want = sign(side) * K.KING;
  for (let i = 0; i < board.length; i += 1) if (board[i] === want) return i;
  return -1;
}

/**
 * 某方是否正被将军。
 * 做法：枚举对方所有伪合法着法，看是否有能吃到将的 ——
 * 比对每个兵种单独写一遍「能否攻击到将」可靠（漏一个兵种就会漏判将军）。
 */
function isChecked(board, side) {
  const kingPos = findKing(board, side);
  if (kingPos < 0) return true;
  const foe = side === 1 ? 2 : 1;
  for (let i = 0; i < board.length; i += 1) {
    if (owner(board[i]) !== foe) continue;
    for (const m of pseudoMoves(board, i)) {
      if (m.to === kingPos) return true;
    }
  }
  return false;
}

/** 过滤「走后自己被将军」的着法（含自杀与送将） */
function legalMovesFrom(board, from, side) {
  const out = [];
  for (const m of pseudoMoves(board, from)) {
    const next = board.slice();
    next[m.to] = next[from];
    next[from] = 0;
    if (!isChecked(next, side)) out.push(m);
  }
  return out;
}

function allLegalMoves(board, side) {
  const out = [];
  for (let i = 0; i < board.length; i += 1) {
    if (owner(board[i]) !== side) continue;
    out.push(...legalMovesFrom(board, i, side));
  }
  return out;
}

export default {
  key: "xiangqi",
  name: "中国象棋",
  brief: "完整象棋规则：蹩马腿、塞象眼、炮翻山、飞将",
  players: 2,
  meta: () => ({ rows: ROWS, cols: COLS, render: "xiangqi", click: "from-to", cell: "piece" }),

  init: initialState,

  view(state, { side } = {}) {
    const myTurn = !side || state.turn === side;
    return {
      board: state.board,
      turn: state.turn,
      lastPos: state.lastPos,
      // 只给自己的合法着法（含 from→to 对），前端据此高亮可选点
      legal: myTurn && state.phase === "playing" ? allLegalMoves(state.board, state.turn) : [],
      note: state.lastNote || "",
      checkSide: state.checkSide || 0,
    };
  },

  move(state, { side, payload }) {
    if (state.phase !== "playing") return { error: "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };

    const from = Math.floor(Number(payload?.from));
    const to = Math.floor(Number(payload?.to));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= COLS * ROWS || to >= COLS * ROWS) {
      return { error: "着法不合法" };
    }
    if (owner(state.board[from]) !== side) return { error: "这不是你的棋子" };

    const legal = legalMovesFrom(state.board, from, side);
    const hit = legal.find((m) => m.to === to);
    if (!hit) {
      // 区分原因，便于用户理解（被将军时只能走解将的着法，这点最容易困惑）
      if (isChecked(state.board, side)) return { error: "你正被将军，必须先解将" };
      return { error: "这一步走不了" };
    }

    const board = state.board.slice();
    const captured = board[to];
    board[to] = board[from];
    board[from] = 0;

    const foe = side === 1 ? 2 : 1;
    // 吃掉对方的将 → 直接终局（正常情况下是被将死，但飞将等可以直接吃）
    if (captured && Math.abs(captured) === K.KING) {
      return {
        state: { phase: "finished", board, turn: state.turn, lastPos: to, lastNote: "将死", checkSide: 0 },
        finished: true,
        winnerSide: side,
        note: "将死对方",
      };
    }

    // 对方必须还有合法着法，否则是将死/困毙（象棋里困毙同样判负）
    const foeMoves = allLegalMoves(board, foe);
    const foeChecked = isChecked(board, foe);
    if (!foeMoves.length) {
      return {
        state: { phase: "finished", board, turn: state.turn, lastPos: to, lastNote: foeChecked ? "将死" : "困毙", checkSide: 0 },
        finished: true,
        winnerSide: side,
        note: foeChecked ? "将死对方" : "对方无子可动（困毙）",
      };
    }

    return {
      state: {
        phase: "playing",
        board,
        turn: foe,
        lastPos: to,
        lastNote: captured ? "吃子" : "",
        checkSide: foeChecked ? foe : 0,
      },
      finished: false,
      winnerSide: 0,
      note: foeChecked ? "将军！" : captured ? "吃子" : "",
    };
  },
};
