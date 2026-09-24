import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Table, Input, Select, Button, Alert, App as AntApp, Tooltip, Drawer, Descriptions, Space, Typography, Grid } from "antd";
import { ReloadOutlined, FileTextOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UsageAnalysis from "../components/UsageAnalysis";
import { ModelLabel, GroupVendorIcons, GroupTag } from "../components/VendorIcon";
import UserAvatar from "../components/UserAvatar";

const { Text } = Typography;

// 历史日志里存的是改名前的「OD」，新日志写的是「OD币」。
// 只在展示时归一化，不改数据库（历史记录保持原样可追溯）。
function normalizeCurrency(text) {
  return String(text || "").replace(/(\d)\s*OD(?!币)/g, `$1 ${CURRENCY_NAME}`);
}

function ms(v) {
  const n = Number(v) || 0;
  if (!n) return "-";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;
}

/** 耗时着色：慢请求要一眼能看出来（>5s 橙、>15s 红） */
function msColor(v) {
  const n = Number(v) || 0;
  if (!n) return "var(--ink-3)";
  if (n >= 15000) return "var(--red)";
  if (n >= 5000) return "var(--orange)";
  return "var(--ink)";
}

/**
 * 日志原文块（输入 / 输出内容）。
 *
 * 为什么需要单独一个组件：原文可能有几千字且含换行，直接铺进 Descriptions
 * 会把整个详情面板撑成一长条（其他字段全被挤到看不见）。
 * 所以给一个**可滚动的固定高度框**：默认只占几行，要看细节在里面滚。
 * 后端已各截断到 4000 字符（TEXT 列上限，见 gateway.js 的 settle），
 * 截断时明确标出来 —— 否则会误以为「模型只输出了这么多」。
 */
function LogTextBlock({ text, truncated, empty = "-" }) {
  if (!text) return <span style={{ color: "var(--ink-3)", fontSize: 12 }}>{empty}</span>;
  return (
    <div>
      <pre
        style={{
          margin: 0,
          maxHeight: 220,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.55,
          background: "var(--inset)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-sm)",
          padding: "6px 9px",
        }}
      >
        {text}
      </pre>
      {truncated ? (
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
          已截断（仅保存前 4000 字符；完整内容会超出日志列的存储上限）
        </span>
      ) : null}
    </div>
  );
}

const RANGE_OPTIONS = [
  { value: 1, label: "今天" },
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 0, label: "全部时间" },
];

/**
 * 使用记录：每一次模型调用的用量审计。
 * 展示列按「用户/模型/分组/密钥/内容/时间/首Token/总耗时/计费/tokens/缓存/IP/设备」
 * 组织；渠道与原始 UA 只对管理员可见（渠道等于上游供应商，属于敏感信息）。
 */
export default function LogPage() {
  const { user, status } = useApp();
  const { message } = AntApp.useApp();
  const isAdmin = Number(user?.role) >= 100;
  const perUnit = unitsPerOd(status);
  // < 768px（手机）：模型列要放宽，否则模型名被截成 `deepseek-v4.1-fl`
  const isNarrow = !Grid.useBreakpoint().md;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({ models: [], tokens: [], groups: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [model, setModel] = useState("");
  const [tokenId, setTokenId] = useState(0);
  const [group, setGroup] = useState("");
  const [days, setDays] = useState(30);
  const [detail, setDetail] = useState(null);
  // 分组元信息（倍率/备注/成员厂商）：分组列按「折叠态厂商图标 + 分组名」展示
  const [groupMeta, setGroupMeta] = useState([]);
  const { begin, isLatest } = useLatest();

  useEffect(() => {
    API.get("/token/groups")
      .then((list) => setGroupMeta(Array.isArray(list) ? list : []))
      .catch(() => setGroupMeta([]));
  }, []);

  /** 历史绑定可能带 "厂商:" 前缀（新格式就是分组名）；展示时统一剥掉 */
  const displayGroupName = (raw) => {
    const s = String(raw || "").trim();
    if (!s || s === "default") return "";
    const i = s.indexOf(":");
    return i > 0 && i < s.length - 1 ? s.slice(i + 1) : s;
  };

  const params = useMemo(
    () => ({
      // 「全部」时显式传 days=0：后端 timeRange 对 0 才是不限时间。
      // 若传 undefined，/usage/summary 会用它自己的默认 30 天窗口，
      // 于是「表格是全量、卡片是近 30 天」——同一页两个口径，会误导人。
      days: days,
      keyword: keyword || undefined,
      model: model || undefined,
      token_id: tokenId || undefined,
      group: group || undefined,
    }),
    [days, keyword, model, tokenId, group]
  );

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    // 列表与汇总分开取：汇总走聚合 SQL（COUNT/SUM/AVG），比列表更容易慢或失败，
    // 用 allSettled 保证「汇总挂了列表照常显示」，而不是整页空白。
    const [listRes, sumRes] = await Promise.allSettled([
      API.get("/log/usage", { params: { ...params, p: page, page_size: pageSize } }),
      API.get("/log/usage/summary", { params }),
    ]);
    if (!isLatest(token)) return;
    if (listRes.status === "fulfilled") {
      setItems(listRes.value.items || []);
      setTotal(listRes.value.total || 0);
      setLoadError("");
    } else {
      const msg = listRes.reason?.message || "使用记录加载失败";
      setLoadError(msg);
      message.error(msg);
    }
    if (sumRes.status === "fulfilled") {
      setSummary(sumRes.value);
    } else {
      // 失败时清空而不是保留上一次的数据：否则切到「全部」后汇总挂了，
      // 会看到「旧范围的卡片 + 新范围的表格」并存，比看不到更误导。
      setSummary(null);
    }
    setLoading(false);
  }, [params, page, pageSize, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

  // 分析数据（按天趋势 + 按模型排行 + 模型多折线 + 时段热点）：
  // 只在展开时拉，避免每次进页面都跑聚合
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [byDay, setByDay] = useState([]);
  const [byModel, setByModel] = useState([]);
  const [modelSeries, setModelSeries] = useState([]);
  const [hourly, setHourly] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  const loadAnalysis = useCallback(
    async (daysArg) => {
      setAnalysisLoading(true);
      setAnalysisError("");
      try {
        const d = await API.get("/log/usage/analysis", { params: { days: daysArg } });
        setByDay(Array.isArray(d?.byDay) ? d.byDay : []);
        setByModel(Array.isArray(d?.byModel) ? d.byModel : []);
        setModelSeries(Array.isArray(d?.modelSeries) ? d.modelSeries : []);
        setHourly(Array.isArray(d?.hourly) ? d.hourly : []);
      } catch (e) {
        setAnalysisError(e.message || "分析数据加载失败");
      } finally {
        setAnalysisLoading(false);
      }
    },
    []
  );

  // 展开时按当前时间范围加载；切范围后重新拉
  useEffect(() => {
    if (analysisOpen) loadAnalysis(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisOpen, days]);

  // 筛选下拉的候选项（模型/密钥/分组）：与列表同一时间口径（含「全部」）
  useEffect(() => {
    let alive = true;
    API.get("/log/usage/filters", { params: { days } })
      .then((d) => {
        if (alive) {
          setFilters({
            models: d.models || [],
            tokens: d.tokens || [],
            groups: d.groups || [],
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [days]);

  const columns = [
    {
      title: "时间",
      dataIndex: "created_at",
      width: 165,
      sorter: (a, b) => (a.created_at || 0) - (b.created_at || 0),
      defaultSortOrder: "descend",
      render: (t) => <span className="oo-num" style={{ whiteSpace: "nowrap" }}>{fmtDate(t)}</span>,
    },
    // 管理员：用户（头像 + 名字）；普通用户看到的是自己，不需要这一列
    ...(isAdmin
      ? [
          {
            title: "用户",
            dataIndex: "username",
            width: 130,
            render: (v, r) => <UserAvatar user={{ id: r.user_id, username: v }} size={22} showName />,
          },
        ]
      : []),
    {
      title: "模型",
      dataIndex: "model",
      // 窄屏加宽：模型名是这一列的核心信息，被截成 `deepseek-v4.1-fl`
      // 就失去意义了（黑盒测试在 390 视口实测：单元格 145px、内容 158px，被右侧裁掉）。
      width: isNarrow ? 190 : 145,
      // channelType 是**兜底**：模型名判定不出来时（OpenCode 的 omen-alpha、
      // 聚合渠道的 openrouter/free）退回该渠道的厂商图标。
      // 用户要求：「应该是跟随其厂商的图标啊」——渠道就是这些模型的厂商来源。
      // title 属性兜底：真的放不下时还能看到全名。
      render: (v, r) =>
        v ? (
          <span title={String(v)}>
            <ModelLabel model={v} size={14} channelType={r.channel_type || ""} />
          </span>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>-</span>
        ),
    },
    // 管理员：分组（独立 Tag 包含专属图标与标题）
    ...(isAdmin
      ? [
          {
            title: "分组",
            dataIndex: "group_name",
            width: 135,
            render: (v) => {
              const name = displayGroupName(v);
              // 「公共池」已废弃：空分组是历史数据的缺归属状态，显示为「未分组」
              if (!name) return <Text type="secondary" style={{ fontSize: 12 }}>未分组</Text>;
              const meta = groupMeta.find((g) => g.name === name);
              return <GroupTag name={name} meta={meta} />;
            },
          },
        ]
      : []),
    {
      title: "计费",
      dataIndex: "quota",
      width: 110,
      sorter: (a, b) => (Number(a.quota) || 0) - (Number(b.quota) || 0),
      render: (q) => {
        const n = Number(q) || 0;
        return n ? (
          <Tooltip title={`${fmtOd(n, perUnit, 6)}`}>
            <span className="oo-num" style={{ fontWeight: 550 }}>{fmtOd(n, perUnit, 4, false)}</span>
            <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 3 }}>{CURRENCY_NAME}</span>
          </Tooltip>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>-</span>
        );
      },
    },
    {
      title: "Tokens",
      dataIndex: "prompt_tokens",
      width: 135,
      render: (v, r) => (
        <Tooltip title={`提示 ${v} · 补全 ${r.completion_tokens}${r.cache_tokens ? ` · 缓存 ${r.cache_tokens}` : ""}`}>
          <span className="oo-num" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
            {Number(v) || 0}
            <span style={{ color: "var(--ink-3)" }}> / </span>
            {Number(r.completion_tokens) || 0}
            {Number(r.cache_tokens) > 0 ? (
              <span className="bui-chip bui-chip--green" style={{ fontSize: 10.5, height: 16, lineHeight: "16px", padding: "0 4px", marginLeft: 4 }}>
                缓{r.cache_tokens}
              </span>
            ) : null}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "总耗时",
      dataIndex: "elapsed_ms",
      width: 88,
      sorter: (a, b) => (a.elapsed_ms || 0) - (b.elapsed_ms || 0),
      render: (v) => <span className="oo-num" style={{ color: msColor(v) }}>{ms(v)}</span>,
    },
    {
      title: "首Token",
      dataIndex: "first_token_ms",
      width: 88,
      sorter: (a, b) => (a.first_token_ms || 0) - (b.first_token_ms || 0),
      render: (v) => <span className="oo-num" style={{ color: msColor(v) }}>{ms(v)}</span>,
    },
    // 管理员：渠道与密钥
    ...(isAdmin
      ? [
          {
            title: "渠道",
            dataIndex: "channel_name",
            width: 140,
            ellipsis: true,
            render: (v, r) =>
              v ? (
                <Tooltip title={`#${r.channel_id} ${v}`}>
                  <span className="oo-truncate" style={{ fontSize: 12.5 }}>{v}</span>
                </Tooltip>
              ) : (
                <span style={{ color: "var(--ink-3)" }}>-</span>
              ),
          },
        ]
      : []),
    // 密钥列：**所有人可见**（不只是管理员）。
    //
    // 人格实测报的（小团队负责人，一人管 10 把 Key）：
    //   「使用记录里没有『密钥』列。我 10 个人 10 把钥匙，想知道小李这个月花了多少，
    //     得先去筛选框选中他那把钥匙。我要的是每一行直接写着谁花的。」
    // 后端已把 token_id/token_name/group_name 对本人开放（渠道名仍只给管理员，
    // 那是上游账号身份）。这里把列移出 isAdmin 分支即可。
    {
      title: "密钥",
      dataIndex: "token_name",
      width: 120,
      ellipsis: true,
      render: (v, r) =>
        v ? (
          <Tooltip title={`#${r.token_id} ${v}`}>
            <span className="oo-truncate" style={{ fontSize: 12.5 }}>{v}</span>
          </Tooltip>
        ) : r.token_id ? (
          <Tooltip title={`令牌 #${r.token_id}（名称未记录）`}>
            <span className="oo-truncate" style={{ fontSize: 12.5, color: "var(--ink-3)" }}>#{r.token_id}</span>
          </Tooltip>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>账户额度</span>
        ),
    },
    {
      title: "调用内容",
      dataIndex: "content",
      width: 220,
      ellipsis: true,
      render: (text) => (
        <Tooltip title={normalizeCurrency(text)}>
          <span style={{ fontSize: 12.5 }}>{normalizeCurrency(text)}</span>
        </Tooltip>
      ),
    },
    {
      title: "IP",
      dataIndex: "ip",
      width: 115,
      ellipsis: true,
      render: (v) => <span className="oo-num" style={{ color: "var(--ink-3)" }}>{v || "-"}</span>,
    },
    {
      title: "设备",
      dataIndex: "device",
      width: 120,
      ellipsis: true,
      render: (v, r) =>
        v ? (
          <Tooltip title={isAdmin && r.user_agent ? r.user_agent : undefined}>
            <span className="oo-truncate" style={{ fontSize: 12.5 }}>{v}</span>
          </Tooltip>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>-</span>
        ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="使用记录"
        extra={
          <Space size={6} wrap>
            <Select
              size="small"
              value={days}
              onChange={(v) => { setDays(v); setPage(1); }}
              style={{ width: 110 }}
              options={RANGE_OPTIONS}
            />
            {isAdmin ? (
              <Select
                size="small"
                value={group || undefined}
                onChange={(v) => { setGroup(v || ""); setPage(1); }}
                style={{ width: 130 }}
                allowClear
                showSearch
                placeholder="全部分组"
                options={filters.groups?.map((g) => ({
                  value: g.name,
                  label: `${g.label || g.name}（${g.count}）`,
                }))}
              />
            ) : null}
            <Select
              size="small"
              value={model || undefined}
              onChange={(v) => { setModel(v || ""); setPage(1); }}
              style={{ width: 165 }}
              allowClear
              showSearch
              placeholder="全部模型"
              options={filters.models.map((m) => ({ value: m.model, label: `${m.model}（${m.count}）` }))}
            />
            <Select
              size="small"
              value={tokenId || undefined}
              onChange={(v) => { setTokenId(v || 0); setPage(1); }}
              style={{ width: 150 }}
              allowClear
              placeholder="全部密钥"
              options={filters.tokens.map((t) => ({ value: t.id, label: `${t.name}（${t.count}）` }))}
            />
            <Input.Search
              size="small"
              placeholder={isAdmin ? "搜索用户 / 内容 / 模型" : "搜索内容 / 模型"}
              allowClear
              style={{ width: 190 }}
              onChange={(e) => {
                if (!e.target.value) {
                  setKeyword("");
                  setPage(1);
                }
              }}
              onSearch={(v) => {
                setKeyword(v);
                setPage(1);
              }}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={load} title="刷新" aria-label="刷新使用记录" />
          </Space>
        }
      />

      {/* 汇总用小 tag 展示，不用大卡片 —— 这一页的主体是记录表，统计只做辅助。
          需要看图表分析时点「分析」展开（与渠道统计弹窗同一套视觉规范）。 */}
      {summary ? (
        <div className="oo-stats-strip">
          <span className="bui-chip" title="区间调用次数">
            调用 <b className="oo-num">{summary.calls}</b>
          </span>
          <span className="bui-chip" title={`区间消耗（${CURRENCY_NAME}）`}>
            消耗 <b className="oo-num">{fmtOd(summary.units, perUnit, 4, false)}</b> {CURRENCY_NAME}
          </span>
          <span className="bui-chip" title={`提示 ${summary.prompt_tokens} / 补全 ${summary.completion_tokens}`}>
            Tokens <b className="oo-num">{summary.prompt_tokens + summary.completion_tokens}</b>
          </span>
          <span
            className={`bui-chip${summary.cache_rate >= 50 ? " bui-chip--green" : ""}`}
            title={`命中 ${summary.cache_tokens} / 输入 ${summary.prompt_tokens}`}
          >
            缓存 <b className="oo-num">{summary.cache_rate}%</b>
          </span>
          <span className="bui-chip" title="流式首个增量到达的平均耗时">
            首Token <b className="oo-num">{ms(summary.avg_first_token)}</b>
          </span>
          <span className="bui-chip" title="端到端平均耗时">
            耗时 <b className="oo-num">{ms(summary.avg_elapsed)}</b>
          </span>
          {summary.uncached_tokens ? (
            <span className="bui-chip" title="未命中缓存的输入 token">
              未命中 <b className="oo-num">{summary.uncached_tokens}</b>
            </span>
          ) : null}
          <button
            type="button"
            className="bui-btn"
            style={{ marginLeft: "auto" }}
            onClick={() => setAnalysisOpen((v) => !v)}
          >
            {analysisOpen ? "收起分析" : "展开分析"}
          </button>
        </div>
      ) : null}

      {analysisOpen ? (
        <UsageAnalysis
          byDay={byDay}
          byModel={byModel}
          modelSeries={modelSeries}
          hourly={hourly}
          loading={analysisLoading}
          error={analysisError}
          perUnit={perUnit}
          onRefresh={() => loadAnalysis(days)}
        />
      ) : null}

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="使用记录加载失败"
            description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Table
          className="oo-table"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={items}
          // scroll.x 必须 ≥ 各列宽度之和，否则带 ellipsis 的列会被压成 0 宽（table-layout: fixed）
          // 窄屏总宽要跟着降：模型列加宽后仍按 1180 会挤压其他列。
          // 手机上主要靠横向滚动，但至少模型名要能在滚动后看全。
          scroll={{ x: isAdmin ? 1720 : isNarrow ? 1240 : 1180 }}
          onRow={(r) => ({
            style: { cursor: "pointer" },
            // 键盘可达：整行是详情入口，只给 onClick 会让键盘用户无法打开
            tabIndex: 0,
            role: "button",
            "aria-label": `查看 ${r.model || "调用"} 详情`,
            onClick: () => setDetail(r),
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDetail(r);
              }
            },
          })}
          locale={{
            emptyText: (
              <div style={{ padding: "32px 0", color: "var(--ink-3)" }}>
                <FileTextOutlined style={{ fontSize: 32, color: "var(--ink-3)", display: "block", margin: "0 auto 10px" }} />
                暂无记录
              </div>
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            // 显式给出档位并把上限拉到 200。
            //
            // 人格实测（团队负责人，10 人一天几百条）：「使用记录分页 20 条/页，
            // 对账要翻很多页；在没有导出的前提下更难受。」
            // AntD 默认档位是 10/20/50/100，20 是默认值 —— 她要的是
            // 「一屏能看更多」，所以把档位摆在明面上、上限提到 200。
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </div>

      {/* 详情抽屉：完整信息（普通用户看不到渠道 / 原始 UA / 成本细节） */}
      <Drawer
        title="调用详情"
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={520}
        destroyOnClose
      >
        {detail ? (() => {
          // detail.detail 是后端写的 JSON 字符串（含输入/输出原文、价格快照等）。
          // 解析失败不能炸整页 —— 历史记录里可能有非 JSON 内容，
          // 那种情况下原文块显示「未存」而不是抛异常。
          let parsedDetail = null;
          try {
            parsedDetail = detail.detail ? JSON.parse(detail.detail) : null;
          } catch {
            parsedDetail = null;
          }
          return (
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            <Descriptions.Item label="时间">{fmtDate(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="用户">
              <UserAvatar user={{ id: detail.user_id, username: detail.username }} size={20} showName />
            </Descriptions.Item>
            <Descriptions.Item label="模型">
              <ModelLabel model={detail.model} size={15} channelType={detail.channel_type || ""} />
            </Descriptions.Item>
            <Descriptions.Item label="调用内容">{normalizeCurrency(detail.content)}</Descriptions.Item>
            <Descriptions.Item label="Tokens">
              {/* 升级前的旧记录没写 token 列（当时的 detail 里也没有），显示 0 会让人
                  误以为"这次没消耗" —— 但同一行的「调用内容」里明明写着「提示 3 / 补全 570」。
                  这种自相矛盾让管理员无法判断该信哪个（黑盒测试指出）。
                  所以 token 全为 0 且 content 里带过数字时，直接标明"旧记录未记"。 */}
              {Number(detail.prompt_tokens) === 0 &&
              Number(detail.completion_tokens) === 0 &&
              /tokens/.test(String(detail.content || "")) ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  该记录较旧，未单独记 token（见左侧「调用内容」里的数字）
                </Text>
              ) : (
                <>
                  提示 {detail.prompt_tokens} · 补全 {detail.completion_tokens}
                  {detail.cache_tokens ? ` · 缓存 ${detail.cache_tokens}` : ""}
                </>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="首Token / 总耗时">
              {ms(detail.first_token_ms)} / {ms(detail.elapsed_ms)}
            </Descriptions.Item>
            <Descriptions.Item label="计费">{fmtOd(Number(detail.quota) || 0, perUnit, 6)}</Descriptions.Item>
            {/* 请求 id：客户端提前断开时一次调用会产生两条记录（计费行 + 错误行），
                这是把它们对起来的唯一线索（黑盒测试实测抱怨过没有它）。
                等宽字体 + 可选中，方便复制去搜另一条。 */}
            <Descriptions.Item label="请求 ID">
              {detail.request_id ? (
                <span className="oo-mono" style={{ fontSize: 12, userSelect: "all" }}>
                  {detail.request_id}
                </span>
              ) : (
                "-"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="IP">{detail.ip || "-"}</Descriptions.Item>
            <Descriptions.Item label="设备">{detail.device || "-"}</Descriptions.Item>
            {isAdmin ? (
              <>
                <Descriptions.Item label="分组">{detail.group_name || "-"}</Descriptions.Item>
                <Descriptions.Item label="密钥">
                  {detail.token_name ? `#${detail.token_id} ${detail.token_name}` : "账户额度（未用密钥）"}
                </Descriptions.Item>
                <Descriptions.Item label="渠道">
                  {detail.channel_name ? `#${detail.channel_id} ${detail.channel_name}` : "-"}
                </Descriptions.Item>
                <Descriptions.Item label="User-Agent">{detail.user_agent || "-"}</Descriptions.Item>
                {/* 输入 / 输出原文 —— 用户要求：「历史记录原始明细没存储输入和输出实际内容
                    （仅管理员可见）？」。整块在 isAdmin 分支里，普通用户连 detail 列都取不到
                    （后端按 isAdmin 裁剪列，见 routes/log.js）。
                    后端各截断到 4000 字符并带 text_truncated 标记，这里照实提示。 */}
                <Descriptions.Item label="输入内容">
                  <LogTextBlock
                    text={parsedDetail?.prompt_text}
                    truncated={parsedDetail?.text_truncated}
                    empty="（该记录未存输入原文，可能是本次升级之前的调用）"
                  />
                </Descriptions.Item>
                <Descriptions.Item label="输出内容">
                  <LogTextBlock
                    text={parsedDetail?.output_text}
                    truncated={parsedDetail?.text_truncated}
                    empty="（该记录未存输出原文，可能是本次升级之前的调用）"
                  />
                </Descriptions.Item>
                <Descriptions.Item label="原始明细">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, wordBreak: "break-all" }}>
                    {detail.detail || "-"}
                  </span>
                </Descriptions.Item>
              </>
            ) : null}
          </Descriptions>
          );
        })() : null}
      </Drawer>
    </div>
  );
}
