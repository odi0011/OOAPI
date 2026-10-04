import test from "node:test";
import assert from "node:assert/strict";
import { preparePlatformCall, runPlatformTool, grantToolCall, platformRequest } from "../src/services/harness/platform-tools.js";
import { toolPresentation } from "../src/services/harness/tool-presentation.js";

const admin = { id: 71, role: 100, token_version: 0 };
const ordinary = { id: 72, role: 1, token_version: 0 };
const response = (data, status = 200) => new Response(JSON.stringify({ success: status < 400, data, ...(status >= 400 ? { message: "读取被拒绝" } : {}) }), { status });
const storedPrice = () => ({ model: "sample-model", input_price: 1.4, output_price: 2.8, cache_price: .14, channel_type: "sample", remark: "已有定价来源", offpeak_input_price: .7, offpeak_output_price: 1.4, offpeak_cache_price: .07, offpeak_rule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"]] } });
function priceApi(initial = storedPrice()) {
  let row = structuredClone(initial), writes = 0, reads = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).hostname, "127.0.0.1");
    if (options.method === "GET") { reads++; return response(row ? [row] : []); }
    assert.equal(options.method, "PUT"); writes++; row = JSON.parse(options.body); delete row._internal_expected; return response(null);
  };
  return { fetchImpl, row: () => row, set: value => { row = value; }, writes: () => writes, reads: () => reads };
}
const approve = (tool, prepared, user) => ({ user, platformPrepared: prepared.prepared, toolGrant: grantToolCall(tool, prepared.canonicalArgs, user.id) });

test("局部定价先读原值，审批展示差异，保留缓存/闲时/备注并读回核对", async () => {
  const api = priceApi(), requested = { action: "set", data: { model: "sample-model", input_price: 2 } };
  const prepared = await preparePlatformCall("pricing", requested, { user: admin }, api);
  assert.equal(api.writes(), 0);
  assert.equal(prepared.canonicalArgs.data.output_price, 2.8);
  assert.equal(prepared.canonicalArgs.data.cache_price, .14);
  assert.equal(prepared.canonicalArgs.data.offpeak_input_price, .7);
  assert.equal(prepared.canonicalArgs.data.remark, "已有定价来源");
  assert.equal(requested.data.output_price, undefined);
  assert.ok(prepared.presentation.fields.some(f => f.label.includes("修改前") && f.value.includes("1.4\n→ 2")));
  assert.deepEqual(toolPresentation("pricing", prepared.canonicalArgs), prepared.presentation);
  const context = approve("pricing", prepared, admin);
  const result = await runPlatformTool("pricing", prepared.canonicalArgs, context, api);
  assert.equal(result.ok, true); assert.equal(result.outcome, "verified");
  assert.equal(api.writes(), 1); assert.equal(api.reads(), 3);
  assert.equal((await runPlatformTool("pricing", prepared.canonicalArgs, context, api)).ok, false);
  assert.equal(api.writes(), 1);
});

test("没有准备或审批参数被替换时不能写；配置在审批期间变动不覆盖", async () => {
  const api = priceApi();
  const args = { action: "set", data: { model: "sample-model", input_price: 2, output_price: 3 } };
  assert.equal((await runPlatformTool("pricing", args, { user: admin, toolGrant: grantToolCall("pricing", args, admin.id) }, api)).outcome, "not_executed");
  const prepared = await preparePlatformCall("pricing", args, { user: admin }, api);
  const changed = structuredClone(prepared.canonicalArgs); changed.data.input_price = 10;
  assert.equal((await runPlatformTool("pricing", changed, { user: admin, platformPrepared: prepared.prepared, toolGrant: grantToolCall("pricing", changed, admin.id) }, api)).ok, false);
  const fresh = await preparePlatformCall("pricing", args, { user: admin }, api);
  api.set({ ...api.row(), cache_price: .2 });
  const result = await runPlatformTool("pricing", fresh.canonicalArgs, approve("pricing", fresh, admin), api);
  assert.equal(result.outcome, "not_executed"); assert.match(result.output, /原配置已变化/); assert.equal(api.writes(), 0);
});

test("新模型必须给足基准价格；数字按接口精度展示后确认", async () => {
  const api = priceApi(null);
  await assert.rejects(preparePlatformCall("pricing", { action: "set", data: { model: "new-model", input_price: 1 } }, { user: admin }, api), /输入和输出/);
  const prepared = await preparePlatformCall("pricing", { action: "set", data: { model: "new-model", input_price: 1.12345678, output_price: "2" } }, { user: admin }, api);
  assert.equal(prepared.canonicalArgs.data.input_price, 1.123457);
  assert.equal(prepared.canonicalArgs.data.cache_price, 0);
  assert.equal((await runPlatformTool("pricing", prepared.canonicalArgs, approve("pricing", prepared, admin), api)).outcome, "verified");
});

test("偏好修改递归保留其他项，数组按意图替换，结果读回", async () => {
  let setting = { limits: { rpm: 10, tpm: 2000 }, layout: { sidebar: true }, pinned: [1, 2] }, writes = 0;
  const api = { fetchImpl: async (_url, options) => {
    if (options.method === "GET") return response({ setting, username: "fixture-user", token: "synthetic-not-a-secret" });
    writes++; setting = JSON.parse(options.body)._internal_setting; return response(setting);
  } };
  const requested = { action: "settings", data: { limits: { rpm: 5 }, pinned: [3] } };
  const prepared = await preparePlatformCall("people", requested, { user: ordinary }, api);
  assert.deepEqual(prepared.canonicalArgs.data, { limits: { rpm: 5, tpm: 2000 }, layout: { sidebar: true }, pinned: [3] });
  assert.equal((await runPlatformTool("people", prepared.canonicalArgs, approve("people", prepared, ordinary), api)).outcome, "verified");
  assert.equal(writes, 1);
  const read = await runPlatformTool("people", { action: "preferences" }, { user: ordinary }, api);
  assert.deepEqual(JSON.parse(read.output).data, { setting });
  assert.ok(!read.output.includes("fixture-user"));
});

test("写成功但读回不一致或读回拒绝，保留未知状态且不重复写", async () => {
  for (const readback of ["mismatch", "denied", "transport"]) {
    const row = storedPrice(); let writes = 0;
    const api = { fetchImpl: async (_url, options) => {
      if (options.method === "PUT") { writes++; return response(null); }
      if (writes && readback === "denied") return response(null, 403);
      if (writes && readback === "transport") throw new Error("fixture connection closed");
      return response([row]);
    } };
    const prepared = await preparePlatformCall("pricing", { action: "set", data: { model: row.model, input_price: 2 } }, { user: admin }, api);
    const result = await runPlatformTool("pricing", prepared.canonicalArgs, approve("pricing", prepared, admin), api);
    assert.equal(result.ok, false); assert.equal(result.outcome, "unknown"); assert.equal(writes, 1);
  }
});

test("角色与字段权限在读取和审批前拒绝，日常管理员合法设置仍可用", async () => {
  let reads = 0; const api = { fetchImpl: async () => { reads++; return response(null); } };
  await assert.rejects(preparePlatformCall("pricing", { action: "set", data: { model: "sample-model", input_price: 2 } }, { user: ordinary }, api), /没有.*权限/);
  await assert.rejects(preparePlatformCall("users", { action: "edit", params: { id: 70 }, data: { role: 100 } }, { user: admin }, api), /超级管理员/);
  await assert.rejects(preparePlatformCall("system", { action: "save_options", data: { request_timeout_ms: 50000 } }, { user: admin }, api), /超级管理员/);
  await assert.rejects(preparePlatformCall("system", { action: "save_options", data: { unknown_setting: true } }, { user: admin }, api), /未知系统设置/);
  assert.equal(reads, 0);
  assert.ok((await preparePlatformCall("system", { action: "save_options", data: { site_name: "测试平台" } }, { user: admin }, api)).canonicalArgs);
  assert.ok((await preparePlatformCall("users", { action: "edit", params: { id: 70 }, data: { display_name: "测试昵称" } }, { user: admin }, api)).canonicalArgs);
  await assert.rejects(preparePlatformCall("users", { action: "delete", params: { id: 70 } }, { user: admin }, { fetchImpl: async () => response({ role: 100 }) }), /超级管理员/);
});

test("目录按当前工具策略和角色过滤，模型查询继承会话密钥且可显式覆盖", async () => {
  const catalog = await runPlatformTool("platform", { action: "catalog" }, { user: admin, enabledTools: ["platform", "models"] });
  assert.deepEqual(JSON.parse(catalog.output).map(g => g.id), ["models"]);
  assert.equal((await runPlatformTool("platform", { action: "describe", group: "pricing" }, { user: admin, enabledTools: ["platform", "models"] })).ok, false);
  assert.equal((await runPlatformTool("pricing", { action: "list" }, { user: admin, enabledTools: ["platform", "models"] })).ok, false);
  const urls = [], api = { fetchImpl: async url => { urls.push(new URL(url)); return response({ models: [], active_key: { id: 99 } }); } };
  await runPlatformTool("models", { action: "available" }, { user: ordinary, keyId: 99 }, api);
  await runPlatformTool("models", { action: "available", params: { keyId: 88 } }, { user: ordinary, keyId: 99 }, api);
  assert.equal(urls[0].searchParams.get("keyId"), "99"); assert.equal(urls[1].searchParams.get("keyId"), "88");
});

test("真实接口的能力定价、模型筛选、消息分页和渠道超时参数均可通过目录", () => {
  for (const [tool, args] of [
    ["pricing", { action: "set_capabilities", data: { model: "sample-model", capabilities: {}, pricing: { input: 1, output: 2, cache: .1 } } }],
    ["pricing", { action: "capabilities", params: { model: "sample-model" } }],
    ["messages", { action: "rooms", params: { p: 2, size: 50 } }],
    ["messages", { action: "search", params: { q: "内容", p: 2, size: 30 } }],
    ["channels", { action: "edit", data: { id: 1, probe_timeout_sec: 300 } }],
  ]) assert.ok(platformRequest(tool, args, admin));
});
