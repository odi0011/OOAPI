// 社区大厅 —— 话题筛选 + 信息流 + 发帖
// ---------------------------------------------------------------------------
// 骨架属 C 类（双栏流式阅读）：主信息流 + 侧栏（热榜/公告/快捷发帖）。
// **宽屏也不拉满**：单行过长会让视线回行困难（Gemini 第 1.C 点）。
// 列表本身是单列列表式（见 components/PostList），不是卡片瀑布流。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button, Select, Input, Segmented, Tag, Space, Empty, Skeleton, App as AntApp, Tooltip, Alert, Modal, Form, List,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, FireOutlined, ClockCircleOutlined, StarOutlined,
  TeamOutlined, TagsOutlined, SearchOutlined, NotificationOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import PostList from "../components/PostList";
import UserAvatar from "../components/UserAvatar";
import GameZone from "../components/GameZone";
import { fmtCompact } from "../components/Charts";

export default function CommunityPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user, status } = useApp();
  const { begin, isLatest } = useLatest();
  const [params, setParams] = useSearchParams();

  const topicId = Number(params.get("topic_id")) || 0;
  const sort = params.get("sort") === "hot" ? "hot" : "new";
  const feed = ["all", "following", "favorited"].includes(params.get("feed") || "") ? params.get("feed") : "all";
  // 板块：讨论区 / 小游戏（小游戏是社区内的一个板块；?room= 分享链接自动进小游戏）
  const board = params.get("board") === "games" || params.get("room") ? "games" : "posts";

  const [topics, setTopics] = useState([]);
  const [posts, setPosts] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [postOpen, setPostOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [form] = Form.useForm();
  const [hotPosts, setHotPosts] = useState([]);

  const patchParams = (patch) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null || v === "" || v === "all" || (k === "sort" && v === "new")) next.delete(k);
          else next.set(k, String(v));
        }
        return next;
      },
      { replace: true }
    );
    setPage(1);
  };

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const data = await API.get("/community/posts", {
        params: {
          p: page,
          page_size: 20,
          topic_id: topicId || undefined,
          sort,
          q: keyword || undefined,
          following: feed === "following" ? 1 : undefined,
          favorited: feed === "favorited" ? 1 : undefined,
        },
      });
      if (!isLatest(token)) return;
      setPosts({ items: data?.items || [], total: data?.total || 0 });
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "加载失败");
        message.error(e.message);
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, isLatest, message, page, topicId, sort, keyword, feed]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    API.get("/community/topics")
      .then((d) => setTopics(Array.isArray(d) ? d : []))
      .catch(() => setTopics([]));
    // 侧栏热榜：按最热取 5 条（与主列表同一接口，不同排序，口径一致）
    API.get("/community/posts", { params: { p: 1, page_size: 5, sort: "hot" } })
      .then((d) => setHotPosts(d?.items || []))
      .catch(() => setHotPosts([]));
  }, []);

  const submitPost = async () => {
    if (posting) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setPosting(true);
    try {
      const r = await API.post("/community/posts", {
        title: v.title,
        content: v.content,
        topic_id: v.topic_id,
        media_ids: [],
      });
      message.success("发布成功");
      setPostOpen(false);
      form.resetFields();
      navigate(`/community/${r.id}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setPosting(false);
    }
  };

  const announce = status?.announcement;
  const announceEnabled = status?.announcement_enabled === true || status?.announcement_enabled === "true";

  // 切换板块：离开小游戏时清掉 room 参数（否则刷新又回到对局）
  const switchBoard = (v) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === "games") next.set("board", "games");
        else {
          next.delete("board");
          next.delete("room");
        }
        return next;
      },
      { replace: true }
    );
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="社区"
        tags={board === "games" ? <Tag>联机对战</Tag> : <Tag>{posts.total} 篇讨论</Tag>}
        extra={
          <>
            <Segmented
              value={board}
              onChange={switchBoard}
              options={[
                { value: "posts", label: "讨论区" },
                { value: "games", label: "小游戏" },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新" aria-label="刷新社区" />
            {board === "posts" ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setPostOpen(true); }}>
                发帖
              </Button>
            ) : null}
          </>
        }
      />

      {board === "games" ? (
        <GameZone />
      ) : (
        <>
      {/* 骨架 C：主信息流 + 侧栏（不拉满宽度） */}
      <div className="oo-read-shell">
        <div>
          <div className="oo-panel" style={{ marginBottom: 0 }}>
            <div className="oo-toolbar">
              <Segmented
                value={sort}
                onChange={(v) => patchParams({ sort: v })}
                options={[
                  { value: "new", label: "最新", icon: <ClockCircleOutlined /> },
                  { value: "hot", label: "最热", icon: <FireOutlined /> },
                ]}
              />
              <Select
                value={feed}
                onChange={(v) => patchParams({ feed: v })}
                style={{ width: 130 }}
                options={[
                  { value: "all", label: "全部讨论" },
                  { value: "following", label: "只看关注" },
                  { value: "favorited", label: "我的收藏" },
                ]}
              />
              <Select
                value={topicId || undefined}
                onChange={(v) => patchParams({ topic_id: v || "" })}
                allowClear
                placeholder="全部话题"
                style={{ width: 150 }}
                options={topics.map((t) => ({ value: t.id, label: `${t.icon || ""} ${t.name}`.trim() }))}
              />
              <Input.Search
                placeholder="搜索标题或正文"
                allowClear
                prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
                style={{ width: 200 }}
                onSearch={(v) => { setKeyword(v); setPage(1); }}
                onChange={(e) => { if (!e.target.value) { setKeyword(""); setPage(1); } }}
              />
            </div>

            {announceEnabled && announce ? (
              <Alert
                type={status?.announcement_level === "error" ? "error" : status?.announcement_level === "warning" ? "warning" : "info"}
                showIcon
                icon={<NotificationOutlined />}
                message={announce}
                style={{ margin: 12 }}
              />
            ) : null}

            {loadError ? (
              <Alert
                type="error"
                showIcon
                message="社区加载失败"
                description={loadError}
                action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
                style={{ margin: 12 }}
              />
            ) : null}

            <PostList
              items={posts.items}
              loading={loading}
              empty={
                feed === "following"
                  ? "你关注的人还没有发帖；去社区逛逛，关注几个感兴趣的作者"
                  : feed === "favorited"
                    ? "还没有收藏的帖子"
                    : topicId
                      ? "这个话题下还没有帖子，来发第一帖"
                      : "社区还没有内容，点击右上角「发帖」开启第一帖"
              }
              onOpen={(p) => navigate(`/community/${p.id}`)}
            />

            {posts.total > 20 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 14px", gap: 8 }}>
                <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
                <span style={{ fontSize: 12, color: "var(--ink-3)", alignSelf: "center" }}>
                  第 {page} / {Math.ceil(posts.total / 20)} 页
                </span>
                <Button size="small" disabled={page >= Math.ceil(posts.total / 20)} onClick={() => setPage((p) => p + 1)}>下一页</Button>
              </div>
            ) : null}
          </div>
        </div>

        {/* 侧栏：话题 / 热榜（复用 RankBar 的数据形态但用列表更省高度） */}
        <aside className="oo-read-aside">
          <div className="oo-aside-card">
            <div className="oo-section-title" style={{ marginBottom: 8 }}>
              <TagsOutlined /> 话题
            </div>
            <Space size={[6, 6]} wrap>
              <Tag
                style={{ cursor: "pointer" }}
                color={topicId ? undefined : "blue"}
                onClick={() => patchParams({ topic_id: "" })}
              >
                全部
              </Tag>
              {topics.map((t) => (
                <Tag
                  key={t.id}
                  style={{ cursor: "pointer" }}
                  color={topicId === t.id ? "blue" : undefined}
                  onClick={() => patchParams({ topic_id: t.id })}
                >
                  {t.icon ? `${t.icon} ` : ""}{t.name}
                  <span style={{ color: "var(--ink-3)", marginLeft: 4 }}>{t.post_count}</span>
                </Tag>
              ))}
            </Space>
          </div>

          <div className="oo-aside-card">
            <div className="oo-section-title" style={{ marginBottom: 6 }}>
              <FireOutlined /> 热门讨论
            </div>
            {hotPosts.length ? (
              <List
                size="small"
                split={false}
                dataSource={hotPosts}
                renderItem={(p, i) => (
                  <List.Item
                    style={{ padding: "5px 0", cursor: "pointer", border: 0 }}
                    onClick={() => navigate(`/community/${p.id}`)}
                  >
                    <div style={{ display: "flex", gap: 8, minWidth: 0, width: "100%" }}>
                      <span
                        className="oo-num"
                        style={{
                          width: 16,
                          flexShrink: 0,
                          color: i < 3 ? "var(--accent-ink)" : "var(--ink-3)",
                          fontWeight: i < 3 ? 600 : 400,
                          fontSize: 12,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span className="oo-truncate" style={{ fontSize: 12.5, flex: 1 }}>{p.title}</span>
                      <span className="oo-num" style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>
                        {fmtCompact(p.like_count || 0)}
                      </span>
                    </div>
                  </List.Item>
                )}
              />
            ) : (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>暂无数据</div>
            )}
          </div>

          <div className="oo-aside-card">
            <div className="oo-section-title" style={{ marginBottom: 8 }}>
              <TeamOutlined /> 我的社区
            </div>
            <Space direction="vertical" size={4} style={{ width: "100%", fontSize: 12.5 }}>
              <a onClick={() => navigate(`/u/${user?.id}`)} style={{ cursor: "pointer" }}>我的主页与发帖</a>
              <a onClick={() => patchParams({ feed: "favorited" })} style={{ cursor: "pointer" }}>我的收藏</a>
              <a onClick={() => patchParams({ feed: "following" })} style={{ cursor: "pointer" }}>我关注的人</a>
            </Space>
          </div>
        </aside>
      </div>
        </>
      )}

      <Modal
        title="发布新帖"
        open={postOpen}
        onOk={submitPost}
        confirmLoading={posting}
        onCancel={() => setPostOpen(false)}
        okText="发布"
        width={620}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="topic_id" label="话题" rules={[{ required: true, message: "请选择话题" }]}>
            <Select
              placeholder="选择话题（必选，便于检索与治理）"
              options={topics.map((t) => ({ value: t.id, label: `${t.icon || ""} ${t.name}`.trim() }))}
            />
          </Form.Item>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: "请输入标题" }, { max: 120, message: "标题最多 120 字" }]}
          >
            <Input placeholder="一句话说清问题或观点" maxLength={120} showCount />
          </Form.Item>
          <Form.Item
            name="content"
            label="正文"
            rules={[{ required: true, message: "请输入正文" }]}
            tooltip="支持 Markdown：代码块、列表、链接。贴报错日志请用代码块包裹，便于他人复制。"
          >
            <Input.TextArea rows={10} placeholder={"支持 Markdown。例如：\n\n```bash\ncurl -X POST ...\n```"} maxLength={20000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
