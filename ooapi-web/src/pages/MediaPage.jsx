// 媒体库 —— 统一文件存储的前端入口
// ---------------------------------------------------------------------------
// 为什么要这个页面：媒体库建好后端只是「存得下」，用户看不见也管不了。
// 这一页承担三件事：① 看得见（宫格/列表两种视图 + 用量条）；② 管得动（改名、
// 下载、删除）；③ 管理员能按用户查（`?user_id=` 视图，用于排查占满配额的账号）。
//
// 几个刻意的设计取舍：
//   · **宫格与列表共用同一次请求**（都读 items），不各拉一套接口 —— 切换视图不该发请求；
//   · 图片缩略图直接用 `url`（签名 URL，永不过期），不做二次压缩：
//     上传时已限制单文件大小，且列表分页 24 条，浏览器原生缩放足够；
//   · **删除按钮在引用数 > 0 时仍然可点**，让后端返回「仍被 N 处引用」的明确原因 ——
//     前端自己禁用会让用户以为坏了；管理员额外给「强制删除」，
//     因为清理违规内容时确实需要绕过引用保护。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button, Table, Tag, Space, Typography, App as AntApp, Popconfirm, Tooltip, Empty,
  Alert, Input, Select, Segmented, Image, Drawer, Descriptions, Pagination, Modal,
} from "antd";
import {
  ReloadOutlined, AppstoreOutlined, UnorderedListOutlined, DeleteOutlined,
  DownloadOutlined, EditOutlined, PictureOutlined, FileOutlined, SearchOutlined,
  ClearOutlined, UserOutlined, EyeOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { fmtDate } from "../services/format";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";

const { Text } = Typography;

/** 字节数 → 可读文本（与运维监控页同一套口径；小文件不显示成 "0 KB"） */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

/** 用量分档配色：与渠道额度条、监控页同一套阈值（<70 绿 / 70-90 橙 / >90 红） */
function usageColor(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return "var(--accent)";
  if (p >= 90) return "var(--red)";
  if (p >= 70) return "var(--orange)";
  return "var(--green)";
}

// kind 的中文名与配色：媒体库的 kind 由后端按文件头判定（image/file/audio/video/other）
const KIND_META = {
  image: { label: "图片", color: "blue" },
  file: { label: "文档", color: "default" },
  audio: { label: "音频", color: "purple" },
  video: { label: "视频", color: "geekblue" },
  other: { label: "其他", color: "default" },
};

// 上传来源（source）的中文名：用户能理解「这张图是从哪来的」
const SOURCE_LABEL = {
  chat: "对话上传",
  avatar: "头像",
  post: "社区发帖",
  admin: "管理员上传",
};

const KIND_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "file", label: "文档" },
];
const STATUS_OPTIONS = [
  { value: 1, label: "正常" },
  { value: 2, label: "已删除" },
  { value: 3, label: "已封禁" },
];

export default function MediaPage() {
  const { message } = AntApp.useApp();
  const { user } = useApp();
  const isAdmin = user?.role >= 100;
  const { begin, isLatest } = useLatest();
  const [searchParams, setSearchParams] = useSearchParams();

  // 管理员视图的「看谁」既来自 URL `?user_id=`（可从别的页面直链过来），
  // 也可在页面内输入切换。URL 是唯一事实来源：改了就同步回地址栏，
  // 这样刷新/分享链接都能复现同一个视图。
  const urlScopeUserId = Number(searchParams.get("user_id")) || 0;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState("grid"); // grid | list
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [stats, setStats] = useState(null);
  const [scopeKeyword, setScopeKeyword] = useState("");
  const [scopeLoading, setScopeLoading] = useState(false);

  const [acting, setActing] = useState(false); // 行内操作防重入
  const [detail, setDetail] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [gcOpen, setGcOpen] = useState(false);
  const [gcRunning, setGcRunning] = useState(false);

  // 管理员按用户查看时，列表与统计都带这个参数
  const scopeParams = useMemo(
    () => (isAdmin && urlScopeUserId ? { user_id: urlScopeUserId } : {}),
    [isAdmin, urlScopeUserId]
  );

  const switchScope = useCallback(
    (uid) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (uid) next.set("user_id", String(uid));
          else next.delete("user_id");
          return next;
        },
        { replace: true } // 切换视图不该在浏览器历史里堆垃圾
      );
      setPage(1);
    },
    [setSearchParams]
  );

  const load = useCallback(async () => {
    const token = begin();
    setLoading(true);
    setLoadError("");
    try {
      const [list, st] = await Promise.all([
        API.get("/media/", {
          params: { p: page, page_size: pageSize, kind, q: keyword, status, ...scopeParams },
        }),
        API.get("/media/stats", { params: { ...scopeParams } }),
      ]);
      if (!isLatest(token)) return;
      setItems(Array.isArray(list?.items) ? list.items : []);
      setTotal(Number(list?.total) || 0);
      setStats(st || null);
    } catch (e) {
      if (isLatest(token)) {
        setLoadError(e.message || "媒体库加载失败");
        message.error(e.message || "媒体库加载失败");
      }
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, isLatest, message, page, pageSize, kind, keyword, status, scopeParams]);

  useEffect(() => {
    load();
  }, [load]);

  // 直链带 ?user_id= 进来时把输入框回填成当前范围，否则用户看不出「在看谁」
  useEffect(() => {
    if (!isAdmin) return;
    setScopeKeyword(urlScopeUserId ? String(urlScopeUserId) : "");
  }, [isAdmin, urlScopeUserId]);

  // 管理员：按用户名/ID 定位用户，再以该用户为范围查看
  const locateUser = async () => {
    const kw = scopeKeyword.trim();
    if (!kw) {
      switchScope(0);
      return;
    }
    if (/^\d+$/.test(kw)) {
      switchScope(Number(kw));
      return;
    }
    setScopeLoading(true);
    try {
      const data = await API.get("/users/", { params: { keyword: kw, p: 1, page_size: 1 } });
      const hit = data?.items?.[0];
      if (!hit) {
        message.warning(`没有找到用户「${kw}」`);
        return;
      }
      switchScope(hit.id);
      message.success(`已切换到用户 ${hit.username}（#${hit.id}）`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setScopeLoading(false);
    }
  };

  const remove = async (record, force = false) => {
    if (acting) return;
    setActing(true);
    try {
      await API.del(`/media/${record.id}${force ? "?force=1" : ""}`);
      message.success(force ? "已强制删除" : "已删除（保留期后可回收）");
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const download = (record) => {
    // 走签名 URL 并强制附件下载：非图片在后端本身就是 attachment，
    // 图片加 download=1 让它也变成下载而不是新开标签页
    const url = record.url ? `${record.url}&download=1` : "";
    if (!url) {
      message.error("该文件没有可用的下载地址");
      return;
    }
    window.open(url, "_blank", "noopener");
  };

  const openRename = (record) => {
    setRenameTarget(record);
    setRenameValue(record.orig_name || "");
  };

  const submitRename = async () => {
    if (!renameTarget || acting) return;
    setActing(true);
    try {
      await API.patch(`/media/${renameTarget.id}`, { orig_name: renameValue });
      message.success("已更新文件名");
      setRenameTarget(null);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const runGc = async () => {
    if (gcRunning) return;
    setGcRunning(true);
    try {
      const r = await API.post("/media/gc", { limit: 500 });
      message.success(`已标记 ${r?.softDeleted ?? 0} 个、清理 ${r?.purged ?? 0} 个`);
      setGcOpen(false);
      await load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setGcRunning(false);
    }
  };

  const quotaPct = stats?.quotaBytes > 0 ? (Number(stats.bytes) / Number(stats.quotaBytes)) * 100 : null;
  const maxFileMb = stats?.maxFileBytes ? Math.round(stats.maxFileBytes / 1048576) : 10;
  const scopeLabel = urlScopeUserId ? `用户 #${urlScopeUserId}` : stats?.scope === "all" ? "全站" : "本人";

  // ---- 卡片操作组：宫格与列表共用同一套动作，避免两处行为漂移 ----
  const actionsOf = (r) => [
    <Tooltip key="view" title="查看详情">
      <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => setDetail(r)} aria-label="查看详情" />
    </Tooltip>,
    <Tooltip key="download" title="下载">
      <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => download(r)} aria-label="下载" />
    </Tooltip>,
    <Tooltip key="rename" title="重命名">
      <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openRename(r)} aria-label="重命名" />
    </Tooltip>,
    // 引用保护由后端裁决（前端禁用会让用户以为功能坏了，看不到「被谁引用」）
    <Popconfirm
      key="del"
      title="删除这个文件？"
      description="若仍被对话或头像引用，后端会拒绝并说明原因。"
      onConfirm={() => remove(r)}
      okText="删除"
      cancelText="取消"
    >
      <Tooltip title="删除">
        <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={acting} aria-label="删除" />
      </Tooltip>
    </Popconfirm>,
  ];

  const columns = [
    {
      title: "文件",
      dataIndex: "orig_name",
      width: 280,
      render: (_, r) => (
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {r.kind === "image" ? (
            <Image
              src={r.url}
              alt={r.orig_name || `#${r.id}`}
              width={36}
              height={36}
              style={{ objectFit: "cover", borderRadius: "var(--r-xs)", flexShrink: 0 }}
              preview={{ mask: null }}
            />
          ) : (
            <span
              style={{
                width: 36, height: 36, flexShrink: 0, display: "inline-flex",
                alignItems: "center", justifyContent: "center",
                background: "var(--inset)", borderRadius: "var(--r-xs)", color: "var(--ink-3)",
              }}
            >
              <FileOutlined style={{ fontSize: 16 }} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="oo-truncate" style={{ fontWeight: 500 }}>
              {r.orig_name || <Text type="secondary">未命名 · #{r.id}</Text>}
            </div>
            <div className="oo-truncate" style={{ fontSize: 12, color: "var(--ink-3)" }}>
              #{r.id}
              {r.width && r.height ? ` · ${r.width}×${r.height}` : ""}
              {isAdmin ? ` · 用户 #${r.user_id}` : ""}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      width: 100,
      render: (k, r) => (
        <Space size={4}>
          <Tag color={KIND_META[k]?.color || "default"}>{KIND_META[k]?.label || k || "其他"}</Tag>
          {r.ext ? <Text type="secondary" style={{ fontSize: 12 }}>{r.ext}</Text> : null}
        </Space>
      ),
    },
    { title: "大小", dataIndex: "size", width: 100, render: (v) => <span className="oo-num">{fmtBytes(v)}</span> },
    {
      title: "引用",
      dataIndex: "ref_count",
      width: 90,
      render: (n) =>
        n > 0 ? (
          <Tooltip title={`被 ${n} 处内容引用，需先删除对应内容`}>
            <span className="bui-chip">{n} 处</span>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>未引用</Text>
        ),
    },
    {
      title: "来源",
      dataIndex: "source",
      width: 110,
      render: (s) => (s ? SOURCE_LABEL[s] || s : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>),
    },
    { title: "上传时间", dataIndex: "created_time", width: 160, render: (v) => <span className="oo-num">{fmtDate(v)}</span> },
    {
      title: "操作",
      width: 160,
      fixed: "right",
      render: (_, r) => (
        <Space size={0}>
          {actionsOf(r)}
          {isAdmin ? (
            <Popconfirm
              title="强制删除？"
              description="会同时解绑所有引用，引用它的内容将留下死链。"
              onConfirm={() => remove(r, true)}
              okText="强制删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Tooltip title="管理员强制删除">
                <Button type="text" size="small" danger icon={<ClearOutlined />} disabled={acting} aria-label="强制删除" />
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
        title="媒体库"
        tags={
          isAdmin ? (
            <Tag color={stats?.scope === "all" ? "gold" : "blue"}>
              {stats?.scope === "all" ? "全站视图" : scopeLabel}
            </Tag>
          ) : null
        }
        extra={
          <>
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: "grid", icon: <AppstoreOutlined />, title: "宫格视图" },
                { value: "list", icon: <UnorderedListOutlined />, title: "列表视图" },
              ]}
            />
            {isAdmin ? (
              <Button icon={<ClearOutlined />} onClick={() => setGcOpen(true)}>
                回收
              </Button>
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={load} title="刷新媒体库" aria-label="刷新媒体库" />
          </>
        }
      />

      {/* 汇总卡片：这一页的主体是文件集合，用量本身就是用户最关心的数字，
          所以按 2.5 规范用卡片（不是表格页的小标签）。 */}
      <div className="oo-grid">
        <StatCard
          label="文件数"
          value={loadError ? "—" : (stats?.count ?? 0)}
          suffix="个"
          icon={<PictureOutlined />}
          foot={<span>{scopeLabel}</span>}
        />
        <StatCard
          label="已用空间"
          value={loadError ? "—" : fmtBytes(stats?.bytes)}
          icon={<AppstoreOutlined />}
          foot={
            quotaPct === null ? (
              <span>配额不限</span>
            ) : (
              <span>
                共 {fmtBytes(stats?.quotaBytes)} · 已用 {quotaPct.toFixed(1)}%
              </span>
            )
          }
        />
        <StatCard
          label="单文件上限"
          value={loadError ? "—" : maxFileMb}
          suffix="MB"
          icon={<FileOutlined />}
          foot={<span>超出会被拒绝（后端按设置项判定）</span>}
        />
        <StatCard
          label="保留策略"
          value={loadError ? "—" : stats?.retentionDays ?? "—"}
          suffix="天"
          icon={<DeleteOutlined />}
          foot={<span>{stats?.orphanHours ? `未引用 ${stats.orphanHours} 小时后回收` : "不自动回收"}</span>}
        />
      </div>

      {/* 配额进度条：只在有配额时出现，超 70% 变橙、超 90% 变红 */}
      {quotaPct !== null ? (
        <div className="oo-panel" style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              存储配额（{scopeLabel}）
            </span>
            <span className="oo-num" style={{ fontSize: 12, color: usageColor(quotaPct), fontWeight: 600 }}>
              {fmtBytes(stats?.bytes)} / {fmtBytes(stats?.quotaBytes)}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "var(--inset)", overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, quotaPct))}%`,
                height: "100%",
                background: usageColor(quotaPct),
                transition: "width .2s ease",
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="oo-panel">
        <div className="oo-toolbar">
          <Input.Search
            placeholder="搜索文件名"
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />}
            style={{ width: 200 }}
            onSearch={(v) => {
              setKeyword(v);
              setPage(1);
            }}
            onChange={(e) => {
              if (!e.target.value) {
                setKeyword("");
                setPage(1);
              }
            }}
          />
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v || "");
              setPage(1);
            }}
            style={{ width: 120 }}
            options={KIND_OPTIONS}
          />
          {isAdmin ? (
            <>
              <Select
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
                style={{ width: 110 }}
                options={STATUS_OPTIONS}
              />
              {/* 管理员按用户查看：支持用户名或 ID，清空即回全站视图 */}
              <Input
                placeholder="按用户查看（用户名或 ID）"
                allowClear
                prefix={<UserOutlined style={{ color: "var(--ink-3)" }} />}
                style={{ width: 220 }}
                value={scopeKeyword}
                onChange={(e) => setScopeKeyword(e.target.value)}
                onPressEnter={locateUser}
                onBlur={() => {
                  if (!scopeKeyword.trim() && urlScopeUserId) locateUser();
                }}
                suffix={
                  <Button type="text" size="small" loading={scopeLoading} onClick={locateUser}>
                    定位
                  </Button>
                }
              />
            </>
          ) : null}
          <span className="oo-toolbar-spacer" />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>共 {total} 个文件</span>
        </div>

        {loadError ? (
          <Alert
            type="error"
            showIcon
            message="媒体库加载失败"
            description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ margin: 14 }}
          />
        ) : null}

        {view === "list" ? (
          <Table
            className="oo-table"
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={items}
            scroll={{ x: 1000 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (t) => `共 ${t} 个`,
              onChange: (p, ps) => {
                setPage(p);
                setPageSize(ps);
              },
            }}
            locale={{
              emptyText: (
                <Empty
                  image={<PictureOutlined style={{ fontSize: 40, color: "var(--ink-3)" }} />}
                  description={keyword || kind ? "没有符合条件的文件" : "媒体库还是空的；在对话里发图片、或上传头像后就会出现在这里"}
                />
              ),
            }}
          />
        ) : (
          <MediaGrid
            items={items}
            loading={loading}
            onOpen={setDetail}
            actionsOf={actionsOf}
            empty={keyword || kind ? "没有符合条件的文件" : "媒体库还是空的；在对话里发图片、或上传头像后就会出现在这里"}
          />
        )}

        {view === "grid" && total > 0 ? (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 14px" }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              pageSizeOptions={[12, 24, 48, 96]}
              showTotal={(t) => `共 ${t} 个`}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
            />
          </div>
        ) : null}
      </div>

      {/* 详情抽屉：完整元信息 + 强制删除入口（管理员） */}
      <Drawer title="文件详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={520} destroyOnClose>
        {detail ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {detail.kind === "image" ? (
              <Image src={detail.url} alt={detail.orig_name || ""} style={{ maxHeight: 260, objectFit: "contain" }} />
            ) : null}
            <Descriptions column={1} size="small" bordered labelStyle={{ width: 110 }}>
              <Descriptions.Item label="文件名">{detail.orig_name || "未命名"}</Descriptions.Item>
              <Descriptions.Item label="ID">#{detail.id}</Descriptions.Item>
              <Descriptions.Item label="类型">
                {KIND_META[detail.kind]?.label || detail.kind} / {detail.mime || "-"}
              </Descriptions.Item>
              <Descriptions.Item label="大小">{fmtBytes(detail.size)}</Descriptions.Item>
              {detail.width && detail.height ? (
                <Descriptions.Item label="尺寸">{detail.width} × {detail.height}</Descriptions.Item>
              ) : null}
              <Descriptions.Item label="归属用户">#{detail.user_id}</Descriptions.Item>
              <Descriptions.Item label="来源">{SOURCE_LABEL[detail.source] || detail.source || "—"}</Descriptions.Item>
              <Descriptions.Item label="引用数">{detail.ref_count} 处</Descriptions.Item>
              <Descriptions.Item label="上传时间">{fmtDate(detail.created_time)}</Descriptions.Item>
              <Descriptions.Item label="最近访问">
                {detail.last_access_time ? fmtDate(detail.last_access_time) : "从未访问"}
              </Descriptions.Item>
              <Descriptions.Item label="SHA256">
                <span className="oo-mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{detail.sha256}</span>
              </Descriptions.Item>
            </Descriptions>
            <Space>
              <Button icon={<DownloadOutlined />} onClick={() => download(detail)}>下载</Button>
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  openRename(detail);
                  setDetail(null);
                }}
              >
                重命名
              </Button>
            </Space>
          </div>
        ) : null}
      </Drawer>

      {/* 重命名 */}
      <Modal
        title="重命名文件"
        open={Boolean(renameTarget)}
        onOk={submitRename}
        confirmLoading={acting}
        onCancel={() => setRenameTarget(null)}
        okText="保存"
        width={420}
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={submitRename}
          placeholder="文件名（仅用于展示与下载）"
          maxLength={255}
          showCount
        />
      </Modal>

      {/* 回收：管理员手动触发（后台也有 6 小时定时任务） */}
      <Modal
        title="回收未引用文件"
        open={gcOpen}
        onOk={runGc}
        confirmLoading={gcRunning}
        onCancel={() => setGcOpen(false)}
        okText="开始回收"
        width={460}
      >
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          回收会做两件事：
          <ul style={{ paddingLeft: 20, margin: "8px 0" }}>
            <li>标记长期未引用（超过 {stats?.orphanHours ?? 24} 小时）的文件为待删；</li>
            <li>物理清理已软删超过 {stats?.retentionDays ?? 7} 天的文件（磁盘空间真正释放）。</li>
          </ul>
          仍被对话、头像等内容引用的文件不会被回收。
        </div>
      </Modal>
    </div>
  );
}

/** 宫格视图：图片直接显示缩略图，非图片显示类型图标 */
function MediaGrid({ items, loading, onOpen, actionsOf, empty }) {
  if (!loading && !items.length) {
    return (
      <div style={{ padding: "40px 0", textAlign: "center", color: "var(--ink-3)" }}>
        <PictureOutlined style={{ fontSize: 40, display: "block", margin: "0 auto 10px" }} />
        {empty}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, padding: 14 }}>
      {items.map((r) => (
        <div
          key={r.id}
          style={{
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            background: "var(--surface)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpen(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(r);
              }
            }}
            title={r.orig_name || `#${r.id}`}
            style={{
              height: 120, background: "var(--inset)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
            }}
          >
            {r.kind === "image" ? (
              <img
                src={r.url}
                alt={r.orig_name || `#${r.id}`}
                loading="lazy"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <FileOutlined style={{ fontSize: 28, color: "var(--ink-3)" }} />
            )}
          </div>
          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span className="oo-truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>
              {r.orig_name || `未命名 · #${r.id}`}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 6 }}>
              <span>{fmtBytes(r.size)}</span>
              {r.ref_count > 0 ? <span>· 引用 {r.ref_count}</span> : null}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
              <Space size={0}>{actionsOf(r)}</Space>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
