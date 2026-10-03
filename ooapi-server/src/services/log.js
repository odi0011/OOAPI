import { pool } from "../db.js";
import { clientAgentAudit } from "./client-agent-context.js";
import { now, deviceFromUa, clientIp } from "../utils.js";
import { billingSourceVendors, sourceVendors } from "./model-sources.js";

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

// 使用记录页展示消费与显式标记的失败调用；操作日志页展示其余管理/历史错误/登录类。
// 之所以在服务端定义而不是前端过滤：日志量会随调用数线性增长，
// 让前端拉全量再过滤既费带宽又会让操作日志被消费日志淹没。
export const CONSUME_TYPE = LOG_TYPE.CONSUME;
// 历史消费无需回填；历史错误不猜测为使用，避免旧版“消费+错误”被重复统计。
export function usageLogWhere(alias = "") {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("非法日志表别名");
  const p = alias ? `${alias}.` : "";
  return `(${p}type = 2 OR (${p}type = 4 AND ${p}is_usage = 1))`;
}
export const USAGE_SQL = usageLogWhere();

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
  firstTokenMs = null,
  elapsedMs = 0,
  userAgent = "",
  device = "",
  pricePhase = "",
  isUsage = type === LOG_TYPE.CONSUME,
  status = "",
  errorCode = "",
  retryCount = 0,
  inputText = null,
  requestPromptText = null,
  outputText = null,
  connection = null,
}) {
  // 未显式传 ip/UA 时从 req 兜底：调用方通常只关心 content，不该被迫重复写这两行
  const finalIp = ip || (req ? clientIp(req) : "");
  const finalUa = String(userAgent || (req ? req.headers?.["user-agent"] : "") || "").slice(0, 255);
  let audit = {};
  try { audit = JSON.parse(detail || "{}"); } catch { /* 非JSON管理日志保持原样 */ }
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) audit = {};
  const text = (value) => String(value ?? "").slice(0, 4000);
  const input = text(inputText ?? audit.input_text);
  const requestPrompt = text(requestPromptText ?? audit.request_prompt_text ?? audit.prompt_text);
  const output = text(outputText ?? audit.output_text);
  if (isUsage) {
    Object.assign(audit, clientAgentAudit());
    if (audit.inbound_endpoint === "/api/chat/run") audit.client_agent = { id: "ooapi", version: "", source: "internal", conflict: false };
    // 复用本次报价快照的实际接入品牌，不查库/猜型号；渠道改名/删除不改历史来源。
    const sources = Object.hasOwn(audit, "source_vendors") ? sourceVendors(audit.source_vendors) : billingSourceVendors(audit.billing_details);
    if (Object.hasOwn(audit, "source_vendors") || sources.length) audit.source_vendors = sources;
    audit.input_truncated = Boolean(audit.input_truncated || String(inputText ?? audit.input_text ?? "").length > 4000);
    audit.output_truncated = Boolean(audit.output_truncated || String(outputText ?? audit.output_text ?? "").length > 4000);
    audit.request_prompt_truncated = Boolean(audit.request_prompt_truncated || audit.prompt_truncated || String(requestPromptText ?? audit.request_prompt_text ?? audit.prompt_text ?? "").length > 4000);
  }
  if (isUsage && audit && typeof audit === "object" && !Array.isArray(audit)) {
    // 原文分别存TEXT列，避免JSON转义或重复字段把detail挤过64KB。
    for (const key of ["input_text", "request_prompt_text", "prompt_text", "output_text"]) delete audit[key];
    detail = JSON.stringify(audit);
  }
  try {
    const [ret] = await (connection || pool).query(
      `INSERT INTO logs (
         user_id, username, created_at, type, content, detail, ip, request_id, quota,
         model, channel_id, channel_name, token_id, token_name, group_name,
         prompt_tokens, completion_tokens, cache_tokens, first_token_ms, elapsed_ms,
         user_agent, device, price_phase, input_text, request_prompt_text, output_text,
         is_usage, status, error_code, retry_count, first_token_known
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input, requestPrompt, output,
        isUsage ? 1 : 0,
        String(status || (isUsage ? (type === LOG_TYPE.ERROR ? "error" : "success") : "")).slice(0, 16),
        String(errorCode || "").slice(0, 64),
        Math.max(0, Math.round(Number(retryCount) || 0)),
        firstTokenMs !== null && firstTokenMs !== undefined && Number.isFinite(Number(firstTokenMs)) ? 1 : 0,
      ]
    );
    return Number(ret.insertId) || 0;
  } catch (e) {
    if (connection) throw e; // 扣费事务中的审计行也必须一起提交或回滚。
    console.error("[log] write failed:", e.code || "DB_ERROR");
    return 0;
  }
}
