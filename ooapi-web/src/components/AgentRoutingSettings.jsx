import React from "react";
import { Alert, Button, InputNumber, Select, Switch } from "antd";
import { ArrowUpOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import ClientAgentBadge, { CLIENT_AGENTS } from "./ClientAgentBadge";

const reasoningOptions = [
  ["preserve", "沿用通用适配（未传关闭，超出范围选最强）"], ["unsupported-default", "不支持的档位使用模型最强"], ["model-default", "使用模型默认档位（未传仍关闭）"],
  ["none", "关闭（none）"], ["low", "低（low）"], ["medium", "中（medium）"], ["high", "高（high）"], ["xhigh", "极高（xhigh）"], ["max", "最高（max）"],
].map(([value, label]) => ({ value, label }));

export function routingValue(raw) {
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return null; } }
  return raw?.version === 1 && Array.isArray(raw.rules) && (raw.bindings === undefined || Array.isArray(raw.bindings)) ? { ...raw, bindings: raw.bindings || [] } : null;
}
export default function AgentRoutingSettings({ value, onChange, disabled }) {
  const config = routingValue(value);
  if (!config) return <Alert type="error" showIcon message="Agent 规则无法读取，请重新加载设置。" />;
  const rules = config.rules, bindings = config.bindings;
  const agentOptions = CLIENT_AGENTS.filter(a => !a.internal).map(a => ({ value: a.id, label: a.name }));
  const update = next => onChange?.({ ...config, rules: next });
  const updateBindings = next => onChange?.({ ...config, bindings: next });
  const patchBinding = (index, fields) => updateBindings(bindings.map((binding, i) => i === index ? { ...binding, ...fields } : binding));
  const patch = (index, fields) => update(rules.map((r, i) => i === index ? { ...r, ...fields } : r));
  return <div className="oo-agent-rules">
    <p className="oo-admin-settings-note">从上到下匹配第一条启用规则。渠道优先级只影响当前密钥可用的渠道；留空沿用全局设置。推理调整可能改变回答质量。</p>
    {!rules.length ? <div className="oo-agent-rules-empty">尚无专用规则，所有 Agent 使用通用路由。</div> : null}
    {rules.map((r, index) => <div className="oo-agent-rule" key={r.id}>
      <div className="oo-agent-rule-head">
        <ClientAgentBadge agent={{ id: r.agent, source: "header" }} />
        <Switch size="small" checked={r.enabled} aria-label={`启用规则 ${index + 1}`} disabled={disabled} onChange={enabled => patch(index, { enabled })} />
        <span className="oo-agent-rule-order">规则 {index + 1}</span>
        <Button size="small" type="text" icon={<ArrowUpOutlined />} aria-label={`上移规则 ${index + 1}`} disabled={disabled || index === 0} onClick={() => { const next = [...rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update(next); }} />
        <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除规则 ${index + 1}`} disabled={disabled} onClick={() => update(rules.filter((_, i) => i !== index))} />
      </div>
      <div className="oo-agent-rule-grid">
        <label>调用 Agent<Select aria-label={`规则 ${index + 1} Agent`} value={r.agent} disabled={disabled} options={agentOptions} onChange={agent => patch(index, { agent })} /></label>
        <label>适用模型<Select aria-label={`规则 ${index + 1} 模型`} mode="tags" value={r.models} disabled={disabled} tokenSeparators={[","]} placeholder="留空匹配所有模型，可输入多个型号" onChange={models => patch(index, { models })} /></label>
        <label>思考强度<Select aria-label={`规则 ${index + 1} 思考强度`} value={r.reasoning} options={reasoningOptions} disabled={disabled} onChange={reasoning => patch(index, { reasoning })} /></label>
        <label>优先渠道编号<Select aria-label={`规则 ${index + 1} 优先渠道`} mode="tags" value={r.preferredChannels.map(String)} disabled={disabled} tokenSeparators={[",", " "]} placeholder="按顺序输入渠道编号，如 6、8" onChange={values => patch(index, { preferredChannels: values.map(v => /^\d+$/.test(v) ? Number(v) : v) })} /></label>
        <label>请求超时（毫秒）<InputNumber aria-label={`规则 ${index + 1} 超时`} value={r.timeoutMs} min={1000} max={86400000} step={1000} precision={0} disabled={disabled} placeholder="沿用全局" onChange={timeoutMs => patch(index, { timeoutMs })} /></label>
        <label>换渠道重试次数<InputNumber aria-label={`规则 ${index + 1} 重试`} value={r.retries} min={0} max={10} precision={0} disabled={disabled} placeholder="沿用全局" onChange={retries => patch(index, { retries })} /></label>
      </div>
    </div>)}
    <Button aria-label="添加 Agent 规则" icon={<PlusOutlined />} disabled={disabled || rules.length >= 40} onClick={() => update([...rules, { id: `agent-${Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7)}`, enabled: false, agent: "zcode", models: [], preferredChannels: [], reasoning: "preserve", timeoutMs: null, retries: null }])}>添加 Agent 规则</Button>
    <p className="oo-admin-settings-note">可通过 X-OOAPI-Agent 声明调用来源，X-OOAPI-Agent-Version 声明版本；中转站可声明 sub2api、new-api、one-api、litellm 或 one-hub，并用 X-OOAPI-Client-Agent、X-OOAPI-Client-Agent-Version 标注原始客户端。明确的 User-Agent 标记仅用于推测；请求头可能被转发或模拟，不能据此验证来源。声明冲突时使用通用路由。</p>
    <p className="oo-admin-settings-note">密钥绑定：为不同 Agent 或中转项目使用专用密钥，再按已鉴权的密钥编号绑定来源；绑定优先于请求头和 User-Agent。绑定不会扩大密钥可用渠道或模型范围；同一密钥只能绑定一次，共用密钥无法区分不同调用来源。</p>
    {!bindings.length ? <div className="oo-agent-rules-empty">尚未配置密钥绑定。</div> : null}
    {bindings.map((binding, index) => <div className="oo-agent-rule" key={`binding-${index}`}>
      <div className="oo-agent-rule-head">
        <ClientAgentBadge agent={{ id: binding.agent, source: "api-key", confidence: "configured" }} />
        <span className="oo-agent-rule-order">绑定 {index + 1}</span>
        <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除绑定 ${index + 1}`} disabled={disabled} onClick={() => updateBindings(bindings.filter((_, i) => i !== index))} />
      </div>
      <div className="oo-agent-rule-grid">
        <label>密钥编号<InputNumber aria-label={`绑定 ${index + 1} 密钥编号`} value={binding.tokenId} min={1} max={Number.MAX_SAFE_INTEGER} precision={0} disabled={disabled} placeholder="输入密钥编号" onChange={tokenId => patchBinding(index, { tokenId })} /></label>
        <label>绑定 Agent<Select aria-label={`绑定 ${index + 1} Agent`} value={binding.agent} options={agentOptions} disabled={disabled} onChange={agent => patchBinding(index, { agent })} /></label>
      </div>
    </div>)}
    <Button aria-label="添加密钥绑定" icon={<PlusOutlined />} disabled={disabled || bindings.length >= 100} onClick={() => updateBindings([...bindings, { tokenId: null, agent: "codex" }])}>添加密钥绑定</Button>
  </div>;
}
