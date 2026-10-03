import React, { useEffect, useId, useRef, useState } from "react";
import ChatMascot from "./ChatMascot";
import { executionEntries, failedPart, presentation, toolName } from "./executionPresentation";
import "./chat-run-flow.css";

// 只展示这一轮真实事件；没有演示计时器，也不向平台策略写入任何设置。
export default function ChatRunFlow({ message }) {
  const [open, setOpen] = useState(Boolean(message?.streaming));
  const bodyId = useId(), listRef = useRef(null);
  const collapseTimer = useRef(null), wasStreaming = useRef(Boolean(message?.streaming));
  const streaming = Boolean(message?.streaming);
  const parts = message?.parts || [];
  const final = parts.findLast(p => p.type === "text" && parts.indexOf(p) > parts.findLastIndex(v => v.type === "tool"));
  const entries = executionEntries(parts, streaming, final?.id);
  const failed = ["failed", "stopped"].includes(message?.status) || parts.some(p => p.type === "error");
  const active = entries.findLast(p => p.active);
  const current = active ? presentation(active.part, true).label : streaming ? final ? "正在写回答…" : "正在接着想…" : failed ? "这一轮停下啦" : "这一轮完成啦～";
  useEffect(() => {
    clearTimeout(collapseTimer.current);
    if (streaming) setOpen(true);
    else if (wasStreaming.current) collapseTimer.current = setTimeout(() => setOpen(false), 2400);
    wasStreaming.current = streaming;
    return () => clearTimeout(collapseTimer.current);
  }, [streaming, message?.key]);
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: "auto" });
  }, [open, entries.length, active?.part.id, Boolean(final)]);
  if (!message) return null;
  return <aside className={`chat-run-flow ${open ? "is-open" : ""} ${streaming ? "is-live" : ""}`} aria-label="本轮执行流程">
    <button className="chat-run-flow-toggle" type="button" aria-label="查看本轮执行流程" title={current} aria-expanded={open} aria-controls={bodyId} onClick={() => { clearTimeout(collapseTimer.current); setOpen(v => !v); }}>
      <ChatMascot state={streaming ? active ? presentation(active.part, true).state : "thinking" : failed ? "sad" : "success"}/>
      <span><strong>乐乐的进度</strong><small>{current}</small></span><span className="chat-run-flow-fold" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div id={bodyId} className="chat-run-flow-body" inert={!open ? "" : undefined}><div ref={listRef}>
      <ol className="chat-run-flow-nodes">
        <li className="is-done"><span className="flow-node-dot"/><span><b>收到你的问题</b><small>开始这一轮</small></span></li>
        {entries.map(({part, active: running}, i) => <li key={part.id || i} className={`${running ? "is-active" : failedPart(part) ? "is-failed" : "is-done"} ${part.type === "tool" ? "is-tool" : ""}`} aria-current={running ? "step" : undefined}>
          <span className="flow-node-dot"/><span><b>{part.type === "compaction" ? "整理记忆" : ["reasoning", "text"].includes(part.type) ? "理一理思路" : toolName(part)}</b><small>{presentation(part, running).label}</small></span>
        </li>)}
        {!active && streaming && !final && <li className="is-active" aria-current="step"><span className="flow-node-dot"/><span><b>{entries.length ? "接着思考" : "准备回答"}</b><small>乐乐在想下一步…</small></span></li>}
        {(final || !streaming) && <li className={streaming ? "is-active" : failed ? "is-failed" : "is-done"} aria-current={streaming ? "step" : undefined}><span className="flow-node-dot"/><span><b>{failed ? "本轮已停止" : streaming ? "写下回答" : "回答已送达"}</b><small>{streaming ? "正在组织文字…" : failed ? "可以在对话中查看原因" : "这一轮的足迹都在这里"}</small></span></li>}
      </ol>
    </div></div>
  </aside>;
}
