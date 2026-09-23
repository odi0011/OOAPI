// 额度展示选取规则 —— **全局统一规范**（所有厂商共用一份，改规则只改这里）
// ===========================================================================
// 单独成文件（而不是留在 ChannelQuota.jsx 里）有两个原因：
//   ① 它是**纯函数规则**，不依赖 React/DOM，可以被单测直接 import 验证；
//   ② 用户要求「做好全局的统一规范，之后如果还有类似的厂商额度就直接用这个规则」——
//      规则必须有一处明确的、可被引用的落点，而不是散在某个组件的 render 里。
//
// ── 演进过程（三轮反馈，每一轮都修正了上一轮的误解）──────────────────────────
// 第一轮：「条太多就折叠，默认 5h，5h 完了就显示 7d，这样递进」
// 第二轮：「中间只显示一个额度条你听不懂吗？你他妈显示俩？」「下面那一行你直接
//         折叠 tag？你有病？」—— 主行要收敛，且下面那行不能只给个光秃秃的 +N
// 第三轮（当前口径，推翻了我的前两版理解）：
//   「下面那里不用只显示一个就折叠啊，是看宽度啊，比如那个 gpt 的积分 free，
//     人家就俩 tag，一个余额一个套餐 tag，你给折叠干啥啊？还有 Gemini，四个额度条，
//     默认就显示俩就行了，一个 5h 一个 7d，在第二个额度条的后面加一个 tag 显示 +n，
//     鼠标悬浮显示折叠掉的额度条即可。统一规范改一下。」
//
// → 于是规范是**三条**，不是「永远只显示一条」：
//
//   ① **装得下就不折叠**。折叠是宽度不够时的妥协，不是默认行为。
//      两个 tag（余额 + 套餐）本来就放得下，硬折叠只会藏信息。
//   ② **折叠时按「窗口类型」各留一条**，而不是「取前 N 条」。Gemini 有四条
//      （两组模型 × 5h/weekly），正确做法是一条 5h + 一条 7d —— 让两种时间尺度
//      都可见；按前 N 条取会拿到两个 5h，7d 的用量完全看不到。
//   ③ `+N` **紧跟在最后一条额度条后面**（同一个位置流），不在另起一行。
//      悬浮 `+N` 显示被折叠的那些额度条。
//
// 容量（看宽度的近似）：额度条比 chip 宽得多（含标签 + 进度条 + 百分比，约 130px），
// 所以额度条上限 2 条、chip 上限 2 个。真实的逐像素测量要给每个单元格挂
// ResizeObserver（表格里几十行 = 几十个观察者，滚动时抖动），代价远大于收益；
// 用「保守容量 + 不超容量绝不折叠」既能满足上面三条口径，又不引入测量复杂度。
//
// 不变量：shown ∪ collapsed = 全部窗口，且 shown ∩ collapsed = ∅（不丢数据）。
export const MAX_INLINE_BARS = 2;
export const MAX_INLINE_CHIPS = 2;

/**
 * 从窗口标签文本解析秒数：「5h」→18000、「7d」→604800、「30d」→2592000、「30m」→1800。
 *
 * 为什么必须解析 tag 而不能只看 windowSeconds：**上游给的窗口常常只有 tag**。
 * antigravity 是 `buckets[].window` 字符串、部分快照里 windowSeconds 直接缺失，
 * 实测预览时 5h 排在 7d 后面 —— 递进规则整个失效，用户看到的顺序像是随机。
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

/** 窗口所属分组（scope 缺失时从 label 回推） */
export function scopeOfWindow(w) {
  return String(w?.scope || w?.label?.split(/[·|]/)[0] || "").trim();
}

/**
 * 选取主行要展示的额度条（规范 ①②③）。
 *
 * @param {Array} windows 上游返回的窗口数组
 * @param {number} maxBars 容量上限（默认 MAX_INLINE_BARS）
 * @returns {{shown: Array, collapsed: Array, overflow: number}}
 *
 * 选取算法：
 *   1. 按「窗口长度」分组（18000 / 604800 / …），长度升序 —— 短窗口是更紧的约束；
 *   2. **每个长度取一条**，直到用满 maxBars（规范 ②：5h 一条 + 7d 一条）；
 *      同一长度内：主分组优先（上游第一条所在分组）→ 未用完优先 → 原顺序稳定；
 *   3. 长度种类不够时，再用剩余的窗口按「短优先、未用完优先」补满；
 *   4. 装得下就不折叠（规范 ①）；全部用完时仍要显示（不能空白）。
 */
export function pickVisibleWindows(windows, maxBars = MAX_INLINE_BARS) {
  const wins = Array.isArray(windows) ? windows : [];
  if (!wins.length) return { shown: [], collapsed: [], overflow: 0 };

  // 主分组：上游把账号自己的主分组列在最前，副分组（第三方模型）在后。
  // 只在「同长度」时作为决胜条件，不改变「短窗口优先」这条主线。
  const primaryScope = scopeOfWindow(wins[0]);

  const indexed = wins.map((w, i) => ({ w, i, secs: windowSecondsOf(w) }));
  const better = (a, b) =>
    a.secs - b.secs ||                                                        // 短的优先
    (scopeOfWindow(a.w) === primaryScope ? 0 : 1) - (scopeOfWindow(b.w) === primaryScope ? 0 : 1) ||
    Number(isWindowSpent(a.w)) - Number(isWindowSpent(b.w)) ||                 // 未用完优先
    a.i - b.i;                                                                // 原顺序稳定

  const sorted = [...indexed].sort(better);

  // 装得下 → 全展示（规范 ①：折叠是宽度不够的妥协，不是默认行为）
  if (sorted.length <= maxBars) {
    return { shown: sorted.map((x) => x.w), collapsed: [], overflow: 0 };
  }

  // 规范 ②：按窗口长度各取一条
  const picked = [];
  const usedIdx = new Set();
  const seenSecs = new Set();
  for (const x of sorted) {
    if (picked.length >= maxBars) break;
    if (seenSecs.has(x.secs)) continue;
    seenSecs.add(x.secs);
    picked.push(x);
    usedIdx.add(x.i);
  }
  // 长度种类不足（例如只有一种长度但有 4 个窗口）→ 用剩余窗口补齐到上限
  for (const x of sorted) {
    if (picked.length >= maxBars) break;
    if (usedIdx.has(x.i)) continue;
    picked.push(x);
    usedIdx.add(x.i);
  }

  // 展示顺序按长度升序（与选取顺序一致），保证同排数据的相对位置稳定
  picked.sort(better);
  const collapsed = sorted.filter((x) => !usedIdx.has(x.i));
  return { shown: picked.map((x) => x.w), collapsed: collapsed.map((x) => x.w), overflow: collapsed.length };
}

/**
 * 选取 chip（余额/套餐/积分包…）要展示的部分。
 * 与额度条同一口径：**装得下就全显示**，超容量才收进 `+N`。
 *
 * @param {Array} chips 已排好序的 chip 列表（余额恒在第一）
 * @param {number} maxChips 容量上限
 * @param {number} reservedBars 同一行已被额度条占去的位置（占 1 个位置就少放 1 个 chip）
 */
export function pickVisibleChips(chips, maxChips = MAX_INLINE_CHIPS, reservedBars = 0) {
  const list = Array.isArray(chips) ? chips : [];
  const cap = Math.max(0, maxChips - Math.max(0, reservedBars));
  if (list.length <= cap) return { shown: list, collapsed: [], overflow: 0 };
  return { shown: list.slice(0, cap), collapsed: list.slice(cap), overflow: list.length - cap };
}
