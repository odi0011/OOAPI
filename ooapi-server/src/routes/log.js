import { endpointPath, endpointList } from "../services/endpoint-audit.js";
import { Router } from "express";
import { pool } from "../db.js";
import { ok, asyncHandler, pageParams, safeInt } from "../utils.js";
import { authRequired, adminRequired, superRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE, LOG_TYPE_LABEL, USAGE_SQL } from "../services/log.js";
import { canonicalModelName } from "../services/models.js";
import { userDataVisibility, requireUserData } from "../services/user-data-visibility.js";
import { logsWithSourceVendors, sourceVendors } from "../services/model-sources.js";

const router = Router();

// 使用记录页与操作日志页的数据来源：
//   usage    = 消费与显式标记的失败调用：一调用一行，失败partial费用也在此审计。
//   operation= 其余充值/管理/历史错误/登录：是「谁做了什么」，与用量无关。
// 之所以在服务端按 type 切分而不是前端过滤：日志量随调用数线性增长，
// 让前端拉全量再筛既费带宽，也会让操作日志被海量调用记录淹没。
const USAGE_TYPE = LOG_TYPE.CONSUME;

/** 只给本人平台费用快照；递归白名单，不能直接返回含渠道报价/上游ID的JSON。 */
function publicBillingDetails(value) {
  if (!value || value.version !== 1) return null;
  const number = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  const component = (v) => ({ tokens: number(v?.tokens), unit_price: number(v?.unit_price), cost_od: number(v?.cost_od), mixed: v?.mixed === true });
  const price = value.platform_price && typeof value.platform_price === "object" ? Object.fromEntries(["in", "out", "cache"].map((k) => [k, number(value.platform_price[k])])) : null;
  return { version: 1, components: { input: component(value.components?.input), output: component(value.components?.output), cache: component(value.components?.cache) },
    platform_unit_prices: Object.fromEntries(["input", "output", "cache"].map((key) => [key,
      (Array.isArray(value.platform_unit_prices?.[key]) ? value.platform_unit_prices[key] : []).map(number).filter((n) => n !== null && n >= 0).slice(0, 40)])),
    price_quoted: value.price_quoted === true, usage_present: value.usage_present === true,
    platform_price: price, price_mode: value.price_mode === "mixed" ? "mixed" : "single",
    raw_cost_od: number(value.raw_cost_od), base_cost_units: number(value.base_cost_units), base_cost_od: number(value.base_cost_od),
    multiplier: number(value.multiplier), charged_cost_units: number(value.charged_cost_units), charged_cost_od: number(value.charged_cost_od),
    pre_rate_rounding_units: number(value.pre_rate_rounding_units), adjustment_units: number(value.adjustment_units),
    price_phase: /^(peak|offpeak|flat)(\+(peak|offpeak|flat))*$/.test(String(value.price_phase)) ? value.price_phase : "",
    context_tier: number(value.context_tier), call_count: number(value.call_count) };
}

/**
 * 日志 → 响应对象。
 * 渠道ID/名称/上游明细仍只给管理员；source_vendors仅是用户授权展示的注册厂商品牌。
 */
function mapLog(r, { isAdmin, user = null }) {
  let detail = {};
  try { detail = JSON.parse(r.detail || "{}"); } catch { /* 老操作日志不一定是JSON */ }
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) detail = {};
  let bill = detail.billing_details || r.billing_details || null;
  if (typeof bill === "string") { try { bill = JSON.parse(bill); } catch { bill = null; } }
  if (bill?.version !== 1) bill = null; // 不用当前配置或旧SKU价伪造历史渠道报价/费用。
  const base = {
    id: r.id,
    user_id: r.user_id,
    username: r.username,
    created_at: r.created_at,
    type: r.type,
    type_label: LOG_TYPE_LABEL[r.type] || "其他",
    is_usage: Number(r.type) === LOG_TYPE.CONSUME || Number(r.is_usage) === 1,
    status: r.status || (Number(r.type) === LOG_TYPE.ERROR ? "error" : "success"),
    error_code: r.error_code || detail.code || "",
    retry_count: Number(r.retry_count) || 0,
    input_text: r.input_text || "", // 旧prompt含系统模板，绝不回填成用户原文。
    output_text: r.output_text || detail.output_text || "",
    input_recorded: r.input_recorded === undefined ? r.input_text != null : Number(r.input_recorded) === 1,
    output_recorded: r.output_recorded === undefined ? r.output_text != null || Object.hasOwn(detail, "output_text") : Number(r.output_recorded) === 1,
    input_truncated: Boolean(Number(r.input_truncated) || detail.input_truncated),
    output_truncated: Boolean(Number(r.output_truncated) || detail.output_truncated),
    prompt_truncated: Boolean(detail.prompt_truncated),
    request_prompt_truncated: Boolean(Number(r.request_prompt_truncated) || detail.request_prompt_truncated || detail.prompt_truncated),
    content: r.content,
    quota: Number(r.quota),
    billing_details: isAdmin ? bill : publicBillingDetails(bill),
    billing_known: Number(r.billing_unknown) !== 1 && detail.billing_known !== false,
    model: canonicalModelName(r.model) || r.model || "",
    reasoning_effort: String(r.reasoning_effort || detail.reasoning_effort || ""),
    inbound_endpoint: endpointPath(r.inbound_endpoint || detail.inbound_endpoint || ""),
    reasoning_applied: r.reasoning_applied === true || Number(r.reasoning_applied) === 1 || detail.reasoning_applied === true,
    model_vendor: r.model_vendor || "",
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    cache_tokens: Number(r.cache_tokens) || 0,
    first_token_ms: Number(r.first_token_known) === 1 || Number(r.first_token_ms) > 0 ? Number(r.first_token_ms) || 0 : null,
    elapsed_ms: Number(r.elapsed_ms) || 0,
    // IP 是「自己的访问来源」，本人可见；设备同理（下面 device 无条件给，
    // 原始 UA 串只给管理员，避免被用来做指纹拼接）
    ip: r.ip || "",
    device: r.device || "",
    // 关联一次运行与它的审计行，本人可见。新失败调用只产生一条usage行。
    request_id: r.request_id || "",
    // 令牌与分组**对本人可见**。
    //
    // 原先这三个字段只给管理员，普通用户看不到「这笔调用是哪把 Key 花的」——
    // 人格实测报的（小团队负责人，一人管 10 把 Key）：
    //   「使用记录里没有『密钥』列。我 10 个人 10 把钥匙，想知道小李这个月花了多少，
    //     得先去筛选框选中他那把钥匙。我要的是每一行直接写着谁花的。」
    //
    // 这几个值描述的是**用户自己的资源**（他自己创建的 Key、他自己选的分组），
    // 不是别人的信息 —— 与 channel_name 不同：后者是上游账号身份，泄露它
    // 等于暴露供应商来源，所以仍然只给管理员。
    token_id: Number(r.token_id) || 0,
    token_name: r.token_name || "",
    group_name: r.group_name || "",
    source_vendors: sourceVendors(r.source_vendors),
  };
  if (!isAdmin) {
    const visibility = userDataVisibility(user);
    if (!visibility.pricing) base.billing_details = null;
    if (!visibility.usage_records && Number(r.type) === LOG_TYPE.ERROR) {
      // 旧调用错误位于操作日志：不能借兼容入口绕过逐次使用记录权限。
      for (const key of ["model", "model_vendor", "quota", "prompt_tokens", "completion_tokens", "cache_tokens", "first_token_ms", "elapsed_ms", "retry_count", "price_phase", "billing_details", "request_id", "token_id", "token_name", "group_name", "source_vendors", "inbound_endpoint", "reasoning_effort", "reasoning_applied"]) delete base[key];
    }
    if (!visibility.request_content) {
      for (const key of ["input_text", "output_text", "input_recorded", "output_recorded", "input_truncated", "output_truncated", "prompt_truncated", "request_prompt_truncated"]) delete base[key];
      if (base.is_usage || Number(r.type) === LOG_TYPE.ERROR) base.content = base.status === "stopped" ? "调用已停止" : base.status === "error" ? "调用失败" : "模型调用";
    }
    if (!visibility.balance && !visibility.usage_summary && !base.is_usage) {
      delete base.quota;
      if (Number(r.type) === LOG_TYPE.TOPUP || /额度|充值|赠送|余额/.test(String(base.content || ""))) base.content = "账户额度变更";
    }
    return base;
  }
  return {
    ...base,
    upstream_endpoints: endpointList(detail.upstream_endpoints),
    original_model: detail.upstream_model || detail.requested_model || r.model || "",
    requested_model: detail.requested_model || r.model || "",
    upstream_model: detail.upstream_model || "",
    pricing_model: detail.pricing_model || "",
    requested_price: detail.requested_price || null,
    original_price: bill?.channel_quote?.status === "available" ? bill.channel_quote.price || null : null,
    effective_price: detail.price || null,
    model_calls: Array.isArray(detail.model_calls) ? detail.model_calls : [],
    request_prompt_text: r.request_prompt_text || detail.request_prompt_text || detail.prompt_text || "",
    channel_id: Number(r.channel_id) || 0,
    channel_name: r.channel_name || "",
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
function buildQuery({ isAdmin, userId, kind, query, defaultDays = 0, showContent = false }) {
  const conds = [];
  const args = [];
  if (kind === "usage") {
    conds.push(USAGE_SQL);
  } else {
    // 操作日志排除消费：消费记录在「使用记录」页，两页内容不重叠
    conds.push(`NOT ${USAGE_SQL}`);
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
    conds.push(showContent ? "(username LIKE ? OR content LIKE ? OR model LIKE ?)" : "(username LIKE ? OR model LIKE ?)");
    args.push(...Array(showContent ? 3 : 2).fill(`%${kw}%`));
  }
  // 使用记录专有筛选
  if (kind === "usage") {
    const model = String(query.model || "").trim();
    const status = String(query.status || "");
    if (["success", "error", "stopped"].includes(status)) {
      conds.push("COALESCE(NULLIF(status, ''), IF(type = 4, 'error', 'success')) = ?");
      args.push(status);
    }
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
    const group = String(query.group || query.group_name || "").trim();
    if (group) {
      if (group === "__public__" || group === "公共" || group === "default") {
        conds.push("(group_name IS NULL OR group_name = '' OR group_name = 'default')");
      } else {
        conds.push("group_name = ?");
        args.push(group.slice(0, 64));
      }
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
  const visibility = userDataVisibility(req.user);
  if (kind === "usage" && !visibility.usage_records) return res.status(403).json({ success: false, message: "管理员未开放使用记录查看权限" });
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
    showContent: visibility.request_content,
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
    "input_text",
    "(input_text IS NOT NULL) AS input_recorded",
    "(output_text IS NOT NULL OR CASE WHEN JSON_VALID(detail) THEN JSON_CONTAINS_PATH(detail, 'one', '$.output_text') ELSE 0 END) AS output_recorded",
    // 历史输出仍是模型正文，允许本人读取；历史prompt包含系统模板，不回填为用户输入。
    "COALESCE(NULLIF(output_text,''), CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.output_text')) ELSE NULL END, '') AS output_text",
    "is_usage", "status", "error_code", "retry_count", "first_token_known",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.input_truncated')) = 'true' ELSE 0 END AS input_truncated",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.output_truncated')) = 'true' ELSE 0 END AS output_truncated",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.request_prompt_truncated')) = 'true' ELSE 0 END AS request_prompt_truncated",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.billing_known')) = 'false' ELSE 0 END AS billing_unknown",
    "CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.billing_details') ELSE NULL END AS billing_details",
    "CASE WHEN JSON_VALID(detail) THEN JSON_EXTRACT(detail, '$.source_vendors') ELSE NULL END AS source_vendors",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reasoning_effort')) ELSE NULL END AS reasoning_effort",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.inbound_endpoint')) ELSE NULL END AS inbound_endpoint",
    "CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reasoning_applied')) = 'true' ELSE 0 END AS reasoning_applied",
    // request_id 必须返回：一次调用可能产生两条记录（计费行 + 错误行，
    // 见「客户端提前断开」那个场景），没有这个字段用户在界面上**无法把两条对起来**。
    // 黑盒测试实测抱怨（运维人格）：「两页都没有 request_id，我只能下 SQL 才看得出来
    // 是同一次调用」—— 排查断连/重试问题时它是唯一的关联键。
    "request_id",
    ...(isAdmin ? ["detail", "user_agent"] : []),
    ...(isAdmin ? ["request_prompt_text"] : []),
  ].join(", ");
  const [rows] = await pool.query(`SELECT ${cols} FROM logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...args,
    size,
    offset,
  ]);

  // 附上渠道类型，供前端渲染**厂商图标**。
  //
  // 用户反馈（原话）：「使用记录里我看到咋还有模型是用的默认的我们系统 logo？
  // 应该是跟随其厂商的图标啊。」—— 模型图标原先只按模型名判定，
  // 有些模型名里既没有厂商前缀、也不在图标规则里（OpenCode 自有的 `omen-alpha`、
  // 聚合渠道的 `openrouter/free`），就掉到平台 logo 了。
  // 而这些模型**跑在哪个渠道上是知道的**（logs.channel_id），
  // 渠道的厂商图标正是「跟随其厂商」的兜底答案。
  //
  // 为什么在查询之后补一次而不是 JOIN：where 子句用的是裸列名（`type = ?`），
  // 加 JOIN 就得给所有列加表别名，改动面大且容易漏（这文件里 where 被
  // COUNT 与列表两处复用）。这里是「一页 20~50 条日志、渠道表只有十几行」，
  // 单独查一次拿 id→type 映射更简单也更安全。
  const chanIds = [...new Set(rows.map((r) => Number(r.channel_id) || 0).filter(Boolean))];
  const chanType = new Map();
  // 管理员兼容字段channel_type保留；普通用户只取安全来源数组，优先读历史快照。
  if (isAdmin && chanIds.length) {
    const [ch] = await pool
      .query(`SELECT id, type FROM channels WHERE id IN (${chanIds.map(() => "?").join(",")})`, chanIds)
      .catch(() => [[]]);
    for (const c of ch) chanType.set(Number(c.id), String(c.type || ""));
  }

  const sourcedRows = await logsWithSourceVendors(rows);
  return ok(res, {
    items: sourcedRows.map((r) => ({
      ...mapLog(r, { isAdmin, user: req.user }),
      // source_vendors已提供实际来源图标；channel_type仅保留管理员旧接口兼容。
      // 普通用户仍拿不到渠道ID/名称/凭据，其品牌展示遵循使用记录可见权限。
      ...(isAdmin ? { channel_type: chanType.get(Number(r.channel_id) || 0) || "" } : {}),
    })),
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
  requireUserData("usage_records"),
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
        WHERE ${USAGE_SQL} ${sinceCond} AND model <> '' ${whereUser}
        GROUP BY model ORDER BY c DESC LIMIT 100`,
      [...sinceArgs, ...args]
    );
    const [tokens] = await pool.query(
      `SELECT token_id, token_name, COUNT(*) AS c FROM logs
        WHERE ${USAGE_SQL} ${sinceCond} AND token_id > 0 ${whereUser}
        GROUP BY token_id, token_name ORDER BY c DESC LIMIT 100`,
      [...sinceArgs, ...args]
    );
    const [groups] = await pool.query(
      `SELECT group_name, COUNT(*) AS c FROM logs
        WHERE ${USAGE_SQL} ${sinceCond} AND group_name IS NOT NULL AND group_name <> '' AND group_name <> 'default' ${whereUser}
        GROUP BY group_name ORDER BY c DESC LIMIT 50`,
      [...sinceArgs, ...args]
    );
    const [[publicGroup]] = await pool.query(
      `SELECT COUNT(*) AS c FROM logs
        WHERE ${USAGE_SQL} ${sinceCond} AND (group_name IS NULL OR group_name = '' OR group_name = 'default') ${whereUser}`,
      [...sinceArgs, ...args]
    );
    return ok(res, {
      models: models.map((m) => ({ model: m.model, count: Number(m.c) })),
      tokens: tokens.map((t) => ({ id: Number(t.token_id), name: t.token_name || `#${t.token_id}`, count: Number(t.c) })),
      groups: [
        ...(publicGroup && Number(publicGroup.c) > 0 ? [{ name: "__public__", label: "公共", count: Number(publicGroup.c) }] : []),
        ...groups.map((g) => ({ name: g.group_name, label: g.group_name, count: Number(g.c) })),
      ],
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
  requireUserData("usage_summary"),
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
      showContent: userDataVisibility(req.user).request_content,
    });
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS calls,
              SUM(CASE WHEN COALESCE(NULLIF(status,''), IF(type = 4,'error','success')) = 'success' THEN 1 ELSE 0 END) AS success_calls,
              SUM(CASE WHEN status = 'error' OR (status = '' AND type = 4) THEN 1 ELSE 0 END) AS error_calls,
              SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped_calls,
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
      success_calls: Number(row.success_calls) || 0,
      error_calls: Number(row.error_calls) || 0,
      stopped_calls: Number(row.stopped_calls) || 0,
      successes: Number(row.success_calls) || 0,
      errors: Number(row.error_calls) || 0,
      stopped: Number(row.stopped_calls) || 0,
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
  requireUserData("usage_summary"),
  asyncHandler(async (req, res) => {
    const isAdmin = Number(req.user.role) >= 100;
    const { where, args } = buildQuery({
      isAdmin,
      userId: req.user.id,
      kind: "usage",
      query: req.query,
      defaultDays: 30,
      showContent: userDataVisibility(req.user).request_content,
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
    // 按模型 × 按天：多折线图用。只取消费 Top 5 的模型（线太多会糊成一团）。
    // 先取榜，再按榜取序列 —— 一次 IN 查询，不做 N+1。
    const topModels = models.slice(0, 5).map((m) => m.model);
    let modelSeries = [];
    if (topModels.length) {
      const [seriesRows] = await pool.query(
        `SELECT model, FLOOR(created_at/86400)*86400 AS day_ts,
                COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units,
                COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens
           FROM logs ${where} AND model IN (${topModels.map(() => "?").join(",")})
          GROUP BY model, day_ts ORDER BY day_ts ASC`,
        [...args, ...topModels]
      );
      modelSeries = topModels.map((model) => ({
        model,
        points: seriesRows
          .filter((r) => r.model === model)
          .map((r) => ({
            day: new Date(Number(r.day_ts) * 1000).toISOString().slice(0, 10),
            calls: Number(r.calls) || 0,
            units: Number(r.units) || 0,
            tokens: Number(r.tokens) || 0,
          })),
      }));
    }

    // 按小时（0-23）× 星期（0-6）：热点图用。
    // 为什么要这个：看板要回答「我什么时候在用 / 全站高峰在几点」，
    // 单看每日趋势看不出作息与峰谷。
    const [hourly] = await pool.query(
      `SELECT HOUR(FROM_UNIXTIME(created_at)) AS hour,
              WEEKDAY(FROM_UNIXTIME(created_at)) AS weekday,
              COUNT(*) AS calls, COALESCE(SUM(quota),0) AS units
         FROM logs ${where} GROUP BY hour, weekday`,
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
      modelSeries,
      // 补齐成 7×24 的矩阵，缺的格子填 0（前端热力图要完整网格，缺格会错位）
      hourly: Array.from({ length: 7 }, (_, wd) =>
        Array.from({ length: 24 }, (_, h) => {
          const hit = hourly.find((x) => Number(x.hour) === h && Number(x.weekday) === wd);
          return { hour: h, weekday: wd, calls: Number(hit?.calls) || 0, units: Number(hit?.units) || 0 };
        })
      ),
    });
  })
);

// 管理：清空日志（同时清掉使用记录与操作日志）
router.delete(
  "/",
  // 超管专属：日志是事后审计的唯一依据，清掉就再也无法追溯（不可逆）。
  // 日常运营账号不应有这个能力 —— 一次误点等于抹掉全部历史。
  superRequired,
  asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM logs");
    // 传 req：清库是高危操作，自身必须留 IP/设备痕迹（否则日志被清后查不到是谁清的）
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: "清空所有日志" });
    return ok(res, null, "日志已清空");
  })
);

export default router;
