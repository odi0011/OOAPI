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

export async function persistOtherPatch(channelId, patch) {
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
