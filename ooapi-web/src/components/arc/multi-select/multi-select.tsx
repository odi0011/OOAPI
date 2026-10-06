"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Variants } from "motion/react";
import { ChevronDown, X } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./multi-select.module.css";
import { Input } from "../input/input";
import type { ReactNode } from "react";

export interface MultiSelectOption {
  value: string;
  label: ReactNode;
  selectedLabel?: ReactNode;
  searchText?: string;
  disabled?: boolean;
  hidden?: boolean;
}

export interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  onSearch?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  filterOption?: boolean | ((query: string, option: MultiSelectOption) => boolean);
  placeholder?: string;
  description?: string;
  maxVisible?: number;
  disabled?: boolean;
  className?: string;
  searchable?: boolean;
  allowCreate?: boolean;
  "aria-label"?: string;
}

const enter = motionTokens.ease.enter;
const standard = motionTokens.ease.standard;
/** Each chip sits in a slot whose width opens and collapses on a spring, so neighbours travel with it and nothing overlaps. */
const slot: Variants = {
  hidden: { width: 0, opacity: 0 },
  shown: { width: "auto", opacity: 1, transition: { width: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, ease: enter } } },
  gone: { width: 0, opacity: 0, transition: { width: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.instant, ease: standard } } },
};
/** The chip itself grows in from .9 with a soft blur and shrinks back as it leaves. */
const chip: Variants = {
  hidden: { scale: 0.9, filter: `blur(${motionTokens.blur.soft}px)` },
  shown: { scale: 1, filter: "blur(0px)", transition: { ...motionTokens.spring.snappy, filter: { duration: motionTokens.duration.standard, ease: enter } } },
  gone: { scale: 0.9, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: standard } },
};
/** Reduced motion keeps short crossfades; resting states match the moving variants so server and client markup agree. */
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.instant } }, gone: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };
const slotFade: Variants = { hidden: { opacity: 0 }, shown: { width: "auto", opacity: 1, transition: { duration: motionTokens.duration.instant } }, gone: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };
const chipStill: Variants = { hidden: { scale: 1, filter: "blur(0px)" }, shown: { scale: 1, filter: "blur(0px)" }, gone: { scale: 1, filter: "blur(0px)" } };
/** The overflow count rolls: a larger number rises from below, a smaller one drops from above. */
const roll: Variants = {
  hidden: (direction: number) => ({ opacity: 0, y: `${direction * 0.5}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: enter } },
  gone: (direction: number) => ({ opacity: 0, y: `${direction * -0.5}em`, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: standard } }),
};

/** A check that draws itself when an option is picked and retracts when it is removed. */
function CheckMark({ reduce }: { reduce: boolean | null }) {
  return <svg className={styles.check} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M4 12.5 9 17.5 20 6.5" initial={reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} exit={reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 }} transition={reduce ? { duration: motionTokens.duration.instant } : { pathLength: { duration: motionTokens.duration.standard, ease: enter }, opacity: { duration: motionTokens.duration.instant } }} />
  </svg>;
}

export function MultiSelect({ label, options, value, defaultValue = [], onValueChange, onSearch, onOpenChange, filterOption, placeholder = "请选择", description, maxVisible = 2, disabled = false, className, searchable, allowCreate, "aria-label": ariaLabel }: MultiSelectProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [internal, setInternal] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = options.filter(option => !option.hidden && (!query || filterOption === false || (typeof filterOption === "function" ? filterOption(query, option) : `${option.searchText || option.label} ${option.value}`.toLowerCase().includes(query.toLowerCase()))));
  const canCreate = allowCreate && query.trim() && !options.some(option => option.value === query.trim());
  const choices = canCreate ? [...filtered, { value: query.trim(), label: `添加“${query.trim()}”` }] : filtered;
  const [activeIndex, setActiveIndex] = useState(-1);
  const selected = value ?? internal;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const labelFor = (item: string) => { const option = options.find((option) => option.value === item); return option?.selectedLabel ?? option?.label ?? item; };
  const textFor = (item: string) => { const option = options.find((option) => option.value === item); return option?.searchText || (typeof option?.label === "string" ? option.label : item); };
  const [visibleCount, setVisibleCount] = useState(maxVisible);
  const measured = selected.slice(0, maxVisible).map((item) => ({ value: item, label: labelFor(item) }));
  const visible = measured.slice(0, visibleCount);
  const remaining = Math.max(0, selected.length - visible.length);
  // A closed menu forgets its highlight, so the next open starts clean instead of on a stale hovered row.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (!open) setActiveIndex(-1); }
  const [previousRemaining, setPreviousRemaining] = useState(remaining);
  const [countDirection, setCountDirection] = useState(1);
  if (previousRemaining !== remaining) { setPreviousRemaining(remaining); setCountDirection(remaining > previousRemaining ? 1 : -1); }

  // 按实际可用宽度折叠完整标签，避免 flex 把胶囊硬裁成半个；末尾始终为 +N 留位。
  useLayoutEffect(() => {
    const valueNode = valueRef.current, measureNode = measureRef.current;
    if (!valueNode || !measureNode) return;
    const measure = () => {
      const chips = Array.from(measureNode.querySelectorAll<HTMLElement>("[data-measure-chip]"));
      const countWidth = (measureNode.querySelector<HTMLElement>("[data-measure-more]")?.getBoundingClientRect().width || 30) + 5;
      let count = 0, used = 0;
      for (const chipNode of chips) {
        const width = chipNode.getBoundingClientRect().width + 5;
        if (used + width + (count + 1 < selected.length ? countWidth : 0) > valueNode.clientWidth) break;
        used += width; count += 1;
      }
      setVisibleCount(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(valueNode); observer.observe(measureNode);
    return () => observer.disconnect();
  }, [selected, options, maxVisible]);

  useEffect(() => {
    const option = choices[activeIndex];
    const node = option ? optionRefs.current[option.value] : null;
    const list = node?.parentElement;
    if (open && node && list) {
      if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop;
      else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight;
    }
  }, [activeIndex, open, query]);

  const changeOpen = (next: boolean) => { setOpen(next); onOpenChange?.(next); if (!next) setQuery(""); };

  const update = (next: string[]) => { if (value === undefined) setInternal(next); onValueChange?.(next); };
  const toggle = (option: MultiSelectOption) => {
    if (disabled || option.disabled) return;
    update(selectedSet.has(option.value) ? selected.filter((item) => item !== option.value) : [...selected, option.value]);
  };
  const clear = () => { update([]); changeOpen(false); triggerRef.current?.focus(); };
  const enabled = choices.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key === "Enter" && open && activeIndex >= 0) { event.preventDefault(); toggle(choices[activeIndex]); return; }
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); changeOpen(false); triggerRef.current?.focus(); return; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && enabled.length) {
      event.preventDefault(); changeOpen(true);
      const current = enabled.indexOf(activeIndex);
      const next = current < 0 ? (event.key === "ArrowDown" ? 0 : enabled.length - 1) : event.key === "ArrowDown" ? (current + 1) % enabled.length : (current - 1 + enabled.length) % enabled.length;
      setActiveIndex(enabled[next]);
    }
  };
  const reduce = useReducedMotion();

  return <PopoverPrimitive.Root open={open} onOpenChange={changeOpen}><div ref={rootRef} data-arc-select-open={open || undefined} className={[styles.field, className].filter(Boolean).join(" ")}>
    <span id={labelId} className={styles.label}>{label}</span>
    <div className={styles.control}><PopoverPrimitive.Trigger asChild><button ref={triggerRef} type="button" className={`${styles.trigger} ${selected.length ? styles.hasClear : ""}`} disabled={disabled} aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : `${labelId} ${valueId}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-listbox`} onKeyDown={onKeyDown}>
      <span id={valueId} className={styles.srOnly}>{selected.length ? selected.map(textFor).join(", ") : placeholder}</span>
      <span ref={valueRef} className={styles.value} aria-hidden="true">
        <AnimatePresence initial={false}>
          {visible.map((item) => <motion.span key={`chip-${item.value}`} className={styles.slot} variants={reduce ? slotFade : slot} initial="hidden" animate="shown" exit="gone"><motion.span className={styles.chip} title={textFor(item.value)} variants={reduce ? chipStill : chip}><span className={styles.chipLabel}>{item.label}</span></motion.span></motion.span>)}
          {remaining > 0 && <motion.span key="more" className={styles.slot} variants={reduce ? slotFade : slot} initial="hidden" animate="shown" exit="gone"><motion.span className={styles.more} variants={reduce ? chipStill : chip}>+<span className={styles.count}><AnimatePresence initial={false} custom={countDirection}><motion.span key={remaining} custom={countDirection} variants={reduce ? fade : roll} initial="hidden" animate="shown" exit="gone">{remaining}</motion.span></AnimatePresence></span></motion.span></motion.span>}
          {!selected.length && <motion.span key="placeholder" className={styles.placeholder} variants={fade} initial="hidden" animate="shown" exit="gone">{placeholder}</motion.span>}
        </AnimatePresence>
      </span>
      <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
    </button></PopoverPrimitive.Trigger>
    <span ref={measureRef} className={styles.measure} aria-hidden="true">{measured.map(item => <span key={item.value} className={styles.chip} data-measure-chip><span className={styles.chipLabel}>{item.label}</span></span>)}<span className={styles.more} data-measure-more>+{selected.length}</span></span>
    <AnimatePresence initial={false}>{selected.length > 0 && !disabled && <motion.button type="button" aria-label="Clear selections" className={styles.clear} onClick={clear}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast } } }}
      exit={{ opacity: 0, ...(reduce ? {} : { scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }), transition: { duration: motionTokens.duration.instant, ease: standard } }}
      whileTap={{ scale: reduce ? 1 : 0.96, transition: { duration: motionTokens.duration.instant, ease: standard } }}><X size={14} aria-hidden="true" /></motion.button>}</AnimatePresence>
    <AnimatePresence initial={false}>
      {open && <PopoverPrimitive.Portal forceMount><PopoverPrimitive.Content asChild forceMount align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); if (searchable) menuRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); changeOpen(false); triggerRef.current?.focus(); }}><motion.div ref={menuRef} data-arc-select-open className={styles.menu} aria-label={ariaLabel || label} onKeyDown={onKeyDown}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: .97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: reduce ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast, ease: enter } } }}
        exit={{ opacity: 0, ...(reduce ? {} : { y: -4, scale: .98 }), transition: { duration: motionTokens.duration.instant, ease: standard } }}>
        {searchable && <Input label="" aria-label="搜索选项" placeholder={allowCreate ? "搜索或输入新值…" : "搜索…"} value={query} onChange={event => { setQuery(event.target.value); onSearch?.(event.target.value); setActiveIndex(-1); }} onKeyDown={event => { if (event.key === "Enter" && canCreate && activeIndex < 0) { event.preventDefault(); event.stopPropagation(); toggle({ value: query.trim(), label: query.trim() }); setQuery(""); } }} />}
        <div id={`${id}-listbox`} className={styles.options} role="listbox" aria-label={ariaLabel || label} aria-multiselectable="true">
        {!choices.length && <div className={styles.description}>没有匹配项</div>}
        {choices.map((option, index) => <button ref={node => { optionRefs.current[option.value] = node; }} type="button" role="option" aria-selected={selectedSet.has(option.value)} aria-disabled={option.disabled || undefined} key={option.value} className={styles.option} data-active={activeIndex === index} disabled={option.disabled} onPointerMove={() => { if (activeIndex !== index) setActiveIndex(index); }} onClick={() => toggle(option)}>
          <span>{option.label}</span><AnimatePresence initial={false}>{selectedSet.has(option.value) && <CheckMark key="check" reduce={reduce} />}</AnimatePresence>
        </button>)}
        </div>
      </motion.div></PopoverPrimitive.Content></PopoverPrimitive.Portal>}
    </AnimatePresence>
    </div>
    {description && <span className={styles.description}>{description}</span>}
  </div></PopoverPrimitive.Root>;
}
