// 联机对战路由 —— 通用引擎派发
// ===========================================================================
// 这一层**不含任何游戏规则**：规则全在 services/games/*.js 里。
// 路由只负责：房间生命周期、成员校验、把客户端操作转交引擎、广播结果。
//
// 三条不变式（改动前先确认）：
//   ① 房主恒为 side 1（先手）；客户端永远不能自己指定 side，
//      否则可以伪造「我是先手」来抢回合；
//   ② state 由引擎产出、原样落库，路由不解释它；
//   ③ view() 按视角过滤（海战棋据此隐藏对手布阵）——
//      所以**每次返回都必须带 viewer 的 side**，不能把原始 state 直接下发。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, idParam, safeJSONParse } from "../utils.js";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { push } from "../services/realtime.js";
import { getGame, gameList, isOnlineGame } from "../services/games/index.js";

const router = Router();

/** 玩家在房间里的阵营：房主 1、客方 2、其他人 0（观战） */
function sideOf(row, userId) {
  if (Number(row.host_id) === Number(userId)) return 1;
  if (Number(row.guest_id) === Number(userId)) return 2;
  return 0;
}

/** 房间 → 响应体（按 viewer 视角过滤，绝不泄露隐藏信息） */
function roomToResp(row, viewerId = 0, baseUrlHint = "") {
  const game = getGame(row.game_key);
  const side = sideOf(row, viewerId);
  const state = safeJSONParse(row.state, {}) || {};
  const view = game?.view ? game.view(state, { side, userId: viewerId }) : { board: [] };
  return {
    id: Number(row.id),
    game_key: row.game_key,
    game_name: game?.name || row.game_key,
    brief: game?.brief || "",
    meta: game?.meta ? game.meta() : {},
    status: row.status,
    host_id: Number(row.host_id) || 0,
    guest_id: Number(row.guest_id) || 0,
    turn_user_id: Number(row.turn_user_id) || 0,
    winner_id: Number(row.winner_id) || 0,
    version: Number(row.version) || 0,
    spectatable: Number(row.spectatable) || 0,
    my_side: side,
    my_turn: side > 0 && Number(row.turn_user_id) === Number(viewerId),
    // 引擎给的视图（棋盘、阶段、合法着法等）平铺到顶层，前端直接用
    ...view,
    created_time: Number(row.created_time),
    updated_time: Number(row.updated_time) || 0,
    url_hint: baseUrlHint,
  };
}

async function loadRoom(id) {
  const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [id]);
  return row || null;
}

/** 落库 + 广播（对局双方都收到同一次更新的各自视角） */
async function commit(row, engineResult, io = {}) {
  const finished = Boolean(engineResult.finished);
  const winnerSide = Number(engineResult.winnerSide) || 0;
  const newState = engineResult.state;
  // winner_id 落库：需要把 side 换算成具体用户（1=host，2=guest）
  const winnerId = winnerSide === 1 ? Number(row.host_id) : winnerSide === 2 ? Number(row.guest_id) : 0;
  const turnSide = newState.turn;
  const turnUserId = turnSide === 1 ? Number(row.host_id) : turnSide === 2 ? Number(row.guest_id) : 0;

  // 乐观锁：带上读到的 version，并发操作只生效一次
  const [r] = await pool.query(
    `UPDATE game_rooms SET state = ?, status = ?, turn_user_id = ?, winner_id = ?, version = version + 1, updated_time = ?
      WHERE id = ? AND version = ?`,
    [
      JSON.stringify(newState),
      finished ? "finished" : row.status,
      finished ? 0 : turnUserId,
      winnerId,
      now(),
      row.id,
      Number(row.version) || 0,
    ]
  );
  if (!r.affectedRows) return { conflict: true };

  const [[fresh]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [row.id]);
  // 按各自视角推送：两个客户端收到的隐藏信息不同（海战棋）
  if (Number(row.host_id)) push(Number(row.host_id), "game_move", roomToResp(fresh, Number(row.host_id)));
  if (Number(row.guest_id)) push(Number(row.guest_id), "game_move", roomToResp(fresh, Number(row.guest_id)));
  return { fresh, result: engineResult };
}

// ---------------------------------------------------------------------------
// 游戏目录
// ---------------------------------------------------------------------------
router.get(
  "/list",
  authRequired,
  asyncHandler(async (req, res) => ok(res, gameList()))
);

// ---------------------------------------------------------------------------
// 房间列表（可加入 / 观战）
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
        ORDER BY r.status = 'waiting' DESC, r.id DESC LIMIT 60`,
      args
    );
    return ok(
      res,
      rows.map((r) => {
        const game = getGame(r.game_key);
        const state = safeJSONParse(r.state, {}) || {};
        return {
          id: Number(r.id),
          game_key: r.game_key,
          game_name: game?.name || r.game_key,
          brief: game?.brief || "",
          status: r.status,
          phase: state.phase || "",
          host_id: Number(r.host_id) || 0,
          host_name: r.host_display_name || r.host_name || "",
          guest_id: Number(r.guest_id) || 0,
          guest_name: r.guest_display_name || r.guest_name || "",
          spectatable: Number(r.spectatable) || 0,
          created_time: Number(r.created_time),
          is_mine: Number(r.host_id) === req.user.id || Number(r.guest_id) === req.user.id,
        };
      })
    );
  })
);

// ---------------------------------------------------------------------------
// 创建房间
// ---------------------------------------------------------------------------
router.post(
  "/rooms",
  rateLimit({ windowMs: 60_000, max: 15, keyPrefix: "game-room", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const key = String(req.body?.game_key || "").trim().slice(0, 24);
    const game = getGame(key);
    if (!game) return fail(res, "不支持的游戏类型");
    // 同一用户同时只能有一个等待中的房间：否则会建一堆空房间把大厅刷满
    const [[exist]] = await pool.query("SELECT id FROM game_rooms WHERE host_id = ? AND status = 'waiting' LIMIT 1", [req.user.id]);
    if (exist) await pool.query("UPDATE game_rooms SET status = 'abandoned' WHERE id = ?", [exist.id]);

    const state = game.init();
    const r = await pool.query(
      `INSERT INTO game_rooms (game_key, status, host_id, state, turn_user_id, spectatable, version, created_time, updated_time)
       VALUES (?, 'waiting', ?, ?, ?, 1, 0, ?, ?)`,
      [key, req.user.id, JSON.stringify(state), req.user.id, now(), now()]
    );
    const roomId = Number(r[0].insertId);
    const [[row]] = await pool.query("SELECT * FROM game_rooms WHERE id = ?", [roomId]);
    return ok(res, roomToResp(row, req.user.id), "房间已创建，等待对手加入");
  })
);

// ---------------------------------------------------------------------------
// 房间详情
// ---------------------------------------------------------------------------
router.get(
  "/rooms/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const row = await loadRoom(id);
    if (!row) return fail(res, "房间不存在", 404);
    const side = sideOf(row, req.user.id);
    // 非对局方：只有允许观战时能看（且对隐藏信息游戏，观战视角等同对手视角，看不到布阵）
    if (!side && !Number(row.spectatable)) return fail(res, "该对局不允许观战", 403);
    return ok(res, roomToResp(row, req.user.id));
  })
);

// ---------------------------------------------------------------------------
// 加入 / 认输 / 离开
// ---------------------------------------------------------------------------
router.post(
  "/rooms/:id/join",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    // 条件更新 + affectedRows：两人同时点「加入」只有一个能成功
    const [r] = await pool.query(
      "UPDATE game_rooms SET guest_id = ?, status = 'playing', updated_time = ? WHERE id = ? AND status = 'waiting' AND host_id <> ?",
      [req.user.id, now(), id, req.user.id]
    );
    if (!r.affectedRows) {
      const row = await loadRoom(id);
      if (!row) return fail(res, "房间不存在", 404);
      if (Number(row.host_id) === req.user.id) return fail(res, "不能加入自己创建的房间");
      return fail(res, "房间已开始对局或被占满", 409);
    }
    const row = await loadRoom(id);
    // 通知房主：对手到了（各自视角）
    push(Number(row.host_id), "game_joined", roomToResp(row, Number(row.host_id)));
    return ok(res, roomToResp(row, req.user.id), "已加入对局");
  })
);

router.post(
  "/rooms/:id/resign",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const row = await loadRoom(id);
    if (!row) return fail(res, "房间不存在", 404);
    const side = sideOf(row, req.user.id);
    if (!side) return fail(res, "你不是对局方", 403);
    if (row.status === "finished") return ok(res, null, "对局已结束");
    if (row.status === "waiting") {
      await pool.query("UPDATE game_rooms SET status = 'abandoned', updated_time = ? WHERE id = ?", [now(), id]);
      return ok(res, null, "已取消房间");
    }
    const opponentId = side === 1 ? Number(row.guest_id) : Number(row.host_id);
    const [r] = await pool.query(
      "UPDATE game_rooms SET status = 'finished', winner_id = ?, turn_user_id = 0, version = version + 1, updated_time = ? WHERE id = ? AND status = 'playing'",
      [opponentId || 0, now(), id]
    );
    if (r.affectedRows && opponentId) {
      const fresh = await loadRoom(id);
      push(opponentId, "game_move", roomToResp(fresh, opponentId));
    }
    return ok(res, null, "已认输");
  })
);

// 我参与的对局（前端「继续对局」入口）
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
        game_name: getGame(r.game_key)?.name || r.game_key,
        status: r.status,
        opponent:
          Number(r.host_id) === req.user.id
            ? { id: Number(r.guest_id) || 0, name: r.guest_display_name || r.guest_name || "" }
            : { id: Number(r.host_id) || 0, name: r.host_display_name || r.host_name || "" },
        my_turn: Number(r.turn_user_id) === req.user.id,
        updated_time: Number(r.updated_time) || Number(r.created_time),
      }))
    );
  })
);

// ---------------------------------------------------------------------------
// 统一动作入口
// ---------------------------------------------------------------------------
// 把「落子 / 摆放 / 准备 / 随机布阵」都收在一个端点上：
// 每个游戏的阶段动作集不同（海战棋有 place/ready/auto，其他只有 move），
// 用 /action 分派比给每个游戏开一套路由清晰得多，限流也只需挂一处。
const ENGINE_ACTIONS = {
  move: (game, state, ctx) => game.move(state, ctx),
  place: (game, state, ctx) => (game.place ? game.place(state, ctx) : { error: "该游戏不支持布阵" }),
  ready: (game, state, ctx) => (game.ready ? game.ready(state, ctx) : { error: "该游戏不支持准备操作" }),
  auto: (game, state, ctx) =>
    game.auto ? game.auto(state, { side: ctx.side, userId: ctx.userId }) : { error: "该游戏不支持随机布置" },
};

router.post(
  "/rooms/:id/action",
  rateLimit({ windowMs: 60_000, max: 180, keyPrefix: "game-action", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const action = String(req.body?.action || "move");
    if (!ENGINE_ACTIONS[action]) return fail(res, "未知操作");
    const game = getGame(req.body?.game_key) || null;

    const row = await loadRoom(id);
    if (!row) return fail(res, "房间不存在", 404);
    const engine = getGame(row.game_key);
    if (!engine) return fail(res, "该房间的游戏已下线", 410);
    // game_key 传了就必须一致：防止「在 A 游戏的房间里用 B 游戏规则落子」
    if (game && game.key !== engine.key) return fail(res, "游戏类型不匹配");

    const side = sideOf(row, req.user.id);
    if (!side) return fail(res, "你不是对局方", 403);
    if (row.status === "finished") return fail(res, "对局已结束");
    // 等待对手期间允许**布阵类**动作（place/ready/auto）：
    // 房主建好房间就该能先摆好自己的舰，对手一加入即可开打 ——
    // 让大家干等对手到了才能布阵是没必要的摩擦。
    // 但落子（move）必须等对手到场，否则等于一个人先走棋。
    const PLACEMENT_ACTIONS = new Set(["place", "ready", "auto"]);
    if (row.status === "waiting" && !PLACEMENT_ACTIONS.has(action)) {
      return fail(res, "还在等待对手加入");
    }

    const state = safeJSONParse(row.state, null);
    if (!state) return fail(res, "对局状态异常，请重新开局", 500);

    const out = ENGINE_ACTIONS[action](engine, state, { side, payload: req.body?.payload || req.body, userId: req.user.id });
    if (out?.error) return fail(res, out.error);

    const { conflict, fresh, result } = await commit(row, out);
    if (conflict) {
      // 乐观锁冲突：让客户端刷新（极少数并发场景）
      const latest = await loadRoom(id);
      return fail(res, "对局状态已变化，请重试", 409, roomToResp(latest, req.user.id));
    }
    return ok(res, roomToResp(fresh, req.user.id), result.note || "已执行");
  })
);

// 兼容旧端点：POST /rooms/:id/move（前端历史的落子调用）
router.post(
  "/rooms/:id/move",
  rateLimit({ windowMs: 60_000, max: 180, keyPrefix: "game-action", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const row = await loadRoom(id);
    if (!row) return fail(res, "房间不存在", 404);
    const engine = getGame(row.game_key);
    if (!engine) return fail(res, "该房间的游戏已下线", 410);
    const side = sideOf(row, req.user.id);
    if (!side) return fail(res, "你不是对局方", 403);
    if (row.status !== "playing") return fail(res, "对局未开始或已结束");

    const state = safeJSONParse(row.state, null);
    if (!state) return fail(res, "对局状态异常", 500);
    const out = engine.move(state, { side, payload: req.body, userId: req.user.id });
    if (out?.error) return fail(res, out.error);
    const { conflict, fresh, result } = await commit(row, out);
    if (conflict) return fail(res, "对局状态已变化，请重试", 409);
    return ok(res, roomToResp(fresh, req.user.id), result.note || "已落子");
  })
);

export default router;
