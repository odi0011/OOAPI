import React, { useEffect, useRef, useState } from "react";
import {   Button  } from "./arc/index";
import { CloseOutlined, ExpandOutlined, CompressOutlined  } from "./arc/icons";
import BrandLogo from "./BrandLogo";

// 窗口只管理桌面交互；内部仍是正常页面链接和滚动容器。
export default function StudioWindow({ children, name, open, onClose, motion }) {
  const [maximized, setMaximized] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const windowRef = useRef(null);
  const drag = useRef(null);
  const maximize = () => { setMaximized((v) => !v); setOffset({ x: 0, y: 0 }); };
  useEffect(() => {
    const resize = () => { setOffset({ x: 0, y: 0 }); setDragging(false); drag.current = null; };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return <main ref={windowRef} id="top" aria-label={`${name} 首页窗口`} aria-hidden={!open} inert={!open ? "" : undefined}
    className={`studio-window${maximized ? " is-maximized" : ""}${dragging ? " is-dragging" : ""}${open ? " is-open" : " is-closed"}`}
    style={{ "--window-x": `${offset.x}px`, "--window-y": `${offset.y}px` }}>
    <div className="studio-window-bar" onDoubleClick={(e) => { if (!e.target.closest("button")) maximize(); }}
      onPointerDown={(e) => {
        if (maximized || innerWidth < 900 || e.button !== 0 || e.target.closest("button")) return;
        const rect = windowRef.current.getBoundingClientRect();
        drag.current = { pointerX: e.clientX, pointerY: e.clientY, ...offset, width: rect.width, top: rect.top - offset.y };
        e.currentTarget.setPointerCapture(e.pointerId); setDragging(true);
      }}
      onPointerMove={(e) => {
        const start = drag.current; if (!start) return;
        const limitX = Math.max(0, (innerWidth - start.width) / 2 - 8);
        setOffset({ x: Math.min(limitX, Math.max(-limitX, start.x + e.clientX - start.pointerX)), y: Math.min(innerHeight - start.top - 140, Math.max(52 - start.top, start.y + e.clientY - start.pointerY)) });
      }}
      onPointerUp={(e) => { drag.current = null; setDragging(false); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}>
      <span><BrandLogo size={12}/> {name} / 首页</span><div>
        <Button type="text" size="small" icon={maximized ? <CompressOutlined /> : <ExpandOutlined />} aria-label={maximized ? "还原窗口" : "展开窗口"} onClick={maximize} />
        <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭首页窗口" onClick={() => {
          if (!motion.active) { onClose(); return; }
          windowRef.current.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "translateY(26px) scale(.95)" }], { duration: 230, easing: "cubic-bezier(.4,0,1,1)" }).finished.then(onClose).catch(() => {});
        }} />
      </div>
    </div>
    <div className="studio-window-scroll" tabIndex={0} aria-label="首页内容"><div className="studio-window-inner">{children}</div></div>
  </main>;
}

export function useStudioCarousel({ active, enabled, onNext, duration = 8000 }) {
  const progressRef = useRef(null);
  const elapsed = useRef(0);
  const callback = useRef(onNext);
  callback.current = onNext;
  useEffect(() => { elapsed.current = 0; progressRef.current?.style.setProperty("--progress", "0"); }, [active]);
  useEffect(() => {
    if (!enabled) return undefined;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      elapsed.current += Math.min(now - last, 150); last = now;
      progressRef.current?.style.setProperty("--progress", String(Math.min(elapsed.current / duration, 1)));
      if (elapsed.current >= duration) { elapsed.current = 0; callback.current(); }
    }, 50);
    return () => clearInterval(timer);
  }, [enabled, active, duration]);
  return progressRef;
}
