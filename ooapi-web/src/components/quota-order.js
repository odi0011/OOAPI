// 额度条选取规则 —— **全局统一规范**（AI协作.md 第 46 批之后新增）
// ===========================================================================
// 单独成文件（而不是留在 ChannelQuota.jsx 里）有两个原因：
//   ① 它是**纯函数规则**，不依赖 React/DOM，可以被单测直接 import 验证；
//   ② 用户要求「做好全局的统一规范，之后如果还有类似的厂商额度就直接用这个规则」——
//      规则必须有一处明确的、可被引用的落点，而不是散在某个组件的 render 里。
//
// 背景（用户 2026-09-22 反馈原话）：
//   「如果他的条太多的话，默认显示 5h 的，其他的折叠，5h 完了的话就显示 7d，
//     这样递进」；「上面的统计 + 中间的额度条 + 下面折叠的额度条」。
//
// 规则：
//   ① 按窗口长度**升序**（5h → 1d → 7d → 30d）：短窗口是当前真正的限制。
//      7d 还剩 90% 但 5h 已经用满时，盯 5h 才有意义。
//   ② **跳过已用完的窗口**（usedPercent ≥ 99.95）：5h 满了就轮到 7d 成为真正的
//      限制 —— 这就是「5h 完了就显示 7d」的递进。继续把已满的 5h 摆在最显眼处
//      只会误导人以为还能用。
//   ③ 同长度的多个窗口（如 Gemini 的 Gemini 组 / Claude 组各有一个 5h）按原顺序
//      依次显示，不因「长度相同」互相挤掉。
//   ④ 若**全部**用完，则退回显示最短的那个 —— 必须能看到「已满」，而不是空白。
//   ⑤ 长度未知（没有 windowSeconds 且 label 也解析不出）的排最后，不抢占主位。
//
// 不变量：shown ∪ collapsed = 全部窗口，且 shown ∩ collapsed = ∅（不丢数据）。
export const DEFAULT_MAX_BARS = 2;

/**
 * 从窗口标签文本解析秒数：「5h」→18000、「7d」→604800、「30d」→2592000、「30m」→1800。
 *
 * 为什么必须解析 tag 而不能只看 windowSeconds：**上游给的窗口常常只有 tag**。
 * antigravity 是 `buckets[].window` 字符串、部分快照里 windowSeconds 直接缺失，
 * 实测预览时 5h 排在 7d 后面 —— 递进规则整个失效，用户看到的顺序像是随机。
 * 秒数是规则的唯一依据，缺了它规则就不成立，所以这里补齐换算。
 */
export function parseWindowSeconds(w) {
  const direct = Number(w?.windowSeconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = String(w?.tag || w?.label || "").trim().toLowerCase();
  if (!text) return Number.POSITIVE_INFINITY;
  // 取最后一段（label 形如「Gemini Models · weekly」，窗口在后半段）
  const tail = (text.split(/[·|/]/).pop() || "").trim();
  const m = tail.match(/(\d+(?:\.\d+)?)\s*(m|min|h|d|w)\b/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "m" || unit === "min") return n * 60;
    if (unit === "h") return n * 3600;
    if (unit === "d") return n * 86400;
    if (unit === "w") return n * 7 * 86400;
  }
  if (tail.includes("hourly")) return 3600;
  if (tail.includes("daily")) return 86400;
  if (tail.includes("weekly")) return 7 * 86400;
  if (tail.includes("monthly")) return 30 * 86400;
  return Number.POSITIVE_INFINITY;
}

/** 窗口长度（秒）；未知返回 Infinity 以便排到最后 */
export function windowSecondsOf(w) {
  return parseWindowSeconds(w);
}

/** 是否已用完（99.95% 向上取整会显示成 100%，所以用它作阈值） */
export function isWindowSpent(w) {
  const p = Number(w?.usedPercent);
  return Number.isFinite(p) && p >= 99.95;
}

/**
 * 递进选取要展示的额度条。
 * @param {Array} windows 上游返回的窗口数组
 * @param {number} maxBars 主行最多几条（默认 2）
 * @returns {{shown: Array, collapsed: Array}} shown 已按长度升序排好
 */
export function pickVisibleWindows(windows, maxBars = DEFAULT_MAX_BARS) {
  const wins = Array.isArray(windows) ? windows : [];
  if (!wins.length) return { shown: [], collapsed: [] };

  // 带原始下标的排序（同长度时按下标稳定保持原顺序）
  const order = wins
    .map((w, i) => ({ w, i }))
    .sort((a, b) => windowSecondsOf(a.w) - windowSecondsOf(b.w) || a.i - b.i);

  // 装得下就全展示（只排序，不折叠、不隐藏）：
  // 没有折叠空间时还去「跳过已用完的窗口」等于把数据藏起来，那是错的 ——
  // 「跳过」只在**必须挑一部分**时才是对的选择。
  // 排序仍然要做：短窗口在前的顺序必须稳定，否则同一排数据换个位置就变样
  // （用户是按位置读的，5h 忽然跑到 7d 后面会让人以为换了账号）。
  if (wins.length <= maxBars) return { shown: order.map((x) => x.w), collapsed: [] };

  const alive = order.filter((x) => !isWindowSpent(x.w));
  // 规则 ④：全用完时退回最短的那个（而不是显示空）
  const pick = (alive.length ? alive : order).slice(0, maxBars);
  const pickSet = new Set(pick.map((x) => x.i));

  return {
    shown: pick.map((x) => x.w),
    collapsed: wins.filter((_, i) => !pickSet.has(i)),
  };
}
