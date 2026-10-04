import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "antd";
import ChatMascot from "./ChatMascot";
import "./composer-companion.css";
import "./lele-locomotion.css";
import "./lele-motion.css";

const hash = value => Array.from(String(value || "lele")).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
const choose = values => values[Math.floor(Math.random() * values.length)];
const askPoses = [
  { edge: "top", at: .18, gesture: "curious", head: -31 },
  { edge: "top", at: .4, gesture: "listen", head: -27 },
  { edge: "top", at: .64, gesture: "invite", head: -32 },
  { edge: "top", at: .82, gesture: "shy", head: -23 },
];
const idlePose = { edge: "top", at: .72, gesture: "peek", head: -24 };
// 下沿只露尾巴/后腿，侧沿只探头/伸爪；不能把上沿的整只猫旋转后复用。
const sideGestures = ["side-peek", "side-scout", "side-paw", "side-tap"];
const bottomGestures = ["tail-slip", "tail-tip", "feet-kick", "foot-dangle"];
const HOVER_ARM_MS = 140;
const HOVER_RELEASE_MS = 260;
const EXIT_MS = 360;
// React 在指针离开浏览器窗口时可能传入 Window；contains 只接受 DOM 节点。
const staysInside = event => event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);

// 同一处边线同时约束猫、爪子、气泡尾巴。身体在裁剪层外侧，爪子独立握住边线。
// 不观察动画自身的宽高，避免位置测量与动画互相触发。
export default function ComposerCompanion({ state, approvals = [], onDecide, menuOpen = false, inputValue = "", inputRef }) {
  const pending = approvals[0] || null;
  const [retained, setRetained] = useState(pending);
  const [pose, setPose] = useState(() => pending ? askPoses[hash(pending.id) % askPoses.length] : idlePose);
  const [phase, setPhase] = useState("enter");
  const [geometry, setGeometry] = useState({ width: 320, top: 700, height: 100, left: 40, bottom: 800, viewportWidth: 1440, viewportHeight: 1000, viewportTop: 0 });
  const [quiet, setQuiet] = useState(() => document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const marker = useRef(null), locked = useRef(false), hover = useRef(false), focused = useRef(false);
  const menuWasOpen = useRef(false), reactionTimer = useRef(null), reactionMove = useRef(null), reactionPhase = useRef(null);
  const hoverArmTimer = useRef(null), hoverReleaseTimer = useRef(null), hoverInside = useRef(false), hoverSession = useRef(0);
  const reactionSequence = useRef(0), deferredReaction = useRef(null);
  const motionToken = useRef(null), completedMotion = useRef(null);
  const flightCapture = useRef(null);
  const wasSuspended = useRef(quiet || pageHidden);
  const scheduleTimer = useRef(null), scheduleMove = useRef(null);
  const travelId = useRef(0);
  if (!motionToken.current || motionToken.current.phase !== phase || motionToken.current.gesture !== pose.gesture || motionToken.current.motion !== pose.motion || motionToken.current.flight !== pose.flight) {
    motionToken.current = { phase, gesture: pose.gesture, motion: pose.motion, flight: pose.flight };
  }
  const live = useRef();
  live.current = { pose, phase, geometry, pending, retained, saving, menuOpen, hovered, state, quiet, pageHidden };
  const labelId = useId();
  const part = pending || retained, closing = Boolean(part && !pending);

  const captureFlight = actor => {
    const parts = new Map();
    for (const node of [actor, ...actor.querySelectorAll(".cat-cranium,.cat-body,.cat-paw-left,.cat-paw-right,.cat-hind-left,.cat-hind-right,.cat-tail,.cat-shadow,.cat-eyes")]) {
      const style = getComputedStyle(node);
      parts.set(node, { transform: style.transform, translate: style.translate, rotate: style.rotate, scale: style.scale, opacity: style.opacity, transformOrigin: style.transformOrigin });
    }
    flightCapture.current = { actor, parts };
  };
  useLayoutEffect(() => {
    const capture = flightCapture.current;
    if (!pose.flight || !capture) return;
    flightCapture.current = null;
    if (quiet || !capture.actor.isConnected) return;
    // 同一身体接新路线：先把新关键帧的起点接到当前肢体姿态，再重新计时。
    // 不靠 key 重挂载，快速切菜单时头、脚和尾巴都沿用上一帧的重心。
    for (const animation of capture.actor.getAnimations({ subtree: true })) {
      if (!(animation instanceof CSSAnimation) || !/^lele-(jump|fall|reach|kick-off|air|startled|scramble|splay)/.test(animation.animationName)) continue;
      const node = animation.effect.target, previous = capture.parts.get(node);
      if (!previous) continue;
      const frames = animation.effect.getKeyframes();
      if (node === capture.actor) {
        const old = new DOMMatrix(previous.transform === "none" ? undefined : previous.transform);
        const [ox, oy] = getComputedStyle(node).transformOrigin.split(" ").map(parseFloat);
        const corners = [[0, 0], [node.offsetWidth, 0], [0, node.offsetHeight], [node.offsetWidth, node.offsetHeight]].map(([x, y]) => ({ x: ox + old.a * (x - ox) + old.c * (y - oy), y: oy + old.b * (x - ox) + old.d * (y - oy) }));
        const x = (pose.travelX || 0) - Math.min(...corners.map(p => p.x));
        const y = (pose.travelY || 0) - Math.min(...corners.map(p => p.y));
        frames[0] = { ...frames[0], transform: `matrix(${old.a},${old.b},${old.c},${old.d},${x},${y})`, translate: "none", rotate: "none", scale: "none" };
      } else frames[0] = { ...frames[0], ...previous };
      animation.effect.setKeyframes(frames);
      animation.currentTime = 0;
      animation.play();
    }
  }, [pose.flight, quiet]);

  const completeMotion = token => {
    if (token !== motionToken.current || completedMotion.current === token) return;
    const current = live.current;
    if (current.quiet || current.pageHidden) return;
    completedMotion.current = token;
    if (current.phase === "enter") {
      const fragment = ["left", "right", "bottom"].includes(current.pose.edge);
      setPhase(fragment ? "hidden" : "rest");
      if (!fragment) {
        const deferred = deferredReaction.current;
        deferredReaction.current = null;
        deferred?.();
      }
    }
  };

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
    const update = () => { setPageHidden(document.hidden); setQuiet(document.hidden || media.matches); };
    document.addEventListener("visibilitychange", update); media.addEventListener("change", update);
    return () => { document.removeEventListener("visibilitychange", update); media.removeEventListener("change", update); };
  }, []);

  // 所有延时都集中清理，避免切页/隐藏标签后旧回调把新动作拉回去。
  useEffect(() => () => {
    clearTimeout(hoverArmTimer.current);
    clearTimeout(hoverReleaseTimer.current);
    clearTimeout(reactionTimer.current);
    clearTimeout(reactionMove.current);
    clearTimeout(scheduleTimer.current);
    clearTimeout(scheduleMove.current);
  }, []);

  useEffect(() => {
    const resume = wasSuspended.current;
    wasSuspended.current = quiet || pageHidden;
    if (quiet || pageHidden) {
      clearTimeout(hoverArmTimer.current);
      clearTimeout(hoverReleaseTimer.current);
      clearTimeout(reactionTimer.current);
      clearTimeout(reactionMove.current);
      clearTimeout(scheduleTimer.current);
      clearTimeout(scheduleMove.current);
      reactionSequence.current += 1;
      deferredReaction.current = null;
      reactionPhase.current = null;
      reactionMove.current = null;
      menuWasOpen.current = false;
      hoverInside.current = false;
      hover.current = false;
      setHovered(false);
      if (!pending) {
        setPose(p => ({ ...idlePose, at: p.edge === "top" ? p.at : idlePose.at, motion: p.motion }));
        setPhase(pageHidden ? "hidden" : "rest");
      }
    } else if (resume && !pending) {
      // 恢复时只回安全的上沿待机，不复活被中断的离场、趴睡或菜单轨迹。
      setPose(p => ({ ...idlePose, at: p.edge === "top" ? p.at : idlePose.at, motion: p.motion }));
      setPhase("rest");
    }
  }, [quiet, pageHidden, pending?.id]);

  useEffect(() => {
    clearTimeout(hoverArmTimer.current);
    clearTimeout(hoverReleaseTimer.current);
    hoverInside.current = false;
    hover.current = false;
    setHovered(false);
    if (!pending) {
      const timer = setTimeout(() => { setRetained(null); focused.current = false; }, quiet ? 0 : HOVER_RELEASE_MS);
      return () => clearTimeout(timer);
    }
    setRetained(pending); setError("");
    menuWasOpen.current = false;
    // 从侧面/下沿先收爪缩回，再从上沿探出。气泡等乐乐就位后才展开。
    if (live.current.pose.edge !== "top") {
      setPhase("exit");
      const timer = setTimeout(() => { setPose(askPoses[hash(pending.id) % askPoses.length]); setPhase(quiet ? "rest" : "enter"); }, quiet ? 0 : EXIT_MS);
      return () => clearTimeout(timer);
    }
    setPose(p => ({ ...p, ...askPoses[hash(pending.id) % askPoses.length], at: p.at }));
    setPhase(!quiet && live.current.phase === "hidden" ? "enter" : "rest");
  }, [pending?.id, quiet]);

  useEffect(() => {
    clearTimeout(scheduleTimer.current);
    clearTimeout(scheduleMove.current);
    if (quiet || pending || menuOpen) return undefined;
    let cancelled = false;
    const schedule = (delay = 18000 + Math.random() * 16000) => {
      clearTimeout(scheduleTimer.current);
      scheduleTimer.current = setTimeout(() => {
        if (cancelled) return;
        const current = live.current;
        // 用户正在等回答时，状态表情负责反馈，不再随机跑动抢走注意力。
        if (["thinking", "working", "loading", "compressing", "waiting"].includes(current.state)) {
          schedule(5000);
          return;
        }
        if (hover.current || focused.current || current.saving || current.menuOpen || current.hovered || reactionPhase.current || current.retained && !current.pending) {
          schedule(2600);
          return;
        }
        if (current.pending) return;
        const g = current.geometry;
        const edges = ["top"];
        if (g.left > 48 && g.height > 84) edges.push("left");
        if (g.viewportWidth - g.left - g.width > 48 && g.height > 84) edges.push("right");
        if (g.width >= 480 && g.viewportHeight + g.viewportTop - g.bottom > 62) edges.push("bottom");
        const edge = choose([...edges, ...Array(12).fill("top")]);
        const candidates = edge === "top"
          ? ["pop", "walk", "spin", "toy", "belly", "cute", "lick", "groom", "wash", "stretch", "wink", "curl", "sleep", "zzz", "peek", "wave", "paws", "look", "chase", "knead", "shake", "shy", "loaf", "yawn", "drowsy", "pawtap"]
          : (edge === "bottom" ? bottomGestures : sideGestures);
        const gesture = choose(candidates.filter(p => p !== current.pose.gesture));
        const arrive = () => {
          if (cancelled) return;
          scheduleMove.current = null;
          if (reactionPhase.current || live.current.pending || live.current.menuOpen || hover.current) {
            if (hover.current && !reactionPhase.current && live.current.phase === "exit") setPhase("rest");
            schedule(2600);
            return;
          }
          const at = edge === "bottom" ? choose([.16, .84]) : .2 + Math.random() * .6;
          setPose({ edge, gesture, at, motion: ++travelId.current });
          setPhase(quiet ? "rest" : "enter");
          schedule();
        };
        if (current.phase === "hidden" || quiet) arrive();
        else {
          setPhase("exit");
          clearTimeout(scheduleMove.current);
          scheduleMove.current = setTimeout(arrive, EXIT_MS);
        }
      }, delay);
    };
    schedule();
    return () => { cancelled = true; clearTimeout(scheduleTimer.current); clearTimeout(scheduleMove.current); };
  }, [quiet, pending?.id, menuOpen]);

  useEffect(() => {
    if (quiet || pending || menuOpen || pose.edge !== "top" || !["walk", "pop", "spin"].includes(pose.gesture)) return;
    let hide;
    const finish = setTimeout(() => {
      if (reactionPhase.current || hover.current) return;
      setPhase("exit");
      hide = setTimeout(() => { if (!reactionPhase.current && !hover.current) setPhase("hidden"); }, EXIT_MS);
    }, 4400);
    return () => { clearTimeout(finish); clearTimeout(hide); };
  }, [pose.gesture, pose.edge, quiet, pending?.id, menuOpen]);

  useEffect(() => {
    if (quiet || !pose.flight || phase !== "enter" || !["leap", "transfer", "drop"].includes(pose.gesture)) return;
    const token = motionToken.current;
    const timer = setTimeout(() => completeMotion(token), pose.duration + 120);
    return () => clearTimeout(timer);
  }, [pose.flight, pose.gesture, pose.duration, phase, quiet]);

  // 只有菜单实际遮住乐乐才避让，位置取菜单外沿；关闭时从真实高度落回输入框。
  useEffect(() => {
    if (pending) { menuWasOpen.current = false; return undefined; }
    if (pageHidden) return undefined;
    let frame, observer;
    if (menuOpen) {
      const align = () => {
        if (["hidden", "exit"].includes(live.current.phase) || ["left", "right", "bottom"].includes(live.current.pose.edge)) return;
        const parent = marker.current?.parentElement;
        const cat = parent?.querySelector(".lele-edge-viewport")?.getBoundingClientRect();
        const menu = parent?.querySelector("[data-promptbar-menu]");
        if (!menu || !cat) return;
        // 菜单入场带缩放，取布局坐标以免把动画中的矩形误当最终边线。
        const origin = menu.offsetParent.getBoundingClientRect(), base = parent.getBoundingClientRect();
        const r = { top: origin.top + menu.offsetTop, left: origin.left + menu.offsetLeft, right: origin.left + menu.offsetLeft + menu.offsetWidth };
        const previous = menuWasOpen.current;
        if (!previous && !(r.left < cat.right && r.right > cat.left && r.top < cat.bottom && menu.getBoundingClientRect().bottom > cat.top)) return;
        const top = r.top, x = Math.min(r.right - 30, Math.max(r.left + 30, cat.x + cat.width / 2));
        const next = { edge: "menu", at: (x - base.left) / base.width, gesture: previous ? "transfer" : "leap", y: top - base.top, floor: base.top - top };
        if (previous && Math.abs(previous.y - next.y) < .5 && Math.abs(previous.at - next.at) * base.width < .5) return;
        // 从当前可见身体起跳；快速切菜单时同样采样当前帧，不瞬移到旧落点。
        const actorElement = parent.querySelector(".lele-edge-actor"), actor = actorElement.getBoundingClientRect();
        captureFlight(actorElement);
        next.travelX = actor.left - (x - 29);
        next.travelY = actor.top - (top - 54);
        next.falling = previous && next.travelY < -45;
        next.duration = Math.min(960, Math.max(580, 500 + Math.hypot(next.travelX, next.travelY) * .9));
        next.motion = live.current.pose.motion;
        next.flight = ++travelId.current;
        menuWasOpen.current = next;
        setPose(next); setPhase(quiet ? "rest" : "enter");
      };
      frame = requestAnimationFrame(() => {
        align();
        const menu = marker.current?.parentElement?.querySelector("[data-promptbar-menu]");
        observer = new ResizeObserver(align);
        if (menu) observer.observe(menu);
        observer.observe(marker.current.parentElement);
      });
    } else if (menuWasOpen.current) {
      menuWasOpen.current = false;
      const parent = marker.current.parentElement, actorElement = parent.querySelector(".lele-edge-actor"), actor = actorElement.getBoundingClientRect(), base = parent.getBoundingClientRect();
      captureFlight(actorElement);
      const travelY = Math.min(0, actor.top - (base.top - 54));
      setPose({ edge: "top", at: (actor.left + 29 - base.left) / base.width, gesture: "drop", falling: true, travelY, duration: Math.min(920, Math.max(600, 520 + Math.abs(travelY) * .85)), motion: live.current.pose.motion, flight: ++travelId.current }); setPhase(quiet ? "rest" : "enter");
    }
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [menuOpen, quiet, pageHidden, pending?.id]);

  // 输入、发送、复制、重试都给乐乐一个短促的专属反应；反应结束才交还给随机动作。
  useEffect(() => {
    const react = e => {
      const action = typeof e.detail === "string" ? e.detail : e.detail?.action;
      if (!action || quiet || pending || menuOpen || saving) return;
      const gestures = { typing: "listen", send: "pop", copy: "proud", retry: "spin", attach: "curious" };
      const gesture = gestures[action];
      if (!gesture) return;
      const current = live.current.pose, currentPhase = live.current.phase;
      const alreadyReacting = reactionPhase.current === gesture;
      const sequence = ++reactionSequence.current;
      reactionPhase.current = gesture;
      clearTimeout(reactionTimer.current);
      const release = () => {
        reactionTimer.current = setTimeout(() => {
          if (reactionSequence.current !== sequence) return;
          reactionPhase.current = null;
          setPose(p => p.edge === "top" ? { ...p, gesture: idlePose.gesture, head: idlePose.head } : p);
          setPhase("rest");
        }, action === "typing" ? 1800 : 1600);
      };
      if (current.edge === "top" && currentPhase === "enter") {
        // 只排队最新反应，让已开始的入场完整落地；不截断 translate，也不重建身体。
        deferredReaction.current = () => {
          if (reactionSequence.current !== sequence || live.current.pending || live.current.menuOpen) return;
          setPose(p => ({ ...p, gesture, head: -25 }));
          setPhase("rest");
          release();
        };
        return;
      }
      deferredReaction.current = null;
      if (!alreadyReacting) {
        clearTimeout(reactionMove.current);
        reactionMove.current = null;
        const arrive = () => {
          if (reactionPhase.current !== gesture || live.current.pending || live.current.menuOpen) return;
          reactionMove.current = null;
          setPose({ edge: "top", at: .72, gesture, head: -25, motion: ++travelId.current });
          setPhase("enter");
        };
        if (["left", "right", "bottom"].includes(current.edge)) {
          // 用户操作打断局部小动作时，先缩回当前边，不能把半条腿瞬移成上沿整只猫。
          if (currentPhase === "hidden") arrive();
          else {
            setPhase("exit");
            reactionMove.current = setTimeout(arrive, EXIT_MS);
          }
        } else {
          // 同一条上沿只改变姿态，保留 DOM 和锚点，让 CSS 从当前帧自然接续。
          setPose(p => ({ ...p, gesture, head: -25 }));
          setPhase(currentPhase === "hidden" ? "enter" : "rest");
        }
      }
      // 连续输入只延长同一段反应，不重复触发入场动画。
      release();
    };
    window.addEventListener("lele-action", react);
    return () => { window.removeEventListener("lele-action", react); clearTimeout(reactionTimer.current); clearTimeout(reactionMove.current); reactionSequence.current += 1; deferredReaction.current = null; reactionMove.current = null; reactionPhase.current = null; };
  }, [quiet, pending?.id, menuOpen, saving]);

  // Hover 是一个稳定的交互状态：先确认用户真的停留，再触发一次轻微反应。
  // 事件挂在锚点上而不是动画身体上，配合 CSS 的 ::before 热区后，身体移动不会反复出入场。
  const armHover = e => {
    if (e?.pointerType === "touch" || quiet || pending || retained || menuOpen) return;
    if (staysInside(e)) return;
    clearTimeout(hoverArmTimer.current);
    clearTimeout(hoverReleaseTimer.current);
    hoverInside.current = true;
    hover.current = true;
    const session = ++hoverSession.current;
    hoverArmTimer.current = setTimeout(() => {
      if (!hoverInside.current || hoverSession.current !== session) return;
      const current = live.current;
      if (current.pending || current.menuOpen || current.saving || current.phase === "exit" || current.phase === "hidden") return;
      setHovered(true);
      // Hover 只叠加微表情，动作本身与 DOM 身份保持连续；睡熟后才会被轻轻惊醒。
    }, quiet ? 0 : HOVER_ARM_MS);
  };

  const releaseHover = e => {
    if (staysInside(e)) return;
    hoverInside.current = false;
    clearTimeout(hoverArmTimer.current);
    clearTimeout(hoverReleaseTimer.current);
    const session = ++hoverSession.current;
    hoverReleaseTimer.current = setTimeout(() => {
      if (hoverInside.current || hoverSession.current !== session) return;
      hover.current = false;
      setHovered(false);
    }, quiet ? 0 : HOVER_RELEASE_MS);
  };

  useEffect(() => {
    const g = geometry;
    const fits = pose.edge === "menu" || pose.edge === "top" || pose.edge === "left" && g.left > 48 || pose.edge === "right" && g.viewportWidth - g.left - g.width > 48 || pose.edge === "bottom" && g.width >= 480 && g.viewportHeight + g.viewportTop - g.bottom > 62;
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
  const asking = Boolean(part && pose.edge === "top" && !["exit", "hidden"].includes(phase));
  const width = Math.min(430, geometry.width), headX = geometry.width * pose.at;
  const left = Math.max(0, Math.min(geometry.width - width, headX - width * .56));
  const tail = Math.max(24, Math.min(width - 24, headX - left));
  const clearance = -(pose.head || -29) + 20;
  const height = Math.min(440, Math.max(130, geometry.top - geometry.viewportTop - clearance - 14));
  const fragment = ["left", "right", "bottom"].includes(pose.edge);
  const anchorStyle = pose.edge === "left" || pose.edge === "right" ? { top: Math.max(34, Math.min(geometry.height - 34, geometry.height * pose.at)) - 29 } : { left: `calc(${pose.at * 100}% - 29px)`, ...(pose.edge === "menu" ? { top: pose.y } : {}), "--edge-floor": `${pose.floor || 0}px`, "--travel-x": `${pose.travelX || 0}px`, "--travel-y": `${pose.travelY || 0}px`, "--travel-arc": `${Math.min(0, pose.travelY || 0) - 32}px`, "--flight-duration": `${pose.duration || 1000}ms` };
  const companionState = asking ? (closing ? "asking-closing" : "asking") : menuOpen ? "menu" : reactionPhase.current ? "reacting" : hovered ? "hover" : phase === "hidden" ? "hidden" : "idle";
  const finishMotion = e => {
    if (!e.target.classList.contains("lele-edge-actor")) return;
    if (pose.flight && phase === "enter" && ["leap", "transfer", "drop"].includes(pose.gesture)) {
      // 同一 DOM 上重启路线后，旧 animationend 仍可能已进入事件队列；只接受当前路线末帧。
      const active = e.target.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === e.animationName && a.effect.target === e.target);
      if (!active || Number(active.currentTime) < Number(active.effect.getComputedTiming().endTime) - 20) return;
    }
    completeMotion(motionToken.current);
  };

  return <>
    <span ref={marker} className="lele-companion-marker" aria-hidden="true"/>
    <span className={`lele-perch-anchor at-${pose.edge} pose-${pose.gesture} phase-${phase} ${pose.falling ? "is-falling" : ""} ${fragment ? "is-fragment" : ""} ${asking ? "is-questioning" : ""} ${hovered ? "is-hovered" : ""} ${quiet ? "is-reduced-motion" : ""}`} style={anchorStyle} data-pose={pose.gesture} data-companion-state={companionState} data-phase={phase} data-hovered={hovered ? "true" : "false"} aria-hidden="true" onPointerEnter={armHover} onPointerLeave={releaseHover} onAnimationEnd={finishMotion}>
      <span className="lele-edge-viewport"><span key={pose.motion || "idle"} className="lele-edge-actor"><ChatMascot state={asking ? "asking" : state} gesture={pose.gesture}/></span></span>
      {["paws", "wave", "invite", "listen", "knead"].includes(pose.gesture) && <span className="lele-edge-grip"><i/><i/></span>}
    </span>
    {asking && <section key={part.id} className={`tool-approval lele-speech ${closing ? "is-closing" : "is-pending"}`} role="region" aria-label="乐乐需要你的确认" aria-labelledby={labelId}
      style={{ width, left, bottom: `calc(100% + ${clearance}px)`, "--speech-tail": `${tail}px`, "--speech-height": `${height}px` }}
      inert={closing ? "" : undefined} onPointerEnter={() => { hover.current = true; }} onPointerLeave={() => { hover.current = false; }}
      onFocusCapture={() => { focused.current = true; }} onBlurCapture={e => { if (!staysInside(e)) focused.current = false; }}>
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
