import assert from "node:assert/strict";
import test from "node:test";
import { callFingerprint } from "../src/services/harness/tool-call-guards.js";

test("同轮完全相同的账号查询只保留一次，不同参数仍保留", () => {
  const calls = [
    { id: "a", tool: "account", args: { action: "overview" } },
    { id: "b", tool: "account", args: { action: "overview" } },
    { id: "c", tool: "account", args: { action: "recent", limit: 5 } },
    { id: "d", tool: "account", args: { limit: 5, action: "recent" } },
  ];
  assert.deepEqual([...new Set(calls.map(callFingerprint))].length, 2);
  assert.equal(callFingerprint(calls[2]), callFingerprint(calls[3]));
});

test("不同工具不混淆，null 参数按空对象处理", () => {
  assert.notEqual(callFingerprint({ tool: "account", args: { action: "usage" } }), callFingerprint({ tool: "search", args: { action: "usage" } }));
  assert.equal(callFingerprint({ tool: "x", args: null }), callFingerprint({ tool: "x", args: {} }));
});
