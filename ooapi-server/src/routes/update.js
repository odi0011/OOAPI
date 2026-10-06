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
import { adminRequired, superRequired } from "../middleware/auth.js";
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
    return ok(res, {
      repo: REPO_URL,
      stamp: await currentStamp(),
      task: task
        ? {
            id: task.id,
            state: task.state,
            startedAt: task.startedAt,
            updatedAt: task.updatedAt,
            steps: task.steps,
            commit: task.commit || "",
            error: task.error || "",
          }
        : null,
    });
  })
);

// 更新是长任务：请求只负责启动，状态由 /status 轮询读取。
// 进程重启后内存任务会消失，前端会用版本戳确认最终结果。
let running = false;
let task = null;

router.post(
  "/apply",
  superRequired,
  asyncHandler(async (req, res) => {
    if (running) return fail(res, "已有更新任务正在执行，请稍候");
    running = true;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    task = { id, state: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [], commit: "", error: "" };

    const collected = task.steps;
    const updateTask = (patch) => {
      if (!task || task.id !== id) return;
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    };
    // 不把构建/迁移挂在 HTTP 请求上：代理和浏览器可以立即得到任务 ID，
    // 服务重启前的最后一段状态仍会写入内存日志。
    void performUpdate((s) => collected.push(s))
      .then(async (result) => {
        updateTask({
          state: result.ok ? "completed" : "failed",
          commit: result.commit || "",
          error: result.ok ? "" : result.error || "更新失败",
        });
        await writeLog({
          req,
          user: req.user,
          type: result.ok ? LOG_TYPE.MANAGE : LOG_TYPE.ERROR,
          content: `在线更新${result.ok ? "成功" : "失败"}：${result.commit || ""}`,
          detail: JSON.stringify({ steps: collected, backup: result.backup }).slice(0, 2000),
        }).catch(() => {});
        running = false;
      })
      .catch((e) => {
        updateTask({ state: "failed", error: e.message || "更新失败" });
        running = false;
      });

    res.status(202);
    return ok(res, { taskId: id, state: "running", steps: collected }, "更新任务已启动，请等待状态确认");
  })
);

export default router;
