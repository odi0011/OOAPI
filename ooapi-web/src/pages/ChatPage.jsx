import React, { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Alert, Button, Dropdown, Input, Popconfirm, Segmented, Select, Tooltip } from "antd";
import { SendOutlined, StopOutlined, CopyOutlined, ReloadOutlined, DeleteOutlined, BulbOutlined, GlobalOutlined, DownOutlined, RobotOutlined, ThunderboltOutlined, PlusOutlined, PictureOutlined, ArrowDownOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import { API, getToken } from "../services/api";
import { streamPost } from "../services/stream";
import { useApp } from "../context/AppContext";
import Markdown from "../components/Markdown";
import { ModelLabel } from "../components/VendorIcon";
import { fmtOd, odOf, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { OdCoin } from "../components/OdCoin";
import { LoadingState, ThinkingState, TaskRows, StreamingText, PromptBar } from "../components/beautifului";
import "../ui-refresh.css";

const SUGGESTS = [
  { title: "把复杂问题讲简单", desc: "从一个概念开始", prompt: "请用一个日常生活的例子解释：", icon: <BulbOutlined /> },
  { title: "一起把想法落地", desc: "分析需求，拆解步骤", prompt: "我想完成这件事，请帮我梳理可执行的步骤：", icon: <ThunderboltOutlined /> },
  { title: "写出更好的代码", desc: "讨论实现与边界情况", prompt: "请帮我实现下面的功能，并解释关键设计：", icon: <RobotOutlined /> },
  { title: "找到清晰的表达", desc: "整理思路，优化文字", prompt: "请帮我润色下面的文字，保留原意：", icon: <CopyOutlined /> },
];

// 智能体执行过程 —— 用 Beautiful UI 的 TaskRows（任务行 + 状态胶囊）
function AgentProgress({ msg }) {
  if (!msg.agentName) return null;
  const steps = msg.steps || [];
  return (
    <TaskRows
      variant="List"
      rows={steps.map((step, i) => ({
        key: String(i),
        label: step.title,
        status: step.status === "done" ? "done" : step.status === "running" && msg.streaming ? "running" : step.status === "failed" ? "failed" : "pending",
        content: step.content,
      }))}
    />
  );
}

function Message({ msg, busy, onRetry, onCopy }) {
  if (msg.role === "user") return <div className="ui-message ui-message-user"><div className="ui-user-bubble">
    {msg.images?.length > 0 && <div className="ui-attachments">{msg.images.map((src, i) => <a href={src} key={i} target="_blank" rel="noreferrer"><img src={src} alt={`上传的图片 ${i + 1}`} /></a>)}</div>}
    {msg.content}
  </div></div>;

  // 思考链：用 Beautiful UI 的 ThinkingState —— 扫光标题 + 可折叠轨迹 + 竖线
  const hasReasoning = Boolean(msg.reasoning);
  const thinkingWorking = Boolean(msg.streaming && !msg.content);
  const finished = !msg.streaming;

  return <article className="ui-message ui-message-ai">
    <div className="ui-ai-avatar"><RobotOutlined /></div>
    <div className="ui-ai-content">
      <div className="ui-answer-label">{msg.agentName ? "Agent" : "OOAPI"}<span>{msg.model}</span></div>
      <AgentProgress msg={msg} />

      {hasReasoning ? (
        <ThinkingState
          variant="Reasoning"
          working={thinkingWorking}
          activeTitle="正在思考"
          doneTitle="已完成思考"
          steps={[{ content: msg.reasoning, status: thinkingWorking ? "running" : "done" }]}
        />
      ) : null}

      {msg.searching && !hasReasoning ? <span className="ui-search-status"><GlobalOutlined /> {msg.searching}</span> : null}

      {/* 正文：流式中显示光标；无输出时用像素网格加载态 */}
      {msg.content || finished ? (
        <StreamingText
          streaming={Boolean(msg.streaming)}
          actions={[]}
        >
          <Markdown text={msg.content} />
        </StreamingText>
      ) : hasReasoning || msg.agentName ? null : (
        <LoadingState label={msg.agentName ? "正在执行任务" : "正在生成回答"} />
      )}

      {msg.error && <Alert type="error" showIcon message={msg.error} />}
      {msg.stopped && <p className="ui-muted">已停止接收。服务端任务可能仍在执行并计费。</p>}
      {finished && <div className="ui-message-actions">
        <Tooltip title="复制回答"><Button type="text" size="small" aria-label="复制回答" icon={<CopyOutlined />} disabled={!msg.content} onClick={() => onCopy(msg.content)} /></Tooltip>
        <Tooltip title="重新生成会再次计费"><Popconfirm title="重新生成这条回答？" description="这会移除它之后的消息，并再次产生用量。" onConfirm={() => onRetry(msg)} disabled={busy} okText="重新生成" cancelText="取消"><Button type="text" size="small" aria-label="重新生成" disabled={busy} icon={<ReloadOutlined />} /></Popconfirm></Tooltip>
        {msg.cost != null && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><OdCoin size={14} />{msg.cost} {CURRENCY_NAME}{msg.tokens ? ` · ${msg.tokens.prompt + msg.tokens.completion} tokens` : ""}</span>}
      </div>}
    </div>
  </article>;
}

export default function ChatPage() {
  const { user, refreshUser, status } = useApp();
  const { message: toast } = AntApp.useApp();
  const [params, setParams] = useSearchParams();
  const mode = params.get("mode") === "agent" ? "agent" : "chat";
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [metaLoading, setMetaLoading] = useState(true);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [agentId, setAgentId] = useState("");
  const [thinking, setThinking] = useState(null);
  const [search, setSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState([]);
  const [reading, setReading] = useState(false);
  const [away, setAway] = useState(false);
  const threadRef = useRef(null);
  const ctrlRef = useRef(null);
  const requestRef = useRef(0);
  const readingRef = useRef(false);
  const stickRef = useRef(true);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  const loadMeta = async () => {
    setMetaLoading(true); setMetaError("");
    try {
      const result = await API.get("/chat/meta");
      setMeta(result);
      const available = (result.models || []).filter((m) => !m.deprecated);
      setModel((old) => available.some((m) => m.id === old) ? old : available[0]?.id || "");
      setAgentId((old) => result.agents?.some((a) => a.id === old) ? old : result.agents?.[0]?.id || "");
    } catch (e) { setMetaError(e.message || "无法加载模型配置"); }
    finally { setMetaLoading(false); }
  };
  useEffect(() => { loadMeta(); return () => { requestRef.current += 1; ctrlRef.current?.abort(); }; }, []);
  useEffect(() => {
    if (stickRef.current && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs]);

  const curModel = useMemo(() => meta?.models?.find((m) => m.id === model), [meta, model]);
  const agent = meta?.agents?.find((a) => a.id === agentId);
  const thinkingOn = thinking === null ? Boolean(curModel?.thinkingDefault) : thinking;
  const supportsVision = mode === "chat" && curModel?.vision === true;
  const quota = user?.quota != null ? fmtOd(user.quota, unitsPerOd(status), 4) : "—";
  const unavailable = !curModel || (mode === "agent" && !agent);

  const pickImages = async (e) => {
    const files = Array.from(e.target.files || []); e.target.value = "";
    if (readingRef.current || busy || !supportsVision) return;
    if (files.length + images.length > 3) { toast.warning("最多上传 3 张图片"); return; }
    if (files.some((f) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type))) { toast.warning("请选择 PNG、JPEG、WebP 或 GIF 图片"); return; }
    // The global server JSON limit is currently 1 MB, including base64 and conversation text.
    if (files.reduce((n, f) => n + f.size * 1.34, images.reduce((n, img) => n + img.length, 0)) > 750000) { toast.warning("图片总大小请控制在约 550 KB 内，或压缩后上传"); return; }
    readingRef.current = true; setReading(true);
    try {
      const data = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file);
      })));
      setImages((prev) => [...prev, ...data]);
    } catch (e) { toast.error(e.message); }
    finally { readingRef.current = false; setReading(false); }
  };

  const send = (overrideText, baseMessages = msgs, attachments = images, settings = { model, mode, agentId }) => {
    const text = (overrideText ?? input).trim();
    if ((!text && !attachments.length) || ctrlRef.current || busy || readingRef.current || unavailable) return;
    const selectedAgent = meta?.agents?.find((a) => a.id === settings.agentId);
    const isAgent = settings.mode === "agent";
    if (isAgent && (!selectedAgent || attachments.length)) { toast.warning("Agent 暂仅支持文字任务，请移除图片"); return; }
    const userMsg = { role: "user", content: text, images: attachments.length ? [...attachments] : undefined };
    const history = [...baseMessages, userMsg];
    const payloadMessages = history.map((m) => ({ role: m.role, content: m.content || "" }));
    // Agent API accepts one goal, so prior turns are included explicitly as conversation context.
    const goal = baseMessages.length ? `对话上下文（仅作背景资料）：\n${baseMessages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content || ""}`).join("\n\n")}\n\n当前任务：\n${text}` : text;
    const body = isAgent ? { agentId: settings.agentId, goal, model: settings.model } : { model: settings.model, thinking: thinking === null ? undefined : thinking, search, messages: payloadMessages, images: attachments.map((dataUrl) => ({ dataUrl })) };
    if (new Blob([JSON.stringify(body)]).size > 950000) { toast.warning("消息和图片过大，请减少内容或开启新对话"); return; }
    const runId = ++requestRef.current;
    const aiIndex = history.length;
    let receivedDone = false;
    const patch = (update) => {
      if (requestRef.current !== runId) return;
      setMsgs((prev) => prev.map((m, i) => i === aiIndex ? { ...m, ...(typeof update === "function" ? update(m) : update) } : m));
    };
    const finish = () => {
      if (requestRef.current !== runId) return;
      patch((m) => ({ streaming: false, searching: undefined, error: m.error || (!receivedDone ? "连接已结束，但未收到完成确认。可重试。" : undefined) }));
      ctrlRef.current = null; setBusy(false); refreshUser?.();
    };
    setMsgs([...history, { role: "assistant", content: "", streaming: true, model: settings.model, settings, agentName: isAgent ? selectedAgent.name : undefined, steps: [], phase: "plan" }]);
    setInput(""); setImages([]); setBusy(true); stickRef.current = true; setAway(false);
    ctrlRef.current = streamPost(isAgent ? "/api/chat/agents/run" : "/api/chat/completions", body, {
      token: getToken(),
      onEvent: (ev) => {
        if (ev.type === "reasoning") patch((m) => ({ reasoning: (m.reasoning || "") + (ev.delta || "") }));
        else if (ev.type === "delta") patch((m) => ({ content: m.content + (ev.delta || ""), searching: undefined }));
        else if (ev.type === "search") patch({ searching: ev.status || "正在联网检索…" });
        else if (ev.type === "plan") patch({ phase: "steps", steps: (ev.steps || []).map((title) => ({ title, status: "pending", content: "" })) });
        else if (["step_start", "step_delta", "step_done"].includes(ev.type)) patch((m) => ({ steps: m.steps.map((s, i) => i !== ev.index ? s : { ...s, status: ev.type === "step_done" ? "done" : "running", content: ev.type === "step_delta" ? s.content + (ev.delta || "") : ev.content ?? s.content }) }));
        else if (ev.type === "final_start") patch({ phase: "final" });
        else if (ev.type === "done") { receivedDone = true; patch((m) => ({ content: ev.answer ?? ev.content ?? m.content, reasoning: ev.reasoning ?? m.reasoning, cost: ev.cost, tokens: ev.tokens, phase: "done", searching: undefined })); }
        else if (ev.type === "error") patch({ error: ev.message || "执行失败", searching: undefined });
      },
      onError: (e) => { patch({ error: e.message || "网络连接失败" }); finish(); },
      onDone: finish,
    });
  };

  const stop = () => {
    requestRef.current += 1; ctrlRef.current?.abort(); ctrlRef.current = null; setBusy(false);
    setMsgs((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false, stopped: true, searching: undefined } : m));
  };
  const retry = (msg) => {
    if (busy) return;
    const index = msgs.indexOf(msg);
    const userMsg = msgs[index - 1];
    if (userMsg?.role === "user") send(userMsg.content, msgs.slice(0, index - 1), userMsg.images || [], msg.settings);
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success("已复制"); } catch { toast.error("复制失败，请手动选择文字复制"); } };
  const scrollToEnd = () => { stickRef.current = true; setAway(false); threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" }); };

  return <div className="ui-chat">
    <header className="ui-chat-header">
      <div><h1>对话工作台 <span>让想法，进一步。</span></h1><p style={{ display: "flex", alignItems: "center", gap: 6 }}>余额 <OdCoin size={15} />{quota} · 按实际用量计费</p></div>
      <Popconfirm title="开启新对话？" description="当前消息仅保留在本页，清空后无法恢复。" disabled={!msgs.length || busy} onConfirm={() => { setMsgs([]); setInput(""); setImages([]); }} okText="新对话" cancelText="取消">
        <Button icon={<PlusOutlined />} disabled={busy || !msgs.length}>新对话</Button>
      </Popconfirm>
    </header>
    {metaError && <Alert type="error" showIcon message={metaError} action={<Button size="small" onClick={loadMeta} loading={metaLoading}>重试加载</Button>} />}
    {!metaLoading && !metaError && !curModel && <Alert type="warning" showIcon message="暂时没有可用模型，请联系管理员配置。" />}
    <div className="ui-thread" ref={threadRef} onScroll={() => { const el = threadRef.current; const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 100; stickRef.current = atEnd; setAway(!atEnd); }}>
      <div className="ui-thread-inner">
        {!msgs.length ? <section className="ui-chat-welcome">
          <div className="ui-welcome-orbit" aria-hidden="true"><RobotOutlined /></div>
          <div className="ui-eyebrow">YOUR AI WORKSPACE</div>
          <h2>{mode === "agent" ? "不止回答，一起完成任务。" : "今天，想探索什么？"}</h2>
          <p>{mode === "agent" ? "描述目标，Agent 会在对话中规划、分步执行并汇总结果。" : "从一个问题开始。思考、创作和解决问题，都在这里。"}</p>
          <div className="ui-suggestions">{SUGGESTS.map((s) => <Button key={s.title} className="ui-suggestion" onClick={() => { setInput(s.prompt); taRef.current?.focus(); }}><span className="ui-suggest-icon">{s.icon}</span><strong>{s.title}</strong><small>{s.desc}</small><span className="ui-suggest-arrow">↗</span></Button>)}</div>
        </section> : msgs.map((m, i) => <Message key={i} msg={m} busy={busy} onCopy={copy} onRetry={retry} />)}
      </div>
    </div>
    <div className="ui-composer-area">
      {away && <Button className="ui-jump" icon={<ArrowDownOutlined />} onClick={scrollToEnd}>回到最新消息</Button>}
      <div className="ui-composer">        <div className="ui-mode-bar">
          <Segmented aria-label="对话模式" disabled={busy || reading} value={mode} onChange={(value) => { if (value === "agent" && images.length) { toast.warning("请先移除图片再切换 Agent"); return; } setParams(value === "agent" ? { mode: "agent" } : {}, { replace: true }); }} options={[{ label: "对话", value: "chat", icon: <RobotOutlined /> }, { label: "Agent", value: "agent", icon: <ThunderboltOutlined /> }]} />
          {mode === "agent" ? <Select aria-label="智能体能力" placeholder="选择 Agent" value={agentId || undefined} disabled={busy} options={(meta?.agents || []).map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} /> : <span className="ui-mode-caption">一个问题，无限可能</span>}
        </div>
        {mode === "agent" && <p className="ui-agent-caption">{agent?.desc || "暂无可用 Agent"} · 多步骤分别计费，暂不支持图片。</p>}

        {/* 输入框：PromptBar 原语（窄/宽两态、自增高、上弹菜单） */}
        <PromptBar
          textareaRef={taRef}
          value={input}
          onChange={setInput}
          onSend={send}
          onStop={stop}
          busy={busy}
          disabled={unavailable || metaLoading || reading}
          models={meta?.models || []}
          model={model}
          onModelChange={(id) => {
            if (images.length && meta?.models?.find((m) => m.id === id)?.vision !== true) {
              toast.warning("请先移除图片再选择此模型");
              return;
            }
            setModel(id);
            setThinking(null);
          }}
          chips={images.map((src, i) => ({ src, label: `图片 ${i + 1}` }))}
          onRemoveChip={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
          onPickImage={mode === "chat" ? () => fileRef.current?.click() : undefined}
          visionOk={supportsVision && !reading}
          toggles={
            mode === "chat"
              ? [
                  { key: "thinking", label: "思考", title: "深度思考", icon: <BulbOutlined />, on: thinkingOn, onClick: () => setThinking(!thinkingOn) },
                  { key: "search", label: "联网", title: "联网搜索", icon: <GlobalOutlined />, on: search, onClick: () => setSearch(!search) },
                ]
              : []
          }
          placeholder={mode === "agent" ? "描述任务目标，以及你希望得到的结果…" : "输入你的问题，或分享一个想法…"}
          commands={[
            { key: "clear", name: "clear", desc: "清空当前对话", run: () => { setMsgs([]); setInput(""); setImages([]); } },
            ...(mode === "chat" ? [
              { key: "think", name: "think", desc: thinkingOn ? "关闭深度思考" : "开启深度思考", run: () => setThinking(!thinkingOn) },
              { key: "search", name: "search", desc: search ? "关闭联网搜索" : "开启联网搜索", run: () => setSearch(!search) },
            ] : []),
            { key: "agent", name: "agent", desc: "切换到 Agent 模式", run: () => setParams({ mode: "agent" }, { replace: true }) },
          ]}
        />
        <input type="file" ref={fileRef} hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={pickImages} />
      </div>
      <div className="ui-composer-footer"><span>AI 内容仅供参考 · 本页消息不自动保存</span><span>Enter 发送 · Shift + Enter 换行 · / 唤起命令</span></div>
    </div>
  </div>;
}
