// 智能体编排（参考 opencode 的 primary / subagent 两层设计）
// ---------------------------------------------------------------------------
// 为什么这样分层：
//   1. primary —— 用户直接选择的角色，决定「这一轮怎么做事」（直接回答 / 多步检索 / 写作 / 代码）。
//      它是唯一能使用 todowrite（自我规划）与 task（派人）的角色。
//   2. subagent —— 由 task 工具（或输入框 @id）派发的专职工：只做一件事、只拿只读工具，
//      并且**禁止再次派发**（深度限制在 loop.js，避免无限套娃把用户额度烧穿）。
//   3. 本平台跑在网关服务器上，不碰用户文件系统，所以工具全部是只读/无副作用
//      （检索、读网页、更新自己的待办清单）—— 因此不需要 opencode 那样的逐次权限确认。
// 默认模型留空表示「跟随会话当前模型」，避免预设模型被下线后智能体不可用。
export const AGENTS = [
  {
    id: "general",
    name: "通用",
    desc: "直接回答，需要时自己查资料。日常问答与轻量任务。",
    icon: "sparkles",
    mode: "primary",
    tools: ["search", "fetch", "task", "todowrite"],
    thinking: false,
    search: false,
    role: "你是一个通用助手：先给结论，再给必要的推导。问题复杂时可以先列待办再逐条推进。",
  },
  {
    id: "research",
    name: "研究",
    desc: "多轮检索与交叉验证，输出带来源的结论。",
    icon: "search",
    mode: "primary",
    tools: ["todowrite", "search", "fetch", "task"],
    thinking: true,
    search: true,
    role:
      "你是一名研究员：先界定问题、列出研究角度（写成待办），再用检索/读网页工具拿一手材料，" +
      "最后综合成结论。区分「查到的事实」与「你的推断」，不确定就标注不确定。",
  },
  {
    id: "writer",
    name: "写作",
    desc: "先立结构、再成稿、最后润色。文章、文案与报告。",
    icon: "edit",
    mode: "primary",
    tools: ["task", "search"],
    thinking: false,
    search: false,
    role: "你是一名资深编辑：先确认文体与读者，再列结构，然后一次成稿。语言自然、少套话、不要堆形容词。",
  },
  {
    id: "coder",
    name: "代码",
    desc: "给实现、讲取舍、指出边界情况。",
    icon: "code",
    mode: "primary",
    tools: ["todowrite", "search", "fetch", "task"],
    thinking: true,
    search: false,
    role:
      "你是一名资深工程师：给出可运行的实现与关键取舍说明。涉及外部库/协议时用工具核实，" +
      "不要凭记忆编造 API。代码块标明语言。",
  },
  {
    id: "explore",
    name: "检索员",
    desc: "快速检索并回报要点，不写长文。",
    icon: "compass",
    mode: "subagent",
    tools: ["search", "fetch"],
    thinking: false,
    search: true,
    role:
      "你是检索专员：针对交办的问题检索少量高质量材料，回报「要点 + 出处链接」，不写结论性长文，" +
      "也不要做超出交办范围的扩展。",
  },
  {
    id: "review",
    name: "审阅员",
    desc: "挑毛病：事实错误、逻辑漏洞、遗漏。",
    icon: "check",
    mode: "subagent",
    tools: ["search"],
    thinking: true,
    search: false,
    role:
      "你是严格审阅者：只输出问题清单（事实错误 / 逻辑漏洞 / 关键遗漏 / 表述歧义），" +
      "每条给出理由与修改建议。不要重写全文，也不要客套。",
  },
  {
    id: "summarize",
    name: "摘要员",
    desc: "把长内容压成结构化要点。",
    icon: "compress",
    mode: "subagent",
    tools: [],
    thinking: false,
    search: false,
    role: "你是摘要专员：把交办内容压缩成保留关键信息与结论的结构化要点，不新增任何原文没有的信息。",
  },
];

export const PRIMARY_AGENTS = AGENTS.filter((a) => a.mode === "primary");
export const SUBAGENTS = AGENTS.filter((a) => a.mode === "subagent");

export function findAgent(id) {
  return AGENTS.find((a) => a.id === String(id || "")) || null;
}

// 对外（前端）暴露的字段：提示词与内部实现不外发
export function publicAgents(list = AGENTS) {
  return list.map(({ role, ...pub }) => pub);
}

// 工具协议：本平台的渠道里既有 OpenAI 兼容 API，也有网页版反代，
// 后者不支持原生 tool calling，所以统一走「提示词 + 严格 JSON 调用块」协议，
// 由 harness/loop.js 解析。协议只有一种写法，减少模型自由发挥。
export const TOOL_PROTOCOL = [
  "需要外部信息时，你可以调用工具。调用写法（严格照抄，一次只调一个）：",
  '<tool_call>{"tool":"工具名","args":{...}}</tool_call>',
  "规则：",
  "1. 调用块必须是独立的一段，放在回复的最后；可以先用一句话说明为什么调用，但不要写调用结果的猜测。",
  "2. 输出调用块后立即停止，等待系统返回 <tool_result>；不要自己编造工具结果。",
  "3. 拿到结果后判断：还需要别的信息就继续调用，信息够了就直接给出最终回答（不要再输出调用块）。",
  "4. 已知的常识不要调用工具；不确定的事实（时间敏感的、具体数字、外部链接）必须调用。",
].join("\n");

/**
 * 生成 harness 系统提示词（每次调用都会重新拼装，因为待办清单会变）
 * @param {object} p
 * @param {object} p.agent     智能体定义
 * @param {string} p.model     当前模型
 * @param {object} p.settings  会话设定（instructions / tools / maxSteps）
 * @param {Array}  p.toolSpecs 本次可用工具
 * @param {Array}  p.todo      待办清单
 * @param {Array}  p.subagents 可派发的子代理
 * @param {number} p.depth     0=主智能体，1=子代理
 */
export function buildSystemPrompt({ agent, model, settings = {}, toolSpecs = [], todo = [], subagents = [], depth = 0 }) {
  const lines = [];
  lines.push(`${agent.role || agent.desc}`);
  lines.push("");
  lines.push("# 运行环境");
  lines.push(`- 时间：${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`);
  lines.push(`- 模型：${model}`);
  lines.push(
    "- 你运行在 OOAPI 模型网关的对话工作台里：**不能执行命令、不能读写用户文件、不能访问内网**，" +
      "获取外部信息只能通过下面的工具。"
  );
  if (depth > 0) lines.push("- 你是被主智能体派发的子代理：只完成交办的这一件事，完成后直接给出结果，不要再派人。");

  if (toolSpecs.length) {
    lines.push("");
    lines.push("# 可用工具");
    for (const t of toolSpecs) lines.push(`- ${t.id}：${t.desc}\n  参数：${t.args}`);
    lines.push("");
    lines.push(TOOL_PROTOCOL);
  } else {
    lines.push("");
    lines.push("# 工具");
    lines.push("本轮没有可用工具，请直接基于已有知识回答；不确定的地方明确说明，不要编造。");
  }

  if (agent.tools.includes("todowrite") && depth === 0) {
    lines.push("");
    lines.push("# 待办清单");
    lines.push(
      "任务需要 3 步以上时，先调用 todowrite 写出计划（恰好一项 in_progress），" +
        "之后每次推进都重新提交完整清单并更新状态。简单问答不要用待办。"
    );
    if (todo.length) {
      lines.push(`当前清单：${todo.map((t) => `[${t.status}] ${t.content}`).join("；")}`);
    }
  }

  if (subagents.length && agent.tools.includes("task")) {
    lines.push("");
    lines.push("# 可派发的子代理（task 工具）");
    for (const s of subagents) lines.push(`- ${s.id}：${s.desc}`);
  }

  const extra = String(settings.instructions || "").trim();
  if (extra) {
    lines.push("");
    lines.push("# 用户会话指令（优先级高于默认风格，但不得越过上面的边界）");
    lines.push(extra.slice(0, 4000));
  }

  lines.push("");
  lines.push("# 输出风格");
  lines.push("- 用 Markdown；中文回答，除非用户使用其他语言。");
  lines.push("- 先给结论/结果，再给依据；不要复述用户的原话，不要写「好的，我来帮你」这类开场白。");
  lines.push("- 不复述工具的原始报文，只给结论与必要出处（链接）。");
  return lines.join("\n");
}
