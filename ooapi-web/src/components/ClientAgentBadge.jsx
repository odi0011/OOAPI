import React from "react";
import { Tooltip } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import agents from "../../../ooapi-server/src/services/client-agents.json";
import "./client-agent.css";
import { reasoningLabel, requestedReasoningLabel } from "../services/reasoning-display";
import BrandLogo from "./BrandLogo";
import { useApp } from "../context/AppContext";

export { agents as CLIENT_AGENTS };
const sources = { header: "客户端声明", "relay-header": "中转项目请求头", "user-agent": "User-Agent 识别", internal: "本站会话", unknown: "客户端未提供可识别标记", disabled: "识别已关闭" };
export default function ClientAgentBadge({ agent, record, showUnknown = false }) {
  const { status } = useApp();
  const value = agent || record?.client_agent || {};
  const product = agents.find(a => a.id === value.id);
  const name = product?.internal ? status?.system_name || "OOAPI" : product?.name;
  if (!product && !showUnknown) return null;
  const title = <div>{name || "未识别 Agent"}{value.version ? ` ${value.version}` : ""}<br />{sources[value.source] || sources.unknown}
    {value.conflict ? <><br />声明与识别结果冲突，未应用 Agent 路由</> : null}
    {record?.agent_routing ? <><br />路由规则：{record.agent_routing.id} · {record.agent_routing.version}</> : null}
    {record?.reasoning_requested ? <><br />请求思考：{requestedReasoningLabel(record.reasoning_requested)} · 实际选择：{reasoningLabel(record.reasoning_selected)}</> : null}
  </div>;
  return <Tooltip title={title}><span className="oo-client-agent" data-agent={product?.id || "unknown"}>
    {product?.internal ? <BrandLogo size={14} /> : product?.icon ? <img src={`/icons/agents/${product.icon}`} alt="" className={product.mono ? "oo-client-agent-mono" : ""} /> : <RobotOutlined />}
    <span>{name || (value.source === "disabled" ? "Agent 识别已关闭" : "未识别 Agent")}</span>
  </span></Tooltip>;
}
