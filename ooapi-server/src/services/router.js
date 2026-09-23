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
  // min_gap_ms：0 / 未设一律回落默认 1200ms。
  // 0 曾被当成「不限间隔」照单放行，而它正是线上 WorkBuddy 撞 429 的直接原因 ——
  // 渠道编辑表单把空值提交成 0（`Number(v) || 0`），于是 20 条批量探测在**同一秒**里
  // 全部打出去，上游 2 秒内就回了两条 `too many requests`。最小间隔是反代账号
  // 最基本的保护，不该因为一个表单默认值被静默关掉；确实需要更密的渠道填 1 也能表达。
  const gap = Number(o.min_gap_ms);
  return {
    minGapMs: Number.isFinite(gap) && gap > 0 && gap <= 600_000 ? gap : RATE.minGapMs,
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

/**
 * 「上游限流」的错误码集合 —— 同一个语义历史上有两个码，必须都认。
 *
 * 为什么会有两个：适配器侧（~15 个文件）早期统一抛 `CHANNEL_RATE_LIMIT`，
 * 而 `upstream/http-error.js` 的 `classifyUpstreamHttp` 归类出的是
 * `CHANNEL_RATE_LIMITED`（多一个 D）。两边各自演化：`RETRYABLE` 与 `cooldownFor`
 * 只收录了带 D 的那个，`metrics.js` 只认不带 D 的那个 —— 于是 429 的冷却档位
 * 长期靠 `default: 300` 巧合对上，任何一处改动都会静默漂移。
 * 这里给出唯一判据，所有需要「这是不是限流」的地方都必须用它。
 */
export const RATE_LIMIT_CODES = new Set(["CHANNEL_RATE_LIMIT", "CHANNEL_RATE_LIMITED"]);

export function isRateLimitedCode(code) {
  return RATE_LIMIT_CODES.has(String(code || ""));
}

/**
 * 上游 429 的停用时长（秒）—— 用户要求：「如果哪个渠道报错 429，不要计入最近调用条条里，
 * 应该直接停止渠道状态然后在额度的余额那一行 tag 的下面新起一行，用橙黄色显示
 * 上游 429，预计恢复时间 xxx」。
 *
 * 与「永久自动暂停」的区别在于**到点自己恢复**：429 是可自愈的（等一会儿就好），
 * 让管理员半夜手工点一下启用是过度反应；而凭据失效那种不可自愈的错误仍然要人来处理。
 * 所以 429 写 status=3 的同时落一个 `rate_limit_until`，后台任务到点放回启用。
 * 15 分钟的依据：适配器侧给出的 429 冷却档位就是 1800s（DeepSeek 网页版）与
 * 300s（其余），这里取 600s 作统一默认并以适配器自带 cooldownSec 优先。
 */
export const RATE_LIMIT_PAUSE_SEC = 600;

/**
 * 429 停用多久（秒）—— 三条失败路径（生产调用 / 手动测试 / 定时检测）共用同一口径。
 *
 * 取「适配器要求的冷却」与默认值的较大者：适配器比自己更清楚上游的脾气
 *（DeepSeek 网页版要求 900s，WorkBuddy 的 429 只要求几百秒）。
 * 上限 30 分钟：限流一般几分钟就缓解，停太久等于白白少一个账号。
 * 下限就是默认值本身，所以 `Math.max` 的第二个参数用它而不是再写一遍 600 ——
 * 三处调用点共用本函数，就不会出现「改了一处、另两处还是旧值」的漂移。
 */
export function rateLimitPauseSec(cooldownSec) {
  return Math.min(1800, Math.max(RATE_LIMIT_PAUSE_SEC, Math.floor(Number(cooldownSec) || 0)));
}

// 标记渠道运行异常：运行时冷却 + （不可自愈的错误）自动暂停 + （429）限时停用后自动恢复。
export async function markChannelError(channel, message, cooldownSec = 300, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = Date.now() + cooldownSec * 1000;
  s.lastError = String(message).slice(0, 400);
  const code = String(meta.errorCode || "");
  const rateLimited = isRateLimitedCode(code);

  // 429 不计入「最近调用」环形记录 —— 用户明确要求：「如果哪个渠道报错 429，
  // 不要计入最近调用条条里，应该直接停止渠道状态」。
  // 理由站得住：最近调用那 20 条要回答的是「这个渠道干活干得怎么样」，
  // 是给管理员看成功率与耗时的；而被上游限流挡回来的请求**根本没被处理**，
  // 它既不代表渠道故障也不代表渠道健康。把它塞进去只会：
  //   · 稀释真实成功率，让「最近 20 条」里的红条全是同一个限流事件的回声；
  //   · 让成功率的含义变成「包含我们自己撞墙的次数」，与管理员要看的不是一回事。
  // 所以限流只更新 last_error / last_error_code / 状态列，不 push recent。
  if (!rateLimited) {
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
        .query("UPDATE channels SET last_error = ?, last_error_code = ?, recent_calls = ? WHERE id = ?", [
          s.lastError,
          code,
          recentJson,
          channel.id,
        ])
        .catch(() => {});
    });
  } else {
    // 限流只写错误信息与码，保留原有 recent_calls 不动
    await pool
      .query("UPDATE channels SET last_error = ?, last_error_code = ? WHERE id = ?", [s.lastError, code, channel.id])
      .catch(() => {});
  }

  // 不可自愈的错误 → 自动暂停（status=3）。
  // 三重保护：① 只在错误码命中白名单时暂停；② 尊重渠道的 auto_ban 开关
  //（管理员关掉它就是不希望自动停）；③ 已经暂停的不重复写（省一次 DB 往返）。
  if (AUTO_PAUSE_CODES.has(code) && channel?.auto_ban !== 0 && Number(channel?.status) === 1) {
    await pool
      .query("UPDATE channels SET status = 3, rate_limit_until = 0 WHERE id = ? AND status = 1", [channel.id])
      .then(([ret]) => {
        if (ret.affectedRows) {
          console.warn(`[router] 渠道 #${channel.id}「${channel.name}」因 ${code} 已自动暂停：${s.lastError.slice(0, 120)}`);
        }
      })
      .catch(() => {});
    // 让内存态与库一致：下次调度不再选中它
    s.autoPaused = true;
    // 渠道快照有 5s TTL：不立刻失效的话，停用后的几秒内调度仍会选中它
    invalidateChannelCache();
  } else if (rateLimited && channel?.auto_ban !== 0 && Number(channel?.status) === 1) {
    // 429 → **停用渠道，但带自动恢复时间**（用户要求「直接停止渠道状态」）。
    // 与上一分支的唯一区别是 `rate_limit_until`：限流是可自愈的，到点由
    // resumeRateLimitedChannels() 放回启用；凭据失效那类留 0，只能人工处理。
    // 时长口径见 rateLimitPauseSec（与手动测试 / 定时检测共用，避免漂移）
    const pauseSec = rateLimitPauseSec(cooldownSec);
    const until = now() + pauseSec;
    await pool
      .query("UPDATE channels SET status = 3, rate_limit_until = ? WHERE id = ? AND status = 1", [until, channel.id])
      .then(([ret]) => {
        if (ret.affectedRows) {
          console.warn(
            `[router] 渠道 #${channel.id}「${channel.name}」因上游 429 已停用 ${pauseSec}s（到 ${new Date(until * 1000).toISOString()} 自动恢复）`
          );
        }
      })
      .catch(() => {});
    s.autoPaused = true;
    s.rateLimitUntil = until;
    invalidateChannelCache();
  }
}

/**
 * 把「因 429 被停用且已到恢复时刻」的渠道放回启用。
 *
 * 只在 `rate_limit_until > 0` 时动手 —— 这个字段是限流专属的标记：
 * 凭据失效/WAF 那类自动暂停同样是 status=3，但标记为 0，
 * 它们**不会**被这里复活（悄悄复活坏凭据比停着更危险，见 AUTO_PAUSE_CODES 的注释）。
 * 管理员手工禁用（status=2）也不受影响：本函数只挑 status=3 的行。
 */
export async function resumeRateLimitedChannels() {
  const t = now();
  const [rows] = await pool
    .query("SELECT id, name, rate_limit_until FROM channels WHERE status = 3 AND rate_limit_until > 0 AND rate_limit_until <= ?", [t])
    .catch(() => [[]]);
  for (const row of rows) {
    const [ret] = await pool
      .query("UPDATE channels SET status = 1, rate_limit_until = 0, last_error = '' WHERE id = ? AND status = 3", [row.id])
      .catch(() => [{ affectedRows: 0 }]);
    if (ret?.affectedRows) {
      // 内存态也要清：否则冷却计时还在，调度侧仍把它当坏渠道
      const s = state.get(Number(row.id));
      if (s) {
        s.autoPaused = false;
        s.rateLimitUntil = 0;
        s.cooldownUntil = 0;
        s.lastError = "";
      }
      invalidateChannelCache();
      console.log(`[router] 渠道 #${row.id}「${row.name}」限流结束，已自动恢复启用`);
    }
  }
  // 冷却时间到但没走 429 分支的（例如中途被管理员手工启用）：顺手把过期标记清掉
  await pool.query("UPDATE channels SET rate_limit_until = 0 WHERE status <> 3 AND rate_limit_until > 0").catch(() => {});
  return rows.length;
}

export async function markChannelOk(channel, elapsedMs, meta = {}) {
  const s = st(channel.id);
  s.cooldownUntil = 0;
  s.lastError = "";
  s.rateLimitUntil = 0;
  // 只更新运行指标，不改 status —— status 是管理员开关（手动启停），
  // 写 status=1 会复活管理员刚禁用的渠道。
  // used_count/last_used_time 供管理端展示渠道使用情况（此前从未累加）。
  // rate_limit_until 清零：这一轮成功了，之前那次 429 的恢复时刻已经没有意义
  //（况且渠道已经真的在干活了，前端不该再显示「预计恢复时间」）。
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
        "UPDATE channels SET response_time = ?, tested_time = ?, last_error = '', last_error_code = '', rate_limit_until = 0, used_count = used_count + 1, last_used_time = ?, recent_calls = ? WHERE id = ?",
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
    s.rateLimitUntil = 0;
    s.autoPaused = false;
  }
}

/**
 * 把「限流到某时刻恢复」写进运行时状态（内存）。
 * 给 routes/channel.js 的手动测试用：它在 `resetChannelState()`（会清内存态）之后
 * 需要把刚写进 DB 的 `rate_limit_until` 补回内存，否则同进程内读到的仍是 0，
 * 管理员要等下一次查库才看到恢复时间。
 */
export function setChannelRateLimit(channelId, untilSec) {
  const s = st(Number(channelId));
  s.rateLimitUntil = Number(untilSec) || 0;
  if (s.rateLimitUntil) s.autoPaused = true;
  invalidateChannelCache();
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
    // 429 停用的恢复时刻（秒）：管理端额度行据此显示「上游 429，预计恢复时间」。
    // 以 DB 列为准（重启后内存态会丢，而停用状态是持久的），这里只做运行时的即时补充。
    rate_limit_until: s?.rateLimitUntil || 0,
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
  // **该分组下一个渠道都没有** —— 用户要求（原话）：
  //   「分组如果渠道为空则直接也是调用时返回当前密钥绑定分组 xx 下无可用渠道」
  //
  // 这种情况与「有渠道但都不支持这个模型」是**两件不同的事**，排查方向完全相反：
  //   · 分组没渠道   → 管理员忘了给分组绑渠道（去分组管理 / 渠道编辑里绑）
  //   · 有渠道无模型 → 该分组确实不提供这个模型（去渠道里补模型声明）
  // 合并成一句「没有可用渠道支持模型 X」会让管理员去查渠道的模型声明，白费功夫。
  if (groupName && !inGroup.length) {
    return {
      reason: "GROUP_EMPTY",
      message: `当前密钥绑定的分组「${groupName}」下没有可用渠道，请联系管理员把渠道绑定到该分组`,
    };
  }
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
