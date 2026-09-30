// 数据看板 · 个人维度（/console）
// ---------------------------------------------------------------------------
// 彻底解决历史与区间指标混淆问题：
//   1. 账户资产概览：全生命周期永久状态（可用余额、总累计消费、有效令牌、分组倍率、日均消耗与可用续航预测）
//   2. 时段用量与服务质量：随 7d/30d/90d 动态响应，带环比增减对比（总请求、总消费、Token 吞吐、成功率、响应耗时）
//   3. 多维可视化图表：双 Y 轴调用与消费趋势图、Token 构成深度拆解、模型用量与消费排行（保证 100% 对齐）、24小时活跃时段
//   4. 最近调用动态微流：最近 8 次 API 请求即时状态与用量快照，接入开发快速核验
//   5. 接入信息与测试台：彻底纠正「计费比例」歧义，规范阐述货币标准与 1 OD = 10,000 额度单位底层换算，支持 cURL / Python / Node.js
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Segmented,
  Tag,
  Empty,
  Skeleton,
  App as AntApp,
  Tooltip,
  Alert,
  Table,
  Space,
} from "antd";
import {
  ReloadOutlined,
  KeyOutlined,
  CopyOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  WalletOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ArrowRightOutlined,
  DollarOutlined,
  CodeOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import {
  LineChart,
  BarChart,
  RankBar,
  Legend,
  Donut,
  ChartCard,
  KpiCard,
  SERIES_COLORS,
  fmtCompact,
} from "../components/Charts";
import { OdCoin } from "../components/OdCoin";
import {
  copyText,
  fmtOd,
  odOf,
  unitsPerOd,
  CURRENCY_NAME,
  fmtDate,
} from "../services/format";

const RANGES = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
];

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
  const [sampleModel, setSampleModel] = useState("");
  const [codeLang, setCodeLang] = useState("curl");

  // 网关完整可用 URL
  const endpoint = (() => {
    const raw = String(status?.api_endpoint || "").trim();
    if (!raw) return `${window.location.origin}/v1`;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${window.location.origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
  })();

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const [d, c, m] = await Promise.all([
        API.get("/dashboard/self", { params: { range } }),
        API.get("/dashboard/community", { params: { range } }).catch(() => null),
        API.get("/chat/meta").catch(() => null),
      ]);
      if (!isLatest(token)) return;
      setData(d);
      setCommunity(c);
      setSampleModel(m?.models?.[0]?.id || "");
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

  const copyString = async (text, tip = "已复制") => {
    try {
      await copyText(text);
      message.success(tip);
    } catch {
      message.error("复制失败，请手动选择复制");
    }
  };

  // 1. 账户资产概览（全生命周期）
  const quota = data?.account?.quota ?? user?.quota ?? 0;
  const usedQuota = data?.account?.used_quota ?? user?.used_quota ?? 0;
  const totalLifetimeQuota = quota + usedQuota;
  const usedPct = totalLifetimeQuota > 0 ? (usedQuota / totalLifetimeQuota) * 100 : 0;
  const lifetimeRequests = data?.account?.request_count ?? user?.request_count ?? 0;
  const activeTokens = data?.account?.active_tokens ?? 0;
  const totalTokensCount = data?.account?.total_tokens ?? 0;
  const groupName = data?.account?.group_name || user?.group_name || "default";
  const groupRate = Number(data?.account?.group_rate ?? 1.0);

  // 2. 区间用量统计（时段聚合）
  const t = data?.totals || {};
  const p = data?.previous || {};
  const trend = data?.trend || [];
  const days = data?.range?.days || 30;

  // 日均消耗与可用天数测算
  const dailyAvg = trend.length ? (t.units || 0) / trend.length : 0;
  const rawDaysLeft = dailyAvg > 0 ? Math.floor(quota / dailyAvg) : null;
  const daysLeft = rawDaysLeft === null ? null : Math.min(rawDaysLeft, 999);
  const daysLeftCapped = rawDaysLeft !== null && rawDaysLeft > 999;

  const od = useCallback((u) => odOf(u, perUnit), [perUnit]);
  const fmtOdVal = (v) => `${fmtCompact(v)} ${CURRENCY_NAME}`;

  // 趋势图数据序列（双 Y 轴）
  const mainSeries = useMemo(
    () => [
      {
        name: "调用次数",
        color: SERIES_COLORS[0],
        format: (v) => `${fmtCompact(v)} 次`,
        values: trend.map((d) => ({ x: d.day, y: d.calls })),
      },
      {
        name: `消费（${CURRENCY_NAME}）`,
        color: SERIES_COLORS[2],
        axis: "right",
        format: fmtOdVal,
        values: trend.map((d) => ({ x: d.day, y: od(d.units) })),
      },
    ],
    [trend, od]
  );

  // Token 拆解图表
  const tokenSeries = useMemo(
    () => [
      { name: "输入 Token", color: SERIES_COLORS[0], values: trend.map((d) => ({ x: d.day, y: d.prompt_tokens })) },
      { name: "输出 Token", color: SERIES_COLORS[1], values: trend.map((d) => ({ x: d.day, y: d.completion_tokens })) },
      { name: "缓存命中", color: SERIES_COLORS[3], area: false, values: trend.map((d) => ({ x: d.day, y: d.cache_tokens })) },
    ],
    [trend]
  );

  const sparkCalls = trend.map((d) => d.calls);
  const sparkUnits = trend.map((d) => d.units);

  // 代码示例
  const modelToUse = sampleModel || "deepseek-v4.1-flash";
  const codeSnippets = {
    curl: `curl ${endpoint}/chat/completions \\
  -H "Authorization: Bearer sk-your-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelToUse}",
    "messages": [{"role": "user", "content": "你好，请介绍你自己"}],
    "stream": true
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${endpoint}",
    api_key="sk-your-key",  # 在控制台「令牌管理」页面创建的应用密钥
)

response = client.chat.completions.create(
    model="${modelToUse}",
    messages=[{"role": "user", "content": "你好，请介绍你自己"}],
    stream=True,
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)`,
    node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${endpoint}",
  apiKey: "sk-your-key", // 在控制台「令牌管理」页面创建的应用密钥
});

const stream = await client.chat.completions.create({
  model: "${modelToUse}",
  messages: [{ role: "user", content: "你好，请介绍你自己" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`,
  };

  return (
    <div className="oo-page">
      <PageHeader
        title={`你好，${user?.display_name || user?.username}`}
        tags={
          <>
            <Tag icon={<DashboardOutlined />}>个人数据看板</Tag>
            <Tooltip title="按天聚合、时段统计均以北京时间（UTC+8）为准">
              <Tag icon={<ClockCircleOutlined />}>北京时间</Tag>
            </Tooltip>
            <Tag color="blue">
              分组: {groupName} ({groupRate.toFixed(1)}x 倍率)
            </Tag>
          </>
        }
        extra={
          <>
            <Segmented value={range} onChange={setRange} options={RANGES} />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={load}
              title="刷新"
              aria-label="刷新看板"
            />
            <Button type="primary" icon={<KeyOutlined />} onClick={() => navigate("/token")}>
              管理令牌
            </Button>
            <Button icon={<DollarOutlined />} onClick={() => navigate("/pricing")}>
              模型价格
            </Button>
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
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {/* 模块 A：账户资产概览（全生命周期永久数据，不随区间选择变化） */}
      <div className="oo-panel" style={{ marginBottom: 16 }}>
        <div className="oo-panel-head">
          <span className="oo-panel-title">
            <WalletOutlined style={{ marginRight: 6, color: "var(--accent)" }} />
            账户与资产概览
          </span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            全生命周期账户状态 · 1 OD币 = 1.00 美元
          </span>
        </div>
        <div className="oo-panel-body">
          <div className="oo-stats-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <StatCard
              label="账户可用余额"
              value={loading ? "—" : fmtOd(quota, perUnit, 2, false)}
              suffix={<OdCoin size={14} muted />}
              tone={quota < 0 ? "danger" : undefined}
              hint={
                quota < 0
                  ? "已欠费，充值需大于欠费额才能恢复 API 服务"
                  : `1 OD币 = 1 美元。当前可用额度为 ${fmtOd(quota, perUnit, 2, false)} ${CURRENCY_NAME}，调用模型时按实际 Token 消耗实时扣除。`
              }
              hintInline={`折合 \$${(quota / perUnit).toFixed(2)} USD`}
            />

            <StatCard
              label="累计历史总消费"
              value={loading ? "—" : fmtOd(usedQuota, perUnit, 2, false)}
              suffix={<OdCoin size={14} muted />}
              tone={usedPct >= 90 ? "danger" : usedPct >= 70 ? "warning" : undefined}
              hint={`账户自注册以来的全生命周期累计总扣费，占累计总额度 ${usedPct.toFixed(1)}%`}
              hintInline={`累计请求 ${fmtCompact(lifetimeRequests)} 次`}
            />

            <StatCard
              label="有效 API 令牌"
              value={loading ? "—" : activeTokens}
              suffix={`/ ${totalTokensCount}`}
              hint="当前正常启用的 API Key 数量。点击可前往令牌管理页面进行签发、禁用或配置白名单。"
              hintInline={
                <span
                  style={{ cursor: "pointer", color: "var(--accent)" }}
                  onClick={() => navigate("/token")}
                >
                  前往管理令牌 <ArrowRightOutlined style={{ fontSize: 10 }} />
                </span>
              }
            />

            <StatCard
              label="用户分组与倍率"
              value={groupName}
              suffix={`${groupRate.toFixed(1)}x`}
              hint={`当前账号绑定的渠道分组为「${groupName}」，计费倍率为 ${groupRate.toFixed(1)} 倍。模型扣费公式：基准单价 × 实际用量 × 分组倍率。`}
              hintInline={groupRate === 1 ? "标准计费倍率" : `${groupRate} 倍阶梯费率`}
            />

            <StatCard
              label="余额续航预估"
              value={
                loading
                  ? "—"
                  : daysLeft === null
                  ? "—"
                  : daysLeftCapped
                  ? "999+"
                  : daysLeft
              }
              suffix={daysLeft === null ? "" : "天"}
              tone={daysLeft !== null && daysLeft < 7 ? "danger" : daysLeft !== null && daysLeft < 30 ? "warning" : undefined}
              hintInline={
                daysLeftCapped
                  ? `余额充足（日均消费约 ${fmtOd(dailyAvg, perUnit, 4, false)} ${CURRENCY_NAME}）`
                  : daysLeft === null
                  ? "近期暂无消费，无法预估"
                  : `按近 ${days} 天日均消耗测算`
              }
              hint={
                daysLeftCapped
                  ? "按当前时段平均日消耗测算，剩余额度已超过 999 天，余额储备充裕"
                  : `按近 ${days} 天区间日均消耗 ${fmtOd(dailyAvg, perUnit, 4, false)} ${CURRENCY_NAME} 测算，当前可用余额预计可支撑约 ${daysLeft ?? 0} 天。`
              }
            />
          </div>
        </div>
      </div>

      {/* 模块 B：区间用量与服务质量（随 7d/30d/90d 响应） */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)" }}>
            时段用量与服务指标（近 {days} 天）
          </span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            已与上一自然周期（同等天数）自动对比环比
          </span>
        </div>

        {loading && !data ? (
          <div className="oo-kpi-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="oo-kpi">
                <Skeleton active paragraph={{ rows: 1 }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="oo-kpi-grid">
            <KpiCard
              label="区间调用次数"
              value={fmtCompact(t.calls || 0)}
              unit="次"
              current={t.calls}
              previous={p.calls}
              spark={sparkCalls}
              hint={`近 ${days} 天内成功完成的 API 请求总数`}
            />

            <KpiCard
              label="区间消费总额"
              value={fmtCompact(od(t.units))}
              unit={<OdCoin size={13} />}
              current={t.units}
              previous={p.units}
              spark={sparkUnits}
              hint={`近 ${days} 天产生的扣费总额，折合 \$${(Number(t.units || 0) / perUnit).toFixed(4)} USD`}
            />

            <KpiCard
              label="Token 吞吐总量"
              value={fmtCompact(t.total_tokens || ((t.prompt_tokens || 0) + (t.completion_tokens || 0)))}
              unit="Tokens"
              current={t.total_tokens}
              previous={p.tokens}
              hint={`输入: ${fmtCompact(t.prompt_tokens || 0)} · 输出: ${fmtCompact(t.completion_tokens || 0)}`}
            />

            <KpiCard
              label="请求成功率"
              value={`${t.success_rate ?? 100}%`}
              current={t.success_rate}
              previous={
                (p.calls || 0) + (p.errors || 0) > 0
                  ? Number((((p.calls || 0) / ((p.calls || 0) + (p.errors || 0))) * 100).toFixed(2))
                  : null
              }
              tone={(t.success_rate ?? 100) < 95 ? "danger" : undefined}
              hint={`成功 ${fmtCompact(t.calls || 0)} 次 · 异常/拦截 ${fmtCompact(t.errors || 0)} 次 · 平均耗时 ${t.avg_elapsed > 0 ? (t.avg_elapsed >= 1000 ? `${(t.avg_elapsed / 1000).toFixed(2)}s` : `${t.avg_elapsed}ms`) : "—"}`}
            />
          </div>
        )}
      </div>

      {/* 模块 C：多维可视化图表网格 */}
      <div className="oo-chart-grid" style={{ marginBottom: 16 }}>
        <ChartCard
          title="调用量与消费趋势"
          note={`左轴：请求调用次数 · 右轴：消费金额（${CURRENCY_NAME}）`}
          full
          extra={<Legend series={mainSeries} />}
        >
          {loading && !trend.length ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : trend.some((d) => d.calls || d.units) ? (
            <LineChart series={mainSeries} height={240} />
          ) : (
            <Empty description="该时间范围内没有调用数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard
          title="Token 构成深度拆解"
          note={`上下文缓存命中率 ${t.cache_rate ?? 0}% · 命中 ${fmtCompact(t.cache_tokens || 0)} Tokens`}
          extra={<Legend series={tokenSeries} />}
        >
          {trend.some((d) => d.prompt_tokens || d.completion_tokens) ? (
            <LineChart series={tokenSeries} height={200} />
          ) : (
            <Empty description="暂无 Token 消耗数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </ChartCard>

        <ChartCard title="24 小时活跃时段分布" note="北京时间 0–23 点用量频度">
          <BarChart
            bars={(data?.by_hour || []).map((h) => ({
              label: `${h.hour}时`,
              value: h.calls,
            }))}
            height={200}
            valueFormat={(v) => `${fmtCompact(v)} 次`}
          />
        </ChartCard>

        <ChartCard title="模型消费排行" note={`按 ${CURRENCY_NAME} 消费排序`}>
          <RankBar
            items={(data?.by_model || []).map((m) => ({
              name: m.model,
              value: od(m.units),
              sub: `${fmtCompact(m.calls)} 次`,
            }))}
            format={fmtOdVal}
            empty="所选区间内暂无模型调用"
          />
        </ChartCard>

        <ChartCard title="模型调用占比" note="按实际调用次数分布">
          <Donut
            items={(data?.by_model || []).map((m) => ({
              name: m.model,
              value: m.calls,
            }))}
            centerLabel="次调用"
          />
        </ChartCard>

        {community ? (
          <ChartCard title="我的社区与互动" note="快捷互动入口">
            <div className="oo-mini-stats">
              {[
                { label: "帖子", value: community.mine?.posts, to: `/u/${user?.id}` },
                { label: "获赞", value: community.mine?.likes_received },
                { label: "评论", value: community.mine?.comments },
                { label: "粉丝", value: community.mine?.followers, to: `/u/${user?.id}` },
                { label: "关注", value: community.mine?.following, to: `/u/${user?.id}` },
                { label: "好友", value: community.mine?.friends, to: "/messages?panel=requests" },
              ].map((x) => (
                <button
                  key={x.label}
                  type="button"
                  className="oo-mini-stat"
                  disabled={!x.to}
                  onClick={() => x.to && navigate(x.to)}
                >
                  <b>{fmtCompact(x.value ?? 0)}</b>
                  <span>{x.label}</span>
                </button>
              ))}
            </div>
          </ChartCard>
        ) : null}
      </div>

      {/* 模块 D：最近调用动态（最近 8 次 API 请求即时审计） */}
      <div className="oo-panel" style={{ marginBottom: 16 }}>
        <div className="oo-panel-head">
          <div>
            <span className="oo-panel-title">
              <ThunderboltOutlined style={{ marginRight: 6, color: "var(--accent)" }} />
              最近调用动态
            </span>
            <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
              展示最新的 API 请求状态与计费流水，方便对接即时排查
            </span>
          </div>
          <Button
            size="small"
            type="link"
            onClick={() => navigate("/log")}
          >
            查看完整使用记录 →
          </Button>
        </div>
        <div className="oo-panel-body" style={{ padding: 0 }}>
          <Table
            className="oo-table"
            size="small"
            rowKey="id"
            pagination={false}
            scroll={{ x: 680 }}
            dataSource={data?.recent_logs || []}
            locale={{
              emptyText: <Empty description="暂无近期调用记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
            }}
            columns={[
              {
                title: "时间",
                dataIndex: "created_at",
                width: 140,
                render: (ts) => (
                  <span className="oo-mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                    {fmtDate(ts, "MM-DD HH:mm:ss")}
                  </span>
                ),
              },
              {
                title: "模型",
                dataIndex: "model",
                render: (m) => (
                  <Tag color="geekblue" style={{ fontFamily: "monospace" }}>
                    {m}
                  </Tag>
                ),
              },
              {
                title: "状态",
                dataIndex: "type",
                width: 100,
                render: (t) =>
                  t === 2 ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>
                      成功
                    </Tag>
                  ) : (
                    <Tag color="error" icon={<CloseCircleOutlined />}>
                      异常
                    </Tag>
                  ),
              },
              {
                title: "耗时",
                dataIndex: "elapsed_ms",
                width: 90,
                align: "right",
                render: (ms) => (
                  <span className="oo-num">
                    {ms > 0 ? (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`) : "—"}
                  </span>
                ),
              },
              {
                title: "Tokens (入 / 出)",
                key: "tokens",
                width: 140,
                align: "right",
                render: (_, r) => (
                  <span className="oo-mono" style={{ fontSize: 12 }}>
                    {fmtCompact(r.prompt_tokens || 0)} / {fmtCompact(r.completion_tokens || 0)}
                  </span>
                ),
              },
              {
                title: "扣费金额",
                dataIndex: "units",
                width: 120,
                align: "right",
                render: (u) => (
                  <span className="oo-num" style={{ fontWeight: 600 }}>
                    {fmtOd(u, perUnit, 4, true)}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>

      {/* 模块 E：接入信息与快速开始（修正换算说明与排版） */}
      <div className="oo-panel">
        <div className="oo-panel-head">
          <div>
            <span className="oo-panel-title">
              <CodeOutlined style={{ marginRight: 6, color: "var(--accent)" }} />
              API 接入信息与快速测试
            </span>
            <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>
              标准 OpenAI 兼容协议接入标准
            </span>
          </div>
          <Space>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyString(endpoint, "接口 Base URL 已复制")}
            >
              复制 Base URL
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<KeyOutlined />}
              onClick={() => navigate("/token")}
            >
              创建/管理 API Key
            </Button>
          </Space>
        </div>

        <div className="oo-panel-body">
          {/* 参数网格：清晰解耦，杜绝排版挤压 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "12px 24px",
              paddingBottom: 16,
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div className="bui-kv">
              <span className="bui-kv-k">Base URL</span>
              <span className="bui-kv-v">
                <span className="oo-mono" style={{ userSelect: "all" }}>
                  {endpoint}
                </span>
              </span>
            </div>

            <div className="bui-kv">
              <span className="bui-kv-k">鉴权 Header</span>
              <span className="bui-kv-v">
                <span className="oo-mono">Authorization: Bearer sk-your-key</span>
              </span>
            </div>

            <div className="bui-kv">
              <span className="bui-kv-k">用户分组与倍率</span>
              <span className="bui-kv-v">
                <Tag color="cyan">分组: {groupName}</Tag>
                <Tag color="purple">倍率: {groupRate.toFixed(1)}x</Tag>
              </span>
            </div>

            <div className="bui-kv">
              <span className="bui-kv-k">
                货币与单位标准
                <Tooltip title="平台基准计费口径：1 OD币 恒等 1 美元，支持 0.0001 美元（1 厘）超精细计量">
                  <InfoCircleOutlined style={{ marginLeft: 4, cursor: "pointer", color: "var(--accent)" }} />
                </Tooltip>
              </span>
              <span className="bui-kv-v" style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                <b>1 {CURRENCY_NAME} = 1.00 美元</b> · 系统底层 <b>1 {CURRENCY_NAME} = {perUnit.toLocaleString()} 额度单位</b>（1 单位 = \$0.0001）
              </span>
            </div>
          </div>

          {/* 快速测试代码演练台 */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>快速开始示例代码</span>
                <Segmented
                  size="small"
                  value={codeLang}
                  onChange={setCodeLang}
                  options={[
                    { label: "cURL", value: "curl" },
                    { label: "Python (OpenAI SDK)", value: "python" },
                    { label: "Node.js (OpenAI SDK)", value: "node" },
                  ]}
                />
              </div>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyString(codeSnippets[codeLang], "示例代码已复制")}
              >
                复制代码
              </Button>
            </div>

            <div className="oo-code-block">
              <div className="oo-code-head">
                <span className="oo-code-lang">{codeLang}</span>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  已自动为您填充当前站点 Base URL 与可用模型名（{modelToUse}）
                </span>
              </div>
              <pre style={{ margin: 0, maxHeight: 260, overflowY: "auto" }}>
                <code>{codeSnippets[codeLang]}</code>
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
