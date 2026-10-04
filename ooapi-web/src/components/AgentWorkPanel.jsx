import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, Popconfirm, Select, Spin, Tag, Tooltip } from "antd";
import { DesktopOutlined, DownloadOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { chatApi } from "../services/chat";
import OdAmount from "./OdAmount";
import "./agent-work-panel.css";

const names = { running: "正在执行", queued: "等待执行", pending: "等待执行", paused: "已暂停", waiting_local: "等待本地连接", interrupted: "可继续", completed: "已完成", partial: "部分完成", failed: "未完成", blocked: "前置任务未完成", stopped: "已停止", cancelled: "已取消", cancelling: "正在取消" };
const active = status => ["running", "paused", "waiting_local", "interrupted"].includes(status);
const taskActive = status => ["queued", "pending", "running", "paused", "waiting_local"].includes(status);
const label = status => names[status] || "准备中";

export default function AgentWorkPanel({ sessionId, busy, revision = 0, onResume, onRunState, onEnsureSession }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false), [workOpen, setWorkOpen] = useState(false);
  const [work, setWork] = useState({ run: null, tasks: [] }), [workspaces, setWorkspaces] = useState([]), [binding, setBinding] = useState(null);
  const [error, setError] = useState(""), [workspaceError, setWorkspaceError] = useState("");
  const [loading, setLoading] = useState(false), [pending, setPending] = useState("");
  const [code, setCode] = useState(""), [message, setMessage] = useState(""), [target, setTarget] = useState("");
  const generation = useRef(0), currentId = useRef(sessionId), inFlight = useRef(null);
  currentId.current = sessionId;
  const run = work.run;
  const connected = binding && workspaces.find(w => w.id === binding.id) || binding;
  const origin = window.location.origin;
  const needsHttps = window.location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const command = `node ooapi-companion/start.mjs --server ${origin} --root "<你的工作目录>"${window.location.protocol === "http:" && !needsHttps ? " --allow-http-localhost" : ""}`;

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const id = currentId.current;
    if (!id || inFlight.current?.id === id) return;
    const marker = { id }, gen = generation.current;
    inFlight.current = marker;
    if (!quiet) setLoading(true);
    const results = await Promise.allSettled([chatApi.work(id), chatApi.localWorkspaces(), chatApi.sessionWorkspace(id)]);
    if (gen !== generation.current || currentId.current !== id) { if (inFlight.current === marker) inFlight.current = null; return; }
    if (results[0].status === "fulfilled") {
      const data = results[0].value || { run: null, tasks: [] };
      setWork({ ...data, tasks: data.tasks || [] }); onRunState?.(data.run || null); setError("");
    } else if (!quiet) setError(results[0].reason?.message || "无法读取任务状态，请重试。");
    if (results[1].status === "fulfilled") setWorkspaces(results[1].value?.workspaces || []);
    if (results[2].status === "fulfilled") setBinding(results[2].value || null);
    const connectionFailure = results.slice(1).find(r => r.status === "rejected");
    if (!quiet) setWorkspaceError(connectionFailure ? connectionFailure.reason?.message || "无法读取本地连接，请重试。" : "");
    if (inFlight.current === marker) inFlight.current = null;
    if (!quiet) setLoading(false);
  }, [onRunState]);

  useEffect(() => {
    generation.current++; setWork({ run: null, tasks: [] }); setBinding(null); setMessage(""); setTarget(""); setError(""); setWorkspaceError(""); setPending("");
    refresh();
    return () => { generation.current++; };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (!revision) return;
    // 流终态与服务端最终落盘可能相隔一拍，延后读一次，不能把 paused 又覆盖成 running。
    const timer = setTimeout(() => refresh({ quiet: true }), 450);
    return () => clearTimeout(timer);
  }, [revision, refresh]);
  useEffect(() => { if (target && (run?.status !== "running" || !work.tasks.some(task => task.id === target && taskActive(task.status)))) setTarget(""); }, [target, work.tasks, run?.status]);
  useEffect(() => {
    if (!busy && !workOpen && !workspaceOpen) return;
    const timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, 3000);
    return () => clearInterval(timer);
  }, [busy, workOpen, workspaceOpen, refresh]);

  const perform = async (key, operation, scope = "work") => {
    if (pending) return;
    const id = currentId.current;
    setPending(key); scope === "workspace" ? setWorkspaceError("") : setError("");
    try {
      await operation();
      if (currentId.current !== id) return;
      await refresh();
      return true;
    } catch (e) {
      if (currentId.current === id) (scope === "workspace" ? setWorkspaceError : setError)(e.message || "操作未完成，请重试。");
      return false;
    } finally { if (currentId.current === id) setPending(""); }
  };
  const resume = () => perform("resume", () => onResume?.());
  const openPanel = async scope => {
    scope === "workspace" ? setWorkspaceOpen(true) : setWorkOpen(true);
    try {
      if (!currentId.current) await onEnsureSession?.();
      await refresh();
    } catch (e) { (scope === "workspace" ? setWorkspaceError : setError)(e.message || "无法创建对话，请重试。"); }
  };

  return <>
    <Tooltip title={connected ? `${connected.label || "本地工作区"} · ${connected.online ? "已连接" : "离线"}` : "连接本机的工作目录"}>
      <button type="button" className={`ui-chat2-iconbtn agent-workspace-button ${connected?.online ? "is-online" : ""}`} aria-label="本地工作区" onClick={() => openPanel("workspace")}><DesktopOutlined />{connected ? <i aria-hidden="true"/> : null}</button>
    </Tooltip>
    <Tooltip title={run ? `任务 · ${label(run.status)}` : "查看任务与补充要求"}>
      <button type="button" className="ui-chat2-iconbtn agent-task-button" aria-label="任务工作台" onClick={() => openPanel("work")}><UnorderedListOutlined />{run && active(run.status) ? <i aria-hidden="true"/> : null}</button>
    </Tooltip>

    <Drawer title="本地工作区" open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} width="min(480px, 100vw)" rootClassName="agent-work-drawer">
      <div className="agent-work-content">
        <p className="agent-work-intro">连接你选择的本机目录，乐乐就能在这段对话里读取文件、继续本地任务。目录在运行器中选择。</p>
        {workspaceError ? <Alert type="error" showIcon message={workspaceError} /> : null}
        <section className="agent-work-section">
          <div className="agent-work-section-title"><h3>当前对话的连接</h3><Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => refresh()} aria-label="刷新工作区"/></div>
          {workspaces.length ? <div className="agent-workspace-list">{workspaces.map(w => <div className={`agent-workspace-row ${binding?.id === w.id ? "is-selected" : ""}`} key={w.id}>
            <div><strong>{w.label || "本地工作区"}</strong><span className="agent-work-muted">{w.online ? "已连接" : "离线"} · {w.capabilities?.write ? "可修改文件" : "只读"}{w.capabilities?.exec ? " · 可运行隔离命令" : ""}</span></div>
            <div className="agent-workspace-actions">
              <Button size="small" aria-label={binding?.id === w.id ? "已选择" : "用于此对话"} loading={pending === `bind-${w.id}`} disabled={Boolean(pending) || busy || active(run?.status) || binding?.id === w.id} onClick={() => perform(`bind-${w.id}`, () => chatApi.bindWorkspace(sessionId, w.id), "workspace")}>{binding?.id === w.id ? "已选择" : "用于此对话"}</Button>
              <Popconfirm title="撤销这个设备的连接？" description="这个设备的所有工作区会断开，已派发的操作可能已经执行。撤销不会删除本机文件。" okText="撤销连接" cancelText="保留连接" disabled={Boolean(pending) || !w.deviceId} onConfirm={() => perform(`revoke-${w.deviceId}`, () => chatApi.revokeDevice(w.deviceId), "workspace")}><Button size="small" danger aria-label="撤销设备连接" loading={pending === `revoke-${w.deviceId}`} disabled={Boolean(pending) || !w.deviceId}>撤销连接</Button></Popconfirm>
            </div>
          </div>)}</div> : loading ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有连接本机" />}
          {binding ? <Button size="small" disabled={busy || active(run?.status) || Boolean(pending)} loading={pending === "unbind"} onClick={() => perform("unbind", () => chatApi.bindWorkspace(sessionId, null), "workspace")}>解除此对话的绑定</Button> : null}
          {binding && !connected?.online ? <p className="agent-work-muted">运行器离线时，本地任务会保留进度；重新启动运行器后再继续。</p> : null}
          {busy || active(run?.status) ? <p className="agent-work-muted">任务结束或停止后可调整绑定。</p> : null}
        </section>
        <section className="agent-work-section">
          <h3>第一次连接</h3>
          <ol className="agent-work-steps"><li><span>下载运行器并解压，在你的电脑上打开终端。</span><Button aria-label="下载本地运行器" icon={<DownloadOutlined />} loading={pending === "download"} disabled={Boolean(pending)} onClick={() => perform("download", () => chatApi.downloadCompanion(), "workspace")}>下载本地运行器</Button></li><li><span>把命令里的目录换成你要交给乐乐的目录，在解压后的文件夹运行：</span><pre aria-label="本地运行器启动命令">{command}</pre><span className="agent-work-muted">默认只读。运行器读取的文件不会存到平台聊天记录；任务所需片段会临时交给云端模型处理。主动上传的附件仍走普通云端上传。</span></li><li><span>运行器会显示配对码。在这里确认，随后选择上面的工作区。</span><div className="agent-pair-controls"><Input aria-label="本地工作区配对码" value={code} maxLength={40} autoComplete="off" placeholder="输入运行器显示的配对码" onChange={e => setCode(e.target.value)} disabled={Boolean(pending)}/><Button aria-label="确认连接" type="primary" loading={pending === "pair"} disabled={!code.trim() || Boolean(pending)} onClick={async () => { if (await perform("pair", () => chatApi.pairWorkspace(code.trim()), "workspace")) setCode(""); }}>确认连接</Button></div></li></ol>
          {needsHttps ? <Alert type="info" showIcon message="本地连接需要 HTTPS" description="当前站点使用 HTTP，请先让管理员启用 HTTPS，再运行并配对。普通对话仍可使用。"/> : null}
          <details className="agent-work-advanced"><summary>需要修改文件或运行命令</summary><p>在本机启动时加 <code>--allow-write</code> 才允许修改文件。执行命令需要 Docker 和本机已有镜像，并加 <code>--allow-exec --docker-image &lt;镜像名&gt;</code>。这些权限由你在本机授予，乐乐不能自行开启。</p></details>
        </section>
      </div>
    </Drawer>

    <Drawer title="任务工作台" open={workOpen} onClose={() => setWorkOpen(false)} width="min(480px, 100vw)" rootClassName="agent-work-drawer">
      <div className="agent-work-content">
        {error ? <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => refresh()}>重试</Button>}/> : null}
        <section className="agent-work-section">
          <div className="agent-work-section-title"><h3>{run ? label(run.status) : "当前任务"}</h3><Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => refresh()} aria-label="刷新任务"/></div>
          {!run ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="发送一个任务后，可以在这里查看进展。"/> : <>
            <p className="agent-work-intro">{run.status === "waiting_local" ? "本地连接暂时不可用，已保存的进度会保留。连接恢复后可以继续。" : run.resumable ? "进度已保存。继续后从上次停下的位置接着做。" : run.status === "running" ? "乐乐正在推进任务，可以暂停，也可以补充新的要求。" : "本次任务的过程和结果保留在这段对话里。"}</p>
            <div className="agent-work-controls">
              {run.status === "running" ? <Button aria-label="暂停任务" icon={<PauseOutlined/>} loading={pending === "pause"} disabled={Boolean(pending)} onClick={() => perform("pause", () => chatApi.pause(sessionId))}>暂停任务</Button> : null}
              {run.resumable ? <Button aria-label="继续任务" type="primary" icon={<PlayCircleOutlined/>} loading={pending === "resume"} disabled={Boolean(pending) || busy || run.local && !connected?.online} onClick={resume}>继续任务</Button> : null}
              {run.resumable ? <Popconfirm title="停止这个任务？" description="已完成的内容会保留，停止后不能继续这次任务。" okText="停止任务" cancelText="保留任务" onConfirm={() => perform("stop", () => chatApi.stop(sessionId))}><Button aria-label="停止任务" icon={<StopOutlined/>} loading={pending === "stop"} disabled={Boolean(pending) || busy}>停止任务</Button></Popconfirm> : null}
            </div>
            {run.budget ? <div className="agent-work-budget" aria-label="任务已用预算"><span>模型调用 <b>{run.budget.modelCalls ?? run.budget.calls ?? 0}</b></span><span>Token <b>{Number(run.budget.tokens || 0).toLocaleString()}</b></span>{run.budget.od != null ? <span>消耗 <OdAmount quota={run.budget.od} perUnit={1} digits={4}/></span> : null}</div> : null}
          </>}
        </section>
        {work.tasks.length ? <section className="agent-work-section"><h3>子任务</h3>{run?.resumable && work.tasks.some(task => taskActive(task.status)) ? <p className="agent-work-muted">继续主任务后，可以调整或取消子任务。现在的补充要求会先交给整个任务。</p> : null}<ol className="agent-work-tasks">{work.tasks.map(task => <li key={task.id}>
          <div className="agent-work-task-title"><strong>{task.label || task.title || "子任务"}</strong><Tag>{label(task.status)}</Tag></div>
          {task.summary ? <p>{task.summary}</p> : null}
          {task.error ? <p className="agent-work-muted">{String(task.error).slice(0, 400)}</p> : null}
          {taskActive(task.status) ? <Popconfirm title="取消这个子任务？" description="已完成的部分会保留。" okText="取消子任务" cancelText="继续执行" disabled={run?.status !== "running"} onConfirm={() => perform(`cancel-${task.id}`, () => chatApi.cancelTask(sessionId, task.id))}><Button aria-label="取消子任务" size="small" loading={pending === `cancel-${task.id}`} disabled={Boolean(pending) || run?.status !== "running"}>取消子任务</Button></Popconfirm> : null}
        </li>)}</ol></section> : null}
        {run && active(run.status) ? <section className="agent-work-section"><h3>补充要求</h3>
          {run.status === "running" && work.tasks.some(task => taskActive(task.status)) ? <Select aria-label="补充要求的目标" value={target} onChange={setTarget} disabled={Boolean(pending)} options={[{ label: "整个任务", value: "" }, ...work.tasks.filter(task => taskActive(task.status)).map(task => ({ label: task.label || task.title || "子任务", value: task.id }))]}/> : null}
          <Input.TextArea aria-label="给任务补充要求" value={message} maxLength={4000} showCount autoSize={{ minRows: 3, maxRows: 8 }} placeholder="例如：先完成文档整理；这一步请保留原格式。" onChange={e => setMessage(e.target.value)} disabled={Boolean(pending)}/>
          <Button aria-label="发送补充要求" type="primary" loading={pending === "message"} disabled={!message.trim() || Boolean(pending)} onClick={async () => { if (await perform("message", () => chatApi.workMessage(sessionId, message.trim(), target || undefined))) setMessage(""); }}>发送补充要求</Button>
        </section> : null}
      </div>
    </Drawer>
  </>;
}
