// 对话页（原「对话工作台」）
// ---------------------------------------------------------------------------
// 页面结构（opencode 风格的三段式）：
//   左侧 Shelf  —— 会话列表（新建/切换/重命名/删除）+ harness 设定入口
//   顶部编排栏  —— 智能体 / 模型 / 思考 / 联网 / 工具开关 / 最大步数 / 会话指令
//   中间会话区  —— 消息按 parts 渲染（正文、思考链、工具 chip、待办清单）
// 数据全部来自服务端：会话与设定落库（chat_sessions），消息落库（chat_messages），
// 刷新页面不丢；本页只负责渲染与把用户操作发回服务端。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Popconfirm, Tooltip } from "antd";
import {
  CopyOutlined,
  ReloadOutlined,
  PlusOutlined,
  ArrowDownOutlined,
  MenuOutlined,
  SettingOutlined,
  DeleteOutlined,
  EditOutlined,
  CompassOutlined,
  BulbOutlined,
  CodeOutlined,
  EditFilled,
  SearchOutlined,
  AudioOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import { getToken } from "../services/api";
import { chatApi, runChatStream } from "../services/chat";
import { useApp } from "../context/AppContext";
import Markdown from "../components/Markdown";
import { OdCoin } from "../components/OdCoin";
import { CURRENCY_NAME, copyText, fmtOd, unitsPerOd } from "../services/format";
import { LoadingState, ThinkingState, StreamingText, PromptBar } from "../components/beautifului";
import {
  Shelf,
  ShelfGroup,
  ShelfItem,
  ToolChips,
  Notice,
  SuggestionCard,
  TodoPanel,
  OrchestrationBar,
} from "../components/beautifului-chat";
import "../components/chat.css";

const SUGGESTS = [
  { icon: <BulbOutlined />, title: "把复杂问题讲简单", desc: "从一个概念开始", prompt: "请用一个日常生活的例子解释：" },
  { icon: <CompassOutlined />, title: "帮我查清一件事", desc: "联网检索 + 给出处", prompt: "请帮我查清楚这件事的来龙去脉，并给出信息来源：", agent: "research" },
  { icon: <CodeOutlined />, title: "写出更好的代码", desc: "实现 + 边界情况", prompt: "请帮我实现下面的功能，并说明关键取舍：", agent: "coder" },
  { icon: <EditFilled />, title: "打磨一段文字", desc: "改写、压缩、润色", prompt: "请帮我润色下面的文字，保留原意：", agent: "writer" },
];

const AGENT_ICONS = {
  sparkles: <ThunderboltOutlined />,
  search: <SearchOutlined />,
  compass: <CompassOutlined />,
  edit: <EditOutlined />,
  code: <CodeOutlined />,
  check: <BulbOutlined />,
  compress: <AudioOutlined />,
};

const uid = () => Math.random().toString(36).slice(2, 10);
const ms = (p) => (p.ended && p.started ? Math.max(1, p.ended - p.started) : 0);
// 消息列表的渲染 key：seq 在流式期间是 0、done 之后才变成真实值，
// 用它当 key 会让消息在回答完成的一刻重挂载（入场动画重播、折叠态丢失）。
// 因此进入列表时固定一个本地 key，重发/回退整体替换时同样重新生成一遍。
const withKeys = (list = []) => list.map((m, i) => ({ ...m, key: m.key || `m${m.seq || 0}-${i}-${uid()}` }));

/* ---------------------------------------------------------------------------
 * 一条消息的渲染：
 *   user      → 右侧气泡（文字 + 图片）
 *   assistant → 无气泡正文，按 parts 顺序渲染：思考链 / 工具 chip / 正文 / 待办 / 提示
 * ------------------------------------------------------------------------- */
const Message = React.memo(function Message({ msg, busy, onRetry, onCopy, streaming }) {
  if (msg.role === "user") {
    const text = (msg.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const imgs = (msg.parts || []).filter((p) => p.type === "image").map((p) => p.url);
    return (
      <div className="ui-msg ui-msg-user">
        <div className="bubble">
          {text}
          {imgs.length ? (
            <div className="imgs">
              {imgs.map((src, i) => (
                <a key={i} href={src} target="_blank" rel="noreferrer">
                  <img src={src} alt={`附件图片 ${i + 1}`} />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const parts = msg.parts || [];
  const textParts = parts.filter((p) => p.type === "text");
  const reasoning = parts.filter((p) => p.type === "reasoning");
  const tools = parts.filter((p) => p.type === "tool");
  // 待办来自 todowrite 工具的结果（落在 tool part 上，刷新后依然在），或流式期间的 todo 事件
  const todo = parts.filter((p) => Array.isArray(p.todo)).slice(-1)[0]?.todo || msg.todo;
  const errors = parts.filter((p) => p.type === "error");
  const hasText = textParts.some((p) => (p.text || "").trim());
  const working = Boolean(streaming) && !hasText;
  const reasoningWorking = Boolean(streaming) && !hasText && reasoning.length > 0;

  return (
    <article className="ui-msg ui-msg-ai">
      {reasoning.length ? (
        <ThinkingState
          variant="Reasoning"
          working={reasoningWorking}
          activeTitle="正在思考"
          doneTitle="已完成思考"
          steps={reasoning.map((p) => ({ content: p.text, status: streaming ? "running" : "done" }))}
        />
      ) : null}

      {todo?.length ? <TodoPanel todo={todo} /> : null}
      <ToolChips calls={tools.map((t) => ({ ...t, ms: ms(t) }))} />

      {hasText ? (
        <StreamingText streaming={Boolean(streaming)} actions={[]}>
          <div className="prose">
            {textParts.map((p) => (
              <Markdown key={p.id} text={p.text} />
            ))}
          </div>
        </StreamingText>
      ) : working ? (
        <LoadingState label={tools.some((t) => t.status === "running") ? "正在调用工具" : "正在生成回答"} />
      ) : null}

      {errors.map((e) => (
        <Notice key={e.id} tone="warn" title="本轮说明">
          {e.message}
        </Notice>
      ))}

      {!streaming ? (
        <div className="ui-msg-actions">
          <Tooltip title="复制回答">
            <Button type="text" size="small" aria-label="复制回答" icon={<CopyOutlined />} disabled={!hasText} onClick={() => onCopy(textParts.map((p) => p.text).join("\n\n"))} />
          </Tooltip>
          <Tooltip title="重新生成会再次计费">
            <Popconfirm
              title="重新生成这条回答？"
              description="这会移除它之后的消息，并再次产生用量。"
              onConfirm={() => onRetry(msg)}
              disabled={busy}
              okText="重新生成"
              cancelText="取消"
            >
              <Button type="text" size="small" aria-label="重新生成" disabled={busy} icon={<ReloadOutlined />} />
            </Popconfirm>
          </Tooltip>
          {msg.cost ? (
            <span className="sp">
              <OdCoin size={13} />
              {msg.cost} {CURRENCY_NAME}
              {msg.tokens ? ` · ${msg.tokens.prompt + msg.tokens.completion} tokens` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

/* ============================ 命令面板（⌘K） ============================ */
function CommandPalette({ open, sessions, onClose, onPick, onNew }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const items = useMemo(() => {
    const list = [
      { key: "__new", label: "新建对话", hint: "Ctrl/⌘ + Shift + O", run: onNew, icon: <PlusOutlined /> },
      { key: "__settings", label: "打开设定", hint: "会话指令与统计", run: () => onPick("__settings"), icon: <SettingOutlined /> },
      ...sessions.map((s) => ({ key: s.id, label: s.title, hint: `${s.message_count} 条`, run: () => onPick(s.id), icon: null })),
    ];
    const key = q.trim().toLowerCase();
    return key ? list.filter((i) => i.label.toLowerCase().includes(key)) : list;
  }, [q, sessions, onNew, onPick]);

  if (!open) return null;
  return (
    <div className="bui-palette-mask" onMouseDown={onClose}>
      <div className="bui-palette" role="dialog" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="搜索会话，或执行操作…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && items[0]) {
              onClose();
              items[0].run();
            }
          }}
        />
        <div className="bui-palette-list">
          {items.length ? (
            items.map((it) => (
              <button
                key={it.key}
                type="button"
                className="bui-palette-row"
                onClick={() => {
                  onClose();
                  it.run();
                }}
              >
                <span className="ic">{it.icon}</span>
                <span className="tx">{it.label}</span>
                <span className="nm">{it.hint}</span>
              </button>
            ))
          ) : (
            <div className="bui-palette-empty">没有匹配的会话</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================ 会话指令 / 设定面板 ============================ */
function SettingsSheet({ open, onClose, meta, session, settings, onSettings, saving, quotaText }) {
  const [title, setTitle] = useState(session?.title || "");
  const [instructions, setInstructions] = useState(settings?.instructions || "");

  useEffect(() => {
    if (open) {
      setTitle(session?.title || "");
      setInstructions(settings?.instructions || "");
    }
  }, [open, session?.title, settings?.instructions]);

  if (!open) return null;
  const agent = meta?.agents?.find((a) => a.id === session?.agent);

  const save = async () => {
    const patch = {};
    if (title.trim() && title.trim() !== session?.title) patch.title = title.trim();
    if (instructions !== (settings?.instructions || "")) patch.instructions = instructions;
    await onSettings(patch);
  };

  return (
    <div className="ui-chat2-sheet-mask" onMouseDown={onClose}>
      <aside className="ui-chat2-sheet" role="dialog" aria-label="会话设定" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ui-chat2-sheet-head">
          <h3>会话设定</h3>
          <button type="button" className="ui-chat2-iconbtn" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ui-chat2-sheet-body">
          <div className="ui-chat2-field">
            <label htmlFor="chat-title">会话名称</label>
            <input id="chat-title" type="text" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="给这个会话起个名字" />
          </div>

          <div className="ui-chat2-field">
            <label htmlFor="chat-sys">会话指令（系统提示词）</label>
            <textarea
              id="chat-sys"
              value={instructions}
              maxLength={4000}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="例如：回答尽量简短；术语先给中文再给英文；代码用 TypeScript。"
            />
            <small>只作用于当前会话，会叠加在智能体角色之上；{4000 - instructions.length} 字可用。</small>
          </div>

          <div>
            <div className="ui-chat2-agentcard">
              <span style={{ display: "flex", color: "var(--accent)" }}>{AGENT_ICONS[agent?.icon] || <ThunderboltOutlined />}</span>
              <span>
                <strong>{agent?.name || "—"}</strong>
                {agent?.desc || ""}
                {agent?.tools?.length ? <><br />可用工具：{agent.tools.join("、")}</> : null}
              </span>
            </div>
          </div>

          <div>
            <div className="ui-chat2-kv">
              <span>消息数</span>
              <strong>{session?.message_count ?? 0}</strong>
            </div>
            <div className="ui-chat2-kv">
              <span>本会话累计消耗</span>
              <strong>
                {session?.cost ?? 0} {CURRENCY_NAME}
              </strong>
            </div>
            <div className="ui-chat2-kv">
              <span>Token（提示 / 补全）</span>
              <strong>
                {session?.prompt_tokens ?? 0} / {session?.completion_tokens ?? 0}
              </strong>
            </div>
            <div className="ui-chat2-kv">
              <span>创建时间</span>
              <strong>{session?.created_time ? new Date(session.created_time * 1000).toLocaleString("zh-CN") : "—"}</strong>
            </div>
            <div className="ui-chat2-kv">
              <span>账户余额</span>
              <strong>
                <OdCoin size={13} /> {quotaText}
              </strong>
            </div>
          </div>

          <Notice tone="info" title="关于计费">
            每轮对话按实际 token 计费，包括工具调用与子代理消耗的每一次上游请求；停止生成时，已产生的部分照常计费。
          </Notice>
        </div>
        <div className="ui-chat2-sheet-foot">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </div>
      </aside>
    </div>
  );
}

/* ============================ 页面 ============================ */
export default function ChatPage() {
  const { user, status, refreshUser } = useApp();
  const { message: toast } = AntApp.useApp();
  const [params, setParams] = useSearchParams();
  const requestedSession = params.get("s") || "";

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savingSheet, setSavingSheet] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [away, setAway] = useState(false);
  const [reading, setReading] = useState(false);

  const threadRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const stickyRef = useRef(true);
  const awayRef = useRef(false);
  const runningRef = useRef(null);
  const genRef = useRef(0); // 会话代际：切换会话后丢弃旧的异步结果
  const readingRef = useRef(false);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sendRef = useRef(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const models = meta?.models || [];
  const agents = (meta?.agents || []).filter((a) => a.mode === "primary");
  const curModel = models.find((m) => m.id === session?.model);
  const agent = meta?.agents?.find((a) => a.id === session?.agent);
  const settings = session?.settings || {};
  // 界面要显示「这一轮实际会怎么跑」：会话未显式设过思考/联网/工具时，
  // 用智能体默认值兜底（后端 runHarness 也是同一套优先级），否则开关会显示成关闭却实际在联网。
  const effective = useMemo(
    () => ({
      ...settings,
      thinking: typeof settings.thinking === "boolean" ? settings.thinking : Boolean(agent?.thinking),
      search: typeof settings.search === "boolean" ? settings.search : Boolean(agent?.search),
      tools: settings.tools ?? agent?.tools ?? [],
      maxSteps: settings.maxSteps || meta?.defaults?.maxSteps || 6,
      instructions: settings.instructions || "",
    }),
    [settings, agent, meta]
  );
  const quota = user?.quota != null ? fmtOd(user.quota, unitsPerOd(status), 4) : "—";
  const unavailable = !session || !curModel;

  /* ---------- 加载：元信息 + 会话列表 ---------- */
  const loadMeta = useCallback(async () => {
    setMetaError("");
    try {
      setMeta(await chatApi.meta());
    } catch (e) {
      setMetaError(e.message || "无法加载模型配置");
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await chatApi.listSessions();
      setSessions(data.sessions || []);
      return data.sessions || [];
    } catch (e) {
      toast.error(e.message || "加载会话列表失败");
      return [];
    }
  }, [toast]);

  useEffect(() => {
    loadMeta();
    loadSessions();
    // 卸载/离开页面时中止正在跑的流，避免回来后状态错乱
    return () => {
      genRef.current += 1;
      runningRef.current?.abort();
    };
  }, [loadMeta, loadSessions]);

  /* ---------- 打开会话 ---------- */
  const openSession = useCallback(
    async (id) => {
      if (!id) return;
      genRef.current += 1;
      const gen = genRef.current;
      runningRef.current?.abort();
      runningRef.current = null;
      setBusy(false);
      setLoadingSession(true);
      try {
        const data = await chatApi.getSession(id);
        if (genRef.current !== gen) return;
        setSession(data.session);
        setMsgs(withKeys(data.messages));
        setParams({ s: id }, { replace: true });
        // 换会话必须重置滚动状态：否则上一个会话滚到中间时留下的「回到最新」会跟着新会话显示
        stickyRef.current = true;
        awayRef.current = false;
        setAway(false);
      } catch (e) {
        if (genRef.current === gen) toast.error(e.message || "打开会话失败");
      } finally {
        if (genRef.current === gen) setLoadingSession(false);
      }
    },
    [setParams, toast]
  );

  /* 首屏：优先打开 URL 里的会话，否则用最近一条，都没有就新建 */
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current || !meta) return;
    bootRef.current = true;
    (async () => {
      const list = await loadSessions();
      const target = (requestedSession && list.find((s) => s.id === requestedSession)?.id) || list[0]?.id;
      if (target) return openSession(target);
      try {
        const created = await chatApi.createSession({ agent: meta.defaults?.agent || "general", model: models.find((m) => !m.deprecated)?.id || "" });
        if (!bootRef.current) return;
        setSession(created);
        setMsgs([]);
        setSessions((prev) => [created, ...prev]);
        setParams({ s: created.id }, { replace: true });
      } catch (e) {
        toast.error(e.message || "创建会话失败");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  /* ---------- 滚动跟随 ---------- */
  useEffect(() => {
    if (stickyRef.current && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    // 内容不足一屏时没有「最新消息」可回，不应出现跳转按钮（空会话/短会话）
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 100 || el.scrollHeight <= el.clientHeight + 4;
    stickyRef.current = atEnd;
    if (awayRef.current === atEnd) {
      awayRef.current = !atEnd;
      setAway(!atEnd);
    }
  };
  const scrollToEnd = () => {
    stickyRef.current = true;
    awayRef.current = false;
    setAway(false);
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  };

  /* ---------- 会话列表操作 ---------- */
  const newSession = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const created = await chatApi.createSession({
        agent: sessionRef.current?.agent || meta?.defaults?.agent || "general",
        model: sessionRef.current?.model || models.find((m) => !m.deprecated)?.id || "",
        settings: sessionRef.current?.settings || {},
      });
      setSessions((prev) => [created, ...prev]);
      setSession(created);
      setMsgs([]);
      setInput("");
      setImages([]);
      stickyRef.current = true;
      awayRef.current = false;
      setAway(false);
      setParams({ s: created.id }, { replace: true });
      setShelfOpen(false);
      taRef.current?.focus();
    } catch (e) {
      toast.error(e.message || "创建会话失败");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, models, setParams, toast]);

  const patchSession = useCallback(
    async (patch, { silent } = {}) => {
      const id = sessionRef.current?.id;
      if (!id) return;
      try {
        const next = await chatApi.patchSession(id, patch);
        setSession((prev) => (prev?.id === next.id ? next : prev));
        setSessions((prev) => prev.map((s) => (s.id === next.id ? { ...s, ...next } : s)));
        if (!silent) toast.success("已保存");
      } catch (e) {
        toast.error(e.message || "保存失败");
      }
    },
    [toast]
  );

  const deleteSession = useCallback(
    async (id) => {
      try {
        await chatApi.deleteSession(id);
        const list = sessions.filter((s) => s.id !== id);
        setSessions(list);
        if (sessionRef.current?.id === id) {
          if (list[0]) openSession(list[0].id);
          else {
            setSession(null);
            setMsgs([]);
            setParams({}, { replace: true });
            bootRef.current = false;
          }
        }
      } catch (e) {
        toast.error(e.message || "删除失败");
      }
    },
    [sessions, openSession, setParams, toast]
  );

  /* ---------- 运行一轮 ---------- */
  const send = useCallback(
    (overrideText) => {
      const text = String(overrideText ?? input).trim();
      const current = sessionRef.current;
      if ((!text && !images.length) || busyRef.current || !current) return;
      if (current.settings?.tools?.length && curModel?.supportsSearch === false) {
        // 搜索工具在部分模型上不可用：不阻断，只提示（工具本身也会返回失败原因）
        // eslint-disable-next-line no-console
        console.debug("[chat] 当前模型不支持联网检索");
      }

      const userMsg = { key: `u-${uid()}`, seq: 0, role: "user", parts: [{ id: uid(), type: "text", text }, ...images.map((url) => ({ id: uid(), type: "image", url }))] };
      const aiMsg = { key: `a-${uid()}`, seq: 0, role: "assistant", parts: [], streaming: true, agent: current.agent, model: current.model };
      setMsgs((prev) => [...prev, userMsg, aiMsg]);
      if (overrideText == null) {
        setInput("");
        setImages([]);
      }
      stickyRef.current = true;
      awayRef.current = false;
      setAway(false);
      setBusy(true);

      const myGen = genRef.current;
      let finished = false;
      // 流式期间只改最后一条消息：按 id 命中，避免整表 map 带来的无谓拷贝
      const patchAi = (fn) => {
        if (genRef.current !== myGen) return;
        setMsgs((prev) => {
          const idx = prev.length - 1;
          const last = prev[idx];
          if (!last || last.role !== "assistant" || !last.streaming) return prev;
          const next = fn(last);
          if (next === last) return prev;
          const copy = prev.slice();
          copy[idx] = next;
          return copy;
        });
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        patchAi((m) => ({ ...m, streaming: false }));
        runningRef.current = null;
        setBusy(false);
        refreshUser?.();
        loadSessions();
      };

      runningRef.current = runChatStream(
        {
          sessionId: current.id,
          text,
          images: images.map((dataUrl) => ({ dataUrl })),
          model: current.model,
          agent: current.agent,
          settings: current.settings,
        },
        {
          token: getToken(),
          onEvent: (ev) => {
            if (genRef.current !== myGen) return;
            if (ev.type === "part") patchAi((m) => ({ ...m, parts: [...m.parts, ev.part] }));
            else if (ev.type === "part_update")
              patchAi((m) => ({ ...m, parts: m.parts.map((p) => (p.id === ev.id ? { ...p, ...ev.patch } : p)) }));
            else if (ev.type === "delta")
              patchAi((m) => ({ ...m, parts: m.parts.map((p) => (p.id === ev.id ? { ...p, [ev.field]: (p[ev.field] || "") + ev.delta } : p)) }));
            else if (ev.type === "todo") patchAi((m) => ({ ...m, todo: ev.todo }));
            else if (ev.type === "done") {
              patchAi((m) => ({ ...m, ...ev.message, streaming: false, todo: ev.todo }));
              if (ev.session) {
                setSession(ev.session);
                setSessions((prev) => prev.map((s) => (s.id === ev.session.id ? { ...s, ...ev.session } : s)));
              }
              finish();
            } else if (ev.type === "error") {
              patchAi((m) => ({ ...m, parts: [...m.parts, { id: uid(), type: "error", message: ev.message }] }));
            }
          },
          onError: (e) => {
            if (genRef.current !== myGen) return;
            patchAi((m) => ({ ...m, parts: [...m.parts, { id: uid(), type: "error", message: e.message || "网络连接失败" }] }));
            finish();
          },
          onDone: finish,
        }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, images, curModel, refreshUser, loadSessions]
  );
  sendRef.current = send;

  const stop = useCallback(() => {
    runningRef.current?.abort();
    runningRef.current = null;
    setBusy(false);
    setMsgs((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.streaming ? { ...m, streaming: false, parts: [...m.parts, { id: uid(), type: "error", message: "已停止接收。本轮已产生的用量照常计费。" }] } : m
      )
    );
    // 服务端在断开后仍会对已产出内容补计费：稍后刷新余额，避免界面一直显示旧值
    setTimeout(() => refreshUser?.(), 1500);
    loadSessions();
  }, [refreshUser, loadSessions]);

  const retry = useCallback(
    async (msg) => {
      if (busyRef.current) return;
      const list = msgsRef.current;
      const index = list.indexOf(msg);
      const userMsg = list[index - 1];
      if (!userMsg || userMsg.role !== "user") return;
      const text = (userMsg.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const imgs = (userMsg.parts || []).filter((p) => p.type === "image").map((p) => p.url);
      // 服务端回退：这一轮问答要从库里删掉，否则重发后上下文里同一个问题会出现两遍
      if (userMsg.seq) {
        try {
          const data = await chatApi.rewind(sessionRef.current.id, userMsg.seq);
          setSession(data.session);
          setSessions((prev) => prev.map((s) => (s.id === data.session.id ? { ...s, ...data.session } : s)));
          setMsgs(withKeys(data.messages));
        } catch (e) {
          toast.error(e.message || "重新生成失败");
          return;
        }
      } else {
        setMsgs(list.slice(0, index - 1));
      }
      setImages(imgs);
      setTimeout(() => sendRef.current?.(text), 0);
    },
    [toast]
  );

  const copy = useCallback(
    async (text) => {
      try {
        await copyText(text);
        toast.success("已复制");
      } catch {
        toast.error("复制失败，请手动选择文字复制");
      }
    },
    [toast]
  );

  const pickImages = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (readingRef.current || busy) return;
    if (curModel && curModel.vision !== true) {
      toast.warning("当前模型不支持图片，请先切换模型");
      return;
    }
    if (files.length + images.length > 3) {
      toast.warning("最多上传 3 张图片");
      return;
    }
    if (files.some((f) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type))) {
      toast.warning("请选择 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    readingRef.current = true;
    setReading(true);
    try {
      const data = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error("图片读取失败"));
              reader.readAsDataURL(file);
            })
        )
      );
      setImages((prev) => [...prev, ...data]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  };

  /* ---------- 设定改动 ---------- */
  const patchSettings = useCallback(
    async (key, value) => {
      const current = sessionRef.current;
      if (!current) return;
      const next = { ...(current.settings || {}), [key]: value };
      setSession((prev) => ({ ...prev, settings: next })); // 先乐观更新，界面不卡
      await patchSession({ settings: next }, { silent: true });
    },
    [patchSession]
  );

  const setAgent = useCallback(
    (id) => {
      const a = meta?.agents?.find((x) => x.id === id);
      // 换智能体 = 换一套做事方式：思考/联网/工具回到该智能体的默认值（清空为 null 让后端按 agent 兜底），
      // 只保留用户写的会话指令
      const next = { thinking: null, search: null, tools: a?.tools || [], instructions: sessionRef.current?.settings?.instructions || "" };
      setSession((prev) => (prev ? { ...prev, agent: id, settings: next } : prev));
      patchSession({ agent: id, settings: next }, { silent: true });
    },
    [meta, patchSession]
  );

  const setModel = useCallback(
    (id) => {
      const m = models.find((x) => x.id === id);
      const patch = { model: id };
      // 切到不支持联网的模型时关掉搜索，避免继续带着无效参数请求上游
      if (m?.supportsSearch === false) patch.settings = { ...(sessionRef.current?.settings || {}), search: false };
      setSession((prev) => (prev ? { ...prev, ...patch, settings: patch.settings || prev.settings } : prev));
      patchSession(patch, { silent: true });
    },
    [models, patchSession]
  );

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newSession();
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const pickFromPalette = (id) => {
    if (id === "__settings") setSheetOpen(true);
    else openSession(id);
  };

  const supportsVision = curModel?.vision === true;
  const sessionCost = session?.cost ?? 0;

  /* ---------- 渲染 ---------- */
  return (
    <div className="ui-chat2">
      <Shelf
        className={shelfOpen ? "is-open" : ""}
        // 移动端：点空白处收起（桌面端常驻）
      >
        <ShelfGroup
          title="会话"
          action={
            <button type="button" className="bui-shelf-act" aria-label="新建对话" title="新建对话（Ctrl+Shift+O）" onClick={newSession} disabled={busy}>
              <PlusOutlined />
            </button>
          }
        >
          {sessions.length ? (
            sessions.map((s) => (
              <ShelfItem
                key={s.id}
                active={s.id === session?.id}
                label={s.title}
                title={`${s.title}（双击重命名）`}
                hint={s.message_count ? String(s.message_count) : ""}
                onClick={() => {
                  openSession(s.id);
                  setShelfOpen(false);
                }}
                onRename={(title) => {
                  setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, title } : x)));
                  if (s.id === sessionRef.current?.id) setSession((prev) => ({ ...prev, title }));
                  chatApi.patchSession(s.id, { title }).catch((e) => toast.error(e.message || "重命名失败"));
                }}
                actions={
                  <>
                    <Popconfirm title="删除这个会话？" description="消息与统计一并删除，无法恢复。" okText="删除" cancelText="取消" onConfirm={() => deleteSession(s.id)}>
                      <button type="button" className="bui-shelf-act is-danger" aria-label={`删除会话 ${s.title}`} onClick={(e) => e.stopPropagation()}>
                        <DeleteOutlined />
                      </button>
                    </Popconfirm>
                  </>
                }
              />
            ))
          ) : (
            <div className="bui-shelf-empty">还没有会话，点上方 + 或直接输入第一句话。</div>
          )}
        </ShelfGroup>

        <div className="bui-shelf-foot">
          <div>余额 {quota} · 按实际用量计费</div>
          {sessionCost ? <div>本会话已用 {sessionCost} {CURRENCY_NAME}</div> : null}
        </div>
      </Shelf>

      <div className="ui-chat2-main">
        <header className="ui-chat2-head">
          <div className="ui-chat2-title">
            <button
              type="button"
              className="ui-chat2-iconbtn is-shelf-toggle"
              aria-label="会话列表"
              aria-expanded={shelfOpen}
              onClick={() => setShelfOpen((v) => !v)}
            >
              <MenuOutlined />
            </button>
            <h1>{session?.title || "对话"}</h1>
            <div className="meta">
              {agent?.name ? <span>{agent.name}</span> : null}
              {session?.model ? <span>· {session.model}</span> : null}
              <span>· {msgs.length} 条消息</span>
            </div>
          </div>
          <div className="ui-chat2-head-actions">
            <Tooltip title="命令面板（Ctrl/⌘ + K）">
              <button type="button" className="ui-chat2-iconbtn" aria-label="命令面板" onClick={() => setPaletteOpen(true)}>
                <SearchOutlined />
              </button>
            </Tooltip>
            <Tooltip title="会话设定">
              <button type="button" className="ui-chat2-iconbtn" aria-label="会话设定" onClick={() => setSheetOpen(true)}>
                <SettingOutlined />
              </button>
            </Tooltip>
            <Tooltip title="新建对话（Ctrl/⌘ + Shift + O）">
              <button type="button" className="ui-chat2-iconbtn" aria-label="新建对话" onClick={newSession} disabled={busy}>
                <PlusOutlined />
              </button>
            </Tooltip>
          </div>
        </header>

        <OrchestrationBar
          agent={agent}
          agents={agents}
          model={session?.model}
          models={models}
          settings={effective}
          tools={meta?.tools || []}
          disabled={busy || !session}
          onAgent={setAgent}
          onModel={setModel}
          onSetting={patchSettings}
          onOpenInstructions={() => setSheetOpen(true)}
        />

        {metaError ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice
              tone="error"
              title="模型配置加载失败"
              actions={
                <Button size="small" onClick={loadMeta}>
                  重试
                </Button>
              }
            >
              {metaError}
            </Notice>
          </div>
        ) : null}
        {!metaError && meta && !models.length ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice tone="warn" title="暂时没有可用模型">请联系管理员在渠道管理里启用至少一个渠道。</Notice>
          </div>
        ) : null}

        <div className="ui-chat2-thread" ref={threadRef} onScroll={onThreadScroll}>
          <div className="ui-chat2-thread-inner">
            {loadingSession ? (
              <LoadingState label="正在打开会话" />
            ) : msgs.length ? (
              msgs.map((m, i) => (
                <Message
                  // key 不能用 seq：done 事件回来时 seq 从 0 变成真实值，会让整条消息重挂载（动画重播）
                  key={m.key || `i${i}`}
                  msg={m}
                  busy={busy}
                  streaming={Boolean(m.streaming)}
                  onRetry={retry}
                  onCopy={copy}
                />
              ))
            ) : (
              <section className="ui-chat2-welcome">
                <div className="bui-eyebrow">OOAPI · 对话</div>
                <h2>今天，想弄清楚什么？</h2>
                <p>直接提问即可。需要查资料、读网页时，智能体会自己调用工具，并把过程摊开给你看。</p>
                <div className="bui-suggests">
                  {SUGGESTS.map((s) => (
                    <SuggestionCard
                      key={s.title}
                      icon={s.icon}
                      title={s.title}
                      desc={s.desc}
                      onClick={() => {
                        if (s.agent && agents.some((a) => a.id === s.agent)) setAgent(s.agent);
                        setInput(s.prompt);
                        taRef.current?.focus();
                      }}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="ui-chat2-composer">
          {away && msgs.length > 3 ? (
            <button type="button" className="ui-chat2-jump" onClick={scrollToEnd}>
              <ArrowDownOutlined /> 回到最新
            </button>
          ) : null}

          <PromptBar
            textareaRef={taRef}
            value={input}
            onChange={setInput}
            onSend={() => send()}
            onStop={stop}
            busy={busy}
            disabled={unavailable || reading}
            models={models}
            model={session?.model || ""}
            onModelChange={setModel}
            chips={images.map((src, i) => ({ src, label: `图片 ${i + 1}` }))}
            onRemoveChip={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onPickImage={() => fileRef.current?.click()}
            visionOk={supportsVision && !reading}
            placeholder={busy ? "正在生成…" : "输入你的问题，或分享一个想法…"}
            commands={[
              { key: "new", name: "new", desc: "新建对话", run: newSession },
              { key: "clear", name: "clear", desc: "清空当前会话消息", run: () => { setMsgs([]); setInput(""); setImages([]); } },
              { key: "setting", name: "setting", desc: "打开会话设定", run: () => setSheetOpen(true) },
              { key: "tools", name: "tools", desc: "切换工具开关（按智能体默认）", run: () => patchSettings("tools", agent?.tools || []) },
            ]}
          />
          <input type="file" ref={fileRef} hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={pickImages} />

          <div className="ui-chat2-composer-foot">
            <span>AI 内容仅供参考 · 对话会保存在你的账户里</span>
            <span>Enter 发送 · Shift + Enter 换行 · / 命令 · Ctrl/⌘ + K 面板</span>
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        sessions={sessions}
        onClose={() => setPaletteOpen(false)}
        onPick={pickFromPalette}
        onNew={newSession}
      />

      <SettingsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        meta={meta}
        session={session}
        settings={settings}
        saving={savingSheet}
        quotaText={quota}
        onSettings={async (patch) => {
          setSavingSheet(true);
          try {
            const body = { ...patch };
            if (body.instructions !== undefined) {
              body.settings = { ...(sessionRef.current?.settings || {}), instructions: body.instructions };
              delete body.instructions;
            }
            await patchSession(body);
            setSheetOpen(false);
          } finally {
            setSavingSheet(false);
          }
        }}
      />
    </div>
  );
}
