// 数据看板：个人维度 + 管理端维度
// ---------------------------------------------------------------------------
// 为什么单独开一个 dashboard.js 而不是扩展 log.js / monitor.js：
//
//   · log.js 的聚合是「跟着筛选条件走的」（用户点哪个筛选就聚合哪个），
//     看板需要的是**固定口径**的几组数字（近 7/30 天、按模型、按渠道、按用户）；
//   · monitor.js 是**进程内实时指标**（重启清零），看板要的是**历史落库数据**
//     （logs 表跨重启），两者性质不同，混在一起会让口径越来越难解释。
//
// 口径声明（前端每张图都要能回答「这是哪段时间、谁的数据」）：
//   · 个人维度：只统计 req.user 自己的 logs，默认近 30 天；
//   · 管理端维度：全站 logs，默认近 30 天，需要管理员权限；
//   · **金额一律用额度单位（units）返回**，展示层用 fmtOd 换算 —— 后端不返回
//     「已经除过 10000」的数字，否则前端再乘一次就会差 10000 倍（历史事故）。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, safeInt } from "../utils.js";
import { authRequired, adminRequired } from "../middleware/auth.js";
import { snapshot } from "../services/metrics.js";

const router = Router();

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

function rangeOf(query) {
  const key = String(query.range || "30d");
  const days = RANGE_DAYS[key] || 30;
  return { key, days, since: Math.floor(Date.now() / 1000) - days * 86400 };
}

/** 按天趋势（消费 + 调用 + token + 缓存），缺数据的日期补 0（否则折线会断） */
async function dailyTrend(userId, since, days) {
  const args = [since];
  let where = "created_at >= ? AND type = 2";
  if (userId) {
    where += " AND user_id = ?";
    args.push(userId);
  }
  const [rows] = await pool.query(
    `SELECT FLOOR(created_at/86400)*86400 AS day_ts,
            COUNT(*) AS calls,
            COALESCE(SUM(quota),0) AS units,
            COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens),0) AS completion_tokens,
            COALESCE(SUM(cache_tokens),0) AS cache_tokens
       FROM logs WHERE ${where} GROUP BY day_ts ORDER BY day_ts`,
    args
  );
  const map = new Map(rows.map((r) => [Number(r.day_ts), r]));
  const out = [];
  const today = Math.floor(Date.now() / 1000);
  const startDay = Math.floor(since / 86400) * 86400;
  // 补齐空白日期：前端折线图需要连续的时间轴，否则「中间没数据的那天」
  // 会被压掉，视觉上把两周的消费画成连续增长（误导）
  for (let t = startDay; t <= today; t += 86400) {
    const r = map.get(t);
    out.push({
      day: new Date(t * 1000).toISOString().slice(0, 10),
      day_ts: t,
      calls: Number(r?.calls) || 0,
      units: Number(r?.units) || 0,
      prompt_tokens: Number(r?.prompt_tokens) || 0,
      completion_tokens: Number(r?.completion_tokens) || 0,
      cache_tokens: Number(r?.cache_tokens) || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 个人维度
// ---------------------------------------------------------------------------
router.get(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => {
    const { key, days, since } = rangeOf(req.query);
    const uid = req.user.id;

    const [[agg]] = await pool.query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COUNT(DISTINCT model) AS models
         FROM logs WHERE user_id = ? AND type = 2 AND created_at >= ?`,
      [uid, since]
    );
    const [byModel] = await pool.query(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
         FROM logs WHERE user_id = ? AND type = 2 AND created_at >= ? AND model <> ''
        GROUP BY model ORDER BY units DESC LIMIT 12`,
      [uid, since]
    );
    const [byChannel] = await pool.query(
      `SELECT channel_id, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE user_id = ? AND type = 2 AND created_at >= ? AND channel_id > 0
        GROUP BY channel_id ORDER BY units DESC LIMIT 8`,
      [uid, since]
    );
    // 按小时分布：看出「我什么时候在用」（对个人是最直观的节奏信息）
    const [byHour] = await pool.query(
      `SELECT HOUR(FROM_UNIXTIME(created_at)) AS hour, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE user_id = ? AND type = 2 AND created_at >= ?
        GROUP BY hour ORDER BY hour`,
      [uid, since]
    );
    // 缓存命中率：分母是 prompt（prompt 已含缓存部分，不能再加一次）
    const prompt = Number(agg.prompt_tokens) || 0;
    const cache = Number(agg.cache_tokens) || 0;
    const trend = await dailyTrend(uid, since, days);

    return ok(res, {
      range: { key, days },
      totals: {
        calls: Number(agg.calls) || 0,
        units: Number(agg.units) || 0,
        prompt_tokens: prompt,
        completion_tokens: Number(agg.completion_tokens) || 0,
        cache_tokens: cache,
        uncached_tokens: Math.max(0, prompt - cache),
        cache_rate: prompt > 0 ? Number(((cache / prompt) * 100).toFixed(1)) : 0,
        models: Number(agg.models) || 0,
      },
      // 余额单独给：它不是「区间消费」，混进 totals 会让「区间汇总」口径不清
      account: {
        quota: Number(req.user.quota) || 0,
        used_quota: Number(req.user.used_quota) || 0,
        request_count: Number(req.user.request_count) || 0,
      },
      trend,
      by_model: byModel.map((m) => ({
        model: m.model,
        calls: Number(m.calls) || 0,
        units: Number(m.units) || 0,
        prompt_tokens: Number(m.prompt_tokens) || 0,
        completion_tokens: Number(m.completion_tokens) || 0,
      })),
      by_channel: byChannel.map((c) => ({
        channel_id: Number(c.channel_id) || 0,
        calls: Number(c.calls) || 0,
        units: Number(c.units) || 0,
      })),
      by_hour: Array.from({ length: 24 }, (_, h) => {
        const hit = byHour.find((x) => Number(x.hour) === h);
        return { hour: h, calls: Number(hit?.calls) || 0, units: Number(hit?.units) || 0 };
      }),
    });
  })
);

// ---------------------------------------------------------------------------
// 管理端维度
// ---------------------------------------------------------------------------
router.get(
  "/admin",
  adminRequired,
  asyncHandler(async (req, res) => {
    const { key, days, since } = rangeOf(req.query);

    const [[agg]] = await pool.query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COUNT(DISTINCT user_id) AS users,
              COUNT(DISTINCT model) AS models
         FROM logs WHERE type = 2 AND created_at >= ?`,
      [since]
    );
    // 用户排行：按消费额，同时给调用数与 token（只看消费额会漏掉「高频低耗」的用户）
    const [topUsers] = await pool.query(
      `SELECT l.user_id, COUNT(*) AS calls, COALESCE(SUM(l.quota),0) AS units,
              COALESCE(SUM(l.prompt_tokens + l.completion_tokens),0) AS tokens,
              u.username, u.display_name, u.avatar_media_id
         FROM logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.type = 2 AND l.created_at >= ?
        GROUP BY l.user_id ORDER BY units DESC LIMIT 10`,
      [since]
    );
    const [topModels] = await pool.query(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE type = 2 AND created_at >= ? AND model <> ''
        GROUP BY model ORDER BY units DESC LIMIT 12`,
      [since]
    );
    const [byChannel] = await pool.query(
      `SELECT l.channel_id, COUNT(*) AS calls, COALESCE(SUM(l.quota),0) AS units,
              COALESCE(AVG(NULLIF(l.elapsed_ms,0)),0) AS avg_elapsed,
              c.name AS channel_name, c.type AS channel_type
         FROM logs l LEFT JOIN channels c ON c.id = l.channel_id
        WHERE l.type = 2 AND l.created_at >= ? AND l.channel_id > 0
        GROUP BY l.channel_id ORDER BY units DESC LIMIT 12`,
      [since]
    );
    // 渠道错误数单独查：错误是**独立的 type=4 日志行**（历史上就没有 status 列），
    // 拿 type=2 的行去数「status <> 1」会一条都数不到（静默算成 0 错误）。
    const [channelErrors] = await pool.query(
      `SELECT channel_id, COUNT(*) AS errors FROM logs
        WHERE type = 4 AND created_at >= ? AND channel_id > 0 GROUP BY channel_id`,
      [since]
    );
    const errMap = new Map(channelErrors.map((e) => [Number(e.channel_id), Number(e.errors) || 0]));
    // 令牌维度：谁在用哪个 Key（管理员排查「某个 Key 在刷量」时的入口）
    const [topTokens] = await pool.query(
      `SELECT token_id, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE type = 2 AND created_at >= ? AND token_id > 0
        GROUP BY token_id ORDER BY units DESC LIMIT 10`,
      [since]
    );
    // 错误分布：错误日志是 type=4，与消费日志（type=2）分开记
    const [errorsByModel] = await pool.query(
      `SELECT model, COUNT(*) AS errors FROM logs
        WHERE type = 4 AND created_at >= ? AND model <> ''
        GROUP BY model ORDER BY errors DESC LIMIT 10`,
      [since]
    );
    const [[users]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE status = 1");
    const [[newUsers]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE created_time >= ?", [since]);

    const prompt = Number(agg.prompt_tokens) || 0;
    const cache = Number(agg.cache_tokens) || 0;
    const trend = await dailyTrend(null, since, days);
    // 实时指标（进程内，重启清零）与历史指标（logs 表）**分开返回**，
    // 前端也要分开标注，不能让用户以为「今天的数字」包含历史累计
    const snap = snapshot();

    return ok(res, {
      range: { key, days },
      totals: {
        calls: Number(agg.calls) || 0,
        units: Number(agg.units) || 0,
        prompt_tokens: prompt,
        completion_tokens: Number(agg.completion_tokens) || 0,
        cache_tokens: cache,
        uncached_tokens: Math.max(0, prompt - cache),
        cache_rate: prompt > 0 ? Number(((cache / prompt) * 100).toFixed(1)) : 0,
        active_users: Number(agg.users) || 0,
        models: Number(agg.models) || 0,
        users_total: Number(users.n) || 0,
        users_new: Number(newUsers.n) || 0,
      },
      trend,
      top_users: topUsers.map((u) => ({
        user_id: Number(u.user_id) || 0,
        username: u.username || "已删除",
        display_name: u.display_name || u.username || "",
        avatar_url: Number(u.avatar_media_id) ? `/api/media/avatar/${u.user_id}?v=${u.avatar_media_id}` : "",
        calls: Number(u.calls) || 0,
        units: Number(u.units) || 0,
        tokens: Number(u.tokens) || 0,
      })),
      top_models: topModels.map((m) => ({ model: m.model, calls: Number(m.calls) || 0, units: Number(m.units) || 0 })),
      by_channel: byChannel.map((c) => {
        const errors = errMap.get(Number(c.channel_id)) || 0;
        const calls = Number(c.calls) || 0;
        return {
          channel_id: Number(c.channel_id) || 0,
          name: c.channel_name || `渠道 #${c.channel_id}`,
          type: c.channel_type || "",
          calls,
          units: Number(c.units) || 0,
          errors,
          // 成功率 = 1 - 错误日志数/成功调用数。注意这是**近似值**：
          // 错误日志不区分「上游真实故障」与「业务限制」（余额不足等），
          // 所以它比监控页的 SLA 口径偏低，前端文案必须标「含限制」而不是当 SLA 用。
          success_rate: calls + errors > 0 ? Number(((calls / (calls + errors)) * 100).toFixed(1)) : null,
          avg_elapsed: Math.round(Number(c.avg_elapsed) || 0),
        };
      }),
      top_tokens: topTokens.map((t) => ({ token_id: Number(t.token_id) || 0, calls: Number(t.calls) || 0, units: Number(t.units) || 0 })),
      errors_by_model: errorsByModel.map((e) => ({ model: e.model, errors: Number(e.errors) || 0 })),
      realtime: {
        inFlight: Number(snap.gateway.inFlight) || 0,
        sla: snap.gateway.sla,
        errorRate: snap.gateway.errorRate,
        p95Ms: snap.gateway.latency?.p95Ms ?? null,
        uptimeSec: Math.round(Number(snap.process?.uptimeSec) || 0),
      },
    });
  })
);

// ---------------------------------------------------------------------------
// 社区数据（个人主页「统计」与管理员社区概况共用入口）
// ---------------------------------------------------------------------------
router.get(
  "/community",
  authRequired,
  asyncHandler(async (req, res) => {
    const { key, days, since } = rangeOf(req.query);
    const isAdmin = req.user.role >= 100;
    const uid = req.user.id;

    const [[mine]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM community_posts WHERE user_id = ? AND status <> 2) AS posts,
         (SELECT COALESCE(SUM(like_count),0) FROM community_posts WHERE user_id = ? AND status <> 2) AS likes,
         (SELECT COUNT(*) FROM community_comments WHERE user_id = ? AND status <> 2) AS comments,
         (SELECT COUNT(*) FROM community_follows WHERE follower_id = ?) AS following,
         (SELECT COUNT(*) FROM community_follows WHERE followee_id = ?) AS followers,
         (SELECT COUNT(*) FROM chat_room_members WHERE user_id = ?) AS rooms,
         (SELECT COUNT(*) FROM friendships WHERE user_id = ? AND status = 1) AS friends`,
      [uid, uid, uid, uid, uid, uid, uid]
    );
    const out = {
      range: { key, days },
      mine: {
        posts: Number(mine.posts) || 0,
        likes_received: Number(mine.likes) || 0,
        comments: Number(mine.comments) || 0,
        following: Number(mine.following) || 0,
        followers: Number(mine.followers) || 0,
        rooms: Number(mine.rooms) || 0,
        friends: Number(mine.friends) || 0,
      },
    };
    if (isAdmin) {
      const [[all]] = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM community_posts WHERE status = 1) AS posts,
           (SELECT COUNT(*) FROM community_posts WHERE status <> 2 AND created_time >= ?) AS posts_new,
           (SELECT COUNT(*) FROM community_comments WHERE status = 1) AS comments,
           (SELECT COUNT(*) FROM users WHERE status = 1) AS users,
           (SELECT COUNT(*) FROM chat_rooms WHERE status = 1) AS rooms,
           (SELECT COUNT(*) FROM chat_room_messages WHERE status = 1 AND created_time >= ?) AS messages_new,
           (SELECT COUNT(*) FROM friendships WHERE status = 1) AS friendships_total`,
        [since, since, since]
      );
      // 待处理内容：隐藏帖与举报（举报功能未做，这里只列隐藏/删除留痕）
      const [[pending]] = await pool.query("SELECT COUNT(*) AS n FROM community_posts WHERE status = 3");
      out.site = {
        posts: Number(all.posts) || 0,
        posts_new: Number(all.posts_new) || 0,
        comments: Number(all.comments) || 0,
        users: Number(all.users) || 0,
        rooms: Number(all.rooms) || 0,
        messages_new: Number(all.messages_new) || 0,
        friendships_total: Number(all.friendships_total) || 0,
        hidden_posts: Number(pending.n) || 0,
      };
    }
    return ok(res, out);
  })
);

export default router;
