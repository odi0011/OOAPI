// 五子棋（Gomoku）—— 15×15，先连成五子者胜
// ---------------------------------------------------------------------------
// 从第 37 批的 routes/games.js 迁移过来，逻辑不变（原本就是服务端权威判定），
// 只是搬进统一的游戏引擎接口，与其他游戏共用同一套房间/落子/胜负流程。
import { emptyBoard, lineWin } from "./index.js";

const SIZE = 15;

export default {
  key: "gomoku",
  name: "五子棋",
  brief: "横竖斜任意方向先连成五子者胜",
  players: 2,
  meta: () => ({ rows: SIZE, cols: SIZE, render: "grid-stone", click: "cell", cell: "stone" }),

  init() {
    return { phase: "playing", board: emptyBoard(SIZE, SIZE), turn: 1, lastPos: -1 };
  },

  view(state) {
    return { board: state.board, lastPos: state.lastPos, turn: state.turn };
  },

  move(state, { side, payload }) {
    if (state.phase !== "playing") return { error: "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };
    const pos = Math.floor(Number(payload?.position));
    if (!Number.isInteger(pos) || pos < 0 || pos >= SIZE * SIZE) return { error: "落子位置不合法" };
    if (state.board[pos]) return { error: "该位置已有棋子" };

    const board = state.board.slice();
    board[pos] = side;
    const win = lineWin(board, SIZE, SIZE, pos, side, 5);
    // 五子棋不判平局：15×15 填满在实际对局中不会发生，判了反而误导
    return {
      state: { phase: win ? "finished" : "playing", board, turn: win ? state.turn : side === 1 ? 2 : 1, lastPos: pos },
      finished: win,
      winnerSide: win ? side : 0,
      note: win ? "五子连线" : "",
    };
  },
};
