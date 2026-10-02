import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Table, Input, Select, Button, Alert, App as AntApp, Tooltip, Drawer, Descriptions, Space, Typography } from "antd";
import { ReloadOutlined, FileTextOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { OdCoin } from "../components/OdCoin";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UsageAnalysis from "../components/UsageAnalysis";
import { ModelLabel, GroupTag } from "../components/VendorIcon";
import UserAvatar from "../components/UserAvatar";
import { DurationCell, TokenCell, formatDuration } from "../components/UsageCells";
import { BillingAmount, BillingDetails } from "../components/BillingDetails";
import { userDataVisibility } from "../services/visibility";

const { Text } = Typography;

// 历史日志里存的是改名前的「OD」，新日志写的是「OD币」。
// 只在展示时归一化，不改数据库（历史记录保持原样可追溯）。
function normalizeCurrency(text) {
  return String(text || "").replace(/(\d)\s*OD(?!币)/g, `$1 ${CURRENCY_NAME}`);
}

const ms = formatDuration;

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
          原文较长，已保留部分内容（最多 4000 字符）
        </span>
      ) : null}
    </div>
  );
}

const RANGE_OPTIONS = [
  { value: 1, label: "近 24 小时" },
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
  const visibility = userDataVisibility(status, user);
  const perUnit = unitsPerOd(status);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({ models: [], tokens: [], groups: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [denied, setDenied] = useState(false);
  // ?keyword= 预填：平台看板「用户消费排行」点进来时按用户名筛选
  const [keyword, setKeyword] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("keyword") || "";
    } catch {
      return "";
    }
  });
  const [model, setModel] = useState("");
  const [tokenId, setTokenId] = useState(0);
  const [group, setGroup] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [days, setDays] = useState(30);
  const [detail, setDetail] = useState(null);
  // 分组元信息（倍率/备注/成员厂商）：分组列按「折叠态厂商图标 + 分组名」展示
  const [groupMeta, setGroupMeta] = useState([]);
  const { begin, isLatest } = useLatest();

  useEffect(() => {
    if (!visibility.usage_records) return;
    API.get("/token/groups")
      .then((list) => setGroupMeta(Array.isArray(list) ? list : []))
      .catch(() => setGroupMeta([]));
  }, [visibility.usage_records]);

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
      status: statusFilter || undefined,
    }),
    [days, keyword, model, tokenId, group, statusFilter]
  );

  const load = useCallback(async () => {
    const token = begin();
    if (!visibility.usage_records) { setLoading(false); setItems([]); setSummary(null); setDetail(null); return; }
    setLoading(true);
    setLoadError("");
    // 列表与汇总分开取：汇总走聚合 SQL（COUNT/SUM/AVG），比列表更容易慢或失败，
    // 用 allSettled 保证「汇总挂了列表照常显示」，而不是整页空白。
    const [listRes, sumRes] = await Promise.allSettled([
      API.get("/log/usage", { params: { ...params, p: page, page_size: pageSize } }),
      visibility.usage_summary ? API.get("/log/usage/summary", { params }) : Promise.resolve(null),
    ]);
    if (!isLatest(token)) return;
    if (listRes.status === "fulfilled") {
      setItems(listRes.value.items || []);
      setTotal(listRes.value.total || 0);
      setLoadError("");
      setDenied(false);
    } else {
      if (listRes.reason?.status === 403) { setDenied(true); setItems([]); setSummary(null); setLoading(false); return; }
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
  }, [params, page, pageSize, message, begin, isLatest, visibility.usage_records, visibility.usage_summary]);

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
  const analysisRequest = useRef(0);

  const loadAnalysis = useCallback(
    async () => {
      if (!visibility.usage_records || !visibility.usage_summary) return;
      const request = ++analysisRequest.current;
      setAnalysisLoading(true);
      setAnalysisError("");
      try {
        const d = await API.get("/log/usage/analysis", { params });
        if (request !== analysisRequest.current) return;
        setByDay(Array.isArray(d?.byDay) ? d.byDay : []);
        setByModel(Array.isArray(d?.byModel) ? d.byModel : []);
        setModelSeries(Array.isArray(d?.modelSeries) ? d.modelSeries : []);
        setHourly(Array.isArray(d?.hourly) ? d.hourly : []);
      } catch (e) {
        if (request !== analysisRequest.current) return;
        setAnalysisError(e.message || "分析数据加载失败");
      } finally {
        if (request === analysisRequest.current) setAnalysisLoading(false);
      }
    },
    [params, visibility.usage_records, visibility.usage_summary]
  );

  // 展开时按当前时间范围加载；切范围后重新拉
  useEffect(() => {
    if (analysisOpen && visibility.usage_summary) loadAnalysis();
    return () => { analysisRequest.current += 1; };
  }, [analysisOpen, loadAnalysis, visibility.usage_summary]);

  // 筛选下拉的候选项（模型/密钥/分组）：与列表同一时间口径（含「全部」）
  useEffect(() => {
    if (!visibility.usage_records) return;
    let alive = true;
    API.get("/log/usage/filters", { params: { days, status: statusFilter || undefined } })
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
  }, [days, statusFilter, visibility.usage_records]);

  const columns = [
    {
      title: "时间",
      dataIndex: "created_at",
      width: 115,
      sorter: (a, b) => (a.created_at || 0) - (b.created_at || 0),
      defaultSortOrder: "descend",
      render: (t) => <span className="oo-num" title={fmtDate(t)} style={{ display: "inline-flex", flexDirection: "column", gap: 2, whiteSpace: "nowrap", fontSize: 12 }}><span>{fmtDate(t, "HH:mm:ss")}</span><span style={{ color: "var(--ink-3)", fontSize: 11 }}>{fmtDate(t, "YYYY-MM-DD")}</span></span>,
    },
    // 管理员：用户（头像 + 名字）；普通用户看到的是自己，不需要这一列
    ...(isAdmin
      ? [
          {
            title: "用户",
            dataIndex: "username",
            width: 115,
            render: (v, r) => <UserAvatar user={{ id: r.user_id, username: v }} size={22} showName />,
          },
        ]
      : []),
    {
      title: "模型",
      dataIndex: "model",
      // 窄屏加宽：模型名是这一列的核心信息，被截成 `deepseek-v4.1-fl`
      // 就失去意义了（黑盒测试在 390 视口实测：单元格 145px、内容 158px，被右侧裁掉）。
      width: 190,
      // 使用记录反映实际渠道来源；多次调用可有多个来源，不能按模型名猜原厂。
      // title 属性兜底：真的放不下时还能看到全名。
      render: (v, r) =>
        v ? (
          <span title={String(v)} style={{ display: "inline-flex", minWidth: 0 }}>
            <ModelLabel model={v} size={14} channelTypes={Array.isArray(r.source_vendors) ? r.source_vendors : r.channel_type ? [r.channel_type] : []} />
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
            width: 120,
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
      width: 112,
      sorter: (a, b) => (Number(a.quota) || 0) - (Number(b.quota) || 0),
      render: (q, r) => {
        const failed = r.status === "error";
        const stopped = r.status === "stopped";
        const stateText = failed ? "调用失败" : stopped ? "已停止" : "";
        return (
          <span className="oo-log-billing">
            {stateText ? <span className={`oo-log-status-label oo-log-status-label--${r.status}`}>{stateText}</span> : null}
            {visibility.pricing ? <BillingAmount record={r} isAdmin={isAdmin} perUnit={perUnit} /> : <span className="oo-num">{r.billing_known === false ? "费用待核查" : r.quota === undefined || r.quota === null ? "—" : fmtOd(r.quota, perUnit, 4)}</span>}
          </span>
        );
      },
    },
    {
      title: "Tokens",
      dataIndex: "prompt_tokens",
      width: 164,
      render: (v, r) => <TokenCell promptTokens={v} completionTokens={r.completion_tokens} cacheTokens={r.cache_tokens} />,
    },
    {
      title: "耗时",
      dataIndex: "elapsed_ms",
      width: 112,
      sorter: (a, b) => (a.elapsed_ms || 0) - (b.elapsed_ms || 0),
      render: (v, r) => <DurationCell firstTokenMs={r.first_token_ms} elapsedMs={v} />,
    },
    // 管理员：渠道与密钥
    ...(isAdmin
      ? [
          {
            title: "渠道",
            dataIndex: "channel_name",
            width: 120,
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
      width: 110,
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
      width: 185,
      ellipsis: true,
      render: (text) => (
        <Tooltip title={normalizeCurrency(text)}>
          <span style={{ fontSize: 12.5 }}>{normalizeCurrency(text)}</span>
        </Tooltip>
      ),
    },
    {
      title: "来源",
      dataIndex: "ip",
      width: 150,
      ellipsis: true,
      render: (v, r) => <Tooltip title={isAdmin && r.user_agent ? r.user_agent : `${v || "—"} · ${r.device || "未知设备"}`}><span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, fontSize: 11 }}><span className="oo-num oo-truncate">{v || "—"}</span><span className="oo-truncate" style={{ color: "var(--ink-3)" }}>{r.device || "未知设备"}</span></span></Tooltip>,
    },
  ];

  if (!visibility.usage_records || denied) return <div className="oo-page"><PageHeader title="使用记录" /><Alert type="info" showIcon message="管理员未开放使用记录" /></div>;

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
            <Select
              size="small"
              value={statusFilter || undefined}
              onChange={(v) => { setStatusFilter(v || ""); setPage(1); }}
              style={{ width: 105 }}
              allowClear
              placeholder="全部状态"
              options={[{ value: "success", label: "成功" }, { value: "error", label: "错误" }, { value: "stopped", label: "已停止" }]}
            />
            <Input.Search
              size="small"
              placeholder={visibility.request_content ? isAdmin ? "搜索用户 / 内容 / 模型" : "搜索内容 / 模型" : isAdmin ? "搜索用户 / 模型" : "搜索模型"}
              allowClear
              defaultValue={keyword}
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
      {visibility.usage_summary && summary ? (
        <div className="oo-stats-strip">
          <span className="bui-chip" title="区间调用次数">
            调用 <b className="oo-num">{summary.calls}</b>
          </span>
          {summary.errors > 0 ? <span className="bui-chip" style={{ color: "var(--red)" }} title="失败调用，部分已产生用量的调用仍按实际用量计费">错误 <b className="oo-num">{summary.errors}</b></span> : null}
          {summary.stopped > 0 ? <span className="bui-chip" title="用户停止的调用">已停止 <b className="oo-num">{summary.stopped}</b></span> : null}
          <span className="bui-chip" title="区间消耗">
            消耗 <OdCoin size={12} /> <b className="oo-num">{summary.units === undefined || summary.units === null ? "—" : fmtOd(summary.units, perUnit, 4, false)}</b>
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

      {visibility.usage_summary && analysisOpen ? (
        <UsageAnalysis
          byDay={byDay}
          byModel={byModel}
          modelSeries={modelSeries}
          hourly={hourly}
          loading={analysisLoading}
          error={analysisError}
          perUnit={perUnit}
          onRefresh={loadAnalysis}
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
          scroll={{ x: columns.reduce((sum, col) => sum + (Number(col.width) || 0), 0) }}
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
        width="min(520px, 100vw)"
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
          <>
          {visibility.pricing ? <div className="oo-log-billing-detail"><BillingDetails record={detail} isAdmin={isAdmin} perUnit={perUnit} /></div> : null}
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            <Descriptions.Item label="时间">{fmtDate(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="用户">
              <UserAvatar user={{ id: detail.user_id, username: detail.username }} size={20} showName />
            </Descriptions.Item>
            <Descriptions.Item label="模型">
              <ModelLabel model={detail.model} size={15} channelTypes={Array.isArray(detail.source_vendors) ? detail.source_vendors : detail.channel_type ? [detail.channel_type] : []} />
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
            <Descriptions.Item label="计费">{detail.billing_known === false ? "费用待核查" : fmtOd(Number(detail.quota) || 0, perUnit, 6)}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <span className={`oo-log-status-label oo-log-status-label--${detail.status || "success"}`}>
                {detail.status === "error" ? `错误${detail.error_code ? ` · ${detail.error_code}` : ""}` : detail.status === "stopped" ? "已停止" : "成功"}
              </span>
            </Descriptions.Item>
            {visibility.request_content ? <><Descriptions.Item label="实际输入">
              <LogTextBlock text={detail.input_text} truncated={detail.input_truncated} empty={detail.input_recorded ? "（本次输入没有文本）" : "（该记录未保存用户输入）"} />
            </Descriptions.Item>
            <Descriptions.Item label="输出内容">
              <LogTextBlock text={detail.output_text} truncated={detail.output_truncated} empty={detail.output_recorded ? "（本次调用没有输出）" : "（该记录未保存输出原文）"} />
            </Descriptions.Item></> : null}
            {/* 请求 ID 用于追溯同一调用；失败账单与状态保存在同一行。 */}
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
                <Descriptions.Item label="请求模型">{detail.requested_model || parsedDetail?.requested_model || detail.model || "-"}</Descriptions.Item>
                <Descriptions.Item label="上游模型">{detail.upstream_model || parsedDetail?.upstream_model || "（该记录未保存上游模型名）"}</Descriptions.Item>
                <Descriptions.Item label="计价模型">{detail.pricing_model || parsedDetail?.pricing_model || detail.model || "-"}</Descriptions.Item>
                <Descriptions.Item label="分组">{detail.group_name || "-"}</Descriptions.Item>
                <Descriptions.Item label="密钥">
                  {detail.token_name ? `#${detail.token_id} ${detail.token_name}` : "账户额度（未用密钥）"}
                </Descriptions.Item>
                <Descriptions.Item label="渠道">
                  {detail.channel_name ? `#${detail.channel_id} ${detail.channel_name}` : "-"}
                </Descriptions.Item>
                <Descriptions.Item label="User-Agent">{detail.user_agent || "-"}</Descriptions.Item>
                {/* 用户原文独立展示；完整上游上下文只对管理员开放。 */}
                <Descriptions.Item label="上游上下文">
                  <LogTextBlock
                    text={detail.request_prompt_text || parsedDetail?.prompt_text}
                    truncated={detail.prompt_truncated ?? parsedDetail?.prompt_truncated ?? parsedDetail?.text_truncated}
                    empty="（未保存上游上下文）"
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
          </>
          );
        })() : null}
      </Drawer>
    </div>
  );
}
