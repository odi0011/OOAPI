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
| `src/services/upstream/codex.js` | ChatGPT 订阅（Codex OAuth） | responses 协议；`other.access_token/refresh_token/account_id`；刷新写回走 `auth-store` |
| `src/services/upstream/claude-oauth.js` | Claude 订阅（Claude Code OAuth） | 必须注入 Claude Code 身份提示词 + `anthropic-beta`；`metadata.user_id` 用 JSON 三元组 |
| `src/services/upstream/antigravity.js` | Google 订阅（Antigravity OAuth） | 私有信封 `{model,project,request}`；首次自动 loadCodeAssist 引导 project_id；client_id/secret 从 `.env` 读（`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`，禁止提交） |
| `src/services/upstream/cli-profile.js` | **统一指纹模块**（订阅渠道共用） | 所有身份按「渠道 id+账号」种子确定性派生；换号即换身份；禁止各适配器自己 random |
| `src/services/upstream/auth-store.js` | OAuth 凭据写回 | 写前重读合并，防覆盖并发修改；`access_token` 同步更新 `channels.api_key` |
| `src/services/upstream/grok.js` | xAI Grok 订阅（device-code OAuth） | Responses 协议：OAuth 走 `cli-chat-proxy.grok.com/v1` 必须带 CLI 身份头；403 bad-credentials 按 401 刷新重试；免费额度耗尽冷却 24h |
| `src/services/upstream/auth-import.js` | **统一凭据导入**（CPA / sub2api） | 识别 `accounts[]`、CPA auth `type`、多文件拼接、裸凭据；映射到已有接入方式，不直接写库 |

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
| `src/pages/ChatPage.jsx` + `services/chat.js` | **对话页**（第 16 批重构） | 会话/消息/设定全部来自服务端；运行一轮走 `/api/chat/run`（SSE，事件见 services/chat.js 注释）；消息按 parts 渲染 |
| `src/components/beautifului-chat.jsx` + `chat.css` | 对话页原语（Shelf/ToolChips/Notice/TodoPanel/OrchestrationBar） | 与 `beautifului.*` 同一来源（MIT），只把 Tailwind 换成本项目 OKLCH token；改动请同步两处 token |

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

### 1.4 codex-state-kit（ChatGPT/Codex 反代的回合态与降智防护）

模块：`services/upstream/codex-state-kit.js`（`codex.js` 接入，`execute.js` 消费轮换信号）。

```
① 注入健康态            ② 捕获            ③ 监控              ④ 轮换
x-codex-turn-state  ─▶ response header ─▶ detectSignal() ─▶ execute 短冷却换号
（按渠道+账号+TTL）      / SSE metadata     312 / 过载 / 516 指纹
```

| 概念 | 说明 |
|---|---|
| 健康态凭据 | 响应头 `x-codex-turn-state`（官方 Codex 协议确有该头：响应下发、同回合回填、新回合清空） |
| 292 语义 | 社区观测：携带 `current_turn_state` 的响应视为「未降智」，我们按此把该 state 缓存为健康态并在后续请求注入 |
| 312 信号 | 服务端主动下发的降智/过载信号 → 抛 `CHANNEL_DEGRADED` + `cooldownSec=90`，execute 立即换下一个账号 |
| 516 指纹 | `reasoning_tokens == 518n−2`（516/1034…）= 思考被截断的降智指纹；命中后本轮内容照常返回，但给渠道短冷却，下次优先换号 |
| 隔离与失效 | state 按「渠道 id + 账号指纹」存储，TTL 20 分钟；换号/过期/显式清空即失效，绝不跨账号携带 |
| 可配置 | 渠道 `other.state_kit=false` 关闭；`CODEX_DEGRADED_STATUS_CODES`（默认 `312`）覆盖信号状态码 |
| 降级策略 | 上游不认注入的 state（400/404 且提到 turn_state）→ 清除后重试一次；协议变化时退化为普通透传，不影响主链路 |

**设计边界**：state kit 只做「健康态选择 + 快速止损」，不伪造协议字段、不改写计费；292/312 的语义来自社区观测（非官方文档），因此全部做成可配置，出现新证据时只改常量。

**2026-09-18 线上实测结论**（真实 ChatGPT 账号，本地代理出口）：
- 不注入 state 请求 → HTTP 200 且响应头下发 `x-codex-turn-state`（**值长度正好 292**，社区所称「292」即该 state 的格式/长度，而非 HTTP 状态码）；
- 注入该 state 再请求 → HTTP 200、上游**不再重复下发** state（视为已接受、复用中）；对话流式与 usage 均正常；
- state 与账号绑定（本平台已按渠道+账号指纹隔离）；按**模型**隔离也已生效（社区要求采集与使用模型一致）。

**CPA / sub2api 凭据导入（第 11 批）**：管理端「渠道管理 → 导入凭据」支持
sub2api 导出（`accounts[]`）、CPA `auths/*.json`（`type=codex/claude/antigravity/gemini/xai`）、
多文件拼接与裸凭据；自动映射到 `codex / claude-oauth / antigravity / grok-oauth` 或 API Key 接入，
重复账号自动跳过。映射表与扩展点见 `services/upstream/auth-import.js`；Grok 接入方式为
`grok-oauth`（订阅）+ `api`（xAI 官方 Key）。

**292 文章对照检查（第 14 批，2026-09-18）**：

| 文章要点 | 我们的实现 | 结论 |
|---|---|---|
| 292 响应携带 `current_turn_state` 作为不降智凭据 | 从响应头 `x-codex-turn-state`（实测值长恰 292）/ 响应体 `current_turn_state` / SSE metadata 三路捕获 | ✅ |
| state 名义 TTL ≈ 1h，可被 312 提前撤销 | TTL 55 分钟；312（状态码可配 `CODEX_DEGRADED_STATUS_CODES`）立即作废 state | ✅ |
| 收到 312 应立即重新采集 | 立即作废 + 短冷却（90s）换号；之后再请求该账号时不带 state，上游自然下发新 292（实测：无 state 请求必回 292） | ✅（惰性续采） |
| state 与账号绑定 | 按「渠道 + 账号指纹」隔离，换号自动失效 | ✅ |
| 采集与使用模型要对齐 | state 按「渠道 + 模型」存储（key=`id:model`） | ✅ |
| 通过本地代理注入 state | 适配器在请求头注入，probe/chat 全部生效（实测注入后 200 且上游不再重复下发） | ✅ |
| 需要住宅 IP 采集、可切回日常线路 | 采集/使用同一出口（数据中心的阿里云出口实测也能拿到 292）；不做 IP 切换 | ⚠️ 部署差异 |
| keeper 每 45s 轮询、到期前 5 分钟续采 | 无独立 keeper 进程；按需惰性续采（下次请求自动拿新 state）。空闲期不消耗额度 | ⚠️ 设计取舍 |
| 「292 / 10 块」的 10 块含义 | 未知，未做处理 | ⚠️ 待考证 |

---

### 1.6 对话 harness（第 16 批新增，`services/harness/`）

对话页的「对话机制 + 智能体编排 + harness 设定」全部落在这四个文件里：

| 文件 | 职责 | 改的时候注意 |
|---|---|---|
| `harness/agents.js` | 智能体定义（primary / subagent 两层）+ 系统提示词拼装 | primary 由用户选择、可用 `task` 派人与 `todowrite`；subagent 只能被派发且禁用 `task`；角色提示词只留服务端 |
| `harness/tools.js` | 工具集：`search` / `fetch` / `task` / `todowrite` | 全部只读或无副作用（不碰文件系统）；`fetch` 必须逐跳过 `assertPublicUrl`（SSRF）；工具失败返回原因而不是抛错 |
| `harness/loop.js` | 运行循环 + 工具调用嗅探（`StepStream`） | 步数上限兜底（默认 6，上限 16）；子代理深度上限 `MAX_DEPTH=1`；嗅探改动务必重跑自测用例（切开的标签、未闭合、正文含花括号、代码块写法） |
| `harness/sessions.js` | 会话/消息存储（`chat_sessions` / `chat_messages`） | 会话设定入参一律走 `sanitizeSettings` 归一化；消息 seq 由 SQL 端 `MAX(seq)+1` 计算，避免并发撞号 |

**数据流**：`POST /api/chat/run` → 落库用户消息 → `runHarness`（每步一次上游调用，工具结果以 `<tool_result>` 回灌）→
逐次调用 `splitTokens` 求和后按 `pricing.js` 计费 → 助手消息（parts JSON）落库 → 更新会话 `todo` 与统计。

**协议边界**：渠道里既有 OpenAI 兼容 API，也有网页版反代（不支持原生 `tools`），因此工具调用统一用
「提示词 + 严格 JSON 调用块」文本协议，由 `StepStream` 嗅探。新增渠道类型无需改协议。

**计费约束**：每轮里**每一次**上游调用（主回答、工具检索、子代理）都要 `record()` 进 `calls`，
失败时用 `err.calls` 带出并部分计费；禁止只按最后一次调用的 usage 计费。

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
12. **订阅型 OAuth 渠道**（参考 CLIProxyAPI/sub2api）：接入方式 key 固定为
    `codex` / `claude-oauth` / `antigravity`，在 `channel-types.js` 的方法上声明 `adapter` 字段，
    在 `router.js` 的 `ADAPTERS` 注册同名适配器；适配器须导出
    `importAuth / verify / chat / loginModes`（有模型接口再加 `fetchUpstreamModels`）。
    凭据统一存 `other`（`access_token/refresh_token/expires_at`），刷新后必须经
    `auth-store.persistOtherPatch` 写回；**所有客户端身份必须走 `cli-profile.js` 统一派生**，
    禁止适配器内 `randomUUID()` 直出（重启后身份乱跳会被上游风控）。

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

### 持续审查（待处理）

- [ ] **订阅 OAuth 渠道实盘验证**（第 12 批进展）：**Codex 已完成全链路实盘验证**
  （sub2api 文件导入 → 渠道测试 → 站内对话 → 精确计费 → 292 state 捕获/注入 → 312 判定）；
  Claude / Gemini / Grok 目前没有真实订阅凭据，待补各跑一次「测试渠道 + 对话」。
- [ ] **新模型定价待补录**：Codex（`gpt-5.6-luna/terra/sol`、`gpt-5.5`、`codex-auto-review`）与
  Grok（`grok-4.6/4.5/4.3`、`grok-3-mini`）尚未收录官方价，当前走兜底价（0.30/1.20 并打告警）；
  补录时按规范在 `remark` 写官方来源（openai.com/api/pricing、x.ai 定价页）。
- [ ] **审查方式可复用**：后续批次继续用「三路并行子代理（前端 / 后端路由 / 服务适配器）+ 人工核实」，
  发现的问题先登记在此节，修完删除并写入变更记录。

### 第 16 批遗留（对话重构）

- [ ] **对话 harness 线上实盘**：本地已用 mock 上游与浏览器验收（流式、工具 chip、待办、设定、移动端），
  上线后需用真实渠道各跑一次：① 纯对话（无工具）② 触发联网检索 ③ 触发 `fetch` ④ 触发 `task` 子代理
  ⑤ 步数上限兜底 ⑥ 中途停止生成的部分计费。
- [ ] **工具调用的渠道兼容性**：`search` 工具依赖渠道的 `search` 能力（反代渠道部分不支持，工具会返回失败原因交给模型）；
  若线上发现某些渠道「只知道调工具、不肯直接回答」，优先检查该渠道是否支持联网，其次考虑收敛 `tools` 默认开关。
- [ ] **会话数据清理**：`chat_sessions` / `chat_messages` 目前不随日志保留策略清理（用户数据，按需保留）；
  若将来要做配额，建议放在「用户删除会话」之外单独设计（历史额度扣减已计入 `used_quota`，删消息不回滚）。
- [ ] **前端长会话性能**：消息按 parts 渲染，流式期间只重写最后一条；若单会话消息数达到数百条，
  需补虚拟滚动（当前未做，实测百条内无压力）。

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
- [ ] **反代图片上传未实现**：GLM/Kimi/豆包/通义适配器暂不支持图片（能力声明已统一为 `vision:false`，
  不会再展示无效开关）；实现图片上传后再把对应模型改回 `vision:true`。

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
- `antigravity`（Google 订阅）需要在本机 `.env` 配置 `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET`（**不提交仓库**）；未配置时该渠道会以 `CHANNEL_CONFIG_ERROR`
  跳过并提示，不影响其他渠道。
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
| 2026-09-18 | **第 7 批（复审+新问题）**：兼容别名归一（`kimi-latest`/`qwen-turbo`/`glm-4-flash`/
  `deepseek-chat` 等按真实模型计费与匹配，此前落到默认档偏差 3~10 倍且别名请求 NO_CHANNEL）；
  浏览器看门狗改为从「真正持有会话」起算（排队时间不再计入）；`migrate2` 设置项改 `INSERT IGNORE`
  （不再覆盖管理员自定义）+ 老库 cookies 解析容错；网关非流式失败也按已产出部分计费；
  `settle` 扣费后令牌更新改 best-effort（防 catch 再次结算导致双扣）；白名单过滤 `messages` 非对象元素
  （防 TypeError 冷却全部渠道）+ 匿名大包先鉴权头预检再解析请求体；`thinking:null` 不再 500；
  管理员不能改自己角色 + 保留最后一个启用管理员；`units_per_od` 固定 10000（前端只读、后端拒绝修改）；
  GLM/Kimi/豆包/通义模型能力声明统一 `vision:false`（与适配器实现一致）+ PoW difficulty 上限；
  Kimi 健康检查/拉模型加超时；Qwen 思考摘要按「段下标+偏移」差分；前端：`api.js` 默认 30s 超时
  （更新 apply 关闭超时）、会话代际防「退出后被写回」、非法主题值归一化、dayjs 中文 locale、
  ChatPage 复制降级/切模型重置搜索、Console curl 去尾斜杠、在线更新轮询清理与超时提示、
  编辑渠道/调整额度/令牌启停删除等防重入。遗留项已登记到第 3 节「第 7 批审查发现」。 |
| 2026-09-18 | **第 8 批（清第 7 批遗留）**：`utils.safeInt` 收口所有 `Number()` 直通 SQL 的入口
  （channel 的 id/priority/weight/批量/拉模型、log 的 type、token 的 body id）；
  `channels.api_key` 由 `VARCHAR(255)` 扩容为 `TEXT`（启动时类型迁移，多 Key 不再约 3 个就溢出）
  + 所有写入按列宽校验/截断（name/base_url/group/models/display_name/email/setting 等）；
  改密接口按用户维度限流（5 次/分钟）；更新器改为扫描 `migrate*.mjs` 按序执行（新增迁移不再漏跑）
  + 前端源码一并备份与回滚；智能体计费改为「逐次 call 分别 splitTokens 后求和」，
  彻底解决跨渠道 usage 混合少计，失败步骤的 prompt/输出也纳入估算。 |
| 2026-09-18 | **第 9 批（PoW worker 化）**：DeepSeek PoW 求解从主线程移到 `worker_threads`
  （`deepseek-pow-worker.mjs`）；60s 超时可终止卡死 worker，空闲 5 分钟自动回收，
  SIGTERM/SIGINT 退出时 `closePowWorker()` 清理；保留 worker 启动失败回退主线程的兜底。 |
| 2026-09-18 | **第 10 批（订阅 OAuth 反代：GPT/Claude/Gemini）**：学习
  CLIProxyAPI（CPA）与 sub2api 的协议实现，新增三种接入方式
  `codex`（ChatGPT 订阅）/`claude-oauth`（Claude 订阅）/`antigravity`（Google 订阅）：
  · `cli-profile.js` 统一指纹模块：会话/设备/安装 id 全部按「渠道+账号」确定性派生；
  · `codex.js`：responses 流式协议（Originator/chatgpt-account-id/session_id）、
    token 表单刷新、id_token 解析 account_id；`claude-oauth.js`：messages 协议、
    注入 Claude Code 身份提示词与 anthropic-beta 头、metadata.user_id 三元组、JSON 刷新；
    `antigravity.js`：Cloud Code Assist 私有信封、loadCodeAssist 自动引导 project_id、
    官方 UA、SSE（thought/正文/usageMetadata）；三者刷新后经 `auth-store` 写回；
  · channel-types 新增 `adapter` 字段与订阅方法定义；router 支持新方法路由；
    `/channel/login` 支持凭据导入；`/fetch-models` 支持适配器自定义模型接口；
  · 前端「添加渠道」订阅方式渲染为「粘贴凭据 JSON」并提交 method；
  · 模型注册新增 openai/anthropic/gemini 三个模型表。实盘验证见第 3 节待办。 |
| 2026-09-18 | **第 10.1 批（订阅渠道三路复审修复）**：过期刷新兜底（`expires_at` 未知先刷一次，
  且 401 时强制刷新后重放一次，解决「首个 token 过期即渠道永久失效」）；Claude 兼容官方
  camelCase 字段与毫秒 `expiresAt`；刷新改为「同渠道合并 + 刷新前重读 DB」（防并发双刷
  refresh_token 作废）；Claude/Antigravity 消息角色规范化（首条 user、合并连续同角色）；
  Claude usage 把缓存读/写计入 prompt（防缓存上下文少计费）；Antigravity 思考 token 计入补全；
  指纹种子只用渠道 id（刷新补齐 account 字段不再换身份）；Google OAuth 密钥移出仓库改 `.env`；
  OAuth 渠道按稳定账号去重 + 入池前凭据校验（失败禁用不再带病调度）；`fetch-models` 订阅兜底
  默认模型并统一返回 id 数组；`/login` 更新渠道补 `priority`；`POST /channel` 拒绝非 api 方法；
  删除路径带 `other` 解析真实 method；前端测试超时 90s、凭据 id 命名空间化、非 API 权重默认 1。 |
| 2026-09-18 | **第 11 批（codex-state-kit 实测校正 + CPA/sub2api 导入 + Grok 接入）**：
  按社区机制重写 state kit（292=通行证、312=撤销、TTL≈55min、按渠道+**模型**隔离、支持响应头/响应体/SSE
  三路捕获、312 立即作废并换号）；**真实账号实测**确认：未注入时下发 292 长度的
  `x-codex-turn-state`，注入后被接受且不重复下发；新增 `grok.js`（device-code OAuth，
  `cli-chat-proxy` Responses 协议 + CLI 身份头 + 403 bad-credentials 刷新重试 + 免费额度 24h 冷却）
  与 `grok-models.js`；新增统一导入器 `auth-import.js` + `POST /api/channel/import` + 前端
  「导入凭据」弹窗（sub2api 导出 / CPA auth / 多文件拼接 / API Key，自动识别厂商与去重）；
  codex/claude/antigravity 解析兼容 sub2api `credentials` 结构。 |
| 2026-09-18 | **第 12 批（UI/UX 体验修复，另一 AI 窗口提交）**：列表页错误态不再显示旧数据——
  `AdminChannels/AdminUsers/AdminPricing` 加载失败时统计卡显示 `—` 并给「统计加载失败」提示
  （新增 `statsError` 独立区分）；重试按钮统一带 `loading`；行内操作在 `acting/actionBusyId`
  期间禁用（编辑/额度/启停/删除），测试按钮防并发；`ProfilePage` 资料表单改为 `useEffect`
  同步异步到达的用户数据（修复首次打开时资料为空）；主题色选择、厂商选择卡等可点击 `div`
  改为原生 `button` 并补 `aria-pressed/aria-label` 与键盘（Enter/Space `preventDefault`）
  支持。构建通过；随最新版本部署到测试服务器。 |
| 2026-09-18 | **第 12 批线上验证**（测试服务器 47.79.85.60，版本 `4df4355`）：内置更新器连续部署
  `f50efba → 671315a → 4df4355`（均服务 active / status 200 / 前端构建成功 / 迁移幂等）；
  用 sub2api 导出的**真实 ChatGPT 账号**走完整链路：
  `POST /api/channel/import` 创建渠道（openai/codex）→ 渠道测试 2.7s 通过（服务器可直连 ChatGPT）
  → 站内对话返回 PONG（tokens 12/6，扣费精确 0.0001 OD）→ 二次对话正常；
  适配器级深度测试：统一指纹确定性（Codex session 36 位、Claude device_id 64 hex、Grok session）、
  响应头捕获 `x-codex-turn-state`（**值长 292**、剩余 TTL≈55min）、注入后上游接受并复用、
  312 信号判定（作废 state + 90s 冷却）、渠道 `last_error` 为空。Codex 默认模型对齐线上型号。 |
| 2026-09-18 | **第 13 批（渠道管理页 UI/UX）**：去掉标题下的说明小字（只留页面标题）；
  原四张统计卡改为标题旁的横向小标签（渠道/启用/冷却/模型，失败时显 `—`），释放纵向空间；
  新增「列表 / 宫格」形态切换按钮（位于厂商筛选与刷新之间，偏好记 localStorage）；
  新增 `channels.recent_calls`（环形 20 条，随 `markChannelOk/markChannelError` 与渠道测试写回，
  运行时缓存 + 落库，重启不丢），列表与宫格统一渲染「最近调用」小绿条（绿=成功 / 橙=失败 /
  灰=无记录，悬浮显示时间、结果、耗时，hover 放大加亮，样式参考 aceternity uptime bars）；
  宫格卡片含厂商图标、名称/账号、状态、分组、模型与行内操作，独立分页（24/页）。
  `PageHeader` 组件新增 `tags` 插槽；移动端宫格单列与更细的小绿条。 |
| 2026-09-18 | **第 13.1 批（渠道列表微调）**：名称列收窄到 150px 并强制省略号（名称/账号/备注均可截断，
  悬浮显示全文）；「最近调用」列前移到名称之后、厂商之前（该栏数据重要，优先可见）。 |
| 2026-09-18 | **第 13.2 批（最近调用 tip 增强）**：`recent_calls` 每条记录新增提示词/回复摘要
  （`p`≤160、`r`≤240 字符，空白压缩）；生产调用（execute 成功/失败）与渠道测试都写入；
  小绿条悬浮 tip 改为多行卡片：时间·结果·耗时 + 「提示词」+「回复/错误」（最多 4 行省略），
  方便直接回看当次 AI 的回复；旧记录无摘要时自动只显示头部信息。 |
| 2026-09-18 | **第 14 批（全渠道探针 + 定时检测 + 降智展示）**：
  · **通用探针** `services/channel-probe.js`：所有接入方式（API Key / 网页反代 / 订阅 OAuth）
  都可「发提示词 → 拿 AI 回复」——适配器有 `probe` 用它，否则直接调 `chat()`，都没有才退回 `verify`；
  测试模型解析顺序：渠道 `test_model` → 接入方式 `testModel` → 渠道声明首个模型；
  · 测试提示词可自定义（渠道 `test_prompt`，默认 `hi`），渠道测试、定时检测与 tip 全部使用；
  · **定时检测**：编辑弹窗在「启用状态」旁新增开关 + 间隔（分钟，存秒），可选提示词；
  后端 `services/autotest.js` 每 60s 检查到期渠道（仅 `auto_test=1 且 status=1`），串行探针、
  渠道间 1.5s 间隔，成功重置冷却、失败写 `last_error`，结果都进「最近调用」；
  · 小绿条改**按时长着色**：成功快（<3s）绿、成功慢黄、失败红；
  · GPT（codex）渠道 tip 新增「降智状态」：是否命中降智/截断 + 292 通行证是否已注入
  （`recent` 记录新增 `d`/`st` 标记，生产调用与探针都写）；
  · 新增 DB 列 `test_prompt/auto_test/auto_test_interval`（建表 + 自动迁移）。 |
| 2026-09-18 | **第 14.1 批（检测模型可选）**：编辑弹窗新增「检测模型」下拉（选项=渠道声明的模型），
  未选择时默认使用渠道第一个模型（`resolveTestModel` 顺序：渠道 `test_model` → 渠道第一个模型 →
  接入方式 `testModel`）；探针把解析出的模型显式传给适配器，测试/定时检测/GPT 降智展示共用同一模型口径。 |
| 2026-09-18 | **第 14.2 批（线上验证与修复）**：修复通用探针对 `rowToChannel.models`（逗号字符串）
  误用数组 `.find` 导致 relay/API 渠道探针报 `find is not a function`；线上实测：GLM 反代渠道返回
  真实回复「Hi there! I'm the GLM model…」，DeepSeek 渠道正确记录账号风控错误（红条）；
  Codex 渠道轮换验证：手动测试（指定 `gpt-5.6-terra` + 自定义提示词）返回「检测OK」，
  定时检测 60s 间隔连续通过（1628ms / 21034ms / 4690ms，回复均为真实 AI 文本），
  `recent` 中 `d`（降智）/`st`（292 通行证）随轮换在 0/1 间正确变化。 |
| 2026-09-18 | **第 15 批（定时检测可见性 + 编辑弹窗细节）**：
  · 新增 `channels.last_test_time`（检测专用时间戳，手动测试/定时检测更新，生产调用不碰）——
  修复「繁忙渠道被每次真实调用不断推迟检测」的缺陷；定时检测到期判断改用它；
  · 最近调用记录新增来源标记 `k`（chat=对话调用 / test=手动测试 / auto=定时检测），tip 头部显示来源；
  · 渠道列表每 30s 静默轮询（页面隐藏时跳过），定时检测的小绿条会自动长出来，无需手动刷新；
  · 编辑弹窗：反代/订阅渠道不再显示「接口地址」（仅 API 渠道有，且不提交空串）；
  · 「支持的模型」多选标签与下拉选项左侧都带厂商图标（新增/编辑共用）。 |
| 2026-09-18 | **第 11 批 UX 修复**：登录/注册切换保留受保护页面回跳；有效 JWT 遇到首屏网络异常时保留会话并提供认证重试；
  首页状态未知时隐藏注册入口；控制台增加加载中、错误和重试状态。令牌、日志、用户、定价、渠道列表增加
  持久错误提示与重试，日志清除搜索回到第一页，刷新按钮补齐无障碍名称；渠道添加补 providers 空/失败态，
  删除渠道同步清除选中项，测试/恢复/编辑/删除等行操作增加禁用、忙碌和 `aria-label`。Agent 无可用能力时
  显示切换提示，重试回答沿用原模型、Agent、思考和联网设置；Agent 的无动作按钮明确禁用。系统设置增加
  加载指示、失败重试并仅在活动 Tab 加载；侧边栏导航、折叠按钮、个人设置主题色支持键盘操作；管理员编辑自己时
  禁止修改启用状态；异步保存/刷新完成前等待列表刷新。涉及 `ooapi-web/src`，并通过 `npm run build`。 |
| 2026-09-18 | **第 11 批视觉与对话体验修复**：后台 `.oo-content` 改为铺满主区域，减少大屏左右空白；
  所有 Ant 表格统一表头、行高、边界线、固定列不透明背景、固定列阴影与底部滚动条，修复右侧固定操作列
  穿透底层列名的问题。对话页复用 Beautiful UI 的 Prompt Bar、Thinking、Streaming Text、Task Rows
  原语，输入框固定为正文区 + 工具栏的桌面编辑器布局，移除 AI 头像、名称和模型标签，AI 回复改为无气泡正文，
  聊天消息与输入区改为响应式全宽。参考组件范围：Beautiful UI 官方 Prompt Bar/Chat/Thinking/Streaming Text/Task Rows。 |
| 2026-09-18 | **第 11 批弹窗密度修复**：渠道添加、编辑、浏览器登录、登录态抓取、凭据导入等弹窗中的说明型 Alert
  统一使用紧凑样式，保留图标、标题和描述，缩小内边距、字体与行距；页面级错误提示保持原有可读密度。 |
| 2026-09-18 | **第 11 批表单密度与控件排列修复**：统一收起低价值 `Form.Item extra` 说明文本，保留字段标签、占位符和校验错误；
  弹窗表单收紧字段间距与垂直标签间距，减少无效留白，改善渠道编辑等三列控件的对齐和整体高度。 |
| 2026-09-18 | **第 16 批（对话页整体重构：对话机制 + 智能体编排 + harness）**：原「对话工作台」改名**对话**（侧栏、面包屑、首页示例文案），
  页面与后端对话链路全部重写，参考 opencode 的「session / message / parts / step / tool / subagent」分层。详见第 1.6 节。
  · **对话机制**：会话与消息落库（新表 `chat_sessions` / `chat_messages`），一次请求跑完整的 harness 循环
  （`services/harness/loop.js`）：拼系统提示词 → 调模型 → 嗅探工具调用 → 执行工具 → 结果回灌 → 下一步，直到产出最终回答或触达步数上限；
  SSE 增量推送 `part` / `part_update` / `delta` / `todo`，前端按 parts 渲染（正文、思考链、工具 chip、待办、提示）；
  · **智能体编排**（`services/harness/agents.js`）：primary（通用/研究/写作/代码，用户直接选择）与 subagent（检索员/审阅员/摘要员，只能由 `task` 工具派发）
  两层，子代理禁止再派发（深度限制），角色提示词只走服务端不下发前端；
  · **harness 设定**（前端编排栏 + 会话设定面板）：智能体、模型、思考、联网、工具开关（search/fetch/task/todowrite）、最大步数（1~16）、会话级系统提示词、会话统计；
  设定随会话落库，刷新不丢；未显式设置时按「智能体默认」兜底且界面同样显示兜底值；
  · **工具**（`services/harness/tools.js`）：全部只读或无副作用 —— 联网检索（复用执行器）、读取网页（逐跳 SSRF 校验 + 去标签转文本）、
  派发子代理、维护待办清单；工具失败把原因交回模型（不终止整轮），每次工具/子代理调用都单独计入本轮账单；
  · **协议**：因渠道里既有 OpenAI 兼容 API 也有网页版反代（不支持原生 tools），统一用「提示词 + 严格 JSON 调用块」协议，
  由 `StepStream` 嗅探（支持 `<tool_call>`、裸 JSON、代码块三种写法，容忍被切开的标签；未闭合按正文吐出，不吞内容；逐字符 delta 下 O(n)）；
  · **计费**：逐次上游调用记 `{prompt, output, usage}` → 逐条 `splitTokens` 求和（与网关同一口径），失败按已产出内容部分计费；
  · **前端**：新增 Beautiful UI 原语 `beautifului-chat.jsx`（Shelf 侧栏 / ToolChips / Notice / SuggestionCard / TodoPanel / OrchestrationBar）
  与 `chat.css`；会话侧栏（新建/切换/双击重命名/删除）、⌘K 命令面板、会话设定抽屉（改名/会话指令/统计）；
  删除旧 `ui-refresh.css`（旧对话页样式），改名同步 `MainLayout` / `HomePage` / `App` 路由；
  · **顺带修复**：移除智能体独立开关（`agent_enabled` 仅保留兼容，功能并入 `chat_enabled`）；
  `Markdown.jsx` 支持表格渲染（见下方二次审查条目）。
  · **顺带修复（二次审查）**：`Markdown.jsx` 支持表格渲染；重新生成改为服务端回退（`POST /sessions/:id/rewind`，删掉该轮问答并重算统计，
  否则重发后上下文里同一个问题会出现两遍）；消息渲染 key 不再用 `seq`（流式期间 0 → done 后变真实值会让整条消息重挂载、动画重播）；
  换会话/新建会话重置滚动状态（此前「回到最新」会跟着新会话错误显示）。
  自检：后端全部改动文件 `node --check` 通过；harness 循环与路由层用 mock 上游/mock 池做端到端自测
  （工具回灌、待办写回、子代理派发、步数上限、格式纠正、未知工具、部分计费、会话 CRUD、余额不足拒绝、
  回退幂等与统计重算：删 2 条后 cost/token/消息数只保留第一轮）；
  前端 `npm run build` 通过；浏览器实测浅色/深色、桌面/移动、流式（思考→工具 chip→正文）、设定面板与命令面板。 |
