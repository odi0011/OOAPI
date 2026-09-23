import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  Table, Space, Typography, Input, Popconfirm, Modal, Form, Select, Switch,
  InputNumber, App as AntApp, Tooltip, Row, Col, Alert, Radio, Button, Spin, Pagination, Segmented, Avatar,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, DeleteOutlined, EditOutlined,
  UndoOutlined, KeyOutlined, LoginOutlined, GlobalOutlined,
  InfoCircleOutlined, SafetyCertificateOutlined, AppstoreOutlined, UnorderedListOutlined, BarChartOutlined,
  ExclamationCircleOutlined, DashboardOutlined, LinkOutlined, CopyOutlined,
  // 额度列的「上游 429，预计恢复时间」提示行用它（时钟语义）
  ClockCircleOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import { fmtDate, CURRENCY_NAME, copyText, odOf, unitsPerOd } from "../services/format";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel, GroupVendorIcons, GroupTag } from "../components/VendorIcon";
import ModelPicker from "../components/ModelPicker";
import QuotaPanel, { QuotaInline } from "../components/ChannelQuota";
// SERIES_COLORS：渠道「用量统计」弹窗里按模型画多条折线时取色。
// 必须显式导入 —— 此前只有引用没有导入，打开该弹窗会抛
// `ReferenceError: SERIES_COLORS is not defined` 把整块图表打空（实测踩到）。
// 取色统一走 Charts.jsx 的规范，颜色语义跨页面一致（见该文件注释）。
import { SERIES_COLORS } from "../components/Charts";

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

/**
 * 状态单元格 —— **可点击切换启停**（用户要求：「状态列应该是一个按钮，
 * 点击能直接设定启用和暂停」）。
 *
 * 之前是纯展示的 chip，启停要去操作列的菜单里翻；而这是运维最高频的动作
 * （一出错就先停掉），直接点状态最顺手。
 *
 * 自动暂停（status=3，检测失败或用户调用出错时由后端写入）也能点 ——
 * 那正是最需要「修好后一键启用」的场景。
 */
/**
 * 渠道启停开关（checkbox-41 造型）—— 用户提供的设计。
 *
 * 按项目约定转成纯 CSS（styles.css 的 .oo-toggle41），原稿改了三处：
 *   ① 不引入 styled-components —— 项目零新依赖，为一条控件加运行时样式库不划算，
 *      还会和现有 CSS 变量体系打架；
 *   ② 尺寸：原设计 --size:100px（100×50px）放不进 128px 的状态列 → 44px（44×22px）；
 *      原稿的 30px/100px 圆角是绝对 px，缩放后会失真，已按比例折成 em；
 *   ③ 颜色换成主题色：`#222` 边框 → `--ink-2`，`#fde881` 黄 → `--accent`，
 *      深浅主题自动适配（用户要求「颜色用我们的主题色」）。
 *
 * 无障碍：用真实 `<input type="checkbox">`（原设计也是），可聚焦、空格切换、
 * 读屏识别开关语义；且勾选态的圆角方向本身不同，不单靠颜色区分。
 */
function ChannelSwitch({ checked, disabled, onToggle, title }) {
  return (
    <Tooltip
      // 状态含义与自动暂停原因是多行，antd 默认会把换行折叠成空格 ——
      // 用 pre-line 的容器保住分行（否则「冷却至 …」「原因：…」会挤成一坨）
      title={<span style={{ whiteSpace: "pre-line" }}>{title}</span>}
    >
      <span className="oo-toggle41">
        <input
          type="checkbox"
          checked={Boolean(checked)}
          disabled={Boolean(disabled)}
          aria-label={title}
          onChange={(e) => onToggle?.(e.target.checked)}
        />
      </span>
    </Tooltip>
  );
}

/**
 * 状态单元格 —— **只放启停开关**（用户要求：「那个已启用不要了，这一列就放这个按钮就行」）。
 *
 * 状态含义全部收进开关本身 + 悬浮提示：
 *   · 勾选 = 渠道在跑（启用且未冷却）
 *   · 未勾选 = 已暂停（手动暂停或自动暂停）
 *   · 冷却中仍是勾选态（渠道没被停，只是暂时避开），提示里写明冷却到几点
 *   · 自动暂停的原因在提示里给出 —— 用户据此决定是恢复还是换凭据
 */
function StatusCell({ r, onToggle, busy }) {
  const st = Number(r.status);
  const auto = st === 3;
  const paused = st === 2;
  const cooling = Boolean(r.cooling) && !auto && !paused;
  const active = !auto && !paused;

  const state = auto
    ? r.rate_limit_until
      ? "限流停用"
      : r.last_error
        ? "已自动暂停"
        : "已暂停"
    : paused
      ? "已暂停"
      : cooling
        ? "冷却中"
        : "已启用";
  const lines = [`${state}（点击${active ? "暂停" : "启用"}）`];
  if (auto && r.rate_limit_until) lines.push(`${fmtClock(r.rate_limit_until)} 自动恢复`);
  else if (cooling && r.cooldown_text) lines.push(`冷却至 ${r.cooldown_text}`);
  if (r.last_error) lines.push(`原因：${r.last_error}`);

  return (
    <ChannelSwitch
      checked={active}
      disabled={busy}
      title={lines.join("\n")}
      onToggle={(next) => onToggle?.(r, next)}
    />
  );
}

/**
 * 「上游 429」提示行 —— 挂在额度列下方，橙黄色，显示预计恢复时刻。
 *
 * 用户要求（原话）：「如果哪个渠道报错 429，不要计入最近调用条条里，
 * 应该直接停止渠道状态然后在额度的余额那一行 tag 的下面新起一行，
 * 用橙黄色显示上游 429，预计恢复时间 xxx」。
 *
 * 为什么单独一行而不是塞进状态列的气泡：429 是**有时间维度的临时状态**，
 * 管理员最需要的是「还要等多久」并据此判断要不要手工启用（或换个号）。
 * 状态列那一个小开关的 hover 里说不清，而额度列本来就是「这个账号现在怎么样」
 * 的位置，放在这里不用额外操作就能看到。
 *
 * 只在真的被限流停用时渲染（`rate_limit_until > 0`）：429 恢复后后端会把它清零，
 * 这一行随之消失，不需要前端自己算时间。
 */
function RateLimitRow({ r }) {
  const until = Number(r?.rate_limit_until) || 0;
  if (!until) return null;
  const left = until * 1000 - Date.now();
  // 已到点但后台还没跑到（30s 那一轮）：显示「恢复中」而不是负数倒计时
  //
  // 文案必须**短**：额度列只有 240px，实测「上游 429 预计 16:34:52 恢复（7 分 45 秒）」
  // 会被截成「…恢复（7 分 45 …」—— 而恢复时刻恰好是最该看清的那几个字。
  // 所以这一行只放「上游 429 · HH:MM 恢复」，倒计时与完整原因放进悬浮提示
  // （要看细节时鼠标一悬就有，平时不占宽度）。
  const text = left > 0 ? `· ${fmtClock(until)} 恢复` : "· 正在恢复…";
  const leftText = left > 0 ? `，还有 ${fmtLeft(left)}` : "";
  return (
    <Tooltip
      title={`上游返回 429（请求过于频繁），渠道已暂停调用${leftText}\n恢复时刻：${
        left > 0 ? fmtClock(until) : "已到，等待后台放回启用"
      }\n${r.last_error || ""}`}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          alignSelf: "flex-start",
          maxWidth: "100%",
          padding: "1px 6px",
          borderRadius: 4,
          fontSize: 11,
          lineHeight: "16px",
          whiteSpace: "nowrap",
          // 橙黄色（复用额度条的 amber 色板，与「用量偏高」同一套语义色）
          color: "var(--pill-amber-ink)",
          background: "var(--pill-amber-tint)",
        }}
      >
        <ClockCircleOutlined style={{ fontSize: 11, flexShrink: 0 }} />
        {/* 不设 ellipsis：文案已按列宽裁剪过，真溢出说明列更窄 —— 那时截断会吃掉
            「恢复」二字，还不如让它自然显示。数字与时刻绝不能被切成两行（用户要求）。 */}
        <span>上游 429 {text}</span>
      </span>
    </Tooltip>
  );
}

/** 时刻（epoch 秒）→ HH:MM（本地时区）。到秒级没有意义：这一行是「大概什么时候好」，
 * 精确到分足够，还能省下 3 个字符的宽度（额度列很窄）。 */
function fmtClock(epochSeconds) {
  const d = new Date(Number(epochSeconds) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 剩余毫秒 → 「x 分 y 秒」/「x 小时 y 分」 */
function fmtLeft(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}
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
/** 支持「一键绑定」（设备授权）的接入方式 —— 与后端 device-bind.js 的清单一致 */
const DEVICE_BIND_METHODS = ["kiro", "workbuddy", "qoder"];
function supportsDeviceBindMethod(methodKey) {
  return DEVICE_BIND_METHODS.includes(String(methodKey || ""));
}

/**
 * 接入方式的短名 —— 用于「凭据」标签。
 * 为什么需要：Anthropic 下同时挂着「Claude 订阅」与「Kiro 反代」，
 * 两者的 credential 都是 paste 模式，若标签一律叫「粘贴凭据」会出现两个同名标签，
 * 用户分不清该选哪个（截图实测确认过这个问题）。
 */
function methodShortName(m) {
  const byKey = {
    kiro: "Kiro 反代",
    "claude-oauth": "Claude 订阅",
    codex: "Codex 订阅",
    antigravity: "Google 订阅",
    grok: "Grok 订阅",
    // 「浏览器驱动」必须显式命名：兜底逻辑会把「反代（浏览器驱动）」去掉括号后
    // 变成「反代」，与同厂商的「反代（网页版）」撞名 —— 而两者凭据完全不同
    // （前者填邮箱密码+2FA，后者粘贴 access_token），选错就建不出可用渠道。
    "openai-web-ui": "浏览器驱动",
  };
  if (byKey[m.key]) return byKey[m.key];
  // 兜底：用方法自身的 label 去掉括号说明（label 形如「反代（Kiro）」）
  const raw = String(m.label || "凭据");
  return raw.replace(/（[^）]*）/g, "").trim() || "凭据";
}

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
            {/* 图标用 p.icon（= 厂商 key），不是 p.vendor ——
                vendor 是「模型归哪家」（Kiro 的 Claude 归 anthropic），
                用它会让 Kiro 显示成 Claude 图标。 */}
            <VendorIcon type={p.icon || p.key || p.vendor} size={22} />
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
  // status 提供 units_per_od 等站点配置：额度单位换算要它（不要自己写死 10000）
  const { status } = useApp();

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

  // 可选分组（管理员在「分组管理」创建；不选 = 不绑定）。
  //
  // 不再按厂商过滤：分组可以跨厂商（vendor 只是建组时的可选筛选），
  // 按厂商过滤会让 vendor 为空的分组对**任何**渠道都不可见，
  // 管理员会误以为「分组丢了」，且难以把跨厂商分组挂到渠道上。
  // 同厂商的分组排在前面，只是排序上的便利。
  const groupNamesOf = (type) => {
    const list = [...groups];
    if (type) list.sort((a, b) => (b.vendor === type ? 1 : 0) - (a.vendor === type ? 1 : 0));
    return list.map((g) => g.name);
  };

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
  const [browserBusy, setBrowserBusy] = useState(false);
  // 浏览器登录类：添加表单里已完成「浏览器登录」（GLM/豆包/通义）：profile 存在服务器临时目录，
  // 提交时按 profileId 复制给渠道（每次登录一个独立目录，避免并发/复用串号）
  // 凭据找回（401/登录态失效后重新登录）：能力由后端算（/channel/:id/recovery），
  // 前端只负责把对应流程跑起来 —— 浏览器授权、网页版会话抓取、设备码、粘贴凭据都在这里。
  const [reloginTarget, setReloginTarget] = useState(null);
  const [reloginInfo, setReloginInfo] = useState(null);
  // 本机浏览器登录指引（后端 /recovery 返回）：分步说明 + 可选的一行取码代码。
  // 与「新增渠道」面板共用后端同一份数据（channel-types 的 LOCAL_LOGIN_GUIDE）。
  const reloginLocalGuide = reloginInfo?.localLogin || null;
  const [reloginText, setReloginText] = useState("");
  const [reloginAccount, setReloginAccount] = useState("");
  const [reloginPassword, setReloginPassword] = useState("");
  const [reloginMode, setReloginMode] = useState("");
  const [reloginBusy, setReloginBusy] = useState(false);
  const [reloginDevice, setReloginDevice] = useState(null);
  // 一键绑定（重新绑定已有渠道）时的渠道特化输入：Kiro 的 region/startUrl、
  // WorkBuddy/Qoder 的区域。放在弹窗里让用户按需填，留空用默认/自动探测。
  const [reloginBindRegion, setReloginBindRegion] = useState("");
  const [reloginBindStartUrl, setReloginBindStartUrl] = useState("");
  const [reloginBindRealm, setReloginBindRealm] = useState("");
  const reloginTimerRef = useRef(null);
  // 找回指向的渠道 id：抓取界面成功后直接写回该渠道（而不是回填「添加渠道」表单）
  const reloginIdRef = useRef(0);
  // 登录态远程抓取（粘贴登录态的厂商：打开登录页 → 登录 → 自动回填 token/cookies）
  // 订阅 OAuth 交互式登录：oauthUrl 有值表示「已发起登录，等待用户粘贴回调地址」
  const [oauthSupported, setOauthSupported] = useState(false);
  // 该渠道是否支持「一键绑定」（设备授权）：Kiro / WorkBuddy / Qoder。
  // 清单由后端下发（/channel/devices/vendors），前端不写死 —— 加渠道不用改前端。
  //
  // 注意：这个 state 曾经声明了却**从没拉取**，导致一键绑定 UI 恒不显示
  // （常量式写法掩盖了问题：`includes()` 在空数组上恒为 false，不报错）。
  // 现在在挂载时拉一次，并给「重新绑定」弹窗单独存一份（那一处需要按渠道类型判断）。
  const [deviceBindVendors, setDeviceBindVendors] = useState([]);
  // 设备码登录（Grok/xAI）：返回 user_code 并在任意浏览器完成授权
  const [oauthDevice, setOauthDevice] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const deviceTimerRef = useRef(null);
  // 一键绑定（设备授权）：Kiro / WorkBuddy / Qoder。
  // 与上面的 deviceInfo（Grok 设备码登录）**流程相同但接口不同**：
  // 那几个渠道走 /channel/devices/*（服务端直接落库），不是 /oauth/device/*（回填表单）。
  // 刻意分开维护 —— 混用会让「绑定成功后凭据去哪」变得含糊。
  const [bindInfo, setBindInfo] = useState(null);
  const bindTimerRef = useRef(null);
  // 绑定成功后暂存的凭据票据（新建渠道流程：先授权、再建渠道、最后 claim）
  const bindTicketRef = useRef("");
  // 绑定目标渠道：新建渠道时为 0（走 ticket 流程），重新绑定时为渠道 id
  const [bindTargetChannelId, setBindTargetChannelId] = useState(0);
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthState, setOauthState] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);

  // ── 以下这段是表单实例、竞态令牌与列表加载函数 ────────────────────────────
  // ⚠️ 它们在一次「删服务器浏览器死代码」的批量删除里被误删过（连带把
  //    addForm/editForm/editModels/load 一起删掉了，线上直接白屏
  //    `ReferenceError: load is not defined`）。恢复时特意标出：
  //    **删代码必须按符号查引用，不能只按行号区间切** —— 行号会因前面的编辑漂移。
  const capImgRef = useRef(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [batchForm] = Form.useForm();
  // 新建表单里的接口地址 / API Key 实时值：ModelPicker 靠它们在**保存前**拉模型
  // （否则「点获取模型 → 请先保存」与「保存 → 请先选模型」互相锁死，见 ModelPicker 注释）
  const addBaseUrl = Form.useWatch("base_url", addForm);
  const addApiKey = Form.useWatch("api_key", addForm);
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

  // 拉「支持一键绑定」的渠道清单（只一次）。
  // 必须真的拉：之前声明了 state 却忘了拉，导致一键绑定 UI 恒不显示（截图才发现）。
  useEffect(() => {
    API.get("/channel/devices/vendors")
      .then((d) => setDeviceBindVendors(Array.isArray(d?.vendors) ? d.vendors : []))
      .catch(() => setDeviceBindVendors([]));
  }, []);


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
      // 用后端下发的 apiKey 标记判断，而不是硬编码 m.key === "api"。
      // 硬编码的后果：同一厂商下的第二个 API Key 型方式（OpenCode 的 GO 套餐、
      // 自定义厂商的 Anthropic 兼容）在「添加渠道」里整档消失 —— 用户根本选不到。
      if (m.apiKey || m.key === "api") {
        // 标签规则：厂商只有**一个** API Key 型方式时叫「API Key」（如各家的官方接口）；
        // 有多个时必须各自带方法名 —— 否则 OpenCode 的 Zen 与 GO 会一个叫「API Key」、
        // 一个叫「GO（$10/月订阅）（API Key）」，用户看不出第一个其实是 Zen。
        const apiKeyCount = pickProvider.methods.filter((x) => x.apiKey || x.key === "api").length;
        out.push({
          id: m.key,
          method: m.key,
          mode: null,
          label:
            apiKeyCount > 1
              ? `${m.label || m.key}（API Key）`
              : "API Key",
          hint: "",
        });
      } else {
        // 每个接入方式只出**一个**登录选项。
        //
        // 为什么合并：`paste`（粘贴登录态）与 `capture`（服务端浏览器登录后自动抓取）
        // 是同一条流程的两个入口 —— 抓取面板里本来就带着粘贴框兜底
        // （见下方 addMode === "paste" 分支的 canCapture 块）。
        // 早先的接入方式（Kimi / DeepSeek）只用 paste 一个模式，面板里自带抓取按钮；
        // 后来给 MiMo / MiniMax / StepFun 写成了 ["paste","capture"]，
        // 导致弹窗里裂出「粘贴登录态」「浏览器登录」两个按钮，
        // 而 capture 那个**前端根本没有对应的渲染分支 → 点进去是空白表单**（用户实测反馈）。
        // 现在统一成一个入口：能抓取的方式直接叫「浏览器登录」（主路径就是它）。
        // `capture` 与 `browser` 都过滤掉：它们代表**服务器浏览器**登录，那条路已删除
        //（用户：「卡的不行、吃服务器内存，根本用不着」）。
        // 按厂商是否声明过它们来分裂 tab，正是「有的厂商一个 tab、有的两个 tab」
        // 的根源（豆包/GLM/通义写了 ["browser","paste"] 就多出一个）。
        // 现在所有网页渠道统一只出一个「本机浏览器登录」入口。
        // 后端 channel-types 里这几家的 loginModes 也已收敛为 ["paste"]。
        const modes = (m.loginModes || []).filter((x) => x !== "capture" && x !== "browser");
        const effective = modes.length ? modes : ["paste"];
        for (const lm of effective) {
          const canGrab = Boolean(m.canCapture || m.entryUrl);
          out.push({
            // id 必须带 method 前缀：同一厂商出现多个 paste 方式时不能撞车
            id: `${m.key}:${lm}`,
            method: m.key, // relay / codex / claude-oauth / antigravity / kiro
            mode: lm,
            // 标签不要一律叫「粘贴凭据」—— 同一厂商有多个订阅/反代方式时
            // （Anthropic 下同时有 Claude 订阅与 Kiro 反代）会出现两个同名标签，
            // 用户根本分不清该选哪个。用方法名区分，并标注支持一键绑定。
            //
            // 同一厂商有**多个 password 方式**时（OpenAI 下有「浏览器驱动」，
            // 未来还可能加别的）也必须区分开：它们的凭据字段完全不同，
            // 都叫「账号密码」会让人选错。needs2fa 的方式带上自己的方法名。
            //
            // **browser 与 paste 必须给不同标签**（实测坑）：网页反代类渠道现在
            // 同时提供两条路 —— 服务器浏览器（自动抓取）与本机浏览器（登录后粘贴
            // 登录态）。两者以前都渲染成「浏览器登录」，同一厂商裂出两个同名按钮，
            // 用户点哪个都像撞运气。现在按「谁在跑浏览器」明确区分。
            // 标签口径（统一规范）：
            //   · OAuth 订阅 → 「方法名（粘贴凭据）」或方法名
            //   · 账号密码   → 「账号密码」，带 2FA 的加上方法名
            //   · 其余网页反代 → **一律「本机浏览器登录」**
            //     （服务器浏览器那条已删除，不再有「粘贴登录态」这种要用户自己
            //      判断该粘什么的名字 —— 面板里会给分步指引）
            label: m.oauth
              ? `${methodShortName(m)}${lm === "paste" ? "（粘贴凭据）" : ""}`
              : lm === "password"
                ? m.needs2fa
                  ? `${methodShortName(m)}（账号密码）`
                  : "账号密码"
                : "本机浏览器登录",
            hint: supportsDeviceBindMethod(m.key) ? "支持一键绑定" : "",
          });
        }
      }
    }
    return out;
  }, [pickProvider]);

  // API Key 型：看后端标记（覆盖 OpenCode GO / 自定义 Anthropic 兼容等非 "api" 的 key）
  const isApi = Boolean(pickMethod?.apiKey) || pickMethod?.key === "api";
  // 当前选中的**接入方式**是否支持一键绑定（设备授权）。
  //
  // 注意必须看 method.key 而不是 provider.key：Kiro 挂在 anthropic 厂商下，
  // provider.key 是 "anthropic"，只有 method.key 才是 "kiro"。
  // 后端 /channel/devices/vendors 返回的正是 method key（kiro/workbuddy/qoder）。
  //
  // 放在 isApi 之后声明：它依赖 pickMethod，而这段代码在渲染期立即求值 ——
  // 放在前面会踩 const 暂时性死区（本项目因此白屏过，见 AI协作.md 2.7 第 ④ 条）。
  const deviceBindSupported = Boolean(pickMethod && deviceBindVendors.includes(pickMethod.key));
  // 非 API 的接入方式（relay 反代 / 订阅 OAuth）走同一套「凭据登录」提交流程
  const isRelay = Boolean(pickMethod) && !isApi;

  // 当前选中的凭据项（注意：必须放在 isApi 声明之后，否则 const 的暂时性死区会直接白屏）
  // 当前选中的凭据项 id，必须与 credOptions 里生成的 `o.id` **完全一致**。
  //
  // 踩过的坑：这里曾对 API Key 型硬编码返回 "api"，而选项 id 是 `m.key`
  // —— 当厂商有多个 API Key 型方式时（OpenCode 的 Zen="api" 与 GO="go"），
  // GO 那个按钮的 value 永远匹配不上选中态，**点了没有任何反应**
  // （Radio.Group 的 value 不匹配 → 视觉上不切换、也不触发 onChange 的场景）。
  // 现在统一用 pickMethod.key，与生成侧同源。
  const credId = pickMethod ? (isApi ? pickMethod.key : `${pickMethod.key}:${addMode}`) : "";

  // ---------- 添加 ----------
  const openAdd = () => {
    setPickProvider(null);
    setPickMethod(null);
    setAddMode("password");
    setOauthUrl("");    setOauthState("");
    addForm.resetFields();
    setAddOpen(true);
  };

  const chooseProvider = (p) => {
    setPickProvider(p);
    const mKey = p.defaultMethod || p.methods[0].key;
    applyMethod(p, p.methods.find((m) => m.key === mKey));
  };

  // 从已加载的厂商表里取「获取 Key」地址（编辑弹窗只有 type，没有 provider 对象）
  const keyUrlOf = (type) => providers.find((p) => p.key === type)?.keyUrl || "";

  /** 取某渠道某模型的「厂商单价」（后端随 upstream-models 一起下发） */
  const pricesFor = (channelId, model) => upstreamPrices[channelId]?.[model] || null;

  // 额度单位换算（1 OD = 10000 units，全站唯一口径）
  const perUnit = unitsPerOd(status);

  /**
   * 该渠道的消费单位 —— 决定额度列上「总消费」那个 tag 用什么图标。
   *
   * 判据是**接入方式/厂商的计费形态**，不是模型：
   *   · WorkBuddy 等积分制（上游 config 里带 credits 倍率）→ 积分
   *   · 其余走货币 → OD 币（平台统一记账单位）
   * 这与「模型列悬浮里显示的厂商单价」是同一套口径，
   * 避免同一页面出现「模型写积分、汇总写 OD 币」的自相矛盾。
   */
  const costUnitOf = (r) => (String(r.type || "") === "workbuddy" ? "credits" : "od");

  /**
   * 格式化消费额：积分制显示原始数值 + 「积分」，货币制换算成 OD 币。
   * 注意 units 是平台的**额度单位**（1 OD = 10000 units），
   * 而积分制渠道的 units 语义就是积分本身（上游按 credits 计），不做换算。
   */
  const fmtCost = (r, units) => {
    const v = Number(units) || 0;
    if (costUnitOf(r) === "credits") return `${v}`;
    // 货币制：按 OD 币展示（与用户余额、定价页同一单位）
    const od = odOf(v, perUnit);
    if (od === 0) return "0";
    if (od >= 1000) return `${(od / 1000).toFixed(1)}k`;
    if (od >= 1) return od.toFixed(2);
    // 小额（<1 OD）保留有效数字而不是固定 4 位小数：
    // 0.0001 OD 这种写法读起来没有信息量，改成「<0.01」更诚实（精确值在悬浮里）。
    if (od >= 0.01) return od.toFixed(3);
    return "<0.01";
  };

  const applyMethod = (p, m, forceMode = null) => {
    if (!m) return;
    setPickMethod(m);
    // 换厂商/换凭据方式时清掉上一轮残留，避免把 A 的登录结果带给 B
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
    // API Key 型方式自带的地址直接预填（OpenCode Zen/GO、自定义厂商等）
    if (m.baseUrl) init.base_url = m.baseUrl;
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
          // 2FA 密钥（仅 needs2fa 的接入方式会填）：后端据此算动态码
          if (v.totpSecret) payload.totpSecret = v.totpSecret;
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
          // **已完成一键绑定/一键登录时不能再要求凭据**。
          // 那条路径的凭据由服务端在授权回调里拿到，提交后经 /channel/devices/claim
          // 写进刚建好的渠道。原实现把这条校验放在票据检查之前，于是用户明明看到
          // 「授权成功」，点「添加」却仍被要求粘贴 JSON —— 而那份 JSON 用户根本不用准备。
          // 带着票据提交：后端据此跳过「凭据导入」（凭据在服务端，用户手里没有 JSON）
          if (bindTicketRef.current) payload.bindTicket = bindTicketRef.current;
          if (pickMethod.oauth && !token && !bindTicketRef.current) {
            throw new Error(
              "请粘贴凭据 JSON、填写 Access/Refresh Token、导入凭据文件，或先用上方的「一键登录 / 一键绑定」完成授权"
            );
          }
          payload.token = token;
          payload.cookies = v.cookies;
        }
        const r = await API.post("/channel/login", payload, { timeoutMs: 90_000 });
        // 一键绑定：授权已成功但当时还没渠道，现在把暂存的凭据写进刚建的渠道。
        // 必须在 login 之后 —— 凭据要落到真实渠道 id 上。
        if (bindTicketRef.current && r?.id) {
          try {
            await API.post("/channel/devices/claim", { ticket: bindTicketRef.current, channel_id: r.id });
            message.success(`渠道「${r.name}」已添加并完成账号绑定`);
          } catch (err) {
            // 绑定失败不影响渠道本身：渠道已建好，用户可重新点「一键绑定」
            message.warning(`渠道已添加，但绑定失败：${err.message}。可在渠道列表点「重新绑定」`);
          }
          bindTicketRef.current = "";
        } else {
          message.success(`渠道「${r.name}」已添加`);
        }
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
      // 检测超时（秒）：0/空 = 用默认预算（普通 90s、浏览器渠道 240s）。
      // 慢模型（大档位思考久）在这里单独放宽，否则每次检测都报超时。
      probe_timeout_sec: Number(r.probe_timeout_sec) || 0,
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
        probe_timeout_sec: Number(v.probe_timeout_sec) || 0,
        // 账号级参数（并发/限速/指纹/计费口径）
        concurrency: Number(v.concurrency) || 0,
        // 空值 / 0 一律提交 0（= 用服务端默认），**不要**在前端把它翻成某个具体数字：
        // 用户留空的意思是「不知道填多少，用默认」，服务端默认（min_gap 1200ms）才是权威。
        // 这里曾经把空提交成 0，而服务端旧代码把 0 当「不限间隔」照单放行 ——
        // 线上 WorkBuddy 就是这样把 20 条探测在同一秒打完、被上游回了 429 的。
        // 服务端现已改成 0/未设都回落默认，这里保持「0 = 用默认」这一个含义即可。
        min_gap_ms: Number(v.min_gap_ms) || 0,
        max_per_min: Number(v.max_per_min) || 0,
        fingerprint_mode: v.fingerprint_mode || "stable",
        context_billing: v.context_billing || "auto",
        namespace: String(v.namespace || "").trim(),
      };
      // 只有 API 渠道有 Base URL（反代/订阅不展示也不提交，避免把空串写回）
      if (editing.isApiKey) payload.base_url = v.base_url;
      // status 只在开关真正变化时提交：服务端收到 status 会清冷却/重置运行状态，
      // 只改备注不该顺手把「冷却中」的渠道重置。
      const nextStatus = v.status ? 1 : 2;
      if (nextStatus !== editing.status) payload.status = nextStatus;
      if (editing.isApiKey && v.api_key) payload.api_key = v.api_key;
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
      // 报首 Token 与总耗时两个数：管理员据此判断慢在「连不上」还是「生成久」
      if (res?.success) {
        message.success(
          res.total && res.total !== res.time
            ? `「${r.name}」可用（首Token ${res.time}ms / 总 ${res.total}ms）`
            : `「${r.name}」可用（${res.time}ms）`
        );
      }
      else message.warning(res?.message || "测试失败");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setTestingId(null);
    }
  };

  /**
   * 点状态列直接启停（用户要求：「状态列应该是一个按钮，点击能直接设定启用和暂停」）。
   *
   * 走批量 enable/disable 而不是 PUT：它们已经处理好了「启用时清冷却、清 last_error」
   * 这类副作用（见 routes/channel.js 的 batch 分支），PUT 只改字段不做这些收尾。
   */
  const doToggleStatus = async (r, nextActive) => {
    if (actionBusyId) return;
    setActionBusyId(r.id);
    try {
      await API.post("/channel/batch", { ids: [r.id], action: nextActive ? "enable" : "disable" });
      message.success(nextActive ? `「${r.name}」已启用` : `「${r.name}」已暂停`);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActionBusyId(null);
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

  /** 取授权地址并返回（**不自己开窗**）：由调用方决定用哪种窗口打开 */
  const startOAuth = async () => {
    const type = pickProvider?.key;
    if (!type) return "";
    setOauthBusy(true);
    try {
      const r = await API.post("/channel/oauth/start", { type });
      setOauthUrl(r.url);
      setOauthState(r.state || "");
      // 这里**不再** window.open：调用方统一用弹窗小窗打开。
      // 两处都开会让用户看到两个窗口（一个多余），且绕过弹窗尺寸设置。
      return r.url;
    } catch (e) {
      // 未配置 OAuth 客户端等：说清怎么解决，而不是只丢报错
      message.error(e.message || "发起登录失败");
      return "";
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

  /**
   * 一键绑定（设备授权）：Kiro / WorkBuddy / Qoder。
   *
   * 与 Grok 设备码的区别：这几个渠道的凭据**由服务端直接写入渠道**，
   * 不回填表单 —— 因为产出的是完整账号凭据（refresh_token 等），
   * 不该经过浏览器。所以流程是「绑定成功后直接刷新渠道列表」。
   */
  const startBind = async () => {
    if (!pickProvider) return;
    setOauthBusy(true);
    try {
      const r = await API.post("/channel/devices/start", {
        vendor: pickMethod.key,
        start_url: addForm.getFieldValue("bind_start_url") || undefined,
        region: addForm.getFieldValue("bind_region") || undefined,
        realm: addForm.getFieldValue("bind_realm") || undefined,
      });
      setBindInfo({ ...r, status: "pending" });
      // 有链接就自动打开新窗口（用户不用手抄）
      if (r.verifyUrl) window.open(r.verifyUrl, "_blank", "noopener");
      if (bindTimerRef.current) clearInterval(bindTimerRef.current);
      const iv = Math.max(2, Number(r.intervalMs) / 1000 || 3) * 1000;
      const deadline = Date.now() + Math.min(900, Number(r.expiresIn) || 900) * 1000;
      bindTimerRef.current = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(bindTimerRef.current);
          bindTimerRef.current = null;
          setBindInfo((d) => (d ? { ...d, status: "expired", error: "授权超时，请重新发起" } : d));
          return;
        }
        try {
          const p = await API.post("/channel/devices/poll", {
            session_id: r.sessionId,
            vendor: pickMethod.key,
            channel_id: bindTargetChannelId || undefined,
          });
          if (p.status === "pending") {
            setBindInfo((d) => (d ? { ...d, status: "pending" } : d));
            return;
          }
          clearInterval(bindTimerRef.current);
          bindTimerRef.current = null;
          if (p.status === "success") {
            if (p.ticket) {
              // 还没有渠道（新建流程）：先把 ticket 记下，等提交后 claim
              bindTicketRef.current = p.ticket;
              setBindInfo((d) => (d ? { ...d, status: "ready", ticket: p.ticket } : d));
              message.success("授权成功，点「添加」完成绑定");
            } else {
              setBindInfo((d) => (d ? { ...d, status: "success", account: p.account } : d));
              message.success(`绑定成功${p.account ? `（${p.account}）` : ""}，凭据已写入渠道`);
              setAddOpen(false);
              load();
            }
            return;
          }
          setBindInfo((d) => (d ? { ...d, status: p.status, error: p.message || "" } : d));
        } catch (e) {
          clearInterval(bindTimerRef.current);
          bindTimerRef.current = null;
          setBindInfo((d) => (d ? { ...d, status: "error", error: e.message } : d));
        }
      }, iv);
    } catch (e) {
      message.error(e.message);
    } finally {
      setOauthBusy(false);
    }
  };

  const cancelBind = () => {
    if (bindTimerRef.current) clearInterval(bindTimerRef.current);
    bindTimerRef.current = null;
    if (bindInfo?.sessionId) API.post("/channel/devices/cancel", { session_id: bindInfo.sessionId }).catch(() => {});
    setBindInfo(null);
  };

  /**
   * 在**用户自己的浏览器**里弹出一个小窗打开登录页。
   *
   * 为什么是小窗而不是新标签：用户明确要求「应该是弹出用户浏览器的小窗口啊」——
   * 小窗（带尺寸的 window.open）能让人一眼看出「这是登录流程的一部分」，
   * 而不是混在一堆标签里找不着；登录完关掉即可，不污染浏览习惯。
   *
   * 为什么**不能**自动把凭据抓回来（这点必须说清楚，不能让用户以为能）：
   * 浏览器同源策略禁止一个站点读取**另一个站点**的 localStorage / cookie。
   * 任何网站都做不到 —— 不是本平台没实现。所以流程是「小窗里登录 →
   * 回到本页按指引复制一次」。真正能全自动的只有 OAuth 回调类
   * （走「粘贴回调地址」那条路），因为授权页会把 code 交给我们自己的回调地址。
   */
  const openLocalLoginWindow = (url) => {
    if (!url) return;
    // 尺寸取常见登录窗大小：够放二维码/验证码，又不至于全屏
    const w = Math.min(520, Math.max(380, Math.round(window.screen.availWidth * 0.42)));
    const h = Math.min(760, Math.max(520, Math.round(window.screen.availHeight * 0.78)));
    const left = Math.max(0, Math.round(window.screen.availWidth / 2 - w / 2));
    const top = Math.max(0, Math.round(window.screen.availHeight / 2 - h / 2));
    const features = `popup=yes,width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`;
    const win = window.open(url, "ooapi-local-login", features);
    if (!win) {
      // 被拦截时不能静默失败：给一条可点的链接兜底
      message.warning("浏览器拦截了弹窗，请允许本站弹窗后重试，或手动打开：" + url);
    }
    return win;
  };


  // 卸载时清掉设备码轮询
  useEffect(
    () => () => {
      if (deviceTimerRef.current) clearInterval(deviceTimerRef.current);
    },
    []
  );


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

  // 上游模型探测：非 API 的反代/订阅渠道没法问「你有哪些模型」，只能让适配器去上游查一次。
  // 结果缓存在内存（不落库）：它是「账号当前"实际"能用什么」的实时快照，
  // 与渠道声明的 model 范围是两件事（后者是管理员限定的范围）。
  //
  // ⚠️ 这三个声明必须在 `columns` **之前**：columns 是数组字面量，
  // 其中 `title` 里的 `{upstreamModelsBusy ? ... : ...}` 在数组创建时就会求值。
  // 若把 useState 放在 columns 之后，会命中 const 的暂时性死区（TDZ）：
  // 运行期抛 "Cannot access 'X' before initialization" → 整个页面白屏，
  // 而 vite build 是成功的（它不做这种顺序检查），只有真打开页面才会暴露。
  const [upstreamModels, setUpstreamModels] = useState({});
  // 该厂商自己的模型单价（积分制的显示积分，货币制的显示金额）——
  // 与平台定价无关，只是「这个模型对当前厂商消费多少」。
  const [upstreamPrices, setUpstreamPrices] = useState({});
  const [upstreamModelsBusy, setUpstreamModelsBusy] = useState(false);
  const refreshAllUpstreamModels = async () => {
    if (upstreamModelsBusy) return;
    // 探测上游模型：所有非 API Key 型渠道（反代/订阅）都能探测
    const targets = items.filter((r) => !r.isApiKey);
    if (!targets.length) return message.info("当前没有可探测的反代/订阅渠道");
    setUpstreamModelsBusy(true);
    const hide = message.loading(`正在从上游探测 ${targets.length} 个渠道的模型…`, 0);
    try {
      const results = await Promise.allSettled(
        targets.map((r) => API.post(`/channel/${r.id}/upstream-models`, undefined, { timeoutMs: 90_000 }))
      );
      const next = { ...upstreamModels };
      let okCount = 0;
      const nextPrices = { ...upstreamPrices };
      results.forEach((res, i) => {
        if (res.status === "fulfilled" && Array.isArray(res.value?.models)) {
          next[targets[i].id] = res.value.models;
          if (res.value.prices) nextPrices[targets[i].id] = res.value.prices;
          if (res.value.models.length) okCount += 1;
        }
      });
      setUpstreamModels(next);
      setUpstreamPrices(nextPrices);
      message.success(`探测完成：${okCount}/${targets.length} 个渠道返回了模型列表`);
    } finally {
      hide();
      setUpstreamModelsBusy(false);
    }
  };

  // ---------- 表格列 ----------
  const columns = [
    { title: "ID", dataIndex: "id", width: 60, render: (v) => <span className="oo-num" style={{ color: "var(--ink-3)" }}>{v}</span> },
    {
      title: "名称",
      dataIndex: "name",
      width: 160,
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
      title: "最近调用",
      dataIndex: "recent",
      width: 150,
      render: (list) => <UptimeBars calls={list} onCopy={copyCallResult} />,
    },
    {
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          模型
          {upstreamModelsBusy ? (
            <Spin size="small" />
          ) : (
            <Tooltip title="获取该账号真实可用的模型">
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
        const merged = probed.length ? probed : own;
        if (!merged.length) {
          return <Text type="secondary" style={{ fontSize: 12 }}>未探测</Text>;
        }
        return (
          <Tooltip
            title={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 11, color: "#aaa" }}>
                  {probed.length ? `上游实际可用：${probed.length} 个` : `共 ${own.length} 个`}
                </div>
                {/* 每个模型后面标出**该厂商自己的单价**（用户要求）。
                    注意这是厂商口径、不是平台定价：
                    WorkBuddy 是积分制就显示积分（credits），
                    走货币的显示金额；拿不到价格的模型不显示这一栏。 */}
                {merged.map((m) => {
                  const pr = pricesFor(r.id, m);
                  return (
                    <div key={m} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                      <ModelLabel model={m} size={13} channelType={r.type} />
                      {pr ? (
                        <span style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                          {pr.unit === "credits" ? <ThunderboltOutlined style={{ marginInlineEnd: 3 }} /> : null}
                          {pr.text}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            }
          >
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap", overflow: "hidden" }}>
              {merged.slice(0, 2).map((m) => <ModelLabel key={m} model={m} size={14} channelType={r.type} />)}
              {merged.length > 2 ? <span className="bui-chip">+{merged.length - 2}</span> : null}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "额度",
      dataIndex: "quota",
      // 额度列承载三块内容（用户要求，2026-09-22）：
      //   ① 统计 tag：调用次数 / 总 token / 总消费（三个纯数字，不写标题文字，
      //      靠图标与单位区分：token 带 k/M/B，消费带 OD 币或积分图标）
      //   ② 汇总 chips（套餐 / 余额 / 积分包），横向排布、超出收 +N
      //   ③ 窗口额度条，同样横向排布、超出收 +N
      // 列宽因此给到 240，否则三块挤在一起会频繁触发 +N。
      width: 240,
      render: (q, r) => {
        // 统计数字来自后端批量聚合（row.totals，一次查询算全部渠道，避免 N+1）。
        // 消费单位取决于该渠道**实际走什么**：积分制渠道（WorkBuddy 等）显示积分，
        // 其余显示 OD 币 —— 与模型单价的单位判定同源，避免一页两种口径。
        const t = r.totals;
        const stats = t
          ? { calls: t.calls, tokens: t.tokens, costUnit: costUnitOf(r), costText: fmtCost(r, t.units) }
          : null;
        // 上游 429 的提示行（用户要求）：「如果哪个渠道报错 429…在额度的余额那一行
        // tag 的下面新起一行，用橙黄色显示 上游 429，预计恢复时间 xxx」。
        // 放在 stats 之前渲染成独立一行，不受额度快照有没有取到影响 ——
        // 限流是**当下正在发生的事**，比额度数字更该先被看到。
        const rateLimitRow = <RateLimitRow r={r} />;
        if (q?.windows?.length || q?.credits || stats) {
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <QuotaInline quota={q} stats={stats} />
              {rateLimitRow}
            </div>
          );
        }
        if (r.quota_supported) {
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
                点击查询
              </span>
              {rateLimitRow}
            </div>
          );
        }
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>不支持</Text>
            {rateLimitRow}
          </div>
        );
      },
    },
    { title: "状态", dataIndex: "status", width: 128, render: (_, r) => <StatusCell r={r} onToggle={doToggleStatus} busy={actionBusyId === r.id} /> },
    {
      title: "凭据",
      width: 126,
      render: (_, r) => {
        if (!r.has_credential) {
          return <span className="bui-chip bui-chip--orange"><InfoCircleOutlined /> 未配置</span>;
        }
        const isApi = Boolean(r.isApiKey);
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
      width: 180,
      render: (list) => {
        const gs = Array.isArray(list) ? list : [];
        // 渠道不绑分组是**合法**的（渠道可以不属于任何分组，只对绑了同名分组的密钥可见）。
        // 这里显示「全域」而不是「公共」：它描述的是「这些渠道对绑了分组的密钥都不开放」，
        // 而不是某个叫「公共池」的东西（那个概念已废弃）。
        if (!gs.length) return <Text type="secondary" style={{ fontSize: 12 }}>未绑定分组</Text>;
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
            {gs.map((g) => (
              <GroupTag key={g} name={g} meta={groups.find((x) => x.name === g)} />
            ))}
          </div>
        );
      },
    },
    {
      // 累计调用次数**不再放这里** —— 已移到额度列的统计 tag 里
      // （用户要求：次数/token/消费三个数字贴在额度条上方，与渠道统计归在一处）。
      // 这一列只留调度参数，名字也收窄成「优先级 / 权重」。
      title: "优先级 / 权重",
      width: 110,
      sorter: (a, b) => (a.priority || 0) - (b.priority || 0),
      render: (_, r) => (
        <Tooltip title={`优先级: ${r.priority ?? 0} · 调度权重: ${r.weight ?? 0}`}>
          <span className="oo-num" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
            {r.priority ?? 0}
            <span style={{ color: "var(--ink-3)", margin: "0 2px" }}>/</span>
            {r.weight ?? 0}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "响应",
      dataIndex: "response_time",
      width: 94,
      render: (v, r) => {
        if (!r.tested_time) return <Text type="secondary" style={{ fontSize: 12 }}>未测</Text>;
        // 展示**首 Token 耗时**（ttft_ms），总耗时放悬浮里。
        // 用户实测反馈：「测测 Gemini 是不是根据首 t 来判定的检测时间？为什么响应时间这么长？」
        // 以及「GLM 响应很慢但人家一直在思考，思考的首 t 也算首 t 吧？」——
        // 首字到达才是体感上的「响应」，总耗时把整段生成/思考都算进去了。
        const ttft = Number(r.ttft_ms) || Number(v) || 0;
        const total = Number(v) || 0;
        return (
          <Tooltip title={total && total !== ttft ? `首 Token ${ttft}ms ｜ 总耗时 ${total}ms（含全部生成/思考）` : ""}>
            <span className="oo-num" style={{ color: ttft > UPTIME_SLOW_MS ? "var(--orange)" : "var(--ink)" }}>
              {ttft ? `${ttft}ms` : "-"}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "操作",
      width: 150,
      fixed: "right",
      render: (_, r) => renderActions(r),
    },
  ];

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
      // 默认选推荐方式（列表第一个）。后端已把「本机浏览器登录后粘贴」排在前面 ——
      // 它不起服务器浏览器、更快，也不容易触发风控。
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

  // 一键绑定（设备授权）找回：发起 → 轮询 → 成功后由服务端直接写回该渠道。
  // 与 Grok 设备码的区别：这里不回填表单，凭据不经浏览器（服务端收到即落库）。
  const reloginBindStart = async () => {
    setReloginBusy(true);
    try {
      const r = await API.post("/channel/devices/start", {
        vendor: reloginTarget.type,
        start_url: reloginBindStartUrl || undefined,
        region: reloginBindRegion || undefined,
        realm: reloginBindRealm || undefined,
      });
      setReloginDevice({ ...r, status: "pending" });
      if (r.verifyUrl) window.open(r.verifyUrl, "_blank", "noopener");
      if (reloginTimerRef.current) clearInterval(reloginTimerRef.current);
      const iv = Math.max(2, Number(r.intervalMs) / 1000 || 3) * 1000;
      const deadline = Date.now() + Math.min(900, Number(r.expiresIn) || 900) * 1000;
      reloginTimerRef.current = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(reloginTimerRef.current);
          reloginTimerRef.current = null;
          setReloginDevice((d) => (d ? { ...d, status: "expired", error: "授权超时，请重新发起" } : d));
          return;
        }
        try {
          const p = await API.post("/channel/devices/poll", {
            session_id: r.sessionId,
            vendor: reloginTarget.type,
            channel_id: reloginTarget.id, // 直接落到该渠道
          });
          if (p.status === "pending") return;
          clearInterval(reloginTimerRef.current);
          reloginTimerRef.current = null;
          if (p.status === "success") {
            message.success(`绑定成功${p.account ? `（${p.account}）` : ""}，凭据已更新`);
            closeRelogin();
            await load();
            return;
          }
          setReloginDevice((d) => (d ? { ...d, status: p.status, error: p.message || "" } : d));
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

  // 上游模型探测的 state 与刷新函数已上移到 `columns` 之前（见那里的注释：
  // columns 会立即求值，放后面会触发 TDZ 白屏）。这里不再重复声明。

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
      {/* 「重新登录 / 找回凭据」只在**渠道真的有问题**时才显示。
          用户反馈：渠道一切正常时也挂着这个按钮，纯属噪音 ——
          它是个"修复"入口，不是常用操作。
          判定「需要找回」：最近一次错误是认证类（needsRelogin，后端已按
          AUTH/401/403/失效/过期 判定），或渠道处于禁用/冷却中。 */}
      {r.canRecover !== false && !r.isApiKey && (r.needsRelogin || r.status !== 1 || r.cooling) ? (
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
      {/* 注：这里原有「浏览器登录」按钮（服务器浏览器里打开登录页）。
          该链路已整体删除 —— 这类渠道改用「重新登录」里的
          「本机浏览器登录 + 粘贴凭据」，不占服务器资源。 */}
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
                  <StatusCell r={r} onToggle={doToggleStatus} busy={actionBusyId === r.id} />
                </div>
                <div className="oo-channel-card-meta">
                  <span className="bui-chip">{r.typeName}</span>
                  <span className="bui-chip" title={r.methodLabel}>
                    {r.isApiKey ? (r.key_count > 1 ? `${r.key_count} 个 Key` : "Key") : "账号"}
                  </span>
                  <span className="bui-chip" title={(r.groups || []).join("、")}>
                    {Array.isArray(r.groups) && r.groups.length ? r.groups[0] : "未分组"}
                  </span>
                </div>
                <div className="oo-channel-card-models">
                  <Tooltip
                    title={
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {(r.models || []).map((m) => <ModelLabel key={m} model={m} size={13} channelType={r.type} />)}
                      </div>
                    }
                  >
                    <span style={{ display: "flex", gap: 8, alignItems: "center", overflow: "hidden" }}>
                      {(r.models || []).length ? (
                        <>
                          {(r.models || []).slice(0, 3).map((m) => <ModelLabel key={m} model={m} size={14} channelType={r.type} />)}
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
            scroll={{ x: 1450 }}
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
                          <Radio.Button key={o.id} value={o.id}>
                            {o.label}
                            {/* 支持一键绑定的方式打标：用户一眼知道哪个不用手工找凭据文件 */}
                            {o.hint ? (
                              <span style={{ fontSize: 11, color: "var(--green)", marginLeft: 4 }}>· {o.hint}</span>
                            ) : null}
                          </Radio.Button>
                        ))}
                      </Radio.Group>
                    </Form.Item>
                  ) : null}

                  {isRelay ? (
                    <>
                      {addMode === "password" ? (
                        <>
                          <Form.Item
                            name="account"
                            label={pickMethod.needs2fa ? "邮箱" : "手机号 / 邮箱"}
                            rules={[{ required: true, message: "请填写账号" }]}
                          >
                            <Input placeholder="13800138000 或 you@example.com" autoComplete="off" />
                          </Form.Item>
                          <Row gutter={12}>
                            {!pickMethod.needs2fa ? (
                              <Col span={8}>
                                <Form.Item name="areaCode" label="区号"><Input placeholder="+86" /></Form.Item>
                              </Col>
                            ) : null}
                            <Col span={pickMethod.needs2fa ? 24 : 16}>
                              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请填写密码" }]}>
                                <Input.Password placeholder="账号密码" autoComplete="new-password" />
                              </Form.Item>
                            </Col>
                          </Row>
                          {/* 2FA 密钥（base32）——**不是** 6 位动态码。
                              6 位码每 30 秒变一次，存下来下次就失效；密钥可以重复算出验证码。 */}
                          {pickMethod.needs2fa ? (
                            <Form.Item
                              name="totpSecret"
                              label="2FA 密钥（两步验证）"
                              extra="验证器 App 里那串 base32 密钥（如 JBSWY3DPEHPK3PXP…），不是每隔 30 秒变的 6 位数字；账号未开两步验证则留空"
                            >
                              <Input.Password placeholder="留空表示账号未开两步验证" autoComplete="off" />
                            </Form.Item>
                          ) : null}
                        </>
                      ) : addMode === "paste" ? (
                        <>
                          {/* 网页反代渠道的登录：**只用本机浏览器**（服务器浏览器那条路已整体删除）。
                              
                              演进（用户三轮反馈，最终落在「删掉」）：
                                ① 「所有快捷登录你都是做的内置浏览器？这不是给服务器徒增压力吗」
                                ② 「本机浏览器应该是直接唤起用户当前浏览器的一个小窗啊，
                                    为什么要做文本让用户照着做？」
                                ③ 「那个服务器内部浏览器压根用不了你懂吗？卡的不行啊而且吃服务器
                                    内存和性能，这个逼玩意可以直接删了啊，根本用不着啊。」
                              于是现在是：点按钮 → 弹出一个浏览器小窗 → 按面板里的分步指引
                              登录并复制一次凭据。零服务器开销。
                              
                              为什么仍需「复制一次」而不能全自动：浏览器同源策略禁止读取
                              **其他站点**的 localStorage/cookie，任何网站都做不到。
                              真正能全自动的只有 OAuth 回调类（走「粘贴回调」那条路，
                              授权码交给我们自己的回调地址）。 */}
                          {pickMethod.localLogin ? (
                            <Form.Item label="登录（推荐：用你自己的浏览器）">
                              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                                <Space wrap>
                                  {pickMethod.entryUrl ? (
                                    <Button
                                      type="primary"
                                      icon={<GlobalOutlined />}
                                      onClick={() => openLocalLoginWindow(pickMethod.entryUrl)}
                                    >
                                      弹出登录小窗（{pickProvider?.name}）
                                    </Button>
                                  ) : null}
                                  {pickMethod.localLogin.snippet ? (
                                    <Button
                                      icon={<CopyOutlined />}
                                      onClick={() =>
                                        copyText(pickMethod.localLogin.snippet).then(
                                          () => message.success("取凭据代码已复制：登录后在浏览器控制台粘贴执行"),
                                          () => message.warning("复制失败，请手动选中下方代码复制")
                                        )
                                      }
                                    >
                                      复制「取凭据」代码
                                    </Button>
                                  ) : null}
                                </Space>
                                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.9 }}>
                                  {pickMethod.localLogin.steps
                                    // 第 1 步通常是「在打开的页面完成登录」—— 那句话由上面的按钮承担，
                                    // 不再重复列出（用户要求「不要干巴巴一堆文本」）
                                    .filter((t) => !/^在打开的页面/.test(t))
                                    .map((t, i) => (
                                      <li key={i}>{t}</li>
                                    ))}
                                </ol>
                                {pickMethod.localLogin.snippet ? (
                                  <div
                                    onClick={() =>
                                      copyText(pickMethod.localLogin.snippet).then(
                                        () => message.success("已复制"),
                                        () => message.warning("复制失败，请手动选中复制")
                                      )
                                    }
                                    style={{
                                      fontFamily: "var(--font-mono)",
                                      fontSize: 12,
                                      background: "var(--inset)",
                                      border: "1px solid var(--line)",
                                      borderRadius: "var(--r-sm)",
                                      padding: "7px 10px",
                                      cursor: "pointer",
                                      wordBreak: "break-all",
                                    }}
                                    title="点击复制"
                                  >
                                    {pickMethod.localLogin.snippet}
                                  </div>
                                ) : null}
                              </Space>
                            </Form.Item>
                          ) : null}
                          {/* 订阅 OAuth：两种登录方式。
                              · 一键登录：在服务器浏览器里打开官方授权页（截图操作），自动抓回调换 token；
                              · 手动：打开授权页面，把打不开的 localhost 回调地址复制回来。 */}
                          {pickMethod.oauth && oauthSupported ? (
                            <Form.Item label="登录账号（推荐）">
                              <Space wrap>
                                <Button
                                  type="primary"
                                  icon={<GlobalOutlined />}
                                  onClick={async () => {
                                    // 先向后端要授权地址，再在**本机浏览器小窗**里打开：
                                    // 登录后页面会跳到打不开的 localhost 回调地址（正常现象），
                                    // 把地址栏那串 URL 粘回来即可换到令牌 —— 这是唯一
                                    // 能真正全自动拿到凭据的路径（授权码交给我们自己的回调）。
                                    const url = await startOAuth();
                                    if (url) openLocalLoginWindow(url);
                                  }}
                                  loading={oauthBusy}
                                >
                                  弹出登录小窗（授权后粘回调）
                                </Button>
                                {oauthUrl ? (
                                  <Button type="link" onClick={() => openLocalLoginWindow(oauthUrl)} style={{ padding: 0 }}>
                                    小窗已关？重新打开
                                  </Button>
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
                          {/* 一键绑定（设备授权）：Kiro / WorkBuddy / Qoder。
                              这三个渠道原先只能手工粘贴桌面端登录文件 —— 对多数用户做不到。
                              设备授权把流程压成「点一下 → 打开链接确认 → 自动完成」。 */}
                          {deviceBindSupported ? (
                            <Form.Item label="一键绑定（推荐）">
                              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                                <Space wrap>
                                  <Button type="primary" icon={<LinkOutlined />} onClick={startBind} loading={oauthBusy}>
                                    {bindInfo ? "重新发起授权" : "一键绑定账号"}
                                  </Button>
                                  {bindInfo?.verifyUrl ? (
                                    <Typography.Link href={bindInfo.verifyUrl} target="_blank" rel="noreferrer">
                                      在新窗口打开授权页
                                    </Typography.Link>
                                  ) : null}
                                  {bindInfo ? (
                                    <Button size="small" type="link" onClick={cancelBind} style={{ padding: 0 }}>
                                      取消
                                    </Button>
                                  ) : null}
                                </Space>

                                {/* 用户码：Kiro 需要用户在授权页输入这串码 */}
                                {bindInfo?.userCode ? (
                                  <div
                                    style={{
                                      padding: "8px 12px",
                                      background: "var(--inset)",
                                      borderRadius: "var(--r-sm)",
                                      fontSize: 13,
                                    }}
                                  >
                                    在授权页输入代码：
                                    <b style={{ letterSpacing: 2, marginLeft: 6, fontSize: 16 }}>{bindInfo.userCode}</b>
                                  </div>
                                ) : null}

                                {/* 状态：轮询中/成功/失败/超时都要有明确文案 */}
                                {bindInfo ? (
                                  <span
                                    style={{
                                      fontSize: 12,
                                      color:
                                        bindInfo.status === "pending"
                                          ? "var(--ink-3)"
                                          : bindInfo.status === "ready" || bindInfo.status === "success"
                                            ? "var(--green)"
                                            : "var(--red)",
                                    }}
                                  >
                                    {bindInfo.status === "pending"
                                      ? "等待你在浏览器中确认授权…（完成后会自动继续）"
                                      : bindInfo.status === "ready"
                                        ? "授权成功，点下方「添加」完成绑定"
                                        : bindInfo.status === "success"
                                          ? `绑定成功${bindInfo.account ? `（${bindInfo.account}）` : ""}`
                                          : bindInfo.error || "授权未完成，请重新发起"}
                                  </span>
                                ) : null}

                                {/* 渠道特化输入：Kiro 的 region/startUrl、WorkBuddy/Qoder 的区域 */}
                                {pickMethod.key === "kiro" ? (
                                  <Space wrap>
                                    <Input
                                      name="bind_region"
                                      placeholder="区域（留空自动探测）"
                                      style={{ width: 200 }}
                                      onChange={(e) => addForm.setFieldValue("bind_region", e.target.value)}
                                    />
                                    <Input
                                      name="bind_start_url"
                                      placeholder="startUrl（留空用 Builder ID）"
                                      style={{ width: 280 }}
                                      onChange={(e) => addForm.setFieldValue("bind_start_url", e.target.value)}
                                    />
                                  </Space>
                                ) : null}
                                {pickMethod.key === "workbuddy" || pickMethod.key === "qoder" ? (
                                  <Select
                                    style={{ width: 200 }}
                                    placeholder="区域（默认国内）"
                                    allowClear
                                    onChange={(v) => addForm.setFieldValue("bind_realm", v)}
                                    options={[
                                      { value: "cn", label: "国内（CN）" },
                                      { value: "global", label: "国际（Global）" },
                                    ]}
                                  />
                                ) : null}

                                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                                  {pickMethod.key === "kiro"
                                    ? "走 AWS SSO OIDC 设备授权（官方标准流程）：打开链接输入验证码即可，无需手工找凭据文件"
                                    : pickMethod.key === "workbuddy"
                                      ? "打开链接登录 WorkBuddy/CodeBuddy 即可；设备风控头（X-Device-Token）无法服务端生成，需要时可在下面粘贴补充"
                                      : "打开链接登录 Qoder 即可；也可在下面粘贴 PAT（pt-...）作为兜底"}
                                </span>
                              </Space>
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
                      ) : null}
                    </>
                  ) : (
                    <>
                      {/* Base URL：接入方式自带地址时预填为默认值（如 OpenCode 的
                          Zen 与 GO 只是 path 前缀不同），用户不用手抄；仍可改写以适配自建/中转。
                          只有「自定义（通用兼容）」那种 baseUrl 为空的方式才要求必填。 */}
                      <Form.Item
                        name="base_url"
                        label="接口地址（Base URL）"
                        rules={pickMethod.baseUrl ? [] : [{ required: true, message: "请填写地址" }]}
                        extra={pickMethod.baseUrl ? "已按接入方式预填，可在需要时改成自建中转地址" : undefined}
                      >
                        <Input placeholder={pickMethod.baseUrl || "https://..."} />
                      </Form.Item>
                      <Form.Item
                        name="api_key"
                        label={
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            API Key
                            {/* 用户要求：标题旁给一个蓝色小字，点开就是该厂商获取 Key 的官方页面。
                                「XX 的 key 在哪」本来是每个人都要自己搜一次的事。 */}
                            {pickProvider?.keyUrl ? (
                              <a
                                href={pickProvider.keyUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                style={{ fontSize: 12, fontWeight: 400 }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                获取 Key ↗
                              </a>
                            ) : null}
                          </span>
                        }
                        rules={[{ required: true, message: "请填写 API Key" }]}
                      >
                        <Input.Password placeholder={pickMethod.keyHint || "填写上游 API Key"} autoComplete="new-password" />
                      </Form.Item>
                      </>
                  )}

                    <Form.Item
                      name="models"
                      label="模型范围"
                      // 不再强制必填：留空 = 该厂商全部已注册模型（后端同口径）。
                      // 原来要求「至少一个」会把「填 Key → 拉模型 → 保存」这条路堵死 ——
                      // 拉模型需要先有渠道，保存又要求先有模型，管理员无路可走（实测反馈）。
                    >
                      <ModelPicker
                        providerKey={pickProvider?.key}
                        baseUrl={addBaseUrl || ""}
                        apiKey={addApiKey || ""}
                      />
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
          {editing?.isApiKey ? (
            <Form.Item name="base_url" label="接口地址（Base URL）">
              <Input placeholder="https://..." />
            </Form.Item>
          ) : null}
          {editing?.isApiKey ? (
            <Form.Item
              name="api_key"
              label={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  API Key
                  {/* 编辑弹窗同样给「获取 Key」入口（与新建弹窗一致） */}
                  {keyUrlOf(editing?.type) ? (
                    <a
                      href={keyUrlOf(editing?.type)}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 12, fontWeight: 400 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      获取 Key ↗
                    </a>
                  ) : null}
                </span>
              }
            >
              <Input.Password placeholder="留空不修改" autoComplete="new-password" />
            </Form.Item>
          ) : null}
          <Form.Item
            name="models"
            label="模型范围"
            // 同上：编辑时也允许留空（= 全部模型），避免「想清空重新拉」被拦下
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
              <Form.Item
                name="probe_timeout_sec"
                label="检测超时（秒）"
                extra="0 或留空 = 默认（普通 90s、浏览器渠道 240s）；大模型思考久就调大，否则每次检测都会报超时"
              >
                <InputNumber style={{ width: "100%" }} min={0} max={1800} step={30} placeholder="默认" />
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
                extra="两次请求之间的最小间隔；0 = 用默认（1200ms）"
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

            {/* 本机浏览器登录 + 粘贴凭据：**推荐路径**。
                用户自己的浏览器多半已登录好，复制一串凭据即可 —— 不起服务器浏览器、
                不占资源、也不容易触发风控。服务器浏览器只在前者不可用时才需要
                （典型是 HttpOnly cookie：JS 读不到，服务器浏览器能自动读）。 */}
            {reloginMode === "paste" ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                {reloginLocalGuide?.entryUrl ? (
                  <Button
                    type="primary"
                    icon={<GlobalOutlined />}
                    onClick={() => window.open(reloginLocalGuide.entryUrl, "_blank", "noopener")}
                    block
                  >
                    打开 {reloginInfo?.typeName || ""} 登录页
                  </Button>
                ) : null}
                {reloginLocalGuide?.snippet ? (
                  <Button
                    icon={<CopyOutlined />}
                    onClick={() =>
                      copyText(reloginLocalGuide.snippet).then(
                        () => message.success("取凭据代码已复制：登录后在浏览器控制台粘贴执行"),
                        () => message.warning("复制失败，请手动选中下方代码复制")
                      )
                    }
                    block
                  >
                    复制「取凭据」代码
                  </Button>
                ) : null}
                {reloginLocalGuide?.steps?.length ? (
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.9 }}>
                    {reloginLocalGuide.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                ) : (
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                    用你自己电脑的浏览器登录上游，把登录态（token / cookie）复制过来即可。
                  </div>
                )}
                {reloginLocalGuide?.snippet ? (
                  <div
                    onClick={() =>
                      copyText(reloginLocalGuide.snippet).then(
                        () => message.success("已复制"),
                        () => message.warning("复制失败，请手动选中复制")
                      )
                    }
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      background: "var(--inset)",
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r-sm)",
                      padding: "7px 10px",
                      cursor: "pointer",
                      wordBreak: "break-all",
                    }}
                    title="点击复制"
                  >
                    {reloginLocalGuide.snippet}
                  </div>
                ) : null}
              </Space>
            ) : null}

            {/* 一键绑定（设备授权）：Kiro / WorkBuddy / Qoder 重新绑定已有渠道 */}
            {reloginMode === "device-bind" ? (
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Button type="primary" icon={<LinkOutlined />} onClick={reloginBindStart} loading={reloginBusy} block>
                  发起一键绑定
                </Button>
                {reloginDevice?.userCode ? (
                  <div style={{ fontSize: 13, padding: "6px 10px", background: "var(--inset)", borderRadius: "var(--r-sm)" }}>
                    在授权页输入代码：<b style={{ letterSpacing: 2 }}>{reloginDevice.userCode}</b>
                  </div>
                ) : null}
                {reloginDevice?.verifyUrl ? (
                  <Typography.Link href={reloginDevice.verifyUrl} target="_blank" rel="noreferrer">
                    在新窗口打开授权页
                  </Typography.Link>
                ) : null}
                {/* 渠道特化输入 */}
                {reloginTarget?.type === "kiro" ? (
                  <Space wrap>
                    <Input
                      placeholder="区域（留空自动探测）"
                      style={{ width: 180 }}
                      value={reloginBindRegion}
                      onChange={(e) => setReloginBindRegion(e.target.value)}
                    />
                    <Input
                      placeholder="startUrl（留空用 Builder ID）"
                      style={{ width: 260 }}
                      value={reloginBindStartUrl}
                      onChange={(e) => setReloginBindStartUrl(e.target.value)}
                    />
                  </Space>
                ) : null}
                {/* 区域只在**确实无法自动判定**时才问：
                    · Qoder 的区域决定 OAuth 端点与 client 参数，且拿不到 token 前无法推断 → 需要选；
                    · WorkBuddy 的区域可由凭据 JWT 的 `iss` 自动判定
                      （适配器 realmOf()），重新绑定时用户没必要再选一次 ——
                      而且选错会被网关 401（且极易被误判成 token 过期）。
                      这是用户反馈「绑定之后重新认证还让我选国内还是国际」的那处。 */}
                {reloginTarget?.type === "qoder" ? (
                  <Select
                    style={{ width: 180 }}
                    placeholder="区域（默认国内）"
                    allowClear
                    value={reloginBindRealm || undefined}
                    onChange={(v) => setReloginBindRealm(v || "")}
                    options={[
                      { value: "cn", label: "国内（CN）" },
                      { value: "global", label: "国际（Global）" },
                    ]}
                  />
                ) : null}
                {reloginDevice?.status === "pending" ? (
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>等待你在浏览器中确认授权…（完成后自动写入）</div>
                ) : null}
                {reloginDevice?.error ? <div style={{ fontSize: 12, color: "var(--red)" }}>{reloginDevice.error}</div> : null}
              </Space>
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
                    reloginInfo?.isApiKey
                      ? "API Key 渠道请关闭本弹窗，用「编辑」更换 Key"
                      : "粘贴官方凭据文件（JSON）/ 登录态（token、cookie 串）"
                  }
                  disabled={reloginInfo?.isApiKey}
                />
                <Button
                  type="primary"
                  loading={reloginBusy}
                  onClick={submitReloginText}
                  disabled={reloginInfo?.isApiKey}
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
                      if (r?.success) {
                        message.success(
                          r.total && r.total !== r.time
                            ? `渠道可用（首Token ${r.time}ms / 总 ${r.total}ms）`
                            : `渠道可用（${r.time}ms）`
                        );
                      }
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
