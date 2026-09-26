import React, { useEffect, useState } from "react";
import { ToolOutlined } from "@ant-design/icons";
import { API } from "../services/api";

// 「平台修复进度」小盒子（社区页右侧栏，热门讨论上面）。
//
// 用户要求（2026-09-26 原话）：「直接做一个窗口……显示实时进度，待办清单，
// 每次有api调用，就实时显示那条记录出来，给用户展示的」。
//
// 数据来自公开接口 GET /api/buildlog（见 routes/buildlog.js）：
//   · tasks —— 待办清单与状态（监工脚本维护 options.buildlog_state）
//   · calls —— 平台自己维护流量（测试人群 fb4* / 修复进程 cc*）的最新调用记录
// 只展示聚合可见字段；渠道/用户身份等敏感字段后端就不返回（隐私红线在服务端把守）。
//
// 轮询 15s：够「实时」的感觉，又不至于让每个打开社区的人都在打接口。
// 组件自身加载失败时整个隐藏 —— 公示是锦上添花，不能因为它把侧栏搞挂。
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

export default function BuildLogCard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      API.get("/buildlog").then((r) => {
        if (!stopped) setData(r || null);
      }).catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!tasks.length && !(data.calls || []).length) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done").slice(0, 6);
  const calls = (data.calls || []).slice(0, 5);

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

      {calls.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px dashed var(--line, #eee)", paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>平台维护调用（实时）</div>
          {calls.map((c, i) => (
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
