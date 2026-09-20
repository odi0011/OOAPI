// 四子棋（Connect Four）—— 7 列 6 行，先连成四子者胜
// ---------------------------------------------------------------------------
// 为什么选它做联机游戏的门面：规则一句话说完、单局 1-3 分钟、先手优势可控、
// 服务端判定极简（列内下落 + 四方向连线）。这类「回合短、随时能来一局」的
// 才是联机游戏大厅真正有人玩的品种。
//
// 与五子棋的关键差异：棋子**受重力约束**（只能落在列内最低空位），
// 所以客户端只提交列号，具体行由服务端算 —— 不接受客户端给的行号。
import { emptyBoard, lineWin, isFull } from "./index.js";

const COLS = 7;
const ROWS = 6;

/** 列内最低空位；列满返回 -1 */
function dropRow(board, col) {
  for (let r = ROWS - 1; r >= 0; r -= 1) {
    if (board[r * COLS + col] === 0) return r;
  }
  return -1;
}

export default {
  key: "connect4",
  name: "四子棋",
  brief: "棋子落下即堆叠，先在横/竖/斜方向连成四子者胜",
  players: 2,
  meta: () => ({ rows: ROWS, cols: COLS, render: "grid-stone", click: "column", cell: "disc" }),

  init() {
    return { phase: "playing", board: emptyBoard(ROWS, COLS), turn: 1, lastPos: -1 };
  },

  view(state) {
    return { board: state.board, lastPos: state.lastPos, turn: state.turn };
  },

  move(state, { side, payload }) {
    if (state.phase !== "playing") return { error: "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };
    // 只收列号：行号由落子规则决定，让客户端给行号等于允许「悬空放子」
    const col = Number(payload?.col);
    if (!Number.isInteger(col) || col < 0 || col >= COLS) return { error: "列号不合法" };
    const row = dropRow(state.board, col);
    if (row < 0) return { error: "这一列已满，换一列" };

    const pos = row * COLS + col;
    const board = state.board.slice();
    board[pos] = side;

    const win = lineWin(board, COLS, ROWS, pos, side, 4);
    const full = !win && isFull(board);
    return {
      state: {
        phase: win || full ? "finished" : "playing",
        board,
        turn: win || full ? state.turn : side === 1 ? 2 : 1,
        lastPos: pos,
      },
      finished: win || full,
      winnerSide: win ? side : 0,
      note: win ? "连成四子" : full ? "棋盘已满，平局" : "",
    };
  },
};
