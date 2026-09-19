// OAuth 订阅渠道的凭据持久化
// ---------------------------------------------------------------------------
// access_token 会过期：适配器刷新后必须写回 channels.other，否则重启/换请求又用旧 token。
// 写前重读最新 other 再合并，避免覆盖管理员同时改动的内容（与 execute.persistProfile 同思路）。
import { pool } from "../../db.js";

/** 读取渠道最新 other（刷新前重读，避免用陈旧快照里的旧 refresh_token 再刷） */
export async function loadOther(channelId) {
  try {
    const [rows] = await pool.query("SELECT other FROM channels WHERE id = ?", [channelId]);
    if (!rows.length) return null;
    return rows[0].other ? JSON.parse(rows[0].other) : {};
  } catch {
    return null;
  }
}

// 同一渠道的刷新合并为一次：并发请求共享同一个 Promise，避免用同一 refresh_token 双刷。
//
// 为什么共享的必须是「结果」而不只是「等待」：
// 旧实现下加入方 await 同一个 Promise 后把返回值丢掉了（各处写的是
// `await refreshAuth(channel).catch(...)`，只为等待），于是加入方手里仍是**旧 token**：
//   · 拿旧 token 打上游 → 401 → 触发一次强制刷新（白打一次上游 token 端点，
//     对会轮换 refresh_token 的厂商等于连续轮换，反而更像异常客户端）；
//   · 三方以上并发时更糟：C 的强制刷新"加入"了 B 正在飞的刷新，返回后 C 的
//     channel.other 依旧没更新 → 重试用的还是同一个 token → 完全不重试，
//     直接把 401 抛给上层，execute 按 CHANNEL_AUTH_EXPIRED 冷却 **6 小时**，
//     前端还会显示「需要重新登录」——而凭据其实完全正常。
// 所以这里额外做两件事：把持锁者写回的 other 同步给所有加入方的 channel 对象，
// 并让加入方拿到同一个返回值。
const refreshLocks = new Map();

/**
 * 同一渠道的刷新合并为一次。
 *
 * 推荐调用：`withRefreshLock(channel, async () => { ... })` —— 渠道对象在前，
 * 执行体在后；channel.id 从对象里取，joiners 也能据此同步自己的 channel.other。
 * 也兼容 `withRefreshLock(channelId, fn, channel)` 的老写法（内部归一化）。
 *
 * 为什么做参数归一化 + 类型守卫：
 * 曾经 6 个适配器把 `(channel.id, fn, channel)` 误写成 `(channel.id, channel, fn)`，
 * 于是 fn 收到对象、调用时抛 "fn is not a function"。而这个异常被调用方的
 * `.catch()` 吞掉（日志只有一句「提前刷新失败，继续用现有 token」），
 * 结果 token 过期后**永远刷不回来**：Codex / Claude / Gemini / Grok / Kiro
 * 全部订阅渠道集体 401，且从现象上极难定位到参数顺序。
 * 现在：接对象就自己取 id，且 fn 不是函数直接抛错——同类问题第一次调用就炸。
 */
export function withRefreshLock(channelOrId, fn, maybeChannel = null) {
  let channelId;
  let channel;
  if (channelOrId && typeof channelOrId === "object") {
    channel = channelOrId;
    channelId = Number(channel.id);
  } else {
    channelId = Number(channelOrId);
    channel = maybeChannel && typeof maybeChannel === "object" ? maybeChannel : null;
  }
  if (typeof fn !== "function") {
    throw new TypeError(
      `withRefreshLock 需要 (channel, fn) 或 (channelId, fn, channel)，但第二个参数是 ${typeof fn}；` +
        `常见错误是把 channel 传在了 fn 前面`
    );
  }
  const existing = refreshLocks.get(channelId);
  if (existing) {
    // 加入方：等结果，并把结果（含写回的 other）同步到自己的 channel 上
    return existing.then(async (result) => {
      if (channel && (!channel.other?.access_token || channel.other.access_token !== result?.access_token)) {
        const fresh = await loadOther(channelId);
        if (fresh) channel.other = { ...(channel.other || {}), ...fresh };
      }
      return result;
    });
  }
  const p = (async () => {
    try {
      const result = await fn();
      // 持锁者也要把结果同步给其它可能持有同一渠道旧快照的调用方（他们是同一个对象引用时自然生效）
      if (channel && result?.access_token && channel.other && channel.other.access_token !== result.access_token) {
        // refreshAuth 内部一般已写过 channel.other；这里只兜底没写的情况
        const fresh = await loadOther(channelId);
        if (fresh) channel.other = { ...(channel.other || {}), ...fresh };
      }
      return result;
    } finally {
      refreshLocks.delete(channelId);
    }
  })();
  refreshLocks.set(channelId, p);
  return p;
}

/**
 * 把刷新结果合并写回渠道。
 *
 * 「凭据代次」（other.cred_epoch）的作用：管理员用「重新登录 / 找回凭据」换过凭据时
 * 会 +1。刷新是异步的，可能在人工换凭据**之后**才落库 —— 那种情况下 patch 里带的是
 * 旧账号的 access/refresh_token，直接合并会把新凭据覆盖掉（表现为「提示已更新，
 * 实际还是旧账号」）。因此刷新发起时记下 epoch，写回前比对：不一致就只写非凭据字段。
 *
 * @param {number} channelId
 * @param {object} patch 要合并的字段
 * @param {number} [epoch] 发起刷新时读到的 cred_epoch；不传则不做代次保护
 */
export async function persistOtherPatch(channelId, patch, epoch = undefined) {
  if (!channelId || !patch || !Object.keys(patch).length) return;
  try {
    const [rows] = await pool.query("SELECT other FROM channels WHERE id = ?", [channelId]);
    if (!rows.length) return;
    let latest = {};
    try {
      latest = rows[0].other ? JSON.parse(rows[0].other) : {};
    } catch {
      latest = {};
    }
    // 代次不符 = 凭据已被人工替换：丢弃这次刷新的 token 字段，避免用旧账号覆盖新凭据
    const currentEpoch = Number(latest.cred_epoch) || 0;
    if (epoch !== undefined && Number(epoch) !== currentEpoch) {
      console.warn(
        `[auth-store] 渠道 #${channelId} 凭据已于刷新期间被替换（epoch ${epoch} → ${currentEpoch}），丢弃本次刷新结果`
      );
      return;
    }
    Object.assign(latest, patch);
    // 刷新后同步 api_key（渠道列表/「查看 Key」展示的是 access_token，避免显示过期值）
    if (patch.access_token) {
      await pool.query("UPDATE channels SET other = ?, api_key = ? WHERE id = ?", [
        JSON.stringify(latest),
        String(patch.access_token),
        channelId,
      ]);
    } else {
      await pool.query("UPDATE channels SET other = ? WHERE id = ?", [JSON.stringify(latest), channelId]);
    }
  } catch (e) {
    console.warn(`[auth-store] 渠道 #${channelId} 凭据写回失败：`, e.message);
  }
}
