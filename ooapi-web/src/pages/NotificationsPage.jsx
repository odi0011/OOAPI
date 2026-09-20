// 通知中心 —— 社区互动提醒（评论/回复/点赞/收藏/关注）
// ---------------------------------------------------------------------------
// 设计取舍：
//   · 通知**只用 SSE 加速、以数据库为真相**：关掉页面期间的提醒不会丢；
//   · 与消息中心分开成两个入口：消息是「和某人对话」（双向、有上下文），
//     通知是「有人动了你的内容」（单向、看完即清），混在一起会让
//     用户分不清「回谁的话」和「处理什么动态」。
//   · 列表用紧凑行（头像 26px + 一行文案 + 相对时间），一屏能看十几条。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Segmented, Empty, Skeleton, App as AntApp, Tag, Tooltip } from "antd";
import {
  ReloadOutlined, CheckOutlined, DeleteOutlined, MessageOutlined, LikeOutlined,
  StarOutlined, UserAddOutlined, CommentOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import { relTime } from "../components/PostList";

/** 通知类型的图标与语义色（与全站状态色一致：主色=信息、绿=正向、橙=互动） */
const TYPE_ICON = {
  post_comment: <CommentOutlined style={{ color: "var(--accent)" }} />,
  comment_reply: <MessageOutlined style={{ color: "var(--accent)" }} />,
  post_like: <LikeOutlined style={{ color: "var(--green)" }} />,
  comment_like: <LikeOutlined style={{ color: "var(--green)" }} />,
  post_favorite: <StarOutlined style={{ color: "var(--orange)" }} />,
  follow: <UserAddOutlined style={{ color: "var(--accent)" }} />,
};

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { begin, isLatest } = useLatest();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState("all"); // all | unread
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const [d, u] = await Promise.all([
        API.get("/community/notifications", { params: { p: 1, page_size: 50, unread: filter === "unread" ? 1 : undefined } }),
        API.get("/community/notifications/unread"),
      ]);
      if (!isLatest(token)) return;
      setItems(d?.items || []);
      setTotal(d?.total || 0);
      setUnread(u?.total || 0);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "通知加载失败");
        message.error(e.message);
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, filter, isLatest, message]);

  useEffect(() => {
    load();
  }, [load]);

  const readAll = async () => {
    if (acting) return;
    setActing(true);
    try {
      const r = await API.post("/community/notifications/read", {});
      message.success(r?.updated ? `已标记 ${r.updated} 条` : "没有未读通知");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const openItem = async (n) => {
    // 点开即视为已读（这是用户最自然的预期，不必再点「标为已读」）
    if (!n.is_read) {
      API.post("/community/notifications/read", { ids: [n.id] })
        .then(() => {
          setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: 1 } : x)));
          setUnread((v) => Math.max(0, v - 1));
        })
        .catch(() => {});
    }
    if (n.post_id) navigate(`/community/${n.post_id}`);
    else if (n.type === "follow") navigate(`/u/${n.actor.id}`);
  };

  const removeItem = async (n, e) => {
    e?.stopPropagation?.();
    try {
      await API.del(`/community/notifications/${n.id}`);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      setTotal((v) => Math.max(0, v - 1));
      if (!n.is_read) setUnread((v) => Math.max(0, v - 1));
    } catch (err) {
      message.error(err.message);
    }
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="通知"
        tags={unread > 0 ? <Tag color="red">{unread} 条未读</Tag> : <Tag>全部已读</Tag>}
        extra={
          <>
            <Button icon={<CheckOutlined />} onClick={readAll} loading={acting} disabled={!unread}>
              全部已读
            </Button>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading} title="刷新通知" aria-label="刷新通知" />
          </>
        }
      />

      <div className="oo-stats-cards">
        <StatCard label="未读" value={unread} suffix="条" tone={unread ? "warning" : undefined} hint="导航栏红点同源" />
        <StatCard label="通知总数" value={total} suffix="条" hint={filter === "unread" ? "当前筛选：仅未读" : "含已读"} />
      </div>

      <div className="oo-panel">
        <div className="oo-toolbar">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "unread", label: "仅未读" },
            ]}
          />
          <span className="oo-toolbar-spacer" />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>点击通知可跳到对应内容</span>
        </div>

        {loadError ? (
          <div style={{ padding: 16 }}>
            <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 8 }}>{loadError}</div>
            <Button size="small" onClick={load}>重试</Button>
          </div>
        ) : null}

        {loading && !items.length ? (
          <div style={{ padding: 16 }}><Skeleton active paragraph={{ rows: 4 }} /></div>
        ) : !items.length ? (
          <div style={{ padding: "48px 0" }}>
            <Empty
              description={filter === "unread" ? "没有未读通知" : "还没有通知；别人评论或点赞你的内容时会出现在这里"}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          <div>
            {items.map((n) => (
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                onClick={() => openItem(n)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openItem(n);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 14px",
                  borderBottom: "1px solid var(--line-soft)",
                  cursor: "pointer",
                  // 未读用极浅底色标记（不用整行变色，避免列表花）
                  background: n.is_read ? undefined : "var(--accent-tint)",
                }}
              >
                <UserAvatar user={n.actor} size={26} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 550 }}>{n.actor?.display_name || n.actor?.username || "有人"}</span>
                    <span style={{ color: "var(--ink-2)" }}>{n.text}</span>
                    {TYPE_ICON[n.type] || null}
                  </div>
                  {n.post_title ? (
                    <div className="oo-truncate" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
                      {n.post_title}
                    </div>
                  ) : null}
                </div>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)", flexShrink: 0 }}>{relTime(n.created_time)}</span>
                <Tooltip title="删除这条通知">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={(e) => removeItem(n, e)}
                    aria-label="删除通知"
                  />
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
