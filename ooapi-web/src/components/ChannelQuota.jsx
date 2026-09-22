// 账号额度展示 —— 渠道列表 / 详情共用
// ---------------------------------------------------------------------------
// 样式参考 sub2api：一行一个窗口，左侧是「窗口标签（5h / 7d / 30d）」，
// 右侧是百分比数字 + 细进度条 + 重置时间。要点：
//   · 窗口**按上游返回动态渲染**，不写死 5h/7d —— 免费号实际是 30 天窗口
//     （OpenAI 的 limit_window_seconds 会告诉我们是哪个），付费号才是 5h+7d；
//   · 百分比取整显示（88%），悬浮才给精确值与重置时间，列表里不堆字；
//   · 颜色按用量分档：<70% 主色、70-90% 橙、>90% 红，一眼看出快用完的账号。
import React from "react";

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
function WindowRow({ w, index = 0, showScope = false }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  const pill = pillOf(index, hasPct ? pct : NaN);
  const identity = windowIdentity(w);
  // 同一账号有多个「额度分组」时（antigravity 的 Gemini / Claude 两组各有 5h+weekly），
  // 光看 5h/7d 还是分不清属于哪一组 —— 补一个极短的分组前缀。
  // 只在真有多个分组时才显示，否则白白占宽度。
  const scopeShort = showScope ? shortScope(w.scope) : "";
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
              flex: 1,
              minWidth: 32,
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
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
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
 * 列表内联形态（表格单元格直接展示，无需悬浮）：
 * 上方横向一行：[套餐 free] [余额 1000]（套餐与余额标签并排）
 * 下方：细进度条（sub2api 风格 [30d] ── 77% 26d）
 * 账号与抓取时间按需求无需展示；关键信息直出在表格中，无需鼠标悬浮触发浮层。
 */
export function QuotaInline({ quota }) {
  if (!quota) return null;
  const wins = Array.isArray(quota.windows) ? quota.windows : [];
  const c = quota.credits;

  const hasPlan = Boolean(quota.plan || quota.limitReached);
  const hasBalance = Boolean(c && c.balance !== undefined && c.balance !== null && c.balance !== "");
  const hasPrepaid = Number.isFinite(Number(c?.prepaidBalance));
  const hasLines = Boolean(c?.lines?.length);
  const hasCredits = hasBalance || hasPrepaid || hasLines;

  if (!hasPlan && !hasCredits && !wins.length) {
    return null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
      {hasPlan || hasCredits ? (
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          {quota.plan ? <InfoPill tone="indigo">套餐 {quota.plan}</InfoPill> : null}
          {quota.limitReached ? <InfoPill tone="red">已达限额</InfoPill> : null}
          {hasLines
            ? c.lines.map((line, i) => (
                <InfoPill key={i}>{line.label} {line.total ?? line.used ?? 0}</InfoPill>
              ))
            : null}
          {hasBalance ? <InfoPill>余额 {c.balance}</InfoPill> : null}
          {hasPrepaid ? (
            <InfoPill>预付费 ${Number(c.prepaidBalance).toFixed(2)}</InfoPill>
          ) : null}
        </div>
      ) : null}

      {/* 全部窗口都渲染（原来只显示前 2 个 + 「还有 N 个窗口…」）。
          用户反馈：「下面的还有 2 个窗口是你故意压缩了还是他没加载出来啊」——
          那种省略让人分不清是数据缺失还是界面藏起来了，而额度恰恰是这张表的
          关键信息（哪个窗口快满了决定要不要换号）。
          窗口行很薄（4px 条 + 一行文字），4 个窗口也只占约 90px 高，值得全展开。
          scope 前缀只在同一账号真有多个分组时才加（见 WindowRow）。 */}
      {(() => {
        const scopes = [...new Set(wins.map((w) => String(w.scope || "").trim()).filter(Boolean))];
        const multiScope = scopes.length > 1;
        return wins.map((w, i) => <WindowRow key={w.key || i} w={w} index={i} showScope={multiScope} />);
      })()}
    </div>
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
