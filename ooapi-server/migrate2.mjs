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
const now = Math.floor(Date.now() / 1000);

// ---------- 1. 模型价格 ----------
// 注意：这里**不再写入任何价格**。
// 历史教训：本文件早期版本会在每次在线更新时用 ON DUPLICATE KEY UPDATE
// 覆盖 model_prices，把管理员改过的价格、渠道类型、来源说明全部冲掉，
// 甚至把已删除的虚构模型（deepseek-vision 等）重新插回来。
// 内置价目统一由启动流程的 seedDefaultPrices() 维护：只补缺失，绝不覆盖。
log.push("SKIP  模型价格由启动流程 seedDefaultPrices() 统一维护（本文件不再写入）");

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

// ---------- 3. 额度换算：旧「500000 额度 = $1」→ 新「10000 额度 = 1 OD 币（=$1）」----------
// 关键：这是**一次性**迁移。旧实现每次执行都会再除 50，导致上线几次后用户额度被反复缩小
// （本环境曾实际发生：余额被除了数次 50）。这里用「币制设置」判断是否已换算过：
// quota_per_unit 已是 10000 就说明新币制已生效，绝不再换算。
const UNITS_PER_OD = 10000;
const OLD_PER_USD = 500000;
const [[curUnit]] = await pool.query("SELECT value FROM options WHERE key_str = 'quota_per_unit' LIMIT 1");
if (String(curUnit?.value || "") === String(UNITS_PER_OD)) {
  log.push("SKIP  额度已是 OD 币制（10000/OD），一次性换算不再重复执行");
} else {
  const [[{ converted }]] = await pool.query(`SELECT COUNT(*) AS converted FROM users WHERE quota > 0`);
  await pool.query(
    `UPDATE users SET quota = ROUND(quota / ? * ?), used_quota = ROUND(used_quota / ? * ?)`,
    [OLD_PER_USD, UNITS_PER_OD, OLD_PER_USD, UNITS_PER_OD]
  );
  // 令牌额度同步换算
  await pool.query(
    `UPDATE tokens SET remain_quota = ROUND(remain_quota / ? * ?), used_quota = ROUND(used_quota / ? * ?)
     WHERE unlimited_quota = 0`,
    [OLD_PER_USD, UNITS_PER_OD, OLD_PER_USD, UNITS_PER_OD]
  );
  log.push(`OK    额度已换算为 OD 币（1 OD = ${UNITS_PER_OD} 单位），涉及 ${converted} 个用户；令牌已同步`);
}

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
