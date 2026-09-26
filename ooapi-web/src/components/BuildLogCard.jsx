import React, { useEffect, useRef, useState } from "react";
import { ToolOutlined } from "@ant-design/icons";
import { API } from "../services/api";

// 「平台修复进度」小盒子（社区页右侧栏，热门讨论上面）。
//
// 用户要求（2026-09-26 原话）：「直接做一个窗口……显示实时进度，待办清单，
// 每次有api调用，就实时显示那条记录出来，给用户展示的」，随后补充：
// 「需要实时流式的回显Claude code的对话消息，所有」。
//
// 数据来自公开接口 GET /api/buildlog（见 routes/buildlog.js）：
//   · tasks —— 待办清单与状态（监工脚本维护 options.buildlog_state）
//   · calls —— 平台自己维护流量（测试人群 fb4* / 修复进程 cc*）的最新调用记录
//   · cc    —— Claude Code 运行日志的增量文本（since_bytes 游标，3s 轮询逼近流式）
// 敏感字段后端就不返回；密钥类字符串在服务端出口已打码（sk-*** / password=***）。
//
// 轮询频率：任务与调用 15s 足够；对话回显要「实时感」，单独 3s 一拍。
// 组件自身加载失败时静默隐藏 —— 公示是锦上添花，不能因为它把侧栏搞挂。
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

const CC_BUF_MAX = 24000; // 对话缓冲上限（字符）：防止页面常驻内存无限涨
const CC_FAST_MS = 3000;
const CC_SLOW_MS = 15000;

export default function BuildLogCard() {
  const [data, setData] = useState(null);
  const [ccText, setCcText] = useState("");
  const [ccAlive, setCcAlive] = useState(false);
  const ccCursor = useRef(0);
  const ccBox = useRef(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;

    const appendCc = (r) => {
      const cc = r?.cc;
      setCcAlive(Boolean(cc));
      if (!cc) return;
      // 服务端按 since_bytes 回增量；乱序/重置（日志轮换）时从头重建缓冲
      if (cc.cursor < ccCursor.current || cc.chunk === "") {
        if (cc.cursor === 0 && cc.size > 0) setCcText("");
      }
      if (cc.chunk) {
        setCcText((prev) => {
          const next = (prev + (prev && !prev.endsWith("\n") ? "\n" : "") + cc.chunk).slice(-CC_BUF_MAX);
          return next;
        });
      }
      ccCursor.current = cc.cursor;
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
    // 对话回显 3s 一拍；任务/调用数据搭同一趟车（接口一次全返回），
    // 比起拆两个接口，多拉的几百字节换来的是实现简单。
    const timer = setInterval(tick, CC_FAST_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, []);

  // 新内容到达时贴底（用户手动上翻就不打扰 —— 记录滚动位置判断）
  useEffect(() => {
    const el = ccBox.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [ccText]);

  if (!data) return null;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const calls = data.calls || [];
  if (!tasks.length && !calls.length && !ccAlive) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done").slice(0, 6);

  return (
    <div className="oo-aside-card">
      <div className="oo-section-title" style={{ marginBottom: 6 }}>
        <ToolOutlined /> 平台修复进度
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)", fontWeight: 400 }}>
          {data.updated_at ? `更新于 ${relTime(data.updated_at)}` : ""}
        </span>
      </div>

      {tasks.length > 0 && (
        <div style={{ fontSize: 12.5, marginBottom: 6 }}>
          <span className="oo-num" style={{ fontWeight: 600, color: "var(--accent-ink)" }}>{done}</span>
          <span style={{ color: "var(--ink-3)" }}> / {tasks.length} 项已完成</span>
          {data.thread ? (
            <div style={{ color: "var(--ink-2, #555)", marginTop: 2 }}>{data.thread}</div>
          ) : null}
        </div>
      )}

      {open.map((t) => {
        const st = STATUS_STYLE[t.status] || STATUS_STYLE.todo;
        return (
          <div key={t.id} style={{ display: "flex", gap: 6, padding: "2px 0", fontSize: 12.5, alignItems: "baseline" }}>
            <span className="oo-num" style={{ flexShrink: 0, color: "var(--ink-3)", fontSize: 11 }}>{t.id}</span>
            <span className="oo-truncate" style={{ flex: 1 }}>{t.title}</span>
            <span style={{ flexShrink: 0, fontSize: 11, color: st.color }}>{st.text}</span>
          </div>
        );
      })}

      {/* Claude Code 实时对话回显：终端质感（深底等宽），自动贴底 */}
      {ccAlive && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 3 }}>
            修复进程对话（Claude Code · 实时{ccText ? "" : " · 等待输出"}）
          </div>
          <pre
            ref={ccBox}
            style={{
              margin: 0,
              padding: "6px 8px",
              maxHeight: 180,
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

      {calls.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px dashed var(--line, #eee)", paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>平台维护调用（实时）</div>
          {calls.slice(0, 5).map((c, i) => (
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
