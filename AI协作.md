# AI 协作指南（AI协作.md）

> 本文件是本仓库的**唯一协作规范与问题台账**。
> 任何 AI（或人）在修改本项目之前，必须先完整阅读本文件；
> 修改完成后，必须回写「变更记录」与「待办清单」。
>
> **文档约束（强制）**：本仓库只允许存在**一个**协作文档，即本文件 `AI协作.md`。
> **禁止** AI 自作主张创建其他 `.md` 文档（如审查报告、设计文档、会议纪要等）。
> 所有问题、待办、变更记录、审查结果，一律写在本文档内。如需拆分章节，只在本文档内用 `##` 分节。
> **分支约束（强制）**：仓库**只使用 `main` 一个分支**。禁止新建/推送 `master` 或其他长期分支；
> 临时分支用完即删。提交永远只推到 `origin/main`。

最后更新：2026-09-18

---

## 0. 接手须知（给下一个 AI / 开发者）

1. **币制只有一条规则**：`1 OD币 = 1 美元`，额度最小单位 10,000 单位 = 1 OD币。
   全站展示只用 `fmtOd / odOf / unitsPerOd`；**不要**引入人民币汇率、美元汇率、其他币名。
2. **先读第 2 节规范再动手**；改动完成后必须：后端 `node --check` 全部改动文件、前端 `npm run build`、
   回写本文档「变更记录」。
3. 数据库结构改动必须同时改 `db.js` 的建表 SQL **和** `COLUMN_MIGRATIONS`（老库自动补列），
   并在 `channel.js` 的 `rowToResp` 里返回新字段。
4. 不要提交 `.env` / `.jwt-secret`；不要绕过 `services/pricing.js` 自行计费；
   不要再犯「SQL `?` 与参数数量不匹配」的历史错误。

---

## 1. 项目概览

OOAPI 是大模型 API 网关与分发平台：对外提供 OpenAI 兼容接口（`/v1`），
支持多渠道调度、令牌分发、按 token 计费（OD币，1 OD = $1）、用户与额度管理、全链路日志。

| 层 | 技术 | 目录 |
|---|---|---|
| 后端 | Node.js 18+ · Express 4 · MySQL（mysql2）· JWT | `ooapi-server/` |
| 前端 | React 18 · Vite 5 · Ant Design 5 | `ooapi-web/` |
| 上游适配 | 网页版反代（Playwright）+ OpenAI 兼容 API | `ooapi-server/src/services/upstream/` |

### 1.1 后端关键模块地图

| 文件 | 职责 | 修改时的注意点 |
|---|---|---|
| `src/index.js` | 入口：建表、种子价格、创建管理员、启动 | 请求体限制按路径分层：普通 `/api/*` 1MB，`/v1` 50MB，`/api/chat` 20MB。**不要**再全局 `express.json()`，否则大图请求 413 |
| `src/db.js` | 连接池、建表、启动时自动补列 | 新增列必须同时更新 `TABLES`（全新安装）与 `COLUMN_MIGRATIONS`（老库），两者缺一不可 |
| `src/config.js` | options 表读写（带默认值） | 布尔项一律 `getBoolOption`，**禁止** `if (getOption(...))`（字符串 "false" 为真） |
| `src/middleware/auth.js` | JWT 鉴权 | 必须 try/catch（Express 4 不捕获 async 中间件异常） |
| `src/middleware/ratelimit.js` | 内存限流 | 敏感入口（登录/注册）必须挂；多实例部署需换共享存储 |
| `src/routes/gateway.js` | `/v1` 对外网关：鉴权、调度、计费、SSE | 计费走 `services/pricing.js`；外链图片必须过 SSRF 校验（`assertPublicUrl`） |
| `src/routes/chat.js` | 站内对话 + 智能体（JWT 计费） | 与网关共用 `runCompletion`；`thinking` 未传时不要默认 false |
| `src/routes/channel.js` | 渠道管理 CRUD、登录、测试、批量 | 渠道凭据在 `api_key`/`other`；多 Key 用换行分隔 |
| `src/routes/user.js` | 个人中心 + 用户管理 | **所有 SQL 的 `?` 必须与参数个数一一对应**（历史事故：缺参导致语法错误 500） |
| `src/routes/update.js` + `services/updater.js` | 在线更新 | 只覆盖源码，保护 `.env/.jwt-secret/data/node_modules/web` |
| `src/services/router.js` | 渠道选择、优先级+轮询、冷却、限速 | 运行期异常只改内存冷却，**不写** `channels.status` |
| `src/services/execute.js` | 统一执行器：选渠道→试错→换渠道 | 单渠道独立超时（读 `request_timeout_ms`）；已输出内容不换渠道；成功后持久化指纹 |
| `src/services/pricing.js` | 价格缓存、计费公式、usage 归一化 | `splitTokens` 必须先走 `normalizeUsage`（对象/数字/null 三种形态） |
| `src/services/upstream/openai-compat.js` | 所有「API Key」渠道 | 厂商私有字段（thinking 等）默认不下发，需渠道 `other.thinking_mode` 显式声明；多 Key 轮换 |

### 1.2 前端关键模块地图

| 文件 | 职责 | 注意点 |
|---|---|---|
| `src/services/api.js` | 唯一 API 出口 | 401 会清 token 并广播 `ooapi:unauthorized` |
| `src/services/format.js` | 唯一金额/时间格式出口 | 金额必须用 `fmtOd/odOf/unitsPerOd`，禁止各页自行除以 10000 |
| `src/services/stream.js` | SSE 客户端 | JSON 解析与业务回调异常分开处理 |
| `src/context/AppContext.jsx` | 全局状态：status/user | 监听 401 广播 |
| `src/styles.css` | 设计令牌 + `oo-*` 组件类 | 新页面复用 `oo-panel/oo-kv/oo-bar/oo-table`，颜色只用 CSS 变量 |
| `src/components/Markdown.jsx` | 模型输出渲染 | 链接必须过 `safeHref` 协议白名单 |
| `src/pages/*` | 业务页 | 页面结构统一：`PageHeader` + `oo-panel`；表单校验必须 catch |

### 1.3 线上测试环境（2026-09-17 起）

| 项 | 值 |
|---|---|
| 服务器 | `root@47.79.85.60`（阿里云 Ubuntu；本机已配置 SSH 免密，可直接 `ssh root@47.79.85.60`） |
| 生产目录 | `/opt/ooapi`（`ooapi-server` + `ooapi-web`），非 git 仓库 |
| 运行方式 | systemd `ooapi.service`：`xvfb-run` + `node src/index.js`，监听 `127.0.0.1:3001`，nginx 反代 |
| 在线更新 | 管理员 → 系统设置 → 更新；接口 `GET /api/update/check`、`POST /api/update/apply`、`GET /api/update/status` |
| 更新流程 | GitHub 拉取 → 备份源码 → rsync 覆盖（保护 `.env/.jwt-secret/data/node_modules/web`）→ npm install → 前端构建 → 复制 `dist` 到 `web/` → 迁移 → 写 `.update-stamp.json` → 延迟重启 |
| 版本戳 | `/opt/ooapi/ooapi-server/.update-stamp.json`（与 GitHub main 的 commit 比对） |
| 已验证 | 服务器 git / rsync / xvfb-run 齐备；能直连 GitHub API 与 codeload（无需代理） |

**验证命令**（改完代码后热验证）：
```powershell
ssh root@47.79.85.60 'cat /opt/ooapi/ooapi-server/.update-stamp.json; systemctl is-active ooapi; curl -s http://127.0.0.1:3001/api/status | head -c 200'
```

**注意事项**：不要在 `/opt/ooapi` 里直接 `git pull`（不是仓库，且会污染运行目录）；前端构建必须带 devDependencies（更新器已处理 NODE_ENV 坑）；`.env` 里保存线上配置，任何操作都不得覆盖。

---

## 2. 统一规范（强制）

### 2.1 通用

1. **币制**：全站唯一货币是 **OD币**，固定 `1 OD币 = 1 美元`，`10,000 额度单位 = 1 OD币`。
   - 计费：`services/pricing.js` 的 `UNITS_PER_OD = 10000`；
   - 展示：前端只用 `fmtOd / odOf / unitsPerOd`；
   - 禁止：新增汇率换算、其他币名（`$`、¥）、各页自行除/乘 10000。
2. **注释用中文，解释「为什么」而不是「是什么」**；保留已有踩坑注释，不要删。
3. **不引入新依赖**：后端只用 `express / mysql2 / jsonwebtoken / bcryptjs / cors / dotenv / playwright`；
   前端只用 `react / react-dom / react-router-dom / antd / dayjs / @ant-design/icons`。
   确需新增时，必须在本文档「依赖决策」记录理由。
4. 不提交 `.env`、`.jwt-secret`、`data/`、任何真实密钥/账号/cookie。
5. 不在日志或错误信息里输出 API Key、cookie、密码。

### 2.2 后端

1. **SQL**：全部参数化；列名/表名不得拼接请求参数（`channel.js` 的动态 SET 用白名单 `setIf`）。
   写完 SQL 必须数一遍 `?` 与数组元素个数（历史事故：`user.js` 6 条语句缺参）。
2. **配置读取**：布尔用 `getBoolOption`，数字用 `getNumberOption`；新增设置项要同步
   `DEFAULT_OPTIONS`、`AdminSettingsPage` 与 README 表格。
3. **错误对象**：适配器抛错必须带 `code`（`CHANNEL_*`）；可换渠道的错误要加入
   `execute.js` 的 `RETRYABLE` 集合。无 `code` 的异常不会重试、不会冷却。
4. **响应格式**：后台接口统一 `ok(res, data, msg)` / `fail(res, msg, status)`（`utils.js`）。
5. **计费**：只允许通过 `splitTokens + computeCost` 计算；上游给了 usage 必须精确计费
   （含 `cached_tokens` 缓存价），没有才退回估算。
6. **权限**：后台接口必须挂 `authRequired` / `adminRequired`；登录、注册必须挂 `rateLimit`。
7. **新增渠道列**：更新 `db.js` 的两处（建表 + `COLUMN_MIGRATIONS`），并在 `channel.js`
   `rowToResp` 中返回给前端。
8. **新渠道类型**：在 `services/channel-types.js` 注册 + `router.js` 的 `ADAPTERS` 注册适配器；
   适配器导出 `verify/chat/loginModes`，relay 方式还要 `release`。
9. **定价数据**：只允许平台已注册模型（`services/models.js` 的 `modelRegistry`）；
   **兼容别名（deprecated/aliasOf）不单独定价**，定价只登记真实模型；
   新增模型必须先由渠道 `models` 字段声明；`remark` 必须写官方来源，禁止「同上」；
   批量维护走「模型定价 → 上传文件更新」（`POST /api/pricing/import`，逐行严格校验）。
10. **一次性迁移**：`migrate*.mjs` 每次在线更新都会被执行，**禁止写非幂等逻辑**
    （历史事故：migrate2 重复除 50 导致用户余额被反复缩小；价格被重复覆盖）。
    需要"只做一次"的操作用 options 表打标或按已生效状态判断后再执行。
11. **登录态抓取**：需要「粘贴登录态」的 relay 接入方式，在 `channel-types.js` 配置
    `entryUrl` + `captureHint` 即自动获得「打开登录页自动抓取」按钮（`/api/channel/capture/*`）。

### 2.3 前端

1. 所有请求走 `services/api.js` 的 `API`；不要在页面里直接 `fetch("/api/...")`
   （站内对话/智能体走 `services/stream.js`）。
2. 金额展示只用 `fmtOd / odOf / unitsPerOd`；输入框与后端交互时**必须换算额度单位**
   （×perUnit / ÷perUnit），页面 label 写 OD 就必须传 OD 值。
3. 表单弹窗：`openEdit/openCreate` 必须先 `resetFields()` 再 `setFieldsValue`；
   `await form.validateFields()` 必须 try/catch 包住。
4. 列表页并发请求要做竞态防护（建议封装 `useLatest` 或在 `load` 里比对请求序号）。
5. 颜色只用 `styles.css` 的 CSS 变量（`--surface/--ink/--accent/--line/...`）；
   间距用 `--sp-*`；圆角用 `--r-*`。禁止硬编码十六进制颜色（渐变除外）。
6. 新增页面：`PageHeader` 标题 + 说明；主体用 `oo-panel`；表格用 `oo-table`；
   空状态给出引导文案。

### 2.4 UI/UX 重构规范（进行中）

当前阶段目标：**先修交互正确性，再统一视觉**。

- 交互正确性（必须）：
  - 任何异步操作要有 loading / disabled / 失败提示；
  - 错误提示统一 `message.error(e.message)`，禁止空 catch；
  - 危险操作（删除、更新、清空）必须二次确认。
- 视觉统一（进行中）：
  - 所有页面标题、卡片、表格、表单间距参照 `ConsolePage`/`TokenPage`；
  - 状态色只用语义变量：成功 `--green`、警告 `--orange`、失败 `--red`、主色 `--accent`；
  - 图标尺寸：正文 13-14，卡片 16，页头 18；
  - 移动端断点用 antd `Grid.useBreakpoint()`，不要写死 `window.innerWidth`。

---

## 3. 待办清单（按优先级）

> 以下为尚未完成的待办项。已修复的问题见「变更记录」。
> 工作方式：每轮审查发现的问题先登记在此，修好后**删除对应条目**并写入变更记录。

### 第 5 批审查发现（待处理）

- [ ] **Agent 计费条件与部分输出的 `usage` 形态**（观察项）：本轮已改为按内容兜底 + 结构化 usage，
  上线后观察计费是否与上游一致。
- [ ] **审查方式可复用**：后续批次继续用「三路并行子代理（前端 / 后端路由 / 服务适配器）+ 人工核实」，
  发现的问题先登记在此节，修完删除并写入变更记录。

### 长期/设计取舍项（已评估，暂不处理）

- [ ] **在线更新无签名校验**：目前信任 GitHub main；供应链加固需要发布流水线（哈希/签名），规划中。
- [ ] **多实例部署**：限流/冷却为单进程内存实现；本项目按单机单实例部署，多实例需换共享存储。
- [ ] **`/api/channel/login/batch` 串行**：一次性人工操作（最多 50 账号），管理员可接受等待；
  真要异步化需要任务队列，投入产出比低。
- [ ] **无测试/lint 基建**：当前以「语法检查 + 构建 + 线上冒烟」保证质量；引入 CI 时一并补 ESLint/`node --test`。
- [ ] **`users.inviter_id`**：邀请体系是产品功能，字段保留待产品决策。
- [ ] **CORS 默认放开**：对外 API 需要；生产建议设 `CORS_ORIGIN` 白名单（`index.js` 已支持）。
- [ ] **浏览器驱动 `--no-sandbox`**：服务器以 root 运行 node，Playwright 需该参数；部署要求为
  独立测试服务器 + 无其他不受信进程，生产建议非 root 用户 + 容器隔离。
- [ ] **`logout` 不撤销 JWT**：JWT 无状态设计的固有特性；如涉及高安全场景，需要 token 版本号/黑名单。
- [ ] **DNS rebinding TOCTOU**：`assertPublicUrl` 解析与 fetch 之间理论上存在窗口，
  彻底修复需 IP 直连 + 自定义 lookup；当前风险面已收窄（外链图片、拉取模型均需管理员/用户显式触发）。
- [ ] **`vision:true` 能力表**：GLM/Doubao/Qwen 渠道暂不支持图片，`channel-types` 中相关模型未标 vision，
  浏览器适配器对图片请求会显式报 `VISION_NOT_SUPPORTED`（不再静默忽略）。

---

## 4. AI 工作流（每次修改必须执行）

1. **读规范**：阅读本文件第 2 节；确认改动是否触碰第 3 节待办。
2. **改代码**：小步提交，一次只解决一类问题；保持现有注释与风格。
3. **自检**：
   ```powershell
   # 后端语法检查（在 ooapi-server/ 下，对所有改动文件执行）
   node --check src/routes/xxx.js

   # 前端构建验证（在 ooapi-web/ 下）
   npm run build
   ```
   涉及 SQL 的改动：人工核对 `?` 数与参数个数（可用 `mysql.format()` 快速验证）。
4. **验证行为**（有环境时）：启动后端 `npm start`（需 MySQL），至少覆盖改动接口的正反用例。
5. **回写文档**：更新本文件「变更记录」，勾选/新增待办，保持行号引用不过期。
6. **不要**：提交 `.env`、改 `ADMIN_PASSWORD`、在没跑构建前就说"完成"。
7. **禁止**：创建新的 `.md` 文档；所有内容只写在本文件内。
8. **分支**：只推 `main`；禁止创建/推送 `master` 或其他分支（详见文件头「分支约束」）。

### 环境备注（本机）

- Git 未加入 PATH，可用 GitHub Desktop 自带的：
  `& "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.3\resources\app\git\cmd\git.exe"`
- 网络受限时自行配置本机代理（每台机器的代理不同，**不要把代理地址写进本仓库**）。
- 运行 `ooapi-web` 的 `npm install` / `npm run build` 前确认 `node_modules` 存在；构建产物在 `dist/`，
  生产需复制到 `ooapi-server/web/`。

---

## 5. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-09-17 | 第 1 批修复：P0 功能 5 项、P1 计费/安全/稳定性 18 项、前端 12 项 |
| 2026-09-17 | 币制统一：移除"美元汇率"设置项，明确 `1 OD币 = 1 美元` |
| 2026-09-17 | 线上环境接入：`/opt/ooapi` 手动执行在线更新至 `98464bd`，确认为可用测试环境 |
| 2026-09-17 | 第 2 批：U1 ChatPage 流式渲染重构、U2 `useLatest` 竞态防护、U3 表单校验与额度口径；10 轮审查整改 |
| 2026-09-17 | 定价数据治理（删除虚构模型、官方来源、JSON/CSV 导入+清理+同步）、登录态远程抓取、渠道 SQL/权限/并发修复 |
| 2026-09-17 | 模型/定价全量对齐：DeepSeek 仅 flash/v4-pro；GLM 7 / Kimi 2 / Qwen 4 / 豆包 2 按官方页补价 |
| 2026-09-17 | **线上事故与修复**：migrate2 重复除 50 导致余额缩小；修复为一次性换算 + 不再写价格；余额已重建 |
| 2026-09-17 | 第 3–4 批持续整改：迁移失败回滚、执行器硬截止、内存表清理、能力标记、部分计费、SSRF、死代码清理 |
| 2026-09-17 | 文档整理：删除审查报告.md，合并待办至本文档；约束只允许存在一个协作文档 |
| 2026-09-18 | **第 5 批（三路并行审查）**：恢复被误删的 `deepseek-pow.js`（DeepSeek 适配器加载失败，P0）；
  `req.on("close")` → `res.on("close")`（Node 16+ 会立即触发导致站内/网关误杀上游，P0）；
  定价最长前缀匹配（短前缀可多收 10 倍）；Qwen/Doubao/GLM usage 结构化（只报 output_tokens 被当 total 导致少计费）；
  GLM 回退重写不再重复输出；OpenAI 兼容流加 8MB 单行上限 + 非 SSE JSON 兼容；网关图片先数后抓（防外链 DoS）
  + Content-Length 预检；migrate2 仅在明确读到旧值 500000 时换算（防新库被除 50）+ `quota_per_unit` 默认值修正；
  设置项数值范围校验（防 Infinity 超时）；非数字路径 id 统一 404（防 mysql2 NaN 500）；
  渠道测试不再复活手动禁用渠道；fetch-models 缺 base_url 时回退渠道真实地址；令牌创建用 insertId 回查；
  `chat_enabled/agent_enabled` 真正生效；智能体失败按内容兜底部分计费；`fe80::/10` 网段判断修正；
  指纹持久化改为写前重读合并（防覆盖并发变更）；`UNSUPPORTED_CHANNEL` 可重试；
  DeepSeek 子请求/流读取超时与释放；前端设置 null 值不再写成 "null"、docs_link 过协议白名单、
  停止生成后刷新余额、重新生成不清空草稿、`/agent` 切换保留图片校验、复制失败正确报错。
  遗留项已登记到第 3 节「第 5 批审查发现」。 |
| 2026-09-18 | **第 6 批（清第 5 批遗留）**：`browser-driver` 会话锁加 15 分钟看门狗（卡死强关 context
  并下次重建，渠道不再永久不可用）；`updater.js` 复制路径补齐删除语义（防回滚后半新半旧）；
  反代渠道 `models/group_name/weight/auto_ban` 真正落库（新增与更新均支持）；
  `fetchUpstreamModels` 改为 `redirect:"manual"` 逐跳 SSRF 校验；`token/user` 额度与过期时间加上限
  （防 BIGINT 越界 500）；前端 `ConsolePage/AdminChannelsPage` 硬编码色改 CSS 变量、
  创建令牌/新增渠道加提交防重入。文档：代理地址不再写入仓库（每台机器不同）。 |
