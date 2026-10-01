// 「有花费但 token 显示 0/0」回归锁（线上实测：对话（部分）记录 收了费、token 列为 0）
// 根因：计费走逐调用（calls），日志写的是调用方传入的汇总 tokens —— 两套算法在
// 「失败轮没有可见正文」时分叉（调用方不会估算，逐调用会按失败步的长上下文估算）。
// 修复：日志一律取 sumCallTokens(calls)（与计费同一口径），见 routes/chat.js chargeUser。
import { sumCallTokens, splitTokens } from "../src/services/pricing.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(root, "src", "routes", "chat.js"), "utf8");

let pass = 0;
let fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

console.log("=== sumCallTokens：与逐调用计费同一口径 ===");
{
  // 场景（线上事故原样）：整轮无成功调用，失败步带长 prompt、无正文
  const calls = [{ prompt: "x".repeat(1600), output: "", usage: null, tokens: null }];
  const t = sumCallTokens(calls);
  ck("失败步的 prompt 按字符估算（>0，与计费一致）", t.promptTokens > 0, JSON.stringify(t));
  ck("没有正文 → completion 为 0", t.completionTokens === 0);

  // 场景：成功步有精确 usage + 失败步估算
  const mixed = [
    { prompt: "", output: "", usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { prompt: "y".repeat(800), output: "答".repeat(40), usage: null },
  ];
  const t2 = sumCallTokens(mixed);
  const perCall = mixed.map((c) => splitTokens({ prompt: c.prompt, output: c.output, upstreamTotal: c.usage }));
  ck("混合场景 = 逐调用之和", t2.promptTokens === perCall.reduce((n, x) => n + x.promptTokens, 0), JSON.stringify(t2));
  ck("cache 一并汇总", t2.cacheTokens === 0);

  // 空入参
  ck("空数组 → 0/0/0", JSON.stringify(sumCallTokens([])) === JSON.stringify({ promptTokens: 0, completionTokens: 0, cacheTokens: 0 }));
  ck("null 项不炸", sumCallTokens([null, undefined]).promptTokens === 0);
}

console.log("\n=== chargeUser 的展示口径必须取自计费口径（源码锚点）===");
{
  // ① 解构必须是 let（calls 分支要重写）
  ck("chargeUser 的 token 解构是 let", /let \{ promptTokens, completionTokens, cacheTokens \} =\s*\n?\s*tokens \|\| splitTokens/.test(chat));
  // ② calls 分支里必须用 sumCallTokens 重写展示值
  ck("calls 分支用 sumCallTokens 对齐展示口径", /const billed = sumCallTokens\(calls\);/.test(chat));
  ck("重写了 promptTokens/completionTokens/cacheTokens", /promptTokens = billed\.promptTokens;[\s\S]*?completionTokens = billed\.completionTokens;[\s\S]*?cacheTokens = billed\.cacheTokens;/.test(chat));
  // ③ writeLog 的 detail 与列仍然写这三个变量（没有改成别的来源）
  ck("writeLog 仍写 prompt_tokens/completion_tokens 列", /prompt_tokens: promptTokens,[\s\S]*?completion_tokens: completionTokens,/.test(chat));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await import("./log-text.test.mjs");
process.exit(fail ? 1 : 0);
