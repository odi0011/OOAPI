import { pool } from "../db.js";
import { now, deviceFromUa, clientIp } from "../utils.js";

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

// 使用记录页只展示「消费」；操作日志页展示其余管理/错误/登录类。
// 之所以在服务端定义而不是前端过滤：日志量会随调用数线性增长，
// 让前端拉全量再过滤既费带宽又会让操作日志被消费日志淹没。
export const CONSUME_TYPE = LOG_TYPE.CONSUME;

/**
 * 写日志。
 * 消费类日志建议带齐明细字段（模型/渠道/令牌/分组/tokens/耗时/设备），
 * 使用记录页直接读列展示，不再解 detail JSON。
 * 明细字段全部可选：管理/登录类日志只传 content 即可。
 *
 * 传 `req` 时会自动补 ip / userAgent（操作日志也要能查「谁从哪台设备做的操作」）。
 * 之所以做成参数而不是中间件：写日志的位置遍布各路由，逐个改 req 透传比全局中间件
 * 更好追踪，也不会在不需要日志的请求上多算一次 UA 解析。
 */
export async function writeLog({
  req = null,
  user,
  type,
  content = "",
  detail = "",
  quota = 0,
  ip = "",
  requestId = "",
  model = "",
  channelId = 0,
  channelName = "",
  tokenId = 0,
  tokenName = "",
  groupName = "",
  promptTokens = 0,
  completionTokens = 0,
  cacheTokens = 0,
  firstTokenMs = 0,
  elapsedMs = 0,
  userAgent = "",
  device = "",
  pricePhase = "",
}) {
  // 未显式传 ip/UA 时从 req 兜底：调用方通常只关心 content，不该被迫重复写这两行
  const finalIp = ip || (req ? clientIp(req) : "");
  const finalUa = String(userAgent || (req ? req.headers?.["user-agent"] : "") || "").slice(0, 255);
  try {
    await pool.query(
      `INSERT INTO logs (
         user_id, username, created_at, type, content, detail, ip, request_id, quota,
         model, channel_id, channel_name, token_id, token_name, group_name,
         prompt_tokens, completion_tokens, cache_tokens, first_token_ms, elapsed_ms,
         user_agent, device, price_phase
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        user?.id ?? 0,
        user?.username ?? "system",
        now(),
        type,
        content,
        detail,
        String(finalIp || "").slice(0, 64),
        String(requestId || "").slice(0, 64),
        quota,
        String(model || "").slice(0, 128),
        Number(channelId) || 0,
        String(channelName || "").slice(0, 64),
        Number(tokenId) || 0,
        String(tokenName || "").slice(0, 64),
        String(groupName || "").slice(0, 64),
        Math.max(0, Math.round(Number(promptTokens) || 0)),
        Math.max(0, Math.round(Number(completionTokens) || 0)),
        Math.max(0, Math.round(Number(cacheTokens) || 0)),
        Math.max(0, Math.round(Number(firstTokenMs) || 0)),
        Math.max(0, Math.round(Number(elapsedMs) || 0)),
        finalUa,
        String(device || (finalUa ? deviceFromUa(finalUa) : "")).slice(0, 64),
        String(pricePhase || "").slice(0, 16),
      ]
    );
  } catch (e) {
    console.error("[log] write failed:", e.message);
  }
}
