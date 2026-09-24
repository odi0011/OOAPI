// 社区大厅 —— 话题筛选 + 信息流 + 发帖
// ---------------------------------------------------------------------------
// 骨架属 C 类（双栏流式阅读）：主信息流 + 侧栏（热榜/公告/快捷发帖）。
// **宽屏也不拉满**：单行过长会让视线回行困难（Gemini 第 1.C 点）。
// 列表本身是单列列表式（见 components/PostList），不是卡片瀑布流。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button, Select, Input, Segmented, Tag, Space, Empty, Skeleton, App as AntApp, Tooltip, Alert, Modal, Form, List, Upload,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, FireOutlined, ClockCircleOutlined, StarOutlined,
  TeamOutlined, TagsOutlined, SearchOutlined, NotificationOutlined, PictureOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import PostList from "../components/PostList";
import UserAvatar from "../components/UserAvatar";
import { fmtCompact } from "../components/Charts";
import RichTextEditor from "../components/RichTextEditor";

export default function CommunityPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { user, status } = useApp();
  const { begin, isLatest } = useLatest();
  const [params, setParams] = useSearchParams();

  const topicId = Number(params.get("topic_id")) || 0;
  const sort = params.get("sort") === "hot" ? "hot" : "new";
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

  // 发帖附图：**先上传到媒体库拿 id，再带 media_ids 发帖**。
  //
  // 黑盒测试发现这里原本硬编码 `media_ids: []`，整个弹窗没有任何上传入口 ——
  // 而**后端与展示层完全支持图片**（POST /api/media 可用、帖子详情会渲染 <img>、
  // 带 media_ids 的发帖 API 也正常）。所以纯前端缺一个上传控件，
  // 图片帖只能靠直接调 API 造出来。
  const [postMedia, setPostMedia] = useState([]); // [{ id, url, name }]
  const [uploading, setUploading] = useState(false);

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
      // 若还有在传的，拦下来提醒 —— 否则用户以为发了 5 张、实际只带上 3 张。
      if (postMedia.some((m) => m.pending)) {
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

  const announce = status?.announcement;
  const announceEnabled = status?.announcement_enabled === true || status?.announcement_enabled === "true";

  return (
    <div className="oo-page">
      <PageHeader
        title="社区"
        tags={<Tag>{posts.total} 篇讨论</Tag>}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新" aria-label="刷新社区" />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setPostOpen(true); }}>
              发帖
            </Button>
          </>
        }
      />

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
              <Input
                placeholder="搜索标题或正文"
                allowClear
                prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
                style={{ width: 200 }}
                onPressEnter={(e) => { setKeyword(e.target.value); setPage(1); }}
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
              // 后端对普通用户是「status=1 或 自己发的」，所以**自己删掉/被隐藏的帖子
              // 仍会出现在自己的信息流里**（本意是作者能找回误删内容，见 PostList 的注释）。
              // 但必须把状态标出来 —— 否则用户看到自己刚删的帖还在列表里，会以为删除失败
              // 而反复删（三个独立人格都报过这条，分别描述为「删除没生效」「阴魂不散」）。
              showStatus
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
