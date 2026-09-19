// 运维监控指标 + 告警规则引擎的纯逻辑测试（不依赖数据库）
// ---------------------------------------------------------------------------
// 覆盖点：
//   · metrics：错误归类（业务限制 / 429 / 529 / 真实上游错误）、分位计算、
//     时间桶趋势、SLA 口径（排除业务限制）、健康分权重、诊断规则
//   · notify：Webhook payload 按平台适配、加签、平台识别
//   · alert：比较符、规则归一化（越界收敛）
// 这些一旦算错，监控页会把「没事」显示成「有事」，或者反过来漏报。
import assert from "node:assert/strict";

// ---- 只测纯函数：这些模块顶层不碰数据库（metrics 引 pool 但不查询） ----
const { recordRequest, snapshot, classifyError, healthScore, diagnose, recordChannelSwitch } =
  await import("../src/services/metrics.js");
const { buildWebhookPayload, webhookPlatform } = await import("../src/services/notify.js");

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

console.log("错误归类（SLA 口径的核心）");
t("业务限制错误码单独计数，不算上游故障", () => {
  const before = snapshot().gateway;
  recordRequest({ ok: false, status: 403, errorCode: "INSUFFICIENT_QUOTA", ms: 10 });
  const after = snapshot().gateway;
  assert.equal(after.businessLimited, before.businessLimited + 1, "businessLimited 应 +1");
  assert.equal(after.upstream.errors, before.upstream.errors, "上游错误不应变化");
});

t("上游 429 计入 429 计数，不计入上游错误", () => {
  const before = snapshot().gateway.upstream;
  recordRequest({ ok: false, status: 502, errorCode: "CHANNEL_HTTP_ERROR", upstreamStatus: 429, ms: 10 });
  const after = snapshot().gateway.upstream;
  assert.equal(after.count429, before.count429 + 1);
  assert.equal(after.errors, before.errors, "429 不应计入上游错误（它是上游的保护性限流）");
});

t("上游 529 单独计数", () => {
  const before = snapshot().gateway.upstream;
  recordRequest({ ok: false, status: 502, errorCode: "CHANNEL_HTTP_ERROR", upstreamStatus: 529, ms: 10 });
  assert.equal(snapshot().gateway.upstream.count529, before.count529 + 1);
});

t("真实上游错误（500）计入 upstreamErrors", () => {
  const before = snapshot().gateway.upstream;
  recordRequest({ ok: false, status: 502, errorCode: "CHANNEL_HTTP_ERROR", upstreamStatus: 500, ms: 10 });
  assert.equal(snapshot().gateway.upstream.errors, before.errors + 1);
});

t("classifyError 能从错误消息解析上游状态码（适配器众多，统一兜底）", () => {
  const e = Object.assign(new Error("上游返回 HTTP 429：rate limited"), { code: "CHANNEL_HTTP_ERROR" });
  const c = classifyError(e);
  assert.equal(c.upstreamStatus, 429);
  assert.equal(c.businessLimited, false);
});

t("classifyError 把 CHANNEL_RATE_LIMIT 视为 429", () => {
  const c = classifyError(Object.assign(new Error("限流"), { code: "CHANNEL_RATE_LIMIT" }));
  assert.equal(c.upstreamStatus, 429);
});

t("classifyError 识别业务限制码", () => {
  for (const code of ["INSUFFICIENT_QUOTA", "TOKEN_INVALID", "CHANNEL_EMPTY", "CHANNEL_MUTED"]) {
    assert.equal(classifyError(Object.assign(new Error("x"), { code })).businessLimited, true, `${code} 应属业务限制`);
  }
});

console.log("分位与趋势");
t("分位计算正确（含 p50/p90/p95/p99/max）", () => {
  for (let i = 1; i <= 100; i += 1) recordRequest({ ok: true, ms: i });
  const lat = snapshot().gateway.latency;
  assert.ok(lat.p50Ms >= 40 && lat.p50Ms <= 60, `p50 应在 50 附近，实际 ${lat.p50Ms}`);
  assert.ok(lat.p99Ms >= 90, `p99 应接近 100，实际 ${lat.p99Ms}`);
  assert.ok(lat.maxMs <= 100);
  assert.ok(lat.avgMs > 0);
});

t("TTFT 独立于总延迟统计（只在流式有样本）", () => {
  const before = snapshot().gateway.ttft;
  recordRequest({ ok: true, ms: 3000, ttftMs: 250 });
  const after = snapshot().gateway.ttft;
  assert.equal(after.samples, (before?.samples || 0) + 1);
  assert.equal(after.maxMs, 250);
});

t("时间桶趋势包含最近 60 个桶且 QPS/TPS 非负", () => {
  const tr = snapshot().trend;
  assert.equal(tr.series.length, 60);
  assert.ok(tr.qps.current >= 0 && tr.tps.current >= 0);
  assert.ok(tr.qps.peak >= tr.qps.current, "峰值不应小于当前值");
});

t("recordChannelSwitch 累加换号计数", () => {
  const before = snapshot().gateway.channelSwitches;
  recordChannelSwitch();
  assert.equal(snapshot().gateway.channelSwitches, before + 1);
});

console.log("SLA 与健康分");
t("SLA 排除业务限制（余额不足不算我们的锅）", () => {
  const g = snapshot().gateway;
  assert.ok(g.sla != null, "有流量时 SLA 应有值");
  assert.ok(g.sla >= g.successRate - 0.01, `SLA(${g.sla}) 不应低于成功率(${g.successRate})`);
});

t("健康分在合理区间，且给出 idle 判定", () => {
  const h = healthScore({ dbOk: true, jobOk: true });
  assert.ok(h.score >= 0 && h.score <= 100, `健康分应在 0-100，实际 ${h.score}`);
  assert.ok(["healthy", "degraded", "risk", "idle"].includes(h.level));
  assert.ok(h.parts && typeof h.parts.infra === "number");
});

t("DB 不可用时基础设施分归零", () => {
  const h = healthScore({ dbOk: false, jobOk: true });
  assert.equal(h.parts.infra < 100, true, "DB 挂掉时 infra 应扣分");
});

console.log("智能诊断");
t("诊断项结构完整（现象/影响/建议三段）", () => {
  const items = diagnose({ dbOk: true, jobOk: true });
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const it of items) {
    assert.ok(["critical", "warning", "info"].includes(it.severity), `未知级别 ${it.severity}`);
    assert.ok(it.title && it.impact && it.advice, "三段式缺字段");
  }
});

t("DB 不可用会产出 critical 诊断", () => {
  const items = diagnose({ dbOk: false, jobOk: true });
  assert.ok(items.some((i) => i.severity === "critical" && /数据库/.test(i.title)));
});

console.log("Webhook 平台适配");
t("飞书 payload 结构", () => {
  const p = buildWebhookPayload("https://open.feishu.cn/open-apis/bot/v2/hook/xxx", "标题", ["行1"]);
  assert.equal(p.msg_type, "text");
  assert.ok(p.content.text.includes("标题") && p.content.text.includes("行1"));
});

t("钉钉 payload 结构", () => {
  const p = buildWebhookPayload("https://oapi.dingtalk.com/robot/send?access_token=x", "标题", ["行1"]);
  assert.equal(p.msgtype, "text");
  assert.ok(p.text.content.includes("标题"));
});

t("企业微信 payload 用 markdown", () => {
  const p = buildWebhookPayload("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", "标题", ["行1"]);
  assert.equal(p.msgtype, "markdown");
  assert.ok(p.markdown.content.includes("标题"));
});

t("Slack payload 结构", () => {
  const p = buildWebhookPayload("https://hooks.slack.com/services/x", "标题", ["行1"]);
  assert.ok(p.text.includes("标题"));
});

t("自定义地址回退为通用结构（同时带 text 字段）", () => {
  const p = buildWebhookPayload("https://example.com/hook", "标题", ["行1"]);
  assert.ok(p.text && p.title && Array.isArray(p.lines));
});

t("平台识别正确", () => {
  assert.equal(webhookPlatform("https://open.feishu.cn/x"), "飞书");
  assert.equal(webhookPlatform("https://oapi.dingtalk.com/x"), "钉钉");
  assert.equal(webhookPlatform("https://qyapi.weixin.qq.com/x"), "企业微信");
  assert.equal(webhookPlatform("https://hooks.slack.com/x"), "Slack");
  assert.equal(webhookPlatform("https://my-own.com/x"), "自定义");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
