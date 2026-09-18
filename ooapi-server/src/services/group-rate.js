// 分组配置（倍率 / 支持模型）读取：30s 缓存，避免每次请求查库。
// 绑定值形态为 "type:name"（如 openai:vip），纯名字（用户分组）无对应分组配置。
import { pool } from "../db.js";

const cache = new Map(); // "type:name" -> { rate, models, at }
const TTL_MS = 30_000;

export function parseGroupKey(groupName) {
  const raw = String(groupName || "").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null;
  return { type: raw.slice(0, idx), name: raw.slice(idx + 1) };
}

export async function groupConfigOf(groupName) {
  const key = parseGroupKey(groupName);
  if (!key) return null;
  const k = `${key.type}:${key.name}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  try {
    const [rows] = await pool.query("SELECT rate, models FROM channel_groups WHERE type = ? AND name = ? LIMIT 1", [
      key.type,
      key.name,
    ]);
    let models = [];
    if (rows.length && rows[0].models) {
      try {
        const arr = JSON.parse(rows[0].models);
        if (Array.isArray(arr)) {
          models = arr
            .map((s) => String(s).trim().toLowerCase())
            .filter(Boolean);
        }
      } catch {
        /* ignore */
      }
    }
    const cfg = { rate: rows.length ? Math.max(0.0001, Number(rows[0].rate) || 1) : 1, models, at: Date.now() };
    cache.set(k, cfg);
    return cfg;
  } catch {
    return null;
  }
}

/** 分组配置变更（建组/编辑/删除）后调用，避免 30s 缓存造成旧倍率/旧模型限制 */
export function clearGroupConfigCache() {
  cache.clear();
}

/** 按分组倍率换算计费额度（rate=1 原样返回；结果至少 1 单位，避免 0 元白嫖） */
export function applyGroupRate(units, rate) {
  const n = Number(units) || 0;
  const r = Number(rate) || 1;
  if (r === 1 || n <= 0) return n;
  return Math.max(1, Math.round(n * r));
}
