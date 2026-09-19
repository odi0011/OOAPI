// 峰谷计费逻辑单元测试（不依赖 DB）
import * as m from "../src/services/pricing.js";

const rule = { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]] };
const t = (iso) => Date.parse(iso);
const cases = [
  ["2026-09-21T10:00:00+08:00", true, "周一 10:00 北京 = 高峰"],
  ["2026-09-21T12:30:00+08:00", false, "周一 12:30 北京 = 闲时"],
  ["2026-09-21T15:00:00+08:00", true, "周一 15:00 北京 = 高峰"],
  ["2026-09-21T20:00:00+08:00", false, "周一 20:00 北京 = 闲时"],
  ["2026-09-26T10:00:00+08:00", false, "周六 10:00 北京 = 闲时（周末全闲）"],
  ["2026-09-21T01:00:00+08:00", false, "周一 01:00 北京 = 闲时"],
];
let bad = 0;
for (const [iso, want, label] of cases) {
  const got = m.isPeakAt(rule, t(iso));
  if (got !== want) {
    bad++;
    console.log("FAIL", label, "got", got);
  } else {
    console.log("OK  ", label);
  }
}

// 跨零点窗口（阿里百炼：每天 22:00-08:00 为闲时 → 这里把 22:00-08:00 当「高峰」表达以便测跨天分支）
const rule2 = { offset: 8, days: [1, 2, 3, 4, 5, 6, 7], peak: [["22:00", "08:00"]] };
const cross = [
  ["2026-09-21T23:00:00+08:00", true, "跨零点 23:00 命中"],
  ["2026-09-21T07:00:00+08:00", true, "跨零点 07:00 命中"],
  ["2026-09-21T12:00:00+08:00", false, "跨零点 12:00 不命中"],
];
for (const [iso, want, label] of cross) {
  const got = m.isPeakAt(rule2, t(iso));
  if (got !== want) {
    bad++;
    console.log("FAIL", label, "got", got);
  } else {
    console.log("OK  ", label);
  }
}

// effectivePrice：不得污染缓存里的同一对象
const p = {
  input: 0.3, output: 1.2, cache: 0.006,
  offpeakInput: 0.15, offpeakOutput: 0.6, offpeakCache: 0.003,
  offpeakRule: rule,
};
const off = m.effectivePrice(p, t("2026-09-21T20:00:00+08:00"));
const peak = m.effectivePrice(p, t("2026-09-21T10:00:00+08:00"));
console.log("\n闲时价:", off.price.input, off.price.output, off.price.cache, "| phase =", off.phase);
console.log("峰时价:", peak.price.input, peak.price.output, peak.price.cache, "| phase =", peak.phase);
const intact = p.input === 0.3 && p.output === 1.2 && p.cache === 0.006;
console.log("原对象未被污染:", intact ? "OK" : "FAIL");
if (!intact) bad++;
if (off.phase !== "offpeak" || peak.phase !== "peak") { bad++; console.log("FAIL phase 判定"); }

// 无闲时价 = flat（与改造前行为一致）
const flat = m.effectivePrice({ input: 1, output: 2, cache: 0 }, Date.now());
console.log("未配闲时价 → phase =", flat.phase, "(应为 flat)");
if (flat.phase !== "flat") bad++;

console.log("\n规则摘要:", m.describeRule(rule));
console.log(bad === 0 ? "ALL_CASES_PASS" : `HAS_FAILURES(${bad})`);
process.exit(bad === 0 ? 0 : 1);
