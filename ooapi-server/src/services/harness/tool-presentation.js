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
const fallback = { ...copy("这一步的内容", "本次结果"), title: "执行这一步", description: "乐乐准备进行下一步操作。", scope: "仅本次操作" };
export function toolPresentation(id, input = {}) {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const base = TOOL_PRESENTATIONS[id] || fallback;
  const rawAction = text(args.action).toLowerCase();
  const action = (id === "account" ? ({ balance: "overview", logs: "recent", history: "recent" })[rawAction] : "") || rawAction || ({ account: "overview", github: "file", binance: "analysis" })[id];
  const { methods: _methods, ...common } = base;
  const selected = { ...common, ...(base.methods?.[action] || {}) };
  let fields = selected.fields || [];
  if (id === "account" && ["recent", "errors"].includes(action)) fields = [["记录范围", `最近 ${Math.min(30, Math.max(1, Number(args.limit) || 10))} 条${action === "errors" ? "失败调用" : "调用"}`], ["查看内容", action === "errors" ? "发生时间 · 模型 · 失败原因" : "模型 · 用量 · 消耗 · 耗时"]];
  if (id === "account" && action === "error_help") fields = [["错误码", text(args.error_code, 64) || "全部系统错误"], ["查看内容", "中文含义 · 排查建议"]];
  if (id === "binance") fields = [["账户范围", args.account_id ? `你的账户 #${text(args.account_id, 20)}` : action === "accounts" ? "你配置的全部账户" : "你启用的全部账户"], ["资料来源", "平台已同步的账户数据"]];
  if (id === "search") fields = [["检索关键词", text(args.query, 300)]];
  if (id === "fetch") fields = [["阅读地址", text(args.url)]];
  if (id === "github") fields = [["公开仓库", text(args.repo, 200)], ["版本", text(args.ref, 200) || "默认分支"], ...(action === "search" ? [["检索内容", text(args.query, 300)]] : [[action === "list" ? "目录" : "文件", text(args.path, 600) || (action === "list" ? "仓库根目录" : "README")]])];
  if (id === "task") fields = [["小帮手", text(args.agent, 80)], ["任务说明", text(args.prompt, 2400)]];
  if (id === "todowrite") fields = [["步骤数量", `${Array.isArray(args.todos) ? Math.min(args.todos.length, 20) : 0} 项`], ["任务步骤", Array.isArray(args.todos) ? args.todos.slice(0, 20).map(t => `${({pending:"待处理",in_progress:"进行中",completed:"已完成"})[t?.status] || "待处理"} · ${text(t?.content, 200)}`).join("\n") : "尚未提供步骤"]];
  return { ...selected, fields: fields.map(([label, value]) => ({ label, value: value || "尚未提供" })) };
}
