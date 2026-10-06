import { Button as ActionButton } from "./arc/index";
import React, { useEffect, useMemo, useState } from "react";
import {  Tooltip  } from "./arc/index";

const textOf = message => (message?.parts || []).filter(p => p.type === "text").map(p => p.text || "").join(" ").replace(/\s+/g, " ").trim();

export default function ConversationRail({ messages, threadRef, onNavigate }) {
  const [active, setActive] = useState(0);
  const turns = useMemo(() => messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const answer = messages[index + 1];
    return [{ index, prompt: textOf(message) || "附件消息", answer: answer?.role === "assistant" ? textOf(answer).slice(0, 200) : "" }];
  }), [messages]);
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = thread.getBoundingClientRect().top + 70;
        const nodes = [...thread.querySelectorAll(".ui-msg-user[data-message-index]")];
        const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 8;
        const current = atEnd ? nodes.at(-1) : nodes.findLast(n => n.getBoundingClientRect().top <= top) || nodes[0];
        if (current) setActive(Number(current.dataset.messageIndex));
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(thread); if (thread.firstElementChild) observer.observe(thread.firstElementChild);
    thread.addEventListener("scroll", update, { passive: true }); update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); thread.removeEventListener("scroll", update); };
  }, [threadRef, turns.length]);
  if (!turns.length) return null;
  const jump = index => {
    const thread = threadRef.current, target = thread?.querySelector(`[data-message-index="${index}"]`);
    if (!target) return;
    onNavigate?.();
    thread.scrollTo({ top: thread.scrollTop + target.getBoundingClientRect().top - thread.getBoundingClientRect().top - 20, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setActive(index);
  };
  return <nav className="conversation-rail" aria-label="对话消息导航">
    {turns.map((turn, i) => <Tooltip key={turn.index} placement="right" trigger={["hover", "focus"]} mouseEnterDelay={.12} title={<div className="conversation-rail-preview"><strong>{turn.prompt}</strong>{turn.answer && <p>{turn.answer}</p>}</div>}>
      <ActionButton type="text" htmlType="button" className={turn.index === active ? "is-current" : ""} aria-current={turn.index === active ? "step" : undefined} aria-label={`第 ${i + 1} 轮：${turn.prompt.slice(0, 65)}`} onClick={() => jump(turn.index)}><span/></ActionButton>
    </Tooltip>)}
  </nav>;
}
