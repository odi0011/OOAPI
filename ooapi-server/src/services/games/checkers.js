// 西洋跳棋（English Draughts）—— 8×8，黑白各 12 子
// ---------------------------------------------------------------------------
// 规则要点（这三条是跳棋区别于其他棋类的地方，也是最容易写错的地方）：
//   ① **强制吃子**：只要存在可吃子的着法，就不能走普通移动。
//      不做这条的话，玩家可以故意不吃来回避劣势 —— 那已经不是跳棋了。
//   ② **连跳到底**：吃掉一子后若同一枚棋子还能继续吃，必须继续（不能中途停）。
//      实现方式是吃子后只把 turn 交给对方「当且仅当没有后续吃子」。
//   ③ **升王**：走到对方底线升王；升王当回合**立即停止连跳**
//      （官方规则，升王后该回合结束，避免「升王后一路吃回」的混乱）。
//
// 棋子编码：0 空 / 1 黑兵 / 3 黑王 / 2 白兵 / 4 白王（奇数为黑方=side1，偶数为白方=side2）
// 用「值 ≥ 3 为王」判定，读数时 % 2 得归属，这样一张 board 就能表达全部信息。
import { emptyBoard } from "./shared.js";

const SIZE = 8;
const BLACK = 1;
const WHITE = 2;
const KING_ADD = 2; // 1→3（黑王）、2→4（白王）

const owner = (v) => (v === 0 ? 0 : v % 2 === 1 ? BLACK : WHITE);
const isKing = (v) => v >= 3;
const idx = (x, y) => y * SIZE + x;

/** 初始布局：黑在上三行（向下走），白在下三行（向上走），深色格放子 */
function initialState() {
  const board = emptyBoard(SIZE, SIZE);
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((x + y) % 2 === 1) board[idx(x, y)] = BLACK;
    }
  }
  for (let y = SIZE - 3; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((x + y) % 2 === 1) board[idx(x, y)] = WHITE;
    }
  }
  return { phase: "playing", board, turn: BLACK, lastPos: -1, mustContinueFrom: -1, lastNote: "" };
}

/** 兵的前进方向：黑向下（+1），白向上（-1） */
function forwardDir(sideValue) {
  return owner(sideValue) === BLACK ? 1 : -1;
}

/** 单枚棋子的普通移动目标 */
function movesOf(board, pos) {
  const v = board[pos];
  if (!v) return [];
  const x = pos % SIZE;
  const y = Math.floor(pos / SIZE);
  const dirs = isKing(v) ? [-1, 1] : [forwardDir(v)];
  const out = [];
  for (const dy of dirs) {
    for (const dx of [-1, 1]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      if (board[idx(nx, ny)] === 0) out.push({ to: idx(nx, ny), capture: -1 });
    }
  }
  return out;
}

/** 单枚棋子的吃子着法（跳过相邻敌子落到其后空位） */
function capturesOf(board, pos) {
  const v = board[pos];
  if (!v) return [];
  const x = pos % SIZE;
  const y = Math.floor(pos / SIZE);
  const dirs = isKing(v) ? [-1, 1] : [forwardDir(v)];
  const out = [];
  for (const dy of dirs) {
    for (const dx of [-1, 1]) {
      const mx = x + dx;
      const my = y + dy;
      const tx = x + dx * 2;
      const ty = y + dy * 2;
      if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) continue;
      const mid = board[idx(mx, my)];
      if (mid && owner(mid) !== owner(v) && board[idx(tx, ty)] === 0) {
        out.push({ to: idx(tx, ty), capture: idx(mx, my) });
      }
    }
  }
  return out;
}

/** 某一方全部可吃子着法（用于强制吃子判定） */
function allCaptures(board, side) {
  const out = [];
  for (let i = 0; i < board.length; i += 1) {
    if (owner(board[i]) !== side) continue;
    for (const c of capturesOf(board, i)) out.push({ from: i, ...c });
  }
  return out;
}

/** 某一方是否还有棋子 */
function hasPieces(board, side) {
  return board.some((v) => owner(v) === side);
}

export default {
  key: "checkers",
  name: "西洋跳棋",
  brief: "斜走一格；有子可吃时强制吃，连跳到底线升王",
  players: 2,
  meta: () => ({ rows: SIZE, cols: SIZE, render: "grid-stone", click: "from-to", cell: "checker" }),

  init: initialState,

  view(state, { side } = {}) {
    // 把「当前可走的所有着法」下发给当前行棋方：
    // 强制吃子规则下，客户端自己算容易算错（而且必须和服务端一致），
    // 直接下发服务端算好的合法着法最省事也最可靠。
    const myTurn = !side || state.turn === side;
    let moves = [];
    if (myTurn && state.phase === "playing") {
      const sideVal = state.turn;
      const caps = allCaptures(state.board, sideVal);
      if (caps.length) moves = caps;
      else {
        for (let i = 0; i < state.board.length; i += 1) {
          if (owner(state.board[i]) !== sideVal) continue;
          for (const m of movesOf(state.board, i)) moves.push({ from: i, to: m.to, capture: -1 });
        }
      }
    }
    return {
      board: state.board,
      turn: state.turn,
      lastPos: state.lastPos,
      // 强制吃子进行中：客户端据此锁定只能动这一枚
      mustContinueFrom: state.mustContinueFrom ?? -1,
      legal: moves,
      note: state.lastNote || "",
    };
  },

  move(state, { side, payload }) {
    if (state.phase !== "playing") return { error: "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };

    const from = Math.floor(Number(payload?.from));
    const to = Math.floor(Number(payload?.to));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= SIZE * SIZE || to >= SIZE * SIZE) {
      return { error: "着法不合法" };
    }
    if (owner(state.board[from]) !== side) return { error: "这不是你的棋子" };

    // 连跳进行中：只能继续动那一枚
    const mustFrom = state.mustContinueFrom ?? -1;
    if (mustFrom >= 0 && from !== mustFrom) return { error: "必须继续用这枚棋子连跳" };

    const caps = allCaptures(state.board, side);
    const capMove = caps.find((c) => c.from === from && c.to === to);
    const plainMove = mustFrom < 0 && !caps.length ? movesOf(state.board, from).find((m) => m.to === to) : null;

    if (!capMove && !plainMove) {
      // 区分错误原因：有吃子机会却走普通移动是最常见的误操作，要明确提示
      if (caps.length && !capMove) return { error: "有子可吃时必须吃子" };
      return { error: "这一步走不了" };
    }

    const board = state.board.slice();
    const piece = board[from];
    board[from] = 0;
    let captured = -1;
    if (capMove) {
      captured = capMove.capture;
      board[captured] = 0;
    }

    // 升王：走到对方底线
    let promoted = false;
    let placed = piece;
    const toY = Math.floor(to / SIZE);
    if (!isKing(piece) && ((owner(piece) === BLACK && toY === SIZE - 1) || (owner(piece) === WHITE && toY === 0))) {
      placed = piece + KING_ADD;
      promoted = true;
    }
    board[to] = placed;

    const foe = side === BLACK ? WHITE : BLACK;
    let finished = false;
    let winnerSide = 0;
    let note = capMove ? "吃子" : "";

    // 连跳：吃子后若还能吃，且**没有升王**，则继续由同一方行动（只能动这枚）
    let mustContinue = -1;
    if (capMove && !promoted) {
      const more = capturesOf(board, to);
      if (more.length) {
        mustContinue = to;
        note = "可以继续连跳，请继续用这枚棋子";
      }
    }

    if (mustContinue < 0) {
      // 交给对方；若对方已无子或无着法可走，则本方胜
      const foeHasPiece = hasPieces(board, foe);
      const foeHasMove = foeHasPiece && (allCaptures(board, foe).length > 0 || board.some((v, i) => owner(v) === foe && movesOf(board, i).length > 0));
      if (!foeHasPiece || !foeHasMove) {
        finished = true;
        winnerSide = side;
        note = !foeHasPiece ? "对方棋子已被吃光" : "对方无子可走";
      }
    }

    if (promoted) note = note ? `${note} · 升王` : "升王";

    return {
      state: {
        phase: finished ? "finished" : "playing",
        board,
        turn: finished ? state.turn : mustContinue >= 0 ? side : foe,
        lastPos: to,
        mustContinueFrom: mustContinue,
        lastNote: note,
      },
      finished,
      winnerSide,
      note,
    };
  },
};
