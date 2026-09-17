import { pool } from "../db.js";
import { now } from "../utils.js";

export const LOG_TYPE = {
  TOPUP: 1,
  CONSUME: 2,
  MANAGE: 3,
  ERROR: 4,
  LOGIN: 5,
};

export const LOG_TYPE_LABEL = {
  1: "充值",
  2: "消费",
  3: "管理",
  4: "错误",
  5: "登录",
};

export async function writeLog({ user, type, content = "", detail = "", quota = 0, ip = "", requestId = "" }) {
  try {
    await pool.query(
      "INSERT INTO logs (user_id, username, created_at, type, content, detail, ip, request_id, quota) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        user?.id ?? 0,
        user?.username ?? "system",
        now(),
        type,
        content,
        detail,
        ip,
        requestId,
        quota,
      ]
    );
  } catch (e) {
    console.error("[log] write failed:", e.message);
  }
}
