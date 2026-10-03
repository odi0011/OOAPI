import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, App } from "antd";
import Markdown from "./Markdown";
import ChatMascot from "./ChatMascot";
import { OdText } from "./OdAmount";

const statusName = { running: "执行中", done: "完成啦", failed: "遇到问题啦", pending: "等待确认", awaiting_approval: "等你确认", approved: "已允许", denied: "已拒绝", expired: "已过期", cancelled: "已取消", stopped: "已停下" };

export function ToolApproval({ part, onDecide, active }) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  if (!active || part.status !== "pending") return null;
  const decide = async decision => {
    setSaving(true);
    try { await onDecide(part.id, decision); }
    catch (e) { message.error(e.message || "确认失败，请重试"); }
    finally { setSaving(false); }
  };
  return <section className="tool-approval is-pending" role="region" aria-label="乐乐需要你的确认">
    <div className="tool-approval-heading"><ChatMascot state="waiting"/><strong>允许{part.name}？</strong></div>
    <dl className="tool-approval-args">{Object.entries(part.args || {}).map(([key, value]) => <div key={key}><dt>{({ action:"操作", limit:"条数", query:"搜索", url:"网页", repo:"仓库", prompt:"任务" })[key] || key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
    <div className="tool-approval-actions"><Button disabled={saving} onClick={() => decide("denied")}>拒绝</Button><Button type="primary" loading={saving} onClick={() => decide("approved")}>仅允许这次</Button></div>
  </section>;
}

function ExecutionPill({ part, active }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef(null), buttonRef = useRef(null), widthRef = useRef(0);
  const isThought = part.type === "reasoning" || part.type === "text";
  const failed = ["failed", "stopped", "cancelled", "denied", "expired"].includes(part.status);
  const state = active ? part.status === "awaiting_approval" ? "waiting" : part.type === "compaction" ? "compressing" : isThought ? "thinking" : part.type === "approval" ? "waiting" : "working" : failed ? "sad" : "success";
  const label = part.type === "compaction" ? active ? "收拾一下记忆…" : failed ? "记忆整理暂停啦" : "记忆收好啦～"
    : isThought ? active ? "乐乐正在想…" : failed ? "思考暂停啦" : part.type === "reasoning" ? "思考完成啦～" : "想法记下啦～"
    : `${part.name || part.tool || "执行"} · ${active ? part.status === "awaiting_approval" ? "等你确认" : "进行中" : statusName[part.status] || "完成啦"}`;
  const preview = active ? String(part.text || part.args?.query || part.args?.url || "").replace(/\s+/g, " ") : "";
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  // 宽度由内容测量，文字变长/完成缩回都走同一条弹性过渡。
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const update = () => {
      const width = node.getBoundingClientRect().width, previous = widthRef.current;
      widthRef.current = width;
      if (previous && Math.abs(previous - width) > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        buttonRef.current?.animate([{ width: `${previous + 24}px` }, { width: `${width + 24}px` }], { duration: 520, easing: "cubic-bezier(.2,1.35,.4,1)" });
      }
    };
    const observer = new ResizeObserver(update); observer.observe(node); update();
    return () => observer.disconnect();
  }, []);
  return <div className={`execution-step ${active ? "is-running" : "is-settled"} ${failed ? "is-failed" : ""}`}>
    <button ref={buttonRef} type="button" className="execution-pill" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span ref={contentRef} className="execution-pill-content"><ChatMascot state={state}/><span className="execution-pill-label">{label}</span>{preview && <span className="execution-pill-preview">{preview}</span>}{active && <span className="lele-sparks" aria-hidden="true"><i/><i/><i/></span>}</span>
    </button>
    <div className={`execution-detail ${open ? "is-open" : ""}`}><div>{open && (isThought ? <Markdown text={part.text || "正在整理思路…"}/> : <>
      {part.args && <dl className="tool-approval-args">{Object.entries(part.args).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>}
      <div className="trajectory-output"><OdText>{part.output || part.text || (active ? "正在执行…" : "已结束")}</OdText></div>
    </>)}</div></div>
  </div>;
}

export default function AgentTrajectory({ parts = [], streaming, finalTextId }) {
  const lastToolIndex = parts.reduce((n, p, i) => p.type === "tool" ? i : n, -1);
  const entries = parts.filter((p, i) => ["tool", "reasoning", "compaction"].includes(p.type) || (p.type === "approval" && ["denied", "expired"].includes(p.status)) || (p.type === "text" && i < lastToolIndex && p.id !== finalTextId));
  const activeReasoning = streaming && parts.findLast(p => ["reasoning", "text", "tool"].includes(p.type))?.id;
  return <section className="agent-trajectory" aria-label="乐乐的执行过程">
    {entries.map((p, i) => <ExecutionPill key={p.id || i} part={p} active={Boolean(streaming && (["running", "pending", "awaiting_approval"].includes(p.status) || (p.type === "reasoning" && !p.status && p.id === activeReasoning)))}/>)}
    {streaming && !entries.some(p => ["running", "pending", "awaiting_approval"].includes(p.status) || p.id === activeReasoning) && !parts.some(p => p.type === "text" && p.id === finalTextId) && <ExecutionPill part={{type:"reasoning",id:"waiting"}} active/>}
  </section>;
}
