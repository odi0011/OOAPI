// 对话页（原「对话工作台」）
// ---------------------------------------------------------------------------
// 页面结构（opencode 风格的三段式）：
//   左侧 Shelf  —— 会话列表（新建/切换/重命名/删除）+ harness 设定入口
//   顶部编排栏  —— 智能体 / 模型 / 思考 / 联网 / 工具开关 / 最大步数 / 会话指令
//   中间会话区  —— 消息按 parts 渲染（正文、思考链、工具 chip、待办清单）
// 数据全部来自服务端：会话与设定落库（chat_sessions），消息落库（chat_messages），
// 刷新页面不丢；本页只负责渲染与把用户操作发回服务端。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Dropdown, Popconfirm, Tooltip } from "antd";
import {
  CopyOutlined,
  SelectOutlined,
  InboxOutlined,
  PushpinOutlined,
  FileTextOutlined,
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { getToken } from "../services/api";
import { chatApi, runChatStream, resumeChatStream } from "../services/chat";
import { useApp } from "../context/AppContext";
import Markdown from "../components/Markdown";
import { OdCoin } from "../components/OdCoin";
import { CURRENCY_NAME, copyText, fmtOd, unitsPerOd } from "../services/format";
import { LoadingState, ThinkingState, StreamingText } from "../components/beautifului";
import PromptBar from "../components/PromptBar";
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
    const files = (msg.parts || []).filter((p) => p.type === "file");
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
          {files.length ? (
            <div className="files">
              {files.map((f, i) => (
                <span key={i} className="file-chip" title={`${f.name}${f.kind ? ` · ${f.kind}` : ""}`}>
                  <FileTextOutlined />
                  <span className="nm">{f.name}</span>
                  {f.bytes ? <span className="kb">{Math.max(1, Math.round(f.bytes / 1024))}KB</span> : null}
                </span>
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
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedSession = params.get("s") || "";

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [counts, setCounts] = useState({ active: 0, archived: 0, byProject: {} });
  // 侧栏视图：active=进行中 / archived=已归档 / 某个项目 id
  const [view, setView] = useState("active");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [session, setSession] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savingSheet, setSavingSheet] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [docs, setDocs] = useState([]); // 文档附件 [{name,size,type,dataUrl}]
  // 选中密钥：站内对话扣账户额度，但路由配置（分组 → 可用模型/渠道/倍率）挂在密钥上。
  // 0 = 用账户默认分组，与老行为一致。
  const [keyId, setKeyId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [away, setAway] = useState(false);
  const [reading, setReading] = useState(false);

  const threadRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const docRef = useRef(null);
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
  const attachRunningRef = useRef(null);
  const attachedRef = useRef(""); // 已经接上事件流的会话 id（防重复订阅导致内容重放叠加）
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
  // 对话必须通过密钥路由：没有可用密钥就没有可用模型，输入区与编排栏一并禁用
  const usableKeys = (meta?.keys || []).filter((k) => k.status === 1);
  const needKey = Boolean(meta) && !usableKeys.length;
  const unavailable = !session || !curModel || needKey;

  /* ---------- 加载：元信息 + 会话列表 ---------- */
  const loadMeta = useCallback(async (forKeyId = 0) => {
    setMetaError("");
    try {
      const data = await chatApi.meta(forKeyId);
      setMeta(data);
      const keys = data.keys || [];
      // 对话必须通过密钥路由（分组 → 模型/渠道/倍率）：
      //   · 没显式选密钥时，自动选中第一个可用密钥并按其能力重算模型
      //   · 当前密钥被禁用/删除时回到自动选择
      if (forKeyId === 0) {
        const first = keys.find((k) => k.status === 1);
        if (first) {
          setKeyId(first.id);
          return loadMeta(first.id);
        }
      } else if (!keys.some((k) => k.id === forKeyId && k.status === 1)) {
        setKeyId(0);
        return loadMeta(0);
      }
      // 切密钥后模型集合会变：当前模型不在新集合里就自动换到第一个可用模型
      setSession((prev) => {
        if (!prev) return prev;
        const ok = (data.models || []).some((m) => m.id === prev.model);
        return ok ? prev : { ...prev, model: (data.models || [])[0]?.id || "" };
      });
    } catch (e) {
      setMetaError(e.message || "无法加载模型配置");
    }
  }, []);

  const loadSessions = useCallback(
    async (nextView = view) => {
      try {
        // 归档视图与项目视图各自拉取；计数与项目列表每次都刷新（移动/归档后侧栏要立刻更新）
        const archived = nextView === "archived" ? "true" : "false";
        const projectId = nextView !== "active" && nextView !== "archived" ? nextView : "";
        const [data, proj] = await Promise.all([
          chatApi.listSessions({ archived, projectId }),
          chatApi.listProjects().catch(() => ({ projects: [] })),
        ]);
        setSessions(data.sessions || []);
        setCounts(data.counts || { active: 0, archived: 0, byProject: {} });
        setProjects(proj.projects || []);
        return data.sessions || [];
      } catch (e) {
        toast.error(e.message || "加载会话列表失败");
        return [];
      }
    },
    [toast, view]
  );

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
      attachedRef.current = ""; // 换会话：上一个会话的订阅标记作废
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
        // 这个会话可能正在生成（用户切页/刷新前提交的）：接回事件流，界面无缝恢复。
        // 走 ref：attachRunning 定义在本函数之后，直接进依赖数组会在渲染期触发 TDZ。
        attachRunningRef.current?.(id, gen);
      } catch (e) {
        if (genRef.current === gen) toast.error(e.message || "打开会话失败");
      } finally {
        if (genRef.current === gen) setLoadingSession(false);
      }
    },
    [setParams, toast]
  );

  /* ---------- 断线续传：接回服务端正在跑的生成 ---------- */
  // 刷新 / 切页回来时，服务端那一轮可能还在跑（也可能已跑完）。
  // 这里先问一次状态，在跑就订阅 /stream：服务端会先回放已缓冲的事件，界面无缝恢复。
  const attachRunning = useCallback(
    (sessionId, gen) => {
      if (!sessionId) return;
      // 同一会话只允许接一次：StrictMode 双挂载 / 重复打开会话都会调进来，
      // 订阅两次会把已缓冲的事件重放两遍，界面上就是思考链和正文被叠加。
      if (attachedRef.current === sessionId) return;
      (async () => {
        let running = false;
        try {
          const st = await chatApi.running(sessionId);
          running = Boolean(st?.running);
        } catch {
          return; // 没有在跑（404）或出错了，静默即可
        }
        if (!running || genRef.current !== gen) return;
        if (attachedRef.current === sessionId) return; // 期间已被另一次调用接上
        attachedRef.current = sessionId;

        const aiKey = `a-${uid()}`;
        const aiMsg = { key: aiKey, seq: 0, role: "assistant", parts: [], streaming: true };
        setMsgs((prev) => [...prev, aiMsg]);
        setBusy(true);
        stickyRef.current = true;

        // 与 send 里同一套事件处理：按 part.id 增量更新最后一条消息
        const patchAi = (fn) => {
          if (genRef.current !== gen) return;
          setMsgs((prev) => {
            const idx = prev.length - 1;
            const last = prev[idx];
            if (!last || last.key !== aiKey) return prev;
            const next = fn(last);
            if (next === last) return prev;
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
          });
        };
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          attachedRef.current = "";
          patchAi((m) => ({ ...m, streaming: false }));
          runningRef.current = null;
          setBusy(false);
          refreshUser?.();
          loadSessions();
        };

        runningRef.current = resumeChatStream(sessionId, {
          token: getToken(),
          onEvent: (ev) => {
            if (genRef.current !== gen) return;
            // 同一个 part 可能被推两次（重连回放 + 实时事件交错）：按 id 覆盖而不是追加，
            // 否则界面会出现两份内容
            if (ev.type === "part")
              patchAi((m) => ({
                ...m,
                parts: m.parts.some((p) => p.id === ev.part.id) ? m.parts.map((p) => (p.id === ev.part.id ? ev.part : p)) : [...m.parts, ev.part],
              }));
            else if (ev.type === "part_update")
              patchAi((m) => ({ ...m, parts: m.parts.map((p) => (p.id === ev.id ? { ...p, ...ev.patch } : p)) }));
            else if (ev.type === "delta")
              patchAi((m) => ({ ...m, parts: m.parts.map((p) => (p.id === ev.id ? { ...p, [ev.field]: (p[ev.field] || "") + ev.delta } : p)) }));
            else if (ev.type === "todo") patchAi((m) => ({ ...m, todo: ev.todo }));
            else if (ev.type === "done") {
              patchAi((m) => ({ ...m, ...ev.message, streaming: false, todo: ev.todo }));
              if (ev.session) {
                setSession(ev.session);
                setSessions((prev) => prev.map((x) => (x.id === ev.session.id ? { ...x, ...ev.session } : x)));
              }
              finish();
            } else if (ev.type === "stopped") {
              patchAi((m) => ({ ...m, parts: [...m.parts, { id: uid(), type: "error", message: ev.message }] }));
              finish();
            } else if (ev.type === "error") {
              patchAi((m) => ({ ...m, parts: [...m.parts, { id: uid(), type: "error", message: ev.message }] }));
            }
          },
          onError: () => {
            // 重连失败：把这条占位消息收尾，用户可正常刷新查看
            patchAi((m) => ({ ...m, parts: [...m.parts, { id: uid(), type: "error", message: "与服务器的连接已断开，刷新页面可查看完整结果。" }] }));
            finish();
          },
          onDone: finish,
        });
      })();
    },
    [refreshUser, loadSessions]
  );
  attachRunningRef.current = attachRunning;

  /* ---------- 侧栏：项目 / 归档 / 批量 ---------- */
  const switchView = useCallback(
    (next) => {
      setView(next);
      setSelected(new Set());
      loadSessions(next);
    },
    [loadSessions]
  );

  const archiveSession = useCallback(
    async (id) => {
      if (!id) return;
      try {
        await chatApi.batch([id], "archive");
        toast.success("已归档");
        const list = await loadSessions();
        if (sessionRef.current?.id === id) {
          if (list[0]) openSession(list[0].id);
          else setSession(null);
        }
      } catch (e) {
        toast.error(e.message || "归档失败");
      }
    },
    [loadSessions, openSession, toast]
  );

  const batchAction = useCallback(
    async (action, projectId) => {
      const ids = [...selected];
      if (!ids.length) return;
      try {
        const r = await chatApi.batch(ids, action, projectId);
        const label = { archive: "归档", unarchive: "取消归档", delete: "删除", move: "移动", pin: "置顶", unpin: "取消置顶" }[action] || "操作";
        toast.success(`已${label} ${r.affected} 个对话`);
        const stillThere = !ids.includes(sessionRef.current?.id) || action === "pin" || action === "unpin";
        setSelected(new Set());
        const list = await loadSessions();
        if (!stillThere && list[0]) openSession(list[0].id);
        else if (!stillThere) setSession(null);
      } catch (e) {
        toast.error(e.message || "批量操作失败");
      }
    },
    [selected, loadSessions, openSession, toast]
  );

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const createProject = useCallback(async () => {
    const name = String(prompt("新项目名称") || "").trim();
    if (!name) return;
    try {
      const p = await chatApi.createProject({ name });
      setProjects((prev) => [p, ...prev]);
      toast.success("项目已创建");
    } catch (e) {
      toast.error(e.message || "创建项目失败");
    }
  }, [toast]);

  const deleteProject = useCallback(
    async (id) => {
      try {
        await chatApi.deleteProject(id);
        toast.success("项目已删除（其中的对话已退回未归类）");
        if (view === id) switchView("active");
        else loadSessions();
      } catch (e) {
        toast.error(e.message || "删除项目失败");
      }
    },
    [view, switchView, loadSessions, toast]
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
      if ((!text && !images.length && !docs.length) || busyRef.current || !current) return;
      if (current.settings?.tools?.length && curModel?.supportsSearch === false) {
        // 搜索工具在部分模型上不可用：不阻断，只提示（工具本身也会返回失败原因）
        // eslint-disable-next-line no-console
        console.debug("[chat] 当前模型不支持联网检索");
      }

      const userMsg = {
        key: `u-${uid()}`,
        seq: 0,
        role: "user",
        parts: [
          { id: uid(), type: "text", text },
          ...images.map((url) => ({ id: uid(), type: "image", url })),
          // 文件只放元信息，正文由服务端解析后回填（避免把大段文本塞进前端状态）
          ...docs.map((d) => ({ id: uid(), type: "file", name: d.name, bytes: d.size })),
        ],
      };
      const aiMsg = { key: `a-${uid()}`, seq: 0, role: "assistant", parts: [], streaming: true, agent: current.agent, model: current.model };
      setMsgs((prev) => [...prev, userMsg, aiMsg]);
      if (overrideText == null) {
        setInput("");
        setImages([]);
        setDocs([]);
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
        attachedRef.current = "";
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
          files: docs.map((d) => ({ name: d.name, type: d.type, dataUrl: d.dataUrl })),
          keyId,
          model: current.model,
          agent: current.agent,
          settings: current.settings,
        },
        {
          token: getToken(),
          onEvent: (ev) => {
            if (genRef.current !== myGen) return;
            // 同一个 part 可能被推两次（重连回放 + 实时事件交错）：按 id 覆盖而不是追加，
            // 否则界面会出现两份内容
            if (ev.type === "part")
              patchAi((m) => ({
                ...m,
                parts: m.parts.some((p) => p.id === ev.part.id) ? m.parts.map((p) => (p.id === ev.part.id ? ev.part : p)) : [...m.parts, ev.part],
              }));
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
    [input, images, docs, keyId, curModel, refreshUser, loadSessions]
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

  // 文档附件：前端只负责读成 base64，真正的解析（PDF/Word/Excel）在服务端做。
  // 类型校验放在服务端兜底，这里先按扩展名做一次快速提示，避免白传大文件。
  const pickDocs = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (readingRef.current || busy) return;
    const MAX = 5;
    const MAX_BYTES = 8 * 1024 * 1024;
    if (files.length + docs.length > MAX) {
      toast.warning(`最多同时上传 ${MAX} 个文件`);
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      toast.warning(`「${tooBig.name}」超过 8MB，请压缩或截取需要的部分`);
      return;
    }
    readingRef.current = true;
    setReading(true);
    try {
      const loaded = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({ name: file.name, size: file.size, type: file.type, dataUrl: reader.result });
              reader.onerror = () => reject(new Error(`「${file.name}」读取失败`));
              reader.readAsDataURL(file);
            })
        )
      );
      setDocs((prev) => [...prev, ...loaded]);
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
        {/* 新建对话（ChatGPT 式：最上面一个显眼的动作） */}
        <button type="button" className="bui-shelf-new" onClick={newSession} disabled={busy}>
          <span className="ic">
            <PlusOutlined />
          </span>
          新建对话
        </button>

        {/* 视图切换：进行中 / 已归档 */}
        <div className="bui-shelf-tabs">
          <button
            type="button"
            className={`bui-shelf-tab ${view === "active" ? "is-on" : ""}`}
            onClick={() => switchView("active")}
          >
            对话
            {counts.active ? <span className="ct">{counts.active}</span> : null}
          </button>
          <button
            type="button"
            className={`bui-shelf-tab ${view === "archived" ? "is-on" : ""}`}
            onClick={() => switchView("archived")}
          >
            已归档
            {counts.archived ? <span className="ct">{counts.archived}</span> : null}
          </button>
        </div>

        {/* 项目（分类）：点进去只看该项目下的对话 */}
        <ShelfGroup
          title="项目"
          defaultOpen
          action={
            <button type="button" className="bui-shelf-act" aria-label="新建项目" title="新建项目" onClick={createProject}>
              <PlusOutlined />
            </button>
          }
        >
          {projects.length ? (
            projects.map((p) => (
              <ShelfItem
                key={p.id}
                active={view === p.id}
                label={p.name}
                title={`${p.name}（双击重命名）`}
                hint={counts.byProject?.[p.id] ? String(counts.byProject[p.id]) : ""}
                onClick={() => {
                  switchView(p.id);
                  setShelfOpen(false);
                }}
                onRename={(name) => {
                  setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, name } : x)));
                  chatApi.updateProject(p.id, { name }).catch((e) => toast.error(e.message || "重命名失败"));
                }}
                actions={
                  <Popconfirm
                    title="删除这个项目？"
                    description="项目里的对话不会被删除，会退回「未归类」。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => deleteProject(p.id)}
                  >
                    <button type="button" className="bui-shelf-act is-danger" aria-label={`删除项目 ${p.name}`} onClick={(e) => e.stopPropagation()}>
                      <DeleteOutlined />
                    </button>
                  </Popconfirm>
                }
              />
            ))
          ) : (
            <div className="bui-shelf-empty">还没有项目。用项目把对话分类，例如「工作」「学习」。</div>
          )}
        </ShelfGroup>

        {/* 对话列表：支持多选批量（归档 / 删除 / 移动项目） */}
        <ShelfGroup
          title={view === "archived" ? "已归档的对话" : "对话"}
          action={
            sessions.length ? (
              <button
                type="button"
                className={`bui-shelf-act ${selectMode ? "is-on" : ""}`}
                aria-label={selectMode ? "退出多选" : "多选"}
                title={selectMode ? "退出多选" : "多选：批量归档 / 删除 / 移动到项目"}
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelected(new Set());
                }}
              >
                <SelectOutlined />
              </button>
            ) : null
          }
        >
          {selectMode && selected.size ? (
            <div className="bui-shelf-batch">
              <span>已选 {selected.size} 个</span>
              <div className="acts">
                {view === "archived" ? (
                  <button type="button" onClick={() => batchAction("unarchive")} title="取消归档">
                    取消归档
                  </button>
                ) : (
                  <button type="button" onClick={() => batchAction("archive")} title="归档">
                    归档
                  </button>
                )}
                {projects.length ? (
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: projects.map((p) => ({ key: p.id, label: p.name, onClick: () => batchAction("move", p.id) })),
                    }}
                  >
                    <button type="button" title="移动到项目">
                      移动
                    </button>
                  </Dropdown>
                ) : null}
                <Popconfirm
                  title={`删除选中的 ${selected.size} 个对话？`}
                  description="消息与统计一并删除，无法恢复。"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => batchAction("delete")}
                >
                  <button type="button" className="is-danger" title="删除">
                    删除
                  </button>
                </Popconfirm>
              </div>
            </div>
          ) : null}

          {sessions.length ? (
            sessions.map((s) =>
              selectMode ? (
                <label key={s.id} className="bui-shelf-pick">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} />
                  <span className="tx">{s.title}</span>
                  {s.pinned ? <span className="hn">置顶</span> : null}
                </label>
              ) : (
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
                      <Tooltip title={s.pinned ? "取消置顶" : "置顶"}>
                        <button
                          type="button"
                          className="bui-shelf-act"
                          aria-label={s.pinned ? `取消置顶 ${s.title}` : `置顶 ${s.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            chatApi
                              .patchSession(s.id, { pinned: !s.pinned })
                              .then(() => loadSessions())
                              .catch((err) => toast.error(err.message || "操作失败"));
                          }}
                        >
                          <PushpinOutlined />
                        </button>
                      </Tooltip>
                      <Tooltip title="归档">
                        <button
                          type="button"
                          className="bui-shelf-act"
                          aria-label={`归档 ${s.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            archiveSession(s.id);
                          }}
                        >
                          <InboxOutlined />
                        </button>
                      </Tooltip>
                      <Popconfirm title="删除这个对话？" description="消息与统计一并删除，无法恢复。" okText="删除" cancelText="取消" onConfirm={() => deleteSession(s.id)}>
                        <button type="button" className="bui-shelf-act is-danger" aria-label={`删除对话 ${s.title}`} onClick={(e) => e.stopPropagation()}>
                          <DeleteOutlined />
                        </button>
                      </Popconfirm>
                    </>
                  }
                />
              )
            )
          ) : (
            <div className="bui-shelf-empty">
              {view === "archived" ? "还没有归档的对话。" : "还没有对话，点上面「新建对话」开始。"}
            </div>
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
          settings={effective}
          tools={meta?.tools || []}
          modelCaps={curModel}
          disabled={busy || !session || needKey}
          keys={usableKeys}
          keyId={keyId}
          onKey={(id) => {
            // 切密钥 = 换一套路由身份：可用模型会变，重新拉 meta 并校正当前模型
            setKeyId(id);
            loadMeta(id);
          }}
          onAgent={setAgent}
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
        {!metaError && meta && needKey ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice
              tone="warn"
              title="请先创建并选择密钥"
              actions={
                <Button size="small" type="primary" onClick={() => navigate("/token")}>
                  去创建密钥
                </Button>
              }
            >
              对话通过密钥路由：密钥绑定的分组决定可用模型、渠道与计费倍率（没有密钥时无法选择模型）。
            </Notice>
          </div>
        ) : null}
        {!metaError && meta && !needKey && !models.length ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice tone="warn" title="当前密钥没有可用模型">
              该密钥绑定的分组下没有可用渠道/模型，请让管理员检查「分组管理」与「渠道管理」。
            </Notice>
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

        {/* 输入区：官方 PromptBar 是「悬空的浮岛」——只有输入框本体有底色，
            外层透明，提示文字贴在输入框正下方，不占额外整条背景。 */}
        <div className="ui-chat2-composer">
          {away && msgs.length > 3 ? (
            <button type="button" className="ui-chat2-jump" onClick={scrollToEnd}>
              <ArrowDownOutlined /> 回到最新
            </button>
          ) : null}

          <div className="ui-chat2-composer-inner">
            <PromptBar
              textareaRef={taRef}
              value={input}
              onChange={setInput}
              onSend={() => send()}
              onStop={stop}
              busy={busy}
              disabled={unavailable || reading}
              models={models}
              vendorGroups={meta?.vendors || null}
              model={session?.model || ""}
              onModelChange={setModel}
              chips={[
                ...images.map((src, i) => ({ src, label: `图片 ${i + 1}`, kind: "image" })),
                ...docs.map((d) => ({ label: d.name, kind: "file" })),
              ]}
              onRemoveChip={(i) => {
                // chips 顺序是「先图片后文件」，按下标反推该删哪个
                if (i < images.length) setImages((prev) => prev.filter((_, j) => j !== i));
                else setDocs((prev) => prev.filter((_, j) => j !== i - images.length));
              }}
              onPickImage={() => fileRef.current?.click()}
              onPickFile={() => docRef.current?.click()}
              fileOk={!reading}
              visionOk={supportsVision && !reading}
              placeholder={busy ? "正在生成…" : "输入你的问题，或分享一个想法…"}
              commands={[
                { key: "new", name: "new", desc: "新建对话", run: newSession },
                { key: "archive", name: "archive", desc: "归档当前对话", run: () => archiveSession(session?.id) },
                { key: "clear", name: "clear", desc: "清空当前会话消息", run: () => { setMsgs([]); setInput(""); setImages([]); setDocs([]); } },
                { key: "file", name: "file", desc: "添加文档（PDF / Word / Excel / 文本）", run: () => docRef.current?.click() },
                { key: "setting", name: "setting", desc: "打开会话设定", run: () => setSheetOpen(true) },
                { key: "tools", name: "tools", desc: "切换工具开关（按智能体默认）", run: () => patchSettings("tools", agent?.tools || []) },
              ]}
            />
            <div className="ui-chat2-composer-foot">
              <span>AI 内容仅供参考 · 对话会保存在你的账户里</span>
            </div>
          </div>
          <input type="file" ref={fileRef} hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={pickImages} />
          {/* 文档附件：不限 accept，具体类型由服务端判定（文本/代码/PDF/Word/Excel），
              前端放宽选择范围，解析不了会给出明确提示 */}
          <input type="file" ref={docRef} hidden multiple onChange={pickDocs} />
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
