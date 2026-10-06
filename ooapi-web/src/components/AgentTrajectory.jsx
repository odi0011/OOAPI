import { Button as ActionButton } from "./arc/index";
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ChatMascot from "./ChatMascot";
import { OdText } from "./OdAmount";

import { capsuleGesture, executionEntries, presentation, taskSummary, toolName } from "./executionPresentation";

function ExecutionPill({ part, active, open, hidden, layout, onOpen, onCollapsed }) {
  const [visited, setVisited] = useState(false);
  const measureRef = useRef(null), stepRef = useRef(null), pillRef = useRef(null);
  const focusedRef = useRef(false);
  const detailId = useId();
  const { thought, failed, state, label } = presentation(part, active);
  const summary = taskSummary(part);
  // 思考是不断追加的文本，折叠时保留末尾；不能把整段右侧省略，永远停在开头。
  const preview = active && !open ? (thought
    ? Array.from(String(part.text || "").slice(-512).replace(/\s+/g, " ").trim()).slice(-120).join("")
    : String(summary).replace(/\s+/g, " ")) : "";
  const previewContent = preview && <span className={`execution-pill-preview ${thought ? "is-latest" : ""}`}><span>{preview}</span></span>;
  useEffect(() => { if (!active) onOpen(false); }, [active]);
  // 同行隐藏后用整行承接详情，从原点击位置向空处展开；宽度与左边距同步变化，
  // 始终包含原来的按钮范围，避免重排凭空触发 pointerleave 又立即收起。
  // 测量层独立于动画，ResizeObserver 不观察正在变化的胶囊。
  useLayoutEffect(() => {
    const pill = pillRef.current, focused = !!layout;
    const naturalWidth = () => Math.ceil(Math.min(stepRef.current.parentElement.clientWidth, measureRef.current.getBoundingClientRect().width || 180));
    if (focused !== focusedRef.current) {
      pill.style.transition = "none";
      pill.style.width = `${layout?.width || naturalWidth()}px`;
      pill.style.marginLeft = `${layout?.left || 0}px`;
      // 在同一帧建立起点，不能等下一帧才补位置，否则鼠标已离开原按钮。
      pill.getBoundingClientRect();
      pill.style.transition = "";
      focusedRef.current = focused;
    }
    const update = () => {
      if (stepRef.current?.hidden) return;
      const natural = naturalWidth(), available = stepRef.current.parentElement.clientWidth;
      const width = Math.min(available, open ? Math.max(natural, 520, (layout?.left || 0) + (layout?.width || 0)) : natural);
      pill.style.width = `${width}px`;
      pill.style.marginLeft = `${layout && !open ? Math.min(layout.left, Math.max(0, available - width)) : 0}px`;
    };
    const observer = new ResizeObserver(update);
    observer.observe(measureRef.current); observer.observe(stepRef.current.parentElement); update();
    return () => observer.disconnect();
  }, [open, layout]);
  const tool = part.tool || part.type || "other";
  return <div ref={stepRef} hidden={hidden} data-execution-id={part.id} data-execution-type={part.type} data-execution-tool={tool} className={`execution-step ${active ? "is-running" : "is-settled"} ${failed ? "is-failed" : ""} ${layout ? "is-focused" : ""}`}>
    <span ref={measureRef} className="execution-measure" aria-hidden="true"><span className="execution-mascot-space"/><span className="execution-pill-label">{label}</span>{previewContent}</span>
    <div ref={pillRef} className={`execution-pill ${open ? "is-open" : ""}`}
      onPointerLeave={e => { if (e.pointerType !== "touch") onOpen(false); }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onOpen(false); }}
      onTransitionEnd={e => { if (e.target === e.currentTarget && e.propertyName === "width" && !open) onCollapsed(); }}
      onKeyDown={e => { if (e.key === "Escape") { onOpen(false); e.stopPropagation(); } }}>
      <ActionButton type="text" htmlType="button" className="execution-pill-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => { setVisited(true); onOpen(!open, stepRef.current); }}>
        <ChatMascot state={state} gesture={capsuleGesture(part)}/><span className="execution-pill-label">{label}</span>{previewContent}
      </ActionButton>
      <div id={detailId} className={`execution-detail ${open ? "is-open" : ""}`} inert={!open ? "" : undefined}><div>{visited && (thought ? <p className="execution-thought">{part.text || "正在整理思路…"}</p> : <>
        <div className="execution-task"><span>{part.type === "compaction" ? "整理上下文" : toolName(part)}</span>{summary && <p>{summary}</p>}</div>
        <div className="trajectory-output"><OdText>{part.output || part.text || (active ? "乐乐正在忙，稍等一下下～" : "这一步已结束")}</OdText></div>
      </>)}</div></div>
    </div>
  </div>;
}

export default function AgentTrajectory({ parts = [], streaming, finalTextId }) {
  const [expanded, setExpanded] = useState(null);
  const trajectoryRef = useRef(null);
  const entries = executionEntries(parts, streaming, finalTextId);
  const change = (id, open, node) => {
    if (!open) { setExpanded(previous => previous?.id === id && previous.open ? { ...previous, open: false } : previous); return; }
    if (expanded?.id === id) { setExpanded({ ...expanded, open: true }); return; }
    // 在展开改变宽度之前记下同行记录；下面的行保持可见，不用互相挤压。
    const top = node.offsetTop;
    const peers = [...node.parentElement.children].filter(n => n !== node && Math.abs(n.offsetTop - top) < 2).map(n => n.dataset.executionId);
    const left = node.getBoundingClientRect().left - node.parentElement.getBoundingClientRect().left;
    const width = node.querySelector(".execution-pill").getBoundingClientRect().width;
    setExpanded({ id, peers, left, width, open: true });
  };
  // 收回动画结束才恢复同行，避免其他按钮在逐帧变窄的详情旁反复换行。
  const collapsed = id => setExpanded(previous => previous?.id === id && !previous.open ? null : previous);
  useEffect(() => {
    if (!expanded || expanded.open) return;
    const timer = setTimeout(() => collapsed(expanded.id), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500);
    return () => clearTimeout(timer);
  }, [expanded]);
  useLayoutEffect(() => {
    let width = trajectoryRef.current.getBoundingClientRect().width;
    // 只有宽度变化会让原来的同行划分失效；地址栏/键盘等高度变化不应打断阅读。
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) < 1) return;
      width = entry.contentRect.width;
      setExpanded(null);
    });
    observer.observe(trajectoryRef.current);
    return () => observer.disconnect();
  }, []);
  if (streaming && !entries.some(p => p.active) && !parts.some(p => p.type === "text" && p.id === finalTextId)) entries.push({part:{type:"waiting",id:"waiting"},active:true});
  return <section ref={trajectoryRef} className="agent-trajectory" aria-label="乐乐的执行过程">
    {entries.map(({part, active}, i) => <ExecutionPill key={part.id || i} part={part} active={active} open={expanded?.id === part.id && expanded.open} layout={expanded?.id === part.id ? expanded : null} hidden={expanded?.peers.includes(part.id)} onOpen={(open, node) => change(part.id, open, node)} onCollapsed={() => collapsed(part.id)}/>)}
  </section>;
}
