import React, { useCallback, useEffect, useState } from "react";
import { Row, Col, Button, Grid, App as AntApp, Alert } from "antd";
import {
  WalletOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  RiseOutlined,
  ReloadOutlined,
  CopyOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { copyText, fmtOd, odOf, odRateText, unitsPerOd } from "../services/format";
import { OdStatValue } from "../components/OdCoin";

// 近 30 天用量柱状图（纯 CSS，无额外依赖）
function UsageBars({ daily, perUnit, loading, error }) {
  if (loading) {
    return (
      <div style={{ padding: "28px 0", textAlign: "center", color: "var(--oo-text-muted)", fontSize: 13 }}>
        正在加载用量记录…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "28px 0", textAlign: "center", color: "var(--oo-text-muted)", fontSize: 13 }}>
        用量记录加载失败，请点击上方重试
      </div>
    );
  }
  const max = Math.max(1, ...daily.map((d) => Number(d.quota) || 0));
  if (!daily.length) {
    return (
      <div style={{ padding: "28px 0", textAlign: "center", color: "var(--oo-text-muted)", fontSize: 13 }}>
        暂无调用记录
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120 }}>
        {daily.map((d) => {
          const q = Number(d.quota) || 0;
          const h = Math.max(3, Math.round((q / max) * 100));
          return (
            <div
              key={d.day}
              title={`${d.day}　${fmtOd(q, perUnit, 4)}　${d.calls} 次`}
              style={{
                flex: 1,
                height: `${h}%`,
                minWidth: 4,
                borderRadius: "3px 3px 0 0",
                background:
                  q > 0
                    ? "linear-gradient(to top, color-mix(in srgb, var(--oo-primary) 55%, transparent), var(--oo-primary))"
                    : "var(--oo-bg-subtle)",
                transition: "opacity 160ms ease",
                cursor: "default",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 11,
          color: "var(--oo-text-muted)",
        }}
      >
        <span>{daily[0]?.day}</span>
        <span>近 {daily.length} 天</span>
        <span>{daily[daily.length - 1]?.day}</span>
      </div>
    </div>
  );
}

export default function ConsolePage() {
  const { user, status, refreshUser } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;
  const [data, setData] = useState(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { begin, isLatest } = useLatest();

  // alsoUser=true 时顺带刷新全局用户信息（刷新按钮用），保证余额卡不是缓存的旧值
  const loadData = useCallback(async ({ alsoUser = false } = {}) => {
    const token = begin();
    setRefreshing(true);
    setDataLoading(true);
    setDataError(null);
    try {
      const d = await API.get("/users/data/self");
      if (!isLatest(token)) return;
      setData(d);
      if (alsoUser) await refreshUser();
    } catch (e) {
      if (isLatest(token)) {
        setDataError(e.message || "数据加载失败，请重试");
        message.error(e.message || "数据加载失败，请重试");
      }
    } finally {
      if (isLatest(token)) {
        setRefreshing(false);
        setDataLoading(false);
      }
    }
  }, [message, refreshUser, begin, isLatest]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const perUnit = unitsPerOd(status); // 1 OD币 = 10,000 额度单位（固定 1 OD = $1）
  // 额度展示统一走 fmtOd：全站货币只能是 OD币（1 OD = 1 美元）
  const od = (q) => fmtOd(q, perUnit, 2);
  // 去掉结尾斜杠：api_endpoint 以 / 结尾时 curl 示例会生成 `//chat/completions`
  // （HomePage 已是这个口径，两处保持一致）
  const endpoint = (status?.api_endpoint || "https://your-domain/v1").replace(/\/+$/, "");

  const totalQuota = Number(user?.quota || 0) + Number(user?.used_quota || 0);
  const usedPct = totalQuota > 0 ? Math.min(100, (Number(user?.used_quota || 0) / totalQuota) * 100) : 0;

  const copyEndpoint = async () => {
    try {
      await copyText(endpoint);
      message.success("接口地址已复制");
    } catch {
      message.error("复制失败，请手动选择复制");
    }
  };

  return (
    <div className="oo-page">
      <PageHeader
        title={`你好，${user?.display_name || user?.username}`}
        desc="这是你的账户概览与近期用量"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => loadData({ alsoUser: true })} title="刷新控制台数据" aria-label="刷新控制台数据">
              刷新
            </Button>
            <Button type="primary" icon={<KeyOutlined />} onClick={() => navigate("/token")}>
              管理令牌
            </Button>
          </>
        }
      />

      {dataError ? (
        <Alert
          type="error"
          showIcon
          closable={false}
          style={{ marginBottom: 16 }}
          message="控制台数据加载失败"
          description={dataError}
          action={<Button size="small" onClick={() => loadData({ alsoUser: true })}>重试</Button>}
        />
      ) : null}

      {/* 指标卡 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatCard
            label="剩余额度"
            value={<OdStatValue od={odOf(user?.quota, perUnit)} />}
            icon={<WalletOutlined />}
            glow="color-mix(in srgb, var(--oo-primary) 32%, transparent)"
            foot={<span>共 {od(totalQuota)} 额度</span>}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="已用额度"
            value={<OdStatValue od={odOf(user?.used_quota, perUnit)} />}
            icon={<ThunderboltOutlined />}
            tone="warning"
            glow="color-mix(in srgb, var(--orange) 20%, transparent)"
            foot={
              <div style={{ width: "100%" }}>
                <div className="oo-bar" style={{ marginBottom: 6 }}>
                  <div
                    className="oo-bar-fill"
                    style={{
                      width: `${usedPct}%`,
                      background: "linear-gradient(90deg, var(--orange), var(--red))",
                    }}
                  />
                </div>
                <span>占比 {usedPct.toFixed(1)}%</span>
              </div>
            }
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="调用次数"
            value={(user?.request_count ?? 0).toLocaleString()}
            icon={<ApiOutlined />}
            tone="success"
            glow="color-mix(in srgb, var(--green) 18%, transparent)"
            foot={<span>累计成功请求</span>}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="近 30 天消费"
            value={data ? od(data.consume_in_logs) : dataLoading ? "加载中…" : "—"}
            icon={<RiseOutlined />}
            glow="color-mix(in srgb, var(--oo-primary) 32%, transparent)"
            foot={<span>{data ? `${data.daily?.length || 0} 天有调用` : dataLoading ? "正在加载" : "—"}</span>}
          />
        </Col>
      </Row>

      {/* 用量趋势 + 账户信息 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <div className="oo-panel" style={{ height: "100%" }}>
            <div className="oo-panel-head">
              <span className="oo-panel-title">用量趋势</span>
              <span style={{ fontSize: 12, color: "var(--oo-text-muted)" }}>按日消费（OD）</span>
            </div>
            <div className="oo-panel-body">
              <UsageBars daily={data?.daily || []} perUnit={perUnit} loading={dataLoading} error={dataError} />
            </div>
          </div>
        </Col>

        <Col xs={24} lg={10}>
          <div className="oo-panel" style={{ height: "100%" }}>
            <div className="oo-panel-head">
              <span className="oo-panel-title">账户信息</span>
            </div>
            <div className="oo-panel-body" style={{ paddingTop: 6 }}>
              <div className="oo-kv">
                <span className="oo-kv-k">用户名</span>
                <span className="oo-kv-v">{user?.username}</span>
              </div>
              <div className="oo-kv">
                <span className="oo-kv-k">显示名称</span>
                <span className="oo-kv-v">{user?.display_name || "-"}</span>
              </div>
              <div className="oo-kv">
                <span className="oo-kv-k">用户分组</span>
                <span className="oo-kv-v">{user?.group || "default"}</span>
              </div>
              <div className="oo-kv">
                <span className="oo-kv-k">邀请码</span>
                <span className="oo-kv-v">
                  <span className="oo-mono">{user?.aff_code || "-"}</span>
                </span>
              </div>
            </div>
          </div>
        </Col>
      </Row>

      {/* 快速开始 */}
      <div className="oo-panel">
        <div className="oo-panel-head">
          <span className="oo-panel-title">接入信息</span>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyEndpoint}>
            复制地址
          </Button>
        </div>
        <div className="oo-panel-body">
          <Row gutter={[16, 12]}>
            <Col xs={24} md={12}>
              <div className="oo-kv">
                <span className="oo-kv-k">Base URL</span>
                <span className="oo-kv-v">
                  <span className="oo-mono">{endpoint}</span>
                </span>
              </div>
              <div className="oo-kv">
                <span className="oo-kv-k">鉴权</span>
                <span className="oo-kv-v">
                  <span className="oo-mono">Authorization: Bearer sk-xxx</span>
                </span>
              </div>
            </Col>
            <Col xs={24} md={12}>
              <div className="oo-kv">
                <span className="oo-kv-k">计费比例</span>
                <span className="oo-kv-v">{odRateText(perUnit)}</span>
              </div>
              <div className="oo-kv">
                <span className="oo-kv-k">可用模型</span>
                <span className="oo-kv-v">
                  {(status?.model_list || []).slice(0, 4).join("、") || "-"}
                  {(status?.model_list?.length || 0) > 4 ? ` 等 ${status.model_list.length} 个` : ""}
                </span>
              </div>
            </Col>
          </Row>

          {!isMobile && (
            <div className="oo-code" style={{ marginTop: 14 }}>
              <div className="oo-code-head">
                <span className="oo-dot oo-dot--ok" />
                <span>快速测试</span>
              </div>
              <pre>
{`curl ${endpoint}/chat/completions \\
  -H "Authorization: Bearer sk-xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'`}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
