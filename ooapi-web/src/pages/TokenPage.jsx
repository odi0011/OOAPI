import React, { useEffect, useState, useCallback } from "react";
import {
  Button, Table, Modal, Form, Input, Switch, InputNumber, DatePicker,
  Select, Tag, Space, Typography, App as AntApp, Popconfirm, Tooltip, Empty,
  Alert,
} from "antd";
import { PlusOutlined, CopyOutlined, ReloadOutlined, KeyOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { API } from "../services/api";
import { copyText, fmtDate, fmtOd, odOf, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel } from "../components/VendorIcon";

const { Text } = Typography;

export default function TokenPage() {
  const { message } = AntApp.useApp();
  const { status } = useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState(null); // 行内操作（启停/删除）防重入
  const [copyingId, setCopyingId] = useState(null);
  const [groupList, setGroupList] = useState([]); // 可选分组（厂商隔离）
  const [form] = Form.useForm();
  const { begin, isLatest } = useLatest();

  // 分组下拉（sub2api 风格）：一个 Key 只能绑定一个分组，选项显示厂商图标 / 分组名 / 备注 / 倍率
  const groupOptions = React.useMemo(
    () =>
      groupList.map((g) => ({
        value: `${g.type}:${g.name}`,
        search: `${g.name} ${g.remark || ""} ${g.typeName || g.type}`.toLowerCase(),
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 320 }}>
            <VendorIcon type={g.type} size={13} />
            <span className="oo-truncate" style={{ fontWeight: 500 }}>{g.name}</span>
            {g.remark ? (
              <span className="oo-truncate" style={{ color: "var(--ink-3)", fontSize: 12 }}>{g.remark}</span>
            ) : null}
            <span className="bui-chip" style={{ marginLeft: "auto", flexShrink: 0 }}>×{Number(g.rate) || 1}</span>
          </span>
        ),
      })),
    [groupList]
  );

  const groupMetaOf = (value) => {
    const [type, name] = String(value || "").split(":");
    if (!type || !name) return null;
    return groupList.find((g) => g.type === type && g.name === name) || { type, name, rate: 1 };
  };

  const perUnit = unitsPerOd(status); // 1 OD = 10000 额度单位

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const data = await API.get("/token/");
      if (!isLatest(token)) return;
      setItems(data);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "令牌列表加载失败");
        message.error(e.message || "令牌列表加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [message, begin, isLatest]);

  useEffect(() => {
    load();
    // 分组列表失败不影响页面主体（无分组时下拉为空）
    API.get("/token/groups")
      .then((list) => setGroupList(Array.isArray(list) ? list : []))
      .catch(() => setGroupList([]));
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      name: "",
      unlimited_quota: true,
      // 输入框单位是 OD 币，默认 50 OD（提交时再乘 perUnit 转成额度单位）
      remain_quota: 50,
      never_expire: true,
      expired_time: null,
      model_limits: [],
      group_name: undefined,
    });
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue({
      name: record.name,
      unlimited_quota: record.unlimited_quota,
      // 后端存的是额度单位，展示/编辑统一换算成 OD 币
      remain_quota: odOf(record.remain_quota, perUnit),
      never_expire: record.expired_time === -1,
      expired_time: record.expired_time > 0 ? dayjs(record.expired_time * 1000) : null,
      model_limits: record.model_limits || [],
      group_name: record.group || undefined,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    if (saving) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const payload = {
      name: v.name,
      remain_quota: v.unlimited_quota ? 0 : Math.round(Number(v.remain_quota) * perUnit),
      unlimited_quota: v.unlimited_quota,
      expired_time: v.never_expire ? -1 : Math.floor(v.expired_time.valueOf() / 1000),
      model_limits: v.model_limits || [],
      group_name: v.group_name || "",
    };
    setSaving(true);
    try {
      if (editing) {
        await API.put("/token/", { id: editing.id, ...payload });
        message.success("令牌已更新");
      } else {
        await API.post("/token/", payload);
        message.success("令牌创建成功");
      }
      setModalOpen(false);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (record) => {
    if (actingId) return; // 防重入：连点会重复提交状态切换
    setActingId(record.id);
    try {
      await API.put("/token/", { id: record.id, status: record.status === 1 ? 2 : 1 });
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActingId(null);
    }
  };

  const remove = async (record) => {
    if (actingId) return;
    setActingId(record.id);
    try {
      await API.del(`/token/${record.id}`);
      message.success("令牌已删除");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActingId(null);
    }
  };

  const copyKey = async (record) => {
    if (copyingId) return;
    setCopyingId(record.id);
    try {
      const { key } = await API.get(`/token/${record.id}/key`);
      await copyText(key);
      message.success("已复制完整密钥");
    } catch (e) {
      message.error(e.message);
    } finally {
      setCopyingId(null);
    }
  };

  const statusTag = (s) =>
    s === 1 ? (
      <Tag color="success">已启用</Tag>
    ) : s === 2 ? (
      <Tag color="error">已禁用</Tag>
    ) : (
      <Tag>已过期</Tag>
    );

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      width: 170,
      ellipsis: true,
      render: (v) => <Text strong>{v}</Text>,
    },
    {
      title: "密钥",
      dataIndex: "key",
      width: 280,
      render: (k, r) => (
        <Space size={2}>
          <span className="oo-mono">{k}</span>
          <Tooltip title="复制完整密钥">
            <Button type="text" size="small" icon={<CopyOutlined />} loading={copyingId === r.id} disabled={Boolean(actingId)} onClick={() => copyKey(r)} />
          </Tooltip>
        </Space>
      ),
    },
    { title: "状态", dataIndex: "status", width: 92, render: statusTag },
    {
      title: "额度",
      width: 130,
      render: (_, r) =>
        r.unlimited_quota ? (
          <Tag color="geekblue">无限</Tag>
        ) : (
          <span className="oo-num">{fmtOd(r.remain_quota, perUnit, 2)}</span>
        ),
    },
    {
      title: "已用",
      dataIndex: "used_quota",
      width: 110,
      render: (q) => <span className="oo-num">{fmtOd(q, perUnit, 4)}</span>,
    },
      {
        title: "分组",
        dataIndex: "group",
        width: 170,
        render: (g) => {
          if (!g) return <Text type="secondary" style={{ fontSize: 12 }}>默认池</Text>;
          const meta = groupMetaOf(g);
          const rate = Number(meta?.rate) || 1;
          const tip = `${meta?.typeName || meta?.type || ""} / ${meta?.name || g}${meta?.remark ? ` · ${meta.remark}` : ""} · 倍率 ×${rate}`;
          return (
            <Tooltip title={tip}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%" }}>
                <VendorIcon type={meta?.type} size={13} />
                <span className="oo-truncate">{meta?.name || g}</span>
                {rate !== 1 ? <span className="bui-chip">×{rate}</span> : null}
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: "模型限制",
        dataIndex: "model_limits",
      width: 160,
      render: (list) =>
        list?.length ? (
          <Tooltip title={<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{list.map((m) => <ModelLabel key={m} model={m} size={13} mono />)}</div>}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <ModelLabel model={list[0]} size={13} />
              {list.length > 1 ? <span className="bui-chip">+{list.length - 1}</span> : null}
            </span>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            不限制
          </Text>
        ),
    },
    { title: "创建时间", dataIndex: "created_time", width: 160, render: (v) => <span className="oo-num">{fmtDate(v)}</span> },
    {
      title: "操作",
      width: 180,
      fixed: "right",
      render: (_, r) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Button type="link" size="small" loading={actingId === r.id} disabled={Boolean(actingId) && actingId !== r.id} onClick={() => toggleStatus(r)}>
            {r.status === 1 ? "禁用" : "启用"}
          </Button>
          <Popconfirm title="确定删除该令牌？" onConfirm={() => remove(r)}>
            <Button type="link" size="small" danger loading={actingId === r.id} disabled={Boolean(actingId) && actingId !== r.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="令牌管理"
        desc="为不同应用签发独立密钥，可限制额度上限、可用模型与有效期"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新令牌列表" aria-label="刷新令牌列表" />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              创建令牌
            </Button>
          </>
        }
      />

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="令牌列表加载失败"
            description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Table
          className="oo-table"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1240 }}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={<KeyOutlined style={{ fontSize: 40, color: "var(--oo-text-disabled)" }} />}
                description="还没有令牌，点击右上角创建第一个"
              />
            ),
          }}
        />
      </div>

      <Modal
        title={editing ? "编辑令牌" : "创建令牌"}
        open={modalOpen}
        onOk={submit}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        okText="保存"
        width={520}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入令牌名称" }]}>
            <Input placeholder="例如：my-app" maxLength={64} />
          </Form.Item>

          <Form.Item name="unlimited_quota" label="无限额度" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.unlimited_quota !== c.unlimited_quota}>
            {({ getFieldValue }) =>
              !getFieldValue("unlimited_quota") && (
                <Form.Item name="remain_quota" label={`额度上限（${CURRENCY_NAME}）`} rules={[{ required: true, message: "请输入额度" }]}>
                  <InputNumber
                    style={{ width: "100%" }}
                    min={0}
                    step={1}
                    precision={4}
                    formatter={(v) => `${v} ${CURRENCY_NAME}`}
                    parser={(v) => String(v).replace(/[^\d.]/g, "")}
                  />
                </Form.Item>
              )
            }
          </Form.Item>

          <Form.Item name="never_expire" label="永不过期" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.never_expire !== c.never_expire}>
            {({ getFieldValue }) =>
              !getFieldValue("never_expire") && (
                <Form.Item name="expired_time" label="过期时间" rules={[{ required: true, message: "请选择过期时间" }]}>
                  <DatePicker showTime style={{ width: "100%" }} />
                </Form.Item>
              )
            }
          </Form.Item>

          <Form.Item name="model_limits" label="可用模型" extra="留空表示不限制">
            <Select
              mode="tags"
              placeholder="输入或选择模型"
              options={(status?.model_list || []).map((m) => ({ value: m, label: m }))}
              tokenSeparators={[","]}
            />
          </Form.Item>

          <Form.Item
            name="group_name"
            label="分组"
            extra="一个 Key 只能绑定一个分组（由管理员创建）；留空使用默认池（全部渠道）"
          >
            <Select
              allowClear
              showSearch
              placeholder="不绑定（默认池）"
              options={groupOptions}
              filterOption={(input, option) => (option?.search || "").includes(input.toLowerCase())}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
