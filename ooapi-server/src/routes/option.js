import { Router } from "express";
import { ok, fail, asyncHandler } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { getOption, setOption, DEFAULT_OPTIONS } from "../config.js";
import { writeLog, LOG_TYPE } from "../services/log.js";

const router = Router();

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
    if (body.key !== undefined && body.value !== undefined) {
      // 单个更新
      const key = String(body.key);
      if (!(key in DEFAULT_OPTIONS)) return fail(res, `未知设置项：${key}`);
      await setOption(key, body.value);
    } else {
      // 批量更新
      const changed = [];
      for (const [key, value] of Object.entries(body)) {
        if (!(key in DEFAULT_OPTIONS)) continue;
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
