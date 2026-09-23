// 个人主页 —— 统一路由 /u/:id
// ---------------------------------------------------------------------------
// 设计依据（Gemini 评审意见，第 3 点）：
//
// ① **统一 URL，UI 层区分「自己看」与「别人看」**。
//    错的做法是「自己看跳到后台设置、别人看才进 /u/:id」—— 那样用户永远
//    无法直觉感知自己的对外形象。这里恒为 /u/:id，靠 is_self 切换右上角主操作：
//      · 自己：编辑公开资料 / 我的令牌 / 仅自己可见的 Tab（草稿、收藏）
//      · 别人：关注 / 发私信
//
// ② **统计不放 4 张大卡片**：个人主页不是看板。按项目 2.5 规范，
//    在头像信息正下方内嵌一行 `.oo-stats-strip`，点击就地切换到下方列表，
//    不抢首屏内容。
//
// ③ 骨架属 A 类（标准工作台流式）：通栏卡片堆叠 + 原生纵向滚动。
import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button, Tabs, Space, Typography, Empty, Skeleton, App as AntApp, Tag, Tooltip } from "antd";
import {
  UserAddOutlined, MessageOutlined, EditOutlined, KeyOutlined, ReloadOutlined,
  FileTextOutlined, EnvironmentOutlined, LinkOutlined, ClockCircleOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import { safeHref } from "../components/Markdown";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import StatCard from "../components/StatCard";
import PostList from "../components/PostList";
import { fmtDate } from "../services/format";

const { Text } = Typography;

/** 统计条：一行小标签，点击就地锚点切换列表（不占首屏、不抢视觉） */
function StatsStrip({ stats, onJump }) {
  const items = [
    { key: "posts", label: "帖子", value: stats.posts },
    { key: "likes", label: "获赞", value: stats.likes_received },
    { key: "followers", label: "粉丝", value: stats.followers },
    { key: "following", label: "关注", value: stats.following },
  ];
  return (
    <div className="oo-stats-strip">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className="bui-chip"
          style={{ cursor: onJump ? "pointer" : "default", border: 0 }}
          onClick={() => onJump?.(it.key)}
          title={`查看${it.label}`}
        >
          {it.label} <b>{it.value ?? 0}</b>
        </button>
      ))}
    </div>
  );
}

export default function ProfileViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user: me } = useApp();
  // **两个独立令牌**：主数据与 Tab 列表是两条并行请求。
  // 共用一个 useLatest 时，同一轮里 load() 拿 token 1、loadTab() 拿 token 2，
  // 于是主数据的结果恒被判为「过期」丢弃 —— setData 与 setLoading(false) 都不执行，
  // 整个个人主页**永远停在骨架屏**（实测反馈）。分开后各管各的竞态。
  //
  // ⚠️ **必须解构**：useLatest 返回 `{ begin, isLatest }` 是每次渲染都新建的对象，
  // begin/isLatest 才是稳定的 useCallback。把整个对象放进 useCallback 依赖数组 →
  // useCallback 每次重建 → useEffect([load]) 每次重跑 → setState → 再渲染 →
  // **无限请求循环**（黑盒测试实测：个人主页 117.8 req/s，404 用户页永远卡骨架屏）。
  const { begin: mainBegin, isLatest: mainIsLatest } = useLatest();
  const { begin: tabBegin, isLatest: tabIsLatest } = useLatest();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [tab, setTab] = useState("posts");
  const [listData, setListData] = useState({ items: [], total: 0 });
  const [listLoading, setListLoading] = useState(false);
  const [tabKey, setTabKey] = useState(0); // 用于强制刷新列表

  const uid = Number(id) || 0;
  const isSelf = Boolean(me && data && me.id === data.id);

  const load = useCallback(async () => {
    if (!uid) return;
    const token = mainBegin();
    setLoading(true);
    setNotFound(false);
    try {
      const d = await API.get(`/profile/u/${uid}`);
      if (!mainIsLatest(token)) return;
      setData(d);
      setFollowing(Boolean(d.following));
    } catch (e) {
      if (mainIsLatest(token)) {
        if (e.status === 404) setNotFound(true);
        else message.error(e.message);
      }
    } finally {
      // 必须能关闭 loading：此前与 loadTab 共用令牌时，
      // loadTab 的 token 更大 → 这里恒被判假 → 主数据永远加载不出来（永远骨架屏）
      if (mainIsLatest(token)) setLoading(false);
    }
  }, [mainBegin, mainIsLatest, message, uid]);

  useEffect(() => {
    load();
  }, [load]);

  // Tab 数据：帖子 / 收藏 / 关注 / 粉丝
  const loadTab = useCallback(async () => {
    if (!uid) return;
    const token = tabBegin();
    setListLoading(true);
    try {
      let d;
      if (tab === "posts") d = await API.get(`/profile/u/${uid}/posts`, { params: { p: 1, page_size: 20 } });
      // Tab 的 key 是 "following"（见下方 Tabs items）。这里原写成 "follows" ——
      // 分支永远不可达，关注列表恒为空（实测反馈「关注 Tab 永远为空」）。
      else if (tab === "following") d = await API.get(`/profile/u/${uid}/follows`, { params: { kind: "following", p: 1, page_size: 30 } });
      else if (tab === "followers") d = await API.get(`/profile/u/${uid}/follows`, { params: { kind: "followers", p: 1, page_size: 30 } });
      else if (tab === "favorites") {
        // 收藏只有本人能看（别人的收藏是隐私）
        if (!isSelf) {
          setListData({ items: [], total: 0 });
          return;
        }
        d = await API.get("/community/posts", { params: { p: 1, page_size: 20, favorited: "1" } });
      }
      if (!tabIsLatest(token)) return;
      setListData({ items: d?.items || [], total: d?.total || 0 });
    } catch (e) {
      if (tabIsLatest(token)) message.error(e.message);
    } finally {
      if (tabIsLatest(token)) setListLoading(false);
    }
  }, [tabBegin, tabIsLatest, isSelf, message, tab, uid]);

  useEffect(() => {
    loadTab();
  }, [loadTab, tabKey]);

  const toggleFollow = async () => {
    if (followBusy) return;
    setFollowBusy(true);
    try {
      const r = await API.post(`/community/users/${uid}/follow`);
      setFollowing(Boolean(r?.following));
      setData((prev) => (prev ? { ...prev, stats: { ...prev.stats, followers: r?.followers ?? prev.stats.followers } } : prev));
      message.success(r?.following ? "已关注" : "已取消关注");
    } catch (e) {
      message.error(e.message);
    } finally {
      setFollowBusy(false);
    }
  };

  // 打开与某人的私聊：复用聊天房间的「单聊唯一」语义，重复点不会建出两个房间
  const startChat = async () => {
    try {
      const r = await API.post("/chatroom/rooms", { type: "single", user_id: uid });
      navigate(`/messages/${r.id}`);
    } catch (e) {
      message.error(e.message);
    }
  };

  if (loading && !data) {
    return (
      <div className="oo-page">
        <div className="oo-panel" style={{ padding: 20 }}>
          <Skeleton avatar active paragraph={{ rows: 3 }} />
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="oo-page">
        <PageHeader title="个人主页" />
        <div className="oo-panel" style={{ padding: "48px 20px" }}>
          <Empty description="用户不存在或已停用" />
        </div>
      </div>
    );
  }

  const stats = data?.stats || {};

  return (
    <div className="oo-page">
      <PageHeader
        title={isSelf ? "我的主页" : "个人主页"}
        tags={
          <>
            {Number(data?.role) >= 1000 ? <Tag color="purple">超级管理员</Tag> : null}
            {Number(data?.role) >= 100 && Number(data?.role) < 1000 ? <Tag color="gold">管理员</Tag> : null}
            {isSelf ? <Tag>这是你的对外形象</Tag> : null}
          </>
        }
        extra={
          isSelf ? (
            <>
              <Button icon={<KeyOutlined />} onClick={() => navigate("/token")}>我的令牌</Button>
              <Button type="primary" icon={<EditOutlined />} onClick={() => navigate("/profile")}>
                编辑公开资料
              </Button>
              <Tooltip title="刷新主页数据">
                <Button icon={<ReloadOutlined />} onClick={() => { load(); setTabKey((k) => k + 1); }} aria-label="刷新" />
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                type={following ? "default" : "primary"}
                icon={<UserAddOutlined />}
                loading={followBusy}
                onClick={toggleFollow}
              >
                {following ? "已关注" : "关注"}
              </Button>
              <Button icon={<MessageOutlined />} onClick={startChat}>发私信</Button>
            </>
          )
        }
      />

      {/* 头部资料 + 统计条：统计内嵌在此处，紧贴身份信息，不抢占内容区 */}
      <div className="oo-panel" style={{ padding: "16px 18px" }}>
        <div className="oo-profile-head">
          <UserAvatar user={{ ...data, avatar_url: data?.avatar_url }} size={72} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="oo-profile-name">{data?.display_name || data?.username}</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>@{data?.username}</div>
            {data?.bio ? <div className="oo-profile-bio">{data.bio}</div> : null}
            <div className="oo-profile-links">
              {data?.location ? (
                <span><EnvironmentOutlined /> {data.location}</span>
              ) : null}
              {data?.website ? (
                // 存储型 XSS 防护：website 是用户可编辑字段，直接放进 href 时
                // 填 `javascript:...` 就能让访客在本站上下文执行脚本。
                // 复用 Markdown 的 safeHref（协议白名单：http/https/mailto/相对路径），
                // 非法的一律当纯文本展示 —— 不隐藏信息，但绝不点得动。
                (() => {
                  const href = safeHref(data.website);
                  return href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener">
                      <LinkOutlined /> {data.website}
                    </a>
                  ) : (
                    <span title="该链接协议不被支持，仅作展示">
                      <LinkOutlined /> {data.website}
                    </span>
                  );
                })()
              ) : null}
              <span><ClockCircleOutlined /> 加入于 {fmtDate(data?.created_time, "YYYY-MM-DD")}</span>
            </div>
            <StatsStrip
              stats={stats}
              onJump={(key) => {
                // 就地锚点切换下方列表，而不是跳走
                setTab(key === "likes" ? "posts" : key);
              }}
            />
          </div>
        </div>
      </div>

      {/* 仅自己可见：用量概览（公开主页不显示余额/调用量） */}
      {isSelf && stats.usage ? (
        <div className="oo-stats-cards">
          <StatCard label="累计调用" value={stats.usage.request_count ?? 0} suffix="次" hint="账户维度（仅自己可见）" />
          <StatCard label="发帖" value={stats.posts} suffix="篇" />
          <StatCard label="获赞" value={stats.likes_received} suffix="次" hint="被其他用户点赞" />
          <StatCard
            label="最近登录"
            value={stats.usage.last_login_time ? fmtDate(stats.usage.last_login_time, "MM-DD HH:mm") : "—"}
            hint="账号安全"
          />
        </div>
      ) : null}

      <div className="oo-panel">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: "posts", label: `帖子 ${stats.posts ?? 0}` },
            ...(isSelf ? [{ key: "favorites", label: `收藏 ${stats.favorites ?? 0}` }] : []),
            { key: "following", label: `关注 ${stats.following ?? 0}` },
            { key: "followers", label: `粉丝 ${stats.followers ?? 0}` },
          ]}
          tabBarStyle={{ padding: "0 14px", marginBottom: 0 }}
        />
        <div style={{ padding: "4px 0 10px" }}>
          {tab === "following" || tab === "followers" || tab === "favorites" ? (
            <UserList items={listData.items} loading={listLoading} empty={tab === "favorites" ? "还没有收藏的帖子" : "还没有用户"} />
          ) : (
            <PostList
              items={listData.items}
              loading={listLoading}
              empty={isSelf ? "你还没有发过帖子" : "TA 还没有发过帖子"}
              onOpen={(p) => navigate(`/community/${p.id}`)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 关注/粉丝列表：紧凑行（头像 + 名字 + 简介 + 关注按钮状态） */
function UserList({ items, loading, empty }) {
  if (loading) return <div style={{ padding: 20 }}><Skeleton active paragraph={{ rows: 2 }} /></div>;
  if (!items.length) return <div style={{ padding: "32px 0" }}><Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>;
  return (
    <div>
      {items.map((u) => (
        <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
          <Link to={`/u/${u.id}`} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, color: "inherit" }}>
            <UserAvatar user={u} size={34} />
            <div style={{ minWidth: 0 }}>
              <div className="oo-truncate" style={{ fontSize: 13, fontWeight: 500 }}>{u.display_name || u.username}</div>
              {u.bio ? <div className="oo-truncate" style={{ fontSize: 12, color: "var(--ink-3)" }}>{u.bio}</div> : null}
            </div>
          </Link>
          {u.followed ? <Text type="secondary" style={{ fontSize: 12 }}>已关注</Text> : null}
        </div>
      ))}
    </div>
  );
}
