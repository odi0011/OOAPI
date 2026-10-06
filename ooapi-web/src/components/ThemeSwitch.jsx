import React, { useRef, useState } from 'react';
import {  flushSync } from 'react-dom';
import { ThemeSwitch as ArcThemeSwitch } from "./arc/theme-switch/theme-switch";
import { useTheme } from '../theme/ThemeContext';


export default function ThemeSwitch() {
  const { resolved, setColorMode, previewing } = useTheme();
  const [switching, setSwitching] = useState(false);
  const pending = useRef(false);
  if (previewing) return null;
  const dark = resolved === 'dark';
  const toggle = async (event) => {
    if (pending.current) return;
    const next = dark ? 'light' : 'dark';
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    pending.current = true; setSwitching(true);
    try {
      if (!document.startViewTransition || reduced) {
        setColorMode(next);
        return;
      }
      const transition = document.startViewTransition(async () => {
        flushSync(() => setColorMode(next));
        // 同步切换配套壁纸，避免第一帧还是上一主题的图片。
        const img = document.querySelector('.studio-desktop-wallpaper img');
        if (img) await Promise.race([img.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))]);
      });
      await transition.ready;
      await document.documentElement.animate([
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(${radius * 1.015}px at ${x}px ${y}px)`, offset: .82 },
        { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
      ], { duration: 720, easing: 'cubic-bezier(.2,.72,.18,1)', pseudoElement: '::view-transition-new(root)' }).finished;
      await transition.finished;
    } catch { setColorMode(next); }
    finally { pending.current = false; setSwitching(false); }
  };
  return <ArcThemeSwitch theme={resolved} iconOnly variant="reveal" label={dark ? "切换至亮色主题" : "切换至暗色主题"} onThemeChange={(_,__,trigger) => toggle({ currentTarget: trigger })}/>;
}
