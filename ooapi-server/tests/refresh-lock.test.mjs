// 订阅渠道 token 刷新锁的回归测试
// ---------------------------------------------------------------------------
// 背景（真实线上事故）：withRefreshLock 的签名是 (channelId, fn, channel)，
// 但 6 个适配器（codex/claude/claude-oauth/antigravity/grok/kiro/openai-web）
// 全都误写成 (channel.id, channel, async () => {})——把 channel 当成了 fn。
//
// 后果不是你想象的那种「报错」，而是**静默失效**：
//   fn 收到对象 → 调用时抛 "fn is not a function" → 被调用方的 .catch() 吞掉
//   （日志只留一句「提前刷新失败，继续用现有 token」）→ token 过期后永远刷不回来
//   → 所有订阅渠道集体 401，从现象上完全看不出是参数顺序问题。
//
// 这个测试锁死两件事：
//   1. 参数顺序写错时必须**立刻抛错**（而不是静默变成 401）；
//   2. 推荐的 (channel, fn) 写法下，并发调用只真正执行一次刷新，
//      且所有调用方都拿到同一个结果（joiners 不会拿着旧 token 去打上游）。
import assert from "node:assert/strict";

// 只测纯逻辑：不连库（loadOther 在无 DB 时返回 null，不影响本测试关注的行为）
const { withRefreshLock } = await import("../src/services/upstream/auth-store.js");

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

let nextId = 50000;
const mkChannel = () => {
  nextId += 1;
  return { id: nextId, name: `ch${nextId}`, other: { access_token: "old-token" } };
};

console.log("参数顺序守卫（防止再次静默失效）");

await t("把 channel 当成 fn 传入时必须立刻抛 TypeError", async () => {
  const ch = mkChannel();
  // 这就是当初 6 个适配器的错误写法
  assert.throws(
    () => withRefreshLock(ch.id, ch, async () => {}),
    (e) => e instanceof TypeError && /第二个参数是 object/.test(e.message),
    "错误写法必须抛 TypeError，而不是静默变成 401"
  );
});

await t("fn 不是函数（无论哪种顺序）都抛错", async () => {
  const ch = mkChannel();
  assert.throws(() => withRefreshLock(ch.id, null), TypeError);
  assert.throws(() => withRefreshLock(ch, "not-a-fn"), TypeError);
});

console.log("\n推荐写法 (channel, fn)");

await t("正常执行并返回结果", async () => {
  const ch = mkChannel();
  const r = await withRefreshLock(ch, async () => ({ access_token: "new-token", expires_at: 123 }));
  assert.equal(r.access_token, "new-token");
});

await t("并发调用只真正执行一次刷新（避免同一 refresh_token 双刷）", async () => {
  const ch = mkChannel();
  let runs = 0;
  const slow = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 60));
    ch.other = { ...ch.other, access_token: "refreshed" };
    return { access_token: "refreshed" };
  };
  const [a, b, c] = await Promise.all([
    withRefreshLock(ch, slow),
    withRefreshLock(ch, slow),
    withRefreshLock(ch, slow),
  ]);
  assert.equal(runs, 1, `刷新应只执行 1 次，实际 ${runs} 次`);
  assert.equal(a.access_token, "refreshed");
  assert.equal(b.access_token, "refreshed", "joiners 必须拿到同一个结果，否则会拿旧 token 撞 401");
  assert.equal(c.access_token, "refreshed");
});

await t("完成后锁被释放，下一次调用会重新执行", async () => {
  const ch = mkChannel();
  let runs = 0;
  const fn = async () => {
    runs += 1;
    return { access_token: `t${runs}` };
  };
  await withRefreshLock(ch, fn);
  await withRefreshLock(ch, fn);
  assert.equal(runs, 2, "锁必须在 finally 里释放，否则后续刷新永远被合并掉");
});

await t("刷新抛错时不吞异常，且锁被释放（下次能重试）", async () => {
  const ch = mkChannel();
  await assert.rejects(
    () => withRefreshLock(ch, async () => {
      throw new Error("refresh failed");
    }),
    /refresh failed/
  );
  const r = await withRefreshLock(ch, async () => ({ access_token: "recovered" }));
  assert.equal(r.access_token, "recovered", "失败后锁必须释放，否则该渠道永远刷不了");
});

console.log("\n兼容老写法 (channelId, fn, channel)");

await t("三参数写法仍可用（内部归一化）", async () => {
  const ch = mkChannel();
  const r = await withRefreshLock(ch.id, async () => ({ access_token: "legacy" }), ch);
  assert.equal(r.access_token, "legacy");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
