// Cline 集成测试
// ===========================================================================
// 背景：用户要求「研究一下有没有 cline 这个厂商的反代方案，需要集成」。
//
// 调研结论（2026-09-23）：**Cline 官方就提供标准 OpenAI 兼容 API**，
// 所以正确做法是按普通 API Key 渠道接入，而不是做社区那种 cline2api 反代。
// 本文件锁住这个结论涉及的每一处实现。
//
// 为什么不做反代（记录下来，免得以后有人再问一遍）：
//   · 多余：官方既有标准 API、又有正式签发的 Key（app.cline.bot → Settings → API Keys）；
//   · 违规：其 ToS §2.2 禁止「以官方提供之外的技术手段访问」，§7.3 禁止共享订阅；
//   · 已被封堵：订阅档 `cline-pass/*` 直接 403 'only available via Cline product surfaces'。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`); }
};

/* ============ ① 厂商声明与适配器注册 ============ */
console.log("\n=== ① 厂商声明与适配器 ===");
{
  const { publicProviders, getMethod } = await import("../src/services/channel-types.js");
  const { getAdapter } = await import("../src/services/router.js");

  const p = publicProviders().find((x) => x.key === "cline");
  ck("厂商列表里有 Cline", Boolean(p), p ? p.name : "缺失");
  ck("厂商名是 Cline", p?.name === "Cline", String(p?.name));
  ck("有 keyUrl（获取 Key 的官方页面）", /app\.cline\.bot/.test(p?.keyUrl || ""), p?.keyUrl);

  const m = getMethod("cline", "api");
  ck("有 api 接入方式", Boolean(m));
  ck("baseUrl 指向官方 OpenAI 兼容端点",
    m?.baseUrl === "https://api.cline.bot/api/v1", String(m?.baseUrl));
  ck("声明了 adapter: cline（不是裸 openai-compat）",
    m?.adapter === "cline", String(m?.adapter));

  const adapter = await getAdapter({ type: "cline", other: { method: "api" } });
  ck("适配器可加载（不是 UNSUPPORTED_CHANNEL）", Boolean(adapter?.chat));
  ck("实现了 chat", typeof adapter?.chat === "function");
  ck("实现了 verify（健康检查）", typeof adapter?.verify === "function");
  ck("实现了 fetchUpstreamModels（拉模型清单）", typeof adapter?.fetchUpstreamModels === "function");
}

/* ============ ② 客户端标识头（上游对无标识的请求会 403） ============ */
console.log("\n=== ② 客户端标识头 ===");
{
  const a = await import("../src/services/upstream/cline.js");
  ck("导出 CLINE_HEADERS", Boolean(a.CLINE_HEADERS));
  ck("含 HTTP-Referer（官方统计头）", a.CLINE_HEADERS["HTTP-Referer"] === "https://cline.bot");
  ck("含 X-Title", Boolean(a.CLINE_HEADERS["X-Title"]));
  ck("含 X-CLIENT-TYPE", a.CLINE_HEADERS["X-CLIENT-TYPE"] === "cline-sdk");
  ck("含 X-IS-MULTIROOT", "X-IS-MULTIROOT" in a.CLINE_HEADERS);

  const decorated = a.withClineHeaders({ id: 1, other: {} });
  ck("withClineHeaders 把标识头放进 extra_headers",
    decorated.other.extra_headers["HTTP-Referer"] === "https://cline.bot");

  // 渠道自定义头必须能覆盖默认值（显式配置优先）
  const custom = a.withClineHeaders({ id: 1, other: { extra_headers: { "X-Title": "MyTool" } } });
  ck("渠道自定义头可覆盖默认值（显式优先）",
    custom.other.extra_headers["X-Title"] === "MyTool", custom.other.extra_headers["X-Title"]);

  // UA 可覆盖（Cline 用 UA 里的版本号做过校验）
  const withUa = a.withClineHeaders({ id: 1, other: { client_user_agent: "Cline/3.0.0" } });
  ck("渠道可指定 UA（上游会校验版本号）",
    withUa.other.extra_headers["user-agent"] === "Cline/3.0.0");

  // 不能重复设置 content-type / authorization（Fetch 会逗号拼接 → 必然 401）
  const ck2 = a.withClineHeaders({ id: 1, other: {} });
  ck("不重复设置 content-type", !("content-type" in ck2.other.extra_headers));
  ck("不重复设置 authorization", !("authorization" in ck2.other.extra_headers));
}

/* ============ ③ 响应包封解包 ============ */
console.log("\n=== ③ 响应包封（data envelope）解包 ===");
{
  const { unwrapEnvelope } = await import("../src/services/upstream/cline.js");

  const standard = { choices: [{ index: 0, delta: { content: "hi" } }] };
  ck("标准形状原样返回", unwrapEnvelope(standard) === standard);
  ck("标准形状不被误改", Array.isArray(unwrapEnvelope(standard).choices));

  const wrapped = { success: true, data: { choices: [{ index: 0, delta: { content: "hi" } }] } };
  const out = unwrapEnvelope(wrapped);
  ck("data 包封被解开", Array.isArray(out.choices) && out.choices[0].delta.content === "hi");

  const wrappedWithUsage = { data: { choices: [{}] }, usage: { total_tokens: 5 } };
  ck("外层 usage 在解包后保留（部分实现把它放外层）",
    unwrapEnvelope(wrappedWithUsage).usage?.total_tokens === 5);

  ck("null 安全", unwrapEnvelope(null) === null);
  ck("无 choices 也无 data 时原样返回",
    unwrapEnvelope({ error: "x" }).error === "x");

  // openai-compat 必须真的调用这个钩子（否则适配器传了也没用）
  const compat = readFileSync(new URL("../src/services/upstream/openai-compat.js", import.meta.url), "utf8");
  ck("chat() 接收 unwrap 选项", /signal,\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*unwrap,/.test(compat) || /\bunwrap,\n\}\) \{/.test(compat));
  ck("SSE 解析里套用 unwrap（解包后再读 choices）",
    /if \(unwrap\) ev = unwrap\(ev\) \|\| ev;/.test(compat));
  ck("unwrap 未传时零影响（条件调用）", /if \(unwrap\)/.test(compat));
}

/* ============ ④ 模型 id 与定价门禁的配合 ============ */
console.log("\n=== ④ 模型 id 与「未定价不放行」门禁 ===");
{
  const { getMethod } = await import("../src/services/channel-types.js");
  const { DEFAULT_PRICES } = await import("../src/services/pricing.js");
  const m = getMethod("cline", "api");
  const ids = (m.defaultModels || []).map((x) => x.id);
  ck("登记了默认模型", ids.length >= 5, String(ids.length));
  ck("模型 id 是 vendor/model 形式（与官方一致）",
    ids.every((i) => i.includes("/")), JSON.stringify(ids.slice(0, 3)));

  // 复刻 isModelPriced 的判定（剥前缀 + 精确/最长前缀命中）
  const priced = new Set(DEFAULT_PRICES.map((p) => String(p.model).toLowerCase()));
  const isPriced = (model) => {
    const t = String(model || "").toLowerCase();
    const stripped = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
    if (priced.has(t) || priced.has(stripped)) return true;
    for (const k of [t, stripped]) for (const p of priced) if (k.startsWith(p)) return true;
    return false;
  };
  const unpriced = ids.filter((i) => !isPriced(i));
  ck("全部默认模型都能通过定价门禁（否则加完渠道立刻不可用）",
    unpriced.length === 0, unpriced.join(", "));
  ck("testModel 也在已定价之列（否则「测试」按钮直接失败）",
    isPriced(m.testModel), String(m.testModel));

  // 剥离 vendor/ 前缀这件事本身要有断言 —— 它是上面能通过的原因
  ck("getPrice 会剥离 vendor/ 前缀（Cline/OpenRouter 共用这套 id 规则）",
    /const slash = m\.lastIndexOf\("\/"\)/.test(readFileSync(new URL("../src/services/pricing.js", import.meta.url), "utf8")));
}

/* ============ ⑤ 集成方式的选择（记录结论，防止回退成反代） ============ */
console.log("\n=== ⑤ 接入方式是官方 API 而非反代 ===");
{
  const src = readFileSync(new URL("../src/services/upstream/cline.js", import.meta.url), "utf8");
  ck("适配器注释说明了「为什么不做反代」", /为什么不做社区那种 cline2api 反代/.test(src));
  ck("说明了 ToS 依据（§2.2 / §7.3）", /ToS/.test(src) && /§2\.2|§7\.3/.test(src));
  ck("提到了订阅档已被封堵（cline-pass 403）", /cline-pass/.test(src));
  ck("没有实现任何伪造客户端/设备指纹逻辑",
    !/fingerprint|attestation|device_?id/i.test(src));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
