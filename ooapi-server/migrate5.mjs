// 迁移 v5：channels 表补 remark / auto_ban 字段（幂等）
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
const cols = [
  ["remark", "VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注'"],
  ["auto_ban", "TINYINT NOT NULL DEFAULT 1 COMMENT '1=测试失败自动禁用'"],
  ["test_model", "VARCHAR(128) NOT NULL DEFAULT '' COMMENT '测试用模型'"],
];

for (const [name, def] of cols) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'channels' AND column_name = ?",
    [name]
  );
  if (row.c > 0) log.push(`SKIP  channels.${name} 已存在`);
  else {
    await pool.query(`ALTER TABLE channels ADD COLUMN ${name} ${def}`);
    log.push(`OK    channels.${name} 已添加`);
  }
}

console.log(log.join("\n"));
await pool.end();
