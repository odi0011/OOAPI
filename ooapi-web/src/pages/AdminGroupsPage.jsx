import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Table, Button, Space, Input, Popconfirm, Modal, Form, Select,
  InputNumber, App as AntApp, Typography, Alert, Tooltip,
} from "antd";
import { ReloadOutlined, PlusOutlined, SearchOutlined, ApiOutlined } from "@ant-design/icons";
import { API } from "../services/api";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel, GroupVendorIcons, GroupRateBadge, GroupTag } from "../components/VendorIcon";

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
  const [search, setSearch] = useState("");
  const [form] = Form.useForm();
  // 账号选择区的「按厂商筛选」视图开关：只影响候选列表的显示，
  // 不影响分组成员的范围（分组可以跨厂商）
  const [vendorFilter, setVendorFilter] = useState(undefined);

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
    setVendorFilter(undefined);
    form.resetFields();
    form.setFieldsValue({ type: undefined, name: "", remark: "", rate: 1 });
    setOpen(true);
  };

  const openEdit = (g) => {
    setEditing(g);
    setModels(Array.isArray(g.models) ? g.models : []);
    setMemberIds(Array.isArray(g.channel_ids) ? g.channel_ids.map(Number) : []);
    // 编辑时不再按厂商过滤候选，直接展示全部账号（分组可能跨厂商）
    setVendorFilter(undefined);
    form.resetFields();
    form.setFieldsValue({ type: g.vendor || g.type || undefined, name: g.name, remark: g.remark || "", rate: Number(g.rate) || 1 });
    setOpen(true);
  };

  // 账号候选项 = 全部渠道（分组**可以跨厂商**）。
  const channelOptions = useMemo(() => {
    const list = vendorFilter ? channels.filter((c) => c.type === vendorFilter) : channels;
    return list.map((c) => ({
      value: c.id,
      label: `${c.name}${c.account ? ` · ${c.account}` : ""} · ${c.typeName || c.type || ""}`,
    }));
  }, [channels, vendorFilter]);

  const modelOptions = useMemo(() => {
    if (!memberIds.length) return [];
    const pool = channels.filter((c) => memberIds.includes(c.id));
    return [...new Set(pool.flatMap((c) => (Array.isArray(c.models) ? c.models : [])))].sort().map((m) => ({ value: m, label: m }));
  }, [channels, memberIds]);

  // 分组图标 = **成员渠道**涉及到的厂商（去重）
  const iconsOfGroup = useCallback(
    (g) => {
      const ids = Array.isArray(g.channel_ids) ? g.channel_ids.map(Number) : [];
      if (!ids.length) return [];
      return [...new Set(channels.filter((c) => ids.includes(c.id)).map((c) => c.type).filter(Boolean))];
    },
    [channels]
  );

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        (g.name || "").toLowerCase().includes(q) ||
        (g.remark || "").toLowerCase().includes(q)
    );
  }, [groups, search]);

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
        type: v.type || "",
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
      title: "分组名称",
      dataIndex: "name",
      width: 200,
      render: (v, g) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }} className="oo-truncate">
              {v}
            </span>
            {v === "default" ? (
              <span className="bui-chip bui-chip--accent" style={{ fontSize: 10.5, height: 16, lineHeight: "16px", padding: "0 4px" }}>
                默认
              </span>
            ) : null}
          </div>
          {g.remark ? (
            <div className="oo-truncate" style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.3 }} title={g.remark}>
              {g.remark}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "成员厂商",
      width: 140,
      render: (_, g) => {
        const icons = iconsOfGroup(g);
        const names = icons.map((x) => providers.find((p) => p.key === x)?.name || x);
        if (!icons.length) {
          return <span className="bui-chip bui-chip--muted" style={{ fontSize: 11 }}>未关联厂商</span>;
        }
        return (
          <Tooltip title={`成员厂商：${names.join("、")}`}>
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              <GroupVendorIcons vendors={icons} size={16} />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "计费倍率",
      dataIndex: "rate",
      width: 110,
      sorter: (a, b) => (Number(a.rate) || 1) - (Number(b.rate) || 1),
      render: (v) => <GroupRateBadge rate={v} />,
    },
    {
      title: "模型范围",
      dataIndex: "models",
      width: 190,
      render: (list) => {
        if (!list || !list.length) {
          return (
            <Tooltip title="未限制模型：该分组的密钥可直接使用关联渠道支持的全部模型">
              <span className="bui-chip bui-chip--muted" style={{ fontSize: 11.5, cursor: "default" }}>
                全部模型（不限）
              </span>
            </Tooltip>
          );
        }
        return (
          <Tooltip
            title={
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 300, overflow: "auto" }}>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>支持以下 {list.length} 个模型：</div>
                {list.map((m) => (
                  <ModelLabel key={m} model={m} size={13} />
                ))}
              </div>
            }
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "default" }}>
              <ModelLabel model={list[0]} size={13} />
              {list.length > 1 ? (
                <span className="bui-chip" style={{ fontSize: 10.5, height: 16, lineHeight: "16px", padding: "0 4px" }}>
                  +{list.length - 1}
                </span>
              ) : null}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "关联渠道",
      width: 140,
      sorter: (a, b) => {
        const aLen = Array.isArray(a.channel_ids) ? a.channel_ids.length : (a.count || 0);
        const bLen = Array.isArray(b.channel_ids) ? b.channel_ids.length : (b.count || 0);
        return aLen - bLen;
      },
      render: (_, g) => {
        const ids = Array.isArray(g.channel_ids) ? g.channel_ids.map(Number) : [];
        const bound = channels.filter((c) => ids.includes(c.id));
        const count = ids.length || g.count || 0;
        if (!count) {
          return <span style={{ color: "var(--ink-3)", fontSize: 12 }}>—</span>;
        }
        const tip = bound.length
          ? `关联渠道：${bound.map((c) => `${c.name} (${c.typeName || c.type || "通用"})`).join("、")}`
          : `关联 ${count} 个渠道`;
        return (
          <Tooltip title={tip}>
            <span className="bui-chip" style={{ fontSize: 11.5, cursor: "default" }}>
              <ApiOutlined style={{ fontSize: 11, color: "var(--ink-3)" }} />
              <span>{count} 个渠道</span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "操作",
      width: 120,
      fixed: "right",
      render: (_, g) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(g)}>
            编辑
          </Button>
          {g.name !== "default" ? (
            <Popconfirm title={`确定删除分组「${g.name}」？已绑定的 Key 会自动解绑回系统默认池`} onConfirm={() => remove(g)}>
              <Button type="link" size="small" danger>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div className="oo-page">
      <PageHeader
        title="分组管理"
        extra={
          <Space size={6} wrap>
            <Button size="small" icon={<ReloadOutlined />} onClick={load} title="刷新分组列表" aria-label="刷新分组列表" />
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建分组</Button>
          </Space>
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
          <Input
            placeholder="按分组名或备注搜索..."
            prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            共 {filteredGroups.length} 个分组
          </span>
        </div>
        <Table
          className="oo-table"
          rowKey="id"
          loading={loading}
          size="small"
          columns={columns}
          dataSource={filteredGroups}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个分组` }}
        />
      </div>


      <Modal
        title={editing ? `编辑分组：${editing.name}` : "新建分组"}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        // destroyOnClose 会在关闭时卸载表单，而 useForm 实例还在 —— 重新打开前
        // 表单尚未挂载，setFieldsValue 找不到目标，antd 会警告
        // "Instance created by useForm is not connected to any Form element"，
        // 且表单值可能不生效。改为 forceRender + 关闭时手动 resetFields（openCreate/openEdit 已做）。
        forceRender
        okText={editing ? "保存" : "创建"}
        width={680}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Space size={12} align="start" style={{ display: "flex" }}>
            <Form.Item name="name" label="分组名" rules={[{ required: true, message: "请填写分组名" }]} style={{ width: 200 }}>
              <Input placeholder="如 vip" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="type"
              label="厂商筛选"
              tooltip="可选。只用于在建组时快速筛出某个厂商的账号；分组本身可以包含任意厂商的账号（留空 = 不限厂商）"
              style={{ width: 200 }}
            >
              <Select
                placeholder="不限厂商"
                allowClear
                onChange={(v) => {
                  // 只切换候选视图，不清空已选账号（分组可跨厂商）
                  setVendorFilter(v || undefined);
                }}
                options={providers.map((p) => ({ value: p.key, label: p.name }))}
              />
            </Form.Item>
            <Form.Item
              name="rate"
              label={
                <Space size={6}>
                  <span>计费倍率</span>
                  <Form.Item noStyle shouldUpdate={(p, c) => p.rate !== c.rate}>
                    {({ getFieldValue }) => <GroupRateBadge rate={getFieldValue("rate")} />}
                  </Form.Item>
                </Space>
              }
              style={{ width: 180 }}
            >
              <InputNumber min={0.0001} max={1000} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input placeholder="可为空" maxLength={64} />
          </Form.Item>
          <Form.Item
            label="包含哪些账号"
            extra={`可跨厂商多选${vendorFilter ? `（当前仅显示 ${providers.find((p) => p.key === vendorFilter)?.name || vendorFilter} 的账号，可在上方「厂商筛选」里切换）` : ""}；不选 = 该分组不含任何账号`}
          >
            <Select
              mode="multiple"
              placeholder="可多选（账号来自任意厂商）"
              value={memberIds}
              onChange={(v) => {
                setMemberIds(v);
                // 渠道变了 → 已选模型可能已不在可选范围内，剔除掉，避免「分组里有
                // 没有任何账号支持的模型」这种静默失效配置
                const pool = channels.filter((c) => (v || []).includes(c.id));
                const allowed = new Set(pool.flatMap((c) => (Array.isArray(c.models) ? c.models : [])));
                setModels((prev) => prev.filter((m) => allowed.has(m)));
              }}
              options={channelOptions}
              optionFilterProp="label"
              maxTagCount={6}
            />
          </Form.Item>
          <Form.Item
            label="支持的模型"
            extra={
              memberIds.length
                ? "候选来自你选中的账号（渠道声明 + 上游探测）；留空 = 不限（跟随账号）"
                : "先选择账号，模型候选会从这些账号支持的模型里汇总"
            }
          >
            <Space direction="vertical" style={{ width: "100%" }} size={6}>
              <Space size={6} wrap>
                <Button
                  size="small"
                  disabled={!modelOptions.length}
                  onClick={() => setModels(modelOptions.map((o) => o.value))}
                >
                  全选
                </Button>
                <Button size="small" disabled={!models.length} onClick={() => setModels([])}>
                  清空（= 不限）
                </Button>
                {modelOptions.length ? (
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    可选 {modelOptions.length} 个，已选 {models.length} 个
                  </span>
                ) : null}
              </Space>
              <Select
                mode="multiple"
                allowClear
                placeholder={memberIds.length ? "留空 = 不限（跟随账号）" : "先选择账号"}
                disabled={!memberIds.length}
                value={models}
                onChange={setModels}
                options={modelOptions}
                optionRender={(opt) => <ModelLabel model={opt.value} size={14} />}
                maxTagCount={10}
                maxTagPlaceholder={(omitted) => `+${omitted.length}`}
                style={{ width: "100%" }}
              />
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
