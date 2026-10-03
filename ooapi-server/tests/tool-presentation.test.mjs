import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_PRESENTATIONS, toolPresentation } from "../src/services/harness/tool-presentation.js";
import { nativeToolSpecs, toolSpecs } from "../src/services/harness/tools.js";
import { requestApproval, decideApproval } from "../src/services/harness/approvals.js";

test("所有工具与操作都有两组足够丰富的文案，但不扩大模型可填参数", () => {
  for (const [id, config] of Object.entries(TOOL_PRESENTATIONS)) {
    for (const p of [config, ...Object.values(config.methods || {})]) {
      for (const key of ["inquiryPhrases", "capsulePhrases"]) {
        assert.ok(p[key].length >= 10, id + key);
        assert.equal(new Set(p[key]).size, p[key].length);
      }
    }
    assert.equal(toolSpecs([id])[0].presentation, config);
    const native = JSON.stringify(nativeToolSpecs([id]));
    assert.ok(!native.includes("inquiryPhrases") && !native.includes("capsulePhrases"));
  }
});

test("询问预览与实际操作的别名、范围、默认值和截断一致", () => {
  assert.deepEqual(toolPresentation("account", { action: "balance" }), toolPresentation("account", { action: "overview" }));
  for (const action of ["recent", "logs", "history"]) {
    assert.equal(toolPresentation("account", { action, limit: 90 }).fields[0].value, "最近 30 条调用");
    assert.equal(toolPresentation("account", { action, limit: -1 }).fields[0].value, "最近 1 条调用");
    assert.equal(toolPresentation("account", { action }).fields[0].value, "最近 10 条调用");
  }
  assert.equal(toolPresentation("account", { action: "usage" }).fields[0].value, "最近 7 天");
  assert.equal(toolPresentation("github", { repo: "sample/project" }).fields[2].value, "README");
  assert.equal(toolPresentation("github", { action: "list" }).fields[2].value, "仓库根目录");
  assert.equal(toolPresentation("search", { query: "词".repeat(500) }).fields[0].value.length, 300);
  assert.equal(toolPresentation("binance", { action: "positions" }).fields[0].value, "你启用的全部账户");
  assert.equal(toolPresentation("binance", { action: "accounts" }).fields[0].value, "你配置的全部账户");
  assert.equal(toolPresentation("task", { prompt: "任务" }).fields[1].value, "任务");
  assert.equal(toolPresentation("todowrite", { todos: [{ content: "核对", status: "completed" }] }).fields[1].value, "已完成 · 核对");
  for (const input of [undefined, null, [], "usage"]) assert.ok(toolPresentation("account", input).title);
});

test("展示元数据不改变审批绑定、一次性、身份检查或拒绝结果", async () => {
  const run = { userId: 7 }, events = [], args = { action: "usage" };
  const result = requestApproval(run, { tool: "account", name: "我的账号", args }, { emit: e => events.push(e) });
  const p = events[0].part;
  assert.deepEqual(p.args, args);
  assert.equal(p.presentation.title, "整理用量统计");
  args.action = "recent";
  assert.equal(p.args.action, "usage");
  assert.equal(decideApproval(run, 8, p.id, "approved"), false);
  assert.equal(decideApproval(run, 7, p.id, "denied"), true);
  assert.equal(await result, false);
  assert.equal(decideApproval(run, 7, p.id, "approved"), false);
  assert.equal(events.at(-1).patch.status, "denied");
});
