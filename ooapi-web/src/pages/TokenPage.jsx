import React, { useEffect, useState, useCallback } from "react";
import {
  Button, Table, Modal, Form, Input, Switch, InputNumber, DatePicker,
  Select, Tag, Space, Typography, App as AntApp, Popconfirm, Tooltip, Empty,
  Alert, Grid,
} from "antd";
import { PlusOutlined, CopyOutlined, ReloadOutlined, KeyOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { API } from "../services/api";
import { copyText, fmtDate, fmtOd, odOf, unitsPerOd, CURRENCY_NAME } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import { VendorIcon, ModelLabel, GroupVendorIcons, GroupRateBadge, GroupTag } from "../components/VendorIcon";

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

  // 分组下拉：一个 Key 只能绑定一个分组
  // 结构升级为专业 SaaS 三段式卡片（左侧厂商图标叠放，中间上下双行标题与备注，右侧精致微胶囊倍率）
  // 绑定值就是分组名（全局唯一，可跨厂商）
  const groupOptions = React.useMemo(
    () =>
      groupList.map((g) => ({
        value: g.name,
        search: `${g.name} ${g.remark || ""} ${g.vendor || ""} ${(g.vendors || []).join(" ")}`.toLowerCase(),
        // 选定后在 Select 框内的单行精简回显
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
            <GroupVendorIcons vendors={g.vendors} size={14} />
            <span className="oo-truncate">{g.name}</span>
          </span>
        ),
        // 下拉列表中展开时的三段式卡片
        renderItem: (
          <div className="oo-group-select-item">
            <div className="oo-group-select-item__left">
              <GroupVendorIcons vendors={g.vendors} size={16} />
              <div className="oo-group-select-item__meta">
                <div className="oo-truncate oo-group-select-item__title">{g.name}</div>
                {g.remark ? (
                  <div className="oo-truncate oo-group-select-item__desc">{g.remark}</div>
                ) : (
                  <div className="oo-truncate oo-group-select-item__desc" style={{ opacity: 0.75 }}>
                    {Array.isArray(g.models) && g.models.length ? `支持 ${g.models.length} 个指定模型` : "支持全量模型"}
                  </div>
                )}
              </div>
            </div>
            <GroupRateBadge rate={g.rate} />
          </div>
        ),
      })),
    [groupList]
  );

  // 由绑定值反查分组：先按整串精确匹配（新格式就是分组名）；
  // 匹配不到再按旧格式 "厂商:分组名" 剥掉前缀重试（兼容历史绑定）。
  const groupMetaOf = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const direct = groupList.find((g) => g.name === raw);
    if (direct) return direct;
    const idx = raw.indexOf(":");
    if (idx > 0 && idx < raw.length - 1) {
      const name = raw.slice(idx + 1);
      const legacy = groupList.find((g) => g.name === name);
      if (legacy) return legacy;
      // 分组已被删除：仍返回一个「按名字」的占位，避免界面显示 0 信息
      return { name, type: "", vendor: "", rate: 1, models: [] };
    }
    return null;
  };

  // 当前选中的分组：密钥的可用模型完全由分组决定，表单不再单独选模型
  const pickedGroupName = Form.useWatch("group_name", form);
  const pickedGroupMeta = groupMetaOf(pickedGroupName);

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
      model_limits: [],
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

  // 窄屏时列会被 responsive 收起，scroll.x 必须跟着变小。
  //
  // 原先写死 `scroll={{ x: 1480 }}` —— 那是「9 列全在时的列宽之和」。
  // 收起 4 列后表格仍被撑到 1480px，手机上依然只有 2 列可见、其余全靠横向滚动，
  // 等于 responsive 白做了（实测：收起后 totalCols=6 但 innerTableW 仍是 1480）。
  // 用 breakpoint 算真实需要的总宽：手机上只剩名称+状态+额度+操作。
  const screens = Grid.useBreakpoint();
  const isNarrow = !screens.md; // < 768px
  const scrollX = isNarrow ? 170 + 92 + 130 + 180 : 1480; // 名称+状态+额度+操作

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
    // 窄屏（手机）只保留「名称 + 状态 + 额度 + 操作」这四列最有信息量的，
    // 其余靠 responsive 自动收起。
    //
    // 实测背景（黑盒测试在 390×844 视口量的）：这张表宽 1480px、屏幕只有 390px，
    // 首屏**只看得见 2 列**（名称、操作），而「密钥/状态/额度/已用/分组」
    // 全在屏幕外。虽然能横向滚动，但用户第一眼看不到中间列、也意识不到要滚。
    // 收起冗余列后，第一屏能直接看到「这把 Key 是什么状态、还剩多少额度」。
    // 桌面端不受影响（md/lg 以上照旧全显示）。
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
      responsive: ["md"],
      render: (q) => <span className="oo-num">{fmtOd(q, perUnit, 4)}</span>,
    },
      {
        title: "分组",
        dataIndex: "group",
        width: 150,
        // 手机上收起（分组是配置信息，不常看；名称/状态/额度已经说清这把 Key 能不能用）
        responsive: ["lg"],
        render: (g) => {
          // 未绑分组的密钥**不能调用**（网关会返回 403 token_group_required），
          // 所以这里不能只显示一个「—」当装饰 —— 那看起来像「没设置也无所谓」。
          // 用户要求（原话）：「密钥必须绑定分组…如果密钥没绑定分组则直接调用的时候报错啊」。
          // 展示上把它标成待处理状态，并说清后果与怎么修。
          if (!g) {
            return (
              <Tooltip title="该密钥未绑定分组，调用会被拒绝（403）。点「编辑」给它选一个分组即可恢复。">
                <span className="bui-chip" style={{ color: "var(--pill-red-ink)", background: "var(--pill-red-tint)" }}>
                  未绑定 · 不可用
                </span>
              </Tooltip>
            );
          }
          const meta = groupMetaOf(g);
          return <GroupTag name={meta?.name || g} meta={meta} />;
        },
      },

      {
        title: "可用模型",
        dataIndex: "group",
        width: 170,
        responsive: ["lg"],
        render: (g) => {
          const list = groupMetaOf(g)?.models || [];
          if (!g) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
          if (!list.length) return <Text type="secondary" style={{ fontSize: 12 }}>不限</Text>;
          return (
            <Tooltip
              title={
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {list.map((m) => <ModelLabel key={m} model={m} size={13} mono />)}
                </div>
              }
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <ModelLabel model={list[0]} size={13} />
                {list.length > 1 ? <span className="bui-chip">+{list.length - 1}</span> : null}
              </span>
            </Tooltip>
          );
        },
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
        extra={
          <Space size={6} wrap>
            <Button size="small" icon={<ReloadOutlined />} onClick={load} title="刷新令牌列表" aria-label="刷新令牌列表" />
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              创建令牌
            </Button>
          </Space>
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
          size="small"
          columns={columns}
          dataSource={items}
          // scroll.x 必须 ≥ **当前可见列**的宽度之和，否则 fixed 布局会把每列按比例压缩，
          // 密钥列与可用模型列会出现非预期截断。
          // 手机端可见列少（responsive 收起了 4 列），总宽要跟着降下来 ——
          // 否则仍被撑到 1480px，一屏还是只看得到 2 列（见 scrollX 的注释）。
          scroll={{ x: scrollX }}
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
        width={600}
      >
        <Form form={form} layout="vertical" requiredMark={false} className="oo-form-grid">
          <Form.Item className="oo-form-grid__full" name="name" label="名称" rules={[{ required: true, message: "请输入令牌名称" }]}>
            <Input placeholder="例如：my-app" maxLength={64} />
          </Form.Item>

          <div className="oo-form-grid__pair">
            <Form.Item name="unlimited_quota" label="无限额度" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => p.unlimited_quota !== c.unlimited_quota}>
              {({ getFieldValue }) =>
                !getFieldValue("unlimited_quota") ? (
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
                ) : null
              }
            </Form.Item>
          </div>

          <div className="oo-form-grid__pair">
            <Form.Item name="never_expire" label="永不过期" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => p.never_expire !== c.never_expire}>
              {({ getFieldValue }) =>
                !getFieldValue("never_expire") ? (
                  <Form.Item name="expired_time" label="过期时间" rules={[{ required: true, message: "请选择过期时间" }]}>
                    <DatePicker showTime style={{ width: "100%" }} />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </div>

          {/* 分组是**必填**：用户要求「密钥必须绑定分组，我们没有那个所谓的公共，
              以及系统默认池，这玩意给我彻底清掉」。
              以前可以不绑定（= 落到「公共池」，只能调用同样没分组的渠道），
              那个池子已经废弃 —— 不绑分组时密钥既不知道按哪个倍率计费、
              也不清楚能调哪些渠道，属于说不清归属的状态。 */}
          <Form.Item
            className="oo-form-grid__full"
            name="group_name"
            label="分组"
            rules={[{ required: true, message: "请选择分组（密钥必须归属某个分组）" }]}
          >
            <Select
              allowClear
              showSearch
              placeholder="请选择分组"
              options={groupOptions}
              optionRender={(opt) => opt.data?.renderItem || opt.label}
              filterOption={(input, option) => (option?.search || "").includes(input.toLowerCase())}
              popupMatchSelectWidth={false}
              dropdownStyle={{ minWidth: 380, padding: "6px" }}
              notFoundContent={<span style={{ fontSize: 12 }}>还没有分组，请先到「分组管理」创建一个</span>}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
