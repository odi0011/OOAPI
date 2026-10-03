// 只允许独立测试库；复刻 Sub2API 探测并验证压缩后的下一次真实 HTTP 调用。
import "dotenv/config";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";
const BASE = process.env.BASE || "http://127.0.0.1:4275";
assert.equal(new URL(BASE).hostname, "127.0.0.1");
const [[database]] = await pool.query("SELECT DATABASE() name");
assert.equal(database.name, "ooapi_compact_gate");
const [[key]] = await pool.query("SELECT * FROM tokens WHERE name = ? LIMIT 1", ["Fixture gateway"]);
assert(key);
const body = { model: "deepseek-flash", instructions: "You are a helpful coding assistant.", input: [{ type: "message", role: "user", content: "Respond with OK. Remember project orchard-726 and leave audit.js unchanged." }, { type: "compaction_trigger" }], stream: true };
const eventsOf = raw => raw.split("\n").filter(l => l.startsWith("data: ") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(6)));
const request = (url, body, apiKey = key.key_str) => fetch(BASE + url, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "Sub2API/fixture", "x-openai-beta-features": "remote_compaction_v2" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const account = async () => (await pool.query("SELECT quota,used_quota,request_count FROM users WHERE id = ?", [key.user_id]))[0][0];
const errors = [];
let otherId;
try {
  const [other] = await pool.query("INSERT INTO tokens (user_id,name,key_str,status,unlimited_quota,group_name) VALUES (?,?,?,?,?,?)", [key.user_id, "Other fixture", "fixture-other-key", 1, 1, "另一组"]);
  otherId = other.insertId;
  const before = await account();
  for (const prefix of ["/v1", "/api/v1", ""]) for (const path of ["/billing", "/sub2api/billing"]) {
    const res = await request(prefix + path + "?group=另一组");
    assert.equal(res.status, 200); assert.match(res.headers.get("cache-control"), /no-store/);
    const json = await res.json();
    assert.equal(json.object, path.includes("sub2api") ? "sub2api.key_billing" : "ooapi.key_billing");
    assert.equal(json.schema_version, 1); assert.equal(json.billing_scope, "token");
    assert.equal(json.group_rate_multiplier, 0.01); assert.equal(json.resolved_rate_multiplier, 0.01); assert.equal(json.effective_rate_multiplier, 0.01);
    assert.equal(json.group_name, "测试"); assert.equal(json.peak_rate_enabled, false);
    assert(Number.isFinite(Date.parse(json.observed_at)));
    const second = await request(prefix + path, null, "fixture-other-key");
    assert.equal((await second.json()).effective_rate_multiplier, 0.5);
    assert.equal((await request(prefix + path, null, "invalid-fixture")).status, 401);
  }
  assert.deepEqual(await account(), before, "探测倍率不能调用模型或扣费，也不能接受外部 group 参数");
  console.log("PASS billing: 6 route aliases, strict Sub2API schema, two groups, auth and zero consumption");

  const resumedItems = [];
  for (const prefix of ["/v1", "/api/v1", ""]) {
    for (const stream of [true, false]) {
      const res = await request(prefix + "/responses", { ...body, stream });
      assert.equal(res.status, 200); assert.equal(res.headers.get("x-compaction-mode"), "gateway_summary");
      const raw = await res.text(), data = stream ? eventsOf(raw) : null;
      const result = stream ? data.find(e => e.type === "response.completed")?.response : JSON.parse(raw);
      assert(result, raw); assert.equal(result.output.length, 1); assert.equal(result.output[0].type, "compaction");
      assert(result.output[0].encrypted_content); assert.equal(result.usage.input_tokens, 30); assert.equal(result.usage.output_tokens, 8);
      assert(!raw.includes("orchard-726"), "压缩协议不输出普通正文或明文摘要");
      if (stream) {
        const item = data.find(e => e.type === "response.output_item.done")?.item;
        assert.deepEqual(item, result.output[0]);
        assert.deepEqual(data.find(e => e.type === "response.output_item.added")?.item, item);
        assert.deepEqual(data.map(e => e.sequence_number), data.map((_, i) => i));
        assert(!data.some(e => /output_text|reasoning/.test(e.type)));
      }
      resumedItems.push(result.output[0]);
      const next = await request(prefix + "/responses", { model: body.model, input: [result.output[0], { role: "user", content: "Continue the previous task." }], stream: false });
      assert.equal(next.status, 200);
      const nextBody = await next.json();
      assert(JSON.stringify(nextBody.output).includes("RESTORED orchard-726 audit.js"), "下一轮上游必须真正收到摘要并据此回答");
    }
    const legacy = await request(prefix + "/responses/compact", { ...body, input: body.input.slice(0, -1), stream: false });
    assert.equal(legacy.status, 200); const json = await legacy.json();
    assert.equal(json.object, "response.compaction"); assert.equal(json.output[0].type, "compaction");
  }
  console.log("PASS compaction: v2 SSE/JSON and legacy endpoints, 3 prefixes, full following-turn restoration");
  const afterSuccess = await account();
  assert.equal(Number(afterSuccess.request_count) - Number(before.request_count), 15);
  assert(Number(afterSuccess.used_quota) > Number(before.used_quota));
  const [[log]] = await pool.query("SELECT detail FROM logs WHERE token_id=? ORDER BY id DESC LIMIT 1", [key.id]);
  assert.equal(JSON.parse(log.detail).billing_details.multiplier, 0.01);

  const item = resumedItems[0];
  for (const input of [[...body.input, { role: "user", content: "misplaced" }], [{ type: "compaction", encrypted_content: "foreign" }, { role: "user", content: "hi" }], [{ ...item, encrypted_content: item.encrypted_content.slice(0, -8) + "tampered" }, { role: "user", content: "hi" }]]) {
    const res = await request("/v1/responses", { model: body.model, input });
    assert.equal(res.status, 400); errors.push((await res.json()).error.code);
  }
  const wrongKey = await request("/v1/responses", { model: body.model, input: [item, { role: "user", content: "hi" }] }, "fixture-other-key");
  assert.equal(wrongKey.status, 400); assert.equal((await wrongKey.json()).error.code, "invalid_compaction");
  assert.deepEqual(await account(), afterSuccess, "解析失败必须在上游调用及额度预占之前拒绝");
  console.log("PASS malformed triggers, foreign/tampered state and wrong key rejected without billing");

  for (const marker of ["truncate-fixture", "max-output-fixture"]) {
    const failed = await request("/v1/responses", { ...body, stream: true, ...(marker === "max-output-fixture" ? { max_output_tokens: 2 } : {}), input: [{ role: "user", content: marker }, { type: "compaction_trigger" }] });
    const raw = await failed.text();
    assert(!raw.includes('"type":"compaction"')); assert(!raw.includes('"type":"response.completed"'));
    assert(raw.includes("CONTEXT_COMPACTION_FAILED"));
    errors.push("CONTEXT_COMPACTION_FAILED");
  }
  const afterFailures = await account();
  assert.equal(Number(afterFailures.request_count) - Number(afterSuccess.request_count), 2, "两次已产生用量的失败分别结算一次");
  console.log("PASS truncated summary never returned as success; partial consumption recorded once");
} finally {
  if (otherId) await pool.query("DELETE FROM tokens WHERE id=?", [otherId]);
  await pool.end();
}
