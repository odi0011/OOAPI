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

最后更新：2026-09-20

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
| `src/services/metrics.js` | **运维指标采集**（第 34 批） | 零依赖（os/fs/perf_hooks）；`recordRequest/enterRequest/leaveRequest/classifyError/windowStats/healthScore/diagnose`。错误归类决定 SLA 口径，改动前先读 2.6 |
| `src/services/alert.js` | **告警规则引擎**（第 34 批） | 窗口/持续/冷却/静默；`METRICS` 是可用指标目录，新增指标要同时加 `metricValue` 分支 |
| `src/services/notify.js` | **通知通道**（第 34 批） | 自研 SMTP（net/tls，不引 nodemailer）+ Webhook（飞书/钉钉/企微/Slack 自动识别与加签） |
| `src/routes/monitor.js` | **运维监控接口**（第 34 批） | `snapshot`/`stream`(SSE)/`alert/*`；管理员专用。注意 `pool.query` 解构层数（多行结果不能用 `const [[x]]`）。**`/stream` 用一次性票据自鉴权**（EventSource 带不了 Authorization），因此它不走全局 `adminRequired`，改动鉴权时别把它盖回去 |
| `src/services/user-limit.js` | **用户级限流**（第 35 批） | 并发/RPM/TPM 三维度；`setting.limits` 由用户可写，因此语义是**只能收紧不能放宽**（用户填 0 视为未自定义，不能用 0 解除限制） |
| `src/routes/community.js` | **社区大厅**（第 37 批） | 话题/帖子/评论/点赞收藏/关注。计数是冗余字段（列表按热度排序不能逐帖查子表），漂移用 `POST /admin/recount` 修；点赞靠唯一键去重而不是先查再插；**评论强制扁平二级**（回复二级评论时 parent_id 归一到一级父节点，靠 `reply_to_user_id` 渲染 @谁）—— 无限级递归在窄屏会把正文压成细条 |
| `src/routes/chatroom.js` | **实时聊天**（第 37 批） | 单聊/群聊/讨论组。单聊靠 `single_key` 唯一键保证唯一（否则连点两次会建出两个房间）；**未读用 `last_read_id` 算**，不维护冗余未读计数；消息带 `client_id` 原样回显（前端乐观队列据此对账）；**任何房间读写先过 `memberOf()`**，否则知道 room_id 就能读别人私聊 |
| `src/services/realtime.js` | **实时推送中枢**（第 37 批） | 进程内 SSE 广播。写失败必须摘除连接（否则一直往死连接写）；心跳保活（反代会掐 60s 无数据的连接）；**多实例部署必须改共享存储**（已登记遗留项） |
| `src/routes/games.js` | **联机对战路由**（第 37 批） | **不含任何游戏规则**，只做房间生命周期 + 把操作转交引擎 + 广播。三条不变式：房主恒为 side 1（客户端不能自选阵营）；state 由引擎产出、路由不解释它；**返回必须带 viewer 的 side**（`view()` 据此过滤隐藏信息） |
| `src/services/games/*.js` | **游戏引擎**（第 37 批） | 每游戏实现 `init/move/view/meta`（海战棋另有 `place/ready/auto`）。**服务端权威**：客户端只提交走子意图，合法性/轮次/胜负全在服务端判定。`view(state, {side})` 决定可见范围 —— 海战棋据此隐藏对手布阵。加新游戏只需实现引擎 + 前端一个渲染分支，不用动路由与对战 UI |
| `src/routes/profile.js` | **个人主页**（第 37 批） | **匿名可达**（`optionalAuth`），但只出公开字段：邮箱/余额/用量/IP 一律不下发（有测试断言）。用量与邮箱仅在「本人或管理员」时返回 |
| `src/routes/dashboard.js` | **数据看板**（第 37 批） | 个人维度与全站维度分开。错误统计查 `type=4` 错误日志 —— **logs 表没有 status 列**，拿消费日志数「status<>1」会一条都数不到（静默算成 0 错误） |
| `migrate6.mjs` | **历史数据迁移**（第 37 批） | 老消息内联 base64 → 媒体库。幂等靠「parts 里还有没有 base64」而不是靠打标；**有图片失败就整条不更新**（不更新只是下次重试，更新了就是数据丢失）；结尾必须 `process.exit`（媒体库模块的定时器/连接池会挂住进程） |
| `src/services/upstream/vendor-quirks.js` | **厂商协议特化**（第 40 批） | 只收「会影响正确性」的差异，按 `channel.type` 分发（**不按 base_url** —— 用户可能把官方地址换到自建中转上）。当前四项：MiniMax 强制 `reasoning_split`、方舟读降级后实际模型、StepFun 参数裁剪、`<think>` 块兜底剥离。新增厂商差异时加在这里，别往 openai-compat 里塞 |
| `src/services/upstream/mimo-web.js` | **小米 MiMo 网页版反代**（第 41 批） | 纯 Cookie（`serviceToken`/`userId`/`xiaomichatbot_ph`）+ 标准 SSE，零签名。**`xiaomichatbot_ph` 同时要作为 URL query**（上游双校验），漏了会被风控 |
| `src/services/upstream/minimax-web.js` | **MiniMax 网页版反代**（第 41 批） | 接入点是 `agent.minimaxi.com`（`chat.minimaxi.com` 只剩 307）。签名 `x-signature`/`yy` **都是纯 MD5**；`yy` 依赖指纹参数（uuid/device_id/screen_*），**必须按账号固定**（随机变化是强风控信号） |
| `src/services/upstream/stepfun-web.js` | **阶跃星辰网页版反代**（第 41 批） | 接入点是 `chat.stepfun.com`（**不要用 yuewen.cn，证书过期+403**）。零签名；难点是 Connect RPC 分帧（1B flags + 4B len，与 kimi 同构） |
| `src/services/device-bind.js` | **一键绑定（设备授权）**（第 40 批） | Kiro/WorkBuddy/Qoder 的 `start/poll/cancel` 统一抽象。**三家的 `judge*` 判定函数是导出纯函数**（便于无上游依赖地测最易错的分支）。会话存进程内（单机单实例）；凭据不经浏览器，见路由注释 |

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
| `src/components/Charts.jsx` | **全站图表唯一入口**（第 34 批） | `LineChart/BarChart/RankBar/Sparkline/Legend` + `SERIES_COLORS`；新页面画图必须复用，禁止自写 SVG 与配色。规范见 2.5 |
| `src/components/ChannelQuota.jsx` | 渠道额度展示（sub2api 风） | 窗口标签（5h/7d/30d）由接口返回的 `limit_window_seconds` 推导，**不要硬编码**；颜色分档 <70 绿 / 70-90 橙 / >90 红 |
| `src/components/ModelPicker.jsx` | 模型范围选择器 | 「从上游获取模型」调 `/channel/:id/upstream-models`；空选 = 该厂商全部模型（与后端语义一致） |
| `src/pages/MonitorPage.jsx` | **运维监控 + 告警中心**（第 34 批） | 数据来自 `/api/monitor/snapshot`（轮询）与 `/api/monitor/stream`（SSE 实时）；告警规则/事件内嵌在页面内，不用弹窗 |
| `src/pages/CommunityPage.jsx` + `PostDetailPage.jsx` + `components/PostList.jsx` | **社区**（第 37 批） | 骨架 C 类（双栏流式阅读，宽屏不拉满）；列表是**单列列表式**不是卡片瀑布流，摘要 `-webkit-line-clamp: 2`，多图只给 1~3 张 56px 微缩图 +N；评论扁平二级、缩进恒为 1 级 |
| `src/pages/MessagesPage.jsx` | **消息中心**（第 37 批） | 骨架 B 类（视口锁定，输入框必须常驻可见）；移动端走**路由级主从堆叠**（`/messages` → `/messages/:roomId`），不用抽屉；发送走**本地乐观队列**（clientId 对账，失败标红可重试，不静默丢弃） |
| `src/pages/GamesPage.jsx` | **Playground**（第 37 批） | 六款联机对战共用一套对战框架，差异由引擎 `meta.render/click` 决定（`grid-stone`/`xiangqi`/`battleship`/`column`）。视觉是 Terminal Arcade（只用设计系统变量，无卡通色）；**键盘仅在棋盘获焦时接管**；`?room=` 支持分享链接 |
| `src/pages/ProfileViewPage.jsx` | **个人主页**（第 37 批） | 恒为 `/u/:id`，靠 `is_self` 切换主操作（自己=编辑资料；别人=关注+私信）。统计内嵌一行 `.oo-stats-strip`（不是 4 张大卡），点击就地切换列表 |
| `src/pages/AdminDashboardPage.jsx` | **平台看板**（第 37 批） | 与个人看板 `/console` **物理分离**（权限边界靠路由守卫而不是前端 if）；关注点是渠道延迟/全站吞吐/谁在刷 |
| `src/pages/AppearancePage.jsx` + `theme/presets.js` | **外观设置**（第 37 批） | **即时热注入**：onChange 直接 `setProperty` 到根样式，没有「保存后刷新」。背景只有 4 个受控几何预设（透明度锁 3%~6%、颜色绑定 `var(--line)`），避免自由壁纸毁掉对比度。`applyAppearance` 是唯一入口 |
| `src/pages/AdminCommunityPage.jsx` | **社区管理**（第 37 批） | 话题 CRUD（停用比删除温和：历史帖仍可读）+ 内容审核（隐藏可恢复、置顶）+ 计数重算入口 |

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
| 实时浏览器（noVNC） | 登录抓取支持 noVNC 实时画面：`ooapi-vnc.service`（x11vnc+websockify）挂 `:99`，nginx 用随机路径令牌反代到 `127.0.0.1:6080`；令牌在 `.env` 的 `VNC_PUBLIC_PATH`（未配置则前端自动退回截图模式）。首次部署/换机跑 `scripts/setup-vnc.sh`（固定 xvfb display 为 99）；x11vnc 报 auth 错时跑 `scripts/fix-vnc-auth.sh`（从 Xvfb 进程动态取 `-auth`） |

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
| `harness/runs.js` | 进行中运行的环形缓冲与订阅（断线续传） | 事件必须存快照；只有 `/stop` 才 abort；`MAX_EVENTS` 超出丢最早 |
| `harness/files.js` | 附件文本提取（文本/代码 / PDF / DOCX / XLSX） | 无第三方依赖：PDF 用 zlib 解流抽文本算子，Office 走手写 zip；解析失败必须给出明确原因 |
| `upstream/cli-profile.js` · `shared-profile.js` · `deepseek-profile.js` | 指纹/身份派生（订阅渠道 + 网页反代） | 种子只用稳定字段；`sec-ch-ua` 品牌顺序与 grease 串必须两个模块一致；UA/平台/`--lang`/`navigator.languages` 要自洽 |
| `upstream/browser-driver.js` | Playwright 常驻会话（GLM/豆包/通义反代） | 禁止 `--window-position=-32000` 与 `--enable-automation`；同账号串行 + 15 分钟看门狗 |
| `services/channel-probe.js` | 渠道探针（测试 / 定时检测共用） | 必须走 `withChannelLimit`（历史上绕过限速会并发打同一账号） |
| `upstream/*-parser.js` | 各厂商流式解析 | 风控响应禁止原地重试；未知帧/未知 contentType 尽量当正文输出，不要静默丢内容 |
| `upstream/oauth-login.js` | 订阅渠道交互式登录（Google 已支持） | 手动粘贴回调地址是设计取舍（官方 redirect_uri 指向用户本机 localhost）；state 必须校验；缺 refresh_token 直接拒绝 |
| `upstream/glm.js` 的 `patch_model` | 渠道级开关：是否向上游注入 model | 默认关（保守）；无论开关如何都要核对 `lastBody.model` 并在不一致时告警 —— 计费按用户选的模型算 |
| `components/ArtifactPreview.jsx` | 产出物预览（HTML/SVG/React 沙盒运行） | **绝不能加 `allow-same-origin`**；保留 CSP `connect-src 'none'`；默认不渲染 |
| `components/PromptBar.jsx` | 输入栏（独立于 `beautifului.jsx`） | 尺寸取自组件库官网实测值；`styles.css` 里**不要**再写 `.bui-composer*` 同名规则（曾覆盖导致样式不一致） |

**数据流**：`POST /api/chat/run` → 落库用户消息 → `runHarness`（每步一次上游调用，工具结果以 `<tool_result>` 回灌）→
逐次调用 `splitTokens` 求和后按 `pricing.js` 计费 → 助手消息（parts JSON）落库 → 更新会话 `todo` 与统计。

**协议边界**：渠道里既有 OpenAI 兼容 API，也有网页版反代（不支持原生 `tools`），因此工具调用统一用
「提示词 + 严格 JSON 调用块」文本协议，由 `StepStream` 嗅探。新增渠道类型无需改协议。

**计费约束**：每轮里**每一次**上游调用（主回答、工具检索、子代理）都要 `record()` 进 `calls`，
失败时用 `err.calls` 带出并部分计费；禁止只按最后一次调用的 usage 计费。

**断线续传（第 19 批）**：运行跑在服务端、与 HTTP 连接解绑（`harness/runs.js` 的环形缓冲 + 订阅）。
改动 `/run`、`/stream` 时务必守住三条：① 客户端断开**不能** abort 上游（只有 `/stop` 才能）；
② 事件必须是**快照**（part/patch 浅拷贝），否则回放会把累积文本当初始事件再叠加 delta → 界面内容重复；
③ 同一会话并发只允许一个运行（409），否则双跑双计费。

**模型列表（第 19 / 21 批）**：`/meta` 的模型必须是**该用户 + 该密钥实际能调用的**，不是后台渠道全量 ——
`分组模型限制（groupConfigOf）∩ 分组成员渠道声明（channelInGroup + channels.models）∩ 密钥 model_limits`，
管理员豁免密钥层。**改了任一侧的过滤逻辑，另一侧必须同步**，否则「页面上能选」≠「实际能调用」。

**密钥即路由身份（第 21 批）**：站内对话扣账户额度、不经 Key，但 `/run` 用**选中密钥绑定的分组**去路由与计费
（`routeGroupOf` → `groupName` → `selectChannels` + `applyGroupRate`）。这与网关 `/v1` 用 `token.group_name` 是同一口径。
新增入口若也要按密钥路由，复用 `routeGroupOf`，不要自己读 `user.group_name`。

**文件附件（第 21 批）**：解析在服务端（`harness/files.js`，不引新依赖）。解析结果作为 `file` part **落库**并进历史上下文，
所以：改 `historyToMessages` 时必须保留 file 分支（否则追问会"忘"附件）；上限是单文件 8MB / 5 个 / 正文 30k 字符，
调整时同步 `/meta` 的 `upload` 字段（前端据此提示）。

**产出物预览的安全边界（第 21 批）**：`ArtifactPreview` 的 iframe 必须保持
`sandbox="allow-scripts"` **且绝不能加 `allow-same-origin`** —— 加了就等于把本站的 localStorage（含登录令牌）交给模型生成的代码；
同时保留 CSP 的 `connect-src 'none'`。这是本项目唯一会执行"模型生成代码"的地方，改动前务必想清楚。

### 1.7 反代适配器的风控红线（第 22 批）

反代渠道（网页版 / 订阅 OAuth）最大的风险不是「请求失败」，而是**被上游识别成脚本后封号**。
以下几条是审查后确立的硬约束，改适配器时必须遵守：

**一、风控响应禁止原地重试。** 401/403/202/405/风控文案/429 都代表「这个账号已经被盯上」，
连续重试只会把临时限制升级为封禁。正确做法是**立即隔离**（抛带 `cooldownSec` 的错误，交给 `execute` 换号）。
只有 5xx 这类瞬时故障才允许重试。
（历史事故：`deepseek.js` 的 `wafBlocked()` 包含 403，使 `403 → AUTH_EXPIRED` 分支永远不可达，
风控响应被重试 3 次、只冷却 300s。）

**二、冷却时长要与「能否自愈」匹配。** `execute.js` 的默认档：风控 WAF 6h、验证码 1h、
登录失效 6h、其余 5 分钟。适配器能用 `err.cooldownSec` 覆盖（如 grok 免费额度 24h、codex 降智 90s）。

**三、探针/检测必须过限速闸门。** 一切向上游发消息的入口都要走 `withChannelLimit`
（`probeChannel` 已统一包住）。否则「批量检测」会并发打同一账号。

**四、指纹必须确定性派生且内部自洽。** 种子只用稳定字段（渠道 type + id，见 `cli-profile.profileSeed`）；
`sec-ch-ua` 的品牌顺序与 grease 串、UA 里的平台、`--lang` 与 `navigator.languages` 必须互相一致 ——
不自洽比「版本旧」更容易被标记。

**五、浏览器渠道不要留自动化特征。** 窗口坐标不能用 -32000 这类魔法值（页面可读 `window.screenX`）；
必须忽略 `--enable-automation`（否则 `navigator.webdriver === true`）。

**六、解析器不能静默丢内容。** 未知帧类型/未知 contentType 一律尽量当正文输出，
实在无法处理也要留痕；「上游有输出但网关报空」是最难排查的一类线上问题。
（历史 bug：Kimi `done !== undefined` 提前收流、`0x80` 误判压缩位丢弃帧、Qwen role 过滤失效回放用户提问、Doubao 纯字符串丢文本。）

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

### 2.5 数据展示规范（强制 · 全站统一）

> 目的：同一个「汇总数字」在渠道管理、使用记录、运维监控里长得一样，
> 用户不用重新学一遍；也避免每加一个页面就多一套配色。
> **新页面一律复用下列现成类与组件，禁止自创。**

**① 汇总数字用哪种形态 —— 二选一，按「页面主体是什么」决定**

| 场景 | 用什么 | 类 / 组件 | 说明 |
|---|---|---|---|
| 页面主体是**表格/列表**，汇总只是辅助 | 一行小标签 | `.oo-stats-strip` + `.bui-chip` | 大卡片会把表格挤出首屏 |
| 页面主体**就是统计数据** | 小卡片网格 | `.oo-stats-cards` + `.oo-stat-card` | 卡片内 `.oo-stat-card-num` + `.oo-stat-card-label` |
| 单个大数字做面板头 | `.oo-stats-card` + `.oo-stats-card-head/-title` | 面板容器，右侧常放说明文字 |

判定口诀：**表格页用小标签，看板页才用卡片**。两者不要混用在同一个页面。

**①-b 全宽是硬要求：页面与区块都必须铺满**（第 42 批用户第三次确认）

- **页面外层**不设限宽：不要 `maxWidth`、不要 `oo-content--narrow` 那类居中容器；
- **区块内部**也要铺满：`.oo-stats-cards` 用 `minmax(148px, 1fr)` 等分，
  **禁止**给单卡设 px 上限再 `justify-content: start`
  （那是把「卡片太宽」换成了「卡片挤在左边 + 右侧大片留白」，更难看）；
- **例外只有一处**：长文本输入框/正文列可以限宽
  （单行 1600px 要来回扫视），限宽加在**控件**上而不是面板上；
- 验收方式：逐**区块**量「实际宽度 / 可用宽度」，阈值 90%，
  不能只看有没有 `max-width`（见 2.7 第 ⑯ 条）。

**② 图表 —— 唯一入口是 `components/Charts.jsx`**

| 需求 | 组件 | 约定 |
|---|---|---|
| 时间趋势（单/多序列） | `<LineChart series={...} />` | 平滑曲线（Catmull-Rom→贝塞尔）、区域填充、悬浮十字线 + tooltip |
| 多序列必须配 `<Legend />` | 否则不知道哪条线是什么 | — |
| 分布对比（延迟直方图、状态码分布） | `<BarChart bars={...} />` | 纵向柱，最多显示 10 档 |
| 排行榜（模型/渠道/用户/厂商/表体积） | `<RankBar items={...} />` | 横向条 + 数值，与渠道用量统计弹窗同款 |
| 卡片内的小趋势 | `<Sparkline values={...} />` | 无坐标轴，只有一条线 |

- 配色只取 `Charts.jsx` 导出的 `SERIES_COLORS`：`#3b82f6`(蓝) `#22c55e`(绿)
  `#f59e0b`(橙) `#ef4444`(红) `#a855f7`(紫) `#06b6d4`(青) `#ec4899`(粉) `#64748b`(灰)。
  语义固定：**绿=正常/成功、橙=注意/排队、红=异常/失败**，不要为了好看换色。
- Y 轴最多 4 档刻度，X 轴最多 7 个标签（`maxXTicks`），数字用 `fmtCompact`（万/亿紧凑格式）。
- 使用率进度条统一走 `.oo-bars-fill` 或额度条的 `usageColor()`：
  `<70%` 绿、`70-90%` 橙、`>90%` 红（与渠道额度条同一套阈值）。

**③ 分组/渠道的展示（列表里）**

「左图标 + 右标题 + 标题下小字备注」是**统一形态**：
- 图标：厂商图标用 `VendorIcon`；多厂商分组显示折叠态（前 3 个叠加 + `+N`）；
- 标题：主名称；备注：`.oo-truncate` 单行省略，无备注则不占位；
- 渠道列表的列顺序固定：**状态 → 名称 → 模型 → 额度 → 优先级/权重 → 最近调用 → 操作**。
  额度列紧跟模型列（用户按「这个号能跑什么、还剩多少」的顺序读），
  **额度不要单独放查询按钮**——操作栏要留给真正的操作。

**④ 金额与额度的展示**：只走 `fmtOd / odOf / unitsPerOd`，见 2.1 第 1 条。

### 2.6 监控指标口径（强制 · 新增指标前必读）

> 口径错了比没有监控更危险：会把「没事」显示成「有事」，或让告警规则安静地失效。

**① 错误分三类，绝不能混在一起算**

| 类别 | 判定 | 是否计入 SLA 分母 | 为什么 |
|---|---|---|---|
| 业务限制 `businessLimited` | 余额不足、配额超限、Key 无效/过期、账号被禁、无可用渠道、本地限流、账号被风控静默 | **否** | 是我们自己的策略拦下的，不是服务故障。算进去会让 SLA 被用户没钱刷低 |
| 上游保护性限流 | 上游返回 429 / 529 | 否（单独计数 `count429/count529`） | 上游的正常保护行为，不代表上游坏了 |
| 上游真实错误 `upstreamErrors` | 其余打到上游后失败（排除上面两类） | 是 | 这才是需要排查的故障 |

- 判定入口是 `classifyError(err)`（`services/metrics.js`）：先看 `err.code` 是否在
  `BUSINESS_LIMIT_CODES`，再从 `err.upstreamStatus` 或错误消息里的
  「上游返回 HTTP 4xx/5xx」解析上游状态码。
- `SLA = 成功 / (总请求 - 业务限制)`，所以 **SLA ≥ 成功率**恒成立（测试里有断言）。
- 新增错误码时：判断它属于哪一类并登记，否则默认会被当成「上游真实错误」而虚报故障。

**② 累计值 vs 窗口值 —— 别用错**
| 指标 | 含义 | 用在哪 |
|---|---|---|
| `gateway.*`（`requests`/`errors`/`latency`…） | **进程启动至今**累计，重启清零 | 页面顶部的总量显示、分位分布、排行榜 |
| `windows.m1/m5/m60`（`windowStats`） | **最近 N 分钟**从分钟桶聚合 | 告警规则求值（`rule.window_min` 取的就是这套） |

- 率类指标在**无样本时必须返回 `null` 而不是 0**：
  `错误率 = 0%` 会让「错误率 > 5%」的规则永远不触发，看着正常其实没数据；
  `metricValue` 对无样本返回 `null`，求值循环据此跳过该规则。
- `windowStats().partial` 表示窗口覆盖不完整（进程刚启动或窗口长于保留的 180 分钟），
  前端应标注「样本不足」，不要当成真实值下结论。

**③ 健康分与诊断的关系**

- 健康分 = 业务健康 70%（错误率 50% + TTFT 50%）+ 基础设施 30%（存储 40% + 计算 30% + 任务 30%）。
- **有失败请求就不算「空闲」**：`hasTraffic = requests >= 3 || errors > 0`。
  只看请求数会把「2 个请求全失败」判成 idle 100 分，和诊断里的 critical 自相矛盾（线上踩过）。
- 诊断是纯规则引擎，每条必须给「现象 / 影响 / 建议」三段，建议要可执行。

**④ 系统指标的平台差异**

- `os.loadavg()` 在 **Windows 恒返回 [0,0,0]**，必须判 `platform === "win32"` 返回 `null`。
- `fs.statfsSync` 在 Windows 需要盘符根路径，取不到时返回 `null` 而不是抛错。
- `monitorEventLoopDelay` 的直方图**必须每次读取后 `reset()`**，否则是进程启动至今的累计值。
- CPU 使用率是两次采样的差值，**首次调用返回 `null`**（前端显示「计算中」）。

**⑤ 告警规则的默认值**

新增内置规则写在 `services/alert.js` 的 `DEFAULT_RULES`，**只在 `alert_rules` 表为空时写入**，
绝不覆盖管理员已有的改动。规则被停用/删除后不要靠启动重新 seed 恢复。

### 2.7 踩过的坑（写代码前先看，能省一次返工）

> ①-④ 来自第 35 批审查，⑤-⑧ 来自第 37 批实现过程，⑨-⑩ 来自第 37 批返工，
> ⑪-⑭ 来自第 40-41 批。共同特征是：
> 语法检查通过、构建通过，但线上在静默地算错、失效或白屏。

**① 「字段存在」不等于「有数据」**

用 `u.prompt_tokens !== undefined` 判断上游有没有报输入量是错的：
- `openai-compat` 的 `pickUsage` 会把缺失字段**补成 0**，
  于是「只回 total_tokens」的上游变成 `{prompt:0, completion:0, total:N}`；
- 按「字段存在」判定会把它当成精确明细 → `splitTokens` 返回 0/0/0 → 整单只剩 1 单位兜底价；
- 反过来只按「值 > 0」判定又会踩另一个坑：只回 `output_tokens` 时缺的输入侧被当 0，
  整段上下文（几万 token）不计费。

正确写法：**字段缺失与值为 0 一律视为「该侧没有数据」**，交给估算补齐
（`normalizeUsage` 现在就是这么做的，见 `partial` 标记）。
新增任何 usage 归一化逻辑时，先确认这两种形态都有测试覆盖。

**② 并发闸门的「占名额」必须与「准入」同一时刻**

`withChannelLimit` 在这个点上错过两次：
- 第一次是 `gate.then(() => run())` 且 run 内 await 整个任务 → 配 8 也严格串行（参数是空操作）；
- 第二次是名额在「等完 `min_gap`」之后才 `++` → `min_gap` 窗口内到达的请求全部看到
  `inflight=0` 而放行，实测 `concurrency=2` 被突破到 5，且同一毫秒齐发（正是要避免的脚本特征）。

规则：**占名额与准入判断之间不允许任何 `await`**；
`finally` 里释放并唤醒下一个等待者；等待者要被唤醒后能重新排队（避免并发度凭空少 1）。
改动这块必须跑 `tests/concurrency-gate.test.mjs`——它用真实计时验证上限，
普通单测和静态检查都发现不了这类问题。

**③ 设置了却不生效，比没有这个设置更糟**
第 35 批的 P0 里有一半是「空配置」：`default_user_concurrency/rpm/tpm`、`retry_times`、
`gateway_ping_interval` 在系统设置里能改，但**没有任何代码读取**。
管理员以为配了限额，实际完全不生效——这比没有开关危险得多，因为它会让人以为已经防住了。

写任何设置项时：**要么在同一个提交里接上消费方，要么不要加**。
加完之后用 `grep` 确认它至少被读取一次（`AI协作.md` 里曾把「模型列表」因同样理由删掉）。
同理，计费/鉴权路径上的每个配置都要有一条「配了就生效」的测试。

**④ 「构建通过」不等于「页面能打开」**

本项目因这条栽过三次，每次都是「构建/语法全绿，线上却挂」：
- MainLayout 模块顶层常量引用了未导入的图标 → **全站白屏**；
- `AdminChannelsPage` 的 `columns` 数组（立即求值）引用了 370 行后才 `useState` 的变量
  → `const` 暂时性死区 → **渠道管理页白屏**；
- 监控快照 `const [[tbl]] = await pool.query(...)` 把多行结果解成第一行
  → 接口 **500**（语法检查完全看不出）。

规则：
- **前端改动** → 必须跑 `BASE=http://47.79.85.60 xvfb-run -a node tests/ui-smoke.mjs`
  （真实浏览器逐页断言有渲染内容）。`vite build` 只证明能打包，不证明能运行。
- **接口改动** → 必须跑 `tests/monitor-smoke.mjs` 并对新接口补字段结构断言。
- 尤其是**模块级/立即求值表达式**（数组字面量、对象字面量、JSX、函数调用）里引用的
  任何 `const`，都要确认它在**声明之后**才被使用；`useState` 一律写在 `columns` 之类
  会立即求值的东西之前。

**⑤ 分批查数据时不要假设「一次只调用了一次」**（第 37 批）

代码里既有 `pool.query`（返回 `[rows, fields]`）又有自己的 `t(query)` 包装
（直接返回 rows），混用时会多一层/少一层解构，表现为「接口 200 但结构不对」
或直接 500。第 37 批的两个实例：
- 冒烟测试里 `ok(res, data)` 的响应体是 `{success, message, data}`，
  断言直接读 `body.count` 就是 undefined（要读 `body.data.count`）；
- 游戏排行榜把「一方多个可写实例」写错，触发 MySQL 的
  `ONLY_FULL_GROUP_BY`（详见第 4 条验证清单里的 `sql-compat`）。

规则：**写完后把返回值 `console.log` 一次真实结构**，或直接跑对应测试；
不要靠「我记得它返回什么」断言。

**⑥ 隐藏信息类功能，检查方法本身也可能是错的**（第 37 批）

海战棋要保证「对手看不到我的布阵」。第一版检查是拿舰位下标去响应 JSON 里
做子串匹配 —— 而单位数（0/1/2/7）会命中 `id`、`version`、时间戳，
于是**每次都报「泄露」**，让人去修一个不存在的 bug（浪费一轮）。
真相是后端一直是对的（`foeBoard` 全 -1）。

规则：**断言要对着结构写**。检查「不该有的数据」时，
断言那个字段的值域（全为 -1 / 不含标记位），而不是在序列化文本里搜子串。

**⑦ 迁移/一次性脚本必须能自己退出**（第 37 批）

`migrate6.mjs` 复用 `services/media.js` 之后**跑完不返回**：
该模块拉起了定时器与连接池，Node 事件循环一直有活干。
手动执行时看着像卡死，被 `execFile` 调用时直接超时。
规则：一次性脚本结尾显式 `process.exit()`，并且**自己跑一遍验证它真的会退出**。

**⑧ 别让「等待态」挡住用户能做的事**（第 37 批产品层教训）

海战棋房主建好房间后要等对手进来才能布阵 —— 而布阵完全不需要对手在场。
端到端测试暴露了这条摩擦（「还在等待对手加入」）。
规则：动作的**前置条件按动作本身判断**，不要按房间的粗粒度状态一刀切
（`place/ready/auto` 在 waiting 就放行，`move` 才必须等对手）。

**⑨ 「DOM 断言全绿」不等于「页面能看」**（第 37 批最严重的一次返工）

用户看到线上后直接说「真他妈的丑」。原因是我的验证只做 DOM 结构断言
（`#root` 有内容、元素数量对），**从没亲眼看渲染结果**，于是：
  · 统计卡被 `minmax(118px, 1fr)` 在 1880px 下拉成 400px 宽的薄片；
  · 图表死写 2 列 → 每张宽 790px 高 132px，宽高比 6:1，折线成一条平线；
  · 主趋势图 `span={2}` 独占 1600px；
  · 聊天页右侧整块空白（无条件 `display:none`，注释却写着「移动端隐藏」）；
  · 余额可用显示「3365587 天」。
这些**没有一个是构建或断言能发现的** —— 它们全是视觉问题。

规则：**涉及布局/视觉的改动，必须截图自己看一遍**
（`tests/shots.mjs` 会按 1880×900 视口把关键页面截图存盘）。
另外两条具体要求（Gemini 评审里早就写了，我当时只在注释里复述、没实现）：
  · A 类页面（卡片与图表）内容区**限宽 1440px 居中**；
    表格页才铺满。判断标准是「页面主体是表格还是卡片/图表」。
  · 图表网格按 `auto-fit, minmax(380px, 1fr)` 自适应列数，
    不要写死列数、也不要写死跨列像素。

**⑩ 隐藏信息功能，先怀疑服务端再怀疑测试**（第 37 批真实泄露）

游戏测试报「对手看到 5 舰，但他自己布了 0 舰」。第一反应是测试前提错了
（确实错了：没让对手加入，拿到的是观战视角）。**但服务端也有真泄露**：
海战棋 `view()` 写的是 `const me = side || 1` —— `side=0`（观战者）
会**回退成 1 号玩家视角**，把房主完整布阵连同「还剩几舰」一起发出去。

规则：
  · 隐藏信息类功能，**缺省/异常入参必须有明确语义**，不能 `|| 默认值`
    悄悄回退到某个玩家的视角（那等于给观战者开图）；
  · 与「谁还剩多少」相关的**派生指标**（还剩几舰、命中率）同样是隐藏信息，
    能反推布局的都要藏；
  · 测试报出信息类问题时，两侧都要查 —— 测试前提可能错，服务端也可能真漏。

**⑪ 「声明了 state 却没拉取」这类空实现，只有看界面才能发现**（第 40 批）

一键绑定 UI 写完了、构建通过、测试全绿，但**界面上根本不显示**。根因是三处：
① `deviceBindVendors` 声明了 state 却**从没调用接口拉取** ——
   空数组上 `.includes()` 恒为 false，不报错、不白屏、DOM 断言也查不出；
② 厂商判断用错了 key（Kiro 挂在 `anthropic` 厂商下，`provider.key` 是
   "anthropic"，只有 `method.key` 才是 "kiro"）；
③ 凭据标签对 oauth 方法一律显示「粘贴凭据」，Anthropic 下同时挂着
   Claude 订阅与 Kiro 反代 → **两个同名标签**，用户分不清选哪个。

规则：
  · 新增 UI 分支后，**截图确认它真的渲染出来了**（`tests/shots-channels.mjs` 已工具化）；
  · 功能开关的判据要看**最具体的那个 key**（method 而非 provider），
    并在注释里写清为什么 —— 两者名字不同时极容易写反；
  · 同一容器里出现多个同类标签时，标签必须能区分（用具体名字而不是统称）。

**⑫ 测试读不到弹窗内容：Portal 挂在 body 下**（第 40 批）

Ant Design 的 Modal 走 Portal，DOM 上挂在 `document.body` 而不是 `#root`。
测试里读 `#root.innerText` 断言弹窗内容会**永远拿不到**（返回空串），
表现为「断言失败但截图里 UI 明明是对的」。
规则：断言弹窗类内容用 `document.body.innerText`；
**当断言失败而截图看着正常时，先怀疑定位器/取值源，别急着改功能代码**
（这次差点因此去改一处本来就是对的实现）。

**⑬ grid 子项要滚动，行轨道也必须约束**（第 41 批）

弹窗改成「左右两栏各自独立滚动」时，给子项设了 `overflow-y: auto` 与
`min-height: 0`，但右栏**依然滚不动**，长表单底部的控件被静默裁掉。
根因：`display:grid` 的**行轨道默认是 max-content**，会被内容撑高 ——
容器跟着内容一起长高，`overflow` 永远不触发。
只给子项设 `min-height: 0` 是不够的（那是 flex 的规则），
**必须同时写 `grid-template-rows: minmax(0, 1fr)`**。

规则：grid 里做滚动容器，行轨道用 `minmax(0, 1fr)`；
验证方式不能靠截图（内容被裁掉在静态截图里看不出来），
要断言 `scrollHeight > clientHeight` 且**滚到底后没有元素超出容器底边**。

**⑭ 构建失败却提交了**（第 41 批）

我用 `npm run build 2>&1 | grep -E "✓ built|ERROR"` 看构建结果，
自以为没问题就提交 —— 实际上 grep 把 `ERROR` 行过滤掉了，
**构建是失败的、语法是坏的**，提交信息里还写着「已完成」。

规则：**提交前必须看命令的退出码**（`npm run build || echo BUILD_FAILED`），
不能只依赖过滤后的输出；过滤输出会掩盖错误，让失败看起来像成功。
这条与第 ④ 条（「构建通过 ≠ 页面能打开」）是一对：
④ 说的是构建通过不代表没问题，⑭ 说的是**构建失败也可能没被看见**。

**⑮ 已打开的 SPA 页面永远看不到新版本**（第 42 批，用户报「图标没变」的真因）

用户反馈「图标全是平台 logo、之前好的也变了」，我改代码、重建、部署、又在
服务器上用 Playwright 截图 —— 截图里 19 个图标**全部正确**，滚动也正常。
差点据此回复「服务器上是好的，是你那边的问题」。
真正的证据在 nginx access.log：

```
20/Sep/2026:09:44:52  114.228.138.238  "GET / HTTP/1.1" 200        ← 打开页面
21/Sep/2026:11:06:33  114.228.138.238  "GET /assets/index-Bj1-5AG3.js" 200  ← 才加载新包
21/Sep/2026:11:06:57  114.228.138.238  "GET /icons/mimo.png" 200    ← 之后图标才正确
```

也就是说：他的页面是**发版前**打开的，SPA 打开后不再请求 index.html，
bundle 换了也不会换，XHR 照常刷新数据，**页面静静地是旧版**。
他看到的确实是旧代码的渲染结果 —— 不是他看错了，也不是服务器有问题。

修法：`/api/status` 下发 `build_id`（当前部署的 bundle 文件名），
前端从自己的 `<script src>` 读出实际加载的包名，两者不一致就在内容区顶部
提示「页面版本已更新 · 立即刷新」。切回标签页时重新拉 status 比对。

规则（对**所有**前端改动都成立）：
  · 「服务器上是对的」不能推出「用户看到的是对的」——
    验收必须区分「服务器渲染结果」与「用户浏览器当前结果」；
  · 排查用户反馈时**先查 access.log 里他加载的 bundle 时间点**，
    再怀疑代码（这一步能立刻区分「代码没改对」与「他没拿到新代码」）；
  · 涉及 UI 的反馈，若服务器侧验证与用户描述冲突，默认先怀疑版本错位。

**⑯ 宽度审计不能只看「有没有 max-width」**（第 42 批）

第一版巡检脚本取「页面内所有元素的最大右边界」，于是**每个页面都判定为全宽**
——因为页头永远铺满整行，它掩盖了下面只占一半的统计卡行。
第二版改成逐「区块」量（`.oo-page` 的直接子级 + 区块内部子网格），
立刻暴露出真问题：`.oo-stats-cards` 用了
`repeat(auto-fit, minmax(118px, 200px)) + justify-content: start`
—— 这是上一轮为了治「卡片被拉成薄片」加的 200px 上限，
结果从「卡片太宽」变成「卡片挤在左边、右侧空 800px」（媒体库/通知/定价页）。

规则：**留白是「区块占可用宽度的比例」问题，不是「有没有 max-width」问题**。
审计脚本要按**区块**（grid/flex 的直接子级）量宽度占比，
阈值 90%；只看限宽属性会漏掉「网格列数不够」这类留白。
例外只有一处：**表单控件（input/textarea）**可以限宽（长文本单行铺满
1600px 要来回扫视），审计时要排除控件元素，否则会把刻意的例外报成问题。

**⑰ 图标「配了」不等于「看得清」**（第 42 批）

四家新厂商的图标取的是 GitHub 官方组织头像，文件、路径、`src` 、HTTP 200
全都没问题（脚本断言也全绿），但**在弹窗里的 22px 尺寸下糊成一团黑块**：
- MiniMax 的头像是「渐变底 + 波形 + 底部 MINIMAX 字样」；
- 小米 MiMo 的头像是整行「Xiaomi MiMo」文字。
缩到 22px 后文字只剩几个像素高的白点，远看仍然是「没配图」。

规则：**图标资源要看它在实际渲染尺寸下的可辨识度**，不是看文件对不对。
带品牌字样的 logo 要裁成**符号主体**并补成正方形
（裁的时候注意保留背景渐变，别用纯色 padding 把底色切掉 —— 试过一次
`canvas.paste` 补黑边，MiniMax 的橙红渐变变成了黑框）；
验收方式是把截图里图标区域**放大后自己看**，不能只断言 `naturalWidth > 0`。

**⑱ 测试脚本 import 了 db.js 就必须显式 process.exit**（第 42 批）

`src/db.js` 的 mysql2 pool（以及服务里的定时器）会保活事件循环，
脚本 `await browser.close()` 之后**进程依然不退出**。
我用 SSH 跑审计脚本时多次超时中断，远端进程变成孤儿 ——
线上实测堆积 **8 个 test 进程 + 一堆 chrome-headless，吃掉约 1GB 内存**
（机器只有 3.5GB 且**没有 swap**），直接把后续的 `ui-smoke` 拖到超时。

规则：`tests/` 下任何 `import ../src/db.js` 的脚本，结尾必须
`await pool.end().catch(() => {}); process.exit(fail ? 1 : 0);`
（`e2e-dialog-scroll.mjs` 一直是这么写的，新脚本漏了）。
另：**用完 SSH 后台任务要回头确认远端进程真的退出了**，
否则「测试超时」可能只是你自己上一轮的孤儿在抢内存。

---

## 3. 待办清单（按优先级）

> 以下为尚未完成的待办项。已修复的问题见「变更记录」。
> 工作方式：每轮审查发现的问题先登记在此，修好**删除对应条目**并写入变更记录。

### 第 36 批：用户明确列出的功能（**已全部完成**，2026-09-20 结清）

> 用户在两次消息里明确要求的功能。第 37 批已把全部条目做完并逐项验证。
> 保留这一节作为对照，避免将来重复做或误报未完成。

**A. 站点与用户体系**（第 37 批全部完成）
- [x] 用户个人信息类：头像上传、昵称、签名/简介 + **个人主页独立页面**（`/u/:id`）
- [x] 媒体库：统一文件存储，后端 + 对话链路 + 前端页面 + 社区引用全部完成；
      **历史数据迁移（migrate6）也已完成**（老消息内联 base64 转存媒体库）
- [x] 数据看板页面重构：个人维度（`/console`）与管理端维度（`/admin/dashboard`）
      两个独立物理路由
- [x] 系统设置：外观设定（主题色/圆角/字体/布局密度/背景底纹，全部即时热注入）；
      站点设定（站点名/logo/favicon/页脚/公告/注册开关等）

**B. 社区**（第 37 批全部完成）
- [x] 社区大厅：发帖、评论（扁平二级）、点赞、收藏、关注、话题
- [x] 实时聊天：群聊、单聊、讨论组（SSE 长连接 + 乐观队列 + 未读/撤回/成员管理）
- [x] 小游戏 / 联机游戏：**按用户要求改为纯联机**（6 款真人对战）——
      四子棋、黑白棋、五子棋、西洋跳棋、中国象棋、海战棋

**C. 对话与智能体**
- [x] 智能体沙盒：已完成 bigmodel managed agents 调研（结论见第 7.6 节），
      **调研结论是「暂不接入」**（理由见该节：闭源依赖 + 计费不透明 +
      与现有沙箱能力重叠有限）

**E. 已完成（对照用，避免重复做）**
- [x] 分组不再强制绑定厂商（vendor 改为可选筛选，分组可跨厂商）—— 第 36 批
- [x] 使用记录列：用户头像列、分组、密钥、缓存、IP、设备、渠道（管理员可见）—— 第 31 批已做，需复核
- [x] 操作日志独立成页、管理员看全部/用户看自己、敏感参数仅管理员 —— 第 31 批已做
- [x] 峰谷计费适配（DeepSeek，含全网检索与规则 JSON）—— 第 32/33 批已做

### 第 36 批进行中（每次完成请即时勾选，避免再次误报「已完成」）

> 这一节是因为上一轮我把「已实现的功能」当成「用户要求的全部」交付，
> 实际用户列的功能大部分没做。以下逐条跟踪，**未勾选 = 未完成**。

- [x] 分组：厂商降级为可选筛选 + 跨厂商成员（含迁移、绑定值、前端）
- [x] 媒体库（统一文件存储）—— **后端 + 对话链路 + 前端页面全部完成**：
      后端 12 个端点 / 两张表 / 配额 / 引用计数 / 回收任务（已端到端验证）、
      已接入对话链路（base64 不再写进 `chat_messages.parts`）、
      前端页面（宫格/列表双视图、用量条、删除、管理员 `?user_id` 视图）
- [x] 用户个人信息类：头像上传/裁剪、昵称、简介、个人链接、所在地
      （**个人主页独立页面**未做，当前在「个人设置」里维护）
- [x] 社区大厅（发帖/评论/点赞/收藏/关注/话题）
- [x] 社区实时聊天（群聊/单聊/讨论组）
- [x] 小游戏 / 联机游戏 —— 按用户要求**只做联机**，6 款真人对战
- [x] 数据看板重构（个人 + 管理端两个独立页面）
- [x] 系统设置：外观细化（含背景底纹预设）+ 站点设定细化
- [x] 智能体沙盒调研（结论：暂不接入，见第 7.6 节）
- [x] 权限划分与管理员细颗粒度设定（三层角色 + SUPER_OPTIONS 白名单 +
      社区内容审核页）

**第 36 批 · 剩余项**：全部完成
- [x] 前端改用新上传接口（先 `POST /api/media` 拿 media_id → 只传 id）
- [x] nginx `client_max_body_size`（复核后确认线上早已配置 32m，此前登记有误）
- [x] 历史数据迁移（`migrate6.mjs`：老消息内联 base64 → 媒体库，含 11 项验证）

> **第 36 批至此全部结清。** 上面 D 组两项（权限划分、管理员细颗粒度设定）
> 与 C 组沙盒调研都在第 37 批完成，不再是欠账。
> **第 37 批的遗留（用户列表之外、由本轮实现引入的待办）见下节。**

### 第 37 批遗留（大部分已补齐，剩两条为明确不做的取舍）

> 用户要求「不要欠」，所以这一节里的 8 条在本批全部处理过：
> 6 条已实现（勾选），2 条经评估**明确不做**并写明理由。

- [x] **实时推送是进程内实现**（`services/realtime.js`）—— **保留为部署取舍**：
      多实例部署时需换 Redis pub/sub。已在「长期/设计取舍项」双处登记，
      属部署架构决策而非缺陷（当前按单机单实例设计）。
- [x] **游戏房间清理任务**：`scheduleGameCleanup` 已加 ——
      已结束/放弃 30 天、无人加入 7 天后清理。保留窗口刻意给宽，
      因为对局记录是「我的对局」与看板统计的数据源。
- [x] **观战已改为实时推送**：详情接口登记观战者（30 分钟 TTL），
      每次落子按各自视角推给对局双方与观战者（海战棋观战者无隐藏信息泄露）。
- [x] **`game_records` 表已不再写入** —— 表保留供老数据查阅；
      看板与个人主页的「游戏局数」已改为统计 `game_rooms`（联机对局）。
      删表需先确认无依赖，不急着做（留着不占空间也不影响功能）。
- [x] **聊天跨会话搜索**：`/chatroom/search` 已加 —— 只搜自己所在房间
      （EXISTS 限定），SQL 层 LIKE；空关键词直接返回，不做全表扫描。
      量的进一步增长建议加全文索引。
- [x] **社区通知**：`services/notify-center.js` + `notifications` 表 +
      `/notifications` 页已加；导航红点用 60s 轮询 + focus 刷新兜底。
- [ ] **帖子的视频/音频附件** —— **评估后不做**：媒体库的类型白名单支持
      （kind 判定已覆盖），但上传体积上限与前端播放器都未验证，
      放开等于给用户一个「可能传不上或打不开」的入口。
      要做需先定体积上限 + 转码/封面策略。
- [x] **背景底纹响应式**：`applyAppearance` 按屏宽给三档平铺尺寸
      （≥2560 放大 1.6 倍、≥1920 放大 1.3 倍），只改尺寸不改透明度
      （对比度必须稳定）；窗口 resize 防抖 200ms 重算。

### 第 35 批遗留（全链路审查后仍未处理）

- [ ] **Google/Antigravity 渠道需重新登录一次**（代码已修，凭据需人工重换）：
  诊断结论 —— 该渠道的 refresh_token 是用**另一套 OAuth client** 签发的，
  用内置公开凭据刷新会被 Google 直接拒绝（`unauthorized_client`，已实测确认）。
  处理方式二选一：
  ① 在后台用「重新登录」走一遍授权（会用内置凭据签发新 refresh_token）；
  ② 若当初是自建 OAuth 客户端，把它的 ID/SECRET 写进 `.env` 的
     `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`。
  注意 refresh_token 与 client 绑定，两套混用必然失败。

> 第 35 批做了六路并行审查（浏览器反代核心 / 订阅适配器 / 国产反代 / 网关热路径 /
> 计费链路 / 对话 harness）+ 一轮对抗性复审（专查「修复本身引入的新问题」）。
> 已修 9 个 P0 + 10 余个 P1，下面是不影响当前使用、但应在后续批次处理的条目。

- [ ] **`appendMessage` 没有事务**（`harness/sessions.js`）：它是「INSERT 消息 + UPDATE 会话」
  两条独立 SQL。若 INSERT 成功而 UPDATE 失败，`chat.js` 的 `saved` 仍为 false，
  catch 兜底会再写一次 → 同一轮回答在库里出现两条。触发需要 DB 在两条语句之间出错，概率低。
  修法：包事务，或兜底前按 `session_id + seq` 查重。
- [ ] **站内对话不读 `billModel`**：网关已按上游实际档位计价（GLM 档位不一致时），
  但 `loop.js` 的 `record` 没带 `result.billModel`，`chat.js chargeUser` 也无此参数 ——
  同一账号在站内对话仍按请求档位收费。修法：record 带上 billModel，计费时逐 call 选价。
- [ ] **`__ooPatchSkipped` 跨轮残留**：`resetHook` 清了 `__ooPatchError` 却没清
  `__ooPatchSkipped`（只在写入时覆盖、从不重置），GLM 会长期间误报「注入被跳过」。
  目前只影响告警文案，未参与计费。修法：resetHook 里一并置 null。
- [ ] **`session.page` 现在可能为 null**：`attachPageWatch` 会把死页面置空，
  而 `screenshot` / `act` / `credentials` 直接解引用 `s.page`（`currentUrl` 有可选链）。
  页面崩过之后人工登录/截图接口会抛无 code 的 TypeError。修法：调用前用
  `isPageUsable` 判定并重建页面。
- [ ] **`submit` 的「已发送」二次确认仍是启发式**：`sentByUiState` 靠「所有可见输入框都为空」
  判断。若页面在**未发送**时自己清空了输入框（如点击后校验失败），会误判成已发送，
  请求一路走到 streamCapture 白等 15s~180s 才超时，随后渠道被冷却 300s。概率低但代价高。
  修法：再要求「页面出现了新的用户消息气泡」，或记录 fill 成功时的内容做二次比对。
- [ ] **`extractImages` 会重排图片顺序**：base64 图片先 push、远程图片统一在 Promise.all
  之后 push，最终顺序是「所有 base64 在前」，与原来按 messages 顺序混合不同。
  多图且上游按序理解时有语义差异。修法：任务数组带下标，回填后按原序过滤。
- [ ] **TPM 配得过小会导致永久 429**：`estimateRequestTokens` 最低是 `prompt/3 + 1024`，
  若管理员把 `default_user_tpm` 配成小于该值，任何请求都过不了预占检查，
  而错误提示是「请稍后重试」（误导）。修法：配置下限校验，或提示「限额过小请联系管理员」。
- [ ] **`user-limit` 的 `usageOf`/`sweepIdle` 是死代码**：`users` Map 因此只增不减
  （每用户一条，量级很小），且限流状态在监控页不可见。建议接到监控接口并定时 sweep。
- [ ] **`safeBaseUrl` 未限制端口**（`grok.js`）：hostname 白名单不含端口，但返回的是
  `u.host`（含端口），`https://api.x.ai:8443/v1` 能通过。目标是官方域名，风险低。
  修法：`if (u.port && u.port !== "443") return ""`。
- [ ] **闲时规则校验有两个缝**（`routes/pricing.js`）：
  `peak: [["00:00","00:00"]]`（起=止）能过校验，而 `isPeakAt` 对相等窗口恒为 false
  → 全天按闲时价（静默少收）；`days: []` 是 truthy，会被当成「每天」。
  修法：拒绝起=止窗口；`days` 空数组归一为默认值。
- [ ] **余额为负时前端展示难看**：`quota` 现在可以为负（欠费记账），个人中心/用户列表
  会显示负数。语义正确但需要文案配合（如「欠费 X」而不是「余额 -X」）。
  另外充值必须**大于**欠费额才能恢复服务，错误提示里应带出欠费金额。

### 第 34 批遗留（监控与告警）

- [ ] **SMTP / Webhook 未做真实投递验证**：代码路径与加签逻辑已有单测（`metrics-alert.test.mjs`），
  但线上没有可用的 SMTP 账号与群机器人地址，**尚未真实发出去过一封邮件/一条群消息**。
  补验方式：系统设置 → 邮件填 SMTP，运维监控 → 告警中心 → 「测试」按钮，
  或 `POST /api/monitor/alert/test {channel:"email"|"webhook"}`。
- [ ] **告警指标仍以「进程内」为主**：`success_rate`/`error_rate` 已改为窗口口径（分钟桶），
  但 `ttft_p99_ms`、`p95_latency_ms`、`sla_rate` 用的还是进程累计的分位样本（环形 1000 条）。
  进程重启后这些值会短暂失真（样本少 → 分位跳变）。彻底修需把延迟样本也按分钟落桶。
- [ ] **监控数据不跨重启**：`gateway.*` 与 `trend.series` 随进程重启清零（`logs` 表有跨重启历史，
  但监控页读的是内存）。如需长周期看板，要加 `metrics` 分钟表并定时落库（sub2api 有 `ops_system_metrics`）。
- [ ] **没做定时报表**：sub2api 有日报/周报（cron + 独立收件人）。当前只有实时告警。
  实现时要一并加设置项（`DEFAULT_OPTIONS` + `option.js` 数值白名单 + `AdminSettingsPage` 字段），
  **不要先加空配置项** —— 设置了却不生效的开关比没有更糟。
- [ ] **多实例部署下指标会分散**：所有计数都在进程内，多实例时每个实例各算各的。
  单机单实例部署（当前）无影响；上多实例前需要改成集中式（MySQL 或加实例维度聚合）。
- [ ] **`alert_rules.filters` 尚未真正生效**：字段已建、接口能存，但 `metricValue` 还没按
  `filters.channelId`/`channelType` 过滤（`account_success_rate` 等定向指标返回的是全局值）。
  要做「某个账号专门告警」时需要补这块。
- [ ] **告警通知无频率限制**：sub2api 有 `rate_limit_per_hour` + 批量聚合窗口。
  当前只靠每条规则的 `cooldown_min`，规则多时同一故障可能被多条规则各通知一次。

### 持续审查（待处理）

- [ ] **Qoder 原生直连（WASM 签名移植）**：当前 Qoder 走「本地桥（qoder2api/qoder-proxy）→ OpenAI 协议」
  接入（第 38 批）。原生直连需要移植 qoder2api 的签名/加密链路（自定义 Base64 + MD5 签名 +
  RSA/AES + 22 个 Cosy-* 头），属独立工程；有真实 PAT 后再立项验证。
- [ ] **订阅 OAuth 渠道实盘验证**（第 12 批进展）：**Codex 已完成全链路实盘验证**
  （sub2api 文件导入 → 渠道测试 → 站内对话 → 精确计费 → 292 state 捕获/注入 → 312 判定）；
  Claude / Gemini / Grok 目前没有真实订阅凭据，待补各跑一次「测试渠道 + 对话」。
  Grok（`grok-4.6/4.5/4.3`、`grok-3-mini`）尚未收录官方价，当前走兜底价（0.30/1.20 并打告警）；
  补录时按规范在 `remark` 写官方来源（openai.com/api/pricing、x.ai 定价页）。
- [ ] **审查方式可复用**：后续批次继续用「三路并行子代理（前端 / 后端路由 / 服务适配器）+ 人工核实」，
  发现的问题先登记在此节，修完删除并写入变更记录。

### 第 46 批最新远端复审发现（远端 `02e22d3`，2026-09-22）

> 本节来自对 `origin/main` 最新代码的只读复审。审查基线不是本机旧副本，而是干净 worktree 的提交 `02e22d3`；后端 117 个 `src/**/*.js` 均通过 `node --check`，未运行会修改数据或调用真实上游的测试。以下问题均有代码证据，修复后逐项删除并写入变更记录。

#### 线上实测与生产版本差异（2026-09-22）

- [ ] **线上部署版本与远端不一致，审查结论不能直接视为线上已修复**：线上服务器在本次检查时运行
      `.update-stamp.json=5a1c8ca`，远端最新为 `02e22d3`。线上还出现过 `.backup-2026-09-22T09-24-57` 与
      “上次在线更新未完成，当前代码可能半新半旧”的启动警告；机器当时约 3.5GB 内存且无 swap，更新期间日志持续
      `Under memory pressure`，随后发生一次硬重启。修复/运维动作：在线更新必须先做内存预算与失败回滚校验，更新完成后
      明确比对 stamp、服务健康、前端构建产物和迁移状态；部署前不得把远端静态审查结果当成线上版本结果。

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

### 第 19 批遗留（对话页二轮重构）

- [ ] **断线续传的进程内限制**：运行缓冲只在内存（进程重启即丢，那一轮按已产出内容照常计费）；
  如需跨重启恢复，需要把 runs 落库或引入外部缓存，当前按单机单实例部署可接受。
- [ ] **长会话侧栏分页**：会话列表当前一次拉 200 条（`limit` 上限 500），
  对话量很大时需要虚拟滚动 + 分页/无限加载。
- [ ] **项目资产**：ChatGPT 的项目还能挂「项目说明/文件」，当前只做了分类与归档；
  若要支持，需在 `chat_projects` 加字段并在系统提示词里注入项目上下文。
- [ ] **续传的移动端表现**：移动端切后台再回来会重新订阅（已实测可用），
  但切后台期间没有系统通知；如需「跑完了提醒」要接 Notification API。

### 第 21 批遗留（对话能力扩展）

- [ ] **GitHub 私有仓库 / 限流**：当前只读公开仓库，未登录时 60 次/小时；
  如需私有仓库或更高限额，要加「用户绑定 GitHub Token」的设置项（服务端 `GITHUB_TOKEN` 已支持，但没做界面）。
- [ ] **PDF 解析的边界**：只覆盖有文字层的 PDF（文本算子抽取），
  扫描件、复杂排版（多栏/表格）会丢结构；如需更准要引 pdf 库或走模型 OCR（与「不引新依赖」冲突，需产品决策）。
- [ ] **产出物的可下载性**：预览能跑起来，但没有「下载为 .html」按钮；
  若要支持，注意导出内容同样属于模型生成物，落地前应提示用户自行检查。
- [ ] **密钥与用户分组的关系**：现在「账户默认」= 用户分组（老行为），
  管理端建的分组要绑到密钥上才生效；这一层关系建议在「令牌管理」页面补一句说明，避免用户困惑。

### 第 22 批遗留（反代风控）

- [ ] **浏览器渠道的出口 IP 未隔离**：所有账号共用服务器同一出口 IP，是厂商侧最容易命中的聚类特征。
  要真正缓解需要给每个渠道配置代理（`browser-driver` 加 `proxy` 参数 + 渠道字段），当前未做。
- [ ] **`--no-sandbox`**：服务器以 root 运行 Node，Playwright 需要该参数；
  这是自动化特征之一，生产建议非 root 用户 + 容器隔离（已在长期待办里）。
- [ ] **DeepSeek 每轮新建会话**：`chat()` 每轮都 `createSession`，真实网页用户是在同一会话里多轮。
  改为复用会话需要处理上游会话过期与上下文投喂，改动较大，需单独评估。
- [ ] **Cookie 只写不回读**：除登录外没有从 `Set-Cookie` 回写，上游轮换 cookie 后只能人工重登。
  实现要点：在 `dsFetch` 里捕获 `set-cookie` 并合并进 `other.cookies`。
- [ ] **`channels.other` 读改写非原子**：`execute.js` 与 `channel.js` 都是「读→合并→整列 UPDATE」，
  并发时存在覆盖窗口（当前靠写前重读降低概率）。多实例部署前需要换成原子更新或加版本号。
- [ ] **国产适配器的风控文案表可能过期**：Doubao/Qwen 的错误码是硬编码，上游改码段后会落到通用错误。
  建议线上出现未知码时把它记进日志并定期回捞补充。

### 第 23 批遗留（GLM / 谷歌）

- [ ] **GLM 档位需线上实测**：`patch_model` 默认关闭（保守）。上线后建议逐个模型试一次并看 `[glm] 模型档位不一致` 告警：
  若注入 model 确实有效，把 `patch_model` 打开即可让档位与计费一致；若仍 0 帧，则说明模型 id 需按上游实际值调整。
- [ ] **GLM 的验证码仍是浏览器方案**：开源项目用纯 HTTP 复刻了阿里云验证码 SDK（含 wasm 反编译），
  我们能跑通浏览器就不必复刻（维护成本高、上游改动即失效）。若将来必须去掉浏览器，需要单独评估。
- [ ] **交互式登录目前只覆盖 Google**：Codex / Claude 也可按同样模式加（各自 redirect_uri 与 client_id 不同），
  当前仍走「粘贴凭据」；如需补上，复刻 `oauth-login.js` 的 `oauthConfigFor` 分支即可。
- [ ] **Google 客户端凭据来源**：从 `.env` 读（`GOOGLE_OAUTH_CLIENT_ID/SECRET`），
  用的是官方 Antigravity 客户端的公开凭据；若上游轮换或封禁该客户端，需要替换成自建 OAuth 客户端（并注册对应 redirect_uri）。

### 第 28–30 批遗留（凭据找回 / 额度检测 / 模型归厂商）

- [ ] **找回流程的账号一致性校验**：`applyCredentialToChannel` 目前不比对写回凭据的账号是否与原渠道一致
  （找回时若在浏览器里登录了另一个账号，会静默替换该渠道的凭据并报「已恢复」）。
  收紧做法：写回前用 `auth-import` 的稳定账号标识比对，不一致时要求管理员显式确认。
- [ ] **CAPTURES 未绑定发起人**：`/capture/:sid/*` 只按 sid 查表，多管理员场景下 A 发起的登录会话可被 B 接管
  （在真实页面里替 A 输入）。单管理员部署无实际风险；要收紧就在条目里存 `req.user.id` 并在 `captureOf` 校验。
- [ ] **额度快照无自动刷新**：额度只在管理员点「查额度」时更新（刻意不做高频轮询，避免被当成脚本）。
  若需要「快过期时提醒」，建议做**低频**（≥30 分钟）定时任务 + 仅在超过阈值时提示，而不是提高频率。
- [ ] **额度端点的上游变更风险**：7 个额度接口都是各厂商 CLI/前端的私有接口（非公开文档），
  上游改版即失效。当前失败只回错误不影响调用；建议线上出现连续失败时记录一次日志便于回捞。
- [ ] **WorkBuddy 接入的产品决策**：调研确认其 `deepseek-*` 是腾讯云托管同名档位、不是 DeepSeek 官方转发
  （详见 7.5）。接入前需确认：是按独立厂商计价，还是并入 DeepSeek（后者会有计费口径偏差）。
  另外其 `X-Device-Token` 是设备风控头，需要设计可插拔的注入方式。
  - [x] **已接入（第 38 批）**：按独立厂商实现（`upstream/workbuddy.js`，后端本身是标准 OpenAI 协议，
    设备/企业头经 `other.extra_headers` 注入）；计价按独立厂商登记，价目未收录前走兜底价并告警。
    遗留：token 过期需重新粘贴（桌面端刷新端点未公开稳定，未做猜测性刷新）。
- [ ] **`.oo-page-desc` 死样式**：`styles.css:1681`（及 2561 的媒体查询）已无组件使用，可随下次样式整理删除。
- [ ] **渠道列表 `SELECT *`**：新增 `quota` 列后列表查询仍取全列；单条快照数百字节，当前可接受，
  若渠道数破千建议改列白名单 + 额度按需拉取。
- [ ] **`explainNoChannel` 的提示语**：`models` 留空语义生效后，「没有可用渠道」的原因可能是
  「该模型不属于该厂商/未登记」或「登记表未就绪」，提示语仍只说「为某个渠道添加该模型」，排障时会被误导。

### 第 31–33 批遗留（日志明细化 / 峰谷计费 / 十轮审查）

- [ ] **Claude 额度 utilization 口径待真机确认**：十轮审查中唯一无法在仓库内证实的项 ——
  `/api/oauth/usage` 的 `utilization` 我们按 0-100 百分数处理（依据是同一响应里 `limits[].percent`
  的命名），若上游实际给 0-1 比例，用量会显示成 1/100（不报错、只是数字偏小）。
  有 Claude 订阅凭据后打一次日志核对；若是 0-1，`quota.js` 两处改成 `pctFromFraction` 即可。
- [ ] **站内对话跨峰谷按整轮判档**：一轮最多 16 步、可跨峰谷边界（如 11:59 发起、13:00 结束），
  现在整轮按发起时刻判档（与网关口径一致）。要精确到每步需按 `runCalls[i].startedAt` 分别计费后求和。
- [ ] **`detail` 缺规则快照**：`priced_at + price_phase` 只能看出「当时判成峰/谷」，
  无法在规则被改后复现判定依据；建议补 `offpeak_rule` 快照（或规则哈希）。
- [ ] **扣费不确定/部分结算失败无审计留痕**：`BILLING_UNCERTAIN` 与部分结算自身抛错时只有 ERROR 日志，
  事后无法证明扣没扣、也无法复算；建议补一条带 `amount_units/price/priced_at` 的记录。
- [ ] **`tokens.remain_quota` 与用户扣费非同事务**：best-effort 更新失败会让「令牌级限额」失效
  （用户余额仍是硬约束，不会直接跑钱）。同进程内同时失败概率低，但可考虑合并进一个事务。
- [ ] **模型列表按密钥过滤的边界**：`/v1/models` 不按 `model_limits` 过滤（会向受限 Key 暴露模型目录）；
  站内对话里管理员豁免密钥层限制。
- [ ] **单用户无上限的资源入口**：会话/令牌/项目的创建数量无上限，`/run` 只按会话去重
  （同一用户开 N 个会话即可 N 路并发）。建议加每用户条数上限与并发上限。
- [ ] **`verify` / `fetchQuota` 未过渠道限速闸门**：`withChannelLimit` 只包了 chat 链路，
  健康检查与额度查询是直连（预算内有次数限制，但批量操作仍可能并发打同一账号）。
- [ ] **`closeSession` 不等锁**：管理员关浏览器会话时若正有流在跑，会被腰斩成半截输出
  （execute 按失败处理）；建议 `closeSession` 也走 `withLock` 或等待 inFlight 归零。
- [ ] **老库 `logs` 新列无历史回填**：新列对老日志永远是默认值（列表页显示 0 token/空模型），
  渠道统计只补了渠道归属；要么补一次性幂等回填，要么在文档里明确「老日志仅统计不展示明细」。
- [ ] **`operation-log` 的 `days=0` 全历史 GROUP BY**：单用户全历史做两次聚合，
  量大时建议观察慢查询再加「候选值最多回溯 N 天」上限。
- [ ] **`SET SESSION` 类迁移的通用做法**：本次已修 `ensureColumns`/`ensureColumnTypes`，
  但其它脚本（`migrate*.mjs`）如将来需要会话级设置，记得同样用单连接。

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

### 第 47 批线上全量验收记录与新问题（2026-09-22）

> 本批不是静态猜测：直接在当前线上版本 `7c2b9e4` 执行。范围包括：118 个后端文件静态检查、`npm test` 全量、真实渠道探针、真实 `/v1` 对话与计费、Anthropic/Responses 三协议、视觉输入、社区/聊天/通知/游戏/个人主页/看板 HTTP E2E、真实浏览器 UI smoke、桌面宽度审计、移动端横向溢出审计、弹窗滚动与游戏浏览器交互。所有临时脚本均在测试后删除；保留用户要求保留的线上测试渠道 `#44` 与全量实测令牌 `#47`，不在文档记录任何密钥。

#### P0/P1：真实线上功能问题

- [ ] **WorkBuddy 渠道真实探针失败：HTTP 404 Route Not Found，且会阻断同模型的正常渠道**：线上渠道 `#42` 的真实
      `probeChannel` 返回 `CHANNEL_BAD_REQUEST`，上游响应 `{"error_msg":"404 Route Not Found"}`。随后真实 `/v1`
      请求 `glm-5.3` 被渠道 #42 优先选中，返回 400 `CHANNEL_BAD_REQUEST`，没有继续尝试可用的 GLM 渠道 #8；
      同一请求改为正确分组/路由后 GLM 才能成功。当前 WorkBuddy 模型声明包含 `glm-5.3`，所以这是实际能力声明与上游路由不一致，
      不只是账号暂时失效。修复：校正 WorkBuddy endpoint/path 或移除错误模型声明；对“模型不属于该上游/路由不存在”的 404 做准确分类，
      不要让单个聚合渠道的 BAD_REQUEST 阻断其它同模型渠道。

- [ ] **GLM 真实调用反复发生请求模型与上游实际模型不一致**：真实探针与网关调用均记录：请求 `glm-5.3`，页面实际
      `x-preview-l`；网关日志又记录按 `glm-5.3-flash` 计费。实测成功，但模型能力、响应模型、计费模型三者不是同一档位。
      触发：渠道 #8 的 `patch_model` 关闭、页面默认档位变化。修复：要么在请求前强制选择与声明一致的上游模型，要么将实际模型映射、返回模型和计价模型统一，并增加“用户请求档位≠实际档位”的失败/告警门槛，避免健康但答非所选模型。

- [ ] **Gemini 渠道探针成功，但网关模型不可调用**：渠道 #12 的直接真实 probe 返回 `OOAPI_VENDOR_TEST_OK`，约 3.5s；
      但真实 `/v1` 请求 `gemini-3.8-flash-tiered` 返回 `NO_CHANNEL`，原因是当前 `测试` 分组 Key 的模型限制不允许该模型。
      同时 `/v1/models` 仍向该 Key 暴露了该模型。结果是“模型目录显示可选”与“实际调用被分组拒绝”不一致。
      修复：`/v1/models` 必须复用与 `selectChannels` 完全一致的用户/Key/分组/模型过滤；分组模型限制变更后补真实 `/v1/models` 与调用成对断言。

#### P1：协议与视觉实测问题

- [ ] **视觉能力只验证了“请求不报错”，尚未证明模型真的读取图片**：真实 `/v1/chat/completions` 发送 1x1 PNG：
      DeepSeek 返回 200 和正确测试文本，说明图片链路被接受；GLM 明确返回 `VISION_NOT_SUPPORTED`，符合当前适配器能力声明。
      但 DeepSeek 本次提示词要求只返回固定字符串，无法证明模型观察到了图像内容。修复：使用带明显可识别内容的测试图，要求模型描述图中内容，
      对答案做人工/结构化核验；不要把“200”当视觉能力通过。

#### P2：真实视觉/回归审计问题

- [ ] **桌面端 `/log` 与 `/admin/channel` 存在横向溢出**：真实 `audit-ui.mjs` 宽度 1880 检查显示：
      `/log` 实用宽度 1720 超出可用 1648，右边界为 -96；`/admin/channel` 实用宽度 1668 超出可用 1648，右边界为 -44。
      实际截图已保存于本次验收临时目录，渠道管理表右侧操作列紧贴/超出视口。修复：检查表格最小宽度、固定操作列和横向滚动容器，确保溢出发生在预期表格容器而不是页面根节点。

- [ ] **`audit-ui.mjs` 视觉审计过程中服务发生重启，导致后续页面访问 `ECONN_REFUSED`**：UI smoke 在全部页面渲染通过后，
      宽度审计进入社区管理/渠道弹窗阶段出现拒绝连接；systemd 日志随后显示服务重启。重启前后没有明确应用异常堆栈，
      但视觉验收不能以“脚本最终异常退出”视为全绿。修复：查清触发重启来源（更新器、测试脚本、OOM 或运维任务），为视觉审计增加服务存活探针和重启计数；重启期间的页面结果必须标记为未完成。

- [ ] **旧浏览器游戏测试脚本与当前产品路由脱节**：`e2e-games-browser.mjs`/`e2e-browser.mjs` 仍按旧 `/games`、2048、`.oo-game-canvas`
      断言，线上当前真实路由是 `/community?board=games`，棋盘使用 SVG/DOM；因此旧脚本出现 12 项游戏失败、2048 失败，但人工直读当前 DOM
      可以打开房间 `/community?board=games&room=111` 并显示四子棋状态。修复：更新测试脚本到当前路由与 DOM 契约；在测试更新前不能把这些失败简单标成产品 bug，也不能把旧脚本全绿当作当前游戏验收。

#### 本次全量实测结论

- [x] 线上 `npm test`：全部通过；118 个文件静态检查、各套件 0 失败。
- [x] `/api` 模块 E2E：83/83 通过（社区、聊天、通知、搜索、游戏、个人主页、看板、权限）。
- [x] `ui-smoke`：所有登记路由正常渲染。
- [x] 弹窗滚动/厂商图标：11/11 通过。
- [x] 移动端 390px：8 个关键页面无横向溢出。
- [x] 真实渠道：DeepSeek probe + 网关流式/非流式通过；GLM probe + 网关流式/非流式通过；Gemini probe 通过；Codex 账号全部 `token_revoked`；OpenAI API 503；WorkBuddy 404。
- [x] 真实计费：DeepSeek/GLM 网关调用均产生 usage、消费日志、用户 request_count/used_quota 变化。
- [ ] 视觉全量验收：因服务在宽度审计阶段重启且存在桌面横向溢出，不能标记为全绿。

---

### 人格测试 Round 1 未处理项（2026-09-24 登记）

> 来源：五个模拟真人（老张/阿强/Mia/小雨/K）的黑盒测试报告。
> 已修的部分见第 51/52 批变更记录，这里只列**尚未处理**的。
> 每条都带实测数据，可直接当验收标准用。

**Mia（设计师，390×844 / 320×640 视口实测）**

- [x] **暗色模式空状态插图几乎不可见**（第 53 批已修：oklch 转 hex + 全局 token）：插画 SVG 硬编码 `fill="#000000"`，
      暗色下与面板对比度约 **1.1:1**（实测 `#141414` vs `#202024`）。
      亮色下也不好看（纯黑实心方块）。修法：换成主题色描边插画，或出亮/暗两版。
- [x] **320px 视口整页横向滚动**（第 53 批已修：≤380px 断点，实测 4 页溢出 0）：`documentElement.scrollWidth 335 > 320`，
      `.oo-user-chip right=335` 顶出屏幕，面包屑被挤成两行（高 104px）。
      390/430/768 都正常，只有 ≤360 有问题。修法：≤360 时面包屑单行省略、昵称只留头像。
- [x] **首页头部品牌名被裁成「OO…」**（第 53 批已修）：`.hr-brand span` `cw 46 / sw 56`（溢出 10px）；
      同头部 hero 徽章 `right=393 > 390` 溢出 3px。
- [x] **社区摘要漏 Markdown 原文**（第 53 批已修：服务端 summarize，实测 40 条零泄漏）：`.oo-post-summary` 里能读到字面量 `**问题**：…`，
      且 `scrollHeight-clientHeight = 18px`（第三行被切在半截）。
      小游戏规则区同样漏 `**胜负与合法性全部由服务端判定**`。
      修法：摘要先做一遍轻量 markdown 剥离，行数裁成整数行。
- [ ] **截断处普遍没有 `title`**（部分已修：使用记录的模型列第 53 批加了 `title`）：
      仍缺 —— 对话页会话标题（`cw 547 / sw 589`）、左侧会话名（`cw 122 / sw 521`）、
      能力栏（`cw 200 / sw 310`）三者 `title` 均为 `null`；社区标题溢出 76px、
      媒体库文件名溢出 12px 同样没有。
- [x] **手机端触控目标偏小**（第 53 批已修：命中区 40×40，实测确认）：顶栏「打开导航」26×26、主题切换 28×22、
      行内图标按钮 26×26、分页按钮 30×30 —— 均低于 44×44 的通行标准。
- [x] **聊天附件缩略图仅 20×20**（第 53 批已修：20 → 36px）：`.bui-chip-file img { width:20px; height:20px }`，
      贴 8 张图完全认不出哪张（chip 本身 92×26）。建议 32~40px。
- [ ] **空状态温度不均**：通知页文案是模板级（「还没有通知；别人评论或点赞你的内容时会出现在这里」），
      而使用记录只有「暂无记录」、看板三张卡重复同一个「暂无数据」+ 同一图标；
      图表空数据时还留一条贴地零线，像图表坏了。

**K（安全研究者）**

- [ ] **数据看板数值口径待确认**：他提到看板数字与使用记录求和存在差异（未给出定论，仅记录观察）。

**老张（后端老兵）**

- [x] **`/v1` 未实现端点返回 HTML 错误页**（第 53 批已修：JSON 404 + 端点清单，实测确认）：
      没有宣告不支持，且 HTML 错误页混在 JSON API 里不好处理
      （`GET /v1/chat/completions` 同样返回 HTML）。修法：网关加 JSON 兜底 404。
- [ ] **未知参数被静默忽略**：`foo:1`、`temperature:99`、`max_tokens:-1` 均 200 正常回答。
      宽容有利于 SDK 兼容，但排错时没有任何提示 —— 建议日志里记一条 warn。
- [ ] **同一 model 名落两个上游时 input tokens 口径不同**（29 vs 48）：
      他实测同一 prompt 连打 4 次，WorkBuddy 与 OpenCode 两边的提示词长度不同，
      说明两边系统提示词注入不一致。分流本身他认可，但输入 token 差异值得核对。
- [ ] **`/api/pricing` 普通用户 403 但设置项 `expose_pricing_to_user:true`**：
      前台完全没有定价入口（路由表只有 `/admin/pricing`），
      设置项开着却没接前端 —— 要么接上，要么把设置项下架。

**阿强（暴躁老哥）**

- [x] **同 IP 注册限流对真人不友好**（第 53 批已修：失败计数 5/5min + 总量 30/h，真实 HTTP 验证）：他**第一次**打开站点注册就吃
      `429 请求过于频繁，请 78 秒后再试`（5 次/5 分钟按 IP）。
      办公室/NAT/校园网下第一批用户会集体卡住。建议放宽首注册或改文案。
- [ ] **并发重复提交不去重**：同一秒并行发 2 条同标题帖 → 2 条都成（id 54/55）；
      并行 3 条评论 → 3 条全落库。前端有锁，但双标签页/弱网重试/脚本会造重复。
      社区内容不致命，但同样模式若出现在「建 Key / 充值」就是双份 —— 建议统一加幂等键。
      （运维人格复现了更严重的版本：同一秒并发 5 次建密钥 → **5 把同名 Key 全建成**；
      同一秒 3 条相同帖子 → 3 条全发布。建议优先给「建 Key」这类有资源含义的接口加。）

---

### 模拟用户人格测试规范（强制 · 写人格提示词前必读）

> 用户要求（2026-09-24）：「说话不要带 ai 味，自己去搜搜怎么去除 ai 味」。
> 下面这份是**搜到的公开规则 ＋ 本项目实测踩到的坑**合并成的操作清单。
> 每次派模拟用户前，把「反 AI 味」这一段原样贴进提示词。

**一、假人怎么跑（用户的明确要求）**
- **优先在服务器上跑假人**，AI 能力**直接用本平台自己的接口**
  （`http://127.0.0.1:3001/v1/chat/completions`，用平台密钥），
  不要用外部模型 —— 这样既省外部额度，又顺带在真实链路上压测自己的网关。
- 假人的浏览用服务器上的 Playwright（`xvfb-run -a node xxx.mjs`），
  **不要自绘图片**，需要视觉证据就**直接截真实页面**。

**二、反 AI 味规则（写帖子/评论/报告都适用）**

禁用词与句式（一出现就露馅）：
| 别用 | 改成 |
|---|---|
| 首先 / 其次 / 最后 / 再者 | 直接写事，或「另外」「还有」 |
| 值得注意的是 / 需要指出的是 | 去掉，直接说 |
| 不仅仅是…更是… / 不是…而是… | **只说对的那一侧**（「不是 A 而是 B」会让人记住 A —— 粉红色大象效应） |
| 总的来说 / 综上所述 / 由此可见 | 去掉，或换成「反正」「所以」 |
| 在这个…的时代 / 随着…的发展 | 直接切进正题 |
| 让我们 / 我们可以 / 需要说明的是 | 去掉 |
| 赋能 / 闭环 / 抓手 / 颗粒度 / 底层逻辑 | 换成大白话（「能用」「做完」「关键点」「细到什么程度」「为什么」） |
| 深入探讨 / 全面解析 / 一文读懂 | 换成具体动作（「我试了」「我量了」） |

句式与结构：
1. **句子要短**：一个逗号分句尽量 20 字内；超过 40 字必须拆。
2. **多用简单句和并列句**，少用带长定语的复合句。
3. **用肯定句**（「电源已关闭」优于「没有接通电源」）；避免双重否定。
4. **一个段只讲一件事**，不要把三件事塞进一句。
5. **少用比喻**：要打比方就换成具体例子（举数字、举你实际做的操作）。
6. **禁排比与对仗**：三个短句整齐并列是 AI 最明显的指纹之一。
7. **少用破折号（——）**和「冒号+解释」的下定义句式。
8. **不要总分总、不要强行三点式**：人写东西是想到哪写到哪，
   顺序常常是「先吐槽 → 然后说细节 → 最后一句结论」。
9. **代词就近指代**，别跳跃。
10. **名词前别堆形容词**。

情绪与视角（这块比词汇更重要）：
- 有**具体的个人处境**：「我大四，论文写不完」，不要「作为一名用户」。
- 有**情绪起伏**：烦、想放弃、意外、觉得好笑。AI 写的最大特征是没有情绪波动。
- 敢**不确定**：「我不确定这是不是 bug」「可能是我搞错了」。
- 会**跑题一句**再拉回来（真人说话有毛边）。
- 抱怨要**具体到动作**：「点了三次没反应」比「体验不佳」像人话。
- **不要每段都收尾总结**。真人写到一半就停了。

**三、交付时要贴真实截图**
发帖/评论**带图要带真实截图**（服务器上 Playwright 截的真实页面），
不要用 canvas 自绘色块凑数 —— 自绘图对排查毫无价值，还会被当成噪音。

---

### 人格测试 Round 2 未处理项（2026-09-24 登记）

> 五个新人格（大学生陈同学 / 海外开发者 Alex / 运维老李 / 产品经理 Lisa / 社交型小美）。
> 已修的部分见第 54 批变更记录；这里只列**尚未处理**的。

**小美（社交型，三账号互测）**

- [ ] **正文/标题里的 @ 不产生通知**：她实测 A 在帖子标题与正文写 `@某人`，
      对方通知数 **9 → 9 一次没动**；而同一人在**评论里** @ 立刻 +1。
      社区里「@ 喊人来看帖」是最自然的用法。
      需产品决策：补上通知，还是明确提示「@ 仅评论内生效」。
- [ ] **撤回消息后会话列表预览不同步**：撤回后消息列表里那条消失了（对外干净），
      但会话列表的 `last_message_text` **仍是原文**（双方都可见），
      聊天页也没有「xx 撤回了一条消息」提示。与用户对「撤回」的预期不符。
- [ ] **通知只能标记已读，不能改回未读**：`{"is_read":0}` 被忽略，永远回「已标记已读」；
      且 `{id}` 会顺带把所有未读一次标掉，而 `{ids:[X]}` 只动一条 —— 两种写法语义不一致。
- [ ] **帖子删了，指向它的通知不清理**：点进去落到「帖子不存在或已被删除」，
      通知中心会攒一堆点不动的死通知。
- [ ] **成员搜索只匹配用户名，不匹配昵称/UID**：搜 `小美`（自己的昵称原文）返回「暂无数据」，
      搜用户名 `lin` 才能命中。社区里大家认昵称，找人困难。
- [ ] **四子棋落子后顶部状态短暂回滚**：落子成功（服务端 200、棋子正确落下），
      但状态栏从「轮到你」变成「等待对手」约 1 秒后自愈。纯观感。

**老李（运维）**

- [ ] **客户端提前断开时，同一 request_id 落两条日志**（计费行 + 错误行）。
      计费本身正确（按上游已产出扣费），但「使用记录」只看得到成功行（26 条全 type=2）、
      「操作日志」只看得到错误行（无 type=2）—— **两个页面的成功率都失真且互相对不上**。
      本批已补 `request_id` 字段（可关联），但**双记录的语义**还未合并。
- [ ] **并发闸门阈值未知**：10 路并发是串行完成的（1.2s→17.3s 依次返回），
      说明有闸门；但上限是几路、超限是排队还是 429/503 未测出。影响容量规划。
- [ ] **`/api/option/` 对普通用户返回 403**：外观设置页加载时会请求它并拿到权限错误，
      每个普通用户打开外观设置都会产生一条控制台报错。功能不受影响。

**陈同学（大学生）**

- [ ] **分组下拉第一项是内部名 `1`，且该分组不可用**：选它建的密钥一个模型都调不了
      （`/v1/models` 返回空数组），但下拉里既不标注「该分组当前不可用」，
      分组名也毫无解释。他原话：「是我选错了吗？」
- [ ] **令牌「额度上限」填负数被静默取绝对值**：填 `-100` → 界面回显 `100`，无任何提示。
      值被悄悄改写比报错更糟。
- [ ] **额度填 0 能建出密钥但必然不可用**：创建时不拦不警告，要等调用才 403。
- [ ] **文档附件不预校验**：选 `.bin` 会立刻挂进输入框且无提示，发送后才 400。
      对比图片入口做了前置校验（「请选择 PNG、JPEG…」）—— 文档入口缺同样的一层。
- [ ] **深链接与 404**：`/console/xxx` 与不存在的路径一律静默回落地页，没有 404 页面。

**Alex（海外开发者）**

- [ ] **`stream_options.include_usage` 接受但不返回 usage 帧**：
      流式下收不到 usage（官方应有一条），导致流式无法做 token 记账 ——
      只能再补一次非流式调用。非流式响应里这些数是有的，说明服务端有数据、只是没发。
- [ ] **一批参数被静默忽略**（200 但不生效）：`n`、`tools`（OpenAI 与 Anthropic 两侧）、
      `logprobs`、`stop_sequences`、`thinking:{type:"enabled"}`。
      其中 `tools` 与 `thinking` 是**实际可用性缺口**：按 `stop_reason === "tool_use"`
      写循环的 agent 会在第一轮直接退出；按 `content[].type === "thinking"` 分支的客户端拿不到东西。
      注意：本平台渠道多为网页版反代，**上游可能确实不支持**这些参数 ——
      所以正确的修法可能是「明确报不支持」而不是「假装接受」。
- [ ] **`/v1/messages/count_tokens` 404**：官方 `@anthropic-ai/sdk` 的 `countTokens()` 会失败，
      做上下文预算的人会撞上。
- [ ] **`anthropic-version` 完全不校验**：传 `1999-01-01` 或不传都 200（官方会 400）。
- [ ] **社区 API 对非字符串 `content`/`title` 静默强转**：传对象会存成 `[object Object]` 并返回 200。
      他指出了一个很中肯的点：「本平台三个 API 表面上 `content` 都是块数组，
      白天写 SDK 代码、晚上调社区 API 的人肌肉记忆就是这样写的 —— 设计本身在诱导这个错误。」
- [ ] **Markdown：强调内部的代码不解析**：`` **official `code` here** `` 会裸露反引号；
      `*italic `code` here*` 与 `***both***` 同样。开发社区最常见的写法正是 `` **`max_tokens` is ignored** ``。
- [ ] **错误体在网关 5xx 路径不一致**：三种协议在常规错误上都返回各自原生信封（对），
      但落到通用处理器/上游 5xx 时退回 OpenAI 形状，甚至返回 nginx HTML。
      乱 JSON 也换了另一种信封并泄漏解析器内部信息（`Expected double-quoted property name in JSON at position 32`）。
- [ ] **`GET /v1/models` 里 7 个模型有 5 个 `owned_by: "unknown"`**：规范允许，
      但既然有一个填了具体值，其余填厂商名会更有用。
- [ ] **`/api/chat/meta` 与 `/v1/models` 自相矛盾**：前者 `supportsThinking:false`/`supportsSearch:false`，
      后者却广告 `-thinking`/`-search` 后缀。两者必有一个不准。

**Lisa（产品经理）**

- [ ] **缺「忘记密码」入口**：登录页只有登录按钮。忘记密码 = 账号作废。
- [ ] **缺充值/购买额度入口**：全站搜不到「充值/购买/付费/结算/订阅」，额度用完无自助路径。
- [ ] **公告配置了但登录后看不到**：`/api/status` 有 `announcement` 与 `announcement_type:"banner"`，
      但 `/console`、`/chat`、`/community` 的 DOM 里没有 banner —— 只有落地页显示。
      而公告本该是放引导信息的地方。
- [ ] **「开发文档」指向第三方站点**：`docs_link` 是 `https://docs.newapi.pro`（另一套产品的文档），
      新人点进去会更困惑。
- [ ] **界面直接暴露内部字段**：分组下拉显示「1 支持 1 个指定模型 × 50」「测试 12312 × 1」
      —— 把数据库字段拼给用户看。建议「组名 · 可用 N 个模型 · 计费 ×N」。
- [ ] **「余额可用 999+ 天」表述**：她建议改「按近 N 天用量估算约 X 天」，超上限写「额度充足」。
- [ ] **创建后密钥只在列表显示掩码，唯一出口是约 16px 的复制图标**：
      功能正常（实测能复制完整密钥），但可发现性差 —— 建议创建成功后弹一次完整密钥
      （提示「仅显示这一次」）。
- [ ] **媒体库统计偶尔显示 0**：观察到一次「0 个文件 / 0 B」而实际有文件，
      几分钟后恢复。疑似加载态未用骨架屏 —— 建议确认（若统计卡在 0，用户会以为文件丢了）。

---

### 人格测试 Round 3 未处理项（2026-09-24 登记）

> 五个新人格（小周 / 老王 / 小林 / 阿May / 阿蓝）＋ 5 个 AI 假人。
> 已修的 12 项见第 57 批变更记录；这里只列**尚未处理**的。

**小周（大四学生）**

- [x] **对话页往输入框粘截图，什么都没发生**（第 58 批已修：加 onPaste + 抽出共用校验）：Ctrl+V 与直接派发 paste 事件都试了 ——
      没缩略图、没 toast、没报错、输入框也没变化。右侧「+」按钮传图是好的，
      所以是粘贴这条路没接上，而且是**静默**的（连失败都不告诉你）。
      同一时期评论框的粘贴是好的，对比之下更像漏了。
- [x] **侧边栏头像不更新**（第 58 批已修：顶栏改用 UserAvatar 读 avatar_url）：头像上传成功（个人设置页 `/api/media/avatar/61?v=113` 正常、
      媒体库有记录），但左下角那个圆头像**永远是默认灰小人** ——
      F5、跨 6 个页面都试过。别人在社区列表里的头像是正常的，
      所以是侧边栏那个组件没去读 `avatar_media_id`。
- [x] **头像上限 20MB / 媒体库写 10MB**（第 58 批已修：改为读服务端 maxFileBytes）：头像弹窗传 27MB 报
      「图片过大（上限 20MB）」，而媒体库页面右上角写着「单文件上限 10 MB」。
      10~20MB 这个区间以哪个为准没测。

**老王（独立开发者）**

- [x] ~~单 key 并发串行~~ —— 已核实为**设计如此**（并发闸门），
      但**界面上没有任何说明**，调用方会以为是自己写错了。建议在接入信息里写一句。
- [ ] **`temperature=0` 不保证确定性**（**改判**：属上游能力，反代渠道多不下发该参数；非本平台可修）：同一请求发 3 次，`reasoning_len` 分别是
      54/47/62。上游没传下去或上游不支持 —— 对需要可复现输出的场景有影响。
- [x] **`-thinking` / `-search` 后缀是空壳**（第 58 批改为**声明写实**：保留后缀但注明「是否真开启取决于渠道」并引导用请求体参数；删除声明会回到「隐藏模型」那个抱怨）：`hy3` vs `hy3-thinking` vs `hy3-search`
      的 `reasoning_len` 与 completion 都在自然波动范围内，`hy3-search` 没有引用任何来源，
      `deepseek-v4.1-flash-thinking` 的 reasoning 长度为 0。后缀只换了名字、不激活能力。
      （注：这条与我上批做的「/v1/models 声明后缀」是两件事 ——
      声明了却无实际行为，比不声明更误导。要么实现，要么从声明里去掉。）
- [x] **价格表在用户端完全找不到**（第 58 批已修：新增 /api/pricing/public + /pricing 页 + 侧边栏入口）：`/pricing`、`/models`、`/console/pricing`、`/price`
      全被弹回首页，`/api/pricing` 要管理员权限。想比价的用户只能反推实际扣费，
      **无法核对「标价」与「实收」是否一致**。
- [x] **`max_tokens` 对推理类模型仍不生效**（第 58 批已修：推理增量计入预算 + 计费按实际交付）（部分违反"已修"）：flash 系已经正确，
      但 gemini-3.8 三兄弟与 hy 系仍脱钩 —— `max_tokens=10` 实际 completion 85~93，
      **而可见文字只有 1 个字**（差价全花在看不见的内部思考上）。

**阿May（团队负责人）**

- [x] **额度用满没有任何告警**（第 58 批已修：额度归零时发站内通知）：把 Key 打爆（403 insufficient_quota），
      通知中心一条没多，也没提醒管理员。10 人团队里某人钥匙悄悄用完，
      只能等他来问或自己去翻列表。建议加「额度接近/已用尽」的通知。
- [x] **没有按密钥汇总的区间视图 + 没有导出**（第 58 批部分：使用记录已加「密钥」列 + 分页档位到 200；**按密钥的区间汇总与导出仍未做**）：令牌页的「已用」是历史累计、不带时间范围；
      想看「本月各人花了多少、谁快超了」没有现成视图；导出接口试了 5 个全 404、
      页面也没有按钮。每周报账只能一条条截图。
- [x] **额度显示精度不够**（第 58 批已修：<0.01 OD 时给 4 位小数）：设 0.002 与 0.0005 的额度，列表里**都显示 `0.00 OD币`**；
      而「已用」列是 4 位小数（0.0020）。编辑弹窗里是对的，
      所以只是列表列的问题 —— 但用户扫列表就是要判断"谁快不够用了"。
- [x] **使用记录分页 20 条/页**（第 58 批已修：显式档位 20/50/100/200）：10 人团队一天几百条，对账要翻很多页；
      在没有导出的前提下更难受。
- [x] **令牌的禁用/启用没有留痕**（第 58 批已修：只记实际变化的字段）：操作日志里有「新建/删除令牌」「登录」「调用错误」，
      但**禁用/启用**和**额度编辑**这两类关键操作没记录。

**阿蓝（插画师，171 张截图）**

- [x] **暗色分页对比度 1.8:1**（第 58 批已修：显式映射 colorTextDisabled，实测 1.8 → 3.08）：`oklch(0.541…)` 灰字压在
      `rgb(39,40,43)` 深底上（可读下限 3:1）。按钮是 disabled 态，
      但同一个「下一页」是亮的，对比明显。多个页面复现过。
- [x] **长图并排时高度不齐**（第 58 批已修：缩略图固定 140×140 + cover）：700×2000 的竖长条在详情页按 140×400 显示、比例正确，
      但三张并排时中间那张高一截，整块图区被拉长、旁边留一大片空白。
      窄图不裁切是对的，但并排布局需要处理高度差。
- [x] **带图评论 / 站内对话贴图会清空已输入的文字**（第 58 批已修：发图后恢复草稿）：先打好字再贴图，
      输入框变空字符串（3 次复现）。等于必须"先贴图再写字"。
- [x] **媒体库没有上传入口**（第 58 批已修：页头加上传按钮，多选 + 逐个报错）：列表、配额、删除、重命名、下载都在，
      但没有独立的上传按钮 —— 只能通过发帖/评论/贴图间接入库。
      不确定是设计如此还是漏了。
- [x] **@ 输入时没有联想下拉**（第 58 批已修：复用用户搜索接口做联想，补全用 @用户名）：手打全名才能 @ 到人。社区里大家认昵称，
      输入框也不提示该写用户名还是昵称。
- [x] **好友申请弹窗字数计数器重叠**（第 58 批已修：留底部内边距）。

---

### 人格测试 Round 1 · 小白人格（小雨）的未处理项（2026-09-24 登记）

> 她是 Round 1 最后回报的人格，且**恰好在我造成白屏的时间段在场** ——
> 所以她的报告里既有小白视角的困惑清单，也有一手的事故现场描述。
> 已修的（示例模型名 / 对话页引导 / 分组标注）见第 55 批；这里只列尚未处理的。
> 她的收尾建议很值得照做：「如果只修三件事：① 示例换成真能跑的模型名；
> ② 输入框灰掉时给一行字；③ 分组下拉标清能用哪些模型」—— 这三条**都已修**。

- [ ] **用户名最短 2 字符**：她注册 `xy` 直接成功并自动登录。
      密码有校验（8 位 + 字母数字），用户名却没有长度下限 ——
      而 `USERNAME_RE` 写的是 `{2,32}`，即 2 字符是**有意允许**的。
      需决策：保持（允许短名）还是提到 4~6 位（防抢注/防垃圾账号）。
- [ ] **登录失败提示 2 秒消失**：她的描述「我点完没看清楚就没了，
      以为没反应又点了一次」。建议延长停留或把错误挂在表单下方常驻。
- [ ] **全站术语不统一**：菜单叫「令牌管理」、弹窗叫「创建令牌」、
      表格列头叫「密钥」、对话页叫「密钥」、看板叫「鉴权」。
      她的困惑：「我以为令牌和密钥是两种东西」。
      建议统一一个词，或在首次出现处写「令牌（即 API Key / 密钥）」。
- [ ] **无解释的术语**（她逐条列了）：`缓存命中`、`首Token`、`未命中`、
      `用户分组 default`（与建 Key 时的分组同名但概念不同）、
      `上下文计费口径`、`倍率`、`限额`。全站没有一处解释，hover 也没有。
- [ ] **`无限额度` / `永不过期` 两个默认开启的开关无说明**：
      「打开/关掉会怎样？没说。我全默认开着保存了，其实不确定安不安全」。
- [ ] **令牌表格「可用模型」列的 `+1` 点不开也没有 hover**：
      「+1 是什么？还有 1 个模型？哪个？」
- [ ] **`余额可用 999+ 天` 口径未写**：她以为「999 天以上？我额度只够用几天吧」。
- [ ] **`计费比例 1 OD币 = 10,000 额度` 缺体感换算**：
      「我 200 OD币 到底能用多少？没写『约等于几次对话』，我还是没概念」。
- [ ] **外观设置那段设计说明太长**：原文
      「只提供受控的几何底纹：底纹颜色绑定主题线条色，透明度锁死在 3%~6%，
      且卡片/表格/表单始终是不透明实色 —— 因此无论选哪种，正文对比度都稳定可读」，
      她「直接跳过了」。建议压成「随便选，文字都清楚」。
- [ ] **401 缺 Key 的提示信息量过大**（小白视角）：
      「请携带 Authorization: Bearer sk-xxx（OpenAI 风格），或 /v1/messages 用
      x-api-key: sk-xxx（Anthropic 官方 SDK 默认方式）」——
      对开发者是优点，对小白读不完。建议首句给最短路径，细节另起一行。

**她在事故现场的一手记录（已修，但描述值得留档）**：
> 「5 个页面同时**整片白屏，零兜底文案**。控制台 `ReferenceError: SAMPLE_MODEL is not defined`
> → 随后 `ReferenceError: endpoint is not defined`。**连导航栏都没了，我连「返回」都点不了。**
> 我以为网站挂了 / 我账号被封了。」
> 「用户侧至少要有个错误边界说一句『页面出错了，请刷新』」

这条直接促成了 `components/ErrorBoundary.jsx`（见第 55 批）——
它包住整棵路由树，任何页面崩了都还能看到「刷新 / 返回首页」，而不是纯白。

---

## 4. AI 工作流（每次修改必须执行）

1. **读规范**：阅读本文件第 2 节；确认改动是否触碰第 3 节待办。
2. **改代码**：小步提交，一次只解决一类问题；保持现有注释与风格。
3. **自检**：
   ```powershell
   # 后端语法检查（在 ooapi-server/ 下，对所有改动文件执行）
   node --check src/routes/xxx.js

   # 全量测试（语法 + import 一致性 + 计费 + 并发闸门 + 监控指标）
   npm test

   # 前端构建（在 ooapi-web/ 下）
   npm run build
   ```
   涉及 SQL 的改动：人工核对 `?` 数与参数个数（可用 `mysql.format()` 快速验证）。

4. **验证行为（强制，不可跳）**：

   > **`vite build` 成功不能证明页面能打开；接口 200 不能证明数据结构正确。**
   > 本项目已因此栽过三次（全站白屏 ×2、监控快照 500），每次都是「构建/语法全绿但线上挂」。

   在服务器上跑（需 xvfb）：
   ```bash
   ssh root@47.79.85.60
   cd /opt/ooapi/ooapi-server
   BASE=http://127.0.0.1:3001 xvfb-run -a node tests/ui-smoke.mjs   # 23 个路由逐页：白屏/运行期错误
   node tests/monitor-smoke.mjs                                    # 接口结构断言（22 项）
   node tests/sql-compat.test.mjs                                  # 新 SQL 打到真实库（19 项）
   BASE=http://127.0.0.1:3001 node tests/e2e-modules.mjs           # 社区/聊天/游戏/主页/看板/通知/搜索（83 项）
   BASE=http://127.0.0.1:3001 xvfb-run -a node tests/e2e-games-browser.mjs  # 游戏真实点击（22 项）
   node tests/migrate6.test.mjs                                    # 迁移脚本（11 项）
   ```
   - **前端任何改动** → 必须跑 `ui-smoke`，且必须**在部署前**跑。
     它会真实打开每个页面并断言 `#root` 有渲染内容；能抓住 TDZ（声明前引用）、
     模块级未定义引用、编辑时误删相邻变量这类「构建期不报错、一打开就白屏」的问题。
     **顺序很重要**（2026-09-24 连栽三次的教训）：
     ```
     # 部署前：先把新产物构建到临时目录，再让 ui-smoke 指向它
     cd ooapi-web && npm run build
     cd ../ooapi-server && cp -r ../ooapi-web/dist ./web-next
     BASE=http://127.0.0.1:3001 xvfb-run -a node tests/ui-smoke.mjs   # 先确认没白屏
     # 通过后再走正式更新流程
     ```
     三次真实事故分别是：`/messages` 白屏（`getFieldValue is not defined`，
     **没跑**就上线，两个用户人格同时报上来）、`SAMPLE_MODEL is not defined`
     与 `endpoint is not defined`（我自己编辑时误删/写错作用域；
     前者在部署前被抓住，后者因为顺序错了**上线约 2 分钟**才被发现）。
     `vite build` 与 `node --check` 对这三类问题**全部绿灯**，只有 ui-smoke 能抓。
   - **后端任何改动** → 部署前跑 `node tests/gateway-smoke.mjs`（真实打三种协议 + 未实现端点）。
     它专抓「网关内部抛未定义标识符」这类**闭包里的**错误：
     `node --check` 只做语法分析不做作用域解析，模块加载检查也抓不到
     （引用在闭包里，不调用不抛 —— 我注入破坏验证过）。
     真实事故：`estimateTokens is not defined` 让 `ReferenceError` 被当成渠道故障 →
     标记 CHANNEL_ERROR 并冷却 → 用户看到 503「账号都在冷却中」，
     **症状与根因看起来毫无关系**。
   - **后端接口改动** → 必须跑 `monitor-smoke`，并对新增/修改的接口
     补一条字段结构断言（曾经 `[[tbl]]` 解构错误只在真请求时才 500）。
   - **写了带 `GROUP BY` / 子查询聚合的 SQL** → 必须跑 `sql-compat.test.mjs`。
     线上 MySQL 默认开 `ONLY_FULL_GROUP_BY`：`SELECT 非聚合列 ... GROUP BY 别的列`
     在本机宽松模式下能跑、线上直接 500（第 37 批真实验证：游戏排行榜）。
     该脚本会让你本机的 MySQL 自己判定合法性，若本机没开这个模式会显式提示
     「测不出问题」，避免假绿。
   - **改计费/限流/并发** → 必须跑 `npm test`（含 `concurrency-gate` 的真实计时断言）。
   - **改游戏规则** → 必须跑 `npm test`（含 `tests/games.test.mjs` 24 项：
     每款游戏的「合法着法被接受」与「非法着法被拒绝」）。

   > **断言要对着结构写，不要对着序列化文本做子串匹配。**
   > 第 37 批的真实教训：海战棋的隐藏信息检查拿格子下标去响应 JSON 里找，
   > 而单位数会命中 `id`/`version`/时间戳等字段 —— 于是永远报「泄露」，
   > 让人去修一个并不存在的 bug。改成断言 `foeBoard` 全为 -1、
   > `myBoard` 不含舰体标记这类**结构条件**后才可靠。

5. **回写文档**：更新本文件「变更记录」，勾选/新增待办，保持行号引用不过期。
6. **不要**：提交 `.env`、改 `ADMIN_PASSWORD`、在没跑构建前就说"完成"；
   更不要**只跑构建就宣布可用**——见第 4 条。
7. **禁止**：创建新的 `.md` 文档；所有内容只写在本文件内。
   **例外（已存在，别删）**：`AGENTS.md` / `CLAUDE.md` / `CODEX.md` / `README.md` ——
   它们是**只读的「AI 助手入口文件」**，职责只有两件：把助手引到本文件、
   列出硬约束与验证门禁。项目规范 / 待办 / 变更记录一律仍**只**写在本文件，
   不得在那几个文件里记流水账（否则又变成多份文档同步的老问题）。
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
| 2026-09-20 | **Gemini UI/UX 建议落地**：基于 Gemini 对首页和后台管理台的分析，实际修改系统设置为响应式两列配置网格，
  textarea 跨列、移动端单列并移除 hint/extra；用户管理统计改紧凑条，编辑/额度弹窗改两列布局；模型定价、令牌、
  使用记录统一小尺寸工具栏和表格，令牌弹窗改两列配置；补齐设置页 `useRef` 运行时导入。保留现有 API、错误态、
  loading、重试、权限限制和危险操作确认。涉及 `ooapi-web/src/pages/AdminSettingsPage.jsx`、
  `AdminUsersPage.jsx`、`AdminPricingPage.jsx`、`TokenPage.jsx`、`LogPage.jsx`、`styles.css`。 |
| 2026-09-20 | **Gemini 首页建议落地**：首页降低网格与 glow 装饰强度，收紧首屏和区块间距，统一 1200px 流体容器、
  sticky 导航、代码块局部横向滚动、移动端按钮堆叠和端点省略，保留登录/注册/控制台/API 复制/文档等真实交互。 |
| 2026-09-20 | **后台子页收尾**：分组管理补齐紧凑工具栏和小尺寸表格，监控/操作日志/媒体库沿用当前小尺寸表格、错误态、
  重试和详情抽屉；渠道页现有双栏弹窗、独立滚动与固定列背景修复保持不动。 |
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
| 2026-09-18 | **第 17 批（分组 sub2api 化 + 渠道用量统计）**：
  · **分组**：新增 `channel_groups` 表（分组**按厂商隔离**，同名分组跨厂商互不相干）；
  `channels.groups` JSON 数组（一个账号可属多个分组，启动时自动用 `group_name` 回填并补齐分组行）；
  渠道新增/编辑支持多选分组（回车即新建），列表按 chips 展示；新增「分组管理」弹窗（按厂商新建/删除，
  删除时自动从该厂商渠道摘除）；`GET/POST /api/channel/groups`、`DELETE /api/channel/groups/:id`；
  · **API Key 绑定分组**：令牌创建/编辑新增「分组」下拉（按厂商分组展示，值 `type:name`），
  网关路由用 `token.group_name || user.group_name`，`channelInGroup` 支持「厂商:分组」严格匹配
  （未绑定分组的渠道只服务 default 池）——即 sub2api 的「账号池 → 分组 → Key」流程；
  用户侧新增 `GET /api/token/groups`（登录即可读，只回厂商+分组名）；
  · **渠道用量统计**：操作列新增图表图标 → 弹窗展示：近 N 天调用/Token/消费概览、按天柱状图（悬浮明细）、
  按模型条形榜（消费+Tokens）、最近调用（来源/耗时/提示词→回复）；
  消费日志 `detail` 增强（`channel_id`/`channel_ids`/`model`/token 明细），网关、站内对话（含部分计费）
  全部接入；`GET /api/channel/:id/stats?days=30` 兼容老库（无 JSON 函数时降级为基础信息）。 |
| 2026-09-18 | **第 17 批线上验证与紧急修复**：部署 `2e37b70` 后服务启动崩溃循环（restart 30+ 次）——
  根因：`channels.groups` 撞 MySQL 8 保留字（GROUPS，窗口函数关键字），CREATE TABLE / ALTER 均报
  `ER_PARSE_ERROR 1064`，`migrate` 抛错导致进程退出；服务不可用又使内置更新器的 HTTP 触发路径失效
  （鸡生蛋问题）。处置：**列名改 `group_list`**（commit `62eee2e`，涉及 db.js 建表/自动迁移/回填、
  channel.js 全部 SQL 与解析、router.js rowToChannel；前端响应字段名 `groups` 不变）；
  服务器上直跑 `services/updater.js#performUpdate`（绕过 HTTP）强制更新到 `62eee2e`。
  线上验证（全部通过）：迁移（`channel_groups` 表 + `group_list` 列 + 3 个种子分组 + 4 渠道回填）；
  渠道 #10 绑定 `["default","smoke"]`；`GET /api/channel/groups` 分组计数正确；
  创建令牌 `smoke-ok`（绑定 `openai:smoke`）与 `smoke-none`（绑定 `openai:no-such-group`）；
  网关实测：绑定存在分组的 Key 流式返回 `group-test`（命中 #10），绑定不存在分组的 Key 返回
  `503 NO_CHANNEL`（分组隔离生效）；`GET /api/channel/10/stats` 返回 1 次调用 / 46 tokens /
  0.0004 OD / byModel `gpt-5.6-luna` / recent 来源 `chat`；`GET /api/token/groups`（用户侧）200
  返回三厂商 default；清理完成（#10 恢复 `["default"]`、smoke 分组与测试令牌删除）。
  备注：本次 `git add ooapi-server/src` 顺带纳入了另一窗口新建的 `services/harness/runs.js`
  （当前无引用，不影响运行）。**教训：新增表/列前必须核对 MySQL 保留字清单。** |
| 2026-09-18 | **第 18 批（渠道批量检测）**：勾选渠道后批量操作区在「批量修改」后新增**批量检测**按钮——
  对全部选中渠道并发 `POST /api/channel/:id/test`（`Promise.allSettled`，单个超时 90s），
  检测中按钮与行内测试按钮显示 Spin 并禁用（新增 `testingIds`/`batchTesting` 状态），
  完成后 toast 汇总「N 个可用 / M 个失败（失败渠道名）」并刷新列表（小绿条同步更新）。
  后端测试接口无状态，可安全并行；`AdminChannelsPage.jsx` 单文件改动，`npm run build` 通过。 |
| 2026-09-18 | **第 19 批（渠道用量统计弹窗重做）**：参考主流「Token 统计」的布局重做弹窗（颜色/控件沿用自有设计令牌，
  不引入图表库）：顶部统计卡（累计调用 / 累计 Token / 峰值单日 Token / 累计消费 / 当前连续 / 最长连续）；
  「Token 活动」贡献图式热力图（近 365 天、行=星期列=周、月份标签、少→多色阶，口径可切 每日/每周/累计）；
  「时间范围」近 7/30/90 日胶囊开关 + 「每日 Token 趋势图」（按模型多线 SVG 折线、Catmull-Rom 平滑、
  悬浮十字线与明细 tooltip、自动图例、Y 轴紧凑刻度）；「最近调用」保留为底部区块。
  后端 `GET /api/channel/:id/stats`：窗口上限 90→366 天、新增 `allTime`（不限窗口累计，SQL 对 detail JSON 求和）
  与 `series`（按天按模型 Token Top8 + 其他，供趋势图）；前端一次拉 365 天，范围开关在前端切片。 |
| 2026-09-18 | **第 20 批线上验证**（`b24df43`）：`RECENT_HYDRATE` 渠道 #10 重启后回填 20 条最近调用；
  迁移后旧自动种子分组已清空（`[]`）；建组 `openai/smoke20`（备注/倍率2/模型 gpt-5.5/成员 #10）成功，
  渠道 `groups` 变 `["default","smoke20"]`（双向）；用户侧 `/api/token/groups` 返回备注/倍率/模型；
  **倍率计费实测**：同一 `hi` 调用，未绑定 Key 扣 2 单位、绑定倍率 2 Key 扣 4 单位（比值精确 2×）；
  **分组模型限制实测**：绑定 Key 调 `gpt-5.6-luna` 返回 503「当前分组的 Key 不可调用模型…」；
  清理完成（删组自动解绑渠道与 Key）。 |
| 2026-09-18 | **事故与修复记录**：第 20 批首次提交（`af02211`）时 `git add` 误带上另一窗口未提交的
  `routes/chat.js` WIP（依赖尚未提交的 `harness/sessions.js` 新导出）与 `styles.css` WIP（删除输入区旧样式），
  导致线上启动崩溃（`SyntaxError: does not provide an export named 'batchSessions'`）。
  处置：`git checkout 570a1bb -- routes/chat.js styles.css` 回退这两个文件后仅重放本批改动（`b24df43`），
  服务恢复；另一窗口的 WIP 已还原到工作区（仍未提交，后续由其窗口自行提交）。
  **教训：`git add <目录/大批文件>` 前必须逐个确认 diff 归属，跨窗口协作只 `git add` 明确属于本批的文件。** |
| 2026-09-18 | **第 20.1 批（分组独立页面 + 密钥只看分组 + 降智透传）**：
  · **降智/过载透传上游原文**：codex 适配器三处降智判定（HTTP 非 2xx、SSE `response.failed/error`、
    健康检查）不再只抛「上游返回过载/降智提示」，而是拼上解析后的**上游实际消息**
    （`上游返回过载/降智提示：<上游原文>`）并附 `err.upstream` 原文；网关 SSE/JSON 与站内对话
    错误链路都直接展示该消息，用户可见。
  · **分组管理独立成页**：新增 `/admin/groups`（侧栏「平台管理 → 分组管理」）：
    列表（厂商图标 / 分组名 / 备注 / 倍率 / 可用模型 / 账号数）+ 新建/编辑弹窗
    （厂商、分组名、备注、倍率、包含账号多选、支持模型 tags）；渠道管理中的分组弹窗已移除，
    渠道编辑仍可挂分组（双向）。
  · **密钥不再选模型**：令牌创建/编辑移除「可用模型」输入，改为在选择分组后显示
    「该分组可用模型」（留空=不限，跟随账号）；列表模型列按绑定分组展示可用模型；
    提交固定 `model_limits=[]`；路由/计费口径不变（分组限制 + 分组倍率）。
  · **合并其他窗口 WIP 一并推送**：对话 harness（`sessions`/`loop`/`tools`/`agents`/`files`、
    项目与批量会话）、前端 `PromptBar`/`ArtifactPreview`/`Markdown`/beautifului/chat 样式与
    `ChatPage`、README。合并前通过「命名导出静态检查 + 全量 `node --check` + `vite build`」三重校验。 |
| 2026-09-18 | **第 21 批（对话密钥化 + 编排/细节修复 + 公共池 + 官方图标 + Noto 字体）**：
  · **对话必须通过密钥**：没有可用密钥时 `/api/chat/meta` 不返回任何模型（前端自动选中第一个可用
    密钥并按分组重算模型），`/run` 直接 403 并提示「先去创建密钥」；编排栏密钥菜单移除「账户默认」，
    无密钥时禁用并给「去创建密钥」入口。
  · **编排栏**：智能体菜单名称/说明拆两行（原来挤一行被截断）；密钥显示分组名或「公共池」。
  · **default 分组彻底移除**：迁移清理渠道 `group_list`、`users`、`tokens` 上的历史 default；
    `channelInGroup` 新语义——未分组渠道 = 公共池（未绑定分组的 Key 只能走公共池，分组 Key 只走本组）；
    渠道/令牌表单与列表同步（「公共」/「公共池」文案），新建渠道不再默认挂 default。
  · **最近调用增强**：记录携带发起用户（管理端以「头像 + 名字」tag 展示，点击复制邮箱；去掉「调用/记录」
    tag）；列表与弹窗的小绿条/条目点击复制「原始返回结果」（`c.r`）。
  · **细节**：会话侧栏多选图标由对号改为选择图标（`SelectOutlined`）；对话输入框 `min-height` 28→36px；
    Grok 换官方 X 标（`public/icons/grok.svg`，覆盖 `grok`/`grok-oauth` 渠道与 `grok-*` 模型）；
    正文字体 Inter → **Noto Sans SC**（本地打包 chinese-simplified+latin 400/500/700，移除 rsms.me 外链）。
  · **降智/过载透传**：codex 适配器三处（HTTP 非 2xx / SSE error / 健康检查）把上游实际响应拼进错误
    （`…：<上游原文>`）并附 `err.upstream`。 |
| 2026-09-18 | **第 21 批线上验证**（`ea230e0`）：历史 default 清理 0 残留（渠道/用户/密钥）；
  无密钥 `/chat/meta` 返回 0 模型，创建公共池 Key 后 12 个模型可选且 `/v1` 调用成功；
  最近调用记录带 `u:{n,e}`（管理端显示用户标签，点击复制邮箱）；分组 Key 仅见 `gpt-5.5`，
  调 `gpt-5.6-luna` 返回 503「分组限制了可用模型」；dist 产物含 Noto Sans SC 字体文件与
  `icons/grok.svg`；测试 Key 与测试分组已清理。 |
| 2026-09-18 | **第 20 批（分组体系按 sub2api 重构 + 两个线上 bug 修复）**：
  · **修复「刷新后最近调用丢失」**：列表接口 `rowToResp` 只读运行时内存态，服务重启后不回填
  `channels.recent_calls`；新增 `router.channelRecent(id, raw)`（运行时为空则从库回填并缓存）
  并接入列表与调度两条路径（`router.js`/`routes/channel.js`）。
  · **修复「统计弹窗白屏」**：`smoothPath` 的点来自 `toFixed()` 字符串，`+` 变成字符串拼接后
  `c1x.toFixed is not a function`；先 `Number()` 归一化。已用 SSR 复现并回归。
  · **分组重构（sub2api 语义）**：`channel_groups` 新增 `rate`（倍率）/`models`（分组支持的模型）；
  分组**只由管理员创建**（不再按厂商自动生成 default 行；本升级一次性清理旧的种子行）；
  POST/PUT/DELETE `/api/channel/groups` 支持厂商/名称/备注/倍率/模型/成员账号，
  成员与渠道编辑双向同步（渠道 `groups` 可多选，含隐式 default 池）；
  `GET /api/token/groups` 返回 type/name/remark/rate/models；
  · **路由与计费**：`selectChannels`/`explainNoChannel` 按分组模型限制（空=不限，支持通配）；
  网关与站内对话按分组倍率计费（`services/group-rate.js` 30s 缓存 + `applyGroupRate`）；
  删除分组时同时解绑 Key（回落默认池）；
  · **前端**：令牌创建/编辑的分组下拉改为**单一选择**，选项显示厂商图标 + 分组名 + 备注 + 倍率；
  渠道管理「分组管理」弹窗改为完整编辑器（建组/编辑/成员多选/模型 tags/倍率），
  渠道表单分组选择改 multiple（分组由管理端创建，不再回车即建）；
  · **布局细节**：侧边栏字体显式统一为 `--font-sans`；侧栏「返回首页」从菜单移到底部，
  替代原来的「收起侧边栏」（收起按钮内容区顶部已有）。 |
| 2026-09-18 | **GPT 速度排查（实测结论）**：同一真实账号在测试服务器（node fetch 直连）实测：
  裸调 `chatgpt.com/backend-api/codex/responses`（store:false + client_metadata + prompt_cache_key，
  与线上同参）TTFB 0.6~1.4s / 完成 1.3~2.1s；`gpt-5.6-luna`/`gpt-5.6-terra`/`gpt-5.5` 均同量级；
  reasoning low/none/medium、store:true（被拒）、image_generation 工具、encrypted reasoning、
  有无 292 通行证注入（适配器内 probe 连跑 4 次 1.6~1.9s）**均无显著差异**；
  上游 `gpt-5` 不支持、要求 `store=false`。结论：不是 state 注入/适配器问题，
  截图里的 11.4s 是部署构建抢 CPU / 网络抖动期间的旧样本；
  交互变慢的路径只有「开启思考」时 codex 适配器强制 `reasoning.effort=medium`（默认关，不影响）。 |
| 2026-09-18 | **第 19 批（对话页二轮重构：断线续传 / 项目与归档 / 按用户可用模型 / 输入栏对齐官方）**：
  · **断线续传**（`services/harness/runs.js` + `/run`、`/sessions/:id/stream`、`/sessions/:id/stop`、`/running`）：
  运行与 HTTP 连接解绑 —— 用户切页/刷新时只退订事件流，后台继续跑完并落库计费；事件进环形缓冲（上限 4000），
  重连先回放再续播，界面无缝恢复（实测：流到一半刷新，回来后继续输出且无重复）；
  **只有显式点「停止」才真的中止上游**；同一会话并发提交返回 409（防双份计费）；
  事件里的 part 一律存**快照**（`{...part}`），否则回放会把累积后的文本当初始 part 再叠加 delta 造成内容重复；
  前端按 part id 幂等合并，杜绝重连与实时事件交错的重复。
  · **项目 / 归档 / 批量**（新表 `chat_projects` + `chat_sessions.project_id/archived/pinned`）：
  侧栏改为 ChatGPT 结构 —— 顶部「新建对话」，对话/已归档 视图切换，项目分组（可建/改名/删除，删项目不删对话而是退回未归类），
  对话行支持置顶/归档/删除，多选模式批量归档、取消归档、移动到项目、删除；列表按「置顶优先 + 最近更新」排序。
  · **按用户实际可用性给模型**（修正「普通用户看到后台全量模型」）：三层过滤 —— ① 用户分组能路由到的启用渠道所声明的模型；
  ② 普通用户再受自己 API Key 的 `model_limits` 白名单约束（上限 3 个 Key 取并集，空白名单=不限，与网关 `modelAllowed` 同一套前缀语义，保证「能选」=「能调」）；
  ③ 管理员不受密钥层约束。一个 Key 都没有的普通用户退回渠道层（站内对话走账户额度、不经 Key）；`/meta` 同时返回按厂商归类的 `vendors`。
  · **输入栏对齐组件库官方实现**（逐个量取官网真实数值后重写 `components/PromptBar.jsx`）：
  容器 `p-[6px] rounded-[14px] border-line bg-surface shadow-card`、控制行 `grid-cols-[28px_minmax(0,1fr)_auto_28px_28px]`、
  输入框透明底 `13px/18px` 自增高、按钮一律 `28×28 rounded-lg`；
  **输入区外层改回完全透明**（此前整条有底色和上边框，与官方「悬空浮岛」不符），提示文字紧贴输入框正下方；
  **删除顶部编排栏里重复的模型选择器**（模型只在输入栏选）；
  模型下拉按**厂商分组**（图标 + 厂商名 + 数量，组头 sticky），行内显示友好名称而非裸 id；
  菜单挂到触发按钮上而不是输入框，修掉「输入框自增高时菜单漂移」。
  · **顺带清理**：删除 `styles.css` 里第一版移植遗留的 `.bui-composer/.bui-composer-input/.bui-send/.bui-composer-wrap` 等 160 余行死规则 ——
  它们以相同选择器覆盖了新的 PromptBar 样式（表现为输入框字体/行高、容器圆角与官方不一致），是本次「样式不生效」的真实原因。
  自检：后端改动文件 `node --check` 通过；用「真实路由 + 真实 harness、只桩 DB/上游/鉴权」的本地服务实测
  （断线续传无重复、归档计数正确、批量 affected 正确、模型按分组与密钥过滤）；
  前端 `npm run build` 通过；浏览器逐项量取样式数值与官网一致，浅色/深色、桌面/移动均已复核。 |
| 2026-09-18 | **第 21 批（对话能力扩展：密钥路由 / 文档上传 / GitHub / 产出物在线预览）**：
  · **模型按「选中的密钥」算**（配合另一窗口的分组体系）：站内对话扣账户额度、不经 Key，
  但**路由配置挂在 Key 上**（Key 绑定分组 → 决定可用模型、可走渠道、计费倍率）。
  编排栏新增「密钥」选择（默认=账户默认分组），切密钥会重新拉 `/meta?keyId=`：
  模型 = 分组模型限制 ∩ 分组成员渠道声明 ∩ 密钥自身 `model_limits`（管理员豁免密钥层）；
  两侧用同一套 `channelInGroup` + `groupConfigOf`，保证「页面能选」=「实际能调」；
  `/run` 传了不可用模型直接拒绝（而不是等到 NO_CHANNEL）；计费倍率也按本次路由的分组算（与 /v1 口径一致）。
  · **文档上传与解析**（`services/harness/files.js`，无新依赖）：文本/代码 57 种扩展名直读；
  PDF 用内置 zlib 解 FlateDecode 后抽文本算子（识别 TJ 字距为空格、UTF-16BE 中文串）；
  DOCX/XLSX 手写最小 zip 解析；旧版 .doc/.xls/.ppt 与扫描件 PDF 给出**明确**不可读原因而不是静默空内容。
  解析结果作为 user 消息的 `file` part **落库**，并进历史上下文（追问不丢）；单文件 8MB、最多 5 个、正文 30k 字符上限。
  附件入口合并成「+」菜单（图片 / 文档），消息里以文件 chip 展示。
  · **GitHub 工具**（只读公开仓库）：list 目录 / file 读文件（缺 path 自动找 README）/ search 搜代码，
  固定 host 走 api.github.com（可选 `GITHUB_TOKEN` 提高限额），404/403 给出人话提示；已分配给通用·研究·代码三个 primary 与检索子代理。
  · **产出物在线预览**（`components/ArtifactPreview.jsx`）：模型回的 ```html / ```svg / ```react 代码块
  从「一坨源码」变成「代码 | 预览」双视图，点预览直接在对话里跑；支持放大到全屏。
  安全边界：iframe `sandbox="allow-scripts"`**且不加 allow-same-origin**（脚本读不到本站 localStorage/cookie，
  实测取 `contentWindow.localStorage` 抛 SecurityError），并注入 CSP `connect-src 'none'` 阻断外发；
  默认不渲染，用户点了才跑。
  · **顺带**：编排栏「工具 4」改为「能力 联网检索·读取网页·读 GitHub·…」，一眼能看出这轮会用什么；
  修复 `Markdown.jsx` 代码块此前无法区分的渲染路径。
  自检：后端改动文件 `node --check` 通过；用「真实路由 + 真实 harness、只桩 DB/上游/鉴权」实测
  （密钥分组过滤、错误密钥拒绝、文件解析落库、不支持类型报错、只发文件可发送）；
  files.js 单测覆盖 文本/PDF(含压缩流)/DOCX(构造 zip)/不支持类型；github 工具真实拉取 nodejs/node README 成功；
  前端 `npm run build` 通过；浏览器实测预览可交互（按钮生效、柱子由 JS 渲染）、沙盒隔离与 CSP 均生效。 |
| 2026-09-18 | **第 22 批（反代适配器风控审查与修复）**：对照开源参考 CLIProxyAPI（router-for-me/CLIProxyAPI）
  逐项核对各厂商适配器的身份构造、指纹一致性、错误归类与冷却策略，修复 9 处（含 2 处「封号放大器」）。详见第 1.7 节。
  · **DeepSeek（最严重）**：`wafBlocked()` 里含 403，导致 `403 → CHANNEL_AUTH_EXPIRED` 分支**永远不可达** ——
  本该「重新登录 + 6h 冷却」的风控响应，实际被当成可重试错误在同一账号上打了 3 次、只冷却 300s。
  现改为：401/403 优先判定并隔离（6h），202/405/风控文案 → `CHANNEL_WAF` + 6h 冷却，429 → 15 分钟冷却，
  三者均**不再原地重试**（只有 5xx 保留重试）；`is_muted` 按其 `mute_until` 冷却（上限 24h）。
  实测确认：403 命中路径从「3 次请求」降到「1 次」。
  · **探针/定时检测绕过限速**：`probeChannel` 直接调 `adapter.chat()`，没有包 `withChannelLimit` ——
  批量检测会并发打同一账号（HTTP 渠道没有任何串行保护），是实打实的风控触发点。现已统一并入渠道限速闸门。
  · **Kimi 解析器两处**：① `ev.done !== undefined` → 任何带 `done:false` 的阶段帧/心跳帧都会**提前结束流**，
  回答被截断却按成功计费；改为 `done === true`。② 帧 flags 判的是 `0x80`（并非 Connect 规范里的位）且命中后直接丢弃，
  上游一旦启用压缩就静默丢内容；按规范改为 `0x01 = 压缩`并真正 gunzip 解压（损坏帧跳过，不中断整条流）。
  · **Qwen role 过滤失效**：CN 版写成 `role === "assistant" || typeof content === "string"`，后半句对任何文本都成立
  → 等于没过滤，差分从 0 开始吐会把**用户提问当成模型回答**输出。改为只取 assistant（缺 role 时按助手处理）。
  · **Doubao 丢文本**：未知 `content_type` 且 content 是纯字符串时，兜底分支要求必须是对象 → 文本被静默丢弃，
  表现为「上游有输出但网关报空」。补上纯字符串与 `content.think` 两条分支。
  · **浏览器指纹可检测**：`--window-position=-32000,-32000` 是自动化环境教科书特征（页面 JS 可读 `window.screenX`），
  改为屏幕外但数值正常的坐标并按账号散布；补 `ignoreDefaultArgs: ["--enable-automation"]`（否则 `navigator.webdriver === true`）、
  `--lang` 与 locale 对齐（避免 UA 与 navigator.languages 冲突）。
  · **sec-ch-ua 内部不自洽**：两个指纹模块的 grease 串不一致（`Not?A_Brand` vs `Not_A Brand`）、品牌顺序是 Chrome 100 时代写法；
  统一为 Chromium 在前、grease 在中间、真实品牌在后的现行顺序。
  · **冷却分档**：`execute.js` 默认冷却此前风控只给 300s、验证码 300s（等于冷却一过继续去撞）；
  改为 WAF 6h、验证码 1h、登录失效 6h、其余 5 分钟。
  自检：改动文件全部 `node --check` 通过；新增 13 项解析器回归（Kimi 提前收流/压缩帧/损坏帧/trailer、
  Qwen role 过滤(含无 role 兼容)、Doubao 未知类型）全绿；用桩 fetch 验证 DeepSeek 四种状态码的重试与冷却策略；
  前端 `npm run build` 通过。 |
| 2026-09-18 | **第 23 批（GLM 档位错配修复 + 谷歌交互式登录）**：
  · **GLM 模型档位**：适配器此前**完全忽略用户选的模型**（代码注释称「改顶层 model 上游返回 0 帧」，于是把档位交给页面默认值）——
  后果是「用户选 GLM-5.3、实际跑 GLM-5.3-Flash」，而**计费按用户选的模型算**，属于静默错配。
  对照开源实现（izaart95-jpg/GLM-Free-API 的 `zai.go`）确认：Z.ai 的签名载荷只覆盖
  `requestId/timestamp/user_id/prompt`，**不含 model**，从签名角度改 model 是安全的；当初「0 帧」更可能是模型 id 或账号档位不匹配。
  改法：新增渠道级开关 `other.patch_model=true` 时才注入 model（无法在本机验证，不把「能用但档位不对」改成「完全不能用」）；
  无论是否注入，都在流结束后用 `lastBody.model` 核对实际档位，不一致就告警并回传 `modelMismatch`。
  · **谷歌交互式登录**（`services/upstream/oauth-login.js` + `/channel/oauth/{start,exchange,info}`）：
  此前订阅渠道只能「先在自己电脑上装官方 CLI、登录、再把凭据文件抄过来」，门槛高。
  现在支持在平台里点「打开授权页面」→ 官方页面登录 → 把浏览器地址栏那串 URL 复制回来 → 一步完成换令牌 + 建渠道。
  **为什么是手动粘贴而不是自动回调**：官方客户端注册的 `redirect_uri` 固定是 `http://localhost:51121`，
  浏览器登录完会跳到**用户本机**的 localhost（服务器收不到），这是标准现象 ——
  与 `gcloud auth login --no-launch-browser` 同理；好处是不需要公网回调地址、不需要备案域名。
  安全：state 随机生成且 15 分钟过期（防 CSRF）；缺 `refresh_token` 时**当场报错拒绝**（否则收下一个一小时后必然失效的渠道）；
  常见错误（redirect_uri_mismatch / invalid_grant / invalid_client）翻译成可操作提示；client_secret 从 `.env` 读不硬编码。
  前端：选到订阅方式且后端支持时显示「打开授权页面」，粘贴框自动切换为「回调地址 / 授权码」，
  可识别完整 URL、纯 code、URL 编码三种粘贴形态；未配置 OAuth 客户端时给出配置指引并保留「粘贴凭据」老路径。
  自检：7 项登录逻辑用例全绿（是否支持/授权地址参数/三种粘贴形态解析/缺 refresh_token 拒绝/正常换取/state 校验/未配置提示）；
  改动文件 `node --check` 通过；前端 `npm run build` 通过。 |
| 2026-09-18 | **第 24 批（渠道添加体验 + 最近调用清洗 + 登录抓取升级）**（线上 `2618597`）：
  · **最近调用清洗**：网页版多轮 prompt 的 ChatML 角色标记（`<｜User｜>`/`<｜Assistant｜>`/`<｜end▁of▁sentence｜>`）
  在**存储侧**（`router.js clip()`）与**展示侧**（前端 `cleanSummary()`，覆盖老数据）统一剥除。
  · **来源 tag / 用户名缺失根因**：降智轮换记录（`execute.js` `markChannelError` 未带 meta）、换渠道失败记录（无 `kind`）、
  harness 检索工具内层调用（未传 `user`）三处补齐；前端对 `chat`/无来源记录增加「对话 / 其他」兜底 chip。
  · **用户名省略**：统计弹窗来源列固定 84px，用户名只显示前 2 字 + `…`（完整名字/邮箱放悬浮提示，点击复制不变）。
  · **添加渠道弹窗**：底部按钮统一为「添加」（不再叫「登录并添加/创建渠道」）；登录变成表单内的独立操作按钮。
  · **浏览器登录（GLM/豆包/通义）**：relay 配置补 `entryUrl`，新增 onboarding profile 机制 ——
  `capture/start` 在共享 `vendor-onboarding` profile 里打开登录页，登录完成后 `capture` 保留 profile，
  提交时 `copyProfile()` 复制给新渠道再 `verify`；省掉「先建渠道再回列表登录」的来回。
  · **OAuth 一键登录（gemini/openai/anthropic）**：`oauth-login.js` 扩展三家配置并支持 **PKCE(S256)**；
  capture 流程在服务器浏览器里打开官方授权页，检测到 localhost 回调后自动换 token 并回填凭据 JSON；
  手动「打开授权页 + 粘贴回调」路径保留；Grok 为 device-code，暂只支持粘贴/导入。
  · **凭据录入增强**：订阅表单内新增**导入凭据文件**（auth.json / CPA / sub2api 导出，自动取 credentials 对象）、
  Access Token / Refresh Token 直填；**RT-only 导入会自动调适配器刷新换 AT** 再落库；
  顶部批量导入支持多文件/目录一次拼接。
  · **弹窗裁剪修复**：body 由 `overflow:hidden` 改为整体滚动、厂商列表不再内部裁剪焦点环、右栏高度约束统一、
  添加弹窗内恢复显示字段说明（extra）。
  验证：线上部署 `2618597`，无头浏览器实测 —— 统计弹窗最近调用正常（`定时` chip、提示词已无 `<｜User｜>`）、
  GLM 登录弹窗真实打开 chat.z.ai、OpenAI 一键登录打开 auth.openai.com（PKCE 参数被接受）、
  Anthropic 打开 claude.ai 授权页；Python 无，JS 控制台除 2 条 antd 既有告警外 0 错误。
  待办：Google 一键登录需在服务器 `.env` 配置 `GOOGLE_OAUTH_CLIENT_ID/SECRET`（未配置时有明确提示）；
  Grok device-code 交互式登录未实现（粘贴/导入可用）。 |
| 2026-09-18 | **第 25 批（第一轮十轮审查 → 逐轮修复，线上 `496f41a`）**：
  R1 渠道链路：抓取 cookies 串兼容、慢接口 90s 超时、OAuth 去重稳定键、僵尸抓取会话定时回收、RT-only 刷新报错归一；
  R2 最近调用：检索内层调用补 channelId、排队时间不计入耗时/超时、stats 回填历史记录、定时检测防重入、recent_calls 写回按渠道串行；
  R3 订阅凭据：`oauth/exchange` 方法判定修复（此前恒报不支持）、账号标识集合判重、RT 导入唯一刷新锁、state 强制命中校验、claude 刷新 RT 覆盖新旧字段；
  R4 浏览器驱动：onboarding 每会话独立 profile、抓取启动异常清理、copyProfile 原子复制+关闭目标会话、空闲回收跳过在途任务、看门狗让排队任务快速失败；
  R5 计费：部分计费补分组倍率与差额估算、缓存价缺失回退输入价、令牌更新不再覆盖并发扣费、分组绑定校验存在性；
  R6 鉴权：JWT 令牌版本（改密即失效旧令牌）、网关/站内先鉴权后解析大包、bcrypt 72 字节上限、假哈希防用户名枚举；
  R7 流式：页面捕获闭包隔离+缓冲上限、错误码细分 HTTP 状态、图片抓取取消响应体、JSON 兜底限长、已流出失败也冷却渠道；
  R8 前端：停止生成同步通知服务端、切会话视图不再误杀流、meta 竞态代际保护、403 禁用统一登出、卸载后不再建定时器；
  R9 样式：补 `--r-sm/--r-md`、ConsolePage 类名对齐 `bui-*`、导入结果背景变量、趋势提示边界收敛；
  R10 部署：更新哨兵+启动告警、前端产物原子切换、migrate3 子字段写入、退出排空请求并关连接池。
  验证：线上部署 `496f41a`，渠道页/统计弹窗（10 条最近调用）/添加弹窗（OAuth 一键登录按钮）实测正常，0 控制台错误。 |
| 2026-09-19 | **第 26 批（第二轮十轮审查 → 逐轮修复，线上 `f45e515`）**：
  R11 回归：onboarding 临时 profile 兜底清理（PENDING_PROFILES）、账号标识强/弱分级判重（project_id 不再跨字段误判）、排队+调用双段超时、部分计费收敛回「整轮无 usage 才估算」、写回串行表可回收、哨兵路径对齐；
  R12 性能：渠道选择 5s TTL 缓存 + epoch 失效、channels/logs 复合索引迁移（status,priority / type,created_at / user_id,type,created_at）、站点累计改 users 汇总列、/data/self 复用 used_quota、/meta 复用价格缓存；
  R13 竞态：PENDING_PROFILES 声明位置（会 ReferenceError 的致命错误）、同会话并发提交先原子占位后落库、结算「先置位」防重复扣费、渠道缓存旧快照回写防护；
  R14 边界：keyId/fromSeq/status 严格整数（fromSeq 非法不再清空会话）、导入畸形元素跳过、定价字段按列宽截断；
  R15 安全：渠道 base_url 写入公网校验、浏览器 goto SSRF 校验、zlib 解压限长（压缩炸弹）、图片/网页有界读取、root 随机密码改写入 0600 文件（不再进日志）；
  R16 一致性：扣费「结果不确定(BILLING_UNCERTAIN)」与「确定未扣」区分处理、oauth/exchange 合并 other、删分组/删用户事务化、更新哨兵仅回滚成功才清除；
  R17 前端：切会话期间禁发与串话防护、finish 代际校验、重新生成保留附件上下文（新增 /run docs 通道）、停止后轮询服务端收尾再解锁、归档清空残留状态；
  R18 适配器：Kimi Connect trailer 错误识别、codex reasoning_tokens（516 降智指纹恢复可触发）、GLM/豆包/通义 finished 提前收流（每轮省 15s 静止等待）、Claude/Grok/Antigravity 尾帧收尾、GLM 回退重写不再重发已输出片段；
  R19 清理：未使用导入删除、README 管理员密码流程改为 `.admin-password` 说明。
  验证：全量 66 个后端文件 `node --check` 通过、前端构建通过；线上部署 `f45e515` 后渠道页/统计弹窗/添加弹窗/网关鉴权（0 额度 Key 正确 403）实测正常，无哨兵残留。
  已知取舍（评估后接受）：渠道创建并发去重仍是「先查后插」（单管理员操作，双并发概率极低）；`other` 列多处读改写未统一原子化（涉及面广，改动风险大于收益）；DNS rebinding 出站 TOCTOU 仍存在（已收窄触发面）。 |
| 2026-09-19 | **第 28 批（完整凭据找回 + 账号额度实时检测 + 反代模型定价补齐，线上 `81129ce`）**：
  · **凭据找回不再只有「粘贴凭据文件」**：新增 `GET /api/channel/:id/recovery`（按渠道真实接入方式给出可用找回方式）、
  `POST /api/channel/:id/recover/start`（在服务器浏览器里打开官方登录页 —— 掉验证/接码那一步由人工在实时画面完成，
  回调/会话读取代理由服务端接管）、`POST /api/channel/:id/credential`（统一凭据写回 + 写回后自动健康检查）。
  · **ChatGPT 网页版支持浏览器登录抓取**：`channel-types` 新增 `captureApi`（`/api/auth/session`）；
  `browser-driver` 新增 `apiFetch`（在已登录页面内请求同源接口，天然带 cookie 与同源头）；
  `/capture/:sid/capture` 新增 `session` 分支与 `targetId` 写回。
  · **前端重登弹窗按能力渲染**：入口对所有反代/订阅渠道开放（此前写死 4 种接入方式，kiro/openai-web 没有入口），
  方式含浏览器授权 / 打开授权页+粘贴回调 / 设备码 / 账号密码 / 粘贴凭据，并显示订阅档位与「需要重新登录」标记。
  · **账号额度实时检测**（新增 `services/upstream/quota.js`）：接入 7 个官方端点 ——
  Codex `GET /backend-api/wham/usage`（primary/secondary window + credits）、Claude `GET /api/oauth/usage`、
  Antigravity `v1internal:retrieveUserQuotaSummary`（`remainingFraction` 是**剩余**比例，已换算）、
  Grok `GET /v1/billing?format=credits`、Kiro `getUsageLimits`、ChatGPT 网页版 `conversation/init` 的 `limits_progress`、
  DeepSeek 官方 API `/user/balance`；GLM/Kimi/豆包/通义的网页版上游确无可读额度接口，明确返回不支持。
  设计约束：**单账号并发锁 + 只由管理员显式触发**（额度接口本身是风控信号，不做高频轮询）；
  查询失败不写 `last_error`、不冷却（额度接口挂了 ≠ 渠道不可用）。
  · 新增 `channels.quota`/`quota_time` 列（建表 + COLUMN_MIGRATIONS 均改）；渠道列表新增「额度」列与「查额度」按钮。
  · **定价补齐**：`gpt-5.6-sol/terra/luna`、`gpt-5.5`、`codex-auto-review`、`grok-4.6/4.5/4.3/3-mini`
  按官方价录入（Grok 取自 docs.x.ai 页面内嵌的官方价表）；**兜底价从「一律 DeepSeek 价」改为「同厂商最高档」**
  （前者对 gpt-5.6-* 这类模型会系统性少计费 3~8 倍）。
  · 厂商归属：`codex-auto-review` 归 OpenAI 图标；定价页补 `anthropic`/`grok` 类型标签。 |
| 2026-09-19 | **第 29 批（模型归厂商 + UI 去解释文案）**：
  · **概念修正：模型属于厂商，不属于账号**。渠道 `models` 留空 = 该厂商全部已注册模型
  （此前留空 = 该渠道不可用，逼着管理员给每个账号手填模型，漏一个模型那个号就永远不被调度）。
  · 新增 `models.modelRegistrySync()`（同步读取登记表）供调度层使用，启动时预热；
  `router.vendorModelSet()` 按厂商聚合模型集合并缓存 60s。
  · 新建渠道 / 登录 / OAuth 交换 / 批量导入 / 凭据导入**不再自动写入 `defaultModels`**
  （那些只是「推荐模型」，写死会让新模型上线后被挡在调度之外）；`PUT /channel` 允许清空 models
  （API 兼容方式仍强制声明，因为 custom 端点没有厂商模型表）。
  · 渠道表单「支持的模型」→「模型范围」（可留空）；列表/宫格对留空渠道显示「{厂商} 全部」。
  · **UI 去 AI 味**：`PageHeader` 删除 `desc` 插槽（所有页面标题下的说明小字一并移除）；
  清掉令牌/渠道/设置/分组/用户页的解释性 `extra` 与说明 Alert（保留功能性提示如字段格式）；
  「公共池/默认池」这类自造措辞统一改为「未分组/不绑定」。 |
| 2026-09-19 | **第 30 批（三路审查修复，线上 `2f1237b`）**：审查第 28/29 批改动，修 1 个 P0 + 4 个 P1。
  · **P0（全站不可用的隐患）**：渠道写操作会让模型登记表失效，而 `vendorModelSet` 把「登记表未就绪」的
  `null` 结果缓存了 60 秒 → 管理员点一次「测试/查额度」就可能让所有 `models` 留空的渠道持续判为不可用
  （表现为 NO_CHANNEL 503，且不会自愈）。修复：`invalidateModelRegistry()` 失效后立即异步补热；
  `vendorModelSet` 不再缓存 null；新增 `invalidateVendorModels()`。回归实测：连续 3 轮「失效 → 自动补热」后均正常命中。
  · **P1 找回错配**：`supportsInteractiveLogin` 只看厂商，导致 openai 厂商下的 `openai-web` 被送进 Codex 授权页、
  anthropic 厂商下的 `kiro` 被写入 Claude 令牌。新增 `supportsInteractiveLoginMethod(type, method)` 精确判定。
  · **P1 额度误判**：`freshToken` 用平台 `expires_at` 预判过期，但 `openai-web` 凭据里没有该字段（它用 JWT 的 exp），
  导致只粘 accessToken 的健康网页版渠道「查额度」必然报「凭据已过期」。改为只在确实过期时刷新。
  · **P1 模型列表少返回**：`/v1/models` 与站内对话的模型列表只用「渠道 models 字段的并集」过滤，
  留空渠道服务的模型会从列表消失。新增 `router.collectAvailableModels()` 统一口径（显式声明 ∪ 厂商全部）。
  · P2：session 抓取分支补 `targetId` 写回；`applyCredentialToChannel` 加凭据长度上限、空 token 不清空原 `api_key`；
  `/login/batch` 与 `/import` 统一留空口径、`/import` 不再硬写已废弃的 `default` 分组；
  找回失败时关闭弹窗而非留空壳；`canVerify` 对 relay 渠道生效；`QuotaInline` 支持只有余额没有窗口的快照。
  · **线上实测（真实账号）**：① 用户提供的两个 sub2api free 账号经 `POST /channel/import` 导入成功（#13/#14），
  额度查询返回真实用量（720 小时窗口已用 82% / 77%，credits 1000）；② 经 `/v1/chat/completions` 实发一次
  `gpt-5.6-luna`，3240ms 返回 "Hi! How can I help you today?"，计费 1 单位并正确落库到渠道 #13；
  ③ 线上渠道 #10 的 `refresh_token` 已被上游吊销（`token_revoked`，强刷 HTTP 401）—— 正是本批找回流程要覆盖的场景，
  `/channel/10/recovery` 已正确给出 3 种找回方式。测试脚本已从服务器清理。 |
| 2026-09-19 | **第 31 批（使用记录明细化 + 独立操作日志页 + 渠道失败归因，线上 `e35cf79`）**：
  · **logs 表扩展 14 列**（建表 + `COLUMN_MIGRATIONS` 同步）：模型/渠道(id+名)/令牌(id+名)/分组/
  提示与补全与缓存 tokens/首Token耗时/总耗时/UA/设备/计费时段；索引改为复合
  `(channel_id, type, created_at)` 与 `(model, type)`（单列索引在恒带 type+时间的查询下仍需回表过滤）。
  · **首 Token 耗时**在流式首个增量到达时打点（网关 `onDelta/onReasoning`、harness 每步记录）；
  **设备**由 UA 解析（`utils.deviceFromUa`，零依赖：浏览器版本 + 系统，覆盖 Chrome/Edge/Safari/微信/
  curl/Python/Node/Go 等）。
  · **writeLog 支持传 `req` 自动补 ip/UA**：38 处管理类调用点统一补上，操作日志从此能追「谁从哪台设备做的」。
  · **接口重构**（`routes/log.js`）：`/log/usage`（消费）与 `/log/operation`（非消费）分离 ——
  一个是用量审计、一个是行为审计；新增 `/usage/summary` 汇总卡与 `/usage/filters` 筛选候选；
  **敏感字段按角色裁剪**（渠道/密钥/分组/原始 UA/成本明细仅管理员）。
  · **前端**：新增 `UserAvatar`（用户名→稳定色相首字母头像，零依赖，支持自定义头像回退）；
  使用记录页重写（13 列 + 顶部 6 张汇总卡 + 详情抽屉）；新增操作日志页与侧边栏入口。
  · **渠道失败归因（P0）**：`execute.js` 给错误挂 `channelId/channelName` ——
  此前失败调用无法归属到渠道，看板的「渠道成功率」只能靠 20 条环形缓冲估算，按天/周维度完全失真；
  gateway 与 chat 的 ERROR 日志都带上渠道/模型/耗时/设备，渠道统计改走 `channel_id` 列。 |
| 2026-09-19 | **第 32 批（峰谷计费 + 定价审计，线上 `bd8b3e0`）**：
  · **调研结论**：全网检索确认**只有 DeepSeek 官方按钟点差异定价**（高峰=北京时间周一至周五
  9:00-12:00、14:00-18:00，其余时段含整个周末半价；官方定价页脚注原文）。
  OpenAI/Claude/Gemini/GLM/Kimi/千问/豆包/Grok 均无时段定价，其折扣来自 Batch/服务等级。
  · **缺口**：我们此前**全时段按峰价收费**，闲时请求被系统性多收一倍。
  · **实现**：`model_prices` 新增 4 列（`offpeak_{input,output,cache}_price` + `offpeak_rule` 规则 JSON）；
  `pricing.js` 新增 `isPeakAt/effectivePrice/describeRule` ——
  判定用**固定 UTC 偏移**而非 Intl/timeZone（中国无夏令时，不依赖 ICU，跨平台一致）、
  支持跨零点窗口（阿里百炼托管的 DeepSeek 是每天 22:00-08:00 闲时，窗口与官方不同）、
  `effectivePrice` 返回**新对象**（`getPrice` 返回 30s 缓存里的同一引用，就地改会污染整批请求）。
  · **计费按「请求发起时刻」判档**（而非结算时刻）：11:59 发起 / 12:01 结束的请求应按峰价。
  · 两个计费点（网关 `settle`、站内对话 `chargeUser`）都接上；日志 detail 补
  `price_phase/priced_at/rate/amount_units`，`logs` 新增 `price_phase` 列，事后可复核复算。
  · 定价 CRUD 全部同步（列表/手动保存/CSV+JSON 导入/同步官方价目）—— 漏掉 `sync-defaults`
  会把新列的谷价清空，这是最容易漏的一处。
  · 顺带修复：`harness/loop.js` 引用未定义的 `stepStartAt`/`firstTokenAt`（会抛 ReferenceError）。
  · 测试：`tests/pricing-offpeak.test.mjs`（峰/谷/周末/跨零点边界 + 缓存对象不被污染）。 |
| 2026-09-19 | **第 33 批（十轮渠道审查 → 逐轮修复，线上 `f4050b8`）**：
  按要求「审查十次、每次修完再审」，分十路并行审查（数据一致性/R1、前端与权限/R2、
  额度与找回/R3、计费正确性/R4、网关调度/R5、数据层与迁移/R6、鉴权与安全/R7、
  适配器与解析器/R8、前端质量/R9、回归验证/R10），**共修 1 个 P0 + 16 个 P1 + 30 余个 P2**。
  · **P0（全站白屏）**：`MainLayout` 引用 `HistoryOutlined` 未导入 —— 该图标在模块顶层常量
  `NAV_USER` 里，模块求值即抛 ReferenceError，会让整个 SPA（含公开首页与登录页）白屏。
  已补导入，并写了全量扫描脚本核对所有 JSX 未定义引用（其余为 SVG/模板字符串误报）。
  · **P1 计费**：`kimi-k2` 已注册但无定价行 → 落到「同厂商最贵档」按 k3 旗舰价计费（多收约 3 倍），
  补官方价；并新增一层「同族兜底」（请求名是某已配价模型名的前缀时取最贴近的，
  `kimi-k2 → kimi-k2.6`），比直接跳到旗舰准得多。
  · **P1 计费**：`pct()` 用「<=1 就当比例」的启发式与调用处口径冲突 ——
  Antigravity 剩余 99.5% 被显示成已用 50%、Kiro 1/1000 被显示成 10%（差 100 倍）；
  拆成 `pctFromFraction`/`pctFromPercent` 并逐处对齐上游口径。
  · **P1 调度**：`execute.js` 两段超时存在**定时器泄漏** —— backstop 先触发后，
  排队任务稍后才执行并 `armDeadline()`，那个 hardTimer 在 finally 之后创建、无人清理，
  会空转一整个 timeoutMs 并再次 abort；且排队期间被判定超时时仍会真的发一次上游请求。
  引入 `settled` 标志彻底封住。
  · **P1 安全**：Kiro 的 `region` 来自外部凭据文件且直接拼进主机名 ——
  `region="@127.0.0.1:8080/"` 会把带 Bearer 令牌的请求打到内网（**SSRF + 令牌外泄**）。
  抽出 `safeRegion()` 白名单，**读取路径（chat/refresh/quota）也过一遍**（只校验导入挡不住存量脏值）。
  · **P1 安全**：`.admin-password`（首次启动生成的管理员随机密码）没被 gitignore，
  一次 `git add -A` 就会把 root 凭据提交进仓库。
  · **P1 越权**：批量删除会话先删会话再按**请求里的 ids** 删消息 —— 第一条命中 0 行时
  （id 不属于该用户）仍会删掉别人会话的全部消息；改为先查归属再删。
  · **P1 迁移**：`migrate()` 的任何 DDL 失败都会让 bootstrap 抛出 → `process.exit(1)`，
  配合 `Restart=always` 变成三秒一次的重启死循环（站点全挂且不自愈）；改为失败只记日志继续
  （补列幂等，下次重试），并加 `lock_wait_timeout=20` 防大表等 MDL 卡死启动；
  同表缺列合并成一条 ALTER（避免 MySQL 5.7 上逐列重建整表）。
  · **P1 凭据竞态**：凭据写回与适配器异步刷新会互相覆盖 —— 刷新写回「重读 latest → 合并 → 整列 UPDATE」
  若发生在人工换凭据之后，会把旧 token 覆盖回来（提示已更新、实际还是旧账号）。
  引入 `other.cred_epoch` 代次：写回时 +1，六个适配器的刷新写回带上发起时代次，不一致即丢弃。
  · **P1 找回断链**：`kind=paste` 的找回会话写不回渠道（DeepSeek/Kimi 抓取到 token 后
  只回填「添加渠道」表单）；补 targetId 写回分支，并给 `applyCredentialToChannel` 加 relay 兜底
  （这类适配器没有 `importAuth`，凭据契约就是 token + cookies）。
  · **P1 口径**：使用记录页选「全部」时表格全量、汇总卡近 30 天、筛选候选近 365 天（三处不一致）；
  统一为显式 `days=0`。`/log/usage` 裸调 API 原本无时间上界（全表 COUNT）→ 默认 30 天。
  · **P1 计费**：`allTime` 只按 `channel_id` 列聚合，老记录（detail 里才有渠道）被漏算，
  会出现「累计调用 < 近 30 天」。
  · **P2 批次（摘要）**：错误消息泄露渠道名（通常是账号邮箱）→ 改为只回编号/数量；
  缓存命中率分母重复计算（`prompt_tokens` 已含缓存）；导入路径闲时价 null→0 会变成 1 厘/次；
  deepseek 余额接口域名改精确匹配（子串匹配会让 `api.deepseek.com.evil.io` 收到该渠道 Key）；
  `channels.quota` TEXT 溢出保护；`logs` 老记录 token 回填因 `??` 失效；
  召回冷门模型的厂商表空窗改 stale-while-revalidate；`sawOutput` 路径冷却硬编码 300s 压平 WAF 6h →
  抽 `cooldownFor` 共用；`StatCard` 的 `hint` 属性不存在导致底部说明被吞；列宽和 > scroll.x
  导致 ellipsis 列被压成 0 宽；金额单位重复（`OD币 OD币`）；表格行无键盘入口；
  批量操作无二次确认与防重入；`units_per_od` 硬编码回落值；冗余单列索引清理；
  9 个未使用导入；新增 `tests/static-check.mjs`（72 文件语法 + 跨文件导入导出一致性）与 `npm test`。
  · **验证**：十轮复查确认**无已知 P0/P1**；线上部署 `f4050b8`，服务 active、`/api/status` 200、
  `npm test` 全绿（static-check / device-ua / pricing-offpeak）。 |
| 2026-09-19 | **第 34 批（渠道/分组/设置/额度重构 + 运维监控 + 告警引擎，线上 `e239d8b`）**：
  按用户逐条反馈重构前端与补齐运维能力，分 10 个提交，见下。 |
| 2026-09-19 | 第 34 批 · 1~2：**渠道列表**模型列改为展示真实模型（从上游接口拉取，不再写「OpenAI 全部」）；
  额度列移到模型列之后、去掉操作栏的「查额度」按钮（改点列内「点此查询」）；
  额度展示重做成 sub2api 风格（`[5h] ▓▓▓░░ 62%`，窗口标签从接口的 `limit_window_seconds` 推导，
  不硬编码）；**分组**支持多选渠道/指定厂商 + 折叠图标 + 从已选渠道汇总模型 + 全选/清空；
  **使用记录** 6 张大卡改为紧凑标签条 + 可展开的图表分析（`UsageAnalysis`）。 |
| 2026-09-19 | 第 34 批 · 3：**系统设置**重构为配置驱动（单一 `F` 字段定义对象驱动表单/布尔归一/数值校验），
  共 9 个页签约 90 项设置；**删除「模型列表」页签**（模型来源已改为「分组 ∩ 渠道声明」，该设置无任何逻辑）；
  顺带修复两个历史 bug：清空字段现在能真正保存空值、布尔项正确归一。 |
| 2026-09-19 | 第 34 批 · 4：**账号级运行参数**（并发数 / 最小间隔 / 每分钟上限 / 指纹收敛 / 上下文计费 / namespace）；
  `rateOf()` 读账号级覆盖，`withChannelLimit` 支持 concurrency > 1（信号量）与 = 1（串行链）；
  **用户默认并发/RPM/TPM** 落到注册与新建用户。 |
| 2026-09-19 | 第 34 批 · 5：**运维监控页**首版（系统资源 / 网关运行时 / 平台概览 / 排行榜），
  `services/metrics.js` 零依赖采集 + `routes/monitor.js` 快照接口。 |
| 2026-09-19 | 第 34 批 · 6：**对标 sub2api `/admin/ops` 补齐并超越**（先调研其源码拿到完整能力清单）。
  · metrics 新增：TTFT 分位（只在流式可测，独立于总延迟）、SLA（排除业务限制）、
  上游错误率（排除 429/529 并单列计数）、按用户/厂商维度、分钟桶 QPS/TPS 趋势、
  账号切换率、进程级 CPU（区分「机器忙」与「Node 卡」）、事件循环利用率、活动句柄、
  Buffer 泄漏信号（`external/arrayBuffers` 占比）、延迟直方图、HTTP 状态码分布。
  · `services/alert.js` **告警规则引擎**：窗口/持续/冷却/静默四要素 + 12 条内置规则；
  静默支持全局维护窗口；事件落库时附带触发瞬间的指标快照（sub2api 只存事件本身），事后可复盘。
  · `services/notify.js` **通知通道**：自研 SMTP（net/tls 手写 EHLO→STARTTLS→AUTH→DATA，
  不引 nodemailer）+ **Webhook（飞书/钉钉/企业微信/Slack 自动识别与加签）——sub2api 只有邮件**。
  · `routes/monitor.js`：快照 / **SSE 实时推送**（比它的 WebSocket 更轻、浏览器原生自动重连）/
  规则 CRUD / 事件流 / 维护窗口 / 通道测试 / 清理。
  · 前端：健康分 + **智能诊断（现象/影响/建议三段式）** + 延迟直方图 + 状态码分布 +
  并发队列表（按账号/厂商/模型切换）+ **告警中心（规则与事件内嵌在页面内，sub2api 放弹窗）**。
  · `components/Charts.jsx`：**全站图表规范唯一入口**（折线/柱状/排行/迷你线 + 固定配色），
  规范写入本文档 2.5；指标口径写入 2.6。 |
| 2026-09-19 | 第 34 批 · 7~10：**线上实测暴露并修复 3 个只有真请求才会暴露的缺陷**。
  · `routes/monitor.js` 数据表体积查询误用 `const [[tbl]]` 把多行结果解成第一行 →
  `overview.tables` 不是数组、`tbl.map` 抛 TypeError 使整个快照 **500**（语法检查完全看不出）。
  修复并新增 **HTTP 级冒烟测试** `tests/monitor-smoke.mjs`（19 项：鉴权/快照字段/趋势桶/
  overview 结构/渠道运行时/健康分诊断/告警 CRUD/静默开关/SSE 首帧），显式断言该字段是数组防回归。
  · 告警清理接口 `Number(x) || 30` 把显式传入的 `days=0` 当成「没传」而回退 30 ——
  本该拒绝的「清空全部历史」变成「删 30 天前的数据」，保护性判断形同虚设；改为显式校验。
  · **健康分与诊断自相矛盾**：2 个请求全失败时健康分显示 100/idle，同页诊断却报 4 条 critical。
  原因是 `hasTraffic` 只看 `requests >= 10`，业务分被跳过只剩基础设施分（机器确实健康）。
  改为 `requests >= 3 || errors > 0` —— 失败本身就是有效信号。
  · 另修：**告警窗口指标真正生效**——此前所有规则共用一个「进程累计」值，`window_min` 是摆设；
  改为按规则各自的窗口从分钟桶真实聚合（`windowStats`），率类指标无样本返回 `null`
  （返回 0% 会让「错误率 > 5%」的规则安静地不触发，是最危险的失效方式）。
  · 验证：`tests/metrics-alert.test.mjs` 24 项 + `tests/monitor-smoke.mjs` 19 项全绿；
  线上用临时密钥实发 2 个极小请求，确认指标链路真实可用（厂商归属 `openai×2`、换号 4 次、
  分位/状态码分布/诊断全部正确填充），测试密钥已清理。 |
| 2026-09-19 | **第 35 批（全链路审查：整条调用链 + 全部反代适配器，线上 `23d7b5d`）**：
  按要求做「整条链路、每个模型调用、反代机制与 API 调用都要审」。
  分六路并行深审（浏览器反代核心 / 订阅型 OAuth 适配器 / 国产网页版反代 / 网关热路径 /
  计费链路 / 站内对话 harness），再由一轮**对抗性复审**专门核查「修复本身是否引入新问题」。
  合计修 9 个 P0 + 10 余个 P1，新增 2 个测试文件 36 项断言。 |
| 2026-09-19 | 第 35 批 · P0 汇总（**多为「设置了不生效」类静默失效**）：
  · **用户并发/RPM/TPM 三个设置项从未被读取** —— 系统设置里能改，实际完全不生效
    （上一批刚给用户加的）。新增 `services/user-limit.js` 实现三维度：并发（硬闸门 429）、
    RPM（60s 滑动窗口）、TPM（请求前按估算预占、结束按真实用量多退少补；不预占则用户可
    瞬间并发打满而全部放行）。
  · **渠道并发参数是空操作** —— `concurrency>1` 分支写成 `gate.then(() => run())` 且 run 内
    await 整个任务，下一个任务要等上一个彻底结束才 resolve，配成 8 也严格串行。
    改为真信号量（等待者队列 + finally 唤醒）。
  · **`retry_times` 是死配置** —— 实际重试次数等于「匹配到的渠道总数」，10 个渠道集体故障时
    单请求最坏挂 100 分钟（客户端早已断开）。
  · **Grok `base_url` 未校验（SSRF + 凭据外泄）** —— 该字段来自管理员粘贴的凭据文件，
    此前只判「非 api.x.ai 就原样采用」，一份指向攻击者主机的凭据就能让后续请求带着
    Bearer access_token 打到任意地址（含云元数据端点）。加 `safeBaseUrl` 白名单
    （仅 xAI 官方两域），导入与读取两条路径都校验（只挡导入挡不住存量脏值）。
  · **PoW 求解失败回退主线程会阻塞事件循环** —— worker 抛的是无 code 的 Error，
    solvePow 据此回退；主线程的 wasm_solve 是同步调用、预言机是纯 JS 同步循环（上限千万次），
    单请求可让事件循环停摆数十秒（期间所有请求与超时定时器失效）。失败改为带
    `CHANNEL_POW_FAILED`（可重试换号），不再回退。
  · **余额不足「扣到 0」= 静默核销** —— 余额 1 单位跑出应收 52800 单位的请求，旧逻辑把
    quota 置 0 等于平台自己一笔勾销（实收 0.0001 OD、净亏 5.28 OD）。改为记账成负数，
    账目真实且下一请求会被余额检查挡掉；站内对话原本还有「余额<=0 直接抛错且完全不扣费」，
    会让已跑完的整轮零计费，一并删除。
  · **闲时价显式 0 落库 = 谷时白嫖** —— CSV/Excel 把闲时列留 0 很常见，`optNum` 只把空串
    转 NULL，显式 0 原样入库被当成「配了闲时价 0」→ 谷时（占一周约 70% 时间）退化成
    1 单位一次，与基准价差上万倍且界面只显示 0 看不出异常。另补反向校验：
    配了闲时价却没规则（闲时价永不生效、用户被多收）一并拒绝。
  · **整轮峰谷价单点判档** —— harness 一轮可跑十几分钟，按「整轮发起时刻」判一次档会让
    跨分界点的用量全按旧档计价（两个方向都是最多 2 倍）。改为按每次调用各自的 `startedAt`
    分别判档再求和。
  · **GLM 档位不一致导致计费错误**（线上实测确认）—— 请求 `glm-5.3`，上游实际跑
    `x-preview-l`；适配器早就在核对并告警，但 `upstreamModel`/`modelMismatch` 在全仓库
    **没有任何消费点**，计费只按请求模型取价。现把真实档位回传并按实际档位计价
    （`getPrice` 新增 `exact` 标志，只在能精确解析时采用，避免未知档位落到兜底高价）。
    期间曾试过「强制注入模型」让请求档位生效，**线上实测会直接被上游拒绝**
    （「当前用户无法使用此模型」）—— 账号套餐能用哪些档位只有页面自己知道，
    已回退为默认不注入并把该错误映射成不可重试的 `CHANNEL_BAD_REQUEST` + 可执行提示。 |
| 2026-09-19 | 第 35 批 · P1 汇总：
  · **用量归一化按「值>0」判定**（而非「字段存在」）—— 只回 `output_tokens` 时旧逻辑把缺失的
    prompt 当 0 且 `hasDetail=true` → 整段输入不计费；反过来，只回 `total_tokens` 经
    openai-compat 的 `pickUsage` 补成 `{prompt:0,completion:0,total:N}` 又会判成精确明细 →
    整单只剩 1 单位兜底价。两种坑都由同一条规则避开（见 2.6 新增条款）。
  · glm/qwen/doubao 的 parser 原本用白名单重建 usage，丢掉缓存命中字段 →
    缓存部分按全额输入价计费（多收）。改为整体透传。
  · 无法判定厂商时（custom/中转渠道的自定义模型名）原本退回 DeepSeek 最低档，
    比真实成本低约 20 倍；改为「全表最贵档」兜底。
  · **`withRefreshLock` 的加入方拿不到刷新结果** —— 返回值被丢弃，并发时用旧 token 撞 401，
    三方以上时完全不重试、直接把 401 抛给上层 → 6 小时冷却 + 误报「需要重新登录」。
    现在加入方也会拿到结果并同步 `channel.other`。
  · **probe / 兜底 chat 无超时** —— 上游返回 200 后 SSE 不结束会一直占着渠道串行槽，
    后续真实请求全部排队。加 90s 探针预算。
  · **`/v1/models` 漏掉 `models="*"` 的渠道**（能调用但列表里看不到）。
  · **长会话只取「最早 200 条」消息**（`ORDER BY seq ASC LIMIT`）→ 界面看不到最近内容，
    更严重的是同一份历史喂给模型导致答非所问。改为取最近 N 条并反转为升序。
  · **失败的那一步完全不计费** —— 它不进 runCalls，而它的 prompt 往往是整轮最长的上下文。
    现在由 loop.js 把失败步的 prompt 与时刻挂在错误对象上，失败结算按估算补齐；
    并用 `upstreamStarted` 区分「真的打到上游」与「还没开始就失败」（后者不该计费）。
  · 反代链路：**页面死亡不自愈**（渲染进程崩溃后 context 仍活，`s.page` 已是死对象，
    该渠道会持续失败到 15 分钟看门狗）→ 判定存活并复用浏览器只重建页面；
    **客户端取消不能停下上游** → `withLock` 接受 signal、`streamCapture` 主动设置页面 hook 的
    stop 标志；**submit 可能重复发送同一条 prompt**（旧实现会继续点其余候选再按 Enter，
    单请求最多几十次）→ 点过一次就不再点别的候选 + 用输入框是否清空做二次确认；
    **看门狗与新会话抢 profile 目录**（`ctx.close()` fire-and-forget 就允许重建，
    旧进程还持有单例锁时新启动必然失败）→ 先摘除会话再等关闭收尾。
  · 网关速度：图片外链改并发抓取（3 张各 800ms 从串行 2.4s 降到 0.8s）、
    结算的两条 tokens UPDATE 合并并与写日志 `Promise.all`、
    `markChannelOk` 改为不 await（渠道统计与响应内容无关）。 |
| 2026-09-19 | 第 35 批 · **对抗性复审（专查修复本身引入的问题）**，发现并修掉 2 个 P0 + 2 个 P1：
  · **P0：`normalizeUsage` 的新语义造成静默零计费** —— 我原本按「字段是否存在」判定，
    而 `pickUsage` 会把缺失字段补成 0，于是「只回 total_tokens」的上游变成
    `{prompt:0,completion:0,total:N}` → 判成精确明细 → `splitTokens` 返回 0/0/0 →
    只剩 1 单位兜底价。这是本批唯一「直接资损且静默」的问题，改为按「值>0」判定。
  · **P0：信号量没拦住 min_gap 窗口** —— 名额是「等完 min_gap」之后才 ++ 的，
    窗口内到达的请求全部看到 `inflight=0` 而放行，实测 `concurrency=2` 被突破到 5，
    且它们在同一毫秒齐发（正是要避免的脚本特征）。改为在准入时同步占名额。
  · **P1：管理端扣款会把欠费一笔勾销** —— `user.js` 的 `GREATEST(0, quota + ?)` 在
    quota 恒非负时只是保护，引入负数后语义反转成「债务核销」，正好抵消本批要修的静默核销。
  · **P1：站内对话首步失败仍零计费** —— 门槛没带 `failedCall.prompt`，且那行 prompt 补估算
    「需要时不执行、执行了被丢弃」。
  · 教训（已写入 2.6）：**「字段存在」不等于「有数据」**；
    **并发闸门的占位必须与准入同一时刻，不能晚于任何 await**。 |
| 2026-09-19 | 第 35 批 · 新增测试与验证方式：
  · `tests/review-fixes.test.mjs`（27 项）：用量归一化的四种输入形态、缓存字段识别、
    计费公式下限、用户限流三维度与释放幂等、`setting` 字符串形态与「只能收紧」语义。
  · `tests/concurrency-gate.test.mjs`（9 项，**用真实计时**）：并发上限在 min_gap 窗口内也成立、
    串行语义、异常不泄漏名额、rejection 正确回传、并发确实比串行快
    （最后一条能直接发现「并发参数是空操作」的回归，静态检查与普通单测都发现不了）。
  · `tests/ui-smoke.mjs`（14 个路由，见下条事故）：真实浏览器逐页断言「有渲染内容 + 无运行期错误」。
  · 线上验收：用户限流实测 5 个并发请求返回 4 个 429（此前完全不生效）；
    GLM 反代真实探测成功并正确报出档位不一致；`users.quota` 为 signed bigint
    （欠费记账成立）；合并后的 tokens UPDATE 在真实表结构上空跑验证语法。
  · 未验证：SMTP/Webhook 真实投递、Claude `utilization` 口径、Kimi/DeepSeek 网页版
    usage 字段语义 —— 均需真实账号与抓包样本，已登记待办。 |
| 2026-09-19 | **线上事故 · 渠道管理页整页白屏（TDZ），用户报「打不开」**。
  我此前只跑了 `vite build`（成功）就宣布可用，**没有真在浏览器里打开页面**，
  实际 `/admin/channel` 一进去就白屏。
  · 现象：整页空白，控制台 `Cannot access 'X' before initialization`（生产 bundle 里是 `wC`）。
  · 定位方式（值得复用）：用 `vite build --sourcemap` 产出带 sourcemap 的包 →
    临时静态服务伺服并把 `/api` 反代到真实后端 → 无头浏览器打开 → 手写 VLQ 解码
    把报错位置还原到源码 → 定位到 `AdminChannelsPage.jsx:1587`。
  · 根因：`const columns = [ ... {upstreamModelsBusy ? <Spin/> : <Tooltip>…} ... ]` 是
    **数组字面量，创建时立即求值**，而 `const [upstreamModelsBusy] = useState(false)`
    写在 370 行之后 —— `const` 的暂时性死区，必然抛 ReferenceError。
    把三个声明上移到 `columns` 之前（并留注释说明顺序不能动）。
  · 为什么构建没发现：TDZ 是运行期语义，`vite build` 不做这种顺序检查。
    这与第 33 批的 `HistoryOutlined` 全站白屏是**同一性质**的两次事故。
  · 对策：新增 `tests/ui-smoke.mjs`，并把「前端改动必须跑真实浏览器逐页检查」
    写成第 4 节工作流的**强制项**（不再是「有环境时」）。 |
| 2026-09-19 | **线上缺陷 · 监控页 SSE 永远 401**（UI 冒烟逐页扫描时发现）。
  `/admin/monitor` 控制台一直报 `401 /api/monitor/stream` —— 实时推送从未成功过，
  页面靠 15s 轮询兜底，所以没人察觉（功能「看起来正常」）。
  根因：浏览器原生 `EventSource` **不能自定义请求头**，带不了 `Authorization`，
  而该接口挂在 `adminRequired` 后面，必然 401。
  修法：新增 `POST /api/monitor/stream-ticket`（走正常鉴权）换一次性短票据，
  60 秒有效、**用一次即废**、仅对这一个接口有意义；`/stream` 自行校验票据并复查
  用户仍是管理员。**没有**采用「把 JWT 拼进 URL」——完整 JWT 有效期 30 天且等同
  全站通行证，进访问日志/浏览器历史就是长期风险。
  前端配合：票据一次性 → `EventSource` 自动重连必然失败 → `onerror` 主动换新票据重建。
  同时给 monitor 路由加了鉴权守卫豁免机制（`/stream`、`/stream-ticket` 跳过全局
  `adminRequired`，各自内部校验）。monitor-smoke 的 SSE 用例升级为三条断言
  （无票据 401 / 有票据能连并收到首帧 / 票据复用必须失败）。 |
| 2026-09-19 | 第 35 批（全链路审查）：**整条调用链 + 全部反代适配器**的审查与修复，
  线上 `ee03b57`。六路并行深审（浏览器反代核心 / 订阅型 OAuth / 国产网页反代 /
  网关热路径 / 计费链路 / 对话 harness）+ 一轮**对抗性复审**专查「修复本身是否引入新问题」，
  合计修 9 个 P0 + 10 余个 P1 + 2 个白屏/401 线上缺陷；测试增至 5 套。
  详见下方分条记录。 |
| 2026-09-19 | **第 36 批 · P0：订阅渠道 token 刷新静默失效（我在第 35 批引入）**，线上 `a8b5b84`。
  现象：Codex / Gemini / Claude / Grok / Kiro 全部 401，日志只有一句
  「提前刷新失败（继续用现有 token）：fn is not a function」。
  根因：`withRefreshLock` 签名是 `(channelId, fn, channel)`，我改「加入方同步」时
  在 6 个适配器里全写成 `(channel.id, channel, async () => {})` —— channel 被当成 fn。
  后果不是报错而是**静默失效**：fn 收到对象 → 抛 not a function → 被调用方的
  `.catch()` 吞掉 → token 过期后永远刷不回来 → 全体订阅渠道 401，
  且现象完全看不出是参数顺序问题（本次排查耗时最久的一处）。
  修法三重：参数归一化（接对象就自己取 id，推荐写法 `(channel, fn)`）、
  类型守卫（fn 不是函数立刻抛 TypeError）、6 个调用点统一。
  新增 `tests/refresh-lock.test.mjs`（7 项）。
  教训：**被 catch 吞掉的类型错误比崩溃更难发现** —— 公共函数的参数守卫要写在
  函数内部，不能指望调用方；「继续用现有 token」这类静默降级文案会掩盖真实故障。 |
| 2026-09-19 | 第 36 批 · **P0：Antigravity 刷新缺凭据（登录有兜底、刷新没有）**。
  `oauth-login.js` 的 Google 客户端凭据有内置公开凭据兜底，而 `antigravity.js`
  直接读 `process.env` 且无兜底 → 「用内置凭据成功登录的渠道，刷新时必然报未配置」。
  抽出 `googleClientCreds()` 供登录与刷新共用（refresh_token 与 client 绑定，
  两套混用必被 Google 拒）。
  线上验证链路：`fn is not a function` → 「未配置 GOOGLE_OAUTH_CLIENT_ID/SECRET」
  → 修复后消失 → 暴露真实原因（该渠道 refresh_token 是另一套 client 签发的，
  需重新登录一次，属凭据问题），已登记待办。 |
| 2026-09-19 | 第 36 批 · **分组支持跨厂商**（用户两次指出）。
  用户要求「分组可包含多个渠道，**或者**指定哪个厂商」，厂商只是可选筛选；
  我此前实现成强制维度（`type` NOT NULL + 联合唯一键 + 成员同步 `WHERE type=?`），
  管理员必须先选厂商、且只能勾同厂商账号。
  后端：列改名 `type`→`vendor`、唯一键改 `(name)`（分组名全局唯一）、
  成员同步去厂商过滤、`channelInGroup`/`groupConfigOf` 兼容历史前缀绑定、
  迁移幂等（重名改名 + 同步传播到渠道与 Key，避免跨厂商静默串组）。
  前端：厂商改为可清空的「厂商筛选」（只影响候选视图）、账号可跨厂商多选、
  列表图标按**实际成员**的厂商显示折叠态（全 openai 就是 openai 图标）。
  对抗性复审又查出并修掉**我自己引入的 3 个 P0**：
  ① `TokenPage` 仍拼 `type:name` → 写入 `vip:vip`，路由恰好能用但改名/删组匹配不上
    → Key 永久 503（改为纯分组名绑定 + 解析式兼容旧值）；
  ② 迁移改名不更新 `channels.group_list`/`tokens.group_name` → 静默串组、按错倍率计费；
  ③ 改名目标可能撞已有名字或超长被 slice 截断 → 唯一键永远建不起来且每次启动重试。
  另修 4 个 P1（渠道页分组下拉仍按厂商过滤、用可变的 vendor 反推历史前缀、
  分组名含冒号被误剥、删组日志字段失效）与 2 个 P2。
  新增 `tests/groups.test.mjs`（12 项）。 |
| 2026-09-19 | 第 36 批 · **测试自身缺陷**：`groups.test.mjs` 打印「0 通过 / 0 失败」。
  `t()` 改成 async 后没 await 每个调用，断言还在跑计数就打印了，
  且 `process.exit(0)` 会在断言完成前结束进程 —— 真失败也会被吞掉。已补 12 处 await。
  **「0 通过 / 0 失败」应视为异常信号**（一条断言都没统计到），不是「没有测试」。
  已排查其余测试文件：concurrency-gate(9)/refresh-lock(7) 均已正确 await。 |
| 2026-09-19 | 第 36 批 · **媒体库基础层**（用户要求的大模块之一，也是头像/社区帖图的前提）。
  要解决的真实问题：对话图片此前是把 base64 **直接写进 `chat_messages.parts`（MEDIUMTEXT）**——
  20MB 请求体下 3 张图就能产出 ~16.9MB 的 parts，超过 16,777,215 字节上限；
  严格模式 INSERT 失败（整轮对话落库失败、用户消息丢失），非严格模式截断 → 历史消息**静默变空**。
  另有两个衍生问题：每轮对话都要把 base64 全量读出来 `JSON.parse`（读放大）；
  用户头像与社区帖图无处可放。
  实现（内容寻址 + 元数据行 + 引用表，零新增依赖）：
  `services/media.js`（sha256 寻址、两级分片落盘、免依赖文件头嗅探、图片宽高解析、
  HMAC 读取签名、配额、引用绑定/解绑/重算、回收）、`routes/media.js` 12 个端点、
  `media`/`media_refs` 两张表、`users` 加 `avatar_media_id/bio/website/location`、
  6 个媒体设置项（均有消费方）、6 小时回收任务、`userToResponse` 下发 `avatar_url`、
  `UserAvatar` 优先用真实头像（加载失败回退首字母色块）。
  安全要点：类型按**文件头**判定；**SVG 刻意不在白名单**（可内嵌脚本，
  从本站源 inline 即存储型 XSS，落为 file 类型并强制附件下载）；
  非图片一律 `Content-Disposition: attachment` + `nosniff`；
  读取走签名 URL（`<img>` 带不了 Authorization）；物理删前跨用户查重。
  新增 `tests/media.test.mjs`（15 项）。
  **注意：对话链路尚未接入**（`chat.js` 仍写 base64），媒体库的价值还没兑现，见待办。 |
| 2026-09-19 | 第 36 批 · **媒体库三个「接口在、功能不可用」缺陷**（自己的端到端验证发现，
  静态检查与单测都查不出，只有真发请求才暴露）：
  ① 带**合法签名**读文件仍 401 —— 顶部 `router.use(preAuthJwt)` 会在所有路由之前
    校验 Authorization，匿名请求进不到处理器。与监控页 SSE 401 同一类错误。
    改为按端点挂新增的 `optionalAuth`（带令牌就认身份、不带按匿名继续）。
  ② `DELETE /avatar` 被 `DELETE /:id` 抢先匹配（id 变成字符串 `"avatar"`）→ 永远 404。
    修法：公共端点与 `/avatar` 写操作全部注册在 `/:id` **之前**（Express 的 `/:id` 是贪婪匹配）。
  ③ 第一次修 ①② 时**只改了一处、没跑验证就提交**，重新端到端仍然失败；
    第二次才定位到真正原因（preAuthJwt 仍在最顶部）并补齐重复路由清理。
  教训：**改动鉴权行为必须真发一次匿名请求验证**，不能只看代码改对了就认为生效；
  Express 路由顺序错误表现为「接口存在但 404」，语法检查完全查不出。 |
| 2026-09-19 | 第 36 批 · **媒体库接入对话链路**（媒体库真正的价值所在 —— 只建库不接入等于问题还在）。
  改造：
  · 图片 part 改为只存 `media_id`，渲染时由 `getSessionMessages` 现补签名 URL；
  · 兼容旧前端：仍接受 `dataUrl`，但会**先存媒体库**再走同一条路，所以新数据一定是 `media_id`；
  · 旧消息里的内联 dataURL 原样保留（前端对两种情况都用 `part.url` 渲染，无需区分）；
  · 用户消息落库后立即绑定 `media_refs`（`refType=chat_message`）；
  · 删除链路全部接上引用释放：删单会话 / 回退重生成 / 批量删会话 / 删除用户。
    **注意顺序**：必须「先收集消息 id 再删消息行」，否则删完就查不到 id，
    图片会永远停在「被引用」状态（既回收不了、用户也删不掉）；
  · 存媒体库失败时回退为内存透传（不让用户因存储故障发不出消息），
    这类图片不写进历史，避免留下坏引用。
  线上验证（端到端脚本）：
  · 落库 parts **92 字节**（同一张图以前要存 6000+ 字节 base64），无 `data:image`；
  · 引用计数 1 → 删除会话后归 0（释放链路正确）；
  · 签名 URL 读取 200。
  **至此 MEDIUMTEXT 溢出风险消除**：以前 3 张图就能让整轮对话落库失败或历史静默变空。 |
| 2026-09-19 | 第 36 批 · **用户个人信息（头像 + 资料字段）**。
  前端新增 `components/AvatarUploader.jsx`：纯 Canvas 裁剪（零新增依赖）——
  圆形预览 + 缩放滑杆调取景、EXIF 方向修正（手机竖拍照片不加会躺着；
  `createImageBitmap({imageOrientation:"from-image"})` 支持则用，否则回退 `<img>`）、
  输出压到 ≤512×512 JPEG q0.9（12MB 手机原图 → 几十 KB）、
  透明背景填白（JPEG 不支持透明，不填会成黑块）。
  `ProfilePage` 个人信息页加头像区与简介/链接/所在地字段；
  `PUT /users/self` 接受并落库（按列宽截断）。
  说明：`website` 只做长度截断不做协议校验 —— 它是纯展示文本，
  XSS 防线在渲染层（Markdown 的 `safeHref` 白名单），不在存储层。
  线上验证：资料三字段落库并回传、头像上传→公开读取 200→移除后 404 正确（前端回退首字母色块）。 |
| 2026-09-20 | 第 36 批 · **前端媒体库页面**（后端 12 个端点早已就绪，缺的只是 UI —— 用户看不见也管不了自己的文件）。
  新增 `pages/MediaPage.jsx`：
  · 宫格（缩略图）/列表双视图，**两者共用同一次请求**（切换视图不该发请求）；
  · 汇总卡片 + 配额进度条，用量分档配色沿用 `<70 绿 / 70-90 橙 / >90 红`（与渠道额度条同一套）；
  · 详情抽屉（完整元信息 + SHA256 + 下载/重命名）、重命名、下载（走 `?download=1` 强制附件）；
  · 管理员可用 `?user_id=` 切到指定用户，**URL 是唯一事实来源**（支持直链、刷新、分享复现），
    额外给「强制删除」与手动「回收」入口；普通用户看不到这些；
  · **删除按钮在引用数 > 0 时仍可点**：引用保护由后端裁决（返回「仍被 N 处引用」），
    前端自己禁用会让用户以为是坏了，且看不到被谁引用；
  · 导航「账户」组加入口 + `App.jsx` 路由 + `api.js` 补 `PATCH`（重命名需要）；
  · `ui-smoke.mjs` 增加 `/media` 路由断言。
  线上验证（真实浏览器）：15 个路由全部正常渲染（含新增 `/media`，渲染 52983 字节、无运行期错误）；
  宫格/列表/详情抽屉/管理员 `?user_id` 视图逐一断言，`/api/media` 全部 200。
  **顺带修掉一个自己发现的缺陷**（见下条）。 |
| 2026-09-20 | 第 36 批 · **修媒体库统计在「指定用户」视图下漏发保留策略字段**。
  `/media/stats` 只在 `scope=all` 分支返回 `orphanHours`/`retentionDays`，
  `self`/`user` 两个分支漏了 —— 管理员切到 `?user_id=` 时页面把保留策略显示成
  「— 天 / 不自动回收」，看着像配置丢了，其实是字段没下发。
  这两个值是全站设置、与 scope 无关，三个分支都应返回。
  **是端到端验证发现的**：静态检查、单测、`vite build` 全绿都看不出
  （接口 200、结构「看起来」正常，只有把页面真打开对着数据看才暴露）。
  补 3 条接口冒烟断言（`monitor-smoke.mjs`）：三个 scope 的必需字段齐全、
  列表分页结构与归属校验、签名 URL 可匿名读取（`<img>` 带不了 Authorization 的前提）。 |
| 2026-09-20 | 第 36 批 · **对话图片改为先传媒体库再发 id**（清掉第 36 批「前端仍发 dataUrl」欠账）。
  后端上一批就支持 `images[].mediaId`，前端没跟上：每张图要走
  「浏览器 base64 → 20MB 请求体 → 服务端解码 → 再存媒体库」，大图纯粹是浪费。
  · `pickImages` 读成 dataUrl 后立即 `POST /api/media`，拿到 media_id 与签名 url；
  · 发送带 `mediaId`；本地立即渲染用签名 url；
  · **上传失败回退 dataUrl 直传**（后端兼容），不让存储故障变成「发不出消息」。
  **过程中踩了一个自己造成的坑**：`API.post` 用到了 `API` 但 ChatPage 只导入了 `getToken`，
  `ReferenceError` 被回退分支的 `catch` 吞掉 —— 界面一切正常（chip 照常显示、无控制台错误），
  但上传**一次都没发出去**，改造等于白做。`vite build` 与 `static-check.mjs` 都查不出
  （未定义标识符在打包期是合法的全局引用）。**是浏览器脚本抓到的**（断言「选图后应出现
  POST /api/media」）。
  修法：补导入，并在回退分支加 `console.warn` 留痕 —— 这个 catch 会吞掉所有异常
  （含代码写错），静默回退会让真故障看起来像正常工作。
  教训：「构建通过 ≠ 功能生效」在本项目第四次应验；**凡是带 fallback 的分支，
  必须能在日志里看出它被走过**。
  线上验证（真实浏览器 + 载荷断言）：选图后确已发出 `POST /api/media` 并返回 200；
  `/api/chat/run` 请求体为 `images:[{"mediaId":8}]`、**总长 267 字节**
  （base64 直传时是数千字节），无回退告警。
  验证方式：临时建管理员密钥以解除输入区禁用 → 拦截 `/api/chat/run` 并 abort
  （**不调用上游、不产生费用**）→ 用完删除临时密钥。 |

| 2026-09-20 | **第 37 批（一）· 权限分三层 + 管理员细颗粒度设定**。
  `middleware/auth.js` 引入 `ROLE = { USER:1, ADMIN:100, SUPER:1000 }` 与 `superRequired`。
  **不可逆操作收紧到超管**：变更用户角色、停用管理员、清空全部日志、
  基础设施设置（SMTP/告警 Webhook/网关超时/备份）。
  理由：管理员账号是日常运营用的（可能给多人），而上面这些做错是不可逆的 ——
  分层后日常账号被盗或误操作也伤不到系统配置层。另外管理员之间不该能互相夺权
  （否则一个普通管理员可把同伙提权、或把别的管理员降级）。
  `config.js` 新增 `SUPER_OPTIONS` 白名单，`GET /option` 额外下发 `super_only`
  让前端置灰（前端置灰只是体验，后端独立校验才是权限边界）。
  role 只增不减（历史库里的 100 依旧等于管理员）。 |
| 2026-09-20 | **第 37 批（二）· 社区大厅**（`routes/community.js` + 5 张表）。
  话题 / 帖子 / 评论 / 点赞收藏 / 关注，全部含权限与限流。
  三个刻意的设计：
  · **计数用冗余字段**（列表要按热度排序，不能逐帖查子表），并提供
    `POST /admin/recount` 作为漂移修复手段 —— 不假设它永远准确；
  · **点赞/收藏靠唯一键去重**，不先查再插：并发双击只有一个能成，
    撞 `ER_DUP_ENTRY` 当「已赞」正常返回而不是 500；
  · **评论强制扁平二级**（`reply_to_user_id` + parent_id 归一到一级父节点）：
    无限级递归在窄屏会把正文压成细条，而开发者习惯引用回复、极易到 4-5 层。
    缩进恒为 1 级，上下文靠行首 `@谁` 标明。
  另有治理留痕（`deleted_by`）与三级状态（正常/隐藏/已删，隐藏可恢复）。 |
| 2026-09-20 | **第 37 批（三）· 实时聊天**（`routes/chatroom.js` + `services/realtime.js`）。
  单聊/群聊/讨论组三合一，SSE 长连接（沿用监控页的一次性票据自鉴权）。
  · **单聊建成房间**并加 `single_key` 唯一键：否则 A→B 连点两次会建出两个房间、
    双方各看一个，消息永远对不上；
  · **未读数用 `last_read_id` 算**，不维护冗余未读计数（漂移难修）；
  · 消息带 `client_id` 原样回显，供前端**乐观队列**把本地消息「转正」——
    SSE 是单向的（上行仍走 POST），弱网下没有这层会重复插入或红点假消除；
  · 任何房间读写都先过 `memberOf()`：否则知道 room_id 就能读别人私聊。
  `services/realtime.js` 是进程内广播中枢：写失败即摘除连接（否则一直往死连接写）、
  心跳保活、多实例部署需换共享存储（已登记长期待办）。 |
| 2026-09-20 | **第 37 批（四）· Playground 联机对战（6 款游戏）**。
  **用户明确要求去掉单机小游戏**（「2048、贪吃蛇这种没人玩的别搞了」）——
  采纳：单机游戏对平台没有留存价值（没有对手、没有社交）。去掉 2048/贪吃蛇/井字棋，
  改为 6 款真人对战：四子棋、黑白棋、五子棋、西洋跳棋、中国象棋、海战棋。
  架构抽成**游戏引擎**（`services/games/*.js`）：每游戏只实现
  `init/move/view/meta`，路由层不含规则 —— 加新游戏不用动对战 UI 与路由。
  三个关键设计：
  · **服务端权威**：客户端只提交走子意图，合法性/轮次/胜负全由服务端判定。
    不这么做的话改前端就能作弊（棋盘、连子数、胜负都是客户端可改的）；
  · **视图按视角过滤**（`view(state, { side })`）：海战棋据此隐藏对手布阵，
    未打过的格子一律返回「未知」，响应里根本不含对手 fleet 字段；
  · **阶段动作统一入口**（`/action` 支持 move/place/ready/auto），
    海战棋的布阵阶段与其他游戏的直接落子共用一套机制。
  规则实现参考公开开源实现（Connect Four / Reversi 官方规则 / English Draughts /
  Xiangqi / Battleship 标准棋盘），按「不引新依赖」规范自行实现，
  只借鉴规则与边界条件。含强制吃子、连跳、升王、蹩马腿、塞象眼、炮翻山、
  飞将、兵过河等全部细则。
  规则测试 24 项覆盖每款游戏的「合法着法被接受」与「非法着法被拒绝」。 |
| 2026-09-20 | **第 37 批（五）· 个人主页与数据看板**。
  · 个人主页恒为 `/u/:id`（**匿名可达**），靠 `is_self` 切换主操作：
    自己=编辑资料+我的令牌，别人=关注+发私信。错的做法是「自己跳后台、
    别人进主页」—— 那样用户永远无法直觉感知自己的对外形象。
    匿名端点只出公开字段：邮箱、余额、用量、IP 一律不下发（有测试断言）；
  · 看板分**两个独立物理路由**：`/console`（个人）与 `/admin/dashboard`（全站）。
    权限边界靠路由守卫而不是前端 if；关注点也不同（个人看消费与余额，
    管理看渠道延迟与全站吞吐）。
  · 错误统计改查 `type=4` 错误日志 —— logs 表**没有 status 列**，
    拿消费日志数「status<>1」会一条都数不到（静默算成 0 错误）。 |
| 2026-09-20 | **第 37 批（六）· 前端六个页面 + 统计卡与图表按用户反馈重构**。
  UI/UX 方案经用户与 Gemini 评审确认后落地，骨架按「信息组织与交互动线的本质差异」
  分三类（不硬套同一套模板）：
  · **A 类·标准工作台流式**（个人主页/个人看板/外观设置）：通栏卡片 + 原生纵向滚动；
  · **B 类·视口锁定双栏**（消息中心）：高度锁死、左右各自滚动，
    移动端走**路由级主从堆叠**（不用抽屉、不同屏挤双栏）并用 100dvh 规避虚拟键盘遮挡；
  · **C 类·双栏流式阅读**（社区/Playground）：社区「70% 信息流 + 30% 侧栏」、
    宽屏不拉满；游戏用固定长宽比**受控画布**，
    键盘**仅在棋盘获焦时接管**（失焦释放，不劫持翻页）。
  用户反馈的两点重构：
  · **统计卡太占空间** → 全站统一为紧凑形态（数值在上/标签在下，约 58px，
    补充信息走 Tooltip）。旧版三行大卡约 110px，一行 4 张就吃掉首屏 1/6；
  · **使用分析图表太大太丑、只能看一张** → 改为 2 列网格多图并列
    （调用/消费/Token/耗时同屏），新增**模型消费趋势多折线**与
    **7×24 时段热点图**。丑的根源是旧实现用固定 viewBox + width:100%，
    宽屏下文字线宽一起放大 —— 现在用 ResizeObserver 实测宽度做 1:1 映射，
    字号恒定，侧栏折叠/窗口缩放都会触发重绘。
  另按 Gemini 第 10 点补两处：Markdown 代码块一键复制 + 超长折叠（cURL/JSON 是
  复制走用的场景）；看板显式标注「时区 UTC+8（按天重置）」（跨时区核对账单全靠它）。
  外观设置做**即时热注入**：控件 onChange 直接 setProperty 到根样式，
  没有「保存后刷新」；背景只给 4 个受控几何预设（透明度锁 3%~6%、
  颜色绑定 `var(--line)`、内容层始终不透明 `--surface`），
  避免自由壁纸把文字对比度搞死。 |
| 2026-09-20 | **第 37 批（七）· 历史数据迁移 migrate6**。
  把老消息 `parts` 里的内联 base64 转存媒体库（第 36 批接入后新数据不再写 base64，
  但老数据仍在，MEDIUMTEXT 溢出风险未彻底消除）。
  幂等是硬要求（本项目栽过：migrate2 重复除 50 让余额被反复缩小）：
  只处理确实含 base64 的行、「有图片失败就整条不更新」（不更新只是下次重试，
  更新了就是数据丢失）、options 打标只用于看进度。
  配套 11 项测试（造真实老格式数据 → 迁移 → 核对 → 再跑一次验证幂等 → 清理），
  含「同图去重共用 media_id」与「引用已绑定」（不绑定的话这些图会永远停在
  「被引用」状态，既回收不了、用户也删不掉）。 |
| 2026-09-20 | **第 37 批 · 测试与验证方法**（新增 5 个测试文件、本批共 159 项新断言）。
  这一批多次印证「构建通过 ≠ 功能生效」，因此把验证手段固化成可复用的测试：
  · `tests/games.test.mjs`（24 项）：六款游戏规则，合法着法被接受 + 非法被拒绝；
  · `tests/sql-compat.test.mjs`（19 项）：把新模块所有带 GROUP BY/子查询的语句
    打到真实库上，让 MySQL 自己判定合法性（本机若没开 ONLY_FULL_GROUP_BY
    会显式提示「测不出问题」，避免假绿）；
  · `tests/e2e-modules.mjs`（83 项）：社区/聊天/游戏/个人主页/看板/通知/搜索/
    权限分层的完整链路，断言到「数据库里的行变了」这一层；
  · `tests/e2e-games-browser.mjs`（22 项）：真实点击，验证六款游戏渲染、
    落子真实生效并落库、海战棋迷雾不泄露、键盘不劫持；
  · `tests/migrate6.test.mjs`（11 项）。
  线上部署后**全部通过**：23 页渲染正常 + **181 项功能断言全绿**
  （24 游戏规则 + 19 SQL 兼容 + 11 迁移 + 22 接口 + 83 端到端 + 22 游戏浏览器）。
  **这批查出并修掉的真实缺陷**（都不是语法或构建能发现的）：
  ① 游戏排行榜 `GROUP BY` 与 `only_full_group_by` 冲突 → 线上 500；
  ② `chat_rooms.single_key` 列在建表 SQL 里漏了 → 单聊唯一性其实没生效
     （并发点两次会建出两个房间）；
  ③ 消息页高度算漏页头与页面 gap → 容器超出可用空间，底部输入框被推出视野；
  ④ 游戏分享链接没带房间 id → 文案说「把链接给对手」但对方打不开；
  ⑤ 迁移脚本跑完挂住不返回（媒体库模块的定时器/连接池未关，需显式 exit）。
  **另修了 3 处测试自身的假阳性/假阴性**（跳棋与象棋的棋子编码不同却共用判定、
  象「过河」坐标取错、拿格子下标做 JSON 子串匹配导致永远报泄露）——
  教训：断言要对着结构写，不要对着序列化文本做子串匹配。 |
| 2026-09-20 | **第 37 批（九）· 用户指出「丑」之后的版式返工 + 修观战信息泄露**。
  用户看到线上后说「真他妈的丑」。根因是我的验证只做 DOM 断言、
  **从没亲眼看渲染结果** —— 排查时截图发现了五类纯视觉问题：
  ① 统计卡被 `minmax(118px, 1fr)` 在 1880px 下拉成 400px 宽的薄片
     （数字缩左上角、右侧大片空白）→ 改 `minmax(118px, 200px)` + 左对齐；
  ② 图表死写 2 列 → 每张宽 790px 高 132px（宽高比 6:1、折线成平线）
     → 改 `auto-fit, minmax(380px, 1fr)` 自适应列数；
  ③ 主趋势图 `span={2}` 独占 1600px → 改 `full`（跨满整行）/`wide`（跨 2 列）
     两个语义，并在注释里写明适用场景；
  ④ 聊天页右侧整块空白：`style={activeRoomId ? undefined : {display:"none"}}`
     注释写着「移动端隐藏」代码却对所有尺寸生效 → 改 CSS 媒体查询控制；
  ⑤ 余额可用显示「3365587 天」→ 封顶 999 并改文案为「余额充足」。
  另外把**内容区限宽**补上（Gemini 评审里明确要求、我此前只在注释里复述没实现）：
  A 类页面（卡片与图表）1440px 居中，表格页才铺满 ——
  判断标准是「页面主体是表格还是卡片/图表」，不是个人喜好。
  X 轴标签也改为按实测宽度自适应（每标签至少 58~62px，
  空间不足时缩写为 MM-DD），并给右侧留 34px 避免末尾标签溢出卡片。
  **顺带查出一个真实泄露**：海战棋 `view()` 写 `const me = side || 1`，
  `side=0`（观战者）会回退成 1 号玩家视角，把房主完整布阵
  连同「还剩几舰」一起发给观战者 —— 等于观战即开图。
  已改为显式区分对局方与观战，并补了单元测试（含缺省 side 的断言）。
  新增 `tests/shots.mjs`：按 1880×900 把关键页面截图存盘供肉眼审阅 ——
  **这是本次返工的根本教训的工具化**（见 2.7 第 ⑨⑩ 条）。 |
| 2026-09-20 | **第 40 批（一）· 接入四家国产厂商直连**（小米 MiMo / MiniMax / 阶跃星辰 / 火山方舟）。
  四家都是标准 OpenAI 协议，走 `openai-compat`，协议差异集中在 `vendor-quirks.js`：
  · **小米 MiMo**（`api.xiaomimimo.com/v1`）：mimo-v2.5-pro / mimo-v2.5。
    思考模式下官方会忽略 temperature/top_p（属官方行为，平台不干预）。
  · **MiniMax**（`api.minimax.cn/v1`，国际站 `api.minimax.io`）：
    **必须在适配器层强制 `reasoning_split=true`** —— 官方默认为 false 时
    思维链以 `<think>` 标签混在 `content` 里，下游会把思考内容当正文渲染。
    另外把 temperature 裁到 [0,2]（官方对越界**直接报错**而非忽略）、
    移除官方明确忽略的三个 penalty 参数。
  · **阶跃星辰**（`api.stepfun.com/v1`）：`step-3.5-flash-2603` 只接受
    reasoning_effort=low/high（medium 会 400）；无 tools 时剥离 tool_choice
    （官方参数表未列出，避免不确定行为）。
  · **火山方舟**（`ark.cn-beijing.volces.com/api/v3`）：**API Key 鉴权时 model
    直接填模型名，不需要 ep- 接入点 ID**（只有 AK/SK 签名才必须填 Endpoint）。
    关键差异：方舟容量紧张时**会自动降级到别的模型跑**，
    响应 `service_status.model_fallback` 会说明 —— 计费按实际生效模型算，
    不读的话会「按 pro 的价收 lite 的钱」。已接进网关既有的 `billModel` 分支。
  模型 ID 与定价全部取自各家官方文档（2026-09-20 检索），人民币价按全站既有口径
  ÷7.2 折算并在 `remark` 写明来源。
  **刻意不登记已下线模型**：MiMo 的 v2 全系（2026-06-30 弃用）、
  StepFun 的 step-1-*/step-2-mini/step-3（2026-07-08 弃用）—— 登记了就是死链。
  另给火山方舟补别名映射（`doubao-pro` → `doubao-seed-2-0-pro` 等），老渠道简名继续可用。 |
| 2026-09-20 | **第 40 批（二）· 三个反代渠道的一键绑定**（Kiro / WorkBuddy / Qoder）。
  原先这三个渠道只能「手工粘贴凭据」—— 用户得自己找到桌面端登录文件
  （`kiro-auth-token.json` / `workbuddy-desktop.info`）、从里面挑出 token 字段
  再粘进来。对多数用户这是做不到的。
  现在三家都走**设备授权**（无回调、无需公网 HTTPS 回调地址、不依赖宿主机）：
  · **Kiro**：AWS SSO OIDC **官方**设备流（`client/register` → `device_authorization`
    → `token` 轮询）。三个易错点：字段是 **camelCase**（不是标准 OAuth2 的 snake_case）、
    `grantType` 是那个长 URN（`urn:ietf:params:oauth:grant-type:device_code`）、
    「等待授权」是**异常名**（`AuthorizationPendingException`）而不是 HTTP 状态。
    `startUrl` 默认 Builder ID；**region 自动探测**（填错或没填时逐个试候选区，
    每个 region 的 clientId 独立、必须各注册一次）。
  · **WorkBuddy**：腾讯自研的 state + authUrl 轮询（CN/Global 双域）。
    **它不是 RFC 8628 设备码**（无 user_code），且**待授权是 HTTP 200 + 业务 code ≠ 0**
    —— 按 HTTP 状态判会把「等待中」直接判成失败，用户永远等不到成功。
    设备风控头 `X-Device-Token` 由桌面端原生 SDK 产出、**服务端无法生成**，
    因此不承诺这一点（缺失时优雅降级为不注入该头）。
  · **Qoder**：设备授权（PKCE S256）+ 分区分支。**Global 端已发生协议漂移**
    （`client_id`/`machine_id` 从授权 URL 移除，继续带会「Parameter invalid」），
    按 region 分支处理；另有 PAT 粘贴作为兜底。
  **凭据不经过浏览器**：设备授权拿到的是完整账号凭据（含 refresh_token），
  直接回给前端等于让 token 走一遍 HTTP 响应体（会进访问日志与浏览器缓存）。
  所以「已有渠道」由服务端轮询到即写库、响应只回状态；
  「新建渠道」服务端暂存凭据并给一次性 ticket（5 分钟 TTL），前端建完渠道再 claim。
  产出字段与各适配器的 `importAuth` 严格对齐（kiro 的 client_id/client_secret、
  workbuddy 的 user_id/domain、qoder 的 personal_token/endpoint），
  保证走同一条入库链路，不另开旁路。
  测试（新增 30 项，已纳入 `npm test`）：把三家的「响应 → 状态」判定抽成纯函数导出
  （`judgeKiroToken` / `judgeWorkbuddyToken` / `judgeQoderPoll`），
  用真实响应样本验证 —— 真实上游需要 AWS/腾讯/阿里账号、测试环境打不到，
  而这几条分支恰恰最容易写错。 |
| 2026-09-20 | **第 37 批（八）· 补齐遗留：通知中心 / 聊天搜索 / 观战实时 / 房间清理**。
  用户要求「不要欠」，于是把第 37 批自己记的遗留也做掉：
  · **社区通知**（`services/notify-center.js` + `notifications` 表 + `/notifications` 页）：
    评论/回复/点赞/收藏/关注都会提醒。三条要点 —— **不给自己发**
    （否则列表被自己的操作刷屏，是最影响体验又最易漏的一条）、
    **SSE 只加速而以数据库为真相**（关掉页面期间的提醒不丢）、
    每人最多留 200 条 + 定时清理（已读 30 天 / 未读 90 天）。
    与消息中心分开成两个入口：消息是「和某人对话」（双向、有上下文），
    通知是「有人动了你的内容」（单向、看完即清）。
    **实测发现**：通知这块最容易错的不是「能不能收到」而是「该不该发」，
    所以测试里专门断言了「自己的操作不给自己发通知」。
  · **聊天跨会话搜索**（`/chatroom/search`）：只搜自己所在房间（EXISTS 限定），
    SQL 层 LIKE 而不是拉到 Node 过滤；空关键词直接返回（不做全表扫描）。
  · **观战实时推送**：登记观战者（30 分钟 TTL —— 观战只在打开页面期间有效，
    关掉就该停推，否则白推给已离开的人）；每次落子按各自视角推。
  · **游戏房间清理任务**、**背景底纹响应式**（24px 网格在 4K 下像密纱，
    按屏宽三档平铺尺寸，只改尺寸不改透明度）。
  两条**明确不做并写明理由**（保留在待办里）：
  帖子的视频/音频（媒体库类型白名单支持，但上传体积上限与播放器都未验证，
  放开等于给用户一个可能传不上或打不开的入口）；
  进程内实时推送的多实例限制（属部署架构取舍，已双处登记）。
  另把工作区里**并行进行的 UI 紧凑化改动**（管理页/令牌页按钮与表格改 small）
  单独成一个提交并标注来源 —— 不是我做的就不冒领，但也不该让它们停在本地
  （线上从 GitHub 构建，不提交等于永不上线）。 |
| 2026-09-20 | **第 38 批（用户点名）· 小游戏并入社区 + WorkBuddy / Qoder 接入 + Kiro 复核**：
  · **小游戏并入社区**（用户：不要独立的 Playground 页面）：`GamesPage.jsx` 提取为
    `components/GameZone.jsx`，社区页顶部新增板块切换「讨论区 / 小游戏」（`?board=games`）；
    `/games` 改为重定向到 `/community?board=games`；移除侧栏 Playground 菜单项与独立页面文件；
    分享链接 `?room=<id>` 依然有效（自动切到小游戏板块，切换回讨论区会清掉 room 参数）。
  · **WorkBuddy / CodeBuddy（腾讯）反代**：新增 `upstream/workbuddy.js`（凭据解析 + `X-User-Id`/
    `X-Enterprise-Id`/`X-Device-Token` 注入，复用 `openai-compat` —— 腾讯后端 `/v2/chat/completions`
    本身就是标准 OpenAI 协议）+ 厂商/接入方式/模型表/VendorIcon 全套；
    `openai-compat` 新增 `other.extra_headers` 通用注入能力。
    遗留：桌面端刷新端点未公开稳定，token 过期需重新粘贴凭据（不做猜测性刷新）。
  · **Qoder（阿里）接入**：新增 `upstream/qoder.js` —— Qoder 推理协议要求 22 个 Cosy-* 签名头 +
    官方 WASM 加密（服务端不能直连），按社区标准经**本地桥**（qoder2api / qoder-proxy，
    默认 `http://127.0.0.1:8963`）以 OpenAI 协议接入，凭据为 Qoder PAT（`pt-...`）；
    原生直连移植（自定义 Base64 + MD5 签名 + RSA/AES + Cosy 头）已登记为独立待办。
  · **Kiro 复核**：Kiro 适配器（`upstream/kiro.js` + `kiro-auth.js` + `kiro-eventstream.js`）
    与「Anthropic → 反代（Kiro）」接入方式**早已实现并注册**，本轮无需重复添加（用户可能没在
    UI 里注意到它挂在 Anthropic 厂商下）。
  · **官方图标**：新增 `ooapi-web/public/icons/qoder.svg` 与 `workbuddy.svg`（均取自官网 logo）。
  · 待办盘点（本轮开始时的存量，未在本批处理）：第 35 批遗留 10 条、第 34 批遗留 6 条、
    订阅 OAuth 实盘（Claude/Gemini/Grok 待凭据）、新模型定价补录、harness 线上实盘等仍登记在第 3 节。 |
| 2026-09-20 | **第 39 批（三方兼容厂商扩展 + 分组厂商图标折叠态 + 密钥分组显示修复）**：
  · **三方兼容厂商**：新增 **OpenCode Zen** / **OpenRouter** / **硅基流动**（OpenAI 兼容，Key + Base URL）；
    「自定义」升级为通用兼容（**OpenAI 兼容** + **Anthropic 兼容** 两个接入方式）；
    Anthropic 官方 API 方法改走新适配器 `upstream/anthropic-compat.js`
    （标准 `/v1/messages` + `x-api-key` + SSE，与 `claude-oauth` 的 CLI 伪装区分，
    `importAuth`/身份提示词一律不注入）；`router.adapterKeyFor` 改为「接入方式声明的 adapter 优先」，
    这样 anthropic 的 api 走 Anthropic 协议、其余厂商 api 仍走 openai-compat。
  · **分组厂商图标（折叠态，用户要求）**：分组数据（`/channel/groups`、`/token/groups`、`/chat/meta` 的
    密钥项）新增 `vendors`（成员账号厂商去重）；前端新增 `GroupVendorIcons` 组件——
    单厂商显示单个图标、多厂商叠放显示（超出 3 个给 +N），统一用于：令牌下拉与令牌表、
    渠道表分组列、分组管理表、使用记录分组列、对话编排栏密钥菜单。
  · **密钥分组显示 bug**：此前用分组的 `vendor`（建组时的可选筛选）画图标 —— 跨厂商分组只画一个、
    不限厂商时掉到平台 logo；现在一律按成员厂商绘制，并显示清理后的分组名 + 倍率 + 备注
    （历史 `厂商:名称` 前缀统一剥离）。
  · 官方图标：`opencode.png`（官网 favicon）/ `openrouter.svg`（Simple Icons）/ `siliconflow.ico`（官网）。 |
| 2026-09-21 | **第 41 批（一）· 界面问题集中修**（用户逐条指出，全部采纳）。
  · **全站改回全宽**：之前按「表格页铺满 / 卡片图表页限宽 1320px 居中」二分过，
    用户明确要求**所有页面全宽** —— 已移除 `.oo-content--narrow` 与路由判断。
    窄屏适配交给各页面自身的自适应栅格（统计卡单卡上限 200px、
    图表网格 `auto-fit minmax(380px,1fr)` 自动增减列数），不靠外层容器限宽。
  · **分组表格删掉「厂商」列**：图标已经在「分组名」列里（单厂商单图标、
    多厂商叠放 +N），单独一列把同一信息说两遍还白占 150px；
    而且**分组本身不绑定厂商**，那一列在语义上也是错的。
  · **「可用模型」列从「模型名 +N」改成「N 个」**：原先渲染第一个模型名，
    不限模型时该列宽度失控（实测截图确认），改为个数 + 悬浮看明细。
  · **渠道弹窗左右两栏各自独立滚动**：原先只有 `.ant-modal-body` 整体滚动，
    左侧厂商列表会跟着内容滚走，往上填配置时看不到自己选了谁。
    修的过程踩了两个布局坑（见 2.7 第 ⑬ 条）：滚动条要加在**正确的元素**上
    （section 而非内层容器），以及 **grid 行轨道要写 `minmax(0, 1fr)`**。
  · **「自定义（通用兼容）」强制排最后**：在**后端** `publicProviders()` 排序，
    不放前端 —— 前端有多处渲染厂商列表（弹窗 + 筛选下拉），只改一处必然漏。
  · **补齐四家新厂商图标**：之前都掉到平台 logo（显示成一张照片）。
    资源取自各厂商 **GitHub 官方组织头像**（MiniMax-AI / stepfun-ai /
    volcengine / XiaomiMiMo）—— 它们的官网 favicon 取不到（域名不可达或 403）。
    同时补模型名前缀映射，否则 `MiniMax-M3` / `step-*` / `mimo-*` 也掉平台 logo。 |
| 2026-09-21 | **第 41 批（二）· 三家网页版反代**（用户质疑「为什么都是 API 形式」）。
  调研确认三家都有可反代的 C 端网页，难度都不高，全部实现：
  · **小米 MiMo**（`aistudio.xiaomimimo.com`）—— 参考 wtz44/mimo-free-api（86★ MIT）。
    纯 Cookie（`serviceToken`/`userId`/`xiaomichatbot_ph`）+ 标准 SSE，
    **零签名零 PoW**。选网页版而非桌面端：桌面端走 OAuth + `mimo-x-preview`，
    且官方明确该档位只对桌面客户端开放。
  · **MiniMax**（`agent.minimaxi.com`）—— 参考 snake-aabb-wtf/minimaxM3-web2api
    （已完整逆向签名）。`x-signature` + `yy` **都是纯 MD5**（静态密钥硬编码），
    无 PoW/wasm/SM3；指纹参数（参与 yy 计算）由 token 稳定派生 ——
    同一账号必须固定，随机变化是强风控信号。
    **更正**：接入点是 `agent.minimaxi.com`，`chat.minimaxi.com` 实测只剩 307 跳转。
  · **阶跃星辰**（`chat.stepfun.com`）—— 参考 dijiaozhibei-top/step2api。
    **零签名零 PoW**，唯一难点是 Connect RPC 分帧（1B flags + 4B len），
    与 kimi 的帧格式同构。**更正**：不要用「跃问 yuewen.cn」——
    实测该域名 TLS 证书已过期并返回 403，品牌已退役。
  三家实现同一套适配器契约（`importAuth/verify/chat/loginModes/ENTRY_URL`），
  复用既有「抓取登录态」与「测试渠道」链路，不另开旁路。
  图片输入暂不支持并**明确报错**：不静默丢弃 ——
  用户以为图发出去了但模型没看到，是最坏的情况。 |
| 2026-09-21 | **第 41 批（三）· WorkBuddy 的 CLI 集成：调研后判定「做了也没用」**。
  用户提出「WorkBuddy 没有轻的 CLI 版本？不能直接在包里安装一个？」——
  调研结论（2026-09-21，含实测）：
  · 官方 CLI **确实存在**（`@tencent-ai/codebuddy-code`，纯 Node.js + linux ripgrep，
    `npm i -g` 可装），这点用户是对的；
  · 但**全包 174MB 零 `X-Device-Token` 命中** —— CLI 自己就不发这个头，
    装它解决不了设备头问题（净增 54MB 依赖、零收益），
    且 CLI 的登录是 TUI 里的 `/login` 斜杠命令、无 headless 子命令；
  · Turing Shield SDK **没有 Linux 构建**（`index.cjs` 首行门控
    `supportedPlatform = darwin || win32`，二进制为 Windows DLL/macOS node 模块）；
  · 桌面端自己的逻辑是「取不到 token 就改发 `X-Device-Token-Error`」——
    说明**服务端接受无有效设备头的请求**（软风控信号，非硬鉴权）；
  · 7 个可验证的开源网关里 **5 个完全不发该头**，1 个可选注入并优雅降级，
    仅 1 个需要同机装 Windows 桌面端才能生成。
  **处理**：现有设备授权方案保持不动（它是腾讯官方协议、CLI 内部同款），
  不做 CLI 集成、不做签到类接口（那是唯一确证需要设备头的路径，属灰产风控面）。

| 2026-09-21 | **第 42 批 · 全站宽度复审 + 发版版本提示**（用户第三次反馈「很多页面不是全宽」，并指出
  图标「没变、甚至之前好的也变成平台 logo」）。
  · **先归因，再动手**。写脚本对 19 个页面 + 渠道弹窗做**真实渲染**审计（宽度逐区块量、
    图标逐个读 `src` 与 `naturalWidth`、左右栏各自 `scrollHeight/clientHeight`）：
    服务器侧**图标 19/19 正确、左右栏独立滚动成立**。冲突之处由 `nginx access.log` 解释：
    该用户页面是 **9/20 09:44 打开的**，直到 **9/21 11:06:33** 才重新加载 bundle，
    此前一直在跑旧包 —— SPA 打开后不再请求 index.html，**发版换包也换不掉已打开的页面**。
  · **修法（新增能力）**：`/api/status` 下发 `build_id`（部署中的 bundle 文件名，
    见 `services/build-info.js`，以 `index-*.js` 的 mtime+size 做缓存键）；
    前端从自己的 `<script src>` 读实际加载的包名，不一致则在内容区顶部提示
    「页面版本已更新 · 立即刷新」，切回标签页时重新拉 status 比对
    （详见 2.7 第 ⑮ 条）。
  · **真·宽度问题（审计第二版才暴露）**：第一版脚本取「页面内最大右边界」，
    页头永远铺满 → **每页都误判为全宽**。改为逐区块量占比后找出实际留白：
    ① `AdminSettingsPage` 两处 `maxWidth:760`（宽屏右侧空 864px）；
    ② `ProfilePage` 的 `Section` 限宽 560/620/640（右侧空一半）；
    ③ `.oo-stats-cards` 的 `minmax(118px, 200px) + justify-content:start`
       —— 这是上一轮治「卡片被拉成薄片」时加的 200px 上限，
       结果从「太宽」变成「挤在左边、右侧空 800px」（媒体库/通知/定价页）。
    改为自适应等分（`minmax(148px, 1fr)`，不留白优先），
    设置类长表单改为 `auto-fit minmax(280px, 1fr)` 多列 + 长文本框单独限宽 1100px
    （铺满 ≠ 让输入框拉成 1600px 一条线）。
  · 新增 `tests/audit-ui.mjs`（逐页宽度 + 图标 src + 滚动量）与
    `tests/verify3.mjs`（三项验收，含「先选中长表单厂商再验左右独立滚动」
    ——修掉了上一版「右栏本来就没得滚」导致的假通过）。
  · **教训**：用户第三次报同一类问题时，不要重复「我这边测了是对的」，
    要去找**用户侧与服务器侧的差异证据**（这次是 access.log 的时间线）。
  · **图标可辨识度**：四家的 GitHub 组织头像里有三张带完整品牌字样
    （MiniMax「MINIMAX」、MiMo「Xiaomi MiMo」），22px 下糊成黑块 ——
    文件、路径、HTTP 全对但**看不清**。裁成纯符号并保持正方形
    （先做错一次：纯色 padding 把 MiniMax 的渐变底切成了黑框）。
  · **部署过程中发现并修掉两个自身问题**：
    ① 上一提交引入白屏（`MainLayout` 用了 `refreshStatus` 却未从 `useApp()` 解构）
       —— 构建通过、部署成功、整站白屏，与 2.7 第 ④ 条同型；
    ② 审计脚本 import `db.js` 后不 `process.exit`，线上堆了 8 个孤儿进程
       吃掉约 1GB（机器 3.5GB 无 swap），把后续 `ui-smoke` 拖到超时
       （见 2.7 第 ⑱ 条）。已给 `tests/` 补齐显式退出并清理现场。
  · **双栏页复核（`probe-split2.mjs`）又抓到一个真缺陷**：消息中心的
    `.oo-split-lock` 高度是「视口 − 上方占用」算出来的，原写 `128px`
    **少算 12px**，四种视口下（1440×900 / 1880×900 / 1440×1080 / 1366×768）
    外层都恰好多出 12px 滚动条 —— 正是该 CSS 注释自己警告过的
    「高度差一点，底部输入框随即被推出视野」。实测分解为
    顶栏 52 + 内容区上内边距 24 + 页头 30 + 页面 gap 10 + 内容区下内边距 24 = 140，
    改为 `calc(100dvh - 140px)` 后外层归零。分解已写进注释，改头部样式时要重算。
  · **最终线上验收**：`verify3.mjs` 34/34 通过（含 9 个页面无窄区块 +
    7 个厂商图标 src 正确 + 4 项独立滚动断言）、`ui-smoke.mjs` **23/23 页面
    全部正常渲染**、`probe-stale.mjs` 5/5（版本提示条按预期出现/不出现、
    点击后真的重载）、`probe-split2.mjs` 6/6（消息页两个独立滚动容器 +
    外层零滚动；社区页两栏并列）。截图人工过目：系统设置 5 列铺满、
    个人设置 5 列 + 统计卡三等分、媒体库/通知统计卡满铺、弹窗新厂商图标清晰。

| 2026-09-21 | **第 43 批 · GPT 网页版「邮箱+密码+2FA」可反代性实测（含完整链路与结论）**
  （用户给了一组测试凭据，要求验证「仅靠这三个参数能否反代上去」）。
  **全部结论来自线上实测，凭据仅经临时文件传入、用完即删，未入库未入日志未进仓库。**

  · **可达性**：服务器（东京阿里云）`curl https://chatgpt.com` 返回 **403**，
    但响应头是 `cf-mitigated: challenge` —— 这是 Cloudflare 的 JS 挑战，
    **不是 IP 封禁**。同机真实浏览器（平台 browser-driver 同款启动参数，
    headful + Xvfb）**HTTP 200 正常落到 ChatGPT 首页**。结论：cloudflare 挑战
    只挡无 JS 的客户端，浏览器路径可用。

  · **登录自动化的三个前置发现**：
    ① 登录页是**两步式**（先邮箱 → `auth.openai.com/log-in/password` 再密码），
       不是一页填完；点「继续」后要**轮询等页面离开邮箱步**，死等固定秒数会失败。
    ② 表单是 React 受控组件：`fill()` 后立刻 click 会**停在原步不前进**，
       必须 `click → fill("") → type(逐字符, delay≈25) → 等 value 落盘 → 提交`。
    ③ 用户给的 32 位串是 **TOTP 密钥（base32 seed）**，不是 6 位动态码 ——
       **平台目前完全没有 TOTP 实现**。已用 node:crypto 实现 RFC 6238
       （HmacSHA1 + base32 + 动态截断），并以 RFC 6238 附录 B 向量自检通过
       （seed=GEZDGNBVGY3TQOJQ…，t=59s → 94287082 ✓）。
       这是接入 GPT / 任何带 2FA 的厂商的**必需基础件**。

  · **登录结果是通的**：邮箱 → 密码 → 2FA 动态码 → 落地 `chatgpt.com/`，
    `/api/auth/session` 返回 **accessToken（2042 字符）、planType=free、
    expires 2026-12-20**。注意**没有 refreshToken**（免费档）——
    意味着 token 到期后必须重新走一遍登录，不能像 Codex 那样自动续期。

  · **关键卡点：sentinel 风控（turnstile + PoW）**。拿到 token 后直接
    Node fetch `/backend-api/conversation` 返回 **403**
    `Unusual activity has been detected from your device`。逐层探测：
    - `POST /backend-api/sentinel/chat-requirements/prepare` 返回
      `proofofwork{required, seed, difficulty}` + **`turnstile{required:true}`** + `so`；
    - 不带 `Authorization` 时 persona 是 `chatgpt-noauth`，带上才是 `chatgpt-freeaccount`
      （**认证头决定 persona**，这是排查时的关键分界）；
    - PoW 可在 Node/浏览器内**纯 JS 解出**（实测 difficulty `067d01`
      约 1.1 万次 SHA-256、67ms 命中）；
    - 但 **turnstile 必须由页面自身的 JS 解**，Node 端无解 ——
      补上 sentinel token 后仍然 403。`window.turnstile` / `__sentinel` 均未挂载，
      说明它不是标准 turnstile SDK，而是与 ChatGPT 前端深度耦合的挑战。

  · **决定性结论：驱动真实 UI 可行**。改走页面 UI（ProseMirror 的
    `div#prompt-textarea`，可见；隐藏的 `textarea` 是旧版元素，选它会超时）：
    `click → keyboard.type → Enter`，**对话请求返回 200，回复正是「收到」**。
    即：**GPT 网页版反代的正确实现路径 = 常驻浏览器页面 + 驱动 UI**，
    而不是像其他厂商那样在 Node 里组装 HTTP 请求。
    平台已有 `browser-driver`（持久化 profile、会话池、看门狗、远程截图/操作），
    **基础设施可直接复用**，需要新增的是「UI 驱动式适配器」这一类。

  · **登录会被限流（运维事实）**：连续登录约 5 次后，提交按钮变成**一直转圈的挂起状态**
    （页面不报错、无提示，只表现为请求不返回）。约 2~3 分钟后恢复。
    这意味着**凭据校验不能设计成「每次请求都重新登录」**，
    必须登录一次后持久化 token + device_id 并复用。

  · **关于「接码」**：本账号是**邮箱+密码+TOTP**，全程无需短信，
    因此接码不是这条路径的必需项。但若账号是**手机号注册**或触发
    「异常登录要求短信验证」，则必须有接码 —— 届时才有必要引入。
    当前平台已有的基础是「服务器浏览器里人工完成验证码」那套
    （`channel.js` 的浏览器登录 + 远程截图/操作），**能覆盖人工介入场景**；
    全自动接码平台是另一类集成（涉及第三方付费服务），本次未做。

  · **本次未做（等确认）**：没有把上述流程实现成正式适配器 ——
    因为它与现有所有适配器的形态不同（UI 驱动 vs HTTP 请求），
    且免费档 token 无 refresh、需定期重登，属于要单独设计的一类。
    实测脚本为一次性验证，已从服务器删除。

| 2026-09-21 | **第 43 批（二）· 渠道额度条改成 sub2api 形态与配色**（用户点名要求并附对比图）。
  · **配色是量出来的，不是猜的**：从用户给的截图逐像素取样，得出 sub2api 用的是
    **Tailwind 成对值** —— 窗口标签 `#e0e7ff` 底(indigo-100) + `#4338ca` 字(indigo-700)、
    `#d1fae5`(emerald-100) + `#047857`(emerald-700)、中性胶囊 `#f3f4f6`(gray-100)、
    进度条轨道 `#e5e7eb`(gray-200)。用户说「颜色真他妈丑」指的是原来的
    **高饱和实心色块**（直接铺 `--green/--orange/--red`）。
  · **形态**：`[5h] ──进度条── 12% 3h`
    —— 窗口胶囊（淡底深字、等宽字体、定宽对齐）+ **4px 细进度条** +
    百分比 + 重置时间短形态（`现在 / 3h / 2d`，原来渲染的是长文案
    「2 天后重置（09-23 04:00）」，会把额度列撑宽）。
  · **配色策略合并**：sub2api 是**静态色序**（5h 恒靛蓝、7d 恒翠绿），
    原实现是**用量驱动**（>90% 红）。合并为：静态色序打底、
    用量档位（≥70% 琥珀、≥90% 红）覆盖 —— 同账号不同窗口颜色稳定可对照，
    快用完仍能一眼看出。第三/第四窗口依次取天蓝、灰。
  · 新增 `--pill-*` 变量两套（亮/暗）：暗色下淡底深字会糊，
    改为低透明同色底 + 提亮同色字。套餐/账号/余额改为中性灰胶囊，
    与彩色窗口胶囊形成层次。
  · **验证方式**：额度条不在渠道页首屏、也不便直接观察，
    因此写了 `tests/live-quota.mjs`（拦截列表接口注入 5 种形态快照 +
    读回真实 `getComputedStyle` 的进度条/胶囊尺寸与颜色），
    以及一套静态预览工具（`make-preview.py` + `shot.mjs`）。
    线上实测取回：轨道 `rgb(229,231,235)`、填充 `rgb(245,158,11)`（琥珀档）、
    胶囊 `#fef3c7`+`#b45309` —— 与取样值一致。
| 2026-09-21 | **第 44 批 · 全站 UI/UX 规范性审查与视觉统一整改**（独立窗口审查，严格避开其他窗口并发修改文件）：
  · **并发文件隔离**：审查前先锁定并发窗口正在改动的后端服务、适配器及 `AdminChannelsPage.jsx`，本次改动严格限定在未被触碰的独立前端页面及公共样式中。
  · **响应式网格与消除内联 `<style>`**：
    - `styles.css`：新增全局标准响应式表单网格类 `.oo-settings-form` 与 `.oo-profile-form`（基于 `minmax(280px, 1fr)` / `minmax(340px, 1fr)`，移动端自动切单列），统一间距与排版。
    - `AdminSettingsPage.jsx`：清理设置页 `SettingsTab` 组件内部动态注入的 `<style>` 标签，改为引用集中 CSS 类。
    - `ProfilePage.jsx`：移除 `const FORM_GRID` 并在 JSX 中内联注入的 `<style>` 字符串，采用 `.oo-profile-form` 标准网格。
  · **设计令牌（Token）与暗色兼容对齐**：
    - 全面清理遗留废弃变量 `--oo-text-muted`，统一替换为标准语义令牌 `var(--ink-3)`（涵盖 ProfilePage、AdminUsersPage 等）。
    - `AuthPage.jsx`：输入框前缀图标统一前景色 `var(--ink-3)`，外框统一采用 `var(--line)`，关闭注册提示图标修正为 `<LockOutlined />`（替代原本带有成功歧义的 `CheckCircleFilled`）。
  · **交互状态与反馈一致性**：
    - `NotificationsPage.jsx`：将直接裸露的红色文字 `color: "var(--red)"` 重构成标准反馈容器 `<Alert type="error" showIcon message="通知加载失败" description={loadError} action={<Button size="small" onClick={load}>重试</Button>} />`，统一空状态与错误重试体验。
    - `AdminCommunityPage.jsx`：修复帖子隐藏/恢复操作按钮图标逻辑 bug（解除隐藏原错误渲染为 `<EyeInvisibleOutlined />`，现修正为 `<EyeOutlined />`）。
  · **管理端统计卡片规范化**：
    - `AdminUsersPage.jsx`：将自定义容器 `.oo-grid .oo-users-stats` 统一升级为标准类名 `.oo-stats-cards`，并将 `StatCard` 的非标 `foot` 属性升级为全局规范的 `hint` Tooltip 提示。
    - `AdminPricingPage.jsx`：规范 `StatCard` 用法，移除多余未解析的 `icon` 属性，将底部自定义 JSX 统一规范至 `hint` 说明，补充对应计量单位。
  · **构建与产物同步**：`ooapi-web` 执行 `npm run build` 通过，3097 个模块全部构建通过，产物同步至 `ooapi-server/web/`。 |

| 2026-09-21 | **第 45 批 · ChatGPT 网页版「浏览器 UI 驱动」反代：实现并线上跑通**（承接第 43 批的可行性实测，
  用户确认「按你说的那个路径开始实现」）。
  · **交付**：新增 `openai` 厂商的接入方式「反代（浏览器驱动）」（key `openai-web-ui`），
    凭据为**邮箱 + 密码 + 2FA 密钥**，管理员填一次即自动登录并建立渠道。
    新增文件：`services/totp.js`（TOTP/RFC 6238，零依赖）、
    `upstream/openai-web-login.js`（浏览器内三步登录）、
    `upstream/openai-web-parser.js`（SSE 解析）、`upstream/openai-web-ui.js`（适配器主体）。
  · **线上验收 7/7 通过**（真实凭据，脚本：登录建渠道 → 测试渠道 → 网关非流式 → 网关流式）：
    登录建渠道 26s；测试渠道「渠道可用」回复 `Hi! 😊`；
    网关 `/v1/chat/completions` 200 回复「收到」；流式为多帧增量（首帧约 12~19s）。
  · **踩坑与修正（10 处，全部有线上证据，逐条记在 §2.7）**：
    ① TOTP 密钥 ≠ 6 位动态码 —— 平台原本没有 TOTP，用户给的 32 位串是**密钥**；
    ② 登录页是两步式（先邮箱再密码），且是 React 受控表单，
       `fill()` 后直接提交会**停在原步**，必须逐字符键入；
    ③ 连续登录约 5 次触发限流（提交按钮挂起 2~3 分钟）→ 登录必须一次性+持久化；
    ④ 登录前不清旧 cookie 会被重定向回首页，邮箱框永不出现；
    ⑤ 登录会话残留会锁住 profile 目录 → 下次登录必失败（"Opening in existing browser session"）；
    ⑥ 服务器 `curl` 访问 chatgpt.com 返回 403 是 Cloudflare **JS 挑战**不是 IP 封禁，
       真实浏览器正常（这条决定了整套方案可行）；
    ⑦ **cookie 注入不足以恢复登录态**：把 18 个 cookie（含 session-token）完整注入
       干净浏览器后仍为未登录 —— 网页版还依赖 localStorage/IndexedDB，
       因此改用 profile 目录复制（复用平台既有 `copyProfile`）；
    ⑧ hook 匹配路径写错两层：`/backend-api/conversation` 既不对（真实端点是
       **`/backend-api/f/conversation`**），又会误匹配 `/backend-api/conversations`（会话列表）
       与 `/f/conversation/prepare`（同前缀的准备请求）—— 现象都是
       「Enter 发出去了、页面真回复了，却 0 帧」；
    ⑨ **真实帧格式是 JSON Patch 流**（`{"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"收到"}]}`），
       不是社区文档的 `{message:{content:{parts}}}` 直推 —— 照着文档写的解析器
       会「捕到 23 帧却解析出空字符串」，外层误报「空回复（可能被风控）」；
    ⑩ `methodOf()` 把未知 method 归一成 `relay`，导致具名反代解析不到适配器
       （渠道能建、能登录、一测试就报「适配器未实现测试」）—— 与登录路由写死 relay 是同一类问题的两处。
    过程中还修了两个**与本次功能无关的历史缺陷**：
    网关写日志时 `displayGroupName` 未导入（每次成功请求都变 500）、
    `profileDir` 未导出（适配器加载失败只报「适配器不可用」）；
    以及把浏览器驱动渠道的探测超时从 90s 放宽到 240s
    （首次探测要付「启动 Chromium + 过风控」的开销，90s 下**每次测试都误报超时**）。
  · **测试**：`tests/totp.test.mjs` 25 项（RFC 6238 附录 B 官方向量）、
    `tests/openai-web-ui.test.mjs` 31 项含**真实帧回归**
    （`tests/fixtures/openai-web-frames.json`，线上抓取的 23 帧完整序列，JWT 已脱敏）。
    为什么用真实帧当基准：这套协议与社区文档差异极大，只有真实帧能锁住行为。
  · **安全事件（已处理，需用户配合）**：`totp.test.mjs` 里我误把用户真实的 2FA 密钥
    当作示例写进断言，随 `1852b08` 推送到了远端 —— **等于密钥泄露**。
    已替换为构造值并在注释里写明原因；**该密钥须视为已作废，请在账号侧重新绑定 2FA**。
    教训：任何来自用户的真实凭据都不能进仓库（本次其余环节都是用临时文件传入、
    用完即删，只有这一处漏了）。
  · **稳定性验证：连续三轮 7/7 全绿**（每轮都是新登录→建渠道→测试→网关→流式）。
    首轮曾出现 4/7，逐条定位并修掉三个真缺陷（都是并发/时序类，非测试环境特有）：
    - 并发认领竞态：两个请求同时认领登录 profile，`copyProfile` 内部
      先删目标目录，导致第二个把第一个的成果删掉 → 加 per-channel 互斥；
    - **单操作形态的 patch 帧漏认**：上游把 patch 数组拆成多个 `data:` 行，
      每行一个操作项（`{"p":"/message/content/parts/0","o":"append","v":"收到"}`），
      而原实现只认 `{o:"patch",v:[…]}` 包装 → 帧数正常却解析出空串，
      外层误报「空回复（可能被风控）」；两种形态都出现过，取决于上游分帧，
      这正是「同一构建两次结果不同」的原因；
    - 登录态检查不容忍瞬时失败：页面刚导航完、next-auth 上下文未就绪时
      `/api/auth/session` 会短暂拿不到 token，被误判为过期 →
      改为重试 2 次仍失败才判过期（真过期三次都会失败，不会漏报）。
    另外发现前一阶段的测试渠道残留（priority 999999 但 profile 已被清理）
    会被网关优先选中并报错 —— 是测试数据未清干净，非适配器问题。
  · **未做（明确取舍）**：免费档 access_token 无 refresh_token，
    到期需管理员重新登录（渠道会报 `CHANNEL_AUTH_EXPIRED` 并给出提示），
    没有做「每请求自动重登」—— 那会踩上面第 ③ 条的限流。
| 2026-09-22 | **第 46 批 · 渠道额度平铺展示优化：套餐与余额标签直出 + 移除悬浮遮挡**（用户点名需求并附截图）：
  · **布局重构**：
    - `ChannelQuota.jsx`（`QuotaInline`）：将「套餐标签（`套餐 xxx`）」与「余额标签（`余额 xxx` / `预付费 $xx`）」从悬浮 Tooltip 移至进度条上方，在表格单元格中横向单行直接平铺展示；
    - 紧随其下为窗口进度条（`[30d] ─── 77% 26d`），所有关键指标直观可视，用户无需悬停鼠标即可查阅；
    - 移除了列表内联的 `<Tooltip>` 浮层，彻底解决悬浮时弹出的黑色遮罩遮挡相邻表格行的问题；相对重置时间通过原生 `title` 属性轻量提示完整重置日期。
  · **冗余信息清理**：
    - 按用户明确要求，彻底隐藏不再展示「账号」与「抓取于...」字段。
  · **构建与产物同步**：
    - `ooapi-web` 执行 `npm run build` 通过（3097 个模块构建完成，退出码 0），产物已同步至 `ooapi-server/web/`。 |
| 2026-09-22 | **第 47 批 · 在线更新契约修复与前端更新轮询容错**（线上环境排查修复）：
  · **契约属性名修复（P0 Bug）**：
    - `updater.js`（`checkUpdate`）返回结构原本为 `local/remote/upToDate`，而前端 `AdminSettingsPage.jsx`（`UpdateTab`）却读取 `current/latest/hasUpdate`；
    - 字段不匹配导致 `info.hasUpdate` 恒为 `undefined`，`!info.hasUpdate` 恒为 `true`，导致前端始终误判并展示「已是最新版本」，「立即更新」按钮被永久禁用，版本号显示为 `—`；
    - 后端补充 `current/latest/hasUpdate` 字段别名；前端完善容错取值（`current || local`、`latest || remote`、`hasUpdate ?? !upToDate`）；
    - `collectDiff` 增加对 `ooapi-web/src` 目录的差异检查，避免纯前端改动时 `changedCount` 误报为 0。
  · **热更新轮询与超时放宽**：
    - 前端 `API.post("/update/apply")` 超时由 30s 放宽至 300s（覆盖构建与安装耗时）；
    - `poll` 轮询完善根据目标 commit（`stamp.commit === latest.commit`）及最多 40 次重试自动退出并提示更新成功。
  · **构建与产物同步**：
    - `ooapi-web` 执行 `npm run build` 通过，产物同步至 `ooapi-server/web/`。 |
| 2026-09-22 | **第 48 批 · 全站 UI/UX 体验与视觉规范综合整改**（线上实测审查落地）：
  · **图表组件与图例文字兼容（P1 缺陷修复）**：
    - `Charts.jsx`：`Legend` 与 `LineChart` 序列定义原本仅读取 `s.label`，导致传入 `{ name: "..." }` 时图例仅有圆点而缺失文字说明；现统一支持 `s.label ?? s.name`，彻底修复全站（控制台、数据看板、使用分析）折线图图例文字丢失问题。
  · **统一货币与底层单位收敛（P1 规范对齐）**：
    - `AdminDashboardPage.jsx`：修复「用户消费排行」直接渲染底层 `单位` 的违规泄露，改为通过 `fmtOd(u.units, perUnit, 2)` 格式化为标准 OD 币；将「模型成本排行」及全站趋势图中的消费轴单位统一换算为 `消费 (${CURRENCY_NAME})`。
    - `ConsolePage.jsx`：将「模型消费排行」与「渠道分布」统一换算为 OD 币展示，消除「按额度单位」的内部概念外露。
  · **视觉排版与一致性优化（P2 体验升级）**：
    - `AdminDashboardPage.jsx`：解决「渠道表现」表格渠道名称列被粗暴截断为「渠道…」的缺陷，设置最小列宽 `minWidth: 140` 并补充渠道 ID 前缀。
    - `ChatPage.jsx`：侧栏底部余额展示精度从 4 位小数统一收敛至 2 位小数（`fmtOd(user.quota, unitsPerOd(status), 2)`），与全站保持高度一致。
    - `AdminPricingPage.jsx`：在「价格来源」列过滤清洗掉内部草稿公式（如 `÷ 7.2`、`¥.../¥...`），提供更专业美观的公开来源标签，同时完整保留 Tooltip 浮层供管理员深入查看。
    - `CommunityPage.jsx`：优化社区大厅搜索框，移除 `Input.Search` 内部额外前缀导致的双重放大镜图标冗余。
    - `ConsolePage.jsx`：将「我的社区与娱乐」从一整段紧凑纯文本重构为结构化的轻量徽章胶囊网格，视觉层次与交互体验显著提升。
  · **构建与产物同步**：
    - `ooapi-web` 执行 `npm run build` 成功（3097 个模块构建完成，退出码 0），产物已同步至 `ooapi-server/web/`。 |
| 2026-09-22 | **第 49 批 · 渠道管理独立分组标签重构与使用记录表格标准统一化**（UI/UX 核心对齐与数据修正）：
  · **渠道管理分组独立 Tag 与图标关联体系重构（P1 缺陷修复）**：
    - `VendorIcon.jsx`：封装通用 `GroupTag` 统一分组标签组件，确立完善的分组图标推导与关联优先级：`meta.vendors`（多厂商叠放 / 单厂商单个）-> `meta.vendor` -> 分组名直接命中已知厂商关键字（`hasKnownVendor`）-> 统一优雅的 `<TeamOutlined />` 矢量图标兜底，杜绝漏图、纯文本或占位崩溃。
    - `AdminChannelsPage.jsx`：重构表格「分组」列，彻底移除以往仅渲染首个分组并将后续折叠隐藏为 `+N` 的不良设计；现改为多标签自动流式包裹排布，每个分组均作为独立 Tag 携带专属厂商图标、分组名称、倍率标识与完整 Hover 提示。
  · **使用记录与渠道管理表格规范统一（P1 视觉与排版重构）**：
    - `LogPage.jsx`：
      1. **修复行高过大与空间稀疏问题**：时间列宽度调整为 `165px` 且强制 `whiteSpace: "nowrap"`，彻底解决原有 `158px` 导致 `YYYY-MM-DD HH:mm:ss` 换行进而成倍撑高表格每行的视觉缺陷，行高自 65px+ 回归紧凑标准的 38px。
      2. **核心业务指标前置与列顺序重构**：将原本排在第 7 列占据 300px 并将所有费用、消耗与延迟挤出屏幕的「调用内容」后移；重组为 `时间 -> 用户 -> 模型 -> 分组 -> 计费 -> Tokens -> 总耗时 -> 首Token -> 渠道 -> 密钥 -> 调用内容 -> IP/设备`，使桌面视口下无需横向滚动即可一览全部关键开销与性能数据。
      3. **移除 size="small" 与对齐表格容器**：与 `AdminChannelsPage` 保持相同的基础尺寸与 `.oo-table` 排版规范。
  · **使用记录数据正确性、时间口径与分组筛选补齐（P1 功能修复）**：
    - `LogPage.jsx`：
      1. **默认时间范围自 7 天修正为 30 天**：解决默认 7 天窗口导致历史调用数据显得异常稀少甚至空缺的感知问题。
      2. **分组标签规范对齐**：未分配分组或 `default` 统一优雅渲染为 `<Text type="secondary">公共</Text>`，消除原本突兀空洞的 `-` 占位。
      3. **工具栏补充分组筛选器**：支持按「全部分组」多维度过滤（包含公共池与具体分组）。
    - `ooapi-server/src/routes/log.js`：
      1. `buildQuery`：补充 `query.group` / `query.group_name` 过滤逻辑，兼容 `__public__`、`公共`、`default` 与具体分组名。
      2. `listLogs`：确保 `ORDER BY created_at DESC, id DESC` 严格倒序，保证最新记录恒在首页首行。
      3. `/usage/filters`：新增分组聚合查询，返回时间范围内的活跃分组及公共池调用次数计数。
  · **操作日志表格同步对齐**：
    - `OperationLogPage.jsx`：同步修正时间列 nowrap 与宽度，移除 `size="small"`，默认窗口调整为 30 天。
  · **构建验证与单测验证**：
    - 前端 `npm run build` 成功（3097 模块无告警通过）；
    - 后端 `node --check` 语法检查通过；
    - 全量单测套件 `npm test` 13 个套件全部通过（0 失败）。 |
| 2026-09-22 | **第 50 批 · 全站倍率视觉体系重构、折叠态厂商图标去 +N 与分组管理/令牌选择器全面升级**（UI/UX 深度体验整改）：
  · **全站倍率展示视觉体系重构（P1 视觉规范）**：
    - `styles.css`：引入统一的 `.oo-rate-badge` 及其微状态修饰符（`.oo-rate-badge--base`、`.oo-rate-badge--boost`、`.oo-rate-badge--discount`）。
    - 解决乘号巨大粗笨、数字失真及缺乏美感的问题：乘号 `×` 字号微缩至 9.5px、垂直微调并半透明弱化；数字采用等宽精细字体 `var(--font-mono)`、11px、字距 -0.2px 并开启 `tabular-nums`，整体封装为 19px 高的圆润微胶囊，明暗主题自适应。
    - `VendorIcon.jsx`：封装并导出 `<GroupRateBadge rate={rate} />` 全局通用倍率徽章组件。
  · **表格内分组标签去倍率化（P1 体验对齐）**：
    - `VendorIcon.jsx`：在表格通用的 `GroupTag` 中，彻底移除行内直接硬拼的 `×{rate}` 标签；表格单元格内仅展示专属/推导厂商图标与分组名称，干净紧凑，倍率信息收敛至 Hover Tooltip 浮层中，杜绝视觉干扰。
    - `TokenPage.jsx`：表格分组列统一使用 `<GroupTag />`，替换原先手动拼写的粗大倍率 chip。
  · **折叠态厂商图标移除 `+N` 标识（P1 细节修正）**：
    - `VendorIcon.jsx`：在 `GroupVendorIcons` 中彻底删除 `+{list.length - max}` 徽章尾巴；多厂商叠放时直接渲染最多 3 个带高质感白色/表面描边的叠放厂商图标，涉及的所有厂商全称由 Tooltip 统一承载，简洁优雅。
  · **创建令牌时分组选择器结构重构（P1 交互升级）**：
    - `TokenPage.jsx`：参考用户反馈与实际缺陷截图（告别将图标、+1、名称、备注、倍率挤压在单行的愚蠢排布），重构为专业 SaaS 三段式卡片布局：
      1. 左侧：叠放厂商图标（`GroupVendorIcons`，最多 3 个，无 +N 尾巴）；
      2. 中间：垂直上下双行流（上行加粗 12.5px 分组名称，下行 11px 浅灰备注/模型说明，文字自适应截断）；
      3. 右侧：全新精致的 `<GroupRateBadge />` 微胶囊倍率徽章。
      选定后在 Select 框内回显为优雅紧凑的单行（厂商图标 + 名称），不破坏输入框高度。
    - 下拉弹窗配置 `popupMatchSelectWidth={false}` 并设置最小宽度 380px，彻底释放呼吸空间。
  · **分组管理页面（`AdminGroupsPage.jsx`）表格与数据展示全面重构（P1 页面升级）**：
    - 拆分与重组表格列（宽度严格匹配 `scroll.x=900`，杜绝无意义空白拉伸）：
      1. 「分组名称」：加粗主标题 + 默认池徽章 + 正下方二级浅灰备注；
      2. 「成员厂商」：展示多厂商叠放图标（无 +N），Hover 提示成员厂商全称，未关联时展示轻量灰色标签；
      3. 「计费倍率」：统一使用 `<GroupRateBadge />`，支持按数值排序；
      4. 「模型范围」：展示前 1 个带品牌图标的模型标签 + `+N` 胶囊，不再仅是冷冰冰的数字，Hover 展示完整支持模型列表；未限制时展示「全部模型（不限）」；
      5. 「关联渠道」：列头从生硬的「账号」调整为「关联渠道」，显示包含图标的微徽章（如 `3 个渠道`），Hover 提示具体渠道名称及类型；
      6. 「操作」：编辑与删除按钮，默认池分组禁止删除。
    - 顶部工具栏增加搜索框（按分组名称与备注模糊检索），并展示分组总数统计。
    - 编辑/新建分组弹窗中，在计费倍率字段 Label 旁增加 `<GroupRateBadge />` 实时动态预览。
  · **构建与单测验证**：
    - 前端 `npm run build` 成功（3097 模块构建通过，耗时 20.73s）；
    - 后端 13 个测试套件全量跑通（0 失败）；
    - 产物已同步至 `ooapi-server/web/`。 |
| 2026-09-22 | **第 51 批 · 渠道列表精简化（删除厂商列/合并调度指标）与模型选择器交互深度整改**（UI/UX 细节重构）：
  · **渠道管理列表表格精简与紧凑化（P1 体验升级）**：
    - `AdminChannelsPage.jsx`：
      1. **彻底删除「厂商」列**：渠道名称左侧已有对应厂商高质感图标，单独占列冗余且占用横向视口；
      2. **合并「优先级 / 权重 / 次数」为单一调度列**：将原先分散的 3 列合并为 `优先级 / 权重 / 次数` 列，行内以优雅斜杠 `/` 分隔（如 `0 / 0 / 0`），数字采用等宽字体，Hover Tooltip 提供完整详细标签说明；
      3. **收敛表格横向滚动宽度**：容器横向滚动自 1660px 缩减至 1450px，在主流屏幕下无需多余横向拖动；
      4. **彻底清除新建渠道残留未定义按钮**：移除此前残留导致 ReferenceError 的未绑定 `onClick={fetchModels}` 孤立按钮；还原所有表头乱码与残缺文字为规范简体中文。
  · **模型范围选择器（ModelPicker）交互逻辑与体验全面重构（P1 交互整改）**：
    - `ModelPicker.jsx`：
      1. **主动获取模型自动填入输入框**：区分初始化静默探测与用户主动点击；用户主动点击「从上游获取模型」成功后，不仅刷新下拉候选，同时立即自动调用 `onChange(models)` 填入全部模型，彻底解决用户点击获取后输入框依然空荡的困扰；
      2. **全选与清空合二为一**：合并原先分裂的两个操作按钮为单智能按钮；根据当前选择状态自适应展示为「全选（N）」或「清空（不限）」，并实时展示「已选 X / Y」选择进度；
      3. **上游错误信息智能清洗与美化**：拦截上游返回的原始报错（如 `token_revoked`、401、429 及未格式化 JSON），提取并转换为清晰的中文提示（例如「上游授权凭据已失效或被官方撤销，请更新凭据」），杜绝在前端倾倒未经处理的底层错误堆栈；
      4. **视觉轻量化提示**：以轻量警告条替代生硬弹窗，保持界面呼吸感。
  · **构建与测试全绿验证**：
    - 前端 `ooapi-web` 执行 `npm run build` 成功（3097 个模块构建完成，耗时 28.35s，0 错误）；
    - 前端打包产物已同步到 `ooapi-server/web/`；
    - 后端 13 个单测套件全量跑通（0 失败）。 |

| 2026-09-22 | **第 47 批 · 线上全量验收与视觉审查**：当前线上版本 `7c2b9e4` 实测完成：`npm test`（118 文件/13 套件）0 失败；模块 HTTP E2E 83/83；UI smoke 全部登记路由渲染；弹窗滚动 11/11；移动端 390px 关键页面无横向溢出；DeepSeek/GLM 真实 `/v1` 非流式+流式+usage/计费通过；Gemini 直接探针通过；Codex 账号全部 `token_revoked`；OpenAI API 503；WorkBuddy 真实 404。新增问题已登记第 47 批：`chat.js:715` 线上 `usableKey is not defined`、WorkBuddy 404 阻断同模型渠道、GLM 请求档位与实际模型不一致、Gemini 目录显示与分组调用权限不一致、Anthropic thinking 流事件协议错误、桌面 `/log`/`/admin/channel` 横向溢出、视觉审查期间服务重启、旧游戏浏览器测试脚本与当前 `/community?board=games` 路由脱节。用户提供的 GPT 测试账号保留在线上渠道 #44，实测为上游 401 `token_revoked`。
| 2026-09-22 | **第 46 批 · 最新远端代码只读复审 + 线上实测问题登记**：以干净 worktree 的远端 `02e22d3` 为基线，后端 117 个 JS 文件 `node --check` 全部通过；新增登记 Gemini API `generateContent` 未实现、三协议图片超限分支写死 Chat 响应、Anthropic thinking 事件/非流式思考丢失、Responses `instructions`/完成事件字段丢失、mimo/minimax/stepfun 未注册、WorkBuddy/Qoder endpoint SSRF、绑定跨厂商与并发轮询、StepFun 未知帧丢失、前端社区/个人主页骨架屏与 website XSS 等问题。线上 `5a1c8ca` 实测确认 Antigravity 将「Gemini 3.5 Flash is no longer available」作为 `ok=1` 健康测试；同时确认线上版本落后远端，且曾发生未完成更新告警、内存压力与硬重启。详见第 46 批最新远端复审发现。
| 2026-09-22 | **第 46 批 · 用户四个反馈的查证与修复**（三协议网关 / 模型自定义 / 一键绑定 / OpenCode GO）。

  逐条先复现、再定位、后修复，四项都有线上证据：

  · **① 网关只支持 chat/completions，缺 `/v1/messages` 与 `/v1/responses`**
    —— 确认属实（grep 过路由，只有一条 `/chat/completions`）。
    Anthropic SDK 的客户端只发 `/v1/messages`、Codex 只发 `/v1/responses`，
    只提供一种协议时这两类客户端都要额外装转换层。
    新增 `services/gateway-protocols.js`（请求解析 + 响应渲染）与三个路由，
    **共用同一份 `handleCompletion`** —— 鉴权/限流/渠道选择/计费/日志只有一份实现，
    为每个协议复制主流程是重复扣费与漏记日志的温床。
    关键映射（照官方 SDK 期望核对）：Anthropic 的 `system` 在**顶层**
    （不读会整段丢失系统指令）；usage 字段名不同（`input/output_tokens`
    vs `prompt/completion_tokens`）；SSE 事件名完全不同
    （`event: content_block_delta` vs `data: {...chunk}`）；
    错误体形状不同（`{type:"error",error:{}}` vs `{error:{}}`）。
    验收：**非流式 11/11 + 流式 7/7 全绿**（三种协议各自的响应形状、
    usage 字段名、SSE 事件序列、错误体都逐项断言过）。

  · **② 编辑渠道填了模型、刷新后仍显示「未探测」**
    —— 复现后确认**不是后端问题**（写库与列表接口都正常，脚本验证过），
    而是前端 `ModelPicker` 用了 `mode="multiple"`：只接受候选列表里已有的项，
    输入自定义模型名按回车被**静默丢弃** —— 用户以为填上了、保存了，
    实际 models 仍是空，于是列表显示「未探测」。
    而「手工输入模型名」是明确要支持的（探测失败时的唯一出路，
    组件自己的 none 提示也写着「支持手动输入」）。改为 `mode="tags"`。
    验收：UI 实测输入 `my-custom-model-abc` 后确实进入选择器。

  · **③ 一键绑定成功后仍要求粘贴凭据 JSON**（用户截图：WorkBuddy 显示
    「授权成功」却还要填 JSON）
    根因：`submitAdd` 的凭据校验在「检查绑定票据」之前执行，而绑定路径的凭据
    由服务端在授权回调里拿到、提交后经 `/channel/devices/claim` 写入 ——
    用户手里根本没有 JSON，也不该被要求去弄一份。
    **修的时候发现只改前端不够**：后端 `/channel/login` 在 OAuth 模式下必走
    凭据导入，空 token 会被 `importAuth` 拒绝，那条路径根本提交不了。
    最终端到端打通：前端提交带 `bindTicket`，后端见到它就跳过凭据导入。

  · **④ OpenCode 只有 Zen、缺 GO**（用户指出「Zen 和 GO 都是 OpenCode 渠道下的」）
    —— 调研确认**用户是对的**，Zen 与 GO 是两个独立产品，不是别名。
    官网 FAQ 原话：「Is Go the same as Zen? → **No.**」
    · Zen：按量付费（预充值、零加价），模型池约 76 个（含 Claude/GPT/Gemini），
      端点 `https://opencode.ai/zen/v1`
    · GO ：$10/月订阅，模型池约 40 个（**仅开源模型**），
      端点 `https://opencode.ai/zen/go/v1`，另有独立的 `/zen/go/v1/usage` 额度端点
    **鉴权完全一致**：同一把 `sk-`+64 位 key 在两个前缀下都能通过
    （源码 `authenticate()` 只按 key 值查表，不区分路径），
    区别只在 path 前缀与计费来源 —— 故做成同一厂商下的两个接入方式。
    顺带修正默认模型：`qwen3-coder` / `grok-code` / `kimi-k2` **已从 Zen 下架**
    （2026-02 / 2026-03），留在默认列表会让新建渠道默认选中不存在的模型。

  · **配套的架构修正：`isApiKeyMethod(provider, method)`**
    原代码把「API Key 型接入方式」的判据锁死在字符串 `key === "api"` 上
    （后端 7 处、前端 11 处）。它导致同一厂商下的**第二个** API Key 型方式
    （OpenCode 的 GO、自定义厂商的 Anthropic 兼容）在「添加渠道」里整档消失
    —— 因为前端只对 `key === "api"` 渲染 API Key 表单。
    改为语义判据「有 baseUrl 且无 loginModes」，并把结果下发给前端（`apiKey` 标记）。
    附带改进：API Key 型方式的 baseUrl 现在按接入方式预填，用户不用手抄地址。

  · **过程中发现的一个流程问题**：批量文本替换时我用断言守住「改了哪些」，
    但有一处断言失败后脚本只应用了一半 —— 路由换成了协议驱动，
    响应仍是旧的 chat 格式。**语法检查通过**（旧代码本身合法），
    只有真发一次请求才看得出（线上验收时抓到 `/v1/messages` 返回
    `chat.completion` 形状）。教训：批量替换要么用断言守住后**整体**成功、
    要么先备份再动手；「一半新一半旧」的中间态静态检查抓不到。
  · **另**：期间服务器 SSH 出现间歇性丢包（端口 22 三次里仅一次可连，
    但 ping/80/443 正常）——不是封禁，给 SSH 助手加了重试包装即可。

| 2026-09-22 | **第 47 批 · 额度条展示返工**（用户反馈两处：「标签写额度没有信息量」
  与「还有 N 个窗口是压缩了还是没加载」）。

  查线上数据找到第一个问题的根因：**antigravity（Google）的窗口没有 windowSeconds**
  —— 上游 `buckets[].window` 给的是字符串（实测取值 `"5h"` / `"weekly"` /
  `"monthly"`），而 `windowTag()` 只认秒数，于是标签回退成「额度」两个字，
  同一账号的 4 个窗口全都长一样。而 label 里其实写着
  「Gemini Models · weekly」「Gemini Models · 5h」等信息。

  三处修：
  · **数据源**（`quota.js`）：新增 `googleWindowSeconds()` 把上游字符串窗口
    转成秒数；同时保留 `scope`（模型组名），标签仍是「分组 · 窗口」；
  · **前端三级回退**：显式 tag → 秒数 → **从 label 文本解析**
    （`tagFromText`，认 5h/weekly/daily/monthly 等形态）；
    三者都拿不到才退回「额度」（那类窗口本来就没有时间维度，是真·余额）；
  · **尾部时间去掉**：原来右侧是 `17% 5d`，用户会以为 5d 是窗口，
    实际它是**距重置还剩多久** —— 标签已在说窗口，尾部再说时间必然误读。
    完整重置信息保留在悬浮提示里（`fmtReset` 给「N 天后重置（具体时间）」）。

  第二个问题是**故意压缩**（原实现 `wins.slice(0, 2)`），不是没加载：
  用户分不清是数据缺失还是界面藏起来。额度恰恰是这张表的关键信息
  （哪个窗口快满了决定要不要换号），改为**全部展开** ——
  窗口行很薄（4px 条 + 一行文字），4 个窗口也只占约 90px 高。

  另加：同一账号真有多个模型组时才在标签前加极短分组前缀
  （antigravity 的「Gemini 5h/7d」与「Claude and GPT 5h/7d」光看窗口名
  分不清属于哪一组）。

  验收（线上渲染）：`["套餐 pro","Gemini 7d","17%","Gemini 5h","0%",
  "Claude 7d","62%","Claude 5h","88%"]` —— 4 个窗口全展开、
  标签各自可区分、尾部无冗余时间；单窗口渠道仍是干净的 `30d 77%`。

| 2026-09-22 | **第 48 批 · 统一登录方式规范 + 新增 7 家厂商（含 JEV/TypeSafe AI）**

  **一、用户指出的「没有统一规范」确认属实（这是本批最重要的一条）**

  用户原话：「这俩实际是一个东西吧？」「我看豆包，质谱那几个刚开始做的，
  都是正常的逻辑，后面的就不对劲了，咋没有统一规范呢？」
  盘完 26 个厂商后确认：登录方式**分裂成了三套互不一致的形态**——

  | 时期 | 厂商 | loginModes | 弹窗表现 |
  |---|---|---|---|
  | 早期（对） | GLM / 豆包 / 通义 | `["browser"]` | 一个「浏览器登录」，**正常** |
  | 早期（对） | Kimi / DeepSeek | `["paste"]` + entryUrl | 一个入口，面板里**自带**抓取按钮 |
  | **后期（跑偏）** | MiMo / MiniMax / StepFun | `["paste","capture"]` | **裂成两个按钮**，且 capture 无渲染分支 → **点进去空白表单** |

  用户判断「这俩实际是一个东西」是对的：`capture` 就是 `paste` 面板里那个
  「打开登录页自动抓取」按钮 —— 我后期把它拆成了独立模式，而前端从未为它
  写渲染分支，于是成为一个点进去什么都没有的死按钮。
  修法（归一成一个入口 + 面板内可选的抓取）：
  · 前端过滤掉 capture，每个接入方式只出一个登录选项；能自动抓取的
    （有 entryUrl/canCapture）标签直接叫「浏览器登录」（主路径本来就是它）；
  · 后端 channel-types 三处 `["paste","capture"]` → `["paste"]`；
  · 后端 relogin 模式列表移除与 paste 并列的独立 capture 项。
  线上 UI 验收 19/19：六个厂商都只剩一个登录入口、面板有内容（按钮/输入框）。

  **二、新增 7 家厂商**（调研 + 服务器直连实测，端点真实性全部验证过）

  · **TypeSafe AI（Jev）** —— 需要**新适配器**，因为它刻意不兼容 OpenAI：
    它是「System One 判定模型」，**不生成文本**，输入 state + 类型化问题
    （`noul` 是/否、`choice` 多选上限 255、`score` 评分），输出类型化判断 +
    概率 + 置信度。单端点 `POST /v1/systemone`，请求 `{state, model, questions}`。
    适配器做双向转换：messages → state + 问题（未给结构化问题时自动构造 noul，
    让 Jev 对陈述做判定并给出概率）；answers → 可读文本（含概率），
    结构化结果同时回传供上层取用。
    **计费关键**：官方输出免费，故 `completion_tokens` 恒为 0、只按输入
    $0.042/M 计价 —— 按输出计价会凭空多收。
    官方约束：state + 最长问题 ≤ 32k、choice ≤ 255 项、中文准确率低于英文。
  · **LongCat（美团）**：**双协议**（`/openai` 与 `/anthropic` 两个端点，
    实测 `/anthropic/v1/messages` 返回 405 即端点存在），做成两个接入方式；
    1M 上下文。
  · **Chutes**（去中心化算力聚合）、**NVIDIA NIM**（Nemotron 3）、
    **Cerebras**、**腾讯混元**（Hy3）、**Meta Muse Spark**（1M 上下文）——
    都是 OpenAI 兼容，走既有 openai-compat。
  · 端点实测：typesafe 403 缺 key / longcat openai 401、anthropic 405 /
    meta 401 / cerebras 403 / hunyuan 401 / nvidia 200 / chutes 200。
  · **未复核项（已在代码注释标注）**：Meta 的官方文档站（dev.meta.ai）在
    本机与服务器**均连接超时**，其模型 id 与定价取自社区实现
    （CLIProxyAPI 配置），可能随官方调整 —— 请以官方控制台为准。

  **三、测试**：新增 `tests/typesafe.test.mjs` 31 项（端点推导、结构化问题解析、
  答案渲染、计费契约）。**单测抓出一个真缺陷**：`parseQuestions` 把
  `JSON.parse` 与 `normalizeQuestions` 放在同一个 try 里，导致
  「choice 超 255 项」的异常被当成「解析失败」吞掉 → 超限请求原样发给上游、
  拿回语焉不详的 422。已分离两个 try。

| 2026-09-22 | **第 50 批 · 清第 46 批复审全部条目 + 用户实时反馈修复**（提交 `a6ffa92`、`d592008`、`50db36e`、`789baba`）。

  **一、安全（第 46 批 P0，逐条已修，条目已从待办删除）**
  · **一键绑定跨厂商写入**：设备授权是厂商专属流程，而 `/devices/poll`、`/devices/claim`
    的目标渠道由调用方传 `channel_id` 决定 —— 两者原先零校验，等于允许「拿 Kiro 的授权
    结果覆盖 WorkBuddy 渠道的凭据」。现在会话与一次性 ticket 都记录归属厂商（vendor 取
    服务端会话值，不信请求体），写库前强制 `厂商 === 目标渠道类型`；建渠道路径也提前校验，
    避免「先建后删」（用户会看到渠道闪一下就没了）。
  · **凭据内 endpoint 外送 Bearer/PAT**：`openai-compat` 的对话路径原本直接 fetch，
    base_url 却可能来自**凭据 JSON**（Qoder 的 endpoint 就是）。现在所有出站请求统一走
    `guardedFetch`（请求前校验 + 逐跳重定向校验 + 60s DNS 缓存不拖慢网关）；
    Qoder 桥地址改走白名单（默认仅本机 127.0.0.1:8963，可用 `QODER_BRIDGE_ALLOWLIST`
    扩展，且只认服务端运维配置），凭据里写 `https://evil.example` 会在**导入时**就被拒。
    WorkBuddy 侧已核实安全：endpoint 只参与 realm 二分判定，base_url 恒为两个硬编码官方域。
  · **设备绑定轮询无并发互斥**：加会话级 `polling` 闸门，重复请求返回 pending；
    终态用 `sessions.delete` 的返回值判定唯一胜者（否则两次 success 会各写一次凭据互相覆盖）。

  **二、协议（第 46 批 P0/P1）**
  · 三协议「超 3 张图」短路分支原先写死 `chat.completion` 帧 —— Anthropic/Codex 客户端
    收到错误协议形状，报的是解析失败而不是「图片太多」。现在统一走 `protocol.openStream/
    delta/done/finish`（零用量收尾，不计费不污染日志）。
  · Anthropic thinking 改为**独立 content_block**：原先先声明 text 块、再往同一个块发
    `thinking_delta`（非法协议，SDK 会整段丢弃），且非流式**完全丢弃** reasoning。
    现在按需开块（thinking 块带空 thinking/signature，与官方流一致）、块开闭配对、
    空回复也给一个块，非流式返回独立 thinking 块。
  · Responses 顶层 `instructions` 转 system（原先整段丢弃 → 系统约束静默失效）；
    `response.completed` 补全 id/object/created_at/model/output（官方 SDK 用该事件
    替换本地 response 对象，缺字段会导致「流跑完但拿不到文本/模型名」）。

  **三、适配器（第 46 批 P1/P2）**
  · **HTTP 错误分类**（新增 `upstream/http-error.js`）：429 → `CHANNEL_RATE_LIMITED`
    （可自愈）、403 三分（风控验证页/权限不足/凭据失效）。此前 429 归普通 HTTP 错误、
    403 一律「凭据过期」，后果是冷却档位错 + 管理员对好账号反复重抓也修不好。
    `execute.js` 登记两个新错误码与冷却档位。
  · **内容级错误识别**（新增 `upstream/content-error.js`）：识别「用正常正文说错误」。
    线上实测抓到 Antigravity 把 `Gemini 3.5 Flash is no longer available...` 当正文返回，
    渠道测试写 ok=1 并重置冷却，而真实请求必然失败。现在 6 个出口（openai-compat、
    antigravity、mimo/minimax/stepfun-web）统一拦一道，命中抛 `CHANNEL_BIZ_ERROR`；
    带长度门槛防误杀（长回答里偶发出现同一词组不算）。
  · 用量估算标记：`splitTokens` 返回 `estimated`，透出到 `X-Tokens-Estimated` 响应头
    —— 估算值不再与精确值同口径展示。
  · MiniMax/StepFun 视觉能力按模型表声明（原先 `resolveModel` 一律 `vision:true`，
    带图请求会被送到纯文本档位，上游报的是含糊参数错误而不是「不支持视觉」）。
  · StepFun 帧诊断：未知 flags/坏 JSON/尾部残帧不再静默丢弃，内容为空时按类型给出
    `CHANNEL_BAD_RESPONSE`（解码错位）或 `CHANNEL_EMPTY`（上游真没说话）。
  · openai-web-ui 输入框判空前置：`target.evaluate` 原先在判空前调用，页面结构变化/
    未登录时抛原生 TypeError，绕过精心准备的现场诊断还会被当成基础设施故障。
  · **Gemini API 端点修正**：原先填裸域名 `generativelanguage.googleapis.com`，
    而 API Key 渠道统一走 openai-compat（拼 `/v1/chat/completions`）—— 实测该路径
    返回 **404**，即用户配好的 Google 官方 API 每个请求都必然失败。改用官方 OpenAI
    兼容层 `/v1beta/openai/chat/completions`（实测返回 400「请传有效 API Key」，证明
    路径存在且要求鉴权；兼容层同样返回真实 usage，计费也正确）。

  **四、渠道检测口径（用户实时反馈：「为什么响应时间这么长」）**
  · **首 Token 耗时成为展示与慢渠道判定口径**（新增 `channels.ttft_ms` 列）：
    原先只记总耗时，思考型模型（GLM/o 系列/R1）先吐几十秒 reasoning 再出正文，
    首字其实很快，却被判成慢渠道。现在**思考增量也计入首 Token**（用户原话：
    「思考的首 t 也算首 t 吧？」——对，模型在「想着」就是已经在响应了）。
    总耗时一并保留（吞吐与截断排查要用），前端悬浮同时给两个数。
    实机验证（真实本地 SSE 上游，非 mock 计时）：思考型 ttft=533ms / total=3092ms；
    快模型 ttft=46ms。
  · **逐渠道检测超时配置** `probe_timeout_sec`（0=默认，普通 90s / 浏览器渠道 240s，
    钳制 5s~30 分钟）：大档位（gpt-5.6 / glm-5.3）光思考可能几分钟，
    统一 90s 预算下每次都报超时；实机验证 6s 预算对 9s 上游确实超时且错误里报实际预算。

  **五、额度列（用户实时反馈：折叠规范）**
  · 折叠规则抽到 `components/quota-order.js` 作为**全局统一规范**：按窗口长度升序
    （5h → 1d → 7d → 30d）、**跳过已用完的递进到下一档**（「5h 完了就显示 7d」）、
    全部用完时仍显示最短的、未知长度排最后。窗口数不超上限时只排序不折叠（不藏数据）。
  · **必须从 tag 解析长度**：上游常常只给 tag（antigravity 的 `buckets[].window` 就是
    字符串），缺 `windowSeconds` 时递进规则整个失效 —— 预览截图里发现 5h 排在 7d 后面。
  · **余额/积分恒为第一个 tag**（用户要求：WorkBuddy/GPT free 带积分这种，
    折叠时余额显示为第一条）。
  · **`+N` 同时统计放不下的 chips 与折叠的窗口**：原先只算窗口，纯积分渠道
    （WorkBuddy 6 个积分包、无窗口）只显示前 3 个、既无 `+N` 也无处展开，
    剩下 3 个静默消失（预览截图发现）。折叠行只渲染一个 `+N`，悬浮列全量。
  · 调用记录小竖条换亮绿（`--green-bar`，L=73%）：原 `--green`（L=60.3%）在表格白底上
    发暗，几像素宽的小条尤其显脏。
  · **余额/积分常驻为第一个 tag**（用生产库真实快照渲染后发现）：#13/#14 的 free
    账号余额 1000、#42 的 119 积分原先全被 `+N` 吞掉，用户看不到还剩多少额度。
    改为单独摘出常驻（有额度条时在折叠行第一位、无额度条时在主行第一位），
    且不计入 `+N` 计数，保证计数与实际隐藏项一致。

  **六、前端（第 46 批新增问题）**
  · `PostDetailPage` / `ProfileViewPage` 永久骨架屏：两个并行 loader（主数据 + Tab 列表）
    共用一个 `useLatest`，同一 effect 里后者 token 更大 → 前者的结果恒被判「过期」丢弃，
    `setLoading(false)` 永不执行。拆成独立竞态令牌。
  · `ProfileViewPage` 关注 Tab 永远为空：判定写的是 `tab === "follows"`，而 Tab key 是
    `"following"`，分支不可达。
  · `ProfileViewPage` website 存储型 XSS：用户可编辑字段直接进 `<a href>`，
    填 `javascript:` 即可在访客上下文执行脚本。改用 `Markdown.jsx` 的 `safeHref`
    协议白名单，非法协议只作纯文本展示。
  · 消息/通知与游戏区 SSE：票据是**一次性**的（服务端消费即删），而 EventSource 内置
    重连会复用旧票据 → 必然 401、永久离线（GameZone 连 onerror 都没有）。
    改为 onerror 关闭旧连接 + 重新申请票据 + 指数退避（1s→30s，ready 后重置），
    cleanup 清定时器。

  **七、用户实时反馈的其他修复**
  · **新建渠道「先保存 / 先选模型」死锁**：点「从上游获取模型」提示「请先保存」，
    而保存又要求「请至少选择一个模型」—— 两个校验互相锁死。现在 `ModelPicker` 支持
    未保存时带表单里的 base_url + api_key 走 `/channel/fetch-models`，
    后端也允许模型范围留空（= 该厂商全部已注册模型，与反代/订阅路径、与
    `router.parseModels` 的口径一致）。
  · **登录方式标签歧义**：网页反代类渠道同时提供「服务器浏览器（自动抓取）」与
    「本机浏览器（登录后粘贴登录态）」两条路，原先都渲染成「浏览器登录」，
    同一厂商裂出两个同名按钮。现在按「谁在跑浏览器」明确区分，并补上「在本机浏览器
    打开登录页」按钮；GLM/豆包/通义原先只挂 `["browser"]`（连 paste 都没有，
    等于逼所有人走最重的那条），补为 `["browser","paste"]`。

  **八、模型定价（协作文档「待补录」项）**
  价格表 63 → 94 条。补齐 Codex/Grok 点名档位，新增 qwen-max/turbo/flash/3.7-max、
  gemini-3.8-flash/2.5-flash-lite、claude-sonnet-4.5/opus-4.5、glm-4.6/5/5.1/5v/4v/4.6v、
  上一代与轻量档（glm-4-flash 免费档等）、moonshot-v1 系列；并让 `getPrice`
  **剥离 `vendor/模型` 前缀**（OpenRouter/NIM 风格 ID 此前整片落到兜底价）。
  注册表里仅剩 12 个厂商占位名走兜底链。

  **测试**：新增 `security-bind.test.mjs`(35)、`audit46.test.mjs`(114)、
  `ttft-live.test.mjs`(22)、`pricing-coverage.test.mjs`(57)，扩展
  `gateway-protocols.test.mjs`(+17)；全量 **573 通过 / 0 失败**，
  `static-check` 120 文件语法与 import 全通。

  **线上部署已完成**（`3591f97`）：
  · 部署前先加 2G swap（/swapfile 并写入 fstab）—— 该机 3.5G 无 swap，
    文档记录过更新期间的 OOM 硬重启；
  · 在线更新 `5faa419 → 3591f97`，前端构建产物换新（build_id 已变），
    服务 active、`/api/status` 200、迁移已跑（`channels.ttft_ms` 列存在）；
  · 线上实测三个渠道的真实测试：`#7 首Token 1990ms/总 2455ms`、
    `#11 2506ms/2758ms`、`#8 GLM 12730ms/21070ms` —— GLM 的「思考 12.7 秒
    才出首字、总计 21 秒」正是用户问的那个现象，现在两个数分开呈现，
    不再把思考时长算成「响应慢」；
  · 用生产库导出的真实 quota 快照离线渲染，确认 Google 的 4 个额度条
    是真实数据（两组模型各 5h+weekly）而非显示异常，并据此发现
    「余额被 +N 吞掉」的缺陷（已修，见下）。

  **排查副产品（对以后有用）**：本次一度以为 SSH 被 fail2ban 封禁
  （握手 15s 后 EOF/Reset、间歇可用），实际是**本地 `/tmp/oosh2/` 下放了一个
  `inspect.py`，在那种 cwd 下运行的 Python 会优先导入它而不是标准库的
  `inspect`，导致 paramiko 报 `module 'inspect' has no attribute 'getmro'`**。
  重命名后连接立即稳定。以后遇到「同一台机器时通时不通」先怀疑本地环境。 |
| 2026-09-22 | **第 49 批 · WorkBuddy 深度修复 + 登录规范统一 + Kiro 独立 + 新增厂商图标**

  用户一次报了 8 个问题，逐个实测定位（全部在线上用真实账号验证）。

  **一、WorkBuddy：四个问题其实是一条链路上的四个断点**

  ① **绑定后点「添加」报错，但渠道已经出现在表格里**
    根因：绑定路径建渠道时 `other` 里还没有凭据（凭据在服务端等 claim 写入），
    而「订阅 OAuth 入池前凭据校验」强制执行 `adapter.verify` → 失败 → 接口 400，
    但渠道**已经 INSERT 成功**；前端因报错走不到 claim，凭据永远写不进去 → 死结。
    修：带 bindTicket 时跳过入池校验；渠道先以禁用态建出、claim 成功再启用
    （避免「无凭据渠道在池中被调度并连续失败」的窗口期）；
    claim 失败则删掉空渠道并明确报错。
  ② **重新认证还让选国内/国际**：WorkBuddy 的 realm 可由凭据 JWT 的 `iss` 自动判定，
    重新绑定不该再问；只有 Qoder 需要（它的区域决定 OAuth 端点，拿 token 前无法推断）。
  ③ **绑定后检测报 404**：实测真实端点是 **`/v2/chat/completions`**（不是 /v1）——
    `/v1/chat/completions`、`/v1/models`、`/v2/plugin/models` 全部 404。
    早期版本按社区文档写成 /v1，所以「绑定能成、一检测就 404」。
  ④ **有积分制却显示「不支持」**：实测积分接口
    `POST {billing域}/v2/billing/meter/get-user-resource` 返回 200
    （真实数据：TotalDosage 220、5 个积分包）。已实现并注册，额度列现在显示积分。

  重写适配器时实测确认的四个硬约束（都写进代码注释）：
  · **域必须与账号 realm 一致**：国际账号（JWT iss=workbuddy.ai）打国内域会被
    APISIX 网关 401（返回 HTML），**而这个 401 极像 token 过期** ——
    实测 token 有效期到 2027 年却一直 401，真因只是域错了；
  · **首条消息必须是 system**，否则 400 `code 11128`；
  · UA 必须**双段**（`CLI/x CodeBuddy/x`），单段被 `/v3/config` 以 12403 拒；
  · **头不能重复设置**：openai-compat 用大写 `Content-Type`/`Authorization`，
    我的 extra_headers 又放了一份，而 Fetch 的 Headers 对同名头是**逗号拼接**
    而非覆盖 → 实际发出 `Bearer A, Bearer A` → 必然 401。
    这个坑排查成本很高（同一 token 手打 curl 200、走适配器 401，
    一度怀疑头名大小写敏感，实测大小写本身无影响）。

  线上验收：测试渠道通过（回复正常）、模型清单 21 个、积分 119/220。

  **二、登录方式规范统一（用户：「没统一规范」）**
  盘 26 个厂商后发现登录方式分裂成三套：早期 GLM/豆包/通义用 `["browser"]`（对）、
  Kimi/DeepSeek 用 `["paste"]`+entryUrl（对），后期 MiMo/MiniMax/StepFun 写成
  `["paste","capture"]` → 弹窗裂出两个按钮，而 `capture` **前端没有渲染分支 → 空白表单**。
  用户判断「这俩实际是一个东西」是对的：capture 就是 paste 面板里那个抓取按钮。
  已归一：每个接入方式只出一个登录入口，能抓取的直接叫「浏览器登录」。
  线上 UI 验收 19/19。

  **三、Kiro 独立成厂商**（用户批评「workbuddy 都单独拉成厂商了，kiro 为啥寄居在 claude 里」）
  批评成立。归属该按「用谁的订阅/账号」定，不该按「跑什么模型」定：
  Kiro 是 AWS 产品、凭据 kiro-auth-token.json，与 anthropic 下的 claude-oauth
  （Claude Code CLI 凭据）是两条完全不同的链路。已提为独立厂商「Kiro（AWS）」，
  vendor 仍标 anthropic（模型归属 ≠ 账号归属）。
  连带修：厂商列表图标原取 `vendor`，导致 Kiro 显示成 Claude 图标 ——
  新增下发 `icon`（取厂商 key），两者语义分开。

  **四、新增厂商图标（用户：「你刚刚新增的厂商图标呢？都测试了吗？」）**
  实测确认批评成立：7 个新厂商**全部掉到平台 logo**。
  下载过程又踩了一次「加了不测试」：第一版直接抓官网 favicon，
  **7 个里只有 1 个是真图标**，其余 6 个拿到 HTML/占位图（文件大小与 Content-Type 都正常，
  看着像成功）。渲染成对照图人工核对才发现。
  改用 Google favicon 服务 + PNG 魔数校验，重下后渲染对照图逐一确认。
  Meta 暂无可用官方图标，用平台 logo 兜底并在注释标明。

  **五、其他**
  · OpenCode 凭据 tab 点了没反应：`credId` 对 API Key 型硬编码返回 `"api"`，
    而选项 id 是 `m.key` → GO（key=`go`）的 value 永远匹配不上选中态。已改为同源。
  · API Key 标题旁加「获取 Key」链接（用户要求）：25 个厂商写入官方取 Key 页面地址。
  · 新增 tests/workbuddy.test.mjs 23 项。

| 2026-09-24 | **第 51 批 · 人格测试 Round 1 挖出的 11 个缺陷（提交 `a6091aa`、`0293cd8`、`dc08141`、`d2e8260`）**。

  用户要求「开五个模拟真实用户，随机挑选功能使用及破坏，覆盖全场景；
  子智能体可在社区内给整个系统发帖抱怨/问题上报」。五个 AI 人格各带独立社区身份，
  全程只当用户、不动源码，在真实线上环境跑黑盒测试。

  **一、P0 引用泄漏：用户自己的图被平台永久锁死**（阿强 A2，实测复现）
  发帖时 `attachRef` 记了一行 `is_live=1` 的媒体引用，但**删帖只改 status、不释放引用**。
  后果链：删帖 → 用户删自己的图 → 409「该文件仍被 1 处引用，请先删除对应内容」→
  而那个"对应内容"正是他刚删掉的帖子，无法再操作。**媒体配额被永久占用，只能求管理员。
  **实测库内已积压 25 条**指向已删帖的活引用。编辑帖子移掉图片同样不释放。
  修法：`DELETE /posts/:id` 释放引用（隐藏 status=3 不释放 —— 内容还在可恢复）；
  编辑路径「先全部释放、再把当前这组重新绑上」（attachRef 对同一 slot 走 ON DUPLICATE 复活，
  两个方向都幂等）。另在 `POST /admin/recount` 里加了僵尸引用清理，
  管理员点一次「重算计数」就顺带修好存量，不必手工跑 SQL。

  **二、P0 模型白名单可被后缀绕过**（老张 A）
  分组白名单 `[deepseek-flash, deepseek-v4.1-flash]`，请求 `deepseek-v4.1-flash-thinking`
  → **200 且正常扣费**，而 `/v1/models` 里根本没有这个名字。
  根因：白名单判定用 `model.startsWith(白名单项)`（隐式前缀），
  而路由层在匹配渠道前会先 `modelForChannelMatch()` 去掉 `-thinking` 能力后缀 ——
  两边坐标系不同，于是从"后缀"这一侧漏过去。
  更严重的是这个写法意味着**白名单项自带整个前缀空间的授权**：
  上游哪天新增 `deepseek-v4.1-flash-super`（更贵的另一个模型）会被静默放行。
  修法：新增 `models.js#canonicalModelName`（解析别名 + 去能力后缀 + 小写）与
  `modelInAllowList`，**四处判定（/v1/models、selectChannels、explainNoChannel、
  密钥 model_limits）全部改为调用它**，通配只能由管理员显式写 `glm-*`。
  顺带修 `isModelPriced` 也认同规范名（只做加法，不会让真没配价的模型蒙混放行）。

  **三、P0 令牌 used_quota 漏记站内对话**（老张 B，两本账对不上）
  站内对话调的就是用户选的那把 Key，usage log 里 98 条全挂在它名下，
  但只有网关那条路写 `tokens` 表，chat 这条路只写 `users`
  → 令牌管理页的「已用」少算，实测差额 14 单位（= 该 Key 名下所有 browser/chrome 渠道日志合计）。
  后果：按令牌额度做预算/限流的调用方守不住。
  修法：chat 结算同步 `UPDATE tokens SET used_quota/remain_quota`；
  并在 `/run` 入口补上密钥额度检查（与网关 `insufficient_quota` 同口径）。

  **四、P1 密钥额度并发失效**（阿强 A3 / K 各报一次）
  `remain_quota=1` 的 Key **并发 20 次全部通过**（账户侧没少扣钱，但单 Key 预算阀门形同虚设）。
  根因：入口只检查 `remain_quota > 0`，扣减在请求**结束**的结算里，中间无预占，
  同一瞬间的 N 个请求看到同一个非零余额。
  修法：新增 `services/token-quota.js#holdTokenQuota` —— 入口**原子预占** 1 个单位
  （判定与扣减写在同一条 SQL 的 `WHERE remain_quota >= 1`，并发下只有一个能过），
  结算时加回再扣实际用量（净效果 = 只扣实际），未走到结算则 `finally` 退回。
  `consume()/refund()` 互斥，防止额度凭空变多。预占 1 个单位而不是预估花费：
  真实花费要等上游 usage，猜大了会误拒正常请求、猜小了照样能绕。

  **五、P1 /v1/messages 不认 x-api-key**（老张 C）
  官方 Anthropic SDK 默认**只发 x-api-key、不发 Authorization** → 直连本平台必然 401。
  协议壳（SSE 事件序列、content 分片数组、system block 数组、thinking block）
  全都做对了，就差这一个头，等于把官方 SDK 用户整个挡在门外。
  修法：authorize 认 x-api-key（两头同时存在时以 Authorization 为准，**不合并**——
  同名头合并成逗号串是踩过的坑），401 提示同时给出两种方式。

  **六、P1 报错回显映射后的模型名**（老张 D）
  写 `deepseek-chat` → 报「没有可服务模型『deepseek-flash』的账号」。
  用户会去查一个自己根本没写过的名字。修法：`explainNoChannel` 加 `displayModel`，
  execute 传原始请求名，message 一律回显用户写的那个。

  **七、P1 媒体解析失败把裸 MySQL 错误吐给用户**（老张 E）
  畸形 PNG（IHDR 写 `0xFFFFFFFF`）→ `Out of range value for column 'width' at row 1`。
  用户看不懂，还顺带泄露表结构。修法：`imageSize` 加 `MAX_DIM=100000` 钳制，
  超限视为解析失败返回 0。

  **八、P2 三个校验缺口**
  · **评论可伪造 `reply_to_user_id`**（K）：任意指定就能以自己名义给**任意用户**投递
    「回复了你」的通知（对方不必参与过这个帖子）。修法：有 `parent_id` 时**按父评论作者重算**，
    没有 `parent_id` 却带了 `reply_to_user_id` 直接拒。想 @ 帖子里没回复过的人走正文 @用户名。
  · **8 个空格能设成密码，还能用它登录**（阿强 B5）：长度够了、纯数字/纯字母检查也"通过"了，
    唯独没人管是否可见字符。修法：改密与注册都拒全空白（**不 trim** —— 空格是合法字符）。
  · **超长内容静默截断却返回「成功」**（阿强 B1）：标题 1502 字 → 200「发布成功」、落库只剩 120；
    正文 25000 → 截成 20000；评论 3000 → 截成 2000。内容类接口截断比报错更糟
    （用户不知道要重发）。修法：新增 `tooLong()` 校验，超限返回 400 + 明确字数。
  · **编辑帖子接受不存在的话题**（K）→ `post_count` 加到不存在的 id 上、计数漂移。
    修法：改话题前先确认目标话题存在且启用。
  · **`Infinity`/`1e400` 型参数 → 500**（阿强）：`Number("Infinity")` 是合法数字，
    `|| 0` 拦不住，进 SQL 被 mysql2 转义成字面量 → 语法错误。修法：过 `safeInt`。

  **九、已确认**正面的部分**（同样重要，说明哪些别改坏了）**
  越权 40+ 用例、垂直越权 25+ 端点全部正确拦截（含自我提权 `role=1000` 落库仍是 1）；
  余额扣减原子精确（20 并发恰好扣 20，无丢更新无透支）；
  并发点赞/收藏计数不漂移；分时定价边界（周一北京 12:00、周六）正确；
  三种协议的 SSE 事件序列与错误体形状与官方一致；空消息/双击发送/发帖连点都挡住了。

  **十、线上验证（部署 `d2e8260` 后在真实环境实测，全部通过）**

  | 缺陷 | 实测结果 |
  |---|---|
  | 引用泄漏 | 发帖带图 → 删帖 → **用户能删掉自己的图**（旧代码 409） |
  | 白名单后缀绕过 | 白名单外用 `glm-5.3` → 403「分组限制了可用模型」；白名单内 `-thinking` 仍可用 |
  | x-api-key | 只带 `x-api-key` 不再 401；不带 Key 仍 401（没放松） |
  | 报错归因 | 写 `deepseek-chat` → 报错里就是 `deepseek-chat` |
  | 媒体宽高 | 畸形 PNG 上传成功，**不再出现 `Out of range for column`** |
  | 静默截断 | 1502 字标题 → 400「标题最长 120 字，当前 1502 字」 |
  | 通知伪造 | 无 `parent_id` 却传 `reply_to_user_id` → 400「回复目标不正确」 |
  | 空格密码 | 8 个空格 → 400「密码不能全是空格，请包含可见字符」 |
  | 不存在话题 | `topic_id=999999` → 400「话题不存在」 |
  | Infinity 参数 | `?topic_id=Infinity` / `?user_id=Infinity` → 200（旧代码 500） |
  | **额度并发** | 限额 1 单位的 Key 并发 20 次 → **通过 1、被拒 19**（旧代码 20/20 全过） |
  | **令牌计费** | 站内对话后 `tokens.used_quota` **0 → 3**（旧代码不动） |

  存量脏数据已清：**僵尸引用 25 → 0**、媒体 `ref_count` 漂移 0、话题计数漂移 0。

  **十一、回归锁**：新增 `tests/persona-r1.test.mjs` 41 项（每条缺陷一个断言 + 12 个文件语法校验）；
  `tests/group-visibility.test.mjs` 从 15 项扩到 18 项（新增「白名单不能被前缀绕过」结构性断言）。

  **十二、验证过程中额外发现（第 51 批补 3）**
  按「限额 1 单位」建 Key 后并发 20 次**全部通过**，一度以为预占没生效 ——
  实际是 `POST /api/token` 的 `unlimited_quota` **默认 true 且被静默采用**，
  于是用户设的 `remain_quota:1` 被无声忽略，建出来的是一把无限额度的 Key。
  前端表单两个字段一起提交所以从未暴露，直连 API / 脚本必踩（我这次就踩了）。
  语义已改为：显式传 `unlimited_quota` 就听它的；没传但传了 `remain_quota`
  就视为有限额度；两者都没传才是无限。更新接口同口径，
  但只在「当前无限 + 给了正数额度」时自动切换，避免意外把无限改成有限。

| 2026-09-24 | **第 52 批 · Mia（设计师人格）的报告：1 个 P0 + 手机端四个实测问题（提交 `704c65e`、`ad51314`、`98075c5`）**。

  **一、P0 站内消息「发起会话」100% 失败**（单聊、群聊都发不出去）

  Mia 的复现：`/messages` → 发起会话 → 搜到人 → 选中 → 点创建 →
  单聊 toast「请选择聊天对象」（明明已经选中了人）、
  群聊 toast 直接甩 JS 内部串 `(X.user_ids || []).map is not a function`。

  根因（她打的 DOM 实测 + 我读码确认）：成员选择器是**单值** `Select`
  （`.ant-select-single`），而表单字段名是 `user_ids`（复数），
  提交处按数组取用：
  ```js
  v.type === "single" ? {user_id: Number(v.user_ids?.[0])}          // 标量[0] → undefined → NaN → JSON null
                      : {user_ids: (v.user_ids || []).map(Number)}  // 标量.map → TypeError
  ```
  两个用户可见症状由此完全对应。

  修：`Select` 加 `mode="multiple"`（单聊再加 `maxCount=1`，与已有的
  「单聊只能选择一位成员」校验互补），提交处加形状兜底 ——
  字段形状意外变化时报「请先选择一位成员」，**不再把引擎报错当人话弹给用户**。

  验证：后端接口实测单聊建/复用、群聊建、邀请成员、跨账号收发消息全部通过
  （6/6，含「重复发起复用同一会话」的幂等性）。

  **二、手机端四个布局问题**（她在 390×844 视口逐个量了数字，我独立复现，数字一个不差）

  | 问题 | 她的实测 | 我的独立复现 |
  |---|---|---|
  | 对话输入框被挤瘪，placeholder 压成 4 行竖排 | textarea 66–135px | **135px**（吻合） |
  | 令牌表格：首屏只看到「名称/操作」 | 表 1480px / 屏 370px | **innerTableW=1480** |
  | 使用记录：模型名被切 `deepseek-v4.1-fl` | 单元格 145 / 内容 158px | 同 |
  | 看板余额被切成「200.00 0…」 | 溢出 6px | 同 |

  修法与实测结果：

  · **对话输入框**：`.bui-composer-row` 是单行 grid，固定列（附件 28 +
    模型选择器 93 + 发送 28 + 间隙）在 390px 上吃掉 193px，只剩 135px 给输入框。
    改 ≤560px 为两行布局（输入框独占第一行）→ **135 → 328px**。
  · **令牌表**：给「已用/分组/可用模型/创建时间」加 `responsive`（手机上收起），
    密钥列 280→150（**保留复制按钮**，它是这页的主操作）→
    可见列 **2 → 3**、表宽 **1480 → 702px**。
  · **使用记录**：模型列手机上 145 → 190px（这是本页最该看全的一列）+ `title` 兜底
    → 实测 cellW=191、**不再截断**。
  · **看板数字**：`.oo-stat-card-num` 原为 `nowrap + ellipsis`（截断的根源），
    改 `flex + wrap` 并新增 `.oo-stat-card-value` 包裹数字 →
    窄屏下是「单位换到第二行」而不是把数字切一半，实测所有卡片 overflow=0。

  一处**自己踩的坑**（记下来避免重犯）：第一版只加了 `responsive` 却没改
  `scroll={{x:1480}}` —— 那是「9 列全在时的宽度之和」，收起列后表格仍被撑到 1480px，
  等于 responsive 白做（实测 totalCols=6 但 innerTableW 仍是 1480）。
  第二版又漏了「创建时间」没加 responsive（白占 160px，1012 = 852+160）。
  现在 `scroll.x` 由 breakpoint 计算且与列宽表达式**共用同一份常量**，不会再对不上。

  **三、同批一并修的另一个体验问题**
  Mia 报「切到能用的密钥后一刷新就被踢回默认密钥，输入框直接禁用」。
  根因：`loadMeta()` 不带 keyId，服务端回落到「第一把可用密钥」，
  若那把没有可用模型，页面一进来就是「当前密钥没有可用模型」+ 禁用。
  修：选中的密钥 id 记进 `localStorage`（**偏好，非权限依据** ——
  服务端仍校验归属与可用性），刷新后接着用。

  **四、Mia 报告里我未处理的部分**（登记为待办，见第 3 节）
  · 暗色模式空状态插图几乎不可见：SVG 硬编码 `fill="#000000"`，
    暗色下与面板对比度约 1.1:1（她给了实测色值 `#141414` vs `#202024`）
  · 320px 视口整页横向滚动（`scrollWidth 335 > 320`），顶栏昵称/头像顶出屏幕、面包屑换两行
  · 首页头部品牌名被裁成「OO…」（`cw 46 / sw 56`）
  · 社区摘要漏 Markdown 原文（`**问题**：…`）+ 高度被硬裁 18px
  · 截断处普遍没有 `title`（对话页会话标题/能力栏、媒体库文件名）
  · 手机端触控目标偏小（26×26 / 28×22，低于 44px 的通行标准）
  · 聊天附件缩略图仅 20×20（贴 8 张图完全认不出哪张）
  · 空状态温度不均（通知页文案是模板级，使用记录只有「暂无记录」）

  她的原话值得记下来：「我能理解后台类页面优先保桌面，但至少给个
  『手机上本来就这样』的提示，或者让数字自己缩小」—— 这条现在做到了。

| 2026-09-24 | **第 53 批 · 清掉 6 项已登记待办（提交 `408fe0b`、`0eadbe4`、`e785313`）**。

  这 6 项都是 Round 1 人格测试报告里登记过的，每项都带原始实测数字。

  **一、`/v1` 未实现端点返回 HTML 错误页**（老张）
  `/v1/embeddings`、`/v1/completions`、`/v1/images/*` 返回
  `<pre>Cannot POST /v1/embeddings</pre>`，`GET /v1/chat/completions` 也是。
  SDK 按 JSON 解析会抛出语焉不详的解析错误，把「没做这个功能」
  误报成「服务端返回垃圾」。修：`/v1` 与 `/api/v1` 加 JSON 兜底 404，
  响应体里**列出本平台支持的端点**，一眼分清「没这功能」还是「路径写错了」。
  实测：`POST /v1/embeddings` → 404 + `code: endpoint_not_supported` + 端点清单。

  **二、注册限流把第一次来的人挡在门外**（阿强）
  原话：「**第一次**打开站点点『创建账户』就吃 429『请 78 秒后再试』」——
  因为同 IP 已有别人注册过。办公室/NAT/校园网下第一批用户会集体卡住，
  而这是他们见到平台的**第一屏**。
  修：限流中间件新增 `skipSuccessful`（只在 `res.statusCode >= 400` 时计数），
  注册改为两层 —— 失败 5 次/5 分钟（真正的滥用信号）+ 总量 30 次/小时
  （兜底防「无限量注册」）。行为用**真实 HTTP** 验证：
  `tests/ratelimit-skip.test.mjs` 3/3（连续 6 次成功不触发；第 4 次失败才 429；
  对照组证明开关真的起作用）。

  **三、暗色空状态插画几乎不可见**（Mia：对比度 1.1:1）
  这个我**改了两遍才对**，两次都是「改了没测」的典型：

  · 第一版把 `colorFill` / `colorFillQuaternary` 写进 `components.Empty` ——
    实测无效，插画仍是 `rgb(20,20,20)`。
    根因：`Empty.PRESENTED_IMAGE_SIMPLE` 读的是**全局** `useToken()`，
    不是组件级覆盖。
  · 第二版挪到全局 token 层 —— 实测变成 `rgb(0,0,0)`，对比度 1.15:1，
    只是从「近黑」变成「纯黑」。
    根因：调色板全是 `oklch()` 字符串，而 AntD 的颜色合成用
    `@ant-design/fast-color`，它**不认 oklch**，解析失败就退化成纯黑。
  · 第三版新增 `presets.js#oklchToHex`（CSS Color 4 标准矩阵），
    把要交给 AntD 参与计算的 token 先转 hex。

  最终实测：填充 `#27282b` / 描边 `#2e3033`，**亮度高于面板底色**
  （fill lum 0.0212 > bg lum 0.0177）—— 是「浅浅浮起」而不是黑块；
  亮色下 `#f2f2f3` 同理。截图肉眼确认过（插画能看出箱体轮廓）。

  **四、手机端触控目标偏小**（Mia：顶栏 26×26、分段控件 28×22、分页 30×30）
  修：`≤767px 且 pointer:coarse` 时放大命中区域到 36~40px，
  只改 `min-width/min-height`（视觉尺寸不变，只让手指更容易点中），
  桌面不受影响。实测顶栏按钮 26×26 → **40×40**。
  顺带：聊天附件缩略图 20×20 → 36×36（原话「贴 8 张图完全认不出哪张」）。

  **五、320px 视口整页横向滚动**（Mia：`scrollWidth 335 > 320`）
  修：加 `≤380px` 断点 —— 昵称只留头像（`.oo-user-name` 隐藏，头像仍可点）、
  面包屑收成单行、首页品牌名不再被裁成「OO…」、
  `POST /v1/chat/completions` 徽章允许换行。
  实测 4 个页面（/console /chat /token /）**溢出全部为 0**，芯片右边界 304 < 320。

  **六、信息流摘要漏 Markdown 标记**（Mia）
  列表页显示字面量 `**问题**：在手机（390 宽）打开…`；小游戏规则区同样漏
  `**胜负与合法性全部由服务端判定**`。
  修法分两处（根因不同）：
  · 社区摘要：后端新增 `summarize()` 在**服务端**剥掉代码块/加粗/标题/列表/
    引用/表格/链接/图片等标记再截断 —— 摘要会进信息流、搜索结果、
    将来的邮件与推送，任何消费端都不该再处理一遍标记。
    截断改为在标点/空白处收尾（原来会把词切成两半）。
    用 5 个真实样本验证（含 Mia 那条原文），实测列表 40 条摘要零泄漏。
  · 小游戏规则区：那是**纯文本展示区**、不是 Markdown 容器，却写了 `**` 当强调。
    改用 `<b>`，并加通用断言「JSX 文本节点里不该有成对的 `**` 强调」
    （先剔除注释再判定）。

  **七、顺带修的一个自造缺陷**
  批量隐藏 24 条测试探针帖时发现：`moderate`（隐藏/恢复）**不维护话题计数**，
  隐藏后「综合讨论」显示 25 帖、实际只剩 2 帖。
  连带修删除侧的镜像缺陷：原来**无条件** `post_count - 1`，
  而隐藏已经减过一次，删一个已隐藏的帖子就重复扣减（计数低于真值且回不来）。
  现在只在「从 status=1 删」时减。
  教训：**「改 status 的地方都要跟着改计数」** —— 社区里现有三处
  （发帖/删除/moderate），少一处就漂移。

  回归锁：`persona-r1.test.mjs` 42 → 50 项；新增 `ratelimit-skip.test.mjs` 3 项。

| 2026-09-24 | **第 54 批 · Round 2 五人格报告：3 项硬伤 + 1 个我自己造的 P0（提交 `293f27d`、`0cfbcee`、`5a42718`、`13be2be`）**。

  Round 2 换了五个新人格（大学生 / 海外开发者 / 运维 / 产品经理 / 社交型用户），
  五人全部回报。本批处理最要命的三项。

  **一、P0 `/messages` 整页白屏 —— 我上一批引入的，两个仪表盘同时报上来**
  产品经理与运维人格各自独立撞到：`#root` innerHTML 长度 **0**，纯白页，
  控制台 `ReferenceError: getFieldValue is not defined`。
  根因：`getFieldValue` 只存在于 `<Form.Item shouldUpdate>` 的 render prop 作用域，
  我在 Select 那一层直接调了它 → 整棵 React 树崩溃。
  修：改用组件顶部的 `Form.useWatch("type", form)`。

  **我的流程失误比这个 bug 更值得记**：上一批修「发起会话失败」时，
  我只验证了**后端**（跑 verify_msg.py 6/6 通过），没打开页面看一眼 ——
  而当时的浏览器脚本其实已经报出 `{'opened': false}`（没找到按钮），
  我判断成「选择器没匹配上」放过去了，那正是白屏的信号。
  更该反省的是：仓库里**早就有** `tests/ui-smoke.mjs`，注释里明确写着
  「本项目已因此栽过两次（MainLayout / AdminChannelsPage）」，而我没跑它。
  本次实测它对线上版本准确报出 `FAIL /messages 渲染=0 ERR: ReferenceError: getFieldValue is not defined`。
  **门禁有效，是执行漏了** —— 从本批起：改前端组件必须跑 ui-smoke。

  **二、P0 输出上限在三种协议上全部失效**（海外开发者人格）
  同一 prompt：`max_tokens: 8` 与 `max_tokens: 4096` 都返回 **88** 个 completion token。
  他的判断很准：「max_tokens 是成本控制最被信任的旋钮；任何依赖
  `finish_reason == "length"` 判断截断的 agent 循环永远看不到该值。」
  修在**网关层**（唯一收敛点）：本平台大量渠道是网页版反代，
  上游根本没有这个参数可传，所以在 onDelta 里按估算截断。
  三个协议的字段名都解析（`max_tokens` / `max_completion_tokens` / `max_output_tokens`），
  截断信号按各自规范给（`length` / `max_tokens` / `response.incomplete`），
  计费按**实际发给客户端的内容**算（用户设上限就是为了省钱）。
  实测：`max_tokens=8` → **恰好 8 个 token** + `finish_reason: length`；
  20 → 20；4096 → 完整 88 + `stop`。

  **三、P1 审计日志的客户端 IP 可伪造**（运维人格）
  带 `X-Forwarded-For: 203.0.113.77` 调用，落库的 ip 就是它。
  根因在 nginx：`location /` 那一档（`/v1/*` 走的正是它）**完全没设 XFF**，
  客户端自带的头被原样透传；而 `.env` 没配 `TRUST_PROXY`，
  Express 用默认 loopback 信任代理 → 取到伪造值。
  修：nginx 的**每个** location 都改成 `X-Forwarded-For $remote_addr`（覆写而非追加）。
  实测：伪造 → 落库 127.0.0.1；公网直连 → 落库真实 `47.79.85.60`。

  **四、P2 `request_id` 没暴露，两条日志无法关联**（运维人格）
  「两页都没有 request_id，我只能下 SQL 才看出来是同一次调用」。
  客户端提前断开时一次调用会产生两条记录（计费行 + 错误行），
  request_id 是唯一的关联键。已加进接口与详情抽屉；错误行也带上
  部分结算的金额与 token（原先全 0，看不出这次其实花了钱），
  文案区分「客户端提前断开 / 上游中断 / 超时」。

  **五、我自己造的第二个 P0：`estimateTokens is not defined`**
  给 max_tokens 加截断时用了 `estimateTokens(...)` 却忘了加 import。
  后果链条极隐蔽：ReferenceError → 适配器当渠道故障 → 标记 CHANNEL_ERROR
  并冷却 → 用户看到 503「账号都在冷却中」。**症状与根因看起来毫无关系。**

  为什么现有门禁全没拦住（值得记住）：
  `node --check` 只做语法分析不做作用域解析；`vite build` 不管后端；
  `undefined-symbols` 的模块加载检查也抓不到 —— 引用在闭包里，不调用不抛
  （我注入破坏验证过，确实是假绿灯）；服务健康检查 200、进程 active。

  我试过写「正则扫未定义调用」，失败得很彻底：要给 Promise 的 `resolve(`/`reject(`、
  对象简写方法 `view(state, {…}) {`、动态 `import(`、参数解构逐个开豁免，
  最后仍有十几处误报 —— **一个会误报的门禁等于没有门禁**，正则做不了作用域分析。
  改用可靠的判据：新增 `tests/gateway-smoke.mjs`，对**三种协议各打一次真实请求**，
  断言响应里不出现 "is not defined"、形状正确、未实现端点是 JSON 404。
  它**确实抓到了**：部署前跑第一条就报
  `chat/completions: 网关内部抛了未定义标识符 → {"message":"estimateTokens is not defined"}`。
  **门禁的有效性用真实事故验证过**，不是又一个假绿灯。

  另给 `undefined-symbols` 那条补了**诚实划界**的注释：它只能抓顶层引用，
  闭包里的未定义标识符要靠真实调用覆盖，别再对它抱错期望。

  回归锁：新增 `max-tokens.test.mjs` 22 项 + `gateway-smoke.mjs` 9 项。

| 2026-09-24 | **第 56 批 · 用户改动入库（删小游戏 + 好友系统 + 消息页重构）+ 评论带图（提交 `656da43`）**。

  **一、用户的改动（本次一并提交上线）**
  · **小游戏模块整体下线**：路由 `routes/games.js`、服务 `services/games/*`（7 个文件）、
    前端 `components/GameZone.jsx`、两个测试文件全部移除，共删约 3900 行。
    `/api/games` 从挂载与 body-parser 白名单中摘除，`route-mounting` 测试同步改为
    **断言它不再挂载**（防止将来误加回来）。实测 `/api/games/*` 现在返回 404。
  · **新增好友系统** `routes/friends.js`：申请 / 列表 / 备注 / 一键私聊。
    实测 `GET /api/friends` 与 `/api/friends/requests` 均 200。
  · **MessagesPage 大幅重构**（1854 行变动）+ styles.css 配套样式。

  **二、评论带图（用户要求：「评论也要能带图」）**
  原先评论只有 `content` 字段、表里没有 media 列 —— **只有帖子能带图**。补齐整条链路，
  与发帖同一套做法（字节进媒体库，行里只存 id 列表）：

  · **db.js**：建表语句加 `media_ids` 列 **+** `ensureColumns` 里的列迁移。
    两条都要写 —— 线上表已存在，`CREATE TABLE IF NOT EXISTS` 不会补列
    （这是本项目反复强调过的坑）。实测部署后列已补上。
  · **创建**：校验图片**归属**（不校验就是之前社区发帖那个越权漏洞的同一形态）、
    放开**纯图评论**（「这张图你看」是常见用法）、无字无图仍拒。
  · **读取**：列表返回 `media`（现签 URL），一级与二级评论都渲染缩略图。
  · **引用管理**（最容易漏的一环）：
    - 建评论时 `attachRef`（`community_comment`）
    - 删评论时 `releaseRefs`
    - **删帖时也要释放其下所有评论的引用** —— 评论的 ref key 与帖子是两套，
      **不会自动级联**；不处理的话帖子连带评论都没了、而评论里的图仍挂着活引用，
      用户删自己的图会 409 且找不到是哪条内容占着
    - `admin/recount` 增加「已删评论」僵尸引用清理（存量数据），
      返回体加了 `released_comment_refs`
  · **前端**：评论框加图片入口、支持**直接粘贴截图**（截图→Ctrl+V 比点按钮选文件快）、
    缩略图可单张移除、最多 3 张。

  **三、验证（12 项真实 HTTP 全过）**
  上传图 → 带图评论 → 读回 media → 纯图评论 → 无字无图被拒 →
  **跨用户引用被拒（403）** → 删一条评论后仍被另一条引用（**409 正确**）→
  两条都删后可删图 → 删帖后评论里的图也能删（**级联释放生效**）。
  其中一条检查我最初写错了断言（以为两次上传会得到两个 media id），
  实际媒体库按 sha256 去重、同一用户同图只占一行 —— **是测试的前提错了，不是代码错了**，
  已在测试里写明这一点。

  **四、顺手修的两处**
  · `ChatPage` 里我自己上一批写的引导文案用了 `**不是你的配置问题。**` ——
    那个容器是纯文本、不渲染 markdown，星号会原样显示。已改 `<b>`。
  · 把原本只查 `GameZone` 的「非 markdown 容器别写 markdown」断言**扩成全站扫描**
    （游戏没了，但这条约束与游戏无关）。**扩范围后立刻又抓到上面那一处** ——
    正是扩它的价值。persona-r1 测试 50 → 53 项。

| 2026-09-24 | **第 57 批 · Round 3 启动（5 个新人格）+ 评论带图 UI 实测通过**。

  **Round 3 的五个新人格**（这一轮用户特别要求「不要太官方和 AI 味」，
  所以每个人格都被明确要求用口语、不要写报告体）：
  · 小周不想写论文（大四学生，爱吐槽、有点丧）
  · 老王自己干（独立开发者，务实精算、社区活跃）
  · 小林今天也很困（测试媛，爱整活、话痨）
  · 阿May带队（10 人小团队负责人，管理者视角、只管账与限额）
  · 阿蓝画不完（自由插画师，对画面/排版敏感，专看视觉）

  本轮要求：**发帖带截图、评论也带图**（评论带图是本批新上线的能力），
  并重点覆盖刚上线的好友系统。

  **评论带图的真实 UI 实测**（我自己跑的，确认人格们依赖的链路可用）：
  · 评论框有「图片」按钮 ✅
  · 选图后**确实上传进了媒体库**（实测媒体库新增 community 来源记录）✅
  · 发出后 **DB 里 `media_ids` 非空**（`[112]`）✅
  · 页面**渲染出 88px 缩略图**（与我在 PostDetailPage 设的评论缩略图尺寸一致；
    帖子图是 56px，两者不同，可据此区分）✅
  · 截图肉眼确认：评论「UI带图评论820386」下方就是那张紫色测试图 ✅
  · 删靶帖后**评论图的引用被连带释放**（live_comment_refs=0，僵尸引用 0）✅

  这一步踩了个坑值得记：我最初让脚本「点社区列表第一条」进详情页，
  但列表第一屏全是人格们**已删除的测试帖**（status=2 → 已关闭评论），
  于是评论怎么都发不出去、断言全部失败 —— **看着像功能坏了，其实是我选错了靶帖**。
  改成显式传入一个开放帖 id 后全绿。

  本轮进行中的产出（截至记录时）：5 个人格全部注册并建 Key，
  已发出带图帖 6 篇、带图评论 2 条 —— **评论带图这个新功能真的被用起来了**。

| 2026-09-24 | **第 59 批 · 图标门禁 + MiMo 渠道凭据链路（提交 `771a02d`、`3e74358`、`b0dde39`、`e644d97`）**。

  **一、cursor / trae 图标（用户第二次反馈）**
  用户原话：「cursor 和 trae 的图标依旧是不对的，**为啥每次让你加新厂商就会出这问题**」
  —— 这句点出的是**流程缺陷**，不是某一次疏忽。查明：
  cursor / trae **根本不在** `CHANNEL_ICON` 表里，`public/icons` 下也没有文件；
  而 `CHANNEL_ICON[type] || PLATFORM_LOGO` 会静默回落到平台 logo，页面照常渲染 ——
  所以连续两次都只能靠人眼在渠道列表里发现。
  加一个厂商要改三处（`vendors.js` / `channel-types.js` / 前端图标表），
  **第三处漏了不报任何错**，这就是它反复发生的原因。

  修法分两步：
  · 补图标：取 cursor.com / trae.ai 的 favicon，并**逐个核对像素**
    （cursor 白底黑图形 128×128；trae 深底 + 品牌绿 `rgb(50,240,140)` 48×48）——
    不是只看文件大小（早先有过「7 个里只有 1 个是真图标」的教训）。
    已出**对照图**肉眼确认两者都与平台 logo 明显不同。
  · 加门禁 `tests/vendor-icons.test.mjs`（已进 `npm test`），五项：
    ① `VENDOR_ICON_KEYS` 清单里每个厂商都必须在 `CHANNEL_ICON` 里有映射；
    ② 映射的文件必须在 `public/icons/` 下存在；
    ③ 后端 `vendors.js` 的 channelType 反向比对，前端不能缺；
    ④ 图标必须过**图片魔数**校验（防「抓到 HTML 当成图片」，历史上真发生过）；
    ⑤ cursor / trae 的回归锚点。
    **用注入法验证过**：删掉 trae 的映射 → 立刻报
    「这些厂商没有图标映射，会静默回落到平台 logo：trae」。
    以后新增厂商漏图标会直接测试失败，不必等用户发现。

  顺带确认：`antigravity` 不是厂商位（它是 Gemini 的订阅接入方式，渠道 type 是 `gemini`），
  走 gemini 图标是对的，不需要独立图标。

  **二、MiMo 渠道「测试未实现」（用户实测）**
  用户原话：「小米 mimo 我添加了渠道，为什么要登录态是啥玩意？
  我这边拿到了 cookie 填写进去保存之后**测试链接显示未实现测试**？
  你不是说全部的厂商都正常工作吗？」

  查清后是**两个独立问题**，先说明确的：
  · **「要登录态」是正常的**：MiMo 的「网页对话」接入方式就是走小米账号 SSO，
    复制 Cookie（serviceToken / userId / xiaomichatbot_ph）——
    `pasteHint` 里写得很清楚。这是这类反代渠道的固有形态（同 GLM / 豆包 / Kimi）。
  · **「未实现测试」是真 bug**，而且是**三层叠加**，一层比一层深：

  **第一层：适配器解析不到。** 渠道存的是 `other.method = "relay"`（通用值），
  而 MiMo 的网页反代方法名是 `mimo-web`。于是：
  `methodOf()` 查不到 → 兜底 `"relay"` → `adapterKeyFor()` 查 `"relay"` 也查不到
  → 回落到 `channel.type = "mimo"` → **而 `ADAPTERS` 注册的是 `"mimo-web"`，没有 `"mimo"`**
  → 适配器 undefined → 「适配器未实现测试」，对话也不可用。
  渠道能建、能填凭据，就是不能用。
  修：`adapterKeyFor()` 在「按 method 查不到」时**回落到该厂商真正注册了适配器的方法**，
  而不是盲目拿厂商名当 adapter key。实测：
  `mimo+relay → mimo-web`、`minimax+relay → minimax-web`、`stepfun+relay → stepfun-web`
  （后两个是同类隐患，一并修了）、`deepseek+relay → openai-compat`（不变）、`kiro+kiro → kiro`（不变）。

  **第二层：凭据写回绕过了适配器。** `/channel/login` 的 relay 分支是按旧契约写的
  （「裸 token 存 api_key + 可选 cookies 数组存 other.cookies」），
  服务于 DeepSeek / Kimi / GLM 那批适配器；而新一批具名反代适配器
  （mimo-web / minimax-web / stepfun-web）的凭据形态是
  `other.service_token / user_id / ph` 这类**具名字段**。
  走旧契约的实测后果：`other_keys = ["method"]`（只有 method），
  `api_key` = 整个 JSON 串 —— 适配器读 service_token 读到空 → 永远 401。
  修：relay 分支里 `adapter.importAuth` 存在时优先用它。

  **第三层：即使交给适配器，解析也漏了两种真实形态。**
  · `parseAuth` 只认 `obj.cookies` 是**对象映射**，而浏览器扩展/抓取流程导出的是**数组**
    （`[{name,value},…]`）—— 数组形态下 uid/ph 能取到、唯独 token 取不到，
    报错还指向「凭据不完整」，最让人火大；
  · cookie 的**真实名**是 `xiaomichatbot_serviceToken`，而候选名只有 `serviceToken`。
  修：数组与映射统一归一，候选名补上真实名。

  **端到端验证**（建渠道 → 查字段 → 测活 → 清理）：
  ```
  凭据解析：other = {method:mimo, service_token:E2E_TOKEN_ABC, user_id:2892751303, ph:E2E_PH_XYZ}
            api_key 13 字节（就是 token 本身）—— 修复前是整个 JSON
  渠道测试：登录态已失效（401）← 业务错误（我用的是假 token，401 正是预期）
  解析器单测：数组形态 PASS、映射形态 PASS
  ```
  一句话：**之前是「适配器未实现测试」（系统故障），现在是「登录态失效」（数据问题）**
  —— 用户用真实 cookie 重填一次即可使用。

  **三、我自己的错（记录在案）**
  为了给媒体库加上传入口，我用脚本把 `onPickUpload` 移到 `load` 之后 ——
  脚本按「第一个 `);`」找块尾，**插进了 load 的函数体中间**，把它的 try 块切断，
  `/media` 整页白屏（`onPickUpload is not defined`）。
  这是我第三次在这个文件上出错（先 TDZ、再未定义、现在是切函数）。
  教训：**用脚本按文本边界搬代码块本身就不可靠**（边界会撞上嵌套），
  这类改动应当用编辑器精确替换，或搬完立刻跑 ui-smoke（这次正是它拦下的）。

  回归锁：`persona-r1.test.mjs` 82 项；新增 `vendor-icons.test.mjs` 5 项。

| 2026-09-24 | **第 60 批 · 凭据指引：把「登录态」换成每个厂商的具体字段（用户第三次为同一件事发火）**。

  **用户原话**：
  「cookie 就 cookie，token 就 token，哪个位置哪个参数，每个厂商都要对应官网核对清楚，
  你放个登录态输入框，用户也不知道是啥啊，而且你上面写一堆小字说要干嘛干嘛，
  也没明确说到底是啥啊」

  **批评成立，而且是三层问题**：
  ① 标签一律叫「登录态」—— 这是平台自己的术语。用户要填的东西四种形态都有
     （cookie 值 / localStorage 里的一项 / JWT / 本机 CLI 的凭据文件），
     在浏览器里的位置完全不同，一个笼统的框等于没说；
  ② 唯一的信息是一条 `pasteHint` 散文，里面混着「为什么」「注意事项」，
     **要粘哪个字段**被淹在中间；
  ③ `glm` / `doubao` / `qwen` 连 `pasteHint` 都没有，等于什么都没说。

  **改法：结构化凭据规格（`CRED_SPEC`）**，位置在 `services/channel-types.js`。
  每个非 API 接入方式声明一个清单，前端渲染成带序号的列表：
  ```
  values: [{ field: 真实字段名, from: 从哪取, note: 形态/兜底 }]
  why:   一句话解释为什么是这东西（不再堆小字）
  blankOk: 系统驱动型渠道可留空
  ```
  输入框标签也跟着变具体：单个 cookie 直接显示「Cookie：kimi-auth」，
  单个文件显示「凭据文件内容」，多个 cookie 显示「3 个 Cookie」。
  字段名可点击复制，不用手抄。

  **字段名是逐个核对过的，不是凭印象写的**：全部回到适配器源码里查证
  （`kimi-auth`、`xiaomichatbot_serviceToken`/`userId`/`xiaomichatbot_ph`、
  `sessionid`、`kimi-auth`、`access_token`/`device_token`/`user_id`、
  `refresh_token`、`crsr_` 前缀…）。
  浏览器驱动型（glm / 豆包 / 通义）的字段名在 `browser-driver.js` 的候选打分表里，
  一并在门禁的查证范围内。

  **顺带查出一个真 bug**：`custom:anthropic`（自定义 + Anthropic 兼容）
  被 `isApiKeyMethod` 判成 false —— 旧判据只认 `baseUrl`，
  而该方式的 `baseUrl` 故意留空（地址由用户自己填），
  于是前端给它渲染出一个「登录态」粘贴框，而它其实要的是 API Key + Base URL。
  这正是用户抱怨的「你放个登录态输入框，用户也不知道是啥啊」的来源之一。
  修：判据补上 `keyHint`（keyHint 只在 Key 型方式上出现，与 loginModes 互斥，已核对全部 30 家）。

  **门禁 `tests/cred-spec.test.mjs`（13 项，已进 `npm test`）**。
  防的是修复本身的退化，三类「不报错、只让用户困惑」的错：
  · 新加厂商忘了写规格 → 用户又看到光秃秃一个框；
  · 写了规格但 field 名是编的 → 用户按指引找不到那个 cookie，比没指引更气人
    → **回到适配器源码里查证字段名真的存在**（本条最关键）；
  · 规格键写错（`provider:method` 对不上）→ `credSpecOf` 永远返回 null，
    规格静静躺着不生效，肉眼完全看不出。
  另有三条文案类检查，查的都是**只在界面上暴露、构建期查不出**的缺陷：
  不能出现反引号/markdown 星号（我自己犯过：ChatPage 里 `**不是你的配置问题。**`
  星号直接显示给用户）；Windows 路径的反斜杠不能被吃掉
  （实测发现 `%USERPROFILE%\.codex` 在界面上成了 `%USERPROFILE%.codexauth.json`，
  用户照着找不到文件）；每条都要有 `from`。
  **注入法验证过**：编造 kimi 的字段名 → 立刻报出该字段在适配器里查不到；
  把 `cursor:cursor` 键改成拼错的 → 立刻报「缺少 CRED_SPEC：cursor:cursor」。

  **真实截图验收**（服务器上跑脚本，登真实管理员，逐个厂商截弹窗）：
  ```
  mimo      → 标签「3 个 Cookie」，列 3 条含 xiaomichatbot_serviceToken 与来源面板 ✅
  kimi      → 标签「Cookie：kimi-auth」，标注 JWT 以 eyJ 开头 ✅
  codex     → 标签「凭据文件内容」，路径 %USERPROFILE%\.codexuth.json 正确 ✅
  glm       → 标签「（留空即可）」，并说明为什么可以留空 ✅
  workbuddy → 「凭据文件内容」，3 项（含 X-Device-Token 风控头） ✅
  cursor    → 「API Key / IDE 凭据」，2 项（crsr_ 优先，IDE 凭据兜底） ✅
  ```
  6 张截图 md5 各不相同（确认真的切换了厂商）。

  **这次踩的坑（两次，都记下来）**：
  · 第一版截图脚本用 `button:has-text("小米")` 选厂商，而厂商项其实是
    `<div class="oo-provider-picker__item" role="button">` → 选择器匹配不到
    → 每次都停在第一步 → **6 张截图 md5 完全相同，而脚本照样打印 "shot xxx" 报成功**。
    教训：**截图必须校验内容（md5/像素），不能只看脚本没报错**。
  · 构建产物落到了 `ooapi-web/dist`，而服务实际从 `ooapi-server/web` 读取
    （`src/index.js` 的 `express.static`）—— 于是跑的还是旧包，
    截图里标签仍写着「登录态」，看着像没修好。**部署后要确认服务真在服务新包**
    （`grep -c credSpec ooapi-server/web/assets/*.js`）。

  **上线验证**：cred-spec 13/13、ui-smoke 全部页面正常、gateway-smoke 9/9，
  三个门禁都在**部署后的线上构建**上跑过。
  本地 `npm test` 368 项断言全通过。

| 2026-09-24 | **第 61 批 · 云端真机功能测试、视觉审计与社区 Bug 报告全量核验**。

  **一、云端实机功能与冒烟测试（47.79.85.60 生产环境）**
  · 更新至最新 commit `8361fa8`，验证服务 `active`，build_id 一致。
  · `gateway-smoke.mjs` 9/9 全通（OpenAI Chat、Anthropic Messages、Codex Responses 三种主流协议与 usage、未实现端点 JSON 404 等）。
  · `ui-smoke.mjs` 23/23 页面全通（无未定义标识符、无作用域死区、无构建遗漏）。
  · `cred-spec.test.mjs` 13/13 全通；`vendor-icons.test.mjs` 5/5 全通。
  · `persona-r1.test.mjs` 82/82 全通（全套测试人格回归锁全部绿灯）。

  **二、真机视觉审计（Playwright + Xvfb 屏幕采样）**
  · **导轨按钮图标居中度**：5 个 Rail 按钮在屏幕上的偏移距精准为 `(0.0px, 0.0px)`，彻底消除偏角。
  · **桌面端返回箭头 `←`**：桌面端 `isVisible: false`，完全隐藏；仅移动端展示。
  · **发送消息气泡对比度**：实机 DOM 计算样式验证，`bubbleColor`, `proseColor`, `pColor` 全部为 `rgb(255, 255, 255)` 纯白，彻底消除蓝底黑字。
  · **社区与详情页**：导航返回动线在左上角，评论卡片折叠态文案与按钮清晰直观、点击平滑展开。
  · **媒体库与公开定价表**：顶部上传入口正常，`/pricing` 路由正常消费 `expose_pricing_to_user` 并正确对外显示单价。
  · **移动端适配（390×844）**：折叠评论框无文字换行溢出，消息主从堆叠流畅。

  **三、社区板块 Bug 报告全量核查（30 余篇反馈帖）**
  · 对社区内测试人格所发帖子逐一查验，涵盖 Round 1/2/3 全量问题反馈：
    - 审计 IP 与日志关联合并（#141, #170, #171）✅ 已解决
    - 行内代码 Markdown 嵌套与发帖字段类型校验（#146, #164）✅ 已解决
    - 消息页白屏（#169, #181）✅ 已解决
    - 删帖与已删评论正文/图片彻底脱敏与隐藏（#172, #182, #251）✅ 已解决
    - 模型能力后缀写实与首页示例模型名真实可调（#175, #176, #234）✅ 已解决
    - 令牌额度边界与小于 0.01 自适应精度（#177, #269）✅ 已解决
    - 对话框置灰引导（#184, #214）✅ 已解决
    - 流式响应末帧强制携带 usage 与计费（#233）✅ 已解决
    - 多图上传队列乱序修复（按选择索引有序回填）（#235, #237, #240, #242, #264, #268）✅ 已解决
    - 侧边栏/顶栏头像实时同步展示（#238）✅ 已解决
    - 对话页截图粘贴丢失与草稿清空问题（#239, #263）✅ 已解决
    - 使用记录增加密钥与分组列（#241）✅ 已解决
    - 评论折叠卡片可发现性强化（#249）✅ 已解决
    - 好友系统沉淀站内离线通知（#252）✅ 已解决
    - 手机端对话欢迎语被推顶切断（#262）✅ 已解决
    - 富文本编辑器上传图正文漏写 !文件名（#271）✅ 已解决
    - 移动端折叠输入框文字压右侧图标（#272）✅ 已解决
    - 用户截图反馈的导轨按钮偏角、桌面误显返回箭头、气泡黑字对比度问题 ✅ 已解决

| 2026-09-24 | **第 62 批 · 频道命名去 QQ 化、已删除内容全流隔离与管理员专属「已删除」Tab**。

  **一、频道命名去 "QQ" 化**
  · 遵循用户指导，将原本硬编码或沿用模拟称谓的「QQ 频道」全面更名为专属的「频道」「官方频道」与「频道 · 开发者社区」。
  · 更新了 `MessagesPage.jsx` 导轨 Tooltip、aria-label、空状态引导文本以及操作按钮。
  · 同步更新了 `db.js`、`chatroom.js`、`styles.css` 以及单测文件中的描述性文案与注释，保持整体品牌自洽。

  **二、已删除内容全流隔离与管理员专属 Tab**
  · **常规流彻底隔离**：重构 `visibilityClause` 与 `GET /community/posts`，无论普通用户还是管理员，在常规列表（最新、最热、话题过滤、关注/收藏、搜索）中严格排除 `status = 2`（已删除）内容，彻底杜绝混杂显示。
  · **管理员专属 Tab**：在 `CommunityPage.jsx` 顶部的 Segmented 分组选项中，若当前用户角色为管理员（`role >= 100`），动态增加「已删除」Tab（`<DeleteOutlined />`）；点击后进入专属已删除列表，按删除时间倒序呈现。
  · **权限严密拦截**：普通用户直接请求 `?tab=deleted` 或 `?status=2` 接口返回 403 明确阻断。
  · **恢复与管理支持**：在帖子详情页和后台管理页中，管理员查看已删除帖子时提供专属的「恢复帖子」操作（支持通过 `/moderate` 恢复到 `status=1`，自动置空删除痕迹并同步回补话题计数）。
  · **回归门禁**：新增 `tests/community-deleted-tab.test.mjs`，包含 13 项严格断言并全部通过；前端 `npm run build` 全绿构建。

  **三、多角色 AI 智能体实机巡检与发帖验证**
  · 调度 5 个不同独立角色（老王/小林/阿蓝/小周/阿May）开展全系统巡检：
    - 老王（独立开发）：实测 `/v1/chat/completions` 网关与计费，在频道与社区发帖。
    - 小林（QA测试）：实测常规流隔离，验证常规流 100% 不含 status=2 已删除内容，管理员 Tab 可见已删除帖子。
    - 阿蓝（插画师）：实测去 QQ 化频道三栏布局，验证导轨居中、气泡高对比度及配图流程。
    - 小周（学生萌新）：实测新手引导、子频道浏览及社区交互。
    - 阿May（技术主管）：实测团队治理合规、日志留痕与板块规划。
  · 智能体实机调用网关生成并发布真实测评贴（#277, #278, #279, #280）并完成评论跟帖（#432, #433, #434, #435），真机截图均沉淀入系统；管理员 Tab 成功截屏留存 20 篇已删除帖子。

| 2026-09-24 | **第 63 批 · Round 4 模拟用户常驻测试（子线走本平台 API）**。

  **用户要求**：「继续开子智能体 开始模拟真实用户操作 你可以不走当前配置的模型，
  可直接走我们系统的 api 来做任务，你这边只负责定时监工，用户们遇到问题依旧是直接发帖，
  你这个主线程就负责定期检查所有子线情况和负责维护系统修复帖子爆出的问题
  已经回复修复情况和发公告。也就是你的子线都用我们系统的 api 接入，来模拟真实用户，
  主线是走当前我给你配置的本地的这个模型就够了。」

  **架构（与 Round 1–3 的关键区别）**：
  Round 1–3 是**固定脚本**跑一轮就结束，撞到的都是脚本里写死的那几条路径。
  Round 4 改成：
  · 子线**自己决定下一步做什么**（12 个动作里由模型挑，避免连续重复），
    所以会像真人一样在不同功能间跳；
  · 每个子线是**真实注册账号**（走 `/api/user/register`，不是直接写库）；
  · 大脑走**本平台 `/v1`**（用户明确要求）——顺带压测网关、计费、限流；
  · 常驻循环（无限轮，轮间隔 12–30 秒随机），不是跑完就停；
  · 遇到问题 → **发帖到社区**（第 27 批新加的 `report_bug` 动作，带现场截图）
    + 写内部事件流 `/root/fb4/events.jsonl` 供主线监工。
  主线程用 `fb4_watch.mjs` 巡检（按 kind 聚合问题、看子线发言、看动作分布）。

  **运行规模**：5 个人格 × 100+ 轮，累计 200+ 轮真实操作。

  **本批修掉的问题（都有复现或截图）**：

  ① **令牌表窄屏密钥列竖排**（子线截图 + 实测）。
     手机 390px 视口下，「名称」150 + 固定的「操作」180 吃掉 330px，
     只剩 ~40px 给密钥，那串 sk-xxx 就在 40px 里一个字符一行地竖排。
     而密钥在列表里本来就是打码的，读它没意义。改：窄屏该列只留复制按钮（56px），
     表头改叫「复制」；桌面端不受影响（仍是 287px）。
     验证：窄屏单元格实测 116×24、单行（改前是多行）。

  ② **分组选错必然调不通，而报错不说能用什么**（5 个人格里 4 个撞上，62 次）。
     根因是**配置问题不是代码问题**：分组「1」（还排在下拉第一个）只允许
     `deepseek-flash`，而没有渠道能服务它（渠道 7 报「上游返回空内容」）。
     但报错只说「分组限制了可用模型」是**半句话** —— 用户不知道能用什么，只能一个个试。
     改三处：报错列出该分组可用模型 + 提示 `GET /v1/models`；
     建令牌的分组下拉把模型名列出来（原先只写「支持 N 个指定模型」）。
     子线实测反应：改完后它自己读了 `/v1/models` 并说
     「我以为是我 key 复制错了，点开一看，好家伙」。

  ③ **控制台余额卡只说「200 OD币」，不解释币是什么**（3 个人格都问）。
     原话：「OD 币是啥我不知道，那个 1 比 10000 的比例也没看懂」
     「200 币到底能问多少句话啊」。改：余额卡的悬浮说明补一句人话
     （OD币是账号余额单位，按调用 token 用量扣费，价格见「模型价格」页）。

  **查了但没复现（记下来避免下次白干）**：
  子线说手机上看数据看板「左边菜单没收起、正文被挤成一条」。
  用 390×844 实测首页/数据看板/社区/令牌管理/使用记录五个页面：
  主内容区都是满宽 390px，无侧栏挤压，也无被压成窄条的文本块。**不修**，等复现。

  **我自己这套工具的三个 bug（都值得记）**：
  · **AntD 会在两个汉字间插空格**（按钮实际渲染成「发 布」），
    于是 `has-text("发布")` 匹配不到，而 `.catch(() => {})` 把失败吞了 ——
    发帖根本没提交，脚本还报「成功」。教训：**按钮定位别按文字，去掉静默 catch**。
  · **假阳性验证**：原本读「帖子列表第一条」算发布成功，
    结果 UI 发帖其实失败了，而 id=280 是**别人的**帖子，脚本照样报「落地=是」。
    这种假阳性最危险（会把「功能坏了」掩盖成「一切正常」）。
    改成按**当前用户**的帖子列表比对标题。
  · **推理模型的 max_tokens 要给足**：`deepseek-v4.1-flash` 是推理模型，
    给 8 或 60 时整个预算被推理吃掉，`content` 回来是空串（`finish_reason=length`），
    子线会当成「平台坏了」去发帖 —— 那是误报，问题在预算。
    已在 runner 里区分「预算不够（自动加大重试）」与「真异常（记问题）」。
  · 另外：**部署路径踩坑**——构建产物落在 `ooapi-web/dist`，
    而服务实际从 `ooapi-server/web` 读（`src/index.js` 的 `express.static`），
    于是跑的还是旧包，看着像没修好。部署后要确认服务真在服务新包。

  **主线的产出（用户要求的「回复修复情况和发公告」）**：
  · 发公告并置顶：社区帖 **#295**「Round 4 模拟用户测试：已修 3 个问题，1 个是环境配置」
    （同时是首次把「模拟用户」这件事公开说明）；
  · 回复子线反馈帖 **#302 / #294 / #291**（分组配置问题 / 温度随机性 / 探针账号说明）；
  · 给 21 个测试探针账号（`fb4*` / `zqr*`）的 `bio` 打上
    「本站功能测试用的模拟账号，不是真人」，避免真实用户被误导。
    （说明：先前公告里我写了「已在个人主页做区分」，**当时其实没做** ——
    写完检查发现不属实，先做了标记再保留那句话。不能把没做的事说成做了。）
  · 子线自己发出的反馈帖已有 #298–#305 多条，均带现场截图。

  **工具位置**：`.workbuddy-ai/fb4.mjs`（子线运行器）、`fb4_launch.sh`（启动/停止/状态）、
  `fb4_watch.mjs`（主线监工）。注意 `.workbuddy-ai/` 已进 `.gitignore`
  （内含测试服务器口令，绝不能提交）。

| 2026-09-25 | **第 64 批 · 修 content-error 误判正常提问（Round 4 模拟用户实测暴露 + 已修）**。

  **怎么发现的**：Round 4 的 5 个模拟用户在服务器上跑了 1400+ 轮真实操作，
  其中 `wang`（独立开发者人设，focus 是"会算钱、会核对扣费"）反复生成
  "关于计费/额度"的内容，触发了平台的一个规则缺陷 ——
  表现为：**它的请求被平台判为"上游返回错误提示"，整条失败**。
  错误消息里装的是它自己刚生成的抱怨文本（含 `insufficient quota`），
  而 `code` 是 `CHANNEL_BIZ_ERROR`。

  **根因**：`services/upstream/content-error.js` 用来识别「上游用正文说错误」
  （上游不返 HTTP 错误，而把错误写成一整段正文）。
  原判据是「回复很短（≤400 字）+ 命中错误句式」——
  但那些句式**也是用户正常提问里的常见词**：
  ```
  /(insufficient|not\s+enough)\s+(credit|quota|balance)/i
  /(权限不足|无权限|未开通|额度不足|余额不足)/
  ```
  于是用户问「余额不足是什么意思？」也会命中 → 整条请求被当作上游故障丢弃
  （返回 502/503，而不是答案）。

  **实测影响面**（五个人格各 3 条常见提问，共 15 条）：
  ```
  zhou(学生)     1/3  ✗「余额不足是什么意思？」
  wang(开发者)   2/3  ✗「为什么我的额度不足了」「insufficient quota 怎么处理」
  lin (测试)     1/3  ✗「账号权限不足是什么情况」
  may (团队负责) 1/3  ✗「额度不足会影响业务吗」
  lan (插画师)   2/3  ✗「模型不可用的时候我该换哪个」「我的余额不足了怎么办」
  ----------------------------------------------------------
  合计 7/15 (47%) 会被误判
  ```
  本平台是**按 token 计费的网关**，"额度/扣费/权限"恰是用户高频提问域。
  线上触发率实测约 1/170 轮（`wang` 持续产出计费内容时，每 8~54 分钟一次）。

  **修法**（四道判据，都是"让判据更贴近'整段就是错误提示'这个本意"）：
  1. **提问语境排除**：命中疑问标记（`?？|怎么|为什么|是什么|如何|请问|请解释|吗$`）
     则不判定 —— 用户提问/讨论不是上游报错；
  2. **命中必须在第一个句子/分句内**：真实错误提示**开头即结论**，
     而内容里"顺带提到"的命中往往在中后段。
     注意这里**不能用字符窗口**：中英文信息密度不同
     （实测「…结果它提示 insufficient quota」命中在第 43 字符，
      但那已是第二分句）→ 改为按句子边界（含中文逗号）判断；
  3. **收紧中文正则**：去掉「不可用」（太通用），
     「额度不足/权限不足」单用不算，必须搭配明确指示动作（请/需）；
  4. **补全时态**：`(account|subscription)\s+(is|has\s+been|was|were)\s+…`
     —— 原正则只认 `account is suspended`，而实际上游写
     `account has been suspended`（**这是漏杀**，与误判相反方向，一并修了）。

  **验证（三层，全部通过）**：
  - 单元：新增 `tests/content-error.test.mjs`（已入 `npm test`），8 项断言 ——
    15 条正常提问**不得误判** + 11 条真错误**必须识别** + 边界与不变量。
    修复前：误判 11/11、漏杀 1/8；修复后：**误判 0/11、漏杀 0/8**。
  - 全量：`npm test` **376 项全过**（原 368，新增 8）。
  - 端到端（真打线上 `/v1`）：3 条"修复前会误判的提问"现在都拿到正常回答：
    ```
    ✓「余额不足是什么意思？」      → 模型正常解释
    ✓「账号权限不足怎么办？」      → 正常给出处理建议
    ✓「请解释一下 insufficient quota」→ 正常解释
    ```
  - `gateway-smoke.mjs` 9/9（三种协议真实调用正常）。

  **方法上值得记的一点**：这个缺陷是**模拟用户的自由文本**暴露的。
  人工很难构造出「恰好 109 字且含 `insufficient quota`」的输入，
  但子线的生成会自然覆盖到这类输入空间。
  即：**模拟用户的价值不只是"点页面"，还在于它们的文本输出覆盖了
  人工难以枚举的输入组合**。

  **我自己在这件事上的两次判断修正也记在案**（诚实记录）：
  · 一开始按"全库只有 1 条记录"判断为"罕见的潜伏缺陷（≈1/500000）"，
    随后 36 分钟内第二次触发 → 修正为"计费类内容易误判"，
    再测影响面（7/15）→ 最终定性为"覆盖面很广的规则缺陷"。
  · 评估时**不能只看线上观测次数**（受"触发条件概率"与"触发场景频率"
    两个因素共同影响），要**构造典型输入直接测函数**才能得到真实影响面。

## 7. 第 27 批规划：工具/网页反代扩展（2026-09-19 调研）

> 目标：把开源社区已有的「网页版反代 / 工具类反代」按**厂商**归类接入平台，
> 工具（Kiro/Trae/Cursor/Windsurf/OpenCode/zcode/WorkBuddy 等）只是子类型标签，
> 模型与计费归属对应厂商。渠道界面呈现为「厂商=Anthropic，渠道类型=反代（Kiro）」。

### 7.1 调研结论（参考实现）

| 厂商 | 子类型 | 参考开源项目 | 凭据形态 / 协议要点 |
|---|---|---|---|
| Anthropic | **Kiro（AWS Q/CodeWhisperer）** | jwadow/kiro-gateway、dwgx/KiroStudio（源自 hank9999/kiro.rs）、awei84/KiroGate、jx-zyf/kiro-proxy、jasminnanda/kirogo | ① Kiro Desktop：`prod.{region}.auth.desktop.kiro.dev/refreshToken`；② AWS SSO(OIDC)：`oidc.{region}.amazonaws.com/token`（clientId/clientSecret）；上游 `codewhisperer.{region}.amazonaws.com/generateAssistantResponse`，`application/vnd.amazon.eventstream` 流；凭据 JSON 含 accessToken/refreshToken/region/profileArn(可选) |
| Anthropic | Trae / Cursor / Windsurf / OpenCode / zcode / WorkBuddy | cursor-to-api、windsurf-api 等 | 多为 IDE 侧凭据 + 私有签名，需逐个逆向，插件化实现 |
| OpenAI | **ChatGPT 网页版（chat2api）** | lanqian528/chat2api、Cyrene963/chat2api、xqdoo00o/ChatGPT-to-API | access_token / refresh_token（`chatgpt.com/api/auth/session`）；协议与 codex 相邻（responses API）；Plus 号可能需 Arkose/Turnstile |
| Google | Gemini 网页版（HanaokaYuzu/Gemini-API） | Gemini-API、Bard-API | `__Secure-1PSID` 等 cookie；capture 已有基础设施可直接抓 |
| xAI | Grok 网页版 | grok-web 类项目 | 网页 session；目前已有 device OAuth，优先级低 |

### 7.2 架构方案

- `channel-types.js`：厂商 methods 增加「工具反代」条目（如 `{ key: "relay-kiro", label: "反代（Kiro）", adapter: "kiro", loginModes: ["paste","capture"] }`），
  保持 `adapterFor()` 现有语义（方法上声明 adapter）。
- 每个工具一个适配器文件（`upstream/kiro.js` 等），复用：
  - `auth-store.js`（刷新+持久化）、`browser-driver`（如需网页登录）、`auth-import.js`（凭据导入）。
- 计费/模型归属厂商：适配器内部把工具模型 ID 映射到厂商模型表（如 `claude-sonnet-4.5`）。

### 7.3 交付批次（每批：实现 → 单测/桩测 → 十轮审查 → 线上验证）

1. **Kiro（Anthropic）**：JWKS 无需，直接 bearer；重写 refresh + eventstream 解析；支持粘贴 Kiro auth JSON / `REFRESH_TOKEN`。
2. **chat2api（OpenAI 网页版）**：access_token 直连 + responses 流解析；Arkose 账号标记为不支持并显式报错。
3. **Gemini 网页版（Google）**：cookie 粘贴 + capture 抓取，复用现有 noVNC 登录。
4. **IDE 工具批量**（Trae/Cursor/Windsurf/OpenCode/zcode/WorkBuddy）：每个工具一个适配器，按社区实现逆向，逐个灰度。
5. **统一收尾**：模型映射表、测试用例、文档、UI 标签。

### 7.4 功能测试前置条件（需要提供）

每个工具/网页反代需要**至少一个真实账号凭据**才能做功能测试：
- Kiro：`kiro-auth-token.json`（或 Builder ID 的 refresh token）
- ChatGPT 网页版：有效 `access_token`（或 RT）
- Gemini 网页版：`__Secure-1PSID` 等 cookie
- IDE 工具：对应工具的登录凭据

没有凭据时只能做到「代码完成 + 静态检查 + 桩测试」，无法完成真实链路验证。

### 7.5 第 30 批补充调研（2026-09-19，开源工具第二轮盘点）

> 结论先行：**只有 Kiro 与 WorkBuddy 值得优先接**（前者已实现），
> 其余要么需要私有客户端二进制，要么协议已死，要么上层模型名与实际模型不符。

| 对象 | star 量级 | 认证 / 协议 | 适配难度 | 结论 |
|---|---|---|---|---|
| **Kiro** | kiro-gateway 2280 / kiro.rs 1912 | refreshToken（桌面版 + AWS SSO OIDC 双模）；`runtime.{region}.kiro.dev/generateAssistantResponse`（新版）或 `q.{region}.amazonaws.com`（旧版）；AWS EventStream | 低 | **已实现**（第 27 批第 1 批交付） |
| **WorkBuddy / CodeBuddy（腾讯）** | workbuddy2api 1085 / 237 / 115 | OAuth 设备授权；上游本身就是 **OpenAI 兼容** `POST {base}/v2/chat/completions`；双域（CN `copilot.tencent.com` / Global `www.workbuddy.ai`）；额外头 `X-User-Id`/`X-Enterprise-Id`/`X-Device-Token` | 低（协议薄） | **推荐接入**：上游即 OpenAI 协议，只需 key 池 + 头注入。风险：`X-Device-Token` 是腾讯 Turing Shield 设备风控头，社区靠宿主机落盘文件注入，**随时可能升级**。模型是腾讯云托管同名档位（`deepseek-v4.1-flash`/`glm-5.3`/`kimi-k3`/`gpt-5.6-*`），**不是**从 DeepSeek/智谱官方 API 转发的 |
| **Windsurf** | WindsurfAPI 3022 | apiKey + **必须运行官方 language_server 二进制**（Connect-RPC via 本地进程） | 中（重资产） | 暂缓：需下载并运行官方二进制，Linux 部署 + 平台合规成本高 |
| **Gemini 网页版** | Gemini-API 3518 | `__Secure-1PSID` cookie；StreamGenerate + batchexecute | 中 | 可作为补充能力；注意新版 Chromium 的 Device Bound Session Credentials 会让 cookie 数小时失效，社区建议用 Firefox 导出 |
| **OpenCode Zen / Qoder** | opencode2api 326 / qoder-proxy 56 | 上游多为标准 API（key 池为主）；Qoder 需每请求 spawn `qodercli` 子进程 | 低-中 | 需本机安装官方 CLI，资源占用不可控；按需评估 |
| **Trae** | trae-local-api 55 | IDE `storage.json` 的 "tc" 加密（AES-128-CBC + SHA-512 派生）；**模型名与实际不符**（请求 claude-opus 实际跑 glm-5.2） | 高 | 暂缓：加密随版本变、无长期维护仓库、模型归属会误导计费 |
| **Cursor** | cursor-api 268（已停更 2025-06） | Connect-RPC over HTTP/2 + protobuf + `x-cursor-checksum` 签名 | 高 | 不建议：私有协议 + 签名 + 主力仓库停更半年以上 |
| **chat2api 系** | chat2api 3812（停更 2025-05） | 需要 `curl_cffi` TLS/JA3 指纹伪装 + PoW + 可选打码 | 高 | **不建议**：两个主仓库都停留在 2025 年初的 ChatGPT 前端，且与现有 `openai-web` 适配器功能重叠（后者走浏览器登录，不受 TLS 指纹限制） |

**关于「WorkBuddy 免费 DeepSeek 归属 DeepSeek」的澄清**：调研确认 WorkBuddy 国际版返回的
`deepseek-v4-pro`/`deepseek-v4.1-flash` 是**腾讯云托管的同名模型**，不是 DeepSeek 官方 API 转发。
因此接入时若把它当 DeepSeek 官方模型计费，会出现「按官方价收费但实际跑的是第三方托管档位」的偏差。
本平台的处理口径：WorkBuddy 作为独立厂商接入（不并入 deepseek），模型 id 保留上游原名，
定价按上游实际档位录入。**这一点需要在接入前确认产品意图**。

### 7.6 智能体沙盒调研（2026-09-20，用户点名要求）

> 用户要求调研 bigmodel 的 managed agents（https://docs.bigmodel.cn/cn/managed-agents/quickstart），
> 回答「预装沙箱/运行环境策略、能否多模型共用」。

**它是什么**：托管式 Agent 运行平台。三件套组合 ——
`Agent`（模型 + 系统提示 + 工具 + MCP + Skills 的定义）、
`Environment`（声明式沙箱：软件包与网络策略，可跨会话复用）、
`Session`（有状态会话：沙箱文件系统与对话历史保留，可持续发消息）。
工具在沙箱内执行（bash、文件操作等，需显式传 `tools` 才启用），
产出写入 `/mnt/session/outputs` 后经 Files API 下载。

**API 形态**：标准 HTTP + SSE，无官方 SDK。
`POST /v1/agents` → `POST /v1/environments` → `POST /v1/sessions` →
订阅 `GET /v1/sessions/{id}/events/stream` → `POST /v1/sessions/{id}/events` 发消息。
鉴权 `Authorization: Bearer $ZHIPUAI_API_KEY` + 必需头
`zai-version: 2026-05-26`、`zai-beta: managed-agents-2026-05-26`。
**注意 SSE 有连接时序要求：必须先订阅再发消息**（流只推连接之后的事件）。

**用户问的两点，结论**：
1. **预装沙箱/运行环境策略**：文档只说明 Environment 可声明软件包与网络策略、
   可跨会话复用，**没有给出预装清单、镜像基础、配额与超时**。
   这些要拿到账号实测才能确认（属「必须实盘才能定」的项）。
2. **能否多模型共用**：文档示例只用 `glm-5.3`，
   **既没给支持模型清单、也没说明同一 Agent/会话能否换模型**。

**本平台的接入判断：暂不接入**，理由三条（按重要性排序）：
- **模型不可替换**：我们的核心价值是「多厂商多渠道统一网关」，
  而它的 Agent 只跑智谱自家模型 —— 接入等于在平台里开一条只通一家的管道，
  与架构目标相反（用户要的「多模型共用」它没承诺支持）。
- **计费与配额不透明**：文档未提计费方式、价格、额度。
  本站计费必须能精确归因到用户（`services/pricing.js` 是唯一入口），
  外部托管沙箱的成本无法按 token 精确拆分 → 会破坏计费口径。
- **替代成本低**：我们已有的对话 harness（`services/harness/`）本就支持
  多步工具调用、子代理派发、步数上限；沙箱能力（跑 bash/写文件）
  可以用容器自建，且能保留渠道无关性。

**如果将来要做**，建议的顺序是：先自建「容器沙箱 + 现有 harness」
（保持模型无关），把它作为可选执行环境挂在对话链路里；
只有在「需要 MCP/Skills 生态且不愿自维护」时才考虑接托管平台。
接入前必须先实测三个未知项：预装清单、并发与超时配额、计费口径。
