// 渠道额度自动刷新
// ===========================================================================
// 用户要求（原话）：
//   「deepseek 的 api 渠道的实际余额显示呢？opencode 如果是 go 渠道的额度条呢？都没做啊？」
//
// 问题不在「能不能查」（两条链路的接口都探通了，fetchQuota 手动点一下就有数据），
// 而在**没人去点**：额度快照只在管理员手动点「查额度」时才写入 channels.quota，
// 于是渠道列表的额度列对 deepseek-api / opencode-go 这类额度型渠道永远是空的 ——
// 看起来就像「没做」。
//
// 为什么不并进 autotest（渠道定时检测）：两者的语义与代价完全不同 ——
//   · 检测是「发一条真 prompt 验证渠道能不能干活」，会消耗上游额度、可能很慢（浏览器渠道上百秒）；
//   · 查额度是「读一个只读接口拿数字」，几百毫秒、不消耗额度。
// 合在一起会让额度被慢探针拖住（实测 GLM 那种渠道一轮要 10s+），
// 而且检测失败与查额度失败的原因、处理方式都不一样（前者要冷却渠道，后者只记日志）。
//
// 节奏：默认 30 分钟一轮。额度是「天级变化」的信息，30 分钟足够新鲜，也不会给上游添压力。
// 只刷**声明支持额度查询**的渠道（quotaSupportFor），其余渠道连请求都不发。
// 失败只记日志：额度查询失败 ≠ 渠道坏了，绝不能写 last_error 或冷却渠道
//（否则一次额度接口抖动就会让好渠道从调度里消失）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { rowToChannel } from "./router.js";
import { fetchQuota, quotaSupportFor, clampQuotaPayload } from "./upstream/quota.js";

// 渠道间隔：单轮里逐个刷，彼此留点空隙，避免整点同时打一堆上游接口
const CHANNEL_GAP_MS = 800;
const DEFAULT_INTERVAL_SEC = 1800;

/** 一轮：把所有支持额度查询的启用渠道刷一遍 */
export async function refreshAllQuotas() {
  // 只取启用中的渠道：停用的渠道刷了也没人看，还可能因为凭据失效反复报错。
  // （不在 SQL 里按 type 过滤：支持额度查询的判定是「type + method + base_url」三者组合，
  //  逻辑全在 quotaSupportFor 里，SQL 里再写一份条件必然会与它漂移。）
  const [rows] = await pool.query("SELECT * FROM channels WHERE status = 1");
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const channel = rowToChannel(row);
    const support = quotaSupportFor(channel);
    if (!support.supported) {
      skipped += 1;
      continue;
    }
    try {
      const quota = await fetchQuota(channel);
      await pool.query("UPDATE channels SET quota = ?, quota_time = ? WHERE id = ?", [
        clampQuotaPayload(quota),
        now(),
        row.id,
      ]);
      ok += 1;
    } catch (e) {
      // 只记日志：额度查询失败不代表渠道不可用（见文件头注释）
      failed += 1;
      console.warn(`[quota] #${row.id}「${row.name}」额度刷新失败：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, CHANNEL_GAP_MS));
  }
  if (ok || failed) {
    console.log(`[quota] 额度刷新完成：成功 ${ok} 个、失败 ${failed} 个、跳过 ${skipped} 个（不支持额度接口）`);
  }
  return { ok, failed, skipped };
}

let running = false;

export function scheduleQuotaRefresh() {
  const run = async () => {
    // 单轮可能较慢（渠道多时逐个串行）：不排队重复跑，避免叠加打上游
    if (running) return;
    running = true;
    try {
      await refreshAllQuotas();
    } catch (e) {
      console.error("[quota] 额度刷新任务失败：", e.message);
    } finally {
      running = false;
    }
  };
  // 启动后延迟 20s 跑第一轮：避开启动高峰（那时有建表、补列、迁移一堆事），
  // 也避免刚部署就把所有上游接口打一遍。
  setTimeout(run, 20_000).unref?.();
  const timer = setInterval(run, DEFAULT_INTERVAL_SEC * 1000);
  timer.unref?.();
  console.log(`[quota] 渠道额度自动刷新已启用（每 ${DEFAULT_INTERVAL_SEC / 60} 分钟一轮）`);
}
