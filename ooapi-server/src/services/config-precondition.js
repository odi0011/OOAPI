import { isDeepStrictEqual } from "node:util";

export const PRICE_FIELDS = ["model", "input_price", "output_price", "cache_price", "channel_type", "remark", "offpeak_input_price", "offpeak_output_price", "offpeak_cache_price", "offpeak_rule"];
export function priceSnapshot(row) {
  if (!row) return null;
  return Object.fromEntries(PRICE_FIELDS.map(key => {
    let value = row[key];
    if (key.endsWith("_price")) value = value == null || value === "" ? (key.startsWith("offpeak_") ? null : 0) : Number(value);
    else if (key === "offpeak_rule") { if (typeof value === "string" && value) { try { value = JSON.parse(value); } catch { /* 保留旧规则供原接口校验 */ } } value ||= null; }
    else value = String(value ?? "");
    return [key, value];
  }));
}
export function settingSnapshot(value) {
  if (typeof value === "string") { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
const changed = () => Object.assign(new Error("原配置已变化，本次没有写入；请读取最新值并重新确认。"), { code: "CONFIG_CHANGED", status: 409 });

// 与普通界面写入使用同一行锁：核对快照与 UPDATE/INSERT 必须留在同一事务中。
// 不存在的价格行也由 InnoDB 的唯一索引间隙锁保护；并发插入若死锁会回滚，不能覆盖。
export async function withConfigPrecondition(db, kind, id, expected, write) {
  if (expected === undefined) return write(db);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(kind === "pricing" ? "SELECT * FROM model_prices WHERE model = ? FOR UPDATE" : "SELECT setting FROM users WHERE id = ? FOR UPDATE", [id]);
    const actual = kind === "pricing" ? priceSnapshot(rows[0]) : rows[0] ? settingSnapshot(rows[0].setting) : null;
    if (!isDeepStrictEqual(actual, expected)) throw changed();
    const result = await write(connection);
    await connection.commit();
    return result;
  } catch (e) { await connection.rollback(); throw e; }
  finally { connection.release(); }
}
