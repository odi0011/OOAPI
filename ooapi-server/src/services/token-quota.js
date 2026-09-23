// 令牌（API Key）额度预占
// ---------------------------------------------------------------------------
// 修的问题（黑盒测试实测）：`remain_quota=1` 的 Key **并发 20 次全部通过**。
//
// 原实现的鉴权只在入口检查 `remain_quota > 0`，而扣减发生在请求**结束**的结算里，
// 中间没有任何预占 —— 同一瞬间到达的 N 个请求看到的是同一个非零余额，全部放行。
// 账户侧的 user.quota 是原子扣的（没少收钱），但「这把 Key 的预算上限」
// 在并发下形同虚设：并发度越高、能超出的倍数越大。
//
// 做法：入口处**原子预占** 1 个单位 —— 判定与扣减在同一条 SQL 里
//（`WHERE remain_quota >= 1`），并发下只有一个能成功，其余立刻拿到 ok=false。
// 结算时把它加回去再扣实际用量（净效果 = 只扣实际用量）；
// 若这一单没走到结算（上游失败且无任何产出），则退回。
//
// 为什么预占 1 个单位、而不是预估这一单的花费：真实花费要等上游返回 usage 才知道，
// 请求前只能按 max_tokens × 单价猜 —— 猜大了会误拒正常请求（用户最烦的那种），
// 猜小了照样能被绕过。1 个单位的作用是让**并发的每个请求各自占一个位**，
// 把「N 个请求共享一次检查」变成「N 个请求各自独占一次检查」——
// 这正是原缺陷的根因，也正是它能修好的原因。
import { pool } from "../db.js";

export const TOKEN_QUOTA_HOLD = 1;

const NOOP = {
  ok: true,
  amount: 0,
  consume() {},
  refund() {},
};

/**
 * 原子预占令牌额度。
 * @returns {{ok: boolean, amount: number, consume: () => void, refund: () => void}}
 *   ok=false 表示额度不足（调用方应拒绝请求）；
 *   consume() 在结算已计入本次 hold 后调用，阻止兜底退回；
 *   refund() 幂等，在「没走到结算」的路径上退回预占。
 */
export async function holdTokenQuota(token) {
  // 不限额度的 Key 没有阀门可守；额度为 0 的情况鉴权处已经拦掉
  if (!token || !token.id || token.unlimited_quota) return NOOP;
  const amt = TOKEN_QUOTA_HOLD;
  const [ret] = await pool.query(
    "UPDATE tokens SET remain_quota = remain_quota - ? WHERE id = ? AND unlimited_quota = 0 AND remain_quota >= ?",
    [amt, token.id, amt]
  );
  if (!ret.affectedRows) return { ...NOOP, ok: false };
  // 只允许「退回」或「被结算消费」其中之一生效，否则额度会凭空变多：
  // 结算路径自己做了 `remain_quota + hold - units`，此时再退一次 hold 就是双重加回。
  let settledOrRefunded = false;
  return {
    ok: true,
    amount: amt,
    // 结算已把 hold 计入（加回后再扣实际用量）→ 兜底退回必须让路
    consume() {
      settledOrRefunded = true;
    },
    refund() {
      if (settledOrRefunded) return;
      settledOrRefunded = true;
      pool
        .query("UPDATE tokens SET remain_quota = remain_quota + ? WHERE id = ? AND unlimited_quota = 0", [amt, token.id])
        .catch((e) => console.error("[token-quota] 预占额度退回失败：", e.message));
    },
  };
}
