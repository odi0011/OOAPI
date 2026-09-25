// 上游「用正文说错误」的识别 —— 所有适配器共用
// ===========================================================================
// 为什么需要：部分上游在模型不可用/权限不足时**不返回 HTTP 错误**，而是把错误
// 写成一整段普通正文（HTTP 200 + 正常 candidates）。第 46 批复审在线上抓到的实例：
//
//   渠道 Google Gemini 的 recent_calls 里真实记录了
//     ok:1, r:"Gemini 3.5 Flash is no longer available. Please switch to
//                 Gemini 3.7 Flash in the latest version of Antigravity."
//     k:"test", 耗时 3019ms
//
// 也就是：**渠道已被判为健康（ok=1），自动检测还会重置冷却**，而实际上这个模型
// 早就下线了，任何真实用户请求都会拿到这段「请换模型」的话。健康判定只看
// 「有没有非空正文」是不够的 —— 有正文不等于成功。
//
// 识别策略（保守优先，宁可放过不可误杀）：
//   · 只在**整段回复很短**且命中明确错误句式时判定为错误 —— 真实回答里出现
//     "no longer available" 这种词组的概率低，但长回答里偶发出现的可能性不为零，
//     长度门槛进一步压住误报；
//   · 命中后返回结构化信息（code + 人话消息），由适配器转成可分类错误，
//     使 execute.js 能按正确档位冷却/换渠道，而不是当作成功。
//
// **只靠"短 + 命中词"是不够的**（Round 4 模拟用户实测，见下方注释）：
// 用户正常提问「余额不足是什么意思？」也会命中，导致回答被当成上游故障丢弃。
// 因此再加两道判据（提问语境排除 + 命中位置需靠段首），
// 并在 tests/content-error.test.mjs 里固化为"不得误判"回归用例。
const PATTERNS = [
  // 模型下线 / 需换模型（实测抓到的原文）
  { re: /(is|are)\s+no\s+longer\s+available/i, reason: "该模型已下线" },
  { re: /please\s+switch\s+to\s+[\w.\- ]+\s+(model|in\s+the\s+latest)/i, reason: "上游要求切换模型" },
  { re: /model\s+[`"']?[\w.\-]+[`"']?\s+(not\s+found|does\s+not\s+exist|is\s+unavailable|has\s+been\s+(retired|deprecated))/i, reason: "模型不存在或已停用" },
  { re: /(invalid|unknown|unsupported)\s+model/i, reason: "模型名不被上游接受" },
  // 权限 / 账号
  { re: /(permission\s+denied|you\s+do\s+not\s+have\s+(access|permission))/i, reason: "账号权限不足" },
  { re: /(insufficient|not\s+enough)\s+(credit|quota|balance)/i, reason: "上游额度不足" },
  // 时态要全：上游也常写 "has been suspended"，只认 "is suspended" 会漏杀
  //（实测：Your account has been suspended. 原先识别不出来）
  { re: /(account|subscription)\s+(is|has\s+been|was|were)\s+(suspended|disabled|expired|deactivated)/i, reason: "上游账号状态异常" },
  // 风控 / 人机验证
  { re: /(verify\s+you\s+are\s+human|unusual\s+activity|complete\s+the\s+verification)/i, reason: "上游要求人机验证" },
  // 中文（国内上游常用）
  // 收紧：去掉「不可用」（太通用，"模型不可用的时候我该怎么做"这种提问会误伤）
  { re: /(模型|接口)(已下线|不存在|已停用)/, reason: "模型不存在或已下线" },
  // 收紧：「额度不足/权限不足」单用不算（用户提问里太常见），
  // 必须同时出现**明确的指示动作**（请/需要），才是上游在报错。
  { re: /(额度|余额|权限|配额)(不足|已用尽|已耗尽)[，,。.；;]?\s*(请|需)/, reason: "账号权限或额度不足" },
  { re: /(请切换|请更换)(到)?(新)?模型/, reason: "上游要求切换模型" },
];

/** 短回复才算「整段都是错误提示」；长文本里偶发命中不算 */
const MAX_LEN = 400;

/**
 * 提问 / 讨论语境的标记 —— 命中则**不做**「上游报错」判定。
 *
 * 为什么加这道判据（Round 4 模拟用户实测，5 个人格 15 条正常提问中 7 条被误判）：
 * 用户问「余额不足是什么意思？」「账号权限不足怎么办」这类**很常见的技术问题**时，
 * 回答会被原判据当成上游错误 → 整条请求作为失败丢弃（返回 502/503 而不是答案）。
 * 平台本身按 token 计费，"额度/扣费/权限"恰是用户高频提问域，所以必须挡住。
 *
 * 判据只认**明显的提问/求解释信号**，不认"含有疑问词"——
 * 避免把上游真错误里偶尔出现的疑问句（如 "is no longer available?"）也放过。
 */
const ASK_CONTEXT = /[?？]|怎么|怎么办|如何|是什么|为什么|啥意思|什么意思|请问|请解释|请说明|解释一下|吗\s*[。.!！]?\s*$/;

/**
 * 命中必须落在**第一个句子内**，才算「整段就是错误提示」。
 *
 * 为什么不用"前 N 个字符"：中英文的信息密度不同 ——
 * "insufficient quota" 在英文里 0 字符就命中，而中文句子里同样长度
 * 已经是一整句话了（实测：「…主要用来处理一些文本翻译工作，结果它提示
 * insufficient quota」中命中在第 43 字符，但那已经是第二个分句）。
 * 用字符窗口会把这种"内容里提到"误当成"整段是错误"，所以改为按句子边界判断。
 *
 * 真实的上游错误提示都是**开头即结论**：
 *   "insufficient quota"                            ← 第 1 句
 *   "Gemini 3.5 Flash is no longer available. …"     ← 第 1 句
 *   "额度不足，请充值后重试"                          ← 第 1 句
 * 所以「命中在第一句内」既宽松（容纳整句错误提示）又准确（排除后文中提及）。
 */
const FIRST_SENTENCE_END = /[。！？!?；;\n]/;
// 中文里的逗号也算软边界：中文一句话常常很长，
// 「…我跑了个脚本，跑到一半 insufficient quota」这种命中虽然在同一"句"内，
// 但它在**第二个分句**，属于"内容里提到"而不是"整段就是错误提示"。
// 只对中文逗号生效（英文逗号太常见，"insufficient quota, please top up" 那种
// 整句错误提示不能因此被判掉）。
const SOFT_BREAK = /[，、]/;

/** 命中位置是否落在第一个句子/分句内 */
function inFirstSentence(text, index) {
  const head = text.slice(0, index);
  return !FIRST_SENTENCE_END.test(head) && !SOFT_BREAK.test(head);
}

/**
 * 检查一段回复文本是否其实是上游的错误提示。
 * @param {string} content 正文
 * @returns {{reason: string, excerpt: string}|null} 命中返回原因与片段，否则 null
 */
export function detectContentError(content) {
  const text = String(content || "").trim();
  if (!text) return null;
  // 长回复不做判定：真实的错误提示都是短句，而正常回答里出现这些词组的概率随长度上升
  if (text.length > MAX_LEN) return null;
  // 提问/讨论语境不是上游报错（见 ASK_CONTEXT 注释）
  if (ASK_CONTEXT.test(text)) return null;
  for (const { re, reason } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // 命中不在第一句内 → 当作"内容里提到"而非"整段就是错误提示"（见 inFirstSentence 注释）
    if (!inFirstSentence(text, m.index)) continue;
    return { reason, excerpt: text.replace(/\s+/g, " ").slice(0, 200) };
  }
  return null;
}

/**
 * 便捷：命中则抛可分类错误（供适配器在拿到完整正文后调用）。
 * 用 CHANNEL_BIZ_ERROR（上游业务错误，可换渠道重试）而不是 CHANNEL_EMPTY ——
 * 语义是「上游明确说了不行」，换号往往能解，冷却档位也匹配。
 */
export function assertNoContentError(content, prefix = "") {
  const hit = detectContentError(content);
  if (!hit) return;
  throw Object.assign(new Error(`${prefix ? prefix + "：" : ""}上游返回错误提示（${hit.reason}）：${hit.excerpt}`), {
    code: "CHANNEL_BIZ_ERROR",
    contentError: 1,
  });
}
