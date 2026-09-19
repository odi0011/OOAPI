import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  Table, Space, Typography, Input, Popconfirm, Modal, Form, Select, Switch,
  InputNumber, App as AntApp, Tooltip, Row, Col, Alert, Radio, Button, Spin, Pagination, Segmented, Avatar,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, DeleteOutlined, EditOutlined,
  UndoOutlined, KeyOutlined, LoginOutlined, GlobalOutlined,
  InfoCircleOutlined, SafetyCertificateOutlined, AppstoreOutlined, UnorderedListOutlined, BarChartOutlined,
  ExclamationCircleOutlined, DashboardOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, CURRENCY_NAME, copyText } from "../services/format";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel } from "../components/VendorIcon";
import ModelPicker from "../components/ModelPicker";
import QuotaPanel, { QuotaInline } from "../components/ChannelQuota";

const { Text } = Typography;

// 网页版多轮 prompt 的角色标记（<｜User｜> / <｜Assistant｜> / <｜end▁of▁sentence｜>）：
// 只对上游有用，展示前剥掉（老记录里也存了这些标记，渲染时统一清理）。
const ROLE_TOKEN_RE = /<[｜|]\s*(?:User|Assistant|System)\s*[｜|]>|<[｜|]end[▁_\s]?of[▁_\s]?sentence[｜|]>/g;
const cleanSummary = (s) => String(s ?? "").replace(ROLE_TOKEN_RE, "").replace(/\s+/g, " ").trim();
// 用户名太长会把这一列撑开：只显示前两个字符 + …（完整名字放在悬浮提示里）
const shortUser = (n) => {
  const s = String(n || "用户");
  return s.length > 2 ? `${Array.from(s).slice(0, 2).join("")}…` : s;
};

// 小绿条悬浮 tip：时间/结果/耗时 + 本次的提示词与回复摘要
function UptimeTip({ c }) {
  const p = cleanSummary(c.p);
  const r = cleanSummary(c.r);
  return (
    <div className="oo-uptime-tip">
      <div className="oo-uptime-tip-head">
        {fmtDate(c.t, "MM-DD HH:mm")} · {c.ok ? "成功" : "失败"}
        {c.ms ? ` · ${c.ms}ms` : ""}
        {c.k === "auto" ? " · 定时检测" : c.k === "test" ? " · 手动测试" : c.k === "chat" ? " · 对话调用" : ""}
      </div>
      {p ? (
        <div className="oo-uptime-tip-row">
          <span className="oo-uptime-tip-label">提示词</span>
          <div className="oo-tip-snippet">{p}</div>
        </div>
      ) : null}
      {r ? (
        <div className="oo-uptime-tip-row">
          <span className="oo-uptime-tip-label">{c.ok ? "回复" : "错误"}</span>
          <div className="oo-tip-snippet">{r}</div>
        </div>
      ) : null}
      {c.d !== undefined || c.st !== undefined ? (
        <div className="oo-uptime-tip-row">
          <span className="oo-uptime-tip-label">降智状态</span>
          <div>
            <span style={{ color: c.d ? "var(--red)" : "var(--green)" }}>{c.d ? "是（命中降智/截断）" : "否"}</span>
            {c.st !== undefined ? <span style={{ opacity: 0.75 }}>{` · 292 通行证${c.st ? "已注入" : "未注入"}`}</span> : null}
          </div>
        </div>
      ) : null}
      {c.u ? (
        <div className="oo-uptime-tip-row">
          <span className="oo-uptime-tip-label">调用者</span>
          <div>
            {c.u.n || "用户"}
            {c.u.e ? <span style={{ opacity: 0.75 }}>{` · ${c.u.e}`}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 模型多选标签：左侧带厂商图标（编辑/新增渠道共用）
const modelTagRender = (vendor) => ({ label, closable, onClose }) => (
  <span className="bui-chip" style={{ marginInlineEnd: 4, display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 190 }}>
    <VendorIcon type={vendor} size={13} />
    <span className="oo-truncate">{label}</span>
    {closable ? (
      <span
        role="button"
        aria-label={`移除 ${label}`}
        onClick={onClose}
        style={{ cursor: "pointer", opacity: 0.55, paddingInline: 2 }}
      >
        ×
      </span>
    ) : null}
  </span>
);

// 下拉选项同样带厂商图标
const modelOptionRender = (vendor) => (opt) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <VendorIcon type={vendor} size={13} />
    {opt.label}
  </span>
);

// 最近调用记录：小竖条（绿=快 / 黄=慢 / 红=失败），悬浮显示提示词与 AI 回复。
// 样式参考 aceternity 的 uptime bars：只保留小竖条与 hover 放大效果。
const UPTIME_SLOW_MS = 3000; // 超过该耗时视为「慢」（黄色）

function UptimeBars({ calls = [], count = 20, onCopy }) {
  const list = (calls || []).slice(-count);
  const bars = Array.from({ length: count }, (_, i) => {
    const idx = i - (count - list.length);
    return idx >= 0 ? list[idx] : null;
  });
  if (!list.length) return <Text type="secondary" style={{ fontSize: 12 }}>暂无调用</Text>;
  return (
    <span className="oo-uptime" aria-label={`最近 ${list.length} 次调用`}>
      {bars.map((c, i) =>
        c ? (
          <Tooltip key={i} title={<UptimeTip c={c} />}>
            <i
              className={`oo-uptime-bar is-clickable ${!c.ok ? "is-fail" : c.ms >= UPTIME_SLOW_MS ? "is-slow" : "is-ok"}`}
              role="button"
              tabIndex={0}
              title="点击复制原始返回结果"
              onClick={() => onCopy?.(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onCopy?.(c);
                }
              }}
            />
          </Tooltip>
        ) : (
          <i key={i} className="oo-uptime-bar is-empty" />
        )
      )}
    </span>
  );
}

// 状态单元格
function StatusCell({ r }) {
  if (r.status === 3) {
    return (
      <Space direction="vertical" size={2}>
        <span className="bui-chip bui-chip--red">
          <span className="bui-dot bui-dot--err" />
          自动禁用
        </span>
        {r.last_error ? (
          <Tooltip title={r.last_error}>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{r.last_error.slice(0, 20)}…</span>
          </Tooltip>
        ) : null}
      </Space>
    );
  }
  if (r.status === 2) {
    return (
      <span className="bui-chip" style={{ background: "transparent", padding: 0 }}>
        <span className="bui-dot bui-dot--idle" />
        已禁用
      </span>
    );
  }
  if (r.cooling) {
    return (
      <Space direction="vertical" size={2}>
        <span className="bui-chip bui-chip--orange">
          <span className="bui-dot bui-dot--warn" />
          冷却中
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>至 {r.cooldown_text}</span>
      </Space>
    );
  }
  return (
    <span className="bui-chip" style={{ background: "transparent", padding: 0 }}>
      <span className="bui-dot bui-dot--ok" />
      已启用
    </span>
  );
}

// ============================================================================
// 用量统计弹窗的图表组件（统计卡 / Token 活动热力图 / 每日 Token 趋势）
// 全部用原生 div + SVG 实现，不引入图表库；颜色取自现有设计令牌。
// ============================================================================

// 折线图分类色（明亮/黑暗主题下都保持可辨识）
const SERIES_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ef4444",
  "#a855f7", "#06b6d4", "#ec4899", "#64748b",
];

// 数字紧凑格式：亿 / 万（统计卡与坐标轴用；详情 tooltip 用完整千分位）
function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
  return v.toLocaleString();
}

function fmtFull(n) {
  return (Number(n) || 0).toLocaleString();
}

// 连续使用天数：当前连续（今天没调用则从昨天往前算）/ 窗口内最长连续
function computeStreaks(byDay = []) {
  let longest = 0;
  let run = 0;
  for (const d of byDay) {
    if ((d.calls || 0) > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let i = byDay.length - 1;
  if (i >= 0 && (byDay[i].calls || 0) === 0) i -= 1;
  let current = 0;
  while (i >= 0 && (byDay[i].calls || 0) > 0) {
    current += 1;
    i -= 1;
  }
  return { current, longest };
}

function StatCard({ label, value, hint }) {
  return (
    <div className="oo-stat-card" title={hint || undefined}>
      <div className="oo-stat-card-num">{value}</div>
      <div className="oo-stat-card-label">{label}</div>
    </div>
  );
}

// 平滑折线路径（Catmull-Rom → 三次贝塞尔）
function smoothPath(rawPts) {
  if (!rawPts.length) return "";
  // 先统一转成数字：点可能来自 toFixed() 的字符串，字符串 + 数字会变成拼接
  const pts = rawPts.map((it) => [Number(it[0]), Number(it[1])]);
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/**
 * Token 活动热力图（GitHub 贡献图样式）：近 365 天，行为星期、列为周。
 * 三种口径：每日 / 每周（该周合计）/ 累计（截至当天）。
 */
function TokenActivity({ byDay = [] }) {
  const [mode, setMode] = useState("day");

  const view = useMemo(() => {
    if (!byDay.length) return { cells: [], months: [], cols: 0, hasData: false };
    const perDay = new Map();
    const weekSum = new Map();
    const cumMap = new Map();
    let cum = 0;
    for (const d of byDay) {
      const tokens = d.tokens || 0;
      perDay.set(d.day, { tokens, calls: d.calls || 0 });
      cum += tokens;
      cumMap.set(d.day, cum);
      const dt = new Date(`${d.day}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
      const wk = dt.toISOString().slice(0, 10);
      weekSum.set(wk, (weekSum.get(wk) || 0) + tokens);
    }
    const firstIso = byDay[0].day;
    const end = new Date(`${byDay[byDay.length - 1].day}T00:00:00Z`);
    const gridStart = new Date(end);
    gridStart.setUTCDate(gridStart.getUTCDate() - 364);
    gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());

    const cells = [];
    const months = [];
    let cur = new Date(gridStart);
    let i = 0;
    let prevMonth = -1;
    let max = 0;
    while (cur <= end) {
      const iso = cur.toISOString().slice(0, 10);
      const inRange = iso >= firstIso;
      const rec = perDay.get(iso);
      let value = 0;
      if (inRange) {
        if (mode === "day") value = rec?.tokens || 0;
        else if (mode === "week") {
          const wk = new Date(cur);
          wk.setUTCDate(wk.getUTCDate() - wk.getUTCDay());
          value = weekSum.get(wk.toISOString().slice(0, 10)) || 0;
        } else value = cumMap.get(iso) || 0;
      }
      if (value > max) max = value;
      if (i % 7 === 0) {
        const m = cur.getUTCMonth();
        if (m !== prevMonth) {
          months.push({ col: Math.floor(i / 7) + 1, label: `${m + 1}月` });
          prevMonth = m;
        }
      }
      cells.push({ i, iso, inRange, value, calls: rec?.calls || 0 });
      cur = new Date(cur);
      cur.setUTCDate(cur.getUTCDate() + 1);
      i += 1;
    }
    const withLevel = cells.map((c) => ({
      ...c,
      level: c.value > 0 && max > 0 ? Math.max(1, Math.ceil((c.value / max) * 4)) : 0,
    }));
    return { cells: withLevel, months, cols: Math.ceil(cells.length / 7), hasData: max > 0 };
  }, [byDay, mode]);

  const tip = (c) => {
    if (!c.inRange) return `${c.iso} · 无数据`;
    if (mode === "week") return `${c.iso} 所在周合计 · ${fmtFull(c.value)} tokens`;
    if (mode === "cum") return `截至 ${c.iso} 累计 · ${fmtFull(c.value)} tokens`;
    return `${c.iso} · ${fmtFull(c.value)} tokens · ${c.calls} 次调用`;
  };

  return (
    <div className="oo-stats-card">
      <div className="oo-stats-card-head">
        <div className="oo-stats-card-title">Token 活动</div>
        <Segmented
          className="oo-seg"
          size="small"
          value={mode}
          onChange={setMode}
          options={[
            { label: "每日", value: "day" },
            { label: "每周", value: "week" },
            { label: "累计", value: "cum" },
          ]}
        />
      </div>
      <div className="oo-heat-scroll">
        <div className="oo-heat-grid" style={{ gridTemplateColumns: `repeat(${view.cols}, 11px)` }}>
          {view.cells.map((c) => (
            <Tooltip key={c.i} title={tip(c)}>
              <i className={`oo-heat-cell${c.level ? ` lv${c.level}` : ""}`} style={{ opacity: c.inRange ? 1 : 0.45 }} />
            </Tooltip>
          ))}
        </div>
        <div className="oo-heat-months" style={{ gridTemplateColumns: `repeat(${view.cols}, 11px)` }}>
          {view.months.map((m) => (
            <span key={`${m.col}-${m.label}`} style={{ gridColumn: m.col, gridRow: 1 }}>{m.label}</span>
          ))}
        </div>
      </div>
      <div className="oo-heat-foot">
        <span>少</span>
        <span className="oo-heat-scale">
          <i className="oo-heat-cell" />
          <i className="oo-heat-cell lv1" />
          <i className="oo-heat-cell lv2" />
          <i className="oo-heat-cell lv3" />
          <i className="oo-heat-cell lv4" />
        </span>
        <span>多</span>
      </div>
      {!view.hasData ? <div className="oo-trend-empty">所选窗口内暂无 Token 消耗记录</div> : null}
    </div>
  );
}

/**
 * 每日 Token 趋势图：按模型多线（SVG 折线 + 悬浮十字线 + 明细 tooltip）。
 * 时间范围与顶部「时间范围」开关联动（7 / 30 / 90 天）。
 */
function TokenTrend({ byDay = [], series = [], range, onRangeChange }) {
  const n = Math.max(1, Math.min(range, byDay.length));
  const days = byDay.slice(-n);
  const W = 780;
  const H = 210;
  const PAD = { l: 46, r: 12, t: 12, b: 26 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const lines = useMemo(
    () =>
      series
        .map((s, i) => ({
          model: s.model,
          color: SERIES_COLORS[i % SERIES_COLORS.length],
          values: (s.values || []).slice(-n),
        }))
        .filter((s) => s.values.some((v) => v > 0)),
    [series, n]
  );

  const max = useMemo(() => {
    let m = 0;
    for (const s of lines) for (const v of s.values) if (v > m) m = v;
    return m || 1;
  }, [lines]);

  const x = (i) => PAD.l + (i * plotW) / Math.max(1, n - 1);
  const y = (v) => PAD.t + (1 - v / max) * plotH;

  const [hover, setHover] = useState(null);
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const xv = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((xv - PAD.l) / plotW) * Math.max(1, n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTickStep = Math.max(1, Math.ceil(n / 6));
  const hoverDay = hover !== null ? days[hover] : null;
  const hoverRows = hoverDay
    ? lines
        .map((s) => ({ model: s.model, color: s.color, v: s.values[hover] || 0 }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v)
    : [];

  return (
    <>
      <div className="oo-stats-card-head">
        <div className="oo-stats-card-title">时间范围</div>
        <Segmented
          className="oo-seg"
          size="small"
          value={range}
          onChange={onRangeChange}
          options={[
            { label: "近 7 日", value: 7 },
            { label: "近 30 日", value: 30 },
            { label: "近 90 日", value: 90 },
          ]}
        />
      </div>
      <div className="oo-stats-card">
        <div className="oo-stats-card-head">
          <div className="oo-stats-card-title">每日 Token 趋势图</div>
        </div>
        {!lines.length ? (
          <div className="oo-trend-empty">近 {n} 天暂无 Token 消耗记录（统计从功能上线后开始累计）</div>
        ) : (
          <>
            <div className="oo-trend-legend">
              {lines.map((s) => (
                <span className="oo-trend-legend-item" key={s.model}>
                  <i style={{ background: s.color }} />
                  <span className="oo-truncate">{s.model}</span>
                </span>
              ))}
            </div>
            <div className="oo-trend-wrap">
              {hoverDay && hoverRows.length ? (
                <div className="oo-trend-tip" style={{ left: `clamp(70px, ${(x(hover) / W) * 100}%, calc(100% - 70px))` }}>
                  <div className="oo-trend-tip-date">{hoverDay.day}</div>
                  {hoverRows.slice(0, 7).map((r) => (
                    <div className="oo-trend-tip-row" key={r.model}>
                      <i style={{ background: r.color }} />
                      <span className="oo-truncate" style={{ maxWidth: 150 }}>{r.model}</span>
                      <span>{fmtCompact(r.v)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width="100%"
                height={H}
                role="img"
                aria-label="每日 Token 趋势图"
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
              >
                {yTicks.map((f) => (
                  <g key={f}>
                    <line
                      x1={PAD.l} x2={W - PAD.r}
                      y1={PAD.t + (1 - f) * plotH} y2={PAD.t + (1 - f) * plotH}
                      stroke="var(--line-soft)" strokeDasharray={f === 0 ? "0" : "3 4"}
                    />
                    <text x={PAD.l - 8} y={PAD.t + (1 - f) * plotH + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-3)">
                      {fmtCompact(max * f)}
                    </text>
                  </g>
                ))}
                {days.map((d, i) =>
                  i % xTickStep === 0 || i === n - 1 ? (
                    <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--ink-3)">
                      {d.day.slice(5)}
                    </text>
                  ) : null
                )}
                {lines.map((s) => (
                  <path
                    key={s.model}
                    d={smoothPath(s.values.map((v, i) => [x(i).toFixed(2), y(v).toFixed(2)]))}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                ))}
                {hover !== null ? (
                  <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--line-strong)" strokeDasharray="3 3" />
                ) : null}
                {hover !== null
                  ? lines.map((s) => (
                      <circle key={s.model} cx={x(hover)} cy={y(s.values[hover] || 0)} r="3" fill="var(--surface)" stroke={s.color} strokeWidth="1.6" />
                    ))
                  : null}
              </svg>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * 厂商选择：一行一个厂商卡片（图标 + 名称 + 支持的接入方式）。
 * 刻意不做分类。厂商就是厂商，接入方式是它内部的属性，
 * 拆成「反代渠道 / API 渠道」两栏只会让同一个厂商出现两次。
 */
function ProviderPicker({ providers, activeKey, onPick }) {

  return (
    <div className="oo-provider-picker">
      {providers.map((p) => {
        const active = activeKey === p.key;
        return (
          <div
            key={p.key}
            className={`oo-provider-picker__item${active ? " is-active" : ""}`}
            onClick={() => onPick(p)}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={`选择厂商 ${p.name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(p);
              }
            }}
          >
            <VendorIcon type={p.vendor} size={22} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 550, color: "var(--ink)" }}>{p.name}</div>
              <div className="oo-truncate" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{p.desc}</div>
            </div>
            {active ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function AdminChannelsPage() {
  const { message } = AntApp.useApp();

  const [items, setItems] = useState([]);
  const [providers, setProviders] = useState([]);
  const [stats, setStats] = useState(null);
  const [groups, setGroups] = useState([]); // 结构化分组：[{id,type,typeName,name,count}]
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [providersError, setProvidersError] = useState("");
  const [statsError, setStatsError] = useState("");
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [testingId, setTestingId] = useState(null);
  // 批量检测：正在并发测试的渠道 id 集合 + 批次进行中标记（防重复点击）
  const [testingIds, setTestingIds] = useState(() => new Set());
  const [batchTesting, setBatchTesting] = useState(false);
  // 批量写操作（启用/禁用/修改/删除）的防重入：这些操作一次影响几十个渠道，连点会重复提交
  const [batchBusy, setBatchBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState(null);
  // 用量统计弹窗
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsTarget, setStatsTarget] = useState(null);
  const [statsData, setStatsData] = useState(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [trendRange, setTrendRange] = useState(30);
  // 列表 / 宫格两种形态（记住偏好；宫格有自己的分页）
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem("ooapi-channels-view") === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const [gridPage, setGridPage] = useState(1);
  const toggleView = () =>
    setViewMode((m) => {
      const next = m === "grid" ? "list" : "grid";
      try {
        localStorage.setItem("ooapi-channels-view", next);
      } catch {
        /* ignore */
      }
      return next;
    });

  // 某厂商可选的分组（管理员在「分组管理」创建；不选 = 不绑定）
  const groupNamesOf = (type) => groups.filter((g) => !type || g.type === type).map((g) => g.name);

  const groupSelectOptions = (type) =>
    groupNamesOf(type).map((g) => ({ value: g, label: g }));

  // ---------- 用量统计 ----------
  // 最近调用：点小绿条复制「原始返回结果」；点用户标签复制邮箱
  const copyCallResult = (c) => {
    const text = String(c?.r || c?.p || "").trim();
    if (!text) return message.warning("这条记录没有可复制的返回内容");
    copyText(text)
      .then(() => message.success("已复制返回结果"))
      .catch(() => message.error("复制失败，请手动复制"));
  };
  const copyUserContact = (u) => {
    const text = String(u?.e || u?.n || "").trim();
    if (!text) return message.warning("这条记录没有可复制的联系方式");
    copyText(text)
      .then(() => message.success(u?.e ? `已复制邮箱：${u.e}` : "已复制用户名"))
      .catch(() => message.error("复制失败，请手动复制"));
  };

  const openStats = async (r) => {
    setStatsTarget(r);
    setStatsData(null);
    setStatsOpen(true);
    setStatsBusy(true);
    try {
      // 热力图 / 趋势图共用一份 365 天数据，切「近 7 / 30 / 90 日」在前端切片
      const d = await API.get(`/channel/${r.id}/stats`, { params: { days: 365 } });
      setStatsData(d);
    } catch (e) {
      message.error(e.message);
    } finally {
      setStatsBusy(false);
    }
  };

  const [keyword, setKeyword] = useState("");
  const [filterProvider, setFilterProvider] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  // 批量导入（CPA / sub2api 凭据文件）
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // 添加流程：先选厂商，再选该厂商的接入方式
  const [pickProvider, setPickProvider] = useState(null);
  const [pickMethod, setPickMethod] = useState(null);
  const [addMode, setAddMode] = useState("password");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTarget, setBrowserTarget] = useState(null);
  const [browserShot, setBrowserShot] = useState(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  // 浏览器登录类：添加表单里已完成「浏览器登录」（GLM/豆包/通义）：profile 存在服务器临时目录，
  // 提交时按 profileId 复制给渠道（每次登录一个独立目录，避免并发/复用串号）
  const [onboardReady, setOnboardReady] = useState(false);
  const [onboardProfile, setOnboardProfile] = useState("");
  // 凭据找回（401/登录态失效后重新登录）：能力由后端算（/channel/:id/recovery），
  // 前端只负责把对应流程跑起来 —— 浏览器授权、网页版会话抓取、设备码、粘贴凭据都在这里。
  const [reloginTarget, setReloginTarget] = useState(null);
  const [reloginInfo, setReloginInfo] = useState(null);
  const [reloginText, setReloginText] = useState("");
  const [reloginAccount, setReloginAccount] = useState("");
  const [reloginPassword, setReloginPassword] = useState("");
  const [reloginMode, setReloginMode] = useState("");
  const [reloginBusy, setReloginBusy] = useState(false);
  const [reloginDevice, setReloginDevice] = useState(null);
  const reloginTimerRef = useRef(null);
  // 找回指向的渠道 id：抓取界面成功后直接写回该渠道（而不是回填「添加渠道」表单）
  const reloginIdRef = useRef(0);
  // 登录态远程抓取（粘贴登录态的厂商：打开登录页 → 登录 → 自动回填 token/cookies）
  const [capOpen, setCapOpen] = useState(false);
  const [capSid, setCapSid] = useState("");
  const [capShot, setCapShot] = useState(null);
  const [capBusy, setCapBusy] = useState(false);
  // 订阅 OAuth 交互式登录：oauthUrl 有值表示「已发起登录，等待用户粘贴回调地址」
  const [oauthSupported, setOauthSupported] = useState(false);
  // 设备码登录（Grok/xAI）：返回 user_code 并在任意浏览器完成授权
  const [oauthDevice, setOauthDevice] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const deviceTimerRef = useRef(null);
  const autoCapRef = useRef(false);
  const autoFailRef = useRef(0);
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthState, setOauthState] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [capCands, setCapCands] = useState(null);
  const [capPick, setCapPick] = useState("");
  const [capText, setCapText] = useState("");
  // noVNC 实时浏览器：可用时弹窗内直接嵌服务器浏览器画面（截图模式作为兜底）
  const [vncInfo, setVncInfo] = useState(null);
  const [vncOff, setVncOff] = useState(false);
  const capImgRef = useRef(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [batchForm] = Form.useForm();
  // 定时检测开关（关闭时禁用间隔与提示词输入）
  const editAutoTestOn = Form.useWatch("auto_test", editForm);
  // 检测模型下拉：用当前渠道声明的模型列表
  const editModels = Form.useWatch("models", editForm);
  const { begin, isLatest } = useLatest();

  const load = useCallback(async ({ silent = false } = {}) => {
    const token = begin();
    // silent：轮询刷新时不要闪表格 loading，也不要清错误提示
    if (!silent) {
      setLoading(true);
      setLoadError("");
      setProvidersError("");
      setStatsError("");
    }
    try {
      // allSettled：某一个接口失败（如 stats 表未建好）不应让整页停在旧数据
      const [list, st, ps, gs] = await Promise.allSettled([
        API.get("/channel/", { params: { keyword, type: filterProvider } }),
        API.get("/channel/stats"),
        API.get("/channel/providers"),
        API.get("/channel/groups"),
      ]);
      if (!isLatest(token)) return;
      if (list.status === "fulfilled") setItems(list.value);
      else setLoadError(list.reason?.message || "渠道列表加载失败");
      if (st.status === "fulfilled") setStats(st.value);
      else setStatsError(st.reason?.message || "渠道统计加载失败");
      if (ps.status === "fulfilled") setProviders(ps.value);
      else setProvidersError(ps.reason?.message || "厂商列表加载失败");
      if (gs.status === "fulfilled") setGroups(Array.isArray(gs.value) ? gs.value : []);
      const failed = [list, st, ps, gs].find((r) => r.status === "rejected");
      if (failed) message.error(failed.reason?.message || "部分数据加载失败");
    } catch (e) {
      if (isLatest(token)) message.error(e.message);
    } finally {
      if (isLatest(token) && !silent) setLoading(false);
    }
  }, [keyword, filterProvider, message, begin, isLatest]);

  // 定时检测会在后台不断写入新记录：静默轮询刷新列表（页面不可见时跳过），
  // 这样小绿条会自己长出来，不需要手动刷新。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) load({ silent: true });
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  // 探测 noVNC 是否可用（只查一次；不可用时全部走原来的截图模式）
  useEffect(() => {
    API.get("/channel/vnc/info")
      .then((r) => setVncInfo(r || { enabled: false }))
      .catch(() => setVncInfo({ enabled: false }));
  }, []);

  const useVnc = Boolean(vncInfo?.enabled) && !vncOff && !capCands;

  // 切换筛选/搜索时清空已选：否则批量操作会作用到当前不可见的渠道
  useEffect(() => {
    setSelectedKeys([]);
    setGridPage(1);
  }, [keyword, filterProvider]);

  const visibleItems = items;

  // 把厂商支持的凭据摊平成「一个选择」，而不是嵌套两层单选。
  // 用户的心智是「我怎么证明身份」：账号密码、粘贴登录态、还是 API Key。
  const credOptions = useMemo(() => {
    if (!pickProvider) return [];
    const out = [];
    for (const m of pickProvider.methods) {
      if (m.key === "api") {
        out.push({ id: "api", method: "api", mode: null, label: "API Key" });
      } else {
        for (const lm of m.loginModes || []) {
          out.push({
            // id 必须带 method 前缀：同一厂商出现多个 paste 方式时不能撞车
            id: `${m.key}:${lm}`,
            method: m.key, // relay / codex / claude-oauth / antigravity
            mode: lm,
            label: m.oauth
              ? "粘贴凭据"
              : lm === "password"
                ? "账号密码"
                : lm === "paste"
                  ? "粘贴登录态"
                  : "浏览器登录",
          });
        }
      }
    }
    return out;
  }, [pickProvider]);

  const isApi = pickMethod?.key === "api";
  // 非 API 的接入方式（relay 反代 / 订阅 OAuth）走同一套「凭据登录」提交流程
  const isRelay = Boolean(pickMethod) && !isApi;

  // 当前选中的凭据项（注意：必须放在 isApi 声明之后，否则 const 的暂时性死区会直接白屏）
  const credId = isApi ? "api" : pickMethod ? `${pickMethod.key}:${addMode}` : "";

  // ---------- 添加 ----------
  const openAdd = () => {
    setPickProvider(null);
    setPickMethod(null);
    setAddMode("password");
    setOnboardReady(false);
    setOnboardProfile("");
    setOauthUrl("");
    setOauthState("");
    addForm.resetFields();
    setAddOpen(true);
  };

  const chooseProvider = (p) => {
    setPickProvider(p);
    const mKey = p.defaultMethod || p.methods[0].key;
    applyMethod(p, p.methods.find((m) => m.key === mKey));
  };

  const applyMethod = (p, m, forceMode = null) => {
    if (!m) return;
    setPickMethod(m);
    // 换厂商/换凭据方式时清掉上一轮的登录态标记，避免把 A 的登录结果带给 B
    setOnboardReady(false);
    setOnboardProfile("");
    setOauthUrl("");
    setOauthState("");
    const mode = forceMode || (m.loginModes && m.loginModes[0]) || "apikey";
    setAddMode(mode);
    const init = {
      name: p.name,
      base_url: m.baseUrl || "",
      api_key: "",
      // 模型范围留空 = 该厂商全部模型：不在新建时预填「推荐模型」，
      // 否则新模型上线后还得逐个渠道补，漏了就等于该渠道不能服务该模型。
      models: [],
      priority: 0,
      // 非 API 方式（反代/订阅）后端会把 <=0 的权重归一到 1，表单默认值保持一致
      weight: m.key === "api" ? 0 : 1,
      groups: [],
      auto_ban: true,
    };
    for (const f of m.loginFields || []) {
      if (f.default !== undefined) init[f.key] = f.default;
    }
    addForm.resetFields();
    addForm.setFieldsValue(init);
  };

  const submitAdd = async () => {
    if (!pickProvider || !pickMethod) return message.warning("请先选择厂商与接入方式");
    if (addSubmitting) return; // 防重入：登录/创建耗时，双击会建出两条渠道
    let v;
    try {
      v = await addForm.validateFields();
    } catch {
      return; // 校验未通过：antd 已在表单上标红
    }

    setAddSubmitting(true);
    try {
      if (isRelay) {
        // relay 也要提交这些字段：后端 /channel/login 已支持落库（此前被丢弃，编辑无效）
        const payload = {
          type: pickProvider.key,
          method: pickMethod.key, // relay / codex / claude-oauth / antigravity
          mode: addMode,
          name: v.name,
          priority: v.priority,
          models: v.models,
          groups: Array.isArray(v.groups) ? v.groups : [],
          weight: v.weight,
          auto_ban: v.auto_ban,
        };
        if (addMode === "password") {
          payload.account = v.account;
          payload.password = v.password;
          payload.areaCode = v.areaCode || "+86";
        } else if (addMode === "paste") {
          // 已发起交互式登录（oauthUrl 有值）时，粘贴的是回调地址 → 走换 token 接口，
          // 一步完成「换令牌 + 建渠道」，管理员不用再手抄凭据 JSON。
          if (pickMethod.oauth && oauthUrl) {
            if (!String(v.token || "").trim()) throw new Error("请粘贴登录后地址栏里的完整 URL");
            const r = await API.post(
              "/channel/oauth/exchange",
              {
                type: pickProvider.key,
                method: pickMethod.key,
                name: v.name,
                priority: v.priority,
                state: oauthState,
                callback: v.token,
              },
              { timeoutMs: 90_000 }
            );
            message.success(`渠道「${r.name}」已添加${r.account ? `（${r.account}）` : ""}`);
            setAddOpen(false);
            setOauthUrl("");
            setOauthState("");
            await load();
            return;
          }
          // 订阅渠道允许三种输入：凭据 JSON / 手动填 RT+AT / 导入文件（文件也会填到 token）
          let token = String(v.token || "").trim();
          if (pickMethod.oauth && !token) {
            const at = String(v.access_token || "").trim();
            const rt = String(v.refresh_token || "").trim();
            if (at || rt) token = JSON.stringify({ access_token: at, refresh_token: rt });
          }
          if (pickMethod.oauth && !token) {
            throw new Error("请粘贴凭据 JSON、填写 Access/Refresh Token，或导入凭据文件");
          }
          payload.token = token;
          payload.cookies = v.cookies;
        } else if (addMode === "browser") {
          // 在表单里已通过 onboarding 完成浏览器登录：带上临时 profile id，后端复制给新渠道
          if (onboardReady && onboardProfile) payload.profileFrom = onboardProfile;
        }
        const r = await API.post("/channel/login", payload, { timeoutMs: 90_000 });
        message.success(`渠道「${r.name}」已添加`);
      } else {
        await API.post("/channel/", {
          name: v.name,
          type: pickProvider.key,
          method: "api",
          base_url: v.base_url,
          api_key: v.api_key,
          models: v.models,
          groups: Array.isArray(v.groups) ? v.groups : [],
          priority: v.priority,
          weight: v.weight,
          auto_ban: v.auto_ban,
        });
        message.success(`渠道「${v.name}」已创建`);
      }
      setAddOpen(false);
      await load();
    } catch (e) {
      // 浏览器登录类：渠道已入库但还没登录，引导管理员去完成人工登录
      if (pickMethod.needsBrowser && /已创建/.test(e.message || "")) {
        setAddOpen(false);
        await load();
        message.warning("渠道已创建，请在列表点「浏览器登录」完成登录");
        return;
      }
      message.error(e.message);
    } finally {
      setAddSubmitting(false);
    }
  };

  // ---------- 批量导入（CPA / sub2api） ----------
  const openImport = () => {
    setImportText("");
    setImportResult(null);
    setImportOpen(true);
  };
  const readImportFile = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    // 支持多选/目录一次导入：每个文件的文本按行拼接，后端按多个 JSON 对象逐个解析
    const chunks = [];
    for (const file of files) {
      if (file.size > 2 * 1024 * 1024) {
        message.warning(`${file.name} 超过 2MB，已跳过`);
        continue;
      }
      try {
        chunks.push(await file.text());
      } catch {
        message.warning(`${file.name} 读取失败，已跳过`);
      }
    }
    if (!chunks.length) return;
    setImportText((prev) => [prev, ...chunks].filter((s) => String(s || "").trim()).join("\n"));
  };
  const submitImport = async () => {
    if (importBusy) return;
    if (!importText.trim()) return message.warning("请粘贴或选择要导入的 JSON 文件");
    setImportBusy(true);
    try {
      const r = await API.post("/channel/import", { text: importText });
      setImportResult(r);
      const bad = (r?.results || []).filter((x) => !x.ok && !x.skipped).length + (r?.parseErrors || []).length;
      if (bad) message.warning(`导入完成：成功 ${r?.created ?? 0}，跳过 ${r?.skipped ?? 0}，失败 ${bad}`);
      else message.success(`导入完成：成功 ${r?.created ?? 0}，跳过 ${r?.skipped ?? 0}`);
      load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setImportBusy(false);
    }
  };

  // ---------- 编辑 ----------
  const openEdit = (r) => {
    setEditing(r);
    // resetFields：清掉上一次编辑残留（尤其 API Key），避免把 A 渠道的 Key 写进 B 渠道
    editForm.resetFields();
    editForm.setFieldsValue({
      name: r.name,
      base_url: r.base_url,
      api_key: "",
      models: r.models,
        groups: Array.isArray(r.groups) ? r.groups : r.group_name ? [r.group_name] : [],
      priority: r.priority,
      weight: r.weight,
      remark: r.remark,
      auto_ban: r.auto_ban !== false,
      status: r.status === 1,
      // 定时检测（间隔以分钟展示，提交时换算成秒；检测模型留空=渠道第一个模型）
      auto_test: r.auto_test === true,
      auto_test_minutes: Math.max(1, Math.round((Number(r.auto_test_interval) || 3600) / 60)),
      test_model: r.test_model || undefined,
      test_prompt: r.test_prompt || "hi",
      // 账号级运行参数
      concurrency: Number(r.concurrency) || 1,
      min_gap_ms: Number(r.min_gap_ms) || 0,
      max_per_min: Number(r.max_per_min) || 0,
      fingerprint_mode: r.fingerprint_mode || "stable",
      context_billing: r.context_billing || "auto",
      namespace: r.namespace || "",
    });
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (editSubmitting) return; // 防重入
    let v;
    try {
      v = await editForm.validateFields();
    } catch {
      return;
    }
    setEditSubmitting(true);
    try {
      const payload = {
        id: editing.id,
        name: v.name,
        models: v.models,
        groups: Array.isArray(v.groups) ? v.groups : [],
        priority: v.priority,
        weight: v.weight,
        remark: v.remark,
        auto_ban: v.auto_ban,
        // 定时检测与检测提示词
        auto_test: v.auto_test === true,
        auto_test_interval: Math.max(60, Math.round(Number(v.auto_test_minutes || 60) * 60)),
        test_model: String(v.test_model || "").trim(),
        test_prompt: String(v.test_prompt || "hi").trim() || "hi",
        // 账号级参数（并发/限速/指纹/计费口径）
        concurrency: Number(v.concurrency) || 0,
        min_gap_ms: Number(v.min_gap_ms) || 0,
        max_per_min: Number(v.max_per_min) || 0,
        fingerprint_mode: v.fingerprint_mode || "stable",
        context_billing: v.context_billing || "auto",
        namespace: String(v.namespace || "").trim(),
      };
      // 只有 API 渠道有 Base URL（反代/订阅不展示也不提交，避免把空串写回）
      if (editing.method === "api") payload.base_url = v.base_url;
      // status 只在开关真正变化时提交：服务端收到 status 会清冷却/重置运行状态，
      // 只改备注不该顺手把「冷却中」的渠道重置。
      const nextStatus = v.status ? 1 : 2;
      if (nextStatus !== editing.status) payload.status = nextStatus;
      if (editing.method === "api" && v.api_key) payload.api_key = v.api_key;
      await API.put("/channel/", payload);
      message.success("已保存");
      setEditOpen(false);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setEditSubmitting(false);
    }
  };

  // ---------- 操作 ----------
  const doTest = async (r) => {
    if (testingId || batchTesting) return; // 防并发：单值状态被覆盖会让前一个按钮提前恢复可点；批量检测中也不允许单测
    setTestingId(r.id);
    try {
      // 订阅渠道 verify 内部可能先刷新 token，服务端超时 60s；前端必须留足余量
      const res = await API.post(`/channel/${r.id}/test`, undefined, { timeoutMs: 90_000 });
      if (res?.success) message.success(`「${r.name}」可用（${res.time}ms）`);
      else message.warning(res?.message || "测试失败");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setTestingId(null);
    }
  };

  const doReset = async (r) => {
    if (actionBusyId) return;
    setActionBusyId(r.id);
    try {
      await API.post("/channel/batch", { ids: [r.id], action: "enable" });
      message.success("已恢复");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const openBrowser = async (r) => {
    setBrowserTarget(r);
    setBrowserShot(null);
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${r.id}/browser/open`);
      setBrowserShot(res);
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  const refreshShot = async () => {
    if (!browserTarget) return;
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${browserTarget.id}/browser/open`);
      setBrowserShot(res);
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  const confirmBrowserReady = async () => {
    if (!browserTarget) return;
    setBrowserBusy(true);
    try {
      const res = await API.post(`/channel/${browserTarget.id}/browser/check`);
      if (res?.success) {
        message.success(`「${browserTarget.name}」登录就绪，渠道可用`);
        setBrowserOpen(false);
        await load();
      } else {
        message.warning(res?.message || "尚未就绪，请先完成登录");
      }
    } catch (e) {
      message.error(e.message);
    } finally {
      setBrowserBusy(false);
    }
  };

  // ---------- 登录态远程抓取 ----------
  // 选到订阅 OAuth 方式时问一下后端：这个厂商支不支持交互式登录（gemini 支持，codex/claude 目前只能粘贴凭据）
  useEffect(() => {
    const type = pickProvider?.key;
    const isOauth = Boolean(pickMethod?.oauth);
    setOauthUrl("");
    setOauthState("");
    if (!type || !isOauth) {
      setOauthSupported(false);
      setOauthDevice(false);
      setDeviceInfo(null);
      if (deviceTimerRef.current) {
        clearInterval(deviceTimerRef.current);
        deviceTimerRef.current = null;
      }
      return undefined;
    }
    let alive = true;
    API.get("/channel/oauth/info", { params: { type } })
      .then((r) => {
        if (alive) {
          setOauthSupported(Boolean(r?.supported));
          setOauthDevice(Boolean(r?.device));
        }
      })
      .catch(() => {
        if (alive) {
          setOauthSupported(false); // 查询失败就退化成「粘贴凭据」，不挡流程
          setOauthDevice(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickProvider?.key, pickMethod?.oauth]);

  const startOAuth = async () => {
    const type = pickProvider?.key;
    if (!type) return;
    setOauthBusy(true);
    try {
      const r = await API.post("/channel/oauth/start", { type });
      setOauthUrl(r.url);
      setOauthState(r.state || "");
      // 新窗口打开授权页（被拦截时页面上还有可点的链接兜底）
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      // 未配置 OAuth 客户端等：说清怎么解决，而不是只丢报错
      message.error(e.message || "发起登录失败");
    } finally {
      setOauthBusy(false);
    }
  };

  const startDevice = async () => {
    setOauthBusy(true);
    try {
      const r = await API.post("/channel/oauth/device/start", { type: pickProvider.key });
      setDeviceInfo(r);
      const target = r.verification_uri_complete || r.verification_uri;
      if (target) window.open(target, "_blank", "noopener");
      if (deviceTimerRef.current) clearInterval(deviceTimerRef.current);
      const iv = Math.max(3, Number(r.interval) || 5) * 1000;
      const deadline = Date.now() + Math.min(900, Number(r.expires_in) || 900) * 1000;
      deviceTimerRef.current = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(deviceTimerRef.current);
          deviceTimerRef.current = null;
          setDeviceInfo((d) => (d ? { ...d, error: "已超时，请重新发起" } : d));
          return;
        }
        try {
          const p = await API.post("/channel/oauth/device/poll", { type: pickProvider.key, device_code: r.device_code });
          if (p.pending) return;
          clearInterval(deviceTimerRef.current);
          deviceTimerRef.current = null;
          addForm.setFieldsValue({ token: p.credential });
          message.success(`设备授权成功${p.accountLabel ? `（${p.accountLabel}）` : ""}，凭据已填入，点「添加」即可`);
          setDeviceInfo(null);
        } catch (e) {
          clearInterval(deviceTimerRef.current);
          deviceTimerRef.current = null;
          setDeviceInfo((d) => (d ? { ...d, error: e.message } : d));
        }
      }, iv);
    } catch (e) {
      message.error(e.message);
    } finally {
      setOauthBusy(false);
    }
  };

  const startCapture = async () => {
    if (!pickProvider) return;
    setCapCands(null);
    setCapPick("");
    setCapText("");
    setCapShot(null);
    setCapBusy(true);
    try {
      const res = await API.post(
        "/channel/capture/start",
        { type: pickProvider.key, method: pickMethod?.key || "relay" },
        { timeoutMs: 90_000 } // 服务端要启动浏览器并等首个页面加载，默认 30s 不够
      );
      // 浏览器登录类：重新登录时先清掉旧的「已登录」标记
      if (res.kind === "browser") {
        setOnboardReady(false);
        setOnboardProfile(res.profileId || "");
      } else {
        setOnboardProfile("");
      }
      autoCapRef.current = false;
      autoFailRef.current = 0;
      setCapSid(res.sid);
      setCapShot({ dataUrl: res.dataUrl, url: res.url, hint: res.hint, kind: res.kind, redirectUri: res.redirectUri || "" });
      setCapOpen(true);
    } catch (e) {
      message.error(e.message);
    } finally {
      setCapBusy(false);
    }
  };

  // 未抓取完成前每 4 秒刷新一次截图（登录过程可见；二维码也能跟着刷新）。
  // noVNC 模式下有实时画面，不需要截图轮询。
  useEffect(() => {
    if (!capOpen || !capSid || capCands || useVnc) return undefined;
    const timer = setInterval(async () => {
      try {
        const res = await API.get(`/channel/capture/${capSid}/shot`);
        setCapShot((old) => ({ ...old, dataUrl: res.dataUrl, url: res.url }));
      } catch {
        /* 会话过期时由用户重新打开，无需打断 */
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [capOpen, capSid, capCands, useVnc]);

  // OAuth 回调自动检测：服务器浏览器跳到 localhost 回调页（连接被拒）时，
  // 轮询当前 URL 一旦命中回调地址就自动换取凭据并填入表单，管理员不用再点按钮。
  useEffect(() => {
    if (!capOpen || !capSid || capCands) return undefined;
    if (capShot?.kind !== "oauth" || !capShot?.redirectUri) return undefined;
    const timer = setInterval(async () => {
      if (autoCapRef.current) return;
      if (autoFailRef.current >= 3) return; // 连续失败就不再自动重试，留给手动按钮
      try {
        const r = await API.get(`/channel/capture/${capSid}/url`);
        const url = String(r?.url || "");
        if (!url.startsWith(capShot.redirectUri) || !/[?&]code=/.test(url)) return;
        autoCapRef.current = true;
        const res = await API.post(`/channel/capture/${capSid}/capture`, undefined, { timeoutMs: 90_000 });
        const val = res?.tokens?.[0]?.value || res?.credential || "";
        if (res?.oauth && val) {
          autoFailRef.current = 0;
          addForm.setFieldsValue({ token: val });
          message.success(`已检测到授权完成，凭据自动填入${res.accountLabel ? `（${res.accountLabel}）` : ""}，请点「添加」`);
          closeCapture(true);
        }
      } catch {
        // 回调到达但换取失败（如授权码已被用过）：限次后停止，提示手动重试
        autoFailRef.current += 1;
        if (autoFailRef.current === 3) {
          message.warning("自动换取凭据失败，请点「完成授权，抓取凭据」重试，或重新登录");
        }
      } finally {
        autoCapRef.current = false;
      }
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capOpen, capSid, capCands, capShot?.kind, capShot?.redirectUri]);

  // 卸载时清掉设备码轮询
  useEffect(
    () => () => {
      if (deviceTimerRef.current) clearInterval(deviceTimerRef.current);
    },
    []
  );

  const capAct = async (op) => {
    if (!capSid) return;
    try {
      const res = await API.post(`/channel/capture/${capSid}/act`, op);
      setCapShot((old) => ({ ...old, dataUrl: res.dataUrl, url: res.url }));
    } catch (e) {
      message.error(e.message);
    }
  };

  // 截图按原始分辨率换算坐标：页面显示宽度 ≠ 真实视口宽度
  const onCapShotClick = (e) => {
    const img = capImgRef.current;
    if (!img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width));
    const y = Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height));
    capAct({ action: "click", x, y });
  };

  const finishCapture = async () => {
    if (!capSid) return;
    setCapBusy(true);
    try {
      const res = await API.post(`/channel/capture/${capSid}/capture`, undefined, { timeoutMs: 90_000 });
      // 找回流程：服务端已把凭据/登录态写回该渠道，这里只需刷新列表
      if (res.updated) {
        reloginIdRef.current = 0;
        message.success(`凭据已写回${res.accountLabel ? `（${res.accountLabel}）` : ""}，渠道已恢复`);
        closeCapture(true);
        await load();
        return;
      }
      // 浏览器登录类：登录态在服务器 profile 里，提交时复制给渠道
      if (res.browserReady) {
        setOnboardReady(true);
        message.success("浏览器登录已完成，点「添加」保存渠道");
        closeCapture(true);
        return;
      }
      setCapCands({ cookies: res.cookies, tokens: res.tokens || [] });
      setCapPick(res.tokens?.[0]?.value || "");
      if (res.oauth) message.success("已抓到登录凭据，确认无误后点「添加」");
    } catch (e) {
      message.error(e.message);
    } finally {
      setCapBusy(false);
    }
  };

  // 订阅凭据文件导入：Codex auth.json / CPA / sub2api 导出都能识别其中的凭据对象。
  // 多账号导出（accounts 数组）取第一个；批量导入请用页面顶部的「导入凭据」。
  const readOAuthFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return message.warning("文件过大（上限 2MB）");
    try {
      const text = await file.text();
      let payload = text;
      try {
        const j = JSON.parse(text);
        const first = Array.isArray(j) ? j[0] : Array.isArray(j?.accounts) ? j.accounts[0] : j;
        if (first && typeof first === "object" && first.credentials && typeof first.credentials === "object") {
          payload = JSON.stringify(first.credentials, null, 2);
        } else if (first && typeof first === "object") {
          payload = JSON.stringify(first, null, 2);
        }
      } catch {
        /* 非 JSON：原样填入，提交时由后端给出明确报错 */
      }
      addForm.setFieldsValue({ token: payload });
      message.success("已读取凭据文件，点「添加」会自动校验");
    } catch {
      message.error("读取文件失败");
    }
  };

  const applyCapture = () => {
    if (!capCands) return;
    addForm.setFieldsValue({ token: capPick, cookies: capCands.cookies || "" });
    message.success("已回填登录态，请继续完善其他字段");
    closeCapture(true);
  };

  const closeCapture = async (keep) => {
    const sid = capSid;
    setCapOpen(false);
    setCapSid("");
    setCapShot(null);
    setCapCands(null);
    setCapPick("");
    setCapText("");
    if (sid && !keep) await API.post(`/channel/capture/${sid}/close`).catch(() => {});
  };

  const doDelete = async (r) => {
    if (actionBusyId) return;
    setActionBusyId(r.id);
    try {
      await API.del(`/channel/${r.id}`);
      message.success("已删除");
      setSelectedKeys((prev) => prev.filter((id) => id !== r.id));
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActionBusyId(null);
    }
  };

  const doBatch = async (action, payload) => {
    if (!selectedKeys.length) return message.warning("请先选择渠道");
    if (batchBusy) return; // 防重入：连点会重复提交同一批写入
    setBatchBusy(true);
    try {
      await API.post("/channel/batch", { ids: selectedKeys, action, payload });
      message.success("操作成功");
      setSelectedKeys([]);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBatchBusy(false);
    }
  };

  // 批量检测：选中渠道一起并发发起检测（后端 /channel/:id/test 无状态，可安全并行）
  const doBatchTest = async () => {
    if (!selectedKeys.length) return message.warning("请先选择渠道");
    if (batchTesting) return;
    const targets = items.filter((r) => selectedKeys.includes(r.id));
    if (!targets.length) return message.warning("请先选择渠道");
    setBatchTesting(true);
    setTestingIds(new Set(targets.map((r) => r.id)));
    const hide = message.loading(`正在检测 ${targets.length} 个渠道…`, 0);
    try {
      const results = await Promise.allSettled(
        targets.map((r) => API.post(`/channel/${r.id}/test`, undefined, { timeoutMs: 90_000 }))
      );
      const failed = [];
      results.forEach((ret, i) => {
        const passed = ret.status === "fulfilled" && ret.value?.success;
        if (!passed) failed.push(targets[i].name);
      });
      const okCount = targets.length - failed.length;
      if (failed.length) {
        const names = failed.slice(0, 3).join("、") + (failed.length > 3 ? ` 等 ${failed.length} 个` : "");
        message.warning(`批量检测：${okCount} 个可用，${failed.length} 个失败（${names}）`);
      } else {
        message.success(`批量检测：${okCount} 个渠道全部可用`);
      }
    } finally {
      hide();
      setTestingIds(new Set());
      setBatchTesting(false);
      await load();
    }
  };

  const fetchModels = async () => {
    const { base_url, api_key } = addForm.getFieldsValue(["base_url", "api_key"]);
    if (!api_key) return message.warning("请先填写 API Key");
    try {
      const list = await API.post("/channel/fetch-models", { base_url, api_key, type: pickProvider?.key });
      if (list?.length) {
        addForm.setFieldsValue({ models: list });
        message.success(`获取到 ${list.length} 个模型`);
      } else message.info("上游未返回模型列表，可手动输入");
    } catch (e) {
      message.error(e.message);
    }
  };

  // ---------- 表格列 ----------
  const columns = [
    { title: "ID", dataIndex: "id", width: 60, render: (v) => <span className="oo-num" style={{ color: "var(--ink-3)" }}>{v}</span> },
    {
      title: "名称",
      dataIndex: "name",
      width: 150,
      render: (v, r) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
          <VendorIcon type={r.type} size={18} />
          <span style={{ minWidth: 0, overflow: "hidden" }}>
            <div style={{ fontWeight: 550 }} className="oo-truncate" title={v}>{v}</div>
            {r.account ? (
              <div className="oo-truncate" style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }} title={r.account}>{r.account}</div>
            ) : r.remark ? (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }} className="oo-truncate" title={r.remark}>{r.remark}</div>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      // 数据重要：紧挨名称展示，方便快速判断账号健康度
      title: "最近调用",
      dataIndex: "recent",
      width: 150,
      render: (list) => <UptimeBars calls={list} onCopy={copyCallResult} />,
    },
    {
      title: "厂商",
      dataIndex: "typeName",
      width: 110,
      render: (v) => <span className="bui-chip">{v}</span>,
    },
    {
      // 模型列：展示该渠道**实际可用**的模型。
      // 两个来源合并：渠道声明的模型（管理员限定的范围）+ 上游实时探测到的模型
      // （非 API 渠道点列头刷新按钮从上游拉，API 渠道直接问 /v1/models）。
      // 不再显示「XX 全部」——那是把「没配置」当结果展示，管理员看不到真实情况。
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          模型
          {upstreamModelsBusy ? (
            <Spin size="small" />
          ) : (
            <Tooltip title="从上游拉取该账号实际可用的模型">
              <ReloadOutlined
                style={{ fontSize: 12, cursor: "pointer", color: "var(--ink-3)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  refreshAllUpstreamModels();
                }}
              />
            </Tooltip>
          )}
        </span>
      ),
      dataIndex: "models",
      width: 260,
      render: (list, r) => {
        const own = Array.isArray(list) ? list : [];
        const probed = upstreamModels[r.id] || [];
        // 探测结果优先（它才是账号真实可用的），渠道声明作为补充
        const merged = probed.length ? probed : own;
        if (!merged.length) {
          return <Text type="secondary" style={{ fontSize: 12 }}>未探测</Text>;
        }
        return (
          <Tooltip
            title={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 11, color: "#aaa" }}>
                  {probed.length ? `上游实际可用（${probed.length}）` : `渠道声明（${own.length}）`}
                </div>
                {merged.map((m) => <ModelLabel key={m} model={m} size={13} />)}
              </div>
            }
          >
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap", overflow: "hidden" }}>
              {merged.slice(0, 2).map((m) => <ModelLabel key={m} model={m} size={14} />)}
              {merged.length > 2 ? <span className="bui-chip">+{merged.length - 2}</span> : null}
            </span>
          </Tooltip>
        );
      },
    },
    {
      // 额度：紧跟在模型之后（与 sub2api 一致）。窗口按上游实际返回动态展示 ——
      // 免费号是 30 天窗口、付费号才是 5h/7d，写死窗口会显示错。
      title: "额度",
      dataIndex: "quota",
      width: 190,
      render: (q, r) =>
        q?.windows?.length || q?.credits ? (
          <QuotaInline quota={q} />
        ) : r.quota_supported ? (
          // 未查询时点一下即查（不再单独占用操作栏的位置）
          <span
            role="button"
            tabIndex={0}
            style={{ cursor: "pointer", fontSize: 12, color: "var(--ink-3)" }}
            onClick={() => doQuota(r, { openPanel: true })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                doQuota(r, { openPanel: true });
              }
            }}
          >
            点此查询
          </span>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>不支持</Text>
        ),
    },
    { title: "状态", dataIndex: "status", width: 128, render: (_, r) => <StatusCell r={r} /> },
    {
      // 凭据种类直接写清（账号 / Key），这样就不需要单独一列讲「接入方式」
      title: "凭据",
      width: 126,
      render: (_, r) => {
        if (!r.has_credential) {
          return <span className="bui-chip bui-chip--orange"><InfoCircleOutlined /> 未配置</span>;
        }
        const isApi = r.method === "api";
        return (
          <span className="bui-chip" title={r.methodLabel}>
            {isApi ? <KeyOutlined /> : <LoginOutlined />}
            {isApi ? (r.key_count > 1 ? `${r.key_count} 个 Key` : "Key") : "账号"}
          </span>
        );
      },
    },
    {
      title: "分组",
      dataIndex: "groups",
      width: 120,
      render: (list) => {
        const gs = Array.isArray(list) ? list : [];
        if (!gs.length) return <Text type="secondary" style={{ fontSize: 12 }}>公共</Text>;
        return (
          <Tooltip title={gs.join("、")}>
            <span style={{ display: "inline-flex", gap: 4, alignItems: "center", overflow: "hidden" }}>
              <span className="bui-chip">{gs[0]}</span>
              {gs.length > 1 ? <span className="bui-chip">+{gs.length - 1}</span> : null}
            </span>
          </Tooltip>
        );
      },
    },
    { title: "优先级", dataIndex: "priority", width: 86, sorter: (a, b) => a.priority - b.priority, render: (v) => <span className="oo-num">{v}</span> },
    { title: "权重", dataIndex: "weight", width: 74, render: (v) => <span className="oo-num">{v}</span> },
    {
      title: "响应",
      dataIndex: "response_time",
      width: 94,
      render: (v, r) =>
        r.tested_time ? (
          <span className="oo-num" style={{ color: v > 3000 ? "var(--orange)" : "var(--ink)" }}>{v ? `${v}ms` : "-"}</span>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>未测试</Text>
        ),
    },
    { title: "调用", dataIndex: "used_count", width: 78, sorter: (a, b) => a.used_count - b.used_count, render: (v) => <span className="oo-num">{v}</span> },
    {
      title: "操作",
      width: 150,
      fixed: "right",
      render: (_, r) => renderActions(r),
    },
  ];

  // 打开找回弹窗：先问后端这个渠道支持哪些恢复方式（不再写死接入方式清单）
  const openRelogin = async (r) => {
    setReloginTarget(r);
    setReloginInfo(null);
    setReloginText("");
    setReloginAccount("");
    setReloginPassword("");
    setReloginMode("");
    setReloginDevice(null);
    setReloginBusy(true);
    try {
      const info = await API.get(`/channel/${r.id}/recovery`);
      setReloginInfo(info);
      // 默认选推荐方式（列表第一个）
      setReloginMode(info?.modes?.[0]?.key || "paste");
    } catch (e) {
      message.error(e.message);
      // 拿不到能力清单时关掉弹窗：留一个没有任何可选方式的空壳只会误导
      setReloginTarget(null);
    } finally {
      setReloginBusy(false);
    }
  };
  const closeRelogin = () => {
    if (reloginTimerRef.current) clearInterval(reloginTimerRef.current);
    reloginTimerRef.current = null;
    reloginIdRef.current = 0;
    setReloginTarget(null);
    setReloginDevice(null);
    setReloginText("");
    setReloginAccount("");
    setReloginPassword("");
    setReloginInfo(null);
  };
  // 统一的凭据写回：粘贴凭据 / 设备码挂机 / 回调换来的凭据都走这里（含写回后自动校验）
  const saveCredential = async (credential) => {
    const r = await API.post(
      `/channel/${reloginIdRef.current || reloginTarget.id}/credential`,
      { credential },
      { timeoutMs: 120_000 }
    );
    // healthy === false 表示「凭据写进去了但上游校验没通过」——这时不能报成功，
    // 否则管理员会以为渠道已恢复（服务端 message 已经写明原因，这里按结果分色提示）
    if (r?.healthy === false) {
      message.warning(r?.message || "凭据已写入，但上游校验未通过，请检查凭据是否有效");
    } else {
      message.success(`凭据已更新${r?.account ? `（${r.account}）` : ""}，渠道已恢复`);
    }
    return r;
  };
  // 粘贴凭据（官方 auth 文件 / 完整 JSON / 网页版 accessToken）
  const submitReloginText = async () => {
    if (!reloginText.trim()) return message.warning("请粘贴凭据 JSON");
    setReloginBusy(true);
    try {
      const r = await saveCredential(reloginText);
      // 提示已由 saveCredential 按 healthy 结果给出（成功/写入但校验失败）
      void r;
      closeRelogin();
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };
  // 账密登录（DeepSeek 这类支持账密的接入方式）
  const submitReloginPassword = async () => {
    if (!reloginAccount.trim()) return message.warning("请填写手机号 / 邮箱");
    if (!reloginPassword) return message.warning("请填写密码");
    setReloginBusy(true);
    try {
      const r = await API.post(
        "/channel/login",
        {
          id: reloginTarget.id,
          type: reloginTarget.type,
          method: reloginTarget.method,
          mode: "password",
          name: reloginTarget.name,
          account: reloginAccount,
          password: reloginPassword,
        },
        { timeoutMs: 90_000 }
      );
      message.success(`登录成功${r?.account ? `（${r.account}）` : ""}，渠道已恢复`);
      closeRelogin();
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };
  // 在服务器浏览器里重新登录（订阅渠道的官方授权页 / 网页版官网登录）：
  // 掉登录态时上游常要求「再验证一次」，验证码在实时画面里人工完成，回调由服务端接管。
  const reloginBrowserStart = async () => {
    setReloginBusy(true);
    try {
      const res = await API.post(`/channel/${reloginTarget.id}/recover/start`, undefined, { timeoutMs: 90_000 });
      reloginIdRef.current = reloginTarget.id;
      autoCapRef.current = false;
      autoFailRef.current = 0;
      setCapSid(res.sid);
      setCapShot({ dataUrl: res.dataUrl, url: res.url, hint: res.hint, kind: res.kind, redirectUri: res.redirectUri || "" });
      setCapCands(null);
      setCapPick("");
      setCapText("");
      setCapOpen(true);
      closeRelogin();
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };
  // 打开授权页 → 粘贴回调地址 → 直接更新该渠道（oauth/exchange 支持 id）
  const reloginOauthStart = async () => {
    setReloginBusy(true);
    try {
      const r = await API.post("/channel/oauth/start", { type: reloginTarget.type });
      setReloginDevice({ oauthUrl: r.url, state: r.state });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };
  const reloginOauthSubmit = async () => {
    if (!reloginText.trim()) return message.warning("请粘贴登录后地址栏里的完整 URL");
    setReloginBusy(true);
    try {
      const r = await API.post(
        "/channel/oauth/exchange",
        {
          type: reloginTarget.type,
          method: reloginTarget.method,
          id: reloginTarget.id,
          name: reloginTarget.name,
          state: reloginDevice?.state || "",
          callback: reloginText,
        },
        { timeoutMs: 90_000 }
      );
      message.success(`登录成功${r?.account ? `（${r.account}）` : ""}，凭据已更新`);
      closeRelogin();
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };
  // Grok 设备码找回：发起 → 轮询 → 成功后更新该渠道
  const reloginDeviceStart = async () => {
    setReloginBusy(true);
    try {
      const r = await API.post("/channel/oauth/device/start", { type: reloginTarget.type });
      setReloginDevice(r);
      const target = r.verification_uri_complete || r.verification_uri;
      if (target) window.open(target, "_blank", "noopener");
      if (reloginTimerRef.current) clearInterval(reloginTimerRef.current);
      const iv = Math.max(3, Number(r.interval) || 5) * 1000;
      const deadline = Date.now() + Math.min(900, Number(r.expires_in) || 900) * 1000;
      reloginTimerRef.current = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(reloginTimerRef.current);
          reloginTimerRef.current = null;
          setReloginDevice((d) => (d ? { ...d, error: "已超时，请重新发起" } : d));
          return;
        }
        try {
          const p = await API.post("/channel/oauth/device/poll", { type: reloginTarget.type, device_code: r.device_code });
          if (p.pending) return;
          clearInterval(reloginTimerRef.current);
          reloginTimerRef.current = null;
          const saved = await saveCredential(p.credential);
          void saved;
          closeRelogin();
          await load();
        } catch (e) {
          clearInterval(reloginTimerRef.current);
          reloginTimerRef.current = null;
          setReloginDevice((d) => (d ? { ...d, error: e.message } : d));
        }
      }, iv);
    } catch (e) {
      message.error(e.message);
    } finally {
      setReloginBusy(false);
    }
  };

  // 上游模型探测：非 API 的反代/订阅渠道没法问「你有哪些模型」，只能让适配器去上游查一次。
  // 结果缓存在内存（不落库）：它是「账号当前"实际"能用什么」的实时快照，
  // 与渠道声明的 model 范围是两件事（后者是管理员限定的范围）。
  const [upstreamModels, setUpstreamModels] = useState({});
  const [upstreamModelsBusy, setUpstreamModelsBusy] = useState(false);
  const refreshAllUpstreamModels = async () => {
    if (upstreamModelsBusy) return;
    const targets = items.filter((r) => r.method !== "api");
    if (!targets.length) return message.info("当前没有可探测的反代/订阅渠道");
    setUpstreamModelsBusy(true);
    const hide = message.loading(`正在从上游探测 ${targets.length} 个渠道的模型…`, 0);
    try {
      const results = await Promise.allSettled(
        targets.map((r) => API.post(`/channel/${r.id}/upstream-models`, undefined, { timeoutMs: 90_000 }))
      );
      const next = { ...upstreamModels };
      let okCount = 0;
      results.forEach((res, i) => {
        if (res.status === "fulfilled" && Array.isArray(res.value?.models)) {
          next[targets[i].id] = res.value.models;
          if (res.value.models.length) okCount += 1;
        }
      });
      setUpstreamModels(next);
      message.success(`探测完成：${okCount}/${targets.length} 个渠道返回了模型列表`);
    } finally {
      hide();
      setUpstreamModelsBusy(false);
    }
  };

  // 查额度：显式触发（不进请求主链路、不做高频轮询 —— 额度接口本身就是风控信号）
  const [quotaBusyId, setQuotaBusyId] = useState(null);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState(null);
  const [quotaData, setQuotaData] = useState(null);
  const [quotaError, setQuotaError] = useState("");
  const doQuota = async (r, { openPanel = false } = {}) => {
    // 全局忙锁：正在查另一个渠道时给出明确提示，而不是静默无反应（按钮只 disable 了自己那行）
    if (quotaBusyId) {
      if (quotaBusyId !== r.id) message.info("已有一个额度查询在进行中，请稍候");
      return;
    }
    setQuotaBusyId(r.id);
    if (openPanel) {
      setQuotaTarget(r);
      setQuotaData(r.quota || null);
      setQuotaError("");
      setQuotaOpen(true);
    }
    try {
      const q = await API.post(`/channel/${r.id}/quota`, undefined, { timeoutMs: 60_000 });
      if (openPanel) setQuotaData(q);
      else message.success(`额度已更新：${q.windows?.map((w) => `${w.label} ${w.usedPercent ?? w.remaining ?? "-"}${w.usedPercent !== undefined && w.usedPercent !== null ? "%" : ""}`).join(" · ") || "已获取"}`);
      await load({ silent: true });
    } catch (e) {
      if (openPanel) setQuotaError(e.message);
      else message.error(e.message);
    } finally {
      setQuotaBusyId(null);
    }
  };

  const renderActions = (r) => (
    <Space size={2}>
      {r.canRecover !== false && r.method !== "api" ? (
        <Tooltip title={r.needsRelogin ? "凭据可能失效：点此重新登录 / 找回" : "重新登录 / 找回凭据"}>
          <button
            className="bui-icon-btn"
            style={r.needsRelogin ? { color: "var(--red)" } : undefined}
            aria-label={`${r.name} 重新登录`}
            onClick={() => openRelogin(r)}
            disabled={Boolean(actionBusyId) || testingId === r.id}
          >
            <SafetyCertificateOutlined />
          </button>
        </Tooltip>
      ) : null}
      {r.needsBrowser ? (
        <Tooltip title={r.browserReady ? "浏览器登录（已就绪）" : "浏览器登录（未完成）"}>
          <button
            className="bui-icon-btn"
            style={r.browserReady ? undefined : { color: "var(--orange)" }}
            aria-label={`${r.name} 浏览器登录`}
            disabled={Boolean(actionBusyId) || browserBusy}
            onClick={() => { setBrowserOpen(true); openBrowser(r); }}
          >
            <GlobalOutlined />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip title="测试">
        <button className="bui-icon-btn" aria-label={`${r.name} 测试`} onClick={() => doTest(r)} disabled={Boolean(actionBusyId) || batchTesting || testingId === r.id} aria-busy={testingId === r.id || testingIds.has(r.id)}>
          {testingId === r.id || testingIds.has(r.id) ? <Spin size="small" /> : <ThunderboltOutlined />}
        </button>
      </Tooltip>
      {r.cooling ? (
        <Tooltip title="恢复">
          <button className="bui-icon-btn" aria-label={`${r.name} 恢复`} onClick={() => doReset(r)} disabled={Boolean(actionBusyId) || testingId === r.id} aria-busy={actionBusyId === r.id}>
            {actionBusyId === r.id ? <Spin size="small" /> : <UndoOutlined />}
          </button>
        </Tooltip>
      ) : null}
      {/* 查额度已移到「额度」列（点未查询的格子即查），不再占用操作栏 —— 操作栏留给高频动作 */}
      <Tooltip title="用量统计">
        <button
          className="bui-icon-btn"
          aria-label={`${r.name} 用量统计`}
          onClick={() => openStats(r)}
        >
          <BarChartOutlined />
        </button>
      </Tooltip>
      <Tooltip title="编辑">
        <button className="bui-icon-btn" aria-label={`${r.name} 编辑`} onClick={() => openEdit(r)} disabled={Boolean(actionBusyId) || testingId === r.id}><EditOutlined /></button>
      </Tooltip>
      <Popconfirm title={`确认删除「${r.name}」？`} onConfirm={() => doDelete(r)}>
        <Tooltip title="删除">
          <button className="bui-icon-btn" aria-label={`${r.name} 删除`} disabled={Boolean(actionBusyId) || testingId === r.id} aria-busy={actionBusyId === r.id} style={{ color: "var(--red)" }}>
            {actionBusyId === r.id ? <Spin size="small" /> : <DeleteOutlined />}
          </button>
        </Tooltip>
      </Popconfirm>
    </Space>
  );

  // 用量统计弹窗的派生指标（累计 / 峰值单日 / 连续天数）
  const statsAll = statsData?.allTime || statsData?.totals || { calls: 0, tokens: 0, units: 0, od: 0 };
  let statsPeak = { tokens: 0, day: "" };
  for (const d of statsData?.byDay || []) {
    if ((d.tokens || 0) > statsPeak.tokens) statsPeak = { tokens: d.tokens, day: d.day };
  }
  const statsStreaks = computeStreaks(statsData?.byDay || []);

  return (
    <div className="oo-page">
      <PageHeader
        title="渠道管理"
        tags={
          <>
            <span className="bui-chip" title="渠道总数">渠道 {statsError ? "—" : stats?.total ?? items.length}</span>
            <span className="bui-chip" style={statsError || !(stats?.enabled > 0) ? undefined : { color: "var(--green)" }} title="已启用">
              启用 {statsError ? "—" : stats?.enabled ?? 0}
            </span>
            <span className="bui-chip" style={!statsError && (stats?.cooling ?? 0) > 0 ? { color: "var(--orange)" } : undefined} title="冷却中（自动恢复）">
              冷却 {statsError ? "—" : stats?.cooling ?? 0}
            </span>
            <span className="bui-chip" title="全部渠道合计的可用模型数">
              模型 {loadError ? "—" : new Set(items.flatMap((x) => x.models || [])).size}
            </span>
          </>
        }
        extra={
          <>
            <Input
              placeholder="搜索名称 / 地址 / 模型"
              allowClear
              prefix={<GlobalOutlined style={{ color: "var(--ink-3)" }} />}
              style={{ width: 210 }}
              onPressEnter={(e) => setKeyword(e.target.value)}
              onChange={(e) => { if (!e.target.value) setKeyword(""); }}
            />
            <Select
              placeholder="全部厂商" allowClear style={{ width: 140 }}
              value={filterProvider || undefined} onChange={(v) => setFilterProvider(v || "")}
              options={providers.map((p) => ({ value: p.key, label: p.name }))}
            />
            <Tooltip title={viewMode === "grid" ? "切换为列表形态" : "切换为宫格形态"}>
              <button className="bui-icon-btn" aria-label="切换列表 / 宫格形态" onClick={toggleView}>
                {viewMode === "grid" ? <UnorderedListOutlined /> : <AppstoreOutlined />}
              </button>
            </Tooltip>
            {selectedKeys.length ? (
              <>
                {/* 批量写入覆盖面很广（一次影响几十个渠道），按规范必须二次确认 */}
                <Popconfirm
                  title={`确认批量启用 ${selectedKeys.length} 个渠道？`}
                  onConfirm={() => doBatch("enable")}
                >
                  <button className="bui-btn" disabled={batchBusy}>批量启用</button>
                </Popconfirm>
                <Popconfirm
                  title={`确认批量禁用 ${selectedKeys.length} 个渠道？`}
                  description="禁用后这些渠道会立即退出调度"
                  onConfirm={() => doBatch("disable")}
                >
                  <button className="bui-btn" disabled={batchBusy}>批量禁用</button>
                </Popconfirm>
                <button className="bui-btn" onClick={() => setBatchOpen(true)} disabled={batchBusy}>批量修改</button>
                <button className="bui-btn" onClick={doBatchTest} disabled={batchTesting || batchBusy || Boolean(testingId)}>
                  {batchTesting ? <Spin size="small" style={{ marginInlineEnd: 6 }} /> : null}批量检测
                </button>
                <Popconfirm title={`确认批量删除 ${selectedKeys.length} 个渠道？`} onConfirm={() => doBatch("delete")}>
                  <button className="bui-btn" style={{ color: "var(--red)" }} disabled={batchBusy}>批量删除</button>
                </Popconfirm>
              </>
            ) : null}
            <button className="bui-btn" onClick={load}><ReloadOutlined /> 刷新</button>
            <button className="bui-btn" onClick={openImport}>导入凭据</button>
            <button className="bui-btn bui-btn--primary" onClick={openAdd}><PlusOutlined /> 添加渠道</button>
          </>
        }
      />

      {viewMode === "grid" ? (
        <div className="oo-panel">
          {loadError ? (
            <Alert
              type="error"
              showIcon
              message="渠道列表加载失败"
              description={loadError}
              action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <div className="oo-channel-grid">
            {visibleItems.slice((gridPage - 1) * 24, gridPage * 24).map((r) => (
              <article className="oo-channel-card" key={r.id}>
                <div className="oo-channel-card-head">
                  <VendorIcon type={r.type} size={20} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="oo-truncate" style={{ fontWeight: 550 }}>{r.name}</div>
                    <div className="oo-truncate" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {r.account || r.remark || r.typeName}
                    </div>
                  </div>
                  <StatusCell r={r} />
                </div>
                <div className="oo-channel-card-meta">
                  <span className="bui-chip">{r.typeName}</span>
                  <span className="bui-chip" title={r.methodLabel}>
                    {r.method === "api" ? (r.key_count > 1 ? `${r.key_count} 个 Key` : "Key") : "账号"}
                  </span>
                  <span className="bui-chip" title={(r.groups || []).join("、")}>
                    {Array.isArray(r.groups) && r.groups.length ? r.groups[0] : "未分组"}
                  </span>
                </div>
                <div className="oo-channel-card-models">
                  <Tooltip
                    title={
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {(r.models || []).map((m) => <ModelLabel key={m} model={m} size={13} />)}
                      </div>
                    }
                  >
                    <span style={{ display: "flex", gap: 8, alignItems: "center", overflow: "hidden" }}>
                      {(r.models || []).length ? (
                        <>
                          {(r.models || []).slice(0, 3).map((m) => <ModelLabel key={m} model={m} size={14} />)}
                          {(r.models?.length || 0) > 3 ? <span className="bui-chip">+{r.models.length - 3}</span> : null}
                        </>
                      ) : (
                        <span className="bui-chip">{r.typeName} 全部</span>
                      )}
                    </span>
                  </Tooltip>
                </div>
                <div className="oo-channel-card-foot">
                  <UptimeBars calls={r.recent} count={16} onCopy={copyCallResult} />
                  <div>{renderActions(r)}</div>
                </div>
              </article>
            ))}
          </div>
          <Pagination
            current={gridPage}
            pageSize={24}
            total={visibleItems.length}
            onChange={setGridPage}
            showSizeChanger={false}
            style={{ marginTop: 12, textAlign: "right" }}
          />
        </div>
      ) : (
        <div className="oo-panel">
          {loadError ? (
            <Alert
              type="error"
              showIcon
              message="渠道列表加载失败"
              description={loadError}
              action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Table
            className="oo-table"
            rowKey="id"
            loading={loading}
            dataSource={visibleItems}
            columns={columns}
            scroll={{ x: 1660 }}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个渠道` }}
          />
        </div>
      )}

      {/* ============ 添加渠道（中心弹窗）============ */}
      <Modal
        title="添加渠道"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        width={960}
        className="oo-channel-add-modal"
        destroyOnClose
        maskClosable={false}
        footer={
          <Space>
            <button className="bui-btn" onClick={() => setAddOpen(false)}>取消</button>
            <button className="bui-btn bui-btn--primary" onClick={submitAdd} disabled={!pickMethod || addSubmitting}>
              添加
            </button>
          </Space>
        }
      >
        <div className="oo-channel-add-layout">
          <section className="oo-channel-add-providers">
            <div className="oo-channel-add-step">1. 选择厂商</div>
          {providersError ? (
            <Alert
              type="error"
              showIcon
              className="oo-alert-compact"
              message="厂商列表加载失败"
              description={providersError}
              action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
              style={{ marginBottom: 10 }}
            />
          ) : null}
          {!providersError && !providers.length ? (
            <Alert
              type="info"
              showIcon
              className="oo-alert-compact"
              message="暂无可用厂商"
              description="请先配置厂商，或点击刷新重新加载列表。"
              action={<Button size="small" onClick={load} loading={loading}>刷新</Button>}
              style={{ marginBottom: 10 }}
            />
          ) : null}
            <ProviderPicker providers={providers} activeKey={pickProvider?.key} onPick={chooseProvider} />
          </section>

          <section className="oo-channel-add-config">
            {pickProvider ? (
              <>
                <div className="oo-channel-add-step">2. 填写配置</div>
            {pickMethod ? (
              <>
                <Form form={addForm} layout="vertical" requiredMark={false}>
                  <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请填写名称" }]}>
                    <Input placeholder={`例如：${pickProvider.name}-主力`} maxLength={64} />
                  </Form.Item>

                  {/* 只有一种凭据时不必让用户选，直接展示对应字段 */}
                  {credOptions.length > 1 ? (
                    <Form.Item label="凭据">
                      <Radio.Group
                        value={credId}
                        onChange={(e) => {
                          const opt = credOptions.find((o) => o.id === e.target.value);
                          if (!opt) return;
                          const m = pickProvider.methods.find((x) => x.key === opt.method);
                          applyMethod(pickProvider, m, opt.mode);
                        }}
                      >
                        {credOptions.map((o) => (
                          <Radio.Button key={o.id} value={o.id}>{o.label}</Radio.Button>
                        ))}
                      </Radio.Group>
                    </Form.Item>
                  ) : null}

                  {isRelay ? (
                    <>
                      {addMode === "password" ? (
                        <>
                          <Form.Item name="account" label="手机号 / 邮箱" rules={[{ required: true, message: "请填写手机号或邮箱" }]}>
                            <Input placeholder="13800138000 或 you@example.com" autoComplete="off" />
                          </Form.Item>
                          <Row gutter={12}>
                            <Col span={8}>
                              <Form.Item name="areaCode" label="区号"><Input placeholder="+86" /></Form.Item>
                            </Col>
                            <Col span={16}>
                              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请填写密码" }]}>
                                <Input.Password placeholder="账号密码" autoComplete="new-password" />
                              </Form.Item>
                            </Col>
                          </Row>
                        </>
                      ) : addMode === "paste" ? (
                        <>
                          {pickMethod.canCapture ? (
                            <Form.Item label="快捷登录（推荐）">
                              <Space wrap>
                                <Button icon={<GlobalOutlined />} onClick={startCapture} loading={capBusy}>
                                  打开登录页自动抓取
                                </Button>
                                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                                  {pickMethod.captureHint || "在服务器端登录页完成登录后，自动读取登录态回填下面"}
                                </span>
                              </Space>
                            </Form.Item>
                          ) : null}
                          {/* 订阅 OAuth：两种登录方式。
                              · 一键登录：在服务器浏览器里打开官方授权页（截图操作），自动抓回调换 token；
                              · 手动：打开授权页面，把打不开的 localhost 回调地址复制回来。 */}
                          {pickMethod.oauth && oauthSupported ? (
                            <Form.Item label="登录账号（推荐）">
                              <Space wrap>
                                <Button icon={<GlobalOutlined />} onClick={startCapture} loading={capBusy}>
                                  一键登录（自动抓取）
                                </Button>
                                <Button type="link" onClick={startOAuth} loading={oauthBusy} style={{ padding: 0 }}>
                                  或手动登录（需粘贴回调）
                                </Button>
                                {oauthUrl ? (
                                  <Typography.Link href={oauthUrl} target="_blank" rel="noreferrer">
                                    在新窗口打开
                                  </Typography.Link>
                                ) : null}
                              </Space>
                              {oauthUrl ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  登录后页面会停在打不开的 localhost 地址（正常），把地址栏整串 URL 粘到下面输入框。
                                </Typography.Text>
                              ) : null}
                            </Form.Item>
                          ) : null}
                          {/* 设备码登录（Grok）：服务端拿 user_code，用户在任意浏览器授权后自动回填 */}
                          {pickMethod.oauth && !oauthSupported && oauthDevice ? (
                            <Form.Item label="登录账号（推荐）">
                              <Space wrap>
                                <Button icon={<GlobalOutlined />} onClick={startDevice} loading={oauthBusy}>
                                  设备码登录
                                </Button>
                                {deviceInfo?.user_code ? (
                                  <span style={{ fontSize: 13 }}>
                                    打开页面输入代码：<b style={{ letterSpacing: 2 }}>{deviceInfo.user_code}</b>
                                    <Typography.Link
                                      href={deviceInfo.verification_uri_complete || deviceInfo.verification_uri}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={{ marginLeft: 8 }}
                                    >
                                      打开授权页
                                    </Typography.Link>
                                  </span>
                                ) : null}
                              </Space>
                              {deviceInfo?.error ? (
                                <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{deviceInfo.error}</div>
                              ) : null}
                            </Form.Item>
                          ) : null}
                          <Form.Item
                            name="token"
                            label={pickMethod.oauth ? (oauthUrl ? "回调地址 / 授权码" : "凭据 JSON") : "登录态"}
                            rules={
                              pickMethod.oauth
                                ? []
                                : [{ required: true, message: "请粘贴登录态" }]
                            }
                            extra={
                              oauthUrl
                                ? "粘贴形如 http://localhost:51121/oauth-callback?code=... 的完整地址"
                                : pickMethod.pasteHint
                            }
                          >
                            <Input.TextArea
                              rows={pickMethod.oauth ? 6 : 3}
                              placeholder={pickMethod.oauth ? "粘贴官方 CLI 凭据文件的完整内容（JSON）" : "粘贴登录态值"}
                            />
                          </Form.Item>
                          {pickMethod.oauth ? (
                            <>
                              <Form.Item label="没有现成凭据？">
                                <Space wrap>
                                  <label className="bui-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                                    <input
                                      type="file"
                                      accept=".json,application/json,text/plain"
                                      style={{ display: "none" }}
                                      onChange={readOAuthFile}
                                    />
                                    导入凭据文件
                                  </label>
                                </Space>
                              </Form.Item>
                              <Row gutter={12}>
                                <Col span={12}>
                                  <Form.Item name="access_token" label="Access Token（可选）">
                                    <Input.Password placeholder="eyJ... 或 at-..." autoComplete="off" />
                                  </Form.Item>
                                </Col>
                                <Col span={12}>
                                  <Form.Item name="refresh_token" label="Refresh Token（可选）">
                                    <Input.Password placeholder="有 RT 才能自动续期" autoComplete="off" />
                                  </Form.Item>
                                </Col>
                              </Row>
                            </>
                          ) : (
                            <Form.Item name="cookies" label="Cookies（可选，建议填写）" extra='JSON 数组，例如 [{"name":"ds_session_id","value":"..."}]'>
                              <Input.TextArea rows={2} placeholder='[{"name":"...","value":"..."}]' />
                            </Form.Item>
                          )}
                        </>
                      ) : addMode === "browser" ? (
                        <>
                          {onboardReady ? (
                            <Alert
                              type="success"
                              showIcon
                              className="oo-alert-compact"
                              style={{ marginBottom: 12 }}
                              message="已完成浏览器登录"
                            />
                          ) : null}
                          <Form.Item label="登录（在服务器浏览器里完成）">
                            <Space wrap>
                              <Button icon={<GlobalOutlined />} onClick={startCapture} loading={capBusy}>
                                {onboardReady ? "重新登录" : "打开登录页"}
                              </Button>
                            </Space>
                          </Form.Item>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Form.Item name="base_url" label="接口地址（Base URL）" rules={[{ required: true, message: "请填写地址" }]}>
                        <Input placeholder="https://..." />
                      </Form.Item>
                      <Form.Item name="api_key" label="API Key" rules={[{ required: true, message: "请填写 API Key" }]}>
                        <Input.Password placeholder={pickMethod.keyHint || "填写上游 API Key"} autoComplete="new-password" />
                      </Form.Item>
                      <Form.Item label="拉取上游模型">
                        <button className="bui-btn" onClick={fetchModels}>从上游获取模型列表</button>
                      </Form.Item>
                    </>
                  )}

                    <Form.Item
                      name="models"
                      label="模型范围"
                      rules={pickMethod?.key === "api" ? [{ required: true, message: "请至少填写一个模型" }] : []}
                    >
                      <ModelPicker providerKey={pickProvider?.key} />
                    </Form.Item>

                    <Row gutter={12}>
                      <Col span={8}>
                        <Form.Item name="groups" label="分组">
                          <Select
                            mode="multiple"
                            placeholder="不绑定"
                            options={groupSelectOptions(pickProvider?.key)}
                          />
                        </Form.Item>
                      </Col>
                    <Col span={8}>
              <Form.Item name="priority" label="优先级">
                <InputNumber style={{ width: "100%" }} min={0} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weight" label="权重">
                <InputNumber style={{ width: "100%" }} min={0} />
              </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item name="auto_ban" label="测试失败自动禁用" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Form>
              </>
                ) : (
                  <div className="oo-channel-add-empty">
                    <span className="oo-channel-add-empty-icon">2</span>
                    <span>选择厂商后填写渠道配置</span>
                  </div>
                )}
              </>
            ) : (
              <div className="oo-channel-add-empty">
                <span className="oo-channel-add-empty-icon">2</span>
                <span>选择厂商后填写渠道配置</span>
              </div>
            )}
          </section>
        </div>
      </Modal>

      {/* ============ 编辑渠道 ============ */}
      <Modal
        title={`编辑渠道：${editing?.name || ""}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={submitEdit}
        confirmLoading={editSubmitting}
        destroyOnClose
        okText="保存"
        width={580}
      >
        <Form form={editForm} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请填写名称" }]}>
            <Input maxLength={64} />
          </Form.Item>
          {/* 只有 API 渠道有 Base URL；反代/订阅渠道不展示也不提交 */}
          {editing?.method === "api" ? (
            <Form.Item name="base_url" label="接口地址（Base URL）">
              <Input placeholder="https://..." />
            </Form.Item>
          ) : null}
          {editing?.method === "api" ? (
            <Form.Item name="api_key" label="API Key">
              <Input.Password placeholder="留空不修改" autoComplete="new-password" />
            </Form.Item>
          ) : null}
          <Form.Item
            name="models"
            label="模型范围"
            rules={editing?.method === "api" ? [{ required: true, message: "请至少填写一个模型" }] : []}
          >
            <ModelPicker channelId={editing?.id || 0} providerKey={editing?.type} />
          </Form.Item>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="groups" label="分组">
                  <Select
                    mode="multiple"
                    placeholder="不绑定"
                    options={groupSelectOptions(editing?.type)}
                  />
                </Form.Item>
              </Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级"><InputNumber style={{ width: "100%" }} min={0} /></Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weight" label="权重"><InputNumber style={{ width: "100%" }} min={0} /></Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注"><Input maxLength={255} placeholder="可选" /></Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="status" label="启用状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="禁用" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="auto_test" label="定时检测" valuePropName="checked">
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="auto_test_minutes" label="检测间隔（分钟）">
                <InputNumber style={{ width: "100%" }} min={1} max={1440} disabled={!editAutoTestOn} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="test_model" label="检测模型">
                <Select
                  allowClear
                  placeholder="默认第一个模型"
                  disabled={!editAutoTestOn}
                  options={(editModels || []).filter((m) => m && m !== "*").map((m) => ({ value: m, label: m }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="test_prompt" label="检测提示词">
                <Input maxLength={200} placeholder="hi" disabled={!editAutoTestOn} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="auto_ban" label="失败自动禁用" valuePropName="checked"><Switch /></Form.Item>
            </Col>
          </Row>

          {/* 账号级运行参数：按这个账号的实际情况配，保护上游不被我们自己打爆 */}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                name="concurrency"
                label="并发数"
                extra="同时允许几个在途请求；1 = 完全串行（最保守）"
              >
                <InputNumber style={{ width: "100%" }} min={1} max={64} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="min_gap_ms"
                label="最小间隔（毫秒）"
                extra="两次请求之间的最小间隔，0 = 不限（用默认值）"
              >
                <InputNumber style={{ width: "100%" }} min={0} max={600000} step={100} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="max_per_min" label="每分钟上限" extra="0 = 用默认（20）">
                <InputNumber style={{ width: "100%" }} min={0} max={100000} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                name="fingerprint_mode"
                label="指纹模式"
                extra="收敛 = 与其它账号共用一套稳定指纹；随机 = 每次会话换"
              >
                <Select
                  options={[
                    { value: "stable", label: "稳定（每账号一套，推荐）" },
                    { value: "converge", label: "收敛（多账号共用一套）" },
                    { value: "random", label: "随机（每次变化）" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="context_billing"
                label="上下文计费口径"
                extra="auto = 跟随上游 usage；input_only = 只计输入（部分订阅号适合）"
              >
                <Select
                  options={[
                    { value: "auto", label: "自动（按上游 usage）" },
                    { value: "full", label: "全额（输入+输出）" },
                    { value: "input_only", label: "只计输入" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="namespace"
                label="Namespace"
                extra="OpenAI 组织/项目命名空间，部分上游要求"
              >
                <Input placeholder="留空 = 不发送" maxLength={64} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ============ 浏览器登录 ============ */}
      <Modal
        title={`浏览器登录：${browserTarget?.name || ""}`}
        open={browserOpen}
        onCancel={() => setBrowserOpen(false)}
        width={860}
        destroyOnClose
        footer={
          <Space>
            <button className="bui-btn" onClick={() => setBrowserOpen(false)}>关闭</button>
            <button className="bui-btn" onClick={refreshShot} disabled={browserBusy}>
              <ReloadOutlined /> 刷新画面
            </button>
            <button className="bui-btn bui-btn--primary" onClick={confirmBrowserReady} disabled={browserBusy}>
              {browserBusy ? "处理中…" : "我已完成登录，检测状态"}
            </button>
          </Space>
        }
      >
        {browserShot?.error ? (
          <Alert type="warning" showIcon className="oo-alert-compact" style={{ marginBottom: 12 }} message={browserShot.error} />
        ) : null}
        <div
          style={{
            background: "var(--inset)",
            borderRadius: "var(--r-card)",
            padding: 8,
            minHeight: 320,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "auto",
          }}
        >
          {browserBusy && !browserShot ? (
            <span style={{ color: "var(--ink-3)", fontSize: 13 }}>正在打开浏览器并加载页面，请稍候…</span>
          ) : browserShot?.dataUrl ? (
            <img
              src={browserShot.dataUrl}
              alt="上游页面截图"
              style={{ maxWidth: "100%", borderRadius: 8, display: "block" }}
            />
          ) : (
            <span style={{ color: "var(--ink-3)", fontSize: 13 }}>暂无画面</span>
          )}
        </div>
        {browserShot?.url ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }} className="oo-truncate">
            {browserShot.url}
          </div>
        ) : null}
      </Modal>

      {/* ============ 登录态远程抓取 ============ */}
      <Modal
        title={capShot?.kind === "oauth" ? "登录并自动抓取凭据" : capShot?.kind === "browser" ? "浏览器登录" : "登录并自动抓取登录态"}
        open={capOpen}
        onCancel={() => closeCapture(false)}
        footer={null}
        destroyOnClose
        width={720}
      >
        {capShot?.hint ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>{capShot.hint}</div>
        ) : null}

        {useVnc ? (
          <div>
            <iframe
              title="远程浏览器"
              src={vncInfo.url}
              style={{ width: "100%", height: 430, border: "1px solid var(--line)", borderRadius: 8, background: "#111" }}
            />
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>直接在画面里操作登录，登录态留在服务器。</span>
              <button type="button" className="bui-btn" onClick={() => setVncOff(true)}>画面没反应？切回截图模式</button>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                background: "var(--canvas)",
                borderRadius: 8,
                padding: 8,
                minHeight: 260,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {capShot?.dataUrl ? (
                <img
                  ref={capImgRef}
                  src={capShot.dataUrl}
                  alt="登录页截图"
                  onClick={onCapShotClick}
                  style={{ maxWidth: "100%", borderRadius: 6, display: "block", cursor: "crosshair" }}
                />
              ) : (
                <Spin tip="正在打开登录页…" />
              )}
            </div>
            {capShot?.url ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }} className="oo-truncate">
                {capShot.url}
              </div>
            ) : null}
            {vncInfo?.enabled ? (
              <div style={{ marginTop: 6 }}>
                <button type="button" className="bui-btn" onClick={() => setVncOff(false)}>切回实时浏览器画面</button>
              </div>
            ) : null}
          </>
        )}

        {!capCands ? (
          <Space direction="vertical" style={{ width: "100%", marginTop: 12 }} size={8}>
            {!useVnc ? (
            <Space wrap>
              <Input
                style={{ width: 220 }}
                placeholder="输入验证码 / 账号（可选）"
                value={capText}
                onChange={(e) => setCapText(e.target.value)}
                onPressEnter={() => {
                  if (capText) {
                    capAct({ action: "type", text: capText });
                    setCapText("");
                  }
                }}
              />
              <Button
                onClick={() => {
                  if (capText) {
                    capAct({ action: "type", text: capText });
                    setCapText("");
                  }
                }}
              >
                输入到页面
              </Button>
              <Button onClick={() => capAct({ action: "key", key: "Enter" })}>回车</Button>
              <Button onClick={() => capAct({ action: "key", key: "Tab" })}>Tab</Button>
              <Button onClick={() => capAct({ action: "key", key: "Backspace" })}>退格</Button>
              <Button onClick={() => capAct({ action: "scroll", dy: 600 })}>向下滚</Button>
              <Button onClick={() => capAct({ action: "scroll", dy: -600 })}>向上滚</Button>
            </Space>
            ) : null}
            <Space>
              <Button type="primary" onClick={finishCapture} loading={capBusy}>
                {capShot?.kind === "oauth" ? "完成授权，抓取凭据" : capShot?.kind === "browser" ? "我已登录，完成" : "我已登录，抓取登录态"}
              </Button>
              <Button onClick={() => closeCapture(false)}>放弃</Button>
            </Space>
          </Space>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              选择要填入表单的登录态（共 {capCands.tokens.length} 个候选）
            </div>
            {capCands.tokens.length ? (
              <Radio.Group
                value={capPick}
                onChange={(e) => setCapPick(e.target.value)}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                {capCands.tokens.map((t) => (
                  <Radio key={t.key} value={t.value}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {t.key} = {t.value.slice(0, 24)}…{t.value.slice(-6)}
                    </span>
                  </Radio>
                ))}
              </Radio.Group>
            ) : (
              <div style={{ fontSize: 12, color: "var(--orange)" }}>没有抓到 token 类登录态，只回填 cookies。</div>
            )}
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
              Cookies：{capCands.cookies ? `${capCands.cookies.slice(0, 60)}…` : "（空）"}
            </div>
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" onClick={applyCapture} disabled={!capPick && !capCands.cookies}>
                填入表单
              </Button>
              <Button onClick={() => closeCapture(false)}>取消</Button>
            </Space>
          </div>
        )}
      </Modal>

      {/* ============ 批量修改 ============ */}
      <Modal
        title={`批量修改 ${selectedKeys.length} 个渠道`}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        footer={null}
        destroyOnClose
        width={460}
      >
        <Form
          form={batchForm}
          layout="vertical"
          requiredMark={false}
          onFinish={async (v) => {
            const payload = {};
            if (v.action === "set_priority") payload.priority = v.priority;
            if (v.action === "set_group") payload.group_name = v.group_name;
            if (v.action === "add_models") payload.models = v.models;
            await doBatch(v.action, payload);
            setBatchOpen(false);
            batchForm.resetFields();
          }}
        >
          <Form.Item name="action" label="操作" rules={[{ required: true, message: "请选择操作" }]}>
            <Select
              options={[
                { value: "set_priority", label: "设置优先级" },
                { value: "set_group", label: "设置分组" },
                { value: "add_models", label: "追加模型" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.action !== c.action}>
            {({ getFieldValue }) => {
              const a = getFieldValue("action");
              if (a === "set_priority") {
                return (
                  <Form.Item name="priority" label="优先级" rules={[{ required: true, message: "请填写" }]}>
                    <InputNumber style={{ width: "100%" }} min={0} />
                  </Form.Item>
                );
              }
                if (a === "set_group") {
                  return (
                    <Form.Item name="group_name" label="分组" rules={[{ required: true, message: "请填写" }]}>
                      <Select options={[...new Set(groups.map((g) => g.name))].map((g) => ({ value: g, label: g }))} />
                    </Form.Item>
                  );
                }
              if (a === "add_models") {
                return (
                  <Form.Item name="models" label="要追加的模型" rules={[{ required: true, message: "请填写" }]}>
                    <Select mode="tags" placeholder="输入模型名后回车" tokenSeparators={[","]} />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
          <button className="bui-btn bui-btn--primary" type="submit">执行</button>
        </Form>
      </Modal>

      {/* ============ 导入凭据（CPA / sub2api） ============ */}
      <Modal
        title="导入凭据（CPA / sub2api）"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        confirmLoading={importBusy}
        okText="开始导入"
        width={680}
      >
                <input type="file" accept=".json,application/json,.txt,text/plain" multiple onChange={readImportFile} style={{ marginBottom: 10 }} />
        <Input.TextArea
          rows={10}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="粘贴 JSON 文件内容（例如 sub2api 导出、CPA auths/*.json）"
        />
        {importResult ? (
          <pre
            style={{
              marginTop: 12,
              maxHeight: 220,
              overflow: "auto",
              fontSize: 12,
                background: "var(--inset)",
              padding: 10,
              borderRadius: 8,
            }}
          >
            {JSON.stringify(
              {
                成功: importResult.created,
                跳过: importResult.skipped,
                明细: (importResult.results || []).map(
                  (x) => `${x.ok ? "[OK]" : x.skipped ? "[SKIP]" : "[FAIL]"} ${x.name}${x.reason ? `（${x.reason}）` : ""}`
                ),
                解析失败: (importResult.parseErrors || []).map((x) => `${x.name}：${x.reason}`),
              },
              null,
              2
            )}
          </pre>
        ) : null}
      </Modal>

      {/* ============ 账号额度 ============ */}
      <Modal
        title={`账号额度：${quotaTarget?.name || ""}`}
        open={quotaOpen}
        onCancel={() => setQuotaOpen(false)}
        footer={<button type="button" className="bui-btn" onClick={() => setQuotaOpen(false)}>关闭</button>}
        destroyOnClose
        width={520}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <QuotaPanel
            quota={quotaData}
            loading={quotaBusyId === quotaTarget?.id && !quotaError}
            error={quotaError}
            onRefresh={() => quotaTarget && doQuota(quotaTarget, { openPanel: true })}
          />
        </div>
      </Modal>

      {/* ============ 重新登录 / 凭据找回 ============ */}
      {/* 方式由后端 /channel/:id/recovery 现算：订阅渠道可在服务器浏览器里走官方授权页
          （掉验证/接码那一步在实时画面里人工完成），网页版渠道直接抓站点会话，账密型可重登。 */}
      <Modal
        title={`重新登录 / 找回凭据：${reloginTarget?.name || ""}`}
        open={Boolean(reloginTarget)}
        onCancel={closeRelogin}
        footer={null}
        destroyOnClose
        width={620}
      >
        {reloginBusy && !reloginInfo ? (
          <div style={{ padding: 28, textAlign: "center" }}><Spin tip="正在检查该渠道可用的找回方式…" /></div>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size={10}>
            {reloginInfo ? (
              <div className="oo-kv" style={{ fontSize: 12 }}>
                <span className="bui-chip">{reloginInfo.typeName}</span>
                <span className="bui-chip">{reloginInfo.methodLabel}</span>
                {reloginInfo.account ? <span className="bui-chip">账号 {reloginInfo.account}</span> : null}
                {reloginInfo.planType ? <span className="bui-chip">订阅 {reloginInfo.planType}</span> : null}
                {reloginInfo.needsRelogin ? (
                  <span className="bui-chip bui-chip--orange"><ExclamationCircleOutlined /> 需要重新登录</span>
                ) : null}
              </div>
            ) : null}
            {reloginInfo?.lastError ? (
              <div style={{ fontSize: 12, color: "var(--red)" }}>{reloginInfo.lastError}</div>
            ) : null}

            <Select
              value={reloginMode || undefined}
              onChange={(v) => { setReloginMode(v); setReloginDevice(null); }}
              style={{ width: "100%" }}
              options={(reloginInfo?.modes || []).map((m) => ({ value: m.key, label: m.label }))}
            />

            {/* 浏览器登录：服务器浏览器里打开官方页/官网，验证码人工完成，成功后自动写回 */}
            {["oauth-browser", "session-capture", "capture", "browser-ready"].includes(reloginMode) ? (
              <Button type="primary" icon={<GlobalOutlined />} onClick={reloginBrowserStart} loading={reloginBusy} block>
                在服务器浏览器里打开登录页
              </Button>
            ) : null}

            {/* 设备码登录（Grok） */}
            {reloginMode === "device" ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Button type="primary" icon={<GlobalOutlined />} onClick={reloginDeviceStart} loading={reloginBusy} block>
                  发起设备码登录
                </Button>
                {reloginDevice?.user_code ? (
                  <div style={{ fontSize: 13 }}>
                    在打开的页面输入代码：<b style={{ letterSpacing: 2 }}>{reloginDevice.user_code}</b>
                    <Typography.Link
                      href={reloginDevice.verification_uri_complete || reloginDevice.verification_uri}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginLeft: 8 }}
                    >
                      打开授权页
                    </Typography.Link>
                  </div>
                ) : null}
                {reloginDevice?.error ? <div style={{ fontSize: 12, color: "var(--red)" }}>{reloginDevice.error}</div> : null}
              </Space>
            ) : null}

            {/* 打开授权页 + 粘贴回调（自己电脑上登录） */}
            {reloginMode === "oauth-callback" ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Space wrap>
                  <Button icon={<GlobalOutlined />} onClick={reloginOauthStart} loading={reloginBusy}>打开授权页</Button>
                  {reloginDevice?.oauthUrl ? (
                    <Typography.Link href={reloginDevice.oauthUrl} target="_blank" rel="noreferrer">在新窗口打开</Typography.Link>
                  ) : null}
                </Space>
                <Input.TextArea
                  rows={4}
                  value={reloginText}
                  onChange={(e) => setReloginText(e.target.value)}
                  placeholder="粘贴回调地址 / 授权码"
                />
                <Button type="primary" loading={reloginBusy} onClick={reloginOauthSubmit}>保存</Button>
              </Space>
            ) : null}

            {/* 账号密码登录 */}
            {reloginMode === "password" ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Input
                  placeholder="手机号 / 邮箱"
                  value={reloginAccount}
                  onChange={(e) => setReloginAccount(e.target.value)}
                />
                <Input.Password
                  placeholder="密码"
                  value={reloginPassword}
                  onChange={(e) => setReloginPassword(e.target.value)}
                  onPressEnter={submitReloginPassword}
                />
                <Button type="primary" loading={reloginBusy} onClick={submitReloginPassword}>登录并写回</Button>
              </Space>
            ) : null}

            {/* 粘贴凭据（所有反代/订阅方式都保留这条兜底路径） */}
            {["paste", "api-key"].includes(reloginMode) ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Input.TextArea
                  rows={6}
                  value={reloginText}
                  onChange={(e) => setReloginText(e.target.value)}
                  placeholder={
                    reloginInfo?.method === "api"
                      ? "API Key 渠道请关闭本弹窗，用「编辑」更换 Key"
                      : "粘贴官方凭据文件（JSON）/ 登录态（token、cookie 串）"
                  }
                  disabled={reloginInfo?.method === "api"}
                />
                <Button
                  type="primary"
                  loading={reloginBusy}
                  onClick={submitReloginText}
                  disabled={reloginInfo?.method === "api"}
                >
                  保存凭据并校验
                </Button>
              </Space>
            ) : null}

            <Space>
              <Button onClick={closeRelogin}>取消</Button>
              {reloginInfo?.canVerify ? (
                <Button
                  onClick={async () => {
                    setReloginBusy(true);
                    try {
                      const r = await API.post(`/channel/${reloginTarget.id}/test`, undefined, { timeoutMs: 90_000 });
                      if (r?.success) message.success(`渠道可用（${r.time}ms）`);
                      else message.warning(r?.message || "渠道暂不可用");
                      await load();
                    } catch (e) {
                      message.error(e.message);
                    } finally {
                      setReloginBusy(false);
                    }
                  }}
                  loading={reloginBusy}
                >
                  仅检测当前凭据
                </Button>
              ) : null}
            </Space>
          </Space>
        )}
      </Modal>

      {/* ============ 用量统计（总计 / 按天 / 按模型 / 最近调用） ============ */}
      <Modal
        title={`用量统计：${statsTarget?.name || ""}`}
        open={statsOpen}
        onCancel={() => setStatsOpen(false)}
        footer={null}
        width={880}
        destroyOnClose
      >
        {statsBusy ? (
          <div style={{ padding: 36, textAlign: "center" }}><Spin /></div>
        ) : statsData ? (
          <>
            <div className="oo-stats-cards">
              <StatCard label="累计调用" value={fmtCompact(statsAll.calls)} hint={`累计 ${fmtFull(statsAll.calls)} 次`} />
              <StatCard label="累计 Token 数" value={fmtCompact(statsAll.tokens)} hint={`${fmtFull(statsAll.tokens)} tokens`} />
              <StatCard
                label="峰值单日 Token"
                value={fmtCompact(statsPeak.tokens)}
                hint={statsPeak.day ? `${statsPeak.day} · ${fmtFull(statsPeak.tokens)} tokens` : "暂无数据"}
              />
              <StatCard label={`累计消费（${CURRENCY_NAME}）`} value={statsAll.od} hint={`${fmtFull(statsAll.units)} 额度单位`} />
              <StatCard label="当前连续天数" value={`${statsStreaks.current} 天`} />
              <StatCard label="最长连续天数" value={`${statsStreaks.longest} 天`} />
            </div>

            <TokenActivity byDay={statsData.byDay} />

            <TokenTrend
              byDay={statsData.byDay}
              series={statsData.series || []}
              range={trendRange}
              onRangeChange={setTrendRange}
            />

            <div className="oo-stats-card-head">
              <div className="oo-stats-card-title">最近调用</div>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                近 {statsData.days} 天：调用 {statsData.totals.calls} · Tokens {fmtFull(statsData.totals.tokens)} · 消费 {statsData.totals.od} {CURRENCY_NAME}
              </span>
            </div>
            <div className="oo-stats-recent">
              {(statsData.recent || []).slice(-10).reverse().map((c, i) => (
                <div className="oo-stats-recent-row" key={i}>
                  <span
                    className={`oo-uptime-bar is-clickable ${!c.ok ? "is-fail" : c.ms >= UPTIME_SLOW_MS ? "is-slow" : "is-ok"}`}
                    role="button"
                    tabIndex={0}
                    title="点击复制原始返回结果"
                    onClick={() => copyCallResult(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        copyCallResult(c);
                      }
                    }}
                  />
                  <span style={{ width: 92, color: "var(--ink-3)", fontSize: 12 }}>{fmtDate(c.t, "MM-DD HH:mm")}</span>
                  <span className="oo-stats-recent-src">
                    {c.u ? (
                      <Tooltip title={`${c.u.n || "用户"}${c.u.e ? ` · ${c.u.e}` : ""}（点击复制）`}>
                        <button type="button" className="bui-user-tag" onClick={() => copyUserContact(c.u)}>
                          <Avatar size={16} style={{ background: "var(--accent)", fontSize: 10 }}>
                            {String(c.u.n || "?").slice(0, 1)}
                          </Avatar>
                          <span className="oo-truncate" style={{ maxWidth: 46 }}>{shortUser(c.u.n)}</span>
                        </button>
                      </Tooltip>
                    ) : c.k === "auto" ? (
                      <span className="bui-chip">定时</span>
                    ) : c.k === "test" ? (
                      <span className="bui-chip">测试</span>
                    ) : c.k === "chat" ? (
                      <span className="bui-chip">对话</span>
                    ) : (
                      <span className="bui-chip" style={{ opacity: 0.6 }}>其他</span>
                    )}
                  </span>
                  <span className="oo-num" style={{ width: 56, textAlign: "right", fontSize: 12 }}>{c.ms ? `${c.ms}ms` : "-"}</span>
                  <span
                    className="oo-truncate"
                    style={{ flex: 1, fontSize: 12 }}
                    title={`${cleanSummary(c.p)} → ${cleanSummary(c.r)}`}
                  >
                    {cleanSummary(c.p) ? `${cleanSummary(c.p)} → ${cleanSummary(c.r)}` : cleanSummary(c.r)}
                  </span>
                </div>
              ))}
              {!(statsData.recent || []).length ? <Text type="secondary" style={{ fontSize: 12 }}>暂无记录</Text> : null}
            </div>
          </>
        ) : (
          <Text type="secondary">暂无数据</Text>
        )}
      </Modal>
    </div>
  );
}
