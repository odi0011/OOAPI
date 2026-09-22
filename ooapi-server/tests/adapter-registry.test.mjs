// 适配器注册一致性（静态检查）
// ---------------------------------------------------------------------------
// 抓的是这样一类 bug：channel-types 里给某个接入方式声明了 `adapter: "xxx"`，
// 但 router.js 的 ADAPTERS 表里没有 "xxx" —— 于是 adapterKeyFor 解析出的 key
// 查不到，getAdapter 抛 UNSUPPORTED_CHANNEL，**渠道一建就报「适配器不可用」**。
//
// 这类漏注册一次都没在构建期暴露（构建通过、语法正确），只在用户建渠道时才炸。
// 实测抓到 4 个：mimo-web / minimax-web / stepfun-web / grok。
import { PROVIDERS } from "../src/services/channel-types.js";
import { isSupportedType, supportedTypes } from "../src/services/router.js";

let pass = 0;
let fail = 0;
const ck = (n, c, e = "") => {
  if (c) { pass += 1; console.log(`  ok   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n} ${e}`); }
};

console.log("=== 每个声明的 adapter 都已注册 ===");
const declared = new Map(); // adapter → [来源描述]
for (const p of PROVIDERS) {
  for (const m of p.methods || []) {
    if (!m.adapter) continue;
    const list = declared.get(m.adapter) || [];
    list.push(`${p.key}/${m.key}`);
    declared.set(m.adapter, list);
  }
}
ck(`共声明 ${declared.size} 个 adapter`, declared.size > 0);
for (const [adapter, from] of [...declared.entries()].sort()) {
  ck(`adapter "${adapter}" 已注册（来自 ${from.join(", ")}）`, isSupportedType(adapter));
}

console.log("\n=== 反向检查：注册表里没有拼写接近但不同的键 ===");
// 例如声明 "grok" 而表里是 "grok-oauth" —— 大小写/连字符差异最容易被漏掉
const types = supportedTypes();
const near = [];
for (const a of declared.keys()) {
  if (types.includes(a)) continue;
  for (const t of types) {
    // 去掉连字符后相等 → 就是这种"看起来对"的拼写差异
    if (t.replace(/-/g, "") === a.replace(/-/g, "")) near.push(`${a} ↔ ${t}`);
  }
}
ck("没有仅差连字符的近似键", near.length === 0, near.join(", "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
