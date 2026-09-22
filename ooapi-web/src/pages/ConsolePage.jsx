// 数据看板 · 个人维度（/console）
// ---------------------------------------------------------------------------
// 为什么个人与管理端是**两个独立物理路由**（Gemini 第 7 点）：
//   · 权限边界：管理端涉及全站流水、渠道故障率、异常用户画像。
//     物理路由 + 路由守卫能从源头阻断非管理员的代码加载与接口嗅探；
//     做成同一页的 Tab 则「代码已加载、只是不显示」，边界靠前端 if 维持，很脆。
//   · 关注点不同：个人看「我花了多少、余额够撑几天、何时在用」；
//     管理看「渠道延迟、全站 QPS、哪个分组在被刷」。见 AdminDashboardPage。
//
// 图表一律走 components/Charts.jsx 与 .oo-chart-grid 多图并列网格：
// 单张大图信息密度极低，且要在口径间来回切换（用户明确反馈过）。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Segmented, Tag, Empty, Skeleton, App as AntApp, Tooltip, Alert } from "antd";
import {
  ReloadOutlined, KeyOutlined, CopyOutlined, ClockCircleOutlined, DashboardOutlined, WalletOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { LineChart, RankBar, Legend, SERIES_COLORS, fmtCompact, useResizeWidth } from "../components/Charts";
import { copyText, fmtOd, odRateText, unitsPerOd, CURRENCY_NAME } from "../services/format";

const RANGES = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
];

/** 图表卡：统一标题 + 右上口径说明 */
/** 图表卡：统一标题 + 右上口径说明。
 *  full = 跨满整行（主趋势图用）。不要用固定 span=2 ——
 *  网格列数是自适应的（宽屏 3~4 列），写死跨 2 列会留下尴尬的空位。 */
function ChartCard({ title, note, children, full }) {
  return (
    <div className="oo-chart-card" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <div className="oo-chart-card-head">
        <span className="oo-chart-card-title">{title}</span>
        {note ? <span className="oo-chart-card-note">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 按小时分布：0-23 的柱状（看个人作息与峰谷） */
function HourBars({ hours }) {
  const [wrapRef, W] = useResizeWidth(420);
  const H = 124;
  const PAD = { l: 34, r: 8, t: 8, b: 18 };
  const n = hours?.length || 0;
  if (!n) return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  const max = Math.max(1, ...hours.map((h) => Number(h.calls) || 0));
  const innerW = Math.max(10, W - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const bw = innerW / n;
  return (
    <div ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", maxWidth: "100%" }}>
        <line x1={PAD.l} y1={PAD.t + innerH} x2={W - PAD.r} y2={PAD.t + innerH} stroke="var(--line)" />
        {hours.map((h, i) => {
          const v = Number(h.calls) || 0;
          const bh = (v / max) * innerH;
          return (
            <Tooltip key={h.hour} title={`${h.hour}:00 · ${v} 次调用`}>
              <rect
                x={PAD.l + i * bw + 1}
                y={PAD.t + innerH - bh}
                width={Math.max(1, bw - 2)}
                height={Math.max(v ? 1 : 0, bh)}
                fill="var(--accent)"
                opacity={v ? 0.85 : 0.25}
                rx={1}
              />
            </Tooltip>
          );
        })}
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={PAD.l + h * bw + bw / 2} y={H - 5} textAnchor="middle" fontSize={9.5} fill="var(--ink-3)">
            {h}
          </text>
        ))}
        <text x={PAD.l - 5} y={PAD.t + 8} textAnchor="end" fontSize={9.5} fill="var(--ink-3)">{fmtCompact(max)}</text>
      </svg>
    </div>
  );
}

export default function ConsolePage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user, status } = useApp();
  const { begin, isLatest } = useLatest();
  const perUnit = unitsPerOd(status);

  const [range, setRange] = useState("30d");
  const [data, setData] = useState(null);
  const [community, setCommunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const endpoint = status?.api_endpoint || `${window.location.origin}/v1`;

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const [d, c] = await Promise.all([
        API.get("/dashboard/self", { params: { range } }),
        // 社区数据失败不影响看板主体（它不是核心指标）
        API.get("/dashboard/community", { params: { range } }).catch(() => null),
      ]);
      if (!isLatest(token)) return;
      setData(d);
      setCommunity(c);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "看板加载失败");
        message.error(e.message);
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, isLatest, message, range]);

  useEffect(() => {
    load();
  }, [load]);

  const copyEndpoint = async () => {
    try {
      await copyText(endpoint);
      message.success("接口地址已复制");
    } catch {
      message.error("复制失败，请手动选择复制");
    }
  };

  const t = data?.totals;
  const trend = data?.trend || [];
  const quota = data?.account?.quota ?? user?.quota ?? 0;
  const usedQuota = data?.account?.used_quota ?? user?.used_quota ?? 0;
  const totalQuota = quota + usedQuota;
  const usedPct = totalQuota > 0 ? (usedQuota / totalQuota) * 100 : 0;
  // 余额可用天数：按区间日均消费估算 —— 比单看「剩余额度」有用得多。
  //
  // 但**必须封顶**：余额大而消费极小时会算出「3365587 天」这种数字，
  // 不但没意义，还让整块看板显得不可信（实测被用户一眼看到）。
  // 超过 999 天就归入「>999」语义：那个量级下精确天数没有决策价值。
  const dailyAvg = trend.length ? (t?.units || 0) / trend.length : 0;
  const rawDaysLeft = dailyAvg > 0 ? Math.floor(quota / dailyAvg) : null;
  const daysLeft = rawDaysLeft === null ? null : Math.min(rawDaysLeft, 999);
  const daysLeftCapped = rawDaysLeft !== null && rawDaysLeft > 999;

  return (
    <div className="oo-page">
      <PageHeader
        title={`你好，${user?.display_name || user?.username}`}
        tags={
          <>
            <Tag icon={<DashboardOutlined />}>我的用量</Tag>
            {/* 时区必须显式声明：跨时区排查账单差异全靠它（Gemini 第 10 点） */}
            <Tooltip title="所有按天聚合以此为基准，与服务器时区一致（按天重置）">
              <Tag icon={<ClockCircleOutlined />}>时区 UTC+8</Tag>
            </Tooltip>
          </>
        }
        extra={
          <>
            <Segmented value={range} onChange={setRange} options={RANGES} />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load} title="刷新" aria-label="刷新看板" />
            <Button type="primary" icon={<KeyOutlined />} onClick={() => navigate("/token")}>管理令牌</Button>
          </>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="看板数据加载失败"
          description={loadError}
          action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
        />
      ) : null}

      {/* 汇总：紧凑统计卡（全站统一形态，一行放得下 7 张） */}
      <div className="oo-stats-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))" }}>
        <StatCard
          label="剩余额度"
          value={loading ? "—" : fmtOd(quota, perUnit, 2, false)}
          suffix={CURRENCY_NAME}
          tone={quota < 0 ? "danger" : undefined}
          hint={quota < 0 ? "已欠费，充值需大于欠费额才能恢复服务" : `共 ${fmtOd(totalQuota, perUnit, 2, false)} ${CURRENCY_NAME}`}
        />
        <StatCard
          label="已用额度"
          value={loading ? "—" : fmtOd(usedQuota, perUnit, 2, false)}
          suffix={CURRENCY_NAME}
          tone={usedPct >= 90 ? "danger" : usedPct >= 70 ? "warning" : undefined}
          hint={`占总额度 ${usedPct.toFixed(1)}%`}
        />
        <StatCard label="调用次数" value={loading ? "—" : fmtCompact(data?.account?.request_count ?? user?.request_count ?? 0)} suffix="次" hint="累计成功请求" />
        <StatCard
          label={`区间消费`}
          value={loading ? "—" : fmtOd(t?.units || 0, perUnit, 2, false)}
          suffix={CURRENCY_NAME}
          hint={`近 ${data?.range?.days || 30} 天 · 应按上游实际用量计费`}
        />
        <StatCard label="区间调用" value={loading ? "—" : fmtCompact(t?.calls || 0)} suffix="次" hint={`${trend.filter((d) => d.calls > 0).length} 天有调用`} />
        <StatCard
          label="缓存命中"
          value={loading ? "—" : `${t?.cache_rate ?? 0}%`}
          tone={(t?.cache_rate ?? 0) >= 50 ? "success" : undefined}
          hint={`命中 ${fmtCompact(t?.cache_tokens || 0)} · 未命中 ${fmtCompact(t?.uncached_tokens || 0)}`}
        />
        <StatCard
          label="余额可用"
          value={loading ? "—" : daysLeft === null ? "—" : daysLeftCapped ? "999+" : daysLeft}
          suffix={daysLeft === null ? "" : "天"}
          tone={daysLeft !== null && daysLeft < 7 ? "danger" : daysLeft !== null && daysLeft < 30 ? "warning" : undefined}
          hint={
            daysLeftCapped
              ? "按日均消费估算已超过 999 天，实际可视为余额充足"
              : "按区间日均消费估算（无消费则显示 —）"
          }
        />
      </div>

      {/* 多图并列：一屏看全，不用来回切口径 */}
      <div className="oo-chart-grid">
        <ChartCard title="调用与消费趋势" note={`近 ${data?.range?.days || 30} 天 · 双口径`} full>
          {loading && !trend.length ? (
            <Skeleton active paragraph={{ rows: 3 }} />
          ) : trend.length ? (
            <>
              <LineChart
                height={160}
                series={[
                  { name: "调用次数", values: trend.map((d) => ({ x: d.day, y: d.calls })), color: SERIES_COLORS[0] },
                  { name: `消费 (${CURRENCY_NAME})`, values: trend.map((d) => ({ x: d.day, y: Number((d.units / perUnit).toFixed(2)) })), color: SERIES_COLORS[2] },
                ]}
              />
              <Legend
                series={[
                  { name: "调用次数", color: SERIES_COLORS[0] },
                  { name: `消费 (${CURRENCY_NAME})`, color: SERIES_COLORS[2] },
                ]}
              />
            </>
          ) : (
            <Empty description="该时间范围内没有调用数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="Token 用量结构" note="输入 / 输出 / 缓存">
          {trend.length ? (
            <>
              <LineChart
                height={130}
                series={[
                  { name: "输入", values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })), color: SERIES_COLORS[0] },
                  { name: "输出", values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })), color: SERIES_COLORS[1] },
                  { name: "缓存命中", values: trend.map((d) => ({ x: d.day, y: d.cache_tokens })), color: SERIES_COLORS[5] },
                ]}
              />
              <Legend
                series={[
                  { name: "输入", color: SERIES_COLORS[0] },
                  { name: "输出", color: SERIES_COLORS[1] },
                  { name: "缓存命中", color: SERIES_COLORS[5] },
                ]}
              />
            </>
          ) : (
            <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="调用时段分布" note="0-23 点（看作息与峰谷）">
          <HourBars hours={data?.by_hour} />
        </ChartCard>

        <ChartCard title="模型消费排行" note={`Top 12 · 按消费 (${CURRENCY_NAME})`}>
          <RankBar items={(data?.by_model || []).map((m) => ({ name: m.model, value: Number((m.units / perUnit).toFixed(2)) }))} suffix={` ${CURRENCY_NAME}`} />
        </ChartCard>

        <ChartCard title="模型调用量" note="按次数">
          <RankBar items={(data?.by_model || []).map((m) => ({ name: m.model, value: m.calls }))} suffix=" 次" />
        </ChartCard>

        <ChartCard title="渠道分布" note={`按消费 (${CURRENCY_NAME})`}>
          <RankBar items={(data?.by_channel || []).map((c) => ({ name: `渠道 #${c.channel_id}`, value: Number((c.units / perUnit).toFixed(2)) }))} suffix={` ${CURRENCY_NAME}`} />
        </ChartCard>

        {community ? (
          <ChartCard title="我的社区与娱乐" note="点击可跳转">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8 }}>
              {[
                { label: "帖子", value: community.mine?.posts, to: `/u/${user?.id}` },
                { label: "获赞", value: community.mine?.likes_received },
                { label: "评论", value: community.mine?.comments },
                { label: "粉丝", value: community.mine?.followers, to: `/u/${user?.id}` },
                { label: "关注", value: community.mine?.following, to: `/u/${user?.id}` },
                { label: "会话", value: community.mine?.rooms, to: "/messages" },
                { label: "游戏", value: community.mine?.game_plays, to: "/games" },
              ].map((x) => (
                <div
                  key={x.label}
                  className="bui-chip"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "6px 4px",
                    height: "auto",
                    background: "var(--inset)",
                    border: "1px solid var(--line-soft)",
                    borderRadius: 6,
                    cursor: x.to ? "pointer" : "default",
                  }}
                  onClick={() => x.to && navigate(x.to)}
                >
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{x.label}</span>
                  <span className="oo-num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", marginTop: 2 }}>
                    {x.value ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </ChartCard>
        ) : null}
      </div>

      {/* 接入信息：保留原有实用内容（Base URL / 鉴权 / 快速测试） */}
      <div className="oo-panel">
        <div className="oo-panel-head">
          <span className="oo-panel-title">接入信息</span>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyEndpoint}>复制地址</Button>
        </div>
        <div className="oo-panel-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "8px 20px" }}>
            <div className="bui-kv">
              <span className="bui-kv-k">Base URL</span>
              <span className="bui-kv-v"><span className="oo-mono">{endpoint}</span></span>
            </div>
            <div className="bui-kv">
              <span className="bui-kv-k">鉴权</span>
              <span className="bui-kv-v"><span className="oo-mono">Authorization: Bearer sk-xxx</span></span>
            </div>
            <div className="bui-kv">
              <span className="bui-kv-k">计费比例</span>
              <span className="bui-kv-v">{odRateText(perUnit)}</span>
            </div>
            <div className="bui-kv">
              <span className="bui-kv-k">用户分组</span>
              <span className="bui-kv-v">{user?.group || "default"}</span>
            </div>
          </div>

          <div className="oo-code-block" style={{ marginTop: 12 }}>
            <div className="oo-code-head">
              <span className="oo-code-lang">bash</span>
            </div>
            <pre>
              <code>{`curl ${endpoint}/chat/completions \\
  -H "Authorization: Bearer sk-xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'`}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
