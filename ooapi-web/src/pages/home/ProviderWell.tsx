import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useReducedMotion } from "motion/react";

import claudeIcon from "../../assets/providers/claude.svg";
import cursorIcon from "../../assets/providers/cursor.svg";
import deepseekIcon from "../../assets/providers/deepseek.svg";
import geminiIcon from "../../assets/providers/gemini.svg";
import grokIcon from "../../assets/providers/grok.svg";
import kimiIcon from "../../assets/providers/kimi.svg";
import kiroIcon from "../../assets/providers/kiro.svg";
import minimaxIcon from "../../assets/providers/minimax.svg";
import mistralIcon from "../../assets/providers/mistral.svg";
import openaiIcon from "../../assets/providers/openai.svg";
import qwenIcon from "../../assets/providers/qwen.svg";
import zhipuIcon from "../../assets/providers/zhipu.svg";

import styles from "./ProviderWell.module.css";

export interface Provider {
  id: string;
  name: string;
  icon: string;
  monochrome?: boolean;
  iconSurface?: "dark";
  url: string;
  description: string;
}

/** Provider marks from LobeHub's MIT-licensed icon collection. */
export const PROVIDERS: Provider[] = [
  { id: "openai", name: "OpenAI", icon: openaiIcon, monochrome: true, url: "https://openai.com", description: "推理模型" },
  { id: "claude", name: "Claude", icon: claudeIcon, url: "https://www.anthropic.com/claude", description: "编程模型" },
  { id: "cursor", name: "Cursor", icon: cursorIcon, monochrome: true, url: "https://cursor.com", description: "编程工具" },
  { id: "grok", name: "Grok", icon: grokIcon, monochrome: true, url: "https://x.ai", description: "实时模型" },
  { id: "deepseek", name: "DeepSeek", icon: deepseekIcon, url: "https://www.deepseek.com", description: "开源模型" },
  { id: "kimi", name: "Kimi", icon: kimiIcon, iconSurface: "dark", url: "https://www.kimi.com", description: "长上下文模型" },
  { id: "kiro", name: "Kiro", icon: kiroIcon, url: "https://kiro.dev", description: "开发工具" },
  { id: "gemini", name: "Gemini", icon: geminiIcon, url: "https://ai.google.dev", description: "多模态模型" },
  { id: "qwen", name: "Qwen", icon: qwenIcon, url: "https://qwenlm.github.io", description: "中文模型" },
  { id: "mistral", name: "Mistral", icon: mistralIcon, url: "https://mistral.ai", description: "开源模型" },
  { id: "zhipu", name: "Zhipu", icon: zhipuIcon, url: "https://www.zhipuai.cn", description: "中文模型" },
  { id: "minimax", name: "MiniMax", icon: minimaxIcon, url: "https://www.minimaxi.com", description: "多模态模型" },
];

export interface ProviderWellProps {
  /** Provider selected on first render. Defaults to OpenAI. */
  defaultProvider?: string;
  /** Selected provider identity, shared with the homepage model activity filter. */
  onSelect?: (id: string) => void;
  /** Called after a tile is clicked or confirmed with Enter. */
  onProviderChange?: (provider: Provider) => void;
  className?: string;
}

type Wave = { id: number; x: number; y: number; delays: number[] };

function providerIndex(id: string | undefined) {
  const index = PROVIDERS.findIndex((provider) => provider.id === id);
  return index < 0 ? 0 : index;
}

export default function ProviderWell({ defaultProvider, onSelect, onProviderChange, className }: ProviderWellProps) {
  const [selected, setSelected] = useState(() => PROVIDERS[providerIndex(defaultProvider)]!);
  const [focused, setFocused] = useState(() => providerIndex(defaultProvider));
  const [wave, setWave] = useState<Wave | null>(null);
  const reducedMotion = useReducedMotion();
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const waveId = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  const resetTiles = () => {
    for (const tile of tileRefs.current) {
      tile?.style.setProperty("--tx", "0px");
      tile?.style.setProperty("--ty", "0px");
      tile?.style.setProperty("--tilt", "0deg");
      tile?.style.setProperty("--scale", "1");
      tile?.removeAttribute("data-near");
    }
  };

  const updateTiles = () => {
    frameRef.current = null;
    const point = pointerRef.current;
    if (!point) {
      resetTiles();
      return;
    }
    for (let index = 0; index < tileRefs.current.length; index++) {
      const tile = tileRefs.current[index];
      if (!tile) continue;
      // Static cells keep the target from drifting as their buttons spring toward it.
      const rect = cellRefs.current[index]?.getBoundingClientRect();
      if (!rect) continue;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const distance = Math.hypot(dx, dy);
      const influence = Math.max(0, 1 - distance / 150);
      tile.style.setProperty("--tx", `${(dx * influence * 0.14).toFixed(2)}px`);
      tile.style.setProperty("--ty", `${(dy * influence * 0.14).toFixed(2)}px`);
      tile.style.setProperty("--tilt", `${(dx * influence * 0.045).toFixed(2)}deg`);
      tile.style.setProperty("--scale", (1 + influence * 0.075).toFixed(3));
      tile.toggleAttribute("data-near", influence > 0.05);
    }
  };

  const schedulePointerUpdate = (event: PointerEvent<HTMLDivElement>) => {
    if (reducedMotion || event.pointerType === "touch") return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(updateTiles);
  };

  const clearPointer = () => {
    pointerRef.current = null;
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(updateTiles);
  };

  const choose = (provider: Provider) => {
    setSelected(provider);
    onSelect?.(provider.id);
    onProviderChange?.(provider);
    if (reducedMotion || !gridRef.current) return;
    const index = PROVIDERS.indexOf(provider);
    const origin = cellRefs.current[index]?.getBoundingClientRect();
    if (!origin) return;
    const bounds = gridRef.current.getBoundingClientRect();
    const x = origin.left + origin.width / 2;
    const y = origin.top + origin.height / 2;
    const delays = cellRefs.current.map((cell) => {
      const rect = cell?.getBoundingClientRect();
      return rect ? Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y) * .5 : 0;
    });
    setWave({ id: ++waveId.current, x: x - bounds.left, y: y - bounds.top, delays });
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    const columns = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").length : 4;
    const offset = event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : event.key === "ArrowLeft" ? -1 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? PROVIDERS.length - 1 : (current + offset + PROVIDERS.length) % PROVIDERS.length;
    event.preventDefault();
    setFocused(next);
    tileRefs.current[next]?.focus();
  };

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const classes = [styles.well, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role="region" aria-label="模型厂商">
      <div className={styles.wellHeader}>
        <span className={styles.wellKicker}>模型与开发工具</span>
        <span className={styles.wellRule} aria-hidden="true" />
        <span className={styles.wellCount}>12 个厂商与工具</span>
      </div>
      <div ref={gridRef} className={styles.tiles} role="group" aria-label="模型厂商选择" onPointerMove={schedulePointerUpdate} onPointerLeave={clearPointer}>
        {wave && !reducedMotion && <span key={wave.id} className={styles.wave} style={{ left: wave.x, top: wave.y }} aria-hidden="true" />}
        {PROVIDERS.map((provider, index) => {
          const iconStyle = { "--wave-delay": `${wave?.delays[index] ?? 0}ms` } as CSSProperties;
          return (
            <div key={provider.id} className={styles.cell} ref={(node) => { cellRefs.current[index] = node; }}>
              <button
                ref={(node) => { tileRefs.current[index] = node; }}
                className={styles.tile}
                style={iconStyle}
                type="button"
                tabIndex={focused === index ? 0 : -1}
                aria-label={`${provider.name}：${provider.description}`}
                aria-pressed={selected.id === provider.id}
                data-selected={selected.id === provider.id || undefined}
                onFocus={() => setFocused(index)}
                onClick={() => choose(provider)}
                onKeyDown={(event) => {
                  if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) moveFocus(event, index);
                }}
              >
                <img src={provider.icon} className={styles.icon} alt="" draggable={false} data-monochrome={provider.monochrome || undefined} data-surface={provider.iconSurface} />
                <span className={styles.tileName}>{provider.name}</span>
                {wave && !reducedMotion && <span key={wave.id} className={styles.pulse} aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </div>
      <div className={styles.selection} aria-live="polite">
        <img src={selected.icon} className={styles.selectionIcon} alt="" draggable={false} data-monochrome={selected.monochrome || undefined} data-surface={selected.iconSurface} />
        <span><strong>{selected.name}</strong><span>{selected.description}</span></span>
        <a href={selected.url} target="_blank" rel="noreferrer">了解厂商 <span aria-hidden="true">↗</span></a>
      </div>
    </div>
  );
}
