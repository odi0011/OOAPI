// 当前模块的端到端功能验证（HTTP 级，真读写数据库）
// ---------------------------------------------------------------------------
// 为什么需要它：「页面能渲染」不等于「功能可用」。
// 本项目反复踩过 —— 构建通过、页面不白屏，但接口 500 或数据没落库。
// 这个文件把社区/聊天/好友/通知/个人主页/看板的完整链路真跑一遍，
// 断言到「数据库里的行变了」这一层，而不是只看 HTTP 200。
//
// 用法（服务器上，需数据库可连）：
//   cd ooapi-server && BASE=http://127.0.0.1:3001 node tests/e2e-modules.mjs
// 会自动清理自己创建的测试数据。
import "dotenv/config";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const { JWT_SECRET, pool } = await import("../src/db.js");

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) {
    pass += 1;
    console.log(`  ok  ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${n} ${extra}`);
  }
};

// 真实账号只参与只读管理请求和本轮话题/帖子管理。所有社交操作在新建的两个普通账号间完成，
// 避免真实用户的通知被标记已读、旧私聊被复活、好友关系或冗余计数被改变。
const runId = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
const ownedUsers = [];
const userNames = new Set();
const ownedTopics = new Set();
const ownedPosts = new Set();
const ownedRooms = new Set();
const topicNames = new Set();
const startedAt = Math.floor(Date.now() / 1000);
let operatorId;
let HA;
const headersOf = (u) => ({
  authorization: `Bearer ${jwt.sign({ id: u.id, role: u.role, tv: Number(u.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
  "content-type": "application/json",
});
async function createUser(suffix) {
  const name = `e2em_${runId}_${suffix}`;
  // 密码随机生成后只存 hash；不登录、不打印，也不接触任何已有用户的凭据。
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), 10);
  const now = Math.floor(Date.now() / 1000);
  userNames.add(name);
  let insert;
  try {
    [insert] = await pool.query(
      "INSERT INTO users (username, password, display_name, role, status, quota, aff_code, group_name, created_time) VALUES (?,?,?,1,1,0,?,?,?)",
      [name, hash, "模块验收临时用户", crypto.randomBytes(8).toString("hex"), "", now]
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") userNames.delete(name); // 冲突行不属于本轮，绝不能据名字删它。
    throw e;
  }
  const user = { id: Number(insert.insertId), username: name, role: 1, token_version: 0 };
  if (!user.id) throw new Error("创建临时测试账号未返回 id");
  ownedUsers.push(user.id);
  return user;
}

const call = async (method, path, body, hdrs = HA) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* 非 JSON 响应（如 502） */
  }
  const id = Number(j?.data?.id) || 0;
  if (method === "POST" && id) {
    if (path === "/api/community/topics") ownedTopics.add(id);
    if (path === "/api/community/posts") ownedPosts.add(id);
    if (path === "/api/chatroom/rooms") ownedRooms.add(id);
  }
  return { status: r.status, body: j, data: j?.data };
};
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b || {});

function requiredId(result, label) {
  if (result.status !== 200 || !Number(result.data?.id)) throw new Error(`${label}失败（HTTP ${result.status}）：${result.body?.message || "未返回 id"}`);
  return Number(result.data.id);
}

// 即使网络中断导致创建接口没返回 id，也能通过本轮唯一用户名/话题名恢复精确清理范围。
async function cleanup() {
  if (!userNames.size && !ownedUsers.length && !topicNames.size) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (userNames.size) {
      const [found] = await conn.query("SELECT id FROM users WHERE username IN (?) AND role = 1 AND display_name = ? AND created_time >= ?", [[...userNames], "模块验收临时用户", startedAt]);
      for (const u of found) if (!ownedUsers.includes(Number(u.id))) ownedUsers.push(Number(u.id));
    }
    const users = [...ownedUsers];
    const affectedMedia = new Set();
    const clearRefs = async (type, ids) => {
      if (!ids.length) return;
      const values = ids.map(String);
      const [refs] = await conn.query("SELECT DISTINCT media_id FROM media_refs WHERE ref_type = ? AND ref_id IN (?)", [type, values]);
      refs.forEach((r) => affectedMedia.add(Number(r.media_id)));
      await conn.query("DELETE FROM media_refs WHERE ref_type = ? AND ref_id IN (?)", [type, values]);
    };
    if (users.length) {
      const [posts] = await conn.query("SELECT id, topic_id FROM community_posts WHERE user_id IN (?)", [users]);
      posts.forEach((p) => ownedPosts.add(Number(p.id)));
      const [rooms] = await conn.query("SELECT id FROM chat_rooms WHERE owner_id IN (?)", [users]);
      rooms.forEach((r) => ownedRooms.add(Number(r.id)));
      // 清理只触碰临时账号关联的记录，绝不按历史测试标题或账号前缀扫全库。
      await conn.query("DELETE FROM notifications WHERE user_id IN (?) OR actor_id IN (?)", [users, users]);
      await conn.query("DELETE FROM friend_requests WHERE from_user_id IN (?) OR to_user_id IN (?)", [users, users]);
      await conn.query("DELETE FROM friendships WHERE user_id IN (?) OR friend_id IN (?)", [users, users]);
      await conn.query("DELETE FROM community_follows WHERE follower_id IN (?) OR followee_id IN (?)", [users, users]);
      await conn.query("DELETE FROM community_reactions WHERE user_id IN (?)", [users]);
      await conn.query("DELETE FROM logs WHERE user_id IN (?)", [users]);
    }
    const postIds = [...ownedPosts];
    if (postIds.length) {
      const [posts] = await conn.query("SELECT DISTINCT topic_id FROM community_posts WHERE id IN (?)", [postIds]);
      const [comments] = await conn.query("SELECT id FROM community_comments WHERE post_id IN (?)", [postIds]);
      await clearRefs("community_post", postIds);
      await clearRefs("community_comment", comments.map((c) => Number(c.id)));
      if (comments.length) {
        await conn.query("DELETE FROM community_reactions WHERE target_type = 'comment' AND target_id IN (?)", [comments.map((c) => Number(c.id))]);
      }
      await conn.query("DELETE FROM community_reactions WHERE target_type = 'post' AND target_id IN (?)", [postIds]);
      // 管理动作审计只清本轮新帖的精确目标，不能清管理员的历史操作日志。
      if (operatorId) {
        for (const id of postIds) {
          await conn.query("DELETE FROM logs WHERE user_id = ? AND created_at >= ? AND type = 3 AND content LIKE ?", [operatorId, startedAt, `管理社区帖子 #${id}：%`]);
        }
      }
      await conn.query("DELETE FROM notifications WHERE post_id IN (?)", [postIds]);
      await conn.query("DELETE FROM community_comments WHERE post_id IN (?)", [postIds]);
      await conn.query("DELETE FROM community_posts WHERE id IN (?)", [postIds]);
      // 按剩余正常帖子重算受影响话题；提前报错时也不会让话题计数永久偏大。
      for (const p of posts) {
        if (!Number(p.topic_id)) continue;
        await conn.query("UPDATE community_topics SET post_count = (SELECT COUNT(*) FROM community_posts WHERE topic_id = ? AND status = 1) WHERE id = ?", [p.topic_id, p.topic_id]);
      }
    }
    const roomIds = [...ownedRooms];
    if (roomIds.length) {
      const [messages] = await conn.query("SELECT id FROM chat_room_messages WHERE room_id IN (?)", [roomIds]);
      await clearRefs("chat_room_message", messages.map((m) => Number(m.id)));
      await conn.query("DELETE FROM chat_room_messages WHERE room_id IN (?)", [roomIds]);
      await conn.query("DELETE FROM chat_room_members WHERE room_id IN (?)", [roomIds]);
      await conn.query("DELETE FROM chat_rooms WHERE id IN (?)", [roomIds]);
    }
    if (topicNames.size) {
      const [topics] = await conn.query("SELECT id FROM community_topics WHERE name IN (?)", [[...topicNames]]);
      topics.forEach((t) => ownedTopics.add(Number(t.id)));
    }
    for (const id of ownedTopics) {
      // 若其他用户在短暂测试期间用了这个新话题，保留话题，不能顺带删他们的帖子。
      const [deleted] = await conn.query("DELETE FROM community_topics WHERE id = ? AND NOT EXISTS (SELECT 1 FROM community_posts WHERE topic_id = ?)", [id, id]);
      if (deleted.affectedRows) await clearRefs("community_topic", [id]);
    }
    await clearRefs("avatar", users);
    for (const id of affectedMedia) {
      if (!id) continue;
      await conn.query("UPDATE media SET ref_count = (SELECT COUNT(*) FROM media_refs WHERE media_id = ? AND is_live = 1) WHERE id = ?", [id, id]);
    }
    if (users.length) await conn.query("DELETE FROM users WHERE id IN (?)", [users]);
    for (const [table, ids] of [["users", users], ["community_posts", postIds], ["chat_rooms", roomIds]]) {
      if (!ids.length) continue;
      // 表名来自此处固定白名单，与任何请求/用户输入无关。
      const [[left]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (?)`, [ids]);
      if (Number(left.n)) throw new Error(`本轮 ${table} 仍有 ${Number(left.n)} 条未清理，事务已回滚`);
    }
    await conn.commit();
    ck("本轮临时用户与帖子/房间关联已清理", true);
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

try {
const [[operator]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 AND status = 1 ORDER BY role DESC, id ASC LIMIT 1");
if (!operator) throw new Error("数据库里没有启用的管理员账号");
const HM = headersOf(operator);
operatorId = Number(operator.id);
const actor = await createUser("a");
const other = await createUser("b");
HA = headersOf(actor);
const HO = headersOf(other);
console.log(`端到端功能验证：本轮 ${runId}，两个独立临时普通账号\n`);

/* ============================ 社区 ============================ */
console.log("社区");
const topics = await get("/api/community/topics");
ck("话题列表可读", topics.status === 200 && Array.isArray(topics.data));
const topicName = `e2e话题_${runId}`;
topicNames.add(topicName);
const topic = await call("POST", "/api/community/topics", { name: topicName, description: "本轮模块验收临时话题" }, HM);
ck("管理员可创建话题", topic.status === 200 && topic.data?.id > 0);
const topicId = requiredId(topic, "创建话题");

const newPost = await post("/api/community/posts", {
  title: `端到端测试帖 ${runId}`,
  content: "端到端测试内容，含代码块：\n\n```bash\ncurl -X POST /v1/chat/completions\n```",
  topic_id: topicId,
  media_ids: [],
});
ck("发帖成功", newPost.status === 200 && newPost.data?.id > 0, JSON.stringify(newPost.body)?.slice(0, 200));
const postId = requiredId(newPost, "创建帖子");

const detail = await get(`/api/community/posts/${postId}`);
ck("详情可读且含作者", detail.status === 200 && Boolean(detail.data?.author?.username));
ck("浏览量已自增", Number(detail.data?.view_count) >= 1, `view=${detail.data?.view_count}`);

const c1 = await post(`/api/community/posts/${postId}/comments`, { content: "一级评论" });
ck("发一级评论", c1.status === 200 && c1.data?.id > 0, JSON.stringify(c1.body)?.slice(0, 160));
const rootId = c1.data?.id;

const c2 = await post(`/api/community/posts/${postId}/comments`, { content: "二级评论", parent_id: rootId });
const [[childRow]] = await pool.query("SELECT parent_id FROM community_comments WHERE id = ?", [c2.data?.id]);
ck("二级评论挂在根评论下", Number(childRow?.parent_id) === Number(rootId), `parent=${childRow?.parent_id}`);

if (HO) {
  // 关键：回复「二级评论」也必须挂回一级 —— 否则会形成三层，窄屏下正文被缩进压成细条
  const c3 = await call("POST", `/api/community/posts/${postId}/comments`, { content: "回复二级（验证不产生三层）", parent_id: c2.data?.id }, HO);
  const [[row3]] = await pool.query("SELECT parent_id, reply_to_user_id FROM community_comments WHERE id = ?", [c3.data?.id]);
  ck("回复二级评论仍挂回一级父节点（扁平二级生效）", Number(row3?.parent_id) === Number(rootId), `parent=${row3?.parent_id}`);
  ck("被回复者已记录（渲染 @谁用）", Number(row3?.reply_to_user_id) === Number(actor.id), `reply_to=${row3?.reply_to_user_id}`);
} else {
  ck("回复二级评论仍挂回一级父节点（扁平二级生效）", true, "（只有一个用户，跳过）");
  ck("被回复者已记录（渲染 @谁用）", true, "（只有一个用户，跳过）");
}

const like1 = await post(`/api/community/posts/${postId}/like`);
ck("点赞返回 active/count", like1.status === 200 && typeof like1.data?.active === "boolean");
const like2 = await post(`/api/community/posts/${postId}/like`);
ck("再点取消点赞（幂等切换）", like2.data?.active === !like1.data?.active);
const fav = await post(`/api/community/posts/${postId}/favorite`);
ck("收藏成功", fav.status === 200 && fav.data?.active === true);

const [[postRow]] = await pool.query("SELECT like_count, favorite_count, comment_count FROM community_posts WHERE id = ?", [postId]);
ck("评论计数正确", Number(postRow.comment_count) === (HO ? 3 : 2), `count=${postRow.comment_count}`);
ck("收藏计数为 1", Number(postRow.favorite_count) === 1, `fav=${postRow.favorite_count}`);

if (HO) {
  const fol = await call("POST", `/api/community/users/${actor.id}/follow`, {}, HO);
  ck("关注他人成功", fol.status === 200 && fol.data?.following === true);
  const unfol = await call("POST", `/api/community/users/${actor.id}/follow`, {}, HO);
  ck("取消关注成功", unfol.data?.following === false);
} else {
  ck("关注他人成功", true, "（只有一个用户，跳过）");
  ck("取消关注成功", true, "（只有一个用户，跳过）");
}

const filtered = await get(`/api/community/posts?topic_id=${topicId}&sort=hot`);
ck("按话题+热度筛选可读", filtered.status === 200 && Array.isArray(filtered.data?.items));

/* ============================ 聊天 ============================ */
console.log("\n聊天");
const room = await post("/api/chatroom/rooms", { type: "group", name: "e2e 测试群 " + runId, user_ids: other ? [other.id] : [] });
const roomId = requiredId(room, "创建群聊");
ck("建群成功", room.status === 200 && roomId > 0, JSON.stringify(room.body)?.slice(0, 160));

const msg = await post(`/api/chatroom/rooms/${roomId}/messages`, { type: "text", content: "端到端消息", client_id: "e2e-client-1" });
ck("发消息成功且回显 client_id（乐观队列依赖）", msg.status === 200 && msg.data?.client_id === "e2e-client-1", JSON.stringify(msg.body)?.slice(0, 200));
const msgId = msg.data?.id;

const list = await get(`/api/chatroom/rooms/${roomId}/messages?p=1&page_size=20`);
ck("消息列表可读", list.status === 200 && (list.data?.items || []).some((m) => m.id === msgId));

const inc = await get(`/api/chatroom/rooms/${roomId}/messages?since_id=${Math.max(0, msgId - 1)}`);
ck("增量拉取（since_id）只返回新消息", inc.status === 200 && inc.data?.incremental === true);

const readRes = await post(`/api/chatroom/rooms/${roomId}/read`, {});
ck("标记已读成功", readRes.status === 200);

const unread = await get("/api/chatroom/unread");
ck("未读汇总可读", unread.status === 200 && typeof unread.data?.total === "number");

const rooms = await get("/api/chatroom/rooms");
ck("会话列表可读", rooms.status === 200 && (rooms.data?.items || []).some((r) => r.id === roomId));

const recall = await call("DELETE", `/api/chatroom/messages/${msgId}`);
ck("撤回自己的消息成功", recall.status === 200, JSON.stringify(recall.body)?.slice(0, 160));
const [[recalled]] = await pool.query("SELECT status FROM chat_room_messages WHERE id = ?", [msgId]);
ck("撤回后 status=2", Number(recalled.status) === 2);

if (other) {
  // 单聊唯一性：同一对用户建两次必须复用同一房间（否则双方各看一个，消息永远对不上）
  const s1 = await post("/api/chatroom/rooms", { type: "single", user_id: other.id });
  const s2 = await post("/api/chatroom/rooms", { type: "single", user_id: other.id });
  ck("单聊房间唯一（重复发起复用同一房间）", Number(s1.data?.id) === Number(s2.data?.id), `${s1.data?.id} vs ${s2.data?.id}`);
  if (s1.data?.id) await call("DELETE", `/api/chatroom/rooms/${s1.data.id}/members/me`);
} else {
  ck("单聊房间唯一（重复发起复用同一房间）", true, "（只有一个用户，跳过）");
}

/* ============================ 通知 ============================ */
console.log("通知");
const n0 = await get("/api/community/notifications/unread");
ck("未读通知可读", n0.status === 200 && typeof n0.data?.total === "number", JSON.stringify(n0.body)?.slice(0, 160));

if (HO) {
  // 第二个用户评论 + 点赞第一条帖子，第一临时用户应收到通知
  const notificationTopic = `通知测试话题_${runId}`;
  topicNames.add(notificationTopic);
  const t2 = await call("POST", "/api/community/topics", { name: notificationTopic }, HM);
  const notificationTopicId = requiredId(t2, "创建通知话题");
  const p2 = await post("/api/community/posts", { title: `通知测试帖 ${runId}`, content: "正文", topic_id: notificationTopicId });
  const pid = requiredId(p2, "创建通知帖子");
  const before = (await get("/api/community/notifications/unread")).data?.total || 0;
  await call("POST", `/api/community/posts/${pid}/comments`, { content: "来自第二个用户的评论" }, HO);
  const afterComment = (await get("/api/community/notifications/unread")).data?.total || 0;
  ck("他人评论后产生通知", afterComment > before, `${before} → ${afterComment}`);

  await call("POST", `/api/community/posts/${pid}/like`, {}, HO);
  const afterLike = (await get("/api/community/notifications/unread")).data?.total || 0;
  ck("他人点赞后产生通知", afterLike > afterComment, `${afterComment} → ${afterLike}`);

  // 关键：自己的操作不该给自己发通知
  const mineBefore = (await get("/api/community/notifications/unread")).data?.total || 0;
  await post(`/api/community/posts/${pid}/comments`, { content: "自己评论自己的帖子" });
  await post(`/api/community/posts/${pid}/like`, {});
  const mineAfter = (await get("/api/community/notifications/unread")).data?.total || 0;
  ck("自己的操作不给自己发通知", mineAfter === mineBefore, `${mineBefore} → ${mineAfter}`);

  const list = await get("/api/community/notifications?p=1&page_size=10");
  ck("通知列表含触发者与文案", list.status === 200 && (list.data?.items || []).every((n) => n.actor && n.text), JSON.stringify(list.data?.items?.[0])?.slice(0, 200));

  const readAll = await post("/api/community/notifications/read", {});
  ck("标记全部已读", readAll.status === 200 && (readAll.data?.unread || 0) === 0, JSON.stringify(readAll.data));
  const afterRead = (await get("/api/community/notifications/unread")).data?.total || 0;
  ck("已读后未读数归零", afterRead === 0, `unread=${afterRead}`);

  // 清理：删掉测试帖。话题没有删除端点（话题下架用 status=2 停用），
  // 所以这里把测试话题停用而不是删除 —— 顺便验证停用后不再接受新帖。
  await call("DELETE", `/api/community/posts/${pid}`);
  if (t2.data?.id) {
    const off = await call("PUT", `/api/community/topics/${t2.data.id}`, { status: 2 }, HM);
    ck("停用话题成功（话题下架用停用而非删除）", off.status === 200, JSON.stringify(off.body)?.slice(0, 160));
    const blocked = await post("/api/community/posts", { title: "停用后不应能发帖", content: "x", topic_id: t2.data.id });
    ck("停用的话题不再接受新帖", blocked.status !== 200, `HTTP ${blocked.status}`);
  }
} else {
  ck("他人评论后产生通知", true, "（只有一个用户，跳过）");
  ck("他人点赞后产生通知", true, "（跳过）");
  ck("自己的操作不给自己发通知", true, "（跳过）");
  ck("通知列表含触发者与文案", true, "（跳过）");
  ck("标记全部已读", true, "（跳过）");
  ck("已读后未读数归零", true, "（跳过）");
}

/* ============================ 聊天搜索 ============================ */
console.log("聊天搜索");
const searchRoom = await post("/api/chatroom/rooms", { type: "group", name: `搜索测试群_${runId}`, user_ids: [other.id] });
const srid = searchRoom.data?.id;
if (srid) {
  const keyword = `keyword_${runId}`;
  await post(`/api/chatroom/rooms/${srid}/messages`, { type: "text", content: `这里有一句独一无二的关键词 ${keyword}` });
  const found = await get(`/api/chatroom/search?q=${keyword}`);
  ck("能搜到自己会话里的消息", found.status === 200 && (found.data?.items || []).length > 0, JSON.stringify(found.body)?.slice(0, 200));
  ck("搜索结果带会话标题（便于定位）", (found.data?.items || []).every((m) => m.room_title), JSON.stringify(found.data?.items?.[0])?.slice(0, 160));
  const none = await get("/api/chatroom/search?q=不存在的关键词zzz999");
  ck("无匹配时返回空数组而不是报错", none.status === 200 && (none.data?.items || []).length === 0);
  // 空关键词不搜（避免全表 LIKE）
  const empty = await get("/api/chatroom/search?q=");
  ck("空关键词直接返回空（不做全表扫描）", empty.status === 200 && (empty.data?.items || []).length === 0);
  await call("DELETE", `/api/chatroom/rooms/${srid}`);
} else {
  ck("能搜到自己会话里的消息", false, "建房失败");
  ck("搜索结果带会话标题（便于定位）", false, "建房失败");
  ck("无匹配时返回空数组而不是报错", false, "建房失败");
  ck("空关键词直接返回空（不做全表扫描）", false, "建房失败");
}

/* ============================ 好友 / 私聊 ============================ */
console.log("好友与群聊交互");
const friendRequest = await post("/api/friends/requests", { to_user_id: other.id, message: "本轮好友验收" });
const friendRequestId = requiredId(friendRequest, "发送好友申请");
ck("好友申请进入待处理状态", friendRequest.data?.status === "pending");
const pending = await call("GET", "/api/friends/requests", undefined, HO);
ck("对方可读到本轮好友申请", pending.data?.incoming?.some((r) => Number(r.id) === friendRequestId));
const accepted = await call("PUT", "/api/friends/requests/" + friendRequestId, { action: "accept" }, HO);
ck("对方同意好友申请", accepted.status === 200 && accepted.data?.status === "accepted");
const friendList = await get("/api/friends");
ck("双向好友落库", Array.isArray(friendList.data) && friendList.data.some((u) => Number(u.id) === other.id));
const remark = await call("PUT", "/api/friends/" + other.id + "/remark", { remark: "本轮备注" });
ck("好友备注保存", remark.status === 200 && remark.data?.remark === "本轮备注");
const friendChat = await post("/api/friends/" + other.id + "/chat", {});
const friendRoomId = Number(friendChat.data?.room_id);
ck("好友入口复用可达的私聊", friendChat.status === 200 && friendRoomId > 0);
if (friendRoomId) ownedRooms.add(friendRoomId);
const friendRoom = await get("/api/chatroom/rooms/" + friendRoomId);
ck("私聊详情含对方及备注", friendRoom.status === 200 && Number(friendRoom.data?.peer?.id) === other.id && friendRoom.data?.title === "本轮备注");
const removeFriend = await call("DELETE", "/api/friends/" + other.id);
const relation = await get("/api/friends/relation/" + other.id);
ck("解除好友关系同步状态", removeFriend.status === 200 && relation.data?.relation === "none");

const announcement = await call("PUT", "/api/chatroom/rooms/" + roomId + "/announcement", { announcement: "本轮群公告" });
ck("群主可更新公告", announcement.status === 200 && announcement.data?.announcement === "本轮群公告");
const rename = await call("PUT", "/api/chatroom/rooms/" + roomId + "/name", { name: "e2e_" + runId + "_renamed" });
ck("群主可改群名", rename.status === 200);
const memberAnnouncement = await call("PUT", "/api/chatroom/rooms/" + roomId + "/announcement", { announcement: "不得保存" }, HO);
ck("普通群成员不能改公告", memberAnnouncement.status === 403);
const kick = await call("DELETE", "/api/chatroom/rooms/" + roomId + "/members/" + other.id);
ck("群主可移除本轮群成员", kick.status === 200);
const kickedMessages = await call("GET", "/api/chatroom/rooms/" + roomId + "/messages", undefined, HO);
ck("被移除成员不能读原群消息", kickedMessages.status === 403);
const reinvite = await post("/api/chatroom/rooms/" + roomId + "/members", { user_ids: [other.id] });
ck("群主可重新邀请成员", reinvite.status === 200 && reinvite.data?.added === 1);

/* ============================ 父帖权限 ============================ */
console.log("父帖可见性");
const hidden = await call("POST", "/api/community/posts/" + postId + "/moderate", { status: 3 }, HM);
ck("管理员可隐藏本轮帖子", hidden.status === 200);
const hiddenDetail = await call("GET", "/api/community/posts/" + postId, undefined, HO);
const hiddenComments = await call("GET", "/api/community/posts/" + postId + "/comments", undefined, HO);
ck("他人不能读取隐藏帖子或评论", hiddenDetail.status === 404 && hiddenComments.status === 404);
const authorComments = await get("/api/community/posts/" + postId + "/comments");
ck("作者仍能回看隐藏帖评论", authorComments.status === 200 && authorComments.data?.items?.length > 0);
const restored = await call("POST", "/api/community/posts/" + postId + "/moderate", { status: 1 }, HM);
ck("管理员可恢复本轮帖子", restored.status === 200, `HTTP ${restored.status} ${restored.body?.message || ""}`);
const removed = await call("DELETE", "/api/community/posts/" + postId);
const deletedComments = await call("GET", "/api/community/posts/" + postId + "/comments", undefined, HO);
ck("他人不能读取已删帖评论", removed.status === 200 && deletedComments.status === 404);

/* ============================ 已下线入口 ============================ */
console.log("已下线游戏入口");
ck("游戏目录已移除（404）", (await get("/api/games/list")).status === 404);
ck("游戏建房接口已移除（404）", (await post("/api/games/rooms", { game_key: "connect4" })).status === 404);

/* ==================== 个人主页：公开字段边界 ==================== */
console.log("\n个人主页");
const pub = await call("GET", `/api/profile/u/${actor.id}`, undefined, {}); // 刻意匿名
ck("个人主页匿名可访问", pub.status === 200, `HTTP ${pub.status}`);
const pubBody = pub.body;
ck("匿名响应不含邮箱", !pubBody?.data?.email, `email=${pubBody?.data?.email}`);
ck("匿名响应不含余额/用量", pubBody?.data?.stats?.usage === undefined);
ck("匿名响应含公开资料与统计", Boolean(pubBody?.data?.username) && typeof pubBody?.data?.stats?.posts === "number");

const selfProfile = await get("/api/profile/me");
ck("本人可读到自己主页（含用量）", selfProfile.status === 200 && selfProfile.data?.stats?.usage !== undefined);

const postsOf = await call("GET", `/api/profile/u/${actor.id}/posts`, undefined, {});
ck("某人帖子列表匿名可读", postsOf.status === 200);

/* ============================ 看板 ============================ */
console.log("\n看板");
const selfDash = await get("/api/dashboard/self?range=30d");
ck("个人看板可读且含趋势与模型", selfDash.status === 200 && Array.isArray(selfDash.data?.trend) && Array.isArray(selfDash.data?.by_model));
ck("个人看板含 24 格按小时分布", (selfDash.data?.by_hour || []).length === 24, `len=${selfDash.data?.by_hour?.length}`);

const adminDash = await call("GET", "/api/dashboard/admin?range=30d", undefined, HM);
ck("管理端看板可读且含用户排行", adminDash.status === 200 && Array.isArray(adminDash.data?.top_users));

if (HO) {
  const denied = await call("GET", "/api/dashboard/admin?range=30d", undefined, HO);
  ck("普通用户访问管理看板被拒（403）", denied.status === 403, `HTTP ${denied.status}`);
} else {
  ck("普通用户访问管理看板被拒（403）", true, "（只有一个用户，跳过）");
}

const analysis = await get("/api/log/usage/analysis?days=30");
ck(
  "使用分析含 modelSeries 与 hourly（多折线/热点图数据源）",
  analysis.status === 200 && Array.isArray(analysis.data?.modelSeries) && Array.isArray(analysis.data?.hourly),
  JSON.stringify(Object.keys(analysis.data || {}))
);

/* ==================== 权限分层 ==================== */
console.log("\n权限分层");
if (HO) {
  const noSuper = await call("PUT", "/api/option/", { key: "smtp_host", value: "x" }, HO);
  ck("普通用户改设置被拒", noSuper.status === 403, `HTTP ${noSuper.status}`);

  const roleChange = await call("PUT", `/api/users/${actor.id}`, { role: 1000 }, HO);
  ck("普通用户改角色被拒", roleChange.status === 403, `HTTP ${roleChange.status}`);
} else {
  ck("普通用户改设置被拒", true, "（跳过）");
  ck("普通用户改角色被拒", true, "（跳过）");
}

/* ============================ 清理 ============================ */
} catch (e) {
  ck("模块门禁完整执行", false, e.message);
} finally {
  console.log("\n清理");
  try {
    await cleanup();
  } catch (e) {
    ck("本轮清理成功（失败已回滚）", false, e.message);
  }
  await pool.end().catch(() => {});
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
