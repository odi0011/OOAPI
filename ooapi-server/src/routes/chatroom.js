// 实时聊天：房间（单聊/群聊）+ 消息 + SSE 推送
// 频道体系（服务器 + 子频道）已于第 79 批下线：公共讨论由社区帖子承担，
// 这里只保留私聊与群聊。遗留的频道房间由 db.js#retireGuildRooms 软解散。
// type=discussion（讨论组）仍兼容读取，前端按群聊展示，不再提供新建入口。
// ---------------------------------------------------------------------------
// 设计要点：
//
// ① **单聊也建成房间**（type=single）：拉会话列表只需一张表；将来「单聊升级群聊」
//    只需改 type 与成员，不用搬消息。
//
// ② **单聊房间唯一**：靠 `single_key` 列（两个用户 id 排序拼接）唯一键保证 ——
//    否则 A→B 点两次「发消息」会建出两个房间，双方各看一个，消息永远对不上。
//
// ③ **未读数用 last_read_id 算**，不给每个成员维护未读计数：计数冗余一旦漂移
//    就很难修（要遍历全表重算），而 `COUNT(*) WHERE id > last_read_id` 有
//    (room_id, id) 索引，代价可接受。
//
// ④ **成员校验集中在 memberOf()**：任何涉及房间的读写都必须先过它，
//    否则「知道 room_id 就能读别人私聊」—— 这是最容易漏的越权点。
import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, pageParams, idParam, safeJSONParse } from "../utils.js";
import { authRequired, adminRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { sseHeaders, register, unregister, push, pushMany, isOnline } from "../services/realtime.js";
import { mediaUrl, attachRef, filterOwnedMediaIds } from "../services/media.js";
import { openSingleRoom, avatarUrlOf, contactIdsOf } from "../services/chat-rooms.js";

const router = Router();

const MAX_TEXT = 4000;
const MAX_GROUP_MEMBERS = 200;
const MAX_MEDIA = 4;

const nameOf = (u) => u?.display_name || u?.username || "";

/** 成员校验：返回成员行（含 role/last_read_id），非成员返回 null */
async function memberOf(roomId, userId) {
  const [[m]] = await pool.query("SELECT * FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
  return m || null;
}

/** 房间成员 id 列表（推送用） */
async function memberIdsOf(roomId) {
  const [rows] = await pool.query("SELECT user_id FROM chat_room_members WHERE room_id = ?", [roomId]);
  return rows.map((r) => Number(r.user_id));
}

async function userBrief(id) {
  const [[u]] = await pool.query("SELECT id, username, display_name, avatar_media_id FROM users WHERE id = ?", [id]);
  if (!u) return { id: Number(id) || 0, username: "", display_name: "" };
  return { id: Number(u.id), username: u.username, display_name: u.display_name, avatar_url: avatarUrlOf(u) };
}

/**
 * 批量取单聊房间的「对方」：一次查询代替逐房间 N 次。
 * 会话列表与搜索结果都要显示对方名字，原实现每个单聊房间各查两次（成员 + 用户）。
 */
async function peersOf(roomIds, userId) {
  const map = new Map();
  if (!roomIds.length) return map;
  const [rows] = await pool.query(
    `SELECT m.room_id, u.id, u.username, u.display_name, u.avatar_media_id
       FROM chat_room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id IN (${roomIds.map(() => "?").join(",")}) AND m.user_id <> ?`,
    [...roomIds, userId]
  );
  for (const r of rows) {
    if (map.has(Number(r.room_id))) continue;
    map.set(Number(r.room_id), {
      id: Number(r.id),
      username: r.username,
      display_name: r.display_name,
      avatar_url: avatarUrlOf(r),
    });
  }
  return map;
}

/** 消息行 → 响应体 */
async function messageToResp(row, users = new Map()) {
  const ids = safeJSONParse(row.media_ids, []) || [];
  const media = [];
  for (const mid of Array.isArray(ids) ? ids : []) {
    const n = Number(mid) || 0;
    if (n) media.push({ id: n, url: await mediaUrl(n) });
  }
  let author = users.get(Number(row.user_id));
  if (!author) {
    author = await userBrief(row.user_id);
    users.set(Number(row.user_id), author);
  }
  return {
    id: Number(row.id),
    room_id: Number(row.room_id),
    user_id: Number(row.user_id),
    author,
    type: row.type,
    content: row.content || "",
    media,
    // 原样回显客户端临时 id：前端靠它把乐观队列里的那条消息「转正」
    client_id: row.client_id || "",
    created_time: Number(row.created_time),
    status: Number(row.status),
  };
}

/** 写一条系统消息（进群/退群/建群等），并广播 */
async function systemMessage(roomId, text) {
  const r = await pool.query(
    "INSERT INTO chat_room_messages (room_id, user_id, type, content, created_time, status) VALUES (?, 0, 'system', ?, ?, 1)",
    [roomId, text, now()]
  );
  const msgId = Number(r[0].insertId);
  await pool.query("UPDATE chat_rooms SET last_message_id = ?, last_message_text = ?, last_message_time = ? WHERE id = ?", [
    msgId,
    String(text).slice(0, 120),
    now(),
    roomId,
  ]);
  const ids = await memberIdsOf(roomId);
  pushMany(ids, "message", { room_id: roomId, message: { id: msgId, room_id: roomId, user_id: 0, type: "system", content: text, created_time: now() } });
  return msgId;
}

// ---------------------------------------------------------------------------
// SSE 长连接
// ---------------------------------------------------------------------------
// EventSource 无法带 Authorization 头，沿用监控页那套「一次性票据」自鉴权。
const tickets = new Map(); // ticket → { userId, exp }
const TICKET_TTL = 60_000;

function issueTicket(userId) {
  const t = crypto.randomBytes(24).toString("hex");
  tickets.set(t, { userId, exp: Date.now() + TICKET_TTL });
  const nowMs = Date.now();
  for (const [k, v] of tickets.entries()) if (v.exp < nowMs) tickets.delete(k);
  return t;
}

router.post(
  "/stream-ticket",
  authRequired,
  asyncHandler(async (req, res) => ok(res, { ticket: issueTicket(req.user.id), expiresInSec: TICKET_TTL / 1000 }))
);

router.get(
  "/stream",
  asyncHandler(async (req, res) => {
    const ticket = String(req.query.ticket || "");
    const rec = tickets.get(ticket);
    if (!rec || rec.exp < Date.now()) {
      res.status(401).json({ success: false, message: "实时连接凭据无效或已过期，请刷新页面" });
      return;
    }
    tickets.delete(ticket); // 一次性
    const [[user]] = await pool.query("SELECT id, status FROM users WHERE id = ?", [rec.userId]);
    if (!user || Number(user.status) !== 1) {
      res.status(403).json({ success: false, message: "账号不可用" });
      return;
    }

    sseHeaders(res);
    const uid = Number(user.id);
    const wasOnline = isOnline(uid);
    register(uid, res);
    res.write(`event: ready\ndata: ${JSON.stringify({ user_id: uid, at: Date.now() })}\n\n`);

    // 在线状态只推给「社交圈」（好友 + 单聊对象），不做全站广播，避免泄露用户列表。
    // 多标签页：只有「第一条连接建立 / 最后一条连接断开」才算上下线，
    // 否则关掉其中一个标签页就会让对方看到你「离线」（而你其实还挂着另一个）。
    const contacts = await contactIdsOf(uid).catch(() => []);
    if (!wasOnline) pushMany(contacts, "presence", { user_id: uid, online: true });

    // 用 res 的 close 而不是 req 的：请求体读完后 req 的 close 可能提前触发（见 AGENTS.md 速查表）
    res.on("close", () => {
      unregister(uid, res);
      if (!isOnline(uid)) pushMany(contacts, "presence", { user_id: uid, online: false });
    });
    return undefined;
  })
);

// 在线列表：只返回「社交圈」里在线的人。
// 原实现直接返回 onlineUserIds() —— 任何登录用户都能拿到全站在线 id，
// 与上面「不做全站广播」的设计自相矛盾。
router.get(
  "/online",
  authRequired,
  asyncHandler(async (req, res) => {
    const contacts = await contactIdsOf(req.user.id);
    return ok(res, contacts.filter((id) => isOnline(id)));
  })
);

// 跨会话消息搜索（只搜自己所在房间的消息）
// 为什么限制在自己房间：聊天是私密的，能搜到别人房间的内容等于泄露。
router.get(
  "/search",
  authRequired,
  asyncHandler(async (req, res) => {
    const kw = String(req.query.q || "").trim().slice(0, 64);
    if (!kw) return ok(res, { items: [], total: 0 });
    const { p, size, offset } = pageParams(req.query, 30);
    // 用 EXISTS 限定「我在这个房间里」，并在 SQL 层做 LIKE——
    // 不要把消息全拉到 Node 里过滤（量大了内存与延迟都不可控）
    const base = `FROM chat_room_messages msg
       JOIN chat_rooms r ON r.id = msg.room_id
       JOIN chat_room_members m ON m.room_id = msg.room_id AND m.user_id = ?
      WHERE msg.status = 1 AND r.status = 1 AND msg.content LIKE ?`;
    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n ${base}`, [req.user.id, `%${kw}%`]);
    const [rows] = await pool.query(
      `SELECT msg.*, r.type AS room_type, r.name AS room_name ${base} ORDER BY msg.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, `%${kw}%`, size, offset]
    );
    // 单聊房间显示对方名字（与列表一致），否则用户看不懂搜到的是哪段对话
    const singleIds = [...new Set(rows.filter((r) => r.room_type === "single").map((r) => Number(r.room_id)))];
    const peers = await peersOf(singleIds, req.user.id);
    const users = new Map();
    const items = [];
    for (const r of rows) {
      const peer = peers.get(Number(r.room_id));
      const title = r.room_type === "single" ? nameOf(peer) : r.room_name;
      const msgResp = await messageToResp(r, users);
      items.push({ ...msgResp, room_type: r.room_type, room_title: title || `会话 #${r.room_id}` });
    }
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size });
  })
);

// 全部未读汇总（导航栏红点用）
router.get(
  "/unread",
  authRequired,
  asyncHandler(async (req, res) => {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(unread), 0) AS total FROM (
         SELECT (SELECT COUNT(*) FROM chat_room_messages msg
                  WHERE msg.room_id = m.room_id AND msg.id > m.last_read_id AND msg.status = 1 AND msg.user_id <> ?) AS unread
           FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id
          WHERE m.user_id = ? AND r.status = 1) t`,
      [req.user.id, req.user.id]
    );
    return ok(res, { total: Number(row.total) || 0 });
  })
);


// ---------------------------------------------------------------------------
// 用户搜索（发起单聊/邀请进群用）
// ---------------------------------------------------------------------------
router.get(
  "/users",
  authRequired,
  asyncHandler(async (req, res) => {
    const kw = String(req.query.q || "").trim().slice(0, 64);
    if (!kw) return ok(res, []);
    const like = `%${kw}%`;
    const [rows] = await pool.query(
      `SELECT id, username, display_name, avatar_media_id FROM users
        WHERE status = 1 AND (username LIKE ? OR display_name LIKE ?)
        ORDER BY id ASC LIMIT 20`,
      [like, like]
    );
    return ok(
      res,
      rows
        .filter((u) => Number(u.id) !== req.user.id) // 不返回自己（发起不了与自己的单聊）
        .map((u) => ({
          id: Number(u.id),
          username: u.username,
          display_name: u.display_name,
          avatar_url: Number(u.avatar_media_id) ? `/api/media/avatar/${u.id}?v=${u.avatar_media_id}` : "",
        }))
    );
  })
);

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------
router.get(
  "/rooms",
  authRequired,
  asyncHandler(async (req, res) => {
    const { p, size, offset } = pageParams(req.query, 50);
    const [[cnt]] = await pool.query(
      "SELECT COUNT(*) AS n FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id WHERE m.user_id = ? AND r.status = 1",
      [req.user.id]
    );
    // 未读数用子查询算：计数冗余漂移难修，last_read_id 是唯一可靠来源
    const [rows] = await pool.query(
      `SELECT r.*, m.role AS my_role, m.muted, m.last_read_id,
              (SELECT COUNT(*) FROM chat_room_messages msg
                WHERE msg.room_id = r.id AND msg.id > m.last_read_id AND msg.status = 1 AND msg.user_id <> ?) AS unread
         FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id
        WHERE m.user_id = ? AND r.status = 1
        ORDER BY r.last_message_time DESC, r.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, req.user.id, size, offset]
    );
    // 单聊房间对每个用户显示「对方」的名字与头像（而不是空房间名）；
    // 好友备注优先 —— 否则在通讯录里改了备注，会话列表还是原名，两处对不上
    const peers = await peersOf(rows.filter((r) => r.type === "single").map((r) => Number(r.id)), req.user.id);
    const peerIds = [...new Set([...peers.values()].map((p) => p.id))];
    const remarks = new Map();
    if (peerIds.length) {
      const [fr] = await pool.query(
        `SELECT friend_id, remark FROM friendships WHERE user_id = ? AND status = 1 AND friend_id IN (${peerIds.map(() => "?").join(",")})`,
        [req.user.id, ...peerIds]
      );
      for (const f of fr) if (f.remark) remarks.set(Number(f.friend_id), f.remark);
    }
    const items = [];
    for (const r of rows) {
      let title = r.name;
      let peer = null;
      if (r.type === "single") {
        peer = peers.get(Number(r.id)) || null;
        if (peer) title = remarks.get(peer.id) || nameOf(peer) || `用户 #${peer.id}`;
      }
      items.push({
        id: Number(r.id),
        type: r.type,
        name: r.name,
        title,
        peer,
        owner_id: Number(r.owner_id) || 0,
        announcement: r.announcement || "",
        member_count: Number(r.member_count) || 0,
        last_message_text: r.last_message_text || "",
        last_message_time: Number(r.last_message_time) || 0,
        last_read_id: Number(r.last_read_id) || 0,
        unread: Number(r.unread) || 0,
        muted: Number(r.muted) || 0,
        my_role: r.my_role,
        created_time: Number(r.created_time),
      });
    }
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size });
  })
);

// 创建房间：type=single 时 body.user_id 是对方；group/discussion 时 body.user_ids 是成员
// 限流放在鉴权**之后**：keyFn 读 req.user.id，放在前面时 req.user 还没挂上，
// 实际按 IP 计数 —— 同一出口（公司 NAT）下的所有人共享 20 次/分钟。
router.post(
  "/rooms",
  authRequired,
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "room-create", keyFn: (r) => r.user?.id || r.ip }),
  asyncHandler(async (req, res) => {
    const type = ["single", "group", "discussion"].includes(String(req.body?.type)) ? String(req.body.type) : "group";
    const name = String(req.body?.name || "").trim().slice(0, 64);
    const rawIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const peerId = Number(req.body?.user_id) || 0;
    const ids = [...new Set([...(peerId ? [peerId] : []), ...rawIds.map(Number)].filter((n) => n > 0 && n !== req.user.id))];

    if (type === "single") {
      if (!peerId) return fail(res, "请选择聊天对象");
      if (peerId === req.user.id) return fail(res, "不能和自己发起私聊");
      const [[peer]] = await pool.query("SELECT id, status FROM users WHERE id = ?", [peerId]);
      if (!peer || Number(peer.status) !== 1) return fail(res, "对方账号不可用", 404);
      // 唯一键保证同一对用户只有一个房间；退出过/解散过的旧房间会被复活（见 services/chat-rooms.js）
      const r = await openSingleRoom(req.user.id, peerId);
      return ok(res, r, r.existed ? "已存在聊天" : "已创建聊天");
    }

    if (!name) return fail(res, "请输入群聊名称");
    if (!ids.length) return fail(res, "请至少邀请一位成员");
    if (ids.length + 1 > MAX_GROUP_MEMBERS) return fail(res, `成员上限 ${MAX_GROUP_MEMBERS} 人`);
    // 只把有效用户拉进来（无效 id 静默丢弃会让「拉了 5 个人只进来 3 个」难以察觉，必须报错）
    const [valid] = await pool.query(
      `SELECT id FROM users WHERE status = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    const validIds = valid.map((v) => Number(v.id));
    if (!validIds.length) return fail(res, "邀请的成员都不可用");
    const r = await pool.query(
      "INSERT INTO chat_rooms (type, name, owner_id, member_count, status, created_time) VALUES (?, ?, ?, ?, 1, ?)",
      [type, name, req.user.id, validIds.length + 1, now()]
    );
    const roomId = Number(r[0].insertId);
    const values = [];
    const args = [];
    values.push("(?, ?, 'owner', ?)");
    args.push(roomId, req.user.id, now());
    for (const uid of validIds) {
      values.push("(?, ?, 'member', ?)");
      args.push(roomId, uid, now());
    }
    await pool.query(`INSERT INTO chat_room_members (room_id, user_id, role, joined_time) VALUES ${values.join(",")}`, args);
    await systemMessage(roomId, `${req.user.display_name || req.user.username} 创建了${type === "discussion" ? "讨论组" : "群聊"}`);
    // 通知被邀请者（他们还没进这个房间，靠 SSE 推通知）
    pushMany(validIds, "invited", { room_id: roomId, name, by: req.user.display_name || req.user.username });
    return ok(res, { id: roomId, invited: validIds.length }, "已创建");
  })
);

router.get(
  "/rooms/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    const [[room]] = await pool.query("SELECT * FROM chat_rooms WHERE id = ? AND status = 1", [id]);
    if (!room) return fail(res, "房间不存在", 404);
    // 非成员：只有管理员能看（用于处理投诉），普通用户一律 404（不泄露房间是否存在）
    if (!m && req.user.role < 100) return fail(res, "房间不存在", 404);
    const [members] = await pool.query(
      `SELECT m.user_id, m.role, m.joined_time, u.username, u.display_name, u.avatar_media_id, u.bio, u.status
         FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.id ASC`,
      [id]
    );
    const memberResp = members.map((x) => ({
      id: Number(x.user_id),
      username: x.username,
      display_name: x.display_name,
      bio: x.bio || "",
      role: x.role,
      online: isOnline(x.user_id),
      avatar_url: avatarUrlOf({ id: x.user_id, avatar_media_id: x.avatar_media_id }),
    }));
    let title = room.name;
    // 单聊要带上 peer：前端顶栏的在线状态读 room.peer —— 原先详情接口不返回它，
    // 于是单聊顶栏恒显示「离线」（列表接口有 peer，详情没有，两处口径不一）
    let peer = null;
    if (room.type === "single") {
      peer = memberResp.find((x) => x.id !== req.user.id) || null;
      title = nameOf(peer) || "单聊";
      if (peer) {
        const [[fr]] = await pool.query(
          "SELECT remark FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 1",
          [req.user.id, peer.id]
        );
        peer.is_friend = Boolean(fr);
        peer.remark = fr?.remark || "";
        if (fr?.remark) title = fr.remark;
      }
    }
    return ok(res, {
      id: Number(room.id),
      type: room.type,
      name: room.name,
      title,
      peer,
      announcement: room.announcement || "",
      owner_id: Number(room.owner_id) || 0,
      member_count: memberResp.length,
      my_role: m?.role || (req.user.role >= 100 ? "admin" : "member"),
      is_member: Boolean(m),
      last_read_id: Number(m?.last_read_id) || 0,
      created_time: Number(room.created_time),
      members: memberResp,
    });
  })
);

// 邀请成员（成员即可邀请；owner/admin 可移除）
router.post(
  "/rooms/:id/members",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    const [[room]] = await pool.query("SELECT * FROM chat_rooms WHERE id = ? AND status = 1", [id]);
    if (!room) return fail(res, "房间不存在", 404);
    if (room.type === "single") return fail(res, "单聊不能加人，请创建群聊");
    const ids = [...new Set((Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(Number).filter((n) => n > 0 && n !== req.user.id))];
    if (!ids.length) return fail(res, "请选择要邀请的成员");
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM chat_room_members WHERE room_id = ?", [id]);
    if (Number(n) + ids.length > MAX_GROUP_MEMBERS) return fail(res, `成员上限 ${MAX_GROUP_MEMBERS} 人`);
    const [valid] = await pool.query(
      `SELECT id FROM users WHERE status = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    let added = 0;
    for (const v of valid) {
      try {
        await pool.query("INSERT INTO chat_room_members (room_id, user_id, role, joined_time) VALUES (?, ?, 'member', ?)", [
          id,
          Number(v.id),
          now(),
        ]);
        added += 1;
      } catch (e) {
        if (e.code !== "ER_DUP_ENTRY") throw e; // 已在群里：跳过，不算失败
      }
    }
    if (added) {
      await pool.query("UPDATE chat_rooms SET member_count = member_count + ? WHERE id = ?", [added, id]);
      await systemMessage(id, `${req.user.display_name || req.user.username} 邀请了 ${added} 位成员`);
      pushMany(valid.map((v) => Number(v.id)), "invited", { room_id: id, name: room.name });
    }
    return ok(res, { added }, added ? `已邀请 ${added} 位成员` : "这些用户都已在群里");
  })
);

// 退出房间。群主退出时：还有别人就转让给最早加入的成员，只剩自己就解散
router.delete(
  "/rooms/:id/members/me",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    const [[room]] = await pool.query("SELECT * FROM chat_rooms WHERE id = ?", [id]);
    await pool.query("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?", [id, req.user.id]);
    await pool.query("UPDATE chat_rooms SET member_count = GREATEST(member_count - 1, 0) WHERE id = ?", [id]);
    const [others] = await pool.query("SELECT user_id FROM chat_room_members WHERE room_id = ? ORDER BY id ASC LIMIT 1", [id]);
    const remain = others.length ? Number(others[0].user_id) : 0;
    if (!remain) {
      await pool.query("UPDATE chat_rooms SET status = 2 WHERE id = ?", [id]);
    } else if (room?.type !== "single" && Number(room?.owner_id) === req.user.id) {
      // 群主走了必须有新群主，否则「解散群」「踢人」这类操作没人能做
      await pool.query("UPDATE chat_rooms SET owner_id = ? WHERE id = ?", [remain, id]);
      await pool.query("UPDATE chat_room_members SET role = 'owner' WHERE room_id = ? AND user_id = ?", [id, remain]);
    }
    // 单聊的「删除会话」是静默的：不给对方推「XX 退出了群聊」这种系统消息；
    // 对方再发消息或自己再点「发私信」时 openSingleRoom 会把人补回来
    if (room?.type !== "single" && remain) {
      await systemMessage(id, `${nameOf(req.user)} 退出了群聊`);
    }
    return ok(res, null, room?.type === "single" ? "已删除会话" : "已退出");
  })
);

// 移除成员（群主/管理员）
router.delete(
  "/rooms/:id/members/:userId",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const targetId = Number(req.params.userId) || 0;
    if (!id || !targetId) return fail(res, "参数不合法");
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    const isManager = m.role === "owner" || m.role === "admin" || req.user.role >= 100;
    if (!isManager) return fail(res, "需要群主或管理员权限", 403);
    if (targetId === req.user.id) return fail(res, "请用「退出房间」");
    const [[target]] = await pool.query("SELECT * FROM chat_room_members WHERE room_id = ? AND user_id = ?", [id, targetId]);
    if (!target) return fail(res, "该用户不在房间里", 404);
    // 不能踢群主（含管理员越权踢群主的情况）
    const [[room]] = await pool.query("SELECT owner_id FROM chat_rooms WHERE id = ?", [id]);
    if (Number(room?.owner_id) === targetId && m.role !== "owner" && req.user.role < 100) {
      return fail(res, "不能移除群主", 403);
    }
    await pool.query("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?", [id, targetId]);
    await pool.query("UPDATE chat_rooms SET member_count = GREATEST(member_count - 1, 0) WHERE id = ?", [id]);
    const targetUser = await userBrief(targetId);
    await systemMessage(id, `${nameOf(req.user)} 将 ${nameOf(targetUser) || "一位成员"} 移出了群聊`);
    push(targetId, "kicked", { room_id: id });
    return ok(res, null, "已移除");
  })
);

// 解散房间（群主或管理员）
router.delete(
  "/rooms/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const [[room]] = await pool.query("SELECT * FROM chat_rooms WHERE id = ?", [id]);
    if (!room) return fail(res, "房间不存在", 404);
    const isOwner = Number(room.owner_id) === req.user.id;
    if (!isOwner && req.user.role < 100) return fail(res, "需要群主或管理员权限", 403);
    await pool.query("UPDATE chat_rooms SET status = 2 WHERE id = ?", [id]);
    const ids = await memberIdsOf(id);
    pushMany(ids, "dissolved", { room_id: id });
    return ok(res, null, "已解散");
  })
);

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------
// 拉取消息：带 since_id 时只取增量（SSE 断线重连/切回标签页的场景）
router.get(
  "/rooms/:id/messages",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    const sinceId = Number(req.query.since_id) || 0;
    if (sinceId) {
      const [rows] = await pool.query(
        "SELECT * FROM chat_room_messages WHERE room_id = ? AND id > ? AND status = 1 ORDER BY id ASC LIMIT 200",
        [id, sinceId]
      );
      const users = new Map();
      const items = [];
      for (const r of rows) items.push(await messageToResp(r, users));
      return ok(res, { items, incremental: true });
    }
    const { p, size, offset } = pageParams(req.query, 50);
    const [[cnt]] = await pool.query("SELECT COUNT(*) AS n FROM chat_room_messages WHERE room_id = ? AND status = 1", [id]);
    // 倒序取最近 N 条再反转：分页时「最新的在第 1 页」符合直觉
    const [rows] = await pool.query(
      "SELECT * FROM chat_room_messages WHERE room_id = ? AND status = 1 ORDER BY id DESC LIMIT ? OFFSET ?",
      [id, size, offset]
    );
    const users = new Map();
    const items = [];
    for (const r of rows.reverse()) items.push(await messageToResp(r, users));
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size, incremental: false });
  })
);

router.post(
  "/rooms/:id/messages",
  authRequired,
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "msg-send", keyFn: (r) => r.user?.id || r.ip }),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    if (Number(m.muted)) return fail(res, "你已被禁言", 403);
    const [[room]] = await pool.query("SELECT id, type, single_key, status FROM chat_rooms WHERE id = ?", [id]);
    if (!room || Number(room.status) !== 1) return fail(res, "房间已解散", 404);
    // 单聊里对方可能「删除了会话」（退出成员表）：发消息时把他补回来，
    // 否则他永远收不到、会话列表也不会重新出现 —— 私聊不该因为一方清理列表就单向断掉
    if (room.type === "single" && room.single_key) {
      const pair = String(room.single_key).split(":").map(Number).filter(Boolean);
      if (pair.length === 2) {
        const [ins] = await pool.query(
          "INSERT IGNORE INTO chat_room_members (room_id, user_id, role, joined_time) VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)",
          [id, pair[0], now(), id, pair[1], now()]
        );
        if (ins?.affectedRows) await pool.query("UPDATE chat_rooms SET member_count = 2 WHERE id = ?", [id]);
      }
    }

    const type = String(req.body?.type || "text") === "image" ? "image" : "text";
    // 超长**报错**，不静默截断（与社区帖子/评论同一口径）。
    //
    // 黑盒测试实测（社交型人格）：「content 传 4001/5000/12000 字，
    // 全部返回 200『已发送』，但服务端存的长度一律被压到 4000」——
    // 用户粘一段长文案进去，以为发出去了，对方只收到前 4000 字，
    // 双方都不知道。社区那边做对了（「正文最长 20000 字，当前 25000 字」），
    // 这里对齐。
    const contentRaw = String(req.body?.content || "").trim();
    if (contentRaw.length > MAX_TEXT) {
      return fail(res, `消息最长 ${MAX_TEXT} 字，当前 ${contentRaw.length} 字`);
    }
    const content = contentRaw;
    // 附图必须属于发送者自己（同 community：不校验就等于把别人的私有文件
    // 变成「我发的消息里的图」，服务端会现签 URL 给所有房间成员读）
    const rawMediaIds = Array.isArray(req.body?.media_ids) ? req.body.media_ids.slice(0, MAX_MEDIA) : [];
    const { ok: mediaIds, bad: badMedia } = await filterOwnedMediaIds(rawMediaIds, req.user.id);
    if (badMedia.length) return fail(res, "图片不存在或无权使用", 403);
    if (!content && !mediaIds.length) return fail(res, "消息不能为空");
    if (type === "image" && !mediaIds.length) return fail(res, "请先上传图片");
    // 客户端临时 id：原样存库并回显，前端据此把「本地乐观插入的消息」
    // 与 SSE 广播回来的同一条对上（否则弱网下会重复插入或红点假消除）
    const clientId = String(req.body?.client_id || "").slice(0, 40);

    const r = await pool.query(
      "INSERT INTO chat_room_messages (room_id, user_id, type, content, media_ids, client_id, created_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      [id, req.user.id, type, content, JSON.stringify(mediaIds), clientId, now()]
    );
    const msgId = Number(r[0].insertId);
    const preview = content || "[图片]";
    await pool.query("UPDATE chat_rooms SET last_message_id = ?, last_message_text = ?, last_message_time = ? WHERE id = ?", [
      msgId,
      preview.slice(0, 120),
      now(),
      id,
    ]);
    // 发送者自己的已读位置也要推进，否则自己发的消息会算成「未读」
    await pool.query("UPDATE chat_room_members SET last_read_id = GREATEST(last_read_id, ?) WHERE room_id = ? AND user_id = ?", [
      msgId,
      id,
      req.user.id,
    ]);
    for (const mid of mediaIds) {
      await attachRef(mid, { userId: req.user.id, refType: "chat_room_message", refId: String(msgId), slot: `m${mid}` }).catch(() => {});
    }
    const msg = await messageToResp({
      id: msgId, room_id: id, user_id: req.user.id, type, content,
      media_ids: JSON.stringify(mediaIds), client_id: clientId, created_time: now(), status: 1,
    });
    const ids = await memberIdsOf(id);
    pushMany(ids, "message", { room_id: id, message: msg });
    return ok(res, msg, "已发送");
  })
);

// 撤回自己的消息（2 分钟内；管理员随时）
router.delete(
  "/messages/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "消息不存在", 404);
    const [[msg]] = await pool.query("SELECT * FROM chat_room_messages WHERE id = ?", [id]);
    if (!msg) return fail(res, "消息不存在", 404);
    const m = await memberOf(msg.room_id, req.user.id);
    if (!m && req.user.role < 100) return fail(res, "无权操作", 403);
    const isMine = Number(msg.user_id) === req.user.id;
    const isAdmin = req.user.role >= 100;
    if (!isMine && !isAdmin) return fail(res, "只能撤回自己的消息", 403);
    // 撤回窗口：超过 2 分钟只有管理员能撤（避免「聊完就撤」破坏对话上下文）
    if (isMine && !isAdmin && Date.now() - Number(msg.created_time) * 1000 > 2 * 60_000) {
      return fail(res, "超过 2 分钟的消息无法撤回");
    }
    await pool.query("UPDATE chat_room_messages SET status = 2, content = '' WHERE id = ?", [id]);
    const ids = await memberIdsOf(msg.room_id);
    pushMany(ids, "recalled", { room_id: Number(msg.room_id), message_id: id });
    return ok(res, null, "已撤回");
  })
);

// 标记已读：把 last_read_id 推到指定消息（默认最新）
router.post(
  "/rooms/:id/read",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m) return fail(res, "你不在这个房间里", 403);
    let target = Number(req.body?.message_id) || 0;
    if (!target) {
      const [[last]] = await pool.query("SELECT id FROM chat_room_messages WHERE room_id = ? AND status = 1 ORDER BY id DESC LIMIT 1", [id]);
      target = Number(last?.id) || 0;
    }
    // 只前进不后退：并发多标签页时旧请求后到不能把已读位置往回拖
    await pool.query(
      "UPDATE chat_room_members SET last_read_id = GREATEST(last_read_id, ?) WHERE room_id = ? AND user_id = ?",
      [target, id, req.user.id]
    );
    return ok(res, { last_read_id: target });
  })
);
router.put(
  "/rooms/:id/announcement",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m && req.user.role < 100) return fail(res, "你不在该群聊中", 403);
    if (m?.role !== "owner" && m?.role !== "admin" && req.user.role < 100) {
      return fail(res, "只有群主或管理员可以修改公告", 403);
    }

    const [[room]] = await pool.query("SELECT type, status FROM chat_rooms WHERE id = ?", [id]);
    if (!room || Number(room.status) !== 1) return fail(res, "房间不存在", 404);
    if (room.type === "single") return fail(res, "私聊没有群公告");

    const raw = String(req.body?.announcement || "").trim();
    if (raw.length > 500) return fail(res, `公告最长 500 字，当前 ${raw.length} 字`);
    const announcement = raw;
    await pool.query("UPDATE chat_rooms SET announcement = ? WHERE id = ?", [announcement, id]);

    // 写一条系统公告更新消息并推送
    await systemMessage(id, announcement ? `${nameOf(req.user)} 更新了群公告` : `${nameOf(req.user)} 清空了群公告`);
    const ids = await memberIdsOf(id);
    pushMany(ids, "room_updated", { room_id: id, announcement });

    return ok(res, { id, announcement }, "公告已更新");
  })
);

router.put(
  "/rooms/:id/name",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "房间不存在", 404);
    const m = await memberOf(id, req.user.id);
    if (!m && req.user.role < 100) return fail(res, "你不在该群聊中", 403);
    if (m?.role !== "owner" && m?.role !== "admin" && req.user.role < 100) {
      return fail(res, "只有群主或管理员可以修改名称", 403);
    }

    const [[room]] = await pool.query("SELECT type, status FROM chat_rooms WHERE id = ?", [id]);
    if (!room || Number(room.status) !== 1) return fail(res, "房间不存在", 404);
    if (room.type === "single") return fail(res, "私聊不能改名");

    const name = String(req.body?.name || "").trim().slice(0, 64);
    if (!name) return fail(res, "请输入名称");

    await pool.query("UPDATE chat_rooms SET name = ? WHERE id = ?", [name, id]);
    await systemMessage(id, `${req.user.display_name || req.user.username} 修改了群名称为「${name}」`);
    const ids = await memberIdsOf(id);
    pushMany(ids, "room_updated", { room_id: id, name });

    return ok(res, { id, name }, "名称已修改");
  })
);

export default router;
