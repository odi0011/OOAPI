# CODEX.md

> Codex CLI 在本仓库的入口。
> 注：Codex 会**自动读取 `AGENTS.md`**，那份是完整版（硬约束 / 结构地图 / 门禁 / 踩坑速查）。
> 本文件是同一套规则的**最短清单**＋ Codex 使用上的注意点，方便你快速对齐、少走弯路。
>
> 项目事实来源：`AI协作.md`（规范 / 待办 / 变更记录）。改完代码要回写它的「变更记录」。

---

## 一、动手前必须知道

| 项 | 值 |
|---|---|
| 项目 | OOAPI —— 大模型 API 网关（对外 OpenAI / Anthropic / Responses 三种兼容协议） |
| 后端 | `ooapi-server/` · Node 18+ · Express 4 · MySQL(mysql2) · JWT |
| 前端 | `ooapi-web/` · React 18 · Vite 5 · Ant Design 5 |
| 计费 | **1 OD币 = 1 美元**，10,000 单位 = 1 OD币；只能走 `services/pricing.js` |

**不可破的四条线**：

1. 只推 `main`（不建 `master` 或其他长期分支）。
2. 不提交 `.env` / `.jwt-secret` / `.admin-password` / `data/`；不把真实 Key、Cookie、密码
   写进代码、日志、错误信息、测试或文档。
3. 零新依赖（后端仅 express / mysql2 / jsonwebtoken / bcryptjs / cors / dotenv / playwright）。
4. 不新建协作文档 —— 一切记进 `AI协作.md`。

---

## 二、最常用的命令

```bash
# 后端：语法 + 全套测试
cd ooapi-server
node --check src/routes/xxx.js
npm test

# 后端：向网关真发三种协议请求（部署前必跑）
node tests/gateway-smoke.mjs

# 前端：构建 + 页面健康检查
cd ooapi-web && npm run build
cd ../ooapi-server && BASE=http://127.0.0.1:3001 xvfb-run -a node tests/ui-smoke.mjs

# SQL：动过 GROUP BY / 聚合子查询就跑它（线上开了 ONLY_FULL_GROUP_BY）
node tests/sql-compat.test.mjs
```

**`ui-smoke` 必须在部署之前跑完。** 本项目三次白屏事故都是「构建绿了就上线」：
`vite build` 与 `node --check` 对「作用域写错 / 模块级引用未定义 / 误删相邻声明」
这三类问题**全部绿灯**，只有 ui-smoke 会报。同理，后端「闭包里的未定义标识符」
（曾导致 `ReferenceError` 被当成渠道故障、用户看到 503「账号都在冷却中」）
只有 `gateway-smoke.mjs` 抓得到。

---

## 三、Codex 使用注意点

- **需要审批的命令**：`npm test`、`ui-smoke`、`gateway-smoke` 都会真实读写
  （前者跑数据库相关用例，后两者需要已运行的服务）。若被沙箱拦下，说明原因再请求放行；
  不要为了「跑通」而跳过门禁。
- **服务不在本机**：线上测试环境是 `root@47.79.85.60`（目录 `/opt/ooapi`，
  **不是 git 仓库**，别在里面 `git pull`）。浏览器与 xvfb 也在服务器上，
  需要真实浏览器时把脚本传上去用 `xvfb-run -a node script.mjs` 执行。
- **Windows**：Git Bash 下 `/tmp/...` 会被自动改写成 Windows 路径，
  涉及服务器临时文件的命令加 `MSYS_NO_PATHCONV=1`。
- **别按记忆里的行号改**：仓库改动频繁，注释中的行号可能已过期。用搜索定位。
- **数据库结构改动**：`db.js` 的建表 SQL 与 `COLUMN_MIGRATIONS` **两处都要改** ——
  线上表已存在，`CREATE TABLE IF NOT EXISTS` 不会补列。
- **一次性脚本用完即删**，不要把调试脚本留在仓库里。

---

## 四、上线流程

推 `main` 后由管理员触发服务器内置更新器（`POST /api/update/apply`）：
GitHub 拉取 → 备份 → rsync 覆盖（保护 `.env` / `data` / `node_modules` / `web`）→
装依赖 → 构建前端 → 跑迁移 → 延迟重启。

上线后自查：

```bash
ssh root@47.79.85.60 'systemctl is-active ooapi; curl -s http://127.0.0.1:3001/health'
```

---

## 五、不要碰的「数据」

社区里 `zqp*` / `zqr*` 开头的账号、`k9x 靶帖` 这类标题，是 AI 模拟用户做黑盒测试留下的
探针，**不是业务数据**。清理走管理员接口，不要手写 SQL 删。
