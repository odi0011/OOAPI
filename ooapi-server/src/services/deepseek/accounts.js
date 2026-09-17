// DeepSeek 账号池（MySQL 版，集成进 ooapi）
// - 账号存 MySQL 表 deepseek_accounts，管理员可在后台增删改查
// - 每次对话从池中轮询选一个可用账号
// - 每账号独立限速（相邻请求间隔 + 每分钟上限），状态存内存按 account.id 索引
// - 被禁言 / token 失效的账号自动隔离，期间不参与调度
import { pool } from "../../db.js";
import { now } from "../../utils.js";

// 单账号默认限速（贴近真人节奏，降低风控概率）
const DEFAULT_RATE = { minGapMs: 2600, jitterMs: 2600, maxPerMin: 12 };

// 运行时状态（不落盘）：accountId -> { lastAt, window[], muteUntil }
const state = new Map();
const chains = new Map();

function ensureState(accountId) {
  if (!state.has(accountId)) state.set(accountId, { lastAt: 0, window: [] });
  return state.get(accountId);
}

export async function loadAccounts({ onlyEnabled = false } = {}) {
  const sql = onlyEnabled
    ? "SELECT * FROM deepseek_accounts WHERE status = 1 ORDER BY id ASC"
    : "SELECT * FROM deepseek_accounts ORDER BY id ASC";
  const [rows] = await pool.query(sql);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    token: r.token,
    cookies: safeParse(r.cookies),
    status: r.status,
    mute_until: Number(r.mute_until) || 0,
    used_count: r.used_count,
    last_used_time: Number(r.last_used_time) || 0,
    last_error: r.last_error || "",
    created_time: Number(r.created_time) || 0,
  }));
}

function safeParse(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function isMuted(account) {
  const s = state.get(account.id);
  if (!s || !s.muteUntil) return false;
  if (Date.now() >= s.muteUntil * 1000) {
    s.muteUntil = 0;
    return false;
  }
  return true;
}

// 账号被禁言：记录解禁时间（内存隔离 + 落库状态）
export async function markMuted(account, muteUntilSec) {
  const s = ensureState(account.id);
  s.muteUntil = muteUntilSec || Math.floor(Date.now() / 1000) + 3600;
  await pool
    .query("UPDATE deepseek_accounts SET status = 3, mute_until = ?, last_error = ? WHERE id = ?", [
      s.muteUntil,
      `被禁言至 ${new Date(s.muteUntil * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      account.id,
    ])
    .catch(() => {});
}

// token 失效类：隔离较久（默认 6 小时）
export async function markUnusable(account, penaltySec = 6 * 3600, message = "token 失效") {
  const s = ensureState(account.id);
  s.muteUntil = Math.floor(Date.now() / 1000) + penaltySec;
  await pool
    .query("UPDATE deepseek_accounts SET status = 3, mute_until = ?, last_error = ? WHERE id = ?", [
      s.muteUntil,
      String(message).slice(0, 480),
      account.id,
    ])
    .catch(() => {});
}

function delayFor(account) {
  const s = ensureState(account.id);
  const t = Date.now();
  s.window = s.window.filter((x) => t - x < 60_000);
  if (s.window.length >= DEFAULT_RATE.maxPerMin) {
    return 60_000 - (t - s.window[0]) + 500;
  }
  const since = t - s.lastAt;
  if (since < DEFAULT_RATE.minGapMs) {
    return DEFAULT_RATE.minGapMs - since + Math.random() * DEFAULT_RATE.jitterMs;
  }
  return 0;
}

function commitRate(account) {
  const s = ensureState(account.id);
  s.lastAt = Date.now();
  s.window.push(Date.now());
}

// 一轮对话套一次限速（同账号串行排队）
export function withAccountRateLimit(account, taskFn) {
  const run = async () => {
    const waitMs = delayFor(account);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    commitRate(account);
    return taskFn();
  };
  const key = account.id;
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

function usable(account) {
  // status: 1=启用 2=禁用 3=异常(隔离中)
  if (account.status === 2) return false;
  if (account.status === 3 && isMuted(account)) return false;
  if (account.status === 3 && !isMuted(account)) return true; // 隔离期已过，自动恢复
  return true;
}

// 轮询选号：round-robin，存模块级游标
export async function pickAccount({ excludeIds = null } = {}) {
  const accounts = await loadAccounts({ onlyEnabled: false });
  const excluded = excludeIds instanceof Set ? excludeIds : new Set();
  const list = accounts.filter((a) => a.token && usable(a) && !excluded.has(a.id));
  if (!list.length) return null;
  let cursor = pickAccount._cursor || 0;
  const picked = list[cursor % list.length];
  pickAccount._cursor = cursor + 1;
  return picked;
}

// 记录一次成功使用
export async function markUsed(account) {
  await pool
    .query(
      "UPDATE deepseek_accounts SET used_count = used_count + 1, last_used_time = ?, last_error = '' WHERE id = ?",
      [now(), account.id]
    )
    .catch(() => {});
}

// 管理员手动清除隔离状态
export function clearIsolation(accountId) {
  const s = state.get(accountId);
  if (s) s.muteUntil = 0;
}

export async function addAccount({ name, token, cookies }) {
  const t = String(token || "").trim();
  if (!t) throw new Error("token 不能为空");
  const [dup] = await pool.query("SELECT id FROM deepseek_accounts WHERE token = ? LIMIT 1", [t]);
  if (dup.length) throw new Error("该 token 已存在");
  const [ret] = await pool.query(
    "INSERT INTO deepseek_accounts (name, token, cookies, status, created_time) VALUES (?,?,?,1,?)",
    [String(name || "").trim() || `账号${randomSuffix()}`, t, JSON.stringify(cookies || []), now()]
  );
  return ret.insertId;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

export async function deleteAccount(id) {
  const [ret] = await pool.query("DELETE FROM deepseek_accounts WHERE id = ?", [id]);
  state.delete(Number(id));
  chains.delete(Number(id));
  return ret.affectedRows > 0;
}

export async function updateAccount(id, fields) {
  const sets = [];
  const args = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    args.push(val);
  }
  if (!sets.length) return false;
  args.push(id);
  const [ret] = await pool.query(`UPDATE deepseek_accounts SET ${sets.join(", ")} WHERE id = ?`, args);
  return ret.affectedRows > 0;
}
