// 第 80 批回归：对话账号工具的越权边界 / 话题图标白名单前后端一致 / 看板按北京时间切天
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";
import { TOOLS } from "../src/services/harness/tools.js";
import express from "express";
import { signToken } from "../src/middleware/auth.js";
import userRoutes from "../src/routes/user.js";
import communityRoutes from "../src/routes/community.js";
import updateRoutes from "../src/routes/update.js";
import optionRoutes from "../src/routes/option.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
let pass = 0;
let fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

console.log("=== ① account 工具只能读当前用户自己的数据 ===");
{
  const seen = [];
  pool.query = async (sql, params = []) => {
    seen.push({ sql: String(sql).replace(/\s+/g, " "), params });
    if (/FROM users WHERE id = \?/.test(sql)) return [[{ username: "alice", display_name: "A", quota: 12345, used_quota: 10000, request_count: 3, group_name: "", created_time: 1 }]];
    if (/SUM\(status = 1\)/.test(sql)) return [[{ n: 1, on_: 1 }]];
    if (/FROM tokens/.test(sql)) return [[{ name: "k1", status: 1, remain_quota: 10000, unlimited_quota: 0, used_quota: 0, group_name: "", expired_time: -1, accessed_time: 0 }]];
    if (/GROUP BY FLOOR/.test(sql)) return [[{ d: 20000, n: 2, cost: 100 }]];
    if (/GROUP BY model/.test(sql)) return [[{ model: "m", n: 2, cost: 100 }]];
    if (/COUNT\(\*\) AS n, COALESCE/.test(sql)) return [[{ n: 1, cost: 100 }]];
    return [[{ created_at: 1, model: "m", token_name: "k1", prompt_tokens: 1, completion_tokens: 1, quota: 1, elapsed_ms: 1, content: "x" }]];
  };
  const ctx = { user: { id: 42 } };
  for (const action of ["overview", "recent", "tokens", "usage", "errors"]) {
    seen.length = 0;
    const r = await TOOLS.account.run({ action }, ctx);
    ck(`${action}：返回成功`, r.ok, r.output);
    const leak = seen.filter((q) => /FROM (logs|tokens|users)/.test(q.sql) && !(/user_id = \?|WHERE id = \?/.test(q.sql) && q.params.includes(42)));
    ck(`${action}：每条查询都带 user_id = 当前用户`, !leak.length, leak.map((q) => q.sql.slice(0, 80)).join(" | "));
  }
  seen.length = 0;
  const t = await TOOLS.account.run({ action: "tokens" }, ctx);
  ck("tokens：不查也不返回密钥（key_str）", !seen.some((q) => /key_str/.test(q.sql)) && !/sk-/.test(t.output));
  const anon = await TOOLS.account.run({ action: "overview" }, { user: null });
  ck("没有登录用户时拒绝", anon.ok === false);
  seen.length = 0;
  await TOOLS.account.run({ action: "recent", limit: 9999 }, ctx);
  ck("recent 的 limit 被夹到 30", seen.some((q) => q.params.includes(30)) && !seen.some((q) => q.params.includes(9999)));
  const agents = read("src/services/harness/agents.js");
  ck("通用助手默认带 account 工具", /tools: \["account"/.test(agents));
}

console.log("\n=== ② 话题图标：前后端白名单一致，且不再用 emoji ===");
{
  const be = read("src/routes/community.js").match(/TOPIC_ICON_KEYS = \[([\s\S]*?)\]/)[1].match(/"([a-z-]+)"/g).map((s) => s.slice(1, -1));
  const fe = readFileSync(path.join(root, "..", "ooapi-web", "src", "components", "TopicIcon.jsx"), "utf8")
    .match(/key: "([a-z-]+)"/g).map((s) => s.slice(6, -1));
  const onlyBe = be.filter((k) => !fe.includes(k));
  const onlyFe = fe.filter((k) => !be.includes(k));
  ck("后端白名单里的每个 key 前端都能渲染", !onlyBe.length, onlyBe.join(","));
  ck("前端可选的每个 key 后端都接受", !onlyFe.length, onlyFe.join(","));
  const admin = readFileSync(path.join(root, "..", "ooapi-web", "src", "pages", "AdminCommunityPage.jsx"), "utf8");
  ck("管理页不再提示「可以是一个 emoji」", !/emoji，例如/.test(admin));
  ck("管理页读话题带 all=1（停用的话题也能看到、能重新启用）", /all: 1/.test(admin));
  ck("db 迁移把默认 emoji 换成图标 key", /EMOJI_TO_KEY/.test(read("src/db.js")));
}

console.log("\n=== ③ 看板按北京时间切天/切小时 ===");
{
  const d = read("src/routes/dashboard.js");
  const code = d.replace(/\/\/.*$/gm, "");
  ck("按天聚合用 (created_at + TZ)", /FLOOR\(\(created_at \+ \$\{TZ\}\)\/86400\)/.test(code));
  ck("不再按 UTC 零点切天", !/FLOOR\(created_at\/86400\)\*86400/.test(code));
  ck("按小时聚合不依赖 MySQL 会话时区（不用 FROM_UNIXTIME/HOUR）", !/HOUR\(FROM_UNIXTIME/.test(code));
  ck("返回上一周期数据（环比）", /previous: prev/.test(code));
}

console.log("\n=== ④ 管理角色与父帖评论权限（真实 HTTP，数据库全走内存桩） ===");
{
  const users = [
    { id: 1, username: "audit_admin", role: 100, status: 1, token_version: 0 },
    { id: 2, username: "audit_super", role: 1000, status: 1, token_version: 0 },
    { id: 3, username: "audit_viewer", role: 1, status: 1, token_version: 0 },
    { id: 4, username: "audit_author", role: 1, status: 1, token_version: 0 },
    { id: 5, username: "audit_peer_admin", role: 100, status: 1, token_version: 0 },
  ];
  const posts = [1, 2, 3].map((status) => ({
    id: 10 + status, user_id: 4, status, title: "权限测试", content: "测试正文", media_ids: "[]", view_count: 0,
  }));
  const comments = posts.map((p) => ({
    id: p.id + 20, post_id: p.id, user_id: 4, status: 1, content: "测试评论", media_ids: "[]", created_time: 1,
  }));
  let commentReads = 0;
  let topicCountDelta = 0;
  const originalQuery = pool.query;
  const originalConnection = pool.getConnection;
  pool.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s === "SELECT * FROM users WHERE id = ?") return [users.filter((u) => u.id === Number(params[0]))];
    if (s.startsWith("SELECT COUNT(*) AS admins")) {
      return [[{ admins: users.filter((u) => u.role >= 100 && u.status === 1 && u.id !== params[0]).length }]];
    }
    if (s.startsWith("SELECT COUNT(*) AS supers")) {
      return [[{ supers: users.filter((u) => u.role >= 1000 && u.status === 1 && u.id !== params[0]).length }]];
    }
    if (s === "DELETE FROM users WHERE id = ?") {
      const index = users.findIndex((u) => u.id === params[0]);
      if (index >= 0) users.splice(index, 1);
      return [{ affectedRows: index >= 0 ? 1 : 0 }];
    }
    if (s.startsWith("DELETE FROM") || s.startsWith("INSERT INTO logs")) return [{ affectedRows: 0 }];
    if (s.includes("FROM media WHERE user_id = ?") || s.includes("FROM media_refs")) return [[]];
    if (s.includes("FROM community_posts p") && s.includes("WHERE p.id = ?")) return [posts.filter((p) => p.id === params[0])];
    if (s === "SELECT id, user_id, status FROM community_posts WHERE id = ?") return [posts.filter((p) => p.id === params[0])];
    if (s === "SELECT id, topic_id, status FROM community_posts WHERE id = ?") return [posts.filter((p) => p.id === params[0])];
    if (s.startsWith("SELECT COUNT(*) AS n FROM community_comments")) {
      commentReads++;
      return [[{ n: comments.filter((c) => c.post_id === params[0]).length }]];
    }
    if (s.startsWith("SELECT c.*")) return [comments.filter((c) => c.post_id === params[0])];
    if (s.startsWith("SELECT id, username, display_name, role, avatar_media_id")) return [users.filter((u) => params.includes(u.id))];
    if (s.includes("FROM community_reactions") || s.includes("FROM community_follows")) return [[]];
    if (s.startsWith("UPDATE community_posts SET view_count")) return [{ affectedRows: 1 }];
    if (s.startsWith("UPDATE community_posts SET status = ?")) {
      // 模拟线上严格 MySQL 的 NOT NULL 约束，让错误的恢复 SQL 在行为测试里也会失败。
      if (/deleted_(by|time) = NULL/.test(s)) throw new Error("Column deleted_by/deleted_time cannot be null");
      const row = posts.find((p) => p.id === params[params.length - 1]);
      if (row) {
        row.status = params[0];
        row.deleted_by = 0;
        row.deleted_time = 0;
      }
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (s.startsWith("UPDATE community_topics SET post_count")) {
      topicCountDelta += Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`权限测试 SQL 桩未覆盖：${s}`);
  };
  pool.getConnection = async () => ({
    query: pool.query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
  });
  // 更新后半段有部署副作用，只替换业务执行函数；鉴权链仍用真正的路由中间件。
  const applyLayer = updateRoutes.stack.find((l) => l.route?.path === "/apply").route.stack;
  const lastApplyLayer = applyLayer[applyLayer.length - 1];
  const originalApply = lastApplyLayer.handle;
  let updateCalls = 0;
  lastApplyLayer.handle = (req, res) => { updateCalls++; res.json({ success: true }); };
  const app = express();
  app.use(express.json());
  app.use("/api/users", userRoutes);
  app.use("/api/community", communityRoutes);
  app.use("/api/update", updateRoutes);
  app.use("/api/option", optionRoutes);
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = new Map(users.map((u) => [u.id, signToken(u)]));
  const call = async (method, path, actor, body) => {
    const res = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${tokens.get(actor)}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json()).data };
  };
  try {
    for (const target of [2, 5]) {
      const token = await call("POST", `/api/users/${target}/token`, 1, {});
      ck(`普通管理员不能签发${target === 2 ? "超管" : "同级管理员"}身份`, token.status === 403);
      const deletion = await call("DELETE", `/api/users/${target}`, 1);
      ck(`普通管理员不能删除${target === 2 ? "超管" : "同级管理员"}账号`, deletion.status === 403 && users.some((u) => u.id === target));
    }
    ck("管理员仍能签发普通用户身份", (await call("POST", "/api/users/3/token", 1, {})).status === 200);
    ck("超管仍能签发管理员身份", (await call("POST", "/api/users/5/token", 2, {})).status === 200);
    ck("超管仍能删除其他管理员", (await call("DELETE", "/api/users/5", 2)).status === 200 && !users.some((u) => u.id === 5));
    ck("普通管理员在线更新被拒绝", (await call("POST", "/api/update/apply", 1, {})).status === 403 && updateCalls === 0);
    ck("超管在线更新仍可通过鉴权", (await call("POST", "/api/update/apply", 2, {})).status === 200 && updateCalls === 1);
    const adminOptions = await call("GET", "/api/option", 1);
    const superOptions = await call("GET", "/api/option", 2);
    ck("管理员设置响应带不可编辑字段", adminOptions.data?.is_super === false && adminOptions.data?.super_only?.includes("smtp_pass"));
    ck("超管设置响应无不可编辑字段", superOptions.data?.is_super === true && superOptions.data?.super_only?.length === 0);
    ck("公开帖评论仍可读取", (await call("GET", "/api/community/posts/11/comments", 3)).data?.items?.length === 1);
    for (const post of [12, 13]) {
      const before = commentReads;
      const detail = await call("GET", `/api/community/posts/${post}`, 3);
      const list = await call("GET", `/api/community/posts/${post}/comments`, 3);
      ck(`${post === 12 ? "已删" : "隐藏"}帖详情和评论均拒绝外人`, detail.status === 404 && list.status === 404 && commentReads === before);
    }
    ck("隐藏帖作者仍可读评论", (await call("GET", "/api/community/posts/13/comments", 4)).data?.items?.length === 1);
    ck("已删帖作者详情不泄露正文", (await call("GET", "/api/community/posts/12", 4)).status === 404);
    ck("已删帖作者评论不可读取", (await call("GET", "/api/community/posts/12/comments", 4)).status === 404);
    ck("管理员仍可读已删帖评论", (await call("GET", "/api/community/posts/12/comments", 1)).data?.items?.length === 1);
    ck("不存在的父帖评论返回 404", (await call("GET", "/api/community/posts/999/comments", 3)).status === 404);
    const restore = await call("POST", "/api/community/posts/12/moderate", 1, { status: 1 });
    ck("严格 MySQL 下恢复帖子成功并清零删除标记", restore.status === 200 && posts.find((p) => p.id === 12)?.deleted_by === 0 && posts.find((p) => p.id === 12)?.deleted_time === 0);
    ck("恢复帖子同步话题计数并重新开放评论读取", topicCountDelta === 1 && (await call("GET", "/api/community/posts/12/comments", 3)).data?.items?.length === 1);
  } finally {
    lastApplyLayer.handle = originalApply;
    pool.query = originalQuery;
    pool.getConnection = originalConnection;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
