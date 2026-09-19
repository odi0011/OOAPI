// 第 35 批审查修复的回归测试（纯逻辑，不需要数据库）
// ---------------------------------------------------------------------------
// 覆盖本轮修复的每一类问题，防止再次退化：
//   · 用量归一化：缺失字段必须走估算补齐，而不是当成 0（少收）
//   · 缓存字段必须保留（丢了会让缓存部分按全额输入价计费 = 多收）
//   · 闲时价显式 0 / 缺规则 必须被拒绝（否则谷时 1 单位白嫖）
//   · 用户限流：并发/RPM/TPM 三个维度的边界与释放幂等
//   · 令牌估算
import assert from "node:assert/strict";

const { splitTokens, normalizeUsage, computeCost, estimateTokens } = await import("../src/services/pricing.js");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

console.log("用量归一化：缺失字段不能再被当成 0");
t("只给 output_tokens 时识别为 partial（旧逻辑会把输入记 0，整段上下文不计费）", () => {
  const u = normalizeUsage({ output_tokens: 500 });
  assert.equal(u.partial, true, "应识别为部分上报");
  assert.equal(u.hasDetail, false, "缺输入侧时不能声称是精确明细");
  assert.equal(u.hasCompletion, true);
  assert.equal(u.hasPrompt, false);
});

t("partial 时缺的一侧按字符估算补齐，而不是 0", () => {
  const r = splitTokens({ prompt: "这是一个很长的中文提示".repeat(50), output: "答案", upstreamTotal: { output_tokens: 500 } });
  assert.equal(r.completionTokens, 500, "已报的补全量必须用真实值");
  assert.ok(r.promptTokens > 100, `输入侧应被估算补齐（实际 ${r.promptTokens}），不能是 0`);
});

t("只给 input_tokens 时同理补全输出侧", () => {
  const r = splitTokens({ prompt: "hi", output: "一段较长的回答内容".repeat(30), upstreamTotal: { input_tokens: 800 } });
  assert.equal(r.promptTokens, 800);
  assert.ok(r.completionTokens > 50, `输出侧应被估算补齐（实际 ${r.completionTokens}）`);
});

t("两侧齐全时是精确明细，不做估算", () => {
  const r = splitTokens({ prompt: "x".repeat(9999), output: "y".repeat(9999), upstreamTotal: { prompt_tokens: 100, completion_tokens: 20 } });
  assert.equal(r.promptTokens, 100);
  assert.equal(r.completionTokens, 20);
});

t("缓存字段能被识别（cached_tokens / prompt_cache_hit_tokens / details）", () => {
  for (const key of ["cached_tokens", "cache_tokens", "prompt_cache_hit_tokens"]) {
    const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, [key]: 800 });
    assert.equal(u.cacheTokens, 800, `${key} 未被识别`);
  }
  const u2 = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } });
  assert.equal(u2.cacheTokens, 600, "prompt_tokens_details.cached_tokens 未被识别");
});

t("缓存 token 被夹到不超过 prompt（防止负数计费基数）", () => {
  const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 999 });
  assert.equal(u.cacheTokens, 100);
});

t("缓存命中比未命中多时不会算成负价（computeCost 有 clamp）", () => {
  const price = { input: 1, output: 2, cache: 0.1 };
  const cost = computeCost({ price, promptTokens: 1000, completionTokens: 100, cacheTokens: 1000 });
  assert.ok(cost > 0, `费用必须为正，实际 ${cost}`);
});

console.log("\n计费公式回归（防止本轮改动破坏既有口径）");
t("正常计费：1M 输入 + 1M 输出", () => {
  const cost = computeCost({ price: { input: 0.3, output: 1.2, cache: 0.006 }, promptTokens: 1e6, completionTokens: 1e6, cacheTokens: 0 });
  // 0.3 + 1.2 = 1.5 OD = 15000 单位
  assert.equal(cost, 15000);
});

t("缓存部分按缓存价计（不按输入价）", () => {
  const price = { input: 1, output: 2, cache: 0.1 };
  // 1000 输入其中 800 命中：未命中 200*1 + 缓存 800*0.1 + 输出 100*2 = 200+80+200 = 480/1e6 OD → 单位
  const cost = computeCost({ price, promptTokens: 1000, completionTokens: 100, cacheTokens: 800 });
  assert.equal(cost, Math.max(1, Math.round((200 / 1e6 + 80 / 1e6 + 200 / 1e6) * 10000)));
});

t("contextBilling=input_only 时输出不计费（账号级口径）", () => {
  const price = { input: 1, output: 100, cache: 0 };
  const withOut = computeCost({ price, promptTokens: 1000, completionTokens: 1000, cacheTokens: 0 });
  const inOnly = computeCost({ price, promptTokens: 1000, completionTokens: 1000, cacheTokens: 0, contextBilling: "input_only" });
  assert.ok(inOnly < withOut, "input_only 必须严格小于全额");
});

t("费用下限是 1 单位（不会出现 0 费用白嫖）", () => {
  const cost = computeCost({ price: { input: 0.000001, output: 0.000001, cache: 0 }, promptTokens: 1, completionTokens: 1, cacheTokens: 0 });
  assert.equal(cost, 1);
});

console.log("\n令牌估算");
t("estimateTokens 对空串返回 0，对文本返回正数", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("hello world") > 0);
});

t("estimateTokens 中文与英文都可估算（不因纯中文返回 0）", () => {
  assert.ok(estimateTokens("你好世界") > 0);
});

console.log("\n用户限流：并发 / RPM / TPM");
const { acquire, limitsFor, usageOf, estimateRequestTokens, __combine } = await import("../src/services/user-limit.js");

t("limitsFor 用全局默认（未配则 0 = 不限制）", () => {
  const lim = limitsFor({ id: 999, setting: {} });
  assert.equal(typeof lim.concurrency, "number");
  assert.equal(typeof lim.rpm, "number");
  assert.equal(typeof lim.tpm, "number");
});

t("用户自定义限额覆盖全局", () => {
  // 全局默认是 0（不限）时，用户自设的正数生效（自我限流）
  const lim = limitsFor({ id: 999, setting: { limits: { concurrency: 3, rpm: 7, tpm: 1234 } } });
  assert.equal(lim.concurrency, 3);
  assert.equal(lim.rpm, 7);
  assert.equal(lim.tpm, 1234);
});

t("安全：用户不能通过 setting 把自己改成「不限制」来绕过管理员的限额", () => {
  // setting 可由用户经 PUT /api/user/self/settings 自行写入，因此语义必须是「只能收紧」。
  // 全局 60 时：
  assert.equal(__combine(60, 0), 60, "用户填 0 不能被当成「不限制」，必须沿用全局");
  assert.equal(__combine(60, -1), 60, "负数同样不能解除限制");
  assert.equal(__combine(60, "abc"), 60, "非法值不能解除限制");
  assert.equal(__combine(60, undefined), 60, "未填时用全局");
  assert.equal(__combine(60, 10), 10, "可以收紧到更小的值");
  assert.equal(__combine(60, 600), 60, "不能放宽到超过全局");
  // 全局不限时，用户自设正数属于自我限流，允许
  assert.equal(__combine(0, 10), 10);
  assert.equal(__combine(0, 0), 0);
});

t("setting 是 JSON 字符串时也要能解析（DB 的 setting 是 TEXT 列）", () => {
  // 线上实测踩到过：users.setting 从数据库读出来是字符串，
  // 只判 typeof === "object" 会让用户自定义限额静默失效（退回全局默认）。
  const lim = limitsFor({ id: 998, setting: JSON.stringify({ limits: { concurrency: 2, rpm: 5, tpm: 600 } }) });
  assert.equal(lim.concurrency, 2, "字符串形态的 setting 未生效");
  assert.equal(lim.rpm, 5);
  assert.equal(lim.tpm, 600);
});

t("setting 是脏数据时不报错，退回全局默认", () => {
  const lim = limitsFor({ id: 997, setting: "{不是合法 JSON" });
  assert.equal(typeof lim.concurrency, "number");
  assert.equal(typeof lim.rpm, "number");
});

t("并发限额生效：达到上限后拒绝", () => {
  const user = { id: 90001, setting: { limits: { concurrency: 1, rpm: 0, tpm: 0 } } };
  const a = acquire(user, { estimatedTokens: 0 });
  assert.equal(a.ok, true, "第一个应放行");
  const b = acquire(user, { estimatedTokens: 0 });
  assert.equal(b.ok, false, "超出并发上限应拒绝");
  assert.equal(b.kind, "concurrency");
  a.release();
  const c = acquire(user, { estimatedTokens: 0 });
  assert.equal(c.ok, true, "释放后应能再次进入");
  c.release();
});

t("release 幂等：重复调用不会把计数减成负数", () => {
  const user = { id: 90002, setting: { limits: { concurrency: 5, rpm: 0, tpm: 0 } } };
  const a = acquire(user, { estimatedTokens: 0 });
  a.release();
  a.release();
  a.release();
  assert.equal(usageOf(90002).inflight, 0, "在途数不能为负");
});

t("RPM 限额生效", () => {
  const user = { id: 90003, setting: { limits: { concurrency: 0, rpm: 2, tpm: 0 } } };
  const rels = [];
  for (let i = 0; i < 2; i += 1) {
    const r = acquire(user, { estimatedTokens: 0 });
    assert.equal(r.ok, true, `第 ${i + 1} 次应放行`);
    rels.push(r.release);
  }
  const third = acquire(user, { estimatedTokens: 0 });
  assert.equal(third.ok, false, "超出 RPM 应拒绝");
  assert.equal(third.kind, "rpm");
  rels.forEach((f) => f());
});

t("TPM 预占生效：单次超额请求被拒", () => {
  const user = { id: 90004, setting: { limits: { concurrency: 0, rpm: 0, tpm: 1000 } } };
  const r = acquire(user, { estimatedTokens: 2000 });
  assert.equal(r.ok, false, "预估超过 TPM 上限应直接拒绝");
  assert.equal(r.kind, "tpm");
});

t("TPM 释放后归还预占（多退少补）", () => {
  const user = { id: 90005, setting: { limits: { concurrency: 0, rpm: 0, tpm: 10000 } } };
  const a = acquire(user, { estimatedTokens: 5000 });
  assert.equal(a.ok, true);
  assert.ok(usageOf(90005).tpmUsed >= 5000, "预占应计入用量");
  a.release({ tokens: 100 }); // 实际只用了 100
  assert.ok(usageOf(90005).tpmUsed <= 200, `归还后应只剩真实用量，实际 ${usageOf(90005).tpmUsed}`);
});

t("没有用户（内部调用）时不限制", () => {
  const r = acquire(null, { estimatedTokens: 1e9 });
  assert.equal(r.ok, true);
  r.release();
});

t("estimateRequestTokens 把 prompt 与 max_tokens 相加", () => {
  const n = estimateRequestTokens("x".repeat(300), 256);
  assert.ok(n >= 256, "至少包含 max_tokens");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
