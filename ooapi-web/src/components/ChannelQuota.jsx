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

/** 用量分档配色 */
function barColor(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "var(--accent)";
  if (p >= 90) return "var(--red)";
  if (p >= 70) return "var(--orange)";
  return "var(--green)";
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

/** 单行窗口：`[5h] ▓▓▓▓▓░░░ 62%` */
function WindowRow({ w }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span
        style={{
          minWidth: 30,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-3)",
          background: "var(--inset)",
          borderRadius: 4,
          padding: "1px 4px",
          flexShrink: 0,
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
              minWidth: 40,
              height: 5,
              borderRadius: 3,
              background: "var(--inset)",
              overflow: "hidden",
              display: "inline-block",
            }}
          >
            <span style={{ display: "block", width: `${pct}%`, height: "100%", background: barColor(pct) }} />
          </span>
          <span
            className="oo-num"
            style={{ minWidth: 36, textAlign: "right", color: barColor(pct), fontWeight: 600, flexShrink: 0 }}
          >
            {pct >= 99.95 ? "100%" : `${Math.round(pct)}%`}
          </span>
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

/** 悬浮详情：套餐、账号、各窗口的重置时间、余额 */
export function QuotaTip({ quota }) {
  if (!quota) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200 }}>
      {quota.plan ? (
        <div style={{ fontSize: 12 }}>
          套餐：<b>{quota.plan}</b>
          {quota.limitReached ? <span style={{ color: "#ff7875", marginLeft: 6 }}>已达限额</span> : null}
        </div>
      ) : null}
      {quota.account ? <div style={{ fontSize: 12 }}>账号：{quota.account}</div> : null}
      {(quota.windows || []).map((w, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <WindowRow w={w} />
          {w.resetAt || w.resetAfterSeconds ? (
            <span style={{ fontSize: 11, color: "#aaa" }}>{fmtReset(w.resetAt, w.resetAfterSeconds)}</span>
          ) : null}
          {w.note ? <span style={{ fontSize: 11, color: "#aaa" }}>{w.note}</span> : null}
        </div>
      ))}
      {quota.credits?.lines?.length
        ? quota.credits.lines.map((c, i) => (
            <div key={i} style={{ fontSize: 11.5 }}>
              {c.label}：{c.total ?? c.used ?? 0}
            </div>
          ))
        : null}
      {quota.credits && quota.credits.balance ? (
        <div style={{ fontSize: 11.5 }}>余额：{quota.credits.balance}</div>
      ) : null}
      {quota.credits && Number.isFinite(Number(quota.credits.prepaidBalance)) ? (
        <div style={{ fontSize: 11.5 }}>预付费余额：${Number(quota.credits.prepaidBalance).toFixed(2)}</div>
      ) : null}
      {quota.fetchedAt ? (
        <div style={{ fontSize: 11, color: "#888" }}>
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
            <WindowRow key={i} w={w} />
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
            <WindowRow w={w} />
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
