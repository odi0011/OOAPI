import { Card as ArcPanel } from "../components/arc/card/card";
import { Button as ActionButton } from "../components/arc/index";
// 社区管理（管理员）—— 话题 / 内容审核 / 计数修复
// ---------------------------------------------------------------------------
// 这一页对应「管理员侧更细颗粒度的设定与管理」：
//   · 话题：新建/改名/排序/停用（停用后不再收新帖，历史帖仍可读 —— 比删除温和）；
//   · 内容：按状态筛选（正常/隐藏/已删），隐藏可恢复、置顶控制信息流；
//   · 计数修复：帖子/评论/点赞的计数是冗余字段，极端并发下可能漂移，
//     提供一键重算（不假设它永远准确，但提供修复手段）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import {   useNavigate } from "react-router-dom";
import {
  Button, Table, Tag, Space, App as ArcApp, Modal, Form, Input, InputNumber, Switch,
  Alert, Popconfirm, Tooltip, Empty, Segmented, Select,
 } from "../components/arc/index";
import {
  PlusOutlined, ReloadOutlined, EditOutlined, EyeOutlined, EyeInvisibleOutlined,
  PushpinOutlined, DeleteOutlined, CalculatorOutlined, TagsOutlined, UndoOutlined, UploadOutlined,
 } from "../components/arc/icons";
import TopicIcon, { TOPIC_ICONS } from "../components/TopicIcon";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import { fmtCompact } from "../components/Charts";
import { fmtDate } from "../services/format";

/** 内置图标网格（受控：value = 图标 key，"" = 未选） */
function IconGrid({ value, onChange }) {
  return (
    <div className="oo-icon-grid" role="radiogroup" aria-label="内置图标">
      {TOPIC_ICONS.map((x) => (
        <Tooltip key={x.key} title={x.label} mouseEnterDelay={0.3}>
          <ActionButton type="text"
            htmlType="button"
            role="radio"
            aria-checked={value === x.key}
            aria-label={x.label}
            className={value === x.key ? "is-on" : ""}
            onClick={() => onChange?.(value === x.key ? "" : x.key)}
          >
            <TopicIcon icon={x.key} size={28} />
          </ActionButton>
        </Tooltip>
      ))}
    </div>
  );
}

export default function AdminCommunityPage() {
  const navigate = useNavigate();
  const { message } = ArcApp.useApp();
  const { begin, isLatest } = useLatest();

  const [tab, setTab] = useState("posts");
  const [posts, setPosts] = useState({ items: [], total: 0 });
  const [topics, setTopics] = useState([]);
  const [status, setStatus] = useState(1); // 1 正常 / 3 隐藏 / 2 已删
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState(false);
  const [summary, setSummary] = useState(null);

  const [topicOpen, setTopicOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [iconImageUrl, setIconImageUrl] = useState("");
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const iconFileRef = useRef(null);
  const [deleting, setDeleting] = useState(null);
  const [moveTo, setMoveTo] = useState(undefined);

  const loadPosts = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const d = await API.get("/community/posts", {
        params: { p: page, page_size: 20, status, sort: "new" },
      });
      if (!isLatest(token)) return;
      setPosts({ items: d?.items || [], total: d?.total || 0 });
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "加载失败");
        message.error(e.message);
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, isLatest, message, page, status]);

  const loadTopics = useCallback(async () => {
    try {
      // all=1：包含已停用的话题。原先不带这个参数 —— 停用后的话题从管理页消失，
      // 表格里那个「启用」按钮永远点不到（停用变成了事实上的不可逆删除）。
      const d = await API.get("/community/topics", { params: { all: 1 } });
      setTopics(Array.isArray(d) ? d : []);
    } catch (e) {
      message.error(e.message);
    }
  }, [message]);

  useEffect(() => {
    if (tab === "posts") loadPosts();
    else loadTopics();
  }, [tab, loadPosts, loadTopics]);

  useEffect(() => {
    API.get("/dashboard/community")
      .then((d) => setSummary(d?.site || null))
      .catch(() => setSummary(null));
  }, []);

  const moderate = async (id, patch) => {
    if (acting) return;
    setActing(true);
    try {
      await API.post(`/community/posts/${id}/moderate`, patch);
      message.success("已处理");
      await loadPosts();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const removePost = async (id) => {
    if (acting) return;
    setActing(true);
    try {
      await API.del(`/community/posts/${id}`);
      message.success("已删除");
      await loadPosts();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const recount = async () => {
    if (acting) return;
    setActing(true);
    try {
      await API.post("/community/admin/recount", {});
      message.success("计数已重算");
      await loadPosts();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const uploadIcon = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingIcon(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读取文件失败"));
        fr.readAsDataURL(file);
      });
      const r = await API.post("/media", { dataUrl, name: file.name, source: "community" }, { timeoutMs: 120000 });
      form.setFieldsValue({ image_media_id: r.id });
      setIconImageUrl(r.url || "");
    } catch (err) {
      message.error(err.message || "上传失败");
    } finally {
      setUploadingIcon(false);
    }
  };

  const removeTopic = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await API.del(`/community/topics/${deleting.id}`, { params: moveTo ? { move_to: moveTo } : undefined });
      message.success("话题已删除");
      setDeleting(null);
      await loadTopics();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const submitTopic = async () => {
    if (saving) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editingTopic) {
        await API.put(`/community/topics/${editingTopic.id}`, v);
        message.success("话题已更新");
      } else {
        await API.post("/community/topics", v);
        message.success("话题已创建");
      }
      setTopicOpen(false);
      setEditingTopic(null);
      form.resetFields();
      await loadTopics();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: "帖子",
      dataIndex: "title",
      width: 320,
      render: (_, r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {r.is_pinned ? <Tag color="orange">置顶</Tag> : null}
            {Number(r.status) === 3 ? <Tag color="orange">已隐藏</Tag> : null}
            {Number(r.status) === 2 ? <Tag color="red">已删除</Tag> : null}
            <span title={r.title} className="oo-truncate" style={{ minWidth: 0, fontWeight: 500, fontSize: 13 }}>{r.title}</span>
          </div>
          <div title={r.summary} className="oo-truncate" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {r.summary || ""}
          </div>
        </div>
      ),
    },
    {
      title: "作者",
      width: 150,
      render: (_, r) => (
        <UserAvatar
          user={{ id: r.author?.id, username: r.author?.username, display_name: r.author?.display_name, avatar_url: r.author?.avatar_url }}
          size={20}
          showName
          nameClass="oo-truncate"
        />
      ),
    },
    {
      title: "话题",
      dataIndex: "topic",
      width: 110,
      render: (v) => (v ? <Tag>{v}</Tag> : <span style={{ color: "var(--ink-3)" }}>—</span>),
    },
    { title: "赞/评/览", width: 110, render: (_, r) => (
      <span className="oo-num" style={{ fontSize: 12, color: "var(--ink-3)" }}>
        {fmtCompact(r.like_count || 0)} / {fmtCompact(r.comment_count || 0)} / {fmtCompact(r.view_count || 0)}
      </span>
    ) },
    { title: "发布", dataIndex: "created_time", width: 150, render: (v) => <span className="oo-num">{fmtDate(v)}</span> },
    {
      title: "操作",
      width: 200,
      fixed: "right",
      render: (_, r) => (
        <Space size={0}>
          <Tooltip title="查看详情">
            <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/community/${r.id}`)} />
          </Tooltip>
          {Number(r.status) === 2 ? (
            <Tooltip title="恢复帖子">
              <Button
                type="text"
                size="small"
                icon={<UndoOutlined />}
                disabled={acting}
                onClick={() => moderate(r.id, { status: 1 })}
              />
            </Tooltip>
          ) : null}
          {Number(r.status) !== 2 ? (
            <Tooltip title={Number(r.status) === 3 ? "取消隐藏" : "隐藏（可恢复，比删除温和）"}>
              <Button
                type="text"
                size="small"
                icon={Number(r.status) === 3 ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                disabled={acting}
                onClick={() => moderate(r.id, { status: Number(r.status) === 3 ? 1 : 3 })}
              />
            </Tooltip>
          ) : null}
          {Number(r.status) === 1 ? (
            <Tooltip title={r.is_pinned ? "取消置顶" : "置顶"}>
              <Button
                type="text"
                size="small"
                icon={<PushpinOutlined />}
                disabled={acting}
                onClick={() => moderate(r.id, { is_pinned: r.is_pinned ? 0 : 1 })}
              />
            </Tooltip>
          ) : null}
          {Number(r.status) !== 2 ? (
            <Popconfirm title="删除该帖子？" description="删除后不可恢复（隐藏是可恢复的）。" onConfirm={() => removePost(r.id)} okText="删除" okType="danger" cancelText="取消">
              <Tooltip title="删除">
                <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={acting} />
              </Tooltip>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="社区管理"
        tags={<Tag icon={<TagsOutlined />}>话题与内容审核</Tag>}
        extra={
          <>
            <Tooltip title="重算帖子/评论/点赞的冗余计数（计数漂移时用）">
              <Button icon={<CalculatorOutlined />} loading={acting} onClick={recount}>重算计数</Button>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={() => (tab === "posts" ? loadPosts() : loadTopics())} title="刷新" />
            {tab === "topics" ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingTopic(null);
                  form.resetFields();
                  form.setFieldsValue({ sort: 0, icon: "chat", image_media_id: 0, description: "" });
                  setIconImageUrl("");
                  setTopicOpen(true);
                }}
              >
                新建话题
              </Button>
            ) : null}
          </>
        }
      />

      {summary ? (
        <div className="oo-stats-cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))" }}>
          <StatCard label="帖子总数" value={summary.posts} suffix="篇" hint="status=1 的帖子" />
          <StatCard label="待处理" value={summary.hidden_posts} suffix="篇" tone={summary.hidden_posts ? "warning" : undefined} hint="被隐藏的内容，可恢复" />
          <StatCard label="评论总数" value={fmtCompact(summary.comments)} hint="全部可见评论" />
          <StatCard label="会话数" value={summary.rooms} hint="进行中的聊天房间" />
          <StatCard label="区间新帖" value={summary.posts_new} hint="近 30 天" />
          <StatCard label="区间消息" value={fmtCompact(summary.messages_new)} hint="近 30 天聊天消息" />
        </div>
      ) : null}

      <ArcPanel className="oo-panel oo-table-panel">
        <div className="oo-toolbar oo-toolbar--plain" style={{ paddingBottom: 12 }}>
          <Segmented
            value={tab}
            onChange={(v) => { setTab(v); setPage(1); }}
            options={[
              { value: "posts", label: "内容管理" },
              { value: "topics", label: "话题管理" },
            ]}
          />
          {tab === "posts" ? (
            <Segmented
              value={status}
              onChange={(v) => { setStatus(v); setPage(1); }}
              options={[
                { value: 1, label: "正常" },
                { value: 3, label: "已隐藏" },
                { value: 2, label: "已删除" },
              ]}
            />
          ) : null}
          <span className="oo-toolbar-spacer" />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tab === "posts" ? `共 ${posts.total} 条` : `共 ${topics.length} 个话题`}
          </span>
        </div>

        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="加载失败"
            description={loadError}
            action={<Button size="small" onClick={loadPosts} loading={loading}>重试</Button>}
            style={{ margin: 14 }}
          />
        ) : null}

        {tab === "posts" ? (
          <Table
            className="oo-table"
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={posts.items}
            tableLayout="fixed"
            scroll={{ x: columns.reduce((total, column) => total + (column.width || 0), 0) }}
            pagination={{
              current: page,
              pageSize: 20,
              total: posts.total,
              showSizeChanger: false,
              showTotal: (t) => `共 ${t} 条`,
              onChange: setPage,
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={status === 1 ? "社区还没有内容" : "该状态下没有内容"}
                />
              ),
            }}
          />
        ) : (
          <Table
            className="oo-table"
            rowKey="id"
            rowClassName={(r) => (Number(r.status) === 2 ? "oo-row-muted" : "")}
            columns={[
              { title: "话题", dataIndex: "name", render: (v, r) => (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <TopicIcon icon={r.icon} imageUrl={r.image_url} size={24} />
                  <b>{v}</b>
                  {Number(r.status) === 2 ? <Tag style={{ margin: 0 }}>已停用</Tag> : null}
                </span>
              ) },
              { title: "说明", dataIndex: "description", ellipsis: true, render: (v) => v || <span style={{ color: "var(--ink-3)" }}>—</span> },
              { title: "帖子数", dataIndex: "post_count", width: 90, render: (v) => <span className="oo-num">{v}</span> },
              { title: "排序", dataIndex: "sort", width: 70, render: (v) => <span className="oo-num">{v}</span> },
              {
                title: "操作",
                width: 220,
                render: (_, r) => (
                  <Space size={2}>
                    <Button
                      type="link"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingTopic(r);
                        form.resetFields();
                        form.setFieldsValue({ name: r.name, description: r.description, icon: r.icon || "", image_media_id: r.image_media_id || 0, sort: r.sort });
                        setIconImageUrl(r.image_url || "");
                        setTopicOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title={Number(r.status) === 2 ? "重新启用该话题？" : "停用该话题？"}
                      description={Number(r.status) === 2 ? "启用后可再次发帖。" : "停用后不再接受新帖，历史帖仍可读（比删除温和）。"}
                      onConfirm={async () => {
                        try {
                          await API.put(`/community/topics/${r.id}`, { status: Number(r.status) === 2 ? 1 : 2 });
                          message.success("已处理");
                          loadTopics();
                        } catch (e) {
                          message.error(e.message);
                        }
                      }}
                      okText="确定"
                      cancelText="取消"
                    >
                      <Button type="link" size="small">
                        {Number(r.status) === 2 ? "启用" : "停用"}
                      </Button>
                    </Popconfirm>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => { setDeleting(r); setMoveTo(undefined); }}>
                      删除
                    </Button>
                  </Space>
                ),
              },
            ]}
            dataSource={topics}
            pagination={false}
            locale={{ emptyText: <Empty description="还没有话题，先建一个" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}
      </ArcPanel>

      <Modal
        title={editingTopic ? "编辑话题" : "新建话题"}
        open={topicOpen}
        onOk={submitTopic}
        confirmLoading={saving}
        onCancel={() => { setTopicOpen(false); setEditingTopic(null); }}
        okText="保存"
        width={460}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入话题名称" }]}>
            <Input placeholder="例如：Prompt 调试" maxLength={40} showCount />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input placeholder="这个话题讨论什么（选填）" maxLength={160} />
          </Form.Item>
          {/* 图标：内置线性图标 或 上传图片（图片优先）。不再接受 emoji —— 各系统字形不一、与站内图标风格冲突 */}
          <Form.Item label="图标" tooltip="选一个内置图标，或上传一张图片（上传的图片优先显示）">
            <div className="oo-icon-picker">
              <Form.Item name="icon" noStyle>
                <IconGrid />
              </Form.Item>
              <Form.Item name="image_media_id" noStyle>
                <Input type="hidden" />
              </Form.Item>
              <div className="oo-icon-upload">
                {iconImageUrl ? (
                  <>
                    <TopicIcon imageUrl={iconImageUrl} size={40} />
                    <Button size="small" onClick={() => { setIconImageUrl(""); form.setFieldsValue({ image_media_id: 0 }); }}>移除图片</Button>
                  </>
                ) : (
                  <Button size="small" icon={<UploadOutlined />} loading={uploadingIcon} onClick={() => iconFileRef.current?.click()}>
                    上传图片
                  </Button>
                )}
                <span className="oo-desc">建议正方形，至少 64×64</span>
                <input ref={iconFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden style={{ display: "none" }} onChange={uploadIcon} />
              </div>
            </div>
          </Form.Item>
          <Form.Item name="sort" label="排序" tooltip="数值越大越靠前">
            <InputNumber style={{ width: 120 }} min={-9999} max={9999} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`删除话题「${deleting?.name || ""}」`}
        open={Boolean(deleting)}
        onCancel={() => setDeleting(null)}
        okText="删除"
        okButtonProps={{ danger: true, disabled: Boolean(deleting?.post_count) && !moveTo, loading: saving }}
        onOk={removeTopic}
        destroyOnClose
      >
        {deleting?.post_count ? (
          <>
            <p>这个话题下有 <b>{deleting.post_count}</b> 篇帖子，删除前需要把它们迁到另一个话题（帖子必须归属某个话题）。</p>
            <Select
              style={{ width: "100%" }}
              placeholder="选择要迁入的话题"
              value={moveTo}
              onChange={setMoveTo}
              options={topics.filter((t) => t.id !== deleting.id).map((t) => ({ value: t.id, label: t.name }))}
            />
          </>
        ) : (
          <p>话题下没有帖子，删除后无法恢复。只是想暂时不让大家发帖的话，用「停用」即可。</p>
        )}
      </Modal>
    </div>
  );
}
