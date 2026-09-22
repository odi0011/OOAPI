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
const PATTERNS = [
  // 模型下线 / 需换模型（实测抓到的原文）
  { re: /(is|are)\s+no\s+longer\s+available/i, reason: "该模型已下线" },
  { re: /please\s+switch\s+to\s+[\w.\- ]+\s+(model|in\s+the\s+latest)/i, reason: "上游要求切换模型" },
  { re: /model\s+[`"']?[\w.\-]+[`"']?\s+(not\s+found|does\s+not\s+exist|is\s+unavailable|has\s+been\s+(retired|deprecated))/i, reason: "模型不存在或已停用" },
  { re: /(invalid|unknown|unsupported)\s+model/i, reason: "模型名不被上游接受" },
  // 权限 / 账号
  { re: /(permission\s+denied|you\s+do\s+not\s+have\s+(access|permission))/i, reason: "账号权限不足" },
  { re: /(insufficient|not\s+enough)\s+(credit|quota|balance)/i, reason: "上游额度不足" },
  { re: /(account|subscription)\s+(is\s+)?(suspended|disabled|expired|deactivated)/i, reason: "上游账号状态异常" },
  // 风控 / 人机验证
  { re: /(verify\s+you\s+are\s+human|unusual\s+activity|complete\s+the\s+verification)/i, reason: "上游要求人机验证" },
  // 中文（国内上游常用）
  { re: /(模型|接口)(已下线|不存在|不可用|已停用)/, reason: "模型不存在或已下线" },
  { re: /(权限不足|无权限|未开通|额度不足|余额不足)/, reason: "账号权限或额度不足" },
  { re: /(请切换|请更换)(到)?(新)?模型/, reason: "上游要求切换模型" },
];

/** 短回复才算「整段都是错误提示」；长文本里偶发命中不算 */
const MAX_LEN = 400;

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
  for (const { re, reason } of PATTERNS) {
    if (re.test(text)) {
      return { reason, excerpt: text.replace(/\s+/g, " ").slice(0, 200) };
    }
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
