// 账号额度小组件 —— 渠道列表 / 宫格卡片 / 详情共用
// ---------------------------------------------------------------------------
// 数据来自后端 /channel/:id/quota 的归一化快照（见 services/upstream/quota.js）：
//   windows[] 每个是一个「窗口」（5 小时 / 7 天 / Kiro 额度桶…），含 usedPercent 或 remaining
// 注意各厂商口径不同：多数给「已用比例」，Antigravity 给「剩余比例」（后端已换算成 usedPercent），
// ChatGPT 网页版只给剩余次数（没有总量）—— 组件按字段有无分别渲染，不做统一假设。
import React from "react";
import { Tooltip } from "antd";

/** 额度条颜色：<70% 正常、70~90% 警告、>90% 危险 */
function barColor(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "var(--accent)";
  if (p >= 90) return "var(--red)";
  if (p >= 70) return "var(--orange)";
  return "var(--green)";
}

function fmtReset(epochSeconds) {
  const s = Number(epochSeconds) || 0;
  if (!s) return "";
  const d = new Date(s * 1000);
  const diff = s * 1000 - Date.now();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const rel = diff <= 0 ? "已重置" : hours > 0 ? `${hours} 小时后重置` : `${mins} 分钟后重置`;
  return `${rel}（${d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}）`;
}

/** 单个窗口的进度条 */
function WindowBar({ w }) {
  const hasPct = Number.isFinite(Number(w.usedPercent));
  const pct = hasPct ? Math.max(0, Math.min(100, Number(w.usedPercent))) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--ink-3)", gap: 8 }}>
        <span className="oo-truncate" title={w.label}>{w.label}</span>
        <span className="oo-num" style={{ flexShrink: 0 }}>
          {hasPct
            ? `${pct}%`
            : Number.isFinite(Number(w.limit))
              ? `${w.used ?? 0} / ${w.limit}`
              : Number.isFinite(Number(w.remaining))
                ? `剩 ${w.remaining}`
                : "—"}
        </span>
      </div>
      {hasPct ? (
        <div style={{ height: 4, borderRadius: 2, background: "var(--inset)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: barColor(pct), borderRadius: 2 }} />
        </div>
      ) : null}
    </div>
  );
}

/** 内联（列表行）形态：只显示最紧的一个窗口；没有窗口时退回 credits 摘要 */
export function QuotaInline({ quota, size = 12 }) {
  if (!quota?.windows?.length) {
    // 有的厂商（Grok / DeepSeek API）只回余额、没有窗口：显示「余额」文字而不是空白
    const c = quota?.credits;
    const line = c?.lines?.[0];
    if (line) {
      return (
        <Tooltip title={<QuotaTip quota={quota} />}>
          <span style={{ fontSize: size, color: "var(--ink-3)" }} className="oo-num">
            余额 {line.total ?? 0}
          </span>
        </Tooltip>
      );
    }
    if (c && c.prepaidBalance !== null && c.prepaidBalance !== undefined) {
      return (
        <Tooltip title={<QuotaTip quota={quota} />}>
          <span style={{ fontSize: size, color: "var(--ink-3)" }} className="oo-num">
            ${Number(c.prepaidBalance).toFixed(2)}
          </span>
        </Tooltip>
      );
    }
    return null;
  }
  // 取「已用最多」的窗口作为代表（没有 usedPercent 的排后面）
  const sorted = [...quota.windows].sort((a, b) => {
    const av = Number.isFinite(Number(a.usedPercent)) ? Number(a.usedPercent) : -1;
    const bv = Number.isFinite(Number(b.usedPercent)) ? Number(b.usedPercent) : -1;
    return bv - av;
  });
  const top = sorted[0];
  const pct = Number.isFinite(Number(top.usedPercent)) ? Number(top.usedPercent) : null;
  return (
    <Tooltip title={<QuotaTip quota={quota} />}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: size }}>
        <span style={{ width: 46, height: 4, borderRadius: 2, background: "var(--inset)", overflow: "hidden", display: "inline-block" }}>
          {pct !== null ? <span style={{ display: "block", width: `${Math.min(100, pct)}%`, height: "100%", background: barColor(pct) }} /> : null}
        </span>
        <span className="oo-num" style={{ color: pct !== null ? barColor(pct) : "var(--ink-3)" }}>
          {pct !== null ? `${pct}%` : top.label || "额度"}
        </span>
      </span>
    </Tooltip>
  );
}

/** tooltip 内容：全部窗口 + 套餐 + 抓取时间 */
export function QuotaTip({ quota }) {
  if (!quota) return null;
  const lines = [];
  if (quota.plan) lines.push(`套餐：${quota.plan}`);
  if (quota.account) lines.push(`账号：${quota.account}`);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}>
      {lines.map((l) => (
        <div key={l} style={{ fontSize: 12 }}>{l}</div>
      ))}
      {(quota.windows || []).map((w, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <WindowBar w={w} />
          {w.resetAt ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtReset(w.resetAt)}</span> : null}
          {w.note ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{w.note}</span> : null}
        </div>
      ))}
      {quota.credits?.lines?.length
        ? quota.credits.lines.map((c, i) => (
            <div key={i} style={{ fontSize: 11.5 }}>
              {c.label}：{c.total ?? c.used ?? 0}
              {c.toppedUp !== undefined ? `（赠送 ${c.granted ?? 0} / 充值 ${c.toppedUp}）` : ""}
            </div>
          ))
        : null}
      {quota.extraUsage?.enabled ? (
        <div style={{ fontSize: 11.5 }}>
          额外用量：{quota.extraUsage.usedCredits} / {quota.extraUsage.monthlyLimit}
        </div>
      ) : null}
      {quota.limitReached ? <div style={{ fontSize: 11.5, color: "var(--red)" }}>已达限额</div> : null}
      {quota.fetchedAt ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          抓取于 {new Date(quota.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
        </div>
      ) : null}
    </div>
  );
}

/** 弹窗 / 详情块形态：完整展示所有窗口 */
export default function QuotaPanel({ quota, loading, onRefresh, error }) {
  if (loading) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>正在查询账号额度…</div>;
  if (error) return <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div>;
  if (!quota) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有额度快照，点「查额度」查询一次。</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {quota.windows?.length ? (
        quota.windows.map((w, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <WindowBar w={w} />
            {w.resetAt ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtReset(w.resetAt)}</span> : null}
            {w.note ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{w.note}</span> : null}
          </div>
        ))
      ) : (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>该账号没有返回额度窗口信息。</div>
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
      {quota.credits && quota.credits.prepaidBalance !== null && quota.credits.prepaidBalance !== undefined ? (
        <div style={{ fontSize: 12 }}>
          预付费余额：${Number(quota.credits.prepaidBalance).toFixed(2)}
          {quota.credits.onDemandCap ? ` · 按需上限 $${Number(quota.credits.onDemandCap).toFixed(2)}` : ""}
        </div>
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
