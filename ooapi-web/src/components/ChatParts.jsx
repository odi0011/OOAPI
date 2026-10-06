import React, { useLayoutEffect, useRef, useState } from "react";
import { Button, Tooltip, Alert, Progress, Collapse } from "./arc/index";
import { Check, Circle, LoaderCircle } from "lucide-react";
export function Shelf({ children, className = "" }) { return <nav className={`arc-chat-shelf ${className}`}>{children}</nav>; }
export function ShelfGroup({ title, children, defaultOpen = true, action }) { return <section className="arc-chat-shelf-group"><div className="arc-chat-shelf-action">{action}</div><Collapse className="arc-chat-shelf-collapse" defaultActiveKey={defaultOpen ? ["sessions"] : []} items={[{key:"sessions",label:title,children}]}/></section>; }
export function ShelfItem({ active, icon, label, hint, onClick, actions, title }) {
  const labelRef = useRef(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = labelRef.current;
    if (!node) return undefined;
    const measure = () => setTruncated(node.scrollWidth > node.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [label]);
  const button = <Button type="text" icon={icon} aria-current={active ? "page" : undefined} onClick={onClick}>
    <span className="arc-chat-label-shell"><span ref={labelRef} className="arc-chat-label oo-truncate">{label}</span></span>
    {hint && <small>{hint}</small>}
  </Button>;
  return <div className="arc-chat-session" data-active={active || undefined}>
    <Tooltip title={title || label} placement="right" disabled={!truncated}>{button}</Tooltip>
    {actions ? <div className="arc-chat-session-actions">{actions}</div> : null}
  </div>;
}
export function Notice({ tone = "info", title, children, actions }) { return <Alert type={tone === "warn" ? "warning" : tone} message={title} description={children} action={actions}/>; }
export function TodoPanel({ todo = [] }) { if (!todo.length) return null; const done=todo.filter(t=>t.status==="completed").length; return <Collapse defaultActiveKey={["tasks"]} items={[{key:"tasks",label:`任务清单 ${done}/${todo.length}`,children:<><Progress percent={done/todo.length*100}/><ul className="arc-chat-todos">{todo.map((t,i)=><li key={i}>{t.status==="completed"?<Check size={15}/>:t.status==="in_progress"?<LoaderCircle size={15}/>:<Circle size={15}/>}<span>{t.content}</span></li>)}</ul></>}]}/>; }
export function StreamingText({ children, streaming }) { return <div className="arc-chat-answer" aria-busy={streaming || undefined}>{children}</div>; }
