// 仅独立候选库。工具走真实 HTTP 路由；模型上游受控，不向生产发帖或调用收费模型。
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import { runPlatformTool, grantToolCall } from "../src/services/harness/platform-tools.js";
const BASE = process.env.BASE || "http://127.0.0.1:4115", OUT = "/var/tmp/ooapi-platform-agent";
assert.equal(new URL(BASE).hostname, "127.0.0.1"); process.env.PORT = new URL(BASE).port;
const [[db]] = await pool.query("SELECT DATABASE() name"); assert.equal(db.name, "ooapi_lele_gate");
const [[admin]] = await pool.query("SELECT * FROM users WHERE role>=1000 LIMIT 1");
const prefix = "platform_gate_" + Date.now(), users = [], sessions = [], created = {};
let checks = 0, browser, currentCall, seenTools = [];
const check = (v, label) => { assert.ok(v, label); checks++; console.log("PASS", label); };
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), results = (body.messages || []).filter(m => m.role === "tool");
  seenTools = body.tools || [];
  const delta = results.length ? { content: "已根据真实工具返回结果完成这一步。" } : { tool_calls: [0, 1].map(i => ({ index: i, id: "fixture_" + i, type: "function", function: { name: currentCall.tool, arguments: JSON.stringify(currentCall.args) } })) };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: results.length ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }) + "\n\ndata: [DONE]\n\n");
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
async function api(user, path, data, method = data ? "POST" : "GET") {
  const res = await fetch(BASE + "/api" + path, { method, headers: { authorization: `Bearer ${signToken(user)}`, "Content-Type": "application/json" }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  return { status: res.status, ...await res.json() };
}
async function tool(user, name, args, approved = false) {
  const result = await runPlatformTool(name, args, { user, toolGrant: approved ? grantToolCall(name, args, user.id) : null });
  return { ...result, value: (() => { try { return JSON.parse(result.output).data; } catch { return null; } })() };
}
try {
  // 候选服务刚重启时先等就绪，避免创建夹具后才发现监听端口尚未启动。
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await fetch(BASE + "/api/status", { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, "候选服务必须就绪后再创建测试数据");
  for (let i = 0; i < 2; i++) {
    const [r] = await pool.query("INSERT INTO users (username,password,display_name,quota,status,role,created_time) VALUES (?,?,?,?,1,1,?)", [prefix + i, "!fixture-disabled-login!", "工具验收" + i, 1000000, Math.floor(Date.now() / 1000)]);
    const [[u]] = await pool.query("SELECT * FROM users WHERE id=?", [r.insertId]); users.push(u);
  }
  const [group] = await pool.query("INSERT INTO channel_groups (name,models,rate) VALUES (?,?,1)", [prefix, JSON.stringify(["deepseek-flash"])]); created.group = group.insertId;
  const [channel] = await pool.query("INSERT INTO channels (name,type,base_url,api_key,models,group_name,group_list,status,priority,other) VALUES (?,?,?,?,?,?,?,1,100,?)", [prefix, "deepseek", `http://127.0.0.1:${upstream.address().port}`, "fixture-not-a-real-key", "deepseek-flash", prefix, JSON.stringify([prefix]), JSON.stringify({ method: "api", allow_private_upstream: true })]); created.channel = channel.insertId;
  assert.equal((await api(admin, "/channel", { id: created.channel, name: prefix }, "PUT")).success, true);
  const key = await tool(users[0], "tokens", { action: "create", data: { name: prefix, group_name: prefix, unlimited_quota: true } }, true);
  check(key.ok && key.value.id && !key.output.includes("sk-"), "工具创建令牌成功但不回传密钥"); created.key = key.value.id;
  const available = await tool(users[0], "models", { action: "available", params: { keyId: created.key } });
  check(available.ok && available.value.models.some(m => m.id === "deepseek-flash"), "无调用历史的新用户仍能查询实际可用模型");
  check(!(await tool(users[0], "channels", { action: "list" })).ok, "普通用户不能读取渠道管理");
  const topic = await tool(admin, "community", { action: "create_topic", data: { name: prefix, description: "隔离验收" } }, true);
  check(topic.ok && topic.value.id, "管理员通过工具创建话题"); created.topic = topic.value.id;
  check(!(await tool(users[0], "community", { action: "create_topic", data: { name: prefix } }, true)).ok, "普通用户不能创建管理话题");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(token => localStorage.setItem("ooapi-token", token), signToken(users[0])); await fs.mkdir(OUT, { recursive: true });
  async function harness(call, decision, name) {
    currentCall = call;
    const session = (await api(users[0], "/chat/sessions", { model: "deepseek-flash", settings: { permissionMode: "auto", maxSteps: 3 } })).data;
    sessions.push(session.id);
    const res = await fetch(BASE + "/api/chat/run", { method: "POST", headers: { authorization: `Bearer ${signToken(users[0])}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id, keyId: created.key, model: "deepseek-flash", text: "PLATFORM_AGENT_FIXTURE " + name }) });
    assert.ok(res.ok); const events = [], reader = res.body.getReader();
    const read = (async () => { let buffer = ""; const decoder = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let end; while ((end = buffer.indexOf("\n\n")) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); for (const line of block.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch {} } } } })();
    for (let i = 0; i < 100 && !events.some(e => e.part?.type === "approval" || e.type === "error"); i++) await new Promise(r => setTimeout(r, 100));
    const approval = events.find(e => e.part?.type === "approval")?.part;
    if (!approval) console.log(JSON.stringify(events.map(e => ({type:e.type, code:e.code, error:e.error, message:e.message, part:e.part?.type, tool:e.part?.tool, output:e.patch?.output}))));
    check(!!approval, name + " 即使自动模式也等待写入审批");
    check((await api(users[1], `/chat/sessions/${session.id}/approvals/${approval.id}`, { decision: "approved" })).status >= 400, name + " 拒绝其他用户审批");
    await page.goto(BASE + "/chat?s=" + session.id, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "仅允许这次", exact: true }).waitFor();
    await page.waitForTimeout(900);
    check((await page.locator(".lele-operation-fields").innerText()).includes(call.args.data.content), name + " 展示完整拟发布内容");
    check(!(await page.locator(".lele-speech").innerText()).includes("topic_id"), name + " 询问使用业务说明而非接口参数名");
    await page.screenshot({ path: `${OUT}/${name}-approval.png` });
    if (name === "publish") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      const confirm = await page.getByRole("button", { name: "仅允许这次", exact: true }).boundingBox();
      check(confirm && confirm.x >= 0 && confirm.x + confirm.width <= 390 && confirm.y >= 0 && confirm.y + confirm.height <= 844, "窄屏发布审批按钮完整可见");
      check(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "窄屏审批无横向溢出");
      await page.screenshot({ path: `${OUT}/publish-approval-mobile.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(300);
    }
    await page.getByRole("button", { name: decision === "approved" ? "仅允许这次" : "拒绝", exact: true }).click(); await read;
    check(events.some(e => e.type === "done"), name + " 回传工具结果并完成回答");
    check(events.filter(e => e.part?.type === "tool").length === 1, name + " 原生重复调用只执行一次");
    check((await api(users[0], `/chat/sessions/${session.id}/approvals/${approval.id}`, { decision: "approved" })).status === 409, name + " 审批不可重放");
    return events;
  }
  const content = "这是仅存于隔离候选库的完整发帖内容。\n不会向生产社区发送。";
  await harness({ tool: "community", args: { action: "publish", data: { title: prefix, content, topic_id: created.topic } } }, "approved", "publish");
  const [[post]] = await pool.query("SELECT id,content,user_id FROM community_posts WHERE topic_id=?", [created.topic]); created.post = post.id;
  check(post.content === content && post.user_id === users[0].id, "发帖真实落库且作者为当前用户");
  check(seenTools.some(t => t.function?.name === "models") && !seenTools.some(t => t.function?.name === "system"), "模型收到可用新工具，普通用户不会收到管理工具");
  await harness({ tool: "community", args: { action: "comment", params: { id: post.id }, data: { content: "批准的指定帖评论" } } }, "approved", "comment");
  await harness({ tool: "community", args: { action: "comment", params: { id: post.id }, data: { content: "拒绝的评论不得入库" } } }, "denied", "denied");
  const [[comments]] = await pool.query("SELECT COUNT(*) n FROM community_comments WHERE post_id=?", [post.id]); check(Number(comments.n) === 1, "拒绝无副作用、重复调用没有重复评论");
  const posts = await tool(users[0], "community", { action: "posts", params: { q: prefix, sort: "new" } }); check(posts.ok && posts.output.includes(prefix), "工具可搜索最新帖子");
  check(!(await tool(users[1], "community", { action: "edit", params: { id: post.id }, data: { title: "不应成功" } }, true)).ok, "原路由阻止修改别人的帖子");
  const profile = await tool(users[0], "people", { action: "edit_profile", data: { bio: "工具资料测试" } }, true); check(profile.ok, "个人资料通过原路由更新");
  const request = await tool(users[0], "people", { action: "request", data: { to_user_id: users[1].id, message: "隔离测试" } }, true); check(request.ok, "好友申请真实送达");
  const [requests] = await pool.query("SELECT id FROM friend_requests WHERE from_user_id=? AND to_user_id=?", users.map(u => u.id));
  check((await tool(users[1], "people", { action: "respond", params: { id: requests[0].id }, data: { action: "accept" } }, true)).ok, "通过工具接受好友申请");
  const room = await tool(users[0], "messages", { action: "create", data: { type: "single", user_id: users[1].id } }, true); check(room.ok && room.value.id, "通过工具创建真实私聊"); created.room = room.value.id;
  check((await tool(users[0], "messages", { action: "send", params: { id: created.room }, data: { type: "text", content: "工具私信验收" } }, true)).ok, "消息工具发送到指定会话");
  check((await tool(users[1], "messages", { action: "history", params: { id: created.room } })).output.includes("工具私信验收"), "收件人能读取真实消息");
  const project = await tool(users[0], "workspace", { action: "create_project", data: { name: prefix } }, true); check(project.ok && project.value.id, "通过工具创建对话项目"); created.project = project.value.id;
  check((await tool(users[0], "workspace", { action: "edit_project", params: { id: created.project }, data: { name: prefix + "edit" } }, true)).ok, "项目修改落库");
  for (const [name, action] of [["notifications", "list"], ["usage", "records"], ["usage", "summary"], ["media", "list"], ["tokens", "reconcile"], ["workspace", "sessions"]]) check((await tool(users[0], name, { action })).ok, `${name}.${action} 读取真实路由`);
  await pool.query("UPDATE users SET status=2 WHERE id=?", [users[1].id]);
  check(!(await tool(users[1], "people", { action: "me" })).ok, "工具在执行时重新鉴权，已禁用账号不可读取");
  check(errors.length === 0, "真实审批页面无运行错误"); console.log(`平台 Agent 真实流程 ${checks} 项通过`);
} finally {
  await browser?.close();
  for (const id of sessions) await api(users[0], "/chat/sessions/" + id + "/stop", {}, "POST").catch(() => {});
  for (const id of sessions) await api(users[0], "/chat/sessions/" + id, undefined, "DELETE").catch(() => {});
  if (created.post) await api(admin, "/community/posts/" + created.post, undefined, "DELETE").catch(() => {});
  if (created.topic) await api(admin, "/community/topics/" + created.topic, undefined, "DELETE").catch(() => {});
  if (created.channel) await api(admin, "/channel/" + created.channel, undefined, "DELETE").catch(() => {});
  if (created.group) await api(admin, "/channel/groups/" + created.group, undefined, "DELETE").catch(() => {});
  for (const u of users) await api(admin, "/users/" + u.id, undefined, "DELETE").catch(() => {});
  await new Promise(r => upstream.close(r)); await pool.end();
}
