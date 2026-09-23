// 渠道定时检测：按渠道配置的间隔真实探针（默认发 "hi"），结果写入「最近调用」记录。
// 说明：
//   · 只有管理员显式打开 auto_test 的渠道才会被检测（默认关闭，避免刷上游额度）；
//   · 单进程串行 + 渠道间 1.5s 间隔，避免整点同时打上游；
//   · 成功重置冷却并更新响应时间；失败写 last_error 与红条，不自动禁用（保留人工决策）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { rowToChannel, getAdapter, recordChannelCall, resetChannelState, setChannelRateLimit } from "./router.js";
import { probeChannel } from "./channel-probe.js";
import { AUTO_PAUSE_CODES, isRateLimitedCode, rateLimitPauseSec } from "./router.js";

const CHECK_TICK_MS = 60_000;

async function runOne(row) {
  const channel = rowToChannel(row);
  const adapter = await getAdapter(channel).catch(() => null);
  if (!adapter) throw Object.assign(new Error("适配器不可用"), { code: "UNSUPPORTED_CHANNEL" });
  const prompt = String(row.test_prompt || "hi").trim() || "hi";
  return probeChannel(adapter, channel, prompt);
}

let running = false;

export async function runDueChannelTests() {
  // 单轮遍历可能超过一个 tick（渠道多/浏览器探针慢）：不排队重复跑，
  // 否则 last_test_time 还没更新，下一 tick 会重复探测同一渠道、重复消耗上游额度。
  if (running) return;
  running = true;
  try {
    const [rows] = await pool.query("SELECT * FROM channels WHERE auto_test = 1 AND status = 1");
    for (const row of rows) {
    const interval = Math.max(60, Number(row.auto_test_interval) || 3600);
    // 用「检测专用时间戳」判断到期：生产调用会更新 tested_time，不能用它，
    // 否则繁忙渠道的定时检测会被每次真实调用不断推迟（等于几乎不检测）
    const last = Math.max(Number(row.last_test_time) || 0, 0);
    if (last && Math.floor(Date.now() / 1000) - last < interval) continue;
    const t0 = Date.now();
    const prompt = String(row.test_prompt || "hi").trim() || "hi";
    try {
      const r = await runOne(row);
      // 与手动测试同口径：同时落总耗时与首 Token 耗时，小竖条按首 Token 着色
      await pool.query("UPDATE channels SET response_time = ?, ttft_ms = ?, tested_time = ?, last_error = '' WHERE id = ?", [
        r.ms,
        r.ttftMs || r.ms,
        now(),
        row.id,
      ]);
      await recordChannelCall(row.id, true, r.ttftMs || r.ms, "", {
        prompt,
        reply: r.reply,
        degraded: r.degraded,
        state: r.state,
        kind: "auto",
      });
      resetChannelState(row.id);
      console.log(`[autotest] #${row.id}「${row.name}」通过（首Token ${r.ttftMs || r.ms}ms / 总 ${r.ms}ms）`);
    } catch (e) {
      const ms = Date.now() - t0;
      // 自动检测失败同样按错误性质决定是否自动暂停（与手动测试、用户调用同一口径）：
      //   · 凭据失效/被封/配置错 → 停用（status=3，人工处理）；
      //   · 上游 429 限流 → 也停用，但带 `rate_limit_until`，到点自动恢复；
      //   · 网络抖动/超时 → 只记错误，不动状态。
      // 三重保护与 router.markChannelError 一致：错误码白名单 + auto_ban 开关 + 仅启用中。
      const ec = String(e.code || "");
      const fatal = AUTO_PAUSE_CODES.has(ec);
      const rateLimited = isRateLimitedCode(ec);
      const pause = (fatal || rateLimited) && row.auto_ban !== 0 && Number(row.status) === 1;
      const until = rateLimited ? now() + rateLimitPauseSec(e.cooldownSec) : 0;
      await pool.query(
        pause
          ? "UPDATE channels SET last_error = ?, last_error_code = ?, tested_time = ?, status = 3, rate_limit_until = ? WHERE id = ? AND status = 1"
          : "UPDATE channels SET last_error = ?, last_error_code = ?, tested_time = ? WHERE id = ?",
        pause
          ? [String(e.message).slice(0, 480), ec, now(), rateLimited ? until : 0, row.id]
          : [String(e.message).slice(0, 480), ec, now(), row.id]
      );
      // 429 不计入「最近调用」（与 router.markChannelError / 手动测试同一口径）：
      // 被限流挡回的请求根本没被处理，记进去只会把真实成功率的含义搞乱。
      if (!rateLimited) {
        await recordChannelCall(row.id, false, ms, e.message, { prompt, reply: e.message, kind: "auto" });
      }
      if (pause) {
        resetChannelState(row.id);
        // resetChannelState 会清掉限流标记，限流那条要在之后补回内存
        if (rateLimited) setChannelRateLimit(row.id, until);
      }
      console.warn(
        `[autotest] #${row.id}「${row.name}」失败${
          pause ? (rateLimited ? "（已因限流停用，到点自动恢复）" : "（已自动暂停）") : ""
        }：${e.message}`
      );
    }
    // 渠道之间留间隔，避免同一时刻并发打上游
    await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    running = false;
  }
}

export function scheduleChannelAutoTest() {
  const timer = setInterval(() => {
    runDueChannelTests().catch((e) => console.error("[autotest] 检测循环失败：", e.message));
  }, CHECK_TICK_MS);
  timer.unref?.();
  console.log("[autotest] 渠道定时检测已启用（每 60s 检查到期渠道）");
}
