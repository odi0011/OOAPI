// 模型定价覆盖测试：新接入的档位不得静默落到兜底价。
// ===========================================================================
// 背景（AI协作.md：「新模型定价待补录」）：
//   模型没有单独定价时会走兜底链 —— 同族 → 同厂商最贵档 → 全表最贵档。
//   这条链是「宁可高估不可漏收」的有意设计，但对**中低端档位**代价很大：
//   glm-4-flash 这类免费档落到旗舰价就是无限倍误差，用户投诉「同样一句话贵了几十倍」。
//
// 这里锁三件事：
//   ① doc 里点名的那批模型（Codex / Grok）必须精确命中；
//   ② 聚合渠道的 `vendor/model` 前缀要能剥掉后命中（OpenRouter 风格）；
//   ③ 上一代/轻量档也要有价，不能靠兜底。
//
// 用 DEFAULT_PRICES 真实数据构建 Map 并复刻 getPrice 的匹配顺序 ——
// 不连数据库（单测环境没有 MySQL），匹配逻辑本身在 pricing 里另有实现。
import { DEFAULT_PRICES } from "../src/services/pricing.js";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

const prices = new Map(DEFAULT_PRICES.map((p) => [String(p.model).toLowerCase(), p]));

/** 复刻 getPrice 的匹配顺序（剥前缀 → 精确 → 最长前缀） */
function resolve(model) {
  let m = String(model).toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash > 0 && slash < m.length - 1) m = m.slice(slash + 1);
  if (prices.has(m)) return { how: "exact", model: m };
  let best = null;
  let bestLen = -1;
  for (const [k, v] of prices) {
    if (k.length > bestLen && m.startsWith(k)) { best = v; bestLen = k.length; }
  }
  if (best) return { how: "prefix", model: best.model, price: best };
  return null;
}

/* ============ ① doc 点名的模型 ============ */
console.log("\n=== ① 协作文档点名的待补录模型 ===");
{
  // Codex / OpenAI 新档
  for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "codex-auto-review"]) {
    const r = resolve(id);
    ck(`${id} 有精确价（不再走兜底）`, r?.how === "exact", JSON.stringify(r));
  }
  // Grok 系列
  for (const id of ["grok-4.6", "grok-4.5", "grok-4.3", "grok-3-mini"]) {
    const r = resolve(id);
    ck(`${id} 有精确价`, r?.how === "exact", JSON.stringify(r));
  }
}

/* ============ ② 聚合渠道的 vendor/ 前缀 ============ */
console.log("\n=== ② 聚合渠道前缀（OpenRouter / NIM 风格）===");
{
  const cases = [
    ["zai-org/GLM-4.6", "glm-4.6"],
    ["anthropic/claude-sonnet-4.5", "claude-sonnet-4.5"],
    ["openai/gpt-5.5", "gpt-5.5"],
    ["google/gemini-2.5-pro", "gemini-2.5-pro"],
    ["deepseek/deepseek-chat", "deepseek-chat"],
    ["deepseek-ai/DeepSeek-V3.2", "deepseek-v3.2"],
    ["Qwen/Qwen3-235B-A22B", "qwen3-235b-a22b"],
  ];
  for (const [req, expect] of cases) {
    const r = resolve(req);
    ck(`${req} → ${expect}`, r?.how === "exact" && r.model === expect, JSON.stringify(r));
  }
  // 源码层面确实剥了前缀（上面那些断言依赖它）
  const src = (await import("node:fs")).readFileSync(
    new URL("../src/services/pricing.js", import.meta.url), "utf8"
  );
  ck("getPrice 内剥离最后一段 `/` 前缀", /const slash = m\.lastIndexOf\("\/"\)/.test(src));
}

/* ============ ③ 轻量/上一代档位必须有价 ============ */
console.log("\n=== ③ 轻量档与上一代档（兜底会按旗舰价收）===");
{
  const must = [
    "glm-4-flash", "glm-4-flashx", "glm-4-air", "glm-4", "glm-4-plus",
    "glm-4.6", "glm-5", "glm-5.1", "glm-5v", "glm-4v", "glm-4.6v",
    "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-latest", "kimi-thinking",
    "qwen-max", "qwen-max-latest", "qwen-turbo", "qwen-flash", "qwen3.7-max",
    "gemini-3.8-flash", "gemini-2.5-flash-lite",
    "claude-sonnet-4.5", "claude-opus-4.5",
    "deepseek-v4.1-flash", "mimo-v2.6-pro", "longcat-2.0",
  ];
  for (const id of must) {
    const r = resolve(id);
    ck(`${id} 有价`, r?.how === "exact", JSON.stringify(r));
  }

  // glm-4-flash 是免费档：价格必须真是 0，不能靠兜底（兜底会收旗舰价）
  const free = prices.get("glm-4-flash");
  ck("glm-4-flash 是免费档（input/output 都为 0）",
    Number(free?.input) === 0 && Number(free?.output) === 0, JSON.stringify(free));

  // 每个新增条目都必须写明官方来源（规范要求）
  const newOnes = ["qwen-max", "qwen-turbo", "gemini-3.8-flash", "claude-sonnet-4.5", "glm-4", "moonshot-v1-8k", "deepseek-v3.2"];
  for (const id of newOnes) {
    ck(`${id} 的 remark 写明来源`, /来源|官方/.test(String(prices.get(id)?.remark || "")), String(prices.get(id)?.remark || "").slice(0, 50));
  }
}

/* ============ ④ 价格表健全性 ============ */
console.log("\n=== ④ 价格表健全性 ===");
{
  const ids = DEFAULT_PRICES.map((p) => String(p.model).toLowerCase());
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  ck("没有重复的模型条目", dup.length === 0, dup.join(","));
  const bad = DEFAULT_PRICES.filter((p) => !(Number(p.input) >= 0) || !(Number(p.output) >= 0));
  ck("所有价格都是非负数字", bad.length === 0, JSON.stringify(bad.map((b) => b.model)));
  const noType = DEFAULT_PRICES.filter((p) => !String(p.type || "").trim());
  ck("所有条目都有 type（兜底链按厂商分组要用）", noType.length === 0, JSON.stringify(noType.map((p) => p.model)));
  // 覆盖度：注册表里只剩厂商占位名（glm/qwen/kimi 这类）允许走兜底
  ck("价格表条目数 >= 90", DEFAULT_PRICES.length >= 90, String(DEFAULT_PRICES.length));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
