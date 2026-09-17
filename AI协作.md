# AI 协作指南（AI协作.md）

> 本文件是本仓库的**唯一协作规范与问题台账**。
> 任何 AI（或人）在修改本项目之前，必须先完整阅读本文件；
> 修改完成后，必须回写「变更记录」与「待办清单」。

最后更新：2026-09-17

---

## 0. 接手须知（给下一个 AI / 开发者）

1. **币制只有一条规则**：`1 OD币 = 1 美元`，额度最小单位 10,000 单位 = 1 OD币。
   全站展示只用 `fmtOd / odOf / unitsPerOd`；**不要**引入人民币汇率、美元汇率、其他币名。
2. **先读第 2 节规范再动手**；改动完成后必须：后端 `node --check` 全部改动文件、前端 `npm run build`、
   回写本文档「变更记录」。
3. **下一批工作按此顺序**（详细见第 4 节待办）：
   - **U1（最高优先，UI/UX）**：`ChatPage` 流式渲染重构（消息 memo、输入隔离、长会话不掉帧），
     然后统一列表页请求竞态防护。
   - P1：`execute.js` 无 `code` 异常按可重试处理；`browser-driver.getSession` 并发首建竞态；
     `pow.js` 同步阻塞拆分。
   - P2：死代码清理（`routes/deepseek.js`、`services/deepseek/`）、UI 视觉统一。
4. 数据库结构改动必须同时改 `db.js` 的建表 SQL **和** `COLUMN_MIGRATIONS`（老库自动补列），
   并在 `channel.js` 的 `rowToResp` 里返回新字段。
5. 不要提交 `.env` / `.jwt-secret`；不要绕过 `services/pricing.js` 自行计费；
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
  - 长列表必须做流式渲染隔离（见待办 U1）；
  - 错误提示统一 `message.error(e.message)`，禁止空 catch；
  - 危险操作（删除、更新、清空）必须二次确认。
- 视觉统一（进行中）：
  - 所有页面标题、卡片、表格、表单间距参照 `ConsolePage`/`TokenPage`；
  - 状态色只用语义变量：成功 `--green`、警告 `--orange`、失败 `--red`、主色 `--accent`；
  - 图标尺寸：正文 13-14，卡片 16，页头 18；
  - 移动端断点用 antd `Grid.useBreakpoint()`，不要写死 `window.innerWidth`。

---

## 3. 本次已修复（2026-09-17，第 1 批）

### P0 功能

| # | 问题 | 修复 |
|---|---|---|
| 1 | `routes/user.js` 6 条 SQL 缺参（改资料/改密码/个人设置/管理员改角色、状态、资料全部 500） | 补全 `id` 参数；密码修改新增旧密码校验 |
| 2 | 全局 1MB JSON 限制先于路由级 50MB/20MB 生效，多模态大图必 413/500 | 改为按路径分层解析（`index.js`）；错误处理器正确返回 413 |
| 3 | 全新安装 `channels` 表缺列（remark/auto_ban/last_error/used_count/last_used_time/test_model） | `db.js` 建表补全 + 启动时 `COLUMN_MIGRATIONS` 自动补列 |
| 4 | `password_register_enabled` 用 `getOption` 判断，字符串 "false" 为真 → 注册开关失效 | 改 `getBoolOption` + 注册限流（5 次/5 分钟） |
| 5 | 新用户赠送额度默认 1 亿单位（=10000 美元）+ 默认开放注册 | 默认改为 2000000（200 美元），注册默认关闭 |

### P1 计费 / 安全 / 稳定性

| # | 问题 | 修复 |
|---|---|---|
| 6 | API 渠道返回的 usage 是对象，`Number(object)=NaN` → 全部按字符估算计费，缓存价从未生效 | 新增 `normalizeUsage`；`splitTokens` 支持对象并返回 `cacheTokens`；网关/站内/智能体全部接入 |
| 7 | 指纹 `needPersist` 无人消费，同一账号每次请求换设备号 | `execute.js` 成功后写回 `channels.other.profile`；DeepSeek `deviceId`、Kimi 设备号改为 seed 确定性派生 |
| 8 | 图片外链可 SSRF（探测内网/元数据） | `gateway.js` 新增 `isPrivateIp` + `assertPublicUrl` + 逐跳重定向校验 |
| 9 | `clientIp` 信任可伪造的 XFF | 改用 `req.ip`，`trust proxy` 默认 `loopback`（可用 `TRUST_PROXY` 覆盖） |
| 10 | `/v1/models` 无鉴权、泄露全量模型 | 与 `/chat/completions` 一致要求 Bearer 鉴权 |
| 11 | 管理员密码硬编码 `Ooapi@Admin2026` | 未设置 `ADMIN_PASSWORD` 时随机生成并打印一次 |
| 12 | 认证中间件 async 异常导致请求挂起 | `authRequired/adminRequired` 加 try/catch → `next(err)` |
| 13 | `markChannelOk` 把管理员手动禁用的渠道重置为启用 | 只更新 response_time/tested_time/last_error |
| 14 | `withChannelLimit` 的 `finally` 派生 unhandledRejection | 先 `catch(()=>{})` 再 `finally` |
| 15 | `openai-compat` 无条件下发 `thinking/enable_thinking`，会让不支持该字段的上游 400 | 默认不下发，渠道 `other.thinking_mode` 显式声明（thinking/enable_thinking/both） |
| 16 | 多 Key 渠道只用第一个 Key | `openai-compat` 请求按渠道轮换 Key |
| 17 | Doubao/Qwen 解析器遇 `data: null` 抛 TypeError | 加对象类型守卫 |
| 18 | `installHook` 全局守卫导致第二个 MATCH_PATH 永不生效 | 改为路径注册表 + fetch 只包装一次 |
| 19 | 浏览器流 `done` 但 0 帧时死等 180s | `st.done` 立即返回，`ok: cursor>0` |
| 20 | DeepSeek `dsFetch` 不检查 HTTP 状态 | 401/403→AUTH_EXPIRED、429→RATE_LIMIT、5xx→HTTP_ERROR，支持 `signal` |
| 21 | 客户端断开不中止上游；重试链共用一个超时预算 | 网关/站内/智能体监听 `req.close` 中止；`execute.js` 每渠道独立超时（读 `request_timeout_ms`） |
| 22 | 无登录/注册限流 | 新增 `middleware/ratelimit.js`（登录 20/分，注册 5/5 分） |
| 23 | 默认价格表 `DEFAULT_PRICES` 从未落库，全新安装全按兜底价计费 | 启动时 `seedDefaultPrices()`（只补缺失，不覆盖管理员改价） |

### 前端

| # | 问题 | 修复 |
|---|---|---|
| 24 | 令牌额度输入框单位错位 10000 倍 | `TokenPage` 全面按 OD 换算（创建/编辑/提交），parser 重写 |
| 25 | 编辑渠道残留上一个渠道的 API Key + 硬编码 `auto_ban: true` | `openEdit` 先 `resetFields`、清空 `api_key`、读取真实 `auto_ban`（后端 `rowToResp` 已返回） |
| 26 | 401 无全局处理，token 过期后不跳登录 | `api.js` 广播事件，`AppContext` 清用户，`RequireAuth` 自动跳转 |
| 27 | `stream.js` 把业务回调异常当非 JSON 行吞掉 | 解析与回调分开 try/catch，回调异常打日志 |
| 28 | `LogPage` 模型正则 `s*`（应为 `\s*`）、充值日志显示为负数、非管理员看到无效搜索框 | 三处均已修 |
| 29 | Markdown 链接未限制协议 | 新增 `safeHref` 白名单（http/https/mailto/相对路径） |
| 30 | `AgentPage` 出错后永久运行中、卸载不清理定时器/流 | `onError`/卸载统一收尾 |
| 31 | `ConsolePage` 刷新整页 reload、复制无 try/catch | 改为重新拉取 + 错误提示 |
| 32 | 设置页「单位额度」编辑的是死键 `quota_per_unit` | 改为编辑真正生效的 `units_per_od` |
| 33 | 在线更新轮询定时器无清理 | `timersRef` + 卸载清理 |
| 34 | 令牌列表掩码泄露前 6 字符 | 只保留 `sk-` 前缀 + 后 4 位 |
| 35 | 修改密码不校验旧密码 | 前端新增「当前密码」字段，后端比对 `bcrypt` |

---

## 4. 待办清单（按优先级）

### P1（建议下一批）

- [ ] **U1（UI/UX，最高优先）**：`ChatPage` 流式渲染重构：
      - 消息组件抽成 `React.memo` 的 `MessageItem`，流式消息独立组件（只重渲染当前消息）；
      - 输入框状态与消息列表隔离（输入态下沉到子组件或独立 context），避免每次按键全量重渲染；
      - 长会话下 Markdown 解析缓存（按消息 id + 内容 hash 缓存解析结果）。
      验收：连续 30 轮对话 + 中途输入不卡顿；React DevTools 中非当前消息不重渲染。
- [ ] **U2（UI/UX）**：列表页请求竞态防护（`TokenPage / LogPage / AdminPricingPage`），
      封装 `useLatest` 或请求序号，快速切页/搜索时旧响应不得覆盖新数据。
- [ ] **U3（UI/UX）**：统一弹窗表单校验流程（`validateFields` 必须 try/catch + 首个错误字段聚焦），
      清点 `AdminUsersPage / AdminPricingPage` 等页面的同类问题；统一 `message.error` 文案风格。
- [ ] `execute.js`：无 `code` 的未知异常按可重试处理（目前 GLM/Kimi/Doubao 的 Playwright 原生异常仍直接 500）。
- [ ] `browser-driver.getSession` 并发首建竞态：用 pending Promise 缓存，避免同 profile 启动两个 Chromium。
- [ ] `pow.js` 兜底求解器：同步阻塞事件循环（最多 10M 次 wasm 调用）且内存不释放，改分批 + 让步。
- [ ] 渠道链路统计 `used_count/last_used_time` 从未更新（字段已存在），在 `execute.js` 成功后累加。
- [ ] `logs` 表清理策略（TTL/归档/后台一键清理已有但无自动策略）。
- [ ] `connectionLimit: 10` 偏小（上游请求常达分钟级），按并发压测调整（建议 50）。
- [ ] 列表请求竞态防护（Token/Log/AdminPricing 页）；建议统一 `useLatest` hook。
- [ ] `AdminChannelsPage` 其余 `validateFields` 未 catch；`AdminUsersPage` 同类问题。
- [ ] `AuthPage` 登录回跳丢失 query/hash；`MainLayout` 的 `/home` 无路由。

### P2（清理与加固）

- [ ] 删除死代码：`routes/deepseek.js`（未挂载）、`services/deepseek/client.js`、`services/deepseek/accounts.js`
      （引用已被 DROP 的 `deepseek_accounts` 表）、`pricing.js` 中重复的 `charge()`、
      `browser-driver.js` 的 `evalInPage/waitForStream`、前端未使用导入。
- [ ] `AgentPage` 已不被路由使用（`/agent` 重定向到 `/chat?mode=agent`）：确认产品意图后删除或合并进 `ChatPage`。
- [ ] `GET /api/channel/login/batch` 串行 50 账号可阻塞数分钟：改异步任务 + 进度查询。
- [ ] GLM `search` 开关应使用解析后的 `resolved.search`。
- [ ] Doubao/Qwen 的 thinking/search 目前静默忽略（适配器未实现注入），要么实现要么显式报错。
- [ ] CORS 默认放开：生产建议 `CORS_ORIGIN` 白名单（已在 `index.js` 支持）。
- [ ] 在线更新无签名校验（供应链风险），考虑固定 commit 或校验发布哈希。
- [ ] `--no-sandbox` 浏览器驱动：文档化部署前提（非 root 用户 + 容器隔离）。
- [ ] 无测试、无 lint：建议最少加 `node --test` 冒烟 + ESLint flat config。
- [ ] `users.inviter_id` / 邀请体系未实现（字段存在）。

---

## 5. AI 工作流（每次修改必须执行）

1. **读规范**：阅读本文件第 2 节；确认改动是否触碰第 4 节待办。
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

### 环境备注（本机）

- Git 未加入 PATH，可用 GitHub Desktop 自带的：
  `& "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.3\resources\app\git\cmd\git.exe"`
- 拉取/推送如需代理：`-c http.proxy=http://127.0.0.1:7892`（代理未启动时两个 npm 镜像可直连）。
- 运行 `ooapi-web` 的 `npm install` / `npm run build` 前确认 `node_modules` 存在；构建产物在 `dist/`，
  生产需复制到 `ooapi-server/web/`。

---

## 6. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-09-17 | 第 1 批修复：P0 功能 5 项、P1 计费/安全/稳定性 18 项、前端 12 项（见第 3 节）；新增本文件 |
| 2026-09-17 | 币制统一：移除"美元汇率"设置项，明确 `1 OD币 = 1 美元`（仅作展示与计费口径，无汇率换算）；同步 README 与本文档规范 |
