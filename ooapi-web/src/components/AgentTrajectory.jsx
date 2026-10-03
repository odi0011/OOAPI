import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, App } from "antd";
import ChatMascot from "./ChatMascot";
import { OdText } from "./OdAmount";

import { executionEntries, presentation, taskSummary, toolName } from "./executionPresentation";

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
  const [visited, setVisited] = useState(false);
  const [width, setWidth] = useState(null);
  const measureRef = useRef(null), stepRef = useRef(null);
  const detailId = useId();
  const { thought, failed, state, label } = presentation(part, active);
  const summary = taskSummary(part);
  const preview = active && !open ? String(thought ? part.text || "" : summary).replace(/\s+/g, " ") : "";
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  // 测量独立的自然宽度，绝不能观察正在过渡的胶囊，否则会循环缩小、反复闪动。
  useLayoutEffect(() => {
    const update = () => {
      const natural = measureRef.current?.getBoundingClientRect().width || 180;
      const available = stepRef.current?.clientWidth || natural;
      setWidth(Math.ceil(Math.min(available, open ? Math.max(natural, 520) : natural)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(measureRef.current); observer.observe(stepRef.current); update();
    return () => observer.disconnect();
  }, [open]);
  return <div ref={stepRef} data-execution-type={part.type} className={`execution-step ${active ? "is-running" : "is-settled"} ${failed ? "is-failed" : ""}`}>
    <span ref={measureRef} className="execution-measure" aria-hidden="true"><span className="execution-mascot-space"/><span className="execution-pill-label">{label}</span>{preview && <span className="execution-pill-preview">{preview}</span>}</span>
    <div className={`execution-pill ${open ? "is-open" : ""}`} style={width ? { width } : undefined}>
      <button type="button" className="execution-pill-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => { setVisited(true); setOpen(v => !v); }}>
        <ChatMascot state={state}/><span className="execution-pill-label">{label}</span>{preview && <span className="execution-pill-preview">{preview}</span>}
      </button>
      <div id={detailId} className={`execution-detail ${open ? "is-open" : ""}`} inert={!open ? "" : undefined}><div>{visited && (thought ? <p className="execution-thought">{part.text || "正在整理思路…"}</p> : <>
        <div className="execution-task"><span>{part.type === "compaction" ? "整理上下文" : toolName(part)}</span>{summary && <p>{summary}</p>}</div>
        <div className="trajectory-output"><OdText>{part.output || part.text || (active ? "乐乐正在忙，稍等一下下～" : "这一步已结束")}</OdText></div>
      </>)}</div></div>
    </div>
  </div>;
}

export default function AgentTrajectory({ parts = [], streaming, finalTextId }) {
  const entries = executionEntries(parts, streaming, finalTextId);
  return <section className="agent-trajectory" aria-label="乐乐的执行过程">
    {entries.map(({part, active}, i) => <ExecutionPill key={part.id || i} part={part} active={active}/>)}
    {streaming && !entries.some(p => p.active) && !parts.some(p => p.type === "text" && p.id === finalTextId) && <ExecutionPill key="waiting" part={{type:"reasoning",id:"waiting"}} active/>}
  </section>;
}
