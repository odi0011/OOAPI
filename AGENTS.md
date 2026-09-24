# AGENTS.md — 在本仓库工作的 AI 助手入口

> 适用于 Codex / Cursor / ZCode / Claude Code / Gemini CLI 等所有编码助手。
> Claude Code 另见 `CLAUDE.md`；Codex 另见 `CODEX.md`（都是精简版＋本文件索引）。
>
> **唯一事实来源是 `AI协作.md`**（规范 / 待办 / 变更记录 / 踩坑史，3500+ 行）。
> 本文件只写「必须知道才能不闯祸」的东西。**不要把流水账记到这里**，
> 变更一律回写 `AI协作.md`。

---

## 1. 这个项目是什么

OOAPI —— 大模型 API 网关与分发平台。对外提供三种兼容协议，内部做多渠道调度、
令牌分发、按 token 计费（**OD币，1 OD = $1**）、用户额度管理与全链路日志。

| 包 | 技术栈 | 负责 |
|---|---|---|
| `ooapi-server/` | Node 18+ · Express 4 · MySQL(mysql2) · JWT | 后端 API + 对外网关 `/v1` |
| `ooapi-web/` | React 18 · Vite 5 · Ant Design 5 | 用户端 + 管理台 |

---

## 2. 硬约束（违反会出生产事故或泄露凭据）

1. **只推 `main`**。禁止新建/推送 `master` 或任何长期分支；临时分支用完即删。
2. **绝不提交**：`.env`、`.jwt-secret`、`.admin-password`、`data/`、`node_modules/`、`dist/`。
   任何真实 API Key / Cookie / 账号密码 / JWT 都不得写进代码、日志、错误信息、测试或文档。
3. **不要改 `ADMIN_PASSWORD`**，不要动线上 `.env`。
4. **零新依赖**。后端只允许：`express` `mysql2` `jsonwebtoken` `bcryptjs` `cors` `dotenv` `playwright`；
   前端只允许现有依赖。要加依赖先问人。
5. **只允许一个协作文档**：`AI协作.md`。不要再建同类文档
   （本文件 + `CLAUDE.md`/`CODEX.md`/`README.md` 是工具入口与说明书，属例外，见 AI协作.md 的说明）。
6. **币制只有一条规则**：`1 OD币 = 1 美元`，10,000 单位 = 1 OD币。
   全站展示只用 `fmtOd / odOf / unitsPerOd`；**不要**引入人民币汇率或其他币名。
7. **计费只能走 `services/pricing.js`**，不要在别处自己算钱。
8. **SQL 的 `?` 必须与参数个数一一对应**（历史事故：缺参 → 语法错误 500）。

---

## 3. 结构与常见改动的落点

### 后端 `ooapi-server/src/`

| 想改什么 | 去哪 |
|---|---|
| 对外网关（鉴权/调度/计费/SSE） | `routes/gateway.js` ＋ `services/gateway-protocols.js`（三种协议的解析与渲染） |
| 站内对话 / 智能体 | `routes/chat.js` ＋ `services/harness/` |
| 渠道管理 / 上游适配 | `routes/channel.js` ＋ `services/upstream/<vendor>.js` |
| 加一个新厂商 | `services/vendors.js` 注册 + `services/channel-types.js` 定义接入方式 + 写 `services/upstream/<vendor>.js` |
| 渠道选择 / 冷却 / 限速 | `services/router.js` |
| 价格与计费公式 | `services/pricing.js`（含默认价格表） |
| 建表 / 补列 | `db.js` |
| 系统设置项 | `config.js` ＋ `routes/option.js` |
| 社区 / 私信 / 通知 / 好友 | `routes/community.js`、`routes/chatroom.js`、`routes/friends.js` |

### 前端 `ooapi-web/src/`

| 想改什么 | 去哪 |
|---|---|
| 路由与布局 | `App.jsx`、`components/MainLayout.jsx` |
| 页面 | `pages/*.jsx` |
| 公共组件 | `components/*.jsx` |
| 主题 / 调色板 | `theme/ThemeContext.jsx`、`theme/presets.js` |
| 全局样式 | `styles.css`、`components/beautifului.css` |

---

## 4. 验证门禁（必跑；**顺序很重要**）

> 本项目已多次因「构建通过就上线」而白屏。下面每条都是真实事故换来的，别跳。

### 4.1 改后端

```bash
cd ooapi-server
node --check src/routes/xxx.js     # 语法（只查语法，不做作用域分析）
npm test                           # 全套静态与逻辑测试
node tests/gateway-smoke.mjs       # 真实打三种协议（部署前必跑）
```

- **`node --check` 抓不到「调用了未定义的函数」**——它不做作用域解析。
  真实事故：给网关加 `max_tokens` 截断时漏 import，`ReferenceError` 被当成渠道故障 →
  渠道被标记冷却 → 用户看到 503「账号都在冷却中」，**症状与根因看起来毫无关系**。
  这类**闭包里的**错误只有 `gateway-smoke.mjs`（真发请求）能抓到。
- 动了**带 `GROUP BY` / 子查询聚合的 SQL** → 必须跑 `node tests/sql-compat.test.mjs`。
  线上 MySQL 开了 `ONLY_FULL_GROUP_BY`，本机宽松模式能跑、线上直接 500。
- **改了数据库结构** → `db.js` 的建表语句 **和** `COLUMN_MIGRATIONS` 两处都要改。
  线上表已存在，`CREATE TABLE IF NOT EXISTS` **不会补列**。

### 4.2 改前端（**必须在部署前跑 ui-smoke**）

```bash
cd ooapi-web && npm run build
cd ../ooapi-server && BASE=http://127.0.0.1:3001 xvfb-run -a node tests/ui-smoke.mjs
```

- `vite build` 成功 **不等于** 页面能打开。ui-smoke 会真开每个路由，断言
  `#root` 有内容且无运行期错误，专抓三类问题：
  作用域写错（`getFieldValue` 用错层）、模块级引用未定义（`SAMPLE_MODEL`）、
  编辑时误删相邻声明（`endpoint`）。
- **血泪教训**：三次白屏事故里，一次是**没跑**就上线（`/messages` 整页白屏，
  两个测试人格同时报上来），一次是**跑晚了**（部署后才跑，白屏上线约 2 分钟）。
  正确顺序：先构建 → 在旧进程上跑 ui-smoke → 通过 → 再走更新流程。

### 4.3 其他专项

| 改动 | 必跑 |
|---|---|
| 社区 / 聊天 / 通知 / 看板接口 | `BASE=... node tests/e2e-modules.mjs` |
| 监控与指标 | `node tests/monitor-smoke.mjs` |
| 计费 / 限流 / 并发 | `npm test`（含 `concurrency-gate` 的真实计时断言） |
| 迁移脚本 | `node tests/migrate6.test.mjs` |

---

## 5. 改动流程（推荐）

1. **先读 `AI协作.md`** 第 2 节规范 + 第 3 节待办，确认这次改动是否已被登记。
2. 小步改，一次解决一类问题；保持现有注释风格（本项目注释偏「解释为什么」）。
3. 按第 4 节跑对应门禁。
4. 回写 `AI协作.md` 的「变更记录」；勾掉/新增待办。
5. 提交并推 `main`。
6. 需要上线时：管理员调 `POST /api/update/apply`（会拉 GitHub → 构建 → 迁移 → 重启）。

---

## 6. 环境备注

- **线上测试环境**：`root@47.79.85.60`，生产目录 `/opt/ooapi`（**不是 git 仓库**，
  别在里面 `git pull`）。服务由 systemd `ooapi.service` 托管，监听 `127.0.0.1:3001`，nginx 反代。
  版本戳：`/opt/ooapi/ooapi-server/.update-stamp.json`。
- **本机**：Git 可能不在 PATH（Windows 上可用 GitHub Desktop 自带的 git）。
  Git Bash 里执行含 `/tmp/...` 的命令建议加 `MSYS_NO_PATHCONV=1`，否则路径会被改写。
- **浏览器测试**：本机没有可用的 Chromium；Playwright 与 xvfb 在服务器上。
  需要真实浏览器时把脚本传上去用 `xvfb-run -a node script.mjs` 跑。

---

## 7. 写代码时反复踩到的坑（速查）

| 坑 | 正确做法 |
|---|---|
| `req.on("close")` 在请求体读完后立即触发，会误杀正常请求 | 用 `res.on("close")` ＋ 判断 `res.writableEnded` |
| `if (getOption("xxx"))` —— 字符串 `"false"` 为真 | 布尔项一律 `getBoolOption` |
| Express 4 不捕获 async 中间件异常 | 自定义中间件必须 try/catch |
| `fetch` 的 Headers 同名是**逗号拼接**而不是覆盖 | 不要重复设 `Authorization` / `Content-Type` |
| 改名/改状态的地方忘了同步冗余计数 | 社区里改 `status` 的三处（发帖/删除/moderate）都要维护 `post_count` 等 |
| 媒体引用有**两套 ref key**（`community_post` / `community_comment`），不会级联 | 删帖时要显式释放其评论的图片引用 |
| 兼容别名 / 能力后缀（`-thinking`）不归一化会导致白名单被绕过、计价落兜底档 | 权限与计价统一走 `models.js#canonicalModelName` / `modelInAllowList` |
| 把「改 `status`」当成「删数据」 | 软删是常态；查列表时要带 `status = 1` 过滤 |

---

## 8. 与测试人格的约定

本项目长期用 **AI 扮演的模拟用户**做黑盒测试（每轮 5 个不同人格，含小白 / 运维 /
开发者 / 产品 / 视觉等视角）。他们只从界面与 HTTP 层操作，**不读源码**，
产出报在社区里并登记进 `AI协作.md`。

如果你在社区/日志里看到 `zqp*` / `zqr*` 开头的用户名、或标题怪异（如 `k9x 靶帖`），
那是测试探针，不是真实用户数据 —— **不要**把它们当业务数据删改；
清理走 `POST /api/community/admin/recount` 与管理员隐藏接口。
