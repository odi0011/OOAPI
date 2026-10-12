import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";

import { Button } from "@/components/arc/button/button";
import { ChipGroup } from "@/components/arc/chip-group/chip-group";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import MorphSelect from "@/components/arc/morph-select/morph-select";
import { NumberField } from "@/components/arc/number-field/number-field";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import AdminLayout from "@/components/admin/AdminLayout";
import { VendorMark } from "@/components/BrandMark";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { canonicalVendor, vendorLabel, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminGroups.module.css";

interface Group {
  id: number;
  name: string;
  remark: string;
  rate: number;
  models: string[];
  created_at: string;
}

/** 模型目录里的一项（来自 /api/admin/models/catalog）。 */
interface CatalogEntry {
  model: string;
  channels: { id: number; name: string; vendor: string; status: number }[];
  priced: boolean;
}

interface Draft {
  name: string;
  remark: string;
  rate: number;
  models: string[];
}

const EMPTY: Draft = { name: "", remark: "", rate: 1, models: [] };

/** 白名单条目超过这个数量就默认折叠（截图里的「36 个模型」那一条）。 */
const COLLAPSE_AT = 12;

/** 一个模型展示用哪个厂商图标：优先账号声明的厂商，再退回模型名前缀。 */
function iconVendor(entry: CatalogEntry | undefined, model: string): string {
  for (const channel of entry?.channels ?? []) {
    const vendor = canonicalVendor(channel.vendor);
    if (vendor) return vendor;
  }
  return vendorOfModel(model) ?? "custom";
}

/**
 * 分组管理。
 *
 * 分组决定两件事：计费倍率与可用模型范围。
 * 密钥必须绑定分组，因此这里改动会直接影响所有引用该分组的密钥。
 *
 * 模型白名单从「一个逗号分隔的输入框」改成可视列表：
 * 白名单是**路由的第一道门**（缺一个模型 = 该模型对该分组的全部密钥不可达），
 * 而输入框里手打的模型名既容易拼错、也看不出哪个模型还没加上 ——
 * 拼错的后果是静默的 403，很难排查。
 */
export default function AdminGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const notify = useNotify();
  const action = useAsyncGuard();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<Record<number, boolean>>({});

  /** 模型目录（供白名单选择与「同步」按钮使用）。 */
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  /**
   * 已定价的模型名。

   * 用途是判断白名单里的名字「认不认识」：账号目录里只有**上游叫法**
   * （deepseek-v4.1-flash），而白名单里允许写**官方名**（deepseek-flash）。
   * 只看账号目录会把官方名误标成「未知」，管理员会以为配错了。
   */
  const [pricedModels, setPricedModels] = useState<string[]>([]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  /** 厂商筛选（白名单候选太长时用来收窄）。 */
  const [vendorFilter, setVendorFilter] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [groupsData, catalogData, priceData] = await Promise.all([
        apiRequest<{ items: Group[] }>("/api/admin/groups"),
        apiRequest<{ items: CatalogEntry[] }>("/api/admin/models/catalog").catch(() => ({ items: [] })),
        apiRequest<{ items: { model: string }[] }>("/api/admin/prices").catch(() => ({ items: [] })),
      ]);
      setGroups(groupsData.items ?? []);
      setCatalog(catalogData.items ?? []);
      setPricedModels((priceData.items ?? []).map((item) => item.model));
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 目录索引：模型名 → 条目（判断图标与是否有账号支持）。 */
  const catalogIndex = useMemo(() => {
    const index = new Map<string, CatalogEntry>();
    for (const entry of catalog) index.set(entry.model.toLowerCase(), entry);
    return index;
  }, [catalog]);

  /**
   * 「有账号在服务」的模型：至少一个启用状态的账号声明支持它。
   *
   * 与「全部模型」分开：同步时多数人要的是「现在真的能调的那些」，
   * 把已停用账号声明过的模型也塞进来只会让人以为配好了却调不通。
   */
  const upstreamSupported = useMemo(
    () => catalog.filter((entry) => entry.channels.some((channel) => channel.status === 1)).map((entry) => entry.model),
    [catalog],
  );
  const allConfigured = useMemo(() => catalog.map((entry) => entry.model), [catalog]);

  /** 厂商分组（供筛选 chip）。 */
  const vendors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of catalog) {
      const vendor = iconVendor(entry, entry.model);
      counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([vendor, count]) => ({ value: vendor, label: `${vendorLabel(vendor)} (${count})` }));
  }, [catalog]);

  /** 白名单里「认识」的名字：账号目录里有，或者已有定价（官方名）。 */
  const knownModels = useMemo(() => {
    const known = new Set<string>();
    for (const entry of catalog) known.add(entry.model.toLowerCase());
    for (const model of pricedModels) known.add(model.toLowerCase());
    return known;
  }, [catalog, pricedModels]);

  /** 「添加模型」的下拉候选：排除已在白名单里的，并按厂商筛选。 */
  const addOptions = useMemo(() => {
    const chosen = new Set(draft.models.map((m) => m.toLowerCase()));
    return catalog
      .filter((entry) => !chosen.has(entry.model.toLowerCase()))
      .filter((entry) => vendorFilter.length === 0 || vendorFilter.includes(iconVendor(entry, entry.model)))
      .map((entry) => ({ value: entry.model, label: entry.model, icon: <VendorMark vendor={iconVendor(entry, entry.model)} /> }));
  }, [catalog, draft.models, vendorFilter]);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY);
    setModelsExpanded(false);
    setVendorFilter([]);
    setOpen(true);
  }

  function openEdit(g: Group) {
    setEditing(g);
    setDraft({ name: g.name, remark: g.remark, rate: g.rate, models: [...g.models] });
    setModelsExpanded(g.models.length <= COLLAPSE_AT);
    setVendorFilter([]);
    setOpen(true);
  }

  function addModel(model: string) {
    if (!model) return;
    setDraft((d) => {
      if (d.models.some((m) => m.toLowerCase() === model.toLowerCase())) return d;
      return { ...d, models: [...d.models, model] };
    });
  }

  function removeModel(model: string) {
    setDraft((d) => ({ ...d, models: d.models.filter((m) => m.toLowerCase() !== model.toLowerCase()) }));
  }

  /** 同步：把给定来源的模型并入白名单（不覆盖已有手选项）。 */
  function syncFrom(source: string[], label: string) {
    setDraft((d) => {
      const seen = new Set(d.models.map((m) => m.toLowerCase()));
      const merged = [...d.models];
      for (const model of source) {
        if (seen.has(model.toLowerCase())) continue;
        seen.add(model.toLowerCase());
        merged.push(model);
      }
      return { ...d, models: merged };
    });
    setModelsExpanded(true);
    notify.success(`已同步${label}`, `白名单已并入 ${source.length} 个候选模型`);
  }

  async function save() {
    if (!action.acquire()) return;
    setSaving(true);
    const body = {
      name: draft.name.trim(),
      remark: draft.remark.trim(),
      rate: draft.rate,
      models: draft.models.map((m) => m.trim()).filter(Boolean),
    };
    try {
      if (editing) {
        await apiRequest(`/api/admin/groups/${editing.id}`, { method: "PUT", body });
        notify.success("分组已更新", "引用该分组的密钥会同步生效");
      } else {
        await apiRequest("/api/admin/groups", { method: "POST", body });
        notify.success("分组已创建");
      }
      setOpen(false);
      await load();
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function remove(g: Group) {
    if (deletedIds[g.id] || !action.acquire()) return;
    try {
      await apiRequest(`/api/admin/groups/${g.id}`, { method: "DELETE" });
      setDeletedIds((prev) => ({ ...prev, [g.id]: true }));
      setGroups((prev) => prev.filter((item) => item.id !== g.id));
      notify.success(`已删除分组「${g.name}」`);
      await load();
    } catch (err) {
      setDeletedIds((prev) => ({ ...prev, [g.id]: false }));
      notify.error("删除失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  /** 白名单展示：折叠时只显示前若干个（选中的永远可见）。 */
  const shownModels = modelsExpanded ? draft.models : draft.models.slice(0, COLLAPSE_AT);
  const hiddenCount = draft.models.length - shownModels.length;

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "用户分组" }]}
      actions={
        <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy || loading}>
          新建分组
        </Button>
      }
    >
      <div className={styles.page}>
        <h1 className={styles.title}>用户分组</h1>

        {loadError && (
          <p className={styles.err} role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className={styles.loading}>加载中…</p>
        ) : groups.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState
              title="还没有分组"
              description="分组决定密钥的可用模型范围与计费倍率。先建一个，用户才能创建密钥。"
              action={
                <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy || loading}>
                  新建分组
                </Button>
              }
            />
          </div>
        ) : (
          <div className={styles.grid}>
            {groups.map((g) => (
              <article key={g.id} className={styles.card}>
                <header className={styles.cardHead}>
                  <div className={styles.cardTitleRow}>
                    <strong className={styles.cardName}>{g.name}</strong>
                    <span className={styles.rateTag}>
                      {g.rate === 1 ? "原价" : `${g.rate} 倍率`}
                    </span>
                  </div>
                  {g.remark && <p className={styles.cardRemark}>{g.remark}</p>}
                </header>

                <div className={styles.cardBody}>
                  <span className={styles.fieldLabel}>可用模型</span>
                  {g.models.length > 0 ? (
                    <div className={styles.models}>
                      {g.models.slice(0, 8).map((m) => (
                        <span key={m} className={styles.modelTag}>
                          <VendorMark vendor={iconVendor(catalogIndex.get(m.toLowerCase()), m)} />
                          <span className={styles.modelTagName}>{m}</span>
                        </span>
                      ))}
                      {g.models.length > 8 && <span className={styles.moreTag}>+{g.models.length - 8}</span>}
                    </div>
                  ) : (
                    <span className={styles.unlimited}>不限</span>
                  )}
                </div>

                <footer className={styles.cardActions}>
                  <Button variant="secondary" size="sm" onClick={() => openEdit(g)} disabled={action.busy || loading}>
                    编辑
                  </Button>
                  <HoldToConfirm
                    key={String(action.busy)}
                    label="长按永久删除分组"
                    confirmedLabel="已删除"
                    tone="danger"
                    duration={1200}
                    disabled={action.busy || loading}
                    confirmed={deletedIds[g.id] ?? false}
                    onConfirm={() => void remove(g)}
                  />
                </footer>
              </article>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={(next) => { if (!action.busy) setOpen(next); }}>
        <DialogContent
          className={styles.wideDialog}
          bodyClassName={styles.dialogBody}
          title={editing ? "编辑分组" : "新建分组"}
          description="分组决定密钥能调用哪些模型，以及计费时乘的倍率。"
        >
          <div className={styles.form} inert={action.busy}>
            <div className={styles.basics}>
              <Input
                label="分组名"
                placeholder="例如：standard"
                value={draft.name}
                maxLength={32}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                description="全局唯一。密钥绑定的是这个名字，改名会同步更新所有引用"
              />
              <NumberField
                label="计费倍率"
                value={draft.rate}
                min={0.0001}
                max={1000}
                step={0.1}
                largeStep={1}
                scrub
                formatOptions={{ maximumFractionDigits: 4 }}
                onValueChange={(rate) => setDraft({ ...draft, rate })}
                description="1 = 原价，0.8 = 八折，2 = 双倍"
              />
              <Input
                label="备注"
                placeholder="这个分组是给谁用的、有什么限制"
                value={draft.remark}
                onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
              />
            </div>

            {/*
              白名单是路由的第一道门：缺一个模型 = 该模型对该分组的全部密钥不可达。
              （原项目这里还有一个「模型映射」页签，但那份实现是规划项、从未落地；
              本站的映射是**全局**的，在「模型定价 → 能力与映射」里配，故此处不设该页签。）
            */}
            <div className={styles.allowTab}>
                <ChipGroup
                  label="按厂商筛选候选"
                  options={vendors}
                  value={vendorFilter}
                  onValueChange={setVendorFilter}
                  maxVisible={10}
                />

                <div className={styles.addRow}>
                  <MorphSelect
                    hideLabel
                    label="添加模型"
                    items={addOptions}
                    value=""
                    onValueChange={addModel}
                    searchable="auto"
                    searchPlaceholder="搜索模型"
                    panelWidth={320}
                    align="start"
                    placeholder={vendorFilter.length > 0 ? "从筛选结果里选一个加入白名单" : "从模型目录里选一个加入白名单"}
                  />
                  <span className={styles.muted}>共 {catalog.length} 个候选</span>
                </div>

                <div className={styles.allowBox}>
                  {draft.models.length === 0 ? (
                    <p className={styles.allowEmpty}>
                      白名单为空 = <strong>不限制</strong>（该分组的密钥可以调用任何模型）。
                      要限制范围就把模型加进来。
                    </p>
                  ) : (
                    <div className={styles.allowGrid}>
                      {shownModels.map((m) => (
                        <span key={m} className={styles.allowItem}>
                          <VendorMark vendor={iconVendor(catalogIndex.get(m.toLowerCase()), m)} />
                          <span className={styles.allowName} title={m}>{m}</span>
                          {/* 手工加的模型可能不在目录里（上游新出的），标记出来便于核对 */}
                          {!knownModels.has(m.toLowerCase()) && <span className={styles.staleTag} title="既不在账号模型目录里，也没有定价 —— 确认拼写是否正确">未知</span>}
                          <button
                            type="button"
                            className={styles.removeModel}
                            aria-label={`从白名单移除 ${m}`}
                            onClick={() => removeModel(m)}
                          >
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {draft.models.length > 0 && (
                    <button
                      type="button"
                      className={styles.collapseToggle}
                      aria-expanded={modelsExpanded}
                      onClick={() => setModelsExpanded((v) => !v)}
                    >
                      <span>{draft.models.length} 个模型{hiddenCount > 0 && modelsExpanded ? "" : ""}</span>
                      <ChevronDown size={14} data-open={modelsExpanded || undefined} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <div className={styles.syncActions}>
                  <button type="button" className={styles.syncBtn} onClick={() => syncFrom(allConfigured, "全部已配置模型")}>
                    同步最新支持模型
                  </button>
                  <button type="button" className={styles.syncBtn} onClick={() => syncFrom(upstreamSupported, "上游支持的模型")}>
                    同步上游支持的模型
                  </button>
                  <button
                    type="button"
                    className={`${styles.syncBtn} ${styles.syncDanger}`}
                    onClick={() => {
                      setDraft((d) => ({ ...d, models: [] }));
                      notify.success("已清空白名单", "该分组将不再限制模型范围（可调用任何模型）");
                    }}
                  >
                    清除所有模型
                  </button>
                </div>
            </div>
          </div>

          <div className={styles.dialogActions}>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={action.busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} disabled={action.busy} onClick={() => void save()}>
              {editing ? "保存" : "创建"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
