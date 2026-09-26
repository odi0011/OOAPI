// 消息中心：私聊 + 群聊 + 好友（第 79 批重构）
// ---------------------------------------------------------------------------
// 频道体系（服务器 + 子频道）已下线：公共讨论交给社区帖子，这里只做「人与人」的即时沟通。
// 布局从「导轨 + 二级栏 + 主区 + 成员栏」四栏收成两栏（+ 可收起的资料栏）：
//   左：会话 / 联系人（同一个搜索框）
//   中：聊天 · 好友申请 · 好友名片 · 空状态
//   右：资料栏（私聊 = 对方名片；群聊 = 公告 + 成员），宽屏常驻、窄屏抽屉
// 移动端走路由级主从堆叠（/messages → /messages/:roomId，?panel= 打开申请/名片），不用抽屉。
//
// 几条不能丢的行为（都有测试或踩坑记录）：
//   · 发送走本地乐观队列（client_id 对账）；**失败标红可重试，不静默丢弃**；
//   · 发图独立成一条消息、不塞「[图片]」占位文字、不清空正在输入的草稿；
//   · SSE 断线自动重连（指数退避），重连后按 since_id 补齐断线期间的消息；
//   · 已读/收到消息时通知导航栏刷新红点（不用等 60s 轮询）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { App as AntApp, Button, Drawer, Dropdown, Empty, Form, Grid, Input, Modal, Segmented, Select, Tooltip } from "antd";
import {
  PlusOutlined, SearchOutlined, UserAddOutlined, UsergroupAddOutlined, EditOutlined, SoundOutlined, LogoutOutlined,
  DeleteOutlined, HomeOutlined, DisconnectOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import UserAvatar from "../components/UserAvatar";
import { RoomList, ContactList } from "../components/im/ImSidebar";
import { ChatHeader, MessageList, Composer } from "../components/im/ImChat";
import { PersonCard, GroupInfo, RequestsView, EmptyStage, MemberPicker } from "../components/im/ImPanels";
import { pingBadges } from "../components/im/im-utils";
import "../components/im/im.css";

const PAGE = 50;
const INFO_KEY = "ooapi-im-info";
const EMPTY_REQ = { incoming: [], outgoing: [], pending_count: 0 };

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
}

/** 已确认的消息按 id 排序；本地乐观消息（id<0）保持原顺序排在最后 */
function sortMsgs(list) {
  const ok = list.filter((m) => m.id > 0).sort((a, b) => a.id - b.id);
  return [...ok, ...list.filter((m) => !(m.id > 0))];
}

export default function MessagesPage() {
  const { roomId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { message: toast, modal } = AntApp.useApp();
  const { user: me } = useApp();
  const { begin, isLatest } = useLatest();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const wide = Boolean(screens.xl);

  const activeRoomId = Number(roomId) || 0;
  const panel = params.get("panel") || "";
  const friendPanelId = panel.startsWith("friend:") ? Number(panel.slice(7)) || 0 : 0;

  // ---- 列表数据 ----
  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [friends, setFriends] = useState([]);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [requests, setRequests] = useState(EMPTY_REQ);
  const [online, setOnline] = useState(() => new Set());
  const [sideTab, setSideTab] = useState(() => (panel ? "contacts" : "rooms"));
  const [kw, setKw] = useState("");
  const [filter, setFilter] = useState("all");

  // ---- 当前会话 ----
  const [room, setRoom] = useState(null);
  const [roomError, setRoomError] = useState("");
  const [msgs, setMsgs] = useState([]);
  const [total, setTotal] = useState(0);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [input, setInput] = useState("");
  const [inflight, setInflight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [infoPref, setInfoPref] = useState(() => {
    try {
      return localStorage.getItem(INFO_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [infoDrawer, setInfoDrawer] = useState(false);
  const [sseDown, setSseDown] = useState(false);

  // ---- 弹窗 ----
  const [cardUser, setCardUser] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pickIds, setPickIds] = useState([]);
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [announceText, setAnnounceText] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [addFriendLoading, setAddFriendLoading] = useState(false);
  const [userOptions, setUserOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [addFriendForm] = Form.useForm();

  // SSE 回调里要读最新值：用 ref 兜住，避免闭包拿到旧状态
  const activeRef = useRef(activeRoomId);
  activeRef.current = activeRoomId;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const lastIdRef = useRef(0);
  const readTimer = useRef(null);
  const roomsTimer = useRef(null);
  const searchTimer = useRef(null);

  /* ==================== 列表加载 ==================== */
  const loadRooms = useCallback(async () => {
    try {
      const d = await API.get("/chatroom/rooms", { params: { p: 1, page_size: 100 } });
      setRooms(d?.items || []);
    } catch (e) {
      toast.error(e.message || "会话列表加载失败");
    } finally {
      setRoomsLoading(false);
    }
  }, [toast]);

  // 一串事件（连发消息、批量邀请）只刷新一次会话列表
  const reloadRoomsSoon = useCallback(() => {
    clearTimeout(roomsTimer.current);
    roomsTimer.current = setTimeout(loadRooms, 400);
  }, [loadRooms]);

  const loadFriends = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([API.get("/friends"), API.get("/friends/requests")]);
      setFriends(Array.isArray(f) ? f : []);
      setRequests(r || EMPTY_REQ);
    } catch (e) {
      toast.error(e.message || "联系人加载失败");
    } finally {
      setFriendsLoading(false);
    }
  }, [toast]);

  const loadOnline = useCallback(async () => {
    try {
      const ids = await API.get("/chatroom/online");
      setOnline(new Set(Array.isArray(ids) ? ids : []));
    } catch { /* 在线状态拿不到不影响聊天 */ }
  }, []);

  const markRead = useCallback((rid) => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      API.post(`/chatroom/rooms/${rid}/read`, {}).then(pingBadges).catch(() => {});
    }, 300);
    setRooms((prev) => prev.map((r) => (r.id === rid && r.unread ? { ...r, unread: 0 } : r)));
  }, []);

  useEffect(() => {
    loadRooms();
    loadFriends();
    loadOnline();
    return () => {
      clearTimeout(readTimer.current);
      clearTimeout(roomsTimer.current);
      clearTimeout(searchTimer.current);
    };
  }, [loadRooms, loadFriends, loadOnline]);

  // 通知中心的「XX 申请加你为好友」深链到 ?panel=requests：切到联系人 Tab
  useEffect(() => {
    if (panel) setSideTab("contacts");
  }, [panel]);

  /* ==================== 打开会话 ==================== */
  useEffect(() => {
    setRoom(null);
    setMsgs([]);
    setTotal(0);
    setRoomError("");
    lastIdRef.current = 0;
    if (!activeRoomId) return;
    const token = begin();
    setMsgsLoading(true);
    Promise.all([
      API.get(`/chatroom/rooms/${activeRoomId}`),
      API.get(`/chatroom/rooms/${activeRoomId}/messages`, { params: { p: 1, page_size: PAGE } }),
    ])
      .then(([r, d]) => {
        if (!isLatest(token)) return;
        const items = d?.items || [];
        setRoom(r);
        setMsgs(items);
        setTotal(Number(d?.total) || items.length);
        lastIdRef.current = items.length ? items[items.length - 1].id : 0;
        markRead(activeRoomId);
      })
      .catch((e) => {
        // 旧链接指向已解散的群 / 已下线的频道房间：给出明确的空状态，而不是报错 + 空白
        if (isLatest(token)) setRoomError(e.status === 404 || e.status === 403 ? "这个会话不存在，或者你已经不在其中" : e.message || "会话加载失败");
      })
      .finally(() => {
        if (isLatest(token)) setMsgsLoading(false);
      });
  }, [activeRoomId, begin, isLatest, markRead]);

  const confirmedCount = msgs.filter((m) => m.id > 0).length;
  const hasMore = confirmedCount < total;

  const loadMore = useCallback(async () => {
    if (loadingMore || !activeRoomId) return;
    setLoadingMore(true);
    const rid = activeRoomId;
    try {
      // 按「已加载条数」推页码：期间有新消息进来会让页边界错位几条，靠 id 去重兜住
      const p = Math.floor(confirmedCount / PAGE) + 1;
      const d = await API.get(`/chatroom/rooms/${rid}/messages`, { params: { p, page_size: PAGE } });
      if (activeRef.current !== rid) return;
      setMsgs((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return sortMsgs([...(d?.items || []).filter((m) => !seen.has(m.id)), ...prev]);
      });
      setTotal(Number(d?.total) || 0);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [activeRoomId, confirmedCount, loadingMore, toast]);

  /* ==================== 实时推送（SSE） ==================== */
  const onIncoming = useCallback(
    (rid, m) => {
      if (!m) return;
      if (rid === activeRef.current) {
        setMsgs((prev) => {
          const without = prev.filter((x) => (m.client_id ? x.client_id !== m.client_id : true) && x.id !== m.id);
          return sortMsgs([...without, m]);
        });
        if (m.id > lastIdRef.current) lastIdRef.current = m.id;
        markRead(rid);
      }
      const exists = roomsRef.current.some((r) => r.id === rid);
      if (!exists) {
        reloadRoomsSoon();
        return;
      }
      const preview = m.type === "system" ? m.content : m.content || (m.media?.length ? "[图片]" : "");
      setRooms((prev) =>
        prev
          .map((r) =>
            r.id === rid
              ? {
                  ...r,
                  last_message_text: String(preview || "").slice(0, 120),
                  last_message_time: Number(m.created_time) || Math.floor(Date.now() / 1000),
                  unread: rid === activeRef.current || m.user_id === me?.id || m.type === "system" ? r.unread : (r.unread || 0) + 1,
                }
              : r
          )
          .sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0))
      );
      if (rid !== activeRef.current && m.user_id !== me?.id) pingBadges();
    },
    [markRead, reloadRoomsSoon, me?.id]
  );

  // 断线重连后补齐：会话列表、在线状态、当前会话里断线期间的消息
  const resync = useCallback(async () => {
    loadRooms();
    loadOnline();
    const rid = activeRef.current;
    if (!rid || !lastIdRef.current) return;
    try {
      const d = await API.get(`/chatroom/rooms/${rid}/messages`, { params: { since_id: lastIdRef.current } });
      if (activeRef.current !== rid) return;
      for (const m of d?.items || []) onIncoming(rid, m);
    } catch { /* 下次重连再补 */ }
  }, [loadRooms, loadOnline, onIncoming]);

  // 事件处理器与 resync 放进 ref：SSE 连接只建一次，处理器每次渲染换成最新闭包
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  const handlers = useRef({});
  handlers.current = {
    message: (d) => onIncoming(Number(d.room_id), d.message),
    recalled: (d) => {
      if (Number(d.room_id) === activeRef.current) {
        setMsgs((prev) => prev.map((m) => (m.id === Number(d.message_id) ? { ...m, status: 2, content: "", media: [] } : m)));
      }
      reloadRoomsSoon();
    },
    presence: (d) =>
      setOnline((prev) => {
        const s = new Set(prev);
        if (d.online) s.add(Number(d.user_id));
        else s.delete(Number(d.user_id));
        return s;
      }),
    friend_request: (d) => {
      toast.info(`${d?.from?.display_name || d?.from?.username || "有人"} 申请加你为好友`);
      loadFriends();
    },
    friend_accepted: (d) => {
      toast.success(`${d?.by?.display_name || d?.by?.username || "对方"} 通过了你的好友申请`);
      loadFriends();
      loadOnline();
    },
    friend_removed: () => loadFriends(),
    room_updated: (d) => {
      if (Number(d.room_id) === activeRef.current) {
        const { room_id: _rid, ...patch } = d;
        setRoom((prev) => (prev ? { ...prev, ...patch, title: patch.name && prev.type !== "single" ? patch.name : prev.title } : prev));
      }
      reloadRoomsSoon();
    },
    invited: (d) => {
      toast.info(`你被邀请加入群聊「${d?.name || ""}」`);
      reloadRoomsSoon();
    },
    kicked: (d) => {
      if (Number(d.room_id) === activeRef.current) {
        toast.warning("你已被移出这个群聊");
        navigate("/messages", { replace: true });
      }
      reloadRoomsSoon();
    },
    dissolved: (d) => {
      if (Number(d.room_id) === activeRef.current) {
        toast.warning("这个群聊已被解散");
        navigate("/messages", { replace: true });
      }
      reloadRoomsSoon();
    },
  };

  useEffect(() => {
    let es = null;
    let retry = 0;
    let timer = null;
    let alive = true;
    let first = true;
    const connect = async () => {
      if (!alive) return;
      try {
        const { ticket } = await API.post("/chatroom/stream-ticket", {});
        if (!alive) return;
        es = new EventSource(`/api/chatroom/stream?ticket=${encodeURIComponent(ticket)}`);
        es.addEventListener("ready", () => {
          retry = 0;
          setSseDown(false);
          if (!first) resyncRef.current();
          first = false;
        });
        for (const ev of Object.keys(handlers.current)) {
          es.addEventListener(ev, (e) => {
            try {
              handlers.current[ev]?.(JSON.parse(e.data));
            } catch { /* 单条坏帧不影响后续 */ }
          });
        }
        es.onerror = () => {
          es?.close();
          schedule();
        };
      } catch {
        schedule();
      }
    };
    // 指数退避重连（1s → 30s）。原实现 onerror 直接 close 且不重连：
    // 换网络/休眠唤醒后这一页就再也收不到消息，只能刷新。
    const schedule = () => {
      if (!alive) return;
      setSseDown(true);
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry));
      retry += 1;
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      es?.close();
    };
  }, []);

  /* ==================== 发送 ==================== */
  const post = useCallback(
    async (rid, clientId, body) => {
      setInflight((n) => n + 1);
      try {
        const saved = await API.post(`/chatroom/rooms/${rid}/messages`, { ...body, client_id: clientId });
        if (saved?.id > lastIdRef.current) lastIdRef.current = saved.id;
        if (activeRef.current === rid) {
          setMsgs((prev) => sortMsgs([...prev.filter((x) => x.client_id !== clientId && x.id !== saved.id), saved]));
        }
        onIncoming(rid, saved);
      } catch (e) {
        // 失败标红保留在原位，可重试 / 删除（不静默丢弃 —— 用户以为发出去了其实没有）
        setMsgs((prev) => prev.map((x) => (x.client_id === clientId ? { ...x, pending: false, failed: true, error: e.message } : x)));
      } finally {
        setInflight((n) => n - 1);
      }
    },
    [onIncoming]
  );

  const doSend = (type = "text", content = input, mediaIds = []) => {
    const text = String(content || "").trim();
    if (!activeRoomId || (!text && !mediaIds.length)) return;
    const clientId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const opt = {
      id: -Date.now(),
      room_id: activeRoomId,
      user_id: me?.id,
      author: { id: me?.id, username: me?.username, display_name: me?.display_name, avatar_url: me?.avatar_url },
      type,
      content: text,
      media: [],
      media_ids: mediaIds,
      client_id: clientId,
      created_time: Math.floor(Date.now() / 1000),
      status: 1,
      pending: true,
    };
    setMsgs((prev) => [...prev, opt]);
    if (type === "text") setInput("");
    post(activeRoomId, clientId, { type, content: text, media_ids: mediaIds });
  };

  const retry = (m) => {
    setMsgs((prev) => prev.map((x) => (x.client_id === m.client_id ? { ...x, pending: true, failed: false, error: "" } : x)));
    post(m.room_id, m.client_id, { type: m.type, content: m.content, media_ids: m.media_ids || [] });
  };

  // 发图：**独立成一条消息**，不带占位文字、不动输入框里正在打的字。
  //
  // 历史上两个真实问题（人格实测）：
  //   ① 发的是 content="[图片]" + media —— 气泡里图的上面多一行「[图片]」，像模板没渲染完；
  //   ② 把输入框里的字当 content 一起发走并清空 —— 「先打好一句话再点图片，输入框变空」。
  // doSend 允许「只有图、没有字」，所以 content 传空串；并在发完后恢复草稿。
  const handleUploadPic = async (file) => {
    if (!file || !activeRoomId) return;
    if (!String(file.type || "").startsWith("image/")) {
      toast.warning("只能发送图片文件");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const r = await API.post("/media", { dataUrl, name: file.name || "image.png", source: "chat" }, { timeoutMs: 120000 });
      const draft = input;
      doSend("image", "", [r.id]);
      setInput(draft);
    } catch (err) {
      toast.error(err.message || "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const recall = async (m) => {
    try {
      await API.del(`/chatroom/messages/${m.id}`);
      setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, status: 2, content: "", media: [] } : x)));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const copy = async (m) => {
    try {
      await navigator.clipboard.writeText(m.content || "");
      toast.success("已复制");
    } catch {
      toast.error("复制失败，请手动选择文字");
    }
  };

  /* ==================== 导航 ==================== */
  const setPanel = useCallback(
    (value) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set("panel", value);
          else next.delete("panel");
          return next;
        },
        { replace: !value }
      ),
    [setParams]
  );

  const openRoom = (r) => navigate(`/messages/${r.id}`);

  const openChatWith = async (u) => {
    if (!u?.id || u.id === me?.id) return;
    try {
      const r = await API.post(`/friends/${u.id}/chat`, {});
      setCardUser(null);
      setInfoDrawer(false);
      navigate(`/messages/${r.room_id}`);
      if (!roomsRef.current.some((x) => x.id === r.room_id)) reloadRoomsSoon();
    } catch (e) {
      toast.error(e.message || "发起私聊失败");
    }
  };

  const toggleInfo = () => {
    if (!wide) {
      setInfoDrawer((v) => !v);
      return;
    }
    setInfoPref((v) => {
      try {
        localStorage.setItem(INFO_KEY, v ? "0" : "1");
      } catch { /* ignore */ }
      return !v;
    });
  };

  /* ==================== 好友 ==================== */
  const openAddFriend = (u) => {
    addFriendForm.resetFields();
    if (u?.id) {
      setUserOptions([u]);
      addFriendForm.setFieldsValue({ to_user_id: u.id });
    } else {
      setUserOptions([]);
    }
    setCardUser(null);
    setAddFriendOpen(true);
  };

  const handleSearchUsers = (q) => {
    clearTimeout(searchTimer.current);
    if (!q.trim()) return;
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await API.get("/chatroom/users", { params: { q: q.trim() } });
        setUserOptions(Array.isArray(d) ? d : []);
      } catch {
        setUserOptions([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  };

  const submitAddFriend = async () => {
    let v;
    try {
      v = await addFriendForm.validateFields();
    } catch {
      return;
    }
    setAddFriendLoading(true);
    try {
      const r = await API.post("/friends/requests", { to_user_id: v.to_user_id, message: v.message });
      toast.success(r?.status === "accepted" ? "对方也申请过加你，已直接成为好友" : "好友申请已发送，等待对方验证");
      setAddFriendOpen(false);
      loadFriends();
    } catch (e) {
      toast.error(e.message || "发送申请失败");
    } finally {
      setAddFriendLoading(false);
    }
  };

  const handleRequest = async (req, action) => {
    try {
      await API.put(`/friends/requests/${req.id}`, { action });
      toast.success(action === "accept" ? "已同意，现在可以开始聊天了" : "已拒绝");
      loadFriends();
      if (action === "accept") loadOnline();
    } catch (e) {
      toast.error(e.message || "操作失败");
    }
  };

  const withdrawRequest = async (req) => {
    try {
      await API.del(`/friends/requests/${req.id}`);
      toast.success("已撤回申请");
      loadFriends();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const afterRelationChange = () => {
    loadFriends();
    reloadRoomsSoon();
  };

  /* ==================== 群聊 ==================== */
  const openCreate = () => {
    setGroupName("");
    setPickIds([]);
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!groupName.trim()) return toast.warning("请填写群聊名称");
    if (!pickIds.length) return toast.warning("至少邀请一位成员");
    setBusy(true);
    try {
      const r = await API.post("/chatroom/rooms", { type: "group", name: groupName.trim(), user_ids: pickIds });
      setCreateOpen(false);
      setSideTab("rooms");
      await loadRooms();
      navigate(`/messages/${r.id}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const submitInvite = async () => {
    if (!pickIds.length) return toast.warning("请选择要邀请的人");
    setBusy(true);
    try {
      const r = await API.post(`/chatroom/rooms/${activeRoomId}/members`, { user_ids: pickIds });
      toast.success(r?.added ? `已邀请 ${r.added} 位成员` : "这些人都已经在群里了");
      setInviteOpen(false);
      setRoom(await API.get(`/chatroom/rooms/${activeRoomId}`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const saveAnnouncement = async () => {
    setBusy(true);
    try {
      await API.put(`/chatroom/rooms/${activeRoomId}/announcement`, { announcement: announceText.trim() });
      setRoom((prev) => (prev ? { ...prev, announcement: announceText.trim() } : prev));
      setAnnounceOpen(false);
      toast.success("群公告已更新");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    const name = renameText.trim();
    if (!name) return toast.warning("群名称不能为空");
    setBusy(true);
    try {
      await API.put(`/chatroom/rooms/${activeRoomId}/name`, { name });
      setRoom((prev) => (prev ? { ...prev, name, title: name } : prev));
      setRenameOpen(false);
      reloadRoomsSoon();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const leaveRoom = () => {
    const single = room?.type === "single";
    modal.confirm({
      title: single ? "删除这个会话？" : `退出群聊「${room?.title}」？`,
      content: single
        ? "会话会从你的列表里移除，对方不会收到提示；对方再发消息时会话会重新出现。"
        : room?.owner_id === me?.id
          ? "你是群主，退出后群主会转给最早加入的成员。"
          : "退出后将不再收到这个群的消息。",
      okText: single ? "删除" : "退出",
      okType: "danger",
      onOk: async () => {
        await API.del(`/chatroom/rooms/${activeRoomId}/members/me`);
        setRooms((prev) => prev.filter((r) => r.id !== activeRoomId));
        navigate("/messages", { replace: true });
      },
    });
  };

  const dissolveRoom = () =>
    modal.confirm({
      title: `解散群聊「${room?.title}」？`,
      content: "所有成员都会被移出，此操作无法撤销。",
      okText: "解散",
      okType: "danger",
      onOk: async () => {
        await API.del(`/chatroom/rooms/${activeRoomId}`);
        setRooms((prev) => prev.filter((r) => r.id !== activeRoomId));
        navigate("/messages", { replace: true });
      },
    });

  const kickMember = (m) =>
    modal.confirm({
      title: `将 ${m.display_name || m.username} 移出群聊？`,
      okText: "移出",
      okType: "danger",
      onOk: async () => {
        await API.del(`/chatroom/rooms/${activeRoomId}/members/${m.id}`);
        setRoom((prev) => (prev ? { ...prev, members: prev.members.filter((x) => x.id !== m.id) } : prev));
      },
    });

  /* ==================== 渲染 ==================== */
  const unreadTotal = useMemo(() => rooms.reduce((n, r) => n + (Number(r.unread) || 0), 0), [rooms]);
  const peerOnline = room?.type === "single" && room.peer ? online.has(room.peer.id) || room.peer.online : undefined;
  const isManager = room && (room.my_role === "owner" || room.my_role === "admin" || Number(me?.role) >= 100);
  const friendForPanel = friendPanelId ? friends.find((f) => f.id === friendPanelId) || { id: friendPanelId } : null;
  const mainView = panel === "requests" ? "requests" : friendForPanel ? "friend" : activeRoomId ? "chat" : "empty";
  const showMainOnMobile = mainView !== "empty";

  const subtitle =
    room?.type === "single"
      ? peerOnline
        ? "在线"
        : `@${room?.peer?.username || ""}`
      : room
        ? `${room.members?.length || room.member_count || 0} 位成员 · ${(room.members || []).filter((m) => m.online || online.has(m.id)).length} 人在线`
        : "";

  const menuItems = !room
    ? []
    : room.type === "single"
      ? [
          { key: "profile", icon: <HomeOutlined />, label: "个人主页", onClick: () => navigate(`/u/${room.peer?.id}`) },
          ...(room.peer?.is_friend ? [] : [{ key: "add", icon: <UserAddOutlined />, label: "加为好友", onClick: () => openAddFriend(room.peer) }]),
          { type: "divider" },
          { key: "leave", icon: <DeleteOutlined />, label: "删除会话", danger: true, onClick: leaveRoom },
        ]
      : [
          { key: "invite", icon: <UsergroupAddOutlined />, label: "邀请成员", onClick: () => { setPickIds([]); setInviteOpen(true); } },
          ...(isManager
            ? [
                { key: "rename", icon: <EditOutlined />, label: "修改群名", onClick: () => { setRenameText(room.name || room.title || ""); setRenameOpen(true); } },
                { key: "announce", icon: <SoundOutlined />, label: "编辑群公告", onClick: () => { setAnnounceText(room.announcement || ""); setAnnounceOpen(true); } },
              ]
            : []),
          { type: "divider" },
          { key: "leave", icon: <LogoutOutlined />, label: "退出群聊", danger: true, onClick: leaveRoom },
          ...(room.owner_id === me?.id || Number(me?.role) >= 100
            ? [{ key: "dissolve", icon: <DeleteOutlined />, label: "解散群聊", danger: true, onClick: dissolveRoom }]
            : []),
        ];

  const infoContent = !room ? null : room.type === "single" ? (
    <div className="oo-im-info">
      <PersonCard user={room.peer} me={me} online={peerOnline} compact onChat={() => setInfoDrawer(false)} onAddFriend={openAddFriend} onChanged={afterRelationChange} />
    </div>
  ) : (
    <GroupInfo
      room={room}
      me={me}
      online={online}
      onMemberClick={(m) => setCardUser(m)}
      onInvite={() => { setPickIds([]); setInviteOpen(true); }}
      onEditAnnouncement={() => { setAnnounceText(room.announcement || ""); setAnnounceOpen(true); }}
      onRename={() => { setRenameText(room.name || room.title || ""); setRenameOpen(true); }}
      onLeave={leaveRoom}
      onDissolve={dissolveRoom}
      onKick={kickMember}
    />
  );
  const infoInline = mainView === "chat" && room && wide && infoPref;

  let main;
  if (mainView === "requests") {
    main = (
      <RequestsView
        requests={requests}
        onBack={() => setPanel("")}
        onHandle={handleRequest}
        onWithdraw={withdrawRequest}
        onOpenUser={(u) => setCardUser(u)}
        onAddFriend={() => openAddFriend()}
      />
    );
  } else if (mainView === "friend") {
    main = (
      <div className="oo-im-page">
        <header className="oo-im-page-head oo-im-mobile-only">
          <Button type="text" onClick={() => setPanel("")}>← 返回</Button>
        </header>
        <div className="oo-im-page-center">
          <PersonCard user={friendForPanel} me={me} online={online.has(friendForPanel.id)} onChat={openChatWith} onAddFriend={openAddFriend} onChanged={afterRelationChange} />
        </div>
      </div>
    );
  } else if (mainView === "chat") {
    main = roomError ? (
      <div className="oo-im-stage-empty">
        <Empty description={roomError} />
        <Button onClick={() => navigate("/messages", { replace: true })}>返回会话列表</Button>
      </div>
    ) : (
      <div className="oo-im-chat">
        <ChatHeader
          room={room || { id: activeRoomId, title: rooms.find((r) => r.id === activeRoomId)?.title }}
          subtitle={subtitle}
          online={peerOnline}
          onBack={() => navigate("/messages")}
          infoOpen={wide ? infoPref : infoDrawer}
          onToggleInfo={toggleInfo}
          menuItems={menuItems}
        />
        {room?.type !== "single" && room?.announcement ? (
          <button type="button" className="oo-im-announce" onClick={() => (wide && !infoPref ? toggleInfo() : !wide ? setInfoDrawer(true) : null)}>
            <SoundOutlined />
            <span className="oo-truncate">{room.announcement}</span>
          </button>
        ) : null}
        <MessageList
          roomId={activeRoomId}
          roomType={room?.type}
          msgs={msgs}
          loading={msgsLoading}
          hasMore={hasMore}
          loadingMore={loadingMore}
          me={me}
          onLoadMore={loadMore}
          onUserClick={(u) => setCardUser(u)}
          onRecall={recall}
          onCopy={copy}
          onRetry={retry}
          onDiscard={(m) => setMsgs((prev) => prev.filter((x) => x.client_id !== m.client_id))}
          onDropFile={handleUploadPic}
        />
        {uploading ? <div className="oo-im-uploading">图片上传中…</div> : null}
        <Composer
          roomId={activeRoomId}
          value={input}
          onChange={setInput}
          onSend={() => doSend()}
          onFile={handleUploadPic}
          sending={inflight > 0}
          disabled={!room || msgsLoading}
          placeholder={room?.type === "single" ? `发消息给 ${room?.title || ""}` : `在「${room?.title || "群聊"}」里发言`}
        />
      </div>
    );
  } else {
    main = (
      <EmptyStage
        friends={friends}
        online={online}
        onAddFriend={() => openAddFriend()}
        onCreateGroup={openCreate}
        onChat={openChatWith}
        onCommunity={() => navigate("/community")}
      />
    );
  }

  return (
    <div className={`oo-im${infoInline ? " has-info" : ""}${showMainOnMobile ? " show-main" : ""}`}>
      <aside className="oo-im-side" aria-label="会话与联系人">
        <div className="oo-im-side-head">
          <div className="oo-im-side-title">
            <h1>消息</h1>
            {sseDown ? (
              <Tooltip title="实时连接已断开，正在自动重连；消息仍可发送">
                <span className="oo-im-offline"><DisconnectOutlined /> 重连中</span>
              </Tooltip>
            ) : null}
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [
                  { key: "friend", icon: <UserAddOutlined />, label: "添加好友", onClick: () => openAddFriend() },
                  { key: "group", icon: <UsergroupAddOutlined />, label: "创建群聊", onClick: openCreate },
                ],
              }}
            >
              <Button type="text" size="small" icon={<PlusOutlined />} aria-label="新建" />
            </Dropdown>
          </div>
          <Segmented
            block
            size="small"
            value={sideTab}
            onChange={(v) => { setSideTab(v); setKw(""); }}
            options={[
              { value: "rooms", label: <span>会话{unreadTotal ? <b className="oo-im-seg-badge">{unreadTotal > 99 ? "99+" : unreadTotal}</b> : null}</span> },
              { value: "contacts", label: <span>联系人{requests.pending_count ? <b className="oo-im-seg-badge">{requests.pending_count}</b> : null}</span> },
            ]}
          />
          <Input
            size="small"
            allowClear
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
            placeholder={sideTab === "rooms" ? "搜索会话" : "搜索好友（名字 / 备注 / 用户名）"}
            aria-label="搜索"
          />
          {sideTab === "rooms" ? (
            <div className="oo-im-chips" role="group" aria-label="会话筛选">
              {[
                ["all", "全部"],
                ["unread", `未读${unreadTotal ? ` ${unreadTotal}` : ""}`],
                ["group", "群聊"],
              ].map(([k, label]) => (
                <button key={k} type="button" className={`oo-im-chip${filter === k ? " is-active" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="oo-im-side-scroll">
          {sideTab === "rooms" ? (
            <RoomList
              rooms={rooms}
              loading={roomsLoading}
              activeId={activeRoomId}
              online={online}
              kw={kw}
              filter={filter}
              onOpen={openRoom}
              onCreateGroup={openCreate}
              onFindPeople={() => openAddFriend()}
            />
          ) : (
            <ContactList
              friends={friends}
              loading={friendsLoading}
              online={online}
              pending={requests.pending_count}
              kw={kw}
              activeFriendId={friendPanelId}
              requestsActive={panel === "requests"}
              onOpenRequests={() => setPanel("requests")}
              onOpenFriend={(f) => setPanel(`friend:${f.id}`)}
              onChat={openChatWith}
              onFindPeople={() => openAddFriend()}
            />
          )}
        </div>
      </aside>

      <main className="oo-im-main">{main}</main>

      {infoInline ? <aside className="oo-im-aside" aria-label="会话资料">{infoContent}</aside> : null}
      <Drawer
        open={!wide && infoDrawer && mainView === "chat" && Boolean(room)}
        onClose={() => setInfoDrawer(false)}
        placement="right"
        width={320}
        title={room?.type === "single" ? "对方资料" : "群资料"}
        styles={{ body: { padding: 0 } }}
      >
        {infoContent}
      </Drawer>

      {/* 成员 / 消息作者的名片 */}
      <Modal open={Boolean(cardUser)} footer={null} onCancel={() => setCardUser(null)} width={360} destroyOnClose centered>
        {cardUser ? (
          <PersonCard
            user={cardUser}
            me={me}
            online={online.has(cardUser.id) || cardUser.online}
            onChat={openChatWith}
            onAddFriend={openAddFriend}
            onChanged={afterRelationChange}
          />
        ) : null}
      </Modal>

      <Modal title="添加好友" open={addFriendOpen} onOk={submitAddFriend} confirmLoading={addFriendLoading} onCancel={() => setAddFriendOpen(false)} okText="发送申请" destroyOnClose>
        <Form form={addFriendForm} layout="vertical" requiredMark={false}>
          <Form.Item name="to_user_id" label="找人" rules={[{ required: true, message: "请选择要添加的用户" }]}>
            <Select
              showSearch
              placeholder="输入用户名或昵称搜索"
              filterOption={false}
              onSearch={handleSearchUsers}
              loading={searching}
              notFoundContent={searching ? "搜索中…" : "输入关键字开始搜索"}
              options={userOptions
                .filter((u) => u.id !== me?.id)
                .map((u) => {
                  const isFriend = friends.some((f) => f.id === u.id);
                  return {
                    value: u.id,
                    disabled: isFriend,
                    label: (
                      <span className="oo-im-pick-opt">
                        <UserAvatar user={u} size={18} />
                        <span className="oo-truncate">{u.display_name || u.username}</span>
                        <span className="oo-im-row-sub">@{u.username}{isFriend ? " · 已是好友" : ""}</span>
                      </span>
                    ),
                  };
                })}
            />
          </Form.Item>
          <Form.Item name="message" label="验证消息" initialValue={`你好，我是 ${me?.display_name || me?.username || ""}`}>
            {/* showCount 的计数器是绝对定位在右下角的，会和文本区的内容/滚动条压在一起。
                人格实测（插画师）量到「验证消息框 (478×71) 和右下角字数『20 / 200』
                视觉上压在一起（overlaps: true）」。
                修法：给文本区底部留出计数器的位置（paddingBottom），
                并把计数器本身往下挪一点，让两者不重叠。 */}
            <Input.TextArea
              maxLength={200}
              showCount={{ formatter: ({ count, maxLength }) => `${count} / ${maxLength}` }}
              rows={3}
              style={{ paddingBottom: 22 }}
              className="oo-count-textarea"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="创建群聊" open={createOpen} onOk={submitCreate} confirmLoading={busy} onCancel={() => setCreateOpen(false)} okText="创建" destroyOnClose>
        <div className="oo-im-form">
          <label htmlFor="im-group-name">群聊名称</label>
          <Input id="im-group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={30} showCount placeholder="例如：Prompt 研究小组" autoFocus />
          <label>邀请成员</label>
          <MemberPicker value={pickIds} onChange={setPickIds} friends={friends} />
          <p className="oo-im-form-hint">公开讨论更适合发到社区；群聊适合小范围、持续的交流。</p>
        </div>
      </Modal>

      <Modal title="邀请成员" open={inviteOpen} onOk={submitInvite} confirmLoading={busy} onCancel={() => setInviteOpen(false)} okText="邀请" destroyOnClose>
        <MemberPicker value={pickIds} onChange={setPickIds} friends={friends} exclude={(room?.members || []).map((m) => m.id)} />
      </Modal>

      <Modal title="群公告" open={announceOpen} onOk={saveAnnouncement} confirmLoading={busy} onCancel={() => setAnnounceOpen(false)} okText="发布" destroyOnClose>
        <Input.TextArea
          value={announceText}
          onChange={(e) => setAnnounceText(e.target.value)}
          placeholder="所有成员进群都能看到；留空则清除公告"
          autoSize={{ minRows: 4, maxRows: 10 }}
          maxLength={500}
          showCount
          className="oo-count-textarea"
        />
      </Modal>

      <Modal title="修改群名" open={renameOpen} onOk={saveRename} confirmLoading={busy} onCancel={() => setRenameOpen(false)} okText="保存" destroyOnClose>
        <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} maxLength={30} showCount autoFocus onPressEnter={saveRename} />
      </Modal>
    </div>
  );
}
