// 海战棋（Battleship）—— 10×10，标准 5 舰
// ---------------------------------------------------------------------------
// 与其他游戏的关键差异：**存在隐藏信息**。
//   · 对局分两阶段：布置（phase=placing）→ 炮击（phase=firing）；
//   · 布阵期双方各自摆舰，摆好后点「准备」；
//   · 炮击期交替打对方格子，但**只能看到自己打过的结果**，
//     绝不能把对方的完整布阵下发给客户端 —— 那等于把答案发给对手。
//   所以本游戏覆写 view(state, { side })，按视角过滤：
//     · 自己的棋盘：完整可见（含己方舰位与被对方打中的位置）；
//     · 对方的棋盘：只回 { miss | hit | sunk }，未打过的格子一律返回未知。
//
// 标准 5 舰：航母 5 / 战列舰 4 / 巡洋舰 3 / 潜艇 3 / 驱逐舰 2。
// 摆放规则：不重叠、可相邻（经典规则允许相邻），方向横或竖。
import { emptyBoard } from "./shared.js";

const SIZE = 10;
const SHIPS = [
  { key: "carrier", name: "航母", len: 5 },
  { key: "battleship", name: "战列舰", len: 4 },
  { key: "cruiser", name: "巡洋舰", len: 3 },
  { key: "submarine", name: "潜艇", len: 3 },
  { key: "destroyer", name: "驱逐舰", len: 2 },
];

/**
 * 一格的三态：
 *   0 = 未知/空（未被打过）
 *   1 = 命中舰体（被打过且原来有舰）
 *   2 = 打空（被打过且原来没舰）
 * 舰体分布单独存 fleet（每舰一组下标），便于判沉没与「全灭」。
 */
function emptySide() {
  return { fleet: [], shots: emptyBoard(SIZE, SIZE) };
}

/** 舰体是否全部被击中（沉没判定） */
function isSunk(fleetEntry, shots) {
  return fleetEntry.cells.every((c) => shots[c] === 1);
}

/** 所有舰是否都沉了（终局判定） */
function allSunk(sideState) {
  return sideState.fleet.length > 0 && sideState.fleet.every((f) => isSunk(f, sideState.shots));
}

/** 校验一组格子能否放下：不越界、不重叠 */
function canPlace(sideState, cells) {
  const occupied = new Set(sideState.fleet.flatMap((f) => f.cells));
  return cells.every((c) => c >= 0 && c < SIZE * SIZE && !occupied.has(c));
}

/** 把「起点 + 方向 + 长度」转成格子数组；越界返回 null */
function cellsOf(start, dir, len) {
  const x = start % SIZE;
  const y = Math.floor(start / SIZE);
  const out = [];
  for (let i = 0; i < len; i += 1) {
    const nx = dir === "h" ? x + i : x;
    const ny = dir === "v" ? y + i : y;
    if (nx >= SIZE || ny >= SIZE) return null;
    out.push(ny * SIZE + nx);
  }
  return out;
}

export default {
  key: "battleship",
  name: "海战棋",
  brief: "先布阵再交替炮击，先击沉对方全部 5 舰者胜",
  players: 2,
  meta: () => ({
    rows: SIZE,
    cols: SIZE,
    render: "battleship",
    click: "cell",
    cell: "sea",
    ships: SHIPS.map((s) => ({ key: s.key, name: s.name, len: s.len })),
  }),

  init() {
    return {
      phase: "placing",
      sides: { 1: emptySide(), 2: emptySide() },
      turn: 1,
      ready: { 1: false, 2: false },
      lastPos: -1,
      lastNote: "",
    };
  },

  /** 一键随机布置（前端「随机布阵」用；服务端算好再存，避免客户端伪造） */
  auto(state, { side: payloadSide }) {
    const side = payloadSide;
    const next = JSON.parse(JSON.stringify(state));
    next.sides[side] = emptySide();
    for (const ship of SHIPS) {
      let placed = false;
      for (let attempt = 0; attempt < 500 && !placed; attempt += 1) {
        const dir = Math.random() < 0.5 ? "h" : "v";
        const start = Math.floor(Math.random() * SIZE * SIZE);
        const cells = cellsOf(start, dir, ship.len);
        if (!cells || !canPlace(next.sides[side], cells)) continue;
        next.sides[side].fleet.push({ key: ship.key, name: ship.name, len: ship.len, cells });
        placed = true;
      }
      if (!placed) return { error: "随机布置失败，请重试" };
    }
    next.ready[side] = true;
    // 双方都准备好 → 进入炮击阶段（先手固定为房主，保证可复现）
    if (next.ready[1] && next.ready[2]) {
      next.phase = "firing";
      next.turn = 1;
    }
    return { state: next, finished: false, winnerSide: 0, note: "已随机布置" };
  },

  /** 手动摆放一舰 */
  place(state, { side, payload }) {
    if (state.phase !== "placing") return { error: "对局已进入炮击阶段，不能改布阵" };
    if (state.ready[side]) return { error: "你已准备完毕，不能改动布阵" };
    const shipKey = String(payload?.ship || "");
    const ship = SHIPS.find((s) => s.key === shipKey);
    if (!ship) return { error: "未知舰种" };
    const dir = String(payload?.dir || "h") === "v" ? "v" : "h";
    const start = Math.floor(Number(payload?.start));
    if (!Number.isInteger(start) || start < 0 || start >= SIZE * SIZE) return { error: "位置不合法" };

    const cells = cellsOf(start, dir, ship.len);
    if (!cells) return { error: "超出棋盘范围" };

    const next = JSON.parse(JSON.stringify(state));
    // 同一舰重新摆放 = 先移除旧的（否则第二次点会报「重叠」）
    next.sides[side].fleet = next.sides[side].fleet.filter((f) => f.key !== shipKey);
    if (!canPlace(next.sides[side], cells)) return { error: "与已有舰船重叠" };
    next.sides[side].fleet.push({ key: ship.key, name: ship.name, len: ship.len, cells });
    return { state: next, finished: false, winnerSide: 0, note: `已放置${ship.name}` };
  },

  /** 准备完毕；双方都准备好则开打 */
  ready(state, { side }) {
    if (state.phase !== "placing") return { error: "已经开打了" };
    const next = JSON.parse(JSON.stringify(state));
    next.ready[side] = true;
    const mine = next.sides[side].fleet;
    if (mine.length !== SHIPS.length) return { error: `还有 ${SHIPS.length - mine.length} 艘舰没摆放` };
    if (next.ready[1] && next.ready[2]) {
      next.phase = "firing";
      next.turn = 1;
      next.lastNote = "双方就绪，开始炮击";
      return { state: next, finished: false, winnerSide: 0, note: "双方就绪，开始炮击" };
    }
    return { state: next, finished: false, winnerSide: 0, note: "已准备，等待对手布阵" };
  },

  move(state, { side, payload }) {
    if (state.phase !== "firing") return { error: state.phase === "placing" ? "还有一方尚未布阵完毕" : "对局已结束" };
    if (state.turn !== side) return { error: "还没轮到你" };

    const pos = Math.floor(Number(payload?.position));
    if (!Number.isInteger(pos) || pos < 0 || pos >= SIZE * SIZE) return { error: "坐标不合法" };

    const foeSide = side === 1 ? 2 : 1;
    const next = JSON.parse(JSON.stringify(state));
    const foe = next.sides[foeSide];
    if (foe.shots[pos] !== 0) return { error: "这个格子已经打过了" };

    const hitShip = foe.fleet.find((f) => f.cells.includes(pos));
    foe.shots[pos] = hitShip ? 1 : 2;

    let note = hitShip ? `命中${hitShip.name}` : "打空";
    let sunkName = "";
    if (hitShip && isSunk(hitShip, foe.shots)) {
      sunkName = hitShip.name;
      note = `击沉${hitShip.name}！`;
    }

    let finished = false;
    let winnerSide = 0;
    if (allSunk(foe)) {
      finished = true;
      winnerSide = side;
      note = "对方舰队全灭";
    }

    // 命中可继续（经典规则：打中就再来一次）；打空则交换回合。
    // 这条规则让对局不至于变成纯运气轮流点，也是标准玩法。
    next.turn = finished ? state.turn : hitShip ? side : foeSide;
    next.lastPos = pos;
    next.lastNote = note;
    if (finished) next.phase = "finished";

    return { state: next, finished, winnerSide, note, sunk: sunkName };
  },

  /**
   * 按视角下发（**隐藏信息的关键**）：
   *   · 自己的棋盘：我的舰在哪、对手打了我哪里，完整可见；
   *   · 对手的棋盘：只暴露已打过的结果，未打过的格子一律 -1（未知），
   *     绝不能把对手的 fleet 发出去。
   */
  view(state, { side } = {}) {
    const me = side || 1;
    const foeSide = me === 1 ? 2 : 1;
    const mine = state.sides?.[me] || emptySide();
    const foe = state.sides?.[foeSide] || emptySide();

    // 对手棋盘：0 未知 / 1 命中 / 2 打空（-1 表示未知，前端画雾）
    const foeView = foe.shots.map((v) => (v === 0 ? -1 : v));
    // 我方棋盘：把自己的舰位叠加显示（被打中的优先显示命中）
    const mineView = mine.shots.map((v) => v);
    for (const f of mine.fleet) {
      for (const c of f.cells) {
        if (mineView[c] === 0) mineView[c] = 3; // 3 = 我方舰体（未被击中）
      }
    }

    return {
      phase: state.phase,
      turn: state.turn,
      ready: state.ready,
      myShips: mine.fleet.map((f) => ({ key: f.key, name: f.name, len: f.len, cells: f.cells, sunk: isSunk(f, mine.shots) })),
      placed: mine.fleet.length,
      // 前面几个是我方视角（完整），后面是对手视角（迷雾）
      myBoard: mineView,
      foeBoard: foeView,
      foeSunk: foe.fleet.filter((f) => isSunk(f, foe.shots)).map((f) => ({ key: f.key, name: f.name })),
      foeAlive: foe.fleet.filter((f) => !isSunk(f, foe.shots)).length,
      lastPos: state.lastPos,
      note: state.lastNote || "",
    };
  },
};
