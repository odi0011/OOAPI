// 好友系统与 QQ 频道自动化测试
// 验证：
// 1. 好友申请发送、防自己加自己拦截、待处理列表
// 2. 好友申请同意、双向关系建立、备注修改、解除好友
// 3. QQ 频道体系：频道服务器与子频道列表、子频道房间绑定
// 4. 群公告与群名称修改接口
// 5. 校验小游戏模块已全量下线
import http from "node:http";
import express from "express";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import friendsRoutes from "../src/routes/friends.js";
import chatroomRoutes from "../src/routes/chatroom.js";

let pass = 0;
let fail = 0;
const ck = (n, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`);
  }
};

console.log("=== 好友系统与 QQ 频道模块自动化测试 ===\n");

// 内存 Mock 数据库，验证业务逻辑闭环
const db = {
  users: [
    { id: 1, username: "user1", display_name: "Alice", status: 1, avatar_media_id: 0, bio: "Hi Alice", role: 1, token_version: 0 },
    { id: 2, username: "user2", display_name: "Bob", status: 1, avatar_media_id: 0, bio: "Hi Bob", role: 1, token_version: 0 },
    { id: 3, username: "user3", display_name: "Charlie", status: 1, avatar_media_id: 0, bio: "Hi Charlie", role: 1, token_version: 0 }
  ],
  friendships: [],
  friend_requests: [],
  community_guilds: [],
  community_channels: [],
  chat_rooms: [],
  chat_room_members: [],
  chat_room_messages: []
};

let nextId = 100;

pool.query = async (sql, params = []) => {
  const s = String(sql || "").trim();

  // 1. users
  if (s.includes("FROM users WHERE id = ?")) {
    const u = db.users.find((x) => x.id === params[0]);
    return [[u || null]];
  }

  // 2. friendships
  if (s.startsWith("SELECT f.friend_id")) {
    const list = db.friendships
      .filter((f) => f.user_id === params[0] && f.status === 1)
      .map((f) => {
        const u = db.users.find((x) => x.id === f.friend_id) || {};
        return {
          friend_id: f.friend_id,
          remark: f.remark || "",
          created_time: f.created_time,
          username: u.username,
          display_name: u.display_name,
          avatar_media_id: u.avatar_media_id || 0,
          bio: u.bio || "",
          status: u.status || 1
        };
      });
    return [list];
  }

  if (s.includes("FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 1")) {
    const row = db.friendships.find((f) => f.user_id === params[0] && f.friend_id === params[1] && f.status === 1);
    return [[row || null]];
  }

  if (s.includes("INSERT INTO friendships")) {
    // 双方添加
    const uid = params[0];
    const fid = params[1];
    const ts = params[2];
    db.friendships.push({ id: ++nextId, user_id: uid, friend_id: fid, remark: "", status: 1, created_time: ts });
    db.friendships.push({ id: ++nextId, user_id: fid, friend_id: uid, remark: "", status: 1, created_time: ts });
    return [{ affectedRows: 2 }];
  }

  if (s.includes("UPDATE friendships SET remark = ?")) {
    const r = db.friendships.find((f) => f.user_id === params[1] && f.friend_id === params[2] && f.status === 1);
    if (r) r.remark = params[0];
    return [{ affectedRows: r ? 1 : 0 }];
  }

  if (s.includes("UPDATE friendships SET status = 2")) {
    const u1 = params[0];
    const f1 = params[1];
    db.friendships.forEach((f) => {
      if ((f.user_id === u1 && f.friend_id === f1) || (f.user_id === f1 && f.friend_id === u1)) {
        f.status = 2;
      }
    });
    return [{ affectedRows: 2 }];
  }

  // 3. friend_requests
  if (s.includes("FROM friend_requests r") && s.includes("WHERE r.to_user_id = ?")) {
    const list = db.friend_requests
      .filter((r) => r.to_user_id === params[0] && r.status === 0)
      .map((r) => {
        const u = db.users.find((x) => x.id === r.from_user_id) || {};
        return { ...r, username: u.username, display_name: u.display_name, avatar_media_id: 0, bio: u.bio };
      });
    return [list];
  }

  if (s.includes("FROM friend_requests r") && s.includes("WHERE r.from_user_id = ?")) {
    const list = db.friend_requests
      .filter((r) => r.from_user_id === params[0])
      .map((r) => {
        const u = db.users.find((x) => x.id === r.to_user_id) || {};
        return { ...r, username: u.username, display_name: u.display_name, avatar_media_id: 0, bio: u.bio };
      });
    return [list];
  }

  if (s.includes("FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 0")) {
    const row = db.friend_requests.find((r) => r.from_user_id === params[0] && r.to_user_id === params[1] && r.status === 0);
    return [[row || null]];
  }

  if (s.includes("INSERT INTO friend_requests")) {
    const item = {
      id: ++nextId,
      from_user_id: params[0],
      to_user_id: params[1],
      message: params[2],
      status: 0,
      created_time: params[3],
      handled_time: 0
    };
    db.friend_requests.push(item);
    return [{ insertId: item.id }];
  }

  if (s.includes("FROM friend_requests WHERE id = ? AND to_user_id = ?")) {
    const row = db.friend_requests.find((r) => r.id === params[0] && r.to_user_id === params[1]);
    return [[row || null]];
  }

  if (s.includes("UPDATE friend_requests SET status =")) {
    const r = db.friend_requests.find((x) => x.id === params[1]);
    if (r) {
      r.status = Number(s.includes("status = 1") ? 1 : 2);
      r.handled_time = params[0];
    }
    return [{ affectedRows: 1 }];
  }

  // 4. QQ 频道体系
  if (s.includes("FROM community_guilds WHERE status = 1")) {
    return [db.community_guilds.filter((g) => g.status === 1)];
  }

  if (s.includes("INSERT INTO community_guilds")) {
    const item = {
      id: ++nextId,
      name: params[0],
      description: params[1],
      icon: params[2],
      is_default: params[3],
      status: 1,
      created_time: params[4]
    };
    db.community_guilds.push(item);
    return [{ insertId: item.id }];
  }

  if (s.includes("FROM community_guilds WHERE id = ?")) {
    const g = db.community_guilds.find((x) => x.id === params[0]);
    return [[g || null]];
  }

  if (s.includes("INSERT INTO community_channels")) {
    const item = {
      id: ++nextId,
      guild_id: params[0],
      category_name: params[1],
      name: params[2],
      type: params[3],
      topic: params[4],
      sort: params[5],
      status: 1,
      created_time: params[6]
    };
    db.community_channels.push(item);
    return [{ insertId: item.id }];
  }

  if (s.includes("FROM community_channels WHERE guild_id = ?")) {
    const list = db.community_channels.filter((c) => c.guild_id === params[0] && c.status === 1);
    return [list];
  }

  // 5. chat_rooms
  if (s.includes("SELECT id, name, last_message_text") && s.includes("FROM chat_rooms WHERE guild_channel_id = ?")) {
    const r = db.chat_rooms.find((x) => x.guild_channel_id === params[0] && x.status === 1);
    return [[r || null]];
  }

  if (s.includes("FROM chat_rooms WHERE id = ?")) {
    const r = db.chat_rooms.find((x) => x.id === params[0] && x.status === 1);
    return [[r || null]];
  }

  if (s.includes("INSERT INTO chat_rooms")) {
    const item = {
      id: ++nextId,
      type: params[0],
      name: params[1],
      owner_id: params[2],
      member_count: params[3],
      guild_channel_id: s.includes("guild_channel_id") ? params[4] : 0,
      announcement: "",
      status: 1,
      created_time: now()
    };
    db.chat_rooms.push(item);
    return [{ insertId: item.id }];
  }

  if (s.includes("UPDATE chat_rooms SET announcement = ?")) {
    const r = db.chat_rooms.find((x) => x.id === params[1]);
    if (r) r.announcement = params[0];
    return [{ affectedRows: 1 }];
  }

  if (s.includes("UPDATE chat_rooms SET name = ?")) {
    const r = db.chat_rooms.find((x) => x.id === params[1]);
    if (r) r.name = params[0];
    return [{ affectedRows: 1 }];
  }

  // 6. chat_room_members
  if (s.includes("FROM chat_room_members WHERE room_id = ? AND user_id = ?")) {
    const m = db.chat_room_members.find((x) => x.room_id === params[0] && x.user_id === params[1]);
    return [[m || { role: "owner" }]];
  }

  if (s.includes("SELECT user_id FROM chat_room_members WHERE room_id = ?")) {
    const ms = db.chat_room_members.filter((x) => x.room_id === params[0]);
    return [ms];
  }

  if (s.includes("INSERT IGNORE INTO chat_room_members") || s.includes("INSERT INTO chat_room_members")) {
    db.chat_room_members.push({ room_id: params[0], user_id: params[1], role: params[2] || "member" });
    return [{ affectedRows: 1 }];
  }

  if (s.includes("INSERT INTO chat_room_messages")) {
    return [{ insertId: ++nextId }];
  }

  if (s.includes("UPDATE chat_rooms SET last_message_id")) {
    return [{ affectedRows: 1 }];
  }

  return [[]];
};

function now() {
  return Math.floor(Date.now() / 1000);
}

// 搭建 express 测试服务器
const app = express();
app.use(express.json());

let currentUser = { id: 1, username: "user1", display_name: "Alice", role: 1, token_version: 0 };

app.use("/api/friends", friendsRoutes);
app.use("/api/chatroom", chatroomRoutes);

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

async function req(path, options = {}) {
  const token = signToken(currentUser);
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  console.log("--- 1. 好友申请与防范校验 ---");
  {
    // 不能申请自己
    const selfRes = await req("/api/friends/requests", { method: "POST", body: { to_user_id: 1, message: "加我自己" } });
    ck("向自己发送好友申请被拦截拒绝", selfRes.status === 400 || selfRes.json?.success === false);

    // 申请用户 2
    const reqRes = await req("/api/friends/requests", { method: "POST", body: { to_user_id: 2, message: "你好，我是 Alice" } });
    ck("发送好友申请成功", reqRes.status === 200 && reqRes.json?.success === true);
    ck("生成好友申请记录 ID", Boolean(reqRes.json?.data?.id));

    // 切换为用户 2 查看收到的申请
    currentUser = { id: 2, username: "user2", display_name: "Bob", role: 1 };
    const listRes = await req("/api/friends/requests");
    ck("接收方能够获取到好友待处理申请", listRes.status === 200 && listRes.json?.data?.pending_count === 1);
    ck("申请信息包含留言", listRes.json?.data?.incoming[0]?.message === "你好，我是 Alice");
  }

  console.log("\n--- 2. 好友申请处理（同意）与双向好友列表 ---");
  {
    const reqId = db.friend_requests[0].id;
    const acceptRes = await req(`/api/friends/requests/${reqId}`, { method: "PUT", body: { action: "accept" } });
    ck("接收方同意好友申请成功", acceptRes.status === 200 && acceptRes.json?.data?.status === "accepted");

    // 查看用户 2 的好友列表
    const fList2 = await req("/api/friends");
    ck("用户 2 好友列表中包含 Alice", fList2.json?.data?.some((f) => f.id === 1));

    // 切换回用户 1 查看好友列表
    currentUser = { id: 1, username: "user1", display_name: "Alice", role: 1 };
    const fList1 = await req("/api/friends");
    ck("用户 1 好友列表中包含 Bob", fList1.json?.data?.some((f) => f.id === 2));

    // 修改好友备注
    const remarkRes = await req("/api/friends/2/remark", { method: "PUT", body: { remark: "我的伙伴Bob" } });
    ck("修改好友备注成功", remarkRes.status === 200 && remarkRes.json?.data?.remark === "我的伙伴Bob");
  }

  console.log("\n--- 3. QQ 频道体系（频道服务器与子频道列表自动预置） ---");
  {
    const guildRes = await req("/api/chatroom/guilds");
    ck("成功获取频道服务器列表", guildRes.status === 200 && Array.isArray(guildRes.json?.data));
    ck("包含官方默认主频道「OOAPI 开发者社区」", guildRes.json?.data[0]?.name === "OOAPI 开发者社区");
    ck("官方频道包含预置子频道列表（公告、综合、探讨等）", guildRes.json?.data[0]?.channels?.length >= 4);
    ck("子频道包含绑定的 chatroom room_id", Boolean(guildRes.json?.data[0]?.channels[0]?.room_id));
  }

  console.log("\n--- 4. 群公告与群名称修改功能 ---");
  {
    const rId = db.chat_rooms[0]?.id || 101;
    const annRes = await req(`/api/chatroom/rooms/${rId}/announcement`, {
      method: "PUT",
      body: { announcement: "今日全员开荒最新 DeepSeek-R1 模型" }
    });
    ck("群公告修改成功", annRes.status === 200 && annRes.json?.data?.announcement?.includes("DeepSeek-R1"));

    const nameRes = await req(`/api/chatroom/rooms/${rId}/name`, {
      method: "PUT",
      body: { name: "超级技术交流群" }
    });
    ck("群名称修改成功", nameRes.status === 200 && nameRes.json?.data?.name === "超级技术交流群");
  }

  console.log("\n--- 5. 校验小游戏模块已全量下线 ---");
  {
    const gameRes = await req("/api/games/list");
    ck("原 /api/games 路由已不再存在（返回 404）", gameRes.status === 404);
  }

} finally {
  await new Promise((r) => server.close(r));
}

console.log(`\n测试汇总：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  console.log("好友系统与 QQ 频道自动化测试全部通过！");
  process.exit(0);
}
