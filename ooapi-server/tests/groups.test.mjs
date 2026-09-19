// 分组绑定值的解析与归一化回归测试
// ---------------------------------------------------------------------------
// 背景（第 36 批审查发现的真实缺陷，均为「厂商降级为可选筛选」改造引入）：
//   ① 前端把绑定值拼成 `${type}:${name}`，而 /token/groups 已把 type 改成分组名
//      → 实际写入 "vip:vip"。路由恰好还能工作（parseGroupKey 会剥前缀），
//      但**改名/删组时匹配不上** → Key 保留死绑定 → 永久 503。
//   ② 日志与接口原样下发绑定值 → 同一分组在记录里出现 "vip" / "vip:vip" / "openai:vip"
//      三种标签，前端按分组聚合就对不上。
//   ③ 分组名含冒号（"a:b"）会被误剥前缀，解析成别的分组。
//
// 这个测试锁死：新格式（纯名字）与旧格式（厂商:名字）都能正确解析，
// 且 `default` 一律归为「无分组」。
import assert from "node:assert/strict";

const { parseGroupKey, displayGroupName, applyGroupRate } = await import("../src/services/group-rate.js");

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

console.log("解析绑定值（parseGroupKey）");

t("新格式：纯分组名", () => {
  assert.deepEqual(parseGroupKey("vip"), { name: "vip" });
});

t("旧格式：厂商:分组名 → 剥掉厂商前缀", () => {
  assert.deepEqual(parseGroupKey("openai:vip"), { name: "vip" });
  assert.deepEqual(parseGroupKey("glm:便宜档"), { name: "便宜档" });
});

t("空值 / default 一律视为「无分组」", () => {
  assert.equal(parseGroupKey(""), null);
  assert.equal(parseGroupKey(null), null);
  assert.equal(parseGroupKey(undefined), null);
  assert.equal(parseGroupKey("default"), null);
  assert.equal(parseGroupKey("openai:default"), null, "带前缀的 default 也要归为无分组");
});

t("冒号在末尾（\"vip:\"）不会被误剥成空", () => {
  // idx === length-1 时不剥前缀：整串作为分组名
  assert.deepEqual(parseGroupKey("vip:"), { name: "vip:" });
});

t("首尾空白被裁剪", () => {
  assert.deepEqual(parseGroupKey("  vip  "), { name: "vip" });
});

console.log("\n展示用归一化（displayGroupName）");

t("三种历史形态归一到同一个名字（避免日志里出现多个标签）", () => {
  const a = displayGroupName("vip");
  const b = displayGroupName("openai:vip");
  const c = displayGroupName("vip:vip");
  assert.equal(a, "vip");
  assert.equal(b, "vip");
  assert.equal(c, "vip", "vip:vip 是历史 bug 产物，也必须归一到 vip");
  assert.equal(a, b);
  assert.equal(b, c);
});

t("无分组时返回空串（不是 default）", () => {
  assert.equal(displayGroupName(""), "");
  assert.equal(displayGroupName("default"), "");
  assert.equal(displayGroupName(null), "");
});

console.log("\n倍率应用");

t("rate=1 原样返回", () => {
  assert.equal(applyGroupRate(1000, 1), 1000);
});

t("倍率按乘法换算，且至少有 1 单位（不产生 0 元白嫖）", () => {
  assert.equal(applyGroupRate(1000, 2), 2000);
  assert.equal(applyGroupRate(1, 0.0001), 1, "极小倍率也要保底 1 单位");
});

t("无倍率/异常值按 1 处理", () => {
  assert.equal(applyGroupRate(500, null), 500);
  assert.equal(applyGroupRate(500, 0), 500, "0 不是有效倍率，按 1 处理");
});

console.log("\n跨厂商分组语义（名称匹配不受厂商影响）");

t("同一分组名对不同厂商的渠道都可匹配（channelInGroup 已去掉厂商前缀强制）", async () => {
  const { channelInGroup } = await import("../src/services/router.js");
  const openaiCh = { id: 1, type: "openai", groups: ["vip"] };
  const glmCh = { id: 2, type: "glm", groups: ["vip"] };
  // 绑定值无论新格式还是旧格式（带任一厂商前缀），两个渠道都应命中
  for (const binding of ["vip", "openai:vip", "glm:vip"]) {
    assert.equal(channelInGroup(openaiCh, binding), true, `${binding} 应命中 openai 渠道`);
    assert.equal(channelInGroup(glmCh, binding), true, `${binding} 应命中 glm 渠道`);
  }
});

t("不在分组里的渠道不匹配；未分组渠道只在「公共池」请求下可用", async () => {
  const { channelInGroup } = await import("../src/services/router.js");
  const outsider = { id: 3, type: "openai", groups: [] };
  assert.equal(channelInGroup(outsider, "vip"), false);
  assert.equal(channelInGroup(outsider, ""), true, "空 groupName = 公共池");
  assert.equal(channelInGroup(outsider, "default"), true, "历史 default = 公共池");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
