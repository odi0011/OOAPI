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
import { groupConfigOf } from "../services/group-rate.js";
import { USAGE_SQL, usageLogWhere } from "../services/log.js";
import { userDataVisibility, visibleAccountData } from "../services/user-data-visibility.js";
import { logsWithSourceVendors, sourceVendors } from "../services/model-sources.js";

const router = Router();

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

function rangeOf(query) {
  const key = Object.hasOwn(RANGE_DAYS, String(query.range)) ? String(query.range) : "30d";
  const days = RANGE_DAYS[key];
  // 包含今天的 N 个北京日期。滚动 N*24h 会跨 N+1 个日期，导致趋势和日均消费错位。
  return { key, days, since: (bjDay(Date.now() / 1000) - days + 1) * 86400 - TZ };
}

// 北京时间偏移：看板页头写着「时区 UTC+8」，但原实现按 UTC 零点切天（FLOOR(created_at/86400)），
// 于是每天 0~8 点的调用被算进了前一天 —— 用户看到的「今天」其实是昨天 8 点到今天 8 点。
// 这里统一按 (ts + 8h) 切天/切小时；不依赖 MySQL 会话时区（FROM_UNIXTIME/HOUR 会随配置漂）。
const TZ = 8 * 3600;
const bjDay = (ts) => Math.floor((Number(ts) + TZ) / 86400);
// 新失败调用与部分计费只保留一行，不能再用「消费数 + 错误数」作分母。
const FAILURE_SQL = "(type = 4 AND is_usage = 1 AND status <> 'stopped')";
const SUCCESS_SQL = "(type = 2 AND status IN ('', 'success'))";

function recentUsageRow(l) {
  return { id: l.id, created_at: Number(l.created_at) || 0, model: l.model || "—", type: Number(l.type),
    status: l.status || (Number(l.type) === 2 ? "success" : "error"), elapsed_ms: Number(l.elapsed_ms) || 0,
    first_token_ms: Number(l.first_token_known) === 1 || Number(l.first_token_ms) > 0 ? Number(l.first_token_ms) || 0 : null,
    units: Number(l.quota) || 0, prompt_tokens: Number(l.prompt_tokens) || 0,
    completion_tokens: Number(l.completion_tokens) || 0, cache_tokens: Number(l.cache_tokens) || 0,
    model_vendor: l.model_vendor || "", source_vendors: sourceVendors(l.source_vendors) };
}

/** 按天趋势（消费 + 调用 + token + 缓存），缺数据的日期补 0（否则折线会断） */
async function dailyTrend(userId, since, days, tokenId = 0) {
  const args = [since];
  let where = `created_at >= ? AND ${USAGE_SQL}`;
  if (userId) {
    where += " AND user_id = ?";
    args.push(userId);
  }
  if (tokenId) { where += " AND token_id = ?"; args.push(tokenId); }
  const [rows] = await pool.query(
    `SELECT FLOOR((created_at + ${TZ})/86400) AS bj_day,
            COUNT(*) AS calls,
            COALESCE(SUM(quota),0) AS units,
            COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens),0) AS completion_tokens,
            COALESCE(SUM(cache_tokens),0) AS cache_tokens
       FROM logs WHERE ${where} GROUP BY FLOOR((created_at + ${TZ})/86400) ORDER BY bj_day`,
    args
  );
  const map = new Map(rows.map((r) => [Number(r.bj_day), r]));
  const out = [];
  const today = bjDay(Date.now() / 1000);
  // 补齐空白日期：前端折线图需要连续的时间轴，否则「中间没数据的那天」
  // 会被压掉，视觉上把两周的消费画成连续增长（误导）
  for (let d = bjDay(since); d <= today; d += 1) {
    const r = map.get(d);
    const t = d * 86400 - TZ; // 北京时间当天零点的 unix 秒
    out.push({
      // d*86400 按 UTC 读出的年月日就是北京日期
      day: new Date(d * 86400 * 1000).toISOString().slice(0, 10),
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

/**
 * 上一周期（等长、紧邻之前）的汇总：看板数字要能回答「比上期多了还是少了」，
 * 只有绝对值时用户无法判断 1,234 次调用是涨是跌。
 */
async function previousTotals(userId, since, days, tokenId = 0) {
  const from = since - days * 86400;
  const args = [from, since];
  let where = `${USAGE_SQL} AND created_at >= ? AND created_at < ?`;
  if (userId) {
    where += " AND user_id = ?";
    args.push(userId);
  }
  if (tokenId) { where += " AND token_id = ?"; args.push(tokenId); }
  const [[p]] = await pool.query(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(${SUCCESS_SQL}),0) AS successes, COALESCE(SUM(quota),0) AS units,
            COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens, COUNT(DISTINCT user_id) AS users
       FROM logs WHERE ${where}`,
    args
  );
  const eargs = [from, since];
  let ew = `${FAILURE_SQL} AND created_at >= ? AND created_at < ?`;
  if (userId) {
    ew += " AND user_id = ?";
    eargs.push(userId);
  }
  if (tokenId) { ew += " AND token_id = ?"; eargs.push(tokenId); }
  const [[e]] = await pool.query(`SELECT COUNT(*) AS n FROM logs WHERE ${ew}`, eargs);
  return {
    calls: Number(p.calls) || 0,
    successes: Number(p.successes) || 0,
    success_rate: Number(p.calls) ? Number(((Number(p.successes) / Number(p.calls)) * 100).toFixed(2)) : null,
    units: Number(p.units) || 0,
    tokens: Number(p.tokens) || 0,
    active_users: Number(p.users) || 0,
    errors: Number(e.n) || 0,
  };
}

async function errorCount(userId, since, tokenId = 0) {
  const args = [since];
  let where = `${FAILURE_SQL} AND created_at >= ?`;
  if (userId) {
    where += " AND user_id = ?";
    args.push(userId);
  }
  if (tokenId) { where += " AND token_id = ?"; args.push(tokenId); }
  const [[e]] = await pool.query(`SELECT COUNT(*) AS n FROM logs WHERE ${where}`, args);
  return Number(e.n) || 0;
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
    const visibility = userDataVisibility(req.user);
    if (!visibility.usage_summary) {
      const [recent] = visibility.usage_records ? await pool.query(
        `SELECT id, created_at, model, type, status, elapsed_ms, first_token_ms, first_token_known, quota, prompt_tokens, completion_tokens, cache_tokens, channel_id,
          CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.source_vendors') ELSE NULL END AS source_vendors,
          CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.billing_details') ELSE NULL END AS billing_details
          FROM logs WHERE user_id = ? AND ${USAGE_SQL} ORDER BY id DESC LIMIT 8`, [uid]) : [[]];
      return ok(res, { range: { key, days }, account: visibleAccountData({ quota: Number(req.user.quota) || 0, group_name: req.user.group_name || "" }, req.user),
        recent_logs: (await logsWithSourceVendors(recent)).map(recentUsageRow) });
    }

    const [[agg]] = await pool.query(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(${SUCCESS_SQL}),0) AS successes,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COUNT(DISTINCT model) AS models,
              COALESCE(AVG(NULLIF(elapsed_ms,0)),0) AS avg_elapsed
         FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ?`,
      [uid, since]
    );

    // 模型分布：保证分项与总和 100% 对齐。超出 12 个时将剩余部分归集入「其他模型」
    const [allModels] = await pool.query(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
         FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ?
        GROUP BY model ORDER BY units DESC`,
      [uid, since]
    );
    let byModel = [];
    if (allModels.length <= 12) {
      byModel = allModels;
    } else {
      const top = allModels.slice(0, 11);
      const rest = allModels.slice(11);
      byModel = [
        ...top,
        {
          model: "其他模型",
          calls: rest.reduce((s, x) => s + (Number(x.calls) || 0), 0),
          units: rest.reduce((s, x) => s + (Number(x.units) || 0), 0),
          prompt_tokens: rest.reduce((s, x) => s + (Number(x.prompt_tokens) || 0), 0),
          completion_tokens: rest.reduce((s, x) => s + (Number(x.completion_tokens) || 0), 0),
        },
      ];
    }

    const [byChannel] = await pool.query(
      `SELECT channel_id, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ? AND channel_id > 0
        GROUP BY channel_id ORDER BY units DESC LIMIT 8`,
      [uid, since]
    );
    // 按小时分布：看出「我什么时候在用」（对个人是最直观的节奏信息）
    const [byHour] = await pool.query(
      `SELECT FLOOR(MOD(created_at + ${TZ}, 86400) / 3600) AS hour, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE user_id = ? AND ${USAGE_SQL} AND created_at >= ?
        GROUP BY FLOOR(MOD(created_at + ${TZ}, 86400) / 3600) ORDER BY hour`,
      [uid, since]
    );
    const errors = await errorCount(uid, since);
    const prev = await previousTotals(uid, since, days);
    // 缓存命中率：分母是 prompt（prompt 已含缓存部分，不能再加一次）
    const prompt = Number(agg.prompt_tokens) || 0;
    const cache = Number(agg.cache_tokens) || 0;
    const comp = Number(agg.completion_tokens) || 0;
    const trend = await dailyTrend(uid, since, days);

    // 用户有效令牌数与分组倍率
    const [[tokRow]] = await pool.query(
      "SELECT COUNT(*) AS total_tokens, COALESCE(SUM(status = 1 AND (expired_time <= 0 OR expired_time > ?) AND (unlimited_quota = 1 OR remain_quota > 0)), 0) AS active_tokens FROM tokens WHERE user_id = ?",
      [Math.floor(Date.now() / 1000), uid]
    );
    const userGroupName = req.user.group_name || "";
    const groupCfg = await groupConfigOf(userGroupName);
    const groupRate = groupCfg?.rate ?? 1.0;

    // 最近 8 条调用动态：让开发者第一时间知道接口是否调通、状态与消耗
    const [recentLogs] = await pool.query(
      `SELECT id, created_at, model, type, status, elapsed_ms, first_token_ms, first_token_known, quota, prompt_tokens, completion_tokens, cache_tokens, channel_id,
              CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.source_vendors') ELSE NULL END AS source_vendors,
              CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.billing_details') ELSE NULL END AS billing_details
         FROM logs WHERE user_id = ? AND ${USAGE_SQL}
        ORDER BY id DESC LIMIT 8`,
      [uid]
    );

    const totalCalls = Number(agg.calls) || 0;
    const successes = Number(agg.successes) || 0;
    const succRate = totalCalls > 0 ? Number(((successes / totalCalls) * 100).toFixed(2)) : null;

    return ok(res, {
      range: { key, days },
      totals: {
        calls: totalCalls,
        successes,
        units: Number(agg.units) || 0,
        prompt_tokens: prompt,
        completion_tokens: comp,
        total_tokens: prompt + comp,
        cache_tokens: cache,
        uncached_tokens: Math.max(0, prompt - cache),
        cache_rate: prompt > 0 ? Number(((cache / prompt) * 100).toFixed(1)) : 0,
        models: Number(agg.models) || 0,
        errors,
        avg_elapsed: Math.round(Number(agg.avg_elapsed) || 0),
        success_rate: succRate,
      },
      previous: prev,
      // 账户与钱包：全生命周期指标单独封装，与「区间时段」彻底隔离
      account: visibleAccountData({
        quota: Number(req.user.quota) || 0,
        used_quota: Number(req.user.used_quota) || 0,
        request_count: Number(req.user.request_count) || 0,
        group_name: userGroupName,
        group_rate: groupRate,
        active_tokens: Number(tokRow?.active_tokens) || 0,
        total_tokens: Number(tokRow?.total_tokens) || 0,
      }, req.user),
      trend,
      by_model: byModel.map((m) => ({
        model: m.model || "未记录模型",
        calls: Number(m.calls) || 0,
        units: Number(m.units) || 0,
        prompt_tokens: Number(m.prompt_tokens) || 0,
        completion_tokens: Number(m.completion_tokens) || 0,
      })),
      ...(Number(req.user.role) >= 100 ? { by_channel: byChannel.map((c) => ({
        channel_id: Number(c.channel_id) || 0,
        calls: Number(c.calls) || 0,
        units: Number(c.units) || 0,
      })) } : {}),
      by_hour: Array.from({ length: 24 }, (_, h) => {
        const hit = byHour.find((x) => Number(x.hour) === h);
        return { hour: h, calls: Number(hit?.calls) || 0, units: Number(hit?.units) || 0 };
      }),
      recent_logs: visibility.usage_records ? (await logsWithSourceVendors(recentLogs)).map(recentUsageRow) : [],
    });
  })
);

// ---------------------------------------------------------------------------
// 管理端维度
// ---------------------------------------------------------------------------
router.get("/filters", adminRequired, asyncHandler(async (req, res) => {
  const userId = safeInt(req.query.user_id, { min: 1, fallback: 0 });
  const [users] = await pool.query("SELECT id,username,display_name FROM users ORDER BY id");
  const [tokens] = await pool.query(`SELECT t.id,t.name,COALESCE(NULLIF(u.display_name,''),u.username) AS owner FROM tokens t JOIN users u ON u.id=t.user_id ${userId ? "WHERE t.user_id = ?" : ""} ORDER BY t.id`, userId ? [userId] : []);
  return ok(res, { users, tokens });
}));

router.get(
  "/admin",
  adminRequired,
  asyncHandler(async (req, res) => {
    const { key, days, since } = rangeOf(req.query);

    const userId = safeInt(req.query.user_id, { min: 1, fallback: 0 }), tokenId = safeInt(req.query.token_id, { min: 1, fallback: 0 });
    if (tokenId) {
      const [[token]] = await pool.query("SELECT user_id FROM tokens WHERE id = ?", [tokenId]);
      if (!token || (userId && Number(token.user_id) !== userId)) return fail(res, "密钥不属于所选用户", 400);
    }
    const query = (sql, args = []) => {
      if (!/FROM logs\b/.test(sql)) return pool.query(sql, args);
      const prefix = /FROM logs l\b/.test(sql) ? "l." : "";
      const conds = [], values = [];
      if (userId) { conds.push(`${prefix}user_id = ?`); values.push(userId); }
      if (tokenId) { conds.push(`${prefix}token_id = ?`); values.push(tokenId); }
      return pool.query(conds.length ? sql.replace(/WHERE /, `WHERE ${conds.join(" AND ")} AND `) : sql, [...values, ...args]);
    };
    const [[agg]] = await query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COUNT(DISTINCT user_id) AS users,
              COUNT(DISTINCT model) AS models,
              COALESCE(AVG(NULLIF(elapsed_ms,0)),0) AS avg_elapsed
         FROM logs WHERE ${USAGE_SQL} AND created_at >= ?`,
      [since]
    );
    // 用户排行：按消费额，同时给调用数与 token（只看消费额会漏掉「高频低耗」的用户）
    const [topUsers] = await query(
      `SELECT l.user_id, COUNT(*) AS calls, COALESCE(SUM(l.quota),0) AS units,
              COALESCE(SUM(l.prompt_tokens + l.completion_tokens),0) AS tokens,
              u.username, u.display_name, u.avatar_media_id
         FROM logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE ${usageLogWhere('l')} AND l.created_at >= ?
        GROUP BY l.user_id, u.username, u.display_name, u.avatar_media_id ORDER BY units DESC LIMIT 10`,
      [since]
    );
    const [allTopModels] = await query(
      `SELECT model, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE ${USAGE_SQL} AND created_at >= ?
        GROUP BY model ORDER BY units DESC`,
      [since]
    );
    let topModels = [];
    if (allTopModels.length <= 12) {
      topModels = allTopModels;
    } else {
      const top = allTopModels.slice(0, 11);
      const rest = allTopModels.slice(11);
      topModels = [
        ...top,
        {
          model: "其他模型",
          calls: rest.reduce((s, x) => s + (Number(x.calls) || 0), 0),
          units: rest.reduce((s, x) => s + (Number(x.units) || 0), 0),
        },
      ];
    }
    const [byChannel] = await query(
      `SELECT l.channel_id, COUNT(*) AS calls, COALESCE(SUM(l.type = 2 AND l.status IN ('', 'success')),0) AS successes, COALESCE(SUM(l.quota),0) AS units,
              COALESCE(AVG(NULLIF(l.elapsed_ms,0)),0) AS avg_elapsed,
              AVG(CASE WHEN l.first_token_known = 1 OR l.first_token_ms > 0 THEN l.first_token_ms END) AS avg_first_token,
              c.name AS channel_name, c.type AS channel_type
         FROM logs l LEFT JOIN channels c ON c.id = l.channel_id
        WHERE ${usageLogWhere('l')} AND l.created_at >= ? AND l.channel_id > 0
        GROUP BY l.channel_id, c.name, c.type ORDER BY units DESC LIMIT 12`,
      [since]
    );
    // 保留历史错误统计；新错误已包含在调用总数内，只计一次。
    const [channelErrors] = await query(
      `SELECT channel_id, COUNT(*) AS errors FROM logs
        WHERE ${FAILURE_SQL} AND created_at >= ? AND channel_id > 0 GROUP BY channel_id`,
      [since]
    );
    const errMap = new Map(channelErrors.map((e) => [Number(e.channel_id), Number(e.errors) || 0]));
    // 令牌维度：谁在用哪个 Key（管理员排查「某个 Key 在刷量」时的入口）
    // 先按 token_id 聚合再关联名称与持有人（原先只给 id，看板上只能显示「令牌 #184」，
    // 管理员还得去日志页反查是谁的 Key）。子查询聚合后再 JOIN，ONLY_FULL_GROUP_BY 下合法。
    const [topTokens] = await query(
      `SELECT t.token_id, t.calls, t.units, k.name AS token_name, u.username, u.display_name
         FROM (SELECT token_id, COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
                 FROM logs WHERE ${USAGE_SQL} AND created_at >= ? AND token_id > 0
                GROUP BY token_id ORDER BY units DESC LIMIT 10) t
         LEFT JOIN tokens k ON k.id = t.token_id
         LEFT JOIN users u ON u.id = k.user_id
        ORDER BY t.units DESC`,
      [since]
    );
    const errorsTotal = await errorCount(userId, since, tokenId);
    const prev = await previousTotals(userId, since, days, tokenId);
    // 失败调用分布：与汇总使用相同口径，排除停止和旧版重复错误日志。
    const [errorsByModel] = await query(
      `SELECT model, COUNT(*) AS errors FROM logs
        WHERE ${FAILURE_SQL} AND created_at >= ?
        GROUP BY model ORDER BY errors DESC LIMIT 10`,
      [since]
    );
    const [[users]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE status = 1");
    const [[newUsers]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE created_time >= ?", [since]);

    const prompt = Number(agg.prompt_tokens) || 0;
    const cache = Number(agg.cache_tokens) || 0;
    const trend = await dailyTrend(userId, since, days, tokenId);
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
        total_tokens: prompt + (Number(agg.completion_tokens) || 0),
        cache_tokens: cache,
        uncached_tokens: Math.max(0, prompt - cache),
        cache_rate: prompt > 0 ? Number(((cache / prompt) * 100).toFixed(1)) : 0,
        active_users: Number(agg.users) || 0,
        models: Number(agg.models) || 0,
        users_total: Number(users.n) || 0,
        users_new: Number(newUsers.n) || 0,
        errors: errorsTotal,
        avg_elapsed: Math.round(Number(agg.avg_elapsed) || 0),
      },
      previous: prev,
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
      top_models: topModels.map((m) => ({ model: m.model || "未记录模型", calls: Number(m.calls) || 0, units: Number(m.units) || 0 })),
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
          success_rate: calls > 0 ? Number(((Number(c.successes) / calls) * 100).toFixed(1)) : null,
          avg_elapsed: Math.round(Number(c.avg_elapsed) || 0),
          avg_first_token: c.avg_first_token == null ? null : Math.round(Number(c.avg_first_token)),
        };
      }),
      top_tokens: topTokens.map((t) => ({
        token_id: Number(t.token_id) || 0,
        name: t.token_name || `令牌 #${t.token_id}`,
        owner: t.display_name || t.username || "",
        calls: Number(t.calls) || 0,
        units: Number(t.units) || 0,
      })),
      errors_by_model: errorsByModel.map((e) => ({ model: e.model || "未记录模型", errors: Number(e.errors) || 0 })),
      realtime: {
        inFlight: Number(snap.gateway.inFlight) || 0,
        sla: snap.gateway.sla,
        errorRate: snap.gateway.upstream?.rate ?? null,
        p95Ms: snap.gateway.latency?.samples ? snap.gateway.latency.p95Ms : null,
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
