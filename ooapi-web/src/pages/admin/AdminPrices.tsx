import { useCallback, useEffect, useMemo, useState } from "react";

import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { SearchField } from "@/components/arc/search-field/search-field";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import AdminLayout from "@/components/admin/AdminLayout";
import AdminModelCatalog from "@/components/admin/AdminModelCatalog";
import AdminModelConfig from "@/components/admin/AdminModelConfig";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useCurrency } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { vendorIconUrl, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminPrices.module.css";

interface Price {
  model: string;
  input_price: number;
  output_price: number;
  cached_price: number;
}

interface Draft {
  model: string;
  input: string;
  output: string;
  cached: string;
}

const EMPTY: Draft = { model: "", input: "", output: "", cached: "" };

const TAB_TITLES = { catalog: "全部模型", prices: "模型定价", config: "能力与映射" } as const;

/**
 * 模型定价。
 *
 * 单价单位是「货币 / 百万 token」。计费公式：
 *   (提示/1e6 × 输入价 + 补全/1e6 × 输出价 + 缓存/1e6 × 缓存价) × 额度单位
 *
 * 未配置价格的模型会按 0 计费 —— 那等于免费，因此这里对「有账号但没有定价的模型」
 * 给出明确提示，避免漏配。
 */
export default function AdminPrices() {
  const currency = useCurrency();

  const [prices, setPrices] = useState<Price[]>([]);
  const [loading, setLoading] = useState(true);
  // 操作反馈走全局 toast
  const notify = useNotify();
  const action = useAsyncGuard();
  /** 列表加载失败是页面级问题，内联常驻；其余走 toast。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 定价的删除完成态（失败时要能复位回可长按） */
  const [deletedModels, setDeletedModels] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  /*
    页面分三块：全部模型（谁支持什么）、定价（多少钱）、
    能力与映射（多少上下文、怎么调思考档）。
    第一块是总入口 —— 从「有哪些模型」出发比从「定价表」出发更符合直觉。
  */
  const [tab, setTab] = useState<"catalog" | "prices" | "config">("catalog");
  /** 从总览点「配置能力参数」时带过去的模型名。 */
  const [focusModel, setFocusModel] = useState<string | undefined>(undefined);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  /** 正在行内编辑的模型名 → 草稿值。 */
  const [editing, setEditing] = useState<Record<string, Draft>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<{ items: Price[] }>("/api/admin/prices");
      setPrices(data.items ?? []);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 按模型名筛选。定价表可能很长，搜索是必要的。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prices;
    return prices.filter((p) => p.model.toLowerCase().includes(q));
  }, [prices, query]);

  async function upsert(model: string, input: string, output: string, cached: string, creating = false) {
    const name = model.trim().toLowerCase();
    if (!name) {
      notify.warning("请填写模型名");
      return;
    }

    // 空字符串按 0 处理：允许只配输入价、缓存价留空。
    const parse = (v: string) => {
      if (v.trim() === "") return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const iv = parse(input);
    const ov = parse(output);
    const cv = parse(cached);

    if ([iv, ov, cv].some((n) => Number.isNaN(n))) {
      notify.warning("价格必须是数字");
      return;
    }
    if ([iv, ov, cv].some((n) => n < 0)) {
      notify.warning("价格不能为负");
      return;
    }

    if (!action.acquire()) return;
    setSaving(true);
    try {
      await apiRequest("/api/admin/prices", {
        method: "POST",
        body: { model: name, input_price: iv, output_price: ov, cached_price: cv },
      });
      notify.success(`已保存「${name}」的定价`);
      if (creating) setDraft(EMPTY);
      setDeletedModels((prev) => ({ ...prev, [name]: false }));
      setEditing((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      await load();
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function remove(model: string) {
    if (deletedModels[model] || !action.acquire()) return;
    try {
      await apiRequest(`/api/admin/prices/${encodeURIComponent(model)}`, { method: "DELETE" });
      setDeletedModels((prev) => ({ ...prev, [model]: true }));
      setPrices((prev) => prev.filter((item) => item.model !== model));
      notify.success(`已删除「${model}」的定价`, "该模型将按 0 计费（免费）");
      await load();
    } catch (err) {
      setDeletedModels((prev) => ({ ...prev, [model]: false }));
      notify.error("删除失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "模型定价" }]}>
      <div className={styles.page}>
        <header className={styles.head}>
          <h1 className={styles.title}>{TAB_TITLES[tab]}</h1>
          <p className={styles.unitNote}>
            {tab === "prices"
              ? <>单价单位：{currency.name} / 百万 token<CurrencyIcon src={currency.icon} size="1em" /></>
              : tab === "config" ? "上下文窗口、能力参数与推理强度映射" : "全部模型、支持的账号与配置状态"}
          </p>
        </header>

        {/* 三块配置服务同一件事：有哪些模型、多少钱、怎么用。 */}
        <Tabs value={tab} onValueChange={(value) => setTab(value as "catalog" | "prices" | "config")}>
          <TabsList aria-label="模型配置分区">
            <TabsTrigger value="catalog">全部模型</TabsTrigger>
            <TabsTrigger value="prices">定价</TabsTrigger>
            <TabsTrigger value="config">能力与映射</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "catalog" ? (
          <AdminModelCatalog onConfigure={(model) => { setFocusModel(model); setTab("config"); }} />
        ) : tab === "config" ? <AdminModelConfig focusModel={focusModel} /> : <>

        {loadError && (
          <p className={styles.err} role="alert">
            {loadError}
          </p>
        )}

        {/* ---------- 新增 ---------- */}
        <section className={styles.addCard}>
          <h2 className={styles.addTitle}>新增 / 覆盖定价</h2>
          <div className={styles.addRow} inert={action.busy}>
            <Input
              label="模型名"
              placeholder="例如 gpt-4-turbo"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
            <Input
              label="输入价"
              placeholder="0"
              value={draft.input}
              onChange={(e) => setDraft({ ...draft, input: e.target.value })}
            />
            <Input
              label="输出价"
              placeholder="0"
              value={draft.output}
              onChange={(e) => setDraft({ ...draft, output: e.target.value })}
            />
            <Input
              label="缓存价"
              placeholder="0"
              value={draft.cached}
              onChange={(e) => setDraft({ ...draft, cached: e.target.value })}
            />
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={action.busy || loading}
              onClick={() => void upsert(draft.model, draft.input, draft.output, draft.cached, true)}
            >
              保存
            </Button>
          </div>
          <p className={styles.addHint}>
            同名模型会被覆盖。模型名不区分大小写 —— 保存时会统一转成小写，避免同一模型出现两条定价。
          </p>
        </section>

        {/* ---------- 列表 ---------- */}
        {loading ? (
          <p className={styles.loading}>加载中…</p>
        ) : prices.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState
              title="还没有配置定价"
              description="未配置价格的模型会按 0 计费，也就是免费。建议逐个确认常用模型的单价。"
            />
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <SearchField
                label="搜索模型"
                value={query}
                onValueChange={setQuery}
                placeholder="按模型名筛选"
              />
              <span className={styles.count}>
                共 {prices.length} 个模型{query && ` · 匹配 ${filtered.length}`}
              </span>
            </div>

            <div className={styles.table}>
              <div className={styles.thead}>
                <span>模型</span>
                <span className={styles.num}>输入价</span>
                <span className={styles.num}>输出价</span>
                <span className={styles.num}>缓存价</span>
                <span className={styles.actions}>操作</span>
              </div>

              {filtered.map((p) => {
                const isEditing = !!editing[p.model];
                const d = editing[p.model] ?? {
                  model: p.model,
                  input: String(p.input_price),
                  output: String(p.output_price),
                  cached: String(p.cached_price),
                };
                const icon = vendorIconUrl(vendorOfModel(p.model));

                return (
                  <div key={p.model} className={isEditing ? `${styles.row} ${styles.rowEditing}` : styles.row}>
                    <span className={styles.modelCell}>
                      {icon && <img className={styles.vendorMark} src={icon} alt="" loading="lazy" />}
                      <code className={styles.modelName}>{p.model}</code>
                      {p.input_price === 0 && p.output_price === 0 && (
                        <Badge tone="warning" size="sm">按 0 计费</Badge>
                      )}
                    </span>

                    {isEditing ? (
                      <>
                        <input
                          className={styles.cellInput}
                          disabled={action.busy}
                          value={d.input}
                          onChange={(e) =>
                            setEditing((prev) => ({ ...prev, [p.model]: { ...d, input: e.target.value } }))
                          }
                        />
                        <input
                          className={styles.cellInput}
                          disabled={action.busy}
                          value={d.output}
                          onChange={(e) =>
                            setEditing((prev) => ({ ...prev, [p.model]: { ...d, output: e.target.value } }))
                          }
                        />
                        <input
                          className={styles.cellInput}
                          disabled={action.busy}
                          value={d.cached}
                          onChange={(e) =>
                            setEditing((prev) => ({ ...prev, [p.model]: { ...d, cached: e.target.value } }))
                          }
                        />
                        <span className={styles.actions}>
                          <Button
                            variant="primary"
                            size="sm"
                            loading={saving}
                            disabled={action.busy}
                            onClick={() => void upsert(p.model, d.input, d.output, d.cached)}
                          >
                            保存
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={action.busy || loading}
                            onClick={() =>
                              setEditing((prev) => {
                                const next = { ...prev };
                                delete next[p.model];
                                return next;
                              })
                            }
                          >
                            取消
                          </Button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={styles.num}>{formatPrice(p.input_price)}</span>
                        <span className={styles.num}>{formatPrice(p.output_price)}</span>
                        <span className={styles.num}>{formatPrice(p.cached_price)}</span>
                        <span className={styles.actions}>
                          {/* 行内编辑而不是弹窗：定价表是密集的数据，
                              弹窗每次只能改一行，行内编辑可以连着改好几行 */}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={action.busy || loading}
                            onClick={() =>
                              setEditing((prev) => ({
                                ...prev,
                                [p.model]: {
                                  model: p.model,
                                  input: String(p.input_price),
                                  output: String(p.output_price),
                                  cached: String(p.cached_price),
                                },
                              }))
                            }
                          >
                            编辑
                          </Button>
                          <HoldToConfirm
                            key={String(action.busy)}
                            label="长按删除，此模型将免费"
                            confirmedLabel="已删除"
                            tone="danger"
                            duration={1200}
                            disabled={action.busy || loading}
                            confirmed={deletedModels[p.model] ?? false}
                            onConfirm={() => void remove(p.model)}
                          />
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        </>}
      </div>
    </AdminLayout>
  );
}

function formatPrice(v: number): string {
  // 单价常有多位小数（如 0.0005），够用即可，不补多余零。
  return v === 0 ? "0" : String(Number(v.toFixed(6)));
}
