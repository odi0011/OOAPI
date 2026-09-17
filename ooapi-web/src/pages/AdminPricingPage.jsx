import React, { useEffect, useState } from "react";
import { Table, Input, Select, App as AntApp, Typography } from "antd";
import { ReloadOutlined, SearchOutlined, DollarOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { ModelLabel } from "../components/VendorIcon";
import { OdCoin } from "../components/OdCoin";
import { CURRENCY_NAME } from "../services/format";

const { Text } = Typography;

// 价格列表头：币种只在表头标一次，不在每一行重复（28 行 × 3 列会太吵）
const priceTitle = (label) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
    <OdCoin size={14} style={{ opacity: 0.8 }} />
    {label}
  </span>
);

const TYPE_LABEL = {
  "deepseek-web": "DeepSeek 网页版",
  openai: "OpenAI",
  claude: "Anthropic",
  gemini: "Google",
  qwen: "阿里通义",
  deepseek: "DeepSeek 官方",
  custom: "其他",
};

export default function AdminPricingPage() {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setItems(await API.get("/pricing/", { params: { keyword, type } }));
    } catch (e) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, type]);

  const columns = [
    {
      title: "模型 ID",
      dataIndex: "model",
      width: 230,
      render: (v) => <ModelLabel model={v} size={15} />,
    },
    {
      title: "渠道类型",
      dataIndex: "channel_type",
      width: 130,
      render: (v) => <span className="bui-chip">{TYPE_LABEL[v] || v || "—"}</span>,
    },
    {
      title: priceTitle("输入"),
      dataIndex: "input_price",
      width: 120,
      sorter: (a, b) => a.input_price - b.input_price,
      render: (v) => <span className="oo-num">{Number(v).toFixed(4)}</span>,
    },
    {
      title: priceTitle("输出"),
      dataIndex: "output_price",
      width: 120,
      sorter: (a, b) => a.output_price - b.output_price,
      render: (v) => <span className="oo-num">{Number(v).toFixed(4)}</span>,
    },
    {
      title: priceTitle("缓存命中"),
      dataIndex: "cache_price",
      width: 110,
      render: (v) =>
        Number(v) > 0 ? <span className="oo-num">{Number(v).toFixed(4)}</span> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: "价格来源",
      dataIndex: "remark",
      ellipsis: true,
      render: (v) => <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{v || "—"}</span>,
    },
  ];

  const cheapest = items.length
    ? items.reduce((a, b) => (Number(a.input_price) <= Number(b.input_price) ? a : b))
    : null;

  return (
    <div>
      <PageHeader
        title="模型定价"
        desc={`${CURRENCY_NAME}计价（1 ${CURRENCY_NAME} = 1 美元），单位为「${CURRENCY_NAME} / 百万 token」`}
        extra={
          <button className="bui-btn" onClick={load}>
            <ReloadOutlined /> 刷新
          </button>
        }
      />

      <div className="oo-grid" style={{ marginBottom: 16 }}>
        <StatCard label="已配置模型" value={items.length} icon={<DollarOutlined />} foot={<span>计价条目</span>} />
        <StatCard
          label="渠道类型"
          value={new Set(items.map((i) => i.channel_type).filter(Boolean)).size}
          foot={<span>覆盖厂商数</span>}
        />
        <StatCard
          label="最低输入价"
          value={cheapest ? Number(cheapest.input_price).toFixed(4) : "-"}
          suffix={CURRENCY_NAME}
          foot={<span>{cheapest?.model || "—"}</span>}
        />
        <StatCard label="币种" value={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><OdCoin size={22} />{CURRENCY_NAME}</span>} foot={<span>1 {CURRENCY_NAME} = 1 美元（1:1）</span>} />
      </div>

      <div className="oo-panel">
        <div className="oo-panel-head" style={{ gap: 10, justifyContent: "flex-start", flexWrap: "wrap" }}>
          <Input
            placeholder="搜索模型"
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
            style={{ width: 220 }}
            onPressEnter={(e) => setKeyword(e.target.value)}
            onChange={(e) => {
              if (!e.target.value) setKeyword("");
            }}
          />
          <Select
            placeholder="全部渠道类型"
            allowClear
            style={{ width: 160 }}
            value={type || undefined}
            onChange={(v) => setType(v || "")}
            options={Object.entries(TYPE_LABEL).map(([v, l]) => ({ value: v, label: l }))}
          />
        </div>
        <Table
          className="oo-table"
          rowKey="model"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 980 }}
          pagination={{ pageSize: 30, showSizeChanger: true, showTotal: (t) => `共 ${t} 个模型` }}
        />
      </div>

      <div className="oo-panel" style={{ marginTop: 16 }}>
        <div className="oo-panel-head">
          <span className="oo-panel-title">计费说明</span>
        </div>
        <div className="oo-panel-body">
          <div className="bui-kv">
            <span className="bui-kv-k">币制</span>
            <span className="bui-kv-v">1 {CURRENCY_NAME} = 1 美元（1:1），最小计费单位 0.0001 {CURRENCY_NAME}</span>
          </div>
          <div className="bui-kv">
            <span className="bui-kv-k">计费公式</span>
            <span className="bui-kv-v" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              (输入 token × 输入价 + 输出 token × 输出价 + 缓存命中 × 缓存价) ÷ 1,000,000
            </span>
          </div>
          <div className="bui-kv">
            <span className="bui-kv-k">数据来源</span>
            <span className="bui-kv-v">
              各厂商官方定价页（2026-09）；官方页不可达的采用公开挂牌价，已在「价格来源」列标注
            </span>
          </div>
          <div className="bui-kv">
            <span className="bui-kv-k">DeepSeek</span>
            <span className="bui-kv-v">取官方高峰时段价；非高峰时段官方减半，本表未区分</span>
          </div>
        </div>
      </div>
    </div>
  );
}
