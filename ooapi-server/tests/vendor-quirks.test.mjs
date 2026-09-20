// 厂商协议特化测试（vendor-quirks）
// ---------------------------------------------------------------------------
// 为什么必须测：这些特化处理是「静默失效」的高发区 ——
// 一旦 MiniMax 的 reasoning_split 没注入，思维链会混进正文；
// 一旦方舟的 model_fallback 没读，计费会按错误档位算。
// 两者都**不会报错**，页面也正常，只有对着实际数据看才发现。
import assert from "node:assert/strict";

const { applyVendorRequest, vendorKindOf, guessVendorFromUrl, effectiveModelOf, reasoningDeltaOf, splitThinkTags } =
  await import("../src/services/upstream/vendor-quirks.js");

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

/* ---------------- 厂商识别 ---------------- */
await t("按渠道类型识别厂商", async () => {
  assert.equal(vendorKindOf({ type: "minimax" }), "minimax");
  assert.equal(vendorKindOf({ type: "stepfun" }), "stepfun");
  assert.equal(vendorKindOf({ type: "mimo" }), "mimo");
  // 豆包的 API 方式就是火山方舟
  assert.equal(vendorKindOf({ type: "ark" }), "ark");
  assert.equal(vendorKindOf({ type: "doubao" }), "ark");
  // 不认识的类型返回空（不做任何注入）
  assert.equal(vendorKindOf({ type: "openai" }), "");
  assert.equal(vendorKindOf({}), "");
  assert.equal(vendorKindOf(null), "");
});

await t("自定义渠道按 base_url 兜底识别", async () => {
  assert.equal(guessVendorFromUrl("https://api.minimax.cn/v1"), "minimax");
  assert.equal(guessVendorFromUrl("https://api.minimax.io/v1"), "minimax");
  assert.equal(guessVendorFromUrl("https://ark.cn-beijing.volces.com/api/v3"), "ark");
  assert.equal(guessVendorFromUrl("https://api.stepfun.com/v1"), "stepfun");
  assert.equal(guessVendorFromUrl("https://api.xiaomimimo.com/v1"), "mimo");
  assert.equal(guessVendorFromUrl("https://api.openai.com/v1"), "");
  // custom 类型走 URL 识别
  assert.equal(vendorKindOf({ type: "custom", base_url: "https://api.stepfun.com/v1" }), "stepfun");
});

/* ---------------- 请求注入 ---------------- */
await t("MiniMax：强制开启 reasoning_split（否则思维链混进正文）", async () => {
  const body = { model: "MiniMax-M3", messages: [] };
  applyVendorRequest(body, { channel: { type: "minimax" }, model: "MiniMax-M3" });
  assert.equal(body.reasoning_split, true, "reasoning_split 必须为 true");
});

await t("MiniMax：temperature 越界被裁剪（上游对越界直接报错）", async () => {
  const high = { temperature: 5 };
  applyVendorRequest(high, { channel: { type: "minimax" }, model: "MiniMax-M3" });
  assert.equal(high.temperature, 2, "上界裁到 2");
  const low = { temperature: -3 };
  applyVendorRequest(low, { channel: { type: "minimax" }, model: "MiniMax-M3" });
  assert.equal(low.temperature, 0, "下界裁到 0");
  const ok = { temperature: 0.7 };
  applyVendorRequest(ok, { channel: { type: "minimax" }, model: "MiniMax-M3" });
  assert.equal(ok.temperature, 0.7, "合法值不动");
});

await t("MiniMax：被官方忽略的参数被移除", async () => {
  const body = { presence_penalty: 1, frequency_penalty: 1, logit_bias: {}, messages: [] };
  applyVendorRequest(body, { channel: { type: "minimax" }, model: "MiniMax-M3" });
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.frequency_penalty, undefined);
  assert.equal(body.logit_bias, undefined);
});

await t("StepFun：2603 档的 medium 被改成 high（上游只收 low/high）", async () => {
  const body = { reasoning_effort: "medium" };
  applyVendorRequest(body, { channel: { type: "stepfun" }, model: "step-3.5-flash-2603" });
  assert.equal(body.reasoning_effort, "high");
  // 其它模型不动
  const other = { reasoning_effort: "medium" };
  applyVendorRequest(other, { channel: { type: "stepfun" }, model: "step-3.7-flash" });
  assert.equal(other.reasoning_effort, "medium");
});

await t("StepFun：无 tools 时剥离 tool_choice（官方未文档化）", async () => {
  const body = { tool_choice: "auto" };
  applyVendorRequest(body, { channel: { type: "stepfun" }, model: "step-3.7-flash" });
  assert.equal(body.tool_choice, undefined, "无 tools 时应剥离");
  // 有 tools 时保留（用户显式要工具调用，不能擅自删）
  const withTools = { tool_choice: "auto", tools: [{ type: "function" }] };
  applyVendorRequest(withTools, { channel: { type: "stepfun" }, model: "step-3.7-flash" });
  assert.equal(withTools.tool_choice, "auto", "有 tools 时保留");
});

await t("方舟：thinking 布尔值转成官方的 {type} 格式", async () => {
  const on = { thinking: true };
  applyVendorRequest(on, { channel: { type: "ark" }, model: "doubao-seed-2-1-pro" });
  assert.deepEqual(on.thinking, { type: "enabled" });
  const off = { thinking: false };
  applyVendorRequest(off, { channel: { type: "ark" }, model: "doubao-seed-2-1-pro" });
  assert.deepEqual(off.thinking, { type: "disabled" });
  // 已经是对象形态的不动（可能来自渠道声明）
  const obj = { thinking: { type: "enabled" } };
  applyVendorRequest(obj, { channel: { type: "ark" }, model: "doubao-seed-2-1-pro" });
  assert.deepEqual(obj.thinking, { type: "enabled" });
});

await t("方舟：max_completion_tokens 与 max_tokens 互斥（同时传会 400）", async () => {
  const body = { max_tokens: 1000, max_completion_tokens: 2000 };
  applyVendorRequest(body, { channel: { type: "ark" }, model: "doubao-seed-2-1-pro" });
  assert.equal(body.max_tokens, undefined, "应删掉 max_tokens，保留 max_completion_tokens");
  assert.equal(body.max_completion_tokens, 2000);
});

await t("不认识的厂商不做任何改动（原样返回）", async () => {
  const body = { model: "gpt-5", temperature: 5, presence_penalty: 1, tool_choice: "auto" };
  const snapshot = JSON.stringify(body);
  applyVendorRequest(body, { channel: { type: "openai" }, model: "gpt-5" });
  assert.equal(JSON.stringify(body), snapshot, "不该动 OpenAI 渠道的请求体");
});

/* ---------------- 响应处理 ---------------- */
await t("方舟：读取实际生效模型（自动降级时计费按它算）", async () => {
  const fallback = {
    model: "doubao-seed-2-0-lite",
    service_status: { model_fallback: { fallback_triggered: true, original_model: "doubao-seed-2-1-pro" } },
  };
  assert.equal(effectiveModelOf(fallback), "doubao-seed-2-0-lite", "降级时应返回实际跑的模型");
  // 没降级：返回空串（调用方沿用请求的 model）
  assert.equal(effectiveModelOf({ model: "doubao-seed-2-1-pro", service_status: {} }), "");
  assert.equal(effectiveModelOf({ model: "x", service_status: { model_fallback: { fallback_triggered: false } } }), "");
  assert.equal(effectiveModelOf(null), "");
  assert.equal(effectiveModelOf("junk"), "");
});

await t("MiniMax：reasoning_details 数组被拼接成思维链", async () => {
  assert.equal(reasoningDeltaOf({ reasoning_details: [{ text: "a" }, { text: "b" }] }), "ab");
  assert.equal(reasoningDeltaOf({ reasoning_details: ["x", "y"] }), "xy");
  assert.equal(reasoningDeltaOf({ reasoning_details: "plain" }), "plain");
  assert.equal(reasoningDeltaOf({}), "");
  assert.equal(reasoningDeltaOf(null), "");
});

await t("剥离正文里的 think 标签（兜底，防止思考内容被当正文展示）", async () => {
  // 用拼接而不是字面量：这些标签必须原样进到被测字符串里
  const O = "<" + "think" + ">";
  const C = "<" + "/" + "think" + ">";
  const a = splitThinkTags(`${O}思考中…${C}末尾`);
  assert.equal(a.content, "末尾");
  assert.equal(a.reasoning, "思考中…");
  // 未闭合的开标签：后面全算思考（宁可不显示也不当成正文）
  const b = splitThinkTags(`正文开头${O}思考没结束`);
  assert.equal(b.content, "正文开头");
  assert.equal(b.reasoning, "思考没结束");
  // 无标签时原样返回
  const c = splitThinkTags("普通正文");
  assert.equal(c.content, "普通正文");
  assert.equal(c.reasoning, "");
  // 多段
  const d = splitThinkTags(`A${O}一${C}B${O}二${C}C`);
  assert.equal(d.content, "ABC");
  assert.equal(d.reasoning, "一二");
  // 空输入
  assert.deepEqual(splitThinkTags(""), { content: "", reasoning: "" });
});

/* ---------------- 模型注册表 ---------------- */
await t("四家新厂商的模型模块可加载且不含已下线模型", async () => {
  const mimo = await import("../src/services/upstream/mimo-models.js");
  const minimax = await import("../src/services/upstream/minimax-models.js");
  const stepfun = await import("../src/services/upstream/stepfun-models.js");
  const ark = await import("../src/services/upstream/ark-models.js");

  assert.ok(mimo.REAL_MODELS.length >= 2, "MiMo 至少 2 个模型");
  // MiMo 已下线（2026-06-30）的模型不能出现
  for (const dead of ["mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash", "mimo-v2-tts"]) {
    assert.ok(!mimo.CHANNEL_MODELS.includes(dead), `不应登记已下线的 ${dead}`);
  }
  assert.ok(minimax.CHANNEL_MODELS.includes("MiniMax-M3"));
  // StepFun 已下线（2026-07-08）的模型不能出现
  for (const dead of ["step-1-8k", "step-1-32k", "step-2-mini", "step-2-16k"]) {
    assert.ok(!stepfun.CHANNEL_MODELS.includes(dead), `不应登记已下线的 ${dead}`);
  }
  assert.ok(ark.CHANNEL_MODELS.includes("doubao-seed-2-1-pro"));
});

await t("MiMo / MiniMax 支持大小写不敏感与别名解析", async () => {
  const minimax = await import("../src/services/upstream/minimax-models.js");
  // 用户常填全小写
  assert.equal(minimax.resolveModel("minimax-m3").model, "MiniMax-M3");
  assert.equal(minimax.resolveModel("MINIMAX-M2.7").model, "MiniMax-M2.7");
  assert.equal(minimax.resolveModel("minimax").model, "MiniMax-M2.7");

  const ark = await import("../src/services/upstream/ark-models.js");
  // 带日期后缀的快照名归一到无后缀名（否则每个快照都要单独配价）
  assert.equal(ark.resolveModel("doubao-seed-2-1-pro-260628").model, "doubao-seed-2-1-pro");
  assert.equal(ark.resolveModel("doubao-pro").model, "doubao-seed-2-0-pro");

  const stepfun = await import("../src/services/upstream/stepfun-models.js");
  // 已下线的 step-3 映射到官方建议的迁移目标
  assert.equal(stepfun.resolveModel("step-3").model, "step-3.7-flash");
});

await t("新厂商的定价已录入且写了官方来源", async () => {
  const { DEFAULT_PRICES } = await import("../src/services/pricing.js");
  const byModel = new Map(DEFAULT_PRICES.map((p) => [p.model, p]));
  const mustHave = [
    "mimo-v2.5-pro",
    "mimo-v2.5",
    "MiniMax-M3",
    "MiniMax-M2.7",
    "step-5-preview",
    "step-3.5-flash",
    "doubao-seed-2-1-pro",
    "doubao-seed-2-0-lite",
  ];
  for (const m of mustHave) {
    const p = byModel.get(m);
    assert.ok(p, `${m} 缺定价`);
    assert.ok(p.input > 0 && p.output > 0, `${m} 价格应为正数`);
    assert.ok(/来源/.test(p.remark || ""), `${m} 的 remark 必须写官方来源（规范要求）`);
  }
  // 每个厂商登记表里的模型都要有价（否则会走兜底价并打告警）
  const mods = {
    mimo: await import("../src/services/upstream/mimo-models.js"),
    minimax: await import("../src/services/upstream/minimax-models.js"),
    stepfun: await import("../src/services/upstream/stepfun-models.js"),
    ark: await import("../src/services/upstream/ark-models.js"),
  };
  for (const [vendor, mod] of Object.entries(mods)) {
    for (const m of mod.REAL_MODELS) {
      assert.ok(byModel.has(m.id), `${vendor} 的模型 ${m.id} 未录入定价`);
    }
  }
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
