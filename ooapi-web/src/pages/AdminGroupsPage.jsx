import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Table, Button, Space, Input, Popconfirm, Modal, Form, Select,
  InputNumber, App as AntApp, Typography, Alert, Tooltip,
} from "antd";
import { ReloadOutlined, PlusOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel } from "../components/VendorIcon";

const { Text } = Typography;

/**
 * 分组管理（sub2api 风格，独立页面）：
 *   · 分组由管理员创建，绑定厂商；可设备注、计费倍率、支持的模型；
 *   · 管理员选择分组包含哪些账号（渠道），渠道编辑里也能挂分组（双向）；
 *   · 用户创建密钥时只能选分组，可用模型完全由分组决定。
 */
export default function AdminGroupsPage() {
  const { message } = AntApp.useApp();
  const [groups, setGroups] = useState([]);
  const [providers, setProviders] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState([]);
  const [memberIds, setMemberIds] = useState([]);
  const [form] = Form.useForm();
  const pickedType = Form.useWatch("type", form);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [gs, ps, cs] = await Promise.allSettled([
        API.get("/channel/groups"),
        API.get("/channel/providers"),
        API.get("/channel/"),
      ]);
      if (gs.status === "fulfilled") setGroups(Array.isArray(gs.value) ? gs.value : []);
      else setLoadError(gs.reason?.message || "分组列表加载失败");
      if (ps.status === "fulfilled") setProviders(Array.isArray(ps.value) ? ps.value : []);
      if (cs.status === "fulfilled") setChannels(Array.isArray(cs.value) ? cs.value : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setModels([]);
    setMemberIds([]);
    form.resetFields();
    form.setFieldsValue({ type: undefined, name: "", remark: "", rate: 1 });
    setOpen(true);
  };

  const openEdit = (g) => {
    setEditing(g);
    setModels(Array.isArray(g.models) ? g.models : []);
    setMemberIds(Array.isArray(g.channel_ids) ? g.channel_ids.map(Number) : []);
    form.resetFields();
    form.setFieldsValue({ type: g.type, name: g.name, remark: g.remark || "", rate: Number(g.rate) || 1 });
    setOpen(true);
  };

  // 账号选项 = 该厂商的渠道；模型选项 = 已选账号（或该厂商全部渠道）声明模型的并集（tags 可手输通配）
  const channelOptions = useMemo(
    () =>
      channels
        .filter((c) => c.type === pickedType)
        .map((c) => ({ value: c.id, label: `${c.name}${c.account ? ` · ${c.account}` : ""}` })),
    [channels, pickedType]
  );

  const modelOptions = useMemo(() => {
    const pool = memberIds.length
      ? channels.filter((c) => memberIds.includes(c.id))
      : channels.filter((c) => c.type === pickedType);
    return [...new Set(pool.flatMap((c) => c.models || []))].map((m) => ({ value: m, label: m }));
  }, [channels, memberIds, pickedType]);

  const submit = async () => {
    if (busy) return;
    let v;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const payload = {
        type: editing?.type || v.type,
        name: v.name,
        remark: v.remark || "",
        rate: Number(v.rate) || 1,
        models,
        channel_ids: memberIds,
      };
      if (editing) await API.put(`/channel/groups/${editing.id}`, payload);
      else await API.post("/channel/groups", payload);
      message.success(editing ? "分组已更新" : "分组已创建");
      setOpen(false);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g) => {
    if (busy) return;
    setBusy(true);
    try {
      await API.del(`/channel/groups/${g.id}`);
      message.success("分组已删除");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      title: "厂商",
      dataIndex: "type",
      width: 150,
      render: (t, g) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <VendorIcon type={t} size={16} />
          <span>{g.typeName || t}</span>
        </span>
      ),
    },
    { title: "分组名", dataIndex: "name", width: 160, render: (v) => <span style={{ fontWeight: 550 }}>{v}</span> },
    {
      title: "备注",
      dataIndex: "remark",
      width: 200,
      render: (v) => (v ? <span className="oo-truncate">{v}</span> : <Text type="secondary">—</Text>),
    },
    {
      title: "倍率",
      dataIndex: "rate",
      width: 90,
      sorter: (a, b) => (Number(a.rate) || 1) - (Number(b.rate) || 1),
      render: (v) => {
        const r = Number(v) || 1;
        return r === 1 ? <span className="oo-num" style={{ color: "var(--ink-3)" }}>×1</span> : <span className="bui-chip">×{r}</span>;
      },
    },
    {
      title: "可用模型",
      dataIndex: "models",
      render: (list) =>
        list?.length ? (
          <Tooltip
            title={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {list.map((m) => <ModelLabel key={m} model={m} size={13} />)}
              </div>
            }
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <ModelLabel model={list[0]} size={13} />
              {list.length > 1 ? <span className="bui-chip">+{list.length - 1}</span> : null}
            </span>
          </Tooltip>
        ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>不限</Text>
        ),
    },
    {
      title: "账号",
      dataIndex: "count",
      width: 90,
      sorter: (a, b) => (a.count || 0) - (b.count || 0),
      render: (v) => <span className="oo-num">{v || 0}</span>,
    },
    {
      title: "操作",
      width: 140,
      fixed: "right",
      render: (_, g) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => openEdit(g)}>编辑</Button>
          <Popconfirm title={`删除分组「${g.name}」？已绑定的 Key 会自动解绑回默认池`} onConfirm={() => remove(g)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="分组管理"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新分组列表" aria-label="刷新分组列表" />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建分组</Button>
          </>
        }
      />

      <div className="oo-panel">
        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="分组列表加载失败"
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
          dataSource={groups}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个分组` }}
        />
      </div>

      <Modal
        title={editing ? `编辑分组：${editing.typeName} / ${editing.name}` : "新建分组"}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnClose
        okText={editing ? "保存" : "创建"}
        width={680}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Space size={12} align="start" style={{ display: "flex" }}>
            <Form.Item name="type" label="厂商" rules={[{ required: true, message: "请选择厂商" }]} style={{ width: 200 }}>
              <Select
                placeholder="选择厂商"
                disabled={Boolean(editing)}
                onChange={() => {
                  setModels([]);
                  setMemberIds([]);
                }}
                options={providers.map((p) => ({ value: p.key, label: p.name }))}
              />
            </Form.Item>
            <Form.Item name="name" label="分组名" rules={[{ required: true, message: "请填写分组名" }]} style={{ width: 200 }}>
              <Input placeholder="如 vip" maxLength={32} />
            </Form.Item>
            <Form.Item name="rate" label="计费倍率" style={{ width: 180 }}>
              <InputNumber min={0.0001} max={1000} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input placeholder="可为空" maxLength={64} />
          </Form.Item>
          <Form.Item label="包含哪些账号">
            <Select
              mode="multiple"
              placeholder={pickedType ? "可多选" : "先选择厂商"}
              disabled={!pickedType}
              value={memberIds}
              onChange={setMemberIds}
              options={channelOptions}
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label="支持的模型">
            <Select
              mode="tags"
              placeholder={pickedType ? "从账号模型里选，或手动输入" : "先选择厂商"}
              disabled={!pickedType}
              value={models}
              onChange={setModels}
              options={modelOptions}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
