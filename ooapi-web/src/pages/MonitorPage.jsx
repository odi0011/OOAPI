// 运维监控 + 告警管理（管理员）
// ---------------------------------------------------------------------------
// 指标来源：GET /api/monitor/snapshot（后端 Node 内置模块采集，见 services/metrics.js）。
// 实时部分走 SSE（/api/monitor/stream），比 sub2api 的 WebSocket 更轻、浏览器原生自动重连。
//
// 页面结构（对标 sub2api 的 /admin/ops，并做增强）：
//   ① 顶部健康分 + 智能诊断（现象/影响/建议三段式）
//   ② 概览小标签条（在途/SLA/成功率/错误率/上游错误/换号率）
//   ③ QPS/TPS 实时 + 趋势折线（sub2api 的 Throughput Trend）
//   ④ 资源卡：CPU / 进程CPU / 内存 / 磁盘 / 事件循环 / 连接池
//   ⑤ 延迟分析：分位表 + 直方图 + TTFT（sub2api 的 Duration Histogram + TTFT）
//   ⑥ 错误分析：状态码分布 + 错误趋势（sub2api 的 Error Distribution / Error Trend）
//   ⑦ 并发与队列（按渠道，sub2api 的 OpsConcurrencyCard）
//   ⑧ 平台概览 + 数据表体积（sub2api 没有表体积）
//   ⑨ 排行：模型 / 渠道 / 用户 / 厂商（sub2api 只有模型/渠道）
//   ⑩ 告警：规则表 + 事件流 + 维护窗口（sub2api 放在弹窗里）
//
// 颜色语义与全站一致：<70% 主色/绿、70-90% 橙、>90% 红（同渠道额度条）。
// 图表一律复用 components/Charts.jsx（全站图表规范唯一入口）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp, Segmented, Spin, Empty, Tooltip, Table, Tag, Button, Modal, Form,
  Input, InputNumber, Select, Switch, Space, Popconfirm, Badge, Alert as AntAlert, Divider,
} from "antd";
import {
  ReloadOutlined, AlertOutlined, ThunderboltOutlined, PlusOutlined,
  DeleteOutlined, EditOutlined, ExperimentOutlined, BellOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { LineChart, BarChart, RankBar, Legend, Sparkline } from "../components/Charts";

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

/** 资源卡：标题 + 大字数值 + 进度条 + 副标题（可选 sparkline） */
function ResourceCard({ label, value, percent, foot, extra, spark }) {
  return (
    <div className="oo-panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</span>
        {extra}
      </div>
      <div className="oo-num" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, marginTop: 2 }}>{value}</div>
      {Number.isFinite(Number(percent)) ? (
        <div style={{ height: 5, borderRadius: 3, background: "var(--inset)", overflow: "hidden", margin: "8px 0 6px" }}>
          <div
            style={{
              width: `${Math.max(0, Math.min(100, Number(percent)))}%`,
              height: "100%",
              background: usageColor(percent),
            }}
          />
        </div>
      ) : null}
      {spark ? <div style={{ margin: "2px 0 4px" }}>{spark}</div> : null}
      {foot ? <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{foot}</div> : null}
    </div>
  );
}

/** 小标签（概览条：与使用记录页的 oo-stats-strip 同一规范） */
function Strip({ items }) {
  return (
    <div className="oo-stats-strip">
      {items.map((it) => (
        <span className="bui-chip" key={it.label}>
          {it.label} <b style={it.color ? { color: it.color } : undefined}>{it.value}</b>
        </span>
      ))}
    </div>
  );
}

const HEALTH_TONE = {
  healthy: { color: "var(--green)", text: "健康" },
  degraded: { color: "var(--orange)", text: "需关注" },
  risk: { color: "var(--red)", text: "风险" },
  idle: { color: "var(--ink-3)", text: "空闲" },
};

const SEV_COLOR = { P0: "red", P1: "orange", P2: "gold", P3: "default" };

// ---------------------------------------------------------------------------
// 健康分 + 智能诊断
// ---------------------------------------------------------------------------
function HealthPanel({ health, diagnosis, onRefresh, loading }) {
  const tone = HEALTH_TONE[health?.level] || HEALTH_TONE.idle;
  const items = diagnosis || [];
  return (
    <div className="oo-panel" style={{ padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <div style={{ textAlign: "center", minWidth: 110 }}>
          <div className="oo-num" style={{ fontSize: 42, fontWeight: 700, lineHeight: 1, color: tone.color }}>
            {health?.score ?? "—"}
          </div>
          <div style={{ fontSize: 12, color: tone.color, marginTop: 4 }}>{tone.text}</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
            {health?.hasTraffic ? `业务 ${health.parts?.business ?? "—"} · 设施 ${health.parts?.infra ?? "—"}` : "暂无流量"}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span className="oo-stats-card-title">智能诊断</span>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>按「现象 → 影响 → 建议」给出可执行结论</span>
            <Button size="small" type="text" icon={<ReloadOutlined spin={loading} />} onClick={onRefresh} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {items.map((d, i) => (
              <div
                key={i}
                style={{
                  borderLeft: `3px solid ${
                    d.severity === "critical" ? "var(--red)" : d.severity === "warning" ? "var(--orange)" : "var(--accent)"
                  }`,
                  paddingLeft: 10,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                }}
              >
                <b>{d.title}</b>
                <div style={{ color: "var(--ink-3)" }}>影响：{d.impact}</div>
                <div style={{ color: "var(--ink-3)" }}>建议：{d.advice}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 告警规则编辑
// ---------------------------------------------------------------------------
function RuleModal({ open, rule, metrics, operators, severities, onClose, onSaved }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
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
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = rule?.id ? await API.put(`/monitor/alert/rules/${rule.id}`, v) : await API.post("/monitor/alert/rules", v);
      if (r?.success === false) throw new Error(r.message || "保存失败");
      message.success(rule?.id ? "规则已更新" : "规则已创建");
      onSaved();
      onClose();
    } catch (e) {
      message.error(e.message || "保存失败");
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

  const load = useCallback(async () => {
    const [r, e, m] = await Promise.allSettled([
      API.get("/monitor/alert/rules"),
      API.get("/monitor/alert/events?days=7"),
      API.get("/monitor/alert/metrics"),
    ]);
    if (r.status === "fulfilled") setRules(r.value?.data || []);
    if (e.status === "fulfilled") setEvents(e.value?.data || { list: [], stat: {}, notify: [] });
    if (m.status === "fulfilled") setMeta(m.value?.data || { metrics: [], operators: [], severities: [] });
  }, []);

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
          <Popconfirm title="删除这条规则？" onConfirm={() => act(() => API.delete(`/monitor/alert/rules/${r.id}`), "已删除")}>
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
      <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
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

      <Table rowKey="id" size="small" columns={columns} dataSource={rules} pagination={false} scroll={{ x: 900 }} style={{ marginBottom: 12 }} />

      <div className="oo-stats-card-head" style={{ marginBottom: 6 }}>
        <div className="oo-stats-card-title">告警事件（近 7 天）</div>
      </div>
      <Table
        rowKey="id"
        size="small"
        columns={eventCols}
        dataSource={events.list || []}
        pagination={{ pageSize: 8, size: "small", hideOnSinglePage: true }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近期没有告警，系统运行平稳" /> }}
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
const REFRESH_OPTIONS = [
  { value: 5000, label: "5 秒" },
  { value: 15000, label: "15 秒" },
  { value: 60000, label: "60 秒" },
  { value: 0, label: "手动" },
];

export default function MonitorPage() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [interval, setIntervalMs] = useState(15000);
  const [live, setLive] = useState(null); // SSE 推送的实时值
  const [liveOk, setLiveOk] = useState(false);
  const [rankTab, setRankTab] = useState("model");
  // 窗口口径（1/5/60 分钟）：告警规则按各自的「统计窗口」取值，这里让管理员能切着看
  const [winKey, setWinKey] = useState("m5");
  // 并发维度（对齐 sub2api 的多维度切换：它按 platform/group/account/user，我们按账号/厂商/模型）
  const [concTab, setConcTab] = useState("channel");
  const timerRef = useRef(null);
  const esRef = useRef(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const r = await API.get("/monitor/snapshot");
        if (r?.success === false) throw new Error(r.message || "加载失败");
        setData(r.data);
        setError("");
      } catch (e) {
        setError(e.message || "加载失败");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  // 轮询
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!interval) return undefined;
    timerRef.current = setInterval(() => load(true), interval);
    return () => clearInterval(timerRef.current);
  }, [interval, load]);

  // SSE 实时推送（失败自动退回纯轮询，不影响可用性）
  //
  // EventSource 不能自定义请求头，所以拿不到 Authorization —— 直接连会被 401。
  // 先用普通 API 调用换一张 60 秒有效的一次性票据，再拼到 query 上。
  // 票据用一次即失效；断线重连时（浏览器自动重连会复用同一个 URL，票据已作废）
  // 由下面的 onerror 主动换新票据重建连接。
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let es = null;
    let closed = false;
    let retryTimer = null;

    const connect = async () => {
      if (closed) return;
      try {
        const r = await API.post("/monitor/stream-ticket");
        const ticket = r?.data?.ticket;
        if (!ticket || closed) return;
        es = new EventSource(`/api/monitor/stream?interval=3000&ticket=${encodeURIComponent(ticket)}`);
        esRef.current = es;
        es.onopen = () => setLiveOk(true);
        es.onmessage = (ev) => {
          try {
            setLive(JSON.parse(ev.data));
            setLiveOk(true);
          } catch {
            /* 忽略脏帧 */
          }
        };
        es.onerror = () => {
          setLiveOk(false);
          // 票据一次性，自动重连必然 401：关掉旧连接，换新票据再连（5 秒后）
          try {
            es?.close();
          } catch {
            /* ignore */
          }
          es = null;
          if (!closed && !retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              connect();
            }, 5000);
          }
        };
      } catch {
        // 换票据失败（网络/权限）：退回轮询，稍后再试
        setLiveOk(false);
        if (!closed && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, 15000);
        }
      }
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const g = data?.gateway || {};
  const sys = data?.system || {};
  const proc = data?.process || {};
  const trend = data?.trend || {};
  const health = data?.health || {};
  const overview = data?.overview || {};
  const channels = data?.channels || {};
  const alerts = data?.alerts || {};
  const thresholds = data?.thresholds || {};
  const win = data?.windows || {};

  // 窗口口径说明：进程累计值（gateway.requests）随重启清零，
  // 而 windows.m1/m5/m60 是分钟桶聚合的「真实窗口值」——告警规则用的就是后者。
  const winStats = win[winKey] || null;

  // 实时值与轮询快照合并：SSE 有值优先（更细粒度），否则用快照
  const rt = live || {
    qps: trend.qps,
    tps: trend.tps,
    inFlight: g.inFlight,
    sla: g.sla,
    errorRate: g.errorRate,
    latency: g.latency,
  };

  // 趋势序列（分钟桶）
  const series = useMemo(() => {
    const pts = (trend.series || []).map((s) => ({
      x: s.minute,
      label: new Date(s.minute * 60000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      calls: s.calls,
      errors: s.errors,
      tokens: s.tokens,
      qps: s.qps,
      tps: s.tps,
      avgTtftMs: s.avgTtftMs,
    }));
    return pts;
  }, [trend.series]);

  const qpsSeries = useMemo(
    () => [
      { key: "qps", label: "QPS", values: series.map((p) => ({ ...p, y: p.qps })) },
      { key: "tps", label: "TPS", color: "#22c55e", values: series.map((p) => ({ ...p, y: p.tps })) },
    ],
    [series]
  );

  const errSeries = useMemo(
    () => [
      {
        key: "errors",
        label: "错误数",
        color: "#ef4444",
        values: series.map((p) => ({ ...p, y: p.errors })),
      },
      {
        key: "calls",
        label: "调用数",
        color: "#3b82f6",
        values: series.map((p) => ({ ...p, y: p.calls })),
      },
    ],
    [series]
  );

  const rankSets = {
    model: { items: (g.topModels || []).map((m) => ({ name: m.model, ...m })), key: "model", suffix: " 次" },
    channel: { items: (g.topChannels || []).map((m) => ({ name: m.channel, ...m })), key: "channel", suffix: " 次" },
    user: { items: (g.topUsers || []).map((m) => ({ name: `用户 #${m.userId}`, ...m })), key: "userId", suffix: " 次" },
    vendor: { items: (g.topVendors || []).map((m) => ({ name: m.vendor || "未登记", ...m })), key: "vendor", suffix: " 次" },
  };

  if (loading && !data) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div style={{ padding: 20 }}>
        <AntAlert type="error" message="加载监控数据失败" description={error} showIcon />
        <Button style={{ marginTop: 12 }} onClick={() => load()}>
          重试
        </Button>
      </div>
    );
  }

  const lat = g.latency || {};
  const ttft = g.ttft;
  const hist = (g.latencyHistogram || []).map((b) => ({ label: b.range.replace("ms", ""), value: b.count }));

  return (
    <div>
      <PageHeader
        title="运维监控"
        subtitle={
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            v{data?.version} · 进程运行 {fmtDuration(proc.uptimeSec)} · {sys.hostname} · {proc.platform}
            {liveOk ? (
              <span style={{ marginLeft: 8, color: "var(--green)" }}>● 实时推送中</span>
            ) : (
              <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>○ 轮询模式</span>
            )}
          </span>
        }
        extra={
          <Space size={6}>
            <Segmented size="small" value={interval} options={REFRESH_OPTIONS} onChange={setIntervalMs} />
            <Button size="small" icon={<ReloadOutlined spin={loading} />} onClick={() => load()}>
              刷新
            </Button>
          </Space>
        }
      />

      {/* ① 健康分 + 智能诊断 */}
      <HealthPanel health={health} diagnosis={data?.diagnosis} onRefresh={() => load()} loading={loading} />

      {/* ② 概览小标签 */}
      <Strip
        items={[
          { label: "在途", value: rt.inFlight ?? 0, color: (rt.inFlight ?? 0) > 20 ? "var(--orange)" : undefined },
          { label: "峰值在途", value: g.peakInFlight ?? 0 },
          { label: "SLA", value: rt.sla != null ? `${rt.sla}%` : "—", color: rt.sla != null && rt.sla < (thresholds.slaPercentMin || 99.5) ? "var(--red)" : undefined },
          { label: "成功率", value: g.successRate != null ? `${g.successRate}%` : "—" },
          { label: "错误率", value: g.errorRate != null ? `${g.errorRate}%` : "—", color: g.errorRate > (thresholds.errorRateMax || 5) ? "var(--red)" : undefined },
          { label: "业务限制", value: g.businessLimited ?? 0 },
          { label: "上游错误", value: g.upstream?.errors ?? 0, color: (g.upstream?.errors ?? 0) > 0 ? "var(--orange)" : undefined },
          { label: "429/529", value: `${g.upstream?.count429 ?? 0}/${g.upstream?.count529 ?? 0}` },
          { label: "换号次数", value: g.channelSwitches ?? 0 },
          { label: "换号率", value: g.switchRate != null ? `${g.switchRate}%` : "—" },
          { label: "总请求", value: g.requests ?? 0 },
        ]}
      />

      {/* ②b 窗口口径（告警规则实际使用的口径，与进程累计值区分开） */}
      <div className="oo-panel" style={{ padding: "10px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Segmented
            size="small"
            value={winKey}
            onChange={setWinKey}
            options={[
              { value: "m1", label: "近 1 分钟" },
              { value: "m5", label: "近 5 分钟" },
              { value: "m60", label: "近 60 分钟" },
            ]}
          />
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            窗口口径（告警规则按各自的「统计窗口」取这套值，不是进程累计）
          </span>
          {winStats?.partial ? <Tag color="gold">样本仅覆盖 {winStats.coveredMinutes}/{winStats.windowMin} 分钟</Tag> : null}
        </div>
        {winStats ? (
          <Strip
            items={[
              { label: "请求", value: winStats.calls },
              { label: "错误", value: winStats.errors, color: winStats.errors ? "var(--red)" : undefined },
              { label: "成功率", value: winStats.successRate != null ? `${winStats.successRate}%` : "无样本" },
              { label: "错误率", value: winStats.errorRate != null ? `${winStats.errorRate}%` : "无样本", color: winStats.errorRate > (thresholds.errorRateMax || 5) ? "var(--red)" : undefined },
              { label: "Token", value: winStats.tokens },
              { label: "平均 QPS", value: winStats.qps },
              { label: "平均 TPS", value: winStats.tps },
              { label: "平均首字", value: winStats.avgTtftMs ? `${winStats.avgTtftMs}ms` : "—" },
            ]}
          />
        ) : null}
      </div>

      {/* ③ 吞吐实时 + 趋势 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">吞吐趋势（近 60 分钟）</div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              QPS 峰值 {trend.qps?.peak ?? 0} · 均值 {trend.qps?.avg ?? 0} · TPS 峰值 {trend.tps?.peak ?? 0}
            </span>
          </div>
          <Legend series={qpsSeries} />
          <LineChart
            series={qpsSeries}
            height={190}
            tipRender={(i) => {
              const p = series[i];
              if (!p) return null;
              return (
                <>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  <div className="oo-trend-tip-row">
                    <i style={{ background: "#3b82f6" }} />
                    QPS <span>{p.qps}</span>
                  </div>
                  <div className="oo-trend-tip-row">
                    <i style={{ background: "#22c55e" }} />
                    TPS <span>{p.tps}</span>
                  </div>
                  <div className="oo-trend-tip-row">
                    调用 <span>{p.calls}</span>
                  </div>
                  <div className="oo-trend-tip-row">
                    错误 <span>{p.errors}</span>
                  </div>
                </>
              );
            }}
          />
        </div>

        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">错误趋势（近 60 分钟）</div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>错误率 {g.errorRate ?? 0}%</span>
          </div>
          <Legend series={errSeries} />
          <LineChart series={errSeries} height={190} />
        </div>
      </div>

      {/* ④ 资源卡 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 12 }}>
        <ResourceCard
          label="CPU（系统）"
          value={sys.cpuPercent != null ? `${sys.cpuPercent}%` : "计算中"}
          percent={sys.cpuPercent}
          foot={`${sys.cpuCount || 0} 核${sys.loadavg ? ` · 负载 ${sys.loadavg.join(" / ")}` : ""}`}
        />
        <ResourceCard
          label="CPU（本进程）"
          value={proc.cpu ? `${proc.cpu.percent}%` : "计算中"}
          percent={proc.cpu?.percentOfMachine}
          foot={proc.cpu ? `占整机 ${proc.cpu.percentOfMachine}% · 用户 ${proc.cpu.userMs}ms / 系统 ${proc.cpu.systemMs}ms` : "区分「机器忙」和「Node 卡」"}
        />
        <ResourceCard
          label="内存（系统）"
          value={`${sys.usedMemPercent ?? 0}%`}
          percent={sys.usedMemPercent}
          foot={`已用 ${fmtBytes((sys.totalMemBytes || 0) - (sys.freeMemBytes || 0))} / 共 ${fmtBytes(sys.totalMemBytes)}`}
        />
        <ResourceCard
          label="内存（进程 RSS）"
          value={fmtBytes(proc.rssBytes)}
          percent={sys.totalMemBytes ? ((proc.rssBytes || 0) / sys.totalMemBytes) * 100 : null}
          foot={`堆 ${fmtBytes(proc.heapUsedBytes)} / ${fmtBytes(proc.heapTotalBytes)} · 外部 ${fmtBytes(proc.externalBytes)}`}
          extra={
            (proc.externalBytes || 0) > 200 * 1024 * 1024 ? (
              <Tooltip title="外部内存（Buffer）占比偏高，可能是流式响应的 Buffer 未释放">
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>Buffer 偏高</Tag>
              </Tooltip>
            ) : null
          }
        />
        <ResourceCard
          label="磁盘"
          value={sys.disk ? `${sys.disk.usedPercent}%` : "不支持"}
          percent={sys.disk?.usedPercent}
          foot={sys.disk ? `剩余 ${fmtBytes(sys.disk.freeBytes)} / 共 ${fmtBytes(sys.disk.totalBytes)}` : "当前文件系统不支持 statfs"}
        />
        <ResourceCard
          label="事件循环延迟"
          value={data?.eventLoop?.p99Ms != null ? `${data.eventLoop.p99Ms} ms` : "计算中"}
          percent={data?.eventLoop?.p99Ms != null ? Math.min(100, (data.eventLoop.p99Ms / 200) * 100) : null}
          foot={
            data?.eventLoop
              ? `P50 ${data.eventLoop.p50Ms ?? "—"}ms · 最大 ${data.eventLoop.maxMs ?? "—"}ms · 利用率 ${((data.eventLoop.utilization ?? 0) * 100).toFixed(1)}%`
              : "Node 被同步操作阻塞的程度"
          }
        />
        <ResourceCard
          label="数据库连接池"
          value={`${data?.pool?.inUse ?? 0} / ${data?.pool?.total ?? 0}`}
          percent={data?.pool?.total ? (data.pool.inUse / data.pool.total) * 100 : null}
          foot={`空闲 ${data?.pool?.free ?? 0} · 排队 ${data?.pool?.queued ?? 0}`}
          extra={(data?.pool?.queued ?? 0) > 0 ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>有排队</Tag> : null}
        />
        <ResourceCard
          label="活动句柄"
          value={data?.resources?.activeHandles ?? "—"}
          foot={
            data?.resources?.resourceUsage
              ? `非自愿上下文切换 ${data.resources.resourceUsage.involuntarySwitches} · 文件读写 ${data.resources.resourceUsage.fsRead}/${data.resources.resourceUsage.fsWrite}`
              : "Node 没有 goroutine，用活动句柄作类比"
          }
        />
      </div>

      {/* ⑤⑥ 延迟 + 错误分析 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">请求延迟分位</div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>样本 {lat.samples ?? 0} 次</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 8, marginBottom: 12 }}>
            {[
              ["平均", lat.avgMs],
              ["P50", lat.p50Ms],
              ["P90", lat.p90Ms],
              ["P95", lat.p95Ms],
              ["P99", lat.p99Ms],
              ["最大", lat.maxMs],
            ].map(([k, v]) => (
              <div key={k} className="oo-stat-card">
                <div className="oo-stat-card-num" style={{ fontSize: 16 }}>
                  {v ?? 0}
                  <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 2 }}>ms</span>
                </div>
                <div className="oo-stat-card-label">{k}</div>
              </div>
            ))}
          </div>
          <div className="oo-stats-card-title" style={{ marginBottom: 6 }}>
            首 Token 延迟（TTFT）
          </div>
          {ttft ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 8 }}>
              {[
                ["平均", ttft.avgMs],
                ["P50", ttft.p50Ms],
                ["P90", ttft.p90Ms],
                ["P95", ttft.p95Ms],
                ["P99", ttft.p99Ms],
                ["最大", ttft.maxMs],
              ].map(([k, v]) => (
                <div key={k} className="oo-stat-card">
                  <div
                    className="oo-stat-card-num"
                    style={{
                      fontSize: 16,
                      color: k === "P99" && v > (thresholds.ttftP99MsMax || 3000) ? "var(--red)" : undefined,
                    }}
                  >
                    {v ?? 0}
                    <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 2 }}>ms</span>
                  </div>
                  <div className="oo-stat-card-label">{k}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>暂无流式请求样本（TTFT 只在流式响应里可测）</div>
          )}
        </div>

        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">延迟分布</div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>按耗时区间分桶</span>
          </div>
          <BarChart bars={hist} height={150} />

          <div className="oo-stats-card-head" style={{ margin: "14px 0 8px" }}>
            <div className="oo-stats-card-title">HTTP 状态码分布</div>
          </div>
          <BarChart
            bars={(g.byStatus || []).map((s) => ({
              label: String(s.status),
              value: s.count,
              color: s.status >= 500 ? "#ef4444" : s.status >= 400 ? "#f59e0b" : "#22c55e",
            }))}
            height={120}
          />
        </div>
      </div>

      {/* ⑦ 并发与队列 */}
      <div className="oo-panel" style={{ padding: 14, marginBottom: 12 }}>
        <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
          <div className="oo-stats-card-title">并发与队列</div>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            在途 {channels.inflight ?? 0} · 冷却中 {channels.cooling ?? 0} · 启用 {channels.enabled ?? 0} · 近期有错误 {channels.errors ?? 0}
          </span>
        </div>
        <Segmented
          size="small"
          value={concTab}
          onChange={setConcTab}
          options={[
            { value: "channel", label: "按账号" },
            { value: "vendor", label: "按厂商" },
            { value: "model", label: "按模型" },
          ]}
          style={{ marginBottom: 8 }}
        />
        {concTab === "channel" ? (
          <Table
            rowKey="channelId"
            size="small"
            dataSource={(channels.list || []).filter((c) => c.inflight > 0 || c.coolingDown || c.queued > 0 || c.lastError)}
            pagination={false}
            scroll={{ x: 720, y: 240 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有在途请求，也没有冷却中的账号" /> }}
            columns={[
              { title: "#", dataIndex: "channelId", width: 54 },
              { title: "账号", dataIndex: "name", ellipsis: true },
              { title: "厂商", dataIndex: "type", width: 100 },
              { title: "在途", dataIndex: "inflight", width: 70, render: (v) => <span className="oo-num">{v}</span> },
              {
                title: "排队",
                dataIndex: "queued",
                width: 70,
                render: (v) => (v ? <Badge count={v} size="small" /> : <span style={{ color: "var(--ink-3)" }}>—</span>),
              },
              {
                title: "冷却",
                dataIndex: "cooldownRemainSec",
                width: 90,
                render: (v) => (v ? <Tag color="orange">{Math.ceil(v / 60)} 分钟</Tag> : <span style={{ color: "var(--ink-3)" }}>—</span>),
              },
              { title: "累计调用", dataIndex: "usedCount", width: 90, render: (v) => <span className="oo-num">{v}</span> },
              { title: "最近错误", dataIndex: "lastError", ellipsis: true },
            ]}
          />
        ) : (
          <Table
            rowKey={concTab === "vendor" ? "vendor" : "model"}
            size="small"
            dataSource={
              concTab === "vendor"
                ? (g.topVendors || []).map((v) => ({
                    vendor: v.vendor || "未登记",
                    calls: v.calls,
                    errors: v.errors,
                    successRate: v.successRate,
                    avgMs: v.avgMs,
                    avgTtftMs: v.avgTtftMs,
                  }))
                : (g.topModels || []).map((v) => ({
                    model: v.model,
                    calls: v.calls,
                    errors: v.errors,
                    successRate: v.successRate,
                    avgMs: v.avgMs,
                    avgTtftMs: v.avgTtftMs,
                  }))
            }
            pagination={false}
            scroll={{ x: 640, y: 240 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本进程还没有调用记录" /> }}
            columns={[
              { title: concTab === "vendor" ? "厂商" : "模型", dataIndex: concTab === "vendor" ? "vendor" : "model", ellipsis: true },
              { title: "调用", dataIndex: "calls", width: 80, render: (v) => <span className="oo-num">{v}</span> },
              { title: "错误", dataIndex: "errors", width: 70, render: (v) => (v ? <Tag color="red">{v}</Tag> : <span style={{ color: "var(--ink-3)" }}>0</span>) },
              {
                title: "成功率",
                dataIndex: "successRate",
                width: 90,
                render: (v) => <span className="oo-num" style={{ color: v != null && v < 95 ? "var(--red)" : undefined }}>{v != null ? `${v}%` : "—"}</span>,
              },
              { title: "平均耗时", dataIndex: "avgMs", width: 100, render: (v) => <span className="oo-num">{v ?? 0} ms</span> },
              { title: "平均首字", dataIndex: "avgTtftMs", width: 100, render: (v) => <span className="oo-num">{v ? `${v} ms` : "—"}</span> },
            ]}
          />
        )}
      </div>

      {/* ⑧ 平台概览 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, marginBottom: 12 }}>
        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">平台概览</div>
          </div>
          <Strip
            items={[
              { label: "渠道", value: `${overview.channels?.enabled ?? 0}/${overview.channels?.total ?? 0}` },
              { label: "自动禁用", value: overview.channels?.autoDisabled ?? 0, color: overview.channels?.autoDisabled ? "var(--orange)" : undefined },
              { label: "密钥", value: `${overview.tokens?.active ?? 0}/${overview.tokens?.total ?? 0}` },
              { label: "用户", value: `${overview.users?.active ?? 0}/${overview.users?.total ?? 0}` },
              { label: "低余额用户", value: overview.users?.lowBalance ?? 0 },
            ]}
          />
          <Strip
            items={[
              { label: "近1小时调用", value: overview.lastHour?.calls ?? 0 },
              { label: "近1小时失败", value: overview.lastHour?.errors ?? 0, color: overview.lastHour?.errors ? "var(--red)" : undefined },
              { label: "近24小时调用", value: overview.last24h?.calls ?? 0 },
              { label: "近24小时失败", value: overview.last24h?.errors ?? 0, color: overview.last24h?.errors ? "var(--red)" : undefined },
              { label: "近24小时消费", value: `${overview.last24h?.units ?? 0} 单位` },
            ]}
          />
        </div>

        <div className="oo-panel" style={{ padding: 14 }}>
          <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
            <div className="oo-stats-card-title">数据表体积</div>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>判断日志是否需要清理</span>
          </div>
          <RankBar
            items={(overview.tables || []).map((t) => ({ name: t.name, mb: t.mb, rows: t.rows }))}
            nameKey="name"
            valueKey="mb"
            suffix=" MB"
          />
        </div>
      </div>

      {/* ⑨ 排行 */}
      <div className="oo-panel" style={{ padding: 14, marginBottom: 12 }}>
        <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
          <div className="oo-stats-card-title">调用排行（本进程累计）</div>
          <Segmented
            size="small"
            value={rankTab}
            onChange={setRankTab}
            options={[
              { value: "model", label: "模型" },
              { value: "channel", label: "渠道" },
              { value: "user", label: "用户" },
              { value: "vendor", label: "厂商" },
            ]}
          />
        </div>
        <RankBar
          items={rankSets[rankTab].items.map((m) => ({
            name: m.name,
            calls: m.calls,
            rate: `${m.successRate ?? "—"}% · ${m.avgMs ?? 0}ms${m.avgTtftMs ? ` · 首字 ${m.avgTtftMs}ms` : ""}`,
          }))}
          nameKey="name"
          valueKey="calls"
          suffix=" 次"
        />
        <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-3)" }}>
          {rankSets[rankTab].items.slice(0, 8).map((m) => `${m.name}：成功率 ${m.successRate ?? "—"}%（平均 ${m.avgMs ?? 0}ms${m.avgTtftMs ? `，首字 ${m.avgTtftMs}ms` : ""}）`).join(" · ") || "暂无调用记录"}
        </div>
      </div>

      {/* ⑩ 告警中心 */}
      <AlertPanel data={data} onReload={() => load(true)} />
    </div>
  );
}
