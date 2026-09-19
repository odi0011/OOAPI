import { Router } from "express";
import { pool } from "../db.js";
import { ok, asyncHandler, pageParams, safeInt } from "../utils.js";
import { authRequired, adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE, LOG_TYPE_LABEL } from "../services/log.js";

const router = Router();

// 使用记录页与操作日志页的数据来源：
//   usage    = 只有消费（type=2）：模型/渠道/令牌/tokens/耗时/设备，是「用量审计」
//   operation= 其余（充值/管理/错误/登录）：是「谁做了什么」，与用量无关
// 之所以在服务端按 type 切分而不是前端过滤：日志量随调用数线性增长，
// 让前端拉全量再筛既费带宽，也会让操作日志被海量调用记录淹没。
const USAGE_TYPE = LOG_TYPE.CONSUME;

/**
 * 日志 → 响应对象。
 * 敏感字段（渠道/令牌/分组/原始 UA/成本价/上游错误明细）只给管理员：
 * 普通用户看到「自己的用量」即可，看到渠道等于泄露上游供应商。
 */
function mapLog(r, { isAdmin }) {
  const base = {
    id: r.id,
    user_id: r.user_id,
    username: r.username,
    created_at: r.created_at,
    type: r.type,
    type_label: LOG_TYPE_LABEL[r.type] || "其他",
    content: r.content,
    quota: Number(r.quota),
    model: r.model || "",
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    cache_tokens: Number(r.cache_tokens) || 0,
    first_token_ms: Number(r.first_token_ms) || 0,
    elapsed_ms: Number(r.elapsed_ms) || 0,
    // IP 是「自己的访问来源」，本人可见；设备同理（下面 device 无条件给，
    // 原始 UA 串只给管理员，避免被用来做指纹拼接）
    ip: r.ip || "",
    device: r.device || "",
  };
  if (!isAdmin) return base;
  return {
    ...base,
    channel_id: Number(r.channel_id) || 0,
    channel_name: r.channel_name || "",
    token_id: Number(r.token_id) || 0,
    token_name: r.token_name || "",
    group_name: r.group_name || "",
    user_agent: r.user_agent || "",
    detail: r.detail || "",
  };
}

/**
 * 解析时间范围参数（支持 days / start / end 秒级时间戳）。
 * @param {object} query
 * @param {number} defaultDays 未传/非法时的默认窗口（0 = 不限制）。
 *   summary 这类聚合查询必须给默认窗口：不带参数直接打接口会对全表做
 *   COUNT + SUM + AVG，大表上足以拖垮数据库。
 */
function timeRange(query = {}, defaultDays = 0) {
  const daysRaw = safeInt(query.days, { min: 0, max: 3660, fallback: null });
  const days = daysRaw === null ? defaultDays : daysRaw;
  const start = safeInt(query.start, { min: 0, max: 9_999_999_999_999, fallback: 0 });
  const end = safeInt(query.end, { min: 0, max: 9_999_999_999_999, fallback: 0 });
  const conds = [];
  const args = [];
  // days 与 start 都表达「起点」：取较晚的那个，避免 WHERE 里出现两个 created_at >= ?
  const fromDays = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  const from = Math.max(fromDays, start);
  if (from) {
    conds.push("created_at >= ?");
    args.push(from);
  }
  if (end) {
    conds.push("created_at <= ?");
    args.push(end);
  }
  return { conds, args };
}

/**
 * 公共查询构造：usage/operation 两页共用，差别只在 type 条件与可筛字段。
 * @param {object} opts
 * @param {boolean} opts.isAdmin
 * @param {number} opts.userId     普通用户只能看自己
 * @param {"usage"|"operation"} opts.kind
 * @param {number} [opts.defaultDays] 未传时间范围时的默认窗口（聚合查询用）
 */
function buildQuery({ isAdmin, userId, kind, query, defaultDays = 0 }) {
  const conds = [];
  const args = [];
  if (kind === "usage") {
    conds.push("type = ?");
    args.push(USAGE_TYPE);
  } else {
    // 操作日志排除消费：消费记录在「使用记录」页，两页内容不重叠
    conds.push("type <> ?");
    args.push(USAGE_TYPE);
  }
  if (!isAdmin) {
    conds.push("user_id = ?");
    args.push(userId);
  } else {
    // 管理员可按用户筛（操作日志排查越权/误操作时必备）
    const uid = safeInt(query.user_id, { min: 1, fallback: 0 });
    if (uid) {
      conds.push("user_id = ?");
      args.push(uid);
    }
  }
  const kw = String(query.keyword || "").trim();
  if (kw) {
    conds.push("(username LIKE ? OR content LIKE ? OR model LIKE ?)");
    args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  // 使用记录专有筛选
  if (kind === "usage") {
    const model = String(query.model || "").trim();
    if (model) {
      conds.push("model = ?");
      args.push(model.slice(0, 128));
    }
    const channelId = safeInt(query.channel_id, { min: 1, fallback: 0 });
    if (channelId && isAdmin) {
      conds.push("channel_id = ?");
      args.push(channelId);
    }
    const tokenId = safeInt(query.token_id, { min: 1, fallback: 0 });
    if (tokenId) {
      conds.push("token_id = ?");
      args.push(tokenId);
    }
  } else {
    // 操作日志专有筛选：按具体类型（管理/错误/登录/充值）
    const type = safeInt(query.type, { min: 1, max: 999, fallback: 0 });
    if (type && type !== USAGE_TYPE) {
      conds.push("type = ?");
      args.push(type);
    }
  }
  const range = timeRange(query, defaultDays);
  conds.push(...range.conds);
  args.push(...range.args);
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", args };
}

async function listLogs(req, res, kind) {
  const isAdmin = Number(req.user.role) >= 100;
  const { p, size, offset } = pageParams(req.query);
  // 默认 30 天窗口：与 /usage/summary、/usage/filters 保持同一口径。
  // 不这么做的后果是「裸调接口（不带 days）时列表是全量、卡片是近 30 天」——
  // 同一页两个口径会误导，且全量 COUNT(*) 在大表上没有上界。
  const { where, args } = buildQuery({
    isAdmin,
    userId: req.user.id,
    kind,
    query: req.query,
    defaultDays: 30,
  });
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM logs ${where}`, args);
  // 显式列出需要的列而不是 SELECT *：
  //   · detail 是 TEXT，只有管理员在详情里会看，列表页取回来纯属浪费带宽；
  //   · user_agent 同理（非管理员不返回）。
  // 普通用户查询因此不取这两列，管理员才带上。
  const cols = [
    "id", "user_id", "username", "created_at", "type", "content", "quota", "ip",
    "model", "channel_id", "channel_name", "token_id", "token_name", "group_name",
    "prompt_tokens", "completion_tokens", "cache_tokens", "first_token_ms", "elapsed_ms",
    "device", "price_phase",
    ...(isAdmin ? ["detail", "user_agent"] : []),
  ].join(", ");
  const [rows] = await pool.query(`SELECT ${cols} FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [
    ...args,
    size,
    offset,
  ]);
  return ok(res, {
    items: rows.map((r) => mapLog(r, { isAdmin })),
    total,
    page: p,
    page_size: size,
  });
}

/** 使用记录（消费）：模型/分组/密钥/内容/时间/首Token/总耗时/计费/tokens/缓存/IP/设备[+渠道] */
router.get(
  "/usage",
  authRequired,
  asyncHandler(async (req, res) => listLogs(req, res, "usage"))
);

/** 操作日志（非消费）：谁在什么时间做了什么 */
router.get(
  "/operation",
  authRequired,
  asyncHandler(async (req, res) => listLogs(req, res, "operation"))
);

/**
 * 筛选用的可选值（使用记录页的下拉）：
 * 只回「当前用户自己用过的」模型，管理员回全站。
 * 不做成独立大接口，避免把 logs 全表 DISTINCT 一遍。
 */
router.get(
  "/usage/filters",
  authRequired,
  asyncHandler(async (req, res) => {
    const isAdmin = Number(req.user.role) >= 100;
    const whereUser = isAdmin ? "" : "AND user_id = ?";
    const args = isAdmin ? [] : [req.user.id];
    // days=0 = 不限时间（与列表页「全部」同一口径）；未传或非法则默认 30 天。
    // 注意 max 给到 3660（10 年）而不是 365：候选值要覆盖列表能翻到的范围，
    // 否则会出现「表格里能看到某模型、筛选下拉里却选不到」。
    const daysRaw = safeInt(req.query.days, { min: 0, max: 3660, fallback: null });
    const days = daysRaw === null ? 30 : daysRaw;
    const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
    const sinceCond = since ? "AND created_at >= ?" : "";
    const sinceArgs = since ? [since] : [];
    const [models] = await pool.query(
      `SELECT model, COUNT(*) AS c FROM logs
        WHERE type = ? ${sinceCond} AND model <> '' ${whereUser}
        GROUP BY model ORDER BY c DESC LIMIT 100`,
      [USAGE_TYPE, ...sinceArgs, ...args]
    );
    const [tokens] = await pool.query(
      `SELECT token_id, token_name, COUNT(*) AS c FROM logs
        WHERE type = ? ${sinceCond} AND token_id > 0 ${whereUser}
        GROUP BY token_id, token_name ORDER BY c DESC LIMIT 100`,
      [USAGE_TYPE, ...sinceArgs, ...args]
    );
    return ok(res, {
      models: models.map((m) => ({ model: m.model, count: Number(m.c) })),
      tokens: tokens.map((t) => ({ id: Number(t.token_id), name: t.token_name || `#${t.token_id}`, count: Number(t.c) })),
    });
  })
);

// 兼容旧接口：/self 与 /（历史前端调用），保持可用但内部走同一套裁剪
router.get(
  "/self",
  authRequired,
  asyncHandler(async (req, res) => listLogs(req, res, "operation"))
);

router.get(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => listLogs(req, res, "operation"))
);

// ---------- 汇总统计（看板/记录页头部卡片）----------
/**
 * 使用记录页顶部的汇总卡：调用次数/消耗/tokens/缓存命中率/平均耗时。
 * 与 /api/users/data/self 的区别：这里按当前筛选条件聚合（看板是固定 30 天）。
 */
router.get(
  "/usage/summary",
  authRequired,
  asyncHandler(async (req, res) => {
    const isAdmin = Number(req.user.role) >= 100;
    // 默认 30 天窗口：不带参数的聚合查询在大表上是全表 COUNT/SUM/AVG，
    // 前端总是会带 days，但接口必须自己兜住（否则一个裸请求就能压住数据库）。
    const { where, args } = buildQuery({
      isAdmin,
      userId: req.user.id,
      kind: "usage",
      query: req.query,
      defaultDays: 30,
    });
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COALESCE(AVG(NULLIF(elapsed_ms,0)),0) AS avg_elapsed,
              COALESCE(AVG(NULLIF(first_token_ms,0)),0) AS avg_first_token
         FROM logs ${where}`,
      args
    );
    const prompt = Number(row.prompt_tokens) || 0;
    const cache = Number(row.cache_tokens) || 0;
    // 缓存命中率 = 命中 / 总输入。
    // 注意 prompt_tokens 是上游原值、**已经包含**缓存命中部分
    // （normalizeUsage 直接透传，扣减发生在 computeCost 内部），
    // 所以分母就是 prompt，不能再加一次 cache（那会把命中率算低约一半）。
    const uncached = Math.max(0, prompt - cache);
    return ok(res, {
      calls: Number(row.calls) || 0,
      units: Number(row.units) || 0,
      prompt_tokens: prompt,
      completion_tokens: Number(row.completion_tokens) || 0,
      cache_tokens: cache,
      uncached_tokens: uncached,
      cache_rate: prompt > 0 ? Number(((cache / prompt) * 100).toFixed(1)) : 0,
      avg_elapsed: Math.round(Number(row.avg_elapsed) || 0),
      avg_first_token: Math.round(Number(row.avg_first_token) || 0),
    });
  })
);

// ---------- 使用记录页的图表分析 ----------
/**
 * 按天趋势 + 按模型排行。与列表/汇总同一套筛选口径（走 buildQuery），
 * 所以图表与表格永远对得上（这是「同一页数据必须自洽」的基本要求）。
 */
router.get(
  "/usage/analysis",
  authRequired,
  asyncHandler(async (req, res) => {
    const isAdmin = Number(req.user.role) >= 100;
    const { where, args } = buildQuery({
      isAdmin,
      userId: req.user.id,
      kind: "usage",
      query: req.query,
      defaultDays: 30,
    });
    // 按天：用 FLOOR(created_at/86400)*86400 做桶（纯算术，能走 created_at 索引范围扫描）
    const [days] = await pool.query(
      `SELECT FLOOR(created_at/86400)*86400 AS day_ts,
              COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COALESCE(AVG(NULLIF(first_token_ms,0)),0) AS avg_first_token,
              COALESCE(AVG(NULLIF(elapsed_ms,0)),0) AS avg_elapsed
         FROM logs ${where}
        GROUP BY day_ts ORDER BY day_ts ASC`,
      args
    );
    // 按模型：消费 + tokens + 次数 + 成功率（成功率取同模型的错误日志数）
    const [models] = await pool.query(
      `SELECT model,
              COUNT(*) AS calls,
              COALESCE(SUM(quota),0) AS units,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cache_tokens),0) AS cache_tokens,
              COALESCE(AVG(NULLIF(elapsed_ms,0)),0) AS avg_elapsed
         FROM logs ${where}
        GROUP BY model ORDER BY units DESC LIMIT 20`,
      args
    );
    return ok(res, {
      byDay: days.map((d) => ({
        day: new Date(Number(d.day_ts) * 1000).toISOString().slice(0, 10),
        calls: Number(d.calls) || 0,
        units: Number(d.units) || 0,
        tokens: (Number(d.prompt_tokens) || 0) + (Number(d.completion_tokens) || 0),
        cacheTokens: Number(d.cache_tokens) || 0,
        avgFirstToken: Math.round(Number(d.avg_first_token) || 0),
        avgElapsed: Math.round(Number(d.avg_elapsed) || 0),
      })),
      byModel: models.map((m) => ({
        model: m.model || "-",
        calls: Number(m.calls) || 0,
        units: Number(m.units) || 0,
        tokens: (Number(m.prompt_tokens) || 0) + (Number(m.completion_tokens) || 0),
        cacheTokens: Number(m.cache_tokens) || 0,
        avgElapsed: Math.round(Number(m.avg_elapsed) || 0),
      })),
    });
  })
);

// 管理：清空日志（同时清掉使用记录与操作日志）
router.delete(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM logs");
    // 传 req：清库是高危操作，自身必须留 IP/设备痕迹（否则日志被清后查不到是谁清的）
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: "清空所有日志" });
    return ok(res, null, "日志已清空");
  })
);

export default router;
