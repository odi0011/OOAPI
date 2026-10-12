import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link2, RefreshCw, Unlink } from "lucide-react";

import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { ChipGroup } from "@/components/arc/chip-group/chip-group";
import MorphSelect from "@/components/arc/morph-select/morph-select";
import { SearchField } from "@/components/arc/search-field/search-field";
import { VendorMark } from "@/components/BrandMark";
import { useCurrency } from "@/contexts/CurrencyContext";
import { apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";
import { canonicalVendor, vendorLabel, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminModelCatalog.module.css";

/*
  全部模型总览。

  解决的问题：模型相关的三件事分散在三个地方 ——
  「哪些账号支持它」（账号管理）、「多少钱」（定价）、
  「多少上下文、怎么调思考档」（能力配置）。漏配其中一个，症状是
  静默的（未定价按 0 计费 = 免费），不主动查就发现不了。

  这一屏把三件事合成一个视图，并按厂商分组：同一个厂商的模型放在一起，
  因为漏配往往是「某次接入新厂商时整批漏了」，按厂商分组最容易看出来。

  默认跟随：如果某个模型名是已定价官模的变体（deepseek-v4.1-flash-sg ←
  deepseek-v4.1-flash），这里会直接建议跟随，一键写入映射 + 抄一份能力参数。
*/

interface CatalogChannel {
  id: number;
  name: string;
  vendor: string;
  method: string;
  status: number;
}

interface CatalogEntry {
  model: string;
  channels: CatalogChannel[];
  priced: boolean;
  price?: { model: string; input_price: number; output_price: number; cached_price: number };
  follow_target?: string;
  followed: boolean;
  capabilities?: { context_window: number; reasoning: { levels: string[] } };
}

export interface RealModel {
  id: string;
  developer: string;
  label: string;
  input_price: number;
  output_price: number;
  cached_price: number;
  context_window: number;
  max_output_tokens: number;
  vision: boolean;
  tool_calling: boolean;
  reasoning: boolean;
  note?: string;
  source?: string;
  verified: boolean;
}

interface Props {
  /** 点「配置能力」时把模型名交给父组件（切到能力配置页并载入）。 */
  onConfigure: (model: string) => void;
}

/** 一个模型的厂商判定：先看账号声明的厂商，再用模型名前缀兜底。 */
function vendorOf(entry: CatalogEntry): string {
  for (const channel of entry.channels) {
    const vendor = canonicalVendor(channel.vendor);
    if (vendor) return vendor;
  }
  return vendorOfModel(entry.model) ?? "custom";
}

export default function AdminModelCatalog({ onConfigure }: Props) {
  const currency = useCurrency();
  const notify = useNotify();
  const action = useAsyncGuard();

  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 厂商筛选（多选）。空 = 全部。 */
  const [vendorFilter, setVendorFilter] = useState<string[]>([]);
  /** 内置真实模型目录（绑定用）。 */
  const [realModels, setRealModels] = useState<RealModel[]>([]);
  /** 正在绑定哪个上游别名（模型名）→ 选中的账号与真实模型 id。 */
  const [binding, setBinding] = useState<{ model: string; channelID: number; realID: string } | null>(null);
  /**
   * 可以承接当前绑定操作的账号（声明支持这个别名的那些）。
   *
   * 绑定是账号级的，所以必须指明绑在哪个账号上 —— 而只有声明了该别名的
   * 账号才有意义（绑到一个不支持它的账号等于没绑）。
   */
  const bindableChannels = useMemo(() => {
    if (!binding) return [];
    const entry = entries.find((e) => e.model === binding.model);
    return entry?.channels ?? [];
  }, [binding, entries]);
  /** 真实模型下拉：按厂商分组（46 个模型平铺太长）。 */
  const realModelGroups = useMemo(() => {
    const byDeveloper = new Map<string, RealModel[]>();
    for (const model of realModels) {
      const list = byDeveloper.get(model.developer) ?? [];
      list.push(model);
      byDeveloper.set(model.developer, list);
    }
    return [...byDeveloper.entries()]
      .map(([developer, models]) => ({
        label: developer,
        options: models
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((model) => ({
            value: model.id,
            label: model.label + " · " + (model.input_price || 0) + "/" + (model.output_price || 0),
          })),
      }))
      .sort((a, b) => b.options.length - a.options.length || a.label.localeCompare(b.label));
  }, [realModels]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, real] = await Promise.all([
        apiRequest<{ items: CatalogEntry[] }>("/api/admin/models/catalog"),
        apiRequest<{ items: RealModel[] }>("/api/admin/models/real"),
      ]);
      setEntries(data.items ?? []);
      setRealModels(real.items ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载模型目录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 按厂商分组（厂商内部按模型名排序）。 */
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
      if (q && !entry.model.toLowerCase().includes(q)) continue;
      const vendor = vendorOf(entry);
      const list = groups.get(vendor) ?? [];
      list.push(entry);
      groups.set(vendor, list);
    }
    return [...groups.entries()]
      .map(([vendor, list]) => ({ vendor, list: list.sort((a, b) => a.model.localeCompare(b.model)) }))
      .sort((a, b) => b.list.length - a.list.length || a.vendor.localeCompare(b.vendor));
  }, [entries, query]);

  /** 经搜索 + 厂商筛选后的可见模型；未定价的排前面（这一屏就是用来找漏配的）。 */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        if (q && !entry.model.toLowerCase().includes(q)) return false;
        if (vendorFilter.length > 0 && !vendorFilter.includes(vendorOf(entry))) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priced !== b.priced) return a.priced ? 1 : -1;
        return a.model.localeCompare(b.model);
      });
  }, [entries, query, vendorFilter]);

  /** 未配价的模型数（用于顶部提醒）。 */
  const unpriced = useMemo(() => entries.filter((e) => !e.priced), [entries]);

  async function follow(entry: CatalogEntry) {
    if (!entry.follow_target || !action.acquire()) return;
    try {
      const result = await apiRequest<{ inherited_capabilities: boolean }>("/api/admin/models/follow", {
        method: "POST",
        body: { model: entry.model, target: entry.follow_target },
      });
      notify.success(
        `「${entry.model}」已跟随「${entry.follow_target}」`,
        result.inherited_capabilities ? "价格与能力参数都已配置" : "价格已配置（能力参数保留原有配置）",
      );
      await load();
    } catch (err) {
      notify.error("设置跟随失败", err instanceof Error ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  async function unfollow(entry: CatalogEntry) {
    if (!action.acquire()) return;
    try {
      await apiRequest(`/api/admin/models/follow/${encodeURIComponent(entry.model)}`, { method: "DELETE" });
      notify.success(`已解除「${entry.model}」的跟随`);
      await load();
    } catch (err) {
      notify.error("解除跟随失败", err instanceof Error ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  async function bind() {
    if (!binding || !binding.realID || !binding.channelID || !action.acquire()) return;
    try {
      const result = await apiRequest<{ item: { priced: boolean; real_model: string } }>("/api/admin/models/bind", {
        method: "POST",
        // channel_id 必填：绑定是账号级的，没有账号就不知道这个别名属于谁。
        body: { model: binding.model, real_id: binding.realID, channel_id: binding.channelID },
      });
      notify.success(
        `「${binding.model}」已绑定到 ${result.item.real_model}`,
        result.item.priced ? "官方定价与能力参数已一并写入" : "未写入定价（该模型暂无官方核实价格，请手动填写）",
      );
      setBinding(null);
      await load();
    } catch (err) {
      notify.error("绑定失败", err instanceof Error ? err.message : undefined);
    } finally {
      action.release();
    }
  }

  if (loading && entries.length === 0) {
    return <p className={styles.muted}>正在加载模型目录…</p>;
  }
  if (loadError) {
    return <p className={styles.err} role="alert">{loadError}</p>;
  }
  if (entries.length === 0) {
    return <EmptyState
      title="还没有任何模型"
      description="先在账号管理里添加账号并拉取模型列表，模型会自动出现在这里。"
    />;
  }

  /*
    布局：一行一个模型（表格形态），厂商做成筛选 chip 而不是分组折叠。

    原来的手风琴把「一个厂商」占满整行，缩进之后模型名本身就没多少横向空间；
    而这一屏的实际用法是「扫一遍看哪个还没配」—— 需要的是密度，不是层次。
  */
  return (
    <div className={styles.wrap}>
      {unpriced.length > 0 && (
        <section className={styles.alert} role="status">
          <strong>{unpriced.length} 个模型没有定价，调用会按 0 计费（免费）</strong>
          <p>
            这些名字大多是上游自定义的别名，既没有对应定价、也看不出是什么模型。
            请在下面的列表里把它们绑定到真实模型 —— 绑定会一并写入官方定价与能力参数。
            <strong>未绑定的模型无法保存到账号，也无法被调用。</strong>
          </p>
        </section>
      )}

      <div className={styles.toolbar}>
        <SearchField label="搜索模型" value={query} onValueChange={setQuery} placeholder="搜索模型名" />
        <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void load()}>
          <RefreshCw size={13} />刷新
        </Button>
        <span className={styles.muted}>
          {entries.length} 个模型 · {grouped.length} 个厂商 · 已定价 {entries.length - unpriced.length}
        </span>
      </div>

      {/* 厂商筛选：多选，用来把列表收窄到某几家（例如只看 WorkBuddy） */}
      <ChipGroup
        label="按厂商筛选"
        options={grouped.map((g) => ({ value: g.vendor, label: `${vendorLabel(g.vendor)} (${g.list.length})` }))}
        value={vendorFilter}
        onValueChange={setVendorFilter}
        maxVisible={12}
      />

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>模型列表</caption>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col">厂商</th>
              <th scope="col">账号</th>
              <th scope="col">价格（{currency.name}/百万 token）</th>
              <th scope="col">上下文</th>
              <th scope="col" className={styles.actionsHead}>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const isBinding = binding?.model === entry.model;
              return (
                <Fragment key={entry.model}>
                  <tr data-unpriced={!entry.priced || undefined}>
                    <td className={styles.cellModel}>
                      {/* 只取品牌图标：ModelMark 自带模型名文本，再写一遍会重复 */}
                      <VendorMark vendor={vendorOf(entry)} />
                      <span className={styles.modelName}>{entry.model}</span>
                    </td>
                    <td><VendorMark vendor={vendorOf(entry)} label /></td>
                    <td className={styles.cellChannels}>
                      {entry.channels.slice(0, 2).map((channel) => (
                        <span key={channel.id} className={styles.channelChip} data-off={channel.status !== 1 || undefined}>
                          {channel.name}
                        </span>
                      ))}
                      {entry.channels.length > 2 && <span className={styles.muted}>+{entry.channels.length - 2}</span>}
                    </td>
                    <td className={styles.cellPrice}>
                      {entry.priced && entry.price ? (
                        <span className={styles.priceTag}>
                          {entry.price.input_price} / {entry.price.output_price}
                        </span>
                      ) : (
                        <span className={styles.missingTag}>未定价</span>
                      )}
                      {entry.followed && entry.follow_target && (
                        <span className={styles.followTag}>跟随 {entry.follow_target}</span>
                      )}
                    </td>
                    <td className={styles.cellWindow}>
                      {entry.capabilities?.context_window
                        ? `${(entry.capabilities.context_window / 1000).toFixed(0)}k`
                        : <span className={styles.muted}>—</span>}
                    </td>
                    <td className={styles.cellActions}>
                      {!entry.priced && (
                        <Button
                          size="sm"
                          variant={isBinding ? "secondary" : "primary"}
                          disabled={action.busy}
                          onClick={() => {
                            /*
                              打开面板时尽量少让用户点一次：只有一个候选账号
                              （声明支持这个别名的账号）时直接默认选中它。
                              多个账号时必须让用户选 —— 绑错账号等于配错模型。
                            */
                            const channels = entry.channels ?? [];
                            const only = channels.length === 1 ? channels[0].id : 0;
                            setBinding(isBinding ? null : { model: entry.model, channelID: only, realID: "" });
                          }}
                        >
                          <Link2 size={13} />绑定真实模型
                        </Button>
                      )}
                      {entry.followed && (
                        <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void unfollow(entry)}>
                          <Unlink size={13} />解除跟随
                        </Button>
                      )}
                      {entry.follow_target && !entry.followed && (
                        <Button size="sm" variant="secondary" loading={action.busy} onClick={() => void follow(entry)}>
                          跟随 {entry.follow_target}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => onConfigure(entry.model)}>参数</Button>
                    </td>
                  </tr>

                  {/* 绑定面板：选中一行时在同一张表里展开，不跳页 */}
                  {isBinding && (
                    <tr className={styles.bindRow}>
                      <td colSpan={6}>
                        <div className={styles.bindPanel}>
                          <div className={styles.bindHead}>
                            <strong>把「{entry.model}」绑定到真实模型</strong>
                            <span className={styles.muted}>
                              绑定后会写入该模型的官方定价与能力参数（上下文、多模态、推理档位）。
                            </span>
                          </div>
                          <div className={styles.bindControls}>
                            {/*
                              先选账号、再选真实模型。

                              绑定是**账号级**的：同一个 default-model 在
                              WorkBuddy 与别的上游是完全不同的模型，
                              所以必须说清「在哪个账号里绑」。
                              只有一个候选账号时直接默认选中，少点一次。
                            */}
                            <MorphSelect
                              label="所属账号"
                              items={bindableChannels.map((ch) => ({
                                value: String(ch.id),
                                label: ch.name + "（" + vendorLabel(ch.vendor) + "）",
                              }))}
                              value={binding?.channelID ? String(binding.channelID) : ""}
                              onValueChange={(id) =>
                                setBinding((prev) => (prev ? { ...prev, channelID: Number(id) } : prev))}
                              searchable
                              searchPlaceholder="搜索账号"
                              panelWidth={320}
                              align="start"
                              placeholder="选择要绑定的账号"
                            />
                            <MorphSelect
                              label="真实模型"
                              items={realModelGroups}
                              value={binding?.realID ?? ""}
                              onValueChange={(realID) => setBinding((prev) => (prev ? { ...prev, realID } : prev))}
                              searchable
                              searchPlaceholder="搜索模型名或厂商…"
                              panelWidth={420}
                              align="start"
                              placeholder="选择对应的真实模型"
                            />
                            <Button
                              size="sm"
                              loading={action.busy}
                              disabled={!binding?.realID || !binding?.channelID}
                              onClick={() => void bind()}
                            >
                              确认绑定
                            </Button>
                            <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setBinding(null)}>取消</Button>
                          </div>
                          <span className={styles.muted}>
                            列表里的价格是官方美元单价（OD 币与美元 1:1）。标「未核实」的模型不会自动写入价格。
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && <p className={styles.muted}>没有匹配的模型</p>}
    </div>
  );
}
