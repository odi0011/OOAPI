import React, { useEffect, useState, useCallback } from "react";
import { Table, Tag, Input, Select, Space, Button, Alert, App as AntApp } from "antd";
import { ReloadOutlined, FileTextOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate, fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { VendorIcon } from "../components/VendorIcon";

const TYPE_COLOR = { 1: "gold", 2: "blue", 3: "purple", 4: "red", 5: "cyan" };

const TYPE_OPTIONS = [
  { value: 0, label: "全部类型" },
  { value: 1, label: "充值" },
  { value: 2, label: "消费" },
  { value: 3, label: "管理" },
  { value: 4, label: "错误" },
  { value: 5, label: "登录" },
];

// 历史日志里存的是改名前的「OD」，新日志写的是「OD币」。
// 这里只在**展示时**归一化，不改数据库（历史记录保持原样可追溯）。
function normalizeCurrency(text) {
  return String(text || "").replace(/(\d)\s*OD(?!币)/g, `$1 ${CURRENCY_NAME}`);
}

export default function LogPage() {
  const { user, status } = useApp();
  const { message } = AntApp.useApp();
  const isAdmin = user?.role >= 100;
  const perUnit = unitsPerOd(status);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState(0);
  const { begin, isLatest } = useLatest();

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const path = isAdmin ? "/log/" : "/log/self";
      const data = await API.get(path, { params: { p: page, page_size: pageSize, keyword, type } });
      if (!isLatest(token)) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "日志加载失败");
        message.error(e.message || "日志加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [isAdmin, page, pageSize, keyword, type, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      title: "时间",
      dataIndex: "created_at",
      width: 165,
      render: (t) => <span className="oo-num">{fmtDate(t)}</span>,
    },
    ...(isAdmin
      ? [
          {
            title: "用户",
            dataIndex: "username",
            width: 130,
            ellipsis: true,
          },
        ]
      : []),
    {
      title: "类型",
      dataIndex: "type",
      width: 88,
      render: (t, r) => <Tag color={TYPE_COLOR[t] || "default"}>{r.type_label}</Tag>,
    },
    {
      title: "内容",
      dataIndex: "content",
      ellipsis: true,
      render: (text) => {
        // 从日志内容里提取模型名（形如 "调用 deepseek-flash · ..."）
        const m = /(?:调用|对话|智能体)\s*[·•]?\s*([a-zA-Z0-9._-]+)/.exec(String(text || ""));
        const modelName = m && /^(deepseek|gpt|o[0-9]|claude|gemini|qwen|glm|kimi|doubao)/i.test(m[1]) ? m[1] : null;
        if (!modelName) return <span>{normalizeCurrency(text)}</span>;

        const rest = normalizeCurrency(String(text).replace(modelName, ""));
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <VendorIcon type={/^deepseek/i.test(modelName) ? "deepseek" : /^claude/i.test(modelName) ? "claude" : /^gemini/i.test(modelName) ? "gemini" : /^qwen/i.test(modelName) ? "qwen" : /^glm/i.test(modelName) ? "zhipu" : /^kimi/i.test(modelName) ? "kimi" : /^doubao/i.test(modelName) ? "doubao" : "openai"} size={14} />
            <span className="oo-truncate" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{modelName}</span>
            <span className="oo-truncate" style={{ color: "var(--ink-3)", fontSize: 12 }}>{rest}</span>
          </span>
        );
      },
    },
    {
      title: "额度",
      dataIndex: "quota",
      width: 110,
      render: (q, r) => {
        const n = Number(q);
        if (!n) return <span style={{ color: "var(--oo-text-disabled)" }}>-</span>;
        // 充值/补充是「+」，消费/错误是「-」；旧实现把所有正数都显示成负数
        const sign = r.type === 1 ? "+" : "-";
        const color = r.type === 1 ? "var(--oo-green, var(--oo-text))" : "var(--oo-text)";
        return (
          <span className="oo-num" style={{ color }}>
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
      render: (v) => <span className="oo-num" style={{ color: "var(--oo-text-muted)" }}>{v || "-"}</span>,
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="使用记录"
        desc={isAdmin ? "全平台调用与操作日志" : "你的调用明细与消费记录"}
        extra={
          <>
            {isAdmin && (
              <Select
                value={type}
                onChange={(v) => {
                  setType(v);
                  setPage(1);
                }}
                style={{ width: 130 }}
                options={TYPE_OPTIONS}
              />
            )}
            {isAdmin && (
              <Input.Search
                placeholder="搜索用户 / 内容"
                allowClear
                style={{ width: 240 }}
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
            )}
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新日志" aria-label="刷新日志" />
          </>
        }
      />

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="日志加载失败"
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
          scroll={{ x: 900 }}
          locale={{
            emptyText: (
              <div style={{ padding: "32px 0", color: "var(--oo-text-muted)" }}>
                <FileTextOutlined style={{ fontSize: 32, color: "var(--oo-text-disabled)", display: "block", margin: "0 auto 10px" }} />
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
    </div>
  );
}
