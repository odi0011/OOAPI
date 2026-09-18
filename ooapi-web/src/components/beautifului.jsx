// Beautiful UI 原语 —— 移植自 https://www.beautifului.dev/
// ---------------------------------------------------------------------------
// 来源：该库站点发布的组件源码（MIT License, Copyright (c) 2026 Shane Levine）。
// 授权允许复制、修改、再分发；此处保留其视觉与交互设计，仅做两处适配：
//   1. Tailwind 工具类 → 本项目 OKLCH 语义 token（见 components/beautifului.css）；
//   2. 演示用的假序列（STAGES/TICKS/TOKENS）→ 真实流式数据。
//
// 移植时刻意保留的原始设计细节：
//   · LoaderGrid 的 4px/1.5px 像素网格与 chevron 延迟 90ms×n
//   · thinking 头部「shimmer 扫光文字」与 grid-template-rows 折叠动画
//   · 轨迹左侧竖线随内容高度过渡
//   · 正文光标为 2px 圆角条
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ModelLabel } from "./VendorIcon";
import "./beautifului.css";

/* ============================ LoaderGrid ============================ */
// 9 格像素网格。chevron 图案：按 (列 + |行-1|) × 90ms 错峰点亮。
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

export function LoaderGrid({ delays = CHEVRON_DELAYS, dur = 650, round = false }) {
  return (
    <span aria-hidden className="bui-loader-grid">
      {delays.map((delay, i) => (
        <span
          key={i}
          className={round ? "is-round" : "is-square"}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `bui-pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/* ============================ LoadingState ============================ */
// 「正在做什么」的等待态：像素网格 + 扫光文字 + 已用时。
export function LoadingState({ label = "处理中", showElapsed = true, startedAt }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!showElapsed) return undefined;
    const t0 = startedAt || Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 200);
    return () => clearInterval(id);
  }, [showElapsed, startedAt]);

  return (
    <div role="status" className="bui-loading">
      <LoaderGrid />
      <span className="bui-shimmer-label">{label}</span>
      {showElapsed && elapsed > 0 ? <span className="bui-elapsed">{elapsed}s</span> : null}
    </div>
  );
}

/* ============================ ThinkingState ============================ */
/**
 * 思考轨迹。
 *   working=true   → 头部扫光显示 activeTitle，轨迹自动展开、当前步骤转圈
 *   working=false  → 头部显示 doneTitle，轨迹自动收起（用户仍可手动展开）
 *
 * defaultExpanded 默认为 null 是**有意**的：null 表示「跟随工作状态自动展开/收起」，
 * 传 true/false 才会固定住。若默认传 false，就会把工作中的轨迹强行折叠起来。
 *
 * @param {Array} steps [{ title, content?, status: "pending"|"running"|"done" }]
 */
export function ThinkingState({
  steps = [],
  working = false,
  activeTitle = "正在思考",
  doneTitle = "已完成思考",
  icon,
  variant = "Steps",
  defaultExpanded = null,
}) {
  const [manualExpanded, setManualExpanded] = useState(defaultExpanded);
  const autoExpanded = working;
  const expanded = manualExpanded === null ? autoExpanded : manualExpanded;

  const traceRef = useRef(null);
  const [lineHeight, setLineHeight] = useState(0);

  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [steps, expanded, working, variant]);

  // 真实思考链只有一段文本，不需要「标题 + 正文」两行；
  // Steps 变体展示步骤标题，Reasoning 变体直接展示内容本身。
  const isReasoning = variant === "Reasoning";
  const rows = isReasoning
    ? steps.filter((s) => s && (s.content || s.title)).map((s) => ({ text: s.content || s.title }))
    : steps.filter((s) => s && (s.title || s.content));

  return (
    <div className="bui-thinking">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded(!(manualExpanded ?? autoExpanded))}
        className="bui-thinking-head"
      >
        {icon ? (
          <span className="spark" style={{ color: working ? "var(--ink-2)" : "var(--ink-3)" }}>
            {icon}
          </span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"}>
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        )}
        <span role="status" style={{ display: "contents" }}>
          {working ? (
            <span className="bui-shimmer-label">{activeTitle}</span>
          ) : (
            <span className="bui-thinking-label is-done">{doneTitle}</span>
          )}
        </span>
        <svg
          className="bui-thinking-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className={`bui-collapse ${expanded ? "is-open" : "is-closed"}`}>
        <div className="inner">
          <div className="bui-trace">
            <span
              aria-hidden
              className="bui-trace-line"
              style={{ height: lineHeight ? lineHeight - 2 : 0 }}
            />
            <div ref={traceRef} className="bui-trace-rows">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className="bui-trace-row"
                  style={{ alignItems: isReasoning ? "flex-start" : "center" }}
                >
                  {isReasoning ? null : variant === "Search" ? (
                    <span className={`bui-mini-dot t${i % 3}`} />
                  ) : row.status === "running" ? (
                    <span className="bui-mini-spinner" />
                  ) : (
                    <svg
                      className="bui-mini-check"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                  <span className={`primary ${isReasoning ? "is-wrap" : ""}`}>
                    {isReasoning ? row.text : row.title || row.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ StreamingText ============================ */
const ACTION_ICONS = [
  <React.Fragment key="a">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </React.Fragment>,
  <React.Fragment key="b">
    <path d="M20 6L9 17l-5-5" />
  </React.Fragment>,
  <React.Fragment key="c">
    <path d="M12 20V10M18 20V4M6 20v-4" />
  </React.Fragment>,
];

/**
 * 流式正文。只负责「正文 + 光标 + 完成后的操作行」，
 * Markdown 渲染由调用方通过 children 传入（我们已有 Markdown 组件）。
 */
export function StreamingText({ streaming, children, actions = ACTION_ICONS, onAction }) {
  return (
    <div>
      <div className="bui-stream-text">
        {children}
        {streaming ? <span className="bui-caret" /> : null}
      </div>

      <div
        className="bui-stream-actions"
        style={{ opacity: streaming ? 0 : 1, pointerEvents: streaming ? "none" : "auto" }}
      >
        {actions.map((icon, i) => (
          <button
            key={i}
            type="button"
            aria-label="操作"
            className="bui-icon-action"
            onClick={() => onAction?.(i)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {icon}
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============================ TaskRows ============================ */
export function TaskRows({ rows = [], variant = "Capsules", className = "", onToggle }) {
  const [manualOpen, setManualOpen] = useState({});
  const list = variant === "List";

  return (
    <div className={`bui-taskrows ${list ? "is-list" : "is-capsules"} ${className}`}>
      {rows.map((row, i) => {
        const open = manualOpen[row.key] ?? false;
        return (
          <div
            key={row.key}
            className={`bui-taskrow ${list ? "is-list" : "is-capsules"}`}
            style={{
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `bui-fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
            }}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setManualOpen((c) => ({ ...c, [row.key]: !open }));
                onToggle?.(row.key, !open);
              }}
              className="bui-taskrow-head"
            >
              <span className="bui-taskrow-badge">
                {row.status === "done" ? (
                  <span className="bui-pill is-green" style={{ padding: 0, width: 22, justifyContent: "center", height: 22 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                ) : row.status === "running" ? (
                  <span className="bui-mini-spinner" />
                ) : (
                  <span className="spinner-idle" style={{ width: 12, height: 12, borderRadius: 999, border: "1.5px solid var(--line-strong)", display: "block" }} />
                )}
              </span>
              <span className="bui-taskrow-label">{row.label}</span>
              {row.amount ? <span className="bui-taskrow-amount">{row.amount}</span> : null}
              {row.status === "done" ? (
                <span className="bui-pill is-green">已完成</span>
              ) : row.status === "failed" ? (
                <span className="bui-pill is-red">失败</span>
              ) : null}
            </button>

            <div className={`bui-collapse ${open ? "is-open" : "is-closed"}`}>
              <div className="inner">
                <div className="bui-taskrow-body">{row.content || <span className="oo-muted">暂无输出</span>}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================ Dot ============================ */
export function Dot({ tone = 0 }) {
  return <span className={`bui-mini-dot t${tone % 3}`} />;
}

/* ============================ PromptBar ============================ */
/**
 * 输入框（PromptBar）—— 移植自 beautifului.dev 的 PromptBar（MIT, Shane Levine）。
 *
 * 保留的原始设计：
 *   · 控制行用 grid，窄态一行放齐、宽态（换行 / 文本超长）输入独占一行、控件下移
 *   · 输入框按内容自增高（上限 100px），超出才出现滚动条
 *   · 模型/命令菜单从输入框**上沿**向上弹出
 *   · 菜单高亮是「单块滑动」而不是每行各自变色
 *   · 按钮 28px 方形，按下 scale(0.94)
 */
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const SendIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const StopIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
const MicIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
  </svg>
);
const ImageIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);
const BulbIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
  </svg>
);
const GlogoIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </svg>
);
const ChevronIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const TickIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/**
 * @param {object} props
 * @param {string} props.value 受控文本
 * @param {Function} props.onChange
 * @param {Function} props.onSend
 * @param {Function} [props.onStop] 有值且 busy 时显示停止按钮
 * @param {boolean} [props.busy]
 * @param {Array} props.models [{ id, label, vision }]
 * @param {string} props.model
 * @param {Function} props.onModelChange
 * @param {Array} [props.chips] 已附加的图片 [{ src, label }]
 * @param {Function} [props.onRemoveChip]
 * @param {Function} [props.onPickImage]
 * @param {boolean} [props.visionOk] 当前模型是否支持图片
 * @param {Array} [props.toggles] [{ key, label, icon, on, onClick, title }]
 * @param {string} [props.placeholder]
 * @param {boolean} [props.disabled]
 * @param {Array} [props.commands] 输入 / 时弹出的命令 [{ key, name, desc, run }]
 * @param {React.Ref} [props.textareaRef]
 */
export function PromptBar({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  models = [],
  model,
  onModelChange,
  chips = [],
  onRemoveChip,
  onPickImage,
  visionOk = false,
  toggles = [],
  placeholder = "输入你的问题，或分享一个想法…",
  disabled = false,
  moreDisabled = false,
  commands = [],
  textareaRef,
}) {
  const innerRef = useRef(null);
  const taRef = textareaRef || innerRef;
  const measureRef = useRef(null);
  const rowRef = useRef(null);
  const [wide, setWide] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);

  const canSend = !disabled && (value.trim().length > 0 || chips.length > 0);

  // 与原始实现一致：用隐藏的 span 量文字宽度，超过输入位宽或含换行就切宽态
  useLayoutEffect(() => {
    const ta = taRef.current;
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!ta || !row || !measure) return;

    const modelBtnW = row.querySelector(".bui-modelbtn")?.offsetWidth || 0;
    const fixed = 28 * 3 + modelBtnW;
    const gaps = 4 * 4;
    const inlineWidth = row.clientWidth - fixed - gaps;
    const needWide = value.includes("\n") || (measure.offsetWidth + 8 > inlineWidth && inlineWidth > 0);
    if (needWide !== wide) setWide(needWide);

    const minH = 28;
    const maxH = 100;
    ta.style.height = "0px";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(Math.max(h, minH), maxH)}px`;
    ta.style.overflowY = h > maxH ? "auto" : "hidden";
  }, [value, wide, taRef]);

  // 点到外面就关菜单
  useEffect(() => {
    if (!modelOpen && !cmdOpen) return undefined;
    const close = (e) => {
      if (!e.target.closest?.("[data-promptbar]")) {
        setModelOpen(false);
        setCmdOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen, cmdOpen]);

  // 输入 / 开头即打开命令菜单（原库的 slash 用法）
  useEffect(() => {
    if (commands.length && value.startsWith("/") && !value.includes(" ")) setCmdOpen(true);
    else if (!value.startsWith("/")) setCmdOpen(false);
  }, [value, commands.length]);

  // 对话编辑器固定为「正文在上、工具栏在下」的两行结构，避免输入区
  // 因文字长度在两种形态之间跳动，视觉上更接近桌面端编辑器。
  const sizeClass = "is-wide";

  return (
    <div className="bui-promptbar" data-promptbar>
      <div style={{ position: "relative" }}>
        {/* 命令菜单：从输入框上沿向上弹出 */}
        {cmdOpen && commands.length > 0 ? (
          <div className="bui-upmenu">
            {commands
              .filter((c) => c.name.toLowerCase().includes(value.slice(1).toLowerCase()))
              .map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="bui-upmenu-row"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setCmdOpen(false);
                    c.run?.();
                  }}
                >
                  <span className="nm">/{c.name}</span>
                  <span className="ds">{c.desc}</span>
                </button>
              ))}
            <div className="bui-upmenu-foot">输入以筛选命令</div>
          </div>
        ) : null}

        {/* 模型菜单 */}
        {modelOpen ? (
          <div className="bui-upmenu is-model">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                className="bui-upmenu-row is-model"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onModelChange?.(m.id);
                  setModelOpen(false);
                  taRef.current?.focus();
                }}
              >
                <span className="nm">{m.label || m.id}</span>
                <span className={`tick ${m.id === model ? "" : "is-off"}`}>{TickIcon}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="bui-composer">
          {chips.length > 0 ? (
            <div className="bui-chips">
              {chips.map((c, i) => (
                <span key={`${c.label}-${i}`} className="bui-chip-file">
                  {c.src ? <img src={c.src} alt="" /> : null}
                  <span className="nm">{c.label}</span>
                  <button type="button" aria-label={`移除 ${c.label}`} onClick={() => onRemoveChip?.(i)}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          {/* 量文字宽度用的隐藏 span（原实现同名） */}
          <span
            ref={measureRef}
            aria-hidden
            style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", whiteSpace: "pre", fontSize: 13, lineHeight: "18px" }}
          >
            {value}
          </span>

          <div ref={rowRef} className={`bui-composer-row ${sizeClass}`}>
            {onPickImage ? (
              <button
                type="button"
                aria-label="添加图片"
                title={visionOk ? "添加图片，最多 3 张" : "当前模型不支持图片"}
                disabled={!visionOk || busy}
                onClick={onPickImage}
                className="bui-cbtn is-wide-plus"
              >
                {ImageIcon}
              </button>
            ) : (
              <button
                type="button"
                aria-label="更多"
                title={moreDisabled ? "当前模式暂不支持附件" : "更多"}
                disabled={moreDisabled || disabled || busy}
                className="bui-cbtn is-wide-plus"
              >
                {PlusIcon}
              </button>
            )}

            <textarea
              ref={taRef}
              rows={1}
              value={value}
              aria-label="消息内容"
              disabled={disabled}
              placeholder={busy ? "正在生成…" : placeholder}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (cmdOpen && (e.key === "Escape" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  setCmdOpen(false);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  if (canSend) onSend?.();
                }
              }}
              className={`bui-composer-input ${sizeClass}`}
            />

            <button
              type="button"
              aria-label="选择模型"
              aria-expanded={modelOpen}
              disabled={busy}
              onClick={() => {
                setCmdOpen(false);
                setModelOpen((c) => !c);
              }}
              className={`bui-modelbtn ${sizeClass}`}
            >
              <ModelLabel model={model || "选择模型"} size={15} />
              <span className="caret">{ChevronIcon}</span>
            </button>

            {toggles.map((t, i) => (
              <button
                key={t.key}
                type="button"
                aria-label={t.title || t.label}
                title={t.title || t.label}
                aria-pressed={t.on}
                disabled={busy}
                onClick={t.onClick}
                className={`bui-cbtn ${t.on ? "is-accent" : ""} ${i === 0 ? "is-wide-a" : "is-wide-b"}`}
              >
                {t.icon}
              </button>
            ))}

            {busy ? (
              <button
                type="button"
                aria-label="停止生成"
                onClick={onStop}
                className="bui-cbtn is-stop is-wide-send"
              >
                {StopIcon}
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送消息"
                disabled={!canSend}
                onClick={() => onSend?.()}
                className="bui-cbtn is-send is-wide-send"
              >
                {SendIcon}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
