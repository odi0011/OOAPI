// 消息中心左栏：会话列表 / 联系人（两个 Tab 共用一个搜索框）
import React, { useMemo } from "react";
import { Skeleton, Tooltip } from "antd";
import { MessageOutlined, UserAddOutlined, RightOutlined, TeamOutlined } from "@ant-design/icons";
import { RoomAvatar, PresenceAvatar, fmtListTime, nameOf } from "./im-utils";

const match = (kw, ...fields) => {
  const q = kw.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f || "").toLowerCase().includes(q));
};

function EmptyHint({ title, desc, action }) {
  return (
    <div className="oo-im-empty-hint">
      <div className="oo-im-empty-title">{title}</div>
      {desc ? <div className="oo-im-empty-desc">{desc}</div> : null}
      {action}
    </div>
  );
}

export function RoomList({ rooms, loading, activeId, online, kw, filter, onOpen, onCreateGroup, onFindPeople }) {
  const list = useMemo(
    () =>
      rooms
        .filter((r) => (filter === "unread" ? r.unread > 0 : filter === "group" ? r.type !== "single" : true))
        .filter((r) => match(kw, r.title, r.name, r.peer?.username)),
    [rooms, filter, kw]
  );

  if (loading && !rooms.length) {
    return <div style={{ padding: 14 }}><Skeleton avatar active paragraph={{ rows: 2 }} /><Skeleton avatar active paragraph={{ rows: 2 }} /></div>;
  }
  if (!rooms.length) {
    return (
      <EmptyHint
        title="还没有会话"
        desc="从联系人发起私聊，或建一个群聊把大家拉进来"
        action={
          <div className="oo-im-empty-actions">
            <button type="button" className="oo-im-link-btn" onClick={onFindPeople}><UserAddOutlined /> 添加好友</button>
            <button type="button" className="oo-im-link-btn" onClick={onCreateGroup}><TeamOutlined /> 创建群聊</button>
          </div>
        }
      />
    );
  }
  if (!list.length) return <EmptyHint title={kw.trim() ? "没有匹配的会话" : filter === "unread" ? "没有未读消息" : "还没有群聊"} />;

  return (
    <ul className="oo-im-list" role="listbox" aria-label="会话列表">
      {list.map((r) => {
        const peerOnline = r.type === "single" && r.peer ? online.has(r.peer.id) : undefined;
        const active = r.id === activeId;
        return (
          <li key={r.id} role="option" aria-selected={active}>
            <button type="button" className={`oo-im-row${active ? " is-active" : ""}`} onClick={() => onOpen(r)}>
              <RoomAvatar room={r} size={40} online={peerOnline} />
              <span className="oo-im-row-body">
                <span className="oo-im-row-top">
                  <span className="oo-im-row-title oo-truncate">{r.title || r.name}</span>
                  {r.type !== "single" ? <span className="oo-im-kind">群</span> : null}
                  <span className="oo-im-row-time">{fmtListTime(r.last_message_time || r.created_time)}</span>
                </span>
                <span className="oo-im-row-bottom">
                  <span className="oo-im-row-preview oo-truncate">{r.last_message_text || (r.type === "single" ? "打个招呼吧" : `${r.member_count || 0} 位成员`)}</span>
                  {r.unread ? <span className="oo-im-unread">{r.unread > 99 ? "99+" : r.unread}</span> : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ContactList({ friends, loading, online, pending, kw, activeFriendId, requestsActive, onOpenRequests, onOpenFriend, onChat, onFindPeople }) {
  const { on, off } = useMemo(() => {
    const filtered = friends.filter((f) => match(kw, f.remark, f.display_name, f.username));
    const sorted = [...filtered].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN"));
    return { on: sorted.filter((f) => online.has(f.id)), off: sorted.filter((f) => !online.has(f.id)) };
  }, [friends, kw, online]);

  const row = (f) => (
    <li key={f.id}>
      <div className={`oo-im-row oo-im-row--contact${activeFriendId === f.id ? " is-active" : ""}`}>
        <button type="button" className="oo-im-row-main" onClick={() => onOpenFriend(f)} onDoubleClick={() => onChat(f)}>
          <PresenceAvatar user={f} size={36} online={online.has(f.id)} />
          <span className="oo-im-row-body">
            <span className="oo-im-row-title oo-truncate">
              {nameOf(f)}
              {f.remark ? <span className="oo-im-row-sub"> · {f.display_name || f.username}</span> : null}
            </span>
            <span className="oo-im-row-preview oo-truncate">{f.bio || `@${f.username}`}</span>
          </span>
        </button>
        <Tooltip title="发消息">
          <button type="button" className="oo-im-icon-btn oo-im-row-action" aria-label={`给 ${nameOf(f)} 发消息`} onClick={() => onChat(f)}>
            <MessageOutlined />
          </button>
        </Tooltip>
      </div>
    </li>
  );

  return (
    <div>
      <button type="button" className={`oo-im-row oo-im-row--requests${requestsActive ? " is-active" : ""}`} onClick={onOpenRequests}>
        <span className="oo-im-req-icon"><UserAddOutlined /></span>
        <span className="oo-im-row-body">
          <span className="oo-im-row-title">新的朋友</span>
          <span className="oo-im-row-preview">{pending ? `${pending} 条好友申请待处理` : "好友申请与记录"}</span>
        </span>
        {pending ? <span className="oo-im-unread">{pending}</span> : <RightOutlined className="oo-im-chevron" />}
      </button>

      {loading && !friends.length ? (
        <div style={{ padding: 14 }}><Skeleton avatar active paragraph={{ rows: 1 }} /></div>
      ) : !friends.length ? (
        <EmptyHint
          title="还没有好友"
          desc="搜用户名添加好友；在社区帖子或个人主页里也能直接加"
          action={<button type="button" className="oo-im-link-btn" onClick={onFindPeople}><UserAddOutlined /> 添加好友</button>}
        />
      ) : (
        <>
          {on.length ? <div className="oo-im-group-label">在线 · {on.length}</div> : null}
          <ul className="oo-im-list">{on.map(row)}</ul>
          {off.length ? <div className="oo-im-group-label">离线 · {off.length}</div> : null}
          <ul className="oo-im-list">{off.map(row)}</ul>
          {!on.length && !off.length ? <EmptyHint title="没有匹配的好友" /> : null}
        </>
      )}
    </div>
  );
}
