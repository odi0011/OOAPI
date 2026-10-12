import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Select } from "@/components/arc/select/select";
import Switch from "@/components/arc/switch/switch";
import { Textarea } from "@/components/arc/textarea/textarea";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import AdminLayout from "@/components/admin/AdminLayout";
import { ModelMark } from "@/components/BrandMark";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { Perm } from "@/lib/permissions";

import styles from "./AdminTokens.module.css";

interface GroupOption {
  id: number;
  name: string;
  remark: string;
  rate: number;
  models: string[];
}

interface TokenItem {
  id: number;
  name: string;
  api_key: string;
  status: number;
  quota: number;
  unlimited_quota: boolean;
  used_quota: number;
  group_name: string;
  models: string[];
  expired_at: string;
  created_at: string;
  accessed_at: string;
}

interface Reconcile {
  account_used: number;
  existing_used: number;
  deleted_used: number;
  consistent: boolean;
}

/** 表单草稿。 */
interface Draft {
  name: string;
  groupName: string;
  unlimited: boolean;
  quota: number;
  models: string;
  /** 为真时不传有效期，后端按永不过期保存。 */
  neverExpires: boolean;
  /** datetime-local 的值，仅在不勾选永不过期时提交。 */
  expiredAt: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  groupName: "",
  unlimited: true,
  quota: 0,
  models: "",
  neverExpires: true,
  expiredAt: "",
};

/** 与后端 IsValidAPIKeyShape 一致：sk- 加 48 位十六进制。打码串含 *，过不了。 */
function isCallableKey(key: string): boolean {
  return /^sk-[0-9a-f]{48}$/.test(key);
}

export default function AdminTokens() {
  const { can, user } = useAuth();
  const currency = useCurrency();

  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [reconcile, setReconcile] = useState<Reconcile | null>(null);
  const [loading, setLoading] = useState(true);
  // 操作反馈走全局 toast（内联提示会随滚动离开视线）
  const notify = useNotify();
  const action = useAsyncGuard();
  /** 列表加载失败是页面级问题，内联常驻；其余走 toast。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 每个密钥的删除完成态（失败时要能复位回可长按） */
  const [deletedIds, setDeletedIds] = useState<Record<number, boolean>>({});

  const [editing, setEditing] = useState<TokenItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  /** 新建或点过「显示」后展示完整密钥。列表本身始终是打码串。 */
  const [revealed, setRevealed] = useState<{ id: number; apiKey: string } | null>(null);
  /** 本页已经通过 /reveal（或刚创建）确认过的密钥。未确认前复制按钮禁用。 */
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [t, g, r] = await Promise.all([
        apiRequest<{ items: TokenItem[] }>("/api/token/"),
        apiRequest<{ items: GroupOption[] }>("/api/groups"),
        apiRequest<Reconcile>("/api/token/reconcile").catch(() => null),
      ]);
      setTokens(t.items ?? []);
      setGroups(g.items ?? []);
      setReconcile(r);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT, groupName: groups[0]?.name ?? "" });
    setDialogOpen(true);
  }

  function openEdit(t: TokenItem) {
    setEditing(t);
    setDraft({
      name: t.name,
      groupName: t.group_name,
      unlimited: t.unlimited_quota,
      quota: t.quota,
      models: t.models.join(", "),
      neverExpires: !t.expired_at,
      expiredAt: toDatetimeLocal(t.expired_at),
    });
    setDialogOpen(true);
  }

  /** 当前草稿选中的分组，用于提示倍率与模型范围。 */
  const activeGroup = useMemo(
    () => groups.find((g) => g.name === draft.groupName) ?? null,
    [groups, draft.groupName],
  );

  async function save() {
    let expiredAt = "";
    if (!editing && !draft.neverExpires) {
      const when = new Date(draft.expiredAt);
      if (!draft.expiredAt || Number.isNaN(when.getTime())) {
        notify.error("请填写有效期");
        return;
      }
      if (when.getTime() <= Date.now()) {
        notify.error("有效期不能早于当前时间");
        return;
      }
      expiredAt = when.toISOString();
    }

    if (!action.acquire()) return;
    setSaving(true);

    const models = draft.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    try {
      if (editing) {
        await apiRequest(`/api/token/${editing.id}`, {
          method: "PUT",
          body: {
            name: draft.name,
            group_name: draft.groupName,
            unlimited_quota: draft.unlimited,
            // 只用额度而没显式说无限时，后端按有限额度处理；这里明确传值。
            quota: draft.unlimited ? 0 : draft.quota,
            models,
          },
        });
        notify.success("密钥已更新");
      } else {
        const created = await apiRequest<{ id: number; api_key: string; name: string }>("/api/token/", {
          method: "POST",
          body: {
            name: draft.name,
            group_name: draft.groupName,
            unlimited_quota: draft.unlimited,
            quota: draft.unlimited ? 0 : draft.quota,
            models,
            // 空字符串表示永不过期，与后端 tokenRequest.expired_at 一致。
            expired_at: expiredAt,
          },
        });
        const key = (created.api_key ?? "").trim();
        if (!isCallableKey(key)) {
          notify.error("密钥已创建，但返回值不是可调用的完整密钥");
        } else {
          setRevealedIds((prev) => new Set(prev).add(created.id));
          setRevealed({ id: created.id, apiKey: key });
          notify.success("密钥已创建", "请立即复制并妥善保存完整密钥");
        }
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function toggleStatus(t: TokenItem) {
    if (!action.acquire()) return;
    try {
      const status = t.status === 1 ? 0 : 1;
      await apiRequest(`/api/token/${t.id}`, { method: "PUT", body: { status } });
      setTokens((prev) => prev.map((item) => item.id === t.id ? { ...item, status } : item));
      notify.success(`已${status === 1 ? "启用" : "禁用"}密钥「${t.name}」`);
      await load();
    } catch (err) {
      notify.error("操作失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  async function remove(t: TokenItem) {
    if (deletedIds[t.id] || !action.acquire()) return;
    try {
      await apiRequest(`/api/token/${t.id}`, { method: "DELETE" });
      setDeletedIds((prev) => ({ ...prev, [t.id]: true }));
      setTokens((prev) => prev.filter((item) => item.id !== t.id));
      notify.success(`已删除密钥「${t.name}」`);
      await load();
    } catch (err) {
      setDeletedIds((prev) => ({ ...prev, [t.id]: false }));
      notify.error("删除失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  function rememberRevealed(id: number) {
    setRevealedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  async function reveal(t: TokenItem) {
    if (!action.acquire()) return;
    try {
      const key = await fetchPlainKey(t.id);
      rememberRevealed(t.id);
      setRevealed({ id: t.id, apiKey: key });
    } catch (err) {
      notify.error("读取密钥失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  /**
   * 复制必须先打 /reveal，再把返回的明文写入剪贴板。
   * 列表上的 api_key 是打码串，不能直接复制。未 reveal 过的密钥按钮是禁用的。
   */
  async function copyToken(id: number) {
    if (!revealedIds.has(id) || !action.acquire()) return;
    try {
      const key = await fetchPlainKey(id);
      try {
        await navigator.clipboard.writeText(key);
        notify.success("已复制到剪贴板");
      } catch {
        setRevealed({ id, apiKey: key });
        notify.error("复制失败", "完整密钥已显示，请手动选中复制");
      }
    } catch (err) {
      notify.error("复制失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  const available = user ? user.quota - user.used_quota : 0;

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "密钥管理" }]}
      actions={
        <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy || loading || groups.length === 0}>
          新建密钥
        </Button>
      }
    >
      <div className={styles.page}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>密钥管理</h1>
            {user && (
              <p className={styles.balance}>
                账号可用额度 {formatOd(available, currency.unitsPerUnit)}
                <CurrencyIcon src={currency.icon} size="1em" />
              </p>
            )}
          </div>
        </header>

        {loadError && (
          <p className={styles.err} role="alert">
            {loadError}
          </p>
        )}

        {/* 分组为空时无法建密钥（密钥必须绑分组），明确告知怎么解决 */}
        {groups.length === 0 && (
          <div className={styles.notice}>
            <strong>还没有任何分组</strong>
            <p>
              每把密钥都必须绑定一个分组（分组决定可用模型与计费倍率）。
              {can(Perm.UserEdit) ? "请先到「用户分组」创建一个。" : "请联系管理员创建分组后再来。"}
            </p>
          </div>
        )}

        {/*
          对账提示。
          删密钥是物理删除，但花费记在账号上 —— 差额是真实支出，
          不显示出来用户会以为系统算错了。
        */}
        {reconcile && !reconcile.consistent && (
          <div className={styles.reconcile}>
            另有已删除密钥花掉{" "}
            <strong>{formatOd(reconcile.deleted_used, currency.unitsPerUnit)}</strong>
            <CurrencyIcon src={currency.icon} size="0.9em" />
            ，因此「现存密钥已用之和」小于账号总用量 —— 这是正常的。
          </div>
        )}

        {loading ? (
          <p className={styles.loading}>加载中…</p>
        ) : tokens.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState
              title="还没有密钥"
              description="创建一把密钥即可开始调用接口。密钥只在创建时完整显示一次。"
              action={
                groups.length > 0 ? (
                  <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy || loading}>
                    新建密钥
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.list}>
            {tokens.map((t) => (
              <article key={t.id} className={styles.item}>
                <div className={styles.itemMain}>
                  <div className={styles.itemHead}>
                    <strong className={styles.itemName}>{t.name}</strong>
                    <span className={styles.groupTag}>{t.group_name}</span>
                    {t.unlimited_quota ? (
                      <span className={styles.unlimitedTag}>不限额度</span>
                    ) : (
                      <span className={styles.limitTag}>
                        限额 {formatOd(t.quota, currency.unitsPerUnit)}
                        <CurrencyIcon src={currency.icon} size="0.85em" />
                      </span>
                    )}
                    {t.status !== 1 && <span className={styles.offTag}>已禁用</span>}
                  </div>

                  <div className={styles.keyRow}>
                    <code className={styles.key} onCopy={(event) => event.preventDefault()}>{t.api_key}</code>
                    <button type="button" className={styles.miniBtn} onClick={() => void reveal(t)} disabled={action.busy || loading}>
                      显示
                    </button>
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => void copyToken(t.id)}
                      disabled={!revealedIds.has(t.id) || action.busy || loading}
                      aria-label={revealedIds.has(t.id) ? "复制完整密钥" : "请先显示完整密钥后再复制"}
                      title={revealedIds.has(t.id) ? "复制完整密钥" : "请先显示完整密钥"}
                    >
                      复制
                    </button>
                  </div>

                  <dl className={styles.meta}>
                    <div>
                      <dt>已用</dt>
                      <dd>
                        {formatOd(t.used_quota, currency.unitsPerUnit)}
                        <CurrencyIcon src={currency.icon} size="0.85em" />
                      </dd>
                    </div>
                    <div>
                      <dt>可用模型</dt>
                      <dd>{t.models.length > 0 ? t.models.map((model) => <ModelMark key={model} model={model} />) : "跟随分组"}</dd>
                    </div>
                    <div>
                      <dt>有效期</dt>
                      <dd>{formatExpiry(t.expired_at)}</dd>
                    </div>
                    <div>
                      <dt>最近使用</dt>
                      <dd>{t.accessed_at ? formatExpiry(t.accessed_at) : "从未使用"}</dd>
                    </div>
                  </dl>
                </div>

                <div className={styles.itemActions}>
                  <Button variant="secondary" size="sm" onClick={() => openEdit(t)} disabled={action.busy || loading}>
                    编辑
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void toggleStatus(t)} disabled={action.busy || loading}>
                    {t.status === 1 ? "禁用" : "启用"}
                  </Button>
                  <HoldToConfirm
                    key={String(action.busy)}
                    label="长按删除，密钥永久失效"
                    confirmedLabel="已删除"
                    tone="danger"
                    duration={1200}
                    disabled={action.busy || loading}
                    confirmed={deletedIds[t.id] ?? false}
                    onConfirm={() => void remove(t)}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* ---------- 新建 / 编辑 ---------- */}
      <Dialog open={dialogOpen} onOpenChange={(next) => { if (!action.busy) setDialogOpen(next); }}>
        <DialogContent
          title={editing ? "编辑密钥" : "新建密钥"}
          description="密钥必须绑定一个分组，分组决定可用模型与计费倍率。"
        >
          <div className={styles.form} inert={action.busy}>
            <Input
              label="名称"
              placeholder="例如：生产环境"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />

            <Select
              label="分组"
              value={draft.groupName}
              options={groups.map((g) => ({
                value: g.name,
                label: `${g.name}${g.rate === 1 ? "" : ` · ${g.rate} 倍率`}`,
              }))}
              onValueChange={(groupName) => setDraft({ ...draft, groupName })}
              placeholder="请选择分组"
            />

            {/* 分组信息提示：让用户知道自己选的是什么，而不是只看一个名字 */}
            {activeGroup && (
              <p className={styles.groupHint}>
                倍率 {activeGroup.rate}
                {activeGroup.rate !== 1 && <span>（计费按 {activeGroup.rate} 倍计算）</span>}
                <br />
                可用模型：{activeGroup.models.length > 0 ? activeGroup.models.map((model) => <ModelMark key={model} model={model} />) : "不限"}
              </p>
            )}

            <div className={styles.switchRow}>
              <Switch
                label={draft.unlimited ? "不限额度（跟账号余额）" : "限制额度"}
                checked={draft.unlimited}
                onCheckedChange={(unlimited) => setDraft({ ...draft, unlimited })}
              />
            </div>

            {!draft.unlimited && (
              <NumberField
                label="额度上限"
                value={draft.quota}
                min={0}
                max={available}
                step={10000}
                largeStep={100000}
                onValueChange={(quota) => setDraft({ ...draft, quota })}
                description={`单位是额度单位，上限为账号可用额度（${formatOd(available, currency.unitsPerUnit)}）`}
              />
            )}

            <Textarea
              label="模型白名单"
              placeholder="留空表示跟随分组设置。多个模型用逗号分隔"
              value={draft.models}
              onChange={(e) => setDraft({ ...draft, models: e.target.value })}
              description="只能填该分组允许的模型，填了范围外的会被拒绝"
            />

            <div className={styles.switchRow}>
              <Switch
                label={draft.neverExpires ? "永不过期" : "设置有效期"}
                checked={draft.neverExpires}
                disabled={editing !== null}
                onCheckedChange={(neverExpires) => setDraft({ ...draft, neverExpires })}
              />
            </div>
            {editing && <p className={styles.groupHint}>有效期在创建时设定，之后不能修改。</p>}

            {!draft.neverExpires && (
              <Input
                label="到期时间"
                type="datetime-local"
                value={draft.expiredAt}
                disabled={editing !== null}
                onChange={(e) => setDraft({ ...draft, expiredAt: e.target.value })}
                description="到期后该密钥不能再调用接口"
              />
            )}
          </div>

          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={action.busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} disabled={action.busy} onClick={() => void save()}>
              {editing ? "保存" : "创建"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---------- 密钥展示（仅一次） ---------- */}
      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent
          title="请立即复制密钥"
          description="列表里只显示打码版本。复制会重新读取完整密钥，可直接作为 Bearer 调用 /v1。"
        >
          <code className={styles.revealedKey}>{revealed?.apiKey}</code>
          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" disabled={action.busy} onClick={() => revealed && void copyToken(revealed.id)}>
              复制
            </Button>
            <Button variant="primary" size="sm" onClick={() => setRevealed(null)}>
              我已保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

/** 把额度单位换算成货币数量显示。 */
function formatOd(units: number, unitsPerUnit: number): string {
  if (!unitsPerUnit) return "0";
  const v = units / unitsPerUnit;
  // 零值直接显示 0：0.0000 看起来像「一个很小的非零值」，
  // 与运行状态页的金额位数也不一致。
  if (v === 0) return "0";
  return v < 1 ? v.toFixed(4) : v.toFixed(2);
}

function formatExpiry(raw: string): string {
  if (!raw) return "永不过期";
  return raw.replace("T", " ").slice(0, 16);
}

/** 把后端的 RFC3339 / DATETIME 收成 datetime-local 需要的本地时间。 */
function toDatetimeLocal(raw: string): string {
  if (!raw) return "";
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** 向 /reveal 要明文。打码串直接拒绝，避免写进剪贴板。 */
async function fetchPlainKey(id: number): Promise<string> {
  const r = await apiRequest<{ api_key: string }>(`/api/token/${id}/reveal`);
  const key = (r.api_key ?? "").trim();
  if (!isCallableKey(key)) {
    throw new ApiRequestError("返回的不是可调用的完整密钥", "masked_key", 0);
  }
  return key;
}
