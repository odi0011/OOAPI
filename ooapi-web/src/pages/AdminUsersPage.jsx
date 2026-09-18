import React, { useEffect, useState, useCallback } from "react";
import {
  Table, Button, Space, Tag, Input, Popconfirm, Modal, Form,
  Select, InputNumber, App as AntApp, Typography, Alert,
} from "antd";
import { ReloadOutlined, TeamOutlined, SearchOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import { fmtDate, fmtOd, unitsPerOd, CURRENCY_NAME } from "../services/format";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";

const { Text } = Typography;

export default function AdminUsersPage() {
  const { status, user: me, refreshUser } = useApp();
  const { message } = AntApp.useApp();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState(null);
  const [acting, setActing] = useState(false); // 编辑/额度/删除 防重入
  const [form] = Form.useForm();
  const [quotaForm] = Form.useForm();
  const { begin, isLatest } = useLatest();

  const perUnit = unitsPerOd(status);

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const data = await API.get("/users/", { params: { p: page, page_size: pageSize, keyword } });
      if (!isLatest(token)) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "用户列表加载失败");
        message.error(e.message || "用户列表加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [page, pageSize, keyword, message, begin, isLatest]);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (u) => {
    setEditing(u);
    // 先清残留再赋值：避免上一次编辑未提交的字段（如上一次改过的邮箱）带进这一位用户
    form.resetFields();
    form.setFieldsValue({ display_name: u.display_name, email: u.email, role: u.role, status: u.status });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (acting) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return; // 校验未通过：antd 已在表单上标红，无需打扰
    }
    setActing(true);
    try {
      await API.put(`/users/${editing.id}`, v);
      message.success("已保存");
      setEditOpen(false);
      // 改的是自己：同步刷新全局用户（降级后管理菜单应立刻消失）
      if (editing.id === me?.id) await refreshUser?.();
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const submitQuota = async () => {
    if (acting) return;
    let v;
    try {
      v = await quotaForm.validateFields();
    } catch {
      return;
    }
    setActing(true);
    try {
      // 输入框单位是 OD 币，提交时换算成额度单位（与令牌页口径一致）
      await API.post(`/users/${quotaTarget.id}/quota`, { quota: Math.round(Number(v.quota) * perUnit) });
      message.success("额度已调整");
      setQuotaOpen(false);
      quotaForm.resetFields();
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const remove = async (u) => {
    if (acting) return;
    setActing(true);
    try {
      await API.del(`/users/${u.id}`);
      message.success("用户已删除");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const toggle = async (u) => {
    if (acting) return;
    setActing(true);
    try {
      await API.put(`/users/${u.id}`, { status: u.status === 1 ? 2 : 1 });
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const admins = items.filter((u) => u.role >= 100).length;
  const disabled = items.filter((u) => u.status !== 1).length;
  const totalUsed = items.reduce((s, u) => s + Number(u.used_quota || 0), 0);

  const columns = [
    {
      title: "ID",
      dataIndex: "id",
      width: 64,
      render: (v) => <span className="oo-num" style={{ color: "var(--oo-text-muted)" }}>{v}</span>,
    },
    {
      title: "用户",
      dataIndex: "username",
      width: 190,
      render: (v, r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 560 }}>{r.display_name || v}</div>
          {r.display_name && r.display_name !== v ? (
            <div style={{ fontSize: 12, color: "var(--oo-text-muted)" }}>{v}</div>
          ) : null}
        </div>
      ),
    },
    { title: "邮箱", dataIndex: "email", width: 180, ellipsis: true, render: (v) => v || <Text type="secondary">-</Text> },
    {
      title: "角色",
      dataIndex: "role",
      width: 96,
      render: (r) => (r >= 100 ? <Tag color="gold">管理员</Tag> : <Tag>普通用户</Tag>),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 88,
      render: (s) =>
        s === 1 ? (
          <span className="oo-flex oo-gap-2" style={{ fontSize: 13 }}>
            <span className="oo-dot oo-dot--ok" /> 启用
          </span>
        ) : (
          <span className="oo-flex oo-gap-2" style={{ fontSize: 13, color: "var(--oo-text-muted)" }}>
            <span className="oo-dot oo-dot--err" /> 禁用
          </span>
        ),
    },
    {
      title: "剩余额度",
      dataIndex: "quota",
      width: 116,
      sorter: (a, b) => a.quota - b.quota,
      render: (q) => <span className="oo-num">{fmtOd(q, perUnit, 2)}</span>,
    },
    {
      title: "已用额度",
      dataIndex: "used_quota",
      width: 116,
      render: (q) => <span className="oo-num" style={{ color: "var(--oo-text-muted)" }}>{fmtOd(q, perUnit, 4)}</span>,
    },
    {
      title: "调用",
      dataIndex: "request_count",
      width: 84,
      sorter: (a, b) => a.request_count - b.request_count,
      render: (v) => <span className="oo-num">{v ?? 0}</span>,
    },
    { title: "注册时间", dataIndex: "created_time", width: 156, render: (v) => <span className="oo-num">{fmtDate(v)}</span> },
    {
      title: "操作",
      width: 190,
      fixed: "right",
      render: (_, u) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => openEdit(u)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setQuotaTarget(u);
              quotaForm.resetFields();
              quotaForm.setFieldsValue({ quota: 10 }); // 默认补充 10 OD
              setQuotaOpen(true);
            }}
          >
            额度
          </Button>
          {/* 自己的账号不允许在此禁用/删除（需换管理员操作），避免把自己锁在门外 */}
          {u.id === me?.id ? (
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>当前账号</span>
          ) : (
            <>
              <Button type="link" size="small" onClick={() => toggle(u)}>
                {u.status === 1 ? "禁用" : "启用"}
              </Button>
              <Popconfirm title={`确定删除用户 ${u.username}？`} onConfirm={() => remove(u)}>
                <Button type="link" size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="用户管理"
        desc="管理平台用户的角色、状态与可用额度"
        extra={
          <>
            <Input
              placeholder="搜索用户名 / 邮箱"
              allowClear
              prefix={<SearchOutlined style={{ color: "var(--oo-text-muted)" }} />}
              style={{ width: 220 }}
              onPressEnter={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
              onChange={(e) => {
                if (!e.target.value) {
                  setKeyword("");
                  setPage(1);
                }
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新用户列表" aria-label="刷新用户列表" />
          </>
        }
      />

      <div className="oo-grid">
        <StatCard label="用户总数" value={total} icon={<TeamOutlined />} />
        <StatCard label="管理员" value={admins} foot={<span>本页统计</span>} />
        <StatCard label="已禁用" value={disabled} tone={disabled ? "danger" : undefined} foot={<span>本页统计</span>} />
        <StatCard label="累计消费" value={fmtOd(totalUsed, perUnit, 2)} foot={<span>本页统计</span>} />
      </div>

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="用户列表加载失败"
            description={loadError}
            action={<Button size="small" onClick={load}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Table
          className="oo-table"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1420 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 位用户`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </div>

      <Modal
        title={`编辑用户：${editing?.username || ""}`}
        open={editOpen}
        onOk={saveEdit}
        onCancel={() => setEditOpen(false)}
        confirmLoading={acting}
        destroyOnClose
        okText="保存"
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="display_name" label="显示名称">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" extra="管理员可管理渠道、用户与系统设置">
            <Select
              // 不能改自己的角色（后端也拒绝）：唯一管理员把自己降级后将失去后台入口
              disabled={editing?.id === me?.id}
              options={[
                { value: 1, label: "普通用户" },
                { value: 100, label: "管理员" },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              disabled={editing?.id === me?.id}
              options={[
                { value: 1, label: "启用" },
                { value: 2, label: "禁用" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`调整额度：${quotaTarget?.username || ""}`}
        open={quotaOpen}
        onOk={submitQuota}
        onCancel={() => setQuotaOpen(false)}
        confirmLoading={acting}
        destroyOnClose
        okText="确认调整"
      >
        <Form form={quotaForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="quota"
            label={`额度变化量（${CURRENCY_NAME}）`}
            extra={`正数为补充，负数为扣除；当前余额 ${fmtOd(quotaTarget?.quota || 0, perUnit, 2)} ${CURRENCY_NAME}`}
            rules={[{ required: true, message: "请输入额度变化量" }]}
          >
            <InputNumber style={{ width: "100%" }} step={10} precision={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
