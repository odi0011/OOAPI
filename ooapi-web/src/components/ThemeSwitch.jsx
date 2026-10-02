import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from 'antd';
import { useTheme } from '../theme/ThemeContext';
import './theme-switch.css';

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
  return <Button type="text" className={`oo-theme-toggle-switch${dark ? ' is-dark' : ''}${switching ? ' is-switching' : ''}`}
    aria-label={dark ? '切换至亮色主题' : '切换至暗色主题'} aria-pressed={dark} title={dark ? '切换至亮色主题' : '切换至暗色主题'} onClick={toggle}>
    <span className="oo-theme-toggle-track" aria-hidden="true"><i className="oo-theme-toggle-star star-one"/><i className="oo-theme-toggle-star star-two"/><i className="oo-theme-toggle-star star-three"/>
      <span className="oo-theme-toggle-thumb"><svg viewBox="0 0 24 24" className="oo-theme-toggle-sun"><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg><svg viewBox="0 0 24 24" className="oo-theme-toggle-moon"><path d="M19.8 15.3A8.4 8.4 0 0 1 8.7 4.2 8.5 8.5 0 1 0 19.8 15.3Z"/></svg></span>
    </span>
  </Button>;
}
