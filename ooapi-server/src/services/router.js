// 渠道调度：按模型选择上游渠道，并支持失败切换。
// 所有上游（含 DeepSeek 网页版反代）都作为 channels 表的一行，
// 由 type 区分适配器，优先级/权重决定调度顺序 —— 与 new-api 一致。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { isOAuthMethod } from "./channel-types.js";
import { groupConfigOf } from "./group-rate.js";

// 适配器表（懒加载，避免未用到的适配器被引入）
//
// 注意「接入方式」这一层：channel.type 存的是**厂商**（deepseek/glm/openai...），
// 具体走哪个适配器由 厂商 + 接入方式 共同决定（见 adapterKeyFor）：
//   relay（网页版反代）→ 该厂商自己的适配器，各家签名/风控都不同，必须专实现
//   api  （官方 API）  → 统一 openai-compat，因为大家都提供 OpenAI 兼容协议
//   codex / claude-oauth / antigravity（订阅 OAuth）→ 各自的 CLI 协议适配器
const ADAPTERS = {
  deepseek: () => import("./upstream/deepseek.js"),
  glm: () => import("./upstream/glm.js"),
  kimi: () => import("./upstream/kimi.js"),
  doubao: () => import("./upstream/doubao.js"),
  qwen: () => import("./upstream/qwen.js"),
  "openai-compat": () => import("./upstream/openai-compat.js"),
  // 订阅型 OAuth（参考 CLIProxyAPI/sub2api 的协议实现）
  codex: () => import("./upstream/codex.js"),
  "claude-oauth": () => import("./upstream/claude-oauth.js"),
  antigravity: () => import("./upstream/antigravity.js"),
  "grok-oauth": () => import("./upstream/grok.js"),
};

/**
 * 渠道 → 适配器 key
 * 老数据没有 other.method，一律按 relay 处理（历史渠道都是反代）
 */
export function adapterKeyFor(channel) {
  const method = channel?.other?.method;
  if (method === "api") return "openai-compat";
  if (isOAuthMethod(method)) return method;
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
  if (!state.has(id)) state.set(id, { lastAt: 0, window: [], cooldownUntil: 0, lastError: "", recent: null });
  return state.get(id);
}

// 最近调用记录（环形 20 条）：运行时为准，首次从数据库行回填，之后随每次成功/失败写回。
// 落库是为了重启后不丢历史；写库与 markChannelOk/Error 合并成同一条 UPDATE。
const RECENT_MAX = 20;

function parseRecent(raw) {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.slice(-RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(id, entry) {
  const s = st(Number(id));
  if (!s.recent) s.recent = [];
  s.recent.push(entry);
  if (s.recent.length > RECENT_MAX) s.recent = s.recent.slice(-RECENT_MAX);
  return JSON.stringify(s.recent);
}

// 记录里保存的提示词/回复摘要上限（长对话只留开头，避免把列撑大）
// 同时剥掉网页版多轮 prompt 的 ChatML 角色标记（<｜User｜> / <｜Assistant｜> / <｜end▁of▁sentence｜>），
// 它们只对上游有意义，展示给管理员会把「最近调用」弄脏。
const ROLE_TOKEN_RE = /<[｜|]\s*(?:User|Assistant|System)\s*[｜|]>|<[｜|]end[▁_\s]?of[▁_\s]?sentence[｜|]>/g;
const clip = (text, max) =>
  String(text ?? "")
    .replace(ROLE_TOKEN_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
// 降智/通行证标记（仅订阅渠道会带）：d=本轮降智，st=注入了 292 通行证；k=来源(chat/test/auto)
// u=发起本次调用的用户（管理端最近调用里显示头像+名字，点击复制邮箱）
const flagsOf = (meta = {}) => ({
  ...(meta.degraded !== undefined ? { d: meta.degraded ? 1 : 0 } : {}),
  ...(meta.state !== undefined ? { st: meta.state ? 1 : 0 } : {}),
  ...(meta.kind ? { k: meta.kind } : {}),
  ...(meta.user
    ? {
        u: {
          n: clip(meta.user.display_name || meta.user.username, 40),
          e: clip(meta.user.email, 80),
        },
      }
    : {}),
});

/** 只记录一次调用结果（不累加 used_count；测试/检查等非生产调用用）。
 * 同时更新 last_test_time：这是「检测」专用时间戳，生产调用不会碰它，
 * 否则繁忙渠道的定时检测会被每次生产调用不断推迟。 */
export async function recordChannelCall(channelId, ok, ms, error = "", meta = {}) {
  const recentJson = pushRecent(channelId, {
    t: now(),
    ok: ok ? 1 : 0,
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    p: clip(meta.prompt, 160),
    r: clip(meta.reply || error, 240),
    ...flagsOf(meta),
  });
  await pool
    .query("UPDATE channels SET recent_calls = ?, last_test_time = ? WHERE id = ?", [
      recentJson,
      now(),
      Number(channelId),
    ])
    .catch(() => {});
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
export async function markChannelError(channel, message, cooldownSec = 300, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = Date.now() + cooldownSec * 1000;
  s.lastError = String(message).slice(0, 400);
  // 最近调用记录与 last_error 一起写回（只记录错误信息，便于管理端展示"异常"原因）
  const recentJson = pushRecent(channel.id, {
    t: now(),
    ok: 0,
    ms: 0,
    p: clip(meta.prompt, 160),
    r: clip(meta.reply || message, 240),
    ...flagsOf(meta),
  });
  await pool
    .query("UPDATE channels SET last_error = ?, recent_calls = ? WHERE id = ?", [s.lastError, recentJson, channel.id])
    .catch(() => {});
}

export async function markChannelOk(channel, elapsedMs, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = 0;
  s.lastError = "";
  // 只更新运行指标，不改 status —— status 是管理员开关（手动启停），
  // 写 status=1 会复活管理员刚禁用的渠道。
  // used_count/last_used_time 供管理端展示渠道使用情况（此前从未累加）。
  const recentJson = pushRecent(channel.id, {
    t: now(),
    ok: 1,
    ms: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    p: clip(meta.prompt, 160),
    r: clip(meta.reply, 240),
    ...flagsOf(meta),
  });
  await pool
    .query(
      "UPDATE channels SET response_time = ?, tested_time = ?, last_error = '', used_count = used_count + 1, last_used_time = ?, recent_calls = ? WHERE id = ?",
      [elapsedMs, now(), now(), recentJson, channel.id]
    )
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

/**
 * 渠道被删除时清掉运行时痕迹（冷却状态、串行链），
 * 避免 state/chains 长期只增不减造成内存泄漏。
 */
export function forgetChannel(channelId) {
  state.delete(Number(channelId));
  chains.delete(Number(channelId));
}

export function channelRuntimeState(channelId) {
  const s = state.get(Number(channelId));
  return {
    cooldown_until: s?.cooldownUntil || 0,
    last_error: s?.lastError || "",
    recent: s?.recent || [],
  };
}

/** 读取最近调用：运行时没有就從数据库行回填并缓存（列表接口与调度共用同一份）。
 * 修复：列表页只读运行时导致服务重启后刷新显示「暂无调用」。 */
export function channelRecent(channelId, rawRecentCalls) {
  const s = st(Number(channelId));
  if (!s.recent || !s.recent.length) s.recent = parseRecent(rawRecentCalls);
  return s.recent;
}

// 渠道是否属于某请求分组（sub2api 语义：分组由管理员创建，未分组渠道 = 公共池）。
//   · groupName 为空 / "default"（历史值）→ 只有「未分组」的渠道可用（公共池）
//   · "type:name"（API Key 绑定的厂商分组）→ 先按厂商过滤，再按名字匹配
export function channelInGroup(channel, groupName) {
  const groups = Array.isArray(channel?.groups) ? channel.groups : [];
  if (!groupName) return groups.length === 0;
  let type = "";
  let name = String(groupName);
  const idx = name.indexOf(":");
  if (idx > 0) {
    type = name.slice(0, idx);
    name = name.slice(idx + 1);
  }
  if (name === "default") return groups.length === 0;
  if (type && String(channel?.type) !== type) return false;
  return groups.includes(name);
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
  // 所属分组（一个账号可属多个；空则退回 group_name，保证老数据行为不变）
  let groups = [];
  try {
    groups = r.group_list ? JSON.parse(r.group_list) : [];
  } catch {
    groups = [];
  }
  groups = (Array.isArray(groups) ? groups : [])
    .map((g) => String(g).trim())
    .filter(Boolean);
  // 未分组渠道 = 公共池（groups 为空数组）；group_name 仅作显示/兼容
  const rawMethod = String(other.method || "relay");
  const method = rawMethod === "api" || isOAuthMethod(rawMethod) ? rawMethod : "relay";
  // 最近调用记录：运行时已有则用运行时的（更新），否则从数据库行回填
  const recent = channelRecent(r.id, r.recent_calls);
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    method,
    base_url: r.base_url || "",
    api_key: r.api_key || "",
    models: r.models || "",
    group_name: r.group_name || "",
    groups,
    status: r.status,
    priority: Number(r.priority) || 0,
    weight: Number(r.weight) || 0,
    response_time: r.response_time || 0,
    test_model: r.test_model || "",
    test_prompt: r.test_prompt || "hi",
    auto_test: Number(r.auto_test) === 1,
    auto_test_interval: Number(r.auto_test_interval) || 3600,
    recent,
    other,
  };
}

// 选出可用渠道列表，并按「优先级降序 + 同优先级轮询」排序
// 轮询实现：同优先级内用模块级游标轮转，保证多账号均摊负载，
// 无可用渠道时，说明到底卡在哪一步。
// 只看「没有可用渠道」很容易被误判成模型不支持，实际多数是账号在冷却。
export async function explainNoChannel({ model, groupName = null } = {}) {
  // 分组模型限制：直接给出明确原因，而不是让用户误以为没有渠道支持该模型
  if (groupName) {
    const cfg = await groupConfigOf(groupName);
    if (cfg?.models?.length) {
      const m = String(model || "").toLowerCase();
      const allowed = cfg.models.some((p) => p === "*" || (p.endsWith("*") ? m.startsWith(p.slice(0, -1)) : p === m));
      if (!allowed) {
        return { reason: "GROUP_MODEL", message: `当前分组的 Key 不可调用模型「${model}」（分组限制了可用模型）` };
      }
    }
  }
  const [rows] = await pool.query("SELECT * FROM channels WHERE status = 1");
  const all = rows.map(rowToChannel);
  const inGroup = all.filter((c) => channelInGroup(c, groupName));
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
  // 分组模型限制：分组配置了「支持的模型」时，请求模型不在列表内直接无渠道
  if (groupName) {
    const cfg = await groupConfigOf(groupName);
    if (cfg?.models?.length) {
      const m = String(model || "").toLowerCase();
      const allowed = cfg.models.some((p) => {
        if (p === "*") return true;
        if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
        return p === m;
      });
      if (!allowed) return [];
    }
  }
  const [rows] = await pool.query(
    "SELECT * FROM channels WHERE status = 1 ORDER BY priority DESC, id ASC"
  );
  const excluded = excludeIds instanceof Set ? excludeIds : new Set();

  const usable = rows
    .map(rowToChannel)
    .filter((c) => !excluded.has(c.id))
    .filter((c) => !isCoolingDown(c))
    .filter((c) => channelSupportsModel(c, model))
    .filter((c) => channelInGroup(c, groupName));

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
    // 组内轮询：游标按优先级推进。
    // 注意不能把模型名拼进 key —— 模型名来自请求，任意字符串会让 Map 无限增长。
    const key = `p${p}`;
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
