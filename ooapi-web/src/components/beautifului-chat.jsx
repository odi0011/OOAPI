// Beautiful UI 原语（第二批）—— 对话页重构新增
// ---------------------------------------------------------------------------
// 同样是 https://www.beautifului.dev/ 的原语移植（MIT, Copyright (c) 2026 Shane Levine），
// 与 beautifului.jsx 保持同一套约定：Tailwind 工具类 → 本项目 OKLCH 语义 token，
// 演示数据 → 真实数据。这一批对应站点上的：
//   · Sidebar Nav       → Shelf / ShelfGroup / ShelfItem（可折叠、hover 高亮）
//   · Tool Chips        → ToolChips（工具调用以小圆点 + 名称 + 耗时呈现）
//   · Approval Card     → Notice（需要用户知晓/确认的一件事）
//   · Recommendation    → SuggestionCard（欢迎页建议卡）
//   · Records/Insight   → TodoPanel（会话待办清单，todowrite 工具产出）
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// 兜底名称：/meta 未返回某个工具时也不要在界面上暴露原始 id
const TOOL_FALLBACK_NAMES = {
  search: "联网检索",
  fetch: "读取网页",
  github: "读 GitHub",
  task: "派发子代理",
  todowrite: "待办清单",
};

const TickIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/* ============================ Shelf（侧栏导航） ============================ */
// 结构：可折叠分组 + 行。行的 padding 固定，选中态是「整行背景」而不是左边框，
// 悬停时图标轻微位移（原站 sidebar-nav 的 micro-interaction）。
export function Shelf({ children, className = "" }) {
  return <nav className={`bui-shelf ${className}`}>{children}</nav>;
}

export function ShelfGroup({ title, children, defaultOpen = true, action }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bui-shelf-group">
      <div className="bui-shelf-group-head">
        <button
          type="button"
          className="bui-shelf-group-btn"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 200ms" }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span>{title}</span>
        </button>
        {action}
      </div>
      <div className={`bui-collapse ${open ? "is-open" : "is-closed"}`}>
        <div className="inner">
          <div className="bui-shelf-rows">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function ShelfItem({ active, icon, label, hint, onClick, actions, onRename, title }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== label) onRename?.(next);
  };

  if (editing) {
    return (
      <div className="bui-shelf-row is-editing">
        <input
          ref={inputRef}
          className="bui-shelf-input"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(label);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`bui-shelf-row ${active ? "is-active" : ""}`} title={title || label}>
      <button
        type="button"
        className="bui-shelf-item"
        aria-current={active ? "true" : undefined}
        onClick={onClick}
        onDoubleClick={() => onRename && setEditing(true)}
      >
        {icon ? <span className="ic">{icon}</span> : null}
        <span className="lb">{label}</span>
        {hint ? <span className="hn">{hint}</span> : null}
      </button>
      {actions ? <div className="bui-shelf-actions">{actions}</div> : null}
    </div>
  );
}

/* ============================ ToolChips（工具调用） ============================ */
// 原站是「一次 run 里的若干工具调用」压缩成小 chip；这里点击可展开原始输出。
export function ToolChips({ calls = [], className = "" }) {
  const [open, setOpen] = useState(null);
  if (!calls.length) return null;
  return (
    <div className={`bui-toolchips ${className}`}>
      {calls.map((c, i) => {
        const expanded = open === i;
        return (
          <div key={c.id || i} className={`bui-toolchip ${expanded ? "is-open" : ""}`}>
            <button
              type="button"
              className={`bui-toolchip-head st-${c.status || "done"}`}
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : i)}
            >
              <span className="dot" />
              <span className="nm">{c.name || c.tool}</span>
              {c.status === "running" ? <span className="bui-mini-spinner" /> : null}
              {c.ms ? <span className="ms">{c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}</span> : null}
              <svg className="cv" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div className={`bui-collapse ${expanded ? "is-open" : "is-closed"}`}>
              <div className="inner">
                <pre className="bui-toolchip-body">{c.output || (c.status === "running" ? "执行中…" : "（无输出）")}</pre>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================ Notice（Approval Card 形态） ============================ */
export function Notice({ tone = "info", title, children, actions }) {
  return (
    <div className={`bui-notice is-${tone}`}>
      <span className="mark" aria-hidden>
        {tone === "warn" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8h.01M11 12h1v4h1" />
          </svg>
        )}
      </span>
      <div className="bd">
        {title ? <strong>{title}</strong> : null}
        <div className="tx">{children}</div>
      </div>
      {actions ? <div className="ac">{actions}</div> : null}
    </div>
  );
}

/* ============================ SuggestionCard（Recommendation Card） ============================ */
export function SuggestionCard({ icon, title, desc, onClick }) {
  return (
    <button type="button" className="bui-suggest" onClick={onClick}>
      <span className="ic">{icon}</span>
      <span className="tx">
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
      <span className="arw" aria-hidden>↗</span>
    </button>
  );
}

/* ============================ TodoPanel（待办清单） ============================ */
export function TodoPanel({ todo = [], className = "" }) {
  if (!todo.length) return null;
  const done = todo.filter((t) => t.status === "completed").length;
  return (
    <div className={`bui-todos ${className}`}>
      <div className="bui-todos-head">
        <span className="bui-todos-title">任务清单</span>
        <span className="bui-todos-count">
          {done}/{todo.length}
        </span>
      </div>
      <div className="bui-todos-bar" aria-hidden>
        <span style={{ width: `${Math.round((done / todo.length) * 100)}%` }} />
      </div>
      <ul className="bui-todos-list">
        {todo.map((t, i) => (
          <li key={i} className={`is-${t.status}`}>
            <span className="mk" aria-hidden>
              {t.status === "completed" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : t.status === "in_progress" ? (
                <span className="bui-mini-spinner" />
              ) : null}
            </span>
            <span className="tx">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================ OrchestrationBar（智能体编排栏） ============================ */
// 对话页顶部的一行编排控件：智能体 / 模型 / 思考 / 联网 / 工具 / 步数 / 会话指令。
export function OrchestrationBar({ agent, agents, settings, tools, onAgent, onSetting, onOpenInstructions, disabled, modelCaps, keys = [], keyId = 0, onKey }) {
  const [openMenu, setOpenMenu] = useState(null);
  const rootRef = useRef(null);
  const caps = modelCaps || {};
  const activeTools = settings.tools ?? agent?.tools ?? [];

  useEffect(() => {
    if (!openMenu) return undefined;
    const close = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openMenu]);

  const menu = (key, items, onPick) =>
    openMenu === key ? (
      <div className="bui-orch-menu">
        {items.map((it) => (
          <button
            key={it.value}
            type="button"
            className={`bui-upmenu-row is-model ${it.value === it.current ? "is-on" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpenMenu(null);
              onPick(it.value);
            }}
          >
            <span className="nm">{it.label}</span>
            <span className={`tick ${it.value === it.current ? "" : "is-off"}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="bui-orch" ref={rootRef}>
      <div className="bui-orch-slot">
        <button
          type="button"
          className="bui-orch-btn is-agent"
          disabled={disabled}
          aria-expanded={openMenu === "agent"}
          onClick={() => setOpenMenu(openMenu === "agent" ? null : "agent")}
        >
          <span className="k">智能体</span>
          <span className="v">{agent?.name || "选择"}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {menu(
          "agent",
          agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.desc}`, current: agent?.id })),
          onAgent
        )}
      </div>

      <span className="bui-orch-sep" />

      {/* 密钥：站内对话扣账户额度，但路由配置挂在密钥上（分组决定可用模型与计费倍率），
          所以要能在这里选。0 = 账户默认分组。 */}
      <div className="bui-orch-slot">
        <button
          type="button"
          className="bui-orch-btn is-key"
          disabled={disabled || !keys.length}
          aria-expanded={openMenu === "key"}
          title={keys.length ? "选择用于本次对话的密钥（决定可用模型与计费分组）" : "还没有创建密钥，可在「令牌管理」里新建"}
          onClick={() => setOpenMenu(openMenu === "key" ? null : "key")}
        >
          <span className="k">密钥</span>
          <span className="v">{keys.find((k) => k.id === keyId)?.name || "账户默认"}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {openMenu === "key" ? (
          <div className="bui-orch-menu is-key">
            <button
              type="button"
              className={`bui-upmenu-row is-model ${keyId === 0 ? "is-on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpenMenu(null);
                onKey?.(0);
              }}
            >
              <span className="nm">账户默认</span>
              <span className="ds">按用户分组路由</span>
              <span className={`tick ${keyId === 0 ? "" : "is-off"}`}>{TickIcon}</span>
            </button>
            {keys.map((k) => (
              <button
                key={k.id}
                type="button"
                className={`bui-upmenu-row is-model ${k.id === keyId ? "is-on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpenMenu(null);
                  onKey?.(k.id);
                }}
              >
                <span className="nm">{k.name}</span>
                <span className="ds">
                  {k.group ? k.group : "未绑定分组"}
                  {k.status !== 1 ? " · 已停用" : ""}
                </span>
                <span className={`tick ${k.id === keyId ? "" : "is-off"}`}>{TickIcon}</span>
              </button>
            ))}
            <div className="bui-upmenu-foot">密钥的分组决定可用模型、渠道与计费倍率</div>
          </div>
        ) : null}
      </div>

      <span className="bui-orch-sep" />

      {caps.supportsThinking !== false ? (
        <button
          type="button"
          className={`bui-orch-toggle ${settings.thinking ? "is-on" : ""}`}
          disabled={disabled}
          aria-pressed={Boolean(settings.thinking)}
          onClick={() => onSetting("thinking", !settings.thinking)}
        >
          思考
        </button>
      ) : null}
      {caps.supportsSearch !== false ? (
        <button
          type="button"
          className={`bui-orch-toggle ${settings.search ? "is-on" : ""}`}
          disabled={disabled}
          aria-pressed={Boolean(settings.search)}
          onClick={() => onSetting("search", !settings.search)}
        >
          联网
        </button>
      ) : null}

      <div className="bui-orch-slot">
        <button
          type="button"
          className="bui-orch-btn is-tools"
          disabled={disabled}
          aria-expanded={openMenu === "tools"}
          onClick={() => setOpenMenu(openMenu === "tools" ? null : "tools")}
        >
          <span className="k">能力</span>
          <span className="v">
            {activeTools.length
              ? activeTools.map((id) => tools.find((t) => t.id === id)?.name || TOOL_FALLBACK_NAMES[id] || id).join("·")
              : "全关"}
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {openMenu === "tools" ? (
          <div className="bui-orch-menu is-tools">
            {tools.map((t) => {
              const on = activeTools.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className="bui-orch-tool"
                  aria-pressed={on}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    onSetting("tools", on ? activeTools.filter((x) => x !== t.id) : [...activeTools, t.id])
                  }
                >
                  <span className="tx">
                    <strong>{t.name}</strong>
                    <small>{t.desc}</small>
                  </span>
                  <span className={`sw ${on ? "is-on" : ""}`} aria-hidden />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <span className="bui-orch-sep" />

      <label className="bui-orch-steps" title="一轮对话里最多调用几次模型（含工具往返）">
        步数
        <input
          type="number"
          min={1}
          max={16}
          value={settings.maxSteps || 6}
          disabled={disabled}
          onChange={(e) => onSetting("maxSteps", Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
        />
      </label>

      <span className="bui-orch-sep" />

      <button
        type="button"
        className={`bui-orch-btn is-sys ${String(settings.instructions || "").trim() ? "is-on" : ""}`}
        disabled={disabled}
        onClick={onOpenInstructions}
        title="会话级系统提示词：只影响这个会话"
      >
        <span className="k">指令</span>
        <span className="v">{String(settings.instructions || "").trim() ? "已设" : "未设"}</span>
      </button>
    </div>
  );
}
