// 游戏引擎共用工具
// ---------------------------------------------------------------------------
// 单独成文件而不是放在 index.js：各游戏模块需要这些函数，而 index.js 又要
// import 各游戏模块 —— 放在一起就形成循环依赖。ESM 的循环导入在「模块初始化
// 阶段就求值」时会拿到 undefined，很难排查；提前拆开是最省事的根治办法。

/** 空棋盘：长度 = rows*cols，全 0 */
export function emptyBoard(rows, cols) {
  return new Array(rows * cols).fill(0);
}

/**
 * 连线获胜判定：从最后落子点向四个方向数同色连子（四子棋/五子棋共用）。
 * 为什么从落子点出发而不是全盘扫描：只有落下的那颗可能形成新连线，
 * 全盘扫描既慢又要处理「同一连线被数多次」。
 */
export function lineWin(board, cols, rows, pos, who, need) {
  const x = pos % cols;
  const y = Math.floor(pos / cols);
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (const sign of [1, -1]) {
      for (let step = 1; step < need; step += 1) {
        const nx = x + dx * step * sign;
        const ny = y + dy * step * sign;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) break;
        if (board[ny * cols + nx] !== who) break;
        n += 1;
      }
    }
    if (n >= need) return true;
  }
  return false;
}

/** 棋盘是否已满（平局判定用） */
export function isFull(board) {
  return board.every((c) => c !== 0);
}

/** 坐标 ↔ 下标（行列棋类共用，避免各处手写 rows/cols 顺序出错） */
export function idx(x, y, cols) {
  return y * cols + x;
}
export function xy(pos, cols) {
  return { x: pos % cols, y: Math.floor(pos / cols) };
}

/** 越界判定 */
export function onBoard(x, y, cols, rows) {
  return x >= 0 && y >= 0 && x < cols && y < rows;
}
