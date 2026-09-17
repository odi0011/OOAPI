// 数据迁移 + 价格种子：DeepSeek 账号 → 渠道；额度换算为 OD 币；写入模型价格
// 幂等：可重复执行。
import mysql from "mysql2/promise";
import "dotenv/config";

const pool = await mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "ooapi",
  password: process.env.DB_PASSWORD || "ooapi",
  database: process.env.DB_NAME || "ooapi",
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
});

const log = [];

// ---------- 1. 模型价格种子 ----------
const PRICES = [
  // DeepSeek（官方，高峰价；非高峰减半）
  ["deepseek-chat", 0.30, 1.20, 0.006, "deepseek", "V4.1-Flash 档，官方高峰价"],
  ["deepseek-reasoner", 0.30, 1.20, 0.006, "deepseek", "深度思考，思考 token 计入输出"],
  ["deepseek-vision", 0.30, 1.20, 0.006, "deepseek", "看图"],
  ["deepseek-vision-thinker", 0.30, 1.20, 0.006, "deepseek", "看图 + 深度思考"],
  ["deepseek-flash", 0.30, 1.20, 0.006, "deepseek", "V4.1-Flash 官方 id"],
  ["deepseek-v4-pro", 1.32, 3.96, 0.044, "deepseek", "V4-Pro 官方 id，高峰价"],
  // OpenAI（官方页 403，采用挂牌价，需复核）
  ["gpt-4o", 2.50, 10.00, 1.25, "openai", "官方页不可达，采用挂牌价"],
  ["gpt-4o-mini", 0.15, 0.60, 0.075, "openai", "同上"],
  ["gpt-5", 1.25, 10.00, 0.125, "openai", "同上"],
  ["gpt-5-mini", 0.25, 2.00, 0.025, "openai", "同上"],
  ["gpt-5-nano", 0.05, 0.40, 0.005, "openai", "同上"],
  ["o3", 2.00, 8.00, 0.50, "openai", "同上"],
  ["o4-mini", 1.10, 4.40, 0.275, "openai", "同上"],
  // Anthropic（官方）
  ["claude-opus-5", 5.00, 25.00, 0.50, "claude", "官方定价页"],
  ["claude-sonnet-5", 2.00, 10.00, 0.20, "claude", "官方定价页"],
  ["claude-haiku-4.5", 1.00, 5.00, 0.10, "claude", "官方定价页"],
  // Gemini（官方页超时，挂牌价）
  ["gemini-3.5-flash", 1.50, 9.00, 0.15, "gemini", "官方页超时，采用挂牌价"],
  ["gemini-2.5-pro", 1.25, 10.00, 0.125, "gemini", "同上"],
  ["gemini-2.5-flash", 0.30, 2.50, 0.03, "gemini", "同上"],
  // 通义千问（官方 CNY ÷ 7.3）
  ["qwen3-max", 0.342, 1.370, 0.034, "qwen", "¥2.5/¥10 按 7.3 换算"],
  ["qwen-max", 0.329, 1.315, 0, "qwen", "¥2.4/¥9.6 按 7.3 换算"],
  ["qwen-plus", 0.110, 0.274, 0, "qwen", "¥0.8/¥2 按 7.3 换算"],
  ["qwen-turbo", 0.041, 0.082, 0, "qwen", "¥0.3/¥0.6 按 7.3 换算"],
  // 月之暗面（官方 CNY ÷ 7.3）
  ["kimi-k3", 2.740, 13.699, 0.274, "custom", "¥20/¥100 按 7.3 换算"],
  ["kimi-k2.6", 0.890, 3.699, 0.151, "custom", "¥6.5/¥27 按 7.3 换算"],
  // 智谱（官方 USD）
  ["glm-5.3", 1.40, 4.40, 0.26, "custom", "官方定价页"],
  ["glm-5.3-flash", 0.15, 0.50, 0.03, "custom", "官方定价页"],
  ["glm-4.7", 0.60, 2.20, 0.11, "custom", "官方定价页"],
];

const now = Math.floor(Date.now() / 1000);
for (const [model, input, output, cache, type, remark] of PRICES) {
  await pool.query(
    `INSERT INTO model_prices (model, input_price, output_price, cache_price, channel_type, remark, updated_time)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE input_price=VALUES(input_price), output_price=VALUES(output_price),
       cache_price=VALUES(cache_price), channel_type=VALUES(channel_type), remark=VALUES(remark), updated_time=VALUES(updated_time)`,
    [model, input, output, cache, type, remark, now]
  );
}
log.push(`OK    模型价格已写入 ${PRICES.length} 条`);

// ---------- 1b. channels 表补充 last_error 列（记录运行期异常原因）----------
const [hasErrCol] = await pool.query(
  "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'channels' AND column_name = 'last_error'"
);
if (!hasErrCol[0].c) {
  await pool.query("ALTER TABLE channels ADD COLUMN last_error VARCHAR(500) NOT NULL DEFAULT ''");
  log.push('OK    channels 表新增 last_error 列');
} else {
  log.push('SKIP  channels.last_error 已存在');
}

// ---------- 2. DeepSeek 账号 → 渠道 ----------
const [hasOld] = await pool.query(
  "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'deepseek_accounts'"
);
if (hasOld[0].c > 0) {
  const [accounts] = await pool.query("SELECT * FROM deepseek_accounts");
  let migrated = 0;
  for (const a of accounts) {
    const [dup] = await pool.query(
      "SELECT id FROM channels WHERE type = 'deepseek' AND api_key = ? LIMIT 1",
      [a.token]
    );
    if (dup.length) continue;
    await pool.query(
      `INSERT INTO channels (name, type, base_url, api_key, models, group_name, status, priority, weight, other, created_time)
       VALUES (?, 'deepseek', 'https://chat.deepseek.com', ?, ?, 'default', ?, 0, 1, ?, ?)`,
      [
        a.name || `DeepSeek-${a.id}`,
        a.token,
        "deepseek-chat,deepseek-reasoner,deepseek-vision,deepseek-vision-thinker,deepseek-chat-search,deepseek-reasoner-search",
        a.status === 2 ? 2 : 1,
        JSON.stringify({ cookies: a.cookies ? JSON.parse(a.cookies || "[]") : [] }),
        a.created_time || now,
      ]
    );
    migrated++;
  }
  log.push(`OK    DeepSeek 账号迁移为渠道：${migrated} 个（原 ${accounts.length} 个）`);
  await pool.query("DROP TABLE deepseek_accounts");
  log.push("OK    已删除 deepseek_accounts 表（收敛为渠道）");
} else {
  log.push("SKIP  deepseek_accounts 表不存在（无需迁移）");
}

// ---------- 3. 额度换算：旧「500000 额度 = $1」→ 新「10000 额度 = 1 OD 币（=$1）」 ----------
const UNITS_PER_OD = 10000;
const OLD_PER_USD = 500000;
const [[{ converted }]] = await pool.query(
  `SELECT COUNT(*) AS converted FROM users WHERE quota > 0`
);
await pool.query(
  `UPDATE users SET quota = ROUND(quota / ? * ?), used_quota = ROUND(used_quota / ? * ?)`,
  [OLD_PER_USD, UNITS_PER_OD, OLD_PER_USD, UNITS_PER_OD]
);
const [urows] = await pool.query("SELECT id, username, quota, used_quota FROM users");
log.push(`OK    额度已换算为 OD 币（1 OD = $1，1 OD = ${UNITS_PER_OD} 单位），涉及 ${converted} 个用户`);
for (const u of urows) {
  log.push(`      #${u.id} ${u.username}: ${(u.quota / UNITS_PER_OD).toFixed(2)} OD（已用 ${(u.used_quota / UNITS_PER_OD).toFixed(4)} OD）`);
}

// 令牌额度同步换算
await pool.query(
  `UPDATE tokens SET remain_quota = ROUND(remain_quota / ? * ?), used_quota = ROUND(used_quota / ? * ?)
   WHERE unlimited_quota = 0`,
  [OLD_PER_USD, UNITS_PER_OD, OLD_PER_USD, UNITS_PER_OD]
);
log.push("OK    令牌额度已同步换算（仅限定额度令牌）");

// ---------- 4. 系统设置：币种与换算 ----------
const opts = [
  ["quota_per_unit", String(UNITS_PER_OD)],
  ["currency_name", "OD"],
  ["currency_symbol", "OD"],
  ["usd_rate", "1"],
  ["general_setting_quota_display", "true"],
];
for (const [k, v] of opts) {
  await pool.query(
    "INSERT INTO options (key_str, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [k, v]
  );
}
log.push("OK    系统设置已更新为 OD 币 1:1");

console.log(log.join("\n"));
await pool.end();
