import React, { useEffect, useRef, useState } from "react";
// 使用用户提供的像素猫；各部件用 class，多个实例不会产生重复 SVG id。
export default function ChatMascot({ state = "idle", perch = false }) {
  const [gesture, setGesture] = useState("");
  const [position, setPosition] = useState("top");
  const [visible, setVisible] = useState(!document.hidden);
  const previousState = useRef(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const wasBusy = ["thinking", "working", "waiting"].includes(previousState.current);
    previousState.current = state;
    if (perch && wasBusy && state === "idle") { setGesture("hop"); const timer = setTimeout(() => setGesture(""), 1600); return () => clearTimeout(timer); }
  }, [state, perch]);
  useEffect(() => {
    if (!perch) return;
    let timer, moveTimer;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const schedule = () => {
      clearTimeout(timer); clearTimeout(moveTimer);
      setVisible(!document.hidden);
      if (document.hidden || motion.matches) { setGesture(""); return; }
      timer = setTimeout(() => {
        // 先缩回边缘再从新位置探头，不横穿输入内容；间隔始终是 5–10 秒。
        setGesture("hide");
        moveTimer = setTimeout(() => {
          setPosition(old => { const next = ["left", "right", "top", "bottom"].filter(p => p !== old); return next[Math.floor(Math.random() * next.length)]; });
          const poses = ["peek", "wave", "sleep", "paws", "stretch", "wink", "curl", "look"];
          setGesture(["idle", "attentive"].includes(stateRef.current) ? poses[Math.floor(Math.random() * poses.length)] : "peek");
          schedule();
        }, 280);
      }, 5000 + Math.random() * 4500);
    };
    document.addEventListener("visibilitychange", schedule); motion.addEventListener("change", schedule);
    schedule();
    return () => { clearTimeout(timer); clearTimeout(moveTimer); document.removeEventListener("visibilitychange", schedule); motion.removeEventListener("change", schedule); };
  }, [perch]);
  useEffect(() => { if (!["idle", "attentive"].includes(state)) setGesture(""); }, [state]);
  const cat = <span className={`chat-mascot is-${state} ${perch ? "is-perched" : ""} ${gesture ? `gesture-${gesture}` : ""}`} data-motion={visible ? "on" : "off"} aria-hidden="true">
{["thinking", "working", "compressing", "loading"].includes(state) && <span className="lele-sparks"><i/><i/><i/></span>}
<span className="lele-sleep" aria-hidden="true">z<span>Z</span><b>Z</b></span>
<span className="lele-perch-paws"><i/><i/></span>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64" aria-hidden="true" shapeRendering="crispEdges">

  <g className="cat-shadow" fill="#30343b" opacity="0.25">
    <rect x="7" y="29" width="18" height="1" />
    <rect x="9" y="30" width="14" height="1" />
  </g>


  <g className="cat-tail">

    <path fill="#30343b" d="
      M26,22 h2 v1 h-2 z
      M25,23 h1 v2 h-1 z
      M26,24 h1 v1 h-1 z
      M27,24 h1 v3 h-1 z
      M30,22 h1 v3 h-1 z
      M29,25 h1 v2 h-1 z
      M27,27 h2 v1 h-2 z
    " />

    <rect x="27" y="22" width="3" height="2" fill="#85898e" />
    <rect x="26" y="23" width="1" height="1" fill="#85898e" />
    <rect x="27" y="24" width="2" height="3" fill="#85898e" />
    <rect x="28" y="26" width="1" height="1" fill="#dfe2e5" />
  </g>


  <g className="cat-body">

    <path fill="#30343b" d="
      M7,20 h1 v1 h-1 z
      M6,21 h1 v3 h-1 z
      M5,24 h1 v4 h-1 z
      M6,28 h2 v1 h-2 z
      M24,20 h1 v1 h-1 z
      M25,21 h1 v3 h-1 z
      M26,24 h1 v4 h-1 z
      M24,28 h2 v1 h-2 z
    " />

    <rect x="8" y="20" width="3" height="1" fill="#85898e" />
    <rect x="7" y="21" width="4" height="3" fill="#85898e" />
    <rect x="6" y="24" width="3" height="3" fill="#85898e" />
    <rect x="6" y="21" width="1" height="3" fill="#62676e" />
    <rect x="21" y="20" width="3" height="1" fill="#85898e" />
    <rect x="21" y="21" width="4" height="3" fill="#85898e" />
    <rect x="23" y="24" width="3" height="3" fill="#85898e" />
    <rect x="25" y="21" width="1" height="3" fill="#62676e" />

    <rect x="11" y="20" width="10" height="4" fill="#ffffff" />
    <rect x="10" y="23" width="12" height="2" fill="#ffffff" />
    <rect x="9" y="24" width="14" height="2" fill="#ffffff" />

    <rect x="13" y="25" width="6" height="3" fill="#dfe2e5" />
    <rect x="12" y="28" width="8" height="1" fill="#30343b" />
  </g>


  <g className="cat-paws">

    <rect x="9" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="8" y="27" width="1" height="2" fill="#dfe2e5" />
    <rect x="8" y="28" width="5" height="1" fill="#30343b" />
    <rect x="11" y="27" width="1" height="1" fill="#dfe2e5" />

    <rect x="19" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="23" y="27" width="1" height="2" fill="#dfe2e5" />
    <rect x="19" y="28" width="5" height="1" fill="#30343b" />
    <rect x="20" y="27" width="1" height="1" fill="#dfe2e5" />

    <rect x="6" y="27" width="2" height="1" fill="#ffffff" />
    <rect x="24" y="27" width="2" height="1" fill="#ffffff" />
  </g>


  <g className="cat-head">

    <path fill="#30343b" d="
      M7,3 h1 v1 h-1 z
      M6,4 h1 v1 h-1 z
      M5,5 h1 v2 h-1 z
      M4,7 h1 v3 h-1 z
      M3,10 h1 v6 h-1 z
      M4,16 h1 v2 h-1 z
      M5,18 h1 v1 h-1 z
      M6,19 h3 v1 h-3 z
      M24,3 h1 v1 h-1 z
      M25,4 h1 v1 h-1 z
      M26,5 h1 v2 h-1 z
      M27,7 h1 v3 h-1 z
      M28,10 h1 v6 h-1 z
      M27,16 h1 v2 h-1 z
      M26,18 h1 v1 h-1 z
      M23,19 h3 v1 h-3 z
      M11,7 h10 v1 h-10 z
    " />


    <rect x="7" y="5" width="2" height="3" fill="#e5a2a8" />
    <rect x="8" y="5" width="1" height="1" fill="#d97d86" />
    <rect x="23" y="5" width="2" height="3" fill="#e5a2a8" />
    <rect x="23" y="5" width="1" height="1" fill="#d97d86" />



    <rect x="7" y="4" width="1" height="1" fill="#85898e" />
    <rect x="6" y="5" width="1" height="3" fill="#85898e" />
    <rect x="5" y="7" width="1" height="3" fill="#62676e" />
    <rect x="6" y="8" width="5" height="4" fill="#85898e" />
    <rect x="4" y="10" width="2" height="5" fill="#62676e" />
    <rect x="6" y="12" width="2" height="3" fill="#85898e" />
    <rect x="11" y="8" width="3" height="3" fill="#85898e" />
    <rect x="12" y="11" width="1" height="1" fill="#85898e" />

    <rect x="24" y="4" width="1" height="1" fill="#85898e" />
    <rect x="25" y="5" width="1" height="3" fill="#85898e" />
    <rect x="26" y="7" width="1" height="3" fill="#62676e" />
    <rect x="21" y="8" width="5" height="4" fill="#85898e" />
    <rect x="26" y="10" width="2" height="5" fill="#62676e" />
    <rect x="24" y="12" width="2" height="3" fill="#85898e" />
    <rect x="18" y="8" width="3" height="3" fill="#85898e" />
    <rect x="19" y="11" width="1" height="1" fill="#85898e" />


    <rect x="14" y="8" width="4" height="4" fill="#ffffff" />
    <rect x="13" y="12" width="6" height="3" fill="#ffffff" />
    <rect x="8" y="15" width="16" height="2" fill="#ffffff" />
    <rect x="5" y="15" width="3" height="2" fill="#ffffff" />
    <rect x="24" y="15" width="3" height="2" fill="#ffffff" />
    <rect x="5" y="17" width="22" height="1" fill="#ffffff" />
    <rect x="6" y="18" width="20" height="1" fill="#ffffff" />

    <rect x="9" y="19" width="14" height="1" fill="#dfe2e5" />
  </g>


  <g className="cat-face">
    <path className="cat-happy-eyes" fill="none" stroke="#30343b" strokeWidth="1.5" d="M8 14l2-2 2 2m8 0 2-2 2 2"/>
    <path className="cat-sleep-eyes" fill="none" stroke="#30343b" strokeWidth="1.5" d="M8 14h4m8 0h4"/>

    <g className="cat-eyes">

      <path fill="#30343b" d="M8,12 h4 v1 h-4 z M7,13 h1 v1 h-1 z M12,13 h1 v1 h-1 z M8,14 h4 v1 h-4 z" />
      <rect x="8" y="13" width="4" height="1" fill="#526842" />
      <rect x="9" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="10" y="13" width="1" height="1" fill="#1c221e" />


      <path fill="#30343b" d="M20,12 h4 v1 h-4 z M19,13 h1 v1 h-1 z M24,13 h1 v1 h-1 z M20,14 h4 v1 h-4 z" />
      <rect x="20" y="13" width="4" height="1" fill="#526842" />
      <rect x="21" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="22" y="13" width="1" height="1" fill="#1c221e" />
    </g>


    <g className="cat-cheeks" fill="#e6b090" opacity="0.8"><rect x="6" y="15" width="3" height="1"/><rect x="23" y="15" width="3" height="1"/></g>
    <g className="cat-nose-mouth">

      <rect x="15" y="15" width="2" height="1" fill="#ea8a94" />
      <rect x="15" y="16" width="2" height="1" fill="#d97d86" />

      <rect x="14" y="17" width="1" height="1" fill="#85898e" />
      <rect x="17" y="17" width="1" height="1" fill="#85898e" />
    </g>


    <g className="cat-whiskers" fill="#dfe2e5">
      <rect x="1" y="15" width="3" height="1" />
      <rect x="2" y="16" width="2" height="1" />
      <rect x="28" y="15" width="3" height="1" />
      <rect x="28" y="16" width="2" height="1" />
    </g>
  </g>
</svg>

  </span>;
  return perch ? <span className={`lele-perch-anchor at-${position} ${gesture === "hide" ? "is-hiding" : ""}`} aria-hidden="true">{cat}</span> : cat;
}
