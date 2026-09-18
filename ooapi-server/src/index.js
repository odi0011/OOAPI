import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, migrate } from "./db.js";
import { loadOptions, publicStatus, getNumberOption } from "./config.js";
import { seedDefaultPrices } from "./services/pricing.js";
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
  ["/api/user", "/api/users", "/api/token", "/api/log", "/api/option", "/api/channel", "/api/pricing", "/api/update"],
  jsonSmall
);

app.get("/api/status", (req, res) => ok(res, publicStatus()));
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
app.use("/v1", gatewayRoutes); // 对外网关：OpenAI 兼容

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
      ["root", hash, "超级管理员", 10000000, "ROOT0001", "default", now]
    );
    console.log(
      `[init] 已创建默认管理员 root / ${pwd}${generated ? "（随机生成，请立即到「个人设置」修改）" : ""}`
    );
  }
  app.listen(PORT, "127.0.0.1", () => console.log(`[ooapi-server] listening on 127.0.0.1:${PORT}`));

  scheduleLogCleanup();

  // 渠道定时检测（按渠道 auto_test/间隔执行真实探针）
  try {
    const { scheduleChannelAutoTest } = await import("./services/autotest.js");
    scheduleChannelAutoTest();
  } catch (e) {
    console.error("[init] 定时检测启动失败：", e.message);
  }

  // 退出时关闭浏览器驱动会话与 PoW worker，避免残留进程
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
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
      process.exit(0);
    });
  }
}

bootstrap().catch((e) => {
  console.error("bootstrap failed:", e);
  process.exit(1);
});
