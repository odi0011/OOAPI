import { useCallback, useEffect, useMemo, useState } from "react";
import { Power, RefreshCw } from "lucide-react";

import { Avatar } from "@/components/arc/avatar/avatar";
import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Input } from "@/components/arc/input/input";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Pagination } from "@/components/arc/pagination/pagination";
import ScrollArea from "@/components/arc/scroll-area/scroll-area";
import { SearchField } from "@/components/arc/search-field/search-field";
import { Select } from "@/components/arc/select/select";
import { SortableDataTable, type DataColumn, type SortState } from "@/components/arc/sortable-data-table/sortable-data-table";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useAuth } from "@/contexts/AuthContext";
import { formatAmount, useCurrency } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { Perm } from "@/lib/permissions";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import styles from "./AdminUsers.module.css";

interface UserItem {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: number;
  role_name: string;
  status: number;
  quota: number;
  used_quota: number;
  request_count: number;
  group_name: string;
  created_at: string;
  last_login_at: string;
  avatar_url: string;
}

interface AssignableRole {
  value: number;
  label: string;
}

/** 表格行：在原始字段上补一个「剩余额度」，否则那一列没法排序。 */
interface UserRow extends Record<string, unknown>, UserItem {
  available: number;
}

interface EditDraft {
  display_name: string;
  email: string;
  role: number;
  status: number;
}

const PAGE_SIZE = 20;
const AMOUNT_LIMIT = 100_000_000;
const EMPTY_DRAFT: EditDraft = { display_name: "", email: "", role: 1, status: 1 };

/** 后端返回 "2026-10-08T15:55:45+08:00"，直接展示会带着 T 与时区后缀。 */
function formatTime(raw: string): string {
  return raw ? raw.replace("T", " ").slice(0, 19) : "—";
}

function formatDay(raw: string): string {
  return raw ? raw.replace("T", " ").slice(0, 16) : "—";
}

/**
 * 用户管理。
 *
 * 三条与后端一致的规则，界面上要如实体现：
 *  1. 管理员只能操作低于自己的用户；超管可操作其他用户
 *  2. 角色下拉的选项来自后端返回的 assignable_roles（不能授予比自己高的角色）
 *  3. 不能修改自己 —— 避免管理员误把自己降级导致无人可管
 */
export default function AdminUsers() {
  const { user: me, can } = useAuth();
  const currency = useCurrency();
  const notify = useNotify();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [roles, setRoles] = useState<AssignableRole[]>([]);
  const [loading, setLoading] = useState(true);
  /** 列表加载失败是页面级问题，内联常驻；其余走 toast。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "id", direction: "desc" });

  // 每个动作一条防重入通道：编辑、额度、行内动作（状态/删除）互不阻塞。
  const editGuard = useAsyncGuard();
  const quotaGuard = useAsyncGuard();
  const rowGuard = useAsyncGuard();

  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>(EMPTY_DRAFT);
  const [quotaTarget, setQuotaTarget] = useState<UserRow | null>(null);
  const [quotaDelta, setQuotaDelta] = useState(10);
  const [statusTarget, setStatusTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  const mayEdit = can(Perm.UserEdit); // 资料 / 状态 / 删除
  const mayAssignRole = can(Perm.RoleAssign); // 角色
  const mayManageQuota = can(Perm.UserManageQuota); // 额度

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await apiRequest<{ items: UserItem[]; total: number; assignable_roles: AssignableRole[] }>(
        "/api/admin/users?page=1&page_size=100",
      );
      setUsers(
        (data.items ?? []).map((u) => ({ ...u, available: (u.quota ?? 0) - (u.used_quota ?? 0) })),
      );
      setTotal(data.total ?? 0);
      setRoles(data.assignable_roles ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 层级判断：不能操作自己，管理员不能操作同级及以上。 */
  const canAct = useCallback(
    (u: UserRow) => Boolean(me) && u.id !== me!.id && (me!.role === 1000 || u.role < me!.role),
    [me],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [users, query]);

  const sorted = useMemo(() => {
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    return [...filtered].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const result =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : collator.compare(String(left ?? ""), String(right ?? ""));
      return (sort.direction === "asc" ? result : -result) || a.id - b.id;
    });
  }, [filtered, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const shownPage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => sorted.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE),
    [sorted, shownPage],
  );

  const admins = users.filter((u) => u.role >= 100).length;
  const disabled = users.filter((u) => u.status !== 1).length;
  const usedTotal = users.reduce((sum, u) => sum + Number(u.used_quota || 0), 0);

  function openEdit(u: UserRow) {
    if (!canAct(u)) return;
    setEditing(u);
    setEditDraft({
      display_name: u.display_name ?? "",
      email: u.email ?? "",
      role: u.role,
      status: u.status,
    });
  }

  function openQuota(u: UserRow) {
    if (!canAct(u)) return;
    setQuotaTarget(u);
    setQuotaDelta(10);
  }

  async function saveEdit() {
    const target = editing;
    if (!target || !editGuard.acquire()) return;

    const displayName = editDraft.display_name.trim();
    const email = editDraft.email.trim();
    const patchProfile = mayEdit && (displayName !== (target.display_name ?? "") || email !== (target.email ?? ""));
    const patchRole = mayAssignRole && editDraft.role !== target.role;
    const patchStatus = mayEdit && editDraft.status !== target.status;

    if (!patchProfile && !patchRole && !patchStatus) {
      editGuard.release();
      setEditing(null);
      notify.info("没有需要保存的修改");
      return;
    }

    try {
      // 三个字段各有独立接口与能力点，按改动逐条提交；任一条失败就停在那里。
      if (patchRole) {
        await apiRequest(`/api/admin/users/${target.id}/role`, {
          method: "PUT",
          body: { role: editDraft.role },
        });
      }
      if (patchStatus) {
        await apiRequest(`/api/admin/users/${target.id}/status`, {
          method: "PUT",
          body: { status: editDraft.status },
        });
      }
      if (patchProfile) {
        await apiRequest(`/api/admin/users/${target.id}/profile`, {
          method: "PUT",
          body: { display_name: displayName, email },
        });
      }
      notify.success("已保存");
      setEditing(null);
      await load(true);
    } catch (err) {
      // 失败时保留对话框与已填内容，让用户改完再提交。
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      editGuard.release();
    }
  }

  async function adjustQuota() {
    const target = quotaTarget;
    if (!target || !quotaGuard.acquire()) return;
    if (!Number.isFinite(quotaDelta) || quotaDelta === 0) {
      notify.warning("请先填写额度变化量", "正数补充，负数扣减");
      quotaGuard.release();
      return;
    }
    // 输入框单位是货币单位，提交时换算成内部额度单位（与密钥页口径一致）。
    const delta = Math.round(quotaDelta * currency.unitsPerUnit);
    if (delta === 0) {
      notify.warning("额度变化太小", `至少需要 ${1 / currency.unitsPerUnit} ${currency.name}`);
      quotaGuard.release();
      return;
    }
    try {
      const r = await apiRequest<{ quota: number }>(`/api/admin/users/${target.id}/quota`, {
        method: "PUT",
        body: { delta },
      });
      setUsers((prev) => prev.map((item) => (item.id === target.id ? { ...item, quota: r.quota, available: r.quota - item.used_quota } : item)));
      notify.success(`「${target.username}」额度已调整`, `当前余额 ${formatAmount(r.quota, currency)} ${currency.name}`);
      setQuotaTarget(null);
      await load(true);
    } catch (err) {
      notify.error("调整额度失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      quotaGuard.release();
    }
  }

  async function changeStatus(target: UserRow, next: 0 | 1) {
    if (!rowGuard.acquire()) return;
    try {
      await apiRequest(`/api/admin/users/${target.id}/status`, { method: "PUT", body: { status: next } });
      notify.success(next === 1 ? `已启用「${target.username}」` : `已禁用「${target.username}」`);
      setStatusTarget(null);
      await load(true);
    } catch (err) {
      notify.error("修改状态失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      rowGuard.release();
    }
  }

  async function removeUser(target: UserRow) {
    if (!rowGuard.acquire()) return;
    try {
      await apiRequest(`/api/admin/users/${target.id}`, { method: "DELETE" });
      notify.success(`已删除用户「${target.username}」`);
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      notify.error("删除用户失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      rowGuard.release();
    }
  }

  const columns: DataColumn<UserRow>[] = [
    { key: "id", label: "ID", sortable: true, width: 60, render: (_v, u) => <span className={styles.num}>{u.id}</span> },
    {
      key: "username",
      label: "用户",
      sortable: true,
      width: 205,
      render: (_v, u) => (
        <div className={styles.identity}>
          <Avatar name={u.display_name || u.username} src={u.avatar_url || undefined} size="sm" />
          <div className={styles.identityText}>
            <strong title={u.display_name || u.username}>{u.display_name || u.username}</strong>
            <span className={styles.username} title={`@${u.username}`}>@{u.username}</span>
          </div>
        </div>
      ),
    },
    {
      key: "email",
      label: "邮箱",
      sortable: false,
      width: 185,
      render: (_v, u) =>
        u.email ? <span className={styles.email} title={u.email}>{u.email}</span> : <span className={styles.muted}>未绑定</span>,
    },
    {
      key: "role",
      label: "角色",
      sortable: true,
      numeric: false,
      width: 96,
      render: (_v, u) => <Badge size="sm" tone={u.role >= 100 ? "info" : "neutral"}>{u.role_name || String(u.role)}</Badge>,
    },
    {
      key: "status",
      label: "状态",
      sortable: false,
      numeric: false,
      width: 88,
      render: (_v, u) => <Badge size="sm" tone={u.status === 1 ? "success" : "danger"}>{u.status === 1 ? "启用" : "已禁用"}</Badge>,
    },
    {
      key: "available",
      label: "剩余额度",
      sortable: true,
      width: 132,
      render: (_v, u) => (
        <span className={styles.amount}>
          {formatAmount(u.available, currency)}
          <CurrencyIcon src={currency.icon} size="0.95em" />
        </span>
      ),
    },
    {
      key: "used_quota",
      label: "已用额度",
      sortable: true,
      width: 132,
      render: (_v, u) => (
        <span className={`${styles.amount} ${styles.amountQuiet}`}>
          {formatAmount(u.used_quota, currency)}
          <CurrencyIcon src={currency.icon} size="0.95em" />
        </span>
      ),
    },
    { key: "request_count", label: "调用", sortable: true, width: 78, render: (_v, u) => <span className={styles.num}>{u.request_count ?? 0}</span> },
    {
      key: "created_at",
      label: "注册时间",
      sortable: false,
      width: 150,
      render: (_v, u) => <span className={styles.time} title={formatTime(u.created_at)}>{formatDay(u.created_at)}</span>,
    },
    {
      key: "actions",
      label: "操作",
      sortable: false,
      width: 268,
      render: (_v, u) => {
        const isSelf = me !== null && u.id === me.id;
        const editable = canAct(u);
        const lockedTitle = isSelf ? "不能操作当前登录账号" : "无权操作该用户";
        return (
          <div className={styles.rowActions}>
            {mayEdit && (
              <Button size="sm" variant="secondary" disabled={!editable} title={editable ? "编辑资料" : lockedTitle} onClick={() => openEdit(u)}>
                编辑
              </Button>
            )}
            {mayManageQuota && (
              <Button size="sm" variant="ghost" disabled={!editable} title={editable ? "调整额度" : lockedTitle} onClick={() => openQuota(u)}>
                额度
              </Button>
            )}
            {mayEdit && (
              <Button
                size="sm"
                variant={u.status === 1 ? "ghost" : "secondary"}
                disabled={!editable}
                title={editable ? (u.status === 1 ? "禁用账号" : "启用账号") : lockedTitle}
                onClick={() => setStatusTarget(u)}
              >
                {u.status === 1 ? "禁用" : "启用"}
              </Button>
            )}
            {mayEdit && (
              <Button size="sm" variant="danger" disabled={!editable} title={editable ? "删除用户" : lockedTitle} onClick={() => setDeleteTarget(u)}>
                删除
              </Button>
            )}
            {isSelf && <span className={styles.selfNote}>当前账号</span>}
            {!isSelf && !editable && <span className={styles.selfNote}>超出层级</span>}
          </div>
        );
      },
    },
  ];

  /** 角色选项：后端可授予的角色 + 当前用户的角色（只读展示，避免下拉显示成占位符）。 */
  const roleOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of roles) seen.set(r.value, r.label);
    if (editing && !seen.has(editing.role)) seen.set(editing.role, editing.role_name || String(editing.role));
    return [...seen.entries()].map(([value, label]) => ({ value: String(value), label }));
  }, [roles, editing]);

  if (!me) return null;

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "用户管理" }]}>
      <div className={styles.page}>
        <h1 className={styles.title}>用户管理</h1>

        <section className={styles.stats} aria-label="用户统计">
          <div className={styles.chip}>
            <span className={styles.chipLabel}>用户总数</span>
            <strong className={styles.chipValue}>{loadError ? "—" : total}</strong>
          </div>
          <div className={styles.chip}>
            <span className={styles.chipLabel}>管理员</span>
            <strong className={styles.chipValue}>{loadError ? "—" : admins}</strong>
            <small className={styles.chipHint}>本页统计</small>
          </div>
          <div className={styles.chip} data-tone={!loadError && disabled > 0 ? "danger" : undefined}>
            <span className={styles.chipLabel}>已禁用</span>
            <strong className={styles.chipValue}>{loadError ? "—" : disabled}</strong>
            <small className={styles.chipHint}>本页统计</small>
          </div>
          <div className={styles.chip}>
            <span className={styles.chipLabel}>累计消费</span>
            <strong className={`${styles.chipValue} ${styles.amount}`}>
              {loadError ? "—" : formatAmount(usedTotal, currency)}
              {!loadError && <CurrencyIcon src={currency.icon} size="0.9em" />}
            </strong>
            <small className={styles.chipHint}>本页统计</small>
          </div>
        </section>

        <div className={styles.toolbar}>
          <SearchField
            label="搜索用户"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setPage(1);
            }}
            placeholder="搜索用户名 / 邮箱"
          />
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
            <RefreshCw size={14} />
            刷新
          </Button>
          <span className={styles.count}>
            共 {total} 位用户{query && ` · 匹配 ${filtered.length}`}
            {total > users.length && ` · 已加载 ${users.length} 位`}
          </span>
        </div>

        {loadError && (
          <p className={styles.err} role="alert">
            {loadError}
          </p>
        )}

        {loading && !users.length ? (
          <p className={styles.loading}>正在加载用户…</p>
        ) : users.length === 0 ? (
          <section className={styles.emptyCard}>
            <EmptyState title="没有用户" description="当前层级下没有可管理的用户。" />
          </section>
        ) : (
          <>
            <div className={styles.table}>
              <SortableDataTable<UserRow>
                rows={pageRows}
                columns={columns}
                rowKey="id"
                caption="用户列表"
                emptyMessage={query ? "没有匹配的用户" : "没有用户"}
                defaultSort={sort}
                onSortChange={(next) => {
                  setSort(next);
                  setPage(1);
                }}
                itemName={{ one: "位用户", other: "位用户" }}
              />
            </div>
            <div className={styles.pagination}>
              <span>每页 {PAGE_SIZE} 条</span>
              <Pagination page={shownPage} pageCount={pageCount} onPageChange={setPage} label="用户分页" />
            </div>
          </>
        )}
      </div>

      {/* ---------- 编辑用户 ---------- */}
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !editGuard.busy) setEditing(null);
        }}
      >
        <DialogContent
          className={styles.editDialog}
          title={editing ? `编辑用户：${editing.username}` : "编辑用户"}
          description="资料、角色与状态各有独立权限，未获授权的字段不可编辑"
          bodyClassName={styles.editBody}
        >
          {editing && (
            <>
              <div className={styles.editIdentity}>
                <Avatar name={editing.display_name || editing.username} src={editing.avatar_url || undefined} size="md" />
                <div className={styles.editIdentityText}>
                  <strong>{editing.display_name || editing.username}</strong>
                  <span>@{editing.username}</span>
                </div>
              </div>
              <ScrollArea className={styles.dialogScroll} maxHeight="min(52vh, 460px)" label="编辑用户表单" fade={12}>
                <div className={styles.formGrid}>
                  <Input
                    label="显示名称"
                    maxLength={64}
                    value={editDraft.display_name}
                    disabled={!mayEdit || editGuard.busy}
                    placeholder="留空则展示用户名"
                    description="最长 64 个字符"
                    onChange={(e) => setEditDraft((d) => ({ ...d, display_name: e.target.value }))}
                  />
                  <Input
                    label="邮箱"
                    type="email"
                    value={editDraft.email}
                    disabled={!mayEdit || editGuard.busy}
                    placeholder="name@example.com"
                    description={mayEdit ? "留空表示未绑定" : "你没有编辑资料的权限"}
                    onChange={(e) => setEditDraft((d) => ({ ...d, email: e.target.value }))}
                  />
                  <Select
                    label="角色"
                    value={String(editDraft.role)}
                    options={roleOptions}
                    disabled={!mayAssignRole || editGuard.busy}
                    onValueChange={(value) => setEditDraft((d) => ({ ...d, role: Number(value) }))}
                    description={mayAssignRole ? "只能授予不高于你自己的角色" : "你没有分配角色的权限"}
                  />
                  <Select
                    label="状态"
                    value={String(editDraft.status)}
                    options={[
                      { value: "1", label: "启用" },
                      { value: "0", label: "禁用" },
                    ]}
                    disabled={!mayEdit || editGuard.busy}
                    onValueChange={(value) => setEditDraft((d) => ({ ...d, status: Number(value) }))}
                    description={mayEdit ? "禁用后该用户无法登录与调用" : "你没有修改状态的权限"}
                  />
                </div>
              </ScrollArea>
              <div className={styles.dialogActions}>
                <Button size="sm" variant="secondary" disabled={editGuard.busy} onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button size="sm" loading={editGuard.busy} disabled={editGuard.busy} onClick={() => void saveEdit()}>
                  保存
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- 调整额度 ---------- */}
      <Dialog
        open={Boolean(quotaTarget)}
        onOpenChange={(open) => {
          if (!open && !quotaGuard.busy) setQuotaTarget(null);
        }}
      >
        <DialogContent
          title={quotaTarget ? `调整额度：${quotaTarget.username}` : "调整额度"}
          bodyClassName={styles.dialogBody}
        >
          {quotaTarget && (
            <>
              <div className={styles.quotaGrid}>
                <NumberField
                  label="额度变化量"
                  value={quotaDelta}
                  disabled={quotaGuard.busy}
                  min={-AMOUNT_LIMIT}
                  max={AMOUNT_LIMIT}
                  step={0.01}
                  largeStep={10}
                  suffix={` ${currency.name}`}
                  formatOptions={{ minimumFractionDigits: 4, maximumFractionDigits: 4 }}
                  onValueChange={setQuotaDelta}
                  description="正数补充，负数扣减；Shift + 方向键或 PageUp/PageDown 以 10 为单位调整"
                />
                <div className={styles.balance}>
                  <span className={styles.balanceLabel}>当前余额</span>
                  <strong className={styles.amount}>
                    {formatAmount(quotaTarget.quota, currency)}
                    <CurrencyIcon src={currency.icon} size="0.95em" />
                  </strong>
                </div>
              </div>
              <div className={styles.dialogActions}>
                <Button size="sm" variant="secondary" disabled={quotaGuard.busy} onClick={() => setQuotaTarget(null)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  loading={quotaGuard.busy}
                  disabled={quotaGuard.busy || quotaDelta === 0}
                  onClick={() => void adjustQuota()}
                >
                  确认调整
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- 启用 / 禁用 ---------- */}
      <Dialog
        open={Boolean(statusTarget)}
        onOpenChange={(open) => {
          if (!open && !rowGuard.busy) setStatusTarget(null);
        }}
      >
        <DialogContent
          title={statusTarget?.status === 1 ? "禁用用户" : "启用用户"}
          bodyClassName={styles.dialogBody}
        >
          {statusTarget && (
            <>
              <p className={styles.confirmText}>
                {statusTarget.status === 1
                  ? `禁用后「${statusTarget.username}」将无法登录，已签发的密钥也会停止服务；已发出的请求不受影响。`
                  : `「${statusTarget.username}」将恢复登录与接口调用权限。`}
              </p>
              <div className={styles.dialogActions}>
                <Button size="sm" variant="secondary" disabled={rowGuard.busy} onClick={() => setStatusTarget(null)}>
                  取消
                </Button>
                <HoldToConfirm
                  label={statusTarget.status === 1 ? "按住禁用账号" : "按住启用账号"}
                  confirmed={false}
                  icon={<Power size={16} strokeWidth={1.75} />}
                  tone={statusTarget.status === 1 ? "danger" : "accent"}
                  disabled={rowGuard.busy}
                  onConfirm={() => void changeStatus(statusTarget, statusTarget.status === 1 ? 0 : 1)}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- 删除用户 ---------- */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !rowGuard.busy) setDeleteTarget(null);
        }}
      >
        <DialogContent title="删除用户" bodyClassName={styles.dialogBody}>
          {deleteTarget && (
            <>
              <p className={styles.confirmText}>
                确定删除用户 <strong>{deleteTarget.username}</strong>？
              </p>
              <p className={styles.warnText}>
                该用户名下的密钥会被一并移除，之后无法再用它调用接口；调用日志会保留（列表中显示为「已注销用户」），以便对账。
                此操作不可撤销。
              </p>
              <div className={styles.dialogActions}>
                <Button size="sm" variant="secondary" disabled={rowGuard.busy} onClick={() => setDeleteTarget(null)}>
                  取消
                </Button>
                <HoldToConfirm
                  label="按住删除用户"
                  confirmed={false}
                  tone="danger"
                  disabled={rowGuard.busy}
                  onConfirm={() => void removeUser(deleteTarget)}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
