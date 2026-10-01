// 对话页（原「对话工作台」）
// ---------------------------------------------------------------------------
// 页面结构（opencode 风格的三段式）：
//   左侧 Shelf  —— 会话列表（新建/切换/重命名/删除）+ harness 设定入口
//   中间会话区  —— 消息按 parts 渲染（正文、思考链、工具 chip、待办清单）
//   底部输入框  —— 附件 / 密钥（多把时）/ 模型 / 发送；会话指令在右上角「设定」里
// 第 80 批：顶部「编排栏」（智能体 / 思考 / 联网 / 工具开关 / 最大步数）整条取消 ——
// 用户反馈「不需要给用户提供智能体、功能开关的选项」。助手拿全部工具、自己判断要不要用。
// 数据全部来自服务端：会话与设定落库（chat_sessions），消息落库（chat_messages），
// 刷新页面不丢；本页只负责渲染与把用户操作发回服务端。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Alert, Button, Checkbox, Drawer, Dropdown, Form, Input, Modal, Popconfirm, Tooltip } from "antd";
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
  CodeOutlined,
  EditFilled,
  SearchOutlined,
  WalletOutlined,
  EllipsisOutlined,
} from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { API, getToken } from "../services/api";

// 单次可带的图片上限：与后端 routes/chat.js 的 MAX_CHAT_IMAGES 一致（后端才是权威值）
const MAX_CHAT_IMAGES = 30;

// 上次选用的密钥 id：刷新后要接着用它，而不是回到服务端的默认选择
// （默认可能是一把没有可用模型的密钥，那样页面一进来就是禁用状态）。
// 注意这是**偏好**不是权限依据 —— 服务端仍会校验它是否属于当前用户且可用。
const LS_KEY_ID = "oo.chat.keyId";
import { chatApi, runChatStream, resumeChatStream } from "../services/chat";
import { useApp } from "../context/AppContext";
import Markdown from "../components/Markdown";
import { OdCoin } from "../components/OdCoin";
import { DurationCell, TokenCell, formatDuration } from "../components/UsageCells";
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
} from "../components/beautifului-chat";
import "../components/chat.css";

// 欢迎页的快捷问题：不再绑定「智能体」（已取消选择），助手自己判断要不要查资料/查账号
const SUGGESTS = [
  { icon: <WalletOutlined />, title: "我的账号怎么样", desc: "余额、最近调用与消耗", prompt: "帮我看看我的账号：余额还剩多少，最近 10 次调用分别用了什么模型、花了多少？" },
  { icon: <CompassOutlined />, title: "帮我查清一件事", desc: "联网检索 + 给出处", prompt: "请帮我查清楚这件事的来龙去脉，并给出信息来源：" },
  { icon: <CodeOutlined />, title: "写出更好的代码", desc: "实现 + 边界情况", prompt: "请帮我实现下面的功能，并说明关键取舍：" },
  { icon: <EditFilled />, title: "打磨一段文字", desc: "改写、压缩、润色", prompt: "请帮我润色下面的文字，保留原意：" },
];

const uid = () => Math.random().toString(36).slice(2, 10);
const ms = (p) => (p.ended && p.started ? Math.max(1, p.ended - p.started) : 0);
// 消息列表的渲染 key：seq 在流式期间是 0、done 之后才变成真实值，
// 用它当 key 会让消息在回答完成的一刻重挂载（入场动画重播、折叠态丢失）。
// 因此进入列表时固定一个本地 key，重发/回退整体替换时同样重新生成一遍。
const withKeys = (list = []) => list.map((m, i) => ({ ...m, key: m.key || `m${m.seq || 0}-${i}-${uid()}` }));
const knownNumber = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
const recoveryKey = (userId, sessionId) => `oo.chat.recovery.${userId}.${sessionId}`;
const readRecovery = (userId, sessionId) => {
  try { return JSON.parse(sessionStorage.getItem(recoveryKey(userId, sessionId)) || "null"); } catch { return null; }
};
const saveRecovery = (userId, sessionId, value) => {
  try {
    if (value) sessionStorage.setItem(recoveryKey(userId, sessionId), JSON.stringify(value));
    else sessionStorage.removeItem(recoveryKey(userId, sessionId));
  } catch { /* 隐私模式或附件超过浏览器存储限制时，内存中的草稿仍保留 */ }
};
const hydrateMessages = (messages, previous = []) => withKeys((messages || []).map((m) => ({
  ...m, key: previous.find((p) => p.seq > 0 && p.seq === m.seq && p.role === m.role)?.key,
})));
const mergeRecovery = (userId, sessionId, messages) => {
  const saved = readRecovery(userId, sessionId);
  if (!saved || !Array.isArray(saved.messages)) return messages;
  if (messages.some((m) => m.seq > saved.baselineSeq)) {
    saveRecovery(userId, sessionId, null);
    return messages;
  }
  return [...messages, ...saved.messages];
};

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
  const errors = parts.filter((p) => p.type === "error");
  // 待办来自 todowrite 工具的结果（落在 tool part 上，刷新后依然在），或流式期间的 todo 事件
  const todo = parts.filter((p) => Array.isArray(p.todo)).slice(-1)[0]?.todo || msg.todo;
  const hasText = textParts.some((p) => (p.text || "").trim());
  const working = Boolean(streaming) && !hasText;
  const reasoningWorking = Boolean(streaming) && !hasText && reasoning.length > 0;
  const firstTokenText = msg.firstTokenMs === 0 ? "0ms"
    : knownNumber(msg.firstTokenMs) ? formatDuration(msg.firstTokenMs) : "—";
  const elapsedText = msg.elapsedMs === 0 ? "0ms" : knownNumber(msg.elapsedMs) ? formatDuration(msg.elapsedMs) : "—";

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

      {errors.map((part, i) => <Alert
        key={part.id || `error-${i}`} type={msg.status === "stopped" ? "warning" : "error"} showIcon
        className="ui-msg-error" message={part.message || part.text || "本轮生成失败，请重试"}
        description={msg.local ? msg.cost === 0 ? "未发起上游调用，输入内容已保留。" : "发送状态尚未确认，请恢复连接核对后重试。" : undefined}
      />)}

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
      ) : !streaming && !errors.length && !reasoning.length && !tools.length ? <span className="ui-msg-empty">本轮没有返回文本内容。</span> : null}

      {!streaming ? (
        <div className="ui-msg-actions">
          <Tooltip title="复制回答">
            <Button type="text" size="small" aria-label="复制回答" icon={<CopyOutlined />} disabled={!hasText} onClick={() => onCopy(textParts.map((p) => p.text).join("\n\n"))} />
          </Tooltip>
          <Tooltip title={errors.length ? "重试可能产生新的用量" : "重新生成会再次计费"}>
            <Popconfirm
              title={errors.length ? "重试这一轮？" : "重新生成这条回答？"}
              description="这会移除它之后的消息，并再次产生用量。"
              onConfirm={() => onRetry(msg)}
              disabled={busy}
              okText="重新生成"
              cancelText="取消"
            >
              <Button type="text" size="small" aria-label={errors.length ? "重试本轮" : "重新生成"} disabled={busy} icon={<ReloadOutlined />} />
            </Popconfirm>
          </Tooltip>
          <div className="ui-msg-stats">
            <span className="ui-msg-cost" title="本轮成本（OD币）；— 表示尚未确认结算结果"><OdCoin size={13} />{knownNumber(msg.cost) ? fmtOd(Number(msg.cost) * unitsPerOd(), unitsPerOd(), 6, false) : "—"}</span>
            {[msg.tokens?.prompt, msg.tokens?.completion, msg.tokens?.cache].every(knownNumber)
              ? <TokenCell promptTokens={msg.tokens.prompt} completionTokens={msg.tokens.completion} cacheTokens={msg.tokens.cache} />
              : <span className="ui-msg-token-unknown" title="— 表示服务端尚未提供统计"><span>输入 {knownNumber(msg.tokens?.prompt) ? msg.tokens.prompt : "—"} · 输出 {knownNumber(msg.tokens?.completion) ? msg.tokens.completion : "—"}</span><span>缓存 {knownNumber(msg.tokens?.cache) ? msg.tokens.cache : "—"}</span></span>}
            {msg.elapsedMs === 0 || msg.firstTokenMs === 0
              ? <span className="oo-duration-cell"><span className="oo-duration-row"><span>首字</span><b>{firstTokenText}</b></span><span className="oo-duration-row"><span>总耗时</span><b>{elapsedText}</b></span></span>
              : <DurationCell firstTokenMs={msg.firstTokenMs} elapsedMs={msg.elapsedMs} />}
          </div>
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
      ...sessions.map((s) => ({ key: s.id, label: s.title, hint: `${s.message_count || 0} 条消息`, run: () => onPick(s.id), icon: null })),
    ];
    const key = q.trim().toLowerCase();
    return key ? list.filter((i) => i.label.toLowerCase().includes(key)) : list;
  }, [q, sessions, onNew, onPick]);

  return (
    <Modal open={open} title="命令面板" footer={null} onCancel={onClose} width={560} className="bui-command-modal" destroyOnClose>
      <div className="bui-palette-search">
        <Input
          ref={inputRef}
          value={q}
          aria-label="搜索会话或操作"
          prefix={<SearchOutlined />}
          allowClear
          placeholder="搜索会话，或执行操作…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && !e.nativeEvent.isComposing && items[0]) {
              onClose();
              items[0].run();
            }
          }}
        />
      </div>
        <div className="bui-palette-list">
          {items.length ? (
            items.map((it) => (
              <Button
                key={it.key}
                type="text"
                className="bui-palette-row"
                onClick={() => {
                  onClose();
                  it.run();
                }}
              >
                <span className="ic">{it.icon}</span>
                <span className="tx">{it.label}</span>
                <span className="nm">{it.hint}</span>
              </Button>
            ))
          ) : (
            <div className="bui-palette-empty">没有匹配的会话</div>
          )}
        </div>
    </Modal>
  );
}

function NameDialog({ dialog, saving, error, onClose, onSave }) {
  const [form] = Form.useForm();
  const inputRef = useRef(null);
  const project = dialog?.kind !== "session";
  const label = project ? "项目名称" : "对话名称";
  const maxLength = project ? 64 : 60;
  useEffect(() => {
    if (dialog) {
      form.resetFields();
      form.setFieldsValue({ name: dialog.name || "" });
    }
  }, [dialog, form]);
  return (
    <Modal
      open={Boolean(dialog)}
      title={dialog?.kind === "create-project" ? "新建项目" : project ? "重命名项目" : "重命名对话"}
      okText={dialog?.kind === "create-project" ? "创建" : "保存"}
      cancelText="取消"
      confirmLoading={saving}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      maskClosable={!saving}
      keyboard={!saving}
      onCancel={onClose}
      onOk={() => form.submit()}
      afterOpenChange={(open) => { if (open) inputRef.current?.focus({ cursor: "all" }); }}
      forceRender
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={onSave} disabled={saving}>
        <Form.Item name="name" label={label} rules={[
          { required: true, whitespace: true, message: `请输入${label}` },
          { max: maxLength, message: `${label}最多 ${maxLength} 个字符` },
        ]}>
          <Input ref={inputRef} maxLength={maxLength} showCount placeholder={project ? "例如：工作、学习" : "给这个对话起个名字"} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/* ============================ 会话指令 / 设定面板 ============================ */
function SettingsSheet({ open, onClose, session, settings, onSettings, saving, quotaText }) {
  const [form] = Form.useForm();
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ title: session?.title || "", instructions: settings?.instructions || "" });
      setError("");
    }
  }, [open, session?.id, session?.title, settings?.instructions, form]);

  const save = async ({ title, instructions = "" }) => {
    const patch = {};
    if (title.trim() && title.trim() !== session?.title) patch.title = title.trim();
    if (instructions !== (settings?.instructions || "")) patch.instructions = instructions;
    setError("");
    if (!await onSettings(patch)) setError("保存失败，请重试。输入内容已保留。");
  };

  return (
    <Drawer
      title="会话设定" open={open} width="min(440px, 100vw)" rootClassName="ui-chat2-settings"
      onClose={saving ? undefined : onClose} closable={!saving} maskClosable={!saving} keyboard={!saving}
      forceRender
      footer={<div className="ui-chat2-settings-actions"><Button onClick={onClose} disabled={saving}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></div>}
    >
      <div className="ui-chat2-sheet-body">
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false} disabled={saving}>
          <Form.Item name="title" label="会话名称" rules={[{ required: true, whitespace: true, message: "请输入会话名称" }, { max: 60, message: "会话名称最多 60 个字符" }]}>
            <Input maxLength={60} showCount placeholder="给这个会话起个名字" />
          </Form.Item>
          <Form.Item name="instructions" label="会话指令（系统提示词）" extra="只作用于当前会话" rules={[{ max: 4000, message: "会话指令最多 4000 个字符" }]}>
            <Input.TextArea maxLength={4000} showCount autoSize={{ minRows: 5, maxRows: 12 }} placeholder="例如：回答尽量简短；术语先给中文再给英文；代码用 TypeScript。" />
          </Form.Item>
        </Form>

          <div className="ui-chat2-agentcard">
            <span>
              <strong>助手能做什么</strong>
              联网检索、读取网页与 GitHub、查询你的账号（余额 / 调用记录 / 令牌 / 用量），需要时自动使用，不用手动开启。
            </span>
          </div>

          <div>
            <div className="ui-chat2-kv">
              <span>消息数</span>
              <strong>{session?.message_count ?? 0}</strong>
            </div>
            <div className="ui-chat2-kv">
              <span>本会话累计消耗</span>
              <strong style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <OdCoin size={13} />
                <span className="oo-num">{session?.cost ?? 0}</span>
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
    </Drawer>
  );
}

/* ============================ 页面 ============================ */
export default function ChatPage() {
  const { user, status, refreshUser } = useApp();
  const { message: toast, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedSession = params.get("s") || "";

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [metaLoading, setMetaLoading] = useState(true);
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
  const [nameDialog, setNameDialog] = useState(null);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const [shelfPending, setShelfPending] = useState("");
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [docs, setDocs] = useState([]); // 文档附件 [{name,size,type,dataUrl}]
  // 选中密钥：站内对话扣账户额度，但路由配置（分组 → 可用模型/渠道/倍率）挂在密钥上。
  // 0 = 用账户默认分组，与老行为一致。
  const [keyId, setKeyId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [away, setAway] = useState(false);
  const [reading, setReading] = useState(false);
  const [connectionError, setConnectionError] = useState("");

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
  const activeIdRef = useRef("");
  activeIdRef.current = session?.id || "";
  const sendRef = useRef(null);
  const attachRunningRef = useRef(null);
  const attachedRef = useRef(""); // 已经接上事件流的会话 id（防重复订阅导致内容重放叠加）
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const nameBusyRef = useRef(false);
  const shelfPendingRef = useRef("");
  const metaReadyRef = useRef(false);
  metaReadyRef.current = Boolean(meta) && !metaLoading && !metaError;
  const sessionListGenRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const streamGenRef = useRef(0);
  const updateBusy = useCallback((value) => { busyRef.current = value; setBusy(value); }, []);
  const draftRef = useRef({ input, images, docs });
  draftRef.current = { input, images, docs };
  const draftVersionRef = useRef(0);
  const draftSessionRef = useRef("");
  const draftSwitchRef = useRef(false);
  useEffect(() => {
    const id = session?.id;
    if (!id || !user?.id || draftSessionRef.current === id) return;
    if (draftSessionRef.current) saveRecovery(user.id, `draft.${draftSessionRef.current}`, draftRef.current);
    const next = readRecovery(user?.id, `draft.${id}`) || {};
    draftSessionRef.current = id; draftSwitchRef.current = true;
    setInput(next.input || ""); setImages(next.images || []); setDocs(next.docs || []);
  }, [session?.id, user?.id]);
  useEffect(() => {
    if (draftSwitchRef.current) { draftSwitchRef.current = false; return; }
    if (session?.id && user?.id && draftSessionRef.current === session.id) saveRecovery(user.id, `draft.${session.id}`, { input, images, docs });
  }, [input, images, docs, session?.id, user?.id]);

  const models = meta?.models || [];
  const curModel = models.find((m) => m.id === session?.model);
  const settings = session?.settings || {};
  const quota = user?.quota != null ? fmtOd(user.quota, unitsPerOd(status), 2) : "—";
  // 对话必须通过密钥路由：没有可用密钥就没有可用模型，输入区与编排栏一并禁用。
  //
  // 判据用后端给的 `usable`（= 已启用 + 未过期 + **已绑定分组**），不能只看 status：
  // 未绑分组的密钥会被网关 403 拒绝、也会被 activeKeyOf 跳过，若这里放行，
  // 用户会选中它、拿到模型列表，然后每次发送都失败。
  // 后端若没给 usable（旧版本），退回 status===1 —— 不能因为字段缺失把所有人都挡住。
  const usableKeys = (meta?.keys || []).filter((k) => (k.usable === undefined ? k.status === 1 : k.usable));
  const needKey = Boolean(meta) && !usableKeys.length;
  const unavailable = !session || !curModel || needKey || loadingSession || metaLoading || Boolean(metaError) || Boolean(connectionError);

  /* ---------- 加载：元信息 + 会话列表 ---------- */
  const metaGenRef = useRef(0);
  const loadMeta = useCallback(async (forKeyId = 0) => {
    // 快速切换密钥会连发多次 meta：旧响应后到会把新密钥的模型/能力覆盖掉
    const gen = ++metaGenRef.current;
    // 同步封住发送/选模型，避免新密钥已选中而 React 还没有渲染禁用态时沿用旧元信息。
    metaReadyRef.current = false;
    setMetaLoading(true);
    setMetaError("");
    try {
      const data = await chatApi.meta(forKeyId);
      if (gen !== metaGenRef.current) return;
      setMeta(data);
      const keys = data.keys || [];
      const chosenKeyId = data.active_key_id || data.active_key?.id || forKeyId || keys.find((k) => k.status === 1)?.id || 0;
      setKeyId(chosenKeyId);

      // 切密钥后模型集合会变：当前模型不在新集合里就自动换到第一个可用模型，并持久化更新
      setSession((prev) => {
        if (!prev) return prev;
        const availableList = data.models || [];
        const ok = availableList.some((m) => m.id === prev.model);
        if (ok) return prev;
        const fallbackModel = availableList[0]?.id || "";
        if (prev.id && fallbackModel) {
          chatApi.patchSession(prev.id, { model: fallbackModel }).catch(() => {});
        }
        return { ...prev, model: fallbackModel };
      });
    } catch (e) {
      if (gen !== metaGenRef.current) return;
      setMetaError(e.message || "无法加载模型配置");
    } finally {
      if (gen === metaGenRef.current) setMetaLoading(false);
    }
  }, []);

  const loadSessions = useCallback(
    async (nextView = viewRef.current) => {
      if (nextView !== viewRef.current) return null;
      const gen = ++sessionListGenRef.current;
      try {
        // 归档视图与项目视图各自拉取；计数与项目列表每次都刷新（移动/归档后侧栏要立刻更新）
        const archived = nextView === "archived" ? "true" : "false";
        const projectId = nextView !== "active" && nextView !== "archived" ? nextView : "";
        const [data, proj] = await Promise.all([
          chatApi.listSessions({ archived, projectId }),
          chatApi.listProjects().catch(() => ({ projects: [] })),
        ]);
        // 旧视图的响应不得覆盖当前列表；null 区分「已作废」与「确实没有会话」。
        if (gen !== sessionListGenRef.current || nextView !== viewRef.current) return null;
        setSessions(data.sessions || []);
        setCounts(data.counts || { active: 0, archived: 0, byProject: {} });
        setProjects(proj.projects || []);
        return data.sessions || [];
      } catch (e) {
        if (gen === sessionListGenRef.current && nextView === viewRef.current) {
          toast.error(e.message || "加载会话列表失败");
        }
        return null;
      }
    },
    [toast]
  );

  /* 元信息只在挂载时加载一次；会话列表随视图变化；卸载时才中止流。
     三者分开写：如果都挂在 [loadMeta, loadSessions] 的 effect 上，
     切换「已归档/项目」视图会触发 cleanup，把正在接收的流误杀。 */
  useEffect(() => {
    // 带上次用的密钥一起加载。
    //
    // 修的问题（黑盒测试实测）：用户在对话页切到某把可用密钥后**一刷新就被踢回**
    // 服务端的默认选择（第一把可用密钥）。若那把密钥没有可用模型，
    // 页面直接变成「当前密钥没有可用模型」+ 输入框禁用 —— 用户明明有能用的密钥，
    // 却要先手动再切一次才能说话。刷新是最高频的操作之一，这个回退很恼人。
    loadMeta(Number(localStorage.getItem(LS_KEY_ID)) || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      genRef.current += 1;
      sessionListGenRef.current += 1;
      metaGenRef.current += 1;
      metaReadyRef.current = false;
      runningRef.current?.abort();
    },
    []
  );

  /* ---------- 打开会话 ---------- */
  const openSession = useCallback(
    async (id) => {
      if (!id) return;
      genRef.current += 1;
      const gen = genRef.current;
      runningRef.current?.abort();
      runningRef.current = null;
      attachedRef.current = ""; // 换会话：上一个会话的订阅标记作废
      updateBusy(true);
      setConnectionError("");
      setLoadingSession(true);
      try {
        const data = await chatApi.getSession(id);
        if (genRef.current !== gen) return;
        setSession(data.session);
        setMsgs(withKeys(mergeRecovery(user?.id, id, data.messages || [])));
        setParams({ s: id }, { replace: true });
        // 换会话必须重置滚动状态：否则上一个会话滚到中间时留下的「回到最新」会跟着新会话显示
        stickyRef.current = true;
        awayRef.current = false;
        setAway(false);
        // 这个会话可能正在生成（用户切页/刷新前提交的）：接回事件流，界面无缝恢复。
        // 走 ref：attachRunning 定义在本函数之后，直接进依赖数组会在渲染期触发 TDZ。
        attachRunningRef.current?.(id, gen);
      } catch (e) {
        if (genRef.current === gen) { updateBusy(false); setConnectionError(e.message || "打开会话失败"); }
      } finally {
        if (genRef.current === gen) setLoadingSession(false);
      }
    },
    [setParams, toast, user?.id, updateBusy]
  );

  /* 发送和续传共享一套状态机：只有服务端终态才完成；网络断开只恢复订阅，绝不重发 POST。 */
  const observeRun = useCallback((sessionId, gen, aiKey, options = {}) => {
    const connection = ++streamGenRef.current;
    const valid = () => genRef.current === gen && streamGenRef.current === connection;
    let finished = false, reconnects = 0, recovering = false, accepted = false;
    let startedAt = Date.now();
    const beforeMessages = options.beforeMessages || msgsRef.current;
    const baselineSeq = options.baselineSeq ?? Math.max(0, ...beforeMessages.filter((m) => !m.local).map((m) => Number(m.seq) || 0));
    const patchAi = (fn) => {
      if (!valid()) return;
      setMsgs((prev) => {
        const index = prev.findIndex((m) => m.key === aiKey);
        if (index < 0) return prev;
        const next = prev.slice(); next[index] = fn(prev[index]); return next;
      });
    };
    const storeFailure = (error, data = {}) => {
      if (!valid()) return;
      const message = error?.message || "本轮生成失败，请重试";
      patchAi((m) => {
        const local = data.local ?? !data.seq;
        const next = { ...m, ...data, key: aiKey, local, streaming: false, status: data.status || "error", elapsedMs: data.elapsedMs ?? Date.now() - startedAt,
          parts: data.parts || [...m.parts.filter((p) => p.id !== "connection-error"), { id: "connection-error", type: "error", code: error?.code, message }],
        };
        if (next.local) saveRecovery(user?.id, sessionId, { baselineSeq, messages: [...(options.userMessage ? [options.userMessage] : []), next] });
        return next;
      });
    };
    const finish = () => {
      if (finished || !valid()) return;
      finished = true; attachedRef.current = "";
      patchAi((m) => ({ ...m, streaming: false }));
      runningRef.current = null; updateBusy(false);
      refreshUser?.(); loadSessions();
    };
    const reconcile = async () => {
      const data = await chatApi.getSession(sessionId);
      if (!valid()) return false;
      const complete = (data.messages || []).some((m) => m.role === "assistant" && (options.request?.retryFromSeq
        ? m.id && !beforeMessages.some((old) => old.id === m.id)
        : m.seq > baselineSeq));
      if (!complete) return false;
      if (!accepted) { accepted = true; options.onAccepted?.(); }
      saveRecovery(user?.id, sessionId, null);
      setSession(data.session);
      setMsgs((prev) => hydrateMessages(data.messages, prev));
      return true;
    };
    const recover = async (error) => {
      if (finished || recovering || !valid()) return;
      recovering = true;
      const detail = error?.data?.data || error?.data || {};
      if (detail.accepted === true && !accepted) { accepted = true; options.onAccepted?.(); }
      if (detail.accepted === false && error?.status !== 409) {
        storeFailure(error, { cost: 0, tokens: { prompt: 0, completion: 0, cache: 0 }, firstTokenMs: 0 });
        finish();
        return;
      }
      patchAi((m) => ({ ...m, parts: [...m.parts.filter((p) => p.id !== "connection-error"), { id: "connection-error", type: "error", message: "连接中断，正在恢复已有生成…" }] }));
      while (reconnects < 3 && valid()) {
        reconnects++;
        try {
          const state = await chatApi.running(sessionId);
          if (!valid()) return;
          if (state?.running) {
            await new Promise((resolve) => setTimeout(resolve, reconnects * 500));
            if (!valid()) return;
            recovering = false;
            connect(true);
            return;
          }
          if (detail.accepted === false || !await reconcile()) {
            if (detail.message?.parts) {
              storeFailure(error, detail.message);
              if (detail.userMessage && options.userMessage) setMsgs((prev) => prev.map((m) => m.key === options.userMessage.key ? { ...m, ...detail.userMessage } : m));
              if (detail.session) setSession(detail.session);
            } else storeFailure(error, detail.accepted === false ? { cost: 0, tokens: { prompt: 0, completion: 0, cache: 0 }, firstTokenMs: 0 } : {});
          }
          finish();
          return;
        } catch {
          if (reconnects < 3) await new Promise((resolve) => setTimeout(resolve, reconnects * 500));
        }
      }
      storeFailure(Object.assign(new Error(`${error?.message || "连接已断开"}。请刷新确认本轮状态后重试，已收到的内容保留。`), { code: error?.code }));
      if (valid()) setConnectionError("暂时无法确认本轮生成状态。请恢复连接后继续，避免重复提交。");
      finish();
    };
    const onEvent = (ev) => {
      if (!valid() || finished) return;
      if (ev.type === "start" || ev.type === "resumed") {
        startedAt = ev.startedAt || startedAt;
        // 回放从初始 part 开始，先清空该占位消息，避免旧 delta 与回放重复。
        if (ev.type === "resumed") patchAi((m) => ({ ...m, parts: [], streaming: true }));
        if (ev.userMessage && options.request?.retryFromSeq) setMsgs((prev) => [...prev.filter((m) => !m.local && m.seq > 0 && m.seq < options.request.retryFromSeq), { ...ev.userMessage, key: `u-${uid()}` }, ...prev.filter((m) => m.key === aiKey)]);
        else if (ev.userMessage && options.userMessage) setMsgs((prev) => prev.map((m) => m.key === options.userMessage.key ? { ...m, ...ev.userMessage, local: false, parts: (ev.userMessage.parts || m.parts).map((p, i) => p.type === "image" && !p.url ? { ...p, url: m.parts[i]?.url } : p) } : m));
        setConnectionError("");
        if (!accepted) { accepted = true; options.onAccepted?.(); }
      } else if (ev.type === "part") patchAi((m) => ({ ...m, parts: m.parts.some((p) => p.id === ev.part.id) ? m.parts.map((p) => p.id === ev.part.id ? ev.part : p) : [...m.parts, ev.part] }));
      else if (ev.type === "snapshot") patchAi((m) => ({ ...m, parts: (ev.parts || []).map((p) => ({ ...p })) }));
      else if (ev.type === "part_update") patchAi((m) => ({ ...m, parts: m.parts.map((p) => p.id === ev.id ? { ...p, ...ev.patch } : p) }));
      else if (ev.type === "delta") patchAi((m) => ({ ...m, parts: m.parts.map((p) => p.id === ev.id ? { ...p, [ev.field]: (p[ev.field] || "") + ev.delta } : p) }));
      else if (ev.type === "todo") patchAi((m) => ({ ...m, todo: ev.todo }));
      else if (["done", "error", "stopped"].includes(ev.type)) {
        if (ev.message && typeof ev.message === "object") {
          patchAi((m) => ({ ...m, ...ev.message, key: aiKey, streaming: false, todo: ev.todo }));
          saveRecovery(user?.id, sessionId, null);
        } else if (ev.type !== "done") storeFailure(new Error(ev.message || "本轮生成失败"), { local: false, status: ev.type === "stopped" ? "stopped" : "error", parts: ev.parts });
        if (ev.session) {
          setSession(ev.session);
          setSessions((prev) => prev.map((s) => s.id === ev.session.id ? { ...s, ...ev.session } : s));
        }
        finish();
      }
    };
    const connect = (resume) => {
      if (!valid() || finished) return;
      attachedRef.current = sessionId; updateBusy(true);
      const handlers = { token: getToken(), onEvent, onError: recover, onDone: () => { if (!finished) recover(new Error("生成连接已结束，正在确认结果")); } };
      runningRef.current = resume ? resumeChatStream(sessionId, handlers) : runChatStream(options.request, handlers);
    };
    connect(!options.request);
  }, [loadSessions, refreshUser, updateBusy, user?.id]);

  /* ---------- 断线续传：接回服务端正在跑的生成 ---------- */
  const attachRunning = useCallback(async (sessionId, gen) => {
    if (!sessionId || attachedRef.current === sessionId) return;
    updateBusy(true);
    try {
      const state = await chatApi.running(sessionId);
      if (genRef.current !== gen) return;
      if (!state?.running) {
        // getSession 与 running 之间可能刚好完成：再取终态避免刷新停在只有 user 的旧快照。
        const data = await chatApi.getSession(sessionId);
        if (genRef.current !== gen) return;
        setSession(data.session); setMsgs((prev) => hydrateMessages(mergeRecovery(user?.id, sessionId, data.messages || []), prev));
        setConnectionError(""); updateBusy(false); return;
      }
      if (attachedRef.current === sessionId) return;
      const aiKey = `a-${uid()}`;
      setMsgs((prev) => [...prev.filter((m) => !m.streaming), { key: aiKey, seq: 0, role: "assistant", parts: [], streaming: true }]);
      stickyRef.current = true;
      observeRun(sessionId, gen, aiKey);
    } catch (error) {
      if (genRef.current !== gen) return;
      updateBusy(false);
      // 无法确认运行状态时保留历史，并明确提示，不能静默当作没有在运行。
      setConnectionError(error.message || "无法确认生成状态，请刷新重试");
    }
  }, [observeRun, updateBusy, user?.id]);
  attachRunningRef.current = attachRunning;

  /* ---------- 侧栏：项目 / 归档 / 批量 ---------- */
  const switchView = useCallback(
    (next) => {
      // 首屏由 boot 加载，切视图只在这里加载一次，避免再被依赖 view 的 effect 重复触发。
      viewRef.current = next;
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
        if (!list) return;
        if (sessionRef.current?.id === id) {
          if (list[0]) openSession(list[0].id);
          else {
            // 与 deleteSession 对齐：清空消息与地址栏参数，否则页面还在渲染已归档会话
            setSession(null);
            setMsgs([]);
            setParams({}, { replace: true });
          }
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
        if (!list) return;
        if (!stillThere && list[0]) openSession(list[0].id);
        else if (!stillThere) {
          setSession(null);
          setMsgs([]);
          setParams({}, { replace: true });
        }
      } catch (e) {
        toast.error(e.message || "批量操作失败");
      }
    },
    [selected, loadSessions, openSession, setParams, toast]
  );

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openNameDialog = useCallback((kind, item) => {
    if (nameBusyRef.current) return;
    setNameError("");
    setNameDialog({ kind, id: item?.id, name: item?.name || item?.title || "" });
  }, []);

  const createProject = useCallback(() => openNameDialog("create-project"), [openNameDialog]);

  const saveName = useCallback(async ({ name: rawName }) => {
    if (!nameDialog || nameBusyRef.current) return;
    const name = String(rawName || "").trim();
    const maxLength = nameDialog.kind === "session" ? 60 : 64;
    if (!name || name.length > maxLength) return;
    nameBusyRef.current = true;
    setSavingName(true);
    setNameError("");
    try {
      if (nameDialog.kind === "create-project") {
        const project = await chatApi.createProject({ name });
        setProjects((prev) => [project, ...prev]);
      } else if (nameDialog.kind === "project") {
        const project = await chatApi.updateProject(nameDialog.id, { name });
        setProjects((prev) => prev.map((p) => p.id === nameDialog.id ? { ...p, name: project.name || name } : p));
      } else {
        const next = await chatApi.patchSession(nameDialog.id, { title: name });
        const title = next.title || name;
        setSessions((prev) => prev.map((s) => s.id === nameDialog.id ? { ...s, title } : s));
        setSession((prev) => prev?.id === nameDialog.id ? { ...prev, title } : prev);
      }
      setNameDialog(null);
      toast.success(nameDialog.kind === "create-project" ? "项目已创建" : "名称已保存");
    } catch (e) {
      // 成功前不改列表名称：失败时既不需要猜回滚值，也能保留弹窗里的输入。
      setNameError(e.message || "保存失败，请重试");
    } finally {
      nameBusyRef.current = false;
      setSavingName(false);
    }
  }, [nameDialog, toast]);

  const deleteProject = useCallback(
    async (id) => {
      try {
        await chatApi.deleteProject(id);
        setProjects((prev) => prev.filter((p) => p.id !== id));
        toast.success("项目已删除（其中的对话已退回未归类）");
        if (view === id) switchView("active");
        else loadSessions();
        return true;
      } catch (e) {
        toast.error(e.message || "删除项目失败");
        return false;
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
      if (!list) return;
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
    const el = threadRef.current;
    if (!stickyRef.current || !el) return;
    // 只在**真的需要**时才滚到底。
    //
    // 原先无条件 `scrollTop = scrollHeight`，在手机（视口 390×844、
    // 消息容器只有 ~414px 高）上空会话或短会话会被顶到最下面，
    // 把欢迎语那行大字顶出上边缘 —— 只露出下半截。
    // 人格实测原话：「手机上看对话页，『今天，想弄清楚什么？』这行字被切掉了一半。
    // 我把 scrollTop 归 0，它跑到 377px 就完整了。桌面上容器装得下，所以看不到。」
    //
    // 判据：内容超出容器（有可滚动的余量）才跟随到底；装得下就保持原位，
    // 让欢迎语完整可见。这与 onThreadScroll 里「内容不足一屏不显示跳转按钮」
    // 是同一个思路。
    if (el.scrollHeight <= el.clientHeight + 4) {
      el.scrollTop = 0;
      return;
    }
    el.scrollTop = el.scrollHeight;
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
    const gen = ++genRef.current;
    runningRef.current?.abort(); runningRef.current = null; attachedRef.current = "";
    updateBusy(true);
    try {
      const created = await chatApi.createSession({
        agent: sessionRef.current?.agent || meta?.defaults?.agent || "general",
        model: sessionRef.current?.model || models.find((m) => !m.deprecated)?.id || "",
        settings: sessionRef.current?.settings || {},
      });
      if (genRef.current !== gen) return;
      setSessions((prev) => [created, ...prev]);
      setSession(created);
      setMsgs([]);
      stickyRef.current = true;
      awayRef.current = false;
      setAway(false);
      setParams({ s: created.id }, { replace: true });
      setShelfOpen(false);
      taRef.current?.focus();
    } catch (e) {
      if (genRef.current === gen) toast.error(e.message || "创建会话失败");
    } finally {
      if (genRef.current === gen) updateBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, models, setParams, toast, updateBusy]);

  const patchSession = useCallback(
    async (patch, { silent } = {}) => {
      const id = sessionRef.current?.id;
      if (!id) return null;
      try {
        const next = await chatApi.patchSession(id, patch);
        setSession((prev) => (prev?.id === next.id ? next : prev));
        setSessions((prev) => prev.map((s) => (s.id === next.id ? { ...s, ...next } : s)));
        if (!silent) toast.success("已保存");
        return next;
      } catch (e) {
        toast.error(e.message || "保存失败");
        return null;
      }
    },
    [toast]
  );

  const deleteSession = useCallback(
    async (id) => {
      try {
        await chatApi.deleteSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        const list = await loadSessions();
        if (sessionRef.current?.id === id) {
          if (list?.[0]) openSession(list[0].id);
          else {
            setSession(null);
            setMsgs([]);
            setParams({}, { replace: true });
            bootRef.current = false;
          }
        }
        return true;
      } catch (e) {
        toast.error(e.message || "删除失败");
        return false;
      }
    },
    [loadSessions, openSession, setParams, toast]
  );

  const sessionAction = useCallback(async (item, action, projectId) => {
    if (shelfPendingRef.current) return;
    shelfPendingRef.current = item.id;
    setShelfPending(item.id);
    try {
      await chatApi.batch([item.id], action, projectId);
      const patch = action === "pin" || action === "unpin" ? { pinned: action === "pin" }
        : action === "archive" || action === "unarchive" ? { archived: action === "archive" }
        : { project_id: projectId || "" };
      setSession((prev) => prev?.id === item.id ? { ...prev, ...patch } : prev);
      const list = await loadSessions();
      if (list && sessionRef.current?.id === item.id && !list.some((s) => s.id === item.id)) {
        if (list[0]) openSession(list[0].id);
        else {
          setSession(null);
          setMsgs([]);
          setParams({}, { replace: true });
        }
      }
      toast.success({ pin: "已置顶", unpin: "已取消置顶", archive: "已归档", unarchive: "已取消归档", move: "已移动" }[action]);
    } catch (e) {
      toast.error(e.message || "操作失败");
    } finally {
      shelfPendingRef.current = "";
      setShelfPending("");
    }
  }, [loadSessions, openSession, setParams, toast]);

  /* ---------- 运行一轮 ---------- */
  const send = useCallback((overrideText, retryPayload) => {
    const current = sessionRef.current;
    if (!metaReadyRef.current || busyRef.current || loadingSession || readingRef.current || connectionError || !current || !curModel) return;
    const draft = draftRef.current;
    const draftVersion = draftVersionRef.current;
    const text = String(retryPayload?.text ?? overrideText ?? draft.input).trim();
    const sendImages = retryPayload?.images || draft.images.map((img) => img.mediaId ? { mediaId: img.mediaId } : { dataUrl: img.dataUrl });
    const sendFiles = retryPayload?.files || draft.docs.filter((d) => d.dataUrl).map((d) => ({ name: d.name, type: d.type, dataUrl: d.dataUrl }));
    const sendDocs = retryPayload?.docs || draft.docs.filter((d) => !d.dataUrl).map((d) => ({ name: d.name, kind: d.kind, bytes: d.bytes, text: d.text }));
    if (!text && !sendImages.length && !sendFiles.length && !sendDocs.length) return;
    const request = { sessionId: current.id, text, images: sendImages, files: sendFiles, docs: sendDocs, keyId, model: current.model, agent: current.agent, settings: current.settings,
      ...(retryPayload?.retryFromSeq ? { retryFromSeq: retryPayload.retryFromSeq } : {}),
    };
    const userMessage = { key: `u-${uid()}`, seq: 0, role: "user", local: true, parts: [
      { id: uid(), type: "text", text },
      ...(!retryPayload ? draft.images.map((img) => ({ id: uid(), type: "image", url: img.url || img.dataUrl, media_id: img.mediaId })) : (retryPayload.userParts || []).filter((p) => p.type === "image")),
      ...(!retryPayload ? draft.docs.map((d) => ({ id: uid(), type: "file", name: d.name, bytes: d.size ?? d.bytes, ...d })) : (retryPayload.userParts || []).filter((p) => p.type === "file")),
    ] };
    const aiKey = `a-${uid()}`;
    const aiMessage = { key: aiKey, seq: 0, role: "assistant", parts: [], streaming: true, model: current.model, request };
    const beforeMessages = msgsRef.current;
    // 重试先保留原历史，等 start 确认服务端事务提交后才替换旧轮。
    setMsgs((prev) => [...prev.filter((m) => !m.local), ...(!request.retryFromSeq ? [userMessage] : []), aiMessage]);
    stickyRef.current = true; awayRef.current = false; setAway(false); updateBusy(true);
    observeRun(current.id, genRef.current, aiKey, { request, userMessage: request.retryFromSeq ? null : userMessage, beforeMessages,
      onAccepted: () => {
        if (!retryPayload) {
          // 用户在等待首包期间输入的新草稿不能被这一轮的迟到 start 清空。
          if (draftVersionRef.current === draftVersion) setInput("");
          if (draftRef.current.images === draft.images) setImages([]);
          if (draftRef.current.docs === draft.docs) setDocs([]);
        }
      },
    });
  }, [keyId, curModel, loadingSession, connectionError, observeRun, updateBusy]);
  sendRef.current = send;

  const stop = useCallback(async () => {
    const id = sessionRef.current?.id, gen = genRef.current, connection = streamGenRef.current;
    const valid = () => genRef.current === gen && streamGenRef.current === connection;
    if (!id) return;
    try {
      await chatApi.stop(id);
      if (!valid()) return;
      // 保留订阅直到服务端发出停止终态；断开浏览器连接本身不会停止上游。
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await chatApi.running(id);
        if (!valid()) return;
        if (!state?.running) {
          const data = await chatApi.getSession(id);
          if (!valid()) return;
          setSession(data.session); setMsgs((prev) => hydrateMessages(data.messages, prev));
          runningRef.current?.abort(); runningRef.current = null; attachedRef.current = "";
          updateBusy(false); refreshUser?.(); loadSessions(); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (valid()) setConnectionError("停止请求已提交，尚未确认生成结束。请恢复连接查看状态。");
    } catch (error) {
      if (valid()) setConnectionError(error.message || "停止失败，生成可能仍在继续，请重试");
    }
  }, [refreshUser, loadSessions, updateBusy]);
  const retry = useCallback((msg) => {
    if (busyRef.current || !metaReadyRef.current || loadingSession) return;
    const list = msgsRef.current;
    const index = list.findIndex((m) => m.key === msg.key);
    const userMessage = list.slice(0, index).reverse().find((m) => m.role === "user");
    if (!userMessage && !msg.request) return;
    const parts = userMessage?.parts || [];
    const payload = msg.request || {
      text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
      images: parts.filter((p) => p.type === "image").map((p) => ({ mediaId: p.media_id || p.mediaId || 0, ...(p.url?.startsWith("data:") ? { dataUrl: p.url } : {}) })),
      docs: parts.filter((p) => p.type === "file" && p.text).map((p) => ({ name: p.name, kind: p.kind, bytes: p.bytes, text: p.text })),
    };
    sendRef.current?.(undefined, { ...payload, userParts: parts, retryFromSeq: msg.request?.retryFromSeq || userMessage?.seq || undefined });
  }, [loadingSession]);
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

  /**
   * 收下一组图片文件（来自文件选择器或剪贴板粘贴）：校验 → 读成 dataUrl →
   * 传媒体库拿 media_id → 进预览队列。
   *
   * 抽出来是因为「点 + 选图」和「Ctrl+V 贴图」必须走**同一套**校验与上传，
   * 否则粘贴那条路会绕过模型视觉能力检查、张数上限、类型白名单
   *（原先粘贴根本没接，所以不存在绕过；接上时若不共用就会引入）。
   */
  const acceptImageFiles = async (files) => {
    if (!files.length) return;
    if (readingRef.current || busy) return;
    if (curModel && curModel.vision !== true) {
      toast.warning("当前模型不支持图片，请先切换模型");
      return;
    }
    if (files.length + images.length > MAX_CHAT_IMAGES) {
      toast.warning(`最多上传 ${MAX_CHAT_IMAGES} 张图片`);
      return;
    }
    if (files.some((f) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type))) {
      toast.warning("请选择 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    readingRef.current = true;
    const gen = genRef.current;
    setReading(true);
    try {
      const loaded = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("图片读取失败"));
            reader.readAsDataURL(file);
          });
          try {
            const saved = await API.post("/media", { dataUrl, name: file.name || "pasted.png", source: "chat" });
            return { mediaId: saved?.id || 0, url: saved?.url || "", dataUrl };
          } catch (err) {
            console.warn(`[chat] 图片上传媒体库失败，回退为直传：${err?.message || err}`);
            return { mediaId: 0, url: "", dataUrl };
          }
        })
      );
      if (genRef.current === gen) setImages((prev) => [...prev, ...loaded]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  };

  const pickImages = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await acceptImageFiles(files);
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
    const gen = genRef.current;
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
      if (genRef.current === gen) setDocs((prev) => [...prev, ...loaded]);
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

  const onKeyPick = useCallback(
    (id) => {
      if (busyRef.current) return;
      // 切密钥 = 换一套路由身份：可用模型会变，重新拉 meta 并校正当前模型。
      // 同时记住它是哪一把：刷新后不该被服务端的默认选择顶掉（见挂载处的注释）。
      setKeyId(id);
      try {
        localStorage.setItem(LS_KEY_ID, String(id || ""));
      } catch {
        /* 隐私模式下 localStorage 可能不可写：记不住不影响功能 */
      }
      loadMeta(id);
    },
    [loadMeta]
  );

  const setModel = useCallback(
    (id) => {
      if (!metaReadyRef.current || busyRef.current) return;
      const m = models.find((x) => x.id === id);
      if (!m) return;
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
            <Tooltip title="新建项目"><Button type="text" className="bui-shelf-act" aria-label="新建项目" icon={<PlusOutlined />} onClick={createProject} /></Tooltip>
          }
        >
          {projects.length ? (
            projects.map((p) => (
              <ShelfItem
                key={p.id}
                active={view === p.id}
                label={p.name}
                hint={`${counts.byProject?.[p.id] || 0} 个对话`}
                onClick={() => {
                  switchView(p.id);
                  setShelfOpen(false);
                }}
                actions={
                  <Dropdown autoFocus trigger={["click"]} menu={{ items: [
                    { key: "rename", label: "重命名项目", icon: <EditOutlined />, onClick: () => openNameDialog("project", p) },
                    { key: "delete", label: "删除项目", icon: <DeleteOutlined />, danger: true, onClick: async () => { await modal.confirm({
                      title: "删除这个项目？", content: "项目里的对话会退回未归类，保留全部消息。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
                      onOk: async () => { if (!await deleteProject(p.id)) throw new Error("删除项目失败，请重试"); },
                    }); } },
                  ] }}>
                    <Button type="text" className="bui-shelf-act" icon={<EllipsisOutlined />} aria-label={`项目更多操作：${p.name}`} />
                  </Dropdown>
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
                    autoFocus
                    trigger={["click"]}
                    menu={{
                      items: projects.map((p) => ({ key: p.id, label: <span className="ui-chat2-menu-name">{p.name}</span>, onClick: () => batchAction("move", p.id) })),
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
                <div key={s.id} className="bui-shelf-pick">
                  <Checkbox checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)}>
                    <span className="tx">{s.title}</span>
                    {s.pinned ? <span className="hn">置顶</span> : null}
                  </Checkbox>
                </div>
              ) : (
                <ShelfItem
                  key={s.id}
                  active={s.id === session?.id}
                  label={s.title}
                  icon={s.pinned ? <PushpinOutlined /> : null}
                  onClick={() => {
                    openSession(s.id);
                    setShelfOpen(false);
                  }}
                  actions={
                    <Dropdown autoFocus trigger={["click"]} disabled={Boolean(shelfPending)} menu={{ triggerSubMenuAction: "click", items: [
                      { key: "rename", label: "重命名对话", icon: <EditOutlined />, onClick: () => openNameDialog("session", s) },
                      { key: "pin", label: s.pinned ? "取消置顶" : "置顶", icon: <PushpinOutlined />, onClick: () => sessionAction(s, s.pinned ? "unpin" : "pin") },
                      { key: "archive", label: view === "archived" || s.archived ? "取消归档" : "归档", icon: <InboxOutlined />, onClick: () => sessionAction(s, view === "archived" || s.archived ? "unarchive" : "archive") },
                      { key: "move", label: "移动到项目", children: [
                        { key: "move-none", label: "未归类", onClick: () => sessionAction(s, "move", "") },
                        ...projects.map((p) => ({ key: `move-${p.id}`, label: <span className="ui-chat2-menu-name">{p.name}</span>, onClick: () => sessionAction(s, "move", p.id) })),
                      ] },
                      { type: "divider" },
                      { key: "delete", label: "删除对话", icon: <DeleteOutlined />, danger: true, onClick: async () => { await modal.confirm({
                        title: "删除这个对话？", content: "消息与统计一并删除，无法恢复。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
                        onOk: async () => { if (!await deleteSession(s.id)) throw new Error("删除失败，请重试"); },
                      }); } },
                    ] }}>
                      <Button type="text" className="bui-shelf-act" icon={<EllipsisOutlined />} loading={shelfPending === s.id} disabled={Boolean(shelfPending)} aria-label={`对话更多操作：${s.title}`} />
                    </Dropdown>
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
          {sessionCost ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              本会话已用 <OdCoin size={11} muted /> {sessionCost}
            </div>
          ) : null}
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
              <span>{msgs.length} 条消息</span>
              {sessionCost ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  · 已用 <OdCoin size={11} muted /> {sessionCost}
                </span>
              ) : null}
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

        {connectionError ? <Alert className="ui-chat2-connection-error" type="error" showIcon message={connectionError}
          action={<Button size="small" onClick={() => openSession(sessionRef.current?.id)}>恢复连接</Button>} /> : null}
        {metaError ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice
              tone="error"
              title="模型配置加载失败"
              actions={
                <Button size="small" onClick={() => loadMeta(keyId)}>
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
        {/* 「有密钥但一把都不可用」的引导。
            为什么必须有动作按钮（三个独立人格都撞到并报上来）：
            原文只说「请让管理员检查分组管理与渠道管理」—— 而个人端根本没有那两个菜单，
            用户被指向一个自己去不了的地方，是**死路**；且输入框同时被禁用、旁边没解释，
            新人会判定「网站坏了」（大学生/产品经理/小白三人都这么描述）。
            与上面「无密钥」那条保持一致：说清原因 + 给出能点的出口。 */}
        {!metaError && meta && !needKey && !models.length ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice
              tone="warn"
              title="当前密钥所在的分组没有可用模型"
              actions={
                <>
                  <Button size="small" onClick={() => navigate("/token")}>
                    换一把密钥
                  </Button>
                  <Button size="small" type="primary" onClick={() => loadMeta(keyId)}>
                    重新检测
                  </Button>
                </>
              }
            >
              密钥的路由由它绑定的分组决定。这个分组下暂时没有可用渠道 ——
              换一把绑定了其他分组的密钥通常就能用了；若所有分组都不可用，
              再把这条提示发给站点管理员。<b>不是你的配置问题。</b>
            </Notice>
          </div>
        ) : null}
        {/* 「已就绪但还没选模型」：输入框此时是禁用的，必须解释原因。
            原先这个中间态没有任何提示（输入框灰着、页面上找不到半句说明），
            用户只能靠乱点发现「要点右下角的『选择模型』」。 */}
        {!metaError && meta && !needKey && models.length && !curModel ? (
          <div style={{ padding: "10px 16px" }}>
            <Notice tone="info" title="请先选择模型">
              点右下角的「选择模型」挑一个，选好后输入框就能用了。
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
                  busy={busy || unavailable}
                  streaming={Boolean(m.streaming)}
                  onRetry={retry}
                  onCopy={copy}
                />
              ))
            ) : (
              <section className="ui-chat2-welcome">
                <div className="bui-eyebrow">OOAPI · 对话</div>
                <h2>今天，想弄清楚什么？</h2>
                <p>直接提问即可。需要查资料、读网页、查你的账号时，助手会自己调用工具，并把过程摊开给你看。</p>
                <div className="bui-suggests">
                  {SUGGESTS.map((s) => (
                    <SuggestionCard
                      key={s.title}
                      icon={s.icon}
                      title={s.title}
                      desc={s.desc}
                      onClick={() => {
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
              onChange={(value) => { draftVersionRef.current += 1; setInput(value); }}
              onSend={() => send()}
              onStop={stop}
              busy={busy}
              // 还没有选择模型时必须允许打开模型菜单；否则「请先选择模型」会变成死锁。
              // 只有输入框/发送按钮继续由 PromptBar 根据 model 是否为空禁用。
              disabled={needKey || loadingSession || metaLoading || Boolean(metaError) || Boolean(connectionError) || reading}
              models={models}
              vendorGroups={meta?.vendors || null}
              model={session?.model || ""}
              onModelChange={setModel}
              keys={usableKeys}
              keyId={keyId}
              onKey={onKeyPick}
              chips={[
                ...images.map((img, i) => ({ src: img.url || img.dataUrl, label: `图片 ${i + 1}`, kind: "image" })),
                ...docs.map((d) => ({ label: d.name, kind: "file" })),
              ]}
              onRemoveChip={(i) => {
                // chips 顺序是「先图片后文件」，按下标反推该删哪个
                if (i < images.length) setImages((prev) => prev.filter((_, j) => j !== i));
                else setDocs((prev) => prev.filter((_, j) => j !== i - images.length));
              }}
              onPickImage={() => fileRef.current?.click()}
              // Ctrl+V 贴截图：与「点 + 选图」共用同一套校验/上传（见 acceptImageFiles）
              onPasteImage={(files) => acceptImageFiles(files)}
              onPickFile={() => docRef.current?.click()}
              fileOk={!reading}
              visionOk={supportsVision && !reading}
              placeholder={busy ? "正在生成…" : metaLoading ? "正在加载密钥和可用模型…" : "输入你的问题，或分享一个想法…"}
              commands={[
                { key: "new", name: "new", desc: "新建对话", run: newSession },
                { key: "archive", name: "archive", desc: "归档当前对话", run: () => archiveSession(session?.id) },
                { key: "clear", name: "clear", desc: "清空当前会话消息", run: () => { setMsgs([]); setInput(""); setImages([]); setDocs([]); } },
                { key: "file", name: "file", desc: "添加文档（PDF / Word / Excel / 文本）", run: () => docRef.current?.click() },
                { key: "setting", name: "setting", desc: "打开会话设定（会话指令）", run: () => setSheetOpen(true) },
                { key: "account", name: "account", desc: "问问我的账号情况", run: () => setInput("帮我看看我的账号：余额、最近的调用记录和消耗情况。") },
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

      <NameDialog
        dialog={nameDialog} saving={savingName} error={nameError} onSave={saveName}
        onClose={() => { if (!nameBusyRef.current) { setNameDialog(null); setNameError(""); } }}
      />

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
            const saved = await patchSession(body);
            if (!saved) return false;
            setSheetOpen(false);
            return true;
          } finally {
            setSavingSheet(false);
          }
        }}
      />
    </div>
  );
}
