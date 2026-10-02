// 展示接入来源与开发厂商是两份元信息；这里只传播渠道真实声明，不猜模型名前缀。
import { providerKeys } from "./channel-types.js";
import { canonicalModelName, modelInAllowList, modelRegistrySync } from "./models.js";
import { collectAvailableModels, channelSupportsModel } from "./router.js";
import { pool } from "../db.js";

const TYPES = new Set(providerKeys());
export function sourceVendors(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === "string").map((v) => v.trim().toLowerCase()).filter((v) => TYPES.has(v)))].sort().slice(0, 40);
}
const json = (value, fallback) => {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
};
function groupsOf(channel) {
  const groups = json(channel?.group_list, []);
  return Array.isArray(groups) ? groups.map(String).filter((v) => v && v !== "default") : [];
}
function declaredModels(channel) {
  return String(channel?.models || "").split(/[\s,，]+/).map((v) => v.trim()).filter((v) => v && v !== "*" && !v.endsWith("*"));
}

/** 复用真实调度能力：空声明/通配展开已有登记，不把通配本身伪装为型号。调用方先预热登记表。 */
export function channelModelVendors(channel, candidates = []) {
  const vendor = sourceVendors([channel?.type])[0];
  const out = Object.create(null);
  if (!vendor) return out;
  const available = collectAvailableModels([channel]);
  const models = new Set([...declaredModels(channel), ...available, ...candidates]);
  if (available.has("*")) for (const model of modelRegistrySync()?.keys() || []) models.add(model);
  for (const model of models) {
    if (!model || model.endsWith("*") || !channelSupportsModel(channel, model)) continue;
    out[model] = [vendor];
    const identity = canonicalModelName(model);
    if (identity) out[identity] = [vendor];
  }
  return out;
}

/** 原始ID/组白名单/规范ID均可查来源；仅合并身份，绝不生成额外定价或改变调度。 */
export function groupModelVendors(group, channels, { activeOnly = false } = {}) {
  const allowed = json(group?.models, []);
  const limits = Array.isArray(allowed) ? allowed.map(String) : [];
  const members = channels.filter((c) => groupsOf(c).includes(String(group?.name || "")) && (!activeOnly || Number(c.status) === 1));
  const byIdentity = new Map();
  const rawModels = new Set(limits.filter((v) => v && !v.endsWith("*")));
  for (const channel of members) {
    const sources = channelModelVendors(channel, [...rawModels]);
    for (const [model, vendors] of Object.entries(sources)) {
      if (!modelInAllowList(limits, model)) continue;
      const identity = canonicalModelName(model);
      if (!byIdentity.has(identity)) byIdentity.set(identity, new Set());
      for (const vendor of vendors) byIdentity.get(identity).add(vendor);
      rawModels.add(model); rawModels.add(identity);
    }
  }
  const out = Object.create(null);
  for (const model of rawModels) out[model] = sourceVendors([...(byIdentity.get(canonicalModelName(model)) || [])]);
  return out;
}

/** 报价快照中的provider已是实际接入类型；只读取这一个受控品牌字段。 */
export function billingSourceVendors(billing) {
  const bill = json(billing, {});
  if (!bill || typeof bill !== "object" || bill.version !== 1) return [];
  return sourceVendors([bill.channel_quote?.provider, ...(Array.isArray(bill.calls) ? bill.calls.map((c) => c?.channel_quote?.provider) : [])]);
}

/** 已存快照优先；旧记录只按自身记录的渠道ID查type，不下发ID/name或当前模型目录。 */
export async function logsWithSourceVendors(rows) {
  const pending = [], out = rows.map((row) => {
    const audit = json(row.detail, {});
    const stored = row.source_vendors ?? audit?.source_vendors;
    const billing = row.billing_details ?? audit?.billing_details;
    const sources = stored != null ? sourceVendors(json(stored, [])) : billingSourceVendors(billing);
    const result = { ...row, source_vendors: sources };
    if (stored == null && !sources.length && Number(row.channel_id) > 0) pending.push(result);
    return result;
  });
  const ids = [...new Set(pending.map((row) => Number(row.channel_id)))];
  if (ids.length) {
    const [channels] = await pool.query(`SELECT id, type FROM channels WHERE id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => [[]]);
    const vendors = new Map(channels.map((c) => [Number(c.id), sourceVendors([c.type])]));
    for (const row of pending) row.source_vendors = vendors.get(Number(row.channel_id)) || [];
  }
  return out;
}
