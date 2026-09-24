// QQ 频道沉浸式消息社区工作台
// ---------------------------------------------------------------------------
// 模式与功能对齐：
// ① QQ 频道 (QQ Channel) 体系：频道服务器 (Guild) + 文字/公告子频道组织，支持公告气泡、话题说明与公共文字流；
// ② QQ 私聊 (C2C) 与 群聊 (Group Chat)：单聊/群聊会话、置顶、未读红点、实时在线指示灯、群公告、群成员分层展示；
// ③ 完备好友系统：好友申请与留言验证、在线/离线好友分组、好友备注名修改、双向关系解除、一键发起私聊；
// ④ 纯正 Channel Layout：左侧 Hub Rail + 中间 Sub-Sidebar + 右侧主舞台与成员抽屉。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button, Input, Space, Avatar, Empty, Skeleton, App as AntApp, Modal, Form, Select, Tag, Dropdown, Tooltip, Badge, Popover, Card, Divider,
} from "antd";
import {
  PlusOutlined, SendOutlined, ArrowLeftOutlined, PictureOutlined, UsergroupAddOutlined,
  MoreOutlined, SearchOutlined, MessageOutlined, TeamOutlined, CommentOutlined, DeleteOutlined,
  UserAddOutlined, GlobalOutlined, SmileOutlined, CodeOutlined, SoundOutlined, PushpinOutlined,
  CrownOutlined, SafetyOutlined, CheckOutlined, CloseOutlined, EditOutlined, ReloadOutlined,
  CheckCircleFilled,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import UserAvatar from "../components/UserAvatar";
import Markdown from "../components/Markdown";

const EMOJI_LIST = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😍", "🥰", "😘", "😎", "🥳", "🤔", "🤫", "🤗", "🤖", "🚀", "💡", "🔥", "👍", "👏", "🎉", "❤️", "⭐", "✨", "💯"];

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

export default function MessagesPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { message: toast, modal } = AntApp.useApp();
  const { user: me } = useApp();
  const { begin, isLatest } = useLatest();

  // 1. 导轨当前选中的 Hub 标签页：'messages' | 'contacts' | 'guild'
  const [hubTab, setHubTab] = useState("messages");

  // 2. 会话列表数据
  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [room, setRoom] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // 3. 好友系统状态
  const [friends, setFriends] = useState([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [], pending_count: 0 });
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [addFriendLoading, setAddFriendLoading] = useState(false);
  const [addFriendForm] = Form.useForm();
  const [contactsView, setContactsView] = useState("friends"); // 'friends' | 'requests'

  // 4. QQ 频道体系状态
  const [guilds, setGuilds] = useState([]);
  const [guildsLoading, setGuildsLoading] = useState(false);
  const [activeChannelId, setActiveChannelId] = useState(0);

  // 5. 群组与公告操作
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [userOptions, setUserOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [createForm] = Form.useForm();
  const [editAnnounceOpen, setEditAnnounceOpen] = useState(false);
  const [announceText, setAnnounceText] = useState("");
  const [showMembers, setShowMembers] = useState(true);

  // 6. 搜索与在线状态
  const [kw, setKw] = useState("");
  const [online, setOnline] = useState([]);
  const [profileModalUser, setProfileModalUser] = useState(null);

  const activeRoomId = Number(roomId) || 0;
  const activeRoomRef = useRef(activeRoomId);
  activeRoomRef.current = activeRoomId;
  const scrollRef = useRef(null);
  const esRef = useRef(null);
  const fileRef = useRef(null);
  const pendingRef = useRef(new Map());

  /* ==================== ① 会话列表加载 ==================== */
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

  /* ==================== ② 好友系统加载 ==================== */
  const loadFriends = useCallback(async () => {
    setFriendsLoading(true);
    try {
      const [fList, reqList] = await Promise.all([
        API.get("/friends").catch(() => []),
        API.get("/friends/requests").catch(() => ({ incoming: [], outgoing: [], pending_count: 0 })),
      ]);
      setFriends(Array.isArray(fList) ? fList : []);
      setRequests(reqList || { incoming: [], outgoing: [], pending_count: 0 });
    } catch (e) {
      // 忽略
    } finally {
      setFriendsLoading(false);
    }
  }, []);

  /* ==================== ③ QQ 频道体系加载 ==================== */
  const loadGuilds = useCallback(async () => {
    setGuildsLoading(true);
    try {
      const d = await API.get("/chatroom/guilds");
      setGuilds(Array.isArray(d) ? d : []);
    } catch (e) {
      // 忽略
    } finally {
      setGuildsLoading(false);
    }
  }, []);

  /* ==================== ④ SSE 实时推送 ==================== */
  const connectSSE = useCallback(async () => {
    try {
      const { ticket } = await API.post("/chatroom/stream-ticket", {});
      const es = new EventSource(`/api/chatroom/stream?ticket=${encodeURIComponent(ticket)}`);
      esRef.current = es;

      es.addEventListener("message", (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          const rid = Number(payload.room_id);
          const m = payload.message;
          if (m?.client_id && pendingRef.current.has(m.client_id)) {
            pendingRef.current.delete(m.client_id);
          }
          if (rid === activeRoomRef.current) {
            setMsgs((prev) => {
              const without = prev.filter((x) => (m.client_id ? x.client_id !== m.client_id : x.id !== m.id));
              return [...without, m];
            });
            API.post(`/chatroom/rooms/${rid}/read`, {}).catch(() => {});
          }
          loadRooms();
        } catch {
          // 忽略
        }
      });

      es.addEventListener("presence", (ev) => {
        try {
          const { user_id, online: isOnlineNow } = JSON.parse(ev.data);
          setOnline((prev) => {
            const s = new Set(prev);
            if (isOnlineNow) s.add(user_id);
            else s.delete(user_id);
            return [...s];
          });
          loadFriends();
        } catch {
          // 忽略
        }
      });

      es.addEventListener("friend_request", () => {
        toast.info("收到一条新的好友申请");
        loadFriends();
      });

      es.addEventListener("friend_accepted", () => {
        toast.success("好友申请已通过，双方已成为好友");
        loadFriends();
        loadRooms();
      });

      es.addEventListener("room_updated", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.room_id === activeRoomRef.current) {
            setRoom((prev) => (prev ? { ...prev, ...data } : prev));
          }
          loadRooms();
        } catch {
          // 忽略
        }
      });

      es.onerror = () => {
        es.close();
      };
    } catch {
      // 忽略
    }
  }, [loadRooms, loadFriends, toast]);

  useEffect(() => {
    loadRooms();
    loadFriends();
    loadGuilds();
    connectSSE();
    API.get("/chatroom/online").then((ids) => setOnline(Array.isArray(ids) ? ids : [])).catch(() => {});
    return () => esRef.current?.close();
  }, [loadRooms, loadFriends, loadGuilds, connectSSE]);

  /* ==================== ⑤ 切换会话与消息加载 ==================== */
  useEffect(() => {
    if (!activeRoomId) {
      setRoom(null);
      setMsgs([]);
      return;
    }
    setMsgsLoading(true);
    Promise.all([
      API.get(`/chatroom/rooms/${activeRoomId}`),
      API.get(`/chatroom/rooms/${activeRoomId}/messages`, { params: { p: 1, page_size: 80 } }),
    ])
      .then(([r, mData]) => {
        setRoom(r);
        setMsgs(mData?.items || []);
        API.post(`/chatroom/rooms/${activeRoomId}/read`, {}).catch(() => {});
      })
      .catch((e) => {
        toast.error(e.message || "加载会话失败");
      })
      .finally(() => setMsgsLoading(false));
  }, [activeRoomId, toast]);

  // 智能默认选中：若进入页面无指定 roomId，自动导航到首个活跃会话或官方频道，消除空屏
  useEffect(() => {
    if (!activeRoomId) {
      if (hubTab === "guild") {
        const firstCh = guilds[0]?.channels?.[0];
        if (firstCh) navigate(`/messages/${firstCh.room_id}`, { replace: true });
      } else if (hubTab === "messages" && rooms.length > 0) {
        const nonGuildRooms = rooms.filter((r) => !r.guild_channel_id);
        if (nonGuildRooms.length > 0) {
          navigate(`/messages/${nonGuildRooms[0].id}`, { replace: true });
        } else if (guilds[0]?.channels?.[0]) {
          navigate(`/messages/${guilds[0].channels[0].room_id}`, { replace: true });
        }
      }
    }
  }, [activeRoomId, hubTab, rooms, guilds, navigate]);

  // 消息自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs]);

  /* ==================== ⑥ 发送消息 ==================== */
  const doSend = async (type = "text", content = input, mediaIds = []) => {
    if (!activeRoomId || (!content.trim() && !mediaIds.length)) return;
    setSending(true);
    const clientId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const optMsg = {
      id: -Date.now(),
      room_id: activeRoomId,
      user_id: me?.id,
      author: { id: me?.id, username: me?.username, display_name: me?.display_name, avatar_url: me?.avatar_url },
      type,
      content: content.trim(),
      media: [],
      client_id: clientId,
      created_time: Math.floor(Date.now() / 1000),
      status: 1,
      pending: true,
    };
    pendingRef.current.set(clientId, optMsg);
    setMsgs((prev) => [...prev, optMsg]);
    setInput("");

    try {
      await API.post(`/chatroom/rooms/${activeRoomId}/messages`, {
        type,
        content: content.trim(),
        media_ids: mediaIds,
        client_id: clientId,
      });
    } catch (e) {
      toast.error(e.message || "发送失败");
      setMsgs((prev) => prev.filter((x) => x.client_id !== clientId));
      pendingRef.current.delete(clientId);
    } finally {
      setSending(false);
    }
  };

  /* ==================== ⑦ 快捷上传图片 ==================== */
  const handleUploadPic = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读取文件失败"));
        fr.readAsDataURL(file);
      });
      // **不要塞 "[图片]" 这个占位文字**。
      //
      // 原实现发的是 `doSend("image", "[图片]", [r.id])` —— content 和 media 都带上，
      // 于是气泡里既渲染图片、又把这四个字原样显示在图片上方，看着像模板没渲染完。
      // 人格实测原话：「图确实在气泡里，但图的上面多了一行字『[图片]』……
      // 对我这种发图为主的人，等于每张图配一个多余的标签。」
      //
      // doSend 允许「只有图、没有字」（它判的是 `!content.trim() && !mediaIds.length`），
      // 所以传空字符串即可，气泡只显示图片。
      const r = await API.post("/media", { dataUrl, name: file.name, source: "chat" });
      // **不要把用户正在打的字一起发出去、更不能因此清空输入框**。
      //
      // 人格实测原话（阿蓝，3 次复现）：
      //   「先打好一句话，再点图片图标选一张图 → 输入框变空字符串。
      //     等于每次都得『先贴图再写字』。」
      // 根因：doSend 末尾无条件 setInput("")，而这里把刚打的字当成
      // content 一起发走了 —— 所以既丢字、又把文字混进了图片消息。
      //
      // 正确行为：发图**独立成一条消息**（content 传空），
      // 且发送后把输入框恢复成用户原来打的内容。
      const draft = input;
      await doSend("image", "", [r.id]);
      setInput(draft);
    } catch (err) {
      toast.error(err.message || "图片上传失败");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /* ==================== ⑧ 好友申请操作 ==================== */
  const submitAddFriend = async (values) => {
    setAddFriendLoading(true);
    try {
      await API.post("/friends/requests", {
        to_user_id: values.to_user_id,
        message: values.message,
      });
      toast.success("好友申请已发送，等待对方验证");
      setAddFriendOpen(false);
      addFriendForm.resetFields();
      loadFriends();
    } catch (e) {
      toast.error(e.message || "发送申请失败");
    } finally {
      setAddFriendLoading(false);
    }
  };

  const handleFriendRequest = async (requestId, action) => {
    try {
      await API.put(`/friends/requests/${requestId}`, { action });
      toast.success(action === "accept" ? "已同意好友申请" : "已拒绝好友申请");
      loadFriends();
      loadRooms();
    } catch (e) {
      toast.error(e.message || "操作失败");
    }
  };

  const directChatFriend = async (friendId) => {
    try {
      const r = await API.post(`/friends/${friendId}/chat`, {});
      navigate(`/messages/${r.room_id}`);
      setHubTab("messages");
    } catch (e) {
      toast.error(e.message || "发起私聊失败");
    }
  };

  const editFriendRemark = (f) => {
    modal.confirm({
      title: `修改好友「${f.display_name || f.username}」的备注名`,
      content: (
        <Input
          id="remark-input"
          defaultValue={f.remark || ""}
          placeholder="请输入自定义备注名"
          maxLength={30}
          style={{ marginTop: 12 }}
        />
      ),
      onOk: async () => {
        const val = document.getElementById("remark-input")?.value?.trim() || "";
        await API.put(`/friends/${f.id}/remark`, { remark: val });
        toast.success("备注名已更新");
        loadFriends();
        loadRooms();
      },
    });
  };

  const removeFriend = (f) => {
    modal.confirm({
      title: "解除好友关系",
      content: `确定要删除好友「${f.remark || f.display_name || f.username}」吗？解除后双方无法在好友列表直接查看。`,
      okType: "danger",
      okText: "删除",
      onOk: async () => {
        await API.del(`/friends/${f.id}`);
        toast.success("已解除好友关系");
        loadFriends();
      },
    });
  };

  /* ==================== ⑨ 修改群公告与群名 ==================== */
  const saveAnnouncement = async () => {
    if (!activeRoomId) return;
    try {
      await API.put(`/chatroom/rooms/${activeRoomId}/announcement`, { announcement: announceText });
      toast.success("群公告已更新");
      setRoom((prev) => (prev ? { ...prev, announcement: announceText } : prev));
      setEditAnnounceOpen(false);
    } catch (e) {
      toast.error(e.message || "更新公告失败");
    }
  };

  const editRoomName = () => {
    modal.confirm({
      title: "修改群聊名称",
      content: <Input id="rname-input" defaultValue={room?.name || ""} maxLength={30} style={{ marginTop: 12 }} />,
      onOk: async () => {
        const val = document.getElementById("rname-input")?.value?.trim() || "";
        if (!val) return;
        await API.put(`/chatroom/rooms/${activeRoomId}/name`, { name: val });
        toast.success("群名称已修改");
        setRoom((prev) => (prev ? { ...prev, name: val } : prev));
        loadRooms();
      },
    });
  };

  /* ==================== ⑩ 创建新会话（群聊/私聊） ==================== */
  const submitCreateRoom = async (values) => {
    setCreating(true);
    try {
      const payload = {
        type: values.type,
        name: values.name,
        user_id: values.user_id,
        user_ids: values.user_ids,
      };
      const r = await API.post("/chatroom/rooms", payload);
      toast.success("已创建");
      setCreateOpen(false);
      createForm.resetFields();
      loadRooms();
      navigate(`/messages/${r.id}`);
      setHubTab("messages");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setCreating(false);
    }
  };

  // 搜索用户备选列表
  const handleSearchUsers = async (kwStr) => {
    if (!kwStr.trim()) return;
    setSearching(true);
    try {
      const d = await API.get("/chatroom/users", { params: { q: kwStr.trim() } });
      setUserOptions(Array.isArray(d) ? d : []);
    } catch {
      setUserOptions([]);
    } finally {
      setSearching(false);
    }
  };

  // 在线好友列表计算
  const onlineFriends = useMemo(() => friends.filter((f) => online.includes(f.id)), [friends, online]);
  const offlineFriends = useMemo(() => friends.filter((f) => !online.includes(f.id)), [friends, online]);

  return (
    <div className="qq-workspace-wrap">
      <div className="qq-channel-shell">
        {/* =========================================================
            第 1 栏：左侧功能极窄导轨 (Hub Rail)
            ========================================================= */}
        <div className="qq-hub-rail">
          {/* 用户自己头像与在线小绿点 */}
          <Popover content={<div style={{ fontSize: 12 }}>当前在线 · <strong>{me?.display_name || me?.username}</strong></div>} placement="right">
            <div className="qq-online-badge" style={{ cursor: "pointer", marginBottom: 2 }} onClick={() => navigate(`/u/${me?.id}`)}>
              <UserAvatar user={me} size={42} />
              <span className="qq-online-dot" />
            </div>
          </Popover>

          <div className="qq-rail-divider" />

          {/* 1. 消息会话入口图标 */}
          <div className={`qq-rail-item-box ${hubTab === "messages" ? "is-active" : ""}`}>
            <span className="qq-rail-pill" />
            <Tooltip title="即时消息 (私聊与群聊)" placement="right">
              <Badge count={rooms.filter((r) => !r.guild_channel_id).reduce((acc, r) => acc + (r.unread || 0), 0)} size="small" offset={[-4, 4]}>
                <div
                  className="qq-rail-btn"
                  role="button"
                  tabIndex={0}
                  aria-label="即时消息（私聊与群聊）"
                  onClick={() => { setHubTab("messages"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setHubTab("messages"); } }}
                >
                  <MessageOutlined />
                </div>
              </Badge>
            </Tooltip>
          </div>

          {/* 2. QQ 频道服务器入口图标 */}
          <div className={`qq-rail-item-box ${hubTab === "guild" ? "is-active" : ""}`}>
            <span className="qq-rail-pill" />
            <Tooltip title="QQ 频道 · 官方开发者社区" placement="right">
              <div
                className="qq-rail-btn"
                role="button"
                tabIndex={0}
                aria-label="QQ 频道 · 官方开发者社区"
                onClick={() => {
                  setHubTab("guild");
                  if (guilds[0]?.channels?.[0]) {
                    const ch = guilds[0].channels[0];
                    setActiveChannelId(ch.id);
                    navigate(`/messages/${ch.room_id}`);
                  }
                }}
              >
                <GlobalOutlined />
              </div>
            </Tooltip>
          </div>

          {/* 3. 通讯录/好友入口图标 */}
          <div className={`qq-rail-item-box ${hubTab === "contacts" ? "is-active" : ""}`}>
            <span className="qq-rail-pill" />
            <Tooltip title="通讯录与好友关系" placement="right">
              <Badge count={requests.pending_count} size="small" offset={[-4, 4]}>
                <div
                  className="qq-rail-btn"
                  role="button"
                  tabIndex={0}
                  aria-label="通讯录与好友关系"
                  onClick={() => { setHubTab("contacts"); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setHubTab("contacts"); } }}
                >
                  <TeamOutlined />
                </div>
              </Badge>
            </Tooltip>
          </div>

          <div style={{ flex: 1 }} />

          {/* 底部快捷操作 */}
          <Tooltip title="添加好友" placement="right">
            <div className="qq-rail-btn" role="button" tabIndex={0} aria-label="添加好友" onClick={() => setAddFriendOpen(true)} style={{ width: 42, height: 42, fontSize: 17 }}>
              <UserAddOutlined />
            </div>
          </Tooltip>

          <Tooltip title="发起聊天 / 创建群聊" placement="right">
            <div className="qq-rail-btn" role="button" tabIndex={0} aria-label="发起聊天 / 创建群聊" onClick={() => { createForm.resetFields(); setCreateOpen(true); }} style={{ width: 42, height: 42, fontSize: 17 }}>
              <PlusOutlined />
            </div>
          </Tooltip>
        </div>

        {/* =========================================================
            第 2 栏：中间二级列表侧边栏 (Sub Sidebar)
            ========================================================= */}
        <div className={`qq-sub-side${activeRoomId ? " is-hidden-mobile" : ""}`}>
          {/* A. 处于「消息 (Messages)」模式 */}
          {hubTab === "messages" && (
            <>
              <div className="qq-sub-head">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>近期会话</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<UsergroupAddOutlined />}
                    title="创建群聊"
                    onClick={() => { createForm.resetFields(); createForm.setFieldsValue({ type: "group" }); setCreateOpen(true); }}
                  />
                </div>
                <Input
                  prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
                  placeholder="搜索聊天会话…"
                  allowClear
                  size="small"
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                />
              </div>

              <div className="qq-sub-scroll">
                {roomsLoading && !rooms.length ? (
                  <div style={{ padding: 14 }}><Skeleton active paragraph={{ rows: 4 }} /></div>
                ) : !rooms.filter((r) => !r.guild_channel_id).length ? (
                  <div style={{ padding: "36px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: 500, marginBottom: 4 }}>暂无私聊或独立群聊</div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>可添加好友发起私聊，或前往 QQ 频道交流</div>
                    <Space direction="vertical" size={8} style={{ width: "100%" }}>
                      <Button size="small" type="primary" block icon={<UserAddOutlined />} onClick={() => setAddFriendOpen(true)}>添加好友</Button>
                      <Button size="small" block icon={<GlobalOutlined />} onClick={() => {
                        setHubTab("guild");
                        if (guilds[0]?.channels?.[0]) navigate(`/messages/${guilds[0].channels[0].room_id}`);
                      }}>前往 QQ 频道</Button>
                    </Space>
                  </div>
                ) : (
                  rooms
                    .filter((r) => !r.guild_channel_id)
                    .filter((r) => {
                      if (!kw.trim()) return true;
                      const q = kw.trim().toLowerCase();
                      return String(r.title || r.name || "").toLowerCase().includes(q);
                    })
                    .map((r) => {
                      const isPeerOnline = r.type === "single" && r.peer && online.includes(r.peer.id);
                      return (
                        <div
                          key={r.id}
                          className={`qq-list-item${r.id === activeRoomId ? " is-active" : ""}`}
                          onClick={() => navigate(`/messages/${r.id}`)}
                        >
                          {r.type === "single" && r.peer ? (
                            <div className="qq-online-badge">
                              <UserAvatar user={r.peer} size={38} />
                              <span className={`qq-online-dot${isPeerOnline ? "" : " is-offline"}`} />
                            </div>
                          ) : (
                            <Avatar size={38} style={{ background: "linear-gradient(135deg, #1890ff 0%, #36cfc9 100%)", color: "#fff", flexShrink: 0 }} icon={<TeamOutlined />} />
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                              <span style={{ fontSize: 13.5, fontWeight: 550, color: "var(--ink)" }} className="oo-truncate">
                                {r.title || r.name}
                              </span>
                              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtRoomTime(r.last_message_time)}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                              <span style={{ fontSize: 12, color: "var(--ink-3)" }} className="oo-truncate">
                                {r.last_message_text || "暂无最新消息"}
                              </span>
                              {Boolean(r.unread) && (
                                <Badge count={r.unread} size="small" />
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </>
          )}

          {/* B. 处于「通讯录与好友 (Contacts)」模式 */}
          {hubTab === "contacts" && (
            <>
              <div className="qq-sub-head">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>通讯录</span>
                  <Button
                    type="primary"
                    size="small"
                    icon={<UserAddOutlined />}
                    onClick={() => setAddFriendOpen(true)}
                  >
                    加好友
                  </Button>
                </div>
                <Input
                  prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
                  placeholder="搜索好友或群组…"
                  allowClear
                  size="small"
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                />
              </div>

              <div className="qq-sub-scroll">
                {/* 1. 新的朋友卡片 */}
                <div
                  className={`qq-list-item${contactsView === "requests" ? " is-active" : ""}`}
                  style={{ borderBottom: "1px solid var(--line)", padding: "10px 14px" }}
                  onClick={() => { setContactsView("requests"); navigate("/messages"); }}
                >
                  <Avatar size={36} style={{ background: "var(--accent)", color: "#fff" }} icon={<UserAddOutlined />} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>新的朋友</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {requests.pending_count ? `${requests.pending_count} 条好友验证待处理` : "查看好友申请历史"}
                    </div>
                  </div>
                  {Boolean(requests.pending_count) && <Badge count={requests.pending_count} size="small" />}
                </div>

                {/* 2. 在线好友分组 */}
                <div style={{ padding: "8px 14px 4px", fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)" }}>
                  在线好友 ({onlineFriends.length}/{friends.length})
                </div>
                {onlineFriends
                  .filter((f) => !kw.trim() || (f.title || f.username).toLowerCase().includes(kw.trim().toLowerCase()))
                  .map((f) => (
                    <div
                      key={f.id}
                      className="qq-list-item"
                      onClick={() => { setContactsView("friends"); directChatFriend(f.id); }}
                    >
                      <div className="qq-online-badge">
                        <UserAvatar user={f} size={32} />
                        <span className="qq-online-dot" />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }} className="oo-truncate">
                          {f.remark ? `${f.remark} (${f.display_name || f.username})` : f.display_name || f.username}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }} className="oo-truncate">{f.bio || "这个人很懒，什么都没写"}</div>
                      </div>
                      <Dropdown
                        menu={{
                          items: [
                            { key: "chat", icon: <MessageOutlined />, label: "发起私聊", onClick: () => directChatFriend(f.id) },
                            { key: "remark", icon: <EditOutlined />, label: "修改备注", onClick: () => editFriendRemark(f) },
                            { key: "profile", icon: <TeamOutlined />, label: "查看主页", onClick: () => navigate(`/u/${f.id}`) },
                            { type: "divider" },
                            { key: "del", icon: <DeleteOutlined />, label: "删除好友", danger: true, onClick: () => removeFriend(f) },
                          ],
                        }}
                        trigger={["click"]}
                      >
                        <Button type="text" size="small" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
                      </Dropdown>
                    </div>
                  ))}

                {/* 3. 离线好友分组 */}
                <div style={{ padding: "12px 14px 4px", fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)" }}>
                  离线好友 ({offlineFriends.length})
                </div>
                {offlineFriends
                  .filter((f) => !kw.trim() || (f.title || f.username).toLowerCase().includes(kw.trim().toLowerCase()))
                  .map((f) => (
                    <div
                      key={f.id}
                      className="qq-list-item"
                      style={{ opacity: 0.8 }}
                      onClick={() => { setContactsView("friends"); directChatFriend(f.id); }}
                    >
                      <div className="qq-online-badge">
                        <UserAvatar user={f} size={32} />
                        <span className="qq-online-dot is-offline" />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }} className="oo-truncate">
                          {f.remark ? `${f.remark} (${f.display_name || f.username})` : f.display_name || f.username}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }} className="oo-truncate">{f.bio || "离线"}</div>
                      </div>
                      <Dropdown
                        menu={{
                          items: [
                            { key: "chat", icon: <MessageOutlined />, label: "发送离线消息", onClick: () => directChatFriend(f.id) },
                            { key: "remark", icon: <EditOutlined />, label: "修改备注", onClick: () => editFriendRemark(f) },
                            { key: "profile", icon: <TeamOutlined />, label: "查看主页", onClick: () => navigate(`/u/${f.id}`) },
                            { type: "divider" },
                            { key: "del", icon: <DeleteOutlined />, label: "删除好友", danger: true, onClick: () => removeFriend(f) },
                          ],
                        }}
                        trigger={["click"]}
                      >
                        <Button type="text" size="small" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
                      </Dropdown>
                    </div>
                  ))}
              </div>
            </>
          )}

          {/* C. 处于「QQ 频道 (Channel Guild)」模式 */}
          {hubTab === "guild" && (
            <>
              <div className="qq-guild-banner">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar size={42} style={{ background: "linear-gradient(135deg, var(--accent) 0%, #722ed1 100%)", fontWeight: 700, fontSize: 16 }}>
                    OO
                  </Avatar>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }} className="oo-truncate">
                      <span>{guilds[0]?.name || "OOAPI 开发者社区"}</span>
                      <CheckCircleFilled style={{ color: "var(--accent)", fontSize: 13 }} />
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }} className="oo-truncate">
                      {guilds[0]?.description || "官方开发者交流阵地 · 实时互动"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="qq-sub-scroll">
                {/* 频道分组 1：官方公告 */}
                <div className="qq-channel-group-title">📢 官方发布</div>
                {guilds[0]?.channels?.filter((c) => c.type === "notice").map((c) => {
                  const isActive = activeRoomId === c.room_id;
                  return (
                    <div
                      key={c.id}
                      className={`qq-channel-item${isActive ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveChannelId(c.id);
                        navigate(`/messages/${c.room_id}`);
                      }}
                    >
                      <SoundOutlined style={{ color: "var(--accent)" }} />
                      <span style={{ flex: 1 }} className="oo-truncate">{c.name}</span>
                      <Tag color="blue" style={{ margin: 0, fontSize: 10, borderRadius: 4 }}>公告</Tag>
                    </div>
                  );
                })}

                {/* 频道分组 2：讨论交流 */}
                <div className="qq-channel-group-title" style={{ marginTop: 10 }}>💬 互动交流</div>
                {guilds[0]?.channels?.filter((c) => c.type !== "notice").map((c) => {
                  const isActive = activeRoomId === c.room_id;
                  return (
                    <div
                      key={c.id}
                      className={`qq-channel-item${isActive ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveChannelId(c.id);
                        navigate(`/messages/${c.room_id}`);
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: 14, opacity: 0.7 }}>#</span>
                      <span style={{ flex: 1 }} className="oo-truncate">{c.name}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* =========================================================
            第 3 栏：右侧主舞台 (Main Stage)
            ========================================================= */}
        <div className={`qq-main-stage${!activeRoomId && contactsView !== "requests" ? " is-hidden-mobile" : ""}`}>
          {/* 场景 1：如果处于通讯录的「新的朋友」申请管理面板 */}
          {hubTab === "contacts" && contactsView === "requests" ? (
            <div style={{ flex: 1, padding: "24px 32px", overflowY: "auto" }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Button
                      type="text"
                      icon={<ArrowLeftOutlined />}
                      className="is-mobile-only"
                      onClick={() => setContactsView("friends")}
                    />
                    <div>
                      <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>新的朋友申请</h2>
                      <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>验证并处理来自社区伙伴的好友请求</div>
                    </div>
                  </div>
                  <Button icon={<UserAddOutlined />} type="primary" onClick={() => setAddFriendOpen(true)}>
                    主动添加好友
                  </Button>
                </div>

                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--ink)" }}>收到的好友验证</div>
                {!requests.incoming.length ? (
                  <Card style={{ textAlign: "center", padding: "30px 0", borderRadius: 12, marginBottom: 24 }}>
                    <Empty description="暂无待处理的好友申请" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  </Card>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
                    {requests.incoming.map((req) => (
                      <Card key={req.id} size="small" style={{ borderRadius: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <UserAvatar user={{ username: req.username, display_name: req.display_name, avatar_url: req.avatar_url }} size={42} />
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 14 }}>{req.display_name || req.username}</div>
                              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
                                留言说明：<span style={{ color: "var(--ink)" }}>{req.message || "对方未填写留言"}</span>
                              </div>
                              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{fmtTime(req.created_time)}</div>
                            </div>
                          </div>
                          <Space>
                            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => handleFriendRequest(req.id, "accept")}>
                              同意
                            </Button>
                            <Button size="small" danger icon={<CloseOutlined />} onClick={() => handleFriendRequest(req.id, "reject")}>
                              拒绝
                            </Button>
                          </Space>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}

                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--ink)" }}>我发出的好友申请</div>
                {!requests.outgoing.length ? (
                  <Card style={{ textAlign: "center", padding: "20px 0", borderRadius: 12 }}>
                    <Empty description="没有发出的申请记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  </Card>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {requests.outgoing.map((req) => (
                      <Card key={req.id} size="small" style={{ borderRadius: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <UserAvatar user={{ username: req.username, display_name: req.display_name, avatar_url: req.avatar_url }} size={34} />
                            <div>
                              <span style={{ fontWeight: 500 }}>{req.display_name || req.username}</span>
                              <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 8 }}>留言: {req.message || "无"}</span>
                            </div>
                          </div>
                          <div>
                            {req.status === 0 ? <Tag color="orange">等待验证</Tag> : req.status === 1 ? <Tag color="green">已同意</Tag> : <Tag color="default">已拒绝</Tag>}
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : !activeRoomId ? (
            /* 场景 2：未选中任何聊天会话时的精美占位看板 */
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 }}>
              <div style={{
                width: 72, height: 72, borderRadius: "50%",
                background: "linear-gradient(135deg, var(--accent-tint) 0%, rgba(var(--accent-rgb, 22, 119, 255), 0.15) 100%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--accent)", fontSize: 34, marginBottom: 16,
                boxShadow: "0 4px 16px rgba(var(--accent-rgb, 22, 119, 255), 0.12)"
              }}>
                <MessageOutlined />
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>开启社区无界交流</h3>
              <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 8, maxWidth: 380, textAlign: "center", lineHeight: 1.6 }}>
                选择左侧好友私聊、交流群，或切换到 QQ 频道探索官方技术交流天地
              </p>
              <Space style={{ marginTop: 18 }}>
                <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAddFriendOpen(true)}>添加好友</Button>
                <Button icon={<GlobalOutlined />} onClick={() => {
                  setHubTab("guild");
                  if (guilds[0]?.channels?.[0]) navigate(`/messages/${guilds[0].channels[0].room_id}`);
                }}>进入 QQ 频道</Button>
                <Button icon={<UsergroupAddOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>创建群聊</Button>
              </Space>
            </div>
          ) : (
            /* 场景 3：正常的聊天/频道工作台 */
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                {/* A. 顶部 Header */}
                <div className="qq-chat-header">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <Button
                      type="text"
                      icon={<ArrowLeftOutlined />}
                      className="is-mobile-only"
                      onClick={() => navigate("/messages")}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {room?.guild_channel_id ? (
                          <span style={{ fontWeight: 700, fontSize: 17, color: "var(--accent)" }}>#</span>
                        ) : room?.type === "group" ? (
                          <TeamOutlined style={{ color: "var(--accent)", fontSize: 16 }} />
                        ) : null}
                        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }} className="oo-truncate">
                          {room?.title || room?.name}
                        </span>
                        {room?.guild_channel_id ? (
                          <Tag color="blue" style={{ margin: 0, fontSize: 11, borderRadius: 4 }}>官方频道</Tag>
                        ) : room?.type === "group" ? (
                          <Tag style={{ margin: 0 }}>{room?.member_count || room?.members?.length || 0} 人</Tag>
                        ) : (
                          <Tag color={online.includes(room?.peer?.id) ? "success" : "default"} style={{ margin: 0, fontSize: 11 }}>
                            {online.includes(room?.peer?.id) ? "在线" : "离线"}
                          </Tag>
                        )}
                      </div>
                    </div>
                  </div>

                  <Space>
                    {(room?.my_role === "owner" || room?.my_role === "admin" || me?.role >= 100) && (
                      <Tooltip title="编辑群/频道公告">
                        <Button
                          size="small"
                          icon={<SoundOutlined />}
                          onClick={() => { setAnnounceText(room?.announcement || ""); setEditAnnounceOpen(true); }}
                        />
                      </Tooltip>
                    )}
                    {room?.type === "group" && (
                      <Tooltip title={showMembers ? "隐藏群成员" : "展开群成员"}>
                        <Button
                          size="small"
                          type={showMembers ? "primary" : "default"}
                          icon={<TeamOutlined />}
                          onClick={() => setShowMembers((prev) => !prev)}
                        />
                      </Tooltip>
                    )}
                    {room?.type === "group" && (room?.my_role === "owner" || me?.role >= 100) && (
                      <Dropdown
                        menu={{
                          items: [
                            { key: "rename", icon: <EditOutlined />, label: "修改群名称", onClick: editRoomName },
                          ],
                        }}
                      >
                        <Button size="small" icon={<MoreOutlined />} />
                      </Dropdown>
                    )}
                  </Space>
                </div>

                {/* 置顶群/频道公告横幅 */}
                {Boolean(room?.announcement) && (
                  <div className="qq-announce-bubble">
                    <SoundOutlined style={{ color: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, flexShrink: 0 }}>置顶公告：</span>
                    <span style={{ flex: 1 }} className="oo-truncate">{room.announcement}</span>
                    {(room?.my_role === "owner" || room?.my_role === "admin" || me?.role >= 100) && (
                      <Button
                        type="link"
                        size="small"
                        icon={<EditOutlined />}
                        style={{ padding: "0 4px", fontSize: 11 }}
                        onClick={() => { setAnnounceText(room?.announcement || ""); setEditAnnounceOpen(true); }}
                      >
                        编辑
                      </Button>
                    )}
                  </div>
                )}

                {/* B. 消息滚动流 */}
                <div className="qq-msg-scroll" ref={scrollRef}>
                  {msgsLoading ? (
                    <Skeleton active paragraph={{ rows: 6 }} />
                  ) : !msgs.length ? (
                    <div style={{ padding: "40px 0", textAlign: "center", color: "var(--ink-3)" }}>
                      <CommentOutlined style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }} />
                      <div>暂无历史消息，说点什么打个招呼吧~</div>
                    </div>
                  ) : (
                    msgs.map((m, idx) => {
                      if (m.type === "system") {
                        return (
                          <div key={m.id || idx} style={{ textAlign: "center", fontSize: 11.5, color: "var(--ink-3)", margin: "4px 0" }}>
                            <span>{m.content}</span>
                          </div>
                        );
                      }
                      const isMine = m.user_id === me?.id;
                      return (
                        <div key={m.id || idx} className={`qq-msg-row${isMine ? " is-mine" : ""}`}>
                          <Popover
                            content={
                              <div style={{ width: 180 }}>
                                <div style={{ fontWeight: 600, fontSize: 13 }}>{m.author?.display_name || m.author?.username}</div>
                                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>ID: {m.user_id}</div>
                                <Divider style={{ margin: "8px 0" }} />
                                <Space direction="vertical" style={{ width: "100%" }} size={4}>
                                  {m.user_id !== me?.id && (
                                    <>
                                      <Button size="small" type="primary" block icon={<MessageOutlined />} onClick={() => directChatFriend(m.user_id)}>
                                        发私聊
                                      </Button>
                                      <Button size="small" block icon={<UserAddOutlined />} onClick={() => { addFriendForm.setFieldsValue({ to_user_id: m.user_id }); setAddFriendOpen(true); }}>
                                        加为好友
                                      </Button>
                                    </>
                                  )}
                                  <Button size="small" block onClick={() => navigate(`/u/${m.user_id}`)}>查看个人主页</Button>
                                </Space>
                              </div>
                            }
                            trigger="click"
                          >
                            <div style={{ cursor: "pointer" }}>
                              <UserAvatar user={m.author} size={34} />
                            </div>
                          </Popover>

                          <div className="qq-msg-box">
                            <div className="qq-msg-meta">
                              <span>{m.author?.display_name || m.author?.username}</span>
                              <span>{fmtTime(m.created_time)}</span>
                            </div>

                            <div className="qq-msg-bubble">
                              <Markdown text={m.content || ""} />
                              {Boolean(m.media?.length) && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                                  {m.media.map((img) => (
                                    <img
                                      key={img.id}
                                      src={img.url}
                                      alt="图片"
                                      style={{ maxWidth: 240, maxHeight: 190, borderRadius: 8, cursor: "pointer", objectFit: "cover", border: "1px solid var(--line)" }}
                                      onClick={() => window.open(img.url, "_blank")}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* C. 发送底栏 */}
                <div className="qq-composer-box">
                  <div className="qq-composer-tools">
                    <Popover
                      content={
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, width: 260 }}>
                          {EMOJI_LIST.map((emo) => (
                            <span
                              key={emo}
                              style={{ fontSize: 20, cursor: "pointer", textAlign: "center", padding: 2 }}
                              onClick={() => setInput((prev) => prev + emo)}
                            >
                              {emo}
                            </span>
                          ))}
                        </div>
                      }
                      trigger="click"
                    >
                      <span className="qq-composer-tool-btn" title="表情"><SmileOutlined /></span>
                    </Popover>

                    <label className="qq-composer-tool-btn" title="上传图片">
                      <PictureOutlined />
                      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleUploadPic} />
                    </label>

                    <span className="qq-composer-tool-btn" title="插入代码块" onClick={() => setInput((prev) => `${prev}\n\`\`\`javascript\n\n\`\`\`\n`)}>
                      <CodeOutlined />
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <Input.TextArea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="发送消息… (Enter 发送，Shift+Enter 换行，支持直接粘贴截图)"
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      onPaste={async (e) => {
                        const items = Array.from(e.clipboardData?.items || []);
                        const img = items.find((it) => it.type.startsWith("image/"));
                        if (img) {
                          const f = img.getAsFile();
                          if (f) {
                            e.preventDefault();
                            await handleUploadPic({ target: { files: [f] } });
                          }
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          doSend();
                        }
                      }}
                    />
                    <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => doSend()}>
                      发送
                    </Button>
                  </div>
                </div>
              </div>

              {/* D. 右侧群成员/频道成员侧边栏 */}
              {showMembers && room?.type === "group" && (
                <div className="qq-members-panel">
                  <div style={{ fontSize: 13, fontWeight: 600, padding: "0 6px 8px", borderBottom: "1px solid var(--line)" }}>
                    频道成员 ({room?.members?.length || 0})
                  </div>

                  {/* 频道主/群主 */}
                  <div className="qq-member-group-title"><CrownOutlined style={{ color: "#faad14" }} /> 群主 / 频道主</div>
                  {room?.members?.filter((m) => m.role === "owner").map((m) => (
                    <div key={m.id} className="qq-member-item" onClick={() => setProfileModalUser(m)}>
                      <UserAvatar user={m} size={24} />
                      <span style={{ fontSize: 12.5 }} className="oo-truncate">{m.display_name || m.username}</span>
                    </div>
                  ))}

                  {/* 管理员 */}
                  {Boolean(room?.members?.some((m) => m.role === "admin")) && (
                    <>
                      <div className="qq-member-group-title"><SafetyOutlined style={{ color: "var(--accent)" }} /> 管理员</div>
                      {room?.members?.filter((m) => m.role === "admin").map((m) => (
                        <div key={m.id} className="qq-member-item" onClick={() => setProfileModalUser(m)}>
                          <UserAvatar user={m} size={24} />
                          <span style={{ fontSize: 12.5 }} className="oo-truncate">{m.display_name || m.username}</span>
                        </div>
                      ))}
                    </>
                  )}

                  {/* 在线成员 */}
                  <div className="qq-member-group-title">在线成员</div>
                  {room?.members?.filter((m) => m.role === "member" && m.online).map((m) => (
                    <div key={m.id} className="qq-member-item" onClick={() => setProfileModalUser(m)}>
                      <div className="qq-online-badge">
                        <UserAvatar user={m} size={24} />
                        <span className="qq-online-dot" />
                      </div>
                      <span style={{ fontSize: 12.5 }} className="oo-truncate">{m.display_name || m.username}</span>
                    </div>
                  ))}

                  {/* 离线成员 */}
                  <div className="qq-member-group-title">离线成员</div>
                  {room?.members?.filter((m) => m.role === "member" && !m.online).map((m) => (
                    <div key={m.id} className="qq-member-item" style={{ opacity: 0.65 }} onClick={() => setProfileModalUser(m)}>
                      <UserAvatar user={m} size={24} />
                      <span style={{ fontSize: 12.5 }} className="oo-truncate">{m.display_name || m.username}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* =========================================================
          模态弹窗：添加好友
          ========================================================= */}
      <Modal
        title="添加好友"
        open={addFriendOpen}
        onOk={() => addFriendForm.submit()}
        confirmLoading={addFriendLoading}
        onCancel={() => setAddFriendOpen(false)}
        destroyOnClose
      >
        <Form form={addFriendForm} layout="vertical" onFinish={submitAddFriend}>
          <Form.Item name="to_user_id" label="查找目标用户" rules={[{ required: true, message: "请选择用户" }]}>
            <Select
              showSearch
              placeholder="输入用户名或昵称搜索…"
              filterOption={false}
              onSearch={handleSearchUsers}
              loading={searching}
              options={userOptions.map((u) => ({
                value: u.id,
                label: `${u.display_name ? `${u.display_name} (@${u.username})` : u.username} · ID:${u.id}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="message" label="验证申请消息" initialValue="你好，我是社区伙伴，希望能添加好友交流。">
            <Input.TextArea maxLength={200} showCount rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* =========================================================
          模态弹窗：发起会话 / 创建群聊
          ========================================================= */}
      <Modal
        title="发起新聊天 / 创建群聊"
        open={createOpen}
        onOk={() => createForm.submit()}
        confirmLoading={creating}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={submitCreateRoom} initialValue={{ type: "single" }}>
          <Form.Item name="type" label="会话类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "single", label: "好友私聊 (单聊)" },
                { value: "group", label: "多人交流群 (群聊)" },
              ]}
            />
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(p, c) => p.type !== c.type}>
            {({ getFieldValue }) =>
              getFieldValue("type") === "single" ? (
                <Form.Item name="user_id" label="聊天对象" rules={[{ required: true, message: "请选择用户" }]}>
                  <Select
                    showSearch
                    placeholder="从好友或全站用户中选择…"
                    filterOption={false}
                    onSearch={handleSearchUsers}
                    loading={searching}
                    options={[
                      ...friends.map((f) => ({ value: f.id, label: `[好友] ${f.title} (@${f.username})` })),
                      ...userOptions.filter((u) => !friends.some((f) => f.id === u.id)).map((u) => ({
                        value: u.id,
                        label: `${u.display_name || u.username} · ID:${u.id}`,
                      })),
                    ]}
                  />
                </Form.Item>
              ) : (
                <>
                  <Form.Item name="name" label="群聊名称" rules={[{ required: true, message: "请输入群名称" }]}>
                    <Input placeholder="例如：DeepSeek 提示词探讨组" maxLength={30} />
                  </Form.Item>
                  <Form.Item name="user_ids" label="邀请初始成员" rules={[{ required: true, message: "请至少选一人" }]}>
                    <Select
                      mode="multiple"
                      placeholder="搜索并选择好友/成员…"
                      filterOption={false}
                      onSearch={handleSearchUsers}
                      options={[
                        ...friends.map((f) => ({ value: f.id, label: `${f.title} (@${f.username})` })),
                        ...userOptions.filter((u) => !friends.some((f) => f.id === u.id)).map((u) => ({
                          value: u.id,
                          label: `${u.display_name || u.username} · ID:${u.id}`,
                        })),
                      ]}
                    />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
        </Form>
      </Modal>

      {/* =========================================================
          模态弹窗：编辑群公告
          ========================================================= */}
      <Modal
        title="编辑群公告"
        open={editAnnounceOpen}
        onOk={saveAnnouncement}
        onCancel={() => setEditAnnounceOpen(false)}
        destroyOnClose
      >
        <Input.TextArea
          value={announceText}
          onChange={(e) => setAnnounceText(e.target.value)}
          placeholder="请输入最新的群公告内容…"
          rows={4}
          maxLength={500}
          showCount
        />
      </Modal>

      {/* =========================================================
          模态弹窗：成员资料名片
          ========================================================= */}
      <Modal
        open={Boolean(profileModalUser)}
        footer={null}
        onCancel={() => setProfileModalUser(null)}
        width={380}
        destroyOnClose
      >
        {profileModalUser && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <UserAvatar user={profileModalUser} size={64} />
            <h3 style={{ fontSize: 17, fontWeight: 600, marginTop: 12, marginBottom: 2 }}>
              {profileModalUser.display_name || profileModalUser.username}
            </h3>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>@{profileModalUser.username} · ID: {profileModalUser.id}</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", margin: "12px auto", maxWidth: 280 }}>
              {profileModalUser.bio || "暂无个性签名"}
            </div>

            <Divider style={{ margin: "14px 0" }} />

            <Space>
              {profileModalUser.id !== me?.id && (
                <>
                  <Button type="primary" icon={<MessageOutlined />} onClick={() => { setProfileModalUser(null); directChatFriend(profileModalUser.id); }}>
                    发起私聊
                  </Button>
                  {!friends.some((f) => f.id === profileModalUser.id) && (
                    <Button icon={<UserAddOutlined />} onClick={() => { setProfileModalUser(null); addFriendForm.setFieldsValue({ to_user_id: profileModalUser.id }); setAddFriendOpen(true); }}>
                      加好友
                    </Button>
                  )}
                </>
              )}
              <Button onClick={() => { setProfileModalUser(null); navigate(`/u/${profileModalUser.id}`); }}>
                主页
              </Button>
            </Space>
          </div>
        )}
      </Modal>
    </div>
  );
}
