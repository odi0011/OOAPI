// 通知中心：社区互动提醒（评论/回复/点赞/收藏/关注）
// ===========================================================================
// 为什么单独一个模块而不是塞进 community.js：
//   通知是**跨模块的能力** —— 社区会用到，将来公告/系统消息/私聊提醒也会用。
//   做成独立服务后，发出方只需 `notify(...)`，不必关心存储与推送细节。
//
// 三条设计要点：
//   ① **不给自己发通知**：自己评论自己的帖子、自己给自己点赞，不发 ——
//      否则通知列表会被自己的操作刷屏（最容易被忽略但最影响体验的一条）。
//   ② **推送走 SSE，落库为真相**：SSE 只是「现在有人在看」的加速通道，
//      未读数与列表都以数据库为准。连接断了也不会丢通知。
//   ③ **条数上限 + 定时清理**：通知只增不删同样会无限增长，
//      这里按用户保留最近 N 条（超出的删最旧），并定期清掉 90 天前的。
import { pool } from "../db.js";
import { now, pageParams } from "../utils.js";
import { push } from "./realtime.js";

/** 每种通知的展示文案（集中在此，避免散落在各处拼字符串导致风格不一） */
const TYPE_TEXT = {
  post_comment: "评论了你的帖子",
  comment_reply: "回复了你的评论",
  post_like: "点赞了你的帖子",
  comment_like: "点赞了你的评论",
  post_favorite: "收藏了你的帖子",
  follow: "关注了你",
  // 正文里 @某人（黑盒测试发现原先只有「点回复」才会 @，手打 @ 完全无效）
  mention: "在评论里提到了你",
  // 好友申请（人格实测报的缺口：原先只有 SSE 实时推送，**不落库**，
  // 于是对方不在线就永远不知道自己被加了 —— 「不是我主动去翻那个五步路径，
  // 永远不知道有人加我」）。SSE 与落库通知是两回事：前者只管当下在线的人，
  // 后者才是「离线也能看到」。
  friend_request: "申请加你为好友",
  friend_accept: "同意了你的好友申请",
};

/** 每个用户保留的通知条数上限（超出的删最旧） */
const KEEP_PER_USER = 200;

/**
 * 发一条通知。
 *
 * @param {object} o
 * @param {number} o.userId 接收者
 * @param {number} o.actorId 触发者（自己触发自己时不发）
 * @param {string} o.type TYPE_TEXT 的键
 * @param {object} [o.target] 关联对象 { postId, commentId, postTitle }
 * @returns {Promise<boolean>} 是否真的发出（false = 自触发或参数不足）
 */
export async function notify({ userId, actorId, type, target = {} }) {
  const to = Number(userId) || 0;
  const from = Number(actorId) || 0;
  if (!to || !from || to === from) return false; // ① 不给自己发
  if (!TYPE_TEXT[type]) return false;

  try {
    const r = await pool.query(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, extra, is_read, created_time)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [to, from, type, Number(target.postId) || 0, Number(target.commentId) || 0, String(target.postTitle || "").slice(0, 120), now()]
    );
    const id = Number(r[0].insertId);

    // 超上限就删最旧的：不做的话单用户通知表可以无限增长
    await pool
      .query(
        `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
           SELECT id FROM (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?) t
         )`,
        [to, to, KEEP_PER_USER]
      )
      .catch(() => {});

    // 查触发者名字用于即时推送的展示（拿不到就只推 id，前端会再拉列表）
    const [[actor]] = await pool.query("SELECT username, display_name, avatar_media_id FROM users WHERE id = ?", [from]);
    push(to, "notification", {
      id,
      type,
      text: TYPE_TEXT[type],
      actor: actor
        ? {
            id: from,
            username: actor.username,
            display_name: actor.display_name,
            avatar_url: Number(actor.avatar_media_id) ? `/api/media/avatar/${from}?v=${actor.avatar_media_id}` : "",
          }
        : { id: from },
      post_id: Number(target.postId) || 0,
      post_title: String(target.postTitle || "").slice(0, 120),
      created_time: now(),
    });
    return true;
  } catch (e) {
    // 通知失败绝不能影响主流程（评论/点赞该成功还是要成功）
    console.warn(`[notify] 写入通知失败：${e.message}`);
    return false;
  }
}

/** 未读数（导航栏红点用） */
export async function unreadCount(userId) {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0", [userId]);
  return Number(row.n) || 0;
}

/** 列表（分页） */
export async function list(userId, query = {}) {
  const { p, size, offset } = pageParams(query, 30);
  // 过滤条件要**真的生效**。
  //
  // 原实现只读了 `unread`，`type` 被静默忽略 —— 人格实测原话：
  // 「筛选参数是假的：带 ?type=friend、?type=system 等任意值，返回的都是同一批数据，
  //   服务端完全忽略该参数。」调用方会以为筛过了、实际拿到全量，属于误导。
  //
  // type 支持逗号分隔多值（前端可一次选多类）。只接受**已知类型**：
  // 未知值当作「不过滤」而不是「查不到」—— 后者会让前端一个拼写错就显示空列表，
  // 更难排查。已知类型从 TYPE_TEXT 的键推导，将来新增通知类型自动生效。
  const conds = ["n.user_id = ?"];
  const args = [userId];
  if (String(query.unread || "") === "1") conds.push("n.is_read = 0");
  const knownTypes = Object.keys(TYPE_TEXT);
  const wantTypes = String(query.type || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => knownTypes.includes(s));
  if (wantTypes.length) {
    conds.push(`n.type IN (${wantTypes.map(() => "?").join(",")})`);
    args.push(...wantTypes);
  }
  const where = conds.join(" AND ");
  const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where}`, args);
  const [rows] = await pool.query(
    `SELECT n.*, u.username, u.display_name, u.avatar_media_id, p.title AS post_title_now
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN community_posts p ON p.id = n.post_id
      WHERE ${where}
      ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    [...args, size, offset]
  );
  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      type: r.type,
      text: TYPE_TEXT[r.type] || "有新动态",
      actor: {
        id: Number(r.actor_id) || 0,
        username: r.username || "",
        display_name: r.display_name || r.username || "",
        avatar_url: Number(r.avatar_media_id) ? `/api/media/avatar/${r.actor_id}?v=${r.avatar_media_id}` : "",
      },
      post_id: Number(r.post_id) || 0,
      comment_id: Number(r.comment_id) || 0,
      // 帖子可能已被删除：优先用当时的标题（extra），取不到再回退当前标题
      post_title: r.post_title_now || r.extra || "",
      is_read: Number(r.is_read) || 0,
      created_time: Number(r.created_time),
    })),
    total: Number(cnt.n) || 0,
    page: p,
    page_size: size,
  };
}

/** 标记已读（不传 id 则全部已读） */
export async function markRead(userId, ids) {
  const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
  if (!list.length) {
    const [r] = await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [userId]);
    return r.affectedRows || 0;
  }
  const [r] = await pool.query(
    `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${list.map(() => "?").join(",")})`,
    [userId, ...list]
  );
  return r.affectedRows || 0;
}

/** 删除一条（用户清理自己的列表） */
export async function remove(userId, id) {
  const [r] = await pool.query("DELETE FROM notifications WHERE user_id = ? AND id = ?", [userId, Number(id) || 0]);
  return Boolean(r.affectedRows);
}

/** 定时清理：90 天前的通知（已读的 30 天即可） */
export function scheduleNotificationCleanup() {
  const run = async () => {
    try {
      const [r1] = await pool.query("DELETE FROM notifications WHERE is_read = 1 AND created_time < UNIX_TIMESTAMP() - 30*86400 LIMIT 1000");
      const [r2] = await pool.query("DELETE FROM notifications WHERE is_read = 0 AND created_time < UNIX_TIMESTAMP() - 90*86400 LIMIT 1000");
      if (r1.affectedRows || r2.affectedRows) {
        console.log(`[notify] 清理通知：已读 ${r1.affectedRows} 条、未读过期 ${r2.affectedRows} 条`);
      }
    } catch (e) {
      console.error("[notify] 通知清理失败：", e.message);
    }
  };
  setTimeout(run, 12 * 60 * 1000).unref?.();
  setInterval(run, 24 * 3600 * 1000).unref?.();
}
