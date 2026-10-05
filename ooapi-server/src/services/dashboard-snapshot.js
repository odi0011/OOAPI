import { pool } from "../db.js";

/** 同秒落库、延迟提交都不能改变同一看板响应的分项；所有统计共享 InnoDB 读视图。 */
export async function withDashboardSnapshot(read, database = pool) {
  const connection = await database.getConnection();
  let started = false, discard = false;
  try {
    // SET TRANSACTION 只影响下一次事务，不修改连接池中长期复用的会话配置。
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    started = true;
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const data = await read((sql, args = []) => connection.query(sql, args));
    await connection.commit();
    started = false;
    return data;
  } catch (error) {
    if (started) {
      try { await connection.rollback(); }
      catch { discard = true; } // 无法确认事务结束的连接不能回到池中，且不能覆盖原始错误。
    }
    if (discard) connection.destroy();
    throw error;
  } finally {
    if (!discard) connection.release();
  }
}
