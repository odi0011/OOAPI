// 数据库迁移 v3：channels 表补充统计字段（幂等）
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

// channels 表补充字段
const cols = [
  ["used_count", "INT NOT NULL DEFAULT 0 COMMENT '累计调用次数'"],
  ["last_used_time", "BIGINT NOT NULL DEFAULT 0 COMMENT '最近调用时间'"],
  ["last_error", "VARCHAR(500) NOT NULL DEFAULT '' COMMENT '最近错误信息'"],
];

for (const [name, def] of cols) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'channels' AND column_name = ?",
    [name]
  );
  if (row.c > 0) {
    log.push(`SKIP  channels.${name} 已存在`);
  } else {
    await pool.query(`ALTER TABLE channels ADD COLUMN ${name} ${def}`);
    log.push(`OK    channels.${name} 已添加`);
  }
}

// 现有 deepseek 渠道补齐指纹（缺失时生成，保证每账号有独立固定指纹）
const [chans] = await pool.query("SELECT id, name, other FROM channels WHERE type = 'deepseek'");
const crypto = await import("node:crypto");
function genProfile(seed) {
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const rnd = (i) => hash[i % hash.length] / 255;
  const v = ["139", "140", "141"][Math.floor(rnd(1) * 3) % 3];
  const envs = [
    {
      platform: "Windows",
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      chUa: `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="24"`,
      chUaPlatform: '"Windows"',
    },
    {
      platform: "macOS",
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      chUa: `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="24"`,
      chUaPlatform: '"macOS"',
    },
  ];
  const env = envs[Math.floor(rnd(0) * envs.length) % envs.length];
  return {
    platform: env.platform,
    chromeVersion: v,
    userAgent: env.ua,
    secChUa: env.chUa,
    secChUaPlatform: env.chUaPlatform,
    secChUaMobile: "?0",
    locale: "zh_CN",
    browserLocale: "zh-CN",
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    timezoneOffset: "28800",
    hardwareConcurrency: [8, 12, 16][Math.floor(rnd(3) * 3) % 3],
    deviceMemory: [8, 16][Math.floor(rnd(4) * 2) % 2],
    deviceId: crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9+/=]/g, "").slice(0, 24),
    screen: ["1920x1080", "2560x1440", "1536x864"][Math.floor(rnd(5) * 3) % 3],
    createdAt: Date.now(),
  };
}

for (const c of chans) {
  let other = {};
  try {
    other = c.other ? JSON.parse(c.other) : {};
  } catch {
    other = {};
  }
  if (other.profile?.userAgent && other.profile?.deviceId) {
    log.push(`SKIP  渠道 #${c.id}「${c.name}」已有指纹`);
    continue;
  }
  other.profile = genProfile(`${c.id}:${(other.cookies?.[0]?.value || c.id).toString().slice(0, 24)}`);
  // 只写 profile 子字段（JSON_SET + JSON_EXTRACT 解析参数）：整列读-改-写会在迁移窗口内
  // 覆盖掉服务进程并发写入的 cookies/登录态
  await pool.query(
    "UPDATE channels SET other = JSON_SET(COALESCE(other, '{}'), '$.profile', JSON_EXTRACT(?, '$')) WHERE id = ?",
    [JSON.stringify(other.profile), c.id]
  );
  log.push(`OK    渠道 #${c.id}「${c.name}」已生成指纹（${other.profile.platform} / Chrome ${other.profile.chromeVersion}）`);
}

console.log(log.join("\n"));
await pool.end();
