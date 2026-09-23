// src/components/ChannelQuota.jsx
import React from "react";
import { Tooltip } from "antd";
import { ApiOutlined, DatabaseOutlined, ThunderboltOutlined } from "@ant-design/icons";

// src/components/quota-order.js
var MAX_INLINE_BARS = 2;
var MAX_INLINE_CHIPS = 2;
function parseWindowSeconds(w) {
  const direct = Number(w?.windowSeconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = String(w?.tag || w?.label || "").trim().toLowerCase();
  if (!text) return Number.POSITIVE_INFINITY;
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
function windowSecondsOf(w) {
  return parseWindowSeconds(w);
}
function isWindowSpent(w) {
  const p = Number(w?.usedPercent);
  return Number.isFinite(p) && p >= 99.95;
}
function scopeOfWindow(w) {
  return String(w?.scope || w?.label?.split(/[·|]/)[0] || "").trim();
}
function pickVisibleWindows(windows, maxBars = MAX_INLINE_BARS) {
  const wins = Array.isArray(windows) ? windows : [];
  if (!wins.length) return { shown: [], collapsed: [], overflow: 0 };
  const primaryScope = scopeOfWindow(wins[0]);
  const indexed = wins.map((w, i) => ({ w, i, secs: windowSecondsOf(w) }));
  const better = (a, b) => a.secs - b.secs || // 短的优先
  (scopeOfWindow(a.w) === primaryScope ? 0 : 1) - (scopeOfWindow(b.w) === primaryScope ? 0 : 1) || Number(isWindowSpent(a.w)) - Number(isWindowSpent(b.w)) || // 未用完优先
  a.i - b.i;
  const sorted = [...indexed].sort(better);
  if (sorted.length <= maxBars) {
    return { shown: sorted.map((x) => x.w), collapsed: [], overflow: 0 };
  }
  const picked = [];
  const usedIdx = /* @__PURE__ */ new Set();
  const seenSecs = /* @__PURE__ */ new Set();
  for (const x of sorted) {
    if (picked.length >= maxBars) break;
    if (seenSecs.has(x.secs)) continue;
    seenSecs.add(x.secs);
    picked.push(x);
    usedIdx.add(x.i);
  }
  for (const x of sorted) {
    if (picked.length >= maxBars) break;
    if (usedIdx.has(x.i)) continue;
    picked.push(x);
    usedIdx.add(x.i);
  }
  picked.sort(better);
  const collapsed = sorted.filter((x) => !usedIdx.has(x.i));
  return { shown: picked.map((x) => x.w), collapsed: collapsed.map((x) => x.w), overflow: collapsed.length };
}
function pickVisibleChips(chips, maxChips = MAX_INLINE_CHIPS, reservedBars = 0) {
  const list = Array.isArray(chips) ? chips : [];
  const cap = Math.max(0, maxChips - Math.max(0, reservedBars));
  if (list.length <= cap) return { shown: list, collapsed: [], overflow: 0 };
  return { shown: list.slice(0, cap), collapsed: list.slice(cap), overflow: list.length - cap };
}

// src/components/ChannelQuota.jsx
function windowTag(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return "";
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${Math.round(s / 60)}m`;
}
function tagFromText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "";
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
function shortScope(scope) {
  const t = String(scope || "").trim();
  if (!t) return "";
  const first = t.split(/[\s·|/]+/).filter(Boolean)[0] || "";
  return first.slice(0, 8);
}
function scopeFromLabel(label) {
  const t = String(label || "").trim();
  if (!t) return "";
  const parts = t.split(/[·|]/);
  if (parts.length < 2) return "";
  return parts[0].trim();
}
function windowIdentity(w) {
  return String(w?.tag || "").trim() || windowTag(w?.windowSeconds) || tagFromText(w?.label) || "\u989D\u5EA6";
}
var PILL_BY_INDEX = [
  { tint: "var(--pill-indigo-tint)", ink: "var(--pill-indigo-ink)", bar: "var(--pill-indigo-bar)" },
  { tint: "var(--pill-emerald-tint)", ink: "var(--pill-emerald-ink)", bar: "var(--pill-emerald-bar)" },
  { tint: "var(--pill-sky-tint)", ink: "var(--pill-sky-ink)", bar: "var(--pill-sky-bar)" },
  { tint: "var(--pill-gray-tint)", ink: "var(--pill-gray-ink)", bar: "var(--pill-gray-bar)" }
];
var PILL_AMBER = { tint: "var(--pill-amber-tint)", ink: "var(--pill-amber-ink)", bar: "var(--pill-amber-bar)" };
var PILL_RED = { tint: "var(--pill-red-tint)", ink: "var(--pill-red-ink)", bar: "var(--pill-red-bar)" };
function pillOf(index, usedPercent) {
  const p = Number(usedPercent);
  if (Number.isFinite(p)) {
    if (p >= 90) return PILL_RED;
    if (p >= 70) return PILL_AMBER;
  }
  return PILL_BY_INDEX[index % PILL_BY_INDEX.length];
}
function fmtReset(epochSeconds, resetAfterSeconds) {
  const at = Number(epochSeconds) || 0;
  const after = Number(resetAfterSeconds) || 0;
  const ms = at ? at * 1e3 : after ? Date.now() + after * 1e3 : 0;
  if (!ms) return "";
  const diff = ms - Date.now();
  const h = Math.floor(diff / 36e5);
  const d = Math.floor(h / 24);
  const rel = diff <= 0 ? "\u5DF2\u91CD\u7F6E" : d >= 1 ? `${d} \u5929\u540E\u91CD\u7F6E` : `${h} \u5C0F\u65F6\u540E\u91CD\u7F6E`;
  const abs = new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${rel}\uFF08${abs}\uFF09`;
}
function WindowRow({ w, index = 0, showScope = true, compact = false }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  const pill = pillOf(index, hasPct ? pct : NaN);
  const identity = windowIdentity(w);
  const scopeShort = showScope ? shortScope(w.scope || scopeFromLabel(w.label)) : "";
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 7, fontSize: 12, minWidth: 0 } }, /* @__PURE__ */ React.createElement(
    "span",
    {
      style: {
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
        whiteSpace: "nowrap"
      },
      title: w.label || identity
    },
    scopeShort ? `${scopeShort} ` : "",
    identity
  ), hasPct ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    "span",
    {
      style: {
        // compact（表格内横向排布）：进度条固定短宽，不抢 flex 空间，
        // 这样一行能放下 3 个 pill；非 compact（详情面板）仍铺满可用宽度。
        flex: compact ? "0 0 auto" : 1,
        width: compact ? 44 : void 0,
        minWidth: compact ? 44 : 32,
        height: 4,
        borderRadius: 2,
        background: "var(--pill-track)",
        overflow: "hidden",
        display: "inline-block"
      }
    },
    /* @__PURE__ */ React.createElement(
      "span",
      {
        style: {
          display: "block",
          width: `${pct}%`,
          height: "100%",
          background: pill.bar,
          borderRadius: 2,
          transition: "width 200ms ease"
        }
      }
    )
  ), /* @__PURE__ */ React.createElement(
    "span",
    {
      className: "oo-num",
      style: { color: pill.ink, fontWeight: 600, flexShrink: 0, fontSize: 11.5 }
    },
    pct >= 99.95 ? "100%" : `${Math.round(pct)}%`
  )) : /* @__PURE__ */ React.createElement("span", { className: "oo-num", style: { color: "var(--ink-3)", flexShrink: 0 } }, Number.isFinite(Number(w.limit)) ? `${w.used ?? 0}/${w.limit}` : Number.isFinite(Number(w.remaining)) ? `\u5269 ${w.remaining}` : "\u2014"));
}
function InfoPill({ children, tone = "gray", title }) {
  const map = {
    gray: { tint: "var(--pill-gray-tint)", ink: "var(--pill-gray-ink)" },
    indigo: { tint: "var(--pill-indigo-tint)", ink: "var(--pill-indigo-ink)" },
    emerald: { tint: "var(--pill-emerald-tint)", ink: "var(--pill-emerald-ink)" },
    red: { tint: "var(--pill-red-tint)", ink: "var(--pill-red-ink)" }
  };
  const c = map[tone] || map.gray;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      title,
      style: {
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
        flexShrink: 1
      }
    },
    children
  );
}
function QuotaTip({ quota }) {
  if (!quota) return null;
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 180 } }, quota.plan || quota.limitReached ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 5, flexWrap: "wrap" } }, quota.plan ? /* @__PURE__ */ React.createElement(InfoPill, { tone: "indigo" }, "\u5957\u9910 ", quota.plan) : null, quota.limitReached ? /* @__PURE__ */ React.createElement(InfoPill, { tone: "red" }, "\u5DF2\u8FBE\u9650\u989D") : null) : null, (quota.windows || []).map((w, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React.createElement(WindowRow, { w, index: i }), w.resetAt || w.resetAfterSeconds ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: "var(--ink-3)" } }, fmtReset(w.resetAt, w.resetAfterSeconds)) : null, w.note ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: "var(--ink-3)" } }, w.note) : null)), quota.credits?.lines?.length || quota.credits?.balance || Number.isFinite(Number(quota.credits?.prepaidBalance)) ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 5, flexWrap: "wrap" } }, (quota.credits?.lines || []).map((c, i) => /* @__PURE__ */ React.createElement(InfoPill, { key: i }, c.label, " ", c.total ?? c.used ?? 0)), quota.credits?.balance ? /* @__PURE__ */ React.createElement(InfoPill, null, "\u4F59\u989D ", quota.credits.balance) : null, Number.isFinite(Number(quota.credits?.prepaidBalance)) ? /* @__PURE__ */ React.createElement(InfoPill, null, "\u9884\u4ED8\u8D39 $", Number(quota.credits.prepaidBalance).toFixed(2)) : null) : null);
}
function QuotaInline({ quota, stats }) {
  if (!quota && !stats) return null;
  const wins = Array.isArray(quota?.windows) ? quota.windows : [];
  const c = quota?.credits;
  const hasBalance = Boolean(c && c.balance !== void 0 && c.balance !== null && c.balance !== "");
  const hasPrepaid = Number.isFinite(Number(c?.prepaidBalance));
  const hasLines = Boolean(c?.lines?.length);
  const chips = [];
  if (quota?.plan) chips.push({ key: "plan", node: /* @__PURE__ */ React.createElement(React.Fragment, null, "\u5957\u9910 ", quota.plan), tone: "indigo" });
  if (quota?.limitReached) chips.push({ key: "limit", node: /* @__PURE__ */ React.createElement(React.Fragment, null, "\u5DF2\u8FBE\u9650\u989D"), tone: "red" });
  if (hasLines) {
    c.lines.forEach((line, i) => {
      chips.push({
        key: `line${i}`,
        node: /* @__PURE__ */ React.createElement(React.Fragment, null, (line.label || "\u5305") + " ", line.total ?? line.used ?? 0),
        // 积分包剩 0 的标红（一眼看出哪个用完了）
        tone: Number(line.total) === 0 ? "red" : "gray"
      });
    });
  }
  if (hasBalance) chips.unshift({ key: "bal", node: /* @__PURE__ */ React.createElement(React.Fragment, null, "\u4F59\u989D ", c.balance, c.unit ? ` ${c.unit}` : "") });
  if (hasPrepaid) chips.push({ key: "pre", node: /* @__PURE__ */ React.createElement(React.Fragment, null, "\u9884\u4ED8\u8D39 $", Number(c.prepaidBalance).toFixed(2)) });
  const balanceChip = chips.find((x) => x.key === "bal") || null;
  const otherChips = chips.filter((x) => x.key !== "bal");
  const { shown: shownWins, collapsed: collapsedWins } = pickVisibleWindows(wins);
  const { shown: shownChips, overflow: chipsOverflow } = pickVisibleChips(otherChips, 3, shownWins.length);
  const scopes = [...new Set(wins.map((w) => String(w.scope || scopeFromLabel(w.label) || "").trim()).filter(Boolean))];
  const multiScope = scopes.length > 1;
  const st = stats || {};
  const hasStats = st.calls !== void 0 || st.tokens !== void 0 || st.cost !== void 0;
  if (!chips.length && !wins.length && !hasStats) return null;
  const collapsedTip = /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 220 } }, collapsedWins.map((w, i) => /* @__PURE__ */ React.createElement(WindowRow, { key: w.key || i, w, index: i + shownWins.length, showScope: multiScope })));
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 150 } }, hasStats ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", overflow: "hidden" } }, /* @__PURE__ */ React.createElement(StatTag, { icon: /* @__PURE__ */ React.createElement(ApiOutlined, null), title: `\u5F53\u524D\u6E20\u9053\u7D2F\u8BA1\u8C03\u7528 ${st.calls ?? 0} \u6B21` }, fmtCompact(st.calls ?? 0)), /* @__PURE__ */ React.createElement(StatTag, { icon: /* @__PURE__ */ React.createElement(DatabaseOutlined, null), title: `\u5F53\u524D\u6E20\u9053\u7D2F\u8BA1 token ${fmtFull(st.tokens ?? 0)}` }, fmtToken(st.tokens ?? 0)), /* @__PURE__ */ React.createElement(
    StatTag,
    {
      icon: st.costUnit === "credits" ? /* @__PURE__ */ React.createElement(ThunderboltOutlined, null) : /* @__PURE__ */ React.createElement(OdCoinIcon, null),
      title: `\u5F53\u524D\u6E20\u9053\u7D2F\u8BA1\u6D88\u8D39 ${st.costText || ""}`
    },
    st.costText || "0"
  )) : null, shownWins.length ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", overflow: "hidden" } }, shownWins.map((w, i) => /* @__PURE__ */ React.createElement(WindowRow, { key: w.key || i, w, index: i, showScope: multiScope, compact: true })), collapsedWins.length ? /* @__PURE__ */ React.createElement(Tooltip, { title: collapsedTip }, /* @__PURE__ */ React.createElement("span", { className: "bui-chip", style: { fontSize: 11, flexShrink: 0 } }, "+", collapsedWins.length)) : null) : null, balanceChip || shownChips.length || chipsOverflow > 0 ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", minWidth: 0 } }, balanceChip ? /* @__PURE__ */ React.createElement("span", { style: { minWidth: 0, flexShrink: 1, display: "inline-flex" } }, /* @__PURE__ */ React.createElement(InfoPill, { tone: balanceChip.tone }, balanceChip.node)) : null, shownChips.map((x) => /* @__PURE__ */ React.createElement("span", { key: x.key, style: { minWidth: 0, flexShrink: 1, display: "inline-flex" } }, /* @__PURE__ */ React.createElement(InfoPill, { tone: x.tone }, x.node))), chipsOverflow > 0 ? /* @__PURE__ */ React.createElement(
    Tooltip,
    {
      title: /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 180 } }, otherChips.slice(otherChips.length - chipsOverflow).map((x) => /* @__PURE__ */ React.createElement("div", { key: x.key }, x.node)))
    },
    /* @__PURE__ */ React.createElement("span", { className: "bui-chip", style: { fontSize: 11, flexShrink: 0 } }, "+", chipsOverflow)
  ) : null) : null);
}
function StatTag({ icon, children, title }) {
  return /* @__PURE__ */ React.createElement(Tooltip, { title }, /* @__PURE__ */ React.createElement(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 11.5,
        lineHeight: 1.5,
        color: "var(--ink-2)",
        background: "var(--inset)",
        borderRadius: 5,
        padding: "1px 6px",
        whiteSpace: "nowrap"
      }
    },
    /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", fontSize: 11, color: "var(--ink-3)" } }, icon),
    /* @__PURE__ */ React.createElement("span", { className: "oo-num" }, children)
  ));
}
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
function OdCoinIcon() {
  return /* @__PURE__ */ React.createElement("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "9" }), /* @__PURE__ */ React.createElement("path", { d: "M12 7v10M9 10h6", strokeLinecap: "round" }));
}
function QuotaPanel({ quota, loading, onRefresh, error }) {
  if (loading) return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: "var(--ink-3)" } }, "\u6B63\u5728\u67E5\u8BE2\u8D26\u53F7\u989D\u5EA6\u2026");
  if (error) return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: "var(--red)" } }, error);
  if (!quota) return /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: "var(--ink-3)" } }, "\u8BE5\u6E20\u9053\u6682\u65F6\u6CA1\u6709\u989D\u5EA6\u5FEB\u7167\u3002");
  const wins = Array.isArray(quota.windows) ? quota.windows : [];
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, quota.plan || quota.limitReached ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } }, quota.plan ? /* @__PURE__ */ React.createElement("span", { className: "bui-chip" }, "\u5957\u9910 ", quota.plan) : null, quota.limitReached ? /* @__PURE__ */ React.createElement("span", { className: "bui-chip bui-chip--orange" }, "\u5DF2\u8FBE\u9650\u989D") : null) : null, wins.length ? wins.map((w, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", flexDirection: "column", gap: 3 } }, /* @__PURE__ */ React.createElement(WindowRow, { w, index: i }), w.resetAt || w.resetAfterSeconds ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: "var(--ink-3)" } }, fmtReset(w.resetAt, w.resetAfterSeconds)) : null, w.note ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: "var(--ink-3)" } }, w.note) : null)) : /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: "var(--ink-3)" } }, "\u8BE5\u8D26\u53F7\u6CA1\u6709\u8FD4\u56DE\u989D\u5EA6\u7A97\u53E3\uFF0C\u53EA\u6709\u4F59\u989D\u4FE1\u606F\u3002"), quota.credits?.lines?.length ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 4 } }, quota.credits.lines.map((c, i) => /* @__PURE__ */ React.createElement("div", { key: i }, c.label, "\uFF1A\u4F59\u989D ", c.total ?? 0, c.toppedUp !== void 0 ? `\uFF08\u8D60\u9001 ${c.granted ?? 0} / \u5145\u503C ${c.toppedUp}\uFF09` : ""))) : null, quota.credits && quota.credits.balance ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12 } }, "\u4F59\u989D\uFF1A", quota.credits.balance) : null, onRefresh ? /* @__PURE__ */ React.createElement("button", { type: "button", className: "bui-btn", style: { alignSelf: "flex-start" }, onClick: onRefresh }, "\u91CD\u65B0\u67E5\u8BE2") : null);
}
export {
  InfoPill,
  MAX_INLINE_BARS,
  MAX_INLINE_CHIPS,
  QuotaInline,
  QuotaTip,
  QuotaPanel as default,
  isWindowSpent,
  parseWindowSeconds,
  pickVisibleChips,
  pickVisibleWindows,
  scopeOfWindow,
  windowSecondsOf
};
