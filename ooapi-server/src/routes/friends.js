// 好友系统：好友列表 / 好友申请 / 验证 / 备注 / 关系解除 / 一键私聊
// ---------------------------------------------------------------------------
// 设计要点：
// ① 双向好友模型：成为好友时在 friendships 插入两条记录（A->B 与 B->A），
//    这样双方都可以独立拥有对好友的「自定义备注名」（remark），不互相干扰。
// ② 好友申请防刷：同一对用户在 status=0（待处理）时重复申请只更新留言与时间，
//    不生成多条垃圾记录。
// ③ 互相申请直接成为好友：A 申请 B 时若 B 已有发给 A 的待处理申请，
//    等价于 A 同意了 B —— 否则两边各挂一条「等待验证」，谁也不知道对方也在等。
// ④ 实时推送联动：好友申请、同意申请、在线/离线状态通过 SSE (realtime.js)
//    主动推送给对应在线连接，前端界面实时刷新红点。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, idParam } from "../utils.js";
import { notify } from "../services/notify-center.js";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { push, isOnline } from "../services/realtime.js";
import { openSingleRoom, avatarUrlOf } from "../services/chat-rooms.js";

const router = Router();

/** 用户简要公开信息查询 */
async function userBrief(id) {
  const [[u]] = await pool.query(
    "SELECT id, username, display_name, avatar_media_id, bio, status FROM users WHERE id = ?",
    [id]
  );
  if (!u) return null;
  return {
    id: Number(u.id),
    username: u.username,
    display_name: u.display_name,
    avatar_url: avatarUrlOf(u),
    bio: u.bio || "",
    status: Number(u.status),
    online: isOnline(u.id),
  };
}

/**
 * 建立双向好友关系并通知发起方（手动同意与「互相申请」共用）。
 * 同时把两个方向上仍待处理的申请都标记为已同意 —— 否则对方那条申请
 * 会一直挂在「新的朋友」里，点同意时报「对方已经是您的好友」。
 */
async function makeFriends(me, otherId) {
  const ts = now();
  await pool.query(
    `UPDATE friend_requests SET status = 1, handled_time = ?
      WHERE status = 0 AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    [ts, otherId, me.id, me.id, otherId]
  );
  // 如之前存在过 status=2 已删除记录，则重新置为 1（备注保留，重新加回来时不用再填）
  await pool.query(
    `INSERT INTO friendships (user_id, friend_id, status, created_time)
     VALUES (?, ?, 1, ?), (?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE status = 1, created_time = VALUES(created_time)`,
    [me.id, otherId, ts, otherId, me.id, ts]
  );
  // 落库通知发起方（离线可见，见下面 friend_request 的说明）+ SSE 实时推送
  await notify({ userId: otherId, actorId: me.id, type: "friend_accept" }).catch((e) =>
    console.warn(`[friends] 好友通过通知写入失败：${e.message}`)
  );
  push(otherId, "friend_accepted", {
    by: { id: me.id, username: me.username, display_name: me.display_name },
    at: ts,
  });
}

// ---------------------------------------------------------------------------
// 1. 获取我的好友列表
// ---------------------------------------------------------------------------
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT f.friend_id, f.remark, f.created_time,
              u.username, u.display_name, u.avatar_media_id, u.bio, u.status
         FROM friendships f
         JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ? AND f.status = 1 AND u.status = 1
        ORDER BY f.created_time DESC`,
      [req.user.id]
    );

    const friends = rows.map((r) => {
      const fid = Number(r.friend_id);
      return {
        id: fid,
        username: r.username,
        display_name: r.display_name,
        remark: r.remark || "",
        title: r.remark || r.display_name || r.username,
        avatar_url: avatarUrlOf({ id: fid, avatar_media_id: r.avatar_media_id }),
        bio: r.bio || "",
        online: isOnline(fid),
        created_time: Number(r.created_time),
      };
    });

    return ok(res, friends);
  })
);

// ---------------------------------------------------------------------------
// 2. 好友申请列表（收到的申请 + 发出的申请）
// ---------------------------------------------------------------------------
router.get(
  "/requests",
  authRequired,
  asyncHandler(async (req, res) => {
    // 我收到的待处理申请
    const [incoming] = await pool.query(
      `SELECT r.id, r.from_user_id, r.message, r.status, r.created_time,
              u.username, u.display_name, u.avatar_media_id, u.bio
         FROM friend_requests r
         JOIN users u ON u.id = r.from_user_id
        WHERE r.to_user_id = ? AND r.status = 0
        ORDER BY r.created_time DESC LIMIT 50`,
      [req.user.id]
    );

    // 我发出的申请（按最新）
    const [outgoing] = await pool.query(
      `SELECT r.id, r.to_user_id, r.message, r.status, r.created_time, r.handled_time,
              u.username, u.display_name, u.avatar_media_id, u.bio
         FROM friend_requests r
         JOIN users u ON u.id = r.to_user_id
        WHERE r.from_user_id = ?
        ORDER BY r.created_time DESC LIMIT 50`,
      [req.user.id]
    );

    const inList = incoming.map((r) => ({
      id: Number(r.id),
      from_user_id: Number(r.from_user_id),
      username: r.username,
      display_name: r.display_name,
      avatar_url: avatarUrlOf({ id: r.from_user_id, avatar_media_id: r.avatar_media_id }),
      bio: r.bio || "",
      message: r.message || "",
      status: Number(r.status),
      online: isOnline(r.from_user_id),
      created_time: Number(r.created_time),
    }));

    const outList = outgoing.map((r) => ({
      id: Number(r.id),
      to_user_id: Number(r.to_user_id),
      username: r.username,
      display_name: r.display_name,
      avatar_url: avatarUrlOf({ id: r.to_user_id, avatar_media_id: r.avatar_media_id }),
      bio: r.bio || "",
      message: r.message || "",
      status: Number(r.status),
      handled_time: Number(r.handled_time),
      created_time: Number(r.created_time),
    }));

    return ok(res, {
      incoming: inList,
      outgoing: outList,
      pending_count: inList.length,
    });
  })
);

// ---------------------------------------------------------------------------
// 3. 与某人的关系（个人主页 / 资料卡的按钮状态用）
//    none | friend | pending_out（我已申请）| pending_in（对方申请了我）| self
// ---------------------------------------------------------------------------
router.get(
  "/relation/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const otherId = idParam(req);
    if (!otherId) return fail(res, "用户不存在", 404);
    if (otherId === req.user.id) return ok(res, { relation: "self" });
    const [[f]] = await pool.query(
      "SELECT remark FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 1",
      [req.user.id, otherId]
    );
    if (f) return ok(res, { relation: "friend", remark: f.remark || "" });
    const [[pending]] = await pool.query(
      `SELECT id, from_user_id FROM friend_requests
        WHERE status = 0 AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
        ORDER BY id DESC LIMIT 1`,
      [req.user.id, otherId, otherId, req.user.id]
    );
    if (pending) {
      const mine = Number(pending.from_user_id) === req.user.id;
      return ok(res, { relation: mine ? "pending_out" : "pending_in", request_id: Number(pending.id) });
    }
    return ok(res, { relation: "none" });
  })
);

// ---------------------------------------------------------------------------
// 4. 发送好友申请
// ---------------------------------------------------------------------------
router.post(
  "/requests",
  authRequired,
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "friend-req", keyFn: (r) => r.user?.id || r.ip }),
  asyncHandler(async (req, res) => {
    const toUserId = Number(req.body?.to_user_id) || 0;
    if (!toUserId) return fail(res, "请选择要添加的用户");
    if (toUserId === req.user.id) return fail(res, "不能向自己发送好友申请");

    const peer = await userBrief(toUserId);
    if (!peer || peer.status !== 1) return fail(res, "目标用户不存在或已被禁用", 404);

    // 检查是否已经是好友
    const [[alreadyFriend]] = await pool.query(
      "SELECT id FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 1",
      [req.user.id, toUserId]
    );
    if (alreadyFriend) return fail(res, "对方已经是您的好友");

    // 对方已经申请过我：直接成为好友（见文件头 ③）
    const [[reverse]] = await pool.query(
      "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 0 LIMIT 1",
      [toUserId, req.user.id]
    );
    if (reverse) {
      await makeFriends(req.user, toUserId);
      return ok(res, { id: Number(reverse.id), status: "accepted" }, "对方也申请过加你，已直接成为好友");
    }

    const raw = String(req.body?.message || "").trim();
    if (raw.length > 200) return fail(res, `验证消息最长 200 字，当前 ${raw.length} 字`);
    const message = raw;

    // 查看是否有历史待处理记录，防重复插入
    const [[existing]] = await pool.query(
      "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 0 LIMIT 1",
      [req.user.id, toUserId]
    );

    let reqId;
    if (existing) {
      await pool.query(
        "UPDATE friend_requests SET message = ?, created_time = ? WHERE id = ?",
        [message, now(), existing.id]
      );
      reqId = Number(existing.id);
    } else {
      const r = await pool.query(
        "INSERT INTO friend_requests (from_user_id, to_user_id, message, status, created_time) VALUES (?, ?, ?, 0, ?)",
        [req.user.id, toUserId, message, now()]
      );
      reqId = Number(r[0].insertId);
    }

    // 落库通知：**离线也要能看到**。
    //
    // 原先这里只有下面的 SSE 推送，没有落库 —— 人格实测报的缺口：
    // 「小号给主号发申请，主号通知页 0 条……不是我主动去翻那个五步路径，
    //   永远不知道有人加我。」SSE 只覆盖"此刻在线"的人，离线用户彻底错过。
    // 与社区通知同一套（notify 内部会顺带发 SSE，两者不冲突）。
    // 重复申请（existing）不再重复落库：只更新留言，避免对方通知页被同一个人刷屏。
    if (!existing) {
      await notify({
        userId: toUserId,
        actorId: req.user.id,
        type: "friend_request",
      }).catch((e) => console.warn(`[friends] 好友申请通知写入失败：${e.message}`));
    }

    // SSE 实时通知接收方
    push(toUserId, "friend_request", {
      request_id: reqId,
      from: {
        id: req.user.id,
        username: req.user.username,
        display_name: req.user.display_name,
        message,
      },
      created_time: now(),
    });

    return ok(res, { id: reqId, status: "pending" }, "好友申请已发送");
  })
);

// ---------------------------------------------------------------------------
// 5. 处理好友申请（同意 / 拒绝）
// ---------------------------------------------------------------------------
router.put(
  "/requests/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "申请记录不存在", 404);

    const [[record]] = await pool.query(
      "SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ?",
      [id, req.user.id]
    );
    if (!record) return fail(res, "未找到该好友申请或无权操作", 404);
    if (Number(record.status) !== 0) return fail(res, "该申请已处理过");

    const action = String(req.body?.action || "").toLowerCase();
    if (!["accept", "reject"].includes(action)) return fail(res, "无效的操作类型");

    const fromUserId = Number(record.from_user_id);

    if (action === "accept") {
      // 申请人可能在等待期间被封禁：同意一个不可用账号只会产生一个点不开的好友
      const peer = await userBrief(fromUserId);
      if (!peer || peer.status !== 1) return fail(res, "对方账号已不可用", 404);
      await makeFriends(req.user, fromUserId);
      return ok(res, { status: "accepted" }, "已同意好友申请");
    }
    await pool.query("UPDATE friend_requests SET status = 2, handled_time = ? WHERE id = ?", [now(), id]);
    return ok(res, { status: "rejected" }, "已拒绝好友申请");
  })
);

// 撤回自己发出、对方尚未处理的申请（status=3 已撤回；前端「我发出的」据此显示）
router.delete(
  "/requests/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "申请记录不存在", 404);
    const [ret] = await pool.query(
      "UPDATE friend_requests SET status = 3, handled_time = ? WHERE id = ? AND from_user_id = ? AND status = 0",
      [now(), id, req.user.id]
    );
    if (!ret.affectedRows) return fail(res, "申请不存在或已被处理", 404);
    return ok(res, null, "已撤回申请");
  })
);

// ---------------------------------------------------------------------------
// 6. 修改好友备注名
// ---------------------------------------------------------------------------
router.put(
  "/:id/remark",
  authRequired,
  asyncHandler(async (req, res) => {
    const friendId = idParam(req);
    if (!friendId) return fail(res, "好友不存在", 404);

    const remark = String(req.body?.remark || "").trim().slice(0, 64);
    const [ret] = await pool.query(
      "UPDATE friendships SET remark = ? WHERE user_id = ? AND friend_id = ? AND status = 1",
      [remark, req.user.id, friendId]
    );

    if (!ret.affectedRows) return fail(res, "好友关系不存在或已被解除", 404);
    return ok(res, { friend_id: friendId, remark }, "备注已更新");
  })
);

// ---------------------------------------------------------------------------
// 7. 删除好友（解除关系）
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const friendId = idParam(req);
    if (!friendId) return fail(res, "好友不存在", 404);

    // 双向软删除/解除
    await pool.query(
      "UPDATE friendships SET status = 2 WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
      [req.user.id, friendId, friendId, req.user.id]
    );

    push(friendId, "friend_removed", { friend_id: req.user.id });
    return ok(res, null, "好友已解除");
  })
);

// ---------------------------------------------------------------------------
// 8. 一键发起/打开与好友的单聊
// ---------------------------------------------------------------------------
router.post(
  "/:id/chat",
  authRequired,
  asyncHandler(async (req, res) => {
    const friendId = idParam(req);
    if (!friendId) return fail(res, "用户不存在", 404);
    if (friendId === req.user.id) return fail(res, "不能和自己发起私聊");
    // 原实现不校验对方账号：传任意 id（含不存在/已封禁的）都会建出一个房间
    const peer = await userBrief(friendId);
    if (!peer || peer.status !== 1) return fail(res, "对方账号不可用", 404);
    const r = await openSingleRoom(req.user.id, friendId);
    return ok(res, { room_id: r.id, existed: r.existed });
  })
);

export default router;
