// 渠道并发闸门（withChannelLimit）的并发正确性测试
// ---------------------------------------------------------------------------
// 为什么需要单独测：这个函数出过两次同类问题，而**静态检查与普通单测都发现不了**——
//   ① 旧实现用 `gate.then(() => run())` 且 run 内 await 整个任务，
//      导致 concurrency 配成 8 也严格串行（参数是空操作）；
//   ② 修成信号量后，名额是在「等完 min_gap」之后才 ++ 的，
//      于是 min_gap 窗口内到达的请求全部看到 inflight=0 而放行，
//      concurrency=2 实测被突破到 5，且它们在同一毫秒齐发（正是要避免的脚本特征）。
// 这里用真实计时验证「并发上限真的成立」与「排队真的生效」。
import assert from "node:assert/strict";

// 用真实的 router.js（不 mock），通过 rateOf 读取渠道 other 里的 concurrency
const { withChannelLimit } = await import("../src/services/router.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

/** 造一个渠道：id 唯一，避免不同用例互相共享运行时状态 */
let nextId = 90000;
function mkChannel(other = {}) {
  nextId += 1;
  return { id: nextId, name: `t${nextId}`, type: "openai", other };
}

/** 跑 N 个任务，跟踪真实同时在跑的数量峰值 */
async function measure(channel, n, taskMs = 120) {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: n }, () =>
    withChannelLimit(channel, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, taskMs));
      running -= 1;
      return running;
    })
  );
  await Promise.all(tasks);
  return peak;
}

console.log("并发上限");

await t("concurrency=2 时，真实同时在跑的数量不超过 2（含 min_gap 窗口）", async () => {
  // other.min_gap_ms 保持默认（1200ms）——旧实现正是栽在这个窗口里：
  // 名额在等完 min_gap 之后才占，窗口内到达的请求全部放行
  const ch = mkChannel({ concurrency: 2 });
  const peak = await measure(ch, 6, 100);
  assert.ok(peak <= 2, `并发峰值应 <= 2，实际 ${peak}（闸门被突破）`);
});

await t("concurrency=1（默认）时严格串行", async () => {
  const ch = mkChannel({});
  const peak = await measure(ch, 4, 60);
  assert.equal(peak, 1, `串行渠道的并发峰值应为 1，实际 ${peak}`);
});

await t("concurrency=4 时峰值不超过 4", async () => {
  const ch = mkChannel({ concurrency: 4, min_gap_ms: 0 });
  const peak = await measure(ch, 10, 80);
  assert.ok(peak <= 4, `并发峰值应 <= 4，实际 ${peak}`);
});

await t("min_gap_ms=0 且 concurrency=1 仍然串行", async () => {
  const ch = mkChannel({ min_gap_ms: 0 });
  const peak = await measure(ch, 5, 40);
  assert.equal(peak, 1, `应为 1，实际 ${peak}`);
});

console.log("\n任务结果与异常传播");

await t("任务抛错不会泄漏名额（后续请求仍能执行）", async () => {
  const ch = mkChannel({ concurrency: 2, min_gap_ms: 0 });
  let ranAfter = false;
  await Promise.allSettled([
    withChannelLimit(ch, async () => {
      throw new Error("boom");
    }),
    withChannelLimit(ch, async () => {
      throw new Error("boom2");
    }),
  ]);
  await withChannelLimit(ch, async () => {
    ranAfter = true;
  });
  assert.equal(ranAfter, true, "异常后名额应已释放");
});

await t("任务的 rejection 会传给调用方（不是被吞掉）", async () => {
  const ch = mkChannel({ concurrency: 2, min_gap_ms: 0 });
  const results = await Promise.allSettled([
    withChannelLimit(ch, async () => {
      throw Object.assign(new Error("expected"), { code: "CHANNEL_TIMEOUT" });
    }),
    withChannelLimit(ch, async () => "ok"),
  ]);
  assert.equal(results[0].status, "rejected", "第一个应被拒绝");
  assert.equal(results[0].reason.code, "CHANNEL_TIMEOUT", "错误码应保留");
  assert.equal(results[1].status, "fulfilled", "第二个应成功");
});

await t("任务返回值能正确回传（含 resolve(run()) 的 thenable 决议）", async () => {
  const ch = mkChannel({ concurrency: 3, min_gap_ms: 0 });
  const out = await Promise.all([
    withChannelLimit(ch, async () => 1),
    withChannelLimit(ch, async () => 2),
    withChannelLimit(ch, async () => 3),
  ]);
  assert.deepEqual(out.sort(), [1, 2, 3]);
});

console.log("\n吞吐与延迟");

await t("concurrency>1 时总耗时明显短于串行（证明并发真的生效）", async () => {
  const taskMs = 200;
  const n = 4;
  const par = mkChannel({ concurrency: 4, min_gap_ms: 0 });
  const t0 = Date.now();
  await measure(par, n, taskMs);
  const parallelMs = Date.now() - t0;

  const seq = mkChannel({ concurrency: 1, min_gap_ms: 0 });
  const t1 = Date.now();
  await measure(seq, n, taskMs);
  const serialMs = Date.now() - t1;

  assert.ok(
    parallelMs < serialMs * 0.75,
    `并发(${parallelMs}ms)应显著快于串行(${serialMs}ms)——若相近说明并发参数是空操作`
  );
});

await t("concurrency=1 且设了 min_gap 时，相邻两次提交有间隔", async () => {
  const gap = 150;
  const ch = mkChannel({ min_gap_ms: gap });
  const stamps = [];
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withChannelLimit(ch, async () => {
        stamps.push(Date.now());
      })
    )
  );
  stamps.sort((a, b) => a - b);
  assert.ok(stamps.length === 3, "三个任务都应执行");
  const d1 = stamps[1] - stamps[0];
  const d2 = stamps[2] - stamps[1];
  assert.ok(d1 >= gap * 0.5, `第一次间隔应接近 ${gap}ms，实际 ${d1}ms`);
  assert.ok(d2 >= gap * 0.5, `第二次间隔应接近 ${gap}ms，实际 ${d2}ms`);
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
