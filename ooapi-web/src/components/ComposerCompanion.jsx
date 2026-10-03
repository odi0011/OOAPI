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
// 下沿只露尾巴/后腿，侧沿只探头/伸爪；不能把上沿的整只猫旋转后复用。
const sideGestures = ["side-peek", "side-scout", "side-paw", "side-tap"];
const bottomGestures = ["tail-slip", "tail-tip", "feet-kick", "foot-dangle"];

// 同一处边线同时约束猫、爪子、气泡尾巴。身体在裁剪层外侧，爪子独立握住边线。
// 不观察动画自身的宽高，避免位置测量与动画互相触发。
export default function ComposerCompanion({ state, approvals = [], onDecide, menuOpen = false }) {
  const pending = approvals[0] || null;
  const [retained, setRetained] = useState(pending);
  const [pose, setPose] = useState(() => pending ? askPoses[hash(pending.id) % askPoses.length] : idlePose);
  const [phase, setPhase] = useState("enter");
  const [geometry, setGeometry] = useState({ width: 320, top: 700, height: 100, left: 40, bottom: 800, viewportWidth: 1440, viewportHeight: 1000, viewportTop: 0 });
  const [quiet, setQuiet] = useState(() => document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const marker = useRef(null), locked = useRef(false), hover = useRef(false), focused = useRef(false);
  const menuWasOpen = useRef(false), reactionTimer = useRef(null), reactionMove = useRef(null), reactionPhase = useRef(null), hoverUntil = useRef(0);
  const travelId = useRef(0);
  const live = useRef();
  live.current = { pose, geometry, pending, retained, saving, menuOpen };
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
    setPose(p => ({ ...askPoses[hash(pending.id) % askPoses.length], at: p.at })); setPhase("rest");
  }, [pending?.id, quiet]);

  useEffect(() => {
    if (quiet || pending || menuOpen) return;
    let timer, move;
    const schedule = () => { timer = setTimeout(() => {
      const current = live.current;
      if (hover.current || focused.current || current.saving || current.menuOpen || reactionPhase.current || current.retained && !current.pending) { schedule(); return; }
      if (current.pending) {
        // 询问期间乐乐和气泡是一套稳定的界面锚点，不在用户阅读和点击时换姿势。
        return;
      }
      const g = current.geometry;
      const edges = ["top"];
      // 两侧需要真实留白；底部还要给页脚与屏幕边缘留足空间。
      if (g.left > 48 && g.height > 84) edges.push("left");
      if (g.viewportWidth - g.left - g.width > 48 && g.height > 84) edges.push("right");
      if (g.width >= 480 && g.viewportHeight + g.viewportTop - g.bottom > 62) edges.push("bottom");
      const edge = choose([...edges, "top", "top"]);
      const gesture = choose(edge === "top"
        ? ["pop", "walk", "tumble", "toy", "belly", "cute", "lick", "groom", "wash", "stretch", "wink", "curl", "sleep", "zzz", "peek", "wave", "paws", "look", "chase", "knead", "shake", "shy"].filter(p => p !== current.pose.gesture)
        : (edge === "bottom" ? bottomGestures : sideGestures).filter(p => p !== current.pose.gesture));
      setPhase("exit");
      move = setTimeout(() => { setPose({ edge, gesture, at: edge === "bottom" ? choose([.16, .84]) : .2 + Math.random() * .6 }); setPhase("enter"); schedule(); }, 300);
    }, 12000 + Math.random() * 12000); };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(move); };
  }, [quiet, pending?.id, menuOpen]);

  useEffect(() => {
    if (quiet || pending || menuOpen || pose.edge !== "top" || !["walk", "pop", "tumble"].includes(pose.gesture)) return;
    let hide;
    const finish = setTimeout(() => { setPhase("exit"); hide = setTimeout(() => setPhase("hidden"), 300); }, 4400);
    return () => { clearTimeout(finish); clearTimeout(hide); };
  }, [pose.gesture, pose.edge, quiet, pending?.id, menuOpen]);

  // 只有菜单实际遮住乐乐才避让，位置取菜单外沿；关闭时从真实高度落回输入框。
  useEffect(() => {
    if (pending) return undefined;
    let timer, frame, observer;
    if (menuOpen) {
      const align = () => {
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
        const next = { edge: "menu", at: (x - base.left) / base.width, gesture: previous ? "transfer" : "annoyed", y: top - base.top };
        if (previous && Math.abs(previous.y - next.y) < .5 && Math.abs(previous.at - next.at) * base.width < .5) return;
        if (previous) {
          // 菜单之间直接移动；距离来自两个真实上沿，不能沿用模型菜单的旧高度。
          const anchor = parent.querySelector(".lele-perch-anchor").getBoundingClientRect();
          const transform = getComputedStyle(parent.querySelector(".lele-edge-actor")).transform;
          const matrix = transform === "none" ? { m41: 0, m42: 0 } : new DOMMatrixReadOnly(transform);
          next.travelX = anchor.left + 29 + matrix.m41 - x;
          next.travelY = anchor.top + matrix.m42 - top;
          next.motion = ++travelId.current;
        }
        menuWasOpen.current = next;
        clearTimeout(timer);
        if (previous) { setPose(next); setPhase(quiet ? "rest" : "enter"); }
        else {
          setPhase("exit");
          timer = setTimeout(() => { setPose(next); setPhase(quiet ? "rest" : "enter"); }, quiet ? 0 : 280);
        }
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
      const parent = marker.current.parentElement, anchor = parent.querySelector(".lele-perch-anchor").getBoundingClientRect(), base = parent.getBoundingClientRect();
      const transform = getComputedStyle(parent.querySelector(".lele-edge-actor")).transform;
      const matrix = transform === "none" ? { m41: 0, m42: 0 } : new DOMMatrixReadOnly(transform);
      setPose({ edge: "top", at: (anchor.left + 29 + matrix.m41 - base.left) / base.width, gesture: "drop", fallFrom: Math.min(0, anchor.top + matrix.m42 - base.top) }); setPhase(quiet ? "rest" : "enter");
    }
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [menuOpen, quiet, pending?.id]);

  // 输入、发送、复制、重试都给乐乐一个短促的专属反应；反应结束才交还给随机动作。
  useEffect(() => {
    const react = e => {
      const action = typeof e.detail === "string" ? e.detail : e.detail?.action;
      if (!action || quiet || pending || menuOpen || saving) return;
      const gestures = { typing: "listen", send: "pop", copy: "proud", retry: "spin", attach: "curious" };
      const gesture = gestures[action];
      if (!gesture) return;
      clearTimeout(reactionTimer.current);
      reactionPhase.current = gesture;
      const current = live.current.pose;
      if (current.gesture !== gesture) {
        const arrive = () => { reactionMove.current = null; setPose({ edge: "top", at: current.edge === "top" ? current.at : .72, gesture, head: -25 }); setPhase("enter"); };
        if (["left", "right", "bottom"].includes(current.edge)) {
          // 用户操作打断局部小动作时，先缩回当前边，不能把半条腿瞬移成上沿整只猫。
          if (!reactionMove.current) { setPhase("exit"); reactionMove.current = setTimeout(arrive, 260); }
        } else arrive();
      }
      reactionTimer.current = setTimeout(() => {
        if (reactionPhase.current !== gesture) return;
        setPhase("exit");
        reactionTimer.current = setTimeout(() => { setPose({ ...idlePose, at: live.current.pose.at }); setPhase("enter"); reactionPhase.current = null; }, 300);
      }, action === "typing" ? 900 : 1500);
    };
    window.addEventListener("lele-action", react);
    return () => { window.removeEventListener("lele-action", react); clearTimeout(reactionTimer.current); clearTimeout(reactionMove.current); reactionMove.current = null; reactionPhase.current = null; };
  }, [quiet, pending?.id, menuOpen, saving]);

  const onHover = () => {
    if (quiet || pending || retained || menuOpen || ["exit", "hidden"].includes(phase) || Date.now() < hoverUntil.current) return;
    hoverUntil.current = Date.now() + 4000;
    if (["left", "right", "bottom"].includes(pose.edge)) {
      // 局部动作被发现时仍缩回同一条边，不突然换成一只倒挂的害羞猫。
      if (Math.random() < .35) {
        setPhase("exit");
        clearTimeout(reactionTimer.current);
        reactionTimer.current = setTimeout(() => setPhase("hidden"), 260);
      } else {
        const gesture = pose.edge === "bottom" ? (pose.gesture.startsWith("tail-") ? "tail-tip" : "feet-kick") : (["side-paw", "side-tap"].includes(pose.gesture) ? "side-tap" : "side-scout");
        setPose({ ...pose, gesture, motion: ++travelId.current }); setPhase("enter");
      }
      return;
    }
    if (Math.random() < .35) {
      setPhase("exit");
      clearTimeout(reactionTimer.current);
      reactionTimer.current = setTimeout(() => { setPose({ edge: "top", at: pose.at < .5 ? .8 : .2, gesture: "shy", head: -25 }); setPhase("enter"); }, 260);
    } else {
      setPose({ ...pose, gesture: "shy" });
      setPhase("enter");
    }
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
  const asking = Boolean(part && pose.edge === "top" && phase !== "exit");
  const width = Math.min(430, geometry.width), headX = geometry.width * pose.at;
  const left = Math.max(0, Math.min(geometry.width - width, headX - width * .56));
  const tail = Math.max(24, Math.min(width - 24, headX - left));
  const clearance = -(pose.head || -29) + 20;
  const height = Math.min(440, Math.max(130, geometry.top - geometry.viewportTop - clearance - 14));
  const fragment = ["left", "right", "bottom"].includes(pose.edge);
  const anchorStyle = pose.edge === "left" || pose.edge === "right" ? { top: Math.max(34, Math.min(geometry.height - 34, geometry.height * pose.at)) - 29 } : { left: `calc(${pose.at * 100}% - 29px)`, ...(pose.edge === "menu" ? { top: pose.y } : {}), ...(pose.fallFrom ? { "--fall-from": `${pose.fallFrom}px` } : {}), "--travel-x": `${pose.travelX || 0}px`, "--travel-y": `${pose.travelY || 0}px`, "--travel-arc": `${Math.min(0, pose.travelY || 0) - 22}px` };

  return <>
    <span ref={marker} className="lele-companion-marker" aria-hidden="true"/>
    <span className={`lele-perch-anchor at-${pose.edge} pose-${pose.gesture} phase-${phase} ${fragment ? "is-fragment" : ""} ${asking ? "is-questioning" : ""}`} style={anchorStyle} data-pose={pose.gesture} aria-hidden="true" onMouseEnter={onHover} onAnimationEnd={e => { if (e.target.classList.contains("lele-edge-actor") && phase === "enter") setPhase(fragment ? "hidden" : "rest"); }}>
      <span className="lele-edge-viewport"><span key={pose.motion || "idle"} className="lele-edge-actor"><ChatMascot state={asking ? "asking" : state} gesture={pose.gesture}/></span></span>
      {["paws", "wave", "invite", "listen", "knead"].includes(pose.gesture) && <span className="lele-edge-grip"><i/><i/></span>}
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
