import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const host = process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || "ooapi";
const password = process.env.DB_PASSWORD || "ooapi";
const database = process.env.DB_NAME || "ooapi";

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  // 上游请求常达分钟级，连接会被长时间占用；10 个连接在高并发下容易排队。
  // 可用 DB_POOL_SIZE 覆盖（默认 50）。
  connectionLimit: Math.max(2, Number(process.env.DB_POOL_SIZE) || 50),
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
});

const TABLES = [
  `CREATE TABLE IF NOT EXISTS model_prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model VARCHAR(128) NOT NULL UNIQUE COMMENT '模型 id',
    input_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '输入价格 OD币/百万token',
    output_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '输出价格 OD币/百万token',
    cache_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '缓存命中价格 OD币/百万token',
    channel_type VARCHAR(32) NOT NULL DEFAULT '' COMMENT '典型渠道类型',
    remark VARCHAR(255) NOT NULL DEFAULT '' COMMENT '价格来源说明',
    updated_time BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(128) NOT NULL,
    display_name VARCHAR(64) DEFAULT '',
    email VARCHAR(128) DEFAULT '',
    role INT NOT NULL DEFAULT 1 COMMENT '1=普通用户 100=管理员',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用',
    quota BIGINT NOT NULL DEFAULT 0,
    used_quota BIGINT NOT NULL DEFAULT 0,
    request_count INT NOT NULL DEFAULT 0,
    aff_code VARCHAR(32) UNIQUE,
    inviter_id INT NOT NULL DEFAULT 0,
    group_name VARCHAR(32) NOT NULL DEFAULT 'default',
    setting TEXT,
    created_time BIGINT NOT NULL DEFAULT 0,
    last_login_time BIGINT NOT NULL DEFAULT 0,
    last_login_ip VARCHAR(64) DEFAULT '',
    login_count INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(64) NOT NULL DEFAULT '',
    key_str VARCHAR(64) NOT NULL UNIQUE COMMENT 'sk-xxxx 格式的 API Key',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用 3=过期',
    created_time BIGINT NOT NULL DEFAULT 0,
    accessed_time BIGINT NOT NULL DEFAULT 0,
    expired_time BIGINT NOT NULL DEFAULT -1 COMMENT '-1 表示永不过期',
    remain_quota BIGINT NOT NULL DEFAULT 0,
    unlimited_quota TINYINT NOT NULL DEFAULT 1,
    used_quota BIGINT NOT NULL DEFAULT 0,
    model_limits TEXT,
    group_name VARCHAR(32) DEFAULT '',
    INDEX idx_tokens_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    username VARCHAR(64) DEFAULT '',
    created_at BIGINT NOT NULL DEFAULT 0,
    type INT NOT NULL DEFAULT 2 COMMENT '1=充值 2=消费 3=管理 4=错误 5=登录',
    content TEXT,
    detail TEXT,
    ip VARCHAR(64) DEFAULT '',
    request_id VARCHAR(64) DEFAULT '',
    quota BIGINT NOT NULL DEFAULT 0,
    INDEX idx_logs_user (user_id),
    INDEX idx_logs_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS options (
    key_str VARCHAR(64) PRIMARY KEY,
    value TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT '',
    type VARCHAR(32) NOT NULL DEFAULT 'openai' COMMENT 'openai/claude/gemini/deepseek/qwen/custom',
    base_url VARCHAR(255) NOT NULL DEFAULT '' COMMENT '上游接口地址',
    api_key TEXT COMMENT '上游密钥（多 Key 用换行分隔）',
    models TEXT COMMENT '支持的模型，逗号分隔',
    group_name VARCHAR(64) NOT NULL DEFAULT 'default' COMMENT '用户分组',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=手动禁用 3=自动禁用',
    priority INT NOT NULL DEFAULT 0 COMMENT '调度优先级，越大越优先',
    weight INT NOT NULL DEFAULT 0 COMMENT '同优先级负载权重',
    response_time INT NOT NULL DEFAULT 0 COMMENT '最近测试耗时 ms',
    tested_time BIGINT NOT NULL DEFAULT 0 COMMENT '最近测试时间戳',
    other TEXT COMMENT '扩展配置 JSON',
    remark VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注',
    auto_ban TINYINT NOT NULL DEFAULT 1 COMMENT '1=测试失败自动禁用',
    test_model VARCHAR(128) NOT NULL DEFAULT '' COMMENT '测试用模型',
    last_error VARCHAR(500) NOT NULL DEFAULT '' COMMENT '最近错误信息',
    used_count INT NOT NULL DEFAULT 0 COMMENT '累计调用次数',
    last_used_time BIGINT NOT NULL DEFAULT 0 COMMENT '最近调用时间',
    created_time BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS deepseek_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT '',
    token TEXT NOT NULL COMMENT 'DeepSeek 网页版登录态 userToken',
    cookies TEXT COMMENT '浏览器 cookies JSON 数组，用于对齐设备指纹',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用 3=异常(风控隔离/失效)',
    mute_until BIGINT NOT NULL DEFAULT 0 COMMENT '隔离到期时间戳(秒)，0 表示无',
    used_count INT NOT NULL DEFAULT 0,
    last_used_time BIGINT NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_ds_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// 生成 / 持久化 JWT 密钥：环境变量 > .jwt-secret 文件 > 随机生成
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = path.join(process.cwd(), ".jwt-secret");
  try {
    const s = fs.readFileSync(secretFile, "utf8").trim();
    if (s) return s;
  } catch {
    /* ignore */
  }
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(secretFile, s, { mode: 0o600 });
  } catch {
    /* ignore */
  }
  return s;
}

export const JWT_SECRET = resolveJwtSecret();

// 增量列补齐（与 migrate2/3/5.mjs 等价，幂等）——全新安装直接由 db.js 建全，
// 老库启动时自动补列，不再依赖手动跑迁移脚本。
const COLUMN_MIGRATIONS = [
  { table: "channels", column: "last_error", ddl: "VARCHAR(500) NOT NULL DEFAULT ''" },
  { table: "channels", column: "used_count", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "channels", column: "last_used_time", ddl: "BIGINT NOT NULL DEFAULT 0" },
  { table: "channels", column: "remark", ddl: "VARCHAR(255) NOT NULL DEFAULT ''" },
  { table: "channels", column: "auto_ban", ddl: "TINYINT NOT NULL DEFAULT 1" },
  { table: "channels", column: "test_model", ddl: "VARCHAR(128) NOT NULL DEFAULT ''" },
];

// 列类型扩容（老库）：列宽不足时 ALTER。
// 历史问题：channels.api_key 是 VARCHAR(255)，「多 Key 用换行分隔」约 3 个 Key 就溢出 500。
const TYPE_MIGRATIONS = [{ table: "channels", column: "api_key", dataType: "text", ddl: "TEXT" }];

async function ensureColumnTypes() {
  for (const m of TYPE_MIGRATIONS) {
    const [rows] = await pool.query(
      "SELECT data_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
      [m.table, m.column]
    );
    if (rows.length && String(rows[0].t).toLowerCase() !== m.dataType) {
      await pool.query(`ALTER TABLE ${m.table} MODIFY ${m.column} ${m.ddl}`);
      console.log(`[migrate] ${m.table}.${m.column} 已扩容为 ${m.dataType}`);
    }
  }
}

async function ensureColumns() {
  for (const m of COLUMN_MIGRATIONS) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
      [m.table, m.column]
    );
    if (!rows[0].c) {
      await pool.query(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
      console.log(`[migrate] ${m.table}.${m.column} 已添加`);
    }
  }
}

export async function migrate() {
  for (const sql of TABLES) await pool.query(sql);
  await ensureColumns();
  await ensureColumnTypes();
}
