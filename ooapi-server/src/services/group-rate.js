// 分组配置（倍率 / 支持模型）读取：30s 缓存，避免每次请求查库。
//
// 绑定值形态：现在就是**分组名**（分组名全局唯一）。
// 兼容历史：旧版 Key 绑的是 "vendor:分组名"，这里剥掉前缀后按名字查 ——
// 分组成员不受厂商限制，厂商前缀对配置查找没有意义。
import { pool } from "../db.js";

const cache = new Map(); // 分组名 -> { rate, models, at }
const TTL_MS = 30_000;

/** 从绑定值里取出分组名（剥掉历史厂商前缀）；空/纯 "default" 返回 null（无分组配置） */
export function parseGroupKey(groupName) {
  let raw = String(groupName || "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  // 只剥「像厂商前缀」的部分：冒号前是非空且不含空格的短串
  if (idx > 0 && idx < raw.length - 1) raw = raw.slice(idx + 1);
  if (!raw || raw === "default") return null;
  return { name: raw };
}

/**
 * 归一化绑定值为「纯分组名」，用于展示与日志。
 *
 * 为什么不直接存原值：历史绑定有 "厂商:分组名" 与 "分组名:分组名" 等形态，
 * 原样写进 logs.group_name 会让同一个分组在日志里出现三种不同标签，
 * 前端按分组筛选/聚合就对不上了。
 */
export function displayGroupName(groupName) {
  const key = parseGroupKey(groupName);
  return key ? key.name : "";
}

export async function groupConfigOf(groupName) {
  const key = parseGroupKey(groupName);
  if (!key) return null;
  const hit = cache.get(key.name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  try {
    const [rows] = await pool.query("SELECT rate, models FROM channel_groups WHERE name = ? LIMIT 1", [key.name]);
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
    cache.set(key.name, cfg);
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
