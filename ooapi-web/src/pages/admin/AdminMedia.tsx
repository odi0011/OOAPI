import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  FolderOpen,
  Pencil,
  RefreshCw,
  SearchX,
  Trash2,
} from "lucide-react";

import Badge from "@/components/arc/badge/badge";
import { BottomSheet } from "@/components/arc/bottom-sheet/bottom-sheet";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Input } from "@/components/arc/input/input";
import { Pagination } from "@/components/arc/pagination/pagination";
import { SearchField } from "@/components/arc/search-field/search-field";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Select } from "@/components/arc/select/select";
import {
  SortableDataTable,
  type DataColumn,
  type SortState,
} from "@/components/arc/sortable-data-table/sortable-data-table";
import Tooltip from "@/components/arc/tooltip/tooltip";
import AdminLayout from "@/components/admin/AdminLayout";
import { useAuth } from "@/contexts/AuthContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { Perm } from "@/lib/permissions";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import styles from "./AdminMedia.module.css";

/**
 * 媒体库。
 *
 * 数据范围由服务端收口：普通用户只能看到自己的文件，
 * 管理员（log:view_all）可以切换「全站 / 指定用户 / 已删除」视图。
 * 前端只负责隐藏入口与筛选，不承担安全边界。
 *
 * 上传走 multipart，不能用 apiRequest（它会 JSON 序列化 body），
 * 因此这里直接 fetch + 手工解析同一套 { success, data } 信封。
 */

interface MediaItem extends Record<string, unknown> {
  id: number;
  user_id: number;
  size: number;
  mime: string;
  kind: string;
  ext: string;
  orig_name: string;
  source: string;
  width: number;
  height: number;
  ref_count: number;
  status: number;
  created_at: string;
  url: string;
}

interface MediaDetail extends MediaItem {
  sha256: string;
  last_access_at?: string | null;
}

interface MediaStats {
  scope: "self" | "user" | "all";
  count: number;
  bytes: number;
  quota_bytes: number;
  max_file_bytes: number;
  enabled: boolean;
  orphan_hours: number;
  retention_days: number;
  by_kind: { kind: string; count: number; bytes: number }[];
}

interface MediaRef {
  ref_type: string;
  ref_id: string;
}

interface UploadResult {
  id: number;
  deduped: boolean;
  url: string;
}

const PAGE_SIZE = 24;
const GC_LIMIT = 200;

const KIND_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "file", label: "文档" },
];

const STATUS_OPTIONS = [
  { value: "1", label: "正常" },
  { value: "2", label: "已删除" },
];

const SOURCE_LABELS: Record<string, string> = {
  upload: "媒体库上传",
  avatar: "头像",
  chat: "对话上传",
  post: "社区发帖",
  community: "社区",
  admin: "管理员上传",
};

const REF_LABELS: Record<string, string> = {
  avatar: "头像",
  chat: "对话消息",
  post: "社区发帖",
  community: "社区内容",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? (source || "未知");
}

function refLabel(ref: MediaRef): string {
  return `${REF_LABELS[ref.ref_type] ?? ref.ref_type} #${ref.ref_id}`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(raw?: string | null): string {
  return raw ? raw.replace("T", " ").slice(0, 19) : "—";
}

export default function AdminMedia() {
  const { can } = useAuth();
  const notify = useNotify();
  const mayAdmin = can(Perm.LogViewAll);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [stats, setStats] = useState<MediaStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("1");
  const [scopeInput, setScopeInput] = useState("");
  const [userId, setUserId] = useState<number | null>(null);
  const [view, setView] = useState("list");
  const [sort, setSort] = useState<SortState>({ key: "created_at", direction: "desc" });

  const [renaming, setRenaming] = useState<MediaItem | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<MediaItem | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<MediaRef[] | null>(null);
  const [deleteAttempt, setDeleteAttempt] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [gcOpen, setGcOpen] = useState(false);
  const [gcAttempt, setGcAttempt] = useState(0);

  const uploadGuard = useAsyncGuard();
  const locateGuard = useAsyncGuard();
  const renameGuard = useAsyncGuard();
  const deleteGuard = useAsyncGuard();
  const gcGuard = useAsyncGuard();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // 搜索走服务端（分页在服务端），输入停下来再发请求。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (quiet = false) => {
    const seq = ++seqRef.current;
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({ p: String(page), page_size: String(PAGE_SIZE) });
      if (kind) params.set("kind", kind);
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (mayAdmin && status) params.set("status", status);
      if (mayAdmin && userId !== null) params.set("user_id", String(userId));
      const data = await apiRequest<{ items: MediaItem[]; total: number }>(`/api/media?${params.toString()}`);
      if (seq !== seqRef.current) return;
      const nextTotal = data.total ?? 0;
      const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
      // 删除 / 过滤后当前页可能越界（返回空列表），回退到最后一页重查。
      if (page > lastPage) setPage(lastPage);
      setItems(data.items ?? []);
      setTotal(nextTotal);
      setLoadError(null);
    } catch (err) {
      if (seq === seqRef.current) {
        setLoadError(err instanceof Error ? err.message : "加载媒体库失败");
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [page, kind, status, userId, debouncedQuery, mayAdmin]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const qs = mayAdmin && userId !== null ? `?user_id=${userId}` : "";
      const data = await apiRequest<MediaStats>(`/api/media/stats${qs}`);
      setStats(data);
      setStatsError(null);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : "加载统计失败");
    } finally {
      setStatsLoading(false);
    }
  }, [mayAdmin, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  function refresh() {
    void load();
    void loadStats();
  }

  const rows = useMemo(() => {
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    return [...items].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const result = typeof left === "number" && typeof right === "number"
        ? left - right
        : collator.compare(String(left ?? ""), String(right ?? ""));
      return (sort.direction === "asc" ? result : -result) || b.id - a.id;
    });
  }, [items, sort]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shownPage = Math.min(page, pageCount);
  const hasFilter = Boolean(debouncedQuery || kind || (mayAdmin && (status !== "1" || userId !== null)));

  function pickFiles() {
    fileInputRef.current?.click();
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length || !uploadGuard.acquire()) return;
    const files = Array.from(fileList);
    let uploaded = 0;
    const errors: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("source", "upload");
      try {
        await apiRequest<UploadResult>("/api/media", { method: "POST", body: form });
        uploaded++;
      } catch (err) {
        errors.push(`${file.name}：${err instanceof Error ? err.message : "上传失败"}`);
      }
    }
    if (uploaded) notify.success(`已上传 ${uploaded} 个文件`);
    if (errors.length) notify.error(`${errors.length} 个文件上传失败`, errors.join("；"));
    uploadGuard.release();
    if (uploaded) await Promise.all([load(true), loadStats()]);
  }

  async function locateUser() {
    const raw = scopeInput.trim();
    if (!raw) {
      setUserId(null);
      setPage(1);
      return;
    }
    if (/^\d+$/.test(raw)) {
      setUserId(Number(raw));
      setPage(1);
      return;
    }
    if (!mayAdmin || !locateGuard.acquire()) return;
    try {
      const data = await apiRequest<{ items: { id: number; username: string; display_name: string }[] }>(
        "/api/admin/users?page=1&page_size=100",
      );
      const needle = raw.toLowerCase();
      const list = data.items ?? [];
      const found = list.find((u) => u.username.toLowerCase() === needle || (u.display_name ?? "").toLowerCase() === needle)
        ?? list.find((u) => u.username.toLowerCase().includes(needle) || (u.display_name ?? "").toLowerCase().includes(needle));
      if (!found) {
        notify.warning(`没有找到用户「${raw}」`);
        return;
      }
      setUserId(found.id);
      setPage(1);
      notify.success(`已切换到「${found.display_name || found.username}」的文件`, `用户 #${found.id}`);
    } catch (err) {
      notify.error("查找用户失败", err instanceof Error ? err.message : undefined);
    } finally {
      locateGuard.release();
    }
  }

  function openRename(item: MediaItem) {
    setRenaming(item);
    setRenameDraft(item.orig_name ?? "");
  }

  async function saveRename() {
    const target = renaming;
    const name = renameDraft.trim();
    if (!target || !name || !renameGuard.acquire()) return;
    try {
      await apiRequest<MediaDetail>(`/api/media/${target.id}`, {
        method: "PATCH",
        body: { orig_name: name },
      });
      setItems((prev) => prev.map((row) => row.id === target.id ? { ...row, orig_name: name } : row));
      if (detail && detail.id === target.id) setDetail({ ...detail, orig_name: name });
      setRenaming(null);
      notify.success(`已重命名为「${name}」`);
    } catch (err) {
      notify.error("重命名失败", err instanceof Error ? err.message : undefined);
    } finally {
      renameGuard.release();
    }
  }

  function openDelete(item: MediaItem) {
    setDeleting(item);
    setDeleteRefs(null);
    setDeleteAttempt((n) => n + 1);
  }

  function closeDelete() {
    setDeleting(null);
    setDeleteRefs(null);
  }

  async function removeFile(target: MediaItem, force = false) {
    if (!deleteGuard.acquire()) return;
    setBusyId(target.id);
    try {
      await apiRequest<{ id: number; status: number; message: string }>(
        `/api/media/${target.id}${force ? "?force=1" : ""}`,
        { method: "DELETE" },
      );
      if (detailId === target.id) setDetailId(null);
      closeDelete();
      notify.success(`已删除「${target.orig_name || `#${target.id}`}」`);
      await Promise.all([load(true), loadStats()]);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // 409 的响应体里带着「还被哪些内容引用」，原样交给对话框展示。
        const refs = (err.data as { refs?: MediaRef[] } | undefined)?.refs;
        setDeleteRefs(Array.isArray(refs) ? refs : []);
      } else {
        notify.error("删除文件失败", err instanceof Error ? err.message : undefined);
      }
    } finally {
      setBusyId(null);
      deleteGuard.release();
    }
  }

  async function openDetail(item: MediaItem) {
    setDetailId(item.id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await apiRequest<MediaDetail>(`/api/media/${item.id}`);
      setDetail(data);
    } catch (err) {
      notify.error("加载文件详情失败", err instanceof Error ? err.message : undefined);
      setDetailId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function runGC() {
    if (!gcGuard.acquire()) return;
    try {
      const result = await apiRequest<{ soft_deleted: number; purged: number }>("/api/media/gc", {
        method: "POST",
        body: { limit: GC_LIMIT },
      });
      setGcOpen(false);
      notify.success(`已标记 ${result.soft_deleted} 个、清理 ${result.purged} 个`);
      await Promise.all([load(true), loadStats()]);
    } catch (err) {
      notify.error("回收失败", err instanceof Error ? err.message : undefined);
      setGcAttempt((n) => n + 1);
    } finally {
      gcGuard.release();
    }
  }

  const isImage = (item: MediaItem) => item.kind === "image" && item.status !== 2 && Boolean(item.url);

  const columns: DataColumn<MediaItem>[] = [
    {
      key: "orig_name",
      label: "文件",
      width: 250,
      render: (_, item) => (
        <div className={styles.identity}>
          {isImage(item)
            ? <img className={styles.thumbSm} src={item.url} alt="" loading="lazy" />
            : <span className={styles.fileIcon} aria-hidden="true"><FileText size={16} strokeWidth={1.75} /></span>}
          <span className={styles.identityText}>
            <button type="button" className={styles.nameButton} onClick={() => void openDetail(item)}>
              {item.orig_name || `未命名 #${item.id}`}
            </button>
            <span className={styles.metaLine}>
              #{item.id}
              {item.width > 0 && item.height > 0 ? ` · ${item.width}×${item.height}` : ""}
            </span>
          </span>
        </div>
      ),
    },
    {
      key: "kind",
      label: "类型",
      sortable: false,
      width: 86,
      render: (_, item) => (
        <div className={styles.stack}>
          <Badge size="sm" tone={item.kind === "image" ? "info" : "neutral"}>
            {item.kind === "image" ? "图片" : "文档"}
          </Badge>
          {item.ext && <small className={styles.muted}>{item.ext.toUpperCase()}</small>}
        </div>
      ),
    },
    {
      key: "size",
      label: "大小",
      numeric: true,
      width: 84,
      render: (_, item) => formatBytes(item.size),
    },
    {
      key: "ref_count",
      label: "引用",
      width: 100,
      render: (_, item) => item.ref_count > 0
        ? (
          <Tooltip content={`被 ${item.ref_count} 处内容引用，需先删除对应内容`}>
            <span className={styles.refCount}>{item.ref_count} 处</span>
          </Tooltip>
        )
        : <span className={styles.muted}>未引用</span>,
    },
    {
      key: "source",
      label: "来源",
      width: 106,
      render: (_, item) => <span>{sourceLabel(item.source)}</span>,
    },
    {
      key: "created_at",
      label: "上传时间",
      width: 148,
      render: (_, item) => <span className={styles.muted}>{formatTime(item.created_at)}</span>,
    },
    {
      key: "actions",
      label: "操作",
      sortable: false,
      width: 178,
      render: (_, item) => (
        <div className={styles.rowActions}>
          {item.status === 2
            ? <span className={styles.actionDisabled}>已删除</span>
            : <a className={styles.actionLink} href={`${item.url}&download=1`}>下载</a>}
          <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => openRename(item)}>重命名</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busyId === item.id || item.status === 2}
            onClick={() => openDelete(item)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  const quotaPercent = stats && stats.quota_bytes > 0
    ? Math.min(100, Math.round((stats.bytes / stats.quota_bytes) * 100))
    : 0;
  const quotaTone = quotaPercent >= 90 ? "danger" : quotaPercent >= 70 ? "warning" : "success";

  return <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "媒体库" }]}>
    <div className={styles.page}>
      <h1 className={styles.title}>媒体库</h1>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchField
            label="搜索文件名"
            placeholder="输入文件名关键字"
            value={query}
            onValueChange={setQuery}
          />
        </div>
        <div className={styles.kind}>
          <Select label="类型" value={kind} options={KIND_OPTIONS} onValueChange={(value) => { setKind(value); setPage(1); }} />
        </div>
        {mayAdmin && (
          <div className={styles.status}>
            <Select label="状态" value={status} options={STATUS_OPTIONS} onValueChange={(value) => { setStatus(value); setPage(1); }} />
          </div>
        )}
        {mayAdmin && (
          <div className={styles.scope}>
            <Input
              label="按用户查看（用户名或 ID）"
              placeholder="例如 3 或 admin"
              value={scopeInput}
              onChange={(event) => setScopeInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void locateUser(); }}
            />
            <Button size="sm" variant="secondary" loading={locateGuard.busy} disabled={locateGuard.busy} onClick={() => void locateUser()}>
              定位
            </Button>
          </div>
        )}
        <span className={styles.spacer} />
        <Button variant="secondary" size="sm" loading={loading} onClick={refresh}>
          <RefreshCw size={14} />刷新
        </Button>
        <Button size="sm" loading={uploadGuard.busy} disabled={stats !== null && !stats.enabled} onClick={pickFiles}>
          上传
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.md,.csv"
        className={styles.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => { void uploadFiles(event.target.files); event.target.value = ""; }}
      />

      {mayAdmin && userId !== null && (
        <p className={styles.scopeChip}>
          当前范围：用户 #{userId}
          <button type="button" onClick={() => { setUserId(null); setScopeInput(""); setPage(1); }}>返回全站</button>
        </p>
      )}

      {statsError && (
        <p className={styles.error} role="alert">
          <span className={styles.errorText}>统计加载失败：{statsError}</span>
          <Button size="sm" variant="secondary" onClick={() => void loadStats()}>重试</Button>
        </p>
      )}
      {stats && (
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>文件数</span>
            <span className={styles.statValue}>{stats.count}</span>
            {stats.scope === "all" && <span className={styles.statHint}>全站</span>}
            {stats.scope === "user" && <span className={styles.statHint}>用户 #{userId}</span>}
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>已用空间</span>
            <span className={styles.statValue}>{statsLoading && !stats ? "…" : formatBytes(stats.bytes)}</span>
            {stats.quota_bytes > 0 && <span className={styles.statHint}>配额 {formatBytes(stats.quota_bytes)}</span>}
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>单文件上限</span>
            <span className={styles.statValue}>{Math.round(stats.max_file_bytes / (1024 * 1024))} MB</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>保留策略</span>
            <span className={styles.statValue}>
              {stats.orphan_hours > 0 ? `未引用 ${stats.orphan_hours} 小时后回收` : "不自动回收"}
            </span>
            {stats.retention_days > 0 && (
              <span className={styles.statHint}>软删 {stats.retention_days} 天后物理清理</span>
            )}
          </div>
          {stats.quota_bytes > 0 && (
            <div className={styles.usage}>
              <div className={styles.usageMeta}>
                <span>{formatBytes(stats.bytes)} / {formatBytes(stats.quota_bytes)}</span>
                <span>{quotaPercent}%</span>
              </div>
              <div className={styles.usageBar} role="progressbar" aria-label="空间使用率" aria-valuenow={quotaPercent} aria-valuemin={0} aria-valuemax={100}>
                <span className={styles.usageFill} data-tone={quotaTone} style={{ width: `${quotaPercent}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className={styles.listHead}>
        <SegmentedControl
          label="视图切换"
          value={view}
          onValueChange={setView}
          options={[{ value: "list", label: "列表" }, { value: "grid", label: "宫格" }]}
        />
        <span className={styles.total}>共 {total} 个文件</span>
      </div>

      {loadError && (
        <p className={styles.error} role="alert">
          <span className={styles.errorText}>{loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>重试</Button>
        </p>
      )}

      {loading && !items.length ? (
        <p className={styles.loading}>正在加载媒体库…</p>
      ) : !rows.length ? (
        <div className={styles.empty}>
          {hasFilter
            ? <EmptyState icon={<SearchX size={20} />} title="没有符合条件的文件" description="试试调整筛选条件，或清空搜索关键词。" />
            : <EmptyState
              icon={<FolderOpen size={20} />}
              title="媒体库还是空的"
              description="上传头像后就会出现在这里，也可以在右上角直接上传文件。"
              action={<Button size="sm" variant="secondary" onClick={pickFiles}>上传文件</Button>}
            />}
        </div>
      ) : view === "list" ? (
        <div className={styles.table} data-loading={loading || undefined}>
          <SortableDataTable<MediaItem>
            rows={rows}
            columns={columns}
            rowKey="id"
            caption="媒体库文件列表"
            emptyMessage="没有符合条件的文件"
            defaultSort={{ key: "created_at", direction: "desc" }}
            onSortChange={setSort}
            itemName={{ one: "个文件", other: "个文件" }}
          />
        </div>
      ) : (
        <div className={styles.grid} data-loading={loading || undefined}>
          {rows.map((item) => (
            <article className={styles.card} key={item.id}>
              <button type="button" className={styles.cardThumb} onClick={() => void openDetail(item)} aria-label={`查看「${item.orig_name || item.id}」详情`}>
                {isImage(item)
                  ? <img src={item.url} alt="" loading="lazy" />
                  : <FileText size={28} strokeWidth={1.5} aria-hidden="true" />}
              </button>
              <div className={styles.cardBody}>
                <button type="button" className={styles.cardName} onClick={() => void openDetail(item)}>
                  {item.orig_name || `未命名 #${item.id}`}
                </button>
                <span className={styles.cardMeta}>
                  {formatBytes(item.size)} · {item.ref_count > 0 ? `${item.ref_count} 处引用` : "未引用"}
                </span>
              </div>
              <div className={styles.cardActions}>
                {item.status === 2
                  ? <span className={styles.iconBtn} data-disabled aria-label="已删除"><Download size={14} strokeWidth={1.75} /></span>
                  : <Tooltip content="下载">
                    <a className={styles.iconBtn} href={`${item.url}&download=1`} aria-label={`下载「${item.orig_name || item.id}」`}><Download size={14} strokeWidth={1.75} /></a>
                  </Tooltip>}
                <Tooltip content="详情">
                  <button type="button" className={styles.iconBtn} onClick={() => void openDetail(item)} aria-label="查看详情"><Eye size={14} strokeWidth={1.75} /></button>
                </Tooltip>
                <Tooltip content="重命名">
                  <button type="button" className={styles.iconBtn} disabled={busyId === item.id} onClick={() => openRename(item)} aria-label="重命名"><Pencil size={14} strokeWidth={1.75} /></button>
                </Tooltip>
                <Tooltip content="删除">
                  <button type="button" className={styles.iconBtn} data-danger onClick={() => openDelete(item)} disabled={busyId === item.id || item.status === 2} aria-label="删除"><Trash2 size={14} strokeWidth={1.75} /></button>
                </Tooltip>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className={styles.pagination}>
        <span>每页 {PAGE_SIZE} 条</span>
        <Pagination page={shownPage} pageCount={pageCount} onPageChange={setPage} label="媒体分页" />
      </div>
    </div>

    {/* 重命名 */}
    <Dialog open={Boolean(renaming)} onOpenChange={(value) => { if (!value && !renameGuard.busy) setRenaming(null); }}>
      <DialogContent title="重命名文件">
        {renaming && <>
          <Input
            label="文件名"
            value={renameDraft}
            maxLength={255}
            onChange={(event) => setRenameDraft(event.target.value)}
            description="仅修改展示用名称，不影响文件内容与磁盘路径。"
          />
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" disabled={renameGuard.busy} onClick={() => setRenaming(null)}>取消</Button>
            <Button size="sm" loading={renameGuard.busy} disabled={!renameDraft.trim()} onClick={() => void saveRename()}>保存</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>

    {/* 删除：被引用时先展示引用来源，管理员可再强制删除 */}
    <Dialog open={Boolean(deleting)} onOpenChange={(value) => { if (!value && !deleteGuard.busy) closeDelete(); }}>
      <DialogContent title={deleteRefs?.length ? "文件仍被引用" : "删除文件"}>
        {deleting && <>
          <p className={styles.confirmText}>
            {deleteRefs === null
              ? `将删除「${deleting.orig_name || `#${deleting.id}`}」。文件会先进入待删状态，保留期内仍可通过回收恢复，物理清理后磁盘空间才会释放。`
              : `「${deleting.orig_name || `#${deleting.id}`}」仍被以下内容引用，请先删除对应内容${mayAdmin ? "，或由管理员强制删除（会一并解绑这些引用）" : ""}：`}
          </p>
          {deleteRefs?.length ? (
            <ul className={styles.refList}>
              {deleteRefs.map((ref) => <li key={`${ref.ref_type}:${ref.ref_id}`}>{refLabel(ref)}</li>)}
            </ul>
          ) : null}
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" disabled={deleteGuard.busy} onClick={closeDelete}>
              {deleteRefs === null ? "取消" : "知道了"}
            </Button>
            {deleteRefs === null
              ? <HoldToConfirm key={deleteAttempt} label="长按删除文件" confirmedLabel="已提交" tone="danger" disabled={deleteGuard.busy} onConfirm={() => void removeFile(deleting)} />
              : mayAdmin && <HoldToConfirm key={`force-${deleteAttempt}`} label="管理员强制删除" confirmedLabel="已提交" tone="danger" disabled={deleteGuard.busy} onConfirm={() => void removeFile(deleting, true)} />}
          </div>
        </>}
      </DialogContent>
    </Dialog>

    {/* 详情：BottomSheet 的 body 自带滚动，内部不要再嵌 ScrollArea */}
    <BottomSheet
      open={detailId !== null}
      onOpenChange={(value) => { if (!value) { setDetailId(null); setDetail(null); } }}
      title="文件详情"
      description={detail ? (detail.orig_name || `#${detail.id}`) : undefined}
      detents={[0.62, 0.92]}
      closeLabel="关闭"
    >
      {detailLoading && !detail ? <p className={styles.loading}>正在加载详情…</p> : detail && (
        <div className={styles.detail}>
          {isImage(detail) && <img className={styles.preview} src={detail.url} alt="" />}
          <dl className={styles.detailRows}>
            <dt>文件名</dt><dd>{detail.orig_name || "未命名"}</dd>
            <dt>ID</dt><dd>#{detail.id}</dd>
            <dt>类型</dt><dd>{detail.kind === "image" ? "图片" : "文档"} · {detail.mime || "未知"}</dd>
            <dt>大小</dt><dd>{formatBytes(detail.size)}</dd>
            <dt>尺寸</dt><dd>{detail.width > 0 && detail.height > 0 ? `${detail.width} × ${detail.height}` : "—"}</dd>
            <dt>归属用户</dt><dd>#{detail.user_id}</dd>
            <dt>来源</dt><dd>{sourceLabel(detail.source)}</dd>
            <dt>引用数</dt><dd>{detail.ref_count > 0 ? `${detail.ref_count} 处` : "未引用"}</dd>
            <dt>上传时间</dt><dd>{formatTime(detail.created_at)}</dd>
            <dt>最近访问</dt><dd>{detail.last_access_at ? formatTime(detail.last_access_at) : "从未访问"}</dd>
            <dt>SHA256</dt><dd className={styles.mono}>{detail.sha256 || "—"}</dd>
          </dl>
          <div className={styles.detailActions}>
            <a className={styles.actionLink} href={`${detail.url}&download=1`}>下载</a>
            <Button size="sm" variant="secondary" onClick={() => { const item = detail; setDetailId(null); setDetail(null); openRename(item); }}>重命名</Button>
          </div>
        </div>
      )}
    </BottomSheet>

    {/* 回收（管理员） */}
    <Dialog open={gcOpen} onOpenChange={(value) => { if (!value && !gcGuard.busy) setGcOpen(false); }}>
      <DialogContent title="回收媒体库">
        <div className={styles.gcText}>
          <p>回收会做两件事：</p>
          <ul>
            <li>{stats && stats.orphan_hours > 0
              ? `标记长期未引用（超过 ${stats.orphan_hours} 小时）的文件为待删；`
              : "长期未引用的文件不会被自动标记（自动标记已关闭）；"}</li>
            <li>{stats && stats.retention_days > 0
              ? `物理清理已软删超过 ${stats.retention_days} 天的文件（磁盘空间真正释放）。`
              : "不会物理清理已软删的文件（物理清理已关闭）。"}</li>
          </ul>
          <p>仍被头像等内容引用的文件不会被回收。</p>
        </div>
        <div className={styles.dialogActions}>
          <Button variant="secondary" size="sm" disabled={gcGuard.busy} onClick={() => setGcOpen(false)}>取消</Button>
          <HoldToConfirm key={gcAttempt} label="长按开始回收" confirmedLabel="回收中" tone="danger" disabled={gcGuard.busy} onConfirm={() => void runGC()} />
        </div>
      </DialogContent>
    </Dialog>
  </AdminLayout>;
}
