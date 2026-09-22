import React, { useCallback, useEffect, useState } from "react";
import { Table, Input, Select, App as AntApp, Typography, Modal, Upload, Alert, Space, Button, Popconfirm, Tag, Tooltip } from "antd";
import { ReloadOutlined, SearchOutlined, DollarOutlined, UploadOutlined, ClearOutlined, CloudDownloadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
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

// 渠道类型显示名：与各厂商注册表一一对应。
// 注意：不存在「DeepSeek 网页版/官方」这种区分 —— 网页反代与官方 API 是同一批模型。
const TYPE_LABEL = {
  deepseek: "DeepSeek",
  glm: "智谱 GLM",
  kimi: "Kimi",
  doubao: "豆包",
  qwen: "通义千问",
  openai: "OpenAI",
  // 渠道类型统一用 anthropic（官方 API / Claude 订阅 / Kiro 工具反代都归到这里），
  // claude 只是历史遗留值，保留映射避免老数据展示成裸 id
  anthropic: "Anthropic",
  claude: "Anthropic",
  gemini: "Google",
  grok: "xAI Grok",
  custom: "其他（历史）",
};

// 导入模板（JSON）：模型 ID 必须与平台登记表严格一致
// 分时定价（可选）：offpeak_* = 闲时价，offpeak_rule 里 offset 是相对 UTC 的小时偏移
// （8 = 北京时间），peak 是高峰窗口，窗口之外按闲时价计费。
const importTemplate = {
  prices: [
    {
      model: "deepseek-flash",
      input: 0.3,
      output: 1.2,
      cache: 0.006,
      offpeak_input: 0.15,
      offpeak_output: 0.6,
      offpeak_cache: 0.003,
      offpeak_rule: "{\"offset\":8,\"days\":[1,2,3,4,5],\"peak\":[[\"09:00\",\"12:00\"],[\"14:00\",\"18:00\"]]}",
      remark: "官方峰谷价；来源 api-docs.deepseek.com/quick_start/pricing/",
    },
    {
      model: "deepseek-v4-pro",
      input: 1.32,
      output: 3.96,
      cache: 0.044,
      offpeak_input: 0.66,
      offpeak_output: 1.98,
      offpeak_cache: 0.022,
      offpeak_rule: "{\"offset\":8,\"days\":[1,2,3,4,5],\"peak\":[[\"09:00\",\"12:00\"],[\"14:00\",\"18:00\"]]}",
      remark: "官方峰谷价；来源 api-docs.deepseek.com/quick_start/pricing/",
    },
  ],
};

export default function AdminPricingPage() {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");
  const { begin, isLatest } = useLatest();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const data = await API.get("/pricing/", { params: { keyword, type } });
      if (!isLatest(token)) return;
      setItems(data);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "定价列表加载失败");
        message.error(e.message || "定价列表加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [keyword, type, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

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
      render: (v) => {
        if (!v) return <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>—</span>;
        // 过滤内部汇率折算与草稿公式（如 "÷ 7.2"、"¥.../¥..."），提取清爽的公开来源说明
        const cleaned = v
          .replace(/[¥￥][0-9.]+(?:\/[¥￥]?[0-9.]+|(?:\/缓存\s*[¥￥]?[0-9.]+))*/g, "")
          .replace(/÷\s*[0-9.]+/g, "")
          .replace(/；\s*；/g, "；")
          .replace(/；\s*来源\s*/g, " · ")
          .replace(/^来源\s*/g, "")
          .replace(/；\s*$/, "")
          .trim();
        return (
          <Tooltip title={v}>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)", cursor: "default" }}>
              {cleaned || v}
            </span>
          </Tooltip>
        );
      },
    },
    {
      // 分时（峰谷）定价：只有部分厂商按钟点差异定价（DeepSeek 官方工作日 9-12、14-18 为高峰）
      title: "分时",
      dataIndex: "offpeak_text",
      width: 240,
      ellipsis: true,
      render: (v, r) =>
        v ? (
          <Tooltip
            title={
              <div style={{ fontSize: 12 }}>
                <div>{v}</div>
                <div style={{ marginTop: 4 }}>
                  闲时：输入 {r.offpeak_input_price ?? "—"} / 输出 {r.offpeak_output_price ?? "—"} / 缓存{" "}
                  {r.offpeak_cache_price ?? "—"}
                </div>
              </div>
            }
          >
            <span className="bui-chip bui-chip--green" style={{ fontSize: 11.5 }}>峰谷价</span>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
        ),
    },
  ];

  const cheapest = items.length
    ? items.reduce((a, b) => (Number(a.input_price) <= Number(b.input_price) ? a : b))
    : null;

  const openImport = () => {
    setImportText("");
    setImportResult(null);
    setImportOpen(true);
  };

  // 文件在浏览器端读成文本，再整段提交（无需 multipart，便于统一 JSON 响应与校验）
  const readFile = (file) => {
    const isJson = /\.json$/i.test(file.name);
    const isCsv = /\.(csv|txt)$/i.test(file.name);
    if (!isJson && !isCsv) {
      message.error("只支持 .json / .csv 文件");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 1024 * 1024) {
      message.error("文件不能超过 1 MB");
      return Upload.LIST_IGNORE;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ""));
      setImportResult(null);
    };
    reader.onerror = () => message.error("文件读取失败");
    reader.readAsText(file);
    return false; // 阻止自动上传
  };

  const downloadTemplate = () => {
    const blob = new Blob([JSON.stringify(importTemplate, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ooapi-pricing-template.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const submitImport = async () => {
    if (!importText.trim()) return message.warning("请先选择文件");
    setImporting(true);
    try {
      const r = await API.post("/pricing/import", { text: importText });
      setImportResult(r);
      message.success(`导入完成：新增 ${r.inserted}，更新 ${r.updated}，拒绝 ${r.rejected?.length || 0}`);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setImporting(false);
    }
  };

  const prune = async () => {
    setCleaning(true);
    try {
      const r = await API.post("/pricing/prune");
      message.success(r.removed?.length ? `已删除 ${r.removed.length} 条无效定价` : "没有发现无效定价");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setCleaning(false);
    }
  };

  const syncDefaults = async () => {
    setSyncing(true);
    try {
      const r = await API.post("/pricing/sync-defaults");
      message.success(`已同步内置价目表 ${r.updated} 条`);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="模型定价"
        extra={
          <Space size={6} wrap>
            <Button size="small" icon={<UploadOutlined />} onClick={openImport}>
              上传文件更新
            </Button>
            <Popconfirm title="按内置官方价目表覆盖更新？" description="会同步价格与来源说明；管理员手改的价格也会被覆盖。" onConfirm={syncDefaults} okText="同步" cancelText="取消">
              <Button size="small" icon={<CloudDownloadOutlined />} loading={syncing}>
                同步官方价目
              </Button>
            </Popconfirm>
            <Popconfirm title="清理无效定价？" description="删除所有「模型 ID 未在平台注册」的垃圾数据（含历史遗留的错误模型）。" onConfirm={prune} okText="清理" cancelText="取消">
              <Button size="small" icon={<ClearOutlined />} loading={cleaning} danger>
                清理无效数据
              </Button>
            </Popconfirm>
            <Button size="small" icon={<ReloadOutlined />} onClick={load} title="刷新定价列表" aria-label="刷新定价列表" />
          </Space>
        }
      />

      <div className="oo-stats-cards">
        <StatCard label="已配置模型" value={loadError ? "—" : items.length} suffix="个" hint="平台生效计价条目" />
        <StatCard
          label="渠道类型"
          value={loadError ? "—" : new Set(items.map((i) => i.channel_type).filter(Boolean)).size}
          suffix="类"
          hint="覆盖上游厂商数"
        />
        <StatCard
          label="最低输入价"
          value={loadError ? "—" : cheapest ? Number(cheapest.input_price).toFixed(4) : "-"}
          suffix={CURRENCY_NAME}
          hint={loadError ? "加载失败" : `对应模型：${cheapest?.model || "—"}`}
        />
        <StatCard
          label="统一币制"
          value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><OdCoin size={18} />{CURRENCY_NAME}</span>}
          hint={`1 ${CURRENCY_NAME} = 1 美元（1:1 精确核算）`}
        />
      </div>

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="定价列表加载失败"
            description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <div className="oo-toolbar">
          <Input
            size="small"
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
            size="small"
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
          size="small"
          columns={columns}
          dataSource={items}
          scroll={{ x: 980 }}
          pagination={{ pageSize: 30, showSizeChanger: true, showTotal: (t) => `共 ${t} 个模型` }}
        />
      </div>

      <div className="oo-panel">
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
              每条来源写在「价格来源」列（官方定价页地址）；人民币计价的厂商按固定汇率折算为美元。
              禁止填写「同上」等无意义说明。
            </span>
          </div>
          <div className="bui-kv">
            <span className="bui-kv-k">DeepSeek</span>
            <span className="bui-kv-v">取官方高峰时段价；非高峰时段官方减半，本表未区分。网页反代与官方 API 是同一批模型</span>
          </div>
        </div>
      </div>

      <Modal
        title="上传文件更新定价"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        okText={importResult ? "继续导入" : "开始导入"}
        confirmLoading={importing}
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="文件约束（不符合的行会被拒绝并逐条列出）"
          description={
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.9 }}>
              <li>支持 JSON（数组或 <Text code>{"{ prices: [...] }"}</Text>）与 CSV（首行表头）</li>
              <li>必填：<Text code>model</Text>（模型 ID）、<Text code>input</Text>、<Text code>output</Text>；可选 <Text code>cache</Text>、<Text code>remark</Text></li>
              <li>
                <b>模型 ID 必须与平台已注册模型严格一致</b>（渠道里声明过的模型），否则视为垃圾数据拒绝；
                渠道类型如填写也须与厂商一致
              </li>
              <li>价格单位：{CURRENCY_NAME} / 百万 token，0 ≤ 单价 ≤ 100000；文件 ≤ 1 MB、单次 ≤ 2000 行</li>
            </ul>
          }
        />
        <Space style={{ marginBottom: 12 }}>
          <Upload beforeUpload={readFile} showUploadList={false} accept=".json,.csv,.txt">
            <Button icon={<UploadOutlined />}>选择 JSON / CSV 文件</Button>
          </Upload>
          <Button type="link" onClick={downloadTemplate}>
            下载模板
          </Button>
          {importText ? <Tag color="blue">已读取 {importText.length} 字符</Tag> : null}
        </Space>

        {importResult && (
          <div style={{ marginTop: 4 }}>
            <Space size={8} wrap style={{ marginBottom: 8 }}>
              <Tag color="green">新增 {importResult.inserted}</Tag>
              <Tag color="blue">更新 {importResult.updated}</Tag>
              <Tag color={importResult.rejected?.length ? "red" : "default"}>拒绝 {importResult.rejected?.length || 0}</Tag>
              <Tag>共 {importResult.total} 行</Tag>
            </Space>
            {importResult.rejected?.length ? (
              <div className="oo-scroll" style={{ maxHeight: 220 }}>
                <Table
                  size="small"
                  rowKey={(r) => `${r.line}-${r.model}`}
                  pagination={false}
                  dataSource={importResult.rejected}
                  columns={[
                    { title: "行", dataIndex: "line", width: 56 },
                    { title: "模型", dataIndex: "model", width: 160, ellipsis: true },
                    { title: "拒绝原因", dataIndex: "reason" },
                  ]}
                />
              </div>
            ) : (
              <Text type="success">全部通过校验</Text>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
