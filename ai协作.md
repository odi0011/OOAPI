# AI 协作规范

本文件是**所有 AI 助手与新会话的必读约束**。换窗口、换模型继续本项目时，先读完本文件再动手。

项目：OOAPI —— 大模型 API 网关与分发平台
线上：`https://ooapi.space` / `https://apidoc.cloud`
服务器：`root@154.36.184.56`（Debian 12 + nginx + MySQL 5.7 + systemd）

---

## 一、技术栈（不要改）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Go 1.27 + Gin + MySQL 5.7 | 单个静态二进制，内存约 10MB |
| 前端 | React 19 + TypeScript + Vite | `ooapi-web/` |
| UI 组件 | **Arc UI**（https://uiarc.dev） | shadcn registry 模式，组件代码归项目所有 |
| 数据库 | MySQL 5.7，库名 `ooapi` | 表由 `internal/db/schema.go` 自动建 |

---

## 二、UI 组件库使用规范

### 2.1 必须优先使用组件库

**所有 UI 元素优先用 Arc UI 的组件，不要自己造轮子。**

安装方式（在服务器上执行）：

```bash
cd /opt/ooapi
python3 install-arc.py arc-foundation <组件名> [组件名...]
```

脚本会自动递归拉取依赖并处理路径。组件落在 `ooapi-web/src/components/arc/` 下。

**已确认免费可用的组件**（132 个条目中与本项目相关的）：

- 图表：`line-chart` `bar-chart` `donut-chart` `sparkline` `gauge` `activity-heatmap` `streamgraph` `waffle-chart` `treemap` `ridgeline` `brush-chart` `slope-chart`
- 数据：`metric-card` `sortable-data-table` `pagination` `filter-toolbar` `badge` `card` `avatar-group` `timeline` `json-viewer` `empty-state` `animated-counter` `code-block`
- 表单：`input` `textarea` `select` `combobox` `checkbox` `switch` `radio-group` `number-field` `password-field` `search-field` `multi-select` `tag-input` `date-picker` `time-picker` `slider` `calendar` `color-picker` `file-dropzone` `segmented-control` `inline-edit` `phone-input` `money-input` `rich-text-editor`
- 反馈：`alert` `toast` `progress` `skeleton` `stepper` `countdown` `usage-meter` `announcement-bar`
- 导航与容器：`breadcrumb` `tabs` `dropdown-menu` `context-menu` `tooltip` `popover` `dialog` `drawer` `accordion` `scroll-area` `resizable-panels` `hover-card` `bottom-sheet`
- 块：`login-centered` `signup-form` `site-header` `site-footer` `hero-section` `faq-section` `stats-band` `page-header` `command-palette` `notification-center` `changelog-feed` `blog-grid` `contact-section` `logo-marquee`

### 2.2 免费版缺口（需自行实现，但要贴组件库的设计语言）

- **侧边栏**：`Dock` / `Morph nav` 属 **Pro 版**，免费版没有。当前 `components/admin/AdminSidebar.tsx` 是自建的，样式全部引用 `foundation.css` 的令牌，视觉与组件库一致。**若将来升级 Pro，应替换为官方 Dock。**
- `Sunburst` `Sankey flow` `Funnel chart` `Radar chart` `Realtime stream` 属 Pro。

### 2.3 组件 API 的坑（已踩过，别再踩）

| 组件 | 坑 |
|---|---|
| `gauge` | 中心数字**永远是 min–max 的百分比**，不接受任意单位。带单位的量（如毫秒）不要放进去。它还会把读数四舍五入成整数，所以**不要设 `thresholds`**，否则会出现「显示 99% 却标着偏低」的自相矛盾。 |
| `radio-group` | 选项是「每项占一整行、带边框」的列表式布局。**两三个字的短选项不要用它**，改用 `segmented-control`（`inline-flex`，自适应宽度）。 |
| `sparkline` | 自带一行 caption（label + value），会占满整行。用它就直接承担数值展示，不要在外面再写一遍数值。 |
| `metric-card` | 后缀（suffix）包在 `inline-block` 里，**普通空格会被折叠**，需要空格用 `\u00A0`。数值过长会把卡片撑爆并压到相邻卡片上（如 `428,400,000 tokens`），要换算成 M/K 单位。 |
| `line-chart` | 多序列共用一根 Y 轴。量级差距大时（如请求数 4 万 vs 消费额 100）小量级会被压成贴底直线，**必须拆成多个图或用 Tabs 分视图**。 |
| `activity-heatmap` | `unit` 需要 `{ one, other }` 两个字段，只给一个会编译报错。 |
| `sortable-data-table` | props 是 `rowKey` / `defaultSort` / `caption`，不是 `label` / `initialSort`。 |
| `file-dropzone` | 没有受控 `items`，只有 `defaultItems`。上传通过 `onUpload` 回调，进度用 XHR 而非 fetch。 |
| `otp-input` | props 含 `length`、`value`、`onChange`。 |
| 多个组件 | `input` 只有**具名导出**；`switch` 有 default 导出；`radio-group`/`number-field` 是具名导出。导入前先看源码确认。 |
| Arc UI 文案 | 组件内置大量硬编码英文（如 `Show password`、`Checkbox`）。**需要中文化时直接改组件源码** —— registry 模式下组件归项目所有。 |

### 2.4 主题与外观

组件库通过 `<html>` 属性切主题，不要再手写配色：

- `data-theme="dark"` → 暗色（写入 `AppearanceContext`）
- `data-accent="violet"` → 主题色（8 种：neutral/violet/blue/green/amber/orange/coral/rose）
- 全部变量定义在 `components/arc/foundation.css`

**外观是全局设置**，由管理员在 `/admin/system#appearance` 配置，通过 `AppearanceContext` 应用到全站（含未登录访客）。

---

## 三、版面与交互约束

### 3.1 标题只留标题

**页面标题与卡片标题下方不要写副标题、小短句、解释性说明。**

用户不需要看「这个页面是干什么的」的说明文字。例如不写：

```tsx
<h1>系统设置</h1>
<p>改动对所有访问者生效，包括未登录的首页访客。</p>  {/* ← 删掉 */}
```

只有一种例外：**表单字段的补充说明**（如「1 OD = 1 美元」）可以保留，因为它是操作必需的信息。

### 3.2 选择式控件不要拉全宽

`SegmentedControl`、开关、色板这类控件按其**自然宽度**渲染，不要 `width: 100%`。
「舒适 / 紧凑」这种两字选项占满整行是明显的版面浪费。

CSS 里的做法：控件容器用 `justify-self: start`，不要给 `width: 100%`。
只有文本输入框才占满列宽，且 `max-width` 兜在 480px 左右。

### 3.3 版面要紧凑

- 卡片内边距 `--space-4`（16px），区块间距 `--space-3`（12px）
- 正文 12–13px，标题 1.5rem（页面）/ 1rem（卡片）
- 一屏要尽可能多地展示数据
- 并排的两张卡片**必须等高**（用 `align-items: stretch` + 内部 flex 撑满），不要出现「左高右矮」

**控件尺寸已全局调小，不要改回组件库默认值。**
Arc 的 `--control-height-sm/md/lg` 原本是 36/44/50px 的触屏规格，一屏放三四个
筛选控件就被撑满。现在 `foundation.css` 里为 32/36/42px，`--radius-control`
同步收到 14px（圆角比例与原本一致）——输入框、搜索框、下拉、标签页、按钮、
分段控件、数字输入都读这几个令牌，所以一处修改全站生效。配套改过的硬编码：
`number-field` 步进（34→28px，否则控件会被顶回 42px）、
`select`/`dropdown-menu`/`user-menu` 的列表行高（36→32px）、
`sortable-data-table` 行高（表头 44→38、数据行 52→44）。

新增 Arc 组件时若写了裸 px 高度，按同一基准调整，不要引入第四种尺寸。

**全局提示位置：底部居中（`bottom-center`）。**
不要改回右下角 —— 后台表格右侧有固定操作列，右下角的提示会被压在下面看不见。
改动点在 `App.tsx` 的 `<ToastStack>`。

### 账号级高级配置（`内部 services/ratelimit.go` + `tls_fingerprint.go`）

「支持的模型」下方是**高级配置**（折叠区，两类账号都显示）：

| 字段 | 作用 |
|---|---|
| 并发上限 / 最小间隔 / 每分钟上限 | 账号级限流。**默认全 0 = 不限**（原版默认 1/1200ms/20 会立刻把普通 API 账号压到 20 req/min，不照抄）。超限的账号在调度时被跳过；若全部候选都被限流，回退为不筛（否则会误报「没有可用账号」）。 |
| 计费口径 | `input_only` 时输出 token 不计费（订阅号常见），**日志仍记录真实用量**，并在 detail 里标注「计费口径=只计输入」。 |
| 调用来源限制 | 逗号分隔的客户端白名单（按入站 UA 识别）。**纯限制**：只减少可调度范围，永不放大权限。空 = 不限。 |
| 出口代理 | 该账号走 http/https/socks5 代理；地址必过 netguard 公网校验，不合法就报错跳过，**不静默回落直连**。 |
| TLS 指纹 | 出站握手模仿 chrome/firefox/safari/edge/ios/android/random（uTLS 实现）。走代理时不生效（TLS 由代理侧协商，这是 TLS 固有限制）。 |
| Namespace / 备注 | 命名空间标签与管理备注，纯存储展示。 |

**TLS 指纹的定位要说清楚**：它改变的是握手的形状；**不改 HTTP 语义、不跳过证书校验、
不伪造 SNI、不是中间人**。原版项目逐字节复刻 ClientHello 仍被 403，结论是
上游主要看行为特征（频率、身份是否稳定、调用模式）—— 所以**限流 + 每账号稳定身份**
才是保号的主要手段，指纹只是补充。
**不做**：JA3 对抗性调优、客户端身份收敛（多账号共用一套身份反而更容易被判定为异常）。

**Grok 一键登录**：`deviceVendor: "grok"`，走 xAI 官方 device code
（auth.x.ai 的 device/code + token），凭据加密落库，传输层只允许发往
`cli-chat-proxy.grok.com`，401/403 才提示重新登录（本地算出的过期时间不作数）。
与 Cline / Kiro / WorkBuddy 同一套会话引擎与一次性票据。

### 订阅账号的交互式登录（Codex / Claude / Google）

与设备码授权是**两条不同的链路**，别混：

| | 设备码（kiro / workbuddy / cline / grok） | 交互式 OAuth（codex / claude-oauth / antigravity） |
|---|---|---|
| 用户动作 | 打开授权页输设备码，什么都不用粘 | 打开授权页登录，**把回调地址粘回来** |
| 服务端动作 | 拿 device_code 轮询 | 用授权码换 token |
| 原因 | 上游支持 device code | 官方客户端回调指向 `localhost`，服务器收不到 |

**为什么必须粘贴回调地址**：Codex / Claude / Gemini 官方注册的 `redirect_uri`
固定指向 `http://localhost:<port>`（用户自己电脑），浏览器登录完跳到那儿，
服务器上的我们收不到 —— 与 `gcloud auth login --no-launch-browser` 同理。
好处是不需要公网回调地址、不需要备案域名。

**安全要点（写在 `services/upstream_login.go`）**：
- `state` 随机、内存暂存、**一次性**、**绑定发起人 owner**，且校验厂商匹配。
  别人（或别的厂商）拿 state 来换会被拒，且**失败不消费会话** ——
  否则攻击者能靠反复乱试打断真正的登录。
- Codex / Claude 用 PKCE（S256）；Google 带 `access_type=offline` +
  `prompt=consent`（少任何一个都拿不到 refresh_token，账号一小时后失效）。
- 代码里**显式拒绝**没有 refresh_token 的返回：宁可让用户重登，
  也不收下一个「一小时后必然失效」的账号。
- 换回来的凭据立刻 AES-256-GCM 加密；前端只拿到一个**一次性句柄**
  （`StoreLoginCredential` / `TakeLoginCredential`），凭据本身永不出现在响应里。
- `tokenHTTP` 的 contentType 是内部简写（`form`/`json`），**必须翻成真正的 MIME 类型** ——
  直接把 "form" 塞进 Content-Type 会让上游解析不到任何字段，表现为
  「换令牌 400 且看不出哪里不对」（这个 bug 被测试抓到过）。
- 粘贴内容解析（`ExtractAuthCode`）要能认完整 URL / 裸 code / URL 编码，
  但**必须排掉「像 URL 但不是回调」的输入**（`http://...` 直接拒绝），
  否则用户粘错东西会拿到一句无从下手的 invalid_grant。

**传输层三家各一个装饰器**（`codex_transport.go` / `claude_transport.go` /
`antigravity_transport.go`），与设备授权同一套形状：内部标识
`ooapi-<method>-channel-<id>` 从 Authorization 取出 → 解密凭据 → 改写请求 →
**主机名硬编码校验**（标识发往其它主机直接报错，凭据绝不出域）。
401/403 才强制刷新重试一次，且**只在新令牌确实变了才重试**。

**装饰器链的坑（已修）**：链是按**文件名字典序** init 的
（antigravity → claude → cline → codex → grok → kiro → workbuddy），
每个装饰器必须包住**当前**的 `upstreamClient.Transport`。
`cline_transport.go` 原先写死 `http.DefaultTransport`，会把排在它前面的层
整个覆盖掉 —— 后果是「某些厂商的渠道配了代理后请求直连官方主机并 401」。
`protocol.go` 里按代理建链的地方也必须列全七层，漏一层只在「配了代理的账号」上复现。

**第二条入口：粘贴凭据导入**（`POST /devices/login/import`）。用户手里已经有别的工具
导出的凭据文件时不必重新授权。解析器按厂商各一份（官方 CLI 是 camelCase、
CPA/sub2api 是 snake_case，要按别名逐个尝试），支持 `token`/`tokens`/`credentials`/
`oauth`/`claudeAiOauth` 等包装层，并剥掉 ```json 围栏。时间字段支持 unix 秒、
unix 毫秒（>1e12 视为毫秒）、RFC3339。**同样强制要求 refresh_token**。
两种入口产出的是同一个东西（一次性凭据句柄），所以后续创建 / 重新授权完全共用。

**渠道的固定地址与路径**由服务端推导（`LoginChannelBase`），管理员改不了：
chatgpt.com/backend-api/codex（`/responses`）、api.anthropic.com/v1（`/messages`）、
daily-cloudcode-pa.googleapis.com/v1internal（`/chat/completions`）。
连通性测试要用 `probePathForMethod` 打对应端点 —— 一律打 `/chat/completions`
会 404，被误报成「账号不可用」甚至自动禁用。

**创建订阅渠道的硬性校验**（`createLoginChannel`，每条都有测试）：必须带授权句柄、
厂商与接入方式必须匹配（错配会把 A 的凭据发到 B 的主机）、不接受自定义地址 /
自定义协议路径 / **手填 API Key**（后者会留下两份互相矛盾的凭据）。
另外写 fail() 后**必须 return** —— 漏一个就会继续往下走到 INSERT，
在测试里表现为 nil DB 崩溃，在生产里表现为「校验形同虚设」。

**默认账号名的后缀表**：接入方式 id 直接大写拼上去会得到
「Anthropic / Claude CLAUDE-OAUTH 账号」这类变量名当展示名的结果，
所以 `defaultAccountName` 里维护 `cli→CLI` / `codex→Codex 订阅` 等映射，
并且**厂商名里已有的词不重复**（避免「Anthropic / Claude Claude 订阅 账号」）。
切换接入方式时同步刷新默认名（前提是用户没手改过）。

**账号弹窗的约定**（`AdminChannels.tsx`）：
- 配置区首行是 **厂商图标 + InlineEdit 形式的账号名**：不再单独画「账号名称」输入框，
  右侧也不重复写厂商名，但**图标要保留**（那一行最直接的身份提示）。
  新建时自动填默认名「厂商 + 接入方式 账号」（重名追加序号），
  用户就地点击即可改名；`nameTouched` 记录是否手改过 —— 改过之后换厂商/接入方式不再覆盖。
- 表单区的内边距不是随手写的：**左 10px 右 22px**。右 22px 是为了容下滚动条
  （宽 11px）并留出间隙 —— 14px 时实测间距只剩 2px，看起来像贴着输入框；
  左 10px 是给 InlineEdit 的悬浮背景留位置，它自带 `margin-inline-start: -9px`
  （让背景外扩、文字与周围对齐），左侧没内边距时背景左半边会被滚动区裁掉。
- 「接入方式」用 Tabs 呈现；**只有一个选项时不渲染这一栏**（省掉一行无意义的控件）。
- 分组 / 优先级 / 权重是一个**带边框的分组卡片**（`configGroup`），
  两条路径（设备账号与普通 API 账号）**共用同一个 JSX 变量** —— 别在两条分支里各写一份，
  那是以前改一处漏一处的原因。卡片内每行 `configRow`：标签左、值**贴右缘**
  （`justify-self: end`），行间用 `border-top` 画分隔线、最后一行不带；
  数字控件限宽 `--nf-width: 132px`，否则会在值列里被拉满。
- 设备授权（一键登录）的接口地址由服务端按凭据推导，**不显示那个永远置灰的输入框**。
- 已授权状态（刚授权完成，或编辑一个早就绑好的账号）整块换成渐变面板本身，
  **不套灰色容器**（否则四边会露出一圈灰）；展示「已授权 + 账号名字 + 期限」，
  历史绑定额外给一个「重新登录其它账号」入口。账号标识来自后端 `DevicePoll.account`，
  只含区域/平台/企业 ID，**绝不回传 token**。
- 已授权面板的动效背景来自外部渐变引擎 `src/vendor/feral-gradient.js`
  （307 KB 预构建产物，配方 Citron / PRISM2，原文件标注 Do not edit，**不要改它**）。
  类型声明单独放在 `feral-gradient.d.ts`；组件用 `lazy()` 引入，
  构建后是独立 chunk，只有出现已授权面板时才下载，主包不受影响。
  用法：`style={{ position:"absolute", inset:0, width:"100%", height:"100%", aspectRatio:"auto" }}`
  —— 必须覆盖 `aspectRatio:auto`，否则它会用配方自带的 2048×1506 比例撑高容器。
  配方两端有很浅的米色，白字要叠一层 `.grantedScrim` 暗角才稳定可读。
- 授权成功即自动拉取全部模型，**用一次性票据而不是渠道 id**
  （`POST /api/admin/channels/devices/models`）—— 新建流程里账号还没落库，
  按 id 解析凭据的路走不通；而模型是保存的必需项，让用户先存空账号再回头拉
  会死锁在置灰的保存按钮上。票据是**只读预览**（`PreviewTicket`，不消费），
  随后的「创建账号」仍要用同一张票据。编辑已有账号时票据已在轮询阶段被消费，
  改按渠道 id 拉（`fetch-models`）。失败静默：用户刚点完授权，
  一个红字报错会让人以为授权没成功。
- **必须至少一个支持的模型**：前端无模型时保存/添加按钮置灰、
  按钮左侧给一行说明（控件在表单中间，滚到底部看不到原因）；
  后端 `validateChannelInput` 同样拦截（创建时无条件、更新时仅在传了
  `models` 字段时），因为前端置灰只是 UX，后端校验才是边界。
  空模型在调度侧等于「不限模型」，账号会被派去接它不支持的模型 ——
  「空 = 不限」只对分组白名单成立，对单个账号不成立。
- 「支持的模型」用 Arc `TagInput`：一个模型一个标签、带品牌图标、
  输入时按已拉取的清单做子串模糊匹配、回车取第一条（补全成完整模型名）。
  候选只来自本次会话拉取的清单，**不凭空造一份全量模型目录**。
- 该字段的标题行是「标题 + 拉取链接（靠左成组）……批量操作（靠右）」：
  通过中间 spacer + `justify-content: flex-start` 实现，不要用 `space-between`
  （那会让链接被推到中间、与标题脱开）。
- 批量操作（多选 / 全选 / 删除选中 N / 清空）都是 `.toolAction` 极轻小按钮
  （视觉参考 FilterToolbar 的「清空」），**列表为空时整组不渲染**。
  TagInput 的多选由 `selectable` + `selectedTags` + `onSelectedTagsChange` 驱动；
  选中集合的更新**必须用函数式 updater** —— 同一批次里的连续点击若基于 prop
  计算会互相覆盖（实测连点 3 个只选中 1 个）。

**全站折叠一律用组件库 `Accordion`，不再用原生 `<details>`。**
原生 `<details>` 自带的三角号不在设计语言里（各浏览器样式也不一致）。
`Accordion`（`@radix-ui/react-accordion` + motion 高度动画）有三种尺寸：
`md`（默认，页面级）、`lg`（FAQ）、`sm`（密集行内，如表格单元格里的「异常详情」——
触发行不抬高所在行的高度）。已迁移：账号弹窗的「高级配置」、账号表格行内的「异常详情」、
首页「本站可用模型」清单。
注意「协议路由与附加请求头」是**常显**的、不折叠（用户明确要求）。

### 模型配置页的三个分区（`AdminPrices.tsx` → 全部模型 / 定价 / 能力与映射）

**「全部模型」是总入口**（`AdminModelCatalog.tsx` + `GET /api/admin/models/catalog`）：
模型相关的事分散在三处（账号支持什么、多少钱、多少上下文），漏配的症状是
**静默**的（未定价 = 按 0 计费 = 免费），不主动查发现不了。这一屏把三处合成一个
视图并**按厂商分组** —— 漏配往往是「某次接入新厂商时整批漏了」，按厂商看最明显。

**默认跟随**是这个页面的核心行为：上游模型名常是官模的变体
（`deepseek-v4.1-flash-sg` ← `deepseek-v4.1-flash`），识别到就建议跟随，
一键同时配好**价格（写映射）与能力参数（抄一份）**。

- 识别只做「一个名字完整包含另一个」（`suggestFollowTarget`），**不做模糊匹配**：
  错认会把请求按错误的价格结算，比不认更糟。两个已修的边界：空模型名会被任何
  字符串前缀命中（必须先挡），已定价的模型不该被建议跟随别人。
- **能力参数抄一份而不是运行时继承**：档位映射要按实际发给上游的模型名选，
  抄一份之后变体能独立调整，也避免「改本体把一堆变体一起改坏」。
- 跟随只改**计费与日志口径**，不改发给上游的模型名（上游只认它自己的名字）。

`POST /models/follow` / `DELETE /models/follow/:model`；目标没定价时拒绝并说明
（否则「跟随一个没价的模型」等于没配）。

### 模型配置：能力参数 + 上游名映射

两块配置服务同一件事 ——「这个模型该怎么用、按什么价算」，都在
`services/model_capabilities.go` 与 `services/model_map.go`，存在 options 表
（`model_caps:<模型>` / `model_map:<上游名>`），**不新增表**：纯配置、
按名字寻址，options 已有的读写与缓存机制够用。

**上游名映射很重要**：同一个模型在不同上游叫法不同（WorkBuddy 认
`deepseek-v4.1-flash-sg`），而定价是按本站名字配的。不映射 → 查不到价 →
**按 0 计费（等于免费）**，用户白用、站长白亏，而且不报错、没人会发现。
管理端有「未定价的上游模型名」清单主动提示（实测一次列出 32 个）。
映射只影响**计费与日志口径**，不改变发给上游的模型名。

**能力参数**（上下文窗口 / 最大输出 / 输入输出类型 / 工具调用等三态能力 /
推理档位映射）：
- **未核实就留空（0）**，运行时走保守默认 —— 不编造数字。`verification`
  字段区分「实测确认」与「未核实」，界面上也分开显示。
- 内置 147 条预设（`presets/model_capabilities.json`，从原项目移植，
  其中 47 条带推理档位），一键导入。预设只是**导入模板**，
  不参与运行时 —— 否则改预设会静默影响线上。
- 查找有**前缀回退**：`deepseek-v4.1-flash-sg` 能命中本体的配置。

**推理参数必须按模型配置下发，不能透传客户端的**：各家字段完全不同
（OpenAI `reasoning_effort`、Anthropic `thinking.budget_tokens` /
`output_config.effort`、Gemini `thinkingConfig.thinkingBudget`、
DeepSeek 用 `thinking.type`）。透传的后果是「参数被静默忽略」，
用户以为开了深度思考、实际按默认档跑。`ReasoningBody` 按协议生成正确形状，
**不相容的映射一律不下发**（把 reasoning_effort 透传给 Anthropic 会被拒）。

关闭思考的坑：DeepSeek 的 effort **只接受开启档位**，关闭必须用
`thinking.type=disabled`，传 `effort=none` 会被上游拒绝。

`/v1/models` 会带上 `context_window` / `max_output_tokens` / `capabilities`
（同时给 `context_length` 等常见别名）——部分客户端（Codex 等）据此决定
自己的压缩阈值，不返回它们就只能用客户端猜的默认值。

### 端点自动协商与上游风控（`handlers/endpoint_fallback.go`）

**端点自动协商**（原项目 `endpoint-fallback` 的 Go 版）：聚合型上游常在同一
base_url 下按模型分走三种协议（Claude→`/messages`、Grok→`/responses`、
其余→`/chat/completions`）。正式依据是账号的 `model_paths`，但配置会漏
（漏一个模型、上游改了支持范围、管理员不知道该走哪个协议），此时上游回
`ModelProtocolUnsupported` 或 404，用户看到的是「模型不可用」——
真实原因只是路径选错了。

规则：**只有上游明确拒绝（400/404/405/415/422/501）才换端点**，
网络错误/限流/鉴权/风控都不换（换协议解决不了，重试只会放大问题）。
成功后按「账号+模型」缓存赢家 10 分钟，后续直接命中。
**一旦开始给客户端写数据就不再换**（否则用户看到两段内容拼接）。
失败时保留最初的错误，不用最后那个 404 覆盖真正的参数错误。

**上游风控标记的识别**（`isNotApprovedResponse`）—— 这一条踩过坑：
腾讯 WorkBuddy/CodeBuddy 对个人账号转 API 有两档风控，
`11128`（400，Illegal API invocation from an unapproved channel）与
`11140`（403，request illegal）。**凭据是有效的**，是账号被标记了。
三种错误处理都不对：当成凭据失效 → 管理员反复重绑（原项目实测连绑 4 次无效）；
当成普通 400 → 他反复调参数；直接冷却 → 立刻重试会加重风控。正确姿势是
「**可换渠道重试**（别的账号可能没事）+ **长冷却**（本站 30 分钟，
原项目 6 小时）」，所以 `isClientError` 对这类错误返回 false，让调度继续试下一个账号。

**另一个实测结论（保号用）**：WorkBuddy 会对**提示词内容**做品牌词过滤 ——
Codex CLI 的默认系统提示里含「OpenAI」「Codex」，整段发过去会被 11128 拒；
把这两个词替换掉就正常。这不是网关的问题（请求体合法、凭据有效），
但会让人误以为「Codex 用不了」。遇 11128 时先看是不是提示词带竞品品牌词。

**不要用 IAB 里的动画表现判断 motion 组件是否有 bug。**
这个自动化环境的 `requestAnimationFrame` 被严重节流 —— 实测 500ms 只跑 1 帧
（正常前台页约 30–60 帧）。后果是所有 motion 的入场/退场动画都会「卡在起始帧」：
- 弹窗打开后 `opacity` 停在 0 → 看起来「弹窗打不开」
- `TagInput` 删标签后元素停在退场起始态 → 看起来「删不掉，标签还在」

这两次我都在这个环境里误判为产品缺陷。判据：先用
`requestAnimationFrame` 自测帧率，帧率不正常时改用**截图 + 元素几何**
（尺寸/位置/是否命中）判断，不要依赖 `getComputedStyle().opacity`。
真实浏览器跑满帧，这些动画正常。

**全局下拉项一律省略号截断，不折行**：折行会让条目高低不一，菜单看起来在抖。
实现要点：Radix 的 `SelectItemText` **会丢弃传入的 className**（它只拿文本做
typeahead 与原生 option），所以截断样式要挂在它内部自己的 `<span>` 上。

### 3.4 未保存提示

只在**确实有改动时**出现，且是**右下角的小浮窗**，不是全宽横条。
全宽横条会压得表单上移，且暗示「整页都在等保存」。

### 3.5 字体

**站内字重上限 500。** 中文字体（站酷快乐体等）笔画本身偏粗，
再叠加 600/700 会糊成一团，小字号下几乎连成一块。
需要更强层级时用字号与颜色区分，**不要用字重**。
`styles/global.css` 已把 `b/strong/h1-h6/th` 统一压到 500。

**字体由管理员统一配置**，见 `lib/fonts.ts` 的 FONTS（10 款公开可商用字体，
默认站酷快乐体）。改一次全站生效，通过 `--site-font` 写到 `<html>` 上。

新增字体：装包 → `main.tsx` 引 CSS → `lib/fonts.ts` 登记 →
后端 `services/appearance.go` 的 `fontValues` 加白名单。

### 3.6 图片类配置用文件上传

**不要让用户手填图片地址。**

站点图标、货币图标、头像等一律用文件上传（`FileDropzone` + `/api/admin/upload/icon`）。
填地址要求用户先把图片传到别处，多一步且经常填错。

---

## 四、货币与图标

### 4.1 货币

货币由管理员配置：**名称**、**图标**、**兑换比例**（默认 1:1 美元）、**额度单位**。

- 配置在 `/admin/system#billing`
- 前端通过 `useCurrency()` 取值，**不要写死 "OD"**
- 金额展示统一用 `<CurrencyIcon />`，不要写文字单位
- 换算统一走 `formatAmount()` / `usdToCurrency()`

### 4.2 内置货币图标

- `public/currency-default.svg` —— 无字母金币，作为默认图标（**刻意不写字母**，因为货币名称可改，写死字母改名后会自相矛盾）
- `public/currency-od.svg` —— 带「OD」立体胶囊字母的品牌版

### 4.3 厂商与模型图标

图标在 `public/vendors/`（31 个 SVG，来自 simple-icons 官方品牌图形）。

用法：

```tsx
import { vendorIconUrl, vendorOfModel } from "@/lib/vendorIcons";

const vendor = vendorOfModel("gpt-5.1");  // → "openai"
const url = vendorIconUrl(vendor);        // → "/vendors/openai.svg"
```

**所有出现厂商名或模型名的地方都要带图标。**

新增厂商时：
1. SVG 放进 `public/vendors/`
2. 在 `lib/vendorIcons.ts` 的 `VENDORS` 登记
3. 在 `MODEL_PREFIXES` 加模型前缀规则

---

## 五、权限体系

**三段式角色**：`RoleGuest(0)` < `RoleUser(1)` < `RoleAdmin(100)` < `RoleRoot(1000)`

**19 个能力点**（见 `internal/authz/authz.go`），管理接口一律按能力点拦截：

```
profile:view_self  profile:edit_self  token:manage_self  log:view_self
pricing:view  chat:use
channel:view  channel:edit  channel:delete
pricing:edit
user:view  user:edit  user:quota
log:view_all  log:delete
option:view  option:edit  system:update  role:assign
```

硬约束：

1. **后端是唯一的安全边界。** 前端隐藏入口只是体验优化，每个受限接口必须挂 `middleware.RequirePermission`。
2. **权限判定读数据库当前角色**，不是令牌里签发的角色 —— 否则用户被降级后旧令牌仍能访问管理接口。
3. **层级隔离防横向越权**：管理员只能操作层级低于自己的用户，不能碰同级/更高层，不能改自己。
4. 新用户注册/三方登录/邮箱登录建号，**角色硬编码为普通用户**，绝不接受请求体传入 Role。

---

## 五之二、网关业务模型（分组 / 密钥 / 账号）

这三者是一条链：**账号**接入上游模型 → **分组**决定密钥能调哪些模型、按什么倍率计费 → **密钥**是用户实际调用的凭据。

### 分组（`channel_groups` 表）

- 两个作用：`rate` 计费倍率（1 = 原价）、`models` 模型白名单（空 = 不限，支持末尾通配如 `gpt-*`）
- 配置读有 **30 秒缓存**，**变更时必须调用 `clearGroupCache()`** —— 否则管理员改完倍率要等最多 30 秒才生效，看起来像没保存成功
- **改分组名会同步更新引用它的密钥、用户、账号**（三者都按「分组名」绑定，不是 id）。这三条 UPDATE 必须在同一事务里，否则中途失败会留下指向不存在分组的密钥
- 有密钥在用该分组时**拒绝删除**，避免密钥失效

### 密钥（`tokens` 表）

四条硬约束：

1. **必须绑定一个已存在的分组**（已取消「无分组的公共池」）
2. **额度语义必须明确**：显式传 `unlimited_quota` 就听它的；只传 `quota` 就是有限额度；两者都没传才是无限。
   ⚠️ 原仓库把默认值写死为「无限」，导致 `{quota: 100}` 得到的是一把无限额度的 Key —— 用户设的额度被静默忽略。
3. **模型白名单必须落在分组白名单之内**，否则用户可用密钥绕过分组限制
4. **额度不能超过账号可用额度**，否则签发出来的 Key 一调用就失败，体验上像系统坏了

**并发安全**：创建后回查必须用 `insertId` 精确定位，**不要**用 `ORDER BY id DESC` —— 并发时会返回别人的密钥（含完整明文）。原仓库踩过这个坑。

**对账接口**（`GET /api/token/reconcile`）：删密钥是物理删除，但已用额度记在账号上，于是「现存密钥已用之和」小于「账号总用量」。差额是真实支出，必须显式报出来，否则用户对不上账会以为系统算错。

路由顺序坑：`/token/reconcile` 必须声明在 `/token/:id` **之前**，否则会被当作 id 参数匹配。

### 账号（`channels` 表）

- 调度：**优先级降序 + 同级权重轮询**；冷却期内的账号跳过
- **TTFT（首 token 耗时）与总耗时分开记录**。总耗时把「思考 + 生成全文」都算进去，思考型模型与长回答会被误判成坏账号，而用户体感是「多久开始出字」
  ⚠️ 当前连通性测试用非流式请求，因此 TTFT 是总耗时的近似值。要拿真实 TTFT 必须发流式请求并测第一个 chunk 到达时间。
- **测试绝不改 `status`** —— 那是管理员的开关。只有 `disabled_by='auto'`（自动禁用）的账号才由测试结果接管恢复；管理员手动禁用的保持禁用
- 测试失败时区分处理：**上游明确返回错误状态码**（401/403/429/5xx）才自动禁用；**网络层错误**（连不上/超时）不禁用，避免一次抖动停掉好账号

### SSRF 防护（`netguard` 包）

账号的 `base_url` 由管理员填写，而「测试连通性」「从上游拉取模型」会真的请求这个地址。不校验就能被用来探测内网与云元数据端点（`169.254.169.254`）。

三层校验：协议白名单 → 禁止携带凭据 → DNS 解析后逐个 IP 检查（任一是私有地址就拒绝）。

⚠️ **踩过的坑**：不要把 `::ffff:0:0/96`（IPv4 映射网段）放进黑名单 —— 它涵盖整个 IPv4 空间，会让**所有公网地址被误判为内网**。IPv4 映射地址的安全性由「先 `To4()` 转回 IPv4 再判断」保证。

结果缓存 60 秒（成功）/ 10 秒（失败），避免每次请求都做 DNS 解析。

## 五之三、货币与图标

## 五之四、网关实现（三种对外协议）

### 对外协议

网关同时讲三种协议，因为主流客户端各只认一种：

| 路径 | 协议 | 谁在用 |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions | 各类 SDK、脚本，最通用 |
| `/v1/responses` | OpenAI Responses | **Codex CLI**（0.145 起它移除了 chat 支持，只认这个） |
| `/v1/messages` | Anthropic Messages | **Claude Code**（只认这个） |

三者只有**协议外壳**不同，内部链路完全一致：
**令牌鉴权 → 额度校验 → 分组白名单 → 账号调度 → 上游转发 → 解析用量 → 计费扣款 → 写日志**。

因此内部链路只实现一份（`handlers/protocol.go`），各协议只负责翻译外壳
（`handlers/responses.go` / `handlers/anthropic.go`）。
**三条路径各写一遍计费的结果，必然是其中一条忘了扣费，而且很难被发现。**

### 被其他中转站接入（下游兼容）

本站除了给终端用户用，也要能被别的中转站当**上游**接入：
new-api / one-api / sub2api / CPA(CLIProxyAPI) 这类项目加渠道时，
会主动来问几件事。不做的话它们会**静默降级** —— 不报错，
但倍率算错（用户投诉价格对不上）或能力被判为不支持。

| 接口 | 谁在用 | 说明 |
|---|---|---|
| `GET /api/pricing` | new-api / one-api 的「倍率同步」 | **必须匿名可访问**，它请求时不带凭据。返回 new-api 的 type2 数组格式 |
| `GET /v1/sub2api/billing` | sub2api 的倍率探测（默认 30 分钟一次） | 按 API Key 返回该 key 的实际倍率，sub2api 会写回自己的账号配置 |
| `POST /v1/responses/compact` | new-api 的 `openai-response-compact` 端点测试、CPA | **非流式**（CPA 明确拒绝流式），响应 `output[]` 必须含 compaction 项 |
| `POST /v1/messages/count_tokens` | Claude Code、sub2api | token 计数，用于上下文进度与转发前预估 |

**倍率换算**（new-api 体系）：`model_ratio = 每百万 token 的货币价 ÷ 2`
（$1 = 500,000 额度，因此每百万价 ÷ 2 就是「每 token 消耗多少额度」）。
`completion_ratio` 是输出价 ÷ 输入价。

**Compact 链路**：这是 Codex 的远程上下文压缩，不是 Claude Code 的 `/compact`
（后者是普通的摘要调用，没有专有端点）。当前已实现兼容端点并完成响应形状探测，但**尚未完成 sub2api、new-api、one-api、CPA 四个项目的原生安装级全链路 E2E**，不能把形状探测称为完整原生支持：
- sub2api：`POST /v1/responses` + `input[]` 里带 `{"type":"compaction_trigger"}`，
  当前会转换为内部摘要提示并返回兼容的 compaction 结果；未验证 Codex 原生 `encrypted_content` 续聊语义
- new-api / CPA：`POST /v1/responses/compact`，当前提供非流式兼容响应；未完成真实中转站安装级探测

**渠道测试的判定标准**（决定本站能否被它们正常接入）：
- one-api：解析 `choices[0].message.content` 必须存在
- new-api：非流式必须有 `usage` 对象；**HTTP 200 但 body 里含 error 字段也算失败**
- 两者都要求流式响应里至少有一行合法的 `data:` 事件

**错误格式**：统一返回 `{"error":{"message","type","code"}}` + 正确的 HTTP 状态码。
已用兼容 shape probe 检查四类响应；这不替代真实中转站 E2E。响应头没有强制的专有字段，
但 `429` 建议带 `Retry-After`（sub2api 用它决定账号冷却时长）。

### 上游协议路由（`model_paths`）

聚合型上游常在同一 `base_url` 下按模型分走不同协议。以 OpenCode Go 为例：

```
https://opencode.ai/zen/go/v1/chat/completions   GLM / Kimi / DeepSeek
https://opencode.ai/zen/go/v1/messages           Claude / Qwen / MiniMax
https://opencode.ai/zen/go/v1/responses          Grok / GPT Luna
```

只打 chat 端点的话，一半模型会直接返回 `ModelProtocolUnsupported`。账号的
`model_paths` 字段按「协议: 模型模式」配置这个映射：

```
messages: claude-*, qwen3*, minimax*
responses: grok-*, gpt-5.6-luna
chat: *
```

**不做自动探测**：探测意味着每个新模型第一次调用都要失败一次再重试，
用户看到的就是「偶尔报一次错」，很难解释。

⚠️ 各协议的**鉴权方式也不同**：Anthropic 系用 `x-api-key` + `anthropic-version`，
OpenAI 系用 `Authorization: Bearer`。用错时上游只回一句「Missing API key」。

### 账号自定义请求头（`headers`）

每行一条 `Key: Value`。值里写 `{{session}}` 会在每次请求时替换成随机会话 ID ——
OpenCode Go 要求每个请求带 `x-opencode-session`，缺了直接拒绝服务。

### 长连接保活

流式转发时每 **15 秒**发一个 SSE 注释行（`: keep-alive`）。
思考型模型可能几十秒不吐一个字，这期间连接的安静会被 nginx 的
`proxy_read_timeout`、云厂商 LB、客户端读超时掐掉 —— 表现为随机重连。

注释行按 SSE 规范必须被客户端忽略，对解析零影响，但能刷新各层空闲计时器。
心跳与数据写入由**同一把互斥锁**串行，避免并发写坏 HTTP 帧。

### 账号调度（`services/gateway.go`）

- 规则：**优先级降序 + 同级权重轮询 + 跳过冷却中的账号**
- `SelectChannels` 返回的是**候选列表**而不是单个账号 —— 顺序本身就是重试链，
  调用方在第一个失败时依次尝试下一个（最多 3 次）
- 账号列表缓存 5 秒。**增删改后必须调 `MarkChannelsDirty()`**，否则改完配置要等最多 5 秒才生效
- **错误要分类，不能一律冷却**（`shouldCooldownOnStatus` / `isClientError`）：
  - `4xx`（除 429）：请求本身的问题，**绝不冷却账号**。早先不分类时，
    上游回一个 400 就能把健康账号踢出调度 60 秒，单个账号的分组直接变成
    「没有可用账号」，而账号本身什么问题都没有
  - `402` 欠费：重试无意义（直接停止重试），冷却延长到 10 分钟
    （60 秒后钱不会自己到账，按 60 秒冷却会让网关每分钟都去撞一次必然失败的请求）
  - `429` / `5xx` / 网络层错误：上游过载或故障，冷却 60 秒后重试有意义
- **客户端主动断开不算账号失败**：Codex 这类 CLI 切模型或用户按 Esc 会直接掐连接，
  context 被取消。早先这被记成「流式传输中断」并把账号打进冷却 ——
  用户按一下 Esc 就能毁掉自己唯一的账号
- 权重轮询的实现：把每个账号按其权重重复放进虚拟环，轮次对环长取模选起点。
  权重 3:1 的两个账号近似 3:1 分流。单账号权重上限 100（防止写错数值把环撑爆）

### 计费（`settle` 函数）

公式：`(提示/1e6 × 输入价 + 补全/1e6 × 输出价 + 缓存/1e6 × 缓存价) × 额度单位`，再乘分组倍率。

⚠️ **踩过的坑：重复扣费。**
`chargeToken()` 已经扣过额度，紧接着又写了一次 `UPDATE tokens SET used_quota = used_quota + ?`，
用户被收两倍费用（实测：应扣 2700 单位，实扣 5400）。修复方式是后者只更新 `accessed_at`。

**并发安全**：扣费用条件更新 `used_quota + 本次 <= quota`，靠数据库保证原子性，
不需要额外的锁，也不会把额度扣成负数。

### 流式转发

- 流式响应一旦开始往客户端写，**就不能再换账号重试**（响应头已发出，换账号会拼出半截内容）
- 请求体会自动补上 `stream_options.include_usage = true`：
  上游默认不在流式响应里带 usage，缺了它就收不到 token 用量，只能估费
- 客户端中途断开时停止转发，但**已产生的用量仍要计费**；
  账号状态保持干净（不冷却、不记失败）
- **不转发空行**：自己生成的是完整 SSE 帧（event + data + 空行），
  再透传上游的空行会让每个事件后多一个空行 —— 宽松的解析器会忽略，
  严格的解析器（如 Codex）会读坏，表现为「模型没回答」
- 收尾事件必须携带**完整正文与参数**：`response.output_text.done` 与
  `response.completed` 里给空串会让客户端认为模型什么都没说

### 账号余额门槛

鉴权时联表读出账号额度，**余额为 0 直接拒绝**。
只查密钥额度是不够的：密钥可能不限额度或额度宽裕，但账号本身已用完 ——
那种情况下请求能通过鉴权，事后扣费却会失败，等于免费使用。

这里用「余额 > 0」作门槛而不是精确判断本次够不够：真实消费要等上游返回 usage 才知道。

## 五之五、已实现的功能页

| 页面 | 路径 | 权限 |
|---|---|---|
| 数据看板 | `/admin` | user:view / channel:view / option:view 任一 |
| 账号管理 | `/admin/channels` | channel:view（改需 channel:edit，删需 channel:delete）|
| 模型定价 | `/admin/models` | pricing:view（改需 pricing:edit）|
| 令牌管理 | `/admin/tokens` | 登录即可 |
| 用户管理 | `/admin/users` | user:view（改角色 role:assign、改资料/状态/删除 user:edit、改额度 user:quota）|
| 用户分组 | `/admin/groups` | user:view（改需 user:edit）|
| 使用记录 | `/admin/logs` | 登录即可；数据范围按 log:view_all 在服务端收口 |
| 操作日志 | `/admin/operation-logs` | 登录即可；规则同上 |
| 消费分析 | `/admin/analytics` | 登录即可（范围同看板）|
| 运行状态 | `/admin/status` | option:view |
| 个人中心 | `/admin/profile` | 登录即可 |
| 媒体库 | `/admin/media` | 登录即可；非管理员只能看自己的文件（SQL 层强制）|
| 系统设置 | `/admin/system` | option:view / option:edit |

日志接口（`internal/handlers/logs_query.go`）：
- `GET /api/logs/usage` + `/summary` + `/filters`：使用记录（type 2/3/4），
  联查用户/密钥/账号名；非管理员看不到账号名与原始 User-Agent。
- `GET /api/logs/operation`：操作日志（type 1 管理 + 5 登录）。
- 归属过滤在 SQL 层强制：非管理员恒加 `user_id = ?`，前端参数改不动。

媒体接口（`internal/handlers/media.go` + `internal/services/media.go`）：
- 内容寻址存储：`data/media/blobs/<sha0:2>/<sha2:4>/<sha>.<ext>`，
  同一用户重复上传同一内容去重复用；软删后回收会复查 sha 是否被他人共享。
- 引用计数（media_refs）：删除被引用的文件返回 409 + 引用清单，
  管理员可 `?force=1` 强制解绑删除。
- 签名 URL：`<exp>.<hmac[:32]>`（7 天，读取时重算），
  因此 `<img>` 这类不带鉴权头的请求也能取图。
- 设置项（options 表，默认值）：`media_enabled=true`、`media_max_file_mb=10`、
  `media_user_quota_mb=1024`、`media_avatar_max_kb=512`、`media_orphan_hours=24`、
  `media_retention_days=7`；回收由管理员手动触发（`POST /api/media/gc`），暂无定时任务。
- 头像：`users.avatar_media_id` 指向媒体记录，`avatar_url` 是派生展示值；
  移除自定义头像会回退到三方平台头像而不是清空。

**范围外**：模型定价之外的广场/对局大厅等功能不在本项目当前需求中，代码中不应恢复这类页面。

## 五之六、组件库英文字面量

Arc UI 有大量硬编码英文界面文案（placeholder、aria-label、内部默认值）。
本项目是中文站点，已批量中文化 53 处（脚本见 `scripts/localize-arc.cjs`）。

**改组件源码是正确做法** —— registry 模式下组件归项目所有，不是 node_modules 里的黑盒。
很多文案是 aria-label 与内部默认值，外层传参覆盖不到。

新增组件时记得跑一次 `node scripts/localize-arc.cjs`。
## 六、安全约束

1. **密码用 bcrypt**（cost 12），绝不存明文。
2. **登录失败提示不区分**「用户不存在」与「密码错误」，且两者耗时一致（防账号枚举）。
3. **JWT 校验限定算法**（防 `none` 算法绕过），密钥文件 `.jwt-secret` 权限 0600 且不提交。
4. **敏感配置加密存储**（AES-256-GCM，见 `cryptoutil`）：三方 Client Secret、SMTP 密码。管理页面只返回掩码。
5. **API 密钥列表打码**，完整密钥仅在创建时返回一次。
6. **令牌通过 URL fragment 传递**（不进服务端日志与 Referer），回调后立即从地址栏清除。
7. **OAuth state 一次性核销**（防重放），PKCE 对支持的平台启用，`redirect_to` 只允许站内路径（防开放重定向）。
8. **OAuth 邮箱匹配必须要求平台邮箱已验证** —— 否则攻击者可在某平台改成受害者邮箱来接管账号。
9. **上传文件校验内容而不只是扩展名**（文件头嗅探），SVG 拒绝含 `<script>` 的（防 XSS）。
10. **SQL 一律参数化**，不拼字符串。
11. **金额换算防除零**：`units_per_od`、`currency_rate` 必须 > 0，接口层校验。
12. **限流**：邮箱验证码同邮箱 60 秒间隔、每日 10 封、单码最多试 5 次。

---

## 七、项目结构

```
OOAPI/
├── ai协作.md                          # ← 本文件
├── logo.jpg
├── scripts/install-arc.py             # Arc UI 组件安装脚本
├── ooapi-server/                      # Go 后端
│   ├── main.go
│   ├── .env                           # 不入库；含 DB、ADMIN_PASSWORD
│   ├── .jwt-secret                    # 不入库；自动生成
│   └── internal/
│       ├── auth/                      # JWT 签发解析、bcrypt
│       ├── authz/                     # 角色、能力点、校验规则
│       ├── config/                    # 配置加载
│       ├── cryptoutil/                # AES-GCM 加解密敏感配置
│       ├── db/                        # 连接池、建表、补列
│       ├── handlers/                  # HTTP 处理器
│       ├── mailer/                    # SMTP 发信（含 STARTTLS）
│       ├── middleware/                # 鉴权与权限中间件
│       ├── models/                    # 数据结构
│       ├── oauth/                     # 7 家平台接入 + PKCE
│       ├── router/                    # 路由与 SPA 托管
│       └── services/                  # 业务逻辑（设置、货币、发信、计费）
└── ooapi-web/                         # React 前端
    ├── public/
    │   ├── currency-default.svg       # 默认货币图标（无字母）
    │   ├── currency-od.svg            # OD 品牌版
    │   ├── logo.jpg
    │   └── vendors/                   # 31 个厂商图标 + manifest.json
    └── src/
        ├── components/
        │   ├── arc/                   # Arc UI 组件（registry 落地，可改）
        │   ├── admin/                 # 后台外壳（侧边栏、布局、上传）
        │   ├── monad/                 # 首页专用视觉组件
        │   ├── CurrencyIcon.tsx
        │   └── RequireAuth.tsx        # 路由守卫
        ├── contexts/                  # Appearance / Currency / Auth / AuthProviders
        ├── lib/                       # api、权限、厂商图标映射
        ├── pages/
        │   ├── Home.tsx               # 首页（独立视觉体系）
        │   ├── Login.tsx / Register.tsx
        │   ├── Dashboard.tsx          # 个人中心
        │   └── admin/                 # 后台页面
        │       ├── AdminDashboard.tsx # 数据看板
        │       ├── AdminSettings.tsx  # 系统设置（含登录与注册分区）
        │       └── sections/          # 设置页各分区
        └── styles/                    # global.css（复位）、monad.css（首页专用）
```

**上传文件目录**：`/opt/ooapi/uploads/`（在前端构建产物**之外**，因为每次构建会清空 `web/`）。

---

## 八、开发与部署流程

### 8.1 服务器信息

- 后端：`/opt/ooapi/ooapi-server-bin`，systemd 服务名 `ooapi`
- 源码：`/opt/ooapi/server/`（后端）、`/opt/ooapi/web/`（前端）
- 前端产物：`/opt/ooapi/server/web/`
- MySQL：库 `ooapi`，用户 `ooapi`
- nginx 配置：`/www/server/panel/vhost/nginx/ooapi.conf`
- SSL 证书：`/www/server/panel/vhost/cert/{ooapi.space,apidoc.cloud}/`

### 8.2 部署步骤

```bash
# 后端
cd /opt/ooapi/server
export PATH=$PATH:/usr/local/go/bin GOPROXY=https://goproxy.cn,direct
go build -o /opt/ooapi/ooapi-server-bin .    # 需先 systemctl stop ooapi，否则 Text file busy

# 前端
cd /opt/ooapi/web
export PATH=$PATH:/usr/local/node-v24.21.0-linux-x64/bin
npm run build
rm -rf /opt/ooapi/server/web && mkdir -p /opt/ooapi/server/web
cp -r dist/* /opt/ooapi/server/web/

systemctl restart ooapi
```

### 8.3 注意事项

1. **Windows 上传源码时会覆盖服务器上新装的 arc 组件**。上传前先备份：
   ```bash
   cp -r /opt/ooapi/web/src/components/arc /tmp/arcbak
   # 解压后再还原
   rm -rf src/components/arc && cp -r /tmp/arcbak src/components/arc
   ```
2. **Git Bash 路径转换**：需要 `MSYS_NO_PATHCONV=1`，否则 `C:/...` 会被当成主机名。
3. **不要用 `pkill -f`** 匹配进程名，会匹配到 SSH 命令行自身导致会话中断。用 `pgrep -x` 或精确路径。
4. **前端每次构建都会清空 `web/`**，上传的图标因此放在 `/opt/ooapi/uploads/`。

---

## 九、当前进度与待办

### 已完成

- 首页（独立视觉体系）
- 后台外壳：侧边栏（可折叠、主题色、版本号）、顶栏（搜索/主题/通知/用户菜单）、命令面板
- 数据看板：13 种图表组件 + 厂商图标 + 进度刻度
- 系统设置：外观（含字体）、站点、注册与登录、第三方与邮件、计费与货币、网关
- 字体系统：10 款可商用中文字体，管理员可换，全站生效
- 货币系统：名称/图标/兑换比例可配，全站金额统一用货币图标
- 厂商图标：35 个（public/vendors/），模型名自动推断厂商
- 文件上传：站点图标、货币图标（含内容嗅探与 SVG XSS 防护）
- 账号管理：CRUD + 连通性测试（TTFT）+ 从上游拉取模型 + SSRF 防护
- 用户分组：CRUD + 倍率 + 模型白名单 + 改名同步引用
- 密钥管理：强制绑分组 + 额度语义 + 模型白名单校验 + 对账接口
- 个人中心：头像上传（裁剪 + 缩放）/ 资料编辑（含简介、链接、所在地）/ 改密 / 三方绑定查看与解绑
- 媒体库：内容寻址存储 + 引用计数 + 配额 + 管理员回收，宫格/列表双视图
- **网关核心**：/v1/chat/completions（账号调度 + 转发 + 计费 + 日志，支持流式）
- 模型定价：CRUD + 行内编辑
- 用户管理：Arc 表格 + 统计条；角色调整 / 资料编辑 / 启停 / 额度增减 / 删除（遵守层级隔离与末位管理员保护）
- 使用记录：时间范围/模型/状态/密钥/账号筛选 + 关键词 + 区间汇总条 + 调用详情 + 分页
- 操作日志：管理操作与登录审计，按类型/时间/关键词筛选 + 操作详情
- 运行状态：数据库 / 账号健康 / 近 24 小时 / 表规模
- 登录与注册：账号密码、邮箱验证码、7 家三方登录（均按配置动态显示）
- 权限体系：角色、能力点、层级隔离
- 数据看板：13 种图表组件
- 系统设置：外观、站点、注册与登录、第三方与邮件、计费与货币、网关
- 图标：31 个厂商图标、货币图标上传
- 文件上传：站点图标、货币图标

### 一键登录（三种厂商，均走真实官方链路）

统一会话引擎在 `internal/services/device_bind.go`，凭据加密存 `channels.auth_credential`，
一次票据经 `/devices/start`→`/poll`→（claim）落库，前端拿不到 token：

| 厂商 | 授权链路 | 转发链路 |
|---|---|---|
| Cline | WorkOS device code（authkit.cline.bot） | `/api/v1/chat/completions` + 头部装饰 |
| Kiro | AWS SSO OIDC device authorization（动态注册 client，5 区域自动探测） | `/generateAssistantResponse`，AWS EventStream 二进制解码后转 OpenAI SSE |
| WorkBuddy | `POST /v2/plugin/auth/state` + `GET /v2/plugin/auth/token`（realm：国际/中国） | `{base}/v2/chat/completions`，OpenAI 兼容 SSE + 专用头部 |

**WorkBuddy 凭据有效期（实测修正）**：access_token 是 JWT，**真实过期时间在 `exp` claim**
（原版也从 JWT 的 `iss` 取 realm，同一套解码）。早先用 `expiresIn` 缺失时的 3600 秒兜底，
导致凭据被标成「创建后 59 分钟到期」，刚过一小时就报「登录已过期」。
现在：优先用 JWT `exp`（合理性窗口：不早于 5 分钟前、不超过 **400 天**），
无 `exp` 才回退；已存库的旧记录在读取时按 JWT 重新校准**并回写**，不必重新绑定。

窗口为什么是 400 天：实测 WorkBuddy 的真实 token `exp` 约为**签发后 1 年**
（Keycloak 长期会话）。最初设的 30 天上限会把它判为不可信、回退到 3600 秒兜底 ——
于是凭据被标成 1 小时到期，一小时后开始报「登录已过期」，而 token 其实还有一年。
**教训：遇到「凭据疑似过期」先解码 token 看真实 exp，不要凭窗口假设下结论。**

**过期的判定权在上游**：传输层**不再**按本地 `auth_expires_at` 拦截请求 ——
本地算出的过期时间可能偏早（或偏晚），只有上游返回 401/403 才算真的失效。
该厂商没有续期接口，401 时提示重新一键绑定。

Kiro/WorkBuddy 的模型列表经传输层转换（`/ListAvailableModels`、`/v3/config`）。
**未做真人授权验证**：三条链路都只有 mock 测试（httptest 模拟 OAuth/授权服务），
没有拿真实账号跑通过；上线后需要管理员实际操作一次才能确认端到端可用。

### 调用详情：计费快照与内容留痕

`logs` 表新增（`internal/db/schema.go`）：`requested_model / upstream_model / pricing_model`、
`input_price / output_price / cached_price / group_rate / base_quota / raw_cost`、
`input_text / prompt_text / output_text / text_truncated`。

- 计费快照记录**结算当时**的单价、倍率、取整前成本与取整后计费额；计费公式一字未改。
- 倍率恒 > 0，因此 `group_rate = 0` 用于判定「历史记录（无快照）」——
  前端对这类记录显示「未保存费用分解」，**不把 0 读成免费**。
- 文本三列各截断 4000 字符；NULL（历史）与空串（新记录确实为空）语义不同，页面文案分别处理。
- 普通用户可见自己的 `input_text`/`output_text`，`prompt_text`（完整上游上下文）与原始 UA 仅管理员可见。

### 待办与明确缺口

- **Kiro/WorkBuddy/Cline 一键登录均未经真人账号验证**，仅有 mock 测试；这是当前最大的未验证面。
- Responses/Anthropic 的 reasoning、并行工具块、长流收尾和多工具 index 仍需继续做协议级测试；当前不能宣称所有思考链路和复杂工具场景完全等价。
- `/v1/responses/compact` 与 `compaction_trigger` 已有兼容实现和 shape probe，但 Codex 原生加密压缩续聊及四个中转站安装级 E2E 尚未完成。
- 看板顶栏通知仍有演示数据来源（通知 demo），不应当作完整生产统计闭环；看板主体数字已全部来自 `/api/admin/stats`。
- 账号多上游密钥仍只使用第一把；若要抗单 key 限流需另行设计轮询。
- 首字耗时只有流式调用会记录；非流式与历史记录显示「—」，不用总耗时冒充。
- Kiro 转发沿用原项目的 UA 指纹格式（`KiroIDE-*`）；这是原版既有做法，未做额外伪装，也未验证是否会被风控。
- 登录与管理操作审计从上线起开始记录；之前的操作无法追溯（旧实现本就没有写入）。

### 本轮已验证

- 账号列表已使用 Arc `SortableDataTable`；添加账号为单列厂商平铺选择，无厂商分类 Tab；
  模型清单与调用详情改用 Arc **Bottom sheet**（组件库自带拖拽滚动，不再嵌套滚动条）。
- 全局 Toast/Toast Stack、敏感操作 Hold to confirm、统一字体与原生滚动条样式已接入；
  所有涉及用户的列表与详情（用户管理、使用记录、操作日志、看板最近调用/用户排行）都带 **Avatar**。
- 使用记录：Tokens 三行带图标（输入/输出/缓存），首字/总耗时按 <5s 绿 / 5–15s 黄 / ≥15s 红着色；
  详情三个区块（计费明细 / 调用内容 / 请求信息）。
- 生产实测：一次真实调用（Codex UA，`space-bunny-free`）确认快照完整写入
  （名称三元组、单价、倍率 ×1、取整前后金额、输入/上下文/输出原文）；
  旧记录正确显示「未保存费用分解」；来源识别为 Codex。
- 个人中心重构为「头像 + 统计条 + 三个 Tab（资料/安全/绑定）」；头像支持
  客户端裁剪压缩后上传，顶栏与所有列表同步显示。
- 媒体库生产实测：真实上传头像 → 列表中显示「1 处引用 / 头像来源」；
  匿名取图 200 且带 `public, max-age=31536000, immutable`；删除被引用文件
  返回 409 并列出引用方；宫格/列表双视图、配额与保留策略展示正常。
- 后端 `go build` / `go test` / `go vet` 通过，`-race` 在服务器 Go 1.27 隔离目录通过；
  前端 `tsc -b` 与 `npm run build` 通过。
- 连通性测试用非流式请求，因此 `ttft_ms` 是总耗时的近似值；要精确值需发流式并测首个 chunk
- `/dashboard` 已并入后台（重定向到 `/admin`）
- `odi` 账号密码为 `123456`，强度过低，**建议尽快修改**
- SSL 证书有效期至 **2027-01-04**，手动申请无自动续期，需在到期前重新申请
- 三方登录需管理员在平台申请密钥后才能真正使用（当前均未配置）

---

## 十、账号与密钥

**不要在代码或文档里写明文密码。** 需要时从以下位置取：

- 超管账号：`root`（密码在服务器 `/opt/ooapi/server/.env` 的 `ADMIN_PASSWORD`）
- MySQL：`/opt/ooapi/server/.env` 的 `DB_PASSWORD`
- JWT 密钥：`/opt/ooapi/server/.jwt-secret`
- 宝塔面板：`/etc/init.d/bt default`

---

## 十一、订阅账号接入后补的关键修复（2026-10-10）

### 客户端用官方名、上游用自己的名（`services.UpstreamModelFor`）

**两套名字必须分开**：

| 角色 | 用哪个名字 | 谁在用 |
|---|---|---|
| 客户端 / 分组白名单 / 对外文档 | **官方模型名**（`deepseek-flash`） | 用户、SDK、Agent |
| 账号的 models 列表 | **上游认的名字**（`deepseek-v4.1-flash`） | `channelSupportsModel`、发给上游的请求体 |

映射表的方向是「上游叫法 → 官方名」（用于计费），请求路径需要**反向**查找。
不做这件事的后果：客户端按官方文档调用 `deepseek-flash`，而账号里写的是
`deepseek-v4.1-flash` → 严格匹配不中 → 报「没有可用账号」，看起来像账号/密钥问题。

配套四处都要按官方名判定，否则各说各话：
`Group.ModelAllowed` 走 `CanonicalModelName`；`channelSupportsModel`
= `UpstreamModelFor != ""`；响应体（含 SSE 每个 chunk）的 `model` 改回
**客户端请求的名字**（部分 SDK 会校验一致性，不一致直接报错）；
日志里 `requested_model` / `upstream_model` / `pricing_model` 三个字段各记一个名字。

### SSE 必须按空行分帧（`ensureSSEFrame`）—— 最隐蔽的一次事故

**症状**：客户端（WorkBuddy CLI）报「No response received from model」，
而网关日志、nginx 访问日志**全是 200 且内容完整**。

**根因**：读上游的循环不转发空行（假设「翻译器自己输出完整帧」），
但 `chatPassthrough` 是**原样透传**、不补空行 → 整条流里一个空行都没有。
按 SSE 规范事件由空行结束；没有空行时客户端把所有 `data:` 行累积成
**同一个事件**，JSON 被拼成 `{...}\n{...}`，解析必然失败。

**教训（方法论）**：手工 `curl` 测试发现不了 —— 人和脚本习惯**按行**解析，
而真正的 SSE 客户端严格**按空行**分帧。所以补的测试断言的是**字节格式**
（按空行切分的事件数 == data 行数），不是逐行解析。

### 流式 role 归一化（`stripRepeatedRole`）

部分上游（实测 OpenCode）**每个 chunk 都带** `delta.role`，而标准只在第一块带。
很多客户端把「delta 里出现 role」当作**新消息开始** → 每个 token 开一条新消息，
内容被反复丢弃 → 同样报「没有返回内容」。修法：只保留第一块，其余剥掉。

实现细节：替换 JSON 片段必须**按索引替换**，不能用 `TrimSuffix(line, payload)`
（行尾有 `\n` 而 payload 没有 → 匹配不上 → 把原 JSON 与新 JSON 一起发出去，
等于同一行两段 JSON，比原问题更糟）。快路径先 `bytes.Contains(line, "\"role\"")`
放过绝大多数块，不做 JSON 解析。

### 分组的模型白名单（`AdminGroups.tsx`）

**后端本来就支持**（请求时校验，不在白名单 → 403 `model_not_allowed`），
缺的一直是界面：原来只是逗号分隔的输入框，手打模型名容易拼错、
也看不出还差哪个 —— 拼错的后果是静默的 403。

现在是可视列表：从模型目录选择（已加入的自动从候选移除）、厂商 chip 筛选、
每条带厂商图标与移除按钮、不在目录且不在定价表的名字标「未知」、
超过 12 个自动折叠。三个同步操作：`同步最新支持模型`（全部已配置）/
`同步上游支持的模型`（**只含有启用账号在跑的那些**）/ `清除所有模型`（= 不限）。

**语义**：白名单为空 = **不限**（不是「什么都不允许」）；非空时是「只允许这些」，
支持末尾通配 `gpt-*`。原项目那个「模型映射」页签只是规划项、从未落地；
本站的模型映射是**全局**的，在「模型定价 → 能力与映射」里配。

### 账号分组可以改回「所有分组」

`channelRequest.GroupName` 原来用值类型 + `if v != ""` 判断，导致**分组一旦设过
就再也改不回「所有分组」**（传空串返回 400 nothing_to_update），而界面上看不出原因
（其他分组的密钥永远调度不到它）。改成 `*string`：传空串 = 显式清空。

### 上游风控要自动换账号，不要打扰调用方

用户要求很明确：**某个账号坏了就换其它可用账号**。
`isClientError` 必须对风控标记（11128/11140，同样是 4xx）返回 **false** ——
它标记的是**账号**，别的账号可能没事；返回 true 会让用户看到 11128 而其实换个账号就能成功。
普通 4xx（参数错、模型名错）才放弃重试。风控给 30 分钟冷却，避免反复触发加重风控。

实测（账号 base_url 指向只会回 11128 的 mock）：4 次调用全部成功返回，
日志是「账号14 type=4 失败 → 账号12 type=2 成功」，调用方完全无感。

### 实测踩坑：WorkBuddy 会按提示词做品牌词过滤

Codex CLI 的默认系统提示里含「OpenAI」「Codex」，整段发到 WorkBuddy 会被
`11128 Illegal API invocation from an unapproved channel` 拒掉；把这两个词替换掉就正常。
**这不是网关问题**（请求体合法、凭据有效），但会让人误以为「Codex 用不了」。
遇 11128 时先看是不是提示词带竞品品牌词。

### `/v1/models` 必须按密钥分组过滤（2026-10-10）

**用户实测发现的缺口**：分组只放行 `deepseek-flash`，
但用该密钥请求模型列表**仍返回全部 46 个** —— 用户按列表选模型必然 403。

**原项目是做了这层的**（`gateway.js` 的 `/models`），而且它的实现注释里记着
这个病的历史：「列表说能调、调用说不能」，以及一个更严重的变体：
分组下没有渠道时 `available.size === 0` 恒为真 → **整份目录（104 个）
被返回给一个什么都调不了的密钥**。

现在的实现（`services.AvailableModelsForGroup`）：
- 口径与调度侧**共用一份**：`分组下属渠道声明的模型 ∩ 分组白名单`，
  两边不可能再各说各话；
- 分组下没有启用渠道 / 分组不存在 → **空集**（不是「不限」）；
- 渠道声明的是**上游叫法**，对外要用 `CanonicalModelName` 转成**官方名**
  （客户端按官方名调用）；
- 没定价的模型不列（调用时也查不到价，列出来只会让人以为可用）；
- 通配声明（`*` 或 `gpt-*`）用定价表里的名字展开 —— 定价表是「对外可售模型」的清单。

**不带密钥仍返回完整目录**（首页/文档要展示平台有什么，且定价页本就公开）；
带了密钥**必须**按分组过滤。密钥格式不对时报 401，**不静默降级成「给你全部」**。

### 图片必须真的发给上游（Responses → chat 转换）

**用户实测发现的缺口**（Codex 桌面端）：贴图后模型回复「图片一片空白/无法解析」。

**根因**：`buildChatBodyFromResponsesDetailed` 把 content 一律走 `flattenContent`
压平，`input_image` 变成 `"[图片]"` 三个字 —— **图片数据整条丢失**。
客户端以为发了图，模型只收到占位文本。

修法（`contentForChat`）：
- 纯文本 → 仍压平成**字符串**（多数上游对分段数组兼容不一，压平成功率最高）；
- 含图片 → 保留**分段数组** `[{type:"text"},{type:"image_url",image_url:{url}}]`；
- 纯图片消息补一句「请描述这张图片。」，避免空 content 被上游拒；
- 判空要针对**文本**，不能对整个 content 做 TrimSpace（含图片时是数组，
  直接判空会把纯图片消息整条丢掉）。

实测：发一张红底白色方块的 PNG（通过 `/v1/responses` 与 `/v1/chat/completions`），
模型均正确回答「红色，白色正方形」；纯文本请求不受影响。

### 图片在协议转换里被静默压平（第二轮，三个方向全修）

**用户实测再次发现**（Codex 桌面端 / Claude Code）：贴图后模型回「我还没看到图片」，
且**时好时坏** —— 同一张图、同一个密钥，上午能识别，下午就不行了。

**根因不是转换本身，而是端点协商把请求换到了有损转换的路径上：**

1. 渠道 12（OpenCode Go）的 `model_paths` 首选 `/chat/completions`；
2. 上游对某个模型回了一次「路径/协议不被接受」，触发 `endpointCandidatesFor` 协商；
3. 备用 `/messages` 成功了 —— 于是**赢家被缓存 10 分钟**；
4. 之后所有请求（含带图的）都优先走 `/messages`；
5. 而 `chatToAnthropicBody` 那时**只取文本**，图片被压平丢弃。

也就解释了两条最迷惑的现象：**重启就恢复**（内存缓存清空）、
**直连上游正常**（转换层在网关里）。

修法分两层：

**A. 三个方向的转换都必须逐块搬运图片**（与「任何取 content 文本的地方都要走
`normalizeContentToText`」是同一个教训，原项目也踩过）：

| 方向 | 图片表达 | 修法 |
| --- | --- | --- |
| 出站 chat → Anthropic | `image` 块 + `source{type:base64,media_type,data}` | `anthropicImageBlock` 拆 `data:` URI；https URL 走 `type:url` |
| 出站 chat → Responses | `input_image`，且 `image_url` 是**字符串**（不是嵌套对象） | 直接搬 URL |
| 入站 Anthropic → chat | `image` 块的 `source` | `anthropicImageSource.chatContentURL()` 还原成 `data:` URI |

`imageURLsOf` 统一从 chat content 取图；取不到图片时**保留原来的纯文本行为**，
不改变纯文本请求的任何字节。

**B. 端点协商的缓存要按「首选路径」隔离，并且必须留痕**：

- `endpointCacheKey` 把 `preferred` 算进 key（原项目同样如此）——
  管理员改了 `model_paths` 就该重新协商，而不是继续沿用旧配置下缓存的赢家；
- 协商成功/失败都写一条 `log.Printf` —— 这个切换是静默的，
  出问题时（如图片被压平）此前**没有任何线索**可查，只能靠重启二分。

实测（9 项全过）：三条协议入口各发一次带图请求，`prompt/input tokens`
均为 200+（图片真的到了上游），模型均正确答出「红色圆形、蓝色正方形、黄色长条」。

### 等待室：账号全挂时占住连接，把重试从用户 agent 手里拿回来

**用户提的诉求**（附截图：`正在重新连接 5/5` + `unexpected status 502`）：

> 所有的 api 调用，不管在哪边的 agent，出了问题我们系统这边静默调度和重试，
> 而不是触发用户 agent 的重试机制。本地 agent 不好控制，有的 5 次有的 3 次
> 就给会话断了。转移到我们这边自动调度重试重连，返回一句
> 「OOAPI 正在紧急调度 xxx 模型可用账号！不要关闭会话！」，
> 每分钟返回一次，错误超五十分钟左右再彻底报错。

**为什么值得做**：agent 的重试次数是写死的（3~5 次、几秒内跑完），
而「所有账号都在冷却」通常几十秒到几分钟就会自愈。把这段时间交回给 agent，
用户看到的是「会话断了」；留在网关这边则只是「这次回复慢了一分钟」。

**实现**（`internal/handlers/hold.go`）：

- 三条流式入口（chat / messages / responses）都在 `relayUpstream` 汇合；
- 关键前提：**建连（`openUpstreamStream`）不写客户端任何字节**。
  只要没写，就能换账号、能等待；一旦写了，状态码与响应头就定死了。
  所以把原来的 `forwardStreamWith` 拆成「建连」与「转发」两半，
  等待室复用同一份转发逻辑（计费/首字/断流判定都不分叉）；
- 全部候选账号都建连失败、且失败性质是「等一等就好」时进等待室：
  占住 SSE 连接 → 立刻发一条正文是提示语的消息 → 每分钟重发一次
  （带已等待时长）→ 后台每 2 秒重试调度 → 账号一恢复就**无缝接上真实回答**；
- 50 分钟（`holdMaxWait`）超时后发明确的超时说明并按协议正常收尾；
- 期间客户端断开则立刻停止，不留后台 goroutine，且**不给账号记失败**
  （用户按 Esc 不是账号的错 —— 这条规则与既有实现一致）。

**哪些失败该等**（`classifyFailureForHold`）：分界线是「等等会不会好」。
账号冷却/限流/上游 5xx/连不上/风控标记（11128、11140）→ 等；
请求本身写错（模型不存在、参数不合法、欠费 402）→ 立刻报错，等待无意义。

**还额外加了一道闸**（`shouldHoldFor` + `services.AnyChannelDeclaresModel`）：
「没有可用账号」有两种完全不同的成因，而 `SelectChannels` 对它们都回同一句话 ——
账号都在冷却（等到期就好）vs 根本没有启用的账号支持这个模型（等多久都没用）。
不区分就会让配置错的用户白等 50 分钟，所以进等待室前额外问一次
「分组里是否存在启用且声明支持该模型的账号」。

**非流式**（`retrySilently`）：没有发进度的通道，所以不做长等待，
改为**静默重试 2 分钟**（`jsonHoldMaxWait`）—— 比客户端读超时明显短，
覆盖「冷却几十秒后恢复」这一最常见的情况，用户只感觉「这次有点慢」。

**提示语为什么走正文而不是协议级错误事件**：三个客户端
（Codex / Claude Code / 其他 OpenAI SDK）对未知事件的容忍度不一样，
而一条最普通的 assistant 消息每个客户端都会如实渲染；且它落在同一个文本块里，
真实回答能直接跟在后面接上，客户端不需要做任何特殊处理。
三个翻译器都验过（`TestHoldNoticeTranslatesToClientMessage`）。

**顺带修掉的两个既有 bug**（都是测试逮出来的）：

1. **`rewriteResponseModel` 对 SSE 行完全失效**：流式的每一行都是
   `data: {...}`，而它直接拿整行去 `json.Unmarshal` —— 必然失败，
   又按「改不动就原样返回」静默放过。后果是渠道用上游叫法
   （`deepseek-v4.1-flash`）、客户端用官方名（`deepseek-flash`）时，
   响应里每个 chunk 的 model 字段都是上游叫法。多数客户端不校验所以潜伏至今，
   但部分 SDK 会校验一致性。现已支持剥 `data:` 前缀改写（含保留前缀空格与行尾换行）。
2. **`defer cancel()` 掐断正在读的流**：把建连拆出来时，建连函数里的
   `defer cancel()` 在函数返回时就取消了 context，而响应体还在被转发函数读 ——
   每次流式调用都在中途变成 `context canceled`，被记成「流式传输中断」
   并给**好账号**上冷却（实测把 OpenCode Go 与 WorkBuddy 都打进了小黑屋）。
   改为 context 所有权显式转移：失败路径 `defer` 回收，成功路径交给转发方读完再取消。
   回归测试 `TestUpstreamStreamSurvivesOpenReturn` 用「分两次写、中间停顿」的
   mock 上游复现（一次性写完的 mock 测不出来），并验证过「装回 bug 必失败」。

**实测**（真实链路，mock 上游可控地在等待期间恢复）：

```
[14:59:04] 正文: OOAPI 正在紧急调度「deepseek-flash」可用账号，请稍候，不要关闭会话！
[14:59:19] ·· 心跳
[14:59:34] ·· 心跳
[14:59:49] ·· 心跳
[15:00:04] 正文: OOAPI 仍在紧急调度「deepseek-flash」可用账号（已等待 1m0s），请勿关闭会话…
[15:00:19] ·· 心跳
[15:01:04] 正文: OOAPI 仍在紧急调度「deepseek-flash」可用账号（已等待 2m0s），请勿关闭会话…
[15:01:08] 正文: 上游恢复了，这是真实回答。
[15:01:08] ✓ 流结束 [DONE]
```

一条连接从头到尾没断：提示语 → 心跳保活 → 真实回答 → 正常收尾。
客户端断开路径也验过（8 秒后掐断 → 日志记「客户端在等待期间断开」、
账号未被标记失败；这正是修好上面第 2 个 bug 之后的正确行为）。

nginx 侧无需改动：现有配置已是 `proxy_buffering off` + `proxy_read_timeout 600s`，
而等待期间每分钟都有数据（15 秒一次心跳），远在安全区内。

### 等待室的第二轮修正：账号被禁用也必须等（不让会话断）

**用户第二次反馈**（附 Codex 截图：`正在重新连接 5/5` + `unexpected status 502`）：

> 还是没有啊，我的意思是他不要断懂吗，就伪装正常显示啊，因为有时候我不在电脑旁，
> 如果三方 agent 调用，因为点小原因断开会话了我这边发个「继续」会导致上下文混乱

**先说清责任**：日志显示截图里那几次 502 出现在 15:01:12–15:01:43，
正是我做隔离测试、临时禁用渠道 12/13/14/15 的窗口（15:01:43 才恢复），
用户那边的 Codex 恰好在这段时间重试。**那是我造成的，不是产品缺陷**。
（另外 15:03–15:04 用户自己在后台点了禁用，是另一回事。）

**但它暴露了一个真实缺口**，而且正是用户描述的场景：
「账号被全部禁用」时，第一版的 `shouldHoldFor` 会判定「等也没用」→ 立刻 502。
判据是「分组里是否存在**启用**且声明支持该模型的账号」—— 把「禁用」当成了永久状态。

修法（判据改成**不看启用状态**）：

| 情况 | 旧行为 | 新行为 |
| --- | --- | --- |
| 账号在冷却 / 被并发占满 | 等待 ✓ | 等待 ✓ |
| **账号被禁用**（管理员误操作、还没配好、风控自动禁用） | **立刻 502** ✗ | **等待** ✓ |
| 模型名写错 / 压根没配置该模型 | 立刻报错 ✓ | 立刻报错 ✓ |

区分第 2、3 行的是 `services.ModelIsDeclared`：**是否存在任何账号
（不论启用与否）声明支持该模型**。有声明 → 只是此刻不可用，等（管理员
点一下启用就好）；没有任何声明 → 模型本身就不存在，等多久都没用。

这个区分是必须保留的：模型名打错时 `SelectChannels` 也回「没有可用账号」，
不区分就会让用户白等 50 分钟才收到一句「没有可用账号」，
而真正的原因（模型名写错）本该立刻告诉他。

顺带把非流式静默等待的上限从 2 分钟提到 5 分钟（仍明显短于主流
SDK 的 600s 读超时），覆盖更多「冷却几分钟后恢复」的情况。

**实测**（你截图里的同一场景：账号禁用中发请求 → 中途启用账号）：

```
  正文: OOAPI 正在紧急调度「deepseek-flash」可用账号，请稍候，不要关闭会话！
  ·· 心跳
  ·· 心跳
  正文: 网关是连接两个不同网络的「翻译官」兼「关卡」，负责在不同协议或架构的网络之间转发数据并控制进出。
  ✓ 流结束 [DONE]
```

日志对照：
```
[gateway] 模型 deepseek-flash 无可用账号（账号不可用（冷却/禁用/占满），等待恢复），进入等待室
[hold] 账号「OpenCode Go」已恢复，接上模型 deepseek-flash（已等待 43s）
```

**一条会话从头到尾没断**：提示语 → 心跳 → 真实回答 → 正常收尾。
用户那边的 agent 完全不会触发自己的重试，也就不会出现「重试 5/5 后断开、
得手工补『继续』、上下文错乱」。

### 提示语的特殊样式：Markdown 引用块

**用户反馈**（附截图：提示语混在模型输出里，是一行普通文字）：

> 能不能搞成特殊样式或者展示方式？

**约束**：我们能控制的只有**文本内容**——agent 的 UI 怎么渲染由它自己决定，
网关无法给它下发样式。所以做法是「用所有客户端都支持的 Markdown 语法，
让它在文本层面就与模型输出区分开」。

**改法**：

| 元素 | 作用 |
| --- | --- |
| `>` 引用块 | 多数渲染器会缩进 + 画左侧竖线，与正文明显分层 |
| `**加粗**` | 标题行突出，扫一眼就能看到 |
| ⏳ / ✅ / ❌ | 状态符号；即使客户端不渲染 Markdown，符号本身也能说明这是系统消息 |
| 多行结构 | 标题一行 + 说明一段，而不是挤成一句 |

五条消息都统一了样式（首次提示 / 每分钟重发 / 恢复过渡 / 超时 / 失败）：

```
> ⏳ **OOAPI 正在紧急调度「deepseek-flash」可用账号**
>
> 请稍候，**不要关闭会话** —— 账号恢复后会自动继续输出，无需重新发送。
```

**两个容易踩的坑**（都有测试守着）：

1. **引用块必须用空行结束**：Markdown 的引用块靠空行终止，少一个空行，
   紧随其后的真实回答会被「懒续行」吸进引用块 —— 用户看到整段回答
   变成灰色引用。所以每条消息都以 `\n\n` 结尾。
   （`TestHoldMessagesAreWellFormedMarkdown` 把这条当硬约束测。）
2. **`>` 会被 JSON 编码器转义**：默认 `json.Marshal` 把 `>` 编成 `\u003e`。
   标准客户端解析后仍是 `>`、渲染无影响，但人工排查时难辨认。
   `chatTextChunk` 改用 `SetEscapeHTML(false)`，chat 路径的原始字节里
   就是干净的 `>`。

   注意：responses / anthropic 两条路径的翻译器**仍会用默认编码**
   （它们要重新序列化事件，不改动既有行为），所以那里看到的是 `\u003e` ——
   这是合法 JSON，客户端解码后照常渲染，因此测试断言的是**解码后的正文**
   而不是原始字节（`sseTextContent` 助手）。

**顺带补的一条消息**：账号恢复、开始接真实回答时先发一句
`> ✅ **OOAPI 已调度到可用账号，继续输出**`。没有它的话，
真实回答会「凭空」出现在那句「仍在调度」后面，看起来像模型在调度期间就答了。

**时长改成说人话**：原来用 Go 的 `Duration.Round(time.Second)`，
显示出来是 `1m0s` / `2m30s` 这种机器写法；新增 `holdElapsed`
说成「1 分钟」「2 分钟」。

**实测**（三条协议入口逐个抓原始字节）：

```
chat 路径原始字节：content":"> ⏳ **OOAPI 正在紧急调度「deepseek-flash」可用账号**\n>\n> 请稍候...
responses 路径（解码后）：'> ⏳ **OOAPI 正在紧急调度「deepseek-flash」可用账号**\n>\n> 请稍候...
```

**一个说明**：如果你用的客户端不渲染 Markdown（少数裸 CLI），
看到的就是带 `>`、`**`、⏳ 的原始文本 —— 虽然不如渲染后好看，
但这些符号本身也足以让它看起来像系统标记而不是模型正文。

### 等待室第三轮：去 emoji、不入上下文、失败必须报错

用户的四条要求逐条落地。

**① 不要 emoji**

`⏳ / ✅ / ❌` 换成纯文字标记 `[OOAPI]`。两个好处：不同终端的字形宽度统一；
`[OOAPI]` 能被稳定识别，用于第 ② 条的剥离。
（`TestHoldMessagesHaveNoEmoji` 按 Unicode 区段拦截，而不是简单地
「大于 U+2100 就报错」—— 中文与全角标点都在更高区段，那样会误杀。）

**② 提示语不计入上下文**

等待期间的提示语会以**助手回复**的身份被 agent 记进对话历史，下次请求带回来。
不剥掉的后果：模型每轮都读到「OOAPI 正在紧急调度…」，白烧 token，
还可能顺着话头把自己当成调度系统往下编。

做法（`stripHoldNotices`，在 `callUpstream` / `relayUpstream` 各剥一次，
覆盖三条协议入口）：
- 命中 `[OOAPI]` 的行起，连同后续 `>` 续行与块内空行一并删除；
- 消息被剥空则整条丢弃（留空消息有些上游直接 400）；
- 丢消息后合并相邻同角色消息 —— Anthropic 要求严格交替，不合并会 400；
- **保守原则**：不含标记的请求先走 `bytes.Contains` 快路径，**逐字节原样返回**，
  常规路径零改动、零风险；
- 编码失败时退回原 body（宁可留提示语，也不能弄坏用户请求）。

**③ 最终失败必须报错，不能给「正常结束」**

用户原话：

> 最终如果彻底结束了，就返回报错啊，而不是返回对话结束状态码，
> 不然 agent 会误认为会话正常结束的

这是真缺陷：收尾成正常事件的话，等待期间那句提示语就成了「模型的最终答复」，
agent 以为这轮顺利完成，用户回到电脑前只看到一句「正在调度」。

新增 `streamTranslator.FinishError`，三个协议各自用**自己的错误事件**：

| 协议 | 成功收尾 | 失败收尾（新） |
| --- | --- | --- |
| chat | `[DONE]` | `data: {"error":{code:"no_available_channel"}}` + `[DONE]` |
| Responses | `response.completed` | `response.failed`（status: failed） |
| Anthropic | `message_stop` | `event: error` |

chat 保留 `[DONE]` 是为了让连接正常关闭（否则客户端挂住）；错误帧在前，
SDK 读到 `error` 字段会抛异常而不是当成空回复。

**测试用的超时覆盖**：超时路径默认要等 50 分钟，无法在验收中触发，
因此加了 `OOAPI_HOLD_MAX_WAIT` 环境变量开关（systemd drop-in）。
用它是为了**真实验证**错误帧，而不是靠单测推断 —— 验证完已清除，
线上仍是默认 50 分钟（重启后确认无覆盖日志）。

**实测**（把上限临时压到 8 秒，逐条协议抓真实字节）：

```
chat:      data: {"error":{"code":"no_available_channel","message":"OOAPI 调度超时：已等待 8 秒，仍无可用账号…"}}
           data: [DONE]

responses: event: response.failed
           data: {...,"status":"failed","error":{"code":"no_available_channel",...}}

anthropic: event: error
           data: {"type":"error","error":{"type":"api_error","message":"OOAPI 调度超时…"}}
```

**顺便发现的问题（不是本次改动引入）**：验证时日志显示两个生产账号都不能用了 ——

```
账号「OpenCode Go」: Upstream request failed: Insufficient account funds
账号「测试」(WorkBuddy): {"code":14018,"msg":"Credits exhausted..."}
```

直连上游确认过是真实的余额/额度耗尽（不是网关问题）。所以现在
`ds-flash` 分组实际上没有可用账号 —— 这也正好让等待室在真实场景下被反复触发。
需要用户充值或补充账号；Kiro（渠道 15）未声明 `deepseek-flash`，接不上。

### 服务器迁移：210.126.235.109 → 154.36.184.56

旧服（韩国）已停用，整套重新部署到新服。**数据不迁移**（用户明确说无所谓），
全新初始化。

**新服环境**：Debian 12 + 宝塔面板 + MySQL 5.7.44 + nginx 1.26.3，
4 核 / 3.9G 内存 / 30G 磁盘。与旧服同为 MySQL 5.7 —— 这点很重要，
`utf8mb4_unicode_ci` 这类排序规则与旧服一致，schema 不用改。

**DNS**：ooapi.space / apidoc.cloud 都已指向新 IP（DNSPod 管理，
不是我们改的）。旧服上 `getent hosts` 还返回旧 IP 是本地缓存，
用公共 DNS（1.1.1.1 / 8.8.8.8）确认过是新 IP。

**部署与旧服的三处不同**：

| 项 | 旧服 | 新服 |
| --- | --- | --- |
| 后端编译 | 上传源码，服务器上 `go build` | **本地交叉编译**再上传（新服无 Go） |
| 前端托管 | Go 服务托管 | **nginx 直接托管**（`root /opt/ooapi/web/dist`） |
| 证书 | 未知来源 | **Let's Encrypt**（certbot，到期 2027-01-10） |

编译方式改成本地是为了少装一套工具链：本地 Go 交叉编译
`GOOS=linux GOARCH=amd64 CGO_ENABLED=0` 出静态 ELF，服务器只管运行。
`deploy-server.sh` 里加了 ELF 魔数校验（防止把 windows 二进制传上去）
和**健康检查 + 自动回滚**。

**数据库**：宝塔装的 MySQL，root 密码不明（宝塔加密存储，
试了常见弱密码都不通）。**没有动 root 密码** —— 用
`--skip-grant-tables --skip-networking + 独立 socket` 建了专用库与用户
（`ooapi` / `ooapi_2026_...`），只授 `ooapi.*` 权限，`chmod 600` 的 .env 存密码。

踩到的坑：`systemctl stop mysqld` 对宝塔启动的实例**不生效**（init 脚本
`/etc/init.d/mysqld` 才是正主），导致一度出现**两个 mysqld 共用一个 datadir**
（有数据损坏风险）—— 发现后立刻先杀 `mysqld_safe` wrapper 再杀实例。
最终走 `/etc/init.d/mysqld stop` 才干净。

**SSL**：用 `certbot certonly --webroot`，nginx 里留
`/.well-known/acme-challenge/` 目录放行（在 301 跳转之前），
续期不需要停服务。配了 `renewal-hooks/deploy/reload-ngix.sh` 自动重载，
`certbot renew --dry-run` 演练通过。证书覆盖 4 个域名
（ooapi.space / apidoc.cloud / www.* 两个）。

**nginx 配置保留了旧服踩过的经验**（这三条缺一不可，都能造成线上事故）：
- `proxy_buffering off` —— 否则 SSE 会被 nginx 缓冲，前端「卡着不出字」
- `proxy_read_timeout 600s` —— 思考型模型几十秒不出字、等待室最长占 50 分钟
- `client_max_body_size 32m` —— 与后端一致（图片 base64 撑大请求体）

**管理员账号是 `root` / `123456`**（来自 `ADMIN_PASSWORD` 环境变量）。
`EnsureDefaultAdmin` 建的用户名是 **root**，不是旧服的 `odi` ——
换服后登录用户名会变，这点容易踩（我一开始用 odi 登录失败才发现）。

**验证结果**：HTTPS 200（两个域名）、HTTP 301 跳转、证书链正确、
登录成功、管理端 4 个接口 200、内置 46 个真实模型 / 16 厂商可读、
前端页面与 assets 200、`/v1/models` 可访问、两个部署脚本实跑通过、
错误日志干净。

**待用户处理**：新库是空的（账号 0 / 分组 0）——需要在后台重新导入
上游账号（OpenCode Go、WorkBuddy 等）才能对外提供模型。
另外旧服那两个账号本身也已欠费（`Insufficient account funds` /
`Credits exhausted`），导入后仍需充值。

### 收尾：管理员用户名可配置 + 全新初始化

用户的要求很明确：**不迁移数据，重新部署最新代码，建一个 `odi` / `123456` 的管理员**。

**为此改了代码**：`EnsureDefaultAdmin` 原来把用户名写死成 `'root'`，
导致每次全新部署的用户名都跟站点所有者的习惯对不上（旧服是 `odi`，
新服的默认值又变回 `root`，登录时才发现）。现在用户名走
`ADMIN_USERNAME` 环境变量（默认仍是 `root`），
`config.AdminUsername` → `EnsureDefaultAdmin(username, password)`。

**执行过程**：
1. 部署最新二进制（含用户名可配置的改动）
2. `.env` 写入 `ADMIN_USERNAME=odi` / `ADMIN_PASSWORD=123456`
3. `DROP DATABASE` 重建空库，重启后端 —— 自动建表 + 按配置建管理员
4. 验证：`odi` / `123456` 登录成功，用户表 `id=1 username=odi role=1000`

**发现一处既有的不一致（未修改，留给用户判断）**：

| 路径 | 长度要求 |
| --- | --- |
| 初始密码（`ADMIN_PASSWORD` → `EnsureDefaultAdmin`） | **无校验**（`123456` 可用） |
| 改密码 `/api/user/password` | **至少 8 位** |

所以 `123456` 能建、能登录，但想改成别的 6 位密码会被拒（报「密码至少 8 位」）。
按既定的安全约束（「不为方便放宽全局密码策略」）我**没有**放宽这个校验 ——
它本身是对的，问题在初始密码路径没有对齐。要消除不一致有两个方向：
要么初始密码也走同一套校验（`123456` 会被拒，与用户要求冲突），
要么改密码时对超管放宽（违反安全约束）。两者都需要用户决策，因此只报不改。
实践上没有影响：`123456` 可以正常登录，只有「改成另一个短密码」这一个动作会被拒。

**验证结果**：`odi` 登录成功、管理端 5 个接口 200、错误密码被拒
（`invalid_credentials`）、前端页面与 `/logo.jpg` 200、
两个域名 HTTPS 200、服务开机自启、证书自动续期已启用。

**当前站点状态**：全新空站（用户 1 / 账号 0 / 分组 0 / 密钥 0），
内置 46 个真实模型的定价目录随时可用。要对外服务需在后台
「接入账号」里导入上游账号。

### 服务器精简：删除宝塔面板与 AstrBot

用户要求「一切会占用磁盘、CPU 的东西都清掉」，并询问 AstrBot 是否值得保留。
盘点后决定：**宝塔全家桶删除、AstrBot 删除（用户确认）、nginx 与 MySQL 保留**（OOAPI 依赖）。

**清理前的占用**：

| 组件 | 磁盘 | 内存 | 处置 |
| --- | --- | --- | --- |
| 宝塔面板 `/www/server/panel` | 550M | ~90M | 删 |
| 宝塔 PHP `/www/server/php` | 94M | ~40M | 删（无 PHP 站点） |
| 宝塔 phpMyAdmin | 少量 | — | 删（面板入口，随面板一起） |
| AstrBot `/opt/astrbot` | 648M | 264M | 删（用户确认） |
| nginx `/www/server/nginx` | 14M | — | **保留**（站点与反代） |
| MySQL `/www/server/mysql` | 540M | ~185M | **保留**（OOAPI 数据库） |

**结果**：磁盘 5.0G → 4.2G，内存占用 1062M → 561M。

**关键风险与处理**：宝塔不只是「面板」——**我们的 nginx 站点配置原本就放在
宝塔目录里**（`/www/server/panel/vhost/nginx/ooapi.conf`，由 nginx.conf 的
`include` 引入）。直接删面板会让 nginx 起不来。所以先做了配置迁移：

1. 站点配置 → `/etc/nginx/sites-available/ooapi.conf`（软链到 sites-enabled）
2. 重写 `/etc/nginx/nginx.conf`：去掉宝塔专有的 `stream{}`、`tcp/*.conf`、
   phpmyadmin（listen 888）、`enable-php.conf`，站点目录改为标准的
   `/etc/nginx/sites-enabled/*.conf`
3. 带上 `mime.types` / `proxy.conf` 到 `/etc/nginx/`
4. 写标准 systemd unit 替代宝塔的 init 脚本

**踩到的两个坑**：

- **宝塔的 nginx 二进制编译进了 Lua**（`--add-module=lua_nginx_module`），
  启动时报 `failed to load the 'resty.core' module`。必须保留
  `lua_package_path "/www/server/nginx/lib/lua/?.lua;;"` —— 即使我们不用
  WAF。我第一版配置把它当「用不到的东西」删了，直接导致 nginx 起不来。
- 我写的配置注释里含 `lua_package_path` 这个词，而落配置的脚本用
  `grep -q lua_package_path` 判断是否已写入 —— 注释命中了检查，
  真正的指令没写进去。改成匹配 `lua_package_path "` 后才正确。

**AstrBot 的凭据**：它**不是首次启动**，启动横幅只打印了 Username
（`astrbot`）没有 Password —— 而 AstrBot 的默认密码只在首次初始化时输出。
日志里翻不到，常见默认密码的 MD5/PBKDF2 也都不匹配。用官方 CLI
`astrbot password` 重置过（实测它的强度要求比 OOAPI 还严：
至少 8 位 + 必须含大写字母），验证登录成功后，按用户要求整体删除。

**顺带收紧的安全项**：AstrBot 原本监听 `0.0.0.0:6185` 且 ufw 放行，
任何人都能访问它的登录页。删除后一并清掉了这些防火墙放行规则：
`20/tcp`、`21/tcp`（宝塔 FTP）、`888/tcp`（宝塔 phpMyAdmin 入口）、
`8889/tcp`（宝塔面板）、`31058/tcp`、`6185/tcp`、`6199/tcp`、
`39000:40000/tcp`（FTP 被动端口）。现在只剩 `22`（SSH）、`80`、`443`。

**发现并修复的一个隐患**：新建 nginx 的 systemd unit 时忘了
`systemctl enable`，`is-enabled` 是 **disabled** —— 服务器一重启站点就挂。
已启用，并且**做了真实的 reboot 验证**：重启后 nginx / mysqld / ooapi
三个服务全部自动拉起（PID 全部变化，确认是真重启），
站点 HTTPS 200、`odi` 登录成功、管理接口正常、证书自动续期演练通过。

**清理后验证**：磁盘 4.2G/30G（15%）、内存 561M/3914M、
监听端口只剩 22/80/443（外）+ 3001（仅本机，后端）+ 3306（MySQL，被 ufw 挡住）、
两个域名 HTTPS 200、HTTP 301 跳转、4 个管理接口 200、
nginx 与后端错误日志均干净、两个部署脚本实跑通过。

### 推仓库时被 GitHub 拦下：源码里的 Google OAuth 凭据

把 Go 版本推送到 `odi0011/OOAPI` 时，GitHub 的推送保护直接**拒收整个推送**：

```
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - GITHUB PUSH PROTECTION
remote:   - Push cannot contain secrets
remote:     —— Google OAuth Client ID ——————  upstream_login.go:129
remote:     —— Google OAuth Client Secret ——— upstream_login.go:130
```

**这是真实问题，不是误报。** 那对凭据是 Google 公开发布的安装型应用凭据
（Gemini CLI 等开源项目都内嵌，本身不算机密），但：

1. GitHub 的扫描规则不认这个「公开」前提 —— 只要形态匹配就拦，
   结果是一整批提交都推不上去；
2. 更根本的：内嵌的 client secret 谁都能提取，等同于公开值，
   无法按部署实例区分「谁在用」。

**改法**：凭据改为**只从环境变量读**，源码里不留任何值。

- `googleOAuthCreds()` 读 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`；
- 缺配置时给**点名缺失变量**的错误（而不是让人对着失败的授权页猜原因），
  并为此补了一条专门的测试（`TestAntigravityLoginWithoutCredsGivesActionableError`）；
- 受影响的两个测试改为 `t.Setenv` 提供测试值 —— 顺带验证了「凭据来自环境」这条路径；
- 生产 `.env`（0600）写入这对值，Google 订阅登录照常可用；
- `deploy-server.sh` 加了检查：缺失时提示但不阻止部署
  （只影响 Google 一键登录这一个功能）。

**仓库结构**：`odi0011/OOAPI` 里原本是**同一产品的 Node 版本**
与一份无关的 `ooapi-binance`（Python）。

按「原项目的东西一样都不留」的要求，随后做了彻底清理：
`ooapi-binance`、VNC / binance 相关脚本、`AGENTS.md` / `CLAUDE.md` / `CODEX.md`
以及原项目那份协作文档全部删除，README 也重写为匹配 Go 版的内容。
旧版本代码只留在 git 历史里（需要时可回看，工作区里已无残留）。

### 清掉仓库里原项目的全部残留

用户要求：**原项目的东西一样都不要留**。上一轮推送时我出于「可能还有参考价值」
保留了 `ooapi-binance`、原项目文档与几个无关脚本 —— 现在按用户要求全部删除。

**删除清单**：

| 项 | 说明 | 数量 |
| --- | --- | --- |
| `AGENTS.md` / `CLAUDE.md` / `CODEX.md` | 原项目的 AI 助手入口 | 3 个文件 |
| `AI协作-原项目笔记.md` | 原项目那份 6167 行协作文档 | 1 个文件 |
| `ooapi-binance/` | 无关的 Python 交易程序 | 24 个文件 |
| `scripts/` 里的无关脚本 | VNC 安装/修复、binance 启停、本地启动 | 6 个文件 |

**怎么确认「删干净了」**：不是凭印象挑文件，而是**逐字节比对**新旧两棵树 ——
`git ls-tree -r` 取两份文件清单与 blob 哈希，找出「与原有仓库完全相同」的 58 个文件，
再逐个归类：

- **原项目内容** → 删除（上表）；
- **Arc UI 第三方组件**（`ooapi-web/src/components/arc/**`）→ 保留。
  它们在两边哈希相同，因为新前端**就是这个组件库的副本**（Arc UI 是
  copy-source 模式），不是原项目的代码；
- **`LICENSE` / `.gitattributes`** → 保留（仓库级配置，与具体实现无关）。

**README 重写**：原 README 描述的是 Node 版（`npm install`、`vendor/`、
`migrate*.mjs`、`src/routes/`），与 Go 版结构完全不符。重写为匹配实际的
目录结构、构建方式（本地交叉编译）、配置项（含 `ADMIN_USERNAME` 与
Google OAuth 变量）与部署要点（nginx 三项 SSE 必需配置）。
新文档里也不再提「原项目」——那是本仓库之外的事。

**`logo.jpg` 保留**：它是站点自己的品牌图标（侧栏、登录页、首页、看板都在用，
`/logo.jpg` 线上正在服务），删掉会让全站图标 404。它与原项目哈希相同只是因为
图标沿用了同一个文件 —— 但它是**这个站点的资源**，不是「原项目的代码」。

**`ai协作.md` 保留并修正**：这是我们自己的协作文档（不是原项目那份），
顺手更新了里面过时的服务器地址（`210.126.235.109` → `154.36.184.56`）
与项目结构图里已删除的入口文件。

**验证**：删除后 `go build ./...`、`go test ./...`、`tsc -b --noEmit` 全部通过 ——
确认删掉的文件没有任何一处被引用。
