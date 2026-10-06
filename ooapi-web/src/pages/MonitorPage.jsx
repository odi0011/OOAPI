import OdAmount from "../components/OdAmount";
// 运维监控：进程实时指标与数据库历史用量分开展示，告警保留独立操作区。
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  App as AntApp, Segmented, Spin, Empty, Table, Tag, Button, Modal, Form,
  Input, InputNumber, Select, Switch, Space, Popconfirm, Badge, Alert as AntAlert, Divider,
} from "antd";
import {
  ReloadOutlined, AlertOutlined, PlusOutlined,
  DeleteOutlined, EditOutlined, ExperimentOutlined, BellOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { LineChart, BarChart, RankBar, Legend, ChartCard, KpiCard, SERIES_COLORS, fmtCompact } from "../components/Charts";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import { unitsPerOd } from "../services/format";
import { VendorIcon } from "../components/VendorIcon";
import "../dashboard.css";

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(1)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MB`;
  return `${(v / 1024).toFixed(0)} KB`;
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${s % 60} 秒`;
}

/** 使用率分档配色（与额度条同一套语义） */
function usageColor(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return "var(--accent)";
  if (p >= 90) return "var(--red)";
  if (p >= 70) return "var(--orange)";
  return "var(--green)";
}

// 资源汇总采用相同小标签，进度及详细资源信息留在悬浮中。
function ResourceCard({ label, value, percent, foot, extra, spark }) {
  const known = percent != null && Number.isFinite(Number(percent));
  return <StatCard label={label} value={value} tone={known && percent >= 90 ? "danger" : known && percent >= 70 ? "warning" : undefined}
    foot={<>{foot}{extra}{known ? <div className="oo-bar" style={{ marginTop: 6 }}><div style={{ width: `${Math.max(0, Math.min(100, Number(percent)))}%`, height: "100%", background: usageColor(percent) }} /></div> : null}{spark}</>} />;
}

const HEALTH_TONE = {
  healthy: { color: "var(--green)", text: "健康" },
  degraded: { color: "var(--orange)", text: "需关注" },
  risk: { color: "var(--red)", text: "风险" },
  idle: { color: "var(--ink-3)", text: "空闲" },
};

const SEV_COLOR = { P0: "red", P1: "orange", P2: "gold", P3: "default" };

// ---------------------------------------------------------------------------
// 告警规则编辑
// ---------------------------------------------------------------------------
function RuleModal({ open, rule, metrics, operators, severities, onClose, onSaved }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        rule || {
          name: "",
          metric: "error_rate",
          operator: ">",
          threshold: 5,
          window_min: 5,
          sustained_min: 5,
          cooldown_min: 30,
          severity: "P2",
          enabled: true,
          notify_email: true,
          notify_webhook: true,
          webhook_url: "",
          notify_emails: "",
          description: "",
        }
      );
    }
  }, [open, rule, form]);

  const metric = Form.useWatch("metric", form);
  const metricDef = metrics.find((m) => m.key === metric);

  const submit = async () => {
    try {
      const v = await form.validateFields();
      setSaving(true);
      const r = rule?.id ? await API.put(`/monitor/alert/rules/${rule.id}`, v) : await API.post("/monitor/alert/rules", v);
      if (r?.success === false) throw new Error(r.message || "保存失败");
      message.success(rule?.id ? "规则已更新" : "规则已创建");
      onSaved();
      onClose();
    } catch (e) {
      if (!e.errorFields) message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={rule?.id ? "编辑告警规则" : "新建告警规则"}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      okText="保存"
      width={620}
      destroyOnClose
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="name" label="规则名称" tooltip="留空则用指标名作为规则名">
          <Input placeholder={metricDef?.label || "如：错误率过高"} maxLength={64} />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="metric" label="指标" style={{ flex: 2 }} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={metrics.map((m) => ({ value: m.key, label: `${m.label}（${m.key}）` }))}
            />
          </Form.Item>
          <Form.Item name="operator" label="条件" style={{ flex: 1, marginLeft: 8 }}>
            <Select options={operators.map((o) => ({ value: o, label: o }))} />
          </Form.Item>
          <Form.Item name="threshold" label={`阈值${metricDef?.unit ? `（${metricDef.unit}）` : ""}`} style={{ flex: 1, marginLeft: 8 }}>
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item name="window_min" label="统计窗口（分钟）" style={{ flex: 1 }} tooltip="指标统计的时间范围">
            <InputNumber min={1} max={1440} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="sustained_min"
            label="持续满足（分钟）"
            style={{ flex: 1, marginLeft: 8 }}
            tooltip="连续满足这么久才触发，避免瞬时抖动误报"
          >
            <InputNumber min={1} max={1440} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="cooldown_min"
            label="冷却（分钟）"
            style={{ flex: 1, marginLeft: 8 }}
            tooltip="触发后多久内不再重复告警，避免告警风暴"
          >
            <InputNumber min={0} max={10080} style={{ width: "100%" }} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="severity" label="级别">
          <Select options={severities.map((s) => ({ value: s, label: s }))} style={{ width: 120 }} />
        </Form.Item>
        <Divider style={{ margin: "4px 0 12px" }} orientation="left" plain>
          通知通道
        </Divider>
        <Space size={20} wrap>
          <Form.Item name="notify_email" label="邮件" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="notify_webhook" label="Webhook" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch size="small" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Switch size="small" />
          </Form.Item>
        </Space>
        <Form.Item name="notify_emails" label="收件人" tooltip="多个用逗号分隔；留空用系统设置里的默认收件人">
          <Input placeholder="ops@example.com, admin@example.com" />
        </Form.Item>
        <Form.Item name="webhook_url" label="Webhook 地址" tooltip="留空用系统设置里的默认 Webhook；自动识别飞书/钉钉/企业微信/Slack">
          <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
        </Form.Item>
        <Form.Item name="description" label="备注">
          <Input maxLength={255} placeholder="这条规则是给谁看的、触发后该做什么" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 告警面板：规则 + 事件 + 维护窗口
// ---------------------------------------------------------------------------
function AlertPanel({ data, onReload }) {
  const { message, modal } = AntApp.useApp();
  const [rules, setRules] = useState([]);
  const [events, setEvents] = useState({ list: [], stat: {}, notify: [] });
  const [meta, setMeta] = useState({ metrics: [], operators: [], severities: [] });
  const [ruleModal, setRuleModal] = useState({ open: false, rule: null });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const { begin, isLatest } = useLatest();

  const load = useCallback(async () => {
    const request = begin(); setLoading(true);
    try {
      const [r, e, m] = await Promise.all([API.get("/monitor/alert/rules"), API.get("/monitor/alert/events?days=7"), API.get("/monitor/alert/metrics")]);
      if (!isLatest(request)) return;
      // API 已解包 data。失败不能伪装成「没有告警」。
      setRules(r || []); setEvents(e || { list: [], stat: {}, notify: [] }); setMeta(m || {}); setLoadError("");
    } catch (e) { if (isLatest(request)) { setLoadError(e.message); message.error(e.message); } }
    finally { if (isLatest(request)) setLoading(false); }
  }, [begin, isLatest, message]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.success === false) throw new Error(r.message || "操作失败");
      message.success(r?.message || okMsg);
      await load();
      onReload?.();
    } catch (e) {
      message.error(e.message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const engine = data?.alerts || {};
  const silenceLeft = engine.silence?.until ? Math.max(0, Math.ceil((engine.silence.until - Date.now()) / 60000)) : 0;

  const columns = [
    { title: "级别", dataIndex: "severity", width: 62, render: (s) => <Tag color={SEV_COLOR[s]}>{s}</Tag> },
    { title: "规则名", dataIndex: "name", ellipsis: true },
    {
      title: "条件",
      key: "cond",
      width: 190,
      render: (_, r) => (
        <span className="oo-num" style={{ fontSize: 12 }}>
          {r.metric} {r.operator} {Number(r.threshold)}
        </span>
      ),
    },
    { title: "窗口", dataIndex: "window_min", width: 66, render: (v) => `${v}分` },
    { title: "持续", dataIndex: "sustained_min", width: 66, render: (v) => `${v}分` },
    { title: "冷却", dataIndex: "cooldown_min", width: 66, render: (v) => `${v}分` },
    {
      title: "通道",
      key: "ch",
      width: 96,
      render: (_, r) => (
        <Space size={4}>
          {r.notify_email ? <Tag>邮件</Tag> : null}
          {r.notify_webhook ? <Tag color="blue">Webhook</Tag> : null}
        </Space>
      ),
    },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 60,
      render: (v, r) => (
        <Switch
          size="small"
          checked={Number(v) === 1}
          loading={busy}
          onChange={() => act(() => API.post(`/monitor/alert/rules/${r.id}/toggle`), "已切换")}
        />
      ),
    },
    {
      title: "操作",
      key: "op",
      width: 96,
      render: (_, r) => (
        <Space size={2}>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRuleModal({ open: true, rule: r })} />
          <Popconfirm title="删除这条规则？" onConfirm={() => act(() => API.del(`/monitor/alert/rules/${r.id}`), "已删除")}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const eventCols = [
    { title: "时间", dataIndex: "created_time", width: 148, render: (t) => new Date(t * 1000).toLocaleString("zh-CN") },
    { title: "级别", dataIndex: "severity", width: 62, render: (s) => <Tag color={SEV_COLOR[s]}>{s}</Tag> },
    { title: "规则", dataIndex: "rule_name", ellipsis: true },
    {
      title: "指标值",
      key: "v",
      width: 130,
      render: (_, r) => (
        <span className="oo-num" style={{ fontSize: 12 }}>
          {r.value} {r.operator} {r.threshold}
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 80,
      render: (s) => (s === "firing" ? <Badge status="error" text="告警中" /> : <Badge status="success" text="已恢复" />),
    },
    {
      title: "操作",
      key: "op",
      width: 80,
      render: (_, r) =>
        r.status === "firing" ? (
          <Button size="small" type="link" onClick={() => act(() => API.post(`/monitor/alert/events/${r.id}/resolve`), "已标记解决")}>
            标记解决
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="oo-panel" style={{ padding: 14, marginTop: 12 }}>
      {loadError && <AntAlert type="error" showIcon message="告警数据更新失败" description={loadError} action={<Button size="small" onClick={load}>重试</Button>} style={{ marginBottom: 16 }} />}
      <div className="oo-stats-card-head oo-monitor-alert-head" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BellOutlined />
          <span className="oo-stats-card-title">告警中心</span>
          {silenceLeft > 0 ? <Tag color="orange">维护窗口剩余 {silenceLeft} 分钟</Tag> : null}
          {engine.lastEvalAt ? (
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              上次求值 {new Date(engine.lastEvalAt).toLocaleTimeString("zh-CN")} · 耗时 {engine.lastEvalMs}ms
              {engine.lastError ? ` · 错误：${engine.lastError}` : ""}
            </span>
          ) : null}
        </div>
        <Space size={6}>
          <Button size="small" icon={<ExperimentOutlined />} loading={busy} onClick={() => act(() => API.post("/monitor/alert/evaluate", { force: true }), "已求值")}>
            立即检测
          </Button>
          <Button
            size="small"
            onClick={() =>
              modal.confirm({
                title: "维护窗口",
                content: (
                  <div>
                    <p style={{ fontSize: 12, color: "var(--ink-3)" }}>开启后所有告警只记录不通知，适合发版/迁移期间使用。</p>
                    <InputNumber id="silence-min" min={5} max={10080} defaultValue={60} addonAfter="分钟" style={{ width: 180 }} />
                  </div>
                ),
                onOk: () => {
                  const el = document.getElementById("silence-min");
                  const minutes = Number(el?.value) || 60;
                  return act(() => API.post("/monitor/alert/silence", { minutes, reason: "手工维护窗口" }), "已静默");
                },
              })
            }
          >
            {silenceLeft > 0 ? "结束静默" : "维护窗口"}
          </Button>
          {silenceLeft > 0 ? (
            <Button size="small" danger onClick={() => act(() => API.post("/monitor/alert/silence", { minutes: 0 }), "已解除静默")}>
              解除
            </Button>
          ) : null}
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setRuleModal({ open: true, rule: null })}>
            新建规则
          </Button>
        </Space>
      </div>

      <div className="oo-stats-strip">
        <span className="bui-chip">规则 <b>{rules.length}</b></span>
        <span className="bui-chip">告警中 <b style={{ color: events.stat?.firing ? "var(--red)" : undefined }}>{events.stat?.firing ?? 0}</b></span>
        <span className="bui-chip">近7天恢复 <b>{events.stat?.resolved ?? 0}</b></span>
        <span className="bui-chip">P0 <b>{events.stat?.p0 ?? 0}</b></span>
        <span className="bui-chip">P1 <b>{events.stat?.p1 ?? 0}</b></span>
        {(events.notify || []).map((n) => (
          <span className="bui-chip" key={n.channel}>
            {n.channel === "email" ? "邮件" : "Webhook"}投递 <b style={{ color: n.failed ? "var(--red)" : undefined }}>{n.total - n.failed}/{n.total}</b>
          </span>
        ))}
      </div>

      <Table className="oo-table" loading={loading} rowKey="id" size="small" columns={columns} dataSource={rules} pagination={false} scroll={{ x: 900 }} style={{ marginBottom: 12 }} />

      <div className="oo-stats-card-head" style={{ marginBottom: 6 }}>
        <div className="oo-stats-card-title">告警事件（近 7 天）</div>
      </div>
      <Table
        className="oo-table"
        loading={loading}
        rowKey="id"
        size="small"
        columns={eventCols}
        dataSource={events.list || []}
        pagination={{ pageSize: 8, size: "small", hideOnSinglePage: true }}
        scroll={{ x: 650 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loadError ? "告警数据暂不可用" : "近 7 天没有告警事件"} /> }}
      />

      <RuleModal
        open={ruleModal.open}
        rule={ruleModal.rule}
        metrics={meta.metrics || []}
        operators={meta.operators || [">=", "<=", ">", "<", "==", "!="]}
        severities={meta.severities || ["P0", "P1", "P2", "P3"]}
        onClose={() => setRuleModal({ open: false, rule: null })}
        onSaved={load}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------
const REFRESH_OPTIONS = [{ value: 5000, label: "5 秒" }, { value: 15000, label: "15 秒" }, { value: 60000, label: "60 秒" }, { value: 0, label: "手动" }];
const percentText = (v) => v == null ? "—" : v + "%";
const msText = (v) => v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : v + " ms";

function MonitorHealth({ health, diagnosis }) {
  const tone = HEALTH_TONE[health?.level] || HEALTH_TONE.idle;
  return <section className="oo-panel oo-monitor-health">
    <div className="oo-monitor-score"><span>运行健康度</span><strong style={{ color: tone.color }}>{health?.score ?? "—"}<small>{tone.text}</small></strong><small>{health?.hasTraffic ? "业务 " + (health.parts?.business ?? "—") + " · 基础设施 " + (health.parts?.infra ?? "—") : "暂无足够流量，业务评分仅供参考"}</small></div>
    <div className="oo-monitor-diagnosis">{(diagnosis || []).map((d, i) => <div key={i}><h3 style={{ color: d.severity === "critical" ? "var(--red)" : d.severity === "warning" ? "var(--orange)" : "var(--ink)" }}>{d.title}</h3><p>{d.impact}</p><p>建议：{d.advice}</p></div>)}{!diagnosis?.length && <p>本次采样未发现需要处理的问题。</p>}</div>
  </section>;
}

export default function MonitorPage() {
  const { status } = useApp();
  const { begin, isLatest } = useLatest();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [interval, setIntervalMs] = useState(15000);
  const [live, setLive] = useState(null);
  const [liveOk, setLiveOk] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState(0);
  const [activeTab, setActiveTab] = useState("overview");
  const [winKey, setWinKey] = useState("m5");
  const [rankTab, setRankTab] = useState("model");
  const pending = useRef(false);
  const perUnit = unitsPerOd(status);

  const load = useCallback(async (silent = false) => {
    if (silent && pending.current) return;
    const token = begin();
    pending.current = true;
    if (!silent) setLoading(true);
    try {
      const r = await API.get("/monitor/snapshot");
      if (isLatest(token)) { setData(r); setError(""); setSnapshotAt(Date.now()); }
    } catch (e) { if (isLatest(token)) setError(e.message || "加载失败"); }
    finally { if (isLatest(token)) { setLoading(false); pending.current = false; } }
  }, [begin, isLatest]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!interval) return undefined;
    const timer = setInterval(() => load(true), interval);
    return () => clearInterval(timer);
  }, [interval, load]);

  // 票据只使用一次。断线后立即丢弃旧实时值，再换票重连，不能让陈旧帧永久盖住新快照。
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let source = null, closed = false, retryTimer = null;
    const retry = (delay) => {
      if (!closed && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    };
    const connect = async () => {
      try {
        const r = await API.post("/monitor/stream-ticket");
        if (closed) return;
        if (!r?.ticket) throw new Error("未取得监控票据");
        source = new EventSource("/api/monitor/stream?interval=3000&ticket=" + encodeURIComponent(r.ticket));
        source.onmessage = (event) => {
          if (closed) return;
          try { setLive({ ...JSON.parse(event.data), receivedAt: Date.now() }); setLiveOk(true); }
          catch { setLiveOk(false); setLive(null); }
        };
        source.onerror = () => {
          source?.close(); source = null;
          if (!closed) { setLiveOk(false); setLive(null); retry(5000); }
        };
      } catch {
        if (!closed) { setLiveOk(false); setLive(null); retry(15000); }
      }
    };
    connect();
    return () => { closed = true; source?.close(); if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  const g = data?.gateway || {};
  const sys = data?.system || {};
  const proc = data?.process || {};
  const overview = data?.overview || {};
  const channels = data?.channels || {};
  const trend = data?.trend || {};
  const win = data?.windows?.[winKey];
  // 本地接收时间比较，不受服务端与浏览器时钟偏差影响。
  const rt = liveOk && live?.receivedAt >= snapshotAt ? live : { ...g, qps: trend.qps, tps: trend.tps };
  const pts = (trend.series || []).map((p) => ({ ...p, x: new Date(p.minute * 60000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }) }));
  const throughput = [
    { name: "QPS（左轴）", values: pts.map((p) => ({ x: p.x, y: p.qps })), format: (v) => v + " 请求/s" },
    { name: "TPS（右轴）", color: SERIES_COLORS[1], axis: "right", values: pts.map((p) => ({ x: p.x, y: p.tps })), format: (v) => v + " Token/s" },
  ];
  const errors = [
    { name: "请求", values: pts.map((p) => ({ x: p.x, y: p.calls })) },
    { name: "失败", color: "var(--red)", values: pts.map((p) => ({ x: p.x, y: p.errors })) },
  ];
  const rankSets = {
    model: (g.topModels || []).map((m) => ({ name: m.model, value: m.calls })),
    channel: (g.topChannels || []).map((m) => ({ name: m.channel, value: m.calls })),
    user: (g.topUsers || []).map((m) => ({ name: "用户 #" + m.userId, value: m.calls })),
    vendor: (g.topVendors || []).map((m) => ({ name: m.vendor || "未登记", value: m.calls })),
  };

  return <div className="oo-page oo-dashboard oo-monitor">
    <PageHeader title="运维监控" tags={<Tag color={liveOk ? "success" : "default"}>{liveOk ? "实时连接" : interval ? "快照轮询" : "手动快照"}</Tag>} extra={<><Segmented size="small" value={interval} options={REFRESH_OPTIONS} onChange={setIntervalMs} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()} aria-label="刷新监控" /></>} />
    <div className="oo-dashboard-context"><span>{data ? "进程运行 " + fmtDuration(proc.uptimeSec) + " · " + sys.hostname + " · " + proc.platform : "正在读取系统与网关状态"}</span><span>{snapshotAt ? "快照 " + new Date(snapshotAt).toLocaleTimeString("zh-CN", { hour12: false }) : ""}</span></div>
    {error && <AntAlert type="error" showIcon message={data ? "快照更新失败，当前显示上次采样" : "监控数据加载失败"} description={error} action={<Button size="small" onClick={() => load()}>重试</Button>} />}
    <div className="oo-monitor-tabs"><Segmented block value={activeTab} onChange={setActiveTab} options={[{ value: "overview", label: "运行概览" }, { value: "infra", label: "系统资源" }, { value: "traffic", label: "渠道与流量" }, { value: "alerts", label: "告警中心" }]} /></div>
    {!data ? loading && <div className="oo-dashboard-loading"><Spin /></div> : <>
      {activeTab === "overview" && <div className="oo-monitor-view">
        <div className="oo-stats-strip">
          <KpiCard label="请求吞吐 QPS" value={rt.qps?.current ?? "—"} unit="请求/s" hint="当前分钟请求数 ÷ 60" />
          <KpiCard label="Token 吞吐 TPS" value={fmtCompact(rt.tps?.current || 0)} unit="Token/s" hint="当前分钟 Token 数 ÷ 60" />
          <KpiCard label="当前在途" value={rt.inFlight ?? "—"} unit="个请求" hint={"本进程峰值 " + (g.peakInFlight ?? 0)} />
          <KpiCard label="P95 请求耗时" value={(rt.requests ?? g.requests) > 0 ? msText(rt.latency?.p95Ms) : "—"} hint="最近保留的耗时样本 · 重启清零" />
        </div>
        <MonitorHealth health={data.health} diagnosis={data.diagnosis} />
        <ChartCard title="窗口内的服务质量" note="无请求时显示无样本；采样不完整时不视为完整窗口。" extra={<Segmented size="small" value={winKey} onChange={setWinKey} options={[{ value: "m1", label: "1 分钟" }, { value: "m5", label: "5 分钟" }, { value: "m60", label: "60 分钟" }]} />}>
          {win?.partial && <div className="oo-monitor-scope"><span>样本覆盖 {win.coveredMinutes} / {win.windowMin} 分钟</span><Tag color="warning">窗口尚未完整</Tag></div>}
          <div className="oo-service-overview"><dl>{[["请求", win?.calls ?? "—"], ["失败", win?.errors ?? "—"], ["成功率", win?.successRate == null ? "无样本" : percentText(win.successRate)], ["平均首字耗时", msText(win?.avgTtftMs)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>
        </ChartCard>
        <div className="oo-monitor-chart-grid">
          <ChartCard title="请求与 Token 吞吐" note="近 60 分钟 · 北京时间 · 左右轴分别计量" extra={<Legend series={throughput} />}><LineChart series={throughput} height={235} /></ChartCard>
          <ChartCard title="请求与失败趋势" note="近 60 分钟 · 分钟汇总" extra={<Legend series={errors} />}><LineChart series={errors} height={235} /></ChartCard>
        </div>
        <div className="oo-monitor-chart-grid">
          <ChartCard title="网关服务质量" note="当前进程累计 · 重启清零"><dl className="oo-dashboard-facts">{[["全部请求", g.requests ?? 0], ["SLA（排除业务限制）", percentText(g.sla)], ["请求失败率", percentText(g.errorRate)], ["上游真实错误", g.upstream?.errors ?? 0], ["业务限制", g.businessLimited ?? 0], ["上游 429 / 529", (g.upstream?.count429 ?? 0) + " / " + (g.upstream?.count529 ?? 0)], ["渠道切换次数", g.channelSwitches ?? 0]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></ChartCard>
          <ChartCard title="平台概况" note="数据库快照 · 用量为最近 24 小时"><dl className="oo-dashboard-facts">{[["启用 / 全部渠道", (overview.channels?.enabled ?? 0) + " / " + (overview.channels?.total ?? 0)], ["启用 / 全部用户", (overview.users?.active ?? 0) + " / " + (overview.users?.total ?? 0)], ["近 24 小时请求", fmtCompact(overview.last24h?.calls)], ["近 24 小时失败", fmtCompact(overview.last24h?.errors)], ["近 24 小时消费", <OdAmount quota={overview.last24h?.units} perUnit={perUnit} digits={4} />], ["低余额用户", overview.users?.lowBalance ?? 0]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></ChartCard>
        </div>
      </div>}
      {activeTab === "infra" && <div className="oo-monitor-view">
        <div className="oo-stats-strip">
          <ResourceCard label="系统 CPU" value={sys.cpuPercent == null ? "采样中" : percentText(sys.cpuPercent)} percent={sys.cpuPercent} foot={(sys.cpuCount ?? 0) + " 核 · " + (sys.loadavg ? "负载 " + sys.loadavg.join(" / ") : "当前平台不提供系统负载")} />
          <ResourceCard label="进程 CPU" value={proc.cpu ? percentText(proc.cpu.percentOfMachine) : "采样中"} percent={proc.cpu?.percentOfMachine} foot="占整机 CPU 的比例" />
          <ResourceCard label="系统内存" value={percentText(sys.usedMemPercent)} percent={sys.usedMemPercent} foot={fmtBytes(sys.totalMemBytes - sys.freeMemBytes) + " / " + fmtBytes(sys.totalMemBytes)} />
          <ResourceCard label="进程内存 RSS" value={fmtBytes(proc.rssBytes)} foot={"堆内存 " + fmtBytes(proc.heapUsedBytes) + " / " + fmtBytes(proc.heapTotalBytes)} />
          <ResourceCard label="磁盘使用率" value={sys.disk ? percentText(sys.disk.usedPercent) : "无法采集"} percent={sys.disk?.usedPercent} foot={sys.disk ? "剩余 " + fmtBytes(sys.disk.freeBytes) : "当前文件系统不支持此指标"} />
          <ResourceCard label="事件循环 P99" value={msText(data.eventLoop?.p99Ms)} foot={"P50 " + msText(data.eventLoop?.p50Ms)} />
          <ResourceCard label="数据库连接池" value={(data.pool?.inUse ?? "—") + " / " + (data.pool?.total ?? "—")} percent={data.pool?.total ? data.pool.inUse / data.pool.total * 100 : null} foot={"排队 " + (data.pool?.queued ?? 0) + " · 空闲 " + (data.pool?.free ?? 0)} />
          <ResourceCard label="活动句柄" value={data.resources?.activeHandles ?? "—"} foot={"外部内存 " + fmtBytes(proc.externalBytes)} />
        </div>
        <div className="oo-monitor-chart-grid">
          <ChartCard title="响应耗时分位" note="最近保留的请求样本 · 非历史全量"><Table className="oo-table" size="small" rowKey="name" pagination={false} columns={[{ title: "指标", dataIndex: "name" }, { title: "总耗时", dataIndex: "latency", align: "right" }, { title: "首 Token", dataIndex: "ttft", align: "right" }]} dataSource={[["平均", "avgMs"], ["P50", "p50Ms"], ["P95", "p95Ms"], ["P99", "p99Ms"], ["最大", "maxMs"]].map(([name, key]) => ({ name, latency: g.latency?.samples ? msText(g.latency[key]) : "无样本", ttft: g.ttft?.samples ? msText(g.ttft[key]) : "无样本" }))} /></ChartCard>
          <ChartCard title="请求耗时分布" note={"样本 " + (g.latency?.samples ?? 0) + " 次"}><BarChart bars={g.latency?.samples ? (g.latencyHistogram || []).map((h) => ({ label: h.range, value: h.count })) : []} height={225} /></ChartCard>
        </div>
        <ChartCard title="数据库表体积" note="磁盘占用 · 数据与索引合计"><RankBar items={(overview.tables || []).map((t) => ({ name: t.name, value: t.mb }))} suffix=" MB" /></ChartCard>
      </div>}
      {activeTab === "traffic" && <div className="oo-monitor-view">
        <ChartCard title="渠道运行状态" note={"在途 " + (channels.inflight ?? 0) + " · 冷却 " + (channels.cooling ?? 0) + " · 启用 " + (channels.enabled ?? 0)}>
          <Table className="oo-table" rowKey="channelId" size="small" pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 880 }} dataSource={channels.list || []} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置渠道" /> }} columns={[
            { title: "渠道", dataIndex: "name", width: 190, render: (v, r) => <span className="oo-dashboard-channel"><VendorIcon type={r.type} size={24} /><span style={{ minWidth: 0 }}><b className="oo-truncate" title={v} style={{ display: "block" }}>{v}</b><small>#{r.channelId}</small></span></span> },
            { title: "状态", dataIndex: "status", width: 90, render: (v, r) => <Tag color={r.coolingDown ? "warning" : v === 1 ? "success" : "default"}>{r.coolingDown ? "冷却中" : v === 1 ? "启用" : "停用"}</Tag> },
            { title: "在途", dataIndex: "inflight", width: 75, align: "right" }, { title: "排队", dataIndex: "queued", width: 75, align: "right" },
            { title: "剩余冷却", dataIndex: "cooldownRemainSec", width: 100, render: (v) => v ? Math.ceil(v) + " 秒" : "—" },
            { title: "累计调用", dataIndex: "usedCount", width: 95, align: "right", render: fmtCompact },
            { title: "最近错误", dataIndex: "lastError", ellipsis: true, render: (v) => v || "—" },
          ]} />
        </ChartCard>
        <div className="oo-monitor-chart-grid">
          <ChartCard title="调用排行" note="当前进程累计" extra={<Segmented size="small" value={rankTab} onChange={setRankTab} options={[{ value: "model", label: "模型" }, { value: "channel", label: "渠道" }, { value: "user", label: "用户" }, { value: "vendor", label: "厂商" }]} />}><RankBar items={rankSets[rankTab]} suffix=" 次" /></ChartCard>
          <ChartCard title="响应状态码" note="当前进程累计 · 非使用记录历史"><BarChart bars={(g.byStatus || []).map((s) => ({ label: String(s.status), value: s.count, color: s.status >= 500 ? "var(--red)" : s.status >= 400 ? "var(--orange)" : "var(--green)" }))} height={235} /></ChartCard>
        </div>
      </div>}
      {activeTab === "alerts" && <AlertPanel data={data} onReload={() => load(true)} />}
    </>}
  </div>;
}
