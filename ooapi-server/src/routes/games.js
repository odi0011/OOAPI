// 小游戏：单机成绩榜 + 联机对战（服务端权威判定）
// ---------------------------------------------------------------------------
// 设计要点：
//
// ① **成绩校验不能信任客户端**。单机游戏（2048/贪吃蛇）的分数是客户端报的，
//    无法完全防伪 —— 所以加两道闸：分数上限（超过理论可能值直接拒）+ 频率限制
//    （单位时间内能刷多少局有物理上限）。真正的防作弊需要服务端跑游戏逻辑，
//    那对单机小游戏投入产出比太低；排行榜定位是「乐子」而非竞技排名，这点在
//    UI 上要诚实（不宣称「公平竞技」）。
//
// ② **联机对战必须服务端权威**：棋盘状态存 game_rooms.state，客户端只发「落子坐标」，
//    服务端判定合法性、胜负、轮次。否则改前端就能无限连子。
//
// ③ **乐观锁防并发覆盖**：落子时校验 version，两次请求同时到达只会有一次生效，
//    另一次返回「棋盘已变化，请重试」——比行锁轻，且对局场景冲突极少。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, pageParams, idParam, safeJSONParse } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { push } from "../services/realtime.js";

const router = Router();

// 支持的联机游戏定义。新增游戏只在这里加一条 + 前端实现渲染，
// 服务端判定逻辑按 key 分发（见 judge 分支）。
const GAMES = {
  gomoku: { name: "五子棋", size: 15, needTwo: true },
  tictactoe: { name: "井字棋", size: 3, needTwo: true },
};

// 单机游戏的理论上限：超过即拒绝（挡住「分数=99999999」这种一眼假的提交）
const SCORE_CAP = { g2048: 1_000_000, snake: 500_000, tetris: 2_000_000 };
const DEFAULT_CAP = 1_000_000;

function gameMeta(key) {
  const k = String(key || "").trim().slice(0, 24);
  if (GAMES[k]) return { key: k, ...GAMES[k], online: true };
  const cap = Object.prototype.hasOwnProperty.call(SCORE_CAP, k) ? SCORE_CAP[k] : DEFAULT_CAP;
  return { key: k, name: k, online: false, scoreCap: cap };
}

/** 五子棋胜负判定：以最后落子点为中心，四个方向数连子 */
function gomokuWin(board, size, x, y, who) {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (const sign of [1, -1]) {
      for (let step = 1; step < 5; step += 1) {
        const nx = x + dx * step * sign;
        const ny = y + dy * step * sign;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) break;
        if (board[ny * size + nx] !== who) break;
        n += 1;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

/** 井字棋胜负：8 条线 */
function tictactoeWin(board, who) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  return lines.some((l) => l.every((i) => board[i] === who));
}

function newBoard(gameKey) {
  const meta = GAMES[gameKey];
  return new Array(meta.size * meta.size).fill(0);
}

/** 对局状态 → 响应体（只暴露给对局双方与观战者） */
function roomToResp(row, viewerId = 0) {
  const state = safeJSONParse(row.state, null) || {};
  return {
    id: Number(row.id),
    game_key: row.game_key,
    game_name: GAMES[row.game_key]?.name || row.game_key,
    status: row.status,
    host_id: Number(row.host_id) || 0,
    guest_id: Number(row.guest_id) || 0,
    turn_user_id: Number(row.turn_user_id) || 0,
    winner_id: Number(row.winner_id) || 0,
    version: Number(row.version) || 0,
    spectatable: Number(row.spectatable) || 0,
    board: state.board || [],
    size: GAMES[row.game_key]?.size || 0,
    // 谁是先手（黑棋）：房主固定执黑，避免先手方在开局前不确定
    my_turn: Number(row.turn_user_id) === Number(viewerId),
    my_side: Number(row.host_id) === Number(viewerId) ? 1 : Number(row.guest_id) === Number(viewerId) ? 2 : 0,
    created_time: Number(row.created_time),
    updated_time: Number(row.updated_time) || 0,
  };
}

// ---------------------------------------------------------------------------
// 单机成绩
// ---------------------------------------------------------------------------
router.get(
  "/list",
  authRequired,
  asyncHandler(async (req, res) => {
    // 前端游戏大厅需要知道有哪些游戏、各自的上限与联机能力
    const list = [
      ...Object.entries(GAMES).map(([key, g]) => ({ key, name: g.name, online: true, size: g.size })),
      { key: "g2048", name: "2048", online: false, scoreCap: SCORE_CAP.g2048 },
      { key: "snake", name: "贪吃蛇", online: false, scoreCap: SCORE_CAP.snake },
    ];
    return ok(res, list);
  })
);

router.post(
  "/records",
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "game-record", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const meta = gameMeta(req.body?.game_key);
    if (!meta.key) return fail(res, "缺少游戏标识");
    const score = Math.floor(Number(req.body?.score) || 0);
    const durationMs = Math.max(0, Math.floor(Number(req.body?.duration_ms) || 0));
    if (score < 0) return fail(res, "分数不合法");
    const cap = meta.scoreCap || DEFAULT_CAP;
    if (score > cap) return fail(res, `分数超出该游戏上限（${cap}）`);
    // 时长下限：一局真玩的游戏不可能 3 秒内拿到高分（挡脚本化的「瞬时刷分」）
    if (score > 1000 && durationMs > 0 && durationMs < 3000) return fail(res, "成绩异常：用时过短");

    const r = await pool.query(
      "INSERT INTO game_records (user_id, game_key, score, duration_ms, detail, created_time) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, meta.key, score, durationMs, String(req.body?.detail || "").slice(0, 255), now()]
    );
    const [[best]] = await pool.query("SELECT COALESCE(MAX(score),0) AS best FROM game_records WHERE user_id = ? AND game_key = ?", [
      req.user.id,
      meta.key,
    ]);
    // 本次是否刷新个人纪录：前端据此弹「新纪录」，比让前端自己比对可靠
    return ok(res, { id: Number(r[0].insertId), best: Number(best.best) || 0, is_record: score >= (Number(best.best) || 0) }, "成绩已记录");
  })
);

router.get(
  "/records",
  authRequired,
  asyncHandler(async (req, res) => {
    const gameKey = String(req.query.game_key || "").trim().slice(0, 24);
    if (!gameKey) return fail(res, "缺少游戏标识");
    const { p, size, offset } = pageParams(req.query, 20);
    // 排行榜：每人只取最高分（否则一个人刷 100 局就霸榜）
    const [rows] = await pool.query(
      `SELECT t.user_id, t.score, t.duration_ms, t.created_time, u.username, u.display_name, u.avatar_media_id
         FROM (
           SELECT user_id, MAX(score) AS score FROM game_records WHERE game_key = ? GROUP BY user_id
         ) best
         JOIN game_records t ON t.user_id = best.user_id AND t.score = best.score AND t.game_key = ?
         JOIN users u ON u.id = t.user_id
        WHERE u.status = 1
        GROUP BY t.user_id
        ORDER BY t.score DESC, t.created_time ASC
        LIMIT ? OFFSET ?`,
      [gameKey, gameKey, size, offset]
    );
    const [[cnt]] = await pool.query("SELECT COUNT(DISTINCT user_id) AS n FROM game_records WHERE game_key = ?", [gameKey]);
    const items = rows.map((r, i) => ({
      rank: offset + i + 1,
      user_id: Number(r.user_id),
      username: r.username,
      display_name: r.display_name,
      avatar_url: Number(r.avatar_media_id) ? `/api/media/avatar/${r.user_id}?v=${r.avatar_media_id}` : "",
      score: Number(r.score),
      duration_ms: Number(r.duration_ms) || 0,
      created_time: Number(r.created_time),
      is_me: Number(r.user_id) === req.user.id,
    }));
    // 我的最高分（即使没进榜也要显示，否则用户看不到自己的进度）
    const [[mine]] = await pool.query(
      "SELECT COALESCE(MAX(score),0) AS best, COUNT(*) AS plays FROM game_records WHERE user_id = ? AND game_key = ?",
      [req.user.id, gameKey]
    );
    return ok(res, {
      items,
      total: Number(cnt.n) || 0,
      page: p,
      page_size: size,
      mine: { best: Number(mine.best) || 0, plays: Number(mine.plays) || 0 },
    });
  })
);

// ---------------------------------------------------------------------------
// 联机对战
// ---------------------------------------------------------------------------
router.get(
  "/rooms",
  authRequired,
  asyncHandler(async (req, res) => {
    const gameKey = String(req.query.game_key || "").trim().slice(0, 24);
    const where = ["r.status IN ('waiting','playing')"];
    const args = [];
    if (gameKey) {
      where.push("r.game_key = ?");
      args.push(gameKey);
    }
    const [rows] = await pool.query(
      `SELECT r.*, h.username AS host_name, h.display_name AS host_display_name,
              g.username AS guest_name, g.display_name AS guest_display_name
         FROM game_rooms r
         LEFT JOIN users h ON h.id = r.host_id
         LEFT JOIN users g ON g.id = r.guest_id
        WHERE ${where.join(" AND ")}
        ORDER BY r.status = 'waiting' DESC, r.id DESC LIMIT 50`,
      args
    );
    return ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        game_key: r.game_key,
        game_name: GAMES[r.game_key]?.name || r.game_key,
        status: r.status,
        host_id: Number(r.host_id) || 0,
        host_name: r.host_display_name || r.host_name || "",
        guest_id: Number(r.guest_id) || 0,
        guest_name: r.guest_display_name || r.guest_name || "",
        move_count: (safeJSONParse(r.state, {})?.board || []).filter((c) => c).length,
        created_time: Number(r.created_time),
        is_mine: Number(r.host_id) === req.user.id || Number(r.guest_id) === req.user.id,
      }))
    );
  })
);

router.post(
  "/rooms",
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "game-room", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const meta = gameMeta(req.body?.game_key);
    if (!GAMES[meta.key]) return fail(res, "该游戏不支持联机对战");
    // 同一用户同时只能开一个等待中的房间：否则会建出一堆空房间把大厅刷满
    const [[exist]] = await pool.query(
      "SELECT id FROM game_rooms WHERE host_id = ? AND status = 'waiting' LIMIT 1",
      [req.user.id]
    );
    if (exist) await pool.query("UPDATE game_rooms SET status = 'abandoned' WHERE id = ?", [exist.id]);
    const state = { board: newBoard(meta.key) };
    const r = await pool.query(
      `INSERT INTO game_rooms (game_key, status, host_id, state, turn_user_id, spectatable, version, created_time, updated_time)
       VALUES (?, 'waiting', ?, ?, ?, 1, 0, ?, ?)`,
      [meta.key, req.user.id, JSON.stringify(state), req.user.id, now(), now()]
    );
    const roomId = Number(r[0].insertId);
    return ok(res, { id: roomId }, "房间已创建，等待对手加入");
  })
);

router.get(
  "/rooms/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
    if (!row) return fail(res, "房间不存在", 404);
    const involved = Number(row.host_id) === req.user.id || Number(row.guest_id) === req.user.id;
    // 非对局方：只有观战开启时能看（观战是社交乐趣，但要让房主能关掉）
    if (!involved && !Number(row.spectatable)) return fail(res, "该对局不允许观战", 403);
    return ok(res, roomToResp(row, req.user.id));
  })
);

// 加入房间
router.post(
  "/rooms/:id/join",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    // 条件更新 + affectedRows 判断：两个人同时点「加入」只有一个能成功
    const [r] = await pool.query(
      "UPDATE game_rooms SET guest_id = ?, status = 'playing', updated_time = ? WHERE id = ? AND status = 'waiting' AND host_id <> ?",
      [req.user.id, now(), id, req.user.id]
    );
    if (!r.affectedRows) {
      const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
      if (!row) return fail(res, "房间不存在", 404);
      if (Number(row.host_id) === req.user.id) return fail(res, "不能加入自己创建的房间");
      return fail(res, "房间已开始对局或被占满", 409);
    }
    const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
    // 通知房主：对手到了，前端据此立刻切到对局界面
    push(row.host_id, "game_joined", { room_id: id, guest_id: req.user.id });
    return ok(res, roomToResp(row, req.user.id), "已加入对局");
  })
);

// 落子（服务端权威判定）
router.post(
  "/rooms/:id/move",
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: "game-move", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
    if (!row) return fail(res, "房间不存在", 404);
    const meta = GAMES[row.game_key];
    if (!meta) return fail(res, "该游戏不支持对战");
    const me = req.user.id;
    const isHost = Number(row.host_id) === me;
    const isGuest = Number(row.guest_id) === me;
    if (!isHost && !isGuest) return fail(res, "你不是对局方", 403);
    if (row.status !== "playing") return fail(res, "对局未开始或已结束");
    if (Number(row.turn_user_id) !== me) return fail(res, "还没轮到你落子");

    const pos = Math.floor(Number(req.body?.position));
    const state = safeJSONParse(row.state, null) || { board: newBoard(row.game_key) };
    const board = Array.isArray(state.board) ? state.board : newBoard(row.game_key);
    if (!Number.isInteger(pos) || pos < 0 || pos >= board.length) return fail(res, "落子位置不合法");
    if (board[pos]) return fail(res, "该位置已有棋子");

    const mySide = isHost ? 1 : 2;
    const next = board.slice();
    next[pos] = mySide;
    const size = meta.size;
    const x = pos % size;
    const y = Math.floor(pos / size);

    let winner = 0;
    let finished = false;
    if (row.game_key === "gomoku" && gomokuWin(next, size, x, y, mySide)) {
      winner = me;
      finished = true;
    } else if (row.game_key === "tictactoe" && tictactoeWin(next, mySide)) {
      winner = me;
      finished = true;
    } else if (next.every((c) => c !== 0)) {
      // 棋盘满了且无人获胜：平局（winner 保持 0，status=finished 由前端显示「平局」）
      finished = true;
    }

    // 乐观锁：带上读到的 version，并发落子时只有一个能生效
    const [r] = await pool.query(
      `UPDATE game_rooms SET state = ?, turn_user_id = ?, status = ?, winner_id = ?, version = version + 1, updated_time = ?
        WHERE id = ? AND version = ?`,
      [
        JSON.stringify({ board: next }),
        finished ? 0 : isHost ? Number(row.guest_id) : Number(row.host_id),
        finished ? "finished" : "playing",
        winner,
        now(),
        id,
        Number(row.version) || 0,
      ]
    );
    if (!r.affectedRows) return fail(res, "棋盘已变化，请刷新后重试", 409);

    const [[fresh]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
    const payload = roomToResp(fresh, 0);
    // 同时通知双方与观战者（观战者靠轮询 /rooms/:id，这里只推对局方）
    push(Number(row.host_id), "game_move", payload);
    if (Number(row.guest_id)) push(Number(row.guest_id), "game_move", payload);
    return ok(res, roomToResp(fresh, me), finished ? (winner ? "获胜！" : "平局") : "已落子");
  })
);

// 认输 / 离开
router.post(
  "/rooms/:id/resign",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
    if (!row) return fail(res, "房间不存在", 404);
    const me = req.user.id;
    const isHost = Number(row.host_id) === me;
    const isGuest = Number(row.guest_id) === me;
    if (!isHost && !isGuest) return fail(res, "你不是对局方", 403);
    if (row.status === "finished") return ok(res, null, "对局已结束");
    // 等待中退出 = 废弃房间；对局中退出 = 对手获胜
    const opponent = isHost ? Number(row.guest_id) : Number(row.host_id);
    if (row.status === "waiting") {
      await pool.query("UPDATE game_rooms SET status = 'abandoned', updated_time = ? WHERE id = ?", [now(), id]);
      return ok(res, null, "已取消房间");
    }
    const [r] = await pool.query(
      "UPDATE game_rooms SET status = 'finished', winner_id = ?, turn_user_id = 0, version = version + 1, updated_time = ? WHERE id = ? AND status = 'playing'",
      [opponent || 0, now(), id]
    );
    if (r.affectedRows && opponent) {
      const [[fresh]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
      push(opponent, "game_move", roomToResp(fresh, 0));
    }
    return ok(res, null, "已认输");
  })
);

// 进行中的对局（前端「继续对局」入口）
router.get(
  "/my-rooms",
  authRequired,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT r.*, h.username AS host_name, h.display_name AS host_display_name,
              g.username AS guest_name, g.display_name AS guest_display_name
         FROM game_rooms r
         LEFT JOIN users h ON h.id = r.host_id
         LEFT JOIN users g ON g.id = r.guest_id
        WHERE (r.host_id = ? OR r.guest_id = ?) AND r.status IN ('waiting','playing')
        ORDER BY r.id DESC LIMIT 20`,
      [req.user.id, req.user.id]
    );
    return ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        game_key: r.game_key,
        game_name: GAMES[r.game_key]?.name || r.game_key,
        status: r.status,
        opponent: Number(r.host_id) === req.user.id
          ? { id: Number(r.guest_id) || 0, name: r.guest_display_name || r.guest_name || "" }
          : { id: Number(r.host_id) || 0, name: r.host_display_name || r.host_name || "" },
        my_turn: Number(r.turn_user_id) === req.user.id,
        updated_time: Number(r.updated_time) || Number(r.created_time),
      }))
    );
  })
);

export default router;
