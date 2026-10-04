// 只用于 4125 独立候选库的本机三协议门禁，不连接收费上游。
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { pool } from "../src/db.js";

if (!/^ooapi_agent_gate_[a-f0-9]{8}$/.test(process.env.DB_NAME || "") || Number(process.env.PORT) !== 4125) throw new Error("拒绝在非隔离候选环境创建 fixture。");
const [[database]] = await pool.query("SELECT DATABASE() AS name"); assert.equal(database.name, process.env.DB_NAME);
const group = "ooapi-agent-isolated", model = "gpt-4o-mini", at = Math.floor(Date.now() / 1000);
await pool.query("INSERT INTO channel_groups (vendor,name,rate,models,created_time) VALUES ('',?,1,?,?) ON DUPLICATE KEY UPDATE rate=1,models=VALUES(models)", [group, JSON.stringify([model]), at]);
const [[channel]] = await pool.query("SELECT id FROM channels WHERE name=?", ["isolated-agent-fixture"]);
const other = JSON.stringify({ method: "api", allow_private_upstream: true });
if (!channel) await pool.query("INSERT INTO channels (name,type,base_url,api_key,models,group_name,group_list,status,auto_ban,auto_test,other,created_time) VALUES (?,'openai',?,?,?,?,?,1,0,0,?,?)", ["isolated-agent-fixture", "http://127.0.0.1:4135", "fixture-" + crypto.randomBytes(24).toString("hex"), model, group, JSON.stringify([group]), other, at]);
await pool.query("UPDATE users SET group_name=? WHERE id IN (11,22,99)", [group]);
const [[token]] = await pool.query("SELECT id FROM tokens WHERE user_id=11 AND group_name=?", [group]);
if (!token) await pool.query("INSERT INTO tokens (user_id,name,key_str,status,unlimited_quota,group_name,created_time) VALUES (11,?,?,1,1,?,?)", ["isolated-fixture", "sk-" + crypto.randomBytes(24).toString("hex"), group, at]);
await pool.query("INSERT INTO model_prices (model,input_price,output_price,cache_price,remark,updated_time) VALUES (?,0.1,0.2,0.01,?,?) ON DUPLICATE KEY UPDATE input_price=0.1,output_price=0.2,cache_price=0.01,remark=VALUES(remark)", [model, "isolated local fixture only", at]);
await pool.end();
const server = http.createServer(async (req, res) => {
  // UI门禁只读空数据，不连接交易服务或建立任何真实账户/订单。
  if (req.method === "GET" && ["/health", "/api/accounts", "/api/strategies", "/api/orders", "/api/positions", "/api/equity", "/api/dashboard"].includes(req.url?.split("?")[0])) {
    const endpoint = req.url.split("?")[0];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(endpoint === "/health" ? { status: "ok", automation: { enabled: false }, fixture: true } : endpoint === "/api/dashboard" ? {} : [])); return;
  }
  if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return; }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 1024 * 1024) { res.writeHead(413).end(); return; } }
  let value; try { value = JSON.parse(data); } catch { res.writeHead(400).end(); return; }
  const id = "chatcmpl-fixture", created = Math.floor(Date.now() / 1000), base = { id, object: "chat.completion.chunk", created, model: value.model };
  const content = "pong";
  if (value.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })); }
});
server.listen(4135, "127.0.0.1", () => console.log("Isolated fixture upstream ready; no external model calls."));
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => server.close(() => process.exit(0)));
