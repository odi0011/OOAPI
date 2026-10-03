import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "antd";
import ChatMascot from "./ChatMascot";
import "./composer-companion.css";

const hash = value => Array.from(String(value || "lele")).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
const choose = values => values[Math.floor(Math.random() * values.length)];
const askPoses = [
  { edge: "top", at: .18, gesture: "curious", head: -31 },
  { edge: "top", at: .4, gesture: "listen", head: -27 },
  { edge: "top", at: .64, gesture: "invite", head: -32 },
  { edge: "top", at: .82, gesture: "shy", head: -23 },
];
const idlePose = { edge: "top", at: .72, gesture: "peek", head: -24 };

// 同一处边线同时约束猫、爪子、气泡尾巴。身体在裁剪层外侧，爪子独立握住边线。
// 不观察动画自身的宽高，避免位置测量与动画互相触发。
export default function ComposerCompanion({ state, approvals = [], onDecide }) {
  const pending = approvals[0] || null;
  const [retained, setRetained] = useState(pending);
  const [pose, setPose] = useState(() => pending ? askPoses[hash(pending.id) % askPoses.length] : idlePose);
  const [phase, setPhase] = useState("enter");
  const [geometry, setGeometry] = useState({ width: 320, top: 700, height: 100, left: 40, bottom: 800, viewportWidth: 1440, viewportHeight: 1000, viewportTop: 0 });
  const [quiet, setQuiet] = useState(() => document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const marker = useRef(null), locked = useRef(false), hover = useRef(false), focused = useRef(false);
  const live = useRef({ pose, geometry, pending, retained, saving });
  live.current = { pose, geometry, pending, retained, saving };
  const labelId = useId();
  const part = pending || retained, closing = Boolean(part && !pending);

  useLayoutEffect(() => {
    const parent = marker.current?.parentElement;
    if (!parent) return;
    const update = () => {
      const r = parent.getBoundingClientRect(), v = window.visualViewport;
      setGeometry({ width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, viewportWidth: document.documentElement.clientWidth, viewportHeight: v?.height || innerHeight, viewportTop: v?.offsetTop || 0 });
    };
    const observer = new ResizeObserver(update); observer.observe(parent); update();
    window.addEventListener("resize", update); window.visualViewport?.addEventListener("resize", update); window.visualViewport?.addEventListener("scroll", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setQuiet(document.hidden || media.matches);
    document.addEventListener("visibilitychange", update); media.addEventListener("change", update);
    return () => { document.removeEventListener("visibilitychange", update); media.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    if (!pending) {
      const timer = setTimeout(() => { setRetained(null); hover.current = false; focused.current = false; }, quiet ? 0 : 260);
      return () => clearTimeout(timer);
    }
    setRetained(pending); setError("");
    // 从侧面/下沿先收爪缩回，再从上沿探出。气泡等乐乐就位后才展开。
    if (live.current.pose.edge !== "top") {
      setPhase("exit");
      const timer = setTimeout(() => { setPose(askPoses[hash(pending.id) % askPoses.length]); setPhase("enter"); }, quiet ? 0 : 300);
      return () => clearTimeout(timer);
    }
    setPose(askPoses[hash(pending.id) % askPoses.length]); setPhase("enter");
  }, [pending?.id, quiet]);

  useEffect(() => {
    if (quiet) return;
    let timer, move;
    const schedule = () => { timer = setTimeout(() => {
      const current = live.current;
      if (hover.current || focused.current || current.saving || current.retained && !current.pending) { schedule(); return; }
      if (current.pending) {
        setPose(choose(askPoses.filter(p => p.gesture !== current.pose.gesture)));
        schedule(); return;
      }
      const g = current.geometry;
      const edges = ["top"];
      // 两侧需要真实留白；底部还要给页脚与屏幕边缘留足空间。
      if (g.left > 48 && g.height > 84) edges.push("left");
      if (g.viewportWidth - g.left - g.width > 48 && g.height > 84) edges.push("right");
      if (g.width >= 480 && g.viewportHeight + g.viewportTop - g.bottom > 62) edges.push("bottom");
      const edge = choose(edges.filter(e => e !== current.pose.edge).length ? edges.filter(e => e !== current.pose.edge) : edges);
      const gesture = choose(edge === "top" ? ["peek", "wave", "sleep", "paws", "stretch", "wink", "curl", "look"].filter(p => p !== current.pose.gesture) : ["peek", "wave", "paws", "look"]);
      setPhase("exit");
      move = setTimeout(() => { setPose({ edge, gesture, at: edge === "bottom" ? choose([.16, .84]) : .2 + Math.random() * .6 }); setPhase("enter"); schedule(); }, 300);
    }, 5000 + Math.random() * 4500); };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(move); };
  }, [quiet, pending?.id]);

  useEffect(() => {
    const g = geometry;
    const fits = pose.edge === "top" || pose.edge === "left" && g.left > 48 || pose.edge === "right" && g.viewportWidth - g.left - g.width > 48 || pose.edge === "bottom" && g.width >= 480 && g.viewportHeight + g.viewportTop - g.bottom > 62;
    if (!fits) { setPose(idlePose); setPhase("enter"); }
  }, [geometry, pose.edge]);

  const decide = async decision => {
    if (locked.current || !pending) return;
    locked.current = true; setSaving(true); setError("");
    try { await onDecide(pending.id, decision); }
    catch (e) { setError(e.message || "刚才没送达，再试一次好吗？"); }
    finally { locked.current = false; setSaving(false); }
  };
  const info = part?.presentation || { title: part?.name || "执行下一步", description: "乐乐想接着处理这一步。", scope: "仅本次操作", fields: [] };
  const choices = info.inquiryPhrases?.filter(p => typeof p === "string" && p) || [];
  const inquiry = choices.length ? choices[hash(part?.id) % choices.length] : "这一步交给我看看，好吗？";
  const asking = Boolean(part && pose.edge === "top" && phase !== "exit");
  const width = Math.min(430, geometry.width), headX = geometry.width * pose.at;
  const left = Math.max(0, Math.min(geometry.width - width, headX - width * .56));
  const tail = Math.max(24, Math.min(width - 24, headX - left));
  const clearance = -(pose.head || -29) + 20;
  const height = Math.min(440, Math.max(130, geometry.top - geometry.viewportTop - clearance - 14));
  const anchorStyle = pose.edge === "left" || pose.edge === "right" ? { top: "50%" } : { left: `calc(${pose.at * 100}% - 29px)` };

  return <>
    <span ref={marker} className="lele-companion-marker" aria-hidden="true"/>
    <span className={`lele-perch-anchor at-${pose.edge} pose-${pose.gesture} phase-${phase} ${asking ? "is-questioning" : ""}`} style={anchorStyle} data-pose={pose.gesture} aria-hidden="true" onAnimationEnd={e => { if (e.target.classList.contains("lele-edge-actor") && phase === "enter") setPhase("rest"); }}>
      <span className="lele-edge-viewport"><span className="lele-edge-actor"><ChatMascot state={asking ? "asking" : state} gesture={pose.gesture}/></span></span>
      <span className="lele-edge-grip"><i/><i/></span>
    </span>
    {asking && <section key={part.id} className={`tool-approval lele-speech ${closing ? "is-closing" : "is-pending"}`} role="region" aria-label="乐乐需要你的确认" aria-labelledby={labelId}
      style={{ width, left, bottom: `calc(100% + ${clearance}px)`, "--speech-tail": `${tail}px`, "--speech-height": `${height}px` }}
      inert={closing ? "" : undefined} onPointerEnter={() => { hover.current = true; }} onPointerLeave={() => { hover.current = false; }}
      onFocusCapture={() => { focused.current = true; }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) focused.current = false; }}>
      <div className="lele-speech-card">
        <header className="lele-speech-heading"><span>乐乐的小询问{approvals.length > 1 ? ` · 还有 ${approvals.length - 1} 件` : ""}</span><h3 id={labelId}>{inquiry}</h3></header>
        <div className="lele-speech-content">
          <div className="lele-operation"><span className="lele-operation-dot"/><strong>{info.title}</strong></div>
          <p className="lele-operation-description">{info.description}</p>
          {info.fields?.length > 0 && <dl className="lele-operation-fields">{info.fields.map(({ label, value }, i) => <div key={i} className={String(value).length > 32 ? "is-wide" : ""}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
          <p className="lele-operation-scope">{info.scope}</p>
          {error && <p className="lele-approval-error" role="alert">{error}</p>}
        </div>
        <footer className="tool-approval-actions"><Button autoInsertSpace={false} disabled={saving || closing} onClick={() => decide("denied")}>拒绝</Button><Button type="primary" disabled={closing} loading={saving} onClick={() => decide("approved")}>仅允许这次</Button></footer>
      </div>
      <svg className="lele-speech-tail" width="44" height="24" viewBox="0 0 44 24" aria-hidden="true"><path d="M0 0C11 0 12 17 22 22C21 11 32 0 44 0"/></svg>
    </section>}
  </>;
}
