import OdAmount from "../components/OdAmount";
import React, { useCallback, useEffect, useState } from "react";
import {  Table, Input, Tag, Alert, App as ArcApp  } from "../components/arc/index";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import PageHeader from "../components/PageHeader";
import ModelPricingLabel from "../components/ModelPricingLabel";

import { userDataVisibility } from "../services/visibility";

/** 公开报价受逐项策略控制；直达页面也不请求未开放的接口。 */
export default function PricingPage() {
  const { status, user } = useApp();
  const allowed = userDataVisibility(status, user).pricing;
  const { message } = ArcApp.useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    if (!allowed) { setLoading(false); setItems([]); return; }
    setLoading(true);
    try {
      const d = await API.get("/pricing/public");
      setItems(Array.isArray(d?.items) ? d.items : []);
      setDenied(false);
    } catch (e) {
      // 403 = 管理员把「向用户展示定价」关了：这不是错误，是配置，给一句说明即可
      if (e.status === 403) setDenied(true);
      else message.error(e.message || "价格加载失败");
    } finally {
      setLoading(false);
    }
  }, [message, allowed]);

  useEffect(() => {
    load();
  }, [load]);

  if (!allowed || denied) {
    return (
      <div className="oo-page">
        <PageHeader title="模型价格" />
        <Alert
          type="info"
          showIcon
          message="管理员未开启价格公示"
        />
      </div>
    );
  }

  const kw = q.trim().toLowerCase();
  const rows = kw ? items.filter((m) => String(m.model).toLowerCase().includes(kw)) : items;

  const columns = [
    {
      title: "模型",
      dataIndex: "model",
      width: 250,
      render: (v, r) => <ModelPricingLabel model={v} vendor={r.vendor} tiers={r.tiers} size={14} />,
    },
    {
      title: "输入（每百万 token）",
      dataIndex: "input",
      width: 180,
      sorter: (a, b) => Number(a.input) - Number(b.input),
      render: (v) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <OdAmount>{v === null || v === undefined ? "—" : Number(v)}</OdAmount>
        </span>
      ),
    },
    {
      title: "输出（每百万 token）",
      dataIndex: "output",
      width: 180,
      sorter: (a, b) => Number(a.output) - Number(b.output),
      render: (v) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <OdAmount>{v === null || v === undefined ? "—" : Number(v)}</OdAmount>
        </span>
      ),
    },
    {
      title: "缓存命中（每百万 token）",
      dataIndex: "cache",
      width: 190,
      render: (v) =>
        v !== null && v !== undefined ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <OdAmount>{Number(v)}</OdAmount>
          </span>
        ) : (
          <span style={{ color: "var(--ink-3)" }}>—</span>
        ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="模型价格"
        tags={
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
            共 {items.length} 个模型 · 每百万 Token
          </span>
        }
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="分档价格与分组倍率可能影响实际扣费。"
      />
      <div style={{ marginBottom: 12, maxWidth: 320 }}>
        <Input.Search placeholder="搜索模型名" allowClear value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Table
        className="oo-table"
        rowKey="model"
        loading={loading}
        size="small"
        columns={columns}
        dataSource={rows}
        tableLayout="fixed"
        scroll={{ x: columns.reduce((total, column) => total + column.width, 0) }}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (t) => `共 ${t} 个模型` }}
      />
    </div>
  );
}
