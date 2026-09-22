// 对话（站内，JWT 鉴权，按用户额度计费）
// ---------------------------------------------------------------------------
// 本轮重构把「对话 / 智能体」两条链路合并成一条：**一次请求跑完整的 harness 循环**。
//   · 会话与会话设定（智能体、模型、思考/联网、工具开关、最大步数、会话指令）落库，
//     刷新页面不丢；历史消息以 parts 结构存储，前端直接渲染。
//   · 工具调用、思考链、待办清单都在同一条 SSE 流里推送（事件见 /run 注释）。
//   · 计费仍走 services/pricing.js：harness 把每次上游调用记为一条 {prompt,output,usage}，
//     这里逐条 splitTokens 后求和 —— 与网关/旧智能体同一套口径，禁止自行折算。
import express from "express";
import { pool } from "../db.js";
import { ok, fail, asyncHandler, now, safeInt, clientIp } from "../utils.js";
import { authRequired, preAuthJwt } from "../middleware/auth.js";
import { rateLimit } from "../middleware/ratelimit.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { getPrice, computeCost, splitTokens, estimateTokens, loadPrices, effectivePrice, UNITS_PER_OD, CURRENCY } from "../services/pricing.js";
import { groupConfigOf, applyGroupRate, parseGroupKey } from "../services/group-rate.js";
import { allPublicModels, resolveAliasSync } from "../services/models.js";
import { rowToChannel, channelInGroup, collectAvailableModels } from "../services/router.js";
import { getBoolOption } from "../config.js";
import { saveBuffer, getMedia, readBlob, mediaUrl, attachRef, releaseRefs } from "../services/media.js";
import { runHarness } from "../services/harness/loop.js";
import { AGENTS, findAgent, publicAgents, PRIMARY_AGENTS } from "../services/harness/agents.js";
import { toolSpecs } from "../services/harness/tools.js";
import { extractFileText, MAX_UPLOAD_FILES, MAX_UPLOAD_BYTES, TEXT_FILE_EXTS } from "../services/harness/files.js";
import { startRun, getRun, isRunning, publish, subscribe, finishRun, runStatus } from "../services/harness/runs.js";
import {
  createSession,
  listSessions,
  sessionCounts,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  batchSessions,
  getSession,
  getSessionMessages,
  appendMessage,
  updateSession,
  deleteSession,
  rewindSession,
  sessionWithMessages,
  sanitizeSettings,
  titleFromText,
  TOOL_IDS,
  MAX_STEPS_LIMIT,
  DEFAULT_MAX_STEPS,
} from "../services/harness/sessions.js";

const router = express.Router();
// 轻量预鉴权放在 express.json 之前：匿名/伪造请求没必要先被缓冲 20MB 大包。
// 只验 JWT 签名（不查库），完整 authRequired 仍在各路由上。
router.use(preAuthJwt);
router.use(express.json({ limit: "20mb" }));

/**
 * 用户的「密钥」列表（前端选 Key 用）。
 * 站内对话虽然扣账户额度（不走 Key 的额度），但**路由配置挂在 Key 上**：
 * Key 绑定的分组决定能调用哪些渠道、哪些模型、按什么倍率计费。
 * 所以这里把 Key 作为「路由身份」暴露给前端，与网关 /v1 的 groupName 口径一致。
 */
export async function listUserKeys(user) {
  const [rows] = await pool.query(
    "SELECT id, name, key_str, status, expired_time, group_name, model_limits, unlimited_quota, remain_quota, used_quota FROM tokens WHERE user_id = ? ORDER BY id ASC",
    [user.id]
  );
  const nowSec = Math.floor(Date.now() / 1000);
  // 分组展示信息（备注/倍率/成员厂商）：密钥菜单与列表按「折叠态厂商图标 + 分组名」展示
  const names = [...new Set(rows.map((t) => parseGroupKey(t.group_name)?.name).filter(Boolean))];
  const meta = new Map();
  if (names.length) {
    const ph = names.map(() => "?").join(",");
    const [gs] = await pool.query(`SELECT name, remark, rate FROM channel_groups WHERE name IN (${ph})`, names);
    for (const g of gs) meta.set(g.name, { remark: g.remark || "", rate: Number(g.rate) || 1, vendors: new Set() });
    const [chans] = await pool.query("SELECT type, group_list, group_name FROM channels");
    for (const c of chans) {
      let list = [];
      try {
        const arr = c.group_list ? JSON.parse(c.group_list) : [];
        if (Array.isArray(arr)) list = arr.map((s) => String(s)).filter(Boolean);
      } catch {
        list = c.group_name ? [String(c.group_name)] : [];
      }
      for (const n of list) if (meta.has(n) && c.type) meta.get(n).vendors.add(String(c.type));
    }
  }
  return rows.map((t) => {
    const expired = Number(t.expired_time) !== -1 && Number(t.expired_time) <= nowSec;
    const gkey = parseGroupKey(t.group_name);
    const gm = gkey ? meta.get(gkey.name) : null;
    return {
      id: Number(t.id),
      name: t.name || `密钥 ${t.id}`,
      // 只回传前后几位，避免完整密钥出现在页面/日志里
      masked: `${String(t.key_str || "").slice(0, 8)}…${String(t.key_str || "").slice(-4)}`,
      status: expired ? 3 : Number(t.status) || 1,
      group: t.group_name || "",
      group_name: gkey?.name || "",
      group_remark: gm?.remark || "",
      group_rate: gm?.rate || 1,
      group_vendors: gm ? [...gm.vendors] : [],
      model_limits: String(t.model_limits || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  });
}

/**
 * 取「当前可用的密钥」：站内对话必须通过密钥路由（分组→模型/渠道/倍率），
 * 没有可用密钥时不给模型、也不允许开跑。禁用/过期/不属于该用户的密钥一律视为不可用。
 */
async function activeKeyOf(user, keyId = 0) {
  // 必须用 safeInt：Number("Infinity") 是合法真值，会拼进 SQL 直接 500
  const id = safeInt(keyId, { min: 1 }) || 0;
  if (!id) return null;
  const [rows] = await pool.query("SELECT * FROM tokens WHERE id = ? AND user_id = ?", [id, user.id]);
  if (!rows.length) return null;
  const t = rows[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = Number(t.expired_time) !== -1 && Number(t.expired_time) <= nowSec;
  if (Number(t.status) !== 1 || expired) return null;
  return t;
}

/**
 * 用户可用的模型。
 *
 * 核心口径：**按「这个用户 + 这个密钥」实际能调用什么来算**。
 *   · 必须选中一个可用密钥；没有密钥 → 返回空（前端引导去创建密钥）
 *   · 密钥绑定的分组（type:name）决定：分组限制的模型 ∩ 分组成员渠道声明的模型
 *   · 额度是账户额度，但路由身份完全挂在密钥上（与网关 /v1 同一口径）
 */
async function availableModels(user, keyId = 0) {
  const isAdmin = Number(user?.role) >= 100;

  // 1) 解析本次请求用的密钥与路由分组；没有可用密钥 → 没有可选模型
  const key = await activeKeyOf(user, keyId);
  if (!key) return [];
  const groupName = key.group_name || null;

  // 2) 分组限制的模型（分组配了 models 就只给这些）
  const gcfg = groupName ? await groupConfigOf(groupName) : null;
  const groupModels = gcfg?.models?.length ? gcfg.models : null;
  const groupAllows = (id) => {
    if (!groupModels) return true;
    const m = String(id).toLowerCase();
    return groupModels.some((p) => p === "*" || (p.endsWith("*") ? m.startsWith(p.slice(0, -1)) : p === m));
  };

  // 3) 分组成员渠道能服务的模型（显式声明 ∪ models 留空渠道的厂商全部模型）
  const [channelRows] = await pool.query("SELECT * FROM channels WHERE status = 1");
  const supported = collectAvailableModels(
    channelRows.filter((r) => channelInGroup(rowToChannel(r), groupName))
  );

  // 4) 密钥自身的模型白名单（管理员豁免）
  const limits = key
    ? String(key.model_limits || "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const keyAllows = (id) => {
    if (isAdmin || !limits.length) return true;
    // 与网关 modelAllowed 同一套前缀语义
    return limits.some((l) => id === l || id.startsWith(l));
  };

  // 复用带 TTL 的价格缓存（此前这里每次 /meta 都全表查一次 model_prices）
  const priceMap = await loadPrices();

  return (await allPublicModels())
    .filter((m) => supported.size === 0 || supported.has("*") || supported.has(String(m.id).toLowerCase()))
    .filter((m) => groupAllows(m.id))
    .filter((m) => keyAllows(m.id))
    .map((m) => {
      const p = priceMap.get(String(m.id).toLowerCase());
      return {
        id: m.id,
        label: m.label,
        desc: m.desc,
        vision: m.vision,
        thinkingDefault: m.thinkingDefault,
        // 能力标记必须透传：前端据此隐藏无效开关（缺失时前端按“支持”处理）
        supportsSearch: m.supportsSearch,
        supportsThinking: m.supportsThinking,
        deprecated: Boolean(m.deprecated),
        vendor: m.vendor,
        vendorName: m.vendorName,
        aliasOf: m.aliasOf,
        price: p
          ? { input: Number(p.input_price), output: Number(p.output_price), cache: Number(p.cache_price) }
          : null,
      };
    });
}

/** 解析密钥的路由分组（/run 用；与 availableModels 同一套优先级；没有可用密钥返回 null） */
async function routeGroupOf(user, keyId = 0) {
  const key = await activeKeyOf(user, keyId);
  return key ? key.group_name || null : null;
}

/** 把模型按厂商归类（前端下拉要按厂商分组，不是一长条平铺） */
function groupModelsByVendor(models) {
  const order = [];
  const map = new Map();
  for (const m of models) {
    const key = m.vendor || "other";
    if (!map.has(key)) {
      map.set(key, { vendor: key, vendorName: m.vendorName || key, models: [] });
      order.push(key);
    }
    map.get(key).models.push(m);
  }
  return order.map((k) => map.get(k));
}

// 单个附件正文上限：留出余量给历史与工具结果，避免一个大文件把上下文挤爆
const FILE_TEXT_LIMIT = 30000;
function clipFileText(text) {
  const s = String(text || "");
  return s.length > FILE_TEXT_LIMIT ? `${s.slice(0, FILE_TEXT_LIMIT)}
…（文件较长，已截断）` : s;
}

// ---------- 元信息（密钥 / 模型 / 厂商 / 智能体 / 工具 / 默认值）----------
// keyId：按某个密钥的能力算模型（分组模型 ∩ 密钥白名单 ∩ 渠道声明）。
// 不传则用「账户默认」（用户分组），与老行为一致。
router.get(
  "/meta",
  authRequired,
  asyncHandler(async (req, res) => {
    const keyId = Number(req.query.keyId) || 0;
    const [models, keys] = await Promise.all([availableModels(req.user, keyId), listUserKeys(req.user)]);
    const activeKey = keys.find((k) => k.id === keyId) || null;
    return ok(res, {
      currency: CURRENCY,
      units_per_od: UNITS_PER_OD,
      quota: Number(req.user.quota),
      used_quota: Number(req.user.used_quota),
      models,
      // 厂商分组：前端模型下拉按厂商归类展示（并带厂商图标）
      vendors: groupModelsByVendor(models),
      // 密钥：站内对话按账户额度计费，但**路由配置挂在密钥上**（分组决定可用模型与倍率）
      keys,
      active_key: activeKey,
      agents: publicAgents(AGENTS),
      tools: toolSpecs(TOOL_IDS).map(({ id, name, desc }) => ({ id, name, desc })),
      defaults: { agent: PRIMARY_AGENTS[0]?.id || "general", maxSteps: DEFAULT_MAX_STEPS, maxStepsLimit: MAX_STEPS_LIMIT },
      chat_enabled: getBoolOption("chat_enabled"),
      // 附件能力（前端文件选择器据此显示可选类型）
      upload: { max_files: MAX_UPLOAD_FILES, max_bytes: MAX_UPLOAD_BYTES, text_types: TEXT_FILE_EXTS },
    });
  })
);

// ---------- 会话 CRUD ----------
router.get(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    const { q, limit, archived, projectId } = req.query;
    const [sessions, counts] = await Promise.all([
      listSessions(req.user.id, { q, limit, archived, projectId }),
      sessionCounts(req.user.id),
    ]);
    return ok(res, { sessions, counts });
  })
);

// ---------- 项目（ChatGPT 式分类；只做组织，不影响计费与路由）----------
router.get(
  "/projects",
  authRequired,
  asyncHandler(async (req, res) => {
    return ok(res, { projects: await listProjects(req.user.id) });
  })
);

router.post(
  "/projects",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name = "", remark = "" } = req.body || {};
    return ok(res, await createProject({ userId: req.user.id, name, remark }));
  })
);

router.put(
  "/projects/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { name, remark } = req.body || {};
    const project = await updateProject(req.user.id, req.params.id, { name, remark });
    if (!project) return fail(res, "项目不存在", 404);
    return ok(res, project);
  })
);

// 删除项目不删会话：项目下的对话会退回「未归类」，避免误删聊天记录
router.delete(
  "/projects/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const okDel = await deleteProject(req.user.id, req.params.id);
    if (!okDel) return fail(res, "项目不存在", 404);
    return ok(res, { id: req.params.id });
  })
);

// ---------- 批量操作（侧栏多选：归档/删除/移动项目/置顶）----------
router.post(
  "/sessions/batch",
  authRequired,
  asyncHandler(async (req, res) => {
    const { ids = [], action, projectId = "" } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return fail(res, "请先选择会话");
    try {
      const result = await batchSessions({ userId: req.user.id, ids, action, projectId });
      return ok(res, result);
    } catch (e) {
      if (e.code === "NO_PROJECT") return fail(res, "项目不存在", 404);
      if (e.code === "BAD_ACTION") return fail(res, "不支持的批量操作");
      throw e;
    }
  })
);

router.post(
  "/sessions",
  authRequired,
  asyncHandler(async (req, res) => {
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    const { agent = "general", model = "", settings = {}, projectId = "" } = req.body || {};
    if (!findAgent(agent)) return fail(res, "智能体不存在");
    const session = await createSession({ userId: req.user.id, agent, model, settings, projectId });
    return ok(res, session);
  })
);

router.get(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    return ok(res, { session, messages: await getSessionMessages(session.id) });
  })
);

router.put(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const patch = {};
    const body = req.body || {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.agent !== undefined) {
      if (!findAgent(body.agent)) return fail(res, "智能体不存在");
      patch.agent = body.agent;
    }
    if (body.model !== undefined) patch.model = body.model;
    if (body.todo !== undefined) patch.todo = body.todo;
    if (body.settings !== undefined) {
      const next = sanitizeSettings(body.settings, { previous: session.settings });
      if (next.tools && next.tools.some((t) => !TOOL_IDS.includes(t))) return fail(res, "包含未知工具");
      patch.settings = next;
    }
    return ok(res, await updateSession(req.user.id, session.id, patch));
  })
);

router.delete(
  "/sessions/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const removed = await deleteSession(req.user.id, req.params.id);
    if (!removed) return fail(res, "会话不存在", 404);
    return ok(res, { id: req.params.id });
  })
);

// 重新生成：先回退到指定消息之前，再让前端重发（见 sessions.rewindSession 的注释）
router.post(
  "/sessions/:id/rewind",
  authRequired,
  asyncHandler(async (req, res) => {
    const { fromSeq } = req.body || {};
    // 非法 fromSeq 绝不能兜底成 1：那会 DELETE seq>=1 清空整个会话（不可逆）
    const seq = safeInt(fromSeq, { min: 1 });
    if (!seq) return fail(res, "fromSeq 无效");
    const result = await rewindSession(req.user.id, req.params.id, seq);
    if (!result) return fail(res, "会话不存在", 404);
    return ok(res, await sessionWithMessages(req.user.id, req.params.id));
  })
);

// ---------- 计费（用户额度）----------
// 与网关同一套原子扣费；harness 传进来的 tokens 是「每次上游调用分别 splitTokens 后求和」，
// 混用 API 渠道（结构化 usage）与反代渠道（usage=null）时不会互相覆盖口径。
  async function chargeUser({ user, model, prompt, output, usage, channel, channelIds, tokens, kind, groupName = null, keyId = 0, keyName = "", startedAt = 0, firstTokenAt = 0, userAgent = "", ip = "", calls = null }) {
    const { promptTokens, completionTokens, cacheTokens } =
      tokens || splitTokens({ prompt, output, upstreamTotal: usage });
  // 兼容别名必须按真实模型计价（否则落到默认兜底档，偏差可达 3~10 倍）
  const basePrice = await getPrice(resolveAliasSync(model));
  // 分组倍率：用户绑定分组后按分组倍率计费（rate=1 时不变）
  // 倍率按本次实际路由的分组（选了密钥就是密钥的分组），与网关 /v1 口径一致
  const gcfg = await groupConfigOf(groupName);

  // 分时（峰谷）定价。
  // 站内对话一轮可能跑十几分钟（最多 16 步 + 子代理），跨过峰谷分界点时
  // 「按整轮发起时刻判一次档」会把边界之后的所有用量都按旧档计价：
  // 谷时开始跨入峰时系统性少收、峰时开始跨入谷时对用户多收，两边都是最多 2 倍。
  // 因此这里改为**按每次上游调用各自的时刻分别判档**，再求和 ——
  // loop.js 已经为每条调用记了 startedAt，正好可用（与网关的逐请求口径一致）。
  let price;
  let eff;
  let units;
  if (Array.isArray(calls) && calls.length) {
    let sum = 0;
    const phases = new Set();
    for (const c of calls) {
      const at = Number(c.startedAt) || startedAt || Date.now();
      const e = effectivePrice(basePrice, at);
      phases.add(e.phase);
      const t =
        c.tokens ||
        splitTokens({ prompt: c.prompt || "", output: c.output || "", upstreamTotal: c.usage || null });
      sum += computeCost({ price: e.price, promptTokens: t.promptTokens, completionTokens: t.completionTokens, cacheTokens: t.cacheTokens });
    }
    units = applyGroupRate(sum, gcfg?.rate);
    // 审计用：跨档时记 "peak+offpeak"，单档时记该档位
    eff = { phase: phases.size > 1 ? [...phases].join("+") : [...phases][0] || "peak", price: basePrice };
    price = basePrice;
  } else {
    eff = effectivePrice(basePrice, startedAt || Date.now());
    price = eff.price;
    // 站内对话一轮可能跨多个渠道（harness 多步），无法对单次调用套用账号级
    // context_billing，这里保持既有的「全额」口径（与网关默认一致）。
    units = applyGroupRate(computeCost({ price, promptTokens, completionTokens, cacheTokens }), gcfg?.rate);
  }

  // 注意：这里**不能**在余额为 0 时直接抛错。旧实现有这一行，后果是
  // 「整轮对话已经完整交付给用户，却一分钱不扣、连一条消费日志都不写」
  // （余额被并发请求清零或管理员扣款时命中，16 步 harness 白送）。
  // 正确做法是照常记账：余额不够就扣成负数（见下），让鉴权处的余额检查
  // 去挡住**下一个**请求，而不是让已经发生的这一轮凭空消失。
  let ret;
  try {
    [ret] = await pool.query(
      "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ? AND quota >= ?",
      [units, units, user.id, units]
    );
    if (!ret.affectedRows) {
      await pool.query(
        "UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?",
        [units, units, user.id]
      );
      console.warn(
        `[chat] 用户 ${user.id} 余额不足仍完成对话，已记账为欠费 ${units} 单位，后续请求将被拒绝直到充值`
      );
    }
  } catch (e) {
    // 扣费是否已提交无法确认：抛专用错误，调用方不得再次结算（宁可少扣不可重复扣）
    throw Object.assign(new Error(`扣费结果不确定：${e.message}`), { code: "BILLING_UNCERTAIN" });
  }
  await writeLog({
    user,
    type: LOG_TYPE.CONSUME,
    content: `${kind} · ${model} · 提示 ${promptTokens} / 补全 ${completionTokens} tokens${
      cacheTokens ? ` / 缓存 ${cacheTokens}` : ""
    } · ${(units / UNITS_PER_OD).toFixed(4)} ${CURRENCY}`,
    detail: JSON.stringify({
      channel: channel?.name,
      channel_id: channel?.id || (Array.isArray(channelIds) && channelIds.length === 1 ? channelIds[0] : undefined),
      channel_ids: Array.isArray(channelIds) && channelIds.length ? channelIds : undefined,
      model,
      kind,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cache_tokens: cacheTokens,
      // 分时审计：与网关同一口径（事后可复核按峰价还是谷价算的）
      price: { in: price.input, out: price.output, cache: price.cache },
      price_phase: eff.phase,
      priced_at: startedAt || Date.now(),
      rate: Number(gcfg?.rate) || 1,
      amount_units: units,
    }),
    quota: units,
    // 使用记录明细（列存储）：站内对话不经 Key，但仍记录本次路由用的密钥与分组，
    // 这样管理员在记录页能看出「这次是按哪个分组/倍率算的」。
    model,
    channelId: channel?.id || (Array.isArray(channelIds) && channelIds.length === 1 ? channelIds[0] : 0) || 0,
    channelName: channel?.name || "",
    tokenId: keyId || 0,
    tokenName: keyName || "",
    // 同网关：归一化成纯分组名，避免历史 "厂商:分组名" 绑定在日志里产生多个标签
    groupName: displayGroupName(groupName || user?.group_name),
    promptTokens,
    completionTokens,
    cacheTokens,
    firstTokenMs: firstTokenAt && startedAt ? firstTokenAt - startedAt : 0,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    userAgent,
    ip,
    pricePhase: eff.phase,
  });
  return { units, promptTokens, completionTokens, cacheTokens };
}

// 逐条调用 → 汇总 token（失败时也算出已消耗的部分）
function aggregate(calls = []) {
  const sum = { promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
  for (const c of calls) {
    const s = splitTokens({ prompt: c.prompt, output: c.output, upstreamTotal: c.usage });
    sum.promptTokens += s.promptTokens;
    sum.completionTokens += s.completionTokens;
    sum.cacheTokens += s.cacheTokens;
  }
  return sum;
}

// ---------- 运行一轮对话（SSE，可断线续传）----------
// 关键设计：**运行与 HTTP 连接解绑**。
// 用户在生成过程中切页/刷新时，浏览器会断开这条 SSE；如果这里跟着 abort 上游，
// 那一轮就白花钱了（上游已产出、我们照价付费）。因此：
//   · 后台任务负责跑完并把结果落库，客户端断开只取消订阅、不影响运行；
//   · 事件进 runs 环形缓冲，刷新后重新订阅（GET /sessions/:id/stream）先回放再续播；
//   · 只有用户显式点「停止」（POST /sessions/:id/stop）才真的中止上游。
  // 事件类型：start / resumed / part / part_update / delta / todo / done / error / stopped
  router.post(
    "/run",
    authRequired,
    // 单个用户维度限流：一轮对话最多可触发 16 步上游调用（每步都是真金白银），
    // 是本站成本最高的入口。给一个宽松但存在的上限，防脚本化刷量与误连点。
    rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "chat-run", keyFn: (r) => r.user?.id || r.ip }),
    asyncHandler(async (req, res) => {
    const { sessionId, text = "", model: modelOverride, agent: agentOverride, settings: settingsPatch, images = [], files = [], keyId = 0 } = req.body || {};

    const session = await getSession(req.user.id, sessionId);
    if (!session) return fail(res, "会话不存在", 404);
    if (!getBoolOption("chat_enabled")) return fail(res, "站内对话功能已关闭", 403);
    if (Number(req.user.quota) <= 0) return fail(res, `${CURRENCY} 币余额不足，请联系管理员充值`, 403);

    const content = String(text || "").trim();
    const agentId = agentOverride || session.agent;
    const agent = findAgent(agentId);
    if (!agent) return fail(res, "智能体不存在");
    const model = modelOverride || session.model;
    if (!model) return fail(res, "请选择模型");
    if (!content && !(Array.isArray(images) && images.length) && !(Array.isArray(files) && files.length)) {
      return fail(res, "请输入内容或添加附件");
    }

    // 同一会话同时只允许一个运行：重复提交若被放行会跑两份、扣两次费
    if (isRunning(session.id)) return fail(res, "这个会话正在生成中，请稍候或先停止", 409);

    const settings = sanitizeSettings(settingsPatch ?? {}, { previous: session.settings });

    // 图片：优先走媒体库（parts 只存 media_id，字节落盘）。
    //
    // 为什么必须这样：以前是把 dataURL 原样写进 chat_messages.parts（MEDIUMTEXT）——
    // 20MB 请求体下 3 张图就能产出 ~16.9MB 的 parts，超过 16,777,215 字节上限，
    // 严格模式 INSERT 失败（整轮对话落库失败、用户消息丢失），
    // 非严格模式被截断 → 历史消息**静默变空**。
    // 兼容旧前端：仍然接受 dataUrl（先存媒体库再走同一条路），
    // 这样新旧前端都能用，且新数据一定是 media_id。
    const imgs = [];
    const imgMediaIds = [];
    for (const img of Array.isArray(images) ? images : []) {
      // 新格式：前端已上传，直接给 media_id
      const mid = Number(img?.mediaId || img?.media_id) || 0;
      if (mid) {
        const row = await getMedia(mid);
        if (!row || Number(row.user_id) !== req.user.id || !String(row.kind).startsWith("image")) {
          return fail(res, "图片不存在或无权使用");
        }
        const buf = await readBlob(row);
        if (!buf) return fail(res, "图片内容缺失，请重新上传");
        imgs.push({ buffer: buf, mimeType: row.mime || "image/png", filename: row.orig_name || "image" });
        imgMediaIds.push(mid);
        continue;
      }
      // 旧格式：dataUrl（存进媒体库，后续统一按 media_id 处理）
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(String(img?.dataUrl || ""));
      if (!mm) continue;
      const buf = Buffer.from(mm[2], "base64");
      try {
        const saved = await saveBuffer({
          buffer: buf,
          userId: req.user.id,
          origName: mm[1].includes("png") ? "image.png" : "image.jpg",
          source: "chat",
        });
        imgs.push({ buffer: buf, mimeType: mm[1], filename: mm[1].includes("png") ? "image.png" : "image.jpg" });
        imgMediaIds.push(saved.id);
      } catch (e) {
        // 媒体库不可用（关闭/超配额）时不让对话直接失败：回退到旧行为（本轮可用，
        // 但不落库到媒体库）。宁可少存一次图，也不要让用户发不出消息。
        console.warn(`[chat] 图片存媒体库失败，回退为内存透传：${e.message}`);
        imgs.push({ buffer: buf, mimeType: mm[1], filename: mm[1].includes("png") ? "image.png" : "image.jpg" });
        imgMediaIds.push(0);
      }
    }
    if (imgs.length > 3) return fail(res, "最多 3 张图片");

    // 文档附件：前端传 base64，这里解析成文本（PDF/Word/Excel/文本/代码），
    // 解析结果作为 user 消息的 file part 落库 —— 历史里保留文件名与正文，
    // 下一轮模型仍能看到（不能只放进本轮 prompt，否则追问就"忘"了）。
    const docs = [];
    for (const f of Array.isArray(files) ? files.slice(0, MAX_UPLOAD_FILES) : []) {
      const mm = /^data:([^;]*);base64,(.+)$/s.exec(String(f?.dataUrl || ""));
      if (!mm) continue;
      const buf = Buffer.from(mm[2], "base64");
      if (buf.length > MAX_UPLOAD_BYTES) {
        return fail(res, `文件「${String(f.name || "未命名").slice(0, 60)}」超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
      }
      const r = extractFileText({ buffer: buf, filename: f.name || "", mimeType: mm[1] || f.type || "" });
      if (!r.ok) return fail(res, `文件「${String(f.name || "未命名").slice(0, 60)}」无法读取：${r.error}`);
      docs.push({ name: String(f.name || "未命名文件").slice(0, 120), kind: r.kind, bytes: buf.length, text: clipFileText(r.text) });
    }
    if (docs.length > MAX_UPLOAD_FILES) return fail(res, `最多同时上传 ${MAX_UPLOAD_FILES} 个文件`);

    // 「重新生成」重发历史消息时附件没有 dataUrl：前端把已解析文本走 docs 通道带回来。
    // 这里做和 files 相同的上限与剪裁，逻辑保持单一入口。
    for (const d of Array.isArray(req.body?.docs) ? req.body.docs.slice(0, MAX_UPLOAD_FILES) : []) {
      if (!d || typeof d !== "object") continue;
      const text = String(d.text || "");
      if (!text) continue;
      docs.push({
        name: String(d.name || "未命名文件").slice(0, 120),
        kind: String(d.kind || "text").slice(0, 20),
        bytes: Math.min(Number(d.bytes) || text.length, 50 * 1024 * 1024),
        text: clipFileText(text),
      });
    }

    // 先原子占位、再做落库等副作用：并发提交的第二个请求会在这里直接 409，
    // 不会留下重复的用户消息或被改错的标题（原实现先落库后占位，存在这个竞态）。
    const run = startRun(session.id, { userId: req.user.id });
    if (!run) return fail(res, "这个会话正在生成中，请稍候或先停止", 409);

    let history;
    let models;
    let modelCaps;
    let routeGroup;
    // 作用域必须覆盖后台 executeRun 调用，否则成功通过密钥校验后会在收尾处引用不到。
    let usableKey = null;
    try {
      history = await getSessionMessages(session.id);

      // 用户消息先落库再跑：即使执行失败，对话历史也是完整的。
      // 图片 part 只存 media_id（字节在媒体库），渲染时由服务端补签名 URL ——
      // 这样 parts 不再承载 base64，彻底避开 MEDIUMTEXT 溢出。
      const userParts = [{ id: `u${Date.now().toString(36)}`, type: "text", text: content }];
      for (let i = 0; i < imgMediaIds.length; i += 1) {
        const mid = imgMediaIds[i];
        if (!mid) continue; // 存库失败的（回退路径）不写进历史，避免留下坏引用
        userParts.push({ id: `i${Math.random().toString(36).slice(2, 8)}`, type: "image", media_id: mid });
      }
      for (const d of docs) {
        userParts.push({ id: `f${Math.random().toString(36).slice(2, 8)}`, type: "file", name: d.name, kind: d.kind, bytes: d.bytes, text: d.text });
      }
      // appendMessage 返回消息 id：图片引用要绑到这个 id 上（删除消息时据此释放）
      const userMsgId = await appendMessage({ sessionId: session.id, userId: req.user.id, role: "user", parts: userParts });
      for (const mid of imgMediaIds) {
        if (!mid) continue;
        await attachRef(mid, {
          userId: req.user.id,
          refType: "chat_message",
          refId: String(userMsgId),
          slot: `m${mid}`,
        }).catch((e) => console.warn(`[chat] 绑定图片引用失败：${e.message}`));
      }

      // 首条消息直接当标题（比再调一次模型便宜；用户之后可手动改名）
      if (session.message_count === 0 && session.title === "新对话") {
        await updateSession(req.user.id, session.id, { title: titleFromText(content || docs[0]?.name || "图片对话") });
      }

      models = await availableModels(req.user, keyId);
      modelCaps = models.find((m) => m.id === model) || null;
      // 路由分组：必须通过密钥路由（分组决定渠道/模型/倍率），没有可用密钥不开跑
      usableKey = await activeKeyOf(req.user, keyId);
      if (!usableKey) {
        finishRun(run);
        return fail(res, "请先在「令牌管理」创建可用密钥，并在对话页选择它（密钥的分组决定可用模型与倍率）", 403);
      }
      routeGroup = usableKey.group_name || null;
      if (!models.some((m) => m.id === model)) {
        finishRun(run);
        return fail(res, `模型「${model}」在当前密钥下不可用，请重新选择模型`);
      }
    } catch (e) {
      // 占位后到真正开跑前的任何异常都要释放，否则会话会永远显示"生成中"
      finishRun(run);
      throw e;
    }
    const ctrl = new AbortController();
    run.abort = () => ctrl.abort();
    publish(run, { type: "start", sessionId: session.id, startedAt: run.startedAt });

    // 后台跑：不 await，HTTP 层只负责把事件流出去
    executeRun({
      run,
      ctrl,
      user: req.user,
      session,
      agent,
      model,
      settings,
      history,
      content,
      imgs,
      docs,
      routeGroup,
      keyId,
      // 密钥名也要落日志：只有 id 的话「使用记录」的密钥列会显示成「账户额度」（见 chargeUser）
      keyName: usableKey?.name || "",
      modelCaps,
      // 使用记录要展示的调用方信息（IP/设备只在本次 HTTP 请求里有，必须在这里取）
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 255),
      startedAt: run.startedAt || Date.now(),
    }).catch((e) => console.error("[chat] 后台运行异常：", e?.message || e));

    streamFromRun(req, res, run);
  })
);

/** 把某个运行的 SSE 流接到本次 HTTP 响应：先回放缓冲，再续播实时事件 */
function streamFromRun(req, res, run, extra = null) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  const write = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  if (extra) write({ type: "resumed", ...extra });

  const unsubscribe = subscribe(run, (ev) => {
    if (ev === null) {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }
    write(ev);
  });

  // 客户端断开（切页/刷新）只取消订阅，**不**中止运行 —— 见 /run 顶部注释
  const onClose = () => unsubscribe();
  res.on("close", onClose);
  req.on("aborted", onClose);
}

// 重新订阅进行中的运行（刷新 / 切页回来时调用，先回放已缓冲事件）
router.get(
  "/sessions/:id/stream",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const run = getRun(session.id);
    if (!run || run.settled) return fail(res, "没有进行中的生成", 404);
    streamFromRun(req, res, run, { startedAt: run.startedAt, events: run.events.length });
  })
);

// 显式中止：只有用户点「停止」才真的 abort 上游
router.post(
  "/sessions/:id/stop",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    const run = getRun(session.id);
    if (!run || run.settled) return fail(res, "没有进行中的生成", 404);
    run.abort?.();
    return ok(res, { stopped: true, startedAt: run.startedAt });
  })
);

/** 这个会话现在有没有在跑（前端刷新后据此决定要不要接回事件流） */
router.get(
  "/sessions/:id/running",
  authRequired,
  asyncHandler(async (req, res) => {
    const session = await getSession(req.user.id, req.params.id);
    if (!session) return fail(res, "会话不存在", 404);
    return ok(res, runStatus(session.id));
  })
);

/**
 * 真正执行一轮：跑 harness、计费、落库、发布事件。
 * 无论客户端是否还在，都必须跑到最后一步（这就是断线续传的前提）。
 */
async function executeRun({ run, ctrl, user, session, agent, model, settings, history, content, imgs, docs = [], routeGroup, keyId = 0, keyName = "", modelCaps, ip = "", userAgent = "", startedAt = 0 }) {
  const runCalls = [];
  let runParts = [];
  let runTodo = session.todo || [];
  let channelName = "";
  let settled = false;
  // 助手消息是否已落库：catch 分支据此避免重复写入（见下方 appendMessage 处说明）
  let saved = false;

  try {
    const out = await runHarness({
      session,
      agent,
      model,
      settings,
      history,
      userText: content,
      images: imgs,
      docs,
      groupName: routeGroup,
      user,
      signal: ctrl.signal,
      modelCaps,
      emit: (ev) => {
        if (ev.type === "todo") runTodo = ev.todo;
        publish(run, ev);
      },
      onTodo: (todo) => {
        runTodo = todo;
      },
      onCall: (c) => runCalls.push(c),
    });

    runParts = out.parts;
    runTodo = out.todo;
    channelName = runCalls.find((c) => c.channel)?.channel || "";
    const runChannelIds = [...new Set(runCalls.map((c) => Number(c.channelId) || 0).filter(Boolean))];

    const tokens = aggregate(runCalls);
    // 首 token / 总耗时：按「本轮的第一次上游调用」算首 token，整轮总耗时从请求进入算起
    const firstCall = runCalls.find((c) => c.firstTokenAt) || null;
    const billed = await chargeUser({
      user,
      model,
      prompt: "",
      output: "",
      usage: null,
      tokens,
      // 逐次调用分别判峰谷档（整轮跨分界点时不再全部按发起时刻计价）
      calls: runCalls,
      channel: channelName ? { name: channelName } : null,
      channelIds: runChannelIds,
      groupName: routeGroup,
      keyId,
      keyName,
      kind: "对话",
      ip,
      userAgent,
      startedAt,
      firstTokenAt: firstCall?.firstTokenAt || 0,
    });
    settled = true;

    const message = {
      seq: 0,
      role: "assistant",
      parts: runParts,
      agent: agent.id,
      model,
      cost: Number((billed.units / UNITS_PER_OD).toFixed(6)),
      tokens: { prompt: billed.promptTokens, completion: billed.completionTokens },
      created_time: now(),
    };
    // 落库成功标记（saved 声明在 try 之外）：catch 分支据此判断
    // 「助手消息是否已经写过」。否则 appendMessage 之后的任一步骤
    // （updateSession / getSession / publish）抛错都会走到 catch 的兜底落库，
    // 同一轮回答在 chat_messages 里出现两条 —— 用户看到重复回答，
    // 下一轮模型上下文里同一答案还会再出现一次。
    message.seq = await appendMessage({
      sessionId: session.id,
      userId: user.id,
      role: "assistant",
      parts: runParts,
      agent: agent.id,
      model,
      cost: message.cost,
      promptTokens: billed.promptTokens,
      completionTokens: billed.completionTokens,
    });
    saved = true;
    await updateSession(user.id, session.id, { todo: runTodo });

    publish(run, { type: "done", message, todo: runTodo, session: await getSession(user.id, session.id) });
  } catch (err) {
    console.error("[chat] 运行失败：", err.code || "", err.message);
    if (Array.isArray(err.parts) && err.parts.length) runParts = err.parts;
    const stopped = ctrl.signal.aborted || err.code === "ABORTED";
    // 扣费结果不确定时不再补结算（防重复扣费）；余额不足等“确定未扣”的错误才走部分结算
    if (err?.code === "BILLING_UNCERTAIN") settled = true;

    // 已消耗的部分照常计费（用户确实为这些 token 付了上游成本）：
    // 失败/中止时最后一次调用没有 usage，按 prompt/输出字符数估算补上。
    const tokens = aggregate(runCalls);
    const partial = runParts.filter((p) => p.type === "text").map((p) => p.text).join("");
    // 失败的那一步不进 runCalls（loop.js 只在 runCompletion 成功后才 record），
    // 若只按 runCalls 汇总，那一步的 prompt 完全不计费 —— 而失败步往往带着
    // 整轮最长的上下文（历史 + 工具结果），是漏收最多的一处。
    // 这里补一条合成调用，让它按自己的时刻判档、按估算用量计费。
    //
    // 条件是 `upstreamStarted`：只有真正发起过上游调用才计费。
    // NO_CHANNEL / UNSUPPORTED_CHANNEL / VISION_NOT_SUPPORTED 这类错误发生在
    // 调上游**之前**，上游零消耗，对它们计费就是无中生有。
    const upstreamStarted = err?.upstreamStarted === true;
    const failedCall = upstreamStarted
      ? {
          prompt: err?.billingPrompt || "",
          output: partial,
          usage: null,
          startedAt: err?.billingStartedAt || startedAt,
          tokens: null,
        }
      : null;
    // 门槛也要带上 failedCall.prompt：首步就失败且没有任何输出时
    // （模型不支持、渠道未就绪、首步超时），三个旧条件全是 0/0/""，
    // 整轮会被完全跳过 —— 而这类失败的上游其实已经吃掉了整段上下文。
    if (!settled && (tokens.promptTokens || tokens.completionTokens || partial || failedCall?.prompt)) {
      if (partial && !tokens.completionTokens) {
        // 只有整轮都没有 usage（中途失败）才按字符估算；
        // 已有精确 completion 计费时再按差额补会重复计费（估算值通常高于真实 token）。
        tokens.completionTokens += estimateTokens(partial);
        // prompt 用「失败步的完整上下文」估算，而不是只算本轮用户输入 ——
        // 后者漏掉 system 提示与全部历史，而 harness 的 system 提示常常上万字符。
        tokens.promptTokens += estimateTokens(failedCall?.prompt || content);
      }
      try {
        await chargeUser({
          user,
          model,
          prompt: "",
          output: "",
          usage: null,
          tokens,
          // 逐次调用计费。只有失败步时也要走 calls 分支，否则 chargeUser 会用
          // 上面那个被忽略的 tokens（有 usage 的情况下它并不完整）。
          calls: failedCall ? [...runCalls, failedCall] : null,
          channel: channelName ? { name: channelName } : null,
          channelIds: [...new Set(runCalls.map((c) => Number(c.channelId) || 0).filter(Boolean))],
          groupName: routeGroup,
          kind: stopped ? "对话（已停止）" : "对话（部分）",
          keyId,
          keyName,
          ip,
          userAgent,
          startedAt,
          firstTokenAt: (runCalls.find((c) => c.firstTokenAt) || {}).firstTokenAt || 0,
        });
      } catch (e2) {
        console.error("[chat] 部分计费失败：", e2.message);
      }
    }

    // 只有「尚未落库」时才补写：成功路径可能已经写过（saved=true），
    // 若此处再写一次，同一轮回答会在库里出现两条。
    if (!saved && runParts.length) {
      try {
        await appendMessage({ sessionId: session.id, userId: user.id, role: "assistant", parts: runParts, agent: agent.id, model });
        saved = true;
        await updateSession(user.id, session.id, { todo: runTodo });
      } catch (e2) {
        console.error("[chat] 失败消息落库异常：", e2.message);
      }
    }

    run.error = { code: err.code || "ERROR", message: err.message };
    // 失败也写一条错误日志：与网关同一口径（模型/渠道/耗时/设备），
    // 否则站内对话的失败在看板上完全不可见。
    // 这里没有 req（executeRun 是后台任务），ip/userAgent 由调用方在 /run 时捕获后传入。
    await writeLog({
      user,
      type: LOG_TYPE.ERROR,
      content: `${stopped ? "对话已停止" : "对话失败"}：${model} · ${err.message}`,
      detail: JSON.stringify({ code: err.code || "ERROR" }),
      model,
      channelId: Number(err.channelId) || 0,
      channelName: err.channelName || "",
      tokenId: keyId || 0,
      groupName: routeGroup || "",
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      userAgent,
      ip,
    }).catch(() => {});    publish(run, {
      type: stopped ? "stopped" : "error",
      code: err.code || "ERROR",
      message: stopped ? "已停止生成。本轮已产生的用量照常计费。" : err.message,
      parts: runParts,
      session: await getSession(user.id, session.id).catch(() => null),
    });
  } finally {
    finishRun(run);
  }
}

export default router;
