// 聊天房间的共用逻辑（routes/chatroom.js 与 routes/friends.js 共用）
// ---------------------------------------------------------------------------
// 为什么单独抽出来：「打开与某人的单聊」原先在两个路由里各写了一份，
// 两份都只查 `status = 1` 的房间 —— 于是有两个真实的坑：
//   ① 一方「退出」单聊后房间仍是 status=1，但他已不是成员；再点「发私信」
//      拿到的是这个旧房间 id，进去就 403「你不在这个房间里」；
//   ② 双方都退出后房间被置为 status=2，而 single_key 唯一键还占着 ——
//      再建同一对用户的单聊 INSERT 撞 ER_DUP_ENTRY，直接 500。
// 这里统一成：按 single_key 找（不管状态），找到就「复活 + 补回双方成员」，
// 找不到才新建；新建撞唯一键（并发双击）时回退到复活分支。
import { pool } from "../db.js";
import { now } from "../utils.js";

/** 单聊唯一键：两个用户 id 升序拼接（谁先发起都指向同一个房间） */
export function singleKey(a, b) {
  const [x, y] = [Number(a) || 0, Number(b) || 0].sort((m, n) => m - n);
  return `${x}:${y}`;
}

export function avatarUrlOf(u) {
  return Number(u?.avatar_media_id) ? `/api/media/avatar/${u.id}?v=${u.avatar_media_id}` : "";
}

/** 把房间恢复为可用，并确保两人都在成员表里（幂等） */
async function reviveSingle(roomId, a, b) {
  await pool.query("UPDATE chat_rooms SET status = 1 WHERE id = ?", [roomId]);
  await pool.query(
    "INSERT IGNORE INTO chat_room_members (room_id, user_id, role, joined_time) VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)",
    [roomId, a, now(), roomId, b, now()]
  );
  // member_count 是冗余字段：补成员后按真值回写，避免退出/复活反复后漂移
  await pool.query(
    "UPDATE chat_rooms SET member_count = (SELECT COUNT(*) FROM chat_room_members WHERE room_id = ?) WHERE id = ?",
    [roomId, roomId]
  );
}

/**
 * 打开（必要时创建）两人之间的单聊房间。
 * 调用方负责校验 peerId 是有效账号、且不是自己。
 * @returns {Promise<{ id: number, existed: boolean }>}
 */
export async function openSingleRoom(userId, peerId) {
  const key = singleKey(userId, peerId);
  const [[exist]] = await pool.query("SELECT id FROM chat_rooms WHERE single_key = ? LIMIT 1", [key]);
  if (exist) {
    await reviveSingle(Number(exist.id), userId, peerId);
    return { id: Number(exist.id), existed: true };
  }
  try {
    const r = await pool.query(
      "INSERT INTO chat_rooms (type, name, owner_id, member_count, single_key, status, created_time) VALUES ('single', '', ?, 2, ?, 1, ?)",
      [userId, key, now()]
    );
    const roomId = Number(r[0].insertId);
    await pool.query(
      "INSERT INTO chat_room_members (room_id, user_id, role, joined_time) VALUES (?, ?, 'member', ?), (?, ?, 'member', ?)",
      [roomId, userId, now(), roomId, peerId, now()]
    );
    return { id: roomId, existed: false };
  } catch (e) {
    if (e?.code !== "ER_DUP_ENTRY") throw e;
    // 并发双击：另一个请求刚建好，走复活分支拿它
    const [[again]] = await pool.query("SELECT id FROM chat_rooms WHERE single_key = ? LIMIT 1", [key]);
    if (!again) throw e;
    await reviveSingle(Number(again.id), userId, peerId);
    return { id: Number(again.id), existed: true };
  }
}

/**
 * 某用户的「社交圈」：好友 + 有单聊房间的人。
 * 在线状态只对这个范围可见 —— 不做全站广播，否则任何登录用户都能枚举谁在线。
 */
export async function contactIdsOf(userId) {
  const [rows] = await pool.query(
    `SELECT friend_id AS uid FROM friendships WHERE user_id = ? AND status = 1
     UNION
     SELECT m2.user_id AS uid FROM chat_room_members m1
       JOIN chat_rooms r ON r.id = m1.room_id AND r.type = 'single'
       JOIN chat_room_members m2 ON m2.room_id = m1.room_id AND m2.user_id <> ?
      WHERE m1.user_id = ?`,
    [userId, userId, userId]
  );
  return rows.map((r) => Number(r.uid)).filter(Boolean);
}
