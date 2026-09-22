import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Table, Tag, Input, Select, Button, Alert, App as AntApp, Tooltip, Drawer, Descriptions } from "antd";
import { ReloadOutlined, HistoryOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, fmtOd, unitsPerOd } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";

// 操作日志 = 非消费类记录（充值/管理/错误/登录）。
// 与「使用记录」分开的原因：使用记录是**用量审计**（每次模型调用），
// 操作日志是**行为审计**（谁改了渠道、谁删了用户、谁登录过），
// 两者查询维度、保留策略、读者都不同，混在一起会让真正的操作记录被调用记录淹没。
const TYPE_COLOR = { 1: "gold", 3: "purple", 4: "red", 5: "cyan" };

const TYPE_OPTIONS = [
  { value: 0, label: "全部类型" },
  { value: 1, label: "充值" },
  { value: 3, label: "管理" },
  { value: 4, label: "错误" },
  { value: 5, label: "登录" },
];

const RANGE_OPTIONS = [
  { value: 1, label: "今天" },
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 0, label: "全部时间" },
];

export default function OperationLogPage() {
  const { user } = useApp();
  const { message } = AntApp.useApp();
  const isAdmin = Number(user?.role) >= 100;
  const perUnit = unitsPerOd(null);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState(0);
  const [days, setDays] = useState(30);
  const [detail, setDetail] = useState(null);
  const { begin, isLatest } = useLatest();

  const params = useMemo(
    // days 显式传（含 0=全部）：与使用记录页同一写法，避免后端默认值变化后两边口径分裂
    () => ({ days, keyword: keyword || undefined, type: type || undefined }),
    [days, keyword, type]
  );

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const data = await API.get("/log/operation", { params: { ...params, p: page, page_size: pageSize } });
      if (!isLatest(token)) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "操作日志加载失败");
        message.error(e.message || "操作日志加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [params, page, pageSize, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      title: "时间",
      dataIndex: "created_at",
      width: 165,
      sorter: (a, b) => (a.created_at || 0) - (b.created_at || 0),
      defaultSortOrder: "descend",
      render: (t) => <span className="oo-num" style={{ whiteSpace: "nowrap" }}>{fmtDate(t)}</span>,
    },
    {
      title: "操作者",
      dataIndex: "username",
      width: 150,
      render: (v, r) => <UserAvatar user={{ id: r.user_id, username: v }} size={22} showName />,
    },
    {
      title: "类型",
      dataIndex: "type",
      width: 90,
      render: (t, r) => <Tag color={TYPE_COLOR[t] || "default"}>{r.type_label}</Tag>,
    },
    {
      title: "内容",
      dataIndex: "content",
      ellipsis: true,
      render: (v) => <span style={{ fontSize: 12.5 }}>{v}</span>,
    },
    // 额度变动（充值/扣减）单独一列，便于核对账目
    {
      title: "额度变动",
      dataIndex: "quota",
      width: 120,
      render: (q, r) => {
        const n = Number(q) || 0;
        if (!n) return <span style={{ color: "var(--ink-3)" }}>-</span>;
        const sign = r.type === 1 ? "+" : "-";
        return (
          <span className="oo-num" style={{ color: r.type === 1 ? "var(--green)" : "var(--ink)" }}>
            {sign}
            {fmtOd(n, perUnit, 4)}
          </span>
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
        title="操作日志"
        extra={
          <>
            <Select value={days} onChange={(v) => { setDays(v); setPage(1); }} style={{ width: 110 }} options={RANGE_OPTIONS} />
            <Select
              value={type}
              onChange={(v) => { setType(v); setPage(1); }}
              style={{ width: 130 }}
              options={TYPE_OPTIONS}
            />
            <Input.Search
              placeholder={isAdmin ? "搜索用户 / 内容" : "搜索内容"}
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
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新" aria-label="刷新操作日志" />
          </>
        }
      />

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="操作日志加载失败"
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
          scroll={{ x: 1000 }}
          onRow={(r) => ({
            style: { cursor: "pointer" },
            // 键盘可达（与使用记录页一致）
            tabIndex: 0,
            role: "button",
            "aria-label": `查看 ${r.type_label || "操作"} 详情`,
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
                <HistoryOutlined style={{ fontSize: 32, color: "var(--ink-3)", display: "block", margin: "0 auto 10px" }} />
                暂无操作记录
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

      <Drawer title="操作详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={520} destroyOnClose>
        {detail ? (
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            <Descriptions.Item label="时间">{fmtDate(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="操作者">
              <UserAvatar user={{ id: detail.user_id, username: detail.username }} size={20} showName />
            </Descriptions.Item>
            <Descriptions.Item label="类型">{detail.type_label}</Descriptions.Item>
            <Descriptions.Item label="内容">{detail.content}</Descriptions.Item>
            {Number(detail.quota) ? (
              <Descriptions.Item label="额度变动">
                {detail.type === 1 ? "+" : "-"}
                {fmtOd(Number(detail.quota), perUnit, 4)}
              </Descriptions.Item>
            ) : null}
            <Descriptions.Item label="IP">{detail.ip || "-"}</Descriptions.Item>
            <Descriptions.Item label="设备">{detail.device || "-"}</Descriptions.Item>
            {isAdmin ? (
              <>
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
