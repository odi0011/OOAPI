import React, { useState } from "react";
import { Button, Modal, App } from "antd";
import { CheckOutlined, DownOutlined, LoadingOutlined, SafetyOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import Markdown from "./Markdown";
import CodeBlock from "./CodeBlock";
import ChatMascot from "./ChatMascot";
import { OdText } from "./OdAmount";

const statusName = { running: "执行中", awaiting_approval: "等待确认", done: "完成", failed: "未成功", pending: "等待确认", approved: "已允许", denied: "已拒绝", expired: "已过期", cancelled: "已取消" };

export function ToolApproval({ part, onDecide, active }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const pending = active && part.status === "pending";
  const decide = async (decision) => {
    setSaving(true);
    try { await onDecide(part.id, decision); setOpen(false); }
    catch (e) { message.error(e.message || "审批失败，请重试"); }
    finally { setSaving(false); }
  };
  return <div className={`tool-approval ${pending ? "is-pending" : ""}`}>
    <SafetyOutlined/><span>{part.name} · {statusName[part.status] || "审批已结束"}</span>
    {pending && <Button size="small" onClick={() => setOpen(true)}>查看并审批</Button>}
    <Modal title={`允许${part.name}？`} open={pending && open} onCancel={() => setOpen(false)} footer={<><Button disabled={saving} onClick={() => decide("denied")}>拒绝</Button><Button type="primary" loading={saving} onClick={() => decide("approved")}>仅允许这次</Button></>}>
      <p>仅在你的账号权限内执行。拒绝后，助手会继续处理能完成的部分。</p>
      <CodeBlock lang="json" title="本次操作参数" code={JSON.stringify(part.args, null, 2)}/>
    </Modal>
  </div>;
}

export default function AgentTrajectory({ parts = [], streaming, finalTextId }) {
  const [open, setOpen] = useState(false);
  const calls = parts.filter((p) => p.type === "tool");
  const track = parts.find((p) => p.type === "trajectory");
  const entries = parts.filter((p) => ["tool", "reasoning"].includes(p.type) || (p.type === "approval" && p.status !== "pending") || (p.type === "text" && p.id !== finalTextId)).sort((a, b) => a.created && b.created ? a.created - b.created : 0);
  if (!entries.length && !streaming) return null;
  const running = calls.find((p) => p.status === "running");
  const waiting = parts.some((p) => p.type === "approval" && p.status === "pending");
  const label = streaming ? waiting ? "等待你的确认" : track?.status === "summarizing" ? "正在整理回答" : running ? running.name : "正在思考" : track?.partial ? "本轮查询已结束" : "查看执行过程";
  return <section className={`agent-trajectory ${streaming ? "is-active" : ""}`}>
    <button type="button" className="agent-trajectory-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {streaming ? <ChatMascot state={waiting ? "waiting" : running ? "working" : "thinking"}/> : ["failed", "stopped"].includes(track?.status) ? <ExclamationCircleOutlined/> : <CheckOutlined/>}
      <span>{label}</span>{calls.length > 0 && <small>{calls.length} 个步骤</small>}<DownOutlined rotate={open ? 180 : 0}/>
    </button>
    {open && <ol className="agent-trajectory-list">{entries.map((p, i) => <li key={p.id || i} className={`is-${p.status || p.type}`}>
      <span className="trajectory-dot"/>
      {p.type === "tool" ? <details><summary><span>{p.name || p.tool}</span><small>{p.reused ? "复用结果" : statusName[p.status]}{p.ended && p.started ? ` · ${((p.ended - p.started) / 1000).toFixed(1)}s` : ""}</small>{p.status === "running" && <LoadingOutlined/>}</summary>
        <div className="trajectory-args"><CodeBlock lang="json" title="调用参数" code={JSON.stringify(p.args || {}, null, 2)}/></div>
        <div className="trajectory-output"><OdText>{p.output || "等待工具结果…"}</OdText></div>
      </details> : p.type === "approval" ? <details><summary>{p.name} · {statusName[p.status]}</summary><CodeBlock lang="json" title="审批参数" code={JSON.stringify(p.args, null, 2)}/></details> : <details><summary>{p.type === "reasoning" ? "思考摘要" : "进展说明"}</summary><Markdown text={p.text}/></details>}
    </li>)}</ol>}
  </section>;
}
