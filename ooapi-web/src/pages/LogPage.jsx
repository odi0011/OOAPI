import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Table, Input, Select, Button, Alert, App as AntApp, Tooltip, Drawer, Descriptions } from "antd";
import { ReloadOutlined, FileTextOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { ModelLabel } from "../components/VendorIcon";
import UserAvatar from "../components/UserAvatar";

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

const RANGE_OPTIONS = [
  { value: 1, label: "今天" },
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 0, label: "全部" },
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

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({ models: [], tokens: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [model, setModel] = useState("");
  const [tokenId, setTokenId] = useState(0);
  const [days, setDays] = useState(7);
  const [detail, setDetail] = useState(null);
  const { begin, isLatest } = useLatest();

  const params = useMemo(
    () => ({
      // 「全部」时显式传 days=0：后端 timeRange 对 0 才是不限时间。
      // 若传 undefined，/usage/summary 会用它自己的默认 30 天窗口，
      // 于是「表格是全量、卡片是近 30 天」——同一页两个口径，会误导人。
      days: days,
      keyword: keyword || undefined,
      model: model || undefined,
      token_id: tokenId || undefined,
    }),
    [days, keyword, model, tokenId]
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

  // 筛选下拉的候选项（模型/密钥）：与列表同一时间口径（含「全部」）
  useEffect(() => {
    let alive = true;
    API.get("/log/usage/filters", { params: { days } })
      .then((d) => {
        if (alive) setFilters({ models: d.models || [], tokens: d.tokens || [] });
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
      width: 158,
      render: (t) => <span className="oo-num">{fmtDate(t)}</span>,
    },
    // 管理员：用户（头像 + 名字）；普通用户看到的是自己，不需要这一列
    ...(isAdmin
      ? [
          {
            title: "用户",
            dataIndex: "username",
            width: 150,
            render: (v, r) => <UserAvatar user={{ id: r.user_id, username: v }} size={22} showName />,
          },
        ]
      : []),
    {
      title: "模型",
      dataIndex: "model",
      width: 150,
      render: (v) => (v ? <ModelLabel model={v} size={14} /> : <span style={{ color: "var(--ink-3)" }}>-</span>),
    },
    // 管理员：分组 / 密钥 / 渠道（普通用户隐藏：分组=倍率口径，密钥与渠道属于平台配置）
    ...(isAdmin
      ? [
          {
            title: "分组",
            dataIndex: "group_name",
            width: 110,
            render: (v) => (v ? <span className="bui-chip">{v}</span> : <span style={{ color: "var(--ink-3)" }}>-</span>),
          },
          {
            title: "密钥",
            dataIndex: "token_name",
            width: 120,
            ellipsis: true,
            render: (v, r) =>
              // token_id 有值但名字缺失（历史数据）也要显示成密钥而不是「账户额度」，
              // 否则「筛选里能选到该密钥、表格里显示账户额度」会自相矛盾
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
            title: "渠道",
            dataIndex: "channel_name",
            width: 150,
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
    {
      title: "调用内容",
      dataIndex: "content",
      width: 300,
      ellipsis: true,
      render: (text) => <span style={{ fontSize: 12.5 }}>{normalizeCurrency(text)}</span>,
    },
    {
      title: "首Token",
      dataIndex: "first_token_ms",
      width: 92,
      sorter: (a, b) => (a.first_token_ms || 0) - (b.first_token_ms || 0),
      render: (v) => <span className="oo-num" style={{ color: msColor(v) }}>{ms(v)}</span>,
    },
    {
      title: "总耗时",
      dataIndex: "elapsed_ms",
      width: 92,
      sorter: (a, b) => (a.elapsed_ms || 0) - (b.elapsed_ms || 0),
      render: (v) => <span className="oo-num" style={{ color: msColor(v) }}>{ms(v)}</span>,
    },
    {
      title: "tokens",
      dataIndex: "prompt_tokens",
      width: 150,
      render: (v, r) => (
        <Tooltip title={`提示 ${v} · 补全 ${r.completion_tokens} · 缓存 ${r.cache_tokens}`}>
          <span className="oo-num" style={{ fontSize: 12.5 }}>
            {Number(v) || 0}
            <span style={{ color: "var(--ink-3)" }}> / </span>
            {Number(r.completion_tokens) || 0}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "缓存",
      dataIndex: "cache_tokens",
      width: 88,
      render: (v) =>
        Number(v) ? (
          <span className="oo-num" style={{ color: "var(--green)" }}>{Number(v)}</span>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>-</span>
        ),
    },
    {
      title: "计费",
      dataIndex: "quota",
      width: 108,
      sorter: (a, b) => (Number(a.quota) || 0) - (Number(b.quota) || 0),
      render: (q) => {
        const n = Number(q) || 0;
        return n ? (
          <span className="oo-num">{fmtOd(n, perUnit, 6)}</span>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>-</span>
        );
      },
    },
    {
      title: "IP",
      dataIndex: "ip",
      width: 128,
      ellipsis: true,
      render: (v) => <span className="oo-num" style={{ color: "var(--ink-3)" }}>{v || "-"}</span>,
    },
    {
      title: "设备",
      dataIndex: "device",
      width: 140,
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
          <>
            <Select
              value={days}
              onChange={(v) => { setDays(v); setPage(1); }}
              style={{ width: 110 }}
              options={RANGE_OPTIONS}
            />
            <Select
              value={model || undefined}
              onChange={(v) => { setModel(v || ""); setPage(1); }}
              style={{ width: 170 }}
              allowClear
              showSearch
              placeholder="全部模型"
              options={filters.models.map((m) => ({ value: m.model, label: `${m.model}（${m.count}）` }))}
            />
            <Select
              value={tokenId || undefined}
              onChange={(v) => { setTokenId(v || 0); setPage(1); }}
              style={{ width: 160 }}
              allowClear
              placeholder="全部密钥"
              options={filters.tokens.map((t) => ({ value: t.id, label: `${t.name}（${t.count}）` }))}
            />
            <Input.Search
              placeholder={isAdmin ? "搜索用户 / 内容 / 模型" : "搜索内容 / 模型"}
              allowClear
              style={{ width: 220 }}
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
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新" aria-label="刷新使用记录" />
          </>
        }
      />

      {summary ? (
        <div className="oo-stats-cards">
          <StatCard label="调用次数" value={summary.calls} />
          <StatCard label="消耗" value={`${fmtOd(summary.units, perUnit, 4)}`} foot={CURRENCY_NAME} />
          <StatCard
            label="Tokens"
            value={summary.prompt_tokens + summary.completion_tokens}
            foot={`提示 ${summary.prompt_tokens} / 补全 ${summary.completion_tokens}`}
          />
          <StatCard label="缓存命中率" value={`${summary.cache_rate}%`} foot={`命中 ${summary.cache_tokens}`} />
          <StatCard label="平均首Token" value={ms(summary.avg_first_token)} />
          <StatCard label="平均耗时" value={ms(summary.avg_elapsed)} />
        </div>
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
          size="small"
          // scroll.x 必须 ≥ 各列宽度之和，否则带 ellipsis 的列会被压成 0 宽（table-layout: fixed）
          scroll={{ x: isAdmin ? 2000 : 1480 }}
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
        {detail ? (
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            <Descriptions.Item label="时间">{fmtDate(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="用户">
              <UserAvatar user={{ id: detail.user_id, username: detail.username }} size={20} showName />
            </Descriptions.Item>
            <Descriptions.Item label="模型">{detail.model || "-"}</Descriptions.Item>
            <Descriptions.Item label="调用内容">{normalizeCurrency(detail.content)}</Descriptions.Item>
            <Descriptions.Item label="Tokens">
              提示 {detail.prompt_tokens} · 补全 {detail.completion_tokens}
              {detail.cache_tokens ? ` · 缓存 ${detail.cache_tokens}` : ""}
            </Descriptions.Item>
            <Descriptions.Item label="首Token / 总耗时">
              {ms(detail.first_token_ms)} / {ms(detail.elapsed_ms)}
            </Descriptions.Item>
            <Descriptions.Item label="计费">{fmtOd(Number(detail.quota) || 0, perUnit, 6)}</Descriptions.Item>
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
                <Descriptions.Item label="原始明细">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, wordBreak: "break-all" }}>
                    {detail.detail || "-"}
                  </span>
                </Descriptions.Item>
              </>
            ) : null}
          </Descriptions>
        ) : null}
      </Drawer>
    </div>
  );
}
