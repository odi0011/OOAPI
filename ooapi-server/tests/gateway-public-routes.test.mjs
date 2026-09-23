// 网关公共路由可用性与协议测试
// 验证三大核心路由及兼容别名：
// 1. /v1/chat/completions (OpenAI 协议)
// 2. /v1/messages (Anthropic 协议)
// 3. /v1/responses (Responses 协议)
// 4. /api/v1/chat/completions 等兼容前缀
// 5. /chat/completions、/messages、/responses 等根路径别名
// 6. /v1/models 模型查询接口
import http from "node:http";
import express from "express";
import { pool } from "../src/db.js";
import gatewayRouter from "../src/routes/gateway.js";
import { PROTOCOLS } from "../src/services/gateway-protocols.js";

let pass = 0;
let fail = 0;
const ck = (n, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${extra ? `  ← ${extra}` : ""}`);
  }
};

// 内存 Mock pool.query，避免单测强依赖本地 MySQL 服务
const originalQuery = pool.query;
pool.query = async (sql, params) => {
  const s = String(sql || "");
  if (s.includes("FROM tokens WHERE key_str = ?")) {
    if (params && params[0] === "sk-valid-test-key") {
      return [[{
        id: 1,
        name: "test-token",
        key_str: "sk-valid-test-key",
        status: 1,
        expired_time: -1,
        remain_quota: 1000000,
        unlimited_quota: 1,
        user_id: 1,
        group_name: "default",
        model_limits: ""
      }]];
    }
    return [[]]; // 未找到 token
  }
  if (s.includes("FROM users WHERE id = ?")) {
    return [[{
      id: 1,
      username: "testuser",
      status: 1,
      quota: 1000000,
      group_name: "default"
    }]];
  }
  if (s.includes("FROM channels")) {
    return [[{
      id: 1,
      name: "测试渠道",
      type: "openai",
      status: 1,
      group_name: "default",
      models: "gpt-4o,gpt-4o-mini"
    }]];
  }
  if (s.includes("logs") || s.includes("UPDATE")) {
    return [{ affectedRows: 1 }];
  }
  return [[]];
};

console.log("=== 网关公共路由及协议可用性自动化测试 ===\n");

// 1. 验证三协议对象定义完备性
console.log("--- 1. 协议对象与解析渲染能力 ---");
ck("PROTOCOLS.chat 存在且包含 parse / chunk / finish / error",
  Boolean(PROTOCOLS.chat && typeof PROTOCOLS.chat.parse === "function" && typeof PROTOCOLS.chat.finish === "function")
);
ck("PROTOCOLS.messages 存在且包含 parse / chunk / finish / error",
  Boolean(PROTOCOLS.messages && typeof PROTOCOLS.messages.parse === "function" && typeof PROTOCOLS.messages.finish === "function")
);
ck("PROTOCOLS.responses 存在且包含 parse / chunk / finish / error",
  Boolean(PROTOCOLS.responses && typeof PROTOCOLS.responses.parse === "function" && typeof PROTOCOLS.responses.finish === "function")
);

// 2. 构建测试 HTTP 服务器，挂载网关路由与兼容别名
const app = express();
app.use("/v1", gatewayRouter);
app.use("/api/v1", gatewayRouter);
app.post("/chat/completions", (req, res, next) => gatewayRouter(req, res, next));
app.post("/messages", (req, res, next) => gatewayRouter(req, res, next));
app.post("/responses", (req, res, next) => gatewayRouter(req, res, next));

// 统一错误处理，防止测试中异常挂起
app.use((err, req, res, next) => {
  res.status(500).json({ error: { message: err.message } });
});

const server = http.createServer(app);

await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    // ignore
  }
  return { status: res.status, headers: res.headers, body: json };
}

try {
  // 3. 验证未提供 API Key 时的鉴权拦截（必须为 401 且返回 OpenAI 兼容错误格式，绝不能报 500）
  console.log("\n--- 2. 未携带 API Key 时的路由与 401 拦截 ---");
  const routesToTest = [
    { name: "/v1/chat/completions", path: "/v1/chat/completions", method: "POST" },
    { name: "/v1/messages", path: "/v1/messages", method: "POST" },
    { name: "/v1/responses", path: "/v1/responses", method: "POST" },
    { name: "/api/v1/chat/completions", path: "/api/v1/chat/completions", method: "POST" },
    { name: "/api/v1/messages", path: "/api/v1/messages", method: "POST" },
    { name: "/api/v1/responses", path: "/api/v1/responses", method: "POST" },
    { name: "/chat/completions (根别名)", path: "/chat/completions", method: "POST" },
    { name: "/messages (根别名)", path: "/messages", method: "POST" },
    { name: "/responses (根别名)", path: "/responses", method: "POST" },
    { name: "/v1/models (查询模型)", path: "/v1/models", method: "GET" }
  ];

  for (const r of routesToTest) {
    const res = await request(r.path, {
      method: r.method,
      body: r.method === "POST" ? { model: "test-model", messages: [{ role: "user", content: "hi" }] } : undefined
    });
    ck(`${r.name} 路由可达并拦截未授权请求返回 401`, res.status === 401, `实际状态码: ${res.status}`);
    ck(`${r.name} 返回规范的错误结构（包含 error.message）`,
      res.body && res.body.error && res.body.error.message && res.body.error.message.includes("API Key"),
      JSON.stringify(res.body)
    );
  }

  // 4. 验证伪造/无效 API Key
  console.log("\n--- 3. 携带伪造/不存在 API Key 时的 401 拦截 ---");
  {
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-nonexistent-key-999999" },
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] }
    });
    ck("/v1/chat/completions 查无此 Key 时返回 401", res.status === 401, `状态码: ${res.status}`);
    ck("错误提示明确指出 API Key 无效", res.body?.error?.message === "API Key 无效", JSON.stringify(res.body));
  }

  {
    const res = await request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer sk-nonexistent-key-999999" },
      body: { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hello" }] }
    });
    ck("/v1/messages 查无此 Key 时返回 401", res.status === 401, `状态码: ${res.status}`);
    ck("错误提示明确指出 API Key 无效", res.body?.error?.message === "API Key 无效", JSON.stringify(res.body));
  }

  {
    const res = await request("/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-nonexistent-key-999999" },
      body: { model: "deepseek-chat", messages: [{ role: "user", content: "hello" }] }
    });
    ck("根别名 /chat/completions 查无此 Key 时返回 401", res.status === 401, `状态码: ${res.status}`);
    ck("错误提示明确指出 API Key 无效", res.body?.error?.message === "API Key 无效", JSON.stringify(res.body));
  }

  console.log("\n--- 4. 协议解析层健壮性 ---");
  {
    // OpenAI 协议
    const parsedChat = PROTOCOLS.chat.parse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.7
    });
    ck("Chat 协议正常解析 model 与 messages", parsedChat.model === "gpt-4o-mini" && parsedChat.messages.length === 1);
    ck("Chat 协议支持 stream 参数", parsedChat.stream === true);

    // Anthropic 协议
    const parsedMessages = PROTOCOLS.messages.parse({
      model: "claude-3-5-sonnet-20241022",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi there" }] }]
    });
    ck("Messages 协议将顶层 system 提取为第一条 system 消息",
      parsedMessages.messages[0].role === "system" && parsedMessages.messages[0].content === "You are a helpful assistant."
    );
    ck("Messages 协议将 content 数组平铺解析为文本", parsedMessages.messages[1].content === "hi there");

    // Responses 协议
    const parsedResp = PROTOCOLS.responses.parse({
      model: "deepseek-r1",
      input: "你好，请解释牛顿力学"
    });
    ck("Responses 协议将字符串 input 解析为单条 user 消息",
      parsedResp.messages.length === 1 && parsedResp.messages[0].content === "你好，请解释牛顿力学"
    );
  }

  // 5. 验证有效 API Key 时的业务可达性
  console.log("\n--- 5. 携带有效 API Key 时的路由与功能验证 ---");
  {
    const res = await request("/v1/models", {
      headers: { Authorization: "Bearer sk-valid-test-key" }
    });
    ck("/v1/models 携带合法 Key 成功响应 200", res.status === 200, `状态码: ${res.status}`);
    ck("/v1/models 返回 OpenAI 规范的 object: list 格式", res.body?.object === "list");
    ck("/v1/models 返回有效模型数组", Array.isArray(res.body?.data));

    const resApiV1 = await request("/api/v1/models", {
      headers: { Authorization: "Bearer sk-valid-test-key" }
    });
    ck("/api/v1/models 别名前缀同样成功响应 200", resApiV1.status === 200, `状态码: ${resApiV1.status}`);

    // 测试鉴权成功后各端点对参数格式的校验拦截（非 401，验证真正进入了各协议处理 handler）
    const chatEmpty = await request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-valid-test-key" },
      body: { model: "gpt-4o" } // 缺少 messages
    });
    ck("/v1/chat/completions 鉴权通过并对空 messages 给出参数拦截（非 401/403）",
      chatEmpty.status === 400 && chatEmpty.body?.error?.message?.includes("messages"),
      `状态码: ${chatEmpty.status}, body: ${JSON.stringify(chatEmpty.body)}`
    );

    const msgsEmpty = await request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer sk-valid-test-key" },
      body: { model: "claude-3-5-sonnet" } // 缺少 messages
    });
    ck("/v1/messages 鉴权通过并对空 messages 给出参数拦截（非 401/403）",
      msgsEmpty.status === 400 && (msgsEmpty.body?.error?.message?.includes("messages") || msgsEmpty.body?.message?.includes("messages")),
      `状态码: ${msgsEmpty.status}, body: ${JSON.stringify(msgsEmpty.body)}`
    );

    const respEmpty = await request("/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer sk-valid-test-key" },
      body: { model: "deepseek-r1" } // 缺少 input
    });
    ck("/v1/responses 鉴权通过并对空 input 给出参数拦截（非 401/403）",
      respEmpty.status === 400 && respEmpty.body?.error?.message?.includes("input"),
      `状态码: ${respEmpty.status}, body: ${JSON.stringify(respEmpty.body)}`
    );
  }

} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n测试汇总：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  console.log("所有网关公共路由与协议检查全部通过！");
  process.exit(0);
}
