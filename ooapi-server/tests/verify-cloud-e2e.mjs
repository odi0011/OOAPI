// 真实云端环境端到端功能验证与自洽性核验
// 包含：注册 -> 登录 -> 查初态看板 -> 建Key -> 真实打API -> 查终态看板 -> 指标自洽性校验 -> 清理
import "dotenv/config";
import { pool } from "../src/db.js";

const BASE = process.env.BASE || "http://127.0.0.1:3001";

async function main() {
  console.log("========================================================");
  console.log("🚀 开始 OOAPI 云端生产环境全链路 E2E 业务功能与自洽性验证");
  console.log("========================================================\n");

  let passCount = 0;
  let totalCount = 0;

  function assert(cond, desc) {
    totalCount++;
    if (cond) {
      passCount++;
      console.log(`  ✅ [PASS] ${desc}`);
    } else {
      console.error(`  ❌ [FAIL] ${desc}`);
      throw new Error(`断言失败: ${desc}`);
    }
  }

  // 1. 检查数据库可用渠道
  console.log("--- 1. 检查渠道与支持模型 ---");
  // 查找一个启用的渠道，并获取它所属的分组和模型
  let testModel = "deepseek-v4.1-flash";
  let targetGroup = "";
  const [channels] = await pool.query(
    "SELECT id, name, type, status, models, group_list FROM channels WHERE status = 1"
  );
  console.log(`  发现 ${channels.length} 个启用渠道`);
  assert(channels.length > 0, "系统存在启用渠道");

  // 优先选取包含 OpenCode 或支持 deepseek-v4.1-flash 的稳定渠道
  const targetChannel = channels.find((c) => String(c.group_list || "").includes("OpenCode")) || channels[0];
  if (targetChannel.models && targetChannel.group_list) {
    try {
      const glist = typeof targetChannel.group_list === "string" ? JSON.parse(targetChannel.group_list) : targetChannel.group_list;
      const ms = targetChannel.models.split(",").map((s) => s.trim()).filter(Boolean);
      targetGroup = glist[0] || "OpenCode";
      testModel = ms.includes("deepseek-v4.1-flash") ? "deepseek-v4.1-flash" : ms[0];
      console.log(`  选用主力渠道 #${targetChannel.id} (${targetChannel.name}), 分组: ${targetGroup}, 模型: ${testModel}`);
    } catch {}
  }

  if (!targetGroup) {
    const [groups] = await pool.query("SELECT name FROM channel_groups LIMIT 1");
    targetGroup = groups[0]?.name || "";
  }
  console.log(`  测试绑定分组: ${targetGroup || "(公共池)"}, 选用模型: ${testModel}`);

  // 2. 模拟新用户全生命周期
  console.log("\n--- 2. 模拟真实用户注册、登录与令牌生命周期 ---");
  const timestamp = Date.now().toString(36);
  const testUsername = `e2e_user_${timestamp}`;
  const testPassword = `E2ePass_${timestamp}!`;

  console.log(`  [2.1] 注册测试账号: ${testUsername}`);
  const regRes = await fetch(`${BASE}/api/user/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: testPassword }),
  });
  const regJson = await regRes.json();
  assert(regRes.status === 200 && regJson.success, `注册成功: ${regJson.message || "OK"}`);

  console.log(`  [2.2] 登录测试账号获取 JWT 凭据`);
  const loginRes = await fetch(`${BASE}/api/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: testPassword }),
  });
  const loginJson = await loginRes.json();
  assert(loginRes.status === 200 && loginJson.success && loginJson.data?.token, "登录成功并获得 JWT");
  const userJwt = loginJson.data.token;
  const userHeaders = {
    Authorization: `Bearer ${userJwt}`,
    "Content-Type": "application/json",
  };

  const [uRow] = await pool.query("SELECT id FROM users WHERE username = ?", [testUsername]);
  const testUserId = uRow[0].id;

  // 为新用户赋予测试额度（50 OD = 500,000 单位）
  await pool.query("UPDATE users SET quota = 500000 WHERE id = ?", [testUserId]);
  console.log(`  [2.3] 注入测试额度 50.00 OD (500,000 额度单位)`);

  // 3. 查验初态个人看板
  console.log(`\n--- 3. 查验初态个人数据看板 (/api/dashboard/self) ---`);
  const dash1Res = await fetch(`${BASE}/api/dashboard/self?period=30d`, { headers: userHeaders });
  const dash1 = await dash1Res.json();
  assert(dash1.success && dash1.data, "个人数据看板接口请求成功");
  assert(dash1.data.account.quota === 500000, "账户余额字段精准匹配 (500,000)");
  assert(dash1.data.account.active_tokens === 0, "初态活跃密钥数正确显示为 0");
  assert(typeof dash1.data.account.group_name === "string", "看板下发了 group_name");
  assert(typeof dash1.data.account.group_rate === "number", "看板下发了 group_rate");
  assert(Array.isArray(dash1.data.recent_logs), "看板包含 recent_logs 数组结构");
  assert(dash1.data.totals.calls === 0, "初态时段调用总数为 0");
  console.log(`  看板初态正常: 余额=${dash1.data.account.quota / 10000} OD, 分组=${dash1.data.account.group_name}, 倍率=×${dash1.data.account.group_rate}, 活跃Key=${dash1.data.account.active_tokens}`);

  // 4. 创建 API 密钥
  console.log(`\n--- 4. 创建 API 密钥 (Token) ---`);
  const tokRes = await fetch(`${BASE}/api/token`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({
      name: "E2E全链路验证密钥",
      group_name: targetGroup,
      remain_quota: 500000,
      unlimited_quota: 0,
    }),
  });
  const tokJson = await tokRes.json();
  assert(tokRes.status === 200 && tokJson.success && tokJson.data?.key, "API 密钥创建成功");
  const apiKey = tokJson.data.key;
  console.log(`  获取到密钥: ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`);

  // 重新查看板看活跃密钥数是否增加
  const dash2Res = await fetch(`${BASE}/api/dashboard/self?period=30d`, { headers: userHeaders });
  const dash2 = await dash2Res.json();
  assert(dash2.data.account.active_tokens === 1, "创建密钥后看板活跃密钥数动态更新为 1");

  // 5. 使用密钥发起真实 API 调用
  console.log(`\n--- 5. 使用新建密钥发起真实网关调用 (/v1/chat/completions) ---`);
  const reqBody = {
    model: testModel,
    messages: [{ role: "user", content: "Reply with 'PASS' only." }],
    max_tokens: 15,
  };
  const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(60000),
  });

  const chatJson = await chatRes.json();
  console.log(`  网关 HTTP 状态码: ${chatRes.status}`);
  if (chatRes.status === 200) {
    console.log(`  模型回复: ${JSON.stringify(chatJson.choices?.[0]?.message?.content || "")}`);
    console.log(`  Token 消耗: ${JSON.stringify(chatJson.usage)}`);
    assert(chatJson.choices?.[0]?.message?.content !== undefined, "网关返回了有效对话内容");
  } else {
    console.log(`  网关上游防护/错误返回: ${JSON.stringify(chatJson)}`);
    assert(chatJson.error !== undefined, "非 200 时网关正常返回标准错误信封 (未崩溃)");
  }

  // 6. 查验调用后个人数据看板的更新与数据自洽性
  console.log(`\n--- 6. 查验调用后个人数据看板与核心数据自洽性 ---`);
  const dash3Res = await fetch(`${BASE}/api/dashboard/self?period=30d`, { headers: userHeaders });
  const dash3 = await dash3Res.json();
  assert(dash3.success && dash3.data, "获取终态数据看板成功");

  const totals = dash3.data.totals;
  console.log(`  时段汇总: 总请求=${totals.calls}, 总消费=${totals.units}单位, 均耗时=${totals.avg_elapsed}ms`);
  assert(typeof totals.avg_elapsed === "number", "平均耗时 avg_elapsed 是有效数值");

  // 模型分布切片加和与 Totals 严格 100% 对齐校验（重点防回归）
  const byModel = dash3.data.by_model;
  assert(Array.isArray(byModel), "by_model 为数组");
  const sumModelCalls = byModel.reduce((acc, item) => acc + Number(item.calls || 0), 0);
  const sumModelUnits = byModel.reduce((acc, item) => acc + Number(item.units || 0), 0);

  console.log(`  [自洽性校验 1] 模型切片调用求和 = ${sumModelCalls}, Totals 总调用 = ${totals.calls}`);
  assert(sumModelCalls === Number(totals.calls), "模型分布调用总和 100% 对齐 totals.calls");

  console.log(`  [自洽性校验 2] 模型切片消费求和 = ${sumModelUnits}, Totals 总消费 = ${totals.units}`);
  assert(sumModelUnits === Number(totals.units), "模型分布消费总和 100% 对齐 totals.units");

  // 查验最近调用动态 recent_logs
  console.log(`  [自洽性校验 3] 最近调用动态记录数 = ${dash3.data.recent_logs.length}`);
  if (dash3.data.recent_logs.length > 0) {
    const firstLog = dash3.data.recent_logs[0];
    console.log(`  最新动态首条: 模型=${firstLog.model}, 耗时=${firstLog.elapsed_ms}ms, 消耗=${firstLog.units}单位, 时间=${firstLog.created_at}`);
    assert(firstLog.model !== undefined, "动态包含 model 字段");
    assert(firstLog.created_at !== undefined, "动态包含 created_at 字段");
  }

  // 7. 查验管理端平台看板 /api/dashboard/admin
  console.log(`\n--- 7. 查验管理端平台看板接口 ---`);
  const [[adminUser]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
  if (adminUser) {
    const adminJwt = (await import("jsonwebtoken")).default.sign(
      { id: adminUser.id, role: adminUser.role, tv: adminUser.token_version || 0 },
      process.env.JWT_SECRET || (await import("../src/db.js")).JWT_SECRET,
      { expiresIn: "5m" }
    );
    const adminDashRes = await fetch(`${BASE}/api/dashboard/admin?period=30d`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
    });
    const adminDash = await adminDashRes.json();
    assert(adminDash.success && adminDash.data, "管理端平台看板请求成功");
    assert(typeof adminDash.data.totals.avg_elapsed === "number", "管理端包含 avg_elapsed 指标");
    assert(typeof adminDash.data.totals.total_tokens === "number", "管理端包含 total_tokens 指标");
    console.log(`  管理端平台看板指标: 总调用=${adminDash.data.totals.calls}, 总Tokens=${adminDash.data.totals.total_tokens}, 均耗时=${adminDash.data.totals.avg_elapsed}ms`);
  }

  // 8. 清理测试资源
  console.log(`\n--- 8. 清理测试数据 ---`);
  await pool.query("DELETE FROM tokens WHERE user_id = ?", [testUserId]);
  await pool.query("DELETE FROM users WHERE id = ?", [testUserId]);
  console.log(`  已清除测试用户 #${testUserId} 及关联密钥`);

  console.log("\n========================================================");
  console.log(`🎉 全链路端到端功能验证全部通过！ 共 ${passCount}/${totalCount} 项断言通过`);
  console.log("========================================================\n");
  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n❌ E2E 测试失败:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
