import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, migrate } from "./db.js";
import { loadOptions, publicStatus } from "./config.js";
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
// 旧的账号管理接口已并入 /api/channel，前端无引用，保留文件但不挂载
// import deepseekRoutes from "./routes/deepseek.js";
import updateRoutes from "./routes/update.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", true);

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
// app.use("/api/deepseek", deepseekRoutes); // 已由 /api/channel 取代
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
  console.error("[error]", err);
  res.status(500).json({ success: false, message: err.message || "服务器内部错误" });
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
  // 首次启动创建默认管理员
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE role >= 100");
  if (!c) {
    const bcrypt = (await import("bcryptjs")).default;
    const pwd = process.env.ADMIN_PASSWORD || "Ooapi@Admin2026";
    const hash = await bcrypt.hash(pwd, 10);
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      "INSERT INTO users (username, password, display_name, role, status, quota, aff_code, group_name, created_time) VALUES (?,?,?,100,1,?,?,?,?)",
      ["root", hash, "超级管理员", 500000000, "ROOT0001", "default", now]
    );
    console.log(`[init] 已创建默认管理员 root / ${process.env.ADMIN_PASSWORD || "Ooapi@Admin2026"}`);
  }
  app.listen(PORT, "127.0.0.1", () => console.log(`[ooapi-server] listening on 127.0.0.1:${PORT}`));

  // 退出时关闭浏览器驱动会话，避免残留进程
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      try {
        const { closeAll } = await import("./services/upstream/browser-driver.js");
        await closeAll();
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
