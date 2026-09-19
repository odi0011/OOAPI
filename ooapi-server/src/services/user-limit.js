// 用户级限流：并发数 / RPM / TPM
// ---------------------------------------------------------------------------
// 为什么单独做一个模块：`default_user_concurrency`、`default_user_rpm`、
// `default_user_tpm` 这三个设置项在系统设置里能改，但此前**没有任何代码读取**——
// 管理员以为配了限额，实际完全不生效（和「模型列表」那类死配置同性质）。
//
// 三个维度的语义与实现：
//   · 并发数：进程内在途计数，硬闸门（超过直接 429，不排队）。
//     排队会让上游连接和 DB 连接被占着，反而拖慢别人；用户自查也更容易（立即报错）。
//   · RPM：滑动窗口（最近 60 秒的请求时间戳），超过直接 429。
//   · TPM：按「预估 token」在请求前预占，请求结束后用真实用量修正。
//     为什么预占：token 数只有响应结束才知道，若不预占则一个用户可以瞬间并发
//     打满 TPM 而全部放行（限额形同虚设）。预占用 prompt 估算，
//     结束后多退少补 —— 与计费的预扣思路一致。
//
// 取值优先级：用户 setting.limits.{concurrency,rpm,tpm} > 全局 default_user_* > 无限制(0)。
import { getNumberOption } from "../config.js";

// userId -> { inflight, stamps: [], tokens: [], reserved }
const users = new Map();

function st(userId) {
  const key = Number(userId) || 0;
  let s = users.get(key);
  if (!s) {
    s = { inflight: 0, stamps: [], tokenEvents: [], reserved: 0 };
    users.set(key, s);
  }
  return s;
}

/** 解析 users.setting（DB 里是 TEXT 列，可能是 JSON 字符串，也可能是已解析的对象） */
function settingOf(user) {
  const raw = user?.setting;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {}; // 脏数据不该让限流报错
  }
}

/**
 * 合成单项限额：用户自定义**只能收紧，不能放宽**。
 *
 * 为什么必须这样：`setting` 这一列可以通过 `PUT /api/user/self/settings` 由
 * 用户自己写入（任意 JSON）。若直接采用用户填的值，用户只要写
 * `{"limits":{"rpm":0}}` 就能把管理员的限额改成「不限制」——0 在我们的语义里
 * 正是「不限制」，等于把限额机制整个绕过。
 * 规则：
 *   · 用户填 0 或负数 → 视为「未自定义」，沿用全局（不能用 0 解除限制）；
 *   · 全局不限（0）而用户填了正数 → 采用用户值（自我限流，无害）；
 *   · 两边都是正数 → 取较小值（只能比管理员配的更严）。
 */
function combine(globalLimit, userLimit) {
  const u = Number(userLimit);
  const g = Number(globalLimit);
  const hasUser = Number.isFinite(u) && u > 0;
  const hasGlobal = Number.isFinite(g) && g > 0;
  if (hasUser && hasGlobal) return Math.min(u, g);
  if (hasUser) return Math.floor(u);
  return hasGlobal ? Math.floor(g) : 0;
}

// 导出给测试：收紧语义是安全边界（用户可通过 /self/settings 写 setting），必须能被单测覆盖
export const __combine = combine;

/** 读取某用户的三项限额（0 = 不限制） */
export function limitsFor(user) {
  const custom = settingOf(user).limits || {};
  return {
    concurrency: combine(getNumberOption("default_user_concurrency"), custom.concurrency),
    rpm: combine(getNumberOption("default_user_rpm"), custom.rpm),
    tpm: combine(getNumberOption("default_user_tpm"), custom.tpm),
  };
}

/** 清理过期样本（滑动窗口只保留最近 60 秒） */
function trim(s, now) {
  const cutoff = now - 60000;
  if (s.stamps.length && s.stamps[0] < cutoff) {
    s.stamps = s.stamps.filter((t) => t >= cutoff);
  }
  if (s.tokenEvents.length && s.tokenEvents[0]?.at < cutoff) {
    s.tokenEvents = s.tokenEvents.filter((e) => e.at >= cutoff);
  }
}

/** 当前分钟已计 token（含预占） */
function tokensInWindow(s, now) {
  trim(s, now);
  return s.tokenEvents.reduce((a, e) => a + (e.n || 0), 0) + s.reserved;
}

/**
 * 尝试获取一个请求名额。
 * @returns {{ ok: true, release: Function } | { ok: false, code: string, message: string, retryAfterSec: number }}
 */
export function acquire(user, { estimatedTokens = 0 } = {}) {
  const userId = user?.id;
  if (!userId) return { ok: true, release: () => {} }; // 没有用户（内部调用）不限
  const lim = limitsFor(user);
  const s = st(userId);
  const now = Date.now();
  trim(s, now);

  if (lim.concurrency > 0 && s.inflight >= lim.concurrency) {
    return {
      ok: false,
      code: "USER_CONCURRENCY_LIMIT",
      message: `并发数已达上限（${lim.concurrency}），请稍后重试`,
      retryAfterSec: 2,
      kind: "concurrency",
    };
  }
  if (lim.rpm > 0 && s.stamps.length >= lim.rpm) {
    const waitMs = 60000 - (now - s.stamps[0]) + 200;
    return {
      ok: false,
      code: "USER_RPM_LIMIT",
      message: `请求过于频繁（每分钟上限 ${lim.rpm} 次），请 ${Math.ceil(waitMs / 1000)} 秒后重试`,
      retryAfterSec: Math.ceil(waitMs / 1000),
      kind: "rpm",
    };
  }
  // TPM：预占。预留 10% 余量避免边界抖动立刻超限
  if (lim.tpm > 0) {
    const est = Math.max(0, Math.floor(estimatedTokens));
    const used = tokensInWindow(s, now);
    if (used + est > lim.tpm) {
      return {
        ok: false,
        code: "USER_TPM_LIMIT",
        message: `Token 用量已达每分钟上限（${lim.tpm}），请稍后重试`,
        retryAfterSec: 10,
        kind: "tpm",
      };
    }
    s.reserved += est;
  }

  s.inflight += 1;
  s.stamps.push(now);

  let released = false;
  return {
    ok: true,
    release: ({ tokens = null } = {}) => {
      if (released) return; // 幂等：重复调用不会把计数减成负数
      released = true;
      s.inflight = Math.max(0, s.inflight - 1);
      // 预占换真实用量（多退少补）；调用方没给真实值就保留预估
      if (lim.tpm > 0 && estimatedTokens > 0) {
        s.reserved = Math.max(0, s.reserved - estimatedTokens);
      }
      const real = Number(tokens);
      if (lim.tpm > 0 && Number.isFinite(real) && real > 0) {
        s.tokenEvents.push({ at: Date.now(), n: real });
      } else if (lim.tpm > 0 && estimatedTokens > 0) {
        s.tokenEvents.push({ at: Date.now(), n: estimatedTokens });
      }
    },
  };
}

/** 用户当前用量（监控页/个人中心展示；也让管理员能验证限额确实生效） */
export function usageOf(userId) {
  const s = users.get(Number(userId) || 0);
  if (!s) return { inflight: 0, rpmUsed: 0, tpmUsed: 0 };
  const now = Date.now();
  trim(s, now);
  return {
    inflight: s.inflight,
    rpmUsed: s.stamps.length,
    tpmUsed: tokensInWindow(s, now),
  };
}

/** 清理长时间无活动的用户条目，避免 Map 只增不减 */
export function sweepIdle(maxIdleMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of users.entries()) {
    if (s.inflight > 0) continue;
    const last = Math.max(s.stamps[s.stamps.length - 1] || 0, s.tokenEvents[s.tokenEvents.length - 1]?.at || 0);
    if (last && now - last > maxIdleMs) users.delete(id);
    else if (!last) users.delete(id); // 从未真正请求过
  }
}

/** 估算本次请求的 token（用于 TPM 预占）：prompt 用「字符/3」，输出按 max_tokens 或默认上限 */
export function estimateRequestTokens(prompt, maxTokens) {
  const p = Math.ceil(String(prompt || "").length / 3);
  const out = Number(maxTokens) > 0 ? Number(maxTokens) : 1024; // 客户端没给 max_tokens 时按 1k 估
  return p + out;
}
