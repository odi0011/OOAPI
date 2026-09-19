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

// 同一渠道的刷新合并为一次：并发请求共享同一个 Promise，避免用同一 refresh_token 双刷
const refreshLocks = new Map();
export function withRefreshLock(channelId, fn) {
  const existing = refreshLocks.get(channelId);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
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
