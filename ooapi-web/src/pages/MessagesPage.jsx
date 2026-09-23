// 消息中心 —— 单聊 / 群聊 / 讨论组
// ---------------------------------------------------------------------------
// 骨架属 B 类（视口锁定双栏）：高度锁死，左右各自独立滚动。
// **绝不允许页面整体被长消息撑出外层滚动条** —— 那会让底部输入框脱离视线。
//
// 移动端按 Gemini 意见走「主从堆叠」而不是抽屉：
//   /messages        → 纯会话列表（占满宽度）
//   /messages/:id    → 全屏聊天（顶部常驻返回箭头）
//   并用 100dvh 规避移动端虚拟键盘遮挡输入框的老问题。
//
// 消息状态用**本地乐观队列**（SSE 是单向的，上行仍走 HTTP POST）：
//   发送时立即用 clientId 乐观插入一条「发送中」的消息，
//   收到服务端广播回来带同一 clientId 的消息后，把它替换为「已发送」。
//   没有这层，弱网下会出现「重复插入」或「红点假消除」。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button, Input, Space, Avatar, Empty, Skeleton, App as AntApp, Modal, Form, Select, Tag, Dropdown, Tooltip,
} from "antd";
import {
  PlusOutlined, SendOutlined, ArrowLeftOutlined, PictureOutlined, UsergroupAddOutlined,
  MoreOutlined, SearchOutlined, MessageOutlined, TeamOutlined, CommentOutlined, DeleteOutlined, WifiOutlined,
} from "@ant-design/icons";
import { API, getToken } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";

const ROOM_TYPE = {
  single: { label: "单聊", icon: <MessageOutlined /> },
  group: { label: "群聊", icon: <TeamOutlined /> },
  discussion: { label: "讨论组", icon: <CommentOutlined /> },
};

/** 时间戳合并：5 分钟内的消息共用一条时间分隔（避免每条都占一行高度） */
const TIME_MERGE_MS = 5 * 60 * 1000;

function fmtTime(ts) {
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return `${md} ${hh}:${mm}`;
}

function fmtRoomTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return "";
  const diff = Math.floor(Date.now() / 1000) - t;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return fmtTime(t).slice(0, 5);
}

/** 超长消息折叠：粘长 JSON/日志不刷屏 */const LONG_TEXT = 600;

export default function MessagesPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();
  const { user: me } = useApp();
  const { begin, isLatest } = useLatest();

  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [room, setRoom] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [userOptions, setUserOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [online, setOnline] = useState([]);
  const [sseOk, setSseOk] = useState(false);
  const [kw, setKw] = useState("");
  const [results, setResults] = useState([]);
  const [msgSearching, setMsgSearching] = useState(false); // 消息内容搜索（与「搜索用户」区分）
  const [form] = Form.useForm();
  // 建会话弹窗里当前选的类型（single/group/discussion）。
  // 用 useWatch 而不是 getFieldValue：后者的作用域仅限 shouldUpdate 的 render prop，
  // 在 Select 那一层引用它会抛 ReferenceError 并让整页白屏（见 Select 处的注释）。
  const formType = Form.useWatch("type", form);

  const scrollRef = useRef(null);
  const esRef = useRef(null);
  const activeRoomRef = useRef(0);
  // 乐观队列：clientId → 本地消息。SSE 回来时按 clientId 命中并替换为服务端版本
  const pendingRef = useRef(new Map());
  const fileRef = useRef(null);

  const activeRoomId = Number(roomId) || 0;
  activeRoomRef.current = activeRoomId;
  const isMobileList = !activeRoomId;

  /* ---------------- 会话列表 ---------------- */
  const loadRooms = useCallback(async () => {
    const token = begin();
    setRoomsLoading(true);
    try {
      const d = await API.get("/chatroom/rooms", { params: { p: 1, page_size: 60 } });
      if (!isLatest(token)) return;
      setRooms(d?.items || []);
    } catch (e) {
      if (isLatest(token)) toast.error(e.message);
    } finally {
      if (isLatest(token)) setRoomsLoading(false);
    }
  }, [begin, isLatest, toast]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  /**
   * 跨会话搜索消息。
   * 服务端只在「我所在的房间」里搜 —— 聊天是私密的，能搜到别人房间等于泄露。
   * 结果为空时不清空会话列表（让用户能接着点原有会话）。
   */
  const doSearch = useCallback(
    async (text) => {
      const q = String(text || "").trim();
      if (!q) {
        setResults([]);
        return;
      }
      setMsgSearching(true);
      try {
        const d = await API.get("/chatroom/search", { params: { q, p: 1, page_size: 30 } });
        setResults(d?.items || []);
        if (!d?.items?.length) toast.info("没有匹配的消息");
      } catch (e) {
        toast.error(e.message);
        setResults([]);
      } finally {
        setMsgSearching(false);
      }
    },
    [toast]
  );

  /* ---------------- SSE 长连接（一次性票据 + 指数退避重连） ----------------
   *
   * 票据是**一次性的**（服务端 `tickets.delete(ticket)`，见 routes/chatroom.js），
   * 而 EventSource 内置的重连会拿同一个 URL（同一个旧票据）再请求 → 必然 401。
   * 所以断线后必须**换新票据**重建连接，且要自己控制退避节奏，
   * 否则服务端一抖就变成「永久离线」（原来 onerror 只是 setSseOk(false)，
   * 什么都不做 —— 实测反馈的问题）。
   *
   * 退避：1s → 2s → 4s → … 最多 30s，一旦 ready 就重置回 1s。
   * cleanup 时必须 clearTimeout，否则组件卸载后定时器还会建连接（内存泄漏 + 幽灵连接）。
   */
  useEffect(() => {
    let closed = false;
    let es = null;
    let retryTimer = null;
    let attempt = 0;
    const MAX_BACKOFF_MS = 30000;

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (!closed) connect();
      }, delay);
    };

    const connect = async () => {
      if (closed) return;
      try {
        const { ticket } = await API.post("/chatroom/stream-ticket", {});
        if (closed) return;
        // EventSource 带不了 Authorization，所以用一次性票据（与监控页同一套）
        es = new EventSource(`/api/chatroom/stream?ticket=${encodeURIComponent(ticket)}`);
        esRef.current = es;
        es.addEventListener("ready", () => {
          attempt = 0; // 连上了就把退避重置
          setSseOk(true);
        });
        es.addEventListener("message", (ev) => {
          let payload = null;
          try {
            payload = JSON.parse(ev.data);
          } catch {
            return;
          }
          const m = payload?.message;
          if (!m) return;
          const rid = Number(payload.room_id) || 0;
          // 乐观队列命中：这条就是我刚发的，用服务端版本替换本地临时消息
          if (m.client_id && pendingRef.current.has(m.client_id)) {
            pendingRef.current.delete(m.client_id);
          }
          if (rid === activeRoomRef.current) {
            setMsgs((prev) => {
              // clientId 命中 → 替换；否则按 id 去重后追加
              const byClient = m.client_id ? prev.findIndex((x) => x.client_id === m.client_id && x.id < 0) : -1;
              if (byClient >= 0) {
                const copy = prev.slice();
                copy[byClient] = { ...m, _local: false };
                return copy;
              }
              if (prev.some((x) => x.id === m.id)) return prev;
              return [...prev, { ...m, _local: false }];
            });
            // 在看的房间即时标记已读，避免红点残留
            API.post(`/chatroom/rooms/${rid}/read`, {}).catch(() => {});
          }
          loadRooms();
        });
        es.addEventListener("presence", (ev) => {
          try {
            const p = JSON.parse(ev.data);
            setOnline((prev) => (p.online ? [...new Set([...prev, p.user_id])] : prev.filter((x) => x !== p.user_id)));
          } catch {
            /* ignore */
          }
        });
        es.addEventListener("invited", () => {
          toast.info("你被邀请加入了一个新的会话");
          loadRooms();
        });
        es.addEventListener("dissolved", (ev) => {
          try {
            const d = JSON.parse(ev.data);
            toast.info("一个会话已被解散");
            if (Number(d.room_id) === activeRoomRef.current) navigate("/messages");
          } catch {
            /* ignore */
          }
          loadRooms();
        });
        es.addEventListener("recalled", (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (Number(d.room_id) === activeRoomRef.current) {
              setMsgs((prev) => prev.map((m) => (m.id === Number(d.message_id) ? { ...m, status: 2, content: "" } : m)));
            }
          } catch {
            /* ignore */
          }
        });
        es.addEventListener("kicked", () => {
          toast.info("你已被移出该会话");
          navigate("/messages");
          loadRooms();
        });
        es.onerror = () => {
          setSseOk(false);
          // 关键：先 close 掉内置重连（它会复用旧票据，必然 401 并在
          // 浏览器里反复打接口），再由我们换新票据重连。
          try {
            es?.close();
          } catch {
            /* ignore */
          }
          esRef.current = null;
          scheduleReconnect();
        };
      } catch {
        setSseOk(false);
        scheduleReconnect();
      }
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
    };
  }, [loadRooms, navigate, toast]);

  useEffect(() => {
    API.get("/chatroom/online")
      .then((d) => setOnline(Array.isArray(d) ? d : []))
      .catch(() => setOnline([]));
  }, []);

  /* ---------------- 当前房间与消息 ---------------- */
  const loadMsgs = useCallback(async () => {
    if (!activeRoomId) {
      setRoom(null);
      setMsgs([]);
      return;
    }
    const token = begin();
    setMsgsLoading(true);
    try {
      const [r, m] = await Promise.all([
        API.get(`/chatroom/rooms/${activeRoomId}`),
        API.get(`/chatroom/rooms/${activeRoomId}/messages`, { params: { p: 1, page_size: 60 } }),
      ]);
      if (!isLatest(token)) return;
      setRoom(r);
      // 服务端消息 + 仍在等待确认的本地消息（乐观队列里没被替换掉的）
      const local = [...pendingRef.current.values()].filter((x) => x.room_id === activeRoomId);
      setMsgs([...(m?.items || []), ...local].sort((a, b) => Number(a.id) - Number(b.id)));
      if (Number(r.last_read_id) !== undefined) {
        API.post(`/chatroom/rooms/${activeRoomId}/read`, {}).catch(() => {});
      }
    } catch (e) {
      if (isLatest(token)) {
        toast.error(e.message);
        navigate("/messages");
      }
    } finally {
      if (isLatest(token)) setMsgsLoading(false);
    }
  }, [activeRoomId, begin, isLatest, navigate, toast]);

  useEffect(() => {
    loadMsgs();
  }, [loadMsgs]);

  // 自动滚到底：新消息到达或切换房间时
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs.length, activeRoomId]);

  /* ---------------- 发送（乐观队列） ---------------- */
  const send = async () => {
    const content = input.trim();
    if (!content || sending || !activeRoomId) return;
    // clientId 必须唯一且够短（服务端列宽 40）；用随机串避免与其它标签页撞车
    const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tempId = -Date.now();
    const optimistic = {
      id: tempId,
      room_id: activeRoomId,
      user_id: me?.id || 0,
      author: { id: me?.id, username: me?.username, display_name: me?.display_name, avatar_url: me?.avatar_url },
      type: "text",
      content,
      media: [],
      client_id: clientId,
      created_time: Math.floor(Date.now() / 1000),
      status: 1,
      _local: true,
    };
    pendingRef.current.set(clientId, optimistic);
    setMsgs((prev) => [...prev, optimistic]);
    setInput("");
    setSending(true);
    try {
      const sent = await API.post(`/chatroom/rooms/${activeRoomId}/messages`, { type: "text", content, client_id: clientId });
      pendingRef.current.delete(clientId);
      setMsgs((prev) => prev.map((m) => (m.client_id === clientId && m.id < 0 ? { ...sent, _local: false } : m)));
      loadRooms();
    } catch (e) {
      // 发送失败：把这条标成失败（不静默丢弃 —— 用户要能看到哪条没发出去）
      setMsgs((prev) => prev.map((m) => (m.client_id === clientId ? { ...m, _failed: true } : m)));
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  const retry = async (m) => {
    const clientId = m.client_id;
    setMsgs((prev) => prev.map((x) => (x.client_id === clientId ? { ...x, _failed: false, _local: true } : x)));
    try {
      const sent = await API.post(`/chatroom/rooms/${activeRoomId}/messages`, { type: "text", content: m.content, client_id: clientId });
      pendingRef.current.delete(clientId);
      setMsgs((prev) => prev.map((x) => (x.client_id === clientId ? { ...sent, _local: false } : x)));
    } catch (e) {
      setMsgs((prev) => prev.map((x) => (x.client_id === clientId ? { ...x, _failed: true } : x)));
      toast.error(e.message);
    }
  };

  const sendImage = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length || !activeRoomId) return;
    const file = files[0];
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      toast.warning("请选择 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
      // 先传媒体库再发 id（与对话页同一条链路）
      const saved = await API.post("/media", { dataUrl, name: file.name, source: "chat" });
      const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const sent = await API.post(`/chatroom/rooms/${activeRoomId}/messages`, {
        type: "image",
        content: "",
        media_ids: [saved.id],
        client_id: clientId,
      });
      setMsgs((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, { ...sent, _local: false }]));
      loadRooms();
    } catch (err) {
      toast.error(err.message);
    }
  };

  /* ---------------- 新建会话 ---------------- */
  const searchUsers = async (kw) => {
    if (!kw?.trim()) {
      setUserOptions([]);
      return;
    }
    setSearching(true);
    try {
      const d = await API.get("/chatroom/users", { params: { q: kw.trim() } });
      setUserOptions(
        (Array.isArray(d) ? d : []).map((u) => ({
          value: u.id,
          label: `${u.display_name || u.username}（@${u.username}）`,
        }))
      );
    } catch {
      setUserOptions([]);
    } finally {
      setSearching(false);
    }
  };

  const submitCreate = async () => {
    if (creating) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    // 防御：正常不会走到（Select 已 multi + 表单必填），但若字段形状意外变化
    // 也不能把 JS 内部报错当 toast 丢给用户（之前 `number.map is not a function`
    // 就是这么漏出去的 —— 用户看到的是引擎报错串，不是人话）。
    const pickedIds = Array.isArray(v.user_ids) ? v.user_ids : v.user_ids == null ? [] : [v.user_ids];
    if (!pickedIds.length) {
      toast.error("请先选择一位成员");
      return;
    }
    setCreating(true);
    try {
      const payload =
        v.type === "single"
          ? { type: "single", user_id: Number(pickedIds[0]) }
          : { type: v.type, name: v.name, user_ids: pickedIds.map(Number).filter(Number.isFinite) };
      const r = await API.post("/chatroom/rooms", payload);
      toast.success("会话已就绪");
      setCreateOpen(false);
      form.resetFields();
      await loadRooms();
      navigate(`/messages/${r.id}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setCreating(false);
    }
  };

  const recall = async (m) => {
    try {
      await API.del(`/chatroom/messages/${m.id}`);
      setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, status: 2, content: "" } : x)));
      toast.success("已撤回");
    } catch (e) {
      toast.error(e.message);
    }
  };

  const leaveRoom = async () => {
    try {
      await API.del(`/chatroom/rooms/${activeRoomId}/members/me`);
      toast.success("已退出");
      navigate("/messages");
      loadRooms();
    } catch (e) {
      toast.error(e.message);
    }
  };

  /* ---------------- 渲染：消息流（时间合并） ---------------- */
  const rendered = useMemo(() => {
    const out = [];
    let lastTs = 0;
    for (const m of msgs) {
      const ts = Number(m.created_time) * 1000;
      // 5 分钟内的消息共用一条时间分隔，避免每条都占一行
      if (!lastTs || ts - lastTs > TIME_MERGE_MS) {
        out.push({ kind: "time", key: `t-${m.id}`, ts: m.created_time });
        lastTs = ts;
      }
      out.push({ kind: "msg", key: `m-${m.id}-${m.client_id || ""}`, m });
    }
    return out;
  }, [msgs]);

  const isMine = (m) => Number(m.user_id) === Number(me?.id);

  return (
    <div className="oo-page" style={{ gap: "var(--sp-3)" }}>
      <PageHeader
        title="消息"
        tags={
          <>
            <Tag>{rooms.reduce((a, r) => a + (r.unread || 0), 0)} 条未读</Tag>
            <Tooltip title={sseOk ? "实时推送已连接" : "实时推送未连接，消息需刷新后可见"}>
              <Tag color={sseOk ? "green" : "default"} icon={<WifiOutlined />}>
                {sseOk ? "实时" : "离线"}
              </Tag>
            </Tooltip>
          </>
        }
        extra={
          <>
            <Button icon={<SearchOutlined />} onClick={() => toast.info("在左侧会话列表上方可直接搜索用户发起新会话")} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setCreateOpen(true); }}>
              发起会话
            </Button>
          </>
        }
      />

      {/* B 类骨架：视口锁定双栏，两端各自滚动。
          移动端由 CSS 切成单列（主从堆叠），所以这里不写条件渲染分支。 */}
      <div className={`oo-split-lock${activeRoomId ? " is-immersive" : ""}`}>
        {/* 左：会话列表 */}
        <div className="oo-split-side" style={activeRoomId ? undefined : { display: "flex" }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
            <Input
              size="small"
              placeholder="搜索消息内容 / 会话"
              allowClear
              prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onPressEnter={() => doSearch(kw)}
            />
          </div>
          <div className="oo-split-scroll">
            {/* 搜索结果：命中消息列表（点击跳到该会话） */}
            {kw.trim() ? (
              <div style={{ borderBottom: "1px solid var(--line)", background: "var(--inset)" }}>
                <div style={{ padding: "6px 10px", fontSize: 11.5, color: "var(--ink-3)" }}>
                  {msgSearching ? "搜索中…" : `消息搜索结果 ${results.length} 条`}
                  {kw ? (
                    <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={() => { setKw(""); setResults([]); }}>
                      清除
                    </Button>
                  ) : null}
                </div>
                {results.slice(0, 20).map((r) => (
                  <div
                    key={r.id}
                    className="oo-room-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      navigate(`/messages/${r.room_id}`);
                      setKw("");
                      setResults([]);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/messages/${r.room_id}`);
                        setKw("");
                        setResults([]);
                      }
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="oo-room-title oo-truncate">{r.room_title || `会话 #${r.room_id}`}</div>
                      <div className="oo-room-preview oo-truncate">{r.content || "[图片]"}</div>
                    </div>
                    <span className="oo-room-time">{fmtRoomTime(r.created_time)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {roomsLoading && !rooms.length ? (
              <div style={{ padding: 14 }}><Skeleton active paragraph={{ rows: 3 }} /></div>
            ) : !rooms.length ? (
              <div style={{ padding: "32px 12px" }}>
                <Empty description="还没有会话，点右上角「发起会话」" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            ) : (
              rooms
                .filter((r) => {
                  const q = kw.trim().toLowerCase();
                  if (!q) return true;
                  return String(r.title || r.name || "").toLowerCase().includes(q);
                })
                .map((r) => (
                <div
                  key={r.id}
                  className={`oo-room-item${r.id === activeRoomId ? " is-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/messages/${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/messages/${r.id}`);
                    }
                  }}
                >
                  {r.type === "single" && r.peer ? (
                    <UserAvatar user={r.peer} size={32} />
                  ) : (
                    <Avatar size={32} style={{ background: "var(--accent-tint)", color: "var(--accent-ink)" }} icon={ROOM_TYPE[r.type]?.icon} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="oo-room-title oo-truncate" style={{ flex: 1 }}>{r.title || r.name}</span>
                      <span className="oo-room-time">{fmtRoomTime(r.last_message_time)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="oo-room-preview oo-truncate" style={{ flex: 1 }}>{r.last_message_text || "暂无消息"}</span>
                      {r.unread ? (
                        <span className="bui-chip bui-chip--accent" style={{ padding: "0 5px", fontSize: 10.5 }}>{r.unread}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右：聊天区。隐藏逻辑交给 CSS —— **只在移动端隐藏**未选中时的占位
            （移动端走「列表 → 全屏聊天」的主从堆叠）。
            这里曾经无条件 display:none，结果桌面端右侧整块空白（截图实测发现）。 */}
        <div className={`oo-split-main${activeRoomId ? "" : " is-empty"}`}>
          {!activeRoomId ? (
            <div style={{ margin: "auto", padding: 24, textAlign: "center", color: "var(--ink-3)" }}>
              <Empty description="从左侧选择一个会话开始聊天" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <>
              {/* 顶栏：移动端常驻返回箭头 */}
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                  borderBottom: "1px solid var(--line)", flexShrink: 0,
                }}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={() => navigate("/messages")}
                  aria-label="返回会话列表"
                />
                {room ? (
                  <>
                    <span style={{ fontSize: 13.5, fontWeight: 550 }} className="oo-truncate">{room.title}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {ROOM_TYPE[room.type]?.label} · {room.member_count} 人
                    </span>
                  </>
                ) : null}
                <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <Tooltip title="邀请成员">
                    <Button
                      type="text"
                      size="small"
                      icon={<UsergroupAddOutlined />}
                      disabled={room?.type === "single"}
                      onClick={() => navigate(`/messages/${activeRoomId}?invite=1`)}
                    />
                  </Tooltip>
                  <Dropdown
                    menu={{
                      items: [
                        { key: "leave", label: "退出会话", danger: true, icon: <DeleteOutlined />, onClick: leaveRoom },
                      ],
                    }}
                  >
                    <Button type="text" size="small" icon={<MoreOutlined />} />
                  </Dropdown>
                </span>
              </div>

              {/* 消息流 */}
              <div className="oo-split-scroll" ref={scrollRef}>
                {msgsLoading && !msgs.length ? (
                  <div style={{ padding: 14 }}><Skeleton active paragraph={{ rows: 4 }} /></div>
                ) : !msgs.length ? (
                  <div style={{ padding: "40px 12px", textAlign: "center", color: "var(--ink-3)", fontSize: 12.5 }}>
                    还没有消息，发送第一条开始对话
                  </div>
                ) : (
                  <div className="oo-msg-list">
                    {rendered.map((it) =>
                      it.kind === "time" ? (
                        <div key={it.key} className="oo-msg-time-divider">{fmtTime(it.ts)}</div>
                      ) : it.m.type === "system" ? (
                        <div key={it.key} className="oo-msg-time-divider">{it.m.content}</div>
                      ) : (
                        <MessageRow
                          key={it.key}
                          m={it.m}
                          mine={isMine(it.m)}
                          onRecall={() => recall(it.m)}
                          onRetry={() => retry(it.m)}
                        />
                      )
                    )}
                  </div>
                )}
              </div>

              {/* 输入区：常驻可见（B 类骨架的核心目的） */}
              <div className="oo-msg-input">
                <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
                  <Tooltip title="发送图片">
                    <Button icon={<PictureOutlined />} onClick={() => fileRef.current?.click()} />
                  </Tooltip>
                  <Input.TextArea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
                    autoSize={{ minRows: 1, maxRows: 5 }}
                    maxLength={4000}
                    onPressEnter={(e) => {
                      if (!e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!input.trim()} onClick={send}>
                    发送
                  </Button>
                </div>
                <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={sendImage} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* 邀请成员弹窗（复用 meta 里的用户搜索） */}
      <InviteModal
        open={new URLSearchParams(window.location.search).get("invite") === "1"}
        roomId={activeRoomId}
        onClose={() => navigate(`/messages/${activeRoomId}`)}
        onDone={() => { loadMsgs(); loadRooms(); }}
      />

      <Modal
        title="发起会话"
        open={createOpen}
        onOk={submitCreate}
        confirmLoading={creating}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false} initialValues={{ type: "single" }}>
          <Form.Item name="type" label="类型">
            <Select
              options={[
                { value: "single", label: "单聊（一对一）" },
                { value: "group", label: "群聊" },
                { value: "discussion", label: "讨论组" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.type !== c.type}>
            {({ getFieldValue }) =>
              getFieldValue("type") !== "single" ? (
                <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
                  <Input placeholder="例如：前端讨论组" maxLength={64} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item
            name="user_ids"
            label="选择成员"
            rules={[
              { required: true, message: "请选择成员" },
              // 单聊必须是恰好一人：选两个会在后端只取第一个（静默忽略第二个），
              // 前端必须拦住，否则用户以为拉进了一个双人会话
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  getFieldValue("type") === "single" && Array.isArray(v) && v.length > 1
                    ? Promise.reject(new Error("单聊只能选择一位成员"))
                    : Promise.resolve(),
              }),
            ]}
            tooltip="输入用户名或昵称搜索；单聊只能选一人"
          >
            {/* 必须 multi 模式：表单字段名是 user_ids（复数），提交处按数组取
                `v.user_ids[0]`（单聊）/ `v.user_ids.map()`（群聊）。
                原先漏了 mode="multiple"，Select 返回的是**标量**，于是：
                  · 单聊 → `Number(number?.[0])` = NaN → JSON 序列化成 null
                    → 后端 400「请选择聊天对象」，明明已经选中了人；
                  · 群聊 → `(number).map is not a function`，JS 报错串直接弹给用户。
                即「站内消息发起会话 100% 失败」（黑盒测试实测，单聊/群聊都发不出去）。
                maxCount 让单聊在 UI 层就选不了第二个人 —— 与下面
                「单聊只能选择一位成员」的校验互补（那条是兜底，不该让用户先选错再报错）。

                `formType` 来自组件顶部的 `Form.useWatch("type", form)`。
                **不能**在这里写 `getFieldValue(...)`：它只在上面的
                `<Form.Item noStyle shouldUpdate>` render prop 作用域里存在，
                在本层是未定义标识符 —— 那会让整个页面抛
                `ReferenceError: getFieldValue is not defined` 而**白屏**
                （我第一版就是这么写的，导致 /messages 整页崩掉，产品经理人格实测报上来）。 */}
            <Select
              mode="multiple"
              maxCount={formType === "single" ? 1 : undefined}
              showSearch
              filterOption={false}
              onSearch={searchUsers}
              loading={searching}
              placeholder="搜索用户"
              options={userOptions}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.type !== c.type}>
            {({ getFieldValue }) => (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {getFieldValue("type") === "single"
                  ? "单聊只能选一位成员；重复发起会复用已有会话。"
                  : "群聊最多 200 人；创建后会通知被邀请者。"}
              </div>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 单条消息：头像 28px、气泡紧凑；长文本折叠；hover 才显示时间与操作 */
function MessageRow({ m, mine, onRecall, onRetry }) {
  const [expanded, setExpanded] = useState(false);
  const text = String(m.content || "");
  const long = text.length > LONG_TEXT;
  return (
    <div className={`oo-msg-row${mine ? " is-mine" : ""}`}>
      {!mine ? <UserAvatar user={m.author} size={28} /> : null}
      <div className={`oo-msg-bubble${m._local ? " is-pending" : ""}${m._failed ? " is-failed" : ""}`}>
        {!mine && m.author?.display_name ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 1 }}>{m.author.display_name}</div>
        ) : null}
        {m.type === "image" && Array.isArray(m.media) && m.media.length ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: text ? 4 : 0 }}>
            {m.media.map((x) => (
              <img key={x.id} src={x.url} alt="" style={{ maxWidth: 200, borderRadius: "var(--r-sm)", display: "block" }} />
            ))}
          </div>
        ) : null}
        {m.status === 2 ? (
          <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>消息已撤回</span>
        ) : text ? (
          <>
            <div className={long && !expanded ? "oo-msg-collapsed" : undefined} style={{ whiteSpace: "pre-wrap" }}>
              {long && !expanded ? text.slice(0, LONG_TEXT) : text}
            </div>
            {long ? (
              <button type="button" className="oo-code-btn" style={{ padding: 0, marginTop: 2 }} onClick={() => setExpanded((v) => !v)}>
                {expanded ? "收起" : `展开全部（${text.length} 字）`}
              </button>
            ) : null}
          </>
        ) : null}
        {m._failed ? (
          <div style={{ fontSize: 11, marginTop: 2 }}>
            发送失败 <a onClick={onRetry} style={{ cursor: "pointer" }}>重试</a>
          </div>
        ) : null}
      </div>
      {/* 时间与撤回只在 hover 时浮现（否则每条都占一行高度） */}
      <div className="oo-msg-meta" style={{ display: "flex", gap: 6 }}>
        <span>{m._local ? "发送中…" : fmtTime(m.created_time)}</span>
        {mine && m.status === 1 && !m._local ? (
          <a onClick={onRecall} style={{ cursor: "pointer" }}>撤回</a>
        ) : null}
      </div>
    </div>
  );
}

/** 邀请成员 */
function InviteModal({ open, roomId, onClose, onDone }) {
  const { message: toast } = AntApp.useApp();
  const [opts, setOpts] = useState([]);
  const [val, setVal] = useState([]);
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  return (
    <Modal
      title="邀请成员"
      open={open}
      onCancel={onClose}
      okText="邀请"
      confirmLoading={busy}
      onOk={async () => {
        if (!val.length) {
          toast.warning("请选择要邀请的成员");
          return;
        }
        setBusy(true);
        try {
          const r = await API.post(`/chatroom/rooms/${roomId}/members`, { user_ids: val });
          toast.success(`已邀请 ${r?.added ?? 0} 位成员`);
          setVal([]);
          onDone?.();
          onClose?.();
        } catch (e) {
          toast.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Select
        mode="multiple"
        showSearch
        filterOption={false}
        value={val}
        onChange={setVal}
        style={{ width: "100%" }}
        placeholder="输入用户名或昵称搜索"
        onSearch={async (kw) => {
          if (!kw?.trim()) return setOpts([]);
          try {
            const d = await API.get("/chatroom/users", { params: { q: kw.trim() } });
            setOpts((Array.isArray(d) ? d : []).map((u) => ({ value: u.id, label: `${u.display_name || u.username}（@${u.username}）` })));
          } catch {
            setOpts([]);
          }
        }}
        options={opts}
      />
    </Modal>
  );
}
