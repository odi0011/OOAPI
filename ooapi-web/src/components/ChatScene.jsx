import { Button as ActionButton } from "./arc/index";
import React, { useEffect, useRef, useState } from "react";
import ChatMascot from "./ChatMascot";
import "./chat-scene.css";

// 借鉴 Aceternity 的流线、微粒与逐段入场，用现有 SVG/CSS 实现并跟随站点主题。
export default function ChatScene({ loading = false, onStart }) {
  const [greeted, setGreeted] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const timer = useRef(null);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => { document.removeEventListener("visibilitychange", change); clearTimeout(timer.current); };
  }, []);
  const greet = () => {
    setGreeted(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setGreeted(false), 1800);
    onStart?.();
  };
  return <section className={`lele-scene ${loading ? "is-loading" : "is-welcome"} ${greeted ? "is-greeted" : ""}`} data-motion={visible ? "on" : "off"} aria-label={loading ? "正在打开会话" : "新对话"}>
    <div className="lele-scene-art" aria-hidden="true">
      <div className="lele-scene-glow" />
      <svg className="lele-scene-lines" viewBox="0 0 800 400" fill="none">
        {[0, 1, 2, 3].map(i => <path key={i} pathLength="100" d={`M -30 ${110 + i * 22} C 150 ${-10 + i * 28}, 190 ${390 - i * 12}, 400 ${260 - i * 15} S 630 ${-40 + i * 35}, 830 ${150 + i * 28}`} style={{ "--line-index": i }} />)}
      </svg>
      <div className="lele-scene-dust">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ "--i": i, left: `${14 + (i * 29) % 74}%`, top: `${18 + (i * 19) % 66}%` }} />)}</div>
    </div>
    <div className="lele-scene-content">
      <div className="lele-scene-stage">
        <span className="lele-scene-orbit" aria-hidden="true" />
        {loading ? <span className="lele-scene-character"><ChatMascot state="loading" /></span> : <ActionButton type="text" className="lele-scene-character" htmlType="button" aria-label="和乐乐打个招呼" onClick={greet}><ChatMascot state={greeted ? "success" : "idle"} /></ActionButton>}
        {!loading && <span className="lele-scene-hello" aria-live="polite">{greeted ? "在呢～" : ""}</span>}
        {loading && <span className="lele-scene-trail" aria-hidden="true"><i/><i/><i/></span>}
      </div>
      {loading ? <p className="lele-scene-loading" role="status">乐乐正在翻开对话<span aria-hidden="true">…</span></p> : <>
        <span className="lele-scene-eyebrow">一段新的小冒险</span>
        <h2>你好呀，<span>我是乐乐</span></h2>
        <p className="lele-scene-caption">把想法放在这里，我们一起完成。</p>
      </>}
    </div>
  </section>;
}
