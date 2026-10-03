import React, { useEffect, useState } from "react";
export default function ChatMascot({ state = "idle", gesture = "" }) {
  const airborne = ["leap", "transfer", "drop"].includes(gesture);
  const turning = ["chase", "spin"].includes(gesture);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", change); return () => document.removeEventListener("visibilitychange", change); }, []);
  return <span className={`chat-mascot is-${state} ${gesture ? `gesture-${gesture}` : ""}`} data-motion={visible ? "on" : "off"} aria-hidden="true">
{["thinking", "working", "compressing", "loading"].includes(state) && <span className="lele-sparks"><i/><i/><i/></span>}
<span className="lele-sleep" aria-hidden="true">z<span>Z</span><b>Z</b></span>
{state === "asking" && <span className="lele-question-mark">?</span>}
{["toy", "proud"].includes(gesture) && <span className="lele-heart" aria-hidden="true">♥</span>}
{gesture === "toy" && <span className="lele-toy" aria-hidden="true"/>}
{gesture.startsWith("capsule-") && <CapsuleAccessory kind={gesture.slice(8)}/>}
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


  {airborne && <g className="cat-hindlegs" fill="#85898e" stroke="#62676e" strokeWidth=".6">
    <g className="cat-hind-left"><path d="M7 22h4v5H7z"/><path fill="#fff" d="M6 26h5v3H6z"/></g>
    <g className="cat-hind-right"><path d="M21 22h4v5h-4z"/><path fill="#fff" d="M21 26h5v3h-5z"/></g>
  </g>}
  <g className="cat-cranium">
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
  {turning && <g className="cat-head-back">
    {/* 转到背面时沿用原头型和灰白毛区，脸留在前面，不翻到后脑勺。 */}
    <path fill="#62676e" d="M7 3h1v4h16V3h1v2h2v5h2v6h-1v2h-2v2H6v-2H4v-2H3v-6h2V5h2z"/>
    <path fill="#85898e" d="M7 5h1v4h16V5h1v5h2v6h-2v2H7v-2H5v-6h2z"/>
    <path fill="#dfe2e5" d="M12 8h8v4h-1v3h4v3H9v-3h4v-3h-1z"/>
    <path fill="#fff" d="M9 17h14v2H9z"/>
  </g>}
  </g>
  <g className="cat-paws">

    <g className="cat-paw-left">
    {(airborne || ["feet-kick", "foot-dangle"].includes(gesture)) && <g className="cat-leg-reach"><path fill="#62676e" d="M9 16h4v10H9z M8 25h1v3H8z M9 28h4v1H9z M13 25h1v3h-1z"/><path fill="#85898e" d="M10 16h3v8h-3z"/><path fill="#dfe2e5" d="M10 23h3v3h-3z"/></g>}
    <rect x="9" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="8" y="27" width="1" height="2" fill="#dfe2e5" />
    <rect className="cat-paw-ground" x="8" y="28" width="5" height="1" fill="#30343b" />
    <rect x="11" y="27" width="1" height="1" fill="#dfe2e5" />

    </g>
    <g className="cat-paw-right">
    {(airborne || ["feet-kick", "foot-dangle", "side-paw", "side-tap"].includes(gesture)) && <g className="cat-leg-reach"><path fill="#62676e" d="M19 16h4v10h-4z M18 25h1v3h-1z M19 28h4v1h-4z M23 25h1v3h-1z"/><path fill="#85898e" d="M19 16h3v8h-3z"/><path fill="#dfe2e5" d="M19 23h3v3h-3z"/></g>}
    <rect x="19" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="23" y="27" width="1" height="2" fill="#dfe2e5" />
    <rect className="cat-paw-ground" x="19" y="28" width="5" height="1" fill="#30343b" />
    <rect x="20" y="27" width="1" height="1" fill="#dfe2e5" />

    </g>
    <rect x="6" y="27" width="2" height="1" fill="#ffffff" />
    <rect x="24" y="27" width="2" height="1" fill="#ffffff" />
  </g>


</svg>

  </span>;
}

// 工作道具独立于乐乐原来的像素身体；完成后的姿势由各方法分别定格。
function CapsuleAccessory({ kind }) {
  const shapes = {
    think:<path d="M4 3v3M1 5h6M7 0v2M6 1h2"/>,
    wave:<path d="M1 2q4 0 4 4M2 0q5 1 5 5"/>,
    notebook:<><path d="M1 1h6v7H1zM3 1v7M4 3h2M4 5h2"/></>,
    inspect:<><circle cx="3" cy="3" r="2.5"/><path d="m5 5 3 3M3 2v2"/></>,
    search:<><circle cx="3" cy="3" r="2.5"/><path d="m5 5 3 3M2 3h2M3 2v2"/></>,
    key:<><circle cx="2.5" cy="2.5" r="2"/><path d="m4 4 4 4M6 6l1-1"/></>,
    chart:<path d="M1 1v7h7M3 6V4M5 6V2M7 6V1"/>,
    coin:<><circle cx="4" cy="4" r="3.5"/><path d="M4 2v4"/></>,
    read:<path d="M4 2Q2 0 0 1v6q2-1 4 1 2-2 4-1V1Q6 0 4 2v6"/>,
    type:<path d="M1 0h6v5H1zM0 7h8M2 7v1M6 7v1"/>,
    reach:<path d="M4 0v8M0 4h8M1 1l6 6M1 7l6-6"/>,
    list:<path d="M0 1h1M3 1h5M0 4h1M3 4h5M0 7h1M3 7h5"/>,
    pack:<path d="m0 2 4-2 4 2v5L4 9 0 7V2l4 2 4-2M4 4v5"/>,
  };
  return <svg className={`capsule-accessory accessory-${kind}`} viewBox="-1 -1 11 11" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">{shapes[kind] || shapes.wave}</svg>;
}
