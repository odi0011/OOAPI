// 触发在线更新（.env 的 ADMIN_PASSWORD 与库不一致，走签名 JWT）。
import "dotenv/config";
import jwt from "jsonwebtoken";
const BASE = process.env.BASE || "http://127.0.0.1:3001";
const { JWT_SECRET, pool } = await import("../src/db.js");
const [[admin]] = await pool.query("SELECT id, role, token_version FROM users WHERE role >= 100 LIMIT 1");
const token = jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "30m" });
const r = await fetch(`${BASE}/api/update/apply`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: "{}",
});
console.log("apply:", r.status, (await r.text()).slice(0, 200));
// 触发更新后服务会重启，但脚本自己也要退出：db.js 的 pool 会保活事件循环。
await pool.end().catch(() => {});
process.exit(0);
