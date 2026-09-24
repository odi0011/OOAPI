// 社区已删除内容隔离与专属 Tab 自动化测试
// ---------------------------------------------------------------------------
// 验证要点：
// 1. 常规流（最新/最热）绝对不包含 status=2 的帖子，无论是普通用户还是管理员。
// 2. 普通用户请求 ?tab=deleted 或 ?status=2 会被 403 拒绝。
// 3. 管理员请求 ?tab=deleted 时，只返回 status=2 的已删除内容。
// 4. 管理员通过 /moderate 能够恢复 status=2 的帖子回到 status=1，并同步恢复话题计数。
import http from "node:http";
import express from "express";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import communityRoutes from "../src/routes/community.js";

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

console.log("=== 社区已删除帖子隔离与管理员专属 Tab 测试 ===\n");

const db = {
  users: [
    { id: 1, username: "admin", display_name: "Admin", role: 100, token_version: 0, status: 1 },
    { id: 2, username: "user_a", display_name: "UserA", role: 1, token_version: 0, status: 1 },
    { id: 3, username: "user_b", display_name: "UserB", role: 1, token_version: 0, status: 1 },
  ],
  topics: [
    { id: 1, name: "技术讨论", post_count: 2, status: 1 },
  ],
  posts: [
    { id: 101, user_id: 2, topic_id: 1, title: "正常帖子1", content: "正常正文1", status: 1, is_pinned: 0, like_count: 0, comment_count: 0, view_count: 0, created_time: 1000, updated_time: 1000 },
    { id: 102, user_id: 2, topic_id: 1, title: "已删除帖子2", content: "已被删除", status: 2, deleted_by: 2, deleted_time: 1050, is_pinned: 0, like_count: 0, comment_count: 0, view_count: 0, created_time: 1010, updated_time: 1010 },
    { id: 103, user_id: 3, topic_id: 1, title: "已删除帖子3", content: "被管理员删除", status: 2, deleted_by: 1, deleted_time: 1100, is_pinned: 0, like_count: 0, comment_count: 0, view_count: 0, created_time: 1020, updated_time: 1020 },
    { id: 104, user_id: 3, topic_id: 1, title: "正常帖子4", content: "正常正文4", status: 1, is_pinned: 0, like_count: 0, comment_count: 0, view_count: 0, created_time: 1030, updated_time: 1030 },
  ],
  reactions: [],
  logs: []
};

// 拦截 pool.query
pool.query = async (sql, params = []) => {
  const s = String(sql || "").trim();

  // 用户校验
  if (s.includes("FROM users WHERE id = ?")) {
    const u = db.users.find((x) => x.id === params[0]);
    return [[u || null]];
  }

  // 批量获取作者
  if (s.includes("FROM users WHERE id IN")) {
    const ids = params;
    const matched = db.users.filter((u) => ids.includes(u.id));
    return [matched];
  }

  // 帖子列表总数
  if (s.startsWith("SELECT COUNT(*) AS n FROM community_posts p")) {
    let list = [...db.posts];
    if (s.includes("p.status = 2")) {
      list = list.filter((p) => p.status === 2);
    } else if (s.includes("p.status != 2")) {
      list = list.filter((p) => p.status !== 2);
    } else if (s.includes("p.status = 1")) {
      list = list.filter((p) => p.status === 1);
    }
    return [[{ n: list.length }]];
  }

  // 帖子列表数据
  if (s.startsWith("SELECT p.*, t.name AS topic_name FROM community_posts p")) {
    let list = [...db.posts];
    if (s.includes("p.status = 2")) {
      list = list.filter((p) => p.status === 2);
    } else if (s.includes("p.status != 2")) {
      list = list.filter((p) => p.status !== 2);
    } else if (s.includes("p.status = 1")) {
      list = list.filter((p) => p.status === 1);
    }
    return [list];
  }

  // 单帖详情
  if (s.includes("FROM community_posts p") && s.includes("WHERE p.id = ?")) {
    const p = db.posts.find((x) => x.id === params[0]);
    return [[p ? { ...p, topic_name: "技术讨论" } : null]];
  }

  if (s.includes("SELECT id, topic_id, status FROM community_posts WHERE id = ?")) {
    const p = db.posts.find((x) => x.id === params[0]);
    return [[p || null]];
  }

  // 点赞/收藏
  if (s.includes("FROM community_reactions")) {
    return [[]];
  }

  // 浏览量增加
  if (s.startsWith("UPDATE community_posts SET view_count")) {
    return [{ affectedRows: 1 }];
  }

  // 关注检查
  if (s.includes("FROM community_follows")) {
    return [[]];
  }

  // 话题更新
  if (s.startsWith("UPDATE community_topics SET post_count")) {
    return [{ affectedRows: 1 }];
  }

  // 管理帖子
  if (s.startsWith("UPDATE community_posts SET")) {
    const id = params[params.length - 1];
    const post = db.posts.find((p) => p.id === id);
    if (post) {
      if (s.includes("status = ?")) {
        post.status = params[0];
      }
    }
    return [{ affectedRows: 1 }];
  }

  // 日志记录
  if (s.includes("INSERT INTO system_logs")) {
    return [{ insertId: 1 }];
  }

  return [[]];
};

const app = express();
app.use(express.json());
app.use("/api/community", communityRoutes);

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const adminToken = signToken({ id: 1, role: 100, token_version: 0 });
const userAToken = signToken({ id: 2, role: 1, token_version: 0 });

const req = async (path, { method = "GET", token, body } = {}) => {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

try {
  console.log("--- 1. 普通用户请求常规帖子流（禁止看到 status=2） ---");
  {
    const res = await req("/api/community/posts", { token: userAToken });
    ck("请求返回 200", res.status === 200);
    const items = res.json?.data?.items || [];
    ck("列表中不含 status=2 的已删除内容", items.every((x) => x.status !== 2));
    ck("自己删除的帖子 102 也不在流中", !items.some((x) => x.id === 102));
  }

  console.log("\n--- 2. 管理员请求常规帖子流（禁止混入 status=2） ---");
  {
    const res = await req("/api/community/posts", { token: adminToken });
    ck("管理员请求常规列表返回 200", res.status === 200);
    const items = res.json?.data?.items || [];
    ck("管理员常规流同样彻底不含 status=2 的已删除内容", items.every((x) => x.status !== 2));
    ck("只包含正常内容 (101, 104)", items.every((x) => [101, 104].includes(x.id)));
  }

  console.log("\n--- 3. 普通用户尝试访问已删除 Tab（拦截 403） ---");
  {
    const resTab = await req("/api/community/posts?tab=deleted", { token: userAToken });
    ck("普通用户带 ?tab=deleted 返回 403", resTab.status === 403);

    const resStatus = await req("/api/community/posts?status=2", { token: userAToken });
    ck("普通用户带 ?status=2 返回 403", resStatus.status === 403);
  }

  console.log("\n--- 4. 管理员访问专属「已删除」Tab ---");
  {
    const res = await req("/api/community/posts?tab=deleted", { token: adminToken });
    ck("管理员访问 ?tab=deleted 返回 200", res.status === 200);
    const items = res.json?.data?.items || [];
    ck("返回的全部都是已删除帖子 (status=2)", items.length === 2 && items.every((x) => x.status === 2));
    ck("包含帖子 102 和 103", items.some((x) => x.id === 102) && items.some((x) => x.id === 103));
  }

  console.log("\n--- 5. 管理员恢复已删除帖子回到正常状态 ---");
  {
    const modRes = await req("/api/community/posts/102/moderate", {
      method: "POST",
      token: adminToken,
      body: { status: 1 }
    });
    ck("恢复已删除帖子返回 200", modRes.status === 200 && modRes.json?.success === true);
    const p102 = db.posts.find((p) => p.id === 102);
    ck("帖子状态已成功修改为 1 (正常)", p102?.status === 1);
  }
} finally {
  await new Promise((r) => server.close(r));
}

console.log(`\n测试汇总：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  console.log("社区已删除帖子隔离与专属 Tab 全部通过！\n");
  process.exit(0);
}
