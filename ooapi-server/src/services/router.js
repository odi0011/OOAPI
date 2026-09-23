// 渠道调度：按模型选择上游渠道，并支持失败切换。
// 所有上游（含 DeepSeek 网页版反代）都作为 channels 表的一行，
// 由 type 区分适配器，优先级/权重决定调度顺序 —— 与 new-api 一致。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { isOAuthMethod, getMethod, isApiKeyMethod } from "./channel-types.js";
import { groupConfigOf } from "./group-rate.js";
import { modelRegistrySync } from "./models.js";

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
  "anthropic-compat": () => import("./upstream/anthropic-compat.js"),
  // 订阅型 OAuth（参考 CLIProxyAPI/sub2api 的协议实现）
  codex: () => import("./upstream/codex.js"),
  "claude-oauth": () => import("./upstream/claude-oauth.js"),
  antigravity: () => import("./upstream/antigravity.js"),
  "grok-oauth": () => import("./upstream/grok.js"),
  kiro: () => import("./upstream/kiro.js"),
  "openai-web": () => import("./upstream/openai-web.js"),
  // ChatGPT 网页版·浏览器 UI 驱动。与 openai-web 的区别：后者在 Node 里直接
  // 拼 HTTP 请求（现已走不通 —— sentinel 的 turnstile 必须由页面 JS 解），
  // 这个驱动真实页面 UI，让页面自己去过风控。
  "openai-web-ui": () => import("./upstream/openai-web-ui.js"),
  // 三家网页版反代。**这三行曾经漏掉**：channel-types 里声明了 adapter
  // （mimo-web / minimax-web / stepfun-web），但 ADAPTERS 表里没有对应注册，
  // 于是 adapterKeyFor 解析出的 key 在表里查不到 → getAdapter 抛
  // UNSUPPORTED_CHANNEL → 渠道一建就报「适配器不可用」。
  // 这类漏注册的静态检查：channel-types 里每个 adapter 值都应在本表出现（见单测）。
  "mimo-web": () => import("./upstream/mimo-web.js"),
  "minimax-web": () => import("./upstream/minimax-web.js"),
  "stepfun-web": () => import("./upstream/stepfun-web.js"),
  // TypeSafe AI（Jev）：**不兼容 OpenAI** 的判定模型，单端点 /v1/systemone，
  // 请求/响应都是自定义结构，必须走独立适配器（见该文件顶部说明）。
  typesafe: () => import("./upstream/typesafe.js"),
  // 第三方反代（凭据型）：WorkBuddy 直连腾讯后端；Qoder 经本地桥
  workbuddy: () => import("./upstream/workbuddy.js"),
  qoder: () => import("./upstream/qoder.js"),
  // OpenCode（Zen / GO）：协议是标准 OpenAI，但 GO 订阅强制要求
  // x-opencode-session 与自述 UA，缺了直接 400 missing_session_id
  //（线上渠道 #45 的故障）。薄适配器只补这两个头，对话仍复用 openai-compat。
  opencode: () => import("./upstream/opencode.js"),
  // Cline 官方就是标准 OpenAI 兼容 API，薄适配器只补客户端标识头与响应包封解包
  //（调研结论见 upstream/cline.js 顶部：官方有正式 API，不需要也不应做反代）。
  cline: () => import("./upstream/cline.js"),
};

/**
 * 渠道 → 适配器 key
 * 老数据没有 other.method，一律按 relay 处理（历史渠道都是反代）
 */
export function adapterKeyFor(channel) {
  const method = String(channel?.other?.method || "");
  // 接入方式显式声明 adapter 时优先（例如 anthropic 的 api 走 anthropic-compat，
  // 而其它厂商的 api 仍走 openai-compat）
  const mCfg = method ? getMethod(channel?.type, method) : null;
  if (mCfg?.adapter) return mCfg.adapter;
  if (isApiKeyMethod(channel?.type, method)) return "openai-compat";
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
// 默认值偏保守；每个账号可以在渠道 `other` 里覆盖：
//   other.min_gap_ms  两次请求最小间隔（默认 1200ms）
//   other.max_per_min 每分钟上限（默认 20）
//   other.concurrency 该账号允许的**并发**请求数（默认 1，串行；>1 时放开串行链）
const RATE = { minGapMs: 1200, jitterMs: 900, maxPerMin: 20 };

/** 该渠道生效的限速参数（账号级覆盖 > 全局默认） */
function rateOf(channel) {
  const o = channel?.other || {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    minGapMs: num(o.min_gap_ms, RATE.minGapMs, 0, 600_000),
    maxPerMin: num(o.max_per_min, RATE.maxPerMin, 1, 100_000),
    // 并发上限：1 = 完全串行（默认，最保守）；>1 允许同时在途
    concurrency: Math.floor(num(o.concurrency, 1, 1, 64)),
    jitterMs: RATE.jitterMs,
  };
}

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

// 同一渠道的「最近调用」写回必须串行：三个写函数都是整列 UPDATE recent_calls，
// 生产调用与定时检测/手动测试并发时，后完成的旧快照会覆盖掉新记录。
const recentWrites = new Map();
function chainRecentWrite(channelId, fn) {
  const key = Number(channelId) || 0;
  const prev = recentWrites.get(key) || Promise.resolve();
  // set 与比较必须用同一个 promise 对象（存 catch 后的尾链会让删除条件永远不成立）
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tail.finally(() => {
    if (recentWrites.get(key) === tail) recentWrites.delete(key);
  });
  recentWrites.set(key, tail);
  return run;
}

/** 删除渠道时清掉串行写回表的条目，避免 Map 常驻累积 */
export function forgetRecentWrites(channelId) {
  recentWrites.delete(Number(channelId) || 0);
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
  await chainRecentWrite(channelId, async () => {
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
  });
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

/**
 * 不该自愈的错误码 → 直接把渠道**自动暂停**（status=3）。
 *
 * 用户要求：「如果某个渠道自动检测，或者手动检测，或者用户调用到了出错了，
 * 则自动暂停状态即可」。
 *
 * 但这里刻意**按错误性质区分**，而不是所有错误都暂停：
 *   · 该暂停的：凭据失效、被封禁、权限不足、渠道类型/配置错误 ——
 *     它们不会自己好，继续参与调度只是白打上游（还可能加重风控）。
 *   · 不该暂停的：限流、网络抖动、超时、上游 5xx —— 冷却一下就能恢复，
 *     暂停反而要管理员手工介入（深夜出一次抖动就把渠道停掉是过度反应）。
 *
 * 校验过的一个反例：早先的实现注释写着「运行期错误若直接写 status=3，会导致
 * token 更新后渠道仍被永久排除」—— 那个担心现在由「状态列可点击启停 +
 * 错误原因直接展示」解决：管理员一眼能看到「已自动暂停」并点一下恢复，
 * 不需要它自己悄悄恢复（悄悄恢复才是更危险的：坏凭据会一直被调度）。
 */
export const AUTO_PAUSE_CODES = new Set([
  "CHANNEL_AUTH_EXPIRED", // 凭据失效：重试一万次也不会好
  "CHANNEL_FORBIDDEN",    // 权限不足（模型档位/账号权限）
  "CHANNEL_CONFIG_ERROR", // 订阅渠道部署配置缺失
  "UNSUPPORTED_CHANNEL",  // 渠道类型未注册 / 适配器缺失
  "CHANNEL_CAPTCHA",      // 需要人机验证：必须人工过一次
  "CHANNEL_WAF",          // 被 WAF 拦：短时间内不会自愈
]);

// 标记渠道运行异常：运行时冷却 + （不可自愈的错误）自动暂停。
export async function markChannelError(channel, message, cooldownSec = 300, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = Date.now() + cooldownSec * 1000;
  s.lastError = String(message).slice(0, 400);
  // 最近调用记录与 last_error 一起写回（只记录错误信息，便于管理端展示"异常"原因）
  await chainRecentWrite(channel.id, async () => {
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
  });
  // 不可自愈的错误 → 自动暂停（status=3）。
  // 三重保护：① 只在错误码命中白名单时暂停；② 尊重渠道的 auto_ban 开关
  //（管理员关掉它就是不希望自动停）；③ 已经暂停的不重复写（省一次 DB 往返）。
  const code = String(meta.errorCode || "");
  if (AUTO_PAUSE_CODES.has(code) && channel?.auto_ban !== 0 && Number(channel?.status) === 1) {
    await pool
      .query("UPDATE channels SET status = 3 WHERE id = ? AND status = 1", [channel.id])
      .then(([ret]) => {
        if (ret.affectedRows) {
          console.warn(`[router] 渠道 #${channel.id}「${channel.name}」因 ${code} 已自动暂停：${s.lastError.slice(0, 120)}`);
        }
      })
      .catch(() => {});
    // 让内存态与库一致：下次调度不再选中它
    s.autoPaused = true;
  }
}

export async function markChannelOk(channel, elapsedMs, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = 0;
  s.lastError = "";
  // 只更新运行指标，不改 status —— status 是管理员开关（手动启停），
  // 写 status=1 会复活管理员刚禁用的渠道。
  // used_count/last_used_time 供管理端展示渠道使用情况（此前从未累加）。
  await chainRecentWrite(channel.id, async () => {
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
  });
}

function delayFor(channel) {
  const r = rateOf(channel);
  const s = st(channel.id);
  const t = Date.now();
  s.window = s.window.filter((x) => t - x < 60_000);
  if (s.window.length >= r.maxPerMin) return 60_000 - (t - s.window[0]) + 400;
  const since = t - s.lastAt;
  if (since < r.minGapMs) return r.minGapMs - since + Math.random() * r.jitterMs;
  return 0;
}

function commitRate(channel) {
  const s = st(channel.id);
  s.lastAt = Date.now();
  s.window.push(Date.now());
}

/**
 * 渠道限速闸门：同一渠道的请求按账号配置串行/限并发执行。
 *
 * concurrency=1（默认）时行为与原先一致：整条链严格串行 —— 这是保护反代账号
 * 最保守、也是风控最不敏感的方式。
 * concurrency>1 时放开为真正的信号量：最多 N 个在途，第 N+1 个开始等待。
 *
 * 注意：这里必须用「等待者队列」而不是「首尾相接的 promise 链」。
 * 旧实现是 `gate.then(() => run())` 且 run() 里 await 整个任务，
 * 于是下一个任务的 gate 要等上一个任务**彻底结束**才 resolve ——
 * 结果是即便把 concurrency 配成 8，仍然严格串行，管理员以为放开了并发但毫无效果。
 *
 * 为什么仍然保留「最小间隔」：即使放开并发，也按 min_gap_ms 给提交节奏留随机抖动，
 * 避免 N 个请求在同一毫秒一起打出去（那是明显的脚本特征）。
 */
export function withChannelLimit(channel, taskFn) {
  const r = rateOf(channel);
  const key = channel.id;
  const s = st(key);

  // 名额必须在这里「占」下来，不能等 delayFor 之后才 ++。
  // 否则在 min_gap（默认 1200ms）窗口内到达的请求，每个都看到 inflight=0 而放行，
  // delay 结束后一起 ++ 并发发车 —— 实测 concurrency=2 时上限会被突破到 5，
  // 且它们在同一毫秒齐发（正是本函数要避免的脚本特征）。
  const takeSlot = () => {
    s.inflight = (s.inflight || 0) + 1;
  };
  const dropSlot = () => {
    s.inflight = Math.max(0, (s.inflight || 1) - 1);
    // 唤醒一个等待者（若有）。放在 finally 里保证失败也会让位，
    // 否则一次异常就会把该渠道的并发槽永久占死。
    const nextInLine = s.waiters?.shift();
    if (nextInLine) nextInLine();
  };

  // 串行模式下名额在任务体内取（与并发模式互斥，见下方分支）；
  // 并发模式下名额由 tryStart 同步占好后才进入 run。
  const run = async (slotTaken = false) => {
    if (!slotTaken) takeSlot();
    try {
      const waitMs = delayFor(channel);
      if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));
      commitRate(channel);
      return await taskFn();
    } finally {
      dropSlot();
    }
  };

  if (r.concurrency <= 1) {
    // 串行链（原行为）
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(run, run);
    chains.set(key, next);
    // 注意：next.finally() 会派生一个新 Promise，任务失败时无人消费会产生
    // unhandledRejection 噪声，所以先 catch 再挂 finally。
    next.catch(() => {}).finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  }

  // 并发模式：真信号量。名额在 tryStart 里同步占好（含「正在等 min_gap 的请求」），
  // 这样上限才真的是上限；等待者按 FIFO 排队。
  return new Promise((resolve) => {
    const tryStart = () => {
      if ((s.inflight || 0) < r.concurrency) {
        takeSlot();
        // 用 resolve(promise) 让外层直接采用任务的结果（含 rejection）
        resolve(run(true));
        return true;
      }
      return false;
    };
    if (tryStart()) return;
    // 名额已满：挂到等待队列，由 dropSlot 唤醒。
    // 入队的是「可重入的一次性函数」：被唤醒时若名额被别人抢走就继续排队，
    // 避免唤醒后无人补位导致并发度凭空少 1。
    if (!s.waiters) s.waiters = [];
    const waiter = () => {
      if (!tryStart()) s.waiters.push(waiter);
    };
    s.waiters.push(waiter);
  });
}

export function resetChannelState(channelId) {
  invalidateChannelCache();
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
  invalidateChannelCache();
  state.delete(Number(channelId));
  chains.delete(Number(channelId));
  forgetRecentWrites(channelId);
}

export function channelRuntimeState(channelId) {
  const s = state.get(Number(channelId));
  return {
    cooldown_until: s?.cooldownUntil || 0,
    last_error: s?.lastError || "",
    recent: s?.recent || [],
  };
}

/**
 * 全渠道运行时快照（监控页的「并发/队列」卡片）。
 * 只返回进程内已知的渠道 —— 从未被调用过的账号不会出现在这里，
 * 调用方（监控接口）需要与 channels 表左连接，把「未激活」的补出来。
 */
export function runtimeConcurrency() {
  const now = Date.now();
  const out = [];
  for (const [id, s] of state.entries()) {
    out.push({
      channelId: id,
      inflight: s.inflight || 0,
      coolingDown: Boolean(s.cooldownUntil && now < s.cooldownUntil),
      cooldownUntil: s.cooldownUntil || 0,
      cooldownRemainSec: s.cooldownUntil && now < s.cooldownUntil ? Math.ceil((s.cooldownUntil - now) / 1000) : 0,
      lastError: s.lastError || "",
      recentCalls: s.window?.length || 0, // 最近一分钟内的提交次数
      // 等待名额的请求数：并发模式下是真实的排队数，串行模式下只有「有链在跑」这一个信息
      queued: (s.waiters?.length || 0) + (chains.has(id) ? 1 : 0),
    });
  }
  return out;
}

/** 读取最近调用：运行时没有就從数据库行回填并缓存（列表接口与调度共用同一份）。
 * 修复：列表页只读运行时导致服务重启后刷新显示「暂无调用」。 */
export function channelRecent(channelId, rawRecentCalls) {
  const s = st(Number(channelId));
  if (!s.recent || !s.recent.length) s.recent = parseRecent(rawRecentCalls);
  return s.recent;
}

// 渠道是否属于某请求分组（分组由管理员创建，未分组渠道 = 公共池）。
//   · groupName 为空 / "default"（历史值）→ 只有「未分组」的渠道可用（公共池）；
//   · 分组名 → 按**名字**匹配（分组名全局唯一，可跨厂商）。
// 兼容历史绑定：旧版 Key 绑的是 "vendor:分组名"，这里剥掉前缀按名字匹配即可 ——
// 分组的成员本来就不再受厂商限制，所以厂商前缀对匹配没有意义。
export function channelInGroup(channel, groupName) {
  const groups = Array.isArray(channel?.groups) ? channel.groups : [];
  if (!groupName) return groups.length === 0;
  let name = String(groupName);
  const idx = name.indexOf(":");
  if (idx > 0) name = name.slice(idx + 1); // 剥掉历史厂商前缀
  if (name === "default") return groups.length === 0;
  return groups.includes(name);
}

function parseModels(modelsStr) {
  return String(modelsStr || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 渠道 → 厂商模型集合（同步缓存）。
// 概念澄清：**模型属于厂商，不属于账号** —— 一个 ChatGPT 账号天然能用 OpenAI 的全部模型，
// 让管理员给每个账号手填「支持的模型」既多余又容易漏配（漏一个模型该账号就永远不被调度）。
// 因此渠道 `models` 留空 = 该厂商全部已注册模型；只在与厂商模型表对不上时才需要显式声明
// （例如 custom 兼容端点，或只想让某个号只跑部分模型）。
let vendorModelsCache = { at: 0, map: null };
const VENDOR_MODELS_TTL_MS = 60_000;

function vendorModelSet(channelType) {
  const t = String(channelType || "");
  if (!t) return null;
  if (!vendorModelsCache.map || Date.now() - vendorModelsCache.at > VENDOR_MODELS_TTL_MS) {
    vendorModelsCache = { at: Date.now(), map: new Map() };
  }
  const cache = vendorModelsCache.map;
  if (cache.has(t)) return cache.get(t);
  // 登记表没就绪（刚被失效、还没重新预热）时**不缓存 null**：
  // 一旦把 null 写进 60s TTL，所有「models 留空」的渠道会在整整一个周期内被判为不可用
  // ——渠道写操作（测试/查额度/保存）会让登记表失效，这会把「点一下测试」变成「全站 503」。
  const reg = modelRegistrySync();
  if (!reg) {
    ensureRegistryWarmup();
    return null;
  }
  const set = new Set();
  for (const [model, info] of reg) {
    if (String(info?.type || "") === t) set.add(model);
  }
  cache.set(t, set);
  return set;
}

// 登记表被失效后异步补热（不阻塞调度：本次按「无厂商表」保守处理，下一次请求就正常了）
let warmupTimer = null;
function ensureRegistryWarmup() {
  if (warmupTimer) return;
  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    import("./models.js")
      .then((m) => m.modelRegistry())
      .catch(() => {});
  }, 200);
  warmupTimer.unref?.();
}

/** 厂商模型集合变更时清缓存（登记表失效后必须同步清，否则会拿旧集合判断） */
export function invalidateVendorModels() {
  vendorModelsCache = { at: 0, map: null };
}

/** 渠道是否支持该模型（支持通配：deepseek-* 或 *） */
export function channelSupportsModel(channel, model) {
  const list = parseModels(channel.models);
  const m = String(model || "").toLowerCase();
  // 留空 = 该厂商全部模型（模型归属厂商，不归属账号）
  if (!list.length) {
    const vendorSet = vendorModelSet(channel.type);
    if (!vendorSet || !vendorSet.size) return false; // 没有厂商模型表（如 custom）：必须显式声明
    return vendorSet.has(m);
  }
  return list.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === "*") return true;
    if (p.endsWith("*")) return m.startsWith(p.slice(0, -1));
    return p === m;
  });
}

/**
 * 一组渠道实际能服务哪些模型（id 集合）。
 * 口径必须与 channelSupportsModel 一致，否则会出现「列表里看不到 = 实际能调」或反过来。
 * 网关 /v1/models 与站内对话的模型下拉都用它，避免各处自己 split(models) 导致语义漂移。
 */
export function collectAvailableModels(channelRows) {
  const out = new Set();
  for (const r of channelRows || []) {
    const ch = rowToChannel(r);
    const declared = parseModels(ch.models);
    if (declared.length) {
      for (const m of declared) {
        const t = m.trim();
        if (!t) continue;
        // 显式写 "*" 与「留空」同义（channelSupportsModel 就是这么判的）。
        // 之前这里把 "*" 直接丢掉，于是声明了 "*" 的渠道在 available 里既没有具体模型
        // 也没有通配标记 —— 网关过滤条件恒为假，该渠道能服务的模型在 /v1/models
        // 里完全看不到，但实际调用又能成功（列表与真实能力不一致）。
        if (t === "*") {
          out.add("*");
          continue;
        }
        out.add(t.toLowerCase());
      }
      continue;
    }
    // 留空 = 该厂商全部模型
    const vendorSet = vendorModelSet(ch.type);
    if (vendorSet) for (const m of vendorSet) out.add(m);
    else out.add("*"); // 厂商表还没就绪：先按「不限」放行，避免列表瞬间空掉
  }
  return out;
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
  const method = isApiKeyMethod(r.type, rawMethod) || isOAuthMethod(rawMethod) ? rawMethod : "relay";
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
    // 只回数量、不回渠道名：这条 message 会原样返回给 API 调用方、也会进普通用户可见的
    // 错误日志，而渠道名通常是上游账号邮箱（等于泄露供应商/账号身份）。
    // 管理员在渠道管理页的「冷却」标签与最近调用里能看到具体是哪些。
    return {
      reason: "COOLING",
      message: `支持模型「${model}」的 ${cooling.length} 个账号都在冷却中，请稍后重试`,
    };
  }
  if (!forModel.length) {
    // 同理不回厂商类型明细，只引导到管理员
    return {
      reason: "NO_MODEL",
      message: `当前没有可服务模型「${model}」的账号，请联系管理员在渠道管理中配置`,
    };
  }
  return {
    reason: "GROUP",
    message: `没有可用渠道支持模型「${model}」（已排除分组不匹配${disabled?.c ? `，另有 ${disabled.c} 个渠道被禁用` : ""}）`,
  };
}

//          而不是永远打在第一个账号上（那会让单账号迅速触发风控）。
// 渠道列表在热路径被频繁读取（每次模型调用、agent 每一步、每次工具调用），
// 加短 TTL 缓存；渠道变更（resetChannelState/forgetChannel）立即失效，最坏只落后 TTL。
let channelsCache = null;
let channelsCacheAt = 0;
let channelsCacheEpoch = 0;
const CHANNELS_TTL_MS = 5000;
export function invalidateChannelCache() {
  // epoch：失效前已发出的查询返回后不能把旧快照写回缓存（否则被删/禁用渠道还能参与调度）
  channelsCacheEpoch++;
  channelsCacheAt = 0;
}

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
  if (!channelsCache || Date.now() - channelsCacheAt > CHANNELS_TTL_MS) {
    const epoch = channelsCacheEpoch;
    const [rows] = await pool.query(
      "SELECT * FROM channels WHERE status = 1 ORDER BY priority DESC, id ASC"
    );
    if (epoch === channelsCacheEpoch) {
      channelsCache = rows;
      channelsCacheAt = Date.now();
    } else {
      return selectChannels({ model, excludeIds, groupName }); // 查询期间有变更：重查一次
    }
  }
  const rows = channelsCache;
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
