// 新模块的 SQL 兼容性测试（真连 MySQL）
// ---------------------------------------------------------------------------
// 为什么必须单独测这个：线上 MySQL 默认开启 only_full_group_by，
// 而 `SELECT 非聚合列 ... GROUP BY 别的列` 在本地宽松模式下能跑、线上直接 500。
// 真实事故：游戏排行榜用了 `GROUP BY t.user_id` 去重但 SELECT 了 duration_ms，
// 页面报 500 —— 语法检查、vite build 全查不出，只有真跑一次接口才暴露。
//
// 这个文件把「新模块里所有带 GROUP BY / 子查询聚合的语句」逐条打到真实库上，
// 让 MySQL 自己判定合法性（比人肉推断可靠，也不会被本机 sql_mode 差异骗过）。
// 需要 .env 的数据库配置；无数据库时跳过（不算失败）。
import "dotenv/config";

let passed = 0;
let failed = 0;
let skipped = 0;
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === "skip") {
      skipped += 1;
      console.log(`  skip ${name}`);
      return;
    }
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

let pool;
try {
  ({ pool } = await import("../src/db.js"));
  await pool.query("SELECT 1");
} catch (e) {
  console.log(`数据库不可用，跳过 SQL 兼容性测试：${e.message}`);
  process.exit(0);
}

const [[mode]] = await pool.query("SELECT @@sql_mode AS m");
console.log(`sql_mode: ${mode.m.includes("ONLY_FULL_GROUP_BY") ? "含 ONLY_FULL_GROUP_BY（与线上一致）" : "不含（本机宽松模式，测不出问题）"}\n`);

/** 断言：一条 SQL 能被 MySQL 解析并执行（只看语法/语义合法性，不看结果） */
async function exec(sql, args = []) {
  await pool.query(sql, args);
}

// ---------------------------------------------------------------------------
// 游戏：排行榜（曾经线上 500 的那条）
// ---------------------------------------------------------------------------
await t("游戏排行榜（每人最高分，一人一行）", () =>
  exec(
    `SELECT t.user_id, t.score, t.duration_ms, t.created_time,
            u.username, u.display_name, u.avatar_media_id
       FROM game_records t
       JOIN users u ON u.id = t.user_id
       JOIN (
         SELECT user_id, MAX(score) AS best_score, MIN(id) AS best_id
           FROM game_records WHERE game_key = ?
          GROUP BY user_id
       ) b ON b.user_id = t.user_id AND t.score = b.best_score
      WHERE t.game_key = ? AND u.status = 1
        AND t.id = (
          SELECT MIN(t2.id) FROM game_records t2
           WHERE t2.user_id = t.user_id AND t2.game_key = t.game_key AND t2.score = t.score
        )
      ORDER BY t.score DESC, t.created_time ASC
      LIMIT 15 OFFSET 0`,
    ["g2048", "g2048"]
  )
);

await t("游戏：我的最高分与局数", () =>
  exec("SELECT COALESCE(MAX(score),0) AS best, COUNT(*) AS plays FROM game_records WHERE user_id = ? AND game_key = ?", [1, "g2048"])
);

await t("游戏：对局列表（LEFT JOIN 双方用户名）", () =>
  exec(
    `SELECT r.*, h.username AS host_name, g.username AS guest_name
       FROM game_rooms r
       LEFT JOIN users h ON h.id = r.host_id
       LEFT JOIN users g ON g.id = r.guest_id
      WHERE r.status IN ('waiting','playing')
      ORDER BY r.status = 'waiting' DESC, r.id DESC LIMIT 50`
  )
);

// ---------------------------------------------------------------------------
// 看板：所有 GROUP BY 聚合
// ---------------------------------------------------------------------------
await t("看板：按天趋势（个人）", () =>
  exec(
    `SELECT FLOOR(created_at/86400)*86400 AS day_ts, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
       FROM logs WHERE created_at >= ? AND type = 2 AND user_id = ? GROUP BY day_ts ORDER BY day_ts`,
    [0, 1]
  )
);

await t("看板：用户排行（JOIN users 后按 l.user_id 分组）", () =>
  exec(
    `SELECT l.user_id, COUNT(*) AS calls, COALESCE(SUM(l.quota),0) AS units,
            COALESCE(SUM(l.prompt_tokens + l.completion_tokens),0) AS tokens,
            u.username, u.display_name, u.avatar_media_id
       FROM logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.type = 2 AND l.created_at >= ?
      GROUP BY l.user_id ORDER BY units DESC LIMIT 10`,
    [0]
  )
);

await t("看板：渠道表现（JOIN channels 后按 l.channel_id 分组）", () =>
  exec(
    `SELECT l.channel_id, COUNT(*) AS calls, COALESCE(SUM(l.quota),0) AS units,
            COALESCE(AVG(NULLIF(l.elapsed_ms,0)),0) AS avg_elapsed,
            c.name AS channel_name, c.type AS channel_type
       FROM logs l LEFT JOIN channels c ON c.id = l.channel_id
      WHERE l.type = 2 AND l.created_at >= ? AND l.channel_id > 0
      GROUP BY l.channel_id ORDER BY units DESC LIMIT 12`,
    [0]
  )
);

await t("看板：按小时×星期（热点图）", () =>
  exec(
    `SELECT HOUR(FROM_UNIXTIME(created_at)) AS hour, WEEKDAY(FROM_UNIXTIME(created_at)) AS weekday,
            COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
       FROM logs WHERE type = 2 AND created_at >= ? GROUP BY hour, weekday`,
    [0]
  )
);

await t("看板：渠道错误数", () =>
  exec("SELECT channel_id, COUNT(*) AS errors FROM logs WHERE type = 4 AND created_at >= ? AND channel_id > 0 GROUP BY channel_id", [0])
);

await t("看板：社区概况（多子查询）", () =>
  exec(
    `SELECT
       (SELECT COUNT(*) FROM community_posts WHERE status = 1) AS posts,
       (SELECT COUNT(*) FROM community_posts WHERE status <> 2 AND created_time >= ?) AS posts_new,
       (SELECT COUNT(*) FROM community_comments WHERE status = 1) AS comments,
       (SELECT COUNT(*) FROM users WHERE status = 1) AS users,
       (SELECT COUNT(*) FROM chat_rooms WHERE status = 1) AS rooms,
       (SELECT COUNT(*) FROM chat_room_messages WHERE status = 1 AND created_time >= ?) AS messages_new,
       (SELECT COUNT(*) FROM game_records WHERE created_time >= ?) AS game_plays_new`,
    [0, 0, 0]
  )
);

// ---------------------------------------------------------------------------
// 使用记录：模型×按天多折线（新加的那条）
// ---------------------------------------------------------------------------
await t("使用分析：模型×按天序列", () =>
  exec(
    `SELECT model, FLOOR(created_at/86400)*86400 AS day_ts,
            COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
            COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens
       FROM logs WHERE type = 2 AND created_at >= ? AND model IN (?,?)
      GROUP BY model, day_ts ORDER BY day_ts ASC`,
    [0, "a", "b"]
  )
);

// ---------------------------------------------------------------------------
// 社区
// ---------------------------------------------------------------------------
await t("社区：帖子列表（JOIN topic + 可见性）", () =>
  exec(
    `SELECT p.*, t.name AS topic_name FROM community_posts p
      LEFT JOIN community_topics t ON t.id = p.topic_id
      WHERE p.status = 1 ORDER BY p.is_pinned DESC, p.id DESC LIMIT 20 OFFSET 0`
  )
);

await t("社区：评论列表（JOIN 被回复者）", () =>
  exec(
    `SELECT c.*, ru.username AS reply_username, ru.display_name AS reply_display_name
       FROM community_comments c
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
      WHERE c.post_id = ? AND c.status = 1 ORDER BY c.id ASC LIMIT 50 OFFSET 0`,
    [1]
  )
);

await t("社区：我的社区汇总（多子查询）", () =>
  exec(
    `SELECT
       (SELECT COUNT(*) FROM community_posts WHERE user_id = ? AND status <> 2) AS posts,
       (SELECT COALESCE(SUM(like_count),0) FROM community_posts WHERE user_id = ? AND status <> 2) AS likes,
       (SELECT COUNT(*) FROM community_comments WHERE user_id = ? AND status <> 2) AS comments,
       (SELECT COUNT(*) FROM community_follows WHERE follower_id = ?) AS following,
       (SELECT COUNT(*) FROM community_follows WHERE followee_id = ?) AS followers,
       (SELECT COUNT(*) FROM chat_room_members WHERE user_id = ?) AS rooms,
       (SELECT COUNT(*) FROM game_records WHERE user_id = ?) AS game_plays`,
    [1, 1, 1, 1, 1, 1, 1]
  )
);

await t("社区：关注/粉丝列表（JOIN users）", () =>
  exec(
    `SELECT u.id, u.username, u.display_name, u.avatar_media_id, u.bio, f.created_time
       FROM community_follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? AND u.status = 1 ORDER BY f.id DESC LIMIT 30 OFFSET 0`,
    [1]
  )
);

// ---------------------------------------------------------------------------
// 聊天
// ---------------------------------------------------------------------------
await t("聊天：会话列表（含未读子查询）", () =>
  exec(
    `SELECT r.*, m.role AS my_role, m.muted, m.last_read_id,
            (SELECT COUNT(*) FROM chat_room_messages msg
              WHERE msg.room_id = r.id AND msg.id > m.last_read_id AND msg.status = 1 AND msg.user_id <> ?) AS unread
       FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id
      WHERE m.user_id = ? AND r.status = 1
      ORDER BY r.last_message_time DESC, r.id DESC LIMIT 50 OFFSET 0`,
    [1, 1]
  )
);

await t("聊天：未读汇总（SUM 子查询）", () =>
  exec(
    `SELECT COALESCE(SUM(unread), 0) AS total FROM (
       SELECT (SELECT COUNT(*) FROM chat_room_messages msg
                WHERE msg.room_id = m.room_id AND msg.id > m.last_read_id AND msg.status = 1 AND msg.user_id <> ?) AS unread
         FROM chat_room_members m JOIN chat_rooms r ON r.id = m.room_id
        WHERE m.user_id = ? AND r.status = 1) t`,
    [1, 1]
  )
);

await t("聊天：单聊房间唯一查找", () =>
  exec("SELECT id FROM chat_rooms WHERE single_key = ? AND status = 1", ["1:2"])
);

// ---------------------------------------------------------------------------
// 个人主页
// ---------------------------------------------------------------------------
await t("个人主页：统计汇总（多子查询）", () =>
  exec(
    `SELECT
       (SELECT COUNT(*) FROM community_posts WHERE user_id = ? AND status <> 2) AS posts,
       (SELECT COUNT(*) FROM community_comments WHERE user_id = ? AND status <> 2) AS comments,
       (SELECT COUNT(*) FROM community_follows WHERE follower_id = ?) AS following,
       (SELECT COUNT(*) FROM community_follows WHERE followee_id = ?) AS followers`,
    [1, 1, 1, 1]
  )
);

await t("个人主页：最近动态（JOIN topic）", () =>
  exec(
    `SELECT p.id, p.title, p.content, p.like_count, p.comment_count, p.view_count, p.created_time, p.topic_id,
            t.name AS topic_name, p.media_ids
       FROM community_posts p LEFT JOIN community_topics t ON t.id = p.topic_id
      WHERE p.user_id = ? AND p.status = 1
      ORDER BY p.id DESC LIMIT 10`,
    [1]
  )
);

await pool.end().catch(() => {});
console.log(`\n${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ""}`);
process.exit(failed ? 1 : 0);
