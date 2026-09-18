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
