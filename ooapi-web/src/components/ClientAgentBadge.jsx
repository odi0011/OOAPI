import React from "react";
import {   Tooltip  } from "./arc/index";
import { RobotOutlined  } from "./arc/icons";
import agents from "../../../ooapi-server/src/services/client-agents.json";
import "./client-agent.css";
import { reasoningLabel, requestedReasoningLabel } from "../services/reasoning-display";
import BrandLogo from "./BrandLogo";
import { useApp } from "../context/AppContext";

export { agents as CLIENT_AGENTS };
const sources = { header: "客户端声明", "relay-header": "中转项目请求头", "user-agent": "User-Agent 标记", "api-key": "管理员按密钥配置", internal: "本站会话", unknown: "未记录识别来源", disabled: "识别已关闭" };
const confidenceText = {
  heuristic: "根据请求标记推测；User-Agent 可能被中转转发或模拟。",
  declared: "请求方自行声明，未独立验证客户端身份。",
  configured: "按已鉴权密钥的管理员配置识别。",
  internal: "本站内部会话调用。",
};
export default function ClientAgentBadge({ agent, record }) {
  const { status } = useApp();
  const value = agent || record?.client_agent || {};
  const product = agents.find(a => a.id === value.id);
  const reported = agents.find(a => a.id === value.reported_client?.id);
  const name = product?.internal ? status?.system_name || "OOAPI" : product?.name;
  if (!product) return null;
  const title = <div>{name}{value.version ? ` ${value.version}` : ""}<br />{sources[value.source] || sources.unknown}
    {confidenceText[value.confidence] ? <><br />{confidenceText[value.confidence]}</> : value.source === "user-agent" ? <><br />{confidenceText.heuristic}</> : ["header", "relay-header"].includes(value.source) ? <><br />{confidenceText.declared}</> : null}
    {reported ? <><br />请求标记的客户端：{reported.name}{value.reported_client.version ? ` ${value.reported_client.version}` : ""}（仅为请求声明）</> : null}
    {value.conflict ? <><br />声明与识别结果冲突，未应用 Agent 路由</> : null}
    {record?.agent_routing ? <><br />路由规则：{record.agent_routing.id} · {record.agent_routing.version}</> : null}
    {record?.reasoning_requested ? <><br />请求思考：{requestedReasoningLabel(record.reasoning_requested)} · 实际选择：{reasoningLabel(record.reasoning_selected)}</> : null}
  </div>;
  return <Tooltip title={title}><span className="oo-client-agent" data-agent={product.id}>
    {product?.internal ? <BrandLogo size={14} /> : product?.icon ? <img src={`/icons/agents/${product.icon}`} alt="" className={product.mono ? "oo-client-agent-mono" : ""} /> : <RobotOutlined />}
    <span>{name}</span>
  </span></Tooltip>;
}
