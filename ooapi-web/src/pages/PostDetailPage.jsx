// 帖子详情 —— 正文 + 扁平二级评论 + 点赞/收藏/关注
// ---------------------------------------------------------------------------
// 评论为何强制「扁平二级」（Gemini 第 9.2 点）：
//   开发者习惯引用回复，按常规 Tree 缩进渲染到 3 层以上时，
//   窄屏与移动端的正文可用宽度会被缩进吃成细条。
//   所以：所有子评论平铺在一级评论内，缩进**恒为 1 级**，
//   上下文靠行首内嵌「@被回复者」标明（数据库里由 reply_to_user_id 承载）。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  Button, Input, Space, Tag, Skeleton, Empty, App as AntApp, Popconfirm, Tooltip, Divider, Image, Modal,
} from "antd";
import {
  LikeOutlined, LikeFilled, StarOutlined, StarFilled, UserAddOutlined, MessageOutlined,
  DeleteOutlined, EditOutlined, EyeOutlined, EyeInvisibleOutlined, PushpinOutlined, ArrowLeftOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import Markdown from "../components/Markdown";
import { relTime } from "../components/PostList";
import { fmtCompact } from "../components/Charts";
import { fmtDate } from "../services/format";

export default function PostDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user: me } = useApp();
  // **两个独立的竞态令牌**（同一个会让其中一个恒被自己作废）：
  // 帖子与评论是两条并行请求，各自被重试/刷新独立触发。共用一个 useLatest 时，
  // 同一 effect 里先发的 loadPost 拿到 token 1、后发的 loadComments 拿到 token 2，
  // 于是 isLatest(1) 恒为假 → setPost 与 finally 里的 setLoading(false) 都不执行，
  // 页面**永远停在骨架屏**（实测反馈：打开任意 /community/:id 都出不来内容）。
  //
  // ⚠️ **必须解构出 begin/isLatest，不能把整个对象放进 useCallback 的依赖数组**。
  // useLatest 返回的是 `{ begin, isLatest }` —— 那是一个**每次渲染都新建的对象**，
  // 而 begin/isLatest 本身是稳定的 useCallback。把对象当依赖 →
  // useCallback 每次都重新创建 → useEffect([loadPost]) 每次都重跑 →
  // setState → 再渲染 → **无限请求循环**。
  // 黑盒测试实测：这一处让帖子详情页跑到 79.6 req/s、个人主页 117.8 req/s，
  // 且 404 的帖子/用户页会永远停在骨架屏（loading 在循环里被反复置真）。
  // 对照：CommunityPage / NotificationsPage / MessagesPage 用的是解构写法，所以没这个问题。
  const { begin: postBegin, isLatest: postIsLatest } = useLatest();
  const { begin: commentBegin, isLatest: commentIsLatest } = useLatest();

  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [comments, setComments] = useState([]);
  const [cLoading, setCLoading] = useState(false);
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState(null); // { id, userId, name } —— 回复某人
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  const postId = Number(id) || 0;
  const isAdmin = me?.role >= 100;
  const isOwner = Boolean(post && me && post.user_id === me.id);

  const loadPost = useCallback(async () => {
    if (!postId) return;
    const token = postBegin();
    setLoading(true);
    setNotFound(false);
    try {
      const d = await API.get(`/community/posts/${postId}`);
      if (!postIsLatest(token)) return;
      setPost(d);
    } catch (e) {
      if (postIsLatest(token)) {
        if (e.status === 404) setNotFound(true);
        else message.error(e.message);
      }
    } finally {
      // finally 也要判 isLatest，但**必须保证首次加载一定会关闭 loading**：
      // 之前的问题正是这里被判假而永不执行。现在 token 不再被兄弟请求顶掉，
      // 正常路径下这里一定成立。
      if (postIsLatest(token)) setLoading(false);
    }
  }, [postBegin, postIsLatest, message, postId]);

  const loadComments = useCallback(async () => {
    if (!postId) return;
    const token = commentBegin();
    setCLoading(true);
    try {
      const d = await API.get(`/community/posts/${postId}/comments`, { params: { p: 1, page_size: 200 } });
      if (!commentIsLatest(token)) return;
      setComments(d?.items || []);
    } catch (e) {
      if (commentIsLatest(token)) message.error(e.message);
    } finally {
      if (commentIsLatest(token)) setCLoading(false);
    }
  }, [commentBegin, commentIsLatest, message, postId]);

  useEffect(() => {
    loadPost();
    loadComments();
  }, [loadPost, loadComments]);

  const react = async (kind) => {
    if (acting) return;
    setActing(true);
    try {
      const r = await API.post(`/community/posts/${postId}/${kind === "like" ? "like" : "favorite"}`);
      setPost((prev) =>
        prev
          ? {
              ...prev,
              liked: kind === "like" ? Boolean(r.active) : prev.liked,
              favorited: kind === "favorite" ? Boolean(r.active) : prev.favorited,
              like_count: kind === "like" ? r.count : prev.like_count,
              favorite_count: kind === "favorite" ? r.count : prev.favorite_count,
            }
          : prev
      );
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const toggleFollow = async () => {
    if (!post || acting) return;
    setActing(true);
    try {
      const r = await API.post(`/community/users/${post.user_id}/follow`);
      setPost((prev) => (prev ? { ...prev, author_followed: Boolean(r.following) } : prev));
      message.success(r.following ? "已关注" : "已取消关注");
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const sendComment = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await API.post(`/community/posts/${postId}/comments`, {
        content,
        // 扁平二级：回复二级评论时，parent_id 仍然挂它的一级父节点，
        // reply_to_user_id 用来渲染 @谁 —— 缩进因此恒为 1 级
        parent_id: replyTo?.parentId ?? 0,
        reply_to_user_id: replyTo?.userId || 0,
      });
      setInput("");
      setReplyTo(null);
      await loadComments();
      setPost((prev) => (prev ? { ...prev, comment_count: (prev.comment_count || 0) + 1 } : prev));
    } catch (e) {
      message.error(e.message);
    } finally {
      setSending(false);
    }
  };

  const removePost = async () => {
    try {
      await API.del(`/community/posts/${postId}`);
      message.success("已删除");
      navigate("/community");
    } catch (e) {
      message.error(e.message);
    }
  };

  const moderate = async (patch) => {
    try {
      await API.post(`/community/posts/${postId}/moderate`, patch);
      message.success("已处理");
      await loadPost();
    } catch (e) {
      message.error(e.message);
    }
  };

  const saveEdit = async () => {
    if (!editTitle.trim() || !editContent.trim()) {
      message.warning("标题与正文都不能为空");
      return;
    }
    try {
      await API.put(`/community/posts/${postId}`, { title: editTitle, content: editContent });
      message.success("已保存");
      setEditOpen(false);
      await loadPost();
    } catch (e) {
      message.error(e.message);
    }
  };

  if (loading && !post) {
    return (
      <div className="oo-page">
        <div className="oo-panel" style={{ padding: 20 }}>
          <Skeleton active paragraph={{ rows: 5 }} />
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="oo-page">
        <PageHeader title="帖子" />
        <div className="oo-panel" style={{ padding: "48px 20px" }}>
          <Empty description="帖子不存在或已被删除" />
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Button onClick={() => navigate("/community")}>返回社区</Button>
          </div>
        </div>
      </div>
    );
  }

  // 评论组织成「一级 + 其下所有回复平铺」
  const roots = comments.filter((c) => !c.parent_id);
  const childrenOf = (pid) => comments.filter((c) => Number(c.parent_id) === Number(pid));

  return (
    <div className="oo-page">
      <PageHeader
        title={post?.title || "帖子"}
        tags={
          <>
            {post?.is_pinned ? <Tag color="orange">置顶</Tag> : null}
            {Number(post?.status) === 3 ? <Tag color="orange">已隐藏（仅你与管理员可见）</Tag> : null}
            {post?.topic ? <Tag>{post.topic}</Tag> : null}
          </>
        }
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/community")}>返回社区</Button>
            {isOwner ? (
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  setEditTitle(post.title);
                  setEditContent(post.content || "");
                  setEditOpen(true);
                }}
              >
                编辑
              </Button>
            ) : null}
            {isOwner || isAdmin ? (
              <Popconfirm title="确定删除该帖子？" onConfirm={removePost} okText="删除" okType="danger" cancelText="取消">
                <Button danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            ) : null}
            {isAdmin ? (
              <>
                <Tooltip title={Number(post?.status) === 3 ? "取消隐藏" : "隐藏（比删除轻，可恢复）"}>
                  <Button
                    icon={Number(post?.status) === 3 ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                    onClick={() => moderate({ status: Number(post?.status) === 3 ? 1 : 3 })}
                  >
                    {Number(post?.status) === 3 ? "取消隐藏" : "隐藏"}
                  </Button>
                </Tooltip>
                <Tooltip title={post?.is_pinned ? "取消置顶" : "置顶"}>
                  <Button
                    icon={<PushpinOutlined />}
                    onClick={() => moderate({ is_pinned: post?.is_pinned ? 0 : 1 })}
                  >
                    {post?.is_pinned ? "取消置顶" : "置顶"}
                  </Button>
                </Tooltip>
              </>
            ) : null}
          </>
        }
      />

      <div className="oo-read-shell">
        <div>
          {/* 正文 */}
          <div className="oo-panel" style={{ marginBottom: "var(--sp-3)" }}>
            <div style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Link to={`/u/${post?.author?.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "inherit" }}>
                  <UserAvatar user={post?.author} size={34} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{post?.author?.display_name || post?.author?.username}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {fmtDate(post?.created_time, "YYYY-MM-DD HH:mm")}
                      {post?.updated_time && post.updated_time !== post.created_time ? " · 已编辑" : ""}
                    </div>
                  </div>
                </Link>
                {!isOwner && me ? (
                  <Button
                    size="small"
                    type={post?.author_followed ? "default" : "primary"}
                    icon={<UserAddOutlined />}
                    loading={acting}
                    onClick={toggleFollow}
                    style={{ marginLeft: "auto" }}
                  >
                    {post?.author_followed ? "已关注" : "关注"}
                  </Button>
                ) : null}
              </div>

              <Divider style={{ margin: "12px 0" }} />

              <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>
                <Markdown text={post?.content || ""} />
              </div>

              {Array.isArray(post?.media) && post.media.length ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <Image.PreviewGroup>
                    {post.media.map((m) => (
                      <Image key={m.id} src={m.url} alt="" width={140} style={{ borderRadius: "var(--r-sm)", objectFit: "cover" }} />
                    ))}
                  </Image.PreviewGroup>
                </div>
              ) : null}

              <Divider style={{ margin: "12px 0" }} />

              <Space size={4}>
                <Button
                  type="text"
                  size="small"
                  icon={post?.liked ? <LikeFilled style={{ color: "var(--accent)" }} /> : <LikeOutlined />}
                  disabled={acting}
                  onClick={() => react("like")}
                >
                  {post?.like_count || 0}
                </Button>
                <Button
                  type="text"
                  size="small"
                  icon={post?.favorited ? <StarFilled style={{ color: "var(--orange)" }} /> : <StarOutlined />}
                  disabled={acting}
                  onClick={() => react("favorite")}
                >
                  {post?.favorite_count || 0}
                </Button>
                <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 6 }}>
                  <MessageOutlined /> {fmtCompact(post?.comment_count || 0)}
                  {" · "}
                  <EyeOutlined /> {fmtCompact(post?.view_count || 0)}
                </span>
              </Space>
            </div>
          </div>

          {/* 评论：扁平二级 */}
          <div className="oo-panel">
            <div style={{ padding: "12px 16px" }}>
              <div className="oo-section-title" style={{ marginBottom: 10 }}>
                评论 {post?.comment_count || 0}
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <UserAvatar user={me} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {replyTo ? (
                    <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>
                      回复 <span className="oo-comment-at">@{replyTo.name}</span>
                      <Button type="link" size="small" onClick={() => setReplyTo(null)}>取消</Button>
                    </div>
                  ) : null}
                  <Input.TextArea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="友善发言。支持 Markdown；贴日志请用代码块包裹。"
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    maxLength={2000}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                    <Button type="primary" size="small" loading={sending} disabled={!input.trim()} onClick={sendComment}>
                      发表评论
                    </Button>
                  </div>
                </div>
              </div>

              {cLoading && !comments.length ? (
                <Skeleton active paragraph={{ rows: 3 }} />
              ) : !roots.length ? (
                <Empty description="还没有评论，来说两句" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div>
                  {roots.map((c) => (
                    <CommentItem
                      key={c.id}
                      comment={c}
                      me={me}
                      isAdmin={isAdmin}
                      onReply={(target) => {
                        setReplyTo(target);
                        // 聚焦输入框：回复是「立刻打字」的动作，不该再点一次
                        document.querySelector(".oo-panel textarea")?.focus();
                      }}
                      onChanged={loadComments}
                      children={childrenOf(c.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="oo-read-aside">
          <div className="oo-aside-card">
            <div className="oo-section-title" style={{ marginBottom: 8 }}>关于本帖</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.9 }}>
              <div>作者：{post?.author?.display_name || post?.author?.username}</div>
              <div>发布于：{fmtDate(post?.created_time, "YYYY-MM-DD HH:mm")}</div>
              <div>浏览：{fmtCompact(post?.view_count || 0)}</div>
            </div>
          </div>
        </aside>
      </div>

      <Modal
        title="编辑帖子"
        open={editOpen}
        onOk={saveEdit}
        onCancel={() => setEditOpen(false)}
        okText="保存"
        width={620}
      >
        <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={120} showCount style={{ marginBottom: 10 }} />
        <Input.TextArea value={editContent} onChange={(e) => setEditContent(e.target.value)} autoSize={{ minRows: 8, maxRows: 20 }} />
      </Modal>
    </div>
  );
}

/** 单条评论：一级评论 + 其下平铺的回复（缩进恒为 1 级） */
function CommentItem({ comment, me, isAdmin, onReply, onChanged, children = [] }) {
  const { message } = AntApp.useApp();
  const [liked, setLiked] = useState(Boolean(comment.liked));
  const [likes, setLikes] = useState(Number(comment.like_count) || 0);
  const [busy, setBusy] = useState(false);
  const isMine = Boolean(me && me.id === comment.user_id);

  const like = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await API.post(`/community/comments/${comment.id}/like`);
      setLiked(Boolean(r.active));
      setLikes(r.count);
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await API.del(`/community/comments/${comment.id}`);
      message.success("已删除");
      onChanged?.();
    } catch (e) {
      message.error(e.message);
    }
  };

  return (
    <div style={{ padding: "9px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Link to={`/u/${comment.user_id}`} style={{ flexShrink: 0 }}>
          <UserAvatar user={comment.author} size={28} />
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link to={`/u/${comment.user_id}`} style={{ fontSize: 12.5, fontWeight: 550, color: "inherit" }}>
              {comment.author?.display_name || comment.author?.username || `用户 #${comment.user_id}`}
            </Link>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{relTime(comment.created_time)}</span>
            {Number(comment.status) === 2 ? <Tag>已删除</Tag> : null}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 3, wordBreak: "break-word" }}>
            {/* 扁平化后靠行首 @ 标明回复对象（而不是靠缩进层级） */}
            {comment.reply_to_user_id ? (
              <span className="oo-comment-at">@{comment.reply_to_name || `用户 #${comment.reply_to_user_id}`} </span>
            ) : null}
            <Markdown text={comment.content || ""} />
          </div>
          <Space size={10} style={{ marginTop: 4 }}>
            <Button
              type="text"
              size="small"
              icon={liked ? <LikeFilled style={{ color: "var(--accent)" }} /> : <LikeOutlined />}
              disabled={busy}
              onClick={like}
              style={{ fontSize: 12 }}
            >
              {likes || ""}
            </Button>
            <Button type="text" size="small" style={{ fontSize: 12 }} onClick={() => onReply({ id: comment.id, parentId: comment.id, userId: comment.user_id, name: comment.author?.display_name || comment.author?.username })}>
              回复
            </Button>
            {isMine || isAdmin ? (
              <Popconfirm title="删除这条评论？" onConfirm={remove} okText="删除" okType="danger" cancelText="取消">
                <Button type="text" size="small" danger style={{ fontSize: 12 }}>删除</Button>
              </Popconfirm>
            ) : null}
          </Space>

          {/* 子回复：平铺在此，缩进只有 1 级（不再嵌套） */}
          {children.length ? (
            <div className="oo-comment-children">
              {children.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 7 }}>
                  <Link to={`/u/${c.user_id}`} style={{ flexShrink: 0 }}>
                    <UserAvatar user={c.author} size={22} />
                  </Link>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <Link to={`/u/${c.user_id}`} style={{ fontSize: 12.5, fontWeight: 500, color: "inherit" }}>
                        {c.author?.display_name || c.author?.username || `用户 #${c.user_id}`}
                      </Link>
                      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{relTime(c.created_time)}</span>
                      {Number(c.status) === 2 ? <Tag>已删除</Tag> : null}
                    </div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 2, wordBreak: "break-word" }}>
                      {c.reply_to_user_id ? (
                        <span className="oo-comment-at">@{c.reply_to_name || `用户 #${c.reply_to_user_id}`} </span>
                      ) : null}
                      <Markdown text={c.content || ""} />
                    </div>
                    <Space size={10} style={{ marginTop: 2 }}>
                      <Button type="text" size="small" style={{ fontSize: 11.5 }} onClick={() => onReply({ id: c.id, parentId: c.parent_id, userId: c.user_id, name: c.author?.display_name || c.author?.username })}>
                        回复
                      </Button>
                      {me && me.id === c.user_id ? (
                        <Popconfirm
                          title="删除这条评论？"
                          onConfirm={async () => {
                            try {
                              await API.del(`/community/comments/${c.id}`);
                              message.success("已删除");
                              onChanged?.();
                            } catch (e) {
                              message.error(e.message);
                            }
                          }}
                          okText="删除"
                          okType="danger"
                          cancelText="取消"
                        >
                          <Button type="text" size="small" danger style={{ fontSize: 11.5 }}>删除</Button>
                        </Popconfirm>
                      ) : null}
                    </Space>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
