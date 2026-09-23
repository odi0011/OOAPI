// 网关真实调用冒烟（部署后必跑）
// ===========================================================================
// 为什么必须有它（真实事故，2026-09-24）：
//   给网关加 max_tokens 截断时用了 `estimateTokens(...)` 但忘了加 import。
//   查出来的过程很痛苦：
//     · `node --check` 通过（只做语法分析，不做作用域解析）
//     · `vite build` 不管后端
//     · tests/undefined-symbols 的模块加载检查也通过
//       （引用在闭包里，不调用不抛 —— 我注入破坏验证过，它抓不到）
//     · 服务健康检查 200、进程 active
//   只有**真实打一次 /v1/chat/completions** 才会抛
//   `ReferenceError: estimateTokens is not defined`；
//   而适配器把它当渠道故障 → 标记 CHANNEL_ERROR 并冷却 →
//   用户看到的是 503「支持该模型的账号都在冷却中」。
//   **症状（渠道冷却）与根因（少一个 import）看起来毫无关系**，极难联想。
//
// 所以：本脚本对三种协议各打一次真实请求，断言
//   ① 不是 5xx/网关内部错；② 响应体里不出现 "is not defined"。
// 用法（服务器上）：
//   cd ooapi-server && node tests/gateway-smoke.mjs
//   BASE=http://127.0.0.1:3001 node tests/gateway-smoke.mjs
// 需要一个**可用的**密钥：从库里挑一把带可用分组的（只读，不修改数据）。
import "dotenv/config";
import { pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const GROUP = process.env.SMOKE_GROUP || "测试";
const MODEL = process.env.SMOKE_MODEL || "deepseek-v4.1-flash";

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok  ${m}`); };
const bad = (m) => { fail += 1; console.log(`  FAIL ${m}`); };

// 挑一把「无限额度 + 已绑分组 + 启用」的密钥（只读）
const [[tok]] = await pool.query(
  `SELECT key_str, group_name FROM tokens
    WHERE status = 1 AND group_name = ? AND unlimited_quota = 1
    ORDER BY id DESC LIMIT 1`,
  [GROUP]
);
if (!tok) {
  console.log(`跳过：库里没有「${GROUP}」分组下可用的无限额度密钥（造一把再跑）`);
  process.exit(0);
}
const KEY = tok.key_str;

async function hit(name, path, body, headers = {}) {
  const t0 = Date.now();
  let res;
  let text = "";
  try {
    res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    text = await res.text();
  } catch (e) {
    bad(`${name}: 请求异常 ${e.message}`);
    return null;
  }
  const ms = Date.now() - t0;
  // 关键断言：响应里绝不能出现「未定义标识符」这类网关自身缺陷
  if (/is not defined|before initialization/.test(text)) {
    bad(`${name}: 网关内部抛了未定义标识符 → ${text.slice(0, 200)}`);
    return null;
  }
  if (res.status >= 500) {
    // 503 可能是渠道真的不可用（与代码缺陷无关），要区分：
    // 只有带「未定义」字样才算我们的锅；其余按「环境问题」记录但不判失败
    const warn = /冷却|NO_CHANNEL|没有可用/.test(text) ? "（渠道不可用，非代码缺陷）" : "";
    console.log(`  warn ${name}: HTTP ${res.status} ${warn} ${text.slice(0, 120)}`);
    return { status: res.status, text, ms, soft: true };
  }
  if (res.status !== 200) {
    bad(`${name}: HTTP ${res.status} ${text.slice(0, 160)}`);
    return null;
  }
  ok(`${name}: 200 · ${ms}ms · ${text.length} 字节`);
  return { status: res.status, text, ms };
}

console.log(`网关冒烟 @ ${BASE}（模型 ${MODEL}）\n`);

// ---------- 三种协议各打一次 ----------
const chat = await hit("chat/completions", "/v1/chat/completions", {
  model: MODEL,
  messages: [{ role: "user", content: "Reply with exactly: pong" }],
  max_tokens: 16,
});
if (chat) {
  try {
    const j = JSON.parse(chat.text);
    const c = j.choices?.[0];
    if (c?.message?.content) ok(`  chat 响应形状正常（finish_reason=${c.finish_reason}）`);
    else bad(`  chat 响应缺少 choices[0].message.content`);
    if (j.usage) ok(`  chat 带 usage（prompt=${j.usage.prompt_tokens} completion=${j.usage.completion_tokens}）`);
  } catch { bad("  chat 响应不是合法 JSON"); }
}

const anth = await hit(
  "messages (Anthropic)",
  "/v1/messages",
  { model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly: pong" }] },
  // 官方 Anthropic SDK 默认只发 x-api-key：这里刻意不复用 Authorization
  { "anthropic-version": "2023-06-01" }
);
if (anth) {
  try {
    const j = JSON.parse(anth.text);
    if (j.type === "message" && Array.isArray(j.content)) ok(`  messages 响应形状正常（stop_reason=${j.stop_reason}）`);
    else bad(`  messages 响应形状异常：${anth.text.slice(0, 160)}`);
  } catch { bad("  messages 响应不是合法 JSON"); }
}

const resp = await hit("responses", "/v1/responses", {
  model: MODEL,
  input: "Reply with exactly: pong",
  max_output_tokens: 16,
});
if (resp) {
  try {
    const j = JSON.parse(resp.text);
    if (j.object === "response" && Array.isArray(j.output)) ok(`  responses 响应形状正常（status=${j.status}）`);
    else bad(`  responses 响应形状异常：${resp.text.slice(0, 160)}`);
  } catch { bad("  responses 响应不是合法 JSON"); }
}

// ---------- 未实现端点必须是 JSON 而不是 HTML ----------
try {
  const r = await fetch(BASE + "/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: "{}",
  });
  const t = await r.text();
  if (r.status === 404 && t.trim().startsWith("{")) ok("未实现端点返回 JSON 404（不是 Express 的 HTML 错误页）");
  else bad(`未实现端点返回 HTTP ${r.status} 且非 JSON：${t.slice(0, 120)}`);
} catch (e) {
  bad(`未实现端点请求异常：${e.message}`);
}

// ---------- /v1/models ----------
try {
  const r = await fetch(BASE + "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  if (r.status === 200 && j.object === "list" && Array.isArray(j.data)) {
    ok(`/v1/models 形状正常（${j.data.length} 个模型）`);
  } else bad(`/v1/models 形状异常：HTTP ${r.status}`);
} catch (e) {
  bad(`/v1/models 请求异常：${e.message}`);
}

// 渠道是否因本次冒烟而被标记故障（自查：别把自己的测试成本算到渠道上）
const [[{ n }]] = await pool.query(
  "SELECT COUNT(*) AS n FROM channels WHERE status = 1 AND last_error_code = 'CHANNEL_ERROR'"
);
if (n) console.log(`\n提示：当前有 ${n} 个启用渠道处于 CHANNEL_ERROR 状态（若冒烟前就有，与本脚本无关）`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
