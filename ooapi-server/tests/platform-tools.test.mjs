import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PLATFORM_CATALOG, PLATFORM_TOOL_IDS, visiblePlatformCatalog } from "../src/services/harness/platform-catalog.js";
import { runPlatformTool, grantToolCall, platformRequest, cleanPlatformResult, preparePlatformCall } from "../src/services/harness/platform-tools.js";
import { toolSpecs, nativeToolSpecs } from "../src/services/harness/tools.js";
import { toolPresentation } from "../src/services/harness/tool-presentation.js";
const user = { id: 77, role: 1000, token_version: 0 };
const response = value => new Response(JSON.stringify({ success: true, data: value }), { headers: { "Content-Type": "application/json" } });

test("每个方法都有真实业务路由、完整参数目录和双文案；角色过滤落到原生声明", () => {
  let count = 0;
  for (const g of Object.values(PLATFORM_CATALOG)) for (const a of Object.values(g.actions)) {
    const segments = a.path.split("/"), routeFile = ({ users: "user", user: "auth", catalog: "index", status: "index" })[segments[2]] || segments[2];
    const source = fs.readFileSync(new URL(routeFile === "index" ? "../src/index.js" : `../src/routes/${routeFile}.js`, import.meta.url), "utf8");
    const local = "/" + segments.slice(3).join("/");
    if (routeFile !== "binance" && routeFile !== "index") assert.ok(source.includes(`"${local}"`), `${g.id}.${a.action} 缺少真实路由`);
    assert.equal(a.write, a.verb !== "GET");
    const presentation = toolPresentation(g.id, { action: a.action });
    assert.equal(presentation.title, a.title);
    assert.ok(presentation.inquiryPhrases.length >= 10 && presentation.capsulePhrases.length >= 10);
    count++;
  }
  assert.ok(count > 150);
  const normal = nativeToolSpecs(PLATFORM_TOOL_IDS, { role: 1 });
  assert.ok(!normal.some(s => ["channels", "pricing", "users", "system", "monitor"].includes(s.name)));
  assert.ok(!normal.find(s => s.name === "community").parameters.properties.action.enum.includes("moderate"));
  assert.equal(toolSpecs(["models"], { role: 1 })[0].id, "models");
  assert.ok(visiblePlatformCatalog(1).every(g => g.actions.every(a => a.role <= 1)));
  console.log(`${count} 个固定业务方法已核对路由`);
});
test("所有写方法缺少确认均不发请求；已确认只执行一次并使用固定路由", async () => {
  for (const g of Object.values(PLATFORM_CATALOG)) for (const a of Object.values(g.actions).filter(a => a.write)) {
    let args = { action: a.action, params: Object.fromEntries([...a.path.matchAll(/:(\w+)/g)].map(m => [m[1], m[1] === "model" ? "sample-model" : "12"])), data: {} };
    if (g.id === "pricing" && a.action === "set") args.data = { model: "sample-model", input_price: 1, output_price: 2 };
    let calls = 0;
    let price = null, setting = {};
    const fetchImpl = async (url, options) => {
      assert.equal(new URL(url).hostname, "127.0.0.1"); assert.equal(options.redirect, "error");
      if (options.method === "GET") return response(new URL(url).pathname === "/api/pricing" ? price ? [price] : [] : { setting });
      calls++; assert.equal(options.method, a.verb);
      if (g.id === "pricing" && a.action === "set") price = JSON.parse(options.body);
      if (g.id === "people" && a.action === "settings") setting = JSON.parse(options.body)._internal_setting;
      return response({ id: 12 });
    };
    assert.equal((await runPlatformTool(g.id, args, { user }, { fetchImpl })).ok, false, g.id + "." + a.action);
    assert.equal(calls, 0);
    let prepared = null;
    if (g.id === "pricing" && a.action === "set" || g.id === "people" && a.action === "settings") {
      const result = await preparePlatformCall(g.id, args, { user }, { fetchImpl });
      args = result.canonicalArgs; prepared = result.prepared;
    }
    const grant = grantToolCall(g.id, args, user.id);
    assert.equal((await runPlatformTool(g.id, args, { user, toolGrant: grant, platformPrepared: prepared }, { fetchImpl })).ok, true);
    assert.equal((await runPlatformTool(g.id, args, { user, toolGrant: grant }, { fetchImpl })).ok, false);
    assert.equal(calls, 1);
  }
});
test("确认绑定完整正文、身份；路径、字段、凭据和当前运行不能越界", async () => {
  const args = { action: "comment", params: { id: 12 }, data: { content: "确认的正文" } };
  let calls = 0; const fetchImpl = async () => { calls++; return response(null); };
  for (const context of [{ user: { ...user, id: 78 }, toolGrant: grantToolCall("community", args, 77) }, { user, toolGrant: grantToolCall("community", { ...args, data: { content: "别的正文" } }, 77) }]) assert.equal((await runPlatformTool("community", args, context, { fetchImpl })).ok, false);
  assert.equal(calls, 0);
  for (const bad of ["../users", "1?x=y", "http://invalid", "1/../../status"]) assert.throws(() => platformRequest("community", { ...args, params: { id: bad } }, user));
  assert.throws(() => platformRequest("community", { ...args, data: { ...args.data, user_id: 99 } }, user));
  assert.throws(() => platformRequest("people", { action: "settings", data: { smtp_pass: "synthetic-fixture" } }, user));
  assert.throws(() => platformRequest("workspace", { action: "delete", params: { id: "current" } }, user, "current"));
  assert.throws(() => platformRequest("system", { action: "save_options", data: { agent_flow: {} } }, user));
  assert.throws(() => platformRequest("channels", { action: "list" }, { id: 77, role: 1 }));
});
test("真实业务拒绝传回失败；敏感返回值清理；请求超时不冒称写入成功", async () => {
  const args = { action: "publish", data: { title: "样例", content: "正文", topic_id: 1 } };
  const denied = await runPlatformTool("community", args, { user, toolGrant: grantToolCall("community", args, 77) }, { fetchImpl: async () => new Response(JSON.stringify({ success: false, message: "没有权限" }), { status: 403 }) });
  assert.equal(denied.ok, false); assert.match(denied.output, /没有权限/);
  const failed = await runPlatformTool("community", args, { user, toolGrant: grantToolCall("community", args, 77) }, { fetchImpl: async () => { throw new Error("synthetic transport failure"); } });
  assert.equal(failed.ok, false); assert.match(failed.output, /避免重复/);
  assert.deepEqual(cleanPlatformResult({ key_str: "synthetic", nested: { password: "synthetic", name: "可见" }, smtp_pass: "synthetic" }), { nested: { name: "可见" } });
  const preview = toolPresentation("community", { ...args, data: { content: "完整正文".repeat(1000), title: "标题", topic_id: 1 } });
  assert.equal(preview.fields.find(f => f.label === "正文").value.length, 4000);
});
test("可用模型查询按实际目录分页，保留末页和无结果；不能把调用历史当模型", async () => {
  const models = Array.from({ length: 40 }, (_, i) => ({ id: "model-" + i, vendor: "sample" }));
  const result = await runPlatformTool("models", { action: "available", params: { p: 3, size: 15 } }, { user }, { fetchImpl: async () => response({ models, keys: [{ key: "synthetic-secret" }], active_key: { id: 1 } }) });
  const data = JSON.parse(result.output).data;
  assert.equal(data.models.length, 10); assert.equal(data.models[0].id, "model-30"); assert.equal(data.total, 40); assert.equal(data.has_more, false); assert.ok(!result.output.includes("synthetic-secret"));
});
