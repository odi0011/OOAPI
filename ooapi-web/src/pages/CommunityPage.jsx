// 社区大厅 —— 话题导轨 + 信息流 + 侧栏（第 79 批改版）
// ---------------------------------------------------------------------------
// 频道体系下线后，社区是站内唯一的公共讨论区，所以话题从下拉框升级成常驻导轨：
//   宽屏三栏（话题 / 信息流 / 我的社区·热榜），中屏话题收成信息流上方的横向标签，
//   窄屏隐藏侧栏。信息流**宽屏也不拉满**：单行过长会让视线回行困难（Gemini 第 1.C 点）。
// 列表本身是单列列表式（见 components/PostList），不是卡片瀑布流。
// 顶部的「发帖提示条」是低门槛入口：点开即发帖弹窗，已选话题会预填。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button, Select, Input, Segmented, Tag, App as AntApp, Tooltip, Alert, Modal, Form, Upload,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, FireOutlined, ClockCircleOutlined,
  TagsOutlined, NotificationOutlined, PictureOutlined, DeleteOutlined, MessageOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import PostList from "../components/PostList";
import UserAvatar from "../components/UserAvatar";
import { fmtCompact } from "../components/Charts";
import RichTextEditor from "../components/RichTextEditor";
import BuildLogCard from "../components/BuildLogCard";

export default function CommunityPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user, status } = useApp();
  const { begin, isLatest } = useLatest();
  const [params, setParams] = useSearchParams();

  const isAdmin = Number(user?.role) >= 100;
  const topicId = Number(params.get("topic_id")) || 0;
  const rawSort = params.get("sort");
  const sort = rawSort === "hot" ? "hot" : (isAdmin && rawSort === "deleted" ? "deleted" : "new");
  const feed = ["all", "following", "favorited"].includes(params.get("feed") || "") ? params.get("feed") : "all";

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
      const isDeletedTab = sort === "deleted" && isAdmin;
      const data = await API.get("/community/posts", {
        params: {
          p: page,
          page_size: 20,
          topic_id: topicId || undefined,
          sort: isDeletedTab ? undefined : sort,
          tab: isDeletedTab ? "deleted" : undefined,
          status: isDeletedTab ? 2 : undefined,
          q: keyword || undefined,
          following: !isDeletedTab && feed === "following" ? 1 : undefined,
          favorited: !isDeletedTab && feed === "favorited" ? 1 : undefined,
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
  }, [begin, isLatest, message, page, topicId, sort, keyword, feed, isAdmin]);

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

  // 发帖附图：**先上传到媒体库拿 id，再带 media_ids 发帖**。
  //
  // 黑盒测试发现这里原本硬编码 `media_ids: []`，整个弹窗没有任何上传入口 ——
  // 而**后端与展示层完全支持图片**（POST /api/media 可用、帖子详情会渲染 <img>、
  // 带 media_ids 的发帖 API 也正常）。所以纯前端缺一个上传控件，
  // 图片帖只能靠直接调 API 造出来。
  const [postMedia, setPostMedia] = useState([]); // [{ id, url, name }]
  const [uploading, setUploading] = useState(false);
  // 正文编辑器里是否还有图片在上传（由 RichTextEditor 上报，见其 onUploadingChange 注释）。
  // 必须单独记一份：编辑器那条上传路径在传输期间**不会**在 postMedia 里留占位项，
  // 只查 postMedia 是查不到它的。
  const [editorUploading, setEditorUploading] = useState(false);

  const uploadOne = async (file) => {
    // 前端先读成 dataURL（与站内对话一致，后端 POST /api/media 接受 dataUrl）
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("读取文件失败"));
      fr.readAsDataURL(file);
    });
    const r = await API.post("/media", { dataUrl, name: file.name, source: "community" });
    return { id: r.id, url: r.url || "", name: file.name };
  };

  // 多图**按选择顺序**入列，而不是按上传完成顺序。
  //
  // 修的问题（插画师人格实测三次、还附了对照片）：
  //   「我按 A、B、C 传的，显示出来是 C、B、A」——
  //   同一组图先后发两个帖，顺序甚至相反（她帖子里 `[119,120,121]` 与
  //   `[121,120,119]` 并存，就是同一批图的两个相反顺序）。
  //
  // 根因：Upload 的 `customRequest` 对多选文件是**并发**触发的，
  // 原实现 `setPostMedia(prev => [...prev, item])` 在**每张完成时**追加 ——
  // 哪张先传完就先入列，与用户选择顺序无关（大图/长图更慢，往往被排到后面）。
  //
  // 做法：**选中时就按顺序占好槽位**（先放占位项），完成后再按槽位回填。
  // 这样顺序只取决于选择顺序，与传输快慢完全无关；用户也能立刻看到
  // 「选了几张、什么顺序、哪张还在传」。
  const slotSeqRef = useRef(0);
  const nextSlot = () => {
    slotSeqRef.current += 1;
    return slotSeqRef.current;
  };
  /** 先占位（返回槽位号） */
  const addSlot = (name) => {
    const slot = nextSlot();
    setPostMedia((prev) => [...prev, { slot, id: 0, url: "", name, pending: true }]);
    return slot;
  };
  /** 按槽位回填上传结果 */
  const fillSlot = (slot, item) => {
    setPostMedia((prev) => prev.map((m) => (m.slot === slot ? { ...m, ...item, pending: false } : m)));
  };

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
      // 只提交**已上传完成**的图（占位项的 id 还是 0）；顺序即列表顺序。
      // 若还有在传的，拦下来提醒 —— 否则用户以为发了 5 张、实际只带上 3 张，
      // 而且**图不会报错**：媒体行已经落库（ref_count=0 的孤儿），帖子却是空的。
      //
      // 发帖弹窗一共有**三种**上传入口，两个来源都要查、缺一个就会漏
      // （实测帖 1233：图片还在传时点了发布，media_ids 为空，媒体 1993 成了孤儿）：
      //   ① 编辑器工具栏「插入图片」、② 编辑器里 Ctrl+V 粘贴
      //      —— 这两条都走 RichTextEditor.handleUploadFile，由 editorUploading 覆盖。
      //      注意它们在上传**进行中**时 postMedia 里还没有对应条目（占位项是上传成功
      //      回调 onMediaUploaded 里才加的），所以**只查 postMedia 是看不见这两条的**。
      //   ③ 「图片（可选）」区的 Upload —— 选中即 addSlot(pending:true)，由 postMedia 覆盖。
      //
      // 为什么**不**再扫正文里的 `![..](/api/media/<id>/raw)` 引用兜底：
      //   编辑器早就改成「只登记附件、不往正文插 markdown 图片语法」（见
      //   RichTextEditor.handleUploadFile 里的长注释），而 Markdown 渲染器也不解析图片
      //   语法（只把 `[..](..)` 渲染成链接）。所以正文里出现这种引用只可能是用户手输，
      //   据此拦截会误伤正常发帖，而图并不会因此丢失 —— 属于「发明产品口径」，故不做。
      //   以后若再加新的上传入口：请让它在传输开始前就 addSlot 或上报 uploading，
      //   并保留这个守卫，别删。
      if (postMedia.some((m) => m.pending) || editorUploading) {
        message.warning("还有图片在上传中，请稍等片刻再发布");
        setPosting(false);
        return;
      }
      const r = await API.post("/community/posts", {
        title: v.title,
        content: v.content,
        topic_id: v.topic_id,
        media_ids: postMedia.filter((m) => m.id).map((m) => m.id),
      });
      message.success("发布成功");
      setPostOpen(false);
      form.resetFields();
      setPostMedia([]);
      navigate(`/community/${r.id}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setPosting(false);
    }
  };

  // 全站公告：/api/status 下发的是 announcement + announcement_type（off/banner/modal）+ version。
  // 原实现读 announcement_enabled / announcement_level —— 这两个键 status 里根本没有，
  // 于是社区页的公告条**永远不显示**。关闭按版本记忆：管理员发新版本公告会重新出现。
  const announce = status?.announcement;
  const announceVersion = String(status?.announcement_version ?? 0);
  const [announceClosed, setAnnounceClosed] = useState(() => {
    try {
      return localStorage.getItem("ooapi-community-announce-closed") || "";
    } catch {
      return "";
    }
  });
  const showAnnounce = Boolean(announce) && status?.announcement_type !== "off" && announceClosed !== announceVersion;
  const closeAnnounce = () => {
    setAnnounceClosed(announceVersion);
    try {
      localStorage.setItem("ooapi-community-announce-closed", announceVersion);
    } catch { /* ignore */ }
  };

  const [summary, setSummary] = useState(null);
  useEffect(() => {
    API.get("/community/me/summary").then(setSummary).catch(() => setSummary(null));
  }, []);

  const totalPages = Math.max(1, Math.ceil(posts.total / 20));
  const topicTotal = topics.reduce((n, t) => n + (Number(t.post_count) || 0), 0);
  const openComposer = () => {
    form.resetFields();
    if (topicId) form.setFieldsValue({ topic_id: topicId });
    setPostOpen(true);
  };
  const activeTopic = topics.find((t) => t.id === topicId);

  const topicButton = (t) => {
    const active = t ? topicId === t.id : !topicId;
    return (
      <button
        key={t ? t.id : "all"}
        type="button"
        className={`oo-topic-item${active ? " is-active" : ""}`}
        aria-pressed={active}
        onClick={() => patchParams({ topic_id: t ? t.id : "" })}
      >
        <span className="oo-topic-icon" aria-hidden="true">{t ? t.icon || "#" : <TagsOutlined />}</span>
        <span className="oo-truncate">{t ? t.name : "全部话题"}</span>
        <span className="oo-topic-count">{t ? t.post_count : topicTotal}</span>
      </button>
    );
  };

  return (
    <div className="oo-page">
      <PageHeader
        title="社区"
        tags={<Tag>{posts.total} 篇{activeTopic ? ` · ${activeTopic.name}` : "讨论"}</Tag>}
        extra={
          <>
            <Tooltip title="刷新"><Button icon={<ReloadOutlined />} onClick={load} aria-label="刷新社区" /></Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={openComposer}>发帖</Button>
          </>
        }
      />

      {showAnnounce ? (
        <Alert type="info" showIcon icon={<NotificationOutlined />} message={announce} closable onClose={closeAnnounce} />
      ) : null}

      {/* 三栏：话题导轨 / 信息流 / 侧栏。窄屏话题导轨收成信息流上方的横向标签条 */}
      <div className="oo-read-shell oo-community-shell">
        <nav className="oo-topic-rail" aria-label="话题">
          <div className="oo-topic-rail-title">话题</div>
          {topicButton(null)}
          {topics.map(topicButton)}
        </nav>

        <div className="oo-community-feed">
          <button type="button" className="oo-compose-prompt" onClick={openComposer}>
            <UserAvatar user={user} size={34} />
            <span>分享经验、提问或发一段代码……{activeTopic ? `（发到「${activeTopic.name}」）` : ""}</span>
            <span className="oo-compose-prompt-icons" aria-hidden="true"><PictureOutlined /></span>
          </button>

          <div className="oo-topic-chips" role="group" aria-label="话题">
            {topicButton(null)}
            {topics.map(topicButton)}
          </div>

          <div className="oo-panel">
            <div className="oo-toolbar oo-community-toolbar">
              <Segmented
                value={feed}
                onChange={(v) => patchParams({ feed: v })}
                options={[
                  { value: "all", label: "全部" },
                  { value: "following", label: "关注的人" },
                  { value: "favorited", label: "我的收藏" },
                ]}
              />
              <div className="oo-toolbar-spacer" />
              <Segmented
                size="small"
                value={sort}
                onChange={(v) => patchParams({ sort: v })}
                options={[
                  { value: "new", label: "最新", icon: <ClockCircleOutlined /> },
                  { value: "hot", label: "最热", icon: <FireOutlined /> },
                  ...(isAdmin ? [{ value: "deleted", label: "已删除", icon: <DeleteOutlined /> }] : []),
                ]}
              />
              <Input.Search
                placeholder="搜索标题或正文"
                allowClear
                className="oo-community-search"
                onSearch={(v) => { setKeyword(v.trim()); setPage(1); }}
                onChange={(e) => { if (!e.target.value) { setKeyword(""); setPage(1); } }}
              />
            </div>

            {keyword ? (
              <div className="oo-community-filter-note">
                搜索「{keyword}」共 {posts.total} 条
                <button type="button" className="oo-link-btn" onClick={() => { setKeyword(""); setPage(1); }}>清除</button>
              </div>
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
                sort === "deleted"
                  ? "回收站为空，暂无已删除帖子"
                  : keyword
                    ? "没有搜到相关帖子，换个关键词试试"
                    : feed === "following"
                      ? "你关注的人还没有发帖；去社区逛逛，关注几个感兴趣的作者"
                      : feed === "favorited"
                        ? "还没有收藏的帖子"
                        : topicId
                          ? "这个话题下还没有帖子，来发第一帖"
                          : "社区还没有内容，点击右上角「发帖」开启第一帖"
              }
              onOpen={(p) => navigate(`/community/${p.id}`)}
              // 后端对普通用户是「status=1 或 自己发的」，所以**自己删掉/被隐藏的帖子
              // 仍会出现在自己的信息流里**（本意是作者能找回误删内容，见 PostList 的注释）。
              // 但必须把状态标出来 —— 否则用户看到自己刚删的帖还在列表里，会以为删除失败
              // 而反复删（三个独立人格都报过这条，分别描述为「删除没生效」「阴魂不散」）。
              showStatus
            />

            {posts.total > 20 ? (
              <div className="oo-community-pager">
                <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
                <span className="oo-num">第 {page} / {totalPages} 页</span>
                <Button size="small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="oo-read-aside">
          <div className="oo-aside-card oo-community-me">
            <div className="oo-community-me-head">
              <UserAvatar user={user} size={40} />
              <div style={{ minWidth: 0 }}>
                <div className="oo-truncate" style={{ fontWeight: 600 }}>{user?.display_name || user?.username}</div>
                <a className="oo-desc" onClick={() => navigate(`/u/${user?.id}`)} role="link" tabIndex={0}>我的主页 →</a>
              </div>
            </div>
            <div className="oo-community-me-stats">
              {[
                ["帖子", summary?.posts, () => navigate(`/u/${user?.id}`)],
                ["获赞", summary?.likes_received, () => navigate(`/u/${user?.id}`)],
                ["收藏", summary?.favorites, () => patchParams({ feed: "favorited" })],
                ["关注", summary?.following, () => patchParams({ feed: "following" })],
              ].map(([label, value, onClick]) => (
                <button key={label} type="button" onClick={onClick}>
                  <b className="oo-num">{value ?? "—"}</b>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <Button block icon={<MessageOutlined />} onClick={() => navigate("/messages")}>私聊与群聊</Button>
          </div>

          <div className="oo-aside-card">
            <div className="oo-section-title" style={{ marginBottom: 6 }}>
              <FireOutlined /> 热门讨论
            </div>
            {hotPosts.length ? (
              <ol className="oo-hot-list">
                {hotPosts.map((p, i) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => navigate(`/community/${p.id}`)}>
                      <span className={`oo-hot-rank${i < 3 ? " is-top" : ""}`}>{i + 1}</span>
                      <span className="oo-truncate">{p.title}</span>
                      <span className="oo-hot-count oo-num">{fmtCompact(p.like_count || 0)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>暂无数据</div>
            )}
          </div>

          {/* 平台修复进度（实时待办 + 维护调用流，公开数据） */}
          <BuildLogCard />
        </aside>
      </div>

      <Modal
        title="发布新帖"
        open={postOpen}
        onOk={submitPost}
        confirmLoading={posting}
        onCancel={() => setPostOpen(false)}
        okText="发布"
        width={780}
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
            tooltip="支持 Markdown 与所见即所得编辑：粗体、代码块、列表、引用。支持截图直接 Ctrl+V 粘贴上传。"
          >
            <RichTextEditor
              placeholder="分享你的见解、踩坑经验或代码片段... 支持 Markdown，可直接粘贴截图"
              minHeight={240}
              // 编辑器内的上传进行中状态要报上来，否则发布守卫看不见这条路径（见 submitPost）
              onUploadingChange={setEditorUploading}
              onMediaUploaded={(media) => {
                // 粘贴/插图路径：与点「添加图片」同一条队列，也按槽位占位，
                // 这样「先粘一张、再选两张」的顺序也是稳定的
                const slot = addSlot(media.name || "粘贴的图片");
                fillSlot(slot, media);
              }}
            />
          </Form.Item>
          {/* 附图：上传到媒体库后带 media_ids 发帖（后端与详情页本来就支持，只是缺这个入口） */}
          <Form.Item label="图片（可选，最多 9 张）">
            <Upload
              listType="picture-card"
              accept="image/*"
              multiple
              // uid 用**槽位号**（不是 media id）：上传完成前还没有 id，
              // 而用户此时就该看到「第几张、什么顺序」
              fileList={postMedia.map((m) => ({
                uid: `s${m.slot}`,
                name: m.name,
                status: m.pending ? "uploading" : "done",
                url: m.url,
              }))}
              customRequest={async ({ file, onSuccess, onError }) => {
                if (postMedia.length >= 9) {
                  message.warning("最多 9 张图片");
                  onError?.(new Error("too many"));
                  return;
                }
                // **先占位再上传**：顺序由选择顺序决定（见 addSlot 的注释）
                const slot = addSlot(file.name);
                setUploading(true);
                try {
                  const item = await uploadOne(file);
                  fillSlot(slot, item);
                  onSuccess?.(item);
                } catch (e) {
                  message.error(e.message || "图片上传失败");
                  setPostMedia((prev) => prev.filter((m) => m.slot !== slot));
                  onError?.(e);
                } finally {
                  setUploading(false);
                }
              }}
              onRemove={(_f, file) => {
                // 按槽位移除（fileList 的 uid 是 `s<slot>`）
                const slot = Number(String(file?.uid || "").replace(/^s/, "")) || 0;
                setPostMedia((prev) => prev.filter((m) => m.slot !== slot));
              }}
              disabled={uploading}
            >
              {postMedia.length >= 9 ? null : (
                <div style={{ fontSize: 12 }}>
                  <PictureOutlined />
                  <div style={{ marginTop: 4 }}>添加图片</div>
                </div>
              )}
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
