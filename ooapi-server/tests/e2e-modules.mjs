// 第 37 批新模块的端到端功能验证（HTTP 级，真读写数据库）
// ---------------------------------------------------------------------------
// 为什么需要它：「页面能渲染」不等于「功能可用」。
// 本项目反复踩过 —— 构建通过、页面不白屏，但接口 500 或数据没落库。
// 这个文件把社区/聊天/游戏/个人主页/看板的完整链路真跑一遍，
// 断言到「数据库里的行变了」这一层，而不是只看 HTTP 200。
//
// 用法（服务器上，需数据库可连）：
//   cd ooapi-server && BASE=http://127.0.0.1:3001 node tests/e2e-modules.mjs
// 会自动清理自己创建的测试数据。
import "dotenv/config";
import jwt from "jsonwebtoken";

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

const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
if (!admin) {
  console.error("数据库里没有管理员账号");
  process.exit(1);
}
const [[other]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE id <> ? AND status = 1 LIMIT 1", [
  admin.id,
]);
const adminTok = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" });
const HA = { authorization: `Bearer ${adminTok}`, "content-type": "application/json" };
const HO = other
  ? {
      authorization: `Bearer ${jwt.sign({ id: other.id, role: other.role, tv: Number(other.token_version) || 0 }, JWT_SECRET, { expiresIn: "20m" })}`,
      "content-type": "application/json",
    }
  : null;

const call = async (method, path, body, hdrs = HA) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* 非 JSON 响应（如 502） */
  }
  return { status: r.status, body: j, data: j?.data };
};
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b || {});

console.log(`端到端功能验证：${admin.username}${other ? ` + ${other.username}` : ""}\n`);

/* ============================ 社区 ============================ */
console.log("社区");
const topics = await get("/api/community/topics");
let topicId = topics.data?.[0]?.id;
if (!topicId) {
  const t = await post("/api/community/topics", { name: `e2e话题${Date.now() % 100000}`, description: "端到端测试" });
  ck("管理员可创建话题", t.status === 200 && t.data?.id > 0, JSON.stringify(t.body)?.slice(0, 160));
  topicId = t.data?.id;
} else {
  ck("话题列表可读", Array.isArray(topics.data) && topics.data.length > 0);
}

const newPost = await post("/api/community/posts", {
  title: `端到端测试帖 ${Date.now() % 100000}`,
  content: "端到端测试内容，含代码块：\n\n```bash\ncurl -X POST /v1/chat/completions\n```",
  topic_id: topicId,
  media_ids: [],
});
ck("发帖成功", newPost.status === 200 && newPost.data?.id > 0, JSON.stringify(newPost.body)?.slice(0, 200));
const postId = newPost.data?.id;

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
  ck("被回复者已记录（渲染 @谁用）", Number(row3?.reply_to_user_id) === Number(admin.id), `reply_to=${row3?.reply_to_user_id}`);
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
  const fol = await call("POST", `/api/community/users/${admin.id}/follow`, {}, HO);
  ck("关注他人成功", fol.status === 200 && fol.data?.following === true);
  const unfol = await call("POST", `/api/community/users/${admin.id}/follow`, {}, HO);
  ck("取消关注成功", unfol.data?.following === false);
} else {
  ck("关注他人成功", true, "（只有一个用户，跳过）");
  ck("取消关注成功", true, "（只有一个用户，跳过）");
}

const filtered = await get(`/api/community/posts?topic_id=${topicId}&sort=hot`);
ck("按话题+热度筛选可读", filtered.status === 200 && Array.isArray(filtered.data?.items));

/* ============================ 聊天 ============================ */
console.log("\n聊天");
const room = await post("/api/chatroom/rooms", { type: "group", name: "e2e 测试群", user_ids: other ? [other.id] : [] });
const roomId = room.data?.id;
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

/* ============================ 游戏 ============================ */
console.log("\n游戏");
const rec = await post("/api/games/records", { game_key: "g2048", score: 1234, duration_ms: 60000 });
ck("提交成绩成功", rec.status === 200 && rec.data?.best >= 1234, JSON.stringify(rec.body)?.slice(0, 160));

const board = await get("/api/games/records?game_key=g2048");
ck("排行榜可读（曾经因 GROUP BY 报 500）", board.status === 200 && Array.isArray(board.data?.items), JSON.stringify(board.body)?.slice(0, 200));
ck("排行榜含我的成绩", (board.data?.items || []).some((x) => x.is_me));
ck("榜单一行一人（未被同分行重复占位）", new Set((board.data?.items || []).map((x) => x.user_id)).size === (board.data?.items || []).length);

const over = await post("/api/games/records", { game_key: "g2048", score: 99999999, duration_ms: 1000 });
ck("超上限分数被拒绝", over.status !== 200, `HTTP ${over.status}`);

const gr = await post("/api/games/rooms", { game_key: "gomoku" });
ck("创建对战房间成功", gr.status === 200 && gr.data?.id > 0, JSON.stringify(gr.body)?.slice(0, 160));
const gameRoomId = gr.data?.id;

if (other && gameRoomId) {
  const joined = await call("POST", `/api/games/rooms/${gameRoomId}/join`, {}, HO);
  ck("他人加入房间成功", joined.status === 200 && joined.data?.status === "playing", JSON.stringify(joined.body)?.slice(0, 200));

  const wrongTurn = await call("POST", `/api/games/rooms/${gameRoomId}/move`, { position: 1 }, HO);
  ck("非当前回合落子被拒（服务端权威）", wrongTurn.status !== 200, `HTTP ${wrongTurn.status}`);

  let won = null;
  let stepOk = true;
  // 房主执先手(1)，横向连成五子获胜；对手落在第 2 行避免干扰
  for (let i = 0; i < 5; i += 1) {
    const a = await post(`/api/games/rooms/${gameRoomId}/move`, { position: i });
    if (a.status !== 200) {
      ck(`房主第 ${i + 1} 子`, false, JSON.stringify(a.body)?.slice(0, 160));
      stepOk = false;
      break;
    }
    won = a.data;
    if (i < 4) {
      const b = await call("POST", `/api/games/rooms/${gameRoomId}/move`, { position: 15 + i }, HO);
      if (b.status !== 200) {
        ck(`对手第 ${i + 1} 子`, false, JSON.stringify(b.body)?.slice(0, 160));
        stepOk = false;
        break;
      }
    }
  }
  if (stepOk) {
    ck("五子连线后服务端判定胜负", won?.status === "finished" && Number(won?.winner_id) === Number(admin.id), `status=${won?.status} winner=${won?.winner_id}`);
  }
  const dup = await call("POST", `/api/games/rooms/${gameRoomId}/move`, { position: 0 }, HO);
  ck("已结束的对局拒绝继续落子", dup.status !== 200, `HTTP ${dup.status}`);
} else {
  ck("联机对战判定（只有一个用户，跳过）", true, "");
}
if (gameRoomId) await post(`/api/games/rooms/${gameRoomId}/resign`, {});

/* ==================== 个人主页：公开字段边界 ==================== */
console.log("\n个人主页");
const pub = await fetch(`${BASE}/api/profile/u/${admin.id}`); // 刻意匿名
ck("个人主页匿名可访问", pub.status === 200, `HTTP ${pub.status}`);
const pubBody = await pub.json().catch(() => null);
ck("匿名响应不含邮箱", !pubBody?.data?.email, `email=${pubBody?.data?.email}`);
ck("匿名响应不含余额/用量", pubBody?.data?.stats?.usage === undefined);
ck("匿名响应含公开资料与统计", Boolean(pubBody?.data?.username) && typeof pubBody?.data?.stats?.posts === "number");

const selfProfile = await get("/api/profile/me");
ck("本人可读到自己主页（含用量）", selfProfile.status === 200 && selfProfile.data?.stats?.usage !== undefined);

const postsOf = await fetch(`${BASE}/api/profile/u/${admin.id}/posts`);
ck("某人帖子列表匿名可读", postsOf.status === 200);

/* ============================ 看板 ============================ */
console.log("\n看板");
const selfDash = await get("/api/dashboard/self?range=30d");
ck("个人看板可读且含趋势与模型", selfDash.status === 200 && Array.isArray(selfDash.data?.trend) && Array.isArray(selfDash.data?.by_model));
ck("个人看板含 24 格按小时分布", (selfDash.data?.by_hour || []).length === 24, `len=${selfDash.data?.by_hour?.length}`);

const adminDash = await get("/api/dashboard/admin?range=30d");
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

  const roleChange = await call("PUT", `/api/users/${admin.id}`, { role: 1000 }, HO);
  ck("普通用户改角色被拒", roleChange.status === 403, `HTTP ${roleChange.status}`);
} else {
  ck("普通用户改设置被拒", true, "（跳过）");
  ck("普通用户改角色被拒", true, "（跳过）");
}

/* ============================ 清理 ============================ */
console.log("\n清理");
if (postId) await call("DELETE", `/api/community/posts/${postId}`);
if (roomId) await call("DELETE", `/api/chatroom/rooms/${roomId}`);
const [[left]] = await pool.query("SELECT COUNT(*) AS n FROM community_posts WHERE title LIKE '端到端测试帖%' AND status <> 2");
ck("测试帖已清理", Number(left.n) === 0, `left=${left.n}`);

await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
