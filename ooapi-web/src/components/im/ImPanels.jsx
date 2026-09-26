// 消息中心的资料面板：个人名片 / 群资料 / 好友申请 / 空状态 / 成员选择器
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App as AntApp, Button, Empty, Input, Modal, Select, Skeleton, Tag, Tooltip } from "antd";
import {
  MessageOutlined, UserAddOutlined, EditOutlined, HomeOutlined, DeleteOutlined, CheckOutlined, CloseOutlined,
  UsergroupAddOutlined, LogoutOutlined, SoundOutlined, CrownOutlined, SafetyOutlined, SearchOutlined, UserDeleteOutlined,
  ArrowLeftOutlined, TeamOutlined, ClockCircleOutlined,
} from "@ant-design/icons";
import { API } from "../../services/api";
import UserAvatar from "../UserAvatar";
import { PresenceAvatar, GroupAvatar, nameOf, fmtListTime } from "./im-utils";

/**
 * 个人名片：按「我和 TA 的关系」给出主操作。
 * 关系从 /friends/relation/:id 实时取 —— 不靠调用方传，否则名片从聊天、群成员、
 * 通讯录三个入口打开时状态各不相同（原实现在群成员名片里对好友也显示「加好友」）。
 */
export function PersonCard({ user, me, online, compact = false, onChat, onAddFriend, onChanged }) {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const [rel, setRel] = useState(null);
  const [profile, setProfile] = useState(null);
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const uid = Number(user?.id) || 0;
  const isSelf = uid && uid === me?.id;

  const loadRel = React.useCallback(async () => {
    if (!uid) return;
    try {
      setRel(await API.get(`/friends/relation/${uid}`));
    } catch {
      setRel({ relation: "none" });
    }
  }, [uid]);

  useEffect(() => {
    let off = false;
    setRel(null);
    setProfile(null);
    if (!uid) return undefined;
    loadRel();
    // 名片里的签名/简介来自个人主页接口（聊天消息里的作者信息只有名字和头像）
    API.get(`/profile/u/${uid}`).then((p) => !off && setProfile(p)).catch(() => {});
    return () => { off = true; };
  }, [uid, loadRel]);

  if (!uid) return null;
  const u = { ...user, ...(profile || {}), remark: rel?.remark || user?.remark || "" };

  /** 执行一个关系操作；返回是否成功（备注弹窗据此决定关不关） */
  const act = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      if (okText) message.success(okText);
      await loadRel();
      onChanged?.();
      return true;
    } catch (e) {
      message.error(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveRemark = async () => {
    if (await act(() => API.put(`/friends/${uid}/remark`, { remark: remark.trim() }), "备注已更新")) setRemarkOpen(false);
  };

  const removeFriend = () =>
    modal.confirm({
      title: `删除好友「${nameOf(u)}」？`,
      content: "双方都会从对方的通讯录里移除，聊天记录保留。",
      okText: "删除",
      okType: "danger",
      onOk: () => act(() => API.del(`/friends/${uid}`), "已删除好友"),
    });

  const r = rel?.relation;
  const primaryBtn = isSelf ? null : (
    <Button type="primary" icon={<MessageOutlined />} onClick={() => onChat(u)}>发消息</Button>
  );
  let relBtns = null;
  if (r === "friend") {
    relBtns = (
      <>
        <Button icon={<EditOutlined />} onClick={() => { setRemark(u.remark || ""); setRemarkOpen(true); }}>备注</Button>
        <Tooltip title="删除好友"><Button danger icon={<UserDeleteOutlined />} onClick={removeFriend} aria-label="删除好友" /></Tooltip>
      </>
    );
  } else if (r === "pending_out") {
    relBtns = (
      <Button loading={busy} icon={<ClockCircleOutlined />} onClick={() => act(() => API.del(`/friends/requests/${rel.request_id}`), "已撤回申请")}>
        已申请 · 撤回
      </Button>
    );
  } else if (r === "pending_in") {
    relBtns = (
      <>
        <Button loading={busy} icon={<CheckOutlined />} onClick={() => act(() => API.put(`/friends/requests/${rel.request_id}`, { action: "accept" }), "已成为好友")}>通过申请</Button>
        <Button loading={busy} icon={<CloseOutlined />} onClick={() => act(() => API.put(`/friends/requests/${rel.request_id}`, { action: "reject" }), "已拒绝")}>拒绝</Button>
      </>
    );
  } else if (r === "none") {
    relBtns = <Button icon={<UserAddOutlined />} onClick={() => onAddFriend(u)}>加好友</Button>;
  }

  return (
    <div className={`oo-im-person${compact ? " is-compact" : ""}`}>
      <PresenceAvatar user={u} size={compact ? 64 : 84} online={isSelf ? undefined : online} />
      <div className="oo-im-person-name">
        {nameOf(u)}
        {r === "friend" ? <Tag color="blue" style={{ marginInlineStart: 8 }}>好友</Tag> : null}
      </div>
      <div className="oo-im-person-sub">
        @{u.username}
        {u.remark ? ` · 昵称 ${u.display_name || u.username}` : ""}
      </div>
      <div className="oo-im-person-bio">{u.bio || (profile ? "这个人还没有写签名" : "")}</div>
      {rel === null ? (
        <Skeleton.Button active size="small" />
      ) : (
        <div className="oo-im-person-actions">
          {primaryBtn}
          {relBtns}
          <Tooltip title="个人主页">
            <Button icon={<HomeOutlined />} onClick={() => navigate(`/u/${uid}`)} aria-label="个人主页">{compact ? null : "主页"}</Button>
          </Tooltip>
        </div>
      )}
      <Modal
        title={`给「${u.display_name || u.username}」设置备注`}
        open={remarkOpen}
        onCancel={() => setRemarkOpen(false)}
        okText="保存"
        confirmLoading={busy}
        onOk={saveRemark}
        destroyOnClose
      >
        <Input
          autoFocus
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          maxLength={30}
          showCount
          placeholder="只有你自己看得到；留空则显示对方昵称"
          onPressEnter={saveRemark}
        />
      </Modal>
    </div>
  );
}

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 };

/** 群资料：公告 + 成员（群主/管理员在前，其余在线优先） */
export function GroupInfo({ room, me, online, onMemberClick, onInvite, onEditAnnouncement, onRename, onLeave, onDissolve, onKick }) {
  const [kw, setKw] = useState("");
  const isManager = room?.my_role === "owner" || room?.my_role === "admin" || Number(me?.role) >= 100;
  const isOwner = room?.owner_id === me?.id || Number(me?.role) >= 100;
  const members = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return [...(room?.members || [])]
      .map((m) => ({ ...m, online: m.online || online.has(m.id) }))
      .filter((m) => !q || `${m.display_name} ${m.username}`.toLowerCase().includes(q))
      .sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || Number(b.online) - Number(a.online));
  }, [room?.members, online, kw]);
  const onlineCount = (room?.members || []).filter((m) => m.online || online.has(m.id)).length;

  return (
    <div className="oo-im-info">
      <div className="oo-im-info-head">
        <GroupAvatar name={room?.title} id={room?.id} size={56} />
        <div className="oo-im-person-name">
          {room?.title}
          {isManager ? (
            <Tooltip title="修改群名"><button type="button" className="oo-im-icon-btn" onClick={onRename} aria-label="修改群名"><EditOutlined /></button></Tooltip>
          ) : null}
        </div>
        <div className="oo-im-person-sub">{room?.members?.length || 0} 位成员 · {onlineCount} 人在线</div>
      </div>

      <div className="oo-im-info-block">
        <div className="oo-im-info-label">
          <span><SoundOutlined /> 群公告</span>
          {isManager ? <button type="button" className="oo-im-link-btn" onClick={onEditAnnouncement}>{room?.announcement ? "编辑" : "发布"}</button> : null}
        </div>
        <div className={`oo-im-announce-text${room?.announcement ? "" : " is-empty"}`}>{room?.announcement || "暂无公告"}</div>
      </div>

      <div className="oo-im-info-block oo-im-info-members">
        <div className="oo-im-info-label">
          <span><TeamOutlined /> 成员</span>
          <button type="button" className="oo-im-link-btn" onClick={onInvite}><UsergroupAddOutlined /> 邀请</button>
        </div>
        {(room?.members?.length || 0) > 8 ? (
          <Input size="small" allowClear prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />} placeholder="搜索成员" value={kw} onChange={(e) => setKw(e.target.value)} style={{ marginBottom: 6 }} />
        ) : null}
        <ul className="oo-im-list">
          {members.map((m) => (
            <li key={m.id} className="oo-im-member">
              <button type="button" className="oo-im-member-main" onClick={() => onMemberClick(m)}>
                <PresenceAvatar user={m} size={28} online={m.online} />
                <span className="oo-truncate">{m.display_name || m.username}{m.id === me?.id ? "（我）" : ""}</span>
                {m.role === "owner" ? <CrownOutlined className="oo-im-role is-owner" aria-label="群主" /> : null}
                {m.role === "admin" ? <SafetyOutlined className="oo-im-role" aria-label="管理员" /> : null}
              </button>
              {isManager && m.id !== me?.id && m.role !== "owner" ? (
                <Tooltip title="移出群聊">
                  <button type="button" className="oo-im-icon-btn oo-im-member-kick" onClick={() => onKick(m)} aria-label={`将 ${m.display_name || m.username} 移出群聊`}>
                    <UserDeleteOutlined />
                  </button>
                </Tooltip>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="oo-im-info-foot">
        <Button block icon={<LogoutOutlined />} onClick={onLeave}>退出群聊</Button>
        {isOwner ? <Button block danger icon={<DeleteOutlined />} onClick={onDissolve}>解散群聊</Button> : null}
      </div>
    </div>
  );
}

const REQ_STATUS = {
  0: <Tag color="orange">等待验证</Tag>,
  1: <Tag color="green">已同意</Tag>,
  2: <Tag>已拒绝</Tag>,
  3: <Tag>已撤回</Tag>,
};

/** 新的朋友：收到的（待处理）+ 我发出的（全部状态） */
export function RequestsView({ requests, onBack, onHandle, onWithdraw, onOpenUser, onAddFriend }) {
  const [busyId, setBusyId] = useState(0);
  const run = async (id, fn) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(0);
    }
  };
  return (
    <div className="oo-im-page">
      <header className="oo-im-page-head">
        <Button type="text" className="oo-im-mobile-only" icon={<ArrowLeftOutlined />} aria-label="返回" onClick={onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>新的朋友</h2>
          <p>处理好友申请；互相申请过的会直接成为好友</p>
        </div>
        <Button type="primary" icon={<UserAddOutlined />} onClick={onAddFriend}>添加好友</Button>
      </header>
      <div className="oo-im-page-body">
        <section>
          <h3>收到的申请 {requests.incoming.length ? <span className="oo-im-unread">{requests.incoming.length}</span> : null}</h3>
          {!requests.incoming.length ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有新的好友申请" />
          ) : (
            <ul className="oo-im-req-list">
              {requests.incoming.map((r) => (
                <li key={r.id} className="oo-im-req">
                  <button type="button" className="oo-im-avatar-btn" onClick={() => onOpenUser({ id: r.from_user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url })}>
                    <PresenceAvatar user={{ id: r.from_user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url }} size={42} online={r.online} />
                  </button>
                  <div className="oo-im-req-body">
                    <div className="oo-im-row-title">{r.display_name || r.username} <span className="oo-im-row-sub">@{r.username}</span></div>
                    <div className="oo-im-req-msg">{r.message || "对方没有填写验证消息"}</div>
                    <div className="oo-im-row-time">{fmtListTime(r.created_time)}</div>
                  </div>
                  <div className="oo-im-req-actions">
                    <Button type="primary" size="small" loading={busyId === r.id} icon={<CheckOutlined />} onClick={() => run(r.id, () => onHandle(r, "accept"))}>同意</Button>
                    <Button size="small" disabled={busyId === r.id} icon={<CloseOutlined />} onClick={() => run(r.id, () => onHandle(r, "reject"))}>拒绝</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>我发出的</h3>
          {!requests.outgoing.length ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有发出过好友申请" />
          ) : (
            <ul className="oo-im-req-list">
              {requests.outgoing.map((r) => (
                <li key={r.id} className="oo-im-req is-compact">
                  <UserAvatar user={{ id: r.to_user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url }} size={32} />
                  <div className="oo-im-req-body">
                    <div className="oo-im-row-title">{r.display_name || r.username}</div>
                    <div className="oo-im-req-msg oo-truncate">{r.message || "（无验证消息）"}</div>
                  </div>
                  <div className="oo-im-req-actions">
                    {REQ_STATUS[r.status] || null}
                    {r.status === 0 ? (
                      <Button size="small" type="text" loading={busyId === r.id} onClick={() => run(r.id, () => onWithdraw(r))}>撤回</Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** 未选中会话时的主区：快捷入口 + 在线好友 */
export function EmptyStage({ friends, online, onAddFriend, onCreateGroup, onChat, onCommunity }) {
  const onlineFriends = friends.filter((f) => online.has(f.id)).slice(0, 8);
  return (
    <div className="oo-im-stage-empty">
      <div className="oo-im-stage-icon"><MessageOutlined /></div>
      <h2>私聊与群聊</h2>
      <p>从左侧选择一个会话。公开的讨论、提问与分享请到社区发帖，所有人都能看到并参与。</p>
      <div className="oo-im-stage-actions">
        <Button type="primary" icon={<UserAddOutlined />} onClick={onAddFriend}>添加好友</Button>
        <Button icon={<UsergroupAddOutlined />} onClick={onCreateGroup}>创建群聊</Button>
        <Button type="text" onClick={onCommunity}>去社区看看</Button>
      </div>
      {onlineFriends.length ? (
        <div className="oo-im-stage-online">
          <div className="oo-im-group-label">在线好友</div>
          <div className="oo-im-stage-online-list">
            {onlineFriends.map((f) => (
              <button key={f.id} type="button" onClick={() => onChat(f)} title={`给 ${nameOf(f)} 发消息`}>
                <PresenceAvatar user={f} size={40} online />
                <span className="oo-truncate">{nameOf(f)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 成员选择器（建群 / 邀请共用）：好友在前，输入关键字再搜全站用户。
 * exclude：已在群里的人（邀请时）—— 列出来也选不了，只会让人以为邀请失败。
 */
export function MemberPicker({ value, onChange, friends, exclude = [] }) {
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);
  const known = useRef(new Map());

  const ex = new Set(exclude);
  for (const f of friends) known.current.set(f.id, f);
  for (const u of found) known.current.set(u.id, u);

  const search = (q) => {
    clearTimeout(timer.current);
    if (!q.trim()) {
      setFound([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await API.get("/chatroom/users", { params: { q: q.trim() } });
        setFound(Array.isArray(d) ? d : []);
      } catch {
        setFound([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const label = (u) => (
    <span className="oo-im-pick-opt">
      <UserAvatar user={u} size={18} />
      <span className="oo-truncate">{nameOf(u)}</span>
      <span className="oo-im-row-sub">@{u.username}</span>
    </span>
  );
  const friendIds = new Set(friends.map((f) => f.id));
  const options = [
    { label: "好友", options: friends.filter((f) => !ex.has(f.id)).map((f) => ({ value: f.id, label: label(f), search: `${nameOf(f)} ${f.username}` })) },
    ...(found.length
      ? [{ label: "搜索结果", options: found.filter((u) => !ex.has(u.id) && !friendIds.has(u.id)).map((u) => ({ value: u.id, label: label(u), search: `${nameOf(u)} ${u.username}` })) }]
      : []),
  ].filter((g) => g.options.length);

  return (
    <Select
      mode="multiple"
      value={value}
      onChange={onChange}
      options={options}
      placeholder="选择好友，或输入用户名搜索其他人"
      onSearch={search}
      filterOption={(input, opt) => String(opt?.search || "").toLowerCase().includes(input.trim().toLowerCase())}
      loading={searching}
      notFoundContent={searching ? "搜索中…" : "输入用户名或昵称搜索"}
      tagRender={({ value: v, closable, onClose }) => {
        const u = known.current.get(v);
        return (
          <Tag closable={closable} onClose={onClose} style={{ marginInlineEnd: 4 }}>
            {u ? nameOf(u) : `#${v}`}
          </Tag>
        );
      }}
      style={{ width: "100%" }}
      maxTagCount="responsive"
    />
  );
}
