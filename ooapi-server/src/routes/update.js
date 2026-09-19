// 在线更新（管理员）：检查 GitHub 最新代码 / 执行更新 / 查询版本
// ---------------------------------------------------------------------------
// 约定：
//   GET  /api/update/check   检查更新（只读，不改任何东西）
//   POST /api/update/apply   执行更新（拉代码 → 装依赖 → 构建前端 → 迁移 → 重启）
//   GET  /api/update/status  当前版本戳（前端重启后轮询用）
//
// 因为更新最后会重启服务（进程会被杀掉），apply 采用「先返回、再重启」：
// 实际重启交给 detached 子进程延迟执行，避免请求方只看到连接中断。
import { Router } from "express";
import { ok, fail, asyncHandler } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { writeLog, LOG_TYPE } from "../services/log.js";
import { checkUpdate, performUpdate, currentStamp, REPO_URL } from "../services/updater.js";

const router = Router();
router.use(adminRequired);

router.get(
  "/check",
  asyncHandler(async (req, res) => {
    const r = await checkUpdate();
    if (!r.ok) return fail(res, r.error || "检查更新失败");
    return ok(res, r);
  })
);

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    return ok(res, { repo: REPO_URL, stamp: await currentStamp() });
  })
);

// 防重复触发：同一时间只允许一个更新任务
let running = false;

router.post(
  "/apply",
  asyncHandler(async (req, res) => {
    if (running) return fail(res, "已有更新任务正在执行，请稍候");
    running = true;

    const collected = [];
    try {
      // 注意：performUpdate 内部若触发重启会杀掉本进程，
      // 所以这里不 await 它的重启阶段——它自己会先返回结果。
      const result = await performUpdate((s) => collected.push(s));
      await writeLog({
        req,
        user: req.user,
        type: result.ok ? LOG_TYPE.MANAGE : LOG_TYPE.ERROR,
        content: `在线更新${result.ok ? "成功" : "失败"}：${result.commit || ""}`,
        detail: JSON.stringify({ steps: collected, backup: result.backup }).slice(0, 2000),
      });
      if (!result.ok) return fail(res, result.error || "更新失败", 500);
      return ok(
        res,
        {
          commit: result.commit,
          backup: result.backup,
          frontendBuilt: result.frontendBuilt,
          steps: collected,
        },
        "更新完成，服务即将重启"
      );
    } finally {
      running = false;
    }
  })
);

export default router;
