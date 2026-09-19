// 运维监控（管理员）
// ---------------------------------------------------------------------------
// 指标来源见 services/metrics.js（Node 内置模块采集，不引依赖）。
// 这一页是「当前进程 + 当前机器」的实时视图；跨重启的历史看使用记录/操作日志。
import { Router } from "express";
import { pool } from "../db.js";
import { ok, asyncHandler } from "../utils.js";
import { adminRequired } from "../middleware/auth.js";
import { snapshot } from "../services/metrics.js";
import { START_TIME, VERSION, getNumberOption, getBoolOption } from "../config.js";

const router = Router();
router.use(adminRequired);

// 实时快照（前端按间隔轮询；不做 SSE —— 监控页不需要亚秒级推送）
router.get(
  "/snapshot",
  asyncHandler(async (req, res) => {
    const s = snapshot();

    // 平台侧业务概览（与系统资源分开：这些来自数据库，不是进程指标）
    const [[ch]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 1) AS enabled,
              SUM(status = 2) AS disabled,
              SUM(status = 3) AS auto_disabled
         FROM channels`
    );
    const [[tk]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 1) AS active FROM tokens");
    const [[us]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 1) AS active,
              SUM(quota <= ?) AS low_balance
         FROM users`,
      [getNumberOption("quota_remind_threshold") || 100000]
    );
    // 近 1 小时/24 小时的调用与失败（来自 logs，跨重启也有）
    const nowSec = Math.floor(Date.now() / 1000);
    const [[h1]] = await pool.query(
      `SELECT SUM(type = 2) AS calls, SUM(type = 4) AS errors, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE created_at >= ?`,
      [nowSec - 3600]
    );
    const [[h24]] = await pool.query(
      `SELECT SUM(type = 2) AS calls, SUM(type = 4) AS errors, COALESCE(SUM(quota),0) AS units
         FROM logs WHERE created_at >= ?`,
      [nowSec - 86400]
    );
    // 表体积（判断日志是否需要清理）
    const [[tbl]] = await pool.query(
      `SELECT table_name AS name,
              ROUND((data_length + index_length) / 1024 / 1024, 2) AS mb
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
        ORDER BY (data_length + index_length) DESC LIMIT 8`
    );

    return ok(res, {
      ...s,
      version: VERSION,
      startedAt: START_TIME * 1000,
      overview: {
        channels: {
          total: Number(ch.total) || 0,
          enabled: Number(ch.enabled) || 0,
          disabled: Number(ch.disabled) || 0,
          autoDisabled: Number(ch.auto_disabled) || 0,
        },
        tokens: { total: Number(tk.total) || 0, active: Number(tk.active) || 0 },
        users: {
          total: Number(us.total) || 0,
          active: Number(us.active) || 0,
          lowBalance: Number(us.low_balance) || 0,
        },
        lastHour: { calls: Number(h1.calls) || 0, errors: Number(h1.errors) || 0, units: Number(h1.units) || 0 },
        last24h: { calls: Number(h24.calls) || 0, errors: Number(h24.errors) || 0, units: Number(h24.units) || 0 },
        tables: tbl.map((t) => ({ name: t.name, mb: Number(t.mb) || 0 })),
      },
      // 阈值来自系统设置，前端据此给红/黄标记（与「告警」同源，避免两处口径）
      thresholds: {
        autoTestEnabled: getBoolOption("auto_test_channel_enabled"),
        logRetentionDays: getNumberOption("log_retention_days"),
        rateLimitEnabled: getBoolOption("rate_limit_enabled"),
        perfMetricsEnabled: getBoolOption("perf_metrics_enabled"),
      },
    });
  })
);

export default router;
