# CLAUDE.md

> Claude Code 在本仓库的入口。
> **完整规范、项目地图、门禁清单见 `AGENTS.md`** —— 请先读它，本文件只放
> 「读了就能不闯祸」的最短路径与 Claude Code 的具体用法。

---

## 先读这两个文件

1. `AGENTS.md` — 硬约束、结构地图、验证门禁、易踩的坑（必读）
2. `AI协作.md` — **唯一事实来源**：规范 / 待办 / 变更记录 / 踩坑史（3500+ 行，按需检索）

改完代码要**回写 `AI协作.md` 的「变更记录」**，这是本项目的规矩。

---

## 一、四条不能破的线

1. **只推 `main`**，不建其他长期分支。
2. **绝不提交** `.env` / `.jwt-secret` / `.admin-password` / `data/`；
   日志、错误信息、测试、文档里都不得出现真实 Key / Cookie / 密码。
3. **零新依赖**（后端只有 express/mysql2/jsonwebtoken/bcryptjs/cors/dotenv/playwright）。
4. **不要再建协作文档**。要记的东西一律写进 `AI协作.md`
   （`AGENTS.md` / `CLAUDE.md` / `CODEX.md` / `README.md` 是工具入口，属例外）。

---

## 二、改完必须过的门禁

```bash
# 后端改动
cd ooapi-server && node --check <改动文件> && npm test
node tests/gateway-smoke.mjs          # 真发三种协议请求；抓「闭包里的未定义标识符」

# 前端改动 —— 必须在上线【之前】跑完这一步
cd ooapi-web && npm run build
cd ../ooapi-server && BASE=http://127.0.0.1:3001 xvfb-run -a node tests/ui-smoke.mjs

# 动过含 GROUP BY / 子查询聚合的 SQL
node tests/sql-compat.test.mjs
```

**为什么盯得这么紧**：本项目三次白屏事故全部是「构建通过就上线」造成的
（`getFieldValue` 作用域、`SAMPLE_MODEL` 模块级引用、`endpoint` 被误删），
`vite build` 和 `node --check` 对这三类问题**全部绿灯**；
另有一次漏 import 导致 `ReferenceError` 被当成渠道故障、用户看到 503「账号都在冷却中」，
症状与根因完全看不出关系。详见 `AGENTS.md` 第 4 节。

---

## 三、Claude Code 用法建议

- **改动前先探路**：本仓库较大（后端 120+ 文件、前端 30+ 页面），
  用 Explore 类子代理并行搜「某个功能在哪些文件实现」，比逐文件读快得多。
- **改动前先读规范**：`AI协作.md` 第 2 节是强制规范（数据展示、监控口径、命名），
  第 3 节列着已知待办 —— 你想改的东西可能已被登记过。
- **别信记忆里的行号**：这个仓库改动频繁，注释里会引用旧行号。
  定位用搜索（grep / Glob），不要用记下来的行号。
- **改动数据库结构**：`db.js` 的建表语句与 `COLUMN_MIGRATIONS` **两处都要改**。
- **一次性脚本用完即删**：调试用的 `.mjs` / `.py` 不要留在仓库里。
- **Windows 环境**：Git Bash 下路径会被自动改写，涉及服务器 `/tmp/...` 的命令加
  `MSYS_NO_PATHCONV=1`。

---

## 四、上线

改完推 `main` 后，由管理员触发服务器上的内置更新器
（`POST /api/update/apply`）：拉取 GitHub → 备份 → rsync 覆盖 → 装依赖 →
构建前端 → 跑迁移 → 延迟重启。

**不要在服务器生产目录 `/opt/ooapi` 里直接改代码或 `git pull`**（它不是 git 仓库）。
上线后记得：

```bash
ssh root@47.79.85.60 'systemctl is-active ooapi; curl -s http://127.0.0.1:3001/health'
```

---

## 五、遇到「测试探针」别当业务数据

社区里的 `zqp*` / `zqr*` 用户、`k9x 靶帖` 这类标题，是 AI 模拟用户做黑盒测试留下的。
清理走管理员接口（`POST /api/community/admin/recount` 等），不要手工删数据。
