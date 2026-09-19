import { Router } from "express";
import { ok, fail, asyncHandler } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { getOption, setOption, DEFAULT_OPTIONS, SECRET_OPTIONS } from "../config.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();

// 数值型设置项的白名单与取值范围（管理员误填 Infinity/负值/超大值会破坏运行期行为：
// 历史隐患：request_timeout_ms = Infinity 会让 setTimeout 溢出成 1ms，所有上游瞬间超时）
const NUMERIC_OPTIONS = {
  quota_per_unit: { min: 1, max: 1e9, int: true },
  units_per_od: { min: 1, max: 1e9, int: true },
  quota_for_new_user: { min: 0, max: 1e12, int: true },
  request_timeout_ms: { min: 1000, max: 86_400_000, int: true },
  log_retention_days: { min: 0, max: 3650, int: true },
  usd_rate: { min: 0, max: 1e6, int: false },
  ds_price_1m_prompt: { min: 0, max: 1e6, int: false },
  ds_price_1m_completion: { min: 0, max: 1e6, int: false },
  ds_request_timeout_ms: { min: 1000, max: 86_400_000, int: true },
  // 新增设置项的取值范围（凡是「参与运行时计算」的数字都必须在这里登记，
  // 否则 Infinity / 负数能直接写库并在运行期引发难以定位的问题）
  register_ip_limit: { min: 0, max: 1000, int: true },
  login_fail_lock_count: { min: 0, max: 100, int: true },
  login_fail_lock_minutes: { min: 1, max: 1440, int: true },
  password_min_length: { min: 6, max: 72, int: true },
  session_days: { min: 1, max: 365, int: true },
  quota_remind_threshold: { min: 0, max: 1e12, int: true },
  invite_reward_inviter: { min: 0, max: 1e12, int: true },
  invite_reward_invitee: { min: 0, max: 1e12, int: true },
  checkin_min_quota: { min: 0, max: 1e12, int: true },
  checkin_max_quota: { min: 0, max: 1e12, int: true },
  announcement_version: { min: 0, max: 1e9, int: true },
  default_user_concurrency: { min: 0, max: 10000, int: true },
  default_user_rpm: { min: 0, max: 1e7, int: true },
  default_user_tpm: { min: 0, max: 1e10, int: true },
  data_export_interval: { min: 1, max: 1440, int: true },
  rate_limit_window_minutes: { min: 1, max: 1440, int: true },
  rate_limit_count: { min: 0, max: 1e8, int: true },
  channel_disable_threshold: { min: 1, max: 1000, int: true },
  auto_test_channel_minutes: { min: 1, max: 1440, int: true },
  auto_test_concurrency: { min: 1, max: 32, int: true },
  perf_metrics_retention_days: { min: 0, max: 3650, int: true },
  retry_times: { min: 0, max: 10, int: true },
  gateway_ping_interval: { min: 0, max: 600, int: true },
  smtp_port: { min: 1, max: 65535, int: true },
  backup_interval_hours: { min: 1, max: 8760, int: true },
  backup_keep: { min: 1, max: 365, int: true },
  // 运维告警
  alert_interval_seconds: { min: 10, max: 86400, int: true },
  alert_silence_until: { min: 0, max: 4e12, int: true },
  alert_retention_days: { min: 0, max: 3650, int: true },
  alert_sla_min: { min: 0, max: 100, int: false },
  alert_ttft_p99_max: { min: 0, max: 600000, int: true },
  alert_error_rate_max: { min: 0, max: 100, int: false },
  alert_upstream_error_rate_max: { min: 0, max: 100, int: false },
};

// 固定值设置项：额度换算由计费代码硬编码（pricing.UNITS_PER_OD = 10000），
// 允许修改只会造成「展示口径 vs 实际扣费」漂移，直接拒绝。
const FIXED_OPTIONS = new Set(["units_per_od"]);

function validateOptionValue(key, raw) {
  if (FIXED_OPTIONS.has(key)) {
    // 表单会把当前值原样回传：等于固定值视为无操作，其他值拒绝
    if (Number(raw) === 10000) return null;
    return "该设置固定为 10000（1 OD币 = 10,000 额度单位），不可修改";
  }
  const spec = NUMERIC_OPTIONS[key];
  if (!spec) return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) return `取值必须在 ${spec.min} ~ ${spec.max} 之间`;
  if (spec.int && !Number.isInteger(v)) return "必须是整数";
  return null;
}

// 管理端：获取全部设置（敏感项掩码下发，避免密码出现在前端/日志/截图里）
const MASK = "********";
router.get(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    const data = {};
    for (const key of Object.keys(DEFAULT_OPTIONS)) {
      const v = getOption(key);
      data[key] = SECRET_OPTIONS.has(key) && v ? MASK : v;
    }
    return ok(res, data);
  })
);

// 管理端：保存设置（支持批量 {key: value}）
router.put(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    // 用 hasOwnProperty 而不是 in：in 会命中原型链（constructor/toString/__proto__ 等），
    // 可能把非白名单键写进 options 表
    const isKnown = (k) => Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k);
    if (body.key !== undefined && body.value !== undefined) {
      // 单个更新
      const key = String(body.key);
      if (!isKnown(key)) return fail(res, `未知设置项：${key}`);
      const verr = validateOptionValue(key, body.value);
      if (verr) return fail(res, `设置项 ${key} ${verr}`);
      await setOption(key, body.value);
    } else {
      // 批量更新：先整体校验再写，避免写一半失败留下混合状态
      for (const [key, value] of Object.entries(body)) {
        if (!isKnown(key)) continue;
        const verr = validateOptionValue(key, value);
        if (verr) return fail(res, `设置项 ${key} ${verr}`);
      }
      const changed = [];
      for (const [key, value] of Object.entries(body)) {
        if (!isKnown(key)) continue;
        // 掩码值 = 前端把「原样未改」的敏感项回传了，跳过不写（否则会把密码写成 ********）
        if (SECRET_OPTIONS.has(key) && String(value ?? "") === MASK) continue;
        const v = typeof value === "boolean" ? String(value) : String(value ?? "");
        await setOption(key, v);
        changed.push(key);
      }
      if (!changed.length) return fail(res, "没有可保存的设置项");
    }
    await writeLog({ req, user: req.user, type: LOG_TYPE.MANAGE, content: "更新系统设置" });
    return ok(res, null, "设置已保存");
  })
);

export default router;
