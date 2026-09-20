// 个人主页（公开资料 + 历史与统计）
// ---------------------------------------------------------------------------
// 公开与私有的边界（这是本文件最需要守住的东西）：
//
//   任何人都能看（含未登录）：昵称、头像、简介、所在地、链接、加入时间、
//     发帖数、获赞数、粉丝/关注数 —— 这些是用户主动填的展示性资料。
//   只有本人与管理员能看：邮箱、余额、调用量、消费额、令牌、IP、设备。
//
// 为什么单独开 /api/profile 而不是复用 /api/user：后者每个端点都要求登录，
// 而个人主页必须**匿名可访问**（社区里分享主页链接是基本能力）。
// 但要注意：匿名可达的端点绝不能带出任何账号信息 —— 一次疏忽就是数据泄露。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, pageParams, safeJSONParse } from "../utils.js";
import { authRequired, optionalAuth } from "../middleware/auth.js";
import { mediaUrl } from "../services/media.js";

const router = Router();

/** 对外的公开资料：只包含用户主动填的展示字段 */
function publicProfile(u, extra = {}) {
  return {
    id: Number(u.id),
    username: u.username,
    display_name: u.display_name || u.username,
    avatar_url: Number(u.avatar_media_id) ? `/api/media/avatar/${u.id}?v=${u.avatar_media_id}` : "",
    bio: u.bio || "",
    website: u.website || "",
    location: u.location || "",
    // 角色影响社区里的身份标识（作者/管理员），是公开展示的一部分
    role: Number(u.role),
    created_time: Number(u.created_time),
    ...extra,
  };
}

/** 用户的社区与用量统计。用量部分只看自己/管理员（公开主页不返回）。 */
async function statsOf(userId, { withUsage = false } = {}) {
  const [[posts]] = await pool.query(
    "SELECT COUNT(*) AS n, COALESCE(SUM(like_count),0) AS likes, COALESCE(SUM(view_count),0) AS views FROM community_posts WHERE user_id = ? AND status <> 2",
    [userId]
  );
  const [[comments]] = await pool.query("SELECT COUNT(*) AS n FROM community_comments WHERE user_id = ? AND status <> 2", [userId]);
  const [[follow]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM community_follows WHERE follower_id = ?) AS following,
            (SELECT COUNT(*) FROM community_follows WHERE followee_id = ?) AS followers`,
    [userId, userId]
  );
  const [[favs]] = await pool.query(
    "SELECT COUNT(*) AS n FROM community_reactions WHERE user_id = ? AND kind = 'favorite' AND target_type = 'post'",
    [userId]
  );
  const [[{ best_game }]] = await pool.query(
    "SELECT COUNT(*) AS best_game FROM game_records WHERE user_id = ?",
    [userId]
  );
  const out = {
    posts: Number(posts.n) || 0,
    likes_received: Number(posts.likes) || 0,
    views_received: Number(posts.views) || 0,
    comments: Number(comments.n) || 0,
    following: Number(follow.following) || 0,
    followers: Number(follow.followers) || 0,
    favorites: Number(favs.n) || 0,
    game_plays: Number(best_game) || 0,
  };
  if (withUsage) {
    // 用量数据只给本人与管理员：它是账号信息，不是公开资料
    const [[u]] = await pool.query("SELECT quota, used_quota, request_count, created_time, last_login_time FROM users WHERE id = ?", [userId]);
    out.usage = {
      quota: Number(u?.quota) || 0,
      used_quota: Number(u?.used_quota) || 0,
      request_count: Number(u?.request_count) || 0,
      last_login_time: Number(u?.last_login_time) || 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 公开主页（匿名可达）
// ---------------------------------------------------------------------------
router.get(
  "/u/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.id) || 0;
    if (!uid) return fail(res, "用户不存在", 404);
    const [[u]] = await pool.query("SELECT * FROM users WHERE id = ?", [uid]);
    // 被禁用/无此用户一律 404：不区分「不存在」与「被禁用」，避免探测账号是否存在
    if (!u || Number(u.status) !== 1) return fail(res, "用户不存在", 404);

    const viewer = req.user || null;
    const isSelf = viewer && Number(viewer.id) === uid;
    const isAdmin = viewer && viewer.role >= 100;
    // 用量只在「本人或管理员」时返回（含余额，绝不能出现在公开响应里）
    const stats = await statsOf(uid, { withUsage: Boolean(isSelf || isAdmin) });

    // 关注状态与关注按钮：匿名访客没有关注状态，但仍要能看主页
    let following = false;
    if (viewer && !isSelf) {
      const [[f]] = await pool.query("SELECT id FROM community_follows WHERE follower_id = ? AND followee_id = ?", [
        viewer.id,
        uid,
      ]);
      following = Boolean(f);
    }
    // 最近动态：只取公开可见的帖子；匿名访客看到的是公开主页，不该看到隐藏帖
    const [recent] = await pool.query(
      `SELECT p.id, p.title, p.content, p.like_count, p.comment_count, p.view_count, p.created_time, p.topic_id,
              t.name AS topic_name, p.media_ids
         FROM community_posts p LEFT JOIN community_topics t ON t.id = p.topic_id
        WHERE p.user_id = ? AND p.status = 1
        ORDER BY p.id DESC LIMIT 10`,
      [uid]
    );
    const recentPosts = [];
    for (const r of recent) {
      const ids = safeJSONParse(r.media_ids, []) || [];
      const first = Array.isArray(ids) && ids.length ? Number(ids[0]) : 0;
      recentPosts.push({
        id: Number(r.id),
        title: r.title,
        summary: String(r.content || "").slice(0, 120),
        cover: first ? await mediaUrl(first) : "",
        topic_id: Number(r.topic_id) || 0,
        topic: r.topic_name || "",
        like_count: Number(r.like_count) || 0,
        comment_count: Number(r.comment_count) || 0,
        view_count: Number(r.view_count) || 0,
        created_time: Number(r.created_time),
      });
    }
    return ok(res, {
      ...publicProfile(u, { is_self: Boolean(isSelf), is_admin_view: Boolean(isAdmin) }),
      stats,
      following,
      recent_posts: recentPosts,
      // 私有字段**显式置空**而不是省略：前端拿不到就知道不该渲染，
      // 也避免「字段消失」被误解成接口坏了
      email: isSelf || isAdmin ? u.email : "",
      phone: "",
    });
  })
);

// 我的主页（快捷入口，等价于 /u/<self>）
router.get(
  "/me",
  authRequired,
  asyncHandler(async (req, res) => {
    const u = req.user;
    const stats = await statsOf(u.id, { withUsage: true });
    const [recent] = await pool.query(
      `SELECT p.id, p.title, p.content, p.like_count, p.comment_count, p.view_count, p.created_time, t.name AS topic_name
         FROM community_posts p LEFT JOIN community_topics t ON t.id = p.topic_id
        WHERE p.user_id = ? AND p.status <> 2 ORDER BY p.id DESC LIMIT 10`,
      [u.id]
    );
    return ok(res, {
      ...publicProfile(u, { is_self: true, is_admin_view: req.user.role >= 100 }),
      stats,
      email: u.email,
      recent_posts: recent.map((r) => ({
        id: Number(r.id),
        title: r.title,
        summary: String(r.content || "").slice(0, 120),
        topic: r.topic_name || "",
        like_count: Number(r.like_count) || 0,
        comment_count: Number(r.comment_count) || 0,
        view_count: Number(r.view_count) || 0,
        created_time: Number(r.created_time),
        status: 1,
      })),
    });
  })
);

// 某人的帖子 / 评论 / 收藏（个人主页的 tab 数据源）
router.get(
  "/u/:id/posts",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.id) || 0;
    if (!uid) return fail(res, "用户不存在", 404);
    const { p, size, offset } = pageParams(req.query, 20);
    const viewer = req.user || null;
    // 只有本人与管理员能看到非公开帖（隐藏/已删）
    const canSeeAll = viewer && (Number(viewer.id) === uid || viewer.role >= 100);
    const clause = canSeeAll ? "p.user_id = ? AND p.status <> 2" : "p.user_id = ? AND p.status = 1";
    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM community_posts p WHERE ${clause}`, [uid]);
    const [rows] = await pool.query(
      `SELECT p.id, p.title, p.content, p.like_count, p.comment_count, p.view_count, p.status, p.created_time,
              t.name AS topic_name
         FROM community_posts p LEFT JOIN community_topics t ON t.id = p.topic_id
        WHERE ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [uid, size, offset]
    );
    return ok(res, {
      items: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        summary: String(r.content || "").slice(0, 160),
        topic: r.topic_name || "",
        like_count: Number(r.like_count) || 0,
        comment_count: Number(r.comment_count) || 0,
        view_count: Number(r.view_count) || 0,
        status: Number(r.status),
        created_time: Number(r.created_time),
      })),
      total: Number(cnt.n) || 0,
      page: p,
      page_size: size,
    });
  })
);

// 关注列表 / 粉丝列表
router.get(
  "/u/:id/follows",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const uid = Number(req.params.id) || 0;
    if (!uid) return fail(res, "用户不存在", 404);
    const kind = String(req.query.kind || "following") === "followers" ? "followers" : "following";
    const { p, size, offset } = pageParams(req.query, 30);
    const sql =
      kind === "following"
        ? `SELECT u.id, u.username, u.display_name, u.avatar_media_id, u.bio, f.created_time
             FROM community_follows f JOIN users u ON u.id = f.followee_id
            WHERE f.follower_id = ? AND u.status = 1 ORDER BY f.id DESC LIMIT ? OFFSET ?`
        : `SELECT u.id, u.username, u.display_name, u.avatar_media_id, u.bio, f.created_time
             FROM community_follows f JOIN users u ON u.id = f.follower_id
            WHERE f.followee_id = ? AND u.status = 1 ORDER BY f.id DESC LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(sql, [uid, size, offset]);
    const [[cnt]] = await pool.query(
      kind === "following"
        ? "SELECT COUNT(*) AS n FROM community_follows WHERE follower_id = ?"
        : "SELECT COUNT(*) AS n FROM community_follows WHERE followee_id = ?",
      [uid]
    );
    // 每个用户是否已被当前访客关注（前端显示「已关注」按钮状态）
    let followedIds = new Set();
    if (req.user && rows.length) {
      const ids = rows.map((r) => Number(r.id));
      const [fs] = await pool.query(
        `SELECT followee_id FROM community_follows WHERE follower_id = ? AND followee_id IN (${ids.map(() => "?").join(",")})`,
        [req.user.id, ...ids]
      );
      followedIds = new Set(fs.map((r) => Number(r.followee_id)));
    }
    return ok(res, {
      items: rows.map((r) => ({
        id: Number(r.id),
        username: r.username,
        display_name: r.display_name || r.username,
        avatar_url: Number(r.avatar_media_id) ? `/api/media/avatar/${r.id}?v=${r.avatar_media_id}` : "",
        bio: r.bio || "",
        followed: followedIds.has(Number(r.id)),
      })),
      total: Number(cnt.n) || 0,
      page: p,
      page_size: size,
      kind,
    });
  })
);

export default router;
