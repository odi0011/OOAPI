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
  Button, Input, Space, Tag, Skeleton, Empty, App as AntApp, Popconfirm, Tooltip, Divider, Image, Modal, Upload, Popover,
} from "antd";
import {
  LikeOutlined, LikeFilled, StarOutlined, StarFilled, UserAddOutlined, MessageOutlined,
  DeleteOutlined, EditOutlined, EyeOutlined, EyeInvisibleOutlined, PushpinOutlined, ArrowLeftOutlined,
  PictureOutlined, CloseOutlined, SmileOutlined, CodeOutlined, UndoOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import UserAvatar from "../components/UserAvatar";
import Markdown from "../components/Markdown";
import RichTextEditor from "../components/RichTextEditor";
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
  const [commentExpanded, setCommentExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  // 评论附图（用户要求「评论也要能带图」）。
  // 流程与发帖一致：**先上传到媒体库拿 id，再带 media_ids 发评论** ——
  // 字节进媒体库（有配额/去重/引用计数），评论行只存 id 列表。
  const [cMedia, setCMedia] = useState([]); // [{ id, url, name }]
  const [cUploading, setCUploading] = useState(false);
  // @ 联想：输入 @ 后列出匹配的用户（用户名或昵称）。
  //
  // 人格实测（插画师）：「@ 输入时没有联想下拉，我是手打全名的」；
  // 而且「社区里大家认昵称，输入框也不提示该写用户名还是昵称」。
  // 后端 /api/chatroom/users?q= 本来就支持按 username 或 display_name 模糊搜，
  // 直接复用（不新增接口）。
  const [mention, setMention] = useState({ open: false, kw: "", items: [] });

  /** 上传一张图到媒体库，返回 { id, url, name }（评论附图用） */
  const uploadCommentImage = async (file) => {
    // 前端先读成 dataURL（与发帖/站内对话一致，后端 POST /api/media 接受 dataUrl）
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("读取文件失败"));
      fr.readAsDataURL(file);
    });
    const r = await API.post("/media", { dataUrl, name: file.name, source: "community" });
    return { id: r.id, url: r.url || "", name: file.name };
  };

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

  // 私信作者：频道下线后，「看到帖子 → 找作者细聊」是私聊最主要的入口
  const messageAuthor = async () => {
    if (!post?.user_id) return;
    try {
      const r = await API.post(`/friends/${post.user_id}/chat`, {});
      navigate(`/messages/${r.room_id}`);
    } catch (e) {
      message.error(e.message);
    }
  };

  const sendComment = async () => {
    const content = input.trim();
    // 纯图评论也允许（「这张图你看」是很常见的用法），所以判据是「有字或有图」
    if ((!content && !cMedia.length) || sending) return;
    // 与发帖同一条守卫（见 CommunityPage 的 submitPost）：图还在传时 cMedia 里
    // 还没有条目，此时提交会把图**静默丢掉** —— 媒体行已经落库，评论却没带上，
    // 留下一个 ref_count=0 的孤儿。有正文时「发表评论」按钮是可点的，所以必须在这里拦。
    if (cUploading) {
      message.warning("还有图片在上传中，请稍等片刻再发布");
      return;
    }
    setSending(true);
    try {
      await API.post(`/community/posts/${postId}/comments`, {
        content,
        media_ids: cMedia.map((m) => m.id),
        // 扁平二级：回复二级评论时，parent_id 仍然挂它的一级父节点，
        // reply_to_user_id 用来渲染 @谁 —— 缩进因此恒为 1 级
        parent_id: replyTo?.parentId ?? 0,
        reply_to_user_id: replyTo?.userId || 0,
      });
      setInput("");
      setCMedia([]);
      setReplyTo(null);
      await loadComments();
      setPost((prev) => (prev ? { ...prev, comment_count: (prev.comment_count || 0) + 1 } : prev));
    } catch (e) {
      message.error(e.message);
    } finally {
      setSending(false);
    }
  };

  /** 评论附图上传（与发帖同一套：先入媒体库拿 id） */
  const pickCommentImage = async (file) => {
    if (cMedia.length >= 3) {
      message.warning("评论最多 3 张图片");
      return;
    }
    setCUploading(true);
    try {
      const item = await uploadCommentImage(file);
      setCMedia((prev) => [...prev, item]);
    } catch (e) {
      message.error(e.message || "图片上传失败");
    } finally {
      setCUploading(false);
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
      {/* 顶部直观导航栏：左侧放置返回与话题面包屑，右侧放置操作/管理按钮 */}
      <div className="oo-post-detail-topbar">
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate("/community")}
          className="oo-back-btn"
        >
          返回社区
        </Button>
        <span className="oo-topbar-sep">/</span>
        <Tag
          color="blue"
          style={{ margin: 0, cursor: "pointer", borderRadius: 4 }}
          onClick={() => navigate(`/community?topic_id=${post?.topic_id || ""}`)}
        >
          {post?.topic || "社区讨论"}
        </Tag>

        <div style={{ flex: 1 }} />

        {/* 右侧管理与编辑按钮 */}
        <Space size={8}>
          {isOwner && (
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
          )}
          {isAdmin && Number(post?.status) === 2 && (
            <Tooltip title="恢复帖子到正常发布状态">
              <Button
                type="primary"
                icon={<UndoOutlined />}
                onClick={() => moderate({ status: 1 })}
              >
                恢复帖子
              </Button>
            </Tooltip>
          )}
          {Number(post?.status) !== 2 && (isOwner || isAdmin) && (
            <Popconfirm title="确定删除该帖子？" onConfirm={removePost} okText="删除" okType="danger" cancelText="取消">
              <Button danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
          {isAdmin && Number(post?.status) !== 2 && (
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
          )}
        </Space>
      </div>

      <div className="oo-post-head-title">
        <h1 className="oo-page-title" style={{ margin: 0, fontSize: 20, lineHeight: 1.4 }}>
          {post?.title || "帖子"}
        </h1>
        {(post?.is_pinned || Number(post?.status) === 3 || Number(post?.status) === 2) && (
          <div className="oo-page-tags" style={{ marginTop: 6 }}>
            {post?.is_pinned ? <Tag color="orange">置顶</Tag> : null}
            {Number(post?.status) === 3 ? <Tag color="orange">已隐藏（仅你与管理员可见）</Tag> : null}
            {Number(post?.status) === 2 ? <Tag color="red">已删除（仅管理员可见）</Tag> : null}
          </div>
        )}
      </div>

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
                  <Space size={6} style={{ marginLeft: "auto" }}>
                    <Button size="small" icon={<MessageOutlined />} onClick={messageAuthor}>私信</Button>
                    <Button
                      size="small"
                      type={post?.author_followed ? "default" : "primary"}
                      icon={<UserAddOutlined />}
                      loading={acting}
                      onClick={toggleFollow}
                    >
                      {post?.author_followed ? "已关注" : "关注"}
                    </Button>
                  </Space>
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
                      // **必须同时给 width 与 height**。
                      // 人格实测（插画师，传了 700×2000 的长图）：
                      //   「我传的竖长条在详情页按 140×400 显示、比例没变形（这点对），
                      //     但三张图并排时中间那张高一截，整块图区被它拉长，
                      //     旁边留一大片空白。」
                      // 原因就是这里只给了 width，高度由原图比例决定 →
                      // 横图. 竖图. 方图混排时行高参差。
                      // 修法：固定 140×140 + objectFit:cover（缩略图统一裁成方），
                      // 想按原比例看完整图**点开预览**（灯箱本来就是按原比例的）。
                      <Image
                        key={m.id}
                        src={m.url}
                        alt=""
                        width={140}
                        height={140}
                        style={{ borderRadius: "var(--r-sm)", objectFit: "cover" }}
                      />
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

          {/* 评论区 */}
          <div className="oo-panel">
            <div style={{ padding: "16px 18px" }}>
              <div className="oo-section-title" style={{ marginBottom: 12 }}>
                评论 {post?.comment_count || 0}
              </div>

              {/* 现代折叠式评论卡片 (Sleek Collapsible Comment Composer) */}
              {/* 折叠条必须**看起来就能点**。
                  两个人格独立把这个当成 bug 报上来：
                    「帖子底下的评论框整个没了，只剩一行『友善交流…』的提示文字」
                    「F12 看 textarea 0 个、file input 0 个，那行提示是个 <span>」
                  他们都没意识到那行字是「点一下就会变成输入框」的折叠控件 ——
                  因为原实现是纯 div ＋ 一段浅灰文字，**没有任何可交互的视觉暗示**
                  （无边框、无光标、无按钮、无"点我"字样）。
                  功能是好的（实测点击后 textarea / 图片按钮 / 发表按钮全部出现），
                  但「功能在却没人发现」等于没有。这里补三件事：
                    ① role="button" + tabIndex + 键盘处理 → 键盘可达、读屏可识别；
                    ② 文案改成明确的动作邀请；
                    ③ 右侧给一个真的按钮，鼠标用户一眼看出能点。 */}
              <div className={`oo-comment-composer-card ${commentExpanded || input.trim() || replyTo || cMedia.length ? "is-expanded" : ""}`}>
                {!commentExpanded && !input.trim() && !replyTo && !cMedia.length ? (
                  <div
                    className="oo-comment-collapsed-bar"
                    role="button"
                    tabIndex={0}
                    aria-label="展开评论输入框"
                    onClick={() => {
                      setCommentExpanded(true);
                      setTimeout(() => document.querySelector(".oo-comment-raw-input")?.focus(), 50);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setCommentExpanded(true);
                        setTimeout(() => document.querySelector(".oo-comment-raw-input")?.focus(), 50);
                      }
                    }}
                  >
                    <UserAvatar user={me} size={32} />
                    <div className="oo-comment-input-pill">
                      <span>点这里写评论…（支持 Markdown，可直接粘贴截图）</span>
                      <div className="oo-comment-pill-actions">
                        <Tooltip title="添加图片"><PictureOutlined /></Tooltip>
                        <Tooltip title="快捷表情"><SmileOutlined /></Tooltip>
                        <Tooltip title="插入代码"><CodeOutlined /></Tooltip>
                      </div>
                    </div>
                    <Button size="small" type="primary" tabIndex={-1}>
                      写评论
                    </Button>
                  </div>
                ) : (
                  <div className="oo-comment-expanded-inner">
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <UserAvatar user={me} size={32} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {replyTo && (
                          <div className="oo-comment-reply-banner">
                            <span>正在回复 @{replyTo.name}</span>
                            <Button
                              type="text"
                              size="small"
                              icon={<CloseOutlined />}
                              style={{ fontSize: 10, padding: 0, height: 16, width: 16, lineHeight: 1 }}
                              onClick={() => setReplyTo(null)}
                            />
                          </div>
                        )}
                        <textarea
                          className="oo-comment-raw-input"
                          value={input}
                          onChange={(e) => {
                            const v = e.target.value;
                            setInput(v);
                            // 取光标前最后一个 @ 到光标之间的片段作为关键词；
                            // 含空格/换行就认为不在 @ 状态（避免把邮箱当提及，
                            // 与后端 @ 解析的规则保持一致：要求 @ 前是行首或空白）
                            const pos = e.target.selectionStart ?? v.length;
                            const before = v.slice(0, pos);
                            const m = before.match(/(?:^|[\s，。！？、,.!?])@([A-Za-z0-9_一-龥-]{0,32})$/);
                            if (!m) {
                              if (mention.open) setMention({ open: false, kw: "", items: [] });
                              return;
                            }
                            const kw = m[1];
                            setMention((prev) => ({ ...prev, open: true, kw }));
                            API.get("/chatroom/users", { params: { q: kw } })
                              .then((list) => {
                                const arr = Array.isArray(list) ? list : list?.items || [];
                                setMention((prev) => (prev.kw === kw ? { ...prev, items: arr.slice(0, 8) } : prev));
                              })
                              .catch(() => {});
                          }}
                          placeholder="友善发言。支持 Markdown 语法与图片（可直接 Ctrl+V 粘贴截图）..."
                          maxLength={2000}
                          onPaste={(e) => {
                            const items = Array.from(e.clipboardData?.items || []);
                            const img = items.find((it) => it.type.startsWith("image/"));
                            if (!img) return;
                            const f = img.getAsFile();
                            if (!f) return;
                            e.preventDefault();
                            pickCommentImage(f);
                          }}
                        />

                        {/* @ 联想下拉：点了就把「@用户名」补进正文。
                            用**用户名**而不是昵称 —— 后端的 @ 解析只认 username
                            （人格实测报过「写 @昵称 不产生通知」），
                            所以补全时直接给能生效的那个写法，并在右侧显示昵称帮助辨认。 */}
                        {mention.open && mention.items.length ? (
                          <div className="oo-mention-pop">
                            {mention.items.map((u) => (
                              <button
                                type="button"
                                key={u.id}
                                className="oo-mention-item"
                                onMouseDown={(e) => {
                                  // 用 mousedown 而不是 click：click 会在 textarea 失焦后才触发，
                                  // 那时光标位置已经不可靠
                                  e.preventDefault();
                                  const name = u.username || "";
                                  setInput((prev) =>
                                    prev.replace(
                                      /(^|[\s，。！？、,.!?])@([A-Za-z0-9_一-龥-]{0,32})$/,
                                      (_all, pre) => `${pre}@${name} `
                                    )
                                  );
                                  setMention({ open: false, kw: "", items: [] });
                                }}
                              >
                                <UserAvatar user={u} size={20} />
                                <span className="oo-mention-name">@{u.username}</span>
                                {u.display_name ? (
                                  <span className="oo-mention-nick">{u.display_name}</span>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        {/* 图片预览 */}
                        {Boolean(cMedia.length) && (
                          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                            {cMedia.map((m) => (
                              <div key={m.id} style={{ position: "relative" }}>
                                <img
                                  src={m.url}
                                  alt={m.name}
                                  style={{ width: 58, height: 58, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }}
                                />
                                <button
                                  type="button"
                                  aria-label="移除图片"
                                  onClick={() => setCMedia((prev) => prev.filter((x) => x.id !== m.id))}
                                  style={{
                                    position: "absolute", top: -6, right: -6, width: 18, height: 18,
                                    borderRadius: "50%", border: 0, cursor: "pointer", lineHeight: 1,
                                    background: "var(--ink)", color: "var(--surface)", fontSize: 11,
                                  }}
                                >
                                  <CloseOutlined />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 底栏工具 */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
                          <Space size={6}>
                            <Popover
                              content={
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4, width: 250 }}>
                                  {["😀", "😄", "🤣", "😊", "😍", "😎", "🤔", "👍", "👏", "🎉", "🔥", "💡", "🚀", "❤️", "✨", "💯"].map((emo) => (
                                    <span
                                      key={emo}
                                      style={{ fontSize: 18, cursor: "pointer", textAlign: "center", padding: 3 }}
                                      onClick={() => setInput((prev) => prev + emo)}
                                    >
                                      {emo}
                                    </span>
                                  ))}
                                </div>
                              }
                              trigger="click"
                            >
                              <Button size="small" type="text" icon={<SmileOutlined />}>表情</Button>
                            </Popover>

                            <Upload
                              accept="image/*"
                              multiple
                              showUploadList={false}
                              beforeUpload={(file) => {
                                pickCommentImage(file);
                                return false;
                              }}
                              disabled={cUploading || cMedia.length >= 3}
                            >
                              <Tooltip title={cMedia.length >= 3 ? "最多 3 张" : "添加图片（可直接粘贴截图）"}>
                                <Button size="small" type="text" icon={<PictureOutlined />} loading={cUploading}>
                                  图片
                                </Button>
                              </Tooltip>
                            </Upload>

                            <Tooltip title="插入代码块">
                              <Button
                                size="small"
                                type="text"
                                icon={<CodeOutlined />}
                                onClick={() => setInput((prev) => prev + "\n```javascript\n\n```\n")}
                              >
                                代码
                              </Button>
                            </Tooltip>
                          </Space>

                          <Space size={10}>
                            <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{input.length} / 2000</span>
                            <Button
                              size="small"
                              onClick={() => {
                                if (!input.trim() && !cMedia.length) {
                                  setCommentExpanded(false);
                                  setReplyTo(null);
                                } else {
                                  setInput("");
                                  setCMedia([]);
                                  setReplyTo(null);
                                  setCommentExpanded(false);
                                }
                              }}
                            >
                              取消
                            </Button>
                            <Button
                              type="primary"
                              size="small"
                              loading={sending}
                              disabled={(!input.trim() && !cMedia.length) || cUploading}
                              onClick={async () => {
                                await sendComment();
                                setCommentExpanded(false);
                              }}
                            >
                              发表评论
                            </Button>
                          </Space>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
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
                        setCommentExpanded(true);
                        setTimeout(() => document.querySelector(".oo-comment-raw-input")?.focus(), 50);
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
          <div className="oo-aside-card oo-community-me">
            <Link to={`/u/${post?.author?.id}`} className="oo-community-me-head" style={{ color: "inherit" }}>
              <UserAvatar user={post?.author} size={40} />
              <div style={{ minWidth: 0 }}>
                <div className="oo-truncate" style={{ fontWeight: 600 }}>{post?.author?.display_name || post?.author?.username}</div>
                <div className="oo-desc">@{post?.author?.username}</div>
              </div>
            </Link>
            {!isOwner && me ? (
              <div style={{ display: "flex", gap: 8 }}>
                <Button block type={post?.author_followed ? "default" : "primary"} icon={<UserAddOutlined />} loading={acting} onClick={toggleFollow}>
                  {post?.author_followed ? "已关注" : "关注"}
                </Button>
                <Button block icon={<MessageOutlined />} onClick={messageAuthor}>私信</Button>
              </div>
            ) : null}
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.9 }}>
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
        width={780}
      >
        <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={120} showCount style={{ marginBottom: 12 }} />
        <RichTextEditor value={editContent} onChange={setEditContent} minHeight={260} />
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
          {/* 评论附图：小尺寸缩略图（评论是次要内容，不该用帖子那种大图占满屏），
              点开用 antd Image 的预览看大图 */}
          {Array.isArray(comment.media) && comment.media.length ? (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {comment.media.map((m) => (
                <Image
                  key={m.id}
                  src={m.url}
                  alt="评论图片"
                  width={88}
                  height={88}
                  style={{ objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }}
                />
              ))}
            </div>
          ) : null}
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
                    {/* 二级评论的附图（比一级再小一点，保持层级感） */}
                    {Array.isArray(c.media) && c.media.length ? (
                      <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                        {c.media.map((m) => (
                          <Image
                            key={m.id}
                            src={m.url}
                            alt="评论图片"
                            width={68}
                            height={68}
                            style={{ objectFit: "cover", borderRadius: 5, border: "1px solid var(--line)" }}
                          />
                        ))}
                      </div>
                    ) : null}
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
