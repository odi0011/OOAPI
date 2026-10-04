import { PLATFORM_CATALOG, platformAction } from "./platform-catalog.js";
// 两组文案属于工具自身的展示元数据，不是模型可填的调用参数。
// 每次事件保存所用文案与操作说明；前端按事件编号抽取，刷新不换词。
function copy(topic, receipt, inquiry = [], capsule = []) {
  return {
    inquiryPhrases: [...inquiry,
      `我来看看${topic}，好吗？`, `想帮你理一理${topic}，可以吗？`,
      `接下来查一下${topic}，好不好？`, `让我翻翻${topic}，怎么样？`,
      `关于${topic}，我再看看可以吗？`, `要我把${topic}整理一下吗？`,
      `我想了解一下${topic}，点点头就出发～`, `把${topic}交给我看看，好吗？`,
      `我去找找${topic}里的线索，可以吗？`, `先从${topic}看起，怎么样？`,
    ],
    capsulePhrases: [...capsule,
      `${receipt}整理好啦～`, `${receipt}带回来咯`, `${receipt}已经备好啦`,
      `${receipt}放这儿啦～`, `${receipt}理清楚咯`, `${receipt}收好啦～`,
      `这份${receipt}准备好了`, `${receipt}已送到～`, `关于${receipt}，这一步完成啦`, `刚把${receipt}整理了一遍～`,
    ],
  };
}
const method = (title, description, topic, receipt, fields = []) => ({ title, description, fields, ...copy(topic, receipt) });
export const TOOL_PRESENTATIONS = {
  account: {
    ...copy("你的账号情况", "账号信息", ["我帮你翻翻账号的小账本，好吗？", "想更了解你的账号现状，可以看看吗？"], ["账号信息查到咯～", "你的账号小账本翻好啦"]),
    title: "查看账号情况", description: "整理当前账号可见的信息，帮你回答这次的问题。", scope: "仅查询当前账号", methods: {
      overview: method("查看账户概况", "整理账号可见的余额、近期调用和令牌概况。", "你的账户概况", "账户概况", [["查询范围", "当前登录账号"], ["关注内容", "余额 · 近期调用 · 令牌概况"]]),
      recent: method("查看最近调用", "按时间查看最近的模型调用、用量和消耗。", "你最近的调用记录", "最近调用记录"),
      errors: method("查看失败记录", "查看最近未成功的调用，整理失败原因和发生时间。", "最近没成功的调用", "失败记录"),
      error_help: { ...method("解释系统错误", "查询错误码的中文含义、可能范围与排查建议。", "这个错误的含义", "错误说明"), scope: "只读系统错误词典" },
      tokens: method("查看令牌概况", "查看令牌名称、状态和可见额度，不读取密钥内容。", "你的令牌使用情况", "令牌概况", [["查询范围", "你创建的令牌"], ["关注内容", "名称 · 状态 · 可见额度"]]),
      usage: method("整理用量统计", "把这周的调用次数与消耗按日期、模型汇总，找出主要用量。", "你这周的用量", "这周的用量", [["时间范围", "最近 7 天"], ["统计方式", "按日期 · 按模型"]]),
    },
  },
  binance: {
    ...copy("你的币安数据", "币安资料", ["让我看看账户里的数据，再陪你分析，好吗？", "我想核对一下你的币安资料，可以吗？"], ["币安资料备好啦～", "数据带回来啦，接着分析"]),
    title: "查看币安资料", description: "读取当前账号可见的币安数据，用于本次分析。", scope: "只读查询，不执行交易", methods: {
      accounts: method("查看账户列表", "查看你已配置的币安账户和启用状态。", "你配置的币安账户", "币安账户列表"),
      overview: method("查看账户权益", "整理账户权益、可用余额和最近同步的概况。", "账户权益和余额", "账户权益"),
      positions: method("查看当前仓位", "整理持仓方向、数量和仓位相关指标。", "你当前的仓位", "仓位信息"),
      orders: method("查看近期订单", "整理账户已有的订单记录和执行状态。", "你的订单记录", "订单记录"),
      strategies: method("查看策略状态", "读取已有策略的运行状态和可见统计。", "你的策略运行情况", "策略状态"),
      risk: method("查看风控指标", "整理敞口、保证金和相关风险指标，辅助分析。", "账户的风控指标", "风控资料"),
      backtests: method("查看回测结果", "读取已保存的回测记录与表现数据。", "已有的回测结果", "回测资料"),
      analysis: method("整理分析资料", "汇总账户、仓位、订单和风控资料，支持综合分析。", "这次分析需要的数据", "分析资料"),
    },
  },
  search: {
    ...copy("这个问题的公开资料", "检索资料", ["我去网上找找线索，好吗？", "要不要让我带着这个问题去查一查？", "我想找些新资料来核对，可以吗？"], ["新鲜资料带回来啦～", "这一趟检索结束咯", "资料和来源一起带回来啦"]),
    title: "联网查找资料", description: "使用这些关键词检索公开资料，整理要点和来源。", scope: "查询内容会发送给检索服务",
  },
  fetch: {
    ...copy("这页公开资料", "网页内容", ["我去读读这一页，好吗？", "想打开原文仔细看看，可以吗？", "让我顺着这个链接看看，好不好？"], ["网页读完咯～", "这一页的内容收好啦", "原文带回来啦～"]),
    title: "阅读网页原文", description: "打开指定公开网页，提取可读文字来回答你的问题。", scope: "读取公开网页",
  },
  github: {
    ...copy("这个公开仓库", "仓库资料", ["我想去仓库里找找答案，好吗？", "让我看看项目的真实实现，可以吗？"], ["仓库资料带回来啦～", "这一趟代码查阅结束咯"]),
    title: "查阅公开仓库", description: "阅读仓库中的公开内容，为本次回答补充依据。", scope: "只读公开仓库", methods: {
      list: method("查看仓库目录", "浏览文件与目录列表，找到后续需要阅读的位置。", "仓库的目录结构", "仓库目录"),
      file: method("阅读仓库文件", "读取指定文件的内容；未指定文件时查阅 README。", "这个仓库文件", "文件内容"),
      search: method("检索仓库代码", "在指定仓库内查找关键词，定位相关文件。", "仓库里的相关代码", "代码检索结果"),
    },
  },
  task: {
    ...copy("这项独立任务", "子任务结果", ["我请一位小帮手来一起处理，好吗？", "这部分交给专门的小帮手，可以吗？", "让我把这件事交给小帮手研究一下，好不好？"], ["小帮手交卷咯～", "子任务的结果带回来啦", "小帮手忙完这一轮啦"]),
    title: "交办独立子任务", description: "把下面这段任务说明交给专职助手，完成后带回结果。", scope: "按子任务的实际模型用量计费",
  },
  todowrite: {
    ...copy("这份任务清单", "任务清单", ["我把接下来的步骤记好，可以吗？", "一起把这份小清单更新一下，好吗？", "我想把进度标清楚，行吗？"], ["小清单更新好啦～", "接下来做什么记住啦", "任务进度标好咯"]),
    title: "更新本次任务清单", description: "用这份清单替换本会话的待办，展示接下来的步骤和进度。", scope: "仅更新当前会话的清单",
  },
};

const text = (v, max = 1800) => String(v ?? "").trim().slice(0, max);
const writeCopy = title => ({
  inquiryPhrases: [`这份「${title}」准备好了，要这样办吗？`, `我把内容列好啦，你看看再点头？`, `按下面这些内容执行，可以吗？`, `这一步会改动平台数据，帮我核对一下吧～`, `目标和内容都在下面，这样安排好吗？`, `最后核对一遍，这份内容可以出发了吗？`, `我准备按这份内容办事，交给我吗？`, `请看看下面的目标和正文，是你想要的吗？`, `你点头后，我就按下面的内容执行～`, `小爪子先停住，等你确认这一份～`, `这一步准备就绪，确认后我再动手～`, `我把这一步摊开啦，核对好就出发？`],
  capsulePhrases: [`${title}完成啦～`, `这一步办妥咯`, `按你确认的内容完成啦`, `结果带回来啦～`, `这一项已经办好啦`, `操作完成，结果放这儿啦`, `这一小步完成咯`, `刚才确认的事情办好啦`, `事情办妥，给你回个信～`, `执行结果收到啦`, `这一份处理好咯`, `已完成这次操作～`],
});
TOOL_PRESENTATIONS.platform = { ...copy("平台的工具目录", "工具目录"), title: "查看平台工具目录", description: "查看当前账号能使用的方法及参数。", scope: "按当前用户权限展示" };
const operationDescriptions = {
  "community.publish": "把下面的标题和正文发布到所选社区话题，署名为你的账号。",
  "community.comment": "使用你的账号，在指定帖子下发布这段评论；回复对象也会列在下面。",
  "community.edit": "将指定帖子修改为下面的内容。",
  "community.delete": "删除指定帖子，并按平台规则处理它的评论和媒体引用。",
  "messages.send": "把下面的消息发送到指定私聊或群聊，请核对收件会话和正文。",
  "usage.clear_logs": "这会永久清空全站全部使用记录和操作日志，无法只清理其中一部分。",
  "system.update_apply": "更新会构建并重启平台，可能短暂影响正在进行的请求。",
  "trading.create_strategy": "创建下面的交易策略；如果开启自动执行，策略将按账户模式持续交易。",
  "trading.edit_strategy": "修改或启停指定策略。运行中的自动策略可能继续提交交易。",
  "trading.order": "请核对账户、交易模式、标的、方向和数量；真实模式会使用真实资金。",
  "trading.close": "按下方比例平掉指定仓位；真实账户的平仓会影响真实资金。",
  "trading.set_platform": "保存你的交易连接配置；开启真实交易后，账户可提交真实资金订单。",
  "tokens.create": "创建一个属于你的 API 令牌。密钥明文在令牌管理页查看。",
};
for (const g of Object.values(PLATFORM_CATALOG)) TOOL_PRESENTATIONS[g.id] = {
  ...copy(g.name, g.name), title: g.name, description: `使用平台已有的${g.name}功能。`, scope: "沿用当前账号的权限与资源归属", methods: Object.fromEntries(Object.values(g.actions).map(a => [a.action, {
    ...(a.write ? writeCopy(a.title) : copy(a.title, a.title.replace(/^(查看|查询|阅读|搜索或浏览|浏览)/, ""))), title: a.title,
    description: operationDescriptions[`${g.id}.${a.action}`] || (a.write ? "请核对下方的目标和内容；确认后，我会使用你的账号执行这一次操作。" : "读取平台中的真实数据来回答你的问题。"), scope: a.write ? "仅执行本次确认的目标与内容" : "只读取当前账号可见的数据",
  }])) };
const fieldLabels = { id: "目标编号", userId: "用户编号", topic_id: "话题编号", title: "标题", content: "正文", name: "名称", remark: "备注", q: "搜索内容", sort: "排序", p: "页码", size: "每页条数", action: "操作方式", ids: "目标编号列表", media_ids: "附带媒体编号", parent_id: "回复的评论编号", reply_to_user_id: "回复对象编号", to_user_id: "收件人编号", user_ids: "成员编号", user_id: "用户编号", account_id: "交易账户编号", model: "模型", group_name: "分组", role: "角色", status: "状态", quota: "额度单位（10000 = 1 OD）", remain_quota: "剩余额度单位（10000 = 1 OD）", symbol: "交易标的", side: "方向", quantity: "数量", mode: "交易模式", percentage: "平仓比例", auto_execute: "策略自动执行", allow_live_trading: "允许真实交易" };
Object.assign(fieldLabels, {
  active: "账户启用", alias: "模型别名", all: "包括停用项", announcement: "群公告", archived: "已归档", auto_ban: "自动禁用异常渠道", auto_test: "自动测试", auto_test_interval: "自动测试间隔", base_url: "接入地址", bio: "个人介绍", capabilities: "模型能力", channel: "通知渠道", channel_id: "渠道编号", channel_ids: "渠道编号列表", channel_type: "接入类型", client_id: "消息去重编号", client_order_id: "订单去重编号", concurrency: "并发上限", context_billing: "上下文计费", cooldown_min: "冷却分钟数", days: "天数", description: "说明", display_name: "昵称", email: "邮箱", enabled: "启用", end: "结束时间", expired_time: "过期时间（Unix 秒）", fast_period: "快线周期", favorited: "仅收藏", fee_rate: "手续费率", filters: "筛选条件", fingerprint_mode: "指纹模式", following: "仅关注", force: "强制执行", fromSeq: "回退起始消息序号", group: "分组", groups: "分组列表", icon: "图标", image_media_id: "封面媒体编号", initial_balance: "初始余额", is_pinned: "置顶", keyId: "API 令牌编号", keyword: "关键词", kind: "类别", limit: "数量上限", liquidation_buffer_pct: "强平缓冲比例", location: "所在地", max_daily_loss: "每日亏损上限", max_leverage: "杠杆上限", max_margin_ratio: "保证金比例上限", max_open_positions: "持仓数量上限", max_order_notional: "单笔名义价值上限", max_per_min: "每分钟请求上限", message: "申请留言", message_id: "消息编号", method: "接入方式", metric: "监控指标", min_gap_ms: "请求最小间隔（毫秒）", minutes: "分钟数", model_limits: "模型白名单", models: "模型列表", move_to: "迁移至话题编号", namespace: "命名空间", notify_email: "邮件通知", notify_emails: "通知收件邮箱", notify_webhook: "回调通知", offpeak_rule: "低峰时段规则", operator: "比较方式", orig_name: "媒体名称", overwrite: "覆盖已有配置", parameters: "策略参数", payload: "批量修改内容", position_side: "持仓方向", priority: "优先级", projectId: "项目编号", proxy_url: "代理地址", rate: "分组倍率", reason: "原因", reduce_only: "仅减仓", settings: "偏好设置", severity: "严重程度", since_id: "起始消息编号", slippage: "滑点", slow_period: "慢线周期", start: "开始时间", stop_loss: "止损价", strategy_id: "策略编号", strategy_type: "策略类型", sustained_min: "持续分钟数", tab: "列表范围", take_profit: "止盈价", test_model: "测试模型", test_prompt: "测试提问", text: "导入内容", threshold: "阈值", timeframe: "K 线周期", to: "通知接收人", todo: "会话待办", token_id: "API 令牌编号", trading_halted: "暂停交易", trailing_pct: "移动止盈比例", type: "类型", unlimited_quota: "不限令牌额度", url: "目标地址", vendor: "厂商", webhook_url: "通知回调地址", website: "个人网站", weight: "权重", window_min: "统计窗口（分钟）",
  input_price: "输入单价（OD/百万 Token）", output_price: "输出单价（OD/百万 Token）", cache_price: "缓存单价（OD/百万 Token）", offpeak_input_price: "低峰输入单价（OD/百万 Token）", offpeak_output_price: "低峰输出单价（OD/百万 Token）", offpeak_cache_price: "低峰缓存单价（OD/百万 Token）",
});
function operationValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map(operationValue).join("、") || "空列表";
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${fieldLabels[key] || key}：${operationValue(item)}`).join("\n");
  return value == null ? "未设置" : String(value);
}
const fallback = { ...copy("这一步的内容", "本次结果"), title: "执行这一步", description: "乐乐准备进行下一步操作。", scope: "仅本次操作" };
// 准备阶段的旧值来自服务端读取，不能允许模型通过工具参数伪造审批差异。
const preparedPresentations = new WeakMap();
export function platformChangePresentation(id, args, before, after) {
  const presentation = toolPresentation(id, args);
  const changes = Object.keys(after).filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
  const fields = changes.map(key => ({ label: `${fieldLabels[key] || key} · 修改前 → 修改后`, value: `${operationValue(before?.[key])}\n→ ${operationValue(after[key])}` }));
  const out = { ...presentation, description: `${presentation.description || ""} 未指定的配置保持原值；执行前检查原值未变化，完成后读取保存结果核对。`, fields: [...fields, ...presentation.fields] };
  preparedPresentations.set(args, out);
  return out;
}
export function toolPresentation(id, input = {}) {
  if (input && typeof input === "object" && preparedPresentations.has(input)) return preparedPresentations.get(input);
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const base = TOOL_PRESENTATIONS[id] || fallback;
  const rawAction = text(args.action).toLowerCase();
  const action = (id === "account" ? ({ balance: "overview", logs: "recent", history: "recent" })[rawAction] : "") || rawAction || ({ account: "overview", github: "file", binance: "analysis" })[id];
  const { methods: _methods, ...common } = base;
  const selected = { ...common, ...(base.methods?.[action] || {}) };
  let fields = selected.fields || [];
  if (PLATFORM_CATALOG[id]) {
    const actionSpec = platformAction(id, args);
    fields = Object.entries({ ...(args.params || {}), ...(args.data || {}) }).map(([key, value]) => [fieldLabels[key] || key, operationValue(value)]);
    if (!fields.length) fields = [["查询范围", actionSpec?.title || "当前账号可见的方法与参数"]];
  }
  if (id === "platform") fields = [["工具范围", text(args.group) || "当前账号可用的全部平台工具"]];
  if (id === "account" && ["recent", "errors"].includes(action)) fields = [["记录范围", `最近 ${Math.min(30, Math.max(1, Number(args.limit) || 10))} 条${action === "errors" ? "失败调用" : "调用"}`], ["查看内容", action === "errors" ? "发生时间 · 模型 · 失败原因" : "模型 · 用量 · 消耗 · 耗时"]];
  if (id === "account" && action === "error_help") fields = [["错误码", text(args.error_code, 64) || "全部系统错误"], ["查看内容", "中文含义 · 排查建议"]];
  if (id === "binance") fields = [["账户范围", args.account_id ? `你的账户 #${text(args.account_id, 20)}` : action === "accounts" ? "你配置的全部账户" : "你启用的全部账户"], ["资料来源", "平台已同步的账户数据"]];
  if (id === "search") fields = [["检索关键词", text(args.query, 300)]];
  if (id === "fetch") fields = [["阅读地址", text(args.url)]];
  if (id === "github") fields = [["公开仓库", text(args.repo, 200)], ["版本", text(args.ref, 200) || "默认分支"], ...(action === "search" ? [["检索内容", text(args.query, 300)]] : [[action === "list" ? "目录" : "文件", text(args.path, 600) || (action === "list" ? "仓库根目录" : "README")]])];
  if (id === "task") fields = [["小帮手", text(args.agent, 80)], ["任务说明", text(args.prompt, 2400)]];
  if (id === "local") {
    fields = action === "exec" ? [["执行目录", String(args.cwd || ".")], ["完整命令", String(args.command || "")], ["最长执行时间", `${Math.min(1800000, Math.max(1000, Number(args.timeoutMs) || 120000)) / 1000} 秒`]]
      : [["本机相对路径", String(args.path || ".")], ...(action === "search" ? [["检索文字", String(args.query || "")]] : []), ...(["write", "patch"].includes(action) ? [["文件版本", args.expectedSha256 === null ? "新增文件，必须尚不存在" : String(args.expectedSha256 || "缺少版本，无法修改")]] : [])];
    if (action === "write") fields.push(["保存后的完整内容", String(args.content ?? "") || "（空文件）"]);
    if (action === "patch") for (const [i, patch] of (Array.isArray(args.patches) ? args.patches : [{ find: args.find, replace: args.replace }]).entries()) fields.push([`替换 ${i + 1} · 原文 → 新内容`, `${String(patch.find ?? "")}\n→ ${String(patch.replace ?? "")}`]);
  }
  if (id === "todowrite") fields = [["步骤数量", `${Array.isArray(args.todos) ? Math.min(args.todos.length, 20) : 0} 项`], ["任务步骤", Array.isArray(args.todos) ? args.todos.slice(0, 20).map(t => `${({pending:"待处理",in_progress:"进行中",completed:"已完成"})[t?.status] || "待处理"} · ${text(t?.content, 200)}`).join("\n") : "尚未提供步骤"]];
  return { ...selected, fields: fields.map(([label, value]) => ({ label, value: value || "尚未提供" })) };
}
