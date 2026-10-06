import { Descriptions } from "../components/arc/index";
import { Badge as ArcBadge } from "../components/arc/badge/badge";
import { Card as ArcPanel } from "../components/arc/card/card";
import ModelAttributions from "../components/ModelAttributions";
import OdAmount from "../components/OdAmount";
import React, { useCallback, useEffect, useState } from "react";
import {   Table, Input, Select, App as ArcApp, Typography, Modal, Upload, Alert, Space, Button, Popconfirm, Tag, Tooltip, Checkbox, Row, Col  } from "../components/arc/index";
import { ReloadOutlined, SearchOutlined, DollarOutlined, UploadOutlined, ClearOutlined, CloudDownloadOutlined, ApartmentOutlined, QuestionCircleOutlined  } from "../components/arc/icons";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { ModelLabel } from "../components/VendorIcon";
import ModelPricingLabel from "../components/ModelPricingLabel";
import { OdCoin } from "../components/OdCoin";


const { Text } = Typography;

// 表头标计量范围，币种统一放在每个金额末尾。
const priceTitle = (label) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
    {label} / 百万
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

export default function AdminPricingPage({ refreshKey = 0 }) {
  const { message } = ArcApp.useApp();
  const [items, setItems] = useState([]);
  const [catalogPending, setCatalogPending] = useState([]);
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
  useEffect(() => {
    API.get("/pricing/catalog-pending").then(list => setCatalogPending(Array.isArray(list) ? list : [])).catch(() => {});
  }, [refreshKey]);

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
  }, [load, refreshKey]);

  const columns = [
    {
      title: "模型 ID",
      dataIndex: "model",
      width: 230,
      render: (v, r) => <ModelPricingLabel model={v} vendor={r.channel_type} tiers={r.tiers} />,
    },
    {
      title: "渠道类型",
      dataIndex: "channel_type",
      width: 130,
      render: (v) => <ArcBadge size="sm" tone="neutral">{TYPE_LABEL[v] || v || "—"}</ArcBadge>,
    },
    {
      title: priceTitle("输入"),
      dataIndex: "input_price",
      width: 120,
      sorter: (a, b) => a.input_price - b.input_price,
      render: (v) => <OdAmount>{v == null ? "—" : Number(v).toFixed(4)}</OdAmount>,
    },
    {
      title: priceTitle("输出"),
      dataIndex: "output_price",
      width: 120,
      sorter: (a, b) => a.output_price - b.output_price,
      render: (v) => <OdAmount>{v == null ? "—" : Number(v).toFixed(4)}</OdAmount>,
    },
    {
      title: priceTitle("缓存命中"),
      dataIndex: "cache_price",
      width: 110,
      render: (v) =>
        v != null ? <OdAmount>{v == null ? "—" : Number(v).toFixed(4)}</OdAmount> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
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
                  闲时：输入 <OdAmount>{r.offpeak_input_price ?? "—"}</OdAmount> / 输出 <OdAmount>{r.offpeak_output_price ?? "—"}</OdAmount> / 缓存{" "}
                  <OdAmount>{r.offpeak_cache_price ?? "—"}</OdAmount>
                </div>
              </div>
            }
          >
            <ArcBadge size="sm" tone="success" style={{ fontSize: 11.5 }}>峰谷价</ArcBadge>
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

  // 同步上游价目：**真的去线上取价**（OpenRouter 公开模型目录，454 个模型全带价），
  // 不再是「把代码里那张静态表重写一遍」—— 老实现因此永远发现不了上游新模型
  //（用户实测反馈：「anthropic 今天出了新模型也没同步到」）。
  //
  // `overwrite` 是危险开关，默认关：库里已有的行不覆盖，保住管理员手工调过的价。
  // 打开它才会把上游价强行写回（用于「历史数据被改乱了想拉回官方口径」）。
  const [overwrite, setOverwrite] = useState(false);
  const syncUpstream = async () => {
    setSyncing(true);
    try {
      const r = await API.post("/pricing/sync-upstream", { overwrite });
      const bits = [];
      if (r.inserted) bits.push(`新增 ${r.inserted}`);
      if (r.updated) bits.push(`更新 ${r.updated}`);
      if (r.skipped) bits.push(`跳过 ${r.skipped}`);
      message.success(`已同步 ${r.fetched} 条已复核价目${bits.length ? `（${bits.join("、")}）` : ""}`);
      await load();
    } catch (e) {
      message.error(e.message || "同步失败");
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
            <Popconfirm
              title="从上游同步价目表？"
              description={
                <span style={{ fontSize: 12 }}>
                  只同步已核实的厂商报价，未核价的型号继续等待管理员配置。此操作
                  {overwrite ? "覆盖已有价格" : "仅补齐库里还没有的模型"}；聚合路由别名合并为同一模型。
                  {overwrite ? "⚠️ 已开启「覆盖已有价」，管理员手改的价格会被冲掉。" : ""}
                </span>
              }
              onConfirm={syncUpstream}
              okText="开始同步"
              cancelText="取消"
              width={420}
            >
              <Button size="small" icon={<CloudDownloadOutlined />} loading={syncing}>
                同步上游价目
              </Button>
            </Popconfirm>
            <Tooltip title="开启后连已有价格一起覆盖（会把管理员手改的价冲掉）">
              <Checkbox checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} style={{ fontSize: 12 }}>
                覆盖已有价
              </Checkbox>
            </Tooltip>
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
          suffix={<OdCoin size={12} muted />}
          hint={loadError ? "加载失败" : `对应模型：${cheapest?.model || "—"}`}
        />
        <StatCard
          label="统一币制"
          value={<OdCoin size={22} />}
        />
      </div>

      {catalogPending.some((m) => (!type || m.type === type) && (!keyword || m.model.toLowerCase().includes(keyword.toLowerCase()))) ? <Alert
        type="info" showIcon style={{ marginBottom: 16 }} message="新型号待定价"
        description={<div>
          <div style={{ marginBottom: 6 }}>官网已发布以下型号，尚未核定单价，可通过「导入定价」补充。</div>
          {catalogPending.filter((m) => (!type || m.type === type) && (!keyword || m.model.toLowerCase().includes(keyword.toLowerCase()))).map((m) =>
            <Tooltip key={m.model} title={`官方模型目录：${m.source}`}><Tag>{m.model}</Tag></Tooltip>)}
        </div>}
      /> : null}
      {/* 模型定价体检
          ----------------------------------------------------------------------
          用户反馈（原话）：「模型归属区域做的太模糊了我根本看不懂咋用，很反人类」。
          旧版失败在哪：它列的是**引擎内部指标**（规则 212 条 / 靠规则 7 个 / 未覆盖 0），
          回答的是「规则引擎怎么工作」，而管理员真正要知道的是三件事：
            ① 我现在有没有问题？（哪些模型没价、会被拦下）
            ② 有问题的话怎么修？（点哪个按钮）
            ③ 我怎么确认某个模型会被按什么价收费？（查一个看看）
          所以这一版改成**按「价格来源」分组**：每个来源是一个人话标签 + 数量 +
          「该怎么处理」，点开就是具体模型清单（带渠道名），每条还能直接跳去定价表改价。 */}
      <ModelAttributions revision={items} onChange={load} />

      <ArcPanel className="oo-panel">
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
      </ArcPanel>

      <ArcPanel className="oo-panel">
        <div className="oo-panel-head">
          <span className="oo-panel-title">计费说明</span>
        </div>
        <div className="oo-panel-body">
          <Descriptions items={[
            { label: "币制", children: <>最小计费单位 <OdAmount>0.0001</OdAmount></> },
            { label: "计费公式", children: <code>(输入 token × 输入价 + 输出 token × 输出价 + 缓存命中 × 缓存价) ÷ 1,000,000</code> },
            { label: "数据来源", children: "每条来源写在价格来源列（官方定价页地址），禁止填写同上等无意义说明。" },
            { label: "DeepSeek", children: "已配置闲时价的模型按请求发起时刻匹配峰谷时段；未配置闲时价时按基准价计费。具体价格与时段见表格。" },
          ]}/>
        </div>
      </ArcPanel>

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
              <li>价格单位：<OdCoin size={14} /> / 百万 token，0 ≤ 单价 ≤ 100000；文件 ≤ 1 MB、单次 ≤ 2000 行</li>
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
