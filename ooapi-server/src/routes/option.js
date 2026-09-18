import { Router } from "express";
import { ok, fail, asyncHandler } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { getOption, setOption, DEFAULT_OPTIONS } from "../config.js";
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
};

function validateOptionValue(key, raw) {
  const spec = NUMERIC_OPTIONS[key];
  if (!spec) return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) return `取值必须在 ${spec.min} ~ ${spec.max} 之间`;
  if (spec.int && !Number.isInteger(v)) return "必须是整数";
  return null;
}

// 管理端：获取全部设置
router.get(
  "/",
  adminRequired,
  asyncHandler(async (req, res) => {
    const data = {};
    for (const key of Object.keys(DEFAULT_OPTIONS)) data[key] = getOption(key);
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
        const v = typeof value === "boolean" ? String(value) : String(value ?? "");
        await setOption(key, v);
        changed.push(key);
      }
      if (!changed.length) return fail(res, "没有可保存的设置项");
    }
    await writeLog({ user: req.user, type: LOG_TYPE.MANAGE, content: "更新系统设置" });
    return ok(res, null, "设置已保存");
  })
);

export default router;
