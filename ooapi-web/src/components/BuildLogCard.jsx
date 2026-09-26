import React, { useEffect, useRef, useState } from "react";
import { ToolOutlined } from "@ant-design/icons";
import { API } from "../services/api";

// 「平台修复进度」小盒子（社区页右侧栏，热门讨论上面）。
// 布局优先级按用户指令（2026-09-26）：**流式对话是主角**，待办/调用各只显示 3 条。
// 数据来自公开接口 GET /api/buildlog：tasks / calls / cc（since_bytes 游标 + mtime）。
// cc.mtime 超过 15 分钟没动 → 如实标「空闲中」，不装作还在直播。
function relTime(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const STATUS_STYLE = {
  done: { text: "已完成", color: "var(--ok, #52c41a)" },
  doing: { text: "进行中", color: "var(--accent, #1677ff)" },
  todo: { text: "待处理", color: "var(--ink-3, #999)" },
  blocked: { text: "受阻", color: "#d4380d" },
};

const CC_BUF_MAX = 24000;
const CC_FAST_MS = 3000;
const CC_IDLE_MS = 15 * 60 * 1000; // mtime 超过 15 分钟视为空闲

export default function BuildLogCard() {
  const [data, setData] = useState(null);
  const [ccText, setCcText] = useState("");
  const [ccMeta, setCcMeta] = useState({ alive: false, idle: true, mtime: 0 });
  const ccCursor = useRef(0);
  const ccBox = useRef(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;

    const appendCc = (r) => {
      const cc = r?.cc;
      if (!cc) {
        setCcMeta((m) => ({ ...m, alive: false }));
        return;
      }
      if (cc.cursor < ccCursor.current && cc.cursor === 0 && cc.size > 0) setCcText("");
      if (cc.chunk) {
        setCcText((prev) => (prev + (prev && !prev.endsWith("\n") ? "\n" : "") + cc.chunk).slice(-CC_BUF_MAX));
      }
      ccCursor.current = cc.cursor;
      setCcMeta({ alive: true, idle: cc.mtime > 0 && Date.now() / 1000 - cc.mtime > CC_IDLE_MS / 1000, mtime: cc.mtime });
    };

    const tick = async () => {
      if (stopped.current) return;
      try {
        const r = await API.get(`/buildlog?cc_since=${ccCursor.current}`);
        if (stopped.current) return;
        setData(r || null);
        appendCc(r);
      } catch {
        /* 网络抖动：下一轮再试 */
      }
    };

    tick();
    const timer = setInterval(tick, CC_FAST_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const el = ccBox.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [ccText]);

  if (!data) return null;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const calls = data.calls || [];
  if (!tasks.length && !calls.length && !ccMeta.alive) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done");
  const openShown = open.slice(0, 3); // 用户指令：待办一次 3 条就够

  return (
    <div className="oo-aside-card">
      <div className="oo-section-title" style={{ marginBottom: 6 }}>
        <ToolOutlined /> 平台修复进度
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)", fontWeight: 400 }}>
          {data.updated_at ? `更新于 ${relTime(data.updated_at)}` : ""}
        </span>
      </div>

      {/* 流式对话是主角，放最上面 */}
      {ccMeta.alive && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 3 }}>
            修复进程对话（Claude Code）·{" "}
            {ccMeta.idle ? (
              <span style={{ color: "#d4380d" }}>空闲中{ccMeta.mtime ? `（上次活动 ${relTime(ccMeta.mtime)}）` : ""}</span>
            ) : (
              <span style={{ color: "var(--ok, #52c41a)" }}>● 实时</span>
            )}
          </div>
          <pre
            ref={ccBox}
            style={{
              margin: 0,
              padding: "6px 8px",
              maxHeight: 220,
              overflowY: "auto",
              background: "var(--gray-3, #1f1f1f)",
              color: "#d6e4ff",
              borderRadius: 6,
              fontSize: 11,
              lineHeight: "16px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
            }}
          >
            {ccText || "…"}
          </pre>
        </div>
      )}

      {tasks.length > 0 && (
        <div style={{ fontSize: 12.5, marginBottom: 4 }}>
          <span className="oo-num" style={{ fontWeight: 600, color: "var(--accent-ink)" }}>{done}</span>
          <span style={{ color: "var(--ink-3)" }}> / {tasks.length} 项已完成</span>
        </div>
      )}
      {openShown.map((t) => {
        const st = STATUS_STYLE[t.status] || STATUS_STYLE.todo;
        return (
          <div key={t.id} style={{ display: "flex", gap: 6, padding: "2px 0", fontSize: 12.5, alignItems: "baseline" }}>
            <span className="oo-num" style={{ flexShrink: 0, color: "var(--ink-3)", fontSize: 11 }}>{t.id}</span>
            <span className="oo-truncate" style={{ flex: 1 }}>{t.title}</span>
            <span style={{ flexShrink: 0, fontSize: 11, color: st.color }}>{st.text}</span>
          </div>
        );
      })}
      {open.length > openShown.length && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", padding: "1px 0" }}>
          还有 {open.length - openShown.length} 项待处理…
        </div>
      )}

      {calls.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px dashed var(--line, #eee)", paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>平台维护调用</div>
          {calls.slice(0, 3).map((c, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "var(--ink-2, #555)", padding: "1px 0", display: "flex", gap: 6 }}>
              <span className="oo-truncate" style={{ flex: 1 }}>
                <span style={{ color: c.ok ? "inherit" : "#d4380d" }}>{c.model || "调用"}</span>
                {" "}{c.prompt_tokens}/{c.completion_tokens} tok
              </span>
              <span className="oo-num" style={{ flexShrink: 0, color: "var(--ink-3)" }}>
                {c.od ? `${c.od.toFixed(4)} OD` : "—"} · {relTime(c.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
