// 账号额度展示 —— 渠道列表 / 详情共用
// ---------------------------------------------------------------------------
// 样式参考 sub2api：一行一个窗口，左侧是「窗口标签（5h / 7d / 30d）」，
// 右侧是百分比数字 + 细进度条 + 重置时间。要点：
//   · 窗口**按上游返回动态渲染**，不写死 5h/7d —— 免费号实际是 30 天窗口
//     （OpenAI 的 limit_window_seconds 会告诉我们是哪个），付费号才是 5h+7d；
//   · 百分比取整显示（88%），悬浮才给精确值与重置时间，列表里不堆字；
//   · 颜色按用量分档：<70% 主色、70-90% 橙、>90% 红，一眼看出快用完的账号。
import React from "react";
import { Tooltip } from "antd";
import { ApiOutlined, DatabaseOutlined, ThunderboltOutlined } from "@ant-design/icons";

/** 把秒数转成 sub2api 那样的短标签：18000→5h、604800→7d、2592000→30d */
function windowTag(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return "";
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${Math.round(s / 60)}m`;
}

/**
 * 从窗口标签文本里解析出短窗口名 —— 兜底用。
 *
 * 为什么需要：上游有时只在 label 里写窗口（antigravity 的
 * `buckets[].window` 是 "5h"/"weekly"/"monthly" 这类字符串），
 * windowSeconds 缺省时标签会退化成「额度」两个字 —— 同一账号两行
 * 都是「额度」，用户完全分不清哪个是 5h、哪个是 weekly。
 */
function tagFromText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "";
  // 取最后一段（label 形如「Gemini Models · weekly」，窗口在后半段）
  const tail = (t.split(/[·|/]/).pop() || "").trim();
  const m = tail.match(/^(\d+)\s*(m|min|h|d|w)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "m" || unit === "min") return `${n}m`;
    if (unit === "h") return `${n}h`;
    if (unit === "d") return `${n}d`;
    if (unit === "w") return `${n * 7}d`;
  }
  if (tail.includes("daily")) return "1d";
  if (tail.includes("weekly")) return "7d";
  if (tail.includes("monthly")) return "30d";
  if (tail.includes("hourly")) return "1h";
  return "";
}

/**
 * 窗口的身份标签（显示在胶囊里）。
 *
 * 用户反馈的原话：「意义不明的 tag，既然都是额度，那就不要写额度啊」——
 * 原来的兜底是「额度」，同一账号的多个窗口全都长一样，等于没有信息。
 * 现在的优先级：显式 tag → 秒数推导 → 从 label 文本解析。
 * 三者都拿不到时才退回「额度」（那种窗口本身就是「余额」类，没有时间维度）。
 */
/**
 * 分组名的极短形式（「Gemini Models」→「Gemini」，「Claude and GPT models」→「Claude」）。
 * 只在同一账号存在多个分组时才用，作用是区分「都是 7d 但属于不同模型组」的两行。
 */
function shortScope(scope) {
  const t = String(scope || "").trim();
  if (!t) return "";
  const first = t.split(/[\s·|/]+/).filter(Boolean)[0] || "";
  return first.slice(0, 8);
}

/**
 * 从 label 回推模型分组名 —— 老**额度快照**没有 `scope` 字段时的兜底。
 *
 * 为什么需要：scope 是后加的字段，已缓存在 channels.quota 里的旧快照没有它。
 * 没有 scope 时，antigravity 的 4 个窗口会显示成「7d / 5h / 7d / 5h」两两重复，
 * 用户完全分不清哪个属于 Gemini、哪个属于 Claude（实测反馈）。
 * label 形如「Gemini Models · weekly」→ 取分隔符之前的部分作为分组名。
 */
function scopeFromLabel(label) {
  const t = String(label || "").trim();
  if (!t) return "";
  const parts = t.split(/[·|]/);
  if (parts.length < 2) return "";
  return parts[0].trim();
}

function windowIdentity(w) {
  return (
    String(w?.tag || "").trim() ||
    windowTag(w?.windowSeconds) ||
    tagFromText(w?.label) ||
    "额度"
  );
}

/**
 * 用量分档 → 胶囊色组（底色 / 字色 / 条色）。
 *
 * 形态与配色对齐 sub2api（用户点名要求）：**按窗口序号取色**而不是按用量，
 * 这样一个账号的 5h / 7d 两个窗口颜色固定、可跨账号对照（sub2api 的
 * 5h 恒为靛蓝、7d 恒为翠绿）。用量的紧张程度改用**字色与条色加深**表达，
 * 不再整条变红 —— 满屏红条会让人分不清「哪个快满了」和「哪个就是红的」。
 *
 * 分档：<70% 常规色、70~90% 琥珀、>=90% 红。这样既有 sub2api 的静态色序，
 * 又保留「快用完一眼看出」这个原来的能力。
 */
const PILL_BY_INDEX = [
  { tint: "var(--pill-indigo-tint)", ink: "var(--pill-indigo-ink)", bar: "var(--pill-indigo-bar)" },
  { tint: "var(--pill-emerald-tint)", ink: "var(--pill-emerald-ink)", bar: "var(--pill-emerald-bar)" },
  { tint: "var(--pill-sky-tint)", ink: "var(--pill-sky-ink)", bar: "var(--pill-sky-bar)" },
  { tint: "var(--pill-gray-tint)", ink: "var(--pill-gray-ink)", bar: "var(--pill-gray-bar)" },
];
const PILL_AMBER = { tint: "var(--pill-amber-tint)", ink: "var(--pill-amber-ink)", bar: "var(--pill-amber-bar)" };
const PILL_RED = { tint: "var(--pill-red-tint)", ink: "var(--pill-red-ink)", bar: "var(--pill-red-bar)" };

function pillOf(index, usedPercent) {
  const p = Number(usedPercent);
  if (Number.isFinite(p)) {
    if (p >= 90) return PILL_RED;
    if (p >= 70) return PILL_AMBER;
  }
  return PILL_BY_INDEX[index % PILL_BY_INDEX.length];
}

/** 兼容旧调用点（详情面板等仍需要单一颜色） */
function barColor(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "var(--pill-indigo-bar)";
  if (p >= 90) return PILL_RED.bar;
  if (p >= 70) return PILL_AMBER.bar;
  return "var(--pill-indigo-bar)";
}

/**
 * 重置时间的**短形态**（sub2api 的「现在 / 3h / 2d」）——
 * 列表单元格里空间紧张，长文案（「2 天后重置（09-23 04:00）」）会把额度列撑宽。
 * 完整时间仍走悬浮提示，这里只给最短的相对描述。
 */
function fmtResetShort(epochSeconds, resetAfterSeconds) {
  const at = Number(epochSeconds) || 0;
  const after = Number(resetAfterSeconds) || 0;
  const ms = at ? at * 1000 : after ? Date.now() + after * 1000 : 0;
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "现在";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "现在";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtReset(epochSeconds, resetAfterSeconds) {
  const at = Number(epochSeconds) || 0;
  const after = Number(resetAfterSeconds) || 0;
  const ms = at ? at * 1000 : after ? Date.now() + after * 1000 : 0;
  if (!ms) return "";
  const diff = ms - Date.now();
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(h / 24);
  const rel = diff <= 0 ? "已重置" : d >= 1 ? `${d} 天后重置` : `${h} 小时后重置`;
  const abs = new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${rel}（${abs}）`;
}

/**
 * 单行窗口 —— 形态对齐 sub2api：
 *   `[5h] ──进度条── 62% 现在`
 * 左：淡色底胶囊（等宽字体，固定宽度，多个窗口纵向对齐）
 * 中：4px 细进度条（轨道 gray-200，填充同色系中等饱和）
 * 右：百分比 + 重置提示（sub2api 显示「现在」，即距重置的相对时间）
 *
 * index 决定静态色序（第一窗口靛蓝、第二翠绿…），用量档位再覆盖成琥珀/红。
 */
function WindowRow({ w, index = 0, showScope = true, compact = false }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  const pill = pillOf(index, hasPct ? pct : NaN);
  const identity = windowIdentity(w);
  // 同一账号有多个「额度分组」时（antigravity 的 Gemini / Claude 两组各有 5h+weekly），
  // 光看 5h/7d 还是分不清属于哪一组 —— 补一个极短的分组前缀。
  // 只在真有多个分组时才显示，否则白白占宽度。
  // scope 前缀：**只要有多个分组就显示**（含 compact 横向排布）。
  // 用户反馈「谷歌那个为什么四个额度条，两个 7d 两个 5h」—— 正是因为没有前缀时
  // 「7d / 5h / 7d / 5h」两两重复，看不出哪个属于 Gemini、哪个属于 Claude。
  const scopeShort = showScope ? shortScope(w.scope || scopeFromLabel(w.label)) : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, minWidth: 0 }}>
      <span
        style={{
          minWidth: 34,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 600,
          color: pill.ink,
          background: pill.tint,
          borderRadius: 5,
          padding: "2px 5px",
          flexShrink: 0,
          lineHeight: 1.35,
          whiteSpace: "nowrap",
        }}
        title={w.label || identity}
      >
        {scopeShort ? `${scopeShort} ` : ""}{identity}
      </span>
      {hasPct ? (
        <>
          <span
            style={{
              // compact（表格内横向排布）：进度条固定短宽，不抢 flex 空间，
              // 这样一行能放下 3 个 pill；非 compact（详情面板）仍铺满可用宽度。
              flex: compact ? "0 0 auto" : 1,
              width: compact ? 44 : undefined,
              minWidth: compact ? 44 : 32,
              height: 4,
              borderRadius: 2,
              background: "var(--pill-track)",
              overflow: "hidden",
              display: "inline-block",
            }}
          >
            <span
              style={{
                display: "block",
                width: `${pct}%`,
                height: "100%",
                background: pill.bar,
                borderRadius: 2,
                transition: "width 200ms ease",
              }}
            />
          </span>
          <span
            className="oo-num"
            style={{ color: pill.ink, fontWeight: 600, flexShrink: 0, fontSize: 11.5 }}
          >
            {pct >= 99.95 ? "100%" : `${Math.round(pct)}%`}
          </span>
          {/* 尾部不再显示重置时间：用户反馈「窗口写在标签里，后面那个时间就不要了」——
              两处都在说时间，读起来分不清哪个是窗口、哪个是倒计时。
              重置信息保留在悬浮提示里（fmtReset 给完整时间与相对描述）。 */}
        </>
      ) : (
        <span className="oo-num" style={{ color: "var(--ink-3)", flexShrink: 0 }}>
          {Number.isFinite(Number(w.limit))
            ? `${w.used ?? 0}/${w.limit}`
            : Number.isFinite(Number(w.remaining))
              ? `剩 ${w.remaining}`
              : "—"}
        </span>
      )}
    </div>
  );
}

/**
 * 信息胶囊（套餐名 / 账号 / 余额）—— sub2api 的灰底小胶囊形态。
 * 与窗口胶囊区分开：窗口胶囊是彩色的（有色序含义），信息胶囊一律中性灰，
 * 避免整个单元格变成调色板。
 */
export function InfoPill({ children, tone = "gray", title }) {
  const map = {
    gray: { tint: "var(--pill-gray-tint)", ink: "var(--pill-gray-ink)" },
    indigo: { tint: "var(--pill-indigo-tint)", ink: "var(--pill-indigo-ink)" },
    emerald: { tint: "var(--pill-emerald-tint)", ink: "var(--pill-emerald-ink)" },
    red: { tint: "var(--pill-red-tint)", ink: "var(--pill-red-ink)" },
  };
  const c = map[tone] || map.gray;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: 1.5,
        color: c.ink,
        background: c.tint,
        borderRadius: 5,
        padding: "1px 6px",
        whiteSpace: "nowrap",
        // 横向排布时每个 chip 必须能被压缩 + 省略号截断，否则长文案
        // （「Free Plan Subscription 0」）会被父级 overflow:hidden 硬切，
        // 看起来像文字残缺（实测截图确认）。
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        flexShrink: 1,
      }}
    >
      {children}
    </span>
  );
}

/** 悬浮/补充详情：套餐、各窗口的重置时间、余额（账号与抓取时间按需求无需展示） */
export function QuotaTip({ quota }) {
  if (!quota) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
      {quota.plan || quota.limitReached ? (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {quota.plan ? <InfoPill tone="indigo">套餐 {quota.plan}</InfoPill> : null}
          {quota.limitReached ? <InfoPill tone="red">已达限额</InfoPill> : null}
        </div>
      ) : null}
      {(quota.windows || []).map((w, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <WindowRow w={w} index={i} />
          {w.resetAt || w.resetAfterSeconds ? (
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtReset(w.resetAt, w.resetAfterSeconds)}</span>
          ) : null}
          {w.note ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{w.note}</span> : null}
        </div>
      ))}
      {/* 余额类信息也走灰胶囊：与窗口彩色胶囊形成层次，不再是一条条裸文本 */}
      {quota.credits?.lines?.length || quota.credits?.balance || Number.isFinite(Number(quota.credits?.prepaidBalance)) ? (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {(quota.credits?.lines || []).map((c, i) => (
            <InfoPill key={i}>{c.label} {c.total ?? c.used ?? 0}</InfoPill>
          ))}
          {quota.credits?.balance ? <InfoPill>余额 {quota.credits.balance}</InfoPill> : null}
          {Number.isFinite(Number(quota.credits?.prepaidBalance)) ? (
            <InfoPill>预付费 ${Number(quota.credits.prepaidBalance).toFixed(2)}</InfoPill>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 列表内联形态 —— 表格单元格直接展示。
 *
 * 用户明确要求的形态（2026-09-22）：
 *   · **横向排布**所有标签，超出可用宽度的收进 `+N`，悬浮显示全部
 *     （原来每个窗口占一行，WorkBuddy 那种 5 个积分包会把行高撑到 200px+）；
 *   · 额度条上面三个**纯数字 tag**：调用次数 / 总 token / 总消费 ——
 *     **不写标题文字**（三个位置固定，写「次数/token/消费」纯属占位），
 *     靠图标与单位区分：token 带 k/M/B 单位，消费带 OD 币图标或积分图标；
 *   · 消费单位取决于该渠道**实际消耗什么**：走钱的用 OD 币图标，
 *     积分制的（WorkBuddy/mimo 之类）用积分图标 —— 与模型价格同源。
 *
 * 为什么用 flex-wrap 而不是真的测量截断：表格列宽是固定的，
 * 用纯 CSS 的 `overflow: hidden` + `+N` 需要知道「装得下几个」，
 * 那要靠 ResizeObserver 逐格测量，成本高且窗口 resize 时抖动。
 * 这里用「固定展示前 N 个 + 其余 +M」的近似（N 由列宽与行高决定），
 * 悬浮给全量 —— 与 sub2api 的做法一致，够用且稳。
 */
const INLINE_MAX_PILLS = 3;

// 额度条的递进选取规则抽到 quota-order.js —— 那是「全局统一规范」的落点
// （用户要求后续所有厂商的额度展示都复用同一规则）。这里只做 re-export，
// 让老的 import { pickVisibleWindows } from "./ChannelQuota" 仍然可用。
export { pickVisibleWindows, windowSecondsOf, isWindowSpent, DEFAULT_MAX_BARS } from "./quota-order.js";
import { pickVisibleWindows, DEFAULT_MAX_BARS as MAX_BARS } from "./quota-order.js";

export function QuotaInline({ quota, stats }) {
  if (!quota && !stats) return null;
  const wins = Array.isArray(quota?.windows) ? quota.windows : [];
  const c = quota?.credits;

  const hasBalance = Boolean(c && c.balance !== undefined && c.balance !== null && c.balance !== "");
  const hasPrepaid = Number.isFinite(Number(c?.prepaidBalance));
  const hasLines = Boolean(c?.lines?.length);

  // 汇总 chips：套餐 / 余额 / 积分包…全部作为「横向标签」平铺，超出收进 +N
  const chips = [];
  if (quota?.plan) chips.push({ key: "plan", node: <>套餐 {quota.plan}</>, tone: "indigo" });
  if (quota?.limitReached) chips.push({ key: "limit", node: <>已达限额</>, tone: "red" });
  if (hasLines) {
    c.lines.forEach((line, i) => {
      chips.push({
        key: `line${i}`,
        node: <>{(line.label || "包") + " "}{line.total ?? line.used ?? 0}</>,
        // 积分包剩 0 的标红（一眼看出哪个用完了）
        tone: Number(line.total) === 0 ? "red" : "gray",
      });
    });
  }
  // 余额/积分为「账户存量」，视觉上排在最前 —— 用户要求：
  // 「workbuddy 或者 gpt 的 free 带积分的这种，如果被折叠了，则余额显示为第一个 tag」。
  // 它比套餐名更能回答「还能不能用」，所以即使不折叠也放最前。
  if (hasBalance) chips.unshift({ key: "bal", node: <>余额 {c.balance}{c.unit ? ` ${c.unit}` : ""}</> });
  if (hasPrepaid) chips.push({ key: "pre", node: <>预付费 ${Number(c.prepaidBalance).toFixed(2)}</> });

  const shownChips = chips.slice(0, INLINE_MAX_PILLS);
  const restChips = chips.slice(INLINE_MAX_PILLS);

  // 分组集合：scope 缺失时从 label 回推（老快照），两处口径必须一致，
  // 否则会出现「判出多分组但取不到 scope」→ 前缀渲染成空。
  const scopes = [...new Set(wins.map((w) => String(w.scope || scopeFromLabel(w.label) || "").trim()).filter(Boolean))];
  const multiScope = scopes.length > 1;

  // 统计 tag：三个纯数字（次数 / token / 消费）
  const st = stats || {};
  const hasStats = st.calls !== undefined || st.tokens !== undefined || st.cost !== undefined;

  if (!chips.length && !wins.length && !hasStats) return null;

  const { shown: shownWins, collapsed: collapsedWins } = pickVisibleWindows(wins);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
      {/* ① 统计行：三个纯数字 tag（无标题文字，靠图标/单位区分） */}
      {hasStats ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", overflow: "hidden" }}>
          <StatTag icon={<ApiOutlined />} title={`当前渠道累计调用 ${st.calls ?? 0} 次`}>
            {fmtCompact(st.calls ?? 0)}
          </StatTag>
          <StatTag icon={<DatabaseOutlined />} title={`当前渠道累计 token ${fmtFull(st.tokens ?? 0)}`}>
            {fmtToken(st.tokens ?? 0)}
          </StatTag>
          <StatTag
            icon={st.costUnit === "credits" ? <ThunderboltOutlined /> : <OdCoinIcon />}
            title={`当前渠道累计消费 ${st.costText || ""}`}
          >
            {st.costText || "0"}
          </StatTag>
        </div>
      ) : null}

      {/* ② 主行：递进选出的额度条（最多 INLINE_MAX_BARS 条）。
          没有任何窗口（纯积分渠道）时，这一行直接承载信息 chips ——
          保证「上面统计、中间额度、下面折叠」三段结构不出现空行。 */}
      {shownWins.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", overflow: "hidden" }}>
          {shownWins.map((w, i) => (
            <WindowRow key={w.key || i} w={w} index={i} showScope={multiScope} compact />
          ))}
        </div>
      ) : chips.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", minWidth: 0 }}>
          {shownChips.map((x) => (
            <span key={x.key} style={{ minWidth: 0, flexShrink: 1, display: "inline-flex" }}>
              <InfoPill tone={x.tone}>{x.node}</InfoPill>
            </span>
          ))}
        </div>
      ) : null}

      {/* ③ 折叠行：信息 chips（余额/积分排第一）+ 被折叠的窗口条。
          悬浮 `+N` 给全量 —— 用户要求「下面是折叠的额度条，悬浮显示全部」。 */}
      {(shownWins.length ? chips.length : 0) || collapsedWins.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", minWidth: 0 }}>
          {(shownWins.length ? chips : []).map((x) => (
            <span key={x.key} style={{ minWidth: 0, flexShrink: 1, display: "inline-flex" }}>
              <InfoPill tone={x.tone}>{x.node}</InfoPill>
            </span>
          ))}
          {collapsedWins.length ? (
            <Tooltip
              title={
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
                  {collapsedWins.map((w, i) => (
                    <WindowRow key={w.key || i} w={w} index={i + shownWins.length} showScope={multiScope} />
                  ))}
                </div>
              }
            >
              <span className="bui-chip" style={{ fontSize: 11, flexShrink: 0 }}>
                +{collapsedWins.length}
              </span>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 统计 tag：一个图标 + 一个数字，无标题文字 */
function StatTag({ icon, children, title }) {
  return (
    <Tooltip title={title}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: "var(--ink-2)",
          background: "var(--inset)",
          borderRadius: 5,
          padding: "1px 6px",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ display: "inline-flex", fontSize: 11, color: "var(--ink-3)" }}>{icon}</span>
        <span className="oo-num">{children}</span>
      </span>
    </Tooltip>
  );
}

/** token 数的紧凑显示：1.2M / 345k / 120（用户要求「加单位 m/b/k」） */
function fmtToken(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(v);
}
function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
}
function fmtFull(n) {
  return String(Number(n) || 0);
}
/** OD 币图标（内联 SVG，避免为一个小图标引入图片资源） */
function OdCoinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9 10h6" strokeLinecap="round" />
    </svg>
  );
}

/** 弹窗/详情块形态：完整窗口 + 余额 + 刷新（账号与抓取时间按需求无需展示） */
export default function QuotaPanel({ quota, loading, onRefresh, error }) {
  if (loading) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>正在查询账号额度…</div>;
  if (error) return <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div>;
  if (!quota) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>该渠道暂时没有额度快照。</div>;
  const wins = Array.isArray(quota.windows) ? quota.windows : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {quota.plan || quota.limitReached ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {quota.plan ? <span className="bui-chip">套餐 {quota.plan}</span> : null}
          {quota.limitReached ? <span className="bui-chip bui-chip--orange">已达限额</span> : null}
        </div>
      ) : null}
      {wins.length ? (
        wins.map((w, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <WindowRow w={w} index={i} />
            {w.resetAt || w.resetAfterSeconds ? (
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtReset(w.resetAt, w.resetAfterSeconds)}</span>
            ) : null}
            {w.note ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{w.note}</span> : null}
          </div>
        ))
      ) : (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>该账号没有返回额度窗口，只有余额信息。</div>
      )}
      {quota.credits?.lines?.length ? (
        <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          {quota.credits.lines.map((c, i) => (
            <div key={i}>
              {c.label}：余额 {c.total ?? 0}
              {c.toppedUp !== undefined ? `（赠送 ${c.granted ?? 0} / 充值 ${c.toppedUp}）` : ""}
            </div>
          ))}
        </div>
      ) : null}
      {quota.credits && quota.credits.balance ? (
        <div style={{ fontSize: 12 }}>余额：{quota.credits.balance}</div>
      ) : null}
      {onRefresh ? (
        <button type="button" className="bui-btn" style={{ alignSelf: "flex-start" }} onClick={onRefresh}>
          重新查询
        </button>
      ) : null}
    </div>
  );
}
