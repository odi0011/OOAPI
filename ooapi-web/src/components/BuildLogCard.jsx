import React, { useEffect, useRef, useState } from "react";
import { Tooltip } from "antd";
import { ToolOutlined, CheckCircleFilled, SyncOutlined, ClockCircleOutlined, StopOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";

// 「平台修复进度」小盒子（社区页右侧栏）。
// 数据来自公开接口 GET /api/buildlog：tasks / calls / cc（since_bytes 游标 + mtime）。
//
// 第 80 批核查结论（用户问「数据显示是否不合理、功能是否正常」）：**确实不正常**。
//   · 线上 buildlog_state 最后更新是 43 小时前，监工脚本已停、CC 日志文件不存在 ——
//     盒子却照常显示「3 / 11 已完成」和一串「待处理」，其中「公告写了不显示」早已修好。
//     给用户看一份过期的进度表，比不显示更误导；
//   · 每 3 秒无条件轮询一次（标签页在后台也在打），而这是一个查 logs 表的公开接口；
//   · 颜色写死十六进制、终端底色用了不存在的 var(--gray-3)，亮色主题下是一块突兀的黑块。
// 现在的规则：
//   · 超过 24 小时没更新 → 对普通用户整块隐藏；对管理员显示「数据已过期」提示（方便发现监工挂了）；
//   · 轮询：标签页可见且盒子有实时对话时 5s，否则 30s；页面隐藏时暂停；
//   · 颜色一律走设计令牌。
function relTime(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const STATUS = {
  done: { text: "已完成", cls: "is-done", icon: <CheckCircleFilled /> },
  doing: { text: "进行中", cls: "is-doing", icon: <SyncOutlined /> },
  todo: { text: "待处理", cls: "is-todo", icon: <ClockCircleOutlined /> },
  blocked: { text: "受阻", cls: "is-blocked", icon: <StopOutlined /> },
};

const CC_BUF_MAX = 24000;
const STALE_SEC = 24 * 3600;
const CC_IDLE_SEC = 15 * 60;

export default function BuildLogCard() {
  const { user } = useApp();
  const isAdmin = Number(user?.role) >= 100;
  const [data, setData] = useState(null);
  const [ccText, setCcText] = useState("");
  const [ccMeta, setCcMeta] = useState({ alive: false, idle: true, mtime: 0 });
  const ccCursor = useRef(0);
  const ccBox = useRef(null);
  const liveRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const appendCc = (r) => {
      const cc = r?.cc;
      if (!cc) {
        liveRef.current = false;
        setCcMeta((m) => ({ ...m, alive: false }));
        return;
      }
      if (cc.cursor < ccCursor.current && cc.cursor === 0 && cc.size > 0) setCcText("");
      if (cc.chunk) setCcText((prev) => (prev + (prev && !prev.endsWith("\n") ? "\n" : "") + cc.chunk).slice(-CC_BUF_MAX));
      ccCursor.current = cc.cursor;
      const idle = cc.mtime > 0 && Date.now() / 1000 - cc.mtime > CC_IDLE_SEC;
      liveRef.current = !idle;
      setCcMeta({ alive: true, idle, mtime: cc.mtime });
    };

    const schedule = () => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(tick, liveRef.current ? 5000 : 30000);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return schedule();
      try {
        const r = await API.get("/buildlog", { params: { cc_since: ccCursor.current } });
        if (stopped) return;
        setData(r || null);
        appendCc(r);
      } catch {
        /* 网络抖动：下一轮再试 */
      }
      schedule();
      return undefined;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const el = ccBox.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [ccText]);

  if (!data) return null;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const calls = data.calls || [];
  const stale = !data.updated_at || Date.now() / 1000 - data.updated_at > STALE_SEC;
  if (!tasks.length && !calls.length && !ccMeta.alive) return null;
  // 过期数据不给普通用户看（见文件头）；实时对话还活着的话照常显示
  if (stale && !ccMeta.alive && !isAdmin) return null;

  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done");
  const order = { doing: 0, blocked: 1, todo: 2 };
  const openShown = [...open].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).slice(0, 4);
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <div className="oo-aside-card oo-buildlog">
      <div className="oo-buildlog-head">
        <span className="oo-section-title"><ToolOutlined /> 平台修复进度</span>
        <span className="oo-buildlog-time">{data.updated_at ? `更新于 ${relTime(data.updated_at)}` : "未更新"}</span>
      </div>

      {stale ? (
        <div className="oo-buildlog-stale">
          数据已 {data.updated_at ? relTime(data.updated_at).replace("前", "") : "很久"}没有更新（监工脚本可能已停止）。
          {isAdmin ? " 普通用户看不到这块内容，恢复更新后自动重新显示。" : ""}
        </div>
      ) : null}

      {ccMeta.alive ? (
        <div className="oo-buildlog-cc">
          <div className="oo-buildlog-sub">
            修复进程对话 ·{" "}
            {ccMeta.idle ? (
              <span className="is-idle">空闲{ccMeta.mtime ? `（上次活动 ${relTime(ccMeta.mtime)}）` : ""}</span>
            ) : (
              <span className="is-live">● 实时</span>
            )}
          </div>
          <pre ref={ccBox}>{ccText || "…"}</pre>
        </div>
      ) : null}

      {tasks.length ? (
        <>
          <div className="oo-buildlog-progress" aria-label={`已完成 ${done} / ${tasks.length}`}>
            <span className="oo-buildlog-bar"><span style={{ width: `${pct}%` }} /></span>
            <span className="oo-num"><b>{done}</b> / {tasks.length}</span>
          </div>
          <ul className="oo-buildlog-tasks">
            {openShown.map((t) => {
              const st = STATUS[t.status] || STATUS.todo;
              return (
                <li key={t.id} className={st.cls}>
                  <Tooltip title={st.text}><span className="oo-buildlog-st">{st.icon}</span></Tooltip>
                  <span className="oo-truncate" title={t.title}>{t.title}</span>
                </li>
              );
            })}
          </ul>
          {open.length > openShown.length ? <div className="oo-buildlog-more">还有 {open.length - openShown.length} 项待处理</div> : null}
        </>
      ) : null}

      {calls.length && !stale ? (
        <div className="oo-buildlog-calls">
          <div className="oo-buildlog-sub">最近的维护调用</div>
          {calls.slice(0, 3).map((c, i) => (
            <div key={i} className="oo-buildlog-call">
              <span className={`oo-truncate${c.ok ? "" : " is-err"}`}>{c.model || "调用"}</span>
              <span className="oo-num">{c.od ? `${c.od.toFixed(4)} OD` : "—"} · {relTime(c.created_at)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
