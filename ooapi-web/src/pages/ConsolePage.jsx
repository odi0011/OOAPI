import React, { useEffect, useState } from "react";
import { Row, Col, Button, Grid, App as AntApp } from "antd";
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
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { copyText, fmtOd, odOf, odRateText, unitsPerOd } from "../services/format";
import { OdStatValue } from "../components/OdCoin";

// 近 30 天用量柱状图（纯 CSS，无额外依赖）
function UsageBars({ daily, perUnit }) {
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
  const { user, status } = useApp();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    setRefreshing(true);
    try {
      setData(await API.get("/users/data/self"));
    } catch (e) {
      message.error(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const perUnit = unitsPerOd(status); // 1 OD币 = 10,000 额度单位（固定 1 OD = $1）
  // 额度展示统一走 fmtOd：全站货币只能是 OD币（1 OD = 1 美元）
  const od = (q) => fmtOd(q, perUnit, 2);
  const endpoint = status?.api_endpoint || "https://your-domain/v1";

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
    <div>
      <PageHeader
        title={`你好，${user?.display_name || user?.username}`}
        desc="这是你的账户概览与近期用量"
        extra={
          <>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={loadData}>
              刷新
            </Button>
            <Button type="primary" icon={<KeyOutlined />} onClick={() => navigate("/token")}>
              管理令牌
            </Button>
          </>
        }
      />

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
            glow="rgba(245,158,11,0.16)"
            foot={
              <div style={{ width: "100%" }}>
                <div className="oo-bar" style={{ marginBottom: 6 }}>
                  <div
                    className="oo-bar-fill"
                    style={{
                      width: `${usedPct}%`,
                      background: "linear-gradient(90deg, #f59e0b, #ef4444)",
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
            glow="rgba(34,197,94,0.14)"
            foot={<span>累计成功请求</span>}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="近 30 天消费"
            value={od(data?.consume_in_logs)}
            icon={<RiseOutlined />}
            glow="color-mix(in srgb, var(--oo-primary) 32%, transparent)"
            foot={<span>{data?.daily?.length || 0} 天有调用</span>}
          />
        </Col>
      </Row>

      {/* 用量趋势 + 账户信息 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <div className="oo-panel" style={{ height: "100%" }}>
            <div className="oo-panel-head">
              <span className="oo-panel-title">用量趋势</span>
              <span style={{ fontSize: 12, color: "var(--oo-text-muted)" }}>按日消费（OD）</span>
            </div>
            <div className="oo-panel-body">
              <UsageBars daily={data?.daily || []} perUnit={perUnit} />
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
      <div className="oo-panel" style={{ marginTop: 16 }}>
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
