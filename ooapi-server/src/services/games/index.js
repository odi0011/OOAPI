// 联机游戏引擎（服务端权威判定）
// ===========================================================================
// 设计原则：**客户端只提交「操作意图」，一切规则由服务端判定**。
//   客户端能改的东西都不能作为事实依据 —— 棋盘状态、轮次、胜负、合法性，
//   全部以服务端 state 为准。这比「前端算好再上报结果」多写一些代码，
//   但那是唯一能防住改前端作弊的做法。
//
// 引擎接口（每个游戏模块导出同样的形状）：
//   key      唯一标识（存库用）
//   name     中文名
//   brief    一句话玩法（前端展示）
//   players  人数（当前恒为 2；留字段是为了将来加多人游戏）
//   meta()   渲染提示：{ rows, cols, render, click, cell }
//            render: grid-stone（格子棋盘）/ battleship（双棋盘，含隐藏信息）
//            click:  cell（点格落子）/ column（点列，棋子下落）/ from-to（选子再选目标）
//   init()   初始 state
//   move(state, ctx) → { error } | { state, finished, winnerSide, note }
//   view(state, ctx) → 给某个视角看的视图（隐藏信息游戏覆写，如海战棋）
//   auto?()  可选：一键随机布置（海战棋用）
//
// state 一律是**纯 JSON**（存进 game_rooms.state）：
//   { phase, board: [...], turn: 1|2, ... }
// 每个游戏自己解释 board 的含义，路由层不关心。
//
// 参考实现（规则与边界处理的来源，均为公开开源的成熟实现；
// 本项目按「不引入新依赖」的规范自行实现，只借鉴规则与边界条件）：
//   · 四子棋 Connect Four —— 7 列 6 行，列内下落 + 四方向连线
//   · 黑白棋 Reversi/Othello —— 官方规则（8 方向夹击翻转；必须能翻才可落；
//     无点可下则跳过；双方都无点则终局算子）
//   · 五子棋 Gomoku —— 15×15，五子连线
//   · 西洋跳棋 English Draughts —— 强制吃子、连跳到底、到底线升王
//   · 中国象棋 Xiangqi —— 完整走子规则（蹩马腿/塞象眼/士象不出宫不过河/飞将/炮翻山）
//   · 海战棋 Battleship —— 10×10 五舰标准棋盘，布阵 + 交替炮击
import connect4 from "./connect4.js";
import reversi from "./reversi.js";
import gomoku from "./gomoku.js";
import checkers from "./checkers.js";
import xiangqi from "./xiangqi.js";
import battleship from "./battleship.js";

/** 注册表。顺序即前端展示顺序（快节奏的在前，复杂的在后）。 */
const GAMES = [connect4, reversi, gomoku, checkers, xiangqi, battleship];

const BY_KEY = new Map(GAMES.map((g) => [g.key, g]));

export function getGame(key) {
  return BY_KEY.get(String(key || "").trim()) || null;
}

export function gameList() {
  return GAMES.map((g) => ({
    key: g.key,
    name: g.name,
    brief: g.brief,
    players: g.players || 2,
    meta: { ...g.meta(), hasAuto: Boolean(g.auto) },
  }));
}

export function isOnlineGame(key) {
  return BY_KEY.has(String(key || "").trim());
}

export { emptyBoard, lineWin, isFull } from "./shared.js";
