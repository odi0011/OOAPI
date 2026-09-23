import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, migrate } from "./db.js";
import { loadOptions, publicStatus, getNumberOption } from "./config.js";
import { seedDefaultPrices } from "./services/pricing.js";
import { buildId } from "./services/build-info.js";
import { ok } from "./utils.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import tokenRoutes from "./routes/token.js";
import logRoutes from "./routes/log.js";
import optionRoutes from "./routes/option.js";
import channelRoutes from "./routes/channel.js";
import gatewayRoutes from "./routes/gateway.js";
import chatRoutes from "./routes/chat.js";
import pricingRoutes from "./routes/pricing.js";
// 旧的账号管理接口已并入 /api/channel（routes/deepseek.js 与 services/deepseek/ 已删除）
import updateRoutes from "./routes/update.js";
import monitorRoutes from "./routes/monitor.js";
import mediaRoutes from "./routes/media.js";
import communityRoutes from "./routes/community.js"; // 社区大厅
import chatroomRoutes from "./routes/chatroom.js"; // 实时聊天（SSE）
import gamesRoutes from "./routes/games.js"; // 小游戏
import profileRoutes from "./routes/profile.js"; // 个人主页（含匿名可达）
import dashboardRoutes from "./routes/dashboard.js"; // 数据看板（个人 + 管理端）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 只信任本机反代（nginx 与后端同机，见 README）。跨机部署时用 TRUST_PROXY 显式配置，
// 避免客户端伪造 X-Forwarded-For 影响 IP 风控与审计。
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");

// CORS：默认放开（对外 API 需要），可用 CORS_ORIGIN 收敛为逗号分隔的白名单
const corsOrigin = (process.env.CORS_ORIGIN || "").trim();
app.use(cors(corsOrigin ? { origin: corsOrigin.split(",").map((s) => s.trim()).filter(Boolean) } : {}));

// 请求体解析：普通后台接口 1MB。
// 注意 /v1（多模态 base64，50MB）与 /api/chat（20MB）在各自路由内单独解析 ——
// 之前这两条路径的 1MB 全局中间件先生效，导致大图请求 413/500。
const jsonSmall = express.json({ limit: "1mb" });
app.use(
  ["/api/user", "/api/users", "/api/token", "/api/log", "/api/option", "/api/channel", "/api/pricing", "/api/update", "/api/monitor", "/api/community", "/api/chatroom", "/api/games", "/api/dashboard"],
  jsonSmall
);
// 注意：/api/media 不在此列表 —— 它自己用 32MB 解析 + 先鉴权（见 routes/media.js）
// /api/profile 也不在：它是匿名可达的（公开个人主页），统一 1MB 足够，单独挂更清楚

// build_id：当前部署的前端 bundle 名。前端拿它和自己的 script src 比对，
// 不一致说明页面还是旧包（SPA 打开后不会再取 index.html），提示刷新。
app.get("/api/status", (req, res) => ok(res, { ...publicStatus(), build_id: buildId() }));
app.get("/health", (req, res) => res.send("ok"));

app.use("/api/user", authRoutes);
app.use("/api/users", userRoutes); // 个人中心 + 管理
app.use("/api/token", tokenRoutes);
app.use("/api/log", logRoutes);
app.use("/api/option", optionRoutes);
app.use("/api/channel", channelRoutes);
app.use("/api/chat", chatRoutes); // 站内对话 + 智能体
app.use("/api/pricing", pricingRoutes); // 管理端：模型定价
app.use("/api/update", updateRoutes); // 管理端：从 GitHub 拉取最新代码在线更新
app.use("/api/monitor", monitorRoutes); // 管理端：运维监控（系统资源 + 网关运行时）
app.use("/api/media", mediaRoutes); // 媒体库：统一文件存储（头像/对话/社区共用）
app.use("/api/community", communityRoutes); // 社区大厅：话题/帖子/评论/点赞收藏/关注
app.use("/api/chatroom", chatroomRoutes); // 实时聊天：单聊/群聊/讨论组（SSE 长连接）
app.use("/api/games", gamesRoutes); // 小游戏：成绩榜 + 联机对战（服务端权威判定）
app.use("/api/profile", profileRoutes); // 个人主页（匿名可达，只出公开字段）
// 数据看板（个人 /console 与管理端 /admin/dashboard）。
//
// 这一行曾经**漏掉了**，而 import（文件顶部）与 body-parser 白名单里都有它 ——
// 于是看板接口全部 404：新用户注册后的第一个页面就是
// 「看板数据加载失败 / 请求失败（HTTP 404）」，所有 KPI 卡片永远显示 0。
// 黑盒测试（新用户全旅程）实测复现。
// 教训：import 了、加进白名单了，都**不等于**挂载了 —— 新增路由必须在这张表里出现。
app.use("/api/dashboard", dashboardRoutes);
app.use("/v1", gatewayRoutes); // 对外网关：OpenAI / Anthropic / Responses 兼容
app.use("/api/v1", gatewayRoutes); // 兼容以 /api/v1 为 Base URL 的三方客户端

// 网关未实现的端点 → **JSON 404**，而不是 Express 默认的 HTML 错误页。
//
// 黑盒测试实测（老张的原话）：「没宣告不支持；HTML 错误页混在 JSON API 里不好处理」
// —— `/v1/embeddings`、`/v1/completions`、`/v1/images/generations` 都返回
// `<pre>Cannot POST /v1/embeddings</pre>`（HTML）。客户端 SDK 按 JSON 解析会
// 抛出一个语焉不详的解析错误，把「这个端点我们没做」误报成「服务端返回了垃圾」。
// 同理 `GET /v1/chat/completions`（应该用 POST）也返回 HTML。
//
// 这里给出与 OpenAI 同形的错误体，并**明确列出本平台支持的端点**，
// 让调用方一眼知道是「没这个功能」还是「路径写错了」。
const GATEWAY_ENDPOINTS = [
  "POST /v1/chat/completions",
  "POST /v1/messages",
  "POST /v1/responses",
  "GET /v1/models",
];
app.use(["/v1", "/api/v1"], (req, res) => {
  res.status(404).json({
    error: {
      message:
        `本平台未实现端点 ${req.method} ${req.baseUrl}${req.path}。` +
        `支持的端点：${GATEWAY_ENDPOINTS.join("、")}`,
      type: "invalid_request_error",
      code: "endpoint_not_supported",
      supported_endpoints: GATEWAY_ENDPOINTS,
    },
  });
});

// 兼容客户端直接向根路径发送补全请求（如省略 /v1）
app.post("/chat/completions", (req, res, next) => {
  req.url = "/chat/completions";
  gatewayRoutes(req, res, next);
});
app.post("/messages", (req, res, next) => {
  req.url = "/messages";
  gatewayRoutes(req, res, next);
});
app.post("/responses", (req, res, next) => {
  req.url = "/responses";
  gatewayRoutes(req, res, next);
});

// 静态资源：logo 与前端构建产物（index.js 位于 src/，web 与 public 在包根目录）
app.use(express.static(path.join(__dirname, "..", "public")));
const dist = path.join(__dirname, "..", "web");
app.use(express.static(dist));
app.get(/^(?!\/api|\/health|\/v1).*/, (req, res, next) => {
  res.sendFile(path.join(dist, "index.html"), (err) => err && next());
});

app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  console.error("[error]", err);
  if (res.headersSent) return next(err);
  // 4xx 保留可读信息（如 413 request entity too large），5xx 不向客户端泄露内部细节
  const message = status >= 500 ? "服务器内部错误" : err.message || "请求错误";
  res.status(status).json({ success: false, message });
});

// 全局异常兜底：上游适配器（浏览器驱动、流式回调）的异常绝不能让进程退出。
// 之前 DeepSeek 账号被风控抛错时曾导致整个服务崩溃，这里做兜底。
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message || err, err?.stack || "");
  // 不退出：单请求失败不应影响其他用户
});

const PORT = Number(process.env.PORT || 3001);

// 日志自动清理：log_retention_days > 0 时，每 6 小时删一次过期日志（0 = 永久保留）。
// 后台「一键清空日志」是手动兜底，这里补上自动策略，避免 logs 表无限增长。
function scheduleLogCleanup() {
  const run = async () => {
    const days = getNumberOption("log_retention_days");
    if (!days || days <= 0) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const [ret] = await pool.query("DELETE FROM logs WHERE created_at < ?", [cutoff]);
      if (ret.affectedRows) {
        console.log(`[cleanup] 已清理 ${ret.affectedRows} 条超期日志（保留 ${days} 天）`);
      }
    } catch (e) {
      console.error("[cleanup] 日志清理失败：", e.message);
    }
  };
  run();
  setInterval(run, 6 * 3600 * 1000).unref?.();
}

// 媒体库自动回收：与日志清理同一套节奏（6 小时一次），失败只记日志不阻塞。
// 三类垃圾：未引用的新上传（用户选了文件没发出去）、过期软删、磁盘残留。
function scheduleMediaCleanup(runGc) {
  const run = async () => {
    try {
      const r = await runGc({ limit: 200 });
      if (r.softDeleted || r.purged) {
        console.log(`[media] 回收完成：标记待删 ${r.softDeleted} 个、物理清理 ${r.purged} 个`);
      }
    } catch (e) {
      console.error("[media] 回收失败：", e.message);
    }
  };
  // 延迟 5 分钟再跑第一次：避开启动高峰，也避免刚部署就删掉「用户正在编辑」的上传
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, 6 * 3600 * 1000).unref?.();
}

/**
 * 清理过期的对局房间。
 *
 * 为什么要它：每开一局就是 game_rooms 一行（含棋盘 JSON，象棋/海战棋几百字节），
 * 只增不删。当前量级无感，但「没有清理」意味着它会随时间一直长 —— 属于迟早要还的账。
 *
 * 保留窗口刻意给得很宽（已结束 30 天 / 未开打 7 天）：
 * 对局记录是「我的对局」列表与看板统计的数据源，删太早会让用户找不到历史。
 */
function scheduleGameCleanup() {
  const run = async () => {
    try {
      // 已结束/已放弃的对局：30 天后清理
      const [r1] = await pool.query(
        "DELETE FROM game_rooms WHERE status IN ('finished','abandoned') AND updated_time > 0 AND updated_time < UNIX_TIMESTAMP() - 30*86400 LIMIT 500"
      );
      // 一直没人加入的空房间：7 天后清理（房主早就走了，留着只占列表）
      const [r2] = await pool.query(
        "DELETE FROM game_rooms WHERE status = 'waiting' AND created_time > 0 AND created_time < UNIX_TIMESTAMP() - 7*86400 LIMIT 500"
      );
      if (r1.affectedRows || r2.affectedRows) {
        console.log(`[games] 清理对局：已结束 ${r1.affectedRows} 局、无人加入 ${r2.affectedRows} 局`);
      }
    } catch (e) {
      console.error("[games] 对局清理失败：", e.message);
    }
  };
  // 延迟 10 分钟首跑（避开启动高峰），之后每 12 小时一次
  setTimeout(run, 10 * 60 * 1000).unref?.();
  setInterval(run, 12 * 3600 * 1000).unref?.();
}

async function bootstrap() {
  // 等待数据库就绪（systemd 启动顺序兜底）
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (i === 29) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await migrate();
  await loadOptions();
  await seedDefaultPrices();
  // 预热兼容别名表（计费与渠道匹配共用；失败不影响启动）
  try {
    const { warmAliasMap } = await import("./services/models.js");
    await warmAliasMap();
  } catch (e) {
    console.error("[init] 别名表预热失败：", e.message);
  }
  // 预热模型登记表：渠道 models 留空时，调度层要按「该厂商有哪些模型」判断能否服务
  // （modelRegistrySync 是同步读取，没预热就等于所有留空渠道都不可用）
  try {
    const { modelRegistry } = await import("./services/models.js");
    await modelRegistry();
  } catch (e) {
    console.error("[init] 模型登记表预热失败：", e.message);
  }
  // 首次启动创建默认管理员
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role >= 100");
  if (!c) {
    const bcrypt = (await import("bcryptjs")).default;
    // 未显式设置 ADMIN_PASSWORD 时随机生成并打印一次，避免公开的硬编码默认密码
    let pwd = process.env.ADMIN_PASSWORD || "";
    let generated = false;
    if (!pwd) {
      pwd = crypto.randomBytes(12).toString("base64url");
      generated = true;
    }
    const hash = await bcrypt.hash(pwd, 10);
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      "INSERT INTO users (username, password, display_name, role, status, quota, aff_code, group_name, created_time) VALUES (?,?,?,100,1,?,?,?,?)",
      // group_name 留空 = 公共池（"default" 是已废弃的历史值，只在启动清理时被归一）
      ["root", hash, "超级管理员", 10000000, "ROOT0001", "", now]
    );
    // 随机密码绝不打印到 stdout/systemd 日志（能读日志的人就能接管后台）：
    // 写入 0600 的一次性文件，提示路径即可（更新器不会碰点文件）
    if (generated) {
      try {
        const f = path.resolve(__dirname, "..", ".admin-password");
        fs.writeFileSync(f, pwd, { mode: 0o600 });
        console.log(`[init] 已创建默认管理员 root；随机密码已写入 ${f}（0600）。登录后请立即改密并删除该文件。`);
      } catch {
        console.log("[init] 已创建默认管理员 root；未能写入密码文件，请设置 ADMIN_PASSWORD 后重启再登录。");
      }
    } else {
      console.log("[init] 已创建默认管理员 root（密码来自 ADMIN_PASSWORD 环境变量）。");
    }
  }
  // 上次在线更新若被强杀（systemd 超时/OOM/手动 kill），会留下哨兵文件：
  // 源码可能处于半新半旧状态，必须在日志里显式告警，避免静默运行混合代码。
  try {
    // 路径必须与 updater.js 的 SERVER_ROOT 一致（这里 __dirname 是 src/，上一级即 ooapi-server/），
    // 不能用 process.cwd()：WorkingDirectory 不当时会永远检测不到哨兵
    const sentinel = path.resolve(__dirname, "..", ".update-in-progress");
    if (fs.existsSync(sentinel)) {
      const info = fs.readFileSync(sentinel, "utf8");
      console.error(
        "[init] 警告：检测到上次在线更新未完成！当前代码可能半新半旧，请重新执行更新或从备份目录恢复。",
        info.slice(0, 300)
      );
    }
  } catch {
    /* ignore */
  }

  const server = app.listen(PORT, "127.0.0.1", () => console.log(`[ooapi-server] listening on 127.0.0.1:${PORT}`));

  scheduleLogCleanup();

  // 渠道定时检测（按渠道 auto_test/间隔执行真实探针）
  try {
    const { scheduleChannelAutoTest } = await import("./services/autotest.js");
    scheduleChannelAutoTest();
  } catch (e) {
    console.error("[init] 定时检测启动失败：", e.message);
  }

  // 渠道额度自动刷新（deepseek 余额 / OpenCode GO 窗口 …）
  // 与检测分开：查额度是只读快接口、不消耗上游额度，失败也绝不冷却渠道（见该文件注释）
  try {
    const { scheduleQuotaRefresh } = await import("./services/quota-refresh.js");
    scheduleQuotaRefresh();
  } catch (e) {
    console.error("[init] 额度刷新任务启动失败：", e.message);
  }

  // 限流渠道自动恢复：429 停用的渠道到点放回启用（见 resumeRateLimitedChannels）。
  // 单独一个轻量定时器（30s）而不是并进上面的检测循环：检测要打上游、可能很慢，
  // 而「到点恢复」只是几十毫秒的数据库操作，被慢探针拖住会让渠道白停更久。
  try {
    const { resumeRateLimitedChannels } = await import("./services/router.js");
    const run = () =>
      resumeRateLimitedChannels().catch((e) => console.error("[router] 限流恢复任务失败：", e.message));
    run();
    setInterval(run, 30_000).unref?.();
  } catch (e) {
    console.error("[init] 限流恢复任务启动失败：", e.message);
  }

  // 运维告警：首次启动写入内置规则（表非空时不覆盖），然后启动定时求值。
  // 求值失败只影响告警，绝不能让主服务起不来。
  try {
    const { seedDefaultRules, startAlertEngine } = await import("./services/alert.js");
    const n = await seedDefaultRules();
    if (n) console.log(`[alert] 已写入 ${n} 条内置告警规则`);
    startAlertEngine();
  } catch (e) {
    console.error("[init] 告警引擎启动失败：", e.message);
  }

  // 媒体库：准备目录（blobs/tmp）+ 清掉上次崩溃残留的半截文件 + 启动回收任务
  try {
    const { initMedia, runGc } = await import("./services/media.js");
    await initMedia();
    scheduleMediaCleanup(runGc);
  } catch (e) {
    console.error("[init] 媒体库初始化失败：", e.message);
  }

  // 对局房间清理：房间只增不删，迟早要还的账
  try {
    scheduleGameCleanup();
  } catch (e) {
    console.error("[init] 对局清理任务启动失败：", e.message);
  }

  // 社区通知清理同理（保留 90 天）
  try {
    const { scheduleNotificationCleanup } = await import("./services/notify-center.js");
    scheduleNotificationCleanup();
  } catch (e) {
    console.error("[init] 通知清理任务启动失败：", e.message);
  }

  // 实时推送（聊天/对战）心跳：反代会掐掉 60s 无数据的连接，注释帧保活
  try {
    const { startHeartbeat } = await import("./services/realtime.js");
    startHeartbeat(15000);
  } catch (e) {
    console.error("[init] 实时推送心跳启动失败：", e.message);
  }

  // 退出：先停接收新连接排空在途请求（分钟级上游/日志写入不能被硬截断），
  // 再关浏览器、PoW worker 与数据库连接池；10s 兜底强制退出。
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      const force = setTimeout(() => process.exit(0), 10_000);
      force.unref?.();
      try {
        const { closeAll } = await import("./services/upstream/browser-driver.js");
        await closeAll();
      } catch {
        /* ignore */
      }
      try {
        const { closePowWorker } = await import("./services/upstream/deepseek-pow.js");
        closePowWorker();
      } catch {
        /* ignore */
      }
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
  }
}

bootstrap().catch((e) => {
  console.error("bootstrap failed:", e);
  process.exit(1);
});
