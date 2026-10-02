import React, { useEffect, useRef, useState } from "react";
// 使用用户提供的像素猫；各部件用 class，多个实例不会产生重复 SVG id。
export default function ChatMascot({ state = "idle", perch = false }) {
  const [gesture, setGesture] = useState("");
  const previousState = useRef(state);
  useEffect(() => {
    const wasBusy = ["thinking", "working", "waiting"].includes(previousState.current);
    previousState.current = state;
    if (perch && wasBusy && state === "idle") { setGesture("hop"); const timer = setTimeout(() => setGesture(""), 1600); return () => clearTimeout(timer); }
  }, [state, perch]);
  useEffect(() => {
    if (!perch || state !== "idle" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer;
    const schedule = () => { timer = setTimeout(() => {
      if (!document.hidden) setGesture(["peek", "stretch", "hop"][Math.floor(Math.random() * 3)]);
      timer = setTimeout(() => { setGesture(""); schedule(); }, 1600);
    }, 12000 + Math.random() * 14000); };
    schedule(); return () => clearTimeout(timer);
  }, [perch, state]);
  return <span className={`chat-mascot is-${state} ${perch ? "is-perched" : ""} ${gesture ? `gesture-${gesture}` : ""}`} aria-hidden="true">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64" aria-hidden="true" shapeRendering="crispEdges">

  <g className="cat-shadow" fill="#28201c" opacity="0.25">
    <rect x="7" y="29" width="18" height="1" />
    <rect x="9" y="30" width="14" height="1" />
  </g>


  <g className="cat-tail">

    <path fill="#28201c" d="
      M26,22 h2 v1 h-2 z
      M25,23 h1 v2 h-1 z
      M26,24 h1 v1 h-1 z
      M27,24 h1 v3 h-1 z
      M30,22 h1 v3 h-1 z
      M29,25 h1 v2 h-1 z
      M27,27 h2 v1 h-2 z
    " />

    <rect x="27" y="22" width="3" height="2" fill="#8d7d74" />
    <rect x="26" y="23" width="1" height="1" fill="#8d7d74" />
    <rect x="27" y="24" width="2" height="3" fill="#8d7d74" />
    <rect x="28" y="26" width="1" height="1" fill="#ded9d5" />
  </g>


  <g className="cat-body">

    <path fill="#28201c" d="
      M7,20 h1 v1 h-1 z
      M6,21 h1 v3 h-1 z
      M5,24 h1 v4 h-1 z
      M6,28 h2 v1 h-2 z
      M24,20 h1 v1 h-1 z
      M25,21 h1 v3 h-1 z
      M26,24 h1 v4 h-1 z
      M24,28 h2 v1 h-2 z
    " />

    <rect x="8" y="20" width="3" height="1" fill="#8d7d74" />
    <rect x="7" y="21" width="4" height="3" fill="#8d7d74" />
    <rect x="6" y="24" width="3" height="3" fill="#8d7d74" />
    <rect x="6" y="21" width="1" height="3" fill="#6b5c54" />
    <rect x="21" y="20" width="3" height="1" fill="#8d7d74" />
    <rect x="21" y="21" width="4" height="3" fill="#8d7d74" />
    <rect x="23" y="24" width="3" height="3" fill="#8d7d74" />
    <rect x="25" y="21" width="1" height="3" fill="#6b5c54" />

    <rect x="11" y="20" width="10" height="4" fill="#ffffff" />
    <rect x="10" y="23" width="12" height="2" fill="#ffffff" />
    <rect x="9" y="24" width="14" height="2" fill="#ffffff" />

    <rect x="13" y="25" width="6" height="3" fill="#ded9d5" />
    <rect x="12" y="28" width="8" height="1" fill="#28201c" />
  </g>


  <g className="cat-paws">

    <rect x="9" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="8" y="27" width="1" height="2" fill="#ded9d5" />
    <rect x="8" y="28" width="5" height="1" fill="#28201c" />
    <rect x="11" y="27" width="1" height="1" fill="#ded9d5" />

    <rect x="19" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="23" y="27" width="1" height="2" fill="#ded9d5" />
    <rect x="19" y="28" width="5" height="1" fill="#28201c" />
    <rect x="20" y="27" width="1" height="1" fill="#ded9d5" />

    <rect x="6" y="27" width="2" height="1" fill="#ffffff" />
    <rect x="24" y="27" width="2" height="1" fill="#ffffff" />
  </g>


  <g className="cat-head">

    <path fill="#28201c" d="
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



    <rect x="7" y="4" width="1" height="1" fill="#8d7d74" />
    <rect x="6" y="5" width="1" height="3" fill="#8d7d74" />
    <rect x="5" y="7" width="1" height="3" fill="#6b5c54" />
    <rect x="6" y="8" width="5" height="4" fill="#8d7d74" />
    <rect x="4" y="10" width="2" height="5" fill="#6b5c54" />
    <rect x="6" y="12" width="2" height="3" fill="#8d7d74" />
    <rect x="11" y="8" width="3" height="3" fill="#8d7d74" />
    <rect x="12" y="11" width="1" height="1" fill="#8d7d74" />

    <rect x="24" y="4" width="1" height="1" fill="#8d7d74" />
    <rect x="25" y="5" width="1" height="3" fill="#8d7d74" />
    <rect x="26" y="7" width="1" height="3" fill="#6b5c54" />
    <rect x="21" y="8" width="5" height="4" fill="#8d7d74" />
    <rect x="26" y="10" width="2" height="5" fill="#6b5c54" />
    <rect x="24" y="12" width="2" height="3" fill="#8d7d74" />
    <rect x="18" y="8" width="3" height="3" fill="#8d7d74" />
    <rect x="19" y="11" width="1" height="1" fill="#8d7d74" />


    <rect x="14" y="8" width="4" height="4" fill="#ffffff" />
    <rect x="13" y="12" width="6" height="3" fill="#ffffff" />
    <rect x="8" y="15" width="16" height="2" fill="#ffffff" />
    <rect x="5" y="15" width="3" height="2" fill="#ffffff" />
    <rect x="24" y="15" width="3" height="2" fill="#ffffff" />
    <rect x="5" y="17" width="22" height="1" fill="#ffffff" />
    <rect x="6" y="18" width="20" height="1" fill="#ffffff" />

    <rect x="9" y="19" width="14" height="1" fill="#ded9d5" />
  </g>


  <g className="cat-face">

    <g className="cat-eyes">

      <path fill="#28201c" d="M8,12 h4 v1 h-4 z M7,13 h1 v1 h-1 z M12,13 h1 v1 h-1 z M8,14 h4 v1 h-4 z" />
      <rect x="8" y="13" width="4" height="1" fill="#526842" />
      <rect x="9" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="10" y="13" width="1" height="1" fill="#1c221e" />


      <path fill="#28201c" d="M20,12 h4 v1 h-4 z M19,13 h1 v1 h-1 z M24,13 h1 v1 h-1 z M20,14 h4 v1 h-4 z" />
      <rect x="20" y="13" width="4" height="1" fill="#526842" />
      <rect x="21" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="22" y="13" width="1" height="1" fill="#1c221e" />
    </g>


    <g className="cat-nose-mouth">

      <rect x="15" y="15" width="2" height="1" fill="#ea8a94" />
      <rect x="15" y="16" width="2" height="1" fill="#d97d86" />

      <rect x="14" y="17" width="1" height="1" fill="#8d7d74" />
      <rect x="17" y="17" width="1" height="1" fill="#8d7d74" />
    </g>


    <g className="cat-whiskers" fill="#ded9d5">
      <rect x="1" y="15" width="3" height="1" />
      <rect x="2" y="16" width="2" height="1" />
      <rect x="28" y="15" width="3" height="1" />
      <rect x="28" y="16" width="2" height="1" />
    </g>
  </g>
</svg>

  </span>;
}
