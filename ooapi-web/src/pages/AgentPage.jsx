import React, { useEffect, useRef, useState } from "react";
import { App as AntApp, Dropdown } from "antd";
import {
  BulbOutlined, SearchOutlined, EditOutlined, CodeOutlined, ThunderboltOutlined,
  PlayCircleOutlined, StopOutlined, CheckOutlined, LoadingOutlined, DownOutlined,
  CopyOutlined, ClearOutlined, ClockCircleOutlined,
} from "@ant-design/icons";
import { API, getToken } from "../services/api";
import { streamPost } from "../services/stream";
import { useApp } from "../context/AppContext";
import { fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { OdCoin } from "../components/OdCoin";
import Markdown from "../components/Markdown";
import PageHeader from "../components/PageHeader";
import { ModelLabel } from "../components/VendorIcon";

const ICONS = {
  sparkles: <ThunderboltOutlined />,
  search: <SearchOutlined />,
  edit: <EditOutlined />,
  code: <CodeOutlined />,
};


const PRESET_GOALS = [
  "帮我规划一个个人知识管理系统的技术选型",
  "分析一下当前主流大模型的定价策略差异",
  "写一篇关于 AI 网关产品的介绍文章",
  "用 Python 实现一个带重试的 HTTP 客户端",
];

export default function AgentPage() {
  const { user, refreshUser, status } = useApp();
  const { message: toast } = AntApp.useApp();

  const [meta, setMeta] = useState(null);
  const [agentId, setAgentId] = useState("general");
  const [model, setModel] = useState(null);
  const [goal, setGoal] = useState("");

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(""); // plan | steps | final
  const [steps, setSteps] = useState([]); // [{title, status, content, delta}]
  const [answer, setAnswer] = useState("");
  const [cost, setCost] = useState(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const ctrlRef = useRef(null);
  const timerRef = useRef(null);
  const outRef = useRef(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    let alive = true;
    API.get("/chat/meta")
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps, answer]);

  // 卸载清理：中止流、清计时器，并让 runId 作废
  // （abort 会让 streamPost 回调 onDone，若不挡住会卸载后 setState）
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      ctrlRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const agent = meta?.agents?.find((a) => a.id === agentId);
  const effectiveModel = model || agent?.model || "deepseek-chat";

  const run = () => {
    if (!goal.trim() || running) return;

    setRunning(true);
    setError("");
    setSteps([]);
    setAnswer("");
    setCost(null);
    setPhase("plan");
    setElapsed(0);

    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Date.now() - t0), 200);

    let buf = "";
    const runId = ++runIdRef.current;
    const stale = () => runIdRef.current !== runId;
    ctrlRef.current = streamPost(
      "/api/chat/agents/run",
      { agentId, goal: goal.trim(), model: effectiveModel },
      {
        token: getToken(),
        onEvent: (ev) => {
          if (stale()) return;
          if (ev.type === "plan_start") {
            setPhase("plan");
          } else if (ev.type === "plan") {
            setSteps(ev.steps.map((t) => ({ title: t, status: "pending", content: "" })));
            setPhase("steps");
          } else if (ev.type === "step_start") {
            setSteps((p) => p.map((s, i) => (i === ev.index ? { ...s, status: "running" } : s)));
          } else if (ev.type === "step_delta") {
            setSteps((p) =>
              p.map((s, i) => (i === ev.index ? { ...s, content: s.content + ev.delta } : s))
            );
          } else if (ev.type === "step_done") {
            setSteps((p) =>
              p.map((s, i) => (i === ev.index ? { ...s, status: "done", content: ev.content || s.content } : s))
            );
          } else if (ev.type === "final_start") {
            setPhase("final");
          } else if (ev.type === "delta") {
            buf += ev.delta;
            setAnswer(buf);
          } else if (ev.type === "done") {
            setAnswer(ev.answer || buf);
            setCost(ev.cost);
            setPhase("done");
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        },
        onError: (e) => {
          if (stale()) return;
          // 出错也要收尾：清计时器、恢复按钮，否则页面永远停在「运行中」
          setError(e.message);
          if (timerRef.current) clearInterval(timerRef.current);
          setRunning(false);
          ctrlRef.current = null;
        },
        onDone: () => {
          if (stale()) return;
          if (timerRef.current) clearInterval(timerRef.current);
          setRunning(false);
          setPhase((p) => (p === "done" ? p : "done"));
          ctrlRef.current = null;
          refreshUser?.();
        },
      }
    );
  };

  const stop = () => {
    ctrlRef.current?.abort();
    if (timerRef.current) clearInterval(timerRef.current);
    setRunning(false);
  };

  const clearAll = () => {
    setSteps([]);
    setAnswer("");
    setCost(null);
    setError("");
    setPhase("");
  };

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const modelMenu = {
    items: (meta?.models || []).map((m) => ({
      key: m.id,
      label: m.id,
      onClick: () => setModel(m.id),
    })),
  };

  const runningStep = steps.find((s) => s.status === "running");
  const doneCount = steps.filter((s) => s.status === "done").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader
        title="智能体"
        desc={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            多步骤任务执行 · 余额
            {user?.quota != null ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <OdCoin size={14} />
                {fmtOd(user.quota, unitsPerOd(status), 4)}
              </span>
            ) : (
              "-"
            )}
          </span>
        }
        extra={
          <>
            <Dropdown menu={modelMenu} trigger={["click"]}>
              <span className="bui-model-pick">
                <ModelLabel model={effectiveModel} size={14} />
                <DownOutlined style={{ fontSize: 9 }} />
              </span>
            </Dropdown>
            {phase ? (
              <button className="bui-btn" onClick={clearAll} disabled={running}>
                <ClearOutlined /> 清空
              </button>
            ) : null}
          </>
        }
      />

      {/* 智能体选择 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))", gap: 12 }}>
        {(meta?.agents || []).map((a) => {
          const active = a.id === agentId;
          return (
            <div
              key={a.id}
              className="bui-agent-card"
              onClick={() => !running && setAgentId(a.id)}
              style={
                active
                  ? { boxShadow: "0 0 0 1.5px var(--accent), var(--shadow-card)" }
                  : undefined
              }
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="bui-agent-ico">{ICONS[a.icon] || <ThunderboltOutlined />}</div>
                <div style={{ minWidth: 0 }}>
                  <p className="bui-agent-name">{a.name}</p>
                  <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                    {a.thinking ? <span className="bui-chip bui-chip--accent">深度思考</span> : null}
                    <span className="bui-chip">{a.steps?.length || 0} 步</span>
                  </div>
                </div>
              </div>
              <p className="bui-agent-desc">{a.desc}</p>
            </div>
          );
        })}
      </div>

      {/* 任务输入 */}
      <div className="bui-composer" style={{ maxWidth: "none" }}>
        <textarea
          className="bui-composer-input"
          rows={2}
          placeholder="描述你的任务目标，智能体会自动规划并分步执行…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={running}
        />
        <div className="bui-composer-bar">
          <div className="bui-composer-tools">
            {!goal ? (
              <>
                {PRESET_GOALS.slice(0, 2).map((g) => (
                  <button key={g} className="bui-seg-item" onClick={() => setGoal(g)}>
                    {g.slice(0, 14)}…
                  </button>
                ))}
              </>
            ) : (
              <span className="oo-mono" style={{ background: "transparent", border: "none", padding: 0 }}>
                {agent?.steps?.join(" › ")}
              </span>
            )}
          </div>
          {running ? (
            <button className="bui-send bui-send--stop" onClick={stop} title="停止">
              <StopOutlined />
            </button>
          ) : (
            <button className="bui-send" onClick={run} disabled={!goal.trim()} title="开始执行">
              <PlayCircleOutlined />
            </button>
          )}
        </div>
      </div>

      {/* 执行过程 */}
      {(steps.length || running || error) && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          {/* 左侧：任务步骤 */}
          <div className="oo-panel">
            <div className="oo-panel-head">
              <span className="oo-panel-title">执行步骤</span>
              <span className="bui-chip">
                {running ? <LoadingOutlined spin /> : <CheckOutlined />}
                {doneCount}/{steps.length || "?"}
              </span>
            </div>
            <div className="oo-panel-body" style={{ paddingTop: 8 }}>
              {running || elapsed ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 10,
                    fontSize: 12,
                    color: "var(--ink-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <ClockCircleOutlined />
                  {(elapsed / 1000).toFixed(1)}s
                  {phase === "plan" ? " · 规划中" : phase === "final" ? " · 汇总中" : ""}
                </div>
              ) : null}

              <div className="bui-steps">
                {phase === "plan" ? (
                  <div className="bui-step is-active">
                    <div className="bui-step-mark">
                      <LoadingOutlined spin style={{ fontSize: 9 }} />
                    </div>
                    <div className="bui-step-text">正在规划任务步骤…</div>
                  </div>
                ) : null}

                {steps.map((s, i) => (
                  <div
                    key={i}
                    className={`bui-step${s.status === "done" ? " is-done" : s.status === "running" ? " is-active" : ""}`}
                  >
                    <div className="bui-step-mark">
                      {s.status === "done" ? (
                        <CheckOutlined style={{ fontSize: 8 }} />
                      ) : s.status === "running" ? (
                        <LoadingOutlined spin style={{ fontSize: 9 }} />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <div className="bui-step-text">
                      <div style={{ fontWeight: s.status === "running" ? 500 : 400 }}>{s.title}</div>
                      {s.status === "running" && s.content ? (
                        <div style={{ color: "var(--ink-3)", marginTop: 2 }}>
                          {s.content.slice(-70)}
                          <span className="bui-caret" style={{ height: 11, width: 5 }} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}

                {phase === "final" || phase === "done" ? (
                  <div className={`bui-step${phase === "done" ? " is-done" : " is-active"}`}>
                    <div className="bui-step-mark">
                      {phase === "done" ? <CheckOutlined style={{ fontSize: 8 }} /> : <LoadingOutlined spin style={{ fontSize: 9 }} />}
                    </div>
                    <div className="bui-step-text">汇总最终答案</div>
                  </div>
                ) : null}
              </div>

              {runningStep ? null : null}

              {cost != null ? (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px dashed var(--line)",
                    fontSize: 12,
                    color: "var(--ink-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  本次消耗 {cost} {CURRENCY_NAME}
                </div>
              ) : null}
            </div>
          </div>

          {/* 右侧：产出 */}
          <div className="oo-panel">
            <div className="oo-panel-head">
              <span className="oo-panel-title">
                {phase === "final" ? "最终答案" : phase === "done" ? "最终答案" : "执行输出"}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {answer ? (
                  <button className="bui-icon-btn" onClick={copyAnswer} title="复制答案">
                    <CopyOutlined />
                  </button>
                ) : null}
                {running ? <span className="bui-chip bui-chip--accent">运行中</span> : null}
              </div>
            </div>
            <div className="oo-panel-body oo-scroll" ref={outRef} style={{ maxHeight: 560 }}>
              {error ? (
                <div className="bui-chip bui-chip--red" style={{ display: "inline-flex" }}>
                  {error}
                </div>
              ) : answer ? (
                <Markdown text={answer} />
              ) : steps.some((s) => s.content) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {steps
                    .filter((s) => s.content)
                    .map((s, i) => (
                      <div key={i}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--ink-3)",
                            marginBottom: 4,
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          <span className="bui-dot oo-dot--ok" style={{ background: "var(--green)" }} />
                          {s.title}
                        </div>
                        <Markdown text={s.content} />
                      </div>
                    ))}
                </div>
              ) : (
                <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
                  {running ? <span className="bui-pulse">智能体正在工作…</span> : "暂无输出"}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
