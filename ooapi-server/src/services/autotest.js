// 渠道定时检测：按渠道配置的间隔真实探针（默认发 "hi"），结果写入「最近调用」记录。
// 说明：
//   · 只有管理员显式打开 auto_test 的渠道才会被检测（默认关闭，避免刷上游额度）；
//   · 单进程串行 + 渠道间 1.5s 间隔，避免整点同时打上游；
//   · 成功重置冷却并更新响应时间；失败写 last_error 与红条，不自动禁用（保留人工决策）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { rowToChannel, getAdapter, recordChannelCall, resetChannelState } from "./router.js";
import { probeChannel } from "./channel-probe.js";

const CHECK_TICK_MS = 60_000;

async function runOne(row) {
  const channel = rowToChannel(row);
  const adapter = await getAdapter(channel).catch(() => null);
  if (!adapter) throw Object.assign(new Error("适配器不可用"), { code: "UNSUPPORTED_CHANNEL" });
  const prompt = String(row.test_prompt || "hi").trim() || "hi";
  return probeChannel(adapter, channel, prompt);
}

export async function runDueChannelTests() {
  const [rows] = await pool.query("SELECT * FROM channels WHERE auto_test = 1 AND status = 1");
  for (const row of rows) {
    const interval = Math.max(60, Number(row.auto_test_interval) || 3600);
    const last = Number(row.tested_time) || 0;
    if (Math.floor(Date.now() / 1000) - last < interval) continue;
    const t0 = Date.now();
    const prompt = String(row.test_prompt || "hi").trim() || "hi";
    try {
      const r = await runOne(row);
      await pool.query("UPDATE channels SET response_time = ?, tested_time = ?, last_error = '' WHERE id = ?", [
        r.ms,
        now(),
        row.id,
      ]);
      await recordChannelCall(row.id, true, r.ms, "", {
        prompt,
        reply: r.reply,
        degraded: r.degraded,
        state: r.state,
      });
      resetChannelState(row.id);
      console.log(`[autotest] #${row.id}「${row.name}」通过（${r.ms}ms）`);
    } catch (e) {
      const ms = Date.now() - t0;
      await pool.query("UPDATE channels SET last_error = ?, tested_time = ? WHERE id = ?", [
        String(e.message).slice(0, 480),
        now(),
        row.id,
      ]);
      await recordChannelCall(row.id, false, ms, e.message, { prompt, reply: e.message });
      console.warn(`[autotest] #${row.id}「${row.name}」失败：${e.message}`);
    }
    // 渠道之间留间隔，避免同一时刻并发打上游
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export function scheduleChannelAutoTest() {
  const timer = setInterval(() => {
    runDueChannelTests().catch((e) => console.error("[autotest] 检测循环失败：", e.message));
  }, CHECK_TICK_MS);
  timer.unref?.();
  console.log("[autotest] 渠道定时检测已启用（每 60s 检查到期渠道）");
}
