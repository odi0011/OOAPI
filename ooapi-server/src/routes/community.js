// 社区大厅：话题 / 帖子 / 评论 / 点赞收藏 / 关注
// ---------------------------------------------------------------------------
// 设计要点（改动前先看）：
//
// ① **计数是冗余字段**，用「单条 UPDATE ... SET x = x + 1」维护，不走 SELECT COUNT。
//    社区列表页要按热度排序并显示计数，对每个帖子查一次子表会随帖子数线性变慢。
//    代价是可能出现计数漂移（极端并发/异常中断），所以提供 body 里的重算接口
//    （`POST /admin/recount`），而不是假设它永远准确。
//
// ② **点赞/收藏靠唯一键去重**，不是先查再插。并发双击时「查了没有 → 插入」
//    两条都可能通过检查，唯一键是唯一可靠的防线；重复插入触发 ER_DUP_ENTRY
//    就当成「已经赞过」正常返回，而不是 500。
//
// ③ **可见性只有一条规则**：status=1 正常、3 隐藏（管理员可见，作者可见自己的）、
//    2 已删（仅管理员可见）。普通用户永远看不到别人的非正常内容。
//
// ④ 内容长度与频率都有限制：帖子正文 20000 字、评论 2000 字，
//    发帖/评论/点赞按用户维度限流 —— 社区是最容易被脚本刷的入口。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, pageParams, idParam, safeJSONParse, safeInt } from "../utils.js";
import { authRequired, adminRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { mediaUrl, attachRef, releaseRefs, filterOwnedMediaIds } from "../services/media.js";
import { notify, unreadCount, list as listNotifications, markRead, remove as removeNotification } from "../services/notify-center.js";

const router = Router();

const MAX_TITLE = 120;
const MAX_CONTENT = 20000;
const MAX_COMMENT = 2000;
const MAX_MEDIA = 9;

/**
 * 长度校验：超限**报错**，不静默截断。
 *
 * 黑盒测试实测（原话）：「标题塞 1502 字 → 接口 200『发布成功』，落库只剩 120 字」。
 * 前端输入框有 maxLength 挡着，但直连 API / 第三方客户端的内容会被**悄悄吃掉**
 * 且返回成功 —— 用户以为发出去了 1502 字，实际只有 120 字，且没有任何提示。
 * 内容类接口截断比报错更糟（用户不会知道要重发），所以宁可拒绝。
 */
function tooLong(value, max, label) {
  const s = String(value ?? "");
  if (s.length <= max) return null;
  return `${label}最长 ${max} 字，当前 ${s.length} 字`;
}

/** 帖子/评论的可见性条件：普通用户只看 status=1 与自己的内容 */
function visibilityClause(user, alias = "p") {
  if (user && user.role >= 100) return { sql: "", args: [] };
  if (user) return { sql: `AND (${alias}.status = 1 OR ${alias}.user_id = ?)`, args: [user.id] };
  return { sql: `AND ${alias}.status = 1`, args: [] };
}

/** 媒体 id 列表 → 含签名 URL 的附件数组（列表页与详情页共用） */
async function mediaList(raw) {
  const ids = safeJSONParse(raw, []) || [];
  const out = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, MAX_MEDIA) : []) {
    const mid = Number(id) || 0;
    if (!mid) continue;
    out.push({ id: mid, url: await mediaUrl(mid) });
  }
  return out;
}

/** 帖子行 → 响应体（含作者信息与附件） */
async function postToResp(row, { withContent = true, authors = null } = {}) {
  const a = authors?.get(Number(row.user_id)) || null;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    author: a
      ? { id: a.id, username: a.username, display_name: a.display_name, avatar_url: a.avatar_url, role: a.role }
      : { id: Number(row.user_id), username: "", display_name: "", avatar_url: "" },
    topic_id: Number(row.topic_id) || 0,
    topic: row.topic_name || "",
    title: row.title,
    content: withContent ? row.content : undefined,
    summary: withContent ? undefined : String(row.content || "").slice(0, 160),
    media: await mediaList(row.media_ids),
    like_count: Number(row.like_count) || 0,
    comment_count: Number(row.comment_count) || 0,
    favorite_count: Number(row.favorite_count) || 0,
    view_count: Number(row.view_count) || 0,
    is_pinned: Number(row.is_pinned) || 0,
    status: Number(row.status),
    created_time: Number(row.created_time),
    updated_time: Number(row.updated_time) || Number(row.created_time),
  };
}

/** 批量取作者信息：列表页一次性 IN 查询，避免逐行查用户表 */
async function authorsOf(rows) {
  const ids = [...new Set(rows.map((r) => Number(r.user_id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const [users] = await pool.query(
    `SELECT id, username, display_name, role, avatar_media_id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  return new Map(
    users.map((u) => [
      Number(u.id),
      {
        id: Number(u.id),
        username: u.username,
        display_name: u.display_name,
        role: Number(u.role),
        avatar_url: Number(u.avatar_media_id) ? `/api/media/avatar/${u.id}?v=${u.avatar_media_id}` : "",
      },
    ])
  );
}

/** 当前用户对这些帖子的点赞/收藏状态（用于列表回显「已赞」） */
async function myReactions(userId, postIds) {
  if (!userId || !postIds.length) return { likes: new Set(), favorites: new Set() };
  const [rows] = await pool.query(
    `SELECT target_id, kind FROM community_reactions
      WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => "?").join(",")})`,
    [userId, ...postIds]
  );
  const likes = new Set();
  const favorites = new Set();
  for (const r of rows) (r.kind === "like" ? likes : favorites).add(Number(r.target_id));
  return { likes, favorites };
}

// ---------------------------------------------------------------------------
// 话题
// ---------------------------------------------------------------------------
router.get(
  "/topics",
  authRequired,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      "SELECT id, name, description, icon, post_count, sort, status FROM community_topics WHERE status = 1 ORDER BY sort DESC, id ASC"
    );
    return ok(res, rows.map((r) => ({
      id: Number(r.id), name: r.name, description: r.description, icon: r.icon,
      post_count: Number(r.post_count) || 0, sort: Number(r.sort) || 0,
    })));
  })
);

// 话题管理（管理员）：新建/改名/停用
router.post(
  "/topics",
  adminRequired,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 40);
    if (!name) return fail(res, "请输入话题名称");
    const description = String(req.body?.description || "").trim().slice(0, 160);
    const icon = String(req.body?.icon || "").trim().slice(0, 16);
    const sort = Number(req.body?.sort) || 0;
    try {
      const r = await pool.query(
        "INSERT INTO community_topics (name, description, icon, sort, status, created_time) VALUES (?, ?, ?, ?, 1, ?)",
        [name, description, icon, sort, now()]
      );
      return ok(res, { id: Number(r[0].insertId) }, "话题已创建");
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") return fail(res, "该话题名称已存在");
      throw e;
    }
  })
);

router.put(
  "/topics/:id",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "话题不存在", 404);
    const sets = [];
    const args = [];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 40);
      if (!name) return fail(res, "话题名称不能为空");
      sets.push("name = ?");
      args.push(name);
    }
    if (req.body?.description !== undefined) {
      sets.push("description = ?");
      args.push(String(req.body.description).trim().slice(0, 160));
    }
    if (req.body?.icon !== undefined) {
      sets.push("icon = ?");
      args.push(String(req.body.icon).trim().slice(0, 16));
    }
    if (req.body?.sort !== undefined) {
      sets.push("sort = ?");
      args.push(Number(req.body.sort) || 0);
    }
    if (req.body?.status !== undefined) {
      sets.push("status = ?");
      args.push(Number(req.body.status) === 2 ? 2 : 1);
    }
    if (!sets.length) return fail(res, "没有需要更新的字段");
    args.push(id);
    try {
      await pool.query(`UPDATE community_topics SET ${sets.join(", ")} WHERE id = ?`, args);
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") return fail(res, "该话题名称已存在");
      throw e;
    }
    return ok(res, null, "已更新");
  })
);

// ---------------------------------------------------------------------------
// 帖子
// ---------------------------------------------------------------------------
// 列表：支持 话题筛选 / 只看关注 / 只看自己 / 关键词 / 排序（最新·最热）
router.get(
  "/posts",
  authRequired,
  asyncHandler(async (req, res) => {
    const { p, size, offset } = pageParams(req.query, 20);
    const isAdmin = req.user.role >= 100;
    const where = ["1=1"];
    const args = [];
    // 管理员可以显式指定 status 查看隐藏/已删内容（审核用）；
    // 普通用户一律走可见性规则，传了 status 也只当筛选自己的可见内容。
    const explicitStatus = isAdmin && req.query.status !== undefined ? Number(req.query.status) : null;
    if (isAdmin && [1, 2, 3].includes(explicitStatus)) {
      where.push("p.status = ?");
      args.push(explicitStatus);
    } else {
      const vis = visibilityClause(req.user, "p");
      if (vis.sql) {
        where.push(vis.sql.replace(/^AND /, ""));
        args.push(...vis.args);
      }
    }
    // ?topic_id=Infinity 这类输入要挡住：`Number("Infinity") || 0` 仍然是 Infinity，
    // 进 SQL 会被 mysql2 转义成字面量 → 语法错误 → 500（而不是干净的 400/空结果）
    if (req.query.topic_id) {
      where.push("p.topic_id = ?");
      args.push(safeInt(req.query.topic_id, { min: 1 }) ?? 0);
    }
    if (req.query.user_id) {
      where.push("p.user_id = ?");
      args.push(safeInt(req.query.user_id, { min: 1 }) ?? 0);
    }
    if (String(req.query.q || "").trim()) {
      const kw = `%${String(req.query.q).trim().slice(0, 64)}%`;
      where.push("(p.title LIKE ? OR p.content LIKE ?)");
      args.push(kw, kw);
    }
    // 只看关注：子查询命中即显示（社区的核心信息流形态）
    if (String(req.query.following || "") === "1") {
      where.push("p.user_id IN (SELECT followee_id FROM community_follows WHERE follower_id = ?)");
      args.push(req.user.id);
    }
    // 只看收藏
    if (String(req.query.favorited || "") === "1") {
      where.push(
        "p.id IN (SELECT target_id FROM community_reactions WHERE user_id = ? AND target_type = 'post' AND kind = 'favorite')"
      );
      args.push(req.user.id);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    // 排序白名单：拼接 SQL 前必须先过白名单（用户可控值不进 ORDER BY）
    const sort = String(req.query.sort || "");
    const order = sort === "hot" ? "p.is_pinned DESC, p.like_count DESC, p.comment_count DESC, p.id DESC" : "p.is_pinned DESC, p.id DESC";

    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM community_posts p ${clause}`, args);
    const [rows] = await pool.query(
      `SELECT p.*, t.name AS topic_name FROM community_posts p
         LEFT JOIN community_topics t ON t.id = p.topic_id
        ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, size, offset]
    );
    const authors = await authorsOf(rows);
    const ids = rows.map((r) => Number(r.id));
    const mine = await myReactions(req.user.id, ids);
    const items = [];
    for (const r of rows) {
      const item = await postToResp(r, { withContent: false, authors });
      item.liked = mine.likes.has(Number(r.id));
      item.favorited = mine.favorites.has(Number(r.id));
      items.push(item);
    }
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size });
  })
);

// 详情：浏览量 +1（同一次请求内不重复计）
router.get(
  "/posts/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "帖子不存在", 404);
    const [[row]] = await pool.query(
      `SELECT p.*, t.name AS topic_name FROM community_posts p
         LEFT JOIN community_topics t ON t.id = p.topic_id WHERE p.id = ?`,
      [id]
    );
    if (!row) return fail(res, "帖子不存在", 404);
    const isOwner = Number(row.user_id) === req.user.id;
    if (Number(row.status) !== 1 && req.user.role < 100 && !isOwner) return fail(res, "帖子不存在", 404);
    await pool.query("UPDATE community_posts SET view_count = view_count + 1 WHERE id = ?", [id]);
    const authors = await authorsOf([row]);
    const item = await postToResp({ ...row, view_count: Number(row.view_count) + 1 }, { authors });
    const mine = await myReactions(req.user.id, [id]);
    item.liked = mine.likes.has(id);
    item.favorited = mine.favorites.has(id);
    // 关注状态：详情页要显示「已关注/关注」
    const [[f]] = await pool.query(
      "SELECT id FROM community_follows WHERE follower_id = ? AND followee_id = ?",
      [req.user.id, row.user_id]
    );
    item.author_followed = Boolean(f);
    return ok(res, item);
  })
);

router.post(
  "/posts",
  rateLimit({ windowMs: 60_000, max: 8, keyPrefix: "post-create", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const titleRaw = String(req.body?.title || "").trim();
    const contentRaw = String(req.body?.content || "").trim();
    const lenErr = tooLong(titleRaw, MAX_TITLE, "标题") || tooLong(contentRaw, MAX_CONTENT, "正文");
    if (lenErr) return fail(res, lenErr, 400);
    const title = titleRaw;
    const content = contentRaw;
    const topicId = Number(req.body?.topic_id) || 0;
    // 附图必须**属于发帖人自己**（见 filterOwnedMediaIds 的注释：不校验会让
    // 任意用户把别人的私有文件挂到自己帖子上，详情返回现签 URL，匿名可读）
    const rawMediaIds = Array.isArray(req.body?.media_ids) ? req.body.media_ids.slice(0, MAX_MEDIA) : [];
    const { ok: mediaIds, bad: badMedia } = await filterOwnedMediaIds(rawMediaIds, req.user.id);
    if (badMedia.length) return fail(res, "图片不存在或无权使用", 403);
    if (!title) return fail(res, "请输入标题");
    if (!content && !mediaIds.length) return fail(res, "请输入正文或添加图片");
    if (!topicId) return fail(res, "请选择话题");

    const [[topic]] = await pool.query("SELECT id, status FROM community_topics WHERE id = ?", [topicId]);
    if (!topic) return fail(res, "话题不存在");
    // 停用话题不接受新帖（历史帖仍可读）—— 管理员下架话题时不必删内容
    if (Number(topic.status) !== 1) return fail(res, "该话题已停用，无法发帖");

    const r = await pool.query(
      `INSERT INTO community_posts (user_id, topic_id, title, content, media_ids, status, created_time, updated_time)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [req.user.id, topicId, title, content, JSON.stringify(mediaIds), now(), now()]
    );
    const postId = Number(r[0].insertId);
    await pool.query("UPDATE community_topics SET post_count = post_count + 1 WHERE id = ?", [topicId]);
    // 绑定媒体引用：帖子删掉时图片才回收得掉（不绑就是永久孤儿）
    for (const mid of mediaIds) {
      await attachRef(mid, { userId: req.user.id, refType: "community_post", refId: String(postId), slot: `p${mid}` }).catch(
        (e) => console.warn(`[community] 绑定帖子图片引用失败：${e.message}`)
      );
    }
    return ok(res, { id: postId }, "发布成功");
  })
);

// 编辑：只有作者能改（管理员走隐藏/删除，不改别人的内容 —— 改动会篡改作者原意）
router.put(
  "/posts/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "帖子不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM community_posts WHERE id = ?", [id]);
    if (!row) return fail(res, "帖子不存在", 404);
    if (Number(row.user_id) !== req.user.id) return fail(res, "只能编辑自己的帖子", 403);
    const titleRaw = String(req.body?.title ?? row.title).trim();
    const contentRaw = String(req.body?.content ?? row.content).trim();
    const lenErr = tooLong(titleRaw, MAX_TITLE, "标题") || tooLong(contentRaw, MAX_CONTENT, "正文");
    if (lenErr) return fail(res, lenErr, 400);
    const title = titleRaw;
    const content = contentRaw;
    const topicId = req.body?.topic_id !== undefined ? Number(req.body.topic_id) || 0 : Number(row.topic_id);
    if (!title) return fail(res, "请输入标题");
    if (!content) return fail(res, "请输入正文");
    if (!topicId) return fail(res, "请选择话题");
    // 换话题前必须确认目标话题存在 —— 否则 post_count 会加到一个不存在的 id 上：
    // 那个帖子在话题页永远不出现（JOIN 不到），计数却已经漂了。
    // （黑盒测试实测：PUT topic_id=99999 → 200 已保存，任务里说「话题计数漂移」）
    if (topicId !== Number(row.topic_id)) {
      const [[t]] = await pool.query("SELECT id, status FROM community_topics WHERE id = ?", [topicId]);
      if (!t) return fail(res, "话题不存在");
      if (Number(t.status) !== 1) return fail(res, "该话题已停用，无法移入");
    }
    // 编辑时同样要校验（否则可以「先发空帖、再把 media_ids 改成别人的图」绕过上面那关）
    const oldMediaIds = (safeJSONParse(row.media_ids, []) || []).map((x) => Number(x) || 0).filter(Boolean);
    const mediaIds = Array.isArray(req.body?.media_ids)
      ? (
          await filterOwnedMediaIds(req.body.media_ids.slice(0, MAX_MEDIA), req.user.id)
        ).ok
      : oldMediaIds;
    await pool.query(
      "UPDATE community_posts SET title = ?, content = ?, topic_id = ?, media_ids = ?, updated_time = ? WHERE id = ?",
      [title, content, topicId, JSON.stringify(mediaIds), now(), id]
    );
    // 换话题要同步两个话题的计数，否则话题页的「N 帖」会越来越偏
    if (topicId !== Number(row.topic_id)) {
      await pool.query("UPDATE community_topics SET post_count = GREATEST(post_count - 1, 0) WHERE id = ?", [row.topic_id]);
      await pool.query("UPDATE community_topics SET post_count = post_count + 1 WHERE id = ?", [topicId]);
    }
    // 编辑时**移掉的图片也要解绑**，否则旧图被永久占着（用户删不掉它，见 DELETE 处的注释）。
    // releaseRefs 只能按 ref_id（帖子）整批释放，所以这里的做法是
    // 「先全部释放，再把当前这组重新绑上」—— 结果与「只释放被移除的」等价：
    // attachRef 对已存在的 (media, ref_type, ref_id, slot) 走 ON DUPLICATE 复活，
    // 两个方向都幂等，且末尾的 recountRefs 会把计数收敛到真值。
    if (oldMediaIds.length) {
      await releaseRefs("community_post", [String(id)]).catch((e) =>
        console.warn(`[community] 编辑帖子释放图片引用失败：${e.message}`)
      );
    }
    for (const mid of mediaIds) {
      await attachRef(mid, { userId: req.user.id, refType: "community_post", refId: String(id), slot: `p${mid}` }).catch(
        (e) => console.warn(`[community] 编辑帖子绑定图片引用失败：${e.message}`)
      );
    }
    return ok(res, null, "已保存");
  })
);

// 删除：作者删自己的；管理员可删任何（留痕）
router.delete(
  "/posts/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "帖子不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM community_posts WHERE id = ?", [id]);
    if (!row) return fail(res, "帖子不存在", 404);
    const isOwner = Number(row.user_id) === req.user.id;
    const isAdmin = req.user.role >= 100;
    if (!isOwner && !isAdmin) return fail(res, "无权删除", 403);
    // 已经删过的再删：幂等返回，而不是把 deleted_by 改成后来者
    if (Number(row.status) === 2) return ok(res, null, "已删除");
    await pool.query("UPDATE community_posts SET status = 2, deleted_by = ?, deleted_time = ? WHERE id = ?", [
      req.user.id,
      now(),
      id,
    ]);
    // **必须释放图片引用**，否则用户的图被永久锁死。
    //
    // 黑盒测试实测（原话）：「帖子删了，图永远删不掉」——
    // 发帖时 attachRef 记了一行 is_live=1 的引用，删帖只改 status，引用不释放，
    // 之后用户自己删图 → 409「该文件仍被 1 处引用，请先删除对应内容（或由管理员强制删除）」，
    // 而那个「对应内容」正是他刚删掉的帖子，无法再操作。用户媒体配额被永久占用，
    // 只能求管理员 force。库内实测已积压 25 条指向已删帖的活引用。
    //
    // 软删帖不复活（status=2 是终态），所以这里直接释放是安全的；
    // 若是「隐藏」（status=3，可恢复）则不释放 —— 内容还在，引用也该在。
    await releaseRefs("community_post", [String(id)]).catch((e) =>
      console.warn(`[community] 删除帖子 #${id} 释放图片引用失败：${e.message}`)
    );
    // 只有**从「正常」删**才减计数：隐藏（status=3）的帖子在 moderate 里已经减过了，
    // 这里再减一次就是重复扣减（话题计数会低于真实值，且再也回不来）。
    if (Number(row.status) === 1) {
      await pool.query("UPDATE community_topics SET post_count = GREATEST(post_count - 1, 0) WHERE id = ?", [row.topic_id]);
    }
    if (!isOwner) {
      await writeLog({
        req,
        user: req.user,
        type: LOG_TYPE.MANAGE,
        content: `删除社区帖子 #${id}（作者 uid=${row.user_id}）：${String(row.title).slice(0, 40)}`,
      });
    }
    return ok(res, null, "已删除");
  })
);

// 隐藏 / 置顶（管理员）。隐藏比删除轻：内容仍可被作者与管理员看到，可恢复。
router.post(
  "/posts/:id/moderate",
  adminRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "帖子不存在", 404);
    const [[row]] = await pool.query("SELECT id, topic_id, status FROM community_posts WHERE id = ?", [id]);
    if (!row) return fail(res, "帖子不存在", 404);
    const sets = [];
    const args = [];
    // 隐藏/恢复要**同步话题计数**。
    //
    // 话题页的「N 帖」统计的是 status=1 的帖子，而这里的 status 变更原先不改
    // post_count —— 隐藏一批帖子后，话题计数就成了虚高的死数
    //（实测：批量隐藏 24 条测试帖后，「综合讨论」显示 25 帖、实际只剩 2 帖）。
    // 与「编辑帖子换话题」处的计数维护是同一类问题，这里补上。
    let countDelta = 0;
    if (req.body?.status !== undefined) {
      const st = Number(req.body.status);
      if (![1, 3].includes(st)) return fail(res, "status 只能是 1（正常）或 3（隐藏）");
      const was = Number(row.status);
      if (was !== st && (was === 1 || st === 1)) countDelta = st === 1 ? 1 : -1;
      sets.push("status = ?");
      args.push(st);
      if (st === 3) {
        sets.push("deleted_by = ?", "deleted_time = ?");
        args.push(req.user.id, now());
      }
    }
    if (req.body?.is_pinned !== undefined) {
      sets.push("is_pinned = ?");
      args.push(Number(req.body.is_pinned) ? 1 : 0);
    }
    if (!sets.length) return fail(res, "没有需要更新的字段");
    args.push(id);
    await pool.query(`UPDATE community_posts SET ${sets.join(", ")} WHERE id = ?`, args);
    if (countDelta) {
      await pool.query(
        `UPDATE community_topics SET post_count = GREATEST(0, post_count + ?) WHERE id = ?`,
        [countDelta, row.topic_id]
      );
    }
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `管理社区帖子 #${id}：${sets.join(", ")}` });
    return ok(res, null, "已处理");
  })
);

// ---------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------
router.get(
  "/posts/:id/comments",
  authRequired,
  asyncHandler(async (req, res) => {
    const postId = idParam(req);
    if (!postId) return fail(res, "帖子不存在", 404);
    const { p, size, offset } = pageParams(req.query, 50);
    const vis = visibilityClause(req.user, "c");
    const clause = `WHERE c.post_id = ? ${vis.sql}`;
    const args = [postId, ...vis.args];
    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM community_comments c ${clause}`, args);
    const [rows] = await pool.query(
      `SELECT c.*, ru.username AS reply_username, ru.display_name AS reply_display_name
         FROM community_comments c
         LEFT JOIN users ru ON ru.id = c.reply_to_user_id
        ${clause} ORDER BY c.id ASC LIMIT ? OFFSET ?`,
      [...args, size, offset]
    );
    const authors = await authorsOf(rows);
    // 评论的点赞状态
    const ids = rows.map((r) => Number(r.id));
    let liked = new Set();
    if (ids.length) {
      const [rs] = await pool.query(
        `SELECT target_id FROM community_reactions
          WHERE user_id = ? AND target_type = 'comment' AND kind = 'like'
            AND target_id IN (${ids.map(() => "?").join(",")})`,
        [req.user.id, ...ids]
      );
      liked = new Set(rs.map((r) => Number(r.target_id)));
    }
    const items = rows.map((c) => {
      const a = authors.get(Number(c.user_id));
      return {
        id: Number(c.id),
        post_id: Number(c.post_id),
        user_id: Number(c.user_id),
        author: a || { id: Number(c.user_id), username: "", display_name: "" },
        parent_id: Number(c.parent_id) || 0,
        content: c.content,
        like_count: Number(c.like_count) || 0,
        status: Number(c.status),
        created_time: Number(c.created_time),
        liked: liked.has(Number(c.id)),
        // 扁平二级：靠 @ 谁标明上下文（而不是靠缩进层级）
        reply_to_user_id: Number(c.reply_to_user_id) || 0,
        reply_to_name: c.reply_display_name || c.reply_username || "",
      };
    });
    return ok(res, { items, total: Number(cnt.n) || 0, page: p, page_size: size });
  })
);

router.post(
  "/posts/:id/comments",
  rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "comment-create", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const postId = idParam(req);
    if (!postId) return fail(res, "帖子不存在", 404);
    const contentRaw = String(req.body?.content || "").trim();
    const lenErr = tooLong(contentRaw, MAX_COMMENT, "评论");
    if (lenErr) return fail(res, lenErr, 400);
    const content = contentRaw;
    if (!content) return fail(res, "请输入评论内容");
    let parentId = Number(req.body?.parent_id) || 0;
    // reply_to_user_id 决定给谁发通知，所以**不能由客户端随便指定**。
    //
    // 黑盒测试实测：任意传 reply_to_user_id=<某人> 就能让平台以自己的名义
    // 给那个人投递一条「回复了你」的通知（通知骚扰面：不需要对方参与过这个帖子、
    // 甚至不需要那条评论存在）。合法取值只有三种：0、父评论作者、帖子作者；
    // 这里只承认最严格的一种 —— 有 parent_id 时必须是该评论的作者
    //（前端 PostDetailPage 始终成对发送 parent_id + reply_to_user_id，
    //  「回复二级评论」时 parent_id 已归一到一级父节点，作者不变，故不受影响）。
    // 想 @ 帖子里没回复过的人，走正文里的 @用户名（那条路径会逐条查库确认用户存在）。
    let replyToUserId = Number(req.body?.reply_to_user_id) || 0;
    if (replyToUserId && !parentId) return fail(res, "回复目标不正确", 400);
    const [[post]] = await pool.query("SELECT id, status FROM community_posts WHERE id = ?", [postId]);
    if (!post) return fail(res, "帖子不存在", 404);
    if (Number(post.status) !== 1) return fail(res, "该帖子已关闭评论");
    if (parentId) {
      const [[parent]] = await pool.query(
        "SELECT id, post_id, parent_id, status, user_id FROM community_comments WHERE id = ?",
        [parentId]
      );
      if (!parent || Number(parent.post_id) !== postId) return fail(res, "回复的评论不存在");
      if (Number(parent.status) !== 1) return fail(res, "该评论已删除，无法回复");
      // **扁平二级的关键**：回复一条「二级评论」时，把 parent_id 归一到它的一级父节点。
      // 否则前端按 parent_id 组织会形成无限层级，窄屏下缩进会把正文压成细条。
      if (Number(parent.parent_id) > 0) {
        parentId = Number(parent.parent_id);
      }
      // 只有「回复对象 == 这条父评论的作者」才成立（见上方 reply_to_user_id 的注释）。
      // 不认客户端送来的其他 id，一律按父评论作者重算 —— 伪造也就无从下手。
      replyToUserId = Number(parent.user_id) || 0;
      // 不给自己回复时@自己（没意义且看着像 bug）
      if (replyToUserId === req.user.id) replyToUserId = 0;
    }
    const r = await pool.query(
      "INSERT INTO community_comments (post_id, user_id, parent_id, reply_to_user_id, content, status, created_time) VALUES (?, ?, ?, ?, ?, 1, ?)",
      [postId, req.user.id, parentId, replyToUserId, content, now()]
    );
    const commentId = Number(r[0].insertId);
    await pool.query("UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = ?", [postId]);

    // 通知（不给自己发，已在 notify 内部兜住）：
    //   回复别人的评论 → 通知被回复者；否则通知帖子作者
    const [[postFull]] = await pool.query("SELECT user_id, title FROM community_posts WHERE id = ?", [postId]);
    if (replyToUserId) {
      await notify({
        userId: replyToUserId,
        actorId: req.user.id,
        type: "comment_reply",
        target: { postId, commentId, postTitle: postFull?.title },
      });
    } else if (postFull) {
      await notify({
        userId: postFull.user_id,
        actorId: req.user.id,
        type: "post_comment",
        target: { postId, commentId, postTitle: postFull.title },
      });
    }
    // **正文里手打的 @用户名 也要通知**。
    //
    // 黑盒测试发现的问题：本平台原先只有「点回复按钮」才会产生 @（走
    // reply_to_user_id），而用户在正文里直接写 `@某人` **完全没有效果** ——
    // 不解析、不通知，被提及的人永远不知道。这与绝大多数社区产品的直觉不符
    //（输入 @ 就是提及），而输入框的提示也没说明只支持回复式 @。
    //
    // 实现要点：
    //   · 只认「存在的用户名」，逐条查库确认 —— 不猜、不为不存在的名字发通知
    //     （否则 `@随便打` 会变成骚扰渠道）；
    //   · **必须要求 @ 前面是行首或空白**：否则 `user@example.com` 这种邮箱会被
    //     当成提及 `example`（实测过），给莫名其妙的人发通知；
    //   · 一条评论里提及多人，逐个发；同一人重复 @ 只发一次；
    //   · 与已有通知去重：被回复者/楼主已经收到 comment_reply / post_comment 了，
    //     不再叠加一条 mention（同一条评论对同一个人最多一条通知）。
    const mentioned = [
      ...new Set(
        [...content.matchAll(/(?:^|[\s，。！？、,.!?])@([A-Za-z0-9_\u4e00-\u9fa5-]{2,32})/g)].map((m) => m[1])
      ),
    ].filter((name) => !/^\d+$/.test(name)); // 纯数字不是用户名
    if (mentioned.length) {
      const alreadyNotified = new Set([Number(replyToUserId) || 0, Number(postFull?.user_id) || 0]);
      for (const name of mentioned.slice(0, 10)) {
        const [[u]] = await pool.query("SELECT id FROM users WHERE username = ? AND status = 1 LIMIT 1", [name]);
        const uid = Number(u?.id) || 0;
        if (!uid || uid === req.user.id || alreadyNotified.has(uid)) continue;
        alreadyNotified.add(uid); // 同一人只发一次
        await notify({
          userId: uid,
          actorId: req.user.id,
          type: "mention",
          target: { postId, commentId, postTitle: postFull?.title },
        });
      }
    }
    return ok(res, { id: commentId }, "评论成功");
  })
);

router.delete(
  "/comments/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return fail(res, "评论不存在", 404);
    const [[row]] = await pool.query("SELECT * FROM community_comments WHERE id = ?", [id]);
    if (!row) return fail(res, "评论不存在", 404);
    const isOwner = Number(row.user_id) === req.user.id;
    if (!isOwner && req.user.role < 100) return fail(res, "无权删除", 403);
    if (Number(row.status) === 2) return ok(res, null, "已删除");
    await pool.query("UPDATE community_comments SET status = 2, deleted_by = ? WHERE id = ?", [req.user.id, id]);
    await pool.query("UPDATE community_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ?", [row.post_id]);
    if (!isOwner) {
      await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: `删除社区评论 #${id}（作者 uid=${row.user_id}）` });
    }
    return ok(res, null, "已删除");
  })
);

// ---------------------------------------------------------------------------
// 点赞 / 收藏（共用一套实现，kind 区分）
// ---------------------------------------------------------------------------
async function toggleReaction(req, res, targetType, kind) {
  const id = idParam(req);
  if (!id) return fail(res, "内容不存在", 404);
  const table = targetType === "post" ? "community_posts" : "community_comments";
  const countCol = kind === "like" ? "like_count" : "favorite_count";
  const [[row]] = await pool.query(`SELECT id, status FROM ${table} WHERE id = ?`, [id]);
  if (!row) return fail(res, "内容不存在", 404);
  if (Number(row.status) !== 1) return fail(res, "内容不可用");

  const [[exist]] = await pool.query(
    "SELECT id FROM community_reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND kind = ?",
    [req.user.id, targetType, id, kind]
  );
  if (exist) {
    await pool.query("DELETE FROM community_reactions WHERE id = ?", [exist.id]);
    await pool.query(`UPDATE ${table} SET ${countCol} = GREATEST(${countCol} - 1, 0) WHERE id = ?`, [id]);
    const [[after]] = await pool.query(`SELECT ${countCol} AS n FROM ${table} WHERE id = ?`, [id]);
    return ok(res, { active: false, count: Number(after.n) || 0 }, kind === "like" ? "已取消点赞" : "已取消收藏");
  }
  let inserted = true;
  try {
    await pool.query(
      "INSERT INTO community_reactions (user_id, target_type, target_id, kind, created_time) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, targetType, id, kind, now()]
    );
  } catch (e) {
    // 并发双击：唯一键挡住了第二次插入。这本身就是「已赞」，按成功返回
    if (e.code !== "ER_DUP_ENTRY") throw e;
    inserted = false; // 已经赞过：不再发通知（否则双击会产生两条提醒）
  }
  // **计数自增必须只在真正插入成功时执行**。
  //
  // 这里踩过一个会造成**永久数据漂移**的坑（黑盒测试实测复现）：自增原先写在
  // `if (inserted)` 之外，于是两个并发请求（同一用户开两个标签页同时点赞，
  // 或 API 双击）都会走到这一行 —— 唯一键只挡住了重复的 INSERT，
  // 计数却 +2，而真实点赞行只有 1 行。结果是「帖子显示 2 个赞、实际 1 人赞」，
  // 且**永不自动纠正**（取消一次只 -1，要点两次才回到真值）。
  // 取消赞的并发同理（会 -2）。所以把自增移进分支内 —— 与上面 cancel 分支的
  // 「先删行、再减计数」严格对称。
  if (inserted) {
    await pool.query(`UPDATE ${table} SET ${countCol} = ${countCol} + 1 WHERE id = ?`, [id]);
  }
  const [[after]] = await pool.query(`SELECT ${countCol} AS n FROM ${table} WHERE id = ?`, [id]);

  if (inserted) {
    // 通知内容作者（帖子点赞/收藏通知楼主；评论点赞通知该评论作者）
    if (targetType === "post") {
      const [[p]] = await pool.query("SELECT user_id, title FROM community_posts WHERE id = ?", [id]);
      if (p) {
        await notify({
          userId: p.user_id,
          actorId: req.user.id,
          type: kind === "like" ? "post_like" : "post_favorite",
          target: { postId: id, postTitle: p.title },
        });
      }
    } else {
      const [[c]] = await pool.query("SELECT user_id, post_id FROM community_comments WHERE id = ?", [id]);
      if (c) {
        await notify({
          userId: c.user_id,
          actorId: req.user.id,
          type: "comment_like",
          target: { postId: c.post_id, commentId: id },
        });
      }
    }
  }
  return ok(res, { active: true, count: Number(after.n) || 0 }, kind === "like" ? "已点赞" : "已收藏");
}

router.post(
  "/posts/:id/like",
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "like", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler((req, res) => toggleReaction(req, res, "post", "like"))
);
router.post(
  "/posts/:id/favorite",
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "fav", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler((req, res) => toggleReaction(req, res, "post", "favorite"))
);
router.post(
  "/comments/:id/like",
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: "clike", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler((req, res) => toggleReaction(req, res, "comment", "like"))
);

// ---------------------------------------------------------------------------
// 关注
// ---------------------------------------------------------------------------
router.post(
  "/users/:id/follow",
  rateLimit({ windowMs: 60_000, max: 40, keyPrefix: "follow", keyFn: (r) => r.user?.id || r.ip }),
  authRequired,
  asyncHandler(async (req, res) => {
    const targetId = idParam(req);
    if (!targetId) return fail(res, "用户不存在", 404);
    if (targetId === req.user.id) return fail(res, "不能关注自己");
    const [[target]] = await pool.query("SELECT id, status FROM users WHERE id = ?", [targetId]);
    if (!target || Number(target.status) !== 1) return fail(res, "用户不存在", 404);
    const [[exist]] = await pool.query(
      "SELECT id FROM community_follows WHERE follower_id = ? AND followee_id = ?",
      [req.user.id, targetId]
    );
    if (exist) {
      await pool.query("DELETE FROM community_follows WHERE id = ?", [exist.id]);
      const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM community_follows WHERE followee_id = ?", [targetId]);
      return ok(res, { following: false, followers: Number(c.n) || 0 }, "已取消关注");
    }
    let fresh = true;
    try {
      await pool.query("INSERT INTO community_follows (follower_id, followee_id, created_time) VALUES (?, ?, ?)", [
        req.user.id,
        targetId,
        now(),
      ]);
    } catch (e) {
      if (e.code !== "ER_DUP_ENTRY") throw e;
      fresh = false;
    }
    // 只在「**首次**关注」时通知（反复点关注/取关不该刷屏）。
    //
    // 这里踩过一个通知刷屏的坑（黑盒测试实测）：`fresh` 只挡得住**同一次重放**
    // （并发/双击产生的 ER_DUP_ENTRY），而「取关 → 再关注」是**全新的插入**，
    // fresh 恒为 true —— 于是在限流窗口（40 次/分）内连点，就能给对方刷满通知
    // （每人保留上限 200 条，很快被刷掉）。
    //
    // 正确语义是「曾经关注过就不再通知第二次」，所以这里查**历史通知**而不是
    // 查关注行（关注行在取关时已经被删掉了，查它必然查不到）。
    if (fresh) {
      const [[notified]] = await pool.query(
        "SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow' LIMIT 1",
        [targetId, req.user.id]
      );
      if (!notified) await notify({ userId: targetId, actorId: req.user.id, type: "follow" });
    }
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM community_follows WHERE followee_id = ?", [targetId]);
    return ok(res, { following: true, followers: Number(c.n) || 0 }, "已关注");
  })
);

// ---------------------------------------------------------------------------
// 我的社区数据（个人主页与「我的」页共用）
// ---------------------------------------------------------------------------
router.get(
  "/me/summary",
  authRequired,
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const [[posts]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(like_count),0) AS likes FROM community_posts WHERE user_id = ? AND status <> 2", [uid]);
    const [[comments]] = await pool.query("SELECT COUNT(*) AS n FROM community_comments WHERE user_id = ? AND status <> 2", [uid]);
    const [[follows]] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM community_follows WHERE follower_id = ?) AS following, (SELECT COUNT(*) FROM community_follows WHERE followee_id = ?) AS followers",
      [uid, uid]
    );
    const [[favs]] = await pool.query(
      "SELECT COUNT(*) AS n FROM community_reactions WHERE user_id = ? AND kind = 'favorite' AND target_type = 'post'",
      [uid]
    );
    return ok(res, {
      posts: Number(posts.n) || 0,
      likes_received: Number(posts.likes) || 0,
      comments: Number(comments.n) || 0,
      following: Number(follows.following) || 0,
      followers: Number(follows.followers) || 0,
      favorites: Number(favs.n) || 0,
    });
  })
);

// ---------------------------------------------------------------------------
// 通知（社区互动的提醒）
// ---------------------------------------------------------------------------
router.get(
  "/notifications",
  authRequired,
  asyncHandler(async (req, res) => ok(res, await listNotifications(req.user.id, req.query)))
);

router.get(
  "/notifications/unread",
  authRequired,
  asyncHandler(async (req, res) => ok(res, { total: await unreadCount(req.user.id) }))
);

router.post(
  "/notifications/read",
  authRequired,
  asyncHandler(async (req, res) => {
    const n = await markRead(req.user.id, req.body?.ids);
    return ok(res, { updated: n, unread: await unreadCount(req.user.id) }, n ? "已标记已读" : "没有未读");
  })
);

router.delete(
  "/notifications/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const okFlag = await removeNotification(req.user.id, idParam(req));
    if (!okFlag) return fail(res, "通知不存在", 404);
    return ok(res, null, "已删除");
  })
);

// ---------------------------------------------------------------------------
// 管理员：计数重算（列表页计数漂移时的修复手段）
// ---------------------------------------------------------------------------
router.post(
  "/admin/recount",
  adminRequired,
  asyncHandler(async (req, res) => {
    // 先补一步「僵尸引用清理」：把属于**已删帖子**的活引用释放掉。
    //
    // 这是为旧代码造成的历史脏数据准备的 —— 在「删帖释放引用」修好之前删掉的帖子，
    // 引用一直挂着 is_live=1，导致用户自己的图删不掉（409「仍被 1 处引用」，
    // 而那个引用指向的是他刚删掉的帖子，无法再操作）。实测库内有 25 条。
    // 新代码不会再产生这种数据，但存量必须清一次；放进重算里，
    // 管理员点一次「重算计数」就顺带修好，不必手工跑 SQL。
    const [zombieRefs] = await pool.query(
      `SELECT r.ref_id FROM media_refs r
         JOIN community_posts p ON p.id = r.ref_id
        WHERE r.ref_type = 'community_post' AND r.is_live = 1 AND p.status = 2`
    );
    const zombieIds = [...new Set(zombieRefs.map((r) => String(r.ref_id)))];
    if (zombieIds.length) {
      await releaseRefs("community_post", zombieIds).catch((e) =>
        console.warn(`[community] 清理僵尸引用失败：${e.message}`)
      );
    }
    // 用一次子查询批量重算，而不是逐行 COUNT（帖子多时逐行会拖很久）
    await pool.query(
      `UPDATE community_posts p SET
         like_count = (SELECT COUNT(*) FROM community_reactions r WHERE r.target_type='post' AND r.target_id=p.id AND r.kind='like'),
         favorite_count = (SELECT COUNT(*) FROM community_reactions r WHERE r.target_type='post' AND r.target_id=p.id AND r.kind='favorite'),
         comment_count = (SELECT COUNT(*) FROM community_comments c WHERE c.post_id=p.id AND c.status=1)`
    );
    await pool.query(
      `UPDATE community_topics t SET
         post_count = (SELECT COUNT(*) FROM community_posts p WHERE p.topic_id=t.id AND p.status=1)`
    );
    await pool.query(
      `UPDATE community_comments c SET
         like_count = (SELECT COUNT(*) FROM community_reactions r WHERE r.target_type='comment' AND r.target_id=c.id AND r.kind='like')`
    );
    await writeLog({
      req,
      user: req.user,
      type: LOG_TYPE.MANAGE,
      content: `重算社区计数${zombieIds.length ? `（并释放 ${zombieIds.length} 条已删帖的图片引用）` : ""}`,
    });
    return ok(res, { released_refs: zombieIds.length }, "计数已重算");
  })
);

export default router;
