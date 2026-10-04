import * as toolPresentation from "../src/services/harness/tool-presentation.js";
import { callFingerprint } from "../src/services/harness/tool-call-guards.js";
import * as platformTools from "../src/services/harness/platform-tools.js";
import * as platformCatalog from "../src/services/harness/platform-catalog.js";
import * as toolWire from "../src/services/tool-wire.js";
import * as contextTools from "../src/services/harness/context.js";
import * as harnessRuntime from "../src/services/harness/runtime.js";
import { splitTokens } from "../src/services/pricing.js";
// 真实工具/对话循环，账户与上游均为内存fixture；不访问数据库、交易引擎或收费模型。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readBinanceAnalysis } from "../src/services/binance-analysis.js";
import { findAgent, buildSystemPrompt, SUBAGENTS } from "../src/services/harness/agents.js";

const stamp = Date.now();
const sentinel = "PRIVATE_BINANCE_FIXTURE_SENTINEL";
const accounts = [
  { id: 1, name: "demo-owned", environment: "demo", active: true, last_sync_at: new Date(stamp).toISOString(), api_key: sentinel },
  { id: 2, name: "testnet-owned", environment: "testnet", active: true, last_sync_at: new Date(stamp - 120000).toISOString(), secret_key: sentinel },
  { id: 3, name: "inactive-owned", environment: "live", active: false, last_sync_at: new Date(stamp).toISOString(), last_sync_error: sentinel },
];
const positions = [
  { id: 10, accountId: 1, symbol: "BTCUSDT", side: "LONG", quantity: 2, markPrice: 100, liquidationPrice: 90, pnl: 20, api_key: sentinel },
  { id: 20, accountId: 2, symbol: "ETHUSDT", side: "SHORT", quantity: 3, markPrice: 100, liquidationPrice: 110, pnl: -10, secret_key: sentinel },
  { id: 30, accountId: 3, symbol: "INACTIVE", side: "LONG", quantity: 1, markPrice: 100 },
  { id: 99, accountId: 999, symbol: "FOREIGN", side: "LONG", quantity: 99, markPrice: 999 },
];
const orders = [1, 2, 3, 999].map((accountId) => ({ id: accountId + 100, accountId, symbol: "BTCUSDT", status: "filled", price: 100, commissionAssets: [{ asset: "USDT", amount: .1, api_key: sentinel }], error: sentinel }));
const strategies = [1, 2, 3, 999].map((accountId) => ({ id: accountId * 11, accountId, name: `strategy-${accountId}`, status: "paused", config: { quantity: "1", auto_execute: false, api_key: sentinel }, credentials: sentinel }));
let mode = "normal", requests = [];
const request = async (endpoint, options) => {
  requests.push(endpoint);
  assert.equal(options.userId, 7); assert.equal(options.method, "GET");
  assert.equal(options.body, undefined); assert.equal(options.headers, undefined);
  const url = new URL(endpoint, "http://fixture.invalid");
  const accountId = Number(url.searchParams.get("account_id"));
  if (url.pathname === "/api/accounts") return mode === "empty" ? [] : mode === "disabled" ? [{ ...accounts[2] }] : mode === "bad-schema" ? {} : accounts;
  if (url.pathname === "/api/dashboard") return { totalEquity: accountId === 3 ? 0 : accountId * 1000, dayPnl: 10, marginUsed: 100, marginTotal: accountId * 1000, market: { connected: true, lastMessageAt: stamp / 1000, error: null, api_key: sentinel }, private: sentinel };
  if (url.pathname === "/api/equity") return mode === "missing" && accountId === 2 ? [] : [{ time: mode === "bad-time" ? 1e20 : stamp - (accountId === 2 ? 120000 : 0), value: mode === "zero" ? 0 : accountId === 3 ? 4000 : accountId * 1000 }];
  if (url.pathname === "/api/positions") return positions; // 故意返回混合账号，验证工具二次过滤。
  if (url.pathname === "/api/orders") return orders;
  if (url.pathname === "/api/strategies") return strategies;
  if (url.pathname.startsWith("/api/risk/")) return { max_leverage: 5, trading_halted: false, api_key: sentinel };
  if (url.pathname === "/api/backtests") return strategies.map((row) => ({ id: row.id, strategyId: row.id, result: { returnPct: 10, curve: [{ credentials: sentinel }], secret_key: sentinel } }));
  throw new Error(`非只读fixture端点：${url.pathname}`);
};
let passed = 0;
const test = async (name, fn) => { mode = "normal"; requests = []; await fn(); passed++; console.log(`  ok  ${name}`); };
const read = (args = {}, ctx = { user: { id: 7 } }) => readBinanceAnalysis(args, ctx, request);

await test("账户清单自然可读，包含停用状态且密钥和同步错误原文不进入模型", async () => {
  const out = await read({ action: "accounts" }); assert.equal(out.accounts.length, 3);
  assert.equal(out.accounts[2].active, false); assert.equal(out.accounts[2].syncStatus, "error");
  assert.equal(JSON.stringify(out).includes(sentinel), false); assert.deepEqual(requests, ["/api/accounts"]);
});
await test("缺省分析本人全部启用账户，汇总与逐账户快照口径一致", async () => {
  const out = await read(); assert.deepEqual(out.accounts.map((row) => row.id), [1, 2]);
  assert.equal(out.summary.totalEquity, 3000); assert.equal(out.positions.length, 2);
  assert.equal(out.exposure.grossNotional, 500); assert.equal(out.exposure.netNotional, -100);
  assert.equal(out.positions[0].liquidationDistancePct, 10); assert.equal(out.positions[1].liquidationDistancePct, 10);
  assert.deepEqual(out.snapshots.map((row) => row.status), ["available", "stale"]);
  assert.equal(JSON.stringify(out).includes(sentinel), false); assert.equal(JSON.stringify(out).includes("FOREIGN"), false);
});
for (const [action, field] of [["positions", "positions"], ["orders", "orders"], ["strategies", "strategies"], ["risk", "risk"], ["backtests", "backtests"]]) {
  await test(`${action} 不需要页面传参，默认覆盖两个启用账户并排除停用/外部资源`, async () => {
    const out = await read({ action }); assert.equal(out[field].length, 2);
    assert.equal(JSON.stringify(out).includes(sentinel), false); assert.deepEqual(out.accounts.map((row) => row.id), [1, 2]);
  });
  await test(`${action} 指定本人账号后只读该账号子资源`, async () => {
    const out = await read({ action, account_id: "2", user_id: 999, method: "POST", body: { action: "trade" } });
    assert.equal(out[field].length, 1); assert.deepEqual(out.accounts.map((row) => row.id), [2]);
    assert.equal(JSON.stringify(out).includes(sentinel), false);
  });
}
await test("指定停用账户只能读取历史快照，不将dashboard的0冒充真实余额", async () => {
  const out = await read({ action: "overview", account_id: 3 });
  assert.equal(out.summary.totalEquity, 4000); assert.equal(out.summary.marginUsed, null);
  assert.equal(out.accounts[0].active, false); assert.equal(out.snapshots[0].syncStatus, "error");
});
await test("真实0余额有快照时保留0，尚无快照返回未知而非0", async () => {
  mode = "zero"; const zero = await read({ action: "overview" });
  assert.equal(zero.summary.totalEquity, 0); assert.equal(zero.snapshots[0].status, "available");
  mode = "missing"; const out = await read({ action: "overview" });
  assert.equal(out.summary.totalEquity, null); assert.equal(out.accountSummaries[0].summary.totalEquity, 1000);
  assert.equal(out.snapshots[1].status, "not_recorded");
});
for (const state of ["empty", "disabled"]) await test(`${state} 不请求跨账户聚合/仓位/风控并明确引导`, async () => {
  mode = state; const out = await read(); assert.equal(out.status, state === "empty" ? "no_accounts" : "no_active_accounts");
  assert.equal(out.summary, null); assert.ok(out.message.includes("OD Binance")); assert.deepEqual(requests, ["/api/accounts"]);
});
await test("外用户ID在账户清单阶段拒绝，不继续读取子资源", async () => {
  await assert.rejects(() => read({ action: "analysis", account_id: 999 }), /无权读取/);
  assert.deepEqual(requests, ["/api/accounts"]);
});
await test("非法账号ID、用户身份、动作在任何桥接调用前拒绝", async () => {
  for (const account_id of [0, -1, 1.5, "not-an-id", "1 OR 1=1", true, null]) await assert.rejects(() => read({ account_id }), /正整数/);
  for (const uid of [0, -1, 1.5, "7x", true]) await assert.rejects(() => read({}, { user: { id: uid } }), /登录用户/);
  for (const action of ["trade", "close", "sync", "place_order", "run_strategy"]) await assert.rejects(() => read({ action }), /只读/);
  assert.equal(requests.length, 0);
});
await test("动作大小写/空白归一，畸形数据失败且停止信号不继续读取", async () => {
  assert.equal((await read({ action: "  POSITIONS " })).positions.length, 2);
  mode = "bad-schema"; await assert.rejects(() => read(), /响应无效/);
  mode = "bad-time"; assert.equal((await read({ action: "overview" })).summary.totalEquity, null);
  requests = []; const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(() => read({}, { user: { id: 7 }, signal: ctrl.signal }), (e) => e.code === "ABORTED"); assert.equal(requests.length, 0);
});

// 工具结果实际进入下一步模型上下文，不能只测read函数或页面按钮跳转。
const audit = {
  harnessRuntime, splitTokens,
  platformTools, platformCatalog,
  callFingerprint,
  toolPresentation, toolWire, contextTools, crypto, request, readBinanceAnalysis, complete: null, buildSystemPrompt, SUBAGENTS };
globalThis.__ooBinanceToolAudit = audit;
const mocked = async (path, prelude) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(`const audit=globalThis.__ooBinanceToolAudit;\nconst { TOOL_PRESENTATIONS, toolPresentation } = audit.toolPresentation;\n${prelude}\n${source}`).toString("base64")}`);
};
try {
  audit.tools = await mocked("../src/services/harness/tools.js", `
    const {platformToolSpecs,platformNativeSchema,runPlatformTool}=audit.platformTools;
    const {PLATFORM_TOOL_IDS}=audit.platformCatalog;
    const readBinanceAnalysis=(args,ctx)=>audit.readBinanceAnalysis(args,ctx,audit.request);
    const pool={query:async()=>{throw new Error('禁止真实DB')}};
    const runCompletion=o=>audit.complete(o);
    const modelForChannelMatch=v=>v;
  `);
  const harness = await mocked("../src/services/harness/loop.js", `
    const {needsToolApproval,PLATFORM_TOOL_IDS}=audit.platformCatalog;
    const {grantToolCall,platformRequest,cleanPlatformResult,preparePlatformCall}=audit.platformTools;
    const {createHarnessRuntime,harnessInterruption,isLocalTool,fingerprintHash,privateToolPart,sanitizeCheckpoint,mapConcurrent}=audit.harnessRuntime;
    const splitTokens=audit.splitTokens;
    const callFingerprint=audit.callFingerprint;
    const crypto=audit.crypto;
    const runCompletion=o=>audit.complete({...o,...o.prepareRequest?.({nativeTools:false})});
    const modelForChannelMatch=v=>v;
    const buildSystemPrompt=audit.buildSystemPrompt, SUBAGENTS=audit.SUBAGENTS;
    const {toolSpecs,nativeToolSpecs,runTool}=audit.tools;
    const {callsText,chatCalls,textToolMessages}=audit.toolWire;
    const {contextBudget,messageTokens,compressionSplit,latestMemory}=audit.contextTools;
    const DEFAULT_MAX_STEPS=8;
    const MAX_STEPS_LIMIT=32;
  `);
  for (const mode of ["whole", "char"]) await test(`通用系统对话${mode}无需预填直接读accounts/仓位/最近订单/策略并据结果回答`, async () => {
    let count = 0;
    const actions = ["accounts", "positions", "orders", "strategies"];
    audit.complete = async (options) => {
      if (count) {
        const returned = JSON.stringify(options.messages);
        assert.ok(returned.includes('<tool_result tool=\\"binance\\"'));
        assert.ok(returned.includes(count === 1 ? "demo-owned" : count === 2 ? "BTCUSDT" : count === 3 ? "filled" : "strategy-1"));
        assert.equal(returned.includes(sentinel), false);
      }
      const content = count < actions.length ? `<tool_call>{"tool":"binance","args":{"action":"${actions[count]}"}}</tool_call>` : "已读取你的两个启用账户、仓位、最近订单和策略。";
      count++;
      for (const text of mode === "whole" ? [content] : [...content]) options.onDelta(text);
      return { content, usage: { prompt_tokens: 2, completion_tokens: 1 }, channel: { id: 1, name: "fixture" }, elapsed: 1 };
    };
    const out = await harness.runHarness({ session: { todo: [] }, user: { id: 7 }, agent: findAgent("general"), model: "fixture-only", settings: { maxSteps: 8 }, userText: "我当前有哪些币安账户、仓位、最近订单和策略？" });
    assert.equal(count, 5); assert.equal(out.calls.length, 5); assert.equal(out.parts.filter((part) => part.type === "tool" && part.status === "done").length, 4);
    assert.equal(out.text, "已读取你的两个启用账户、仓位、最近订单和策略。");
  });
  await test("真实runTool失败/空账户结果可解释，未增交易权限", async () => {
    mode = "empty"; const empty = await audit.tools.runTool("binance", { action: "analysis" }, { user: { id: 7 } });
    assert.equal(empty.ok, true); assert.equal(JSON.parse(empty.output).status, "no_accounts");
    const invalid = await audit.tools.runTool("binance", { action: "trade" }, { user: { id: 7 } }); assert.equal(invalid.ok, false);
  });
} finally { delete globalThis.__ooBinanceToolAudit; }
console.log(`BINANCE_TOOL_PASS: ${passed} read-only owner/snapshot/harness checks; real DB/upstream/trade requests=0`);
