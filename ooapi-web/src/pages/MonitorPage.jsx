// 运维监控（管理员）
// ---------------------------------------------------------------------------
// 指标来源：GET /api/monitor/snapshot（后端用 Node 内置模块采集，见 services/metrics.js）。
// 展示分四块：
//   ① 概览行：进程/系统关键指标（用小 tag，不占版面）
//   ② 资源卡：CPU / 内存 / 磁盘 / 事件循环延迟（带进度条与阈值着色）
//   ③ 网关运行时：在途/峰值、成功率、延迟分位、状态码分布
//   ④ 排行：Top 模型 / Top 渠道（成功率 + 平均耗时）
// 颜色语义与全站一致：<70% 主色、70-90% 橙、>90% 红（同渠道额度条）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { App as AntApp, Segmented, Spin, Empty, Tooltip } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";

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

/** 资源卡：标题 + 大字数值 + 进度条 + 副标题 */
function ResourceCard({ label, value, percent, foot, extra }) {
  return (
    <div className="oo-panel" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>{label}</div>
      <div className="oo-num" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
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
      {foot ? <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{foot}</div> : null}
      {extra || null}
    </div>
  );
}

/** 排行条（模型/渠道共用） */
function RankList({ items, keyName, emptyText }) {
  if (!items?.length) {
    return <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  const max = Math.max(1, ...items.map((x) => x.calls));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((x) => (
        <div key={x[keyName]} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span className="oo-truncate" style={{ width: 150, fontFamily: "var(--font-mono)" }} title={x[keyName]}>
            {x[keyName]}
          </span>
          <span style={{ flex: 1, height: 7, background: "var(--inset)", borderRadius: 4, overflow: "hidden" }}>
            <span
              style={{
                display: "block",
                width: `${Math.max(2, (x.calls / max) * 100)}%`,
                height: "100%",
                background: usageColor(x.successRate === null ? 0 : 100 - x.successRate),
              }}
            />
          </span>
          <span className="oo-num" style={{ width: 56, textAlign: "right" }}>{x.calls} 次</span>
          <span className="oo-num" style={{ width: 62, textAlign: "right", color: placementColor(x.successRate) }}>
            {x.successRate === null ? "—" : `${x.successRate}%`}
          </span>
          <span className="oo-num" style={{ width: 66, textAlign: "right", color: "var(--ink-3)" }}>
            {(x.avgMs / 1000).toFixed(2)}s
          </span>
        </div>
      ))}
    </div>
  );
}
function placementColor(rate) {
  if (rate === null || rate === undefined) return "var(--ink-3)";
  if (rate >= 99) return "var(--green)";
  if (rate >= 95) return "var(--orange)";
  return "var(--red)";
}

export default function MonitorPage() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoSec, setAutoSec] = useState(5);
  const timerRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const d = await API.get("/monitor/snapshot", { timeoutMs: 20_000 });
      setData(d);
      setError("");
    } catch (e) {
      setError(e.message || "监控数据加载失败");
      if (!silent) message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 首次加载 + 自动刷新（手动模式下不建定时器）
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!autoSec) return undefined;
    timerRef.current = setInterval(() => load({ silent: true }), autoSec * 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [autoSec, load]);

  const s = data;
  const gw = s?.gateway || {};
  const sys = s?.system || {};
  const ov = s?.overview || {};

  return (
    <div className="oo-page">
      <PageHeader
        title="运维监控"
        extra={
          <>
            <Segmented
              size="small"
              value={autoSec}
              onChange={setAutoSec}
              options={[
                { value: 5, label: "5s" },
                { value: 15, label: "15s" },
                { value: 60, label: "60s" },
                { value: 0, label: "手动" },
              ]}
            />
            <button className="bui-icon-btn" aria-label="立即刷新" onClick={() => load()}>
              <ReloadOutlined />
            </button>
          </>
        }
      />

      {error ? (
        <div className="oo-panel" style={{ padding: 14, marginBottom: 12 }}>
          <span style={{ color: "var(--red)", fontSize: 13 }}>{error}</span>
          <button type="button" className="bui-btn" style={{ marginLeft: 10 }} onClick={() => load()}>重试</button>
        </div>
      ) : null}

      {loading && !s ? (
        <div className="oo-panel" style={{ padding: 40, textAlign: "center" }}>
          <Spin />
        </div>
      ) : s ? (
        <>
          {/* 概览：一行小 tag（列表页规范，不占版面） */}
          <div className="oo-stats-strip">
            <span className="bui-chip" title="服务版本">版本 <b>{s.version}</b></span>
            <span className="bui-chip" title="进程运行时长">运行 <b>{fmtDuration(s.process?.uptimeSec)}</b></span>
            <span className="bui-chip" title="Node 版本与平台">Node <b>{s.process?.nodeVersion}</b> · {s.process?.platform}</span>
            <span className="bui-chip" title="当前在途请求">在途 <b className="oo-num">{gw.inFlight ?? 0}</b></span>
            <span className="bui-chip" title="峰值在途">峰值 <b className="oo-num">{gw.peakInFlight ?? 0}</b></span>
            <span className="bui-chip" title="本进程累计请求">请求 <b className="oo-num">{gw.requests ?? 0}</b></span>
            <span
              className={`bui-chip${gw.successRate !== null && gw.successRate < 95 ? " bui-chip--red" : ""}`}
              title="本进程成功率"
            >
              成功率 <b className="oo-num">{gw.successRate === null ? "—" : `${gw.successRate}%`}</b>
            </span>
            <span className="bui-chip" title="P95 延迟">P95 <b className="oo-num">{(gw.latency?.p95Ms / 1000 || 0).toFixed(2)}s</b></span>
            <span className="bui-chip" title="近 1 小时调用 / 失败">近1h <b className="oo-num">{ov.lastHour?.calls ?? 0}</b>/{ov.lastHour?.errors ?? 0}</span>
            <span className="bui-chip" title="近 24 小时调用 / 失败">近24h <b className="oo-num">{ov.last24h?.calls ?? 0}</b>/{ov.last24h?.errors ?? 0}</span>
          </div>

          {/* 资源 */}
          <div className="oo-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
            <ResourceCard
              label="CPU"
              value={sys.cpuPercent === null || sys.cpuPercent === undefined ? "计算中…" : `${sys.cpuPercent}%`}
              percent={sys.cpuPercent}
              foot={`${sys.cpuCount} 核${sys.loadavg ? ` · 负载 ${sys.loadavg.join(" / ")}` : ""}`}
            />
            <ResourceCard
              label="内存"
              value={`${sys.usedMemPercent ?? 0}%`}
              percent={sys.usedMemPercent}
              foot={`${fmtBytes((sys.totalMemBytes || 0) - (sys.freeMemBytes || 0))} / ${fmtBytes(sys.totalMemBytes)}`}
            />
            <ResourceCard
              label="进程内存"
              value={fmtBytes(s.process?.rssBytes)}
              foot={`堆 ${fmtBytes(s.process?.heapUsedBytes)} / ${fmtBytes(s.process?.heapTotalBytes)} · 外部 ${fmtBytes(s.process?.externalBytes)}`}
            />
            <ResourceCard
              label="磁盘"
              value={sys.disk ? `${sys.disk.usedPercent}%` : "不支持"}
              percent={sys.disk?.usedPercent}
              foot={sys.disk ? `${fmtBytes(sys.disk.usedBytes)} / ${fmtBytes(sys.disk.totalBytes)}` : "当前文件系统不支持 statfs"}
            />
            <ResourceCard
              label="事件循环延迟"
              value={s.eventLoop ? `${s.eventLoop.p50Ms}ms` : "不支持"}
              percent={s.eventLoop ? Math.min(100, (s.eventLoop.p99Ms / 200) * 100) : null}
              foot={s.eventLoop ? `P99 ${s.eventLoop.p99Ms}ms · 峰值 ${s.eventLoop.maxMs}ms` : "perf_hooks 不可用"}
            />
            <ResourceCard
              label="数据库连接池"
              value={s.pool ? `${s.pool.inUse} / ${s.pool.total}` : "—"}
              percent={s.pool && s.pool.total ? (s.pool.inUse / s.pool.total) * 100 : null}
              foot={s.pool ? `空闲 ${s.pool.free} · 排队 ${s.pool.queued}` : ""}
            />
          </div>

          {/* 网关运行时 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginBottom: 12 }}>
            <div className="oo-panel" style={{ padding: 14 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
                <div className="oo-stats-card-title">延迟分位（本进程最近 {gw.latency?.samples || 0} 次）</div>
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                {[
                  ["平均", gw.latency?.avgMs],
                  ["P50", gw.latency?.p50Ms],
                  ["P95", gw.latency?.p95Ms],
                  ["P99", gw.latency?.p99Ms],
                ].map(([label, v]) => (
                  <div key={label}>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{label}</div>
                    <div className="oo-num" style={{ fontSize: 18, fontWeight: 600 }}>{((v || 0) / 1000).toFixed(2)}s</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, fontSize: 12 }}>
                <div style={{ color: "var(--ink-3)", marginBottom: 6 }}>HTTP 状态码分布</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(gw.byStatus || []).length ? (
                    gw.byStatus.map((x) => (
                      <span
                        key={x.status}
                        className={`bui-chip${x.status >= 500 ? " bui-chip--red" : x.status >= 400 ? " bui-chip--orange" : ""}`}
                      >
                        {x.status} <b className="oo-num">{x.count}</b>
                      </span>
                    ))
                  ) : (
                    <span style={{ color: "var(--ink-3)" }}>暂无请求</span>
                  )}
                </div>
              </div>
            </div>

            <div className="oo-panel" style={{ padding: 14 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
                <div className="oo-stats-card-title">平台概览</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                <span className="bui-chip">渠道 <b className="oo-num">{ov.channels?.total ?? 0}</b></span>
                <span className="bui-chip bui-chip--green">启用 <b className="oo-num">{ov.channels?.enabled ?? 0}</b></span>
                {ov.channels?.autoDisabled ? (
                  <span className="bui-chip bui-chip--red">自动禁用 <b className="oo-num">{ov.channels.autoDisabled}</b></span>
                ) : null}
                <span className="bui-chip">密钥 <b className="oo-num">{ov.tokens?.active ?? 0}</b>/{ov.tokens?.total ?? 0}</span>
                <span className="bui-chip">用户 <b className="oo-num">{ov.users?.active ?? 0}</b>/{ov.users?.total ?? 0}</span>
                {ov.users?.lowBalance ? (
                  <span className="bui-chip bui-chip--orange">低余额 <b className="oo-num">{ov.users.lowBalance}</b></span>
                ) : null}
                {s.thresholds?.autoTestEnabled ? <span className="bui-chip bui-chip--green">定时检测 开</span> : null}
                {s.thresholds?.rateLimitEnabled ? <span className="bui-chip">限流 开</span> : null}
              </div>
              <div style={{ marginTop: 12, fontSize: 12 }}>
                <div style={{ color: "var(--ink-3)", marginBottom: 6 }}>数据表体积（Top 8）</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(ov.tables || []).map((t) => (
                    <div key={t.name} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontFamily: "var(--font-mono)" }}>{t.name}</span>
                      <span className="oo-num" style={{ color: t.mb >= 500 ? "var(--orange)" : "var(--ink-3)" }}>{t.mb} MB</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 排行 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12 }}>
            <div className="oo-panel" style={{ padding: 14 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
                <div className="oo-stats-card-title">模型调用（本进程）</div>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>次数 · 成功率 · 平均耗时</span>
              </div>
              <RankList items={gw.topModels} keyName="model" emptyText="本进程还没有调用记录" />
            </div>
            <div className="oo-panel" style={{ padding: 14 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 10 }}>
                <div className="oo-stats-card-title">渠道调用（本进程）</div>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>次数 · 成功率 · 平均耗时</span>
              </div>
              <RankList items={gw.topChannels} keyName="channel" emptyText="本进程还没有调用记录" />
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
            <Tooltip title="本页的请求数/延迟分位是进程内累计，服务重启后清零；跨重启的历史请看使用记录与操作日志。">
              <span>采样时间：{new Date(s.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（进程级指标随重启清零）</span>
            </Tooltip>
          </div>
        </>
      ) : null}
    </div>
  );
}
