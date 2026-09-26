// 好友系统 + 私聊/群聊 行为测试（替代原 friends-channels.test.mjs；频道体系已于第 79 批下线）
// ---------------------------------------------------------------------------
// 用一个「有状态」的内存 SQL 桩跑真实路由（express + 真 JWT），覆盖这次改动的易错分支：
//   1. 好友申请：不能加自己 / 重复申请只更新 / 互相申请自动成为好友 / 撤回
//   2. 关系查询 /friends/relation/:id 的五种状态
//   3. 单聊唯一：同一对用户重复打开只有一个房间；一方「删除会话」后再打开能复活并补回成员；
//      对方删除会话后我发消息会把他补回来（否则他永远收不到）
//   4. 群聊：建群、公告、改名；私聊不能设公告/改名
//   5. 频道接口 /chatroom/guilds 已下线（404），/online 只返回社交圈
// 桩只认本文件用到的 SQL 片段；遇到没认出的 SQL 会打印出来，方便改路由时同步桩。
import http from "node:http";
import express from "express";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import friendsRoutes from "../src/routes/friends.js";
import chatroomRoutes from "../src/routes/chatroom.js";
import { register } from "../src/services/realtime.js";

let pass = 0;
let failCount = 0;
const ck = (n, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    failCount++;
    console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`);
  }
};

const ts = () => Math.floor(Date.now() / 1000);
const db = {
  users: [1, 2, 3, 4].map((id) => ({
    id, username: `user${id}`, display_name: ["", "Alice", "Bob", "Carol", "Dave"][id],
    status: id === 4 ? 2 : 1, avatar_media_id: 0, bio: "", role: 1, token_version: 0,
  })),
  friendships: [],
  friend_requests: [],
  chat_rooms: [],
  chat_room_members: [],
  chat_room_messages: [],
};
let nextId = 100;
const unhandled = new Set();
const members = (roomId) => db.chat_room_members.filter((m) => m.room_id === roomId);
const room = (id) => db.chat_rooms.find((r) => r.id === id);
const user = (id) => db.users.find((u) => u.id === Number(id));

pool.query = async (sql, p = []) => {
  const s = String(sql).replace(/\s+/g, " ").trim();
  const has = (frag) => s.includes(frag);

  // ---------- users ----------
  if (/FROM users WHERE id = \?$/.test(s) || /FROM users WHERE id = \? /.test(s)) return [[user(p[0]) || undefined].filter(Boolean)];
  if (has("FROM users WHERE status = 1 AND id IN")) return [db.users.filter((u) => u.status === 1 && p.includes(u.id))];

  // ---------- friendships ----------
  if (has("SELECT f.friend_id")) {
    return [db.friendships.filter((f) => f.user_id === p[0] && f.status === 1).map((f) => ({ ...user(f.friend_id), friend_id: f.friend_id, remark: f.remark, created_time: f.created_time }))];
  }
  if (has("FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 1")) {
    return [db.friendships.filter((f) => f.user_id === p[0] && f.friend_id === p[1] && f.status === 1)];
  }
  if (has("SELECT friend_id, remark FROM friendships")) {
    return [db.friendships.filter((f) => f.user_id === p[0] && f.status === 1 && p.slice(1).includes(f.friend_id))];
  }
  if (has("INSERT INTO friendships")) {
    for (const [a, b, t] of [[p[0], p[1], p[2]], [p[3], p[4], p[5]]]) {
      const row = db.friendships.find((f) => f.user_id === a && f.friend_id === b);
      if (row) { row.status = 1; row.created_time = t; } else db.friendships.push({ id: ++nextId, user_id: a, friend_id: b, remark: "", status: 1, created_time: t });
    }
    return [{ affectedRows: 2 }];
  }
  if (has("UPDATE friendships SET remark = ?")) {
    const r = db.friendships.find((f) => f.user_id === p[1] && f.friend_id === p[2] && f.status === 1);
    if (r) r.remark = p[0];
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (has("UPDATE friendships SET status = 2")) {
    for (const f of db.friendships) if ((f.user_id === p[0] && f.friend_id === p[1]) || (f.user_id === p[2] && f.friend_id === p[3])) f.status = 2;
    return [{ affectedRows: 2 }];
  }

  // ---------- friend_requests ----------
  if (has("FROM friend_requests r") && has("WHERE r.to_user_id = ?")) {
    return [db.friend_requests.filter((r) => r.to_user_id === p[0] && r.status === 0).map((r) => ({ ...user(r.from_user_id), ...r }))];
  }
  if (has("FROM friend_requests r") && has("WHERE r.from_user_id = ?")) {
    return [db.friend_requests.filter((r) => r.from_user_id === p[0]).map((r) => ({ ...user(r.to_user_id), ...r }))];
  }
  if (has("FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 0")) {
    return [db.friend_requests.filter((r) => r.from_user_id === p[0] && r.to_user_id === p[1] && r.status === 0)];
  }
  if (has("SELECT id, from_user_id FROM friend_requests")) {
    return [db.friend_requests.filter((r) => r.status === 0 && ((r.from_user_id === p[0] && r.to_user_id === p[1]) || (r.from_user_id === p[2] && r.to_user_id === p[3]))).reverse()];
  }
  if (has("INSERT INTO friend_requests")) {
    const item = { id: ++nextId, from_user_id: p[0], to_user_id: p[1], message: p[2], status: 0, created_time: p[3], handled_time: 0 };
    db.friend_requests.push(item);
    return [{ insertId: item.id }];
  }
  if (has("UPDATE friend_requests SET message = ?")) {
    const r = db.friend_requests.find((x) => x.id === p[2]);
    if (r) { r.message = p[0]; r.created_time = p[1]; }
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (has("FROM friend_requests WHERE id = ? AND to_user_id = ?")) {
    return [db.friend_requests.filter((r) => r.id === p[0] && r.to_user_id === p[1])];
  }
  if (has("UPDATE friend_requests SET status = 1") && has("WHERE status = 0 AND")) {
    let n = 0;
    for (const r of db.friend_requests) {
      if (r.status === 0 && ((r.from_user_id === p[1] && r.to_user_id === p[2]) || (r.from_user_id === p[3] && r.to_user_id === p[4]))) { r.status = 1; r.handled_time = p[0]; n++; }
    }
    return [{ affectedRows: n }];
  }
  if (has("UPDATE friend_requests SET status = 2")) {
    const r = db.friend_requests.find((x) => x.id === p[1]);
    if (r) { r.status = 2; r.handled_time = p[0]; }
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (has("UPDATE friend_requests SET status = 3")) {
    const r = db.friend_requests.find((x) => x.id === p[1] && x.from_user_id === p[2] && x.status === 0);
    if (r) { r.status = 3; r.handled_time = p[0]; }
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (has("INSERT INTO notifications")) return [{ insertId: ++nextId }];

  // ---------- 社交圈（在线状态可见范围） ----------
  if (has("SELECT friend_id AS uid FROM friendships") && has("UNION")) {
    const ids = new Set(db.friendships.filter((f) => f.user_id === p[0] && f.status === 1).map((f) => f.friend_id));
    for (const m of db.chat_room_members.filter((x) => x.user_id === p[2])) {
      if (room(m.room_id)?.type !== "single") continue;
      for (const o of members(m.room_id)) if (o.user_id !== p[1]) ids.add(o.user_id);
    }
    return [[...ids].map((uid) => ({ uid }))];
  }

  // ---------- chat_rooms ----------
  if (has("SELECT id FROM chat_rooms WHERE single_key = ? LIMIT 1")) return [db.chat_rooms.filter((r) => r.single_key === p[0])];
  if (has("UPDATE chat_rooms SET status = 1 WHERE id = ?")) { room(p[0]).status = 1; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET status = 2 WHERE id = ?")) { room(p[0]).status = 2; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET member_count = (SELECT COUNT(*)")) { room(p[1]).member_count = members(p[0]).length; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET member_count = 2")) { room(p[0]).member_count = 2; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET member_count = member_count + ?")) { room(p[1]).member_count += p[0]; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET member_count = GREATEST")) { room(p[0]).member_count = Math.max(0, room(p[0]).member_count - 1); return [{ affectedRows: 1 }]; }
  if (has("INSERT INTO chat_rooms (type, name, owner_id, member_count, single_key")) {
    if (db.chat_rooms.some((r) => r.single_key === p[1])) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
    const item = { id: ++nextId, type: "single", name: "", owner_id: p[0], member_count: 2, single_key: p[1], status: 1, announcement: "", created_time: p[2], last_message_time: 0 };
    db.chat_rooms.push(item);
    return [{ insertId: item.id }];
  }
  if (has("INSERT INTO chat_rooms (type, name, owner_id, member_count, status")) {
    const item = { id: ++nextId, type: p[0], name: p[1], owner_id: p[2], member_count: p[3], single_key: null, status: 1, announcement: "", created_time: p[4], last_message_time: 0 };
    db.chat_rooms.push(item);
    return [{ insertId: item.id }];
  }
  if (has("SELECT id, type, single_key, status FROM chat_rooms WHERE id = ?")) return [[room(p[0])].filter(Boolean)];
  if (has("SELECT type, status FROM chat_rooms WHERE id = ?")) return [[room(p[0])].filter(Boolean)];
  if (has("SELECT * FROM chat_rooms WHERE id = ? AND status = 1")) return [[room(p[0])].filter((r) => r && r.status === 1)];
  if (has("SELECT * FROM chat_rooms WHERE id = ?")) return [[room(p[0])].filter(Boolean)];
  if (has("UPDATE chat_rooms SET announcement = ?")) { room(p[1]).announcement = p[0]; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET name = ?")) { room(p[1]).name = p[0]; return [{ affectedRows: 1 }]; }
  if (has("UPDATE chat_rooms SET last_message_id")) { const r = room(p[3]); r.last_message_text = p[1]; r.last_message_time = p[2]; return [{ affectedRows: 1 }]; }
  if (has("SELECT COUNT(*) AS n FROM chat_room_members m JOIN chat_rooms r")) {
    return [[{ n: db.chat_room_members.filter((m) => m.user_id === p[0] && room(m.room_id)?.status === 1).length }]];
  }
  if (has("SELECT r.*, m.role AS my_role")) {
    const mine = db.chat_room_members.filter((m) => m.user_id === p[1] && room(m.room_id)?.status === 1);
    return [mine.map((m) => ({ ...room(m.room_id), my_role: m.role, muted: 0, last_read_id: 0, unread: 0 }))];
  }

  // ---------- chat_room_members ----------
  if (has("SELECT * FROM chat_room_members WHERE room_id = ? AND user_id = ?")) {
    return [db.chat_room_members.filter((m) => m.room_id === p[0] && m.user_id === p[1])];
  }
  if (has("INSERT IGNORE INTO chat_room_members") || has("INSERT INTO chat_room_members")) {
    let n = 0;
    for (let i = 0; i + 2 < p.length + 1; i += 3) {
      const [rid, uid] = [p[i], p[i + 1]];
      if (rid === undefined) break;
      const roleMatch = s.match(/VALUES (.*)$/)[1].split("),")[i / 3] || "";
      const role = roleMatch.includes("'owner'") ? "owner" : "member";
      if (members(rid).some((m) => m.user_id === uid)) {
        if (!has("IGNORE")) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
        continue;
      }
      db.chat_room_members.push({ id: ++nextId, room_id: rid, user_id: uid, role, last_read_id: 0, muted: 0 });
      n++;
    }
    return [{ affectedRows: n }];
  }
  if (has("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?")) {
    db.chat_room_members = db.chat_room_members.filter((m) => !(m.room_id === p[0] && m.user_id === p[1]));
    return [{ affectedRows: 1 }];
  }
  if (has("SELECT user_id FROM chat_room_members WHERE room_id = ? ORDER BY id ASC LIMIT 1")) return [members(p[0]).slice(0, 1)];
  if (has("SELECT user_id FROM chat_room_members WHERE room_id = ?")) return [members(p[0])];
  if (has("FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id IN")) {
    const ids = p.slice(0, -1);
    return [db.chat_room_members.filter((m) => ids.includes(m.room_id) && m.user_id !== p[p.length - 1]).map((m) => ({ room_id: m.room_id, ...user(m.user_id) }))];
  }
  if (has("FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?")) {
    return [members(p[0]).map((m) => ({ user_id: m.user_id, role: m.role, ...user(m.user_id) }))];
  }
  if (has("UPDATE chat_room_members SET last_read_id")) return [{ affectedRows: 1 }];

  // ---------- chat_room_messages ----------
  if (has("INSERT INTO chat_room_messages")) {
    const item = { id: ++nextId, room_id: p[0], user_id: has("VALUES (?, 0, 'system'") ? 0 : p[1] };
    db.chat_room_messages.push(item);
    return [{ insertId: item.id }];
  }

  unhandled.add(s.slice(0, 110));
  return [[]];
};

const app = express();
app.use(express.json());
app.use("/api/friends", friendsRoutes);
app.use("/api/chatroom", chatroomRoutes);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let me = 1;
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(user(me))}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const as = (id) => { me = id; };

console.log("=== 好友系统 + 私聊/群聊 行为测试 ===\n");
try {
  console.log("--- 1. 好友申请 ---");
  {
    as(1);
    const self = await call("POST", "/api/friends/requests", { to_user_id: 1 });
    ck("不能向自己发送好友申请", self.json?.success === false);
    const banned = await call("POST", "/api/friends/requests", { to_user_id: 4 });
    ck("不能申请已禁用账号", banned.status === 404);
    const long = await call("POST", "/api/friends/requests", { to_user_id: 2, message: "x".repeat(201) });
    ck("验证消息超长报错而不是静默截断", long.json?.success === false && /200/.test(long.json?.message || ""));
    const r1 = await call("POST", "/api/friends/requests", { to_user_id: 2, message: "你好" });
    const r2 = await call("POST", "/api/friends/requests", { to_user_id: 2, message: "再打个招呼" });
    ck("重复申请复用同一条记录", r1.json?.data?.id && r1.json?.data?.id === r2.json?.data?.id);
    ck("重复申请只更新留言", db.friend_requests.filter((r) => r.from_user_id === 1 && r.to_user_id === 2).length === 1 && db.friend_requests[0].message === "再打个招呼");

    const rel = await call("GET", "/api/friends/relation/2");
    ck("关系：我已申请 → pending_out", rel.json?.data?.relation === "pending_out");
    as(2);
    const rel2 = await call("GET", "/api/friends/relation/1");
    ck("关系：对方申请了我 → pending_in", rel2.json?.data?.relation === "pending_in");

    // 互相申请：B 反向申请 A → 直接成为好友，且 A 的那条申请被标记为已同意
    const mutual = await call("POST", "/api/friends/requests", { to_user_id: 1 });
    ck("互相申请直接成为好友", mutual.json?.data?.status === "accepted");
    ck("原申请被一并标记为已同意（不会残留在「新的朋友」里）", db.friend_requests.every((r) => r.status !== 0));
    const list = await call("GET", "/api/friends");
    ck("B 的好友列表里有 Alice", list.json?.data?.some((f) => f.id === 1));
    const rel3 = await call("GET", "/api/friends/relation/1");
    ck("关系：friend", rel3.json?.data?.relation === "friend");
    const relSelf = await call("GET", "/api/friends/relation/2");
    ck("关系：self", relSelf.json?.data?.relation === "self");

    as(1);
    const toC = await call("POST", "/api/friends/requests", { to_user_id: 3 });
    const withdraw = await call("DELETE", `/api/friends/requests/${toC.json?.data?.id}`);
    ck("撤回未处理的申请", withdraw.json?.success === true);
    const relC = await call("GET", "/api/friends/relation/3");
    ck("撤回后关系回到 none", relC.json?.data?.relation === "none");
    const again = await call("DELETE", `/api/friends/requests/${toC.json?.data?.id}`);
    ck("已撤回的申请不能再撤", again.status === 404);

    const remark = await call("PUT", "/api/friends/2/remark", { remark: "老 Bob" });
    ck("修改备注", remark.json?.data?.remark === "老 Bob");
  }

  console.log("\n--- 2. 单聊唯一 / 复活 / 补回成员 ---");
  let singleId;
  {
    as(1);
    const a = await call("POST", "/api/friends/2/chat");
    const b = await call("POST", "/api/chatroom/rooms", { type: "single", user_id: 2 });
    singleId = a.json?.data?.room_id;
    ck("好友入口与通用入口指向同一个单聊房间", singleId && singleId === b.json?.data?.id);
    ck("同一对用户只有一个单聊房间", db.chat_rooms.filter((r) => r.type === "single").length === 1);
    const ghost = await call("POST", "/api/friends/999/chat");
    ck("与不存在的用户发起私聊被拒（原实现会建出幽灵房间）", ghost.status === 404);
    const banned = await call("POST", "/api/friends/4/chat");
    ck("与已禁用账号发起私聊被拒", banned.status === 404);

    const rooms = await call("GET", "/api/chatroom/rooms");
    const it = rooms.json?.data?.items?.find((r) => r.id === singleId);
    ck("会话列表里单聊标题优先用好友备注", it?.title === "老 Bob");
    const detail = await call("GET", `/api/chatroom/rooms/${singleId}`);
    ck("房间详情带 peer（顶栏在线状态依赖它）", detail.json?.data?.peer?.id === 2);
    ck("房间详情里 peer 标注了好友关系", detail.json?.data?.peer?.is_friend === true);

    // A 删除会话 → 再点「发私信」能回到同一个房间且重新是成员
    const leave = await call("DELETE", `/api/chatroom/rooms/${singleId}/members/me`);
    ck("删除单聊会话", leave.json?.success === true);
    ck("删除单聊不发「退出了群聊」系统消息", !db.chat_room_messages.some((m) => m.room_id === singleId && m.user_id === 0));
    const reopen = await call("POST", "/api/chatroom/rooms", { type: "single", user_id: 2 });
    ck("再打开复用原房间（历史消息还在）", reopen.json?.data?.id === singleId);
    ck("再打开时自己被补回成员", members(singleId).some((m) => m.user_id === 1));

    // B 删除会话后，A 发消息 → B 被补回（否则 B 永远收不到）
    as(2);
    await call("DELETE", `/api/chatroom/rooms/${singleId}/members/me`);
    ck("B 已不在成员表", !members(singleId).some((m) => m.user_id === 2));
    as(1);
    const send = await call("POST", `/api/chatroom/rooms/${singleId}/messages`, { content: "在吗", client_id: "c1" });
    ck("A 仍能发消息", send.json?.success === true && send.json?.data?.client_id === "c1");
    ck("发消息把删除了会话的 B 补回成员", members(singleId).some((m) => m.user_id === 2));

    // 双方都删掉 → 房间被解散；再打开能复活而不是撞唯一键 500
    await call("DELETE", `/api/chatroom/rooms/${singleId}/members/me`);
    as(2);
    await call("DELETE", `/api/chatroom/rooms/${singleId}/members/me`);
    ck("双方都删除后房间为已解散", room(singleId).status === 2);
    const revive = await call("POST", "/api/friends/1/chat");
    ck("已解散的单聊能复活（不再撞唯一键 500）", revive.status === 200 && revive.json?.data?.room_id === singleId);
    ck("复活后房间恢复可用、双方都在", room(singleId).status === 1 && members(singleId).length === 2);
  }

  console.log("\n--- 3. 群聊 ---");
  {
    as(1);
    const noName = await call("POST", "/api/chatroom/rooms", { type: "group", user_ids: [2] });
    ck("建群必须有名称", noName.json?.success === false);
    const g = await call("POST", "/api/chatroom/rooms", { type: "group", name: "提示词研究", user_ids: [2, 3] });
    const gid = g.json?.data?.id;
    ck("建群成功并邀请 2 人", gid && g.json?.data?.invited === 2);
    ck("群主角色正确", members(gid).find((m) => m.user_id === 1)?.role === "owner");
    const ann = await call("PUT", `/api/chatroom/rooms/${gid}/announcement`, { announcement: "周五分享会" });
    ck("群主可改群公告", ann.json?.data?.announcement === "周五分享会");
    const annLong = await call("PUT", `/api/chatroom/rooms/${gid}/announcement`, { announcement: "x".repeat(501) });
    ck("公告超长报错", annLong.json?.success === false);
    const rn = await call("PUT", `/api/chatroom/rooms/${gid}/name`, { name: "Prompt 小组" });
    ck("群主可改群名", rn.json?.data?.name === "Prompt 小组");
    as(2);
    const annByMember = await call("PUT", `/api/chatroom/rooms/${gid}/announcement`, { announcement: "我来改" });
    ck("普通成员不能改公告", annByMember.status === 403);
    as(1);
    const singleAnn = await call("PUT", `/api/chatroom/rooms/${singleId}/announcement`, { announcement: "x" });
    ck("私聊不能设公告", singleAnn.json?.success === false);
    const singleRename = await call("PUT", `/api/chatroom/rooms/${singleId}/name`, { name: "x" });
    ck("私聊不能改名", singleRename.json?.success === false);
    const invite = await call("POST", `/api/chatroom/rooms/${singleId}/members`, { user_ids: [3] });
    ck("私聊不能拉人", invite.json?.success === false);
  }

  console.log("\n--- 4. 频道下线 / 在线状态可见范围 ---");
  {
    as(1);
    const guilds = await call("GET", "/api/chatroom/guilds");
    ck("/chatroom/guilds 已下线（404）", guilds.status === 404);
    // 模拟 2 号（好友）与 3 号（非好友、无单聊）都在线
    const fake = () => ({ write() { return true; }, on() {} });
    register(2, fake());
    register(3, fake());
    const online = await call("GET", "/api/chatroom/online");
    ck("在线列表包含好友", online.json?.data?.includes(2));
    ck("在线列表不泄露社交圈之外的人", !online.json?.data?.includes(3));
  }
} finally {
  await new Promise((r) => server.close(r));
}

if (unhandled.size) {
  console.log("\n桩未识别的 SQL（改了路由请同步桩）：");
  for (const s of unhandled) console.log(`  · ${s}`);
}
console.log(`\n测试汇总：通过 ${pass}，失败 ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
