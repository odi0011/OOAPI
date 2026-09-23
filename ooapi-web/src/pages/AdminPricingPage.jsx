import React, { useCallback, useEffect, useState } from "react";
import { Table, Input, Select, App as AntApp, Typography, Modal, Upload, Alert, Space, Button, Popconfirm, Tag, Tooltip, Checkbox, Row, Col } from "antd";
import { ReloadOutlined, SearchOutlined, DollarOutlined, UploadOutlined, ClearOutlined, CloudDownloadOutlined, ApartmentOutlined, QuestionCircleOutlined } from "@ant-design/icons";
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
  // 模型归属（把 `anthropic/claude-sonnet-4.5` 这类上游 id 自动对到真实厂商与价格）：
  //   attrib    —— 归属概览（规则覆盖了多少、多少落到 DB 价、多少没着落）
  //   resolveQ  —— 管理员贴一个模型名，即时看「会被当成谁、按什么价算」
  //   resolveR  —— 上一条的查询结果
  //   fixing    —— 「固化为定价」进行中
  const [attrib, setAttrib] = useState(null);
  const [attribOpen, setAttribOpen] = useState(""); // "" = 未展开；否则是展开的来源 key
  const [resolveQ, setResolveQ] = useState("");
  const [resolveR, setResolveR] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [fixing, setFixing] = useState("");

  const loadAttrib = useCallback(async () => {
    try {
      setAttrib(await API.get("/pricing/attribution"));
    } catch {
      /* 归属概览是辅助信息：拿不到就整块不显示，不能让定价页主体跟着报错 */
    }
  }, []);

  useEffect(() => {
    loadAttrib();
  }, [loadAttrib]);

  const doResolve = async () => {
    const q = String(resolveQ || "").trim();
    if (!q) return message.warning("请先输入要检查的模型名");
    setResolving(true);
    try {
      setResolveR(await API.get("/pricing/resolve", { params: { model: q } }));
    } catch (e) {
      message.error(e.message || "查询失败");
    } finally {
      setResolving(false);
    }
  };

  // 固化：把归属规则写进定价表，之后可在上方列表里逐条微调。
  // `vendor` 为空 = 固化全部有归属的模型；给了 vendor 就只固化归到该厂商的那批。
  const doMaterialize = async (vendor = "") => {
    const who = vendor ? `归到「${TYPE_LABEL[vendor] || vendor}」的模型` : "全部有归属的模型";
    setFixing(vendor || "__all__");
    try {
      const r = await API.post("/pricing/materialize", vendor ? { vendor } : {});
      if (r.inserted) {
        message.success(`已固化 ${r.inserted} 条定价（跳过 ${r.skipped} 条已定价/不适用）`);
        await load();
        await loadAttrib();
      } else {
        message.info("没有需要固化的模型（都已定价或不适用）");
      }
    } catch (e) {
      message.error(e.message || "固化失败");
    } finally {
      setFixing("");
    }
  };

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
      message.success(`已同步上游 ${r.fetched} 条价目${bits.length ? `（${bits.join("、")}）` : ""}`);
      await load();
      loadAttrib();
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
                  从上游模型目录（OpenRouter 公开接口）拉取**真实价格**，覆盖
                  {overwrite ? "包括已有行在内的全部价格" : "仅补齐库里还没有的模型"}。
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
          suffix={CURRENCY_NAME}
          hint={loadError ? "加载失败" : `对应模型：${cheapest?.model || "—"}`}
        />
        <StatCard
          label="统一币制"
          value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><OdCoin size={18} />{CURRENCY_NAME}</span>}
          hint={`1 ${CURRENCY_NAME} = 1 美元（1:1 精确核算）`}
        />
      </div>

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
      {attrib ? (
        <div className="oo-panel">
          <div className="oo-panel-head">
            <span className="oo-panel-title">
              <ApartmentOutlined style={{ marginRight: 6 }} />
              定价体检
            </span>
            <Space size={6}>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadAttrib}>
                刷新
              </Button>
            </Space>
          </div>
          <div className="oo-panel-body">
            {/* 一句话结论：不展开也能知道有没有问题 */}
            <Alert
              type={attrib.counts?.none || attrib.counts?.fallback ? "warning" : "success"}
              showIcon
              style={{ marginBottom: 10 }}
              message={attrib.summary}
              description={
                <span style={{ fontSize: 12 }}>
                  平台在用的模型共 <b>{attrib.total}</b> 个（只统计启用渠道声明过的）。
                  下面是每个模型按什么价收费 —— 点某一类可以展开看具体是哪些模型。
                </span>
              }
            />

            {/* 四类价格来源：卡片形式，一眼看出「哪类是问题」 */}
            <Row gutter={10} style={{ marginBottom: 10 }}>
              {(attrib.sources || []).map((src) => {
                const tone = {
                  green: { bg: "var(--pill-green-tint, #e7f6ec)", ink: "var(--pill-green-ink, #1a7f4b)" },
                  cyan: { bg: "var(--pill-cyan-tint, #e3f5f8)", ink: "var(--pill-cyan-ink, #0d7490)" },
                  orange: { bg: "var(--pill-amber-tint)", ink: "var(--pill-amber-ink)" },
                  red: { bg: "var(--pill-red-tint)", ink: "var(--pill-red-ink)" },
                }[src.tone] || { bg: "transparent", ink: "var(--ink-2)" };
                const isOpen = attribOpen === src.key;
                return (
                  <Col span={6} key={src.key}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setAttribOpen(isOpen ? "" : src.key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setAttribOpen(isOpen ? "" : src.key);
                        }
                      }}
                      style={{
                        cursor: "pointer",
                        padding: "8px 10px",
                        borderRadius: 6,
                        height: "100%",
                        border: `1px solid ${isOpen ? tone.ink : "var(--line)"}`,
                        background: isOpen ? tone.bg : "transparent",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                        <span style={{ fontSize: 20, fontWeight: 600, color: tone.ink }}>{src.count}</span>
                        <span style={{ fontSize: 12, color: tone.ink }}>{src.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4, marginTop: 2 }}>{src.desc}</div>
                    </div>
                  </Col>
                );
              })}
            </Row>

            {/* 点开某一类 → 具体模型清单（带渠道名，一眼知道是哪个渠道带进来的） */}
            {attribOpen ? (() => {
              const src = (attrib.sources || []).find((x) => x.key === attribOpen);
              if (!src) return null;
              const rows = src.models || [];
              return (
                <div style={{ marginBottom: 12 }}>
                  <Space size={8} style={{ marginBottom: 6 }} wrap>
                    <Text strong style={{ fontSize: 13 }}>{src.label}（{src.count} 个）</Text>
                    {src.key === "rule" || src.key === "fallback" ? (
                      <Popconfirm
                        title={`把「${src.label}」里的模型固化成定价行？`}
                        description="已存在的定价行不会被覆盖（管理员手改的价保住）。固化后可在上方列表里逐条微调。"
                        onConfirm={() => doMaterialize("")}
                        okText="固化"
                        cancelText="取消"
                      >
                        <Button size="small" type="primary" ghost loading={fixing === "__all__"}>
                          一键固化为定价
                        </Button>
                      </Popconfirm>
                    ) : null}
                    {src.key === "fallback" || src.key === "none" ? (
                      <Button
                        size="small"
                        onClick={() => {
                          window.scrollTo({ top: 0, behavior: "smooth" });
                          message.info("用顶部的「同步上游价目」能从上游补齐这些模型的价格");
                        }}
                      >
                        怎么补价？
                      </Button>
                    ) : null}
                    <Button size="small" onClick={() => setAttribOpen("")}>收起</Button>
                  </Space>
                  <Table
                    size="small"
                    rowKey={(r) => `${r.model}@${r.channelId}`}
                    dataSource={rows}
                    pagination={rows.length > 20 ? { pageSize: 20, size: "small" } : false}
                    columns={[
                      { title: "模型", dataIndex: "model", render: (v) => <ModelLabel model={v} size={14} /> },
                      { title: "来自渠道", dataIndex: "channel", width: 150, ellipsis: true },
                      {
                        title: "归属 / 命中",
                        dataIndex: "got",
                        width: 170,
                        render: (v) => (v ? <span className="bui-chip">{TYPE_LABEL[v] || v}</span> : <Text type="secondary">—</Text>),
                      },
                      {
                        title: "输入 / 输出",
                        width: 150,
                        render: (_, r) =>
                          r.input !== undefined ? (
                            <span className="oo-num">
                              {Number(r.input).toFixed(4)} / {Number(r.output).toFixed(4)}
                            </span>
                          ) : (
                            <Text type="secondary">未知</Text>
                          ),
                      },
                      {
                        title: "操作",
                        width: 90,
                        render: (_, r) => (
                          <Button size="small" type="link" onClick={() => setKeyword(r.model)}>
                            改价
                          </Button>
                        ),
                      },
                    ]}
                  />
                  {src.count > rows.length ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      只显示前 {rows.length} 个（共 {src.count} 个）
                    </Text>
                  ) : null}
                </div>
              );
            })() : null}

            {/* 单条自检：最直白的入口 ——「我这个模型会被按什么价收费？」 */}
            <div style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 6 }}>
                <b>查一个模型</b>：输入模型名（可以是 <code>vendor/model</code> 这种带前缀的），
                看它会被归到哪个厂商、按什么价收费、这个价是从哪来的。
              </div>
              <Space wrap size={6}>
                <Input
                  size="small"
                  placeholder="如 anthropic/claude-sonnet-4.5、deepseek-flash"
                  value={resolveQ}
                  onChange={(e) => setResolveQ(e.target.value)}
                  onPressEnter={doResolve}
                  style={{ width: 340 }}
                  prefix={<QuestionCircleOutlined style={{ color: "var(--ink-3)" }} />}
                />
                <Button size="small" type="primary" ghost loading={resolving} onClick={doResolve}>
                  查询
                </Button>
              </Space>
              {resolveR ? (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  {resolveR.source === "none" ? (
                    <Alert
                      type="error"
                      showIcon
                      message={`「${resolveR.model}」没有确切价格`}
                      description={
                        <span>
                          {resolveR.remark}
                          <br />
                          它被调用时会被闸门拦下。请到顶部点「同步上游价目」补齐，或在这张表里手工加一行。
                        </span>
                      }
                    />
                  ) : (
                    <Space size={8} wrap>
                      <ModelLabel model={resolveR.model} size={14} />
                      <span style={{ color: "var(--ink-3)" }}>→</span>
                      <Tag color="blue">{TYPE_LABEL[resolveR.type] || resolveR.type || "未知厂商"}</Tag>
                      <span className="oo-num">
                        输入 {Number(resolveR.input).toFixed(4)} / 输出 {Number(resolveR.output).toFixed(4)}
                        {Number(resolveR.cache) ? ` / 缓存 ${Number(resolveR.cache).toFixed(4)}` : ""}
                      </span>
                      <Tag color={resolveR.source === "rule" ? "cyan" : resolveR.source === "db" ? "green" : "default"}>
                        {{
                          db: "来自定价表（你配的）",
                          "db-prefix": `命中定价表前缀「${resolveR.matched || ""}」`,
                          rule: "来自归属规则（自动）",
                        }[resolveR.source] || resolveR.source}
                      </Tag>
                      {resolveR.remark ? (
                        <Text type="secondary" style={{ fontSize: 11 }}>{resolveR.remark}</Text>
                      ) : null}
                    </Space>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

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
