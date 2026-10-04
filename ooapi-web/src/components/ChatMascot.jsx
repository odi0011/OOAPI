import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./chat-mascot.css";

// 业务状态与身体动作分开描述，样式不再靠互相覆盖来猜测当前表情。
const AIRBORNE_GESTURES = new Set(["leap", "transfer", "drop"]);
const TURNING_GESTURES = new Set(["chase", "spin"]);
const LEFT_REACH_GESTURES = new Set(["feet-kick", "foot-dangle", "pawtap"]);
const RIGHT_REACH_GESTURES = new Set(["feet-kick", "foot-dangle", "side-paw", "side-tap"]);
const HEART_GESTURES = new Set(["toy", "proud"]);
const DROWSY_GESTURES = new Set(["loaf", "drowsy"]);
const SLEEP_GESTURES = new Set(["sleep", "curl", "zzz"]);

const STATE_META = {
  idle: { expression: "neutral", action: "rest" },
  attentive: { expression: "attentive", action: "notice" },
  loading: { expression: "focused", action: "wait" },
  thinking: { expression: "focused", action: "think" },
  working: { expression: "focused", action: "work" },
  compressing: { expression: "focused", action: "compress" },
  waiting: { expression: "attentive", action: "wait" },
  asking: { expression: "asking", action: "ask" },
  success: { expression: "happy", action: "celebrate" },
  sad: { expression: "sad", action: "comfort" },
};

const GESTURE_EXPRESSIONS = {
  annoyed: "sad",
  curl: "sleepy",
  cute: "happy",
  drape: "drowsy",
  drowsy: "drowsy",
  loaf: "drowsy",
  proud: "happy",
  sleep: "sleepy",
  wink: "playful",
  yawn: "sleepy",
  zzz: "sleepy",
};

function token(value, fallback = "") {
  const clean = typeof value === "string" ? value.trim().toLowerCase() : "";
  return clean.replace(/[^a-z0-9_-]/g, "") || fallback;
}

function useMotionState() {
  const [motion, setMotion] = useState(() => typeof document === "undefined" || !document.hidden ? "on" : "off");
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(document.hidden || media.matches ? "off" : "on");
    sync();
    document.addEventListener("visibilitychange", sync);
    media.addEventListener("change", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      media.removeEventListener("change", sync);
    };
  }, []);
  return motion;
}

const BLEND_PARTS = ".cat-cranium,.cat-body,.cat-tail,.cat-paw-left,.cat-paw-right,.cat-paws";

function usePoseBlend(ref, state, gesture, motion) {
  const previous = useRef(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const signature = `${state}:${gesture}`;
    const rig = gesture === "drape" ? "drape" : "sit";
    const parts = root ? [...root.querySelectorAll(BLEND_PARTS)] : [];
    const blends = [];
    const canBlend = motion === "on" && !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (canBlend && previous.current?.rig === rig && previous.current.signature !== signature) {
      for (const part of parts) {
        const before = previous.current.transforms.get(part);
        const after = getComputedStyle(part).transform;
        if (!before || before === after || !part.animate || getComputedStyle(part).display === "none") continue;
        // 短暂固定底层动作的当前帧，过渡结束原位续播，避免结束时跳到已前进的动画帧。
        // 正脸/后脑勺与转头共用时钟，不能让显隐先跑到背面、头部还在过渡。
        const faceTimeline = part.classList.contains("cat-cranium")
          ? [...root.querySelectorAll(".cat-face,.cat-head-back")].flatMap(face => face.getAnimations()) : [];
        const paused = [...part.getAnimations(), ...faceTimeline].filter(animation => animation.playState === "running");
        paused.forEach(animation => animation.pause());
        const animation = part.animate([{ transform: before }, { transform: after }], {
          duration: 380,
          easing: "cubic-bezier(.22,.75,.25,1)",
        });
        const finish = () => {
          animation.onfinish = null;
          animation.cancel();
          paused.forEach(active => { if (active.playState === "paused") active.play(); });
        };
        animation.onfinish = finish;
        blends.push(finish);
      }
    }
    return () => {
      // 新姿态先从屏幕上的实际部位位置接续；反复悬停也不会回到动画首帧。
      const currentParts = ref.current ? [...ref.current.querySelectorAll(BLEND_PARTS)] : [];
      previous.current = { signature, rig, transforms: new Map(currentParts.map(part => [part, getComputedStyle(part).transform])) };
      blends.forEach(finish => finish());
    };
  }, [ref, state, gesture, motion]);
}

function PoseBlend({ mascot, state, gesture, motion }) {
  // 放在父 span 的第一个子节点：React 先清理子布局效果、再更新父 class，才能采到旧姿态。
  usePoseBlend(mascot, state, gesture, motion);
  return null;
}

export default function ChatMascot({ state = "idle", gesture = "" }) {
  const stateToken = token(state, "idle");
  const gestureToken = token(gesture);
  const stateMeta = STATE_META[stateToken] || STATE_META.idle;
  const expression = stateToken !== "idle" ? stateMeta.expression : GESTURE_EXPRESSIONS[gestureToken] || stateMeta.expression;
  const airborne = AIRBORNE_GESTURES.has(gestureToken);
  const turning = TURNING_GESTURES.has(gestureToken);
  const draped = gestureToken === "drape";
  const sleeping = SLEEP_GESTURES.has(gestureToken);
  const showDrowseEyes = DROWSY_GESTURES.has(gestureToken);
  const showHeart = HEART_GESTURES.has(gestureToken);
  const capsuleKind = gestureToken.startsWith("capsule-") ? gestureToken.slice(8) : "";
  const motion = useMotionState();
  const mascot = useRef(null);
  const mascotClasses = [
    "chat-mascot",
    `is-${stateToken}`,
    `state-${stateToken}`,
    gestureToken && `gesture-${gestureToken}`,
    `expression-${expression}`,
    draped && "is-draped",
    airborne && "is-airborne",
    turning && "is-turning",
    sleeping && "is-sleeping",
    showDrowseEyes && "is-drowsy",
  ].filter(Boolean).join(" ");

  return <span ref={mascot} className={mascotClasses}
    data-state={stateToken}
    data-gesture={gestureToken || undefined}
    data-expression={expression}
    data-action={stateMeta.action}
    data-motion={motion}
    aria-hidden="true">
<PoseBlend mascot={mascot} state={stateToken} gesture={gestureToken} motion={motion}/>
<span className="lele-sparks" data-effect="busy"><i/><i/><i/></span>
<span className="lele-sleep" aria-hidden="true">z<span>Z</span><b>Z</b></span>
<span className="lele-question-mark" data-effect="question">?</span>
{showHeart && <span className="lele-heart" data-effect="heart" aria-hidden="true">♥</span>}
{gestureToken === "toy" && <span className="lele-toy" data-effect="toy" aria-hidden="true"/>}
{capsuleKind && <CapsuleAccessory kind={capsuleKind}/>}
<svg xmlns="http://www.w3.org/2000/svg" viewBox={draped ? "0 0 64 54" : "0 0 32 32"} width={draped ? "112" : "64"} height={draped ? "94.5" : "64"} aria-hidden="true" shapeRendering="crispEdges">

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
  {draped && <DrapedBody/>}
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
    <path className="cat-drowse-eyes" fill="none" stroke="#30343b" strokeWidth="1.4" strokeLinecap="round" d="M8 14c1.1.7 2.6.7 3.8 0m8.4 0c1.1.7 2.6.7 3.8 0"/>

    <g className="cat-eyes">

      <g className="cat-eye-left">
      <path fill="#30343b" d="M8,12 h4 v1 h-4 z M7,13 h1 v1 h-1 z M12,13 h1 v1 h-1 z M8,14 h4 v1 h-4 z" />
      <rect x="8" y="13" width="4" height="1" fill="#526842" />
      <g className="cat-pupils cat-pupil-left">
      <rect x="9" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="10" y="13" width="1" height="1" fill="#1c221e" />
      </g>
      </g>


      <g className="cat-eye-right">
      <path fill="#30343b" d="M20,12 h4 v1 h-4 z M19,13 h1 v1 h-1 z M24,13 h1 v1 h-1 z M20,14 h4 v1 h-4 z" />
      <rect x="20" y="13" width="4" height="1" fill="#526842" />
      <g className="cat-pupils cat-pupil-right">
      <rect x="21" y="13" width="1" height="1" fill="#ffffff" />
      <rect x="22" y="13" width="1" height="1" fill="#1c221e" />
      </g>
      </g>
    </g>


    <g className="cat-cheeks" fill="#e6b090" opacity="0.8"><rect x="6" y="15" width="3" height="1"/><rect x="23" y="15" width="3" height="1"/></g>
    <g className="cat-nose-mouth">

      <rect x="15" y="15" width="2" height="1" fill="#ea8a94" />
      <rect x="15" y="16" width="2" height="1" fill="#d97d86" />

      <rect x="14" y="17" width="1" height="1" fill="#85898e" />
      <rect x="17" y="17" width="1" height="1" fill="#85898e" />
      {gestureToken === "yawn" && <g className="cat-yawn-mouth"><rect x="15" y="16.5" width="2" height="2" rx="1" fill="#d97d86" /><rect x="15.3" y="17" width="1.4" height="1.2" rx="0.5" fill="#f4a0a8" /></g>}
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
    {(airborne || LEFT_REACH_GESTURES.has(gestureToken)) && <g className="cat-leg-reach"><path fill="#62676e" d="M9 16h4v10H9z M8 25h1v3H8z M9 28h4v1H9z M13 25h1v3h-1z"/><path fill="#85898e" d="M10 16h3v8h-3z"/><path fill="#dfe2e5" d="M10 23h3v3h-3z"/></g>}
    <rect x="9" y="25" width="4" height="3" fill="#ffffff" />
    <rect x="8" y="27" width="1" height="2" fill="#dfe2e5" />
    <rect className="cat-paw-ground" x="8" y="28" width="5" height="1" fill="#30343b" />
    <rect x="11" y="27" width="1" height="1" fill="#dfe2e5" />

    </g>
    <g className="cat-paw-right">
    {(airborne || RIGHT_REACH_GESTURES.has(gestureToken)) && <g className="cat-leg-reach"><path fill="#62676e" d="M19 16h4v10h-4z M18 25h1v3h-1z M19 28h4v1h-4z M23 25h1v3h-1z"/><path fill="#85898e" d="M19 16h3v8h-3z"/><path fill="#dfe2e5" d="M19 23h3v3h-3z"/></g>}
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

// 同一只乐乐的侧卧肢体：沿用灰白毛区和原脸，肩、肘、髋、尾根独立活动。
// y=28 是输入框边沿；只有放松的小腿和尾端可以越过这条边。
function DrapedBody() {
  return <g className="cat-lounge-rig">
    <g className="lounge-tail" data-drape-contact="tail">
      <path fill="none" stroke="#62676e" strokeWidth="3.2" strokeLinecap="round" d="M47 22C53 23 53.5 28 52 32S53 37 50 40"/>
      <path fill="none" stroke="#85898e" strokeWidth="1.8" strokeLinecap="round" d="M47 22C52 23 52.5 28 51.5 32S52 36 50 39.5"/>
    </g>
    <g className="lounge-body">
      <path fill="#62676e" d="M21 20h2v-2h4v-2h6v-1h8v1h5v2h3v3h2v4h-2v2h-5v1H25v-1h-4v-2h-2v-3h2z"/>
      <path fill="#85898e" d="M22 20h2v-2h4v-2h6v-1h7v1h4v2h3v3h2v3h-2v2h-5v1H26v-1h-4v-2h-1v-2h1z"/>
      <path fill="#a2a6aa" d="M29 16h5v-1h6v1h5v1H29z M45 18h2v2h-2z"/>
      <path fill="#62676e" d="M40 20h6v1h-2v2h-2v2h-2v-3h1z"/>
      <path fill="#dfe2e5" d="M23 24h5v1h5v1h8v1H26v-1h-3v-1h1z"/>
      <g className="lounge-belly-spot"><rect x="37" y="25" width="3" height="2" rx="1" fill="#dfe2e5"/></g>
    </g>
    <g className="lounge-folded-paw">
      <path fill="#62676e" d="M24 23h4v2h4v3h-8v-1h-2v-3h2z"/>
      <path fill="#85898e" d="M25 24h4v1h2v2h-6v-1h-1v-1h1z"/>
      <path fill="#dfe2e5" d="M24 26h7v2h-7z"/>
      <path fill="#fff" d="M25 26h4v1h-4z"/>
      <rect x="26" y="25" width="3" height="2" rx="1" fill="#ffffff"/>
    </g>
    {/* 照片中垂下的是近侧前腿和近侧后腿，分别从肩、髋伸出；远侧后腿被侧卧躯干遮住。 */}
    <g className="lounge-hanging-leg lounge-hind-leg" style={{"--joint-x":"44px","--joint-y":"23px"}} data-drape-contact="hind-leg">
      <path fill="#62676e" d="M41 21h7v3h1v4h-2v5h-5v-4h-2v-5h1z"/>
      <path fill="#85898e" d="M42 22h5v3h1v2h-2v5h-3v-4h-2v-3h1z"/>
      <path fill="#a2a6aa" d="M42 23h2v4h-2z"/>
      <g className="lounge-hock">
        <path fill="#62676e" d="M42 30h5v5h-1v5h-1v2h-4v-1h-1v-4h1v-5h1z"/>
        <path fill="#85898e" d="M43 31h3v3h-1v5h-3v-2h-1v-3h1v-2h1z"/>
        <path fill="#dfe2e5" d="M41 39h4v3h-4z"/>
        <path fill="#fff" d="M42 39h2v2h-2z"/>
      </g>
    </g>
    <g className="lounge-hanging-leg lounge-front-leg" style={{"--joint-x":"25px","--joint-y":"24px"}} data-drape-contact="front-leg">
      <path fill="#62676e" d="M22 22h6v5h-1v4h-5v-3h-1v-4h1z"/>
      <path fill="#85898e" d="M23 22h4v5h-1v3h-3v-3h-1v-3h1z"/>
      <g className="lounge-wrist">
        <path fill="#62676e" d="M22 29h5v5h-1v5h-1v1h-4v-1h-1v-3h1v-7z"/>
        <path fill="#85898e" d="M23 29h3v5h-1v5h-3v-3h1z"/>
        <path fill="#dfe2e5" d="M21 38h4v3h-1v1h-3z"/>
        <path fill="#fff" d="M22 39h2v2h-2z"/>
      </g>
    </g>
  </g>;
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
