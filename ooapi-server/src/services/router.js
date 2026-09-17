// 渠道调度：按模型选择上游渠道，并支持失败切换。
// 所有上游（含 DeepSeek 网页版反代）都作为 channels 表的一行，
// 由 type 区分适配器，优先级/权重决定调度顺序 —— 与 new-api 一致。
import { pool } from "../db.js";
import { now } from "../utils.js";

// 适配器表（懒加载，避免未用到的适配器被引入）
//
// 注意「接入方式」这一层：channel.type 存的是**厂商**（deepseek/glm/openai...），
// 具体走哪个适配器由 厂商 + 接入方式 共同决定（见 adapterKeyFor）：
//   relay（网页版反代）→ 该厂商自己的适配器，各家签名/风控都不同，必须专实现
//   api  （官方 API）  → 统一 openai-compat，因为大家都提供 OpenAI 兼容协议
const ADAPTERS = {
  deepseek: () => import("./upstream/deepseek.js"),
  glm: () => import("./upstream/glm.js"),
  kimi: () => import("./upstream/kimi.js"),
  doubao: () => import("./upstream/doubao.js"),
  qwen: () => import("./upstream/qwen.js"),
  "openai-compat": () => import("./upstream/openai-compat.js"),
};

/**
 * 渠道 → 适配器 key
 * 老数据没有 other.method，一律按 relay 处理（历史渠道都是反代）
 */
export function adapterKeyFor(channel) {
  const method = channel?.other?.method;
  if (method === "api") return "openai-compat";
  return channel?.type || "";
}

export function isSupportedType(type) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, type);
}

export function supportedTypes() {
  return Object.keys(ADAPTERS);
}

// 运行时状态（不落盘）：channelId -> { lastAt, window[], cooldownUntil, lastError }
const state = new Map();
const chains = new Map();
// 同优先级轮询游标（模块级，进程存活期间有效）
const SELECT_CURSOR = new Map();

// 单渠道限速（保护上游账号，降低风控概率）
const RATE = { minGapMs: 1200, jitterMs: 900, maxPerMin: 20 };

function st(id) {
  if (!state.has(id)) state.set(id, { lastAt: 0, window: [], cooldownUntil: 0, lastError: "" });
  return state.get(id);
}

export function isCoolingDown(channel) {
  const s = state.get(channel.id);
  if (!s || !s.cooldownUntil) return false;
  if (Date.now() >= s.cooldownUntil) {
    s.cooldownUntil = 0;
    return false;
  }
  return true;
}

// 标记渠道运行异常：只做运行时冷却，不改数据库 status。
// 原因：status 是管理员开关（手动启停/测试结果），运行期错误若直接写 status=3，
// 会导致 token 更新后渠道仍被永久排除在调度外。冷却结束后自动恢复调度。
export async function markChannelError(channel, message, cooldownSec = 300) {
  const s = st(channel.id);
  s.cooldownUntil = Date.now() + cooldownSec * 1000;
  s.lastError = String(message).slice(0, 400);
  // 仅记录错误信息，便于管理端展示"异常"原因
  await pool
    .query("UPDATE channels SET last_error = ? WHERE id = ?", [s.lastError, channel.id])
    .catch(() => {});
}

export async function markChannelOk(channel, elapsedMs) {
  const s = st(channel.id);
  s.cooldownUntil = 0;
  s.lastError = "";
  // 只更新运行指标，不改 status —— status 是管理员开关（手动启停），
  // 写 status=1 会复活管理员刚禁用的渠道。
  await pool
    .query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [
      elapsedMs,
      now(),
      channel.id,
    ])
    .catch(() => {});
}

function delayFor(channel) {
  const s = st(channel.id);
  const t = Date.now();
  s.window = s.window.filter((x) => t - x < 60_000);
  if (s.window.length >= RATE.maxPerMin) return 60_000 - (t - s.window[0]) + 400;
  const since = t - s.lastAt;
  if (since < RATE.minGapMs) return RATE.minGapMs - since + Math.random() * RATE.jitterMs;
  return 0;
}

function commitRate(channel) {
  const s = st(channel.id);
  s.lastAt = Date.now();
  s.window.push(Date.now());
}

// 同一渠道串行执行（含限速），避免并发打爆上游账号
export function withChannelLimit(channel, taskFn) {
  const run = async () => {
    const waitMs = delayFor(channel);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    commitRate(channel);
    return taskFn();
  };
  const key = channel.id;
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  chains.set(key, next);
  // 注意：next.finally() 会派生一个新 Promise，任务失败时无人消费会产生
  // unhandledRejection 噪音，所以先 catch 再挂 finally。
  next.catch(() => {}).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

export function resetChannelState(channelId) {
  const s = state.get(Number(channelId));
  if (s) {
    s.cooldownUntil = 0;
    s.lastError = "";
  }
}

export function channelRuntimeState(channelId) {
  const s = state.get(Number(channelId));
  return {
    cooldown_until: s?.cooldownUntil || 0,
    last_error: s?.lastError || "",
  };
}

function parseModels(modelsStr) {
  return String(modelsStr || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 渠道是否支持该模型（支持通配：deepseek-* 或 *）
export function channelSupportsModel(channel, model) {
  const list = parseModels(channel.models);
  if (!list.length) return false;
  const m = String(model || "").toLowerCase();
  return list.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === "*") return true;
    if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
    return p === m;
  });
}

export function rowToChannel(r) {
  let other = {};
  try {
    other = r.other ? JSON.parse(r.other) : {};
  } catch {
    other = {};
  }
  const method = other.method === "api" ? "api" : "relay";
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    method,
    base_url: r.base_url || "",
    api_key: r.api_key || "",
    models: r.models || "",
    group_name: r.group_name || "default",
    status: r.status,
    priority: Number(r.priority) || 0,
    weight: Number(r.weight) || 0,
    response_time: r.response_time || 0,
    other,
  };
}

// 选出可用渠道列表，并按「优先级降序 + 同优先级轮询」排序
// 轮询实现：同优先级内用模块级游标轮转，保证多账号均摊负载，
// 无可用渠道时，说明到底卡在哪一步。
// 只看「没有可用渠道」很容易被误判成模型不支持，实际多数是账号在冷却。
export async function explainNoChannel({ model, groupName = null } = {}) {
  const [rows] = await pool.query("SELECT * FROM channels WHERE status = 1");
  const all = rows.map(rowToChannel);
  const inGroup = all.filter((c) => (groupName ? c.group_name === groupName || c.group_name === "default" : true));
  const forModel = inGroup.filter((c) => channelSupportsModel(c, model));
  const cooling = forModel.filter((c) => isCoolingDown(c));
  const [[disabled]] = await pool.query("SELECT COUNT(*) AS c FROM channels WHERE status != 1");

  if (!all.length) return { reason: "EMPTY", message: "平台还没有配置任何渠道，请在渠道管理中添加" };
  if (cooling.length && cooling.length === forModel.length) {
    const names = cooling.map((c) => c.name).join("、");
    return {
      reason: "COOLING",
      message: `支持模型「${model}」的渠道都在冷却中（${names}），请稍后重试或添加新账号`,
    };
  }
  if (!forModel.length) {
    const types = [...new Set(all.map((c) => c.type))].join("、");
    return {
      reason: "NO_MODEL",
      message: `没有渠道支持模型「${model}」。当前已有渠道类型：${types}；请在渠道管理里为某个渠道添加该模型`,
    };
  }
  return {
    reason: "GROUP",
    message: `没有可用渠道支持模型「${model}」（已排除分组不匹配${disabled?.c ? `，另有 ${disabled.c} 个渠道被禁用` : ""}）`,
  };
}

//          而不是永远打在第一个账号上（那会让单账号迅速触发风控）。
export async function selectChannels({ model, excludeIds = null, groupName = null } = {}) {
  const [rows] = await pool.query(
    "SELECT * FROM channels WHERE status = 1 ORDER BY priority DESC, id ASC"
  );
  const excluded = excludeIds instanceof Set ? excludeIds : new Set();

  const usable = rows
    .map(rowToChannel)
    .filter((c) => !excluded.has(c.id))
    .filter((c) => !isCoolingDown(c))
    .filter((c) => channelSupportsModel(c, model))
    .filter((c) => (groupName ? c.group_name === groupName || c.group_name === "default" : true));

  if (usable.length <= 1) return usable;

  // 按优先级分组，组内轮询
  const byPriority = new Map();
  for (const c of usable) {
    const p = c.priority || 0;
    if (!byPriority.has(p)) byPriority.set(p, []);
    byPriority.get(p).push(c);
  }

  const priorities = [...byPriority.keys()].sort((a, b) => b - a);
  const ordered = [];

  for (const p of priorities) {
    const group = byPriority.get(p);
    if (group.length === 1) {
      ordered.push(group[0]);
      continue;
    }
    // 组内轮询：游标按「优先级 + 模型」维度推进，避免不同模型互相干扰
    const key = `p${p}:${model}`;
    const cursor = (SELECT_CURSOR.get(key) || 0) % group.length;
    SELECT_CURSOR.set(key, cursor + 1);
    // 从游标处开始环形展开
    for (let i = 0; i < group.length; i++) {
      ordered.push(group[(cursor + i) % group.length]);
    }
  }

  return ordered;
}

// 取适配器
/**
 * 取适配器。
 * 参数可以是：
 *   · 渠道对象  —— 推荐，会自动按 厂商+接入方式 解析（API 渠道走 openai-compat）
 *   · 字符串    —— 直接指定适配器 key（内部兜底/测试用）
 */
export async function getAdapter(typeOrChannel) {
  const key =
    typeof typeOrChannel === "string" ? typeOrChannel : adapterKeyFor(typeOrChannel);
  const loader = ADAPTERS[key];
  if (!loader) {
    const provider = typeof typeOrChannel === "object" ? typeOrChannel?.type : "";
    throw Object.assign(new Error(`不支持的渠道类型：${provider || key}`), { code: "UNSUPPORTED_CHANNEL" });
  }
  return loader();
}
