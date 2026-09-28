// 第 80 批回归：对话账号工具的越权边界 / 话题图标白名单前后端一致 / 看板按北京时间切天
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";
import { TOOLS } from "../src/services/harness/tools.js";

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

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
