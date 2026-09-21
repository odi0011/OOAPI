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

/** 把秒数转成 sub2api 那样的短标签：18000→5h、604800→7d、2592000→30d */
function windowTag(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return "额度";
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${Math.round(s / 60)}m`;
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
function WindowRow({ w, index = 0 }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  const pill = pillOf(index, hasPct ? pct : NaN);
  // sub2api 的「0% 现在」：把重置时间压成最短的相对描述
  const resetShort = fmtResetShort(w.resetAt, w.resetAfterSeconds);
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
        }}
        title={w.label}
      >
        {w.tag || windowTag(w.windowSeconds)}
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
          {resetShort ? (
            <span style={{ color: "var(--ink-3)", fontSize: 11, flexShrink: 0 }}>{resetShort}</span>
          ) : null}
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

/** 悬浮详情：套餐、账号、各窗口的重置时间、余额 */
export function QuotaTip({ quota }) {
  if (!quota) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200 }}>
      {quota.plan || quota.limitReached ? (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {quota.plan ? <InfoPill tone="indigo">套餐 {quota.plan}</InfoPill> : null}
          {quota.limitReached ? <InfoPill tone="red">已达限额</InfoPill> : null}
        </div>
      ) : null}
      {quota.account ? (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <InfoPill title={quota.account}>账号 {quota.account}</InfoPill>
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
      {quota.fetchedAt ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          抓取于 {new Date(quota.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 列表内联形态：最多两行窗口（sub2api 布局），其余进悬浮。
 * 没有窗口但有余额（DeepSeek API / Grok）时退化为一行余额。
 */
export function QuotaInline({ quota }) {
  if (!quota) return null;
  const wins = Array.isArray(quota.windows) ? quota.windows : [];
  if (wins.length) {
    return (
      <Tooltip title={<QuotaTip quota={quota} />}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 150 }}>
          {wins.slice(0, 2).map((w, i) => (
            <WindowRow key={i} w={w} index={i} />
          ))}
          {wins.length > 2 ? (
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>还有 {wins.length - 2} 个窗口…</span>
          ) : null}
        </div>
      </Tooltip>
    );
  }
  const c = quota.credits;
  const line = c?.lines?.[0];
  const text = line
    ? `余额 ${line.total ?? 0}`
    : c && c.balance
      ? `余额 ${c.balance}`
      : Number.isFinite(Number(c?.prepaidBalance))
        ? `$${Number(c.prepaidBalance).toFixed(2)}`
        : "";
  if (!text) return null;
  return (
    <Tooltip title={<QuotaTip quota={quota} />}>
      <span className="oo-num" style={{ fontSize: 12, color: "var(--ink-3)" }}>{text}</span>
    </Tooltip>
  );
}

/** 弹窗/详情块形态：完整窗口 + 余额 + 刷新 */
export default function QuotaPanel({ quota, loading, onRefresh, error }) {
  if (loading) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>正在查询账号额度…</div>;
  if (error) return <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div>;
  if (!quota) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>该渠道暂时没有额度快照。</div>;
  const wins = Array.isArray(quota.windows) ? quota.windows : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {quota.plan || quota.account ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {quota.plan ? <span className="bui-chip">套餐 {quota.plan}</span> : null}
          {quota.account ? <span className="bui-chip">{quota.account}</span> : null}
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
      {quota.fetchedAt ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          抓取于 {new Date(quota.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
        </div>
      ) : null}
      {onRefresh ? (
        <button type="button" className="bui-btn" style={{ alignSelf: "flex-start" }} onClick={onRefresh}>
          重新查询
        </button>
      ) : null}
    </div>
  );
}
