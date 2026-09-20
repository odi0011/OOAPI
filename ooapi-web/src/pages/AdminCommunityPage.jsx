// 社区管理（管理员）—— 话题 / 内容审核 / 计数修复
// ---------------------------------------------------------------------------
// 这一页对应「管理员侧更细颗粒度的设定与管理」：
//   · 话题：新建/改名/排序/停用（停用后不再收新帖，历史帖仍可读 —— 比删除温和）；
//   · 内容：按状态筛选（正常/隐藏/已删），隐藏可恢复、置顶控制信息流；
//   · 计数修复：帖子/评论/点赞的计数是冗余字段，极端并发下可能漂移，
//     提供一键重算（不假设它永远准确，但提供修复手段）。
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Table, Tag, Space, App as AntApp, Modal, Form, Input, InputNumber, Switch,
  Alert, Popconfirm, Tooltip, Empty, Segmented,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, EditOutlined, EyeOutlined, EyeInvisibleOutlined,
  PushpinOutlined, DeleteOutlined, CalculatorOutlined, TagsOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";
import { fmtCompact } from "../components/Charts";
import { fmtDate } from "../services/format";

export default function AdminCommunityPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
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
      const d = await API.get("/community/topics");
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
      render: (_, r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {r.is_pinned ? <Tag color="orange">置顶</Tag> : null}
            {Number(r.status) === 3 ? <Tag color="orange">已隐藏</Tag> : null}
            {Number(r.status) === 2 ? <Tag color="red">已删除</Tag> : null}
            <span className="oo-truncate" style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</span>
          </div>
          <div className="oo-truncate" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
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
          {Number(r.status) !== 2 ? (
            <Tooltip title={Number(r.status) === 3 ? "取消隐藏" : "隐藏（可恢复，比删除温和）"}>
              <Button
                type="text"
                size="small"
                icon={Number(r.status) === 3 ? <EyeInvisibleOutlined /> : <EyeInvisibleOutlined />}
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
                  form.setFieldsValue({ sort: 0, icon: "", description: "" });
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

      <div className="oo-panel">
        <div className="oo-toolbar">
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
            scroll={{ x: 900 }}
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
                <span>
                  {r.icon ? `${r.icon} ` : ""}
                  <b>{v}</b>
                  {Number(r.status) === 2 ? <Tag style={{ marginLeft: 8 }}>已停用</Tag> : null}
                </span>
              ) },
              { title: "说明", dataIndex: "description", ellipsis: true, render: (v) => v || <span style={{ color: "var(--ink-3)" }}>—</span> },
              { title: "帖子数", dataIndex: "post_count", width: 90, render: (v) => <span className="oo-num">{v}</span> },
              { title: "排序", dataIndex: "sort", width: 70, render: (v) => <span className="oo-num">{v}</span> },
              {
                title: "操作",
                width: 170,
                render: (_, r) => (
                  <Space size={2}>
                    <Button
                      type="link"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingTopic(r);
                        form.resetFields();
                        form.setFieldsValue({ name: r.name, description: r.description, icon: r.icon, sort: r.sort });
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
                      <Button type="link" size="small" danger={Number(r.status) !== 2}>
                        {Number(r.status) === 2 ? "启用" : "停用"}
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
            dataSource={topics}
            pagination={false}
            locale={{ emptyText: <Empty description="还没有话题，先建一个" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}
      </div>

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
          <Form.Item name="icon" label="图标" tooltip="可以是一个 emoji，例如 💡">
            <Input placeholder="💡" maxLength={16} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="sort" label="排序" tooltip="数值越大越靠前">
            <InputNumber style={{ width: 120 }} min={-9999} max={9999} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
