import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge, type BadgeTone } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { NumberField } from "@/components/arc/number-field/number-field";
import { Select } from "@/components/arc/select/select";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";
import { useNotify } from "@/lib/useNotify";

import {
  GRID_SYMBOL_PRESETS,
  formatPct,
  formatPrice,
  formatQty,
  formatUsdt,
  gridReasonLabel,
  gridStateLabel,
  lineStateLabel,
} from "./gridView";
import {
  createGrid,
  deleteGrid,
  getGrid,
  listGrids,
  previewGrid,
  startGrid,
  stopGrid,
  updateGrid,
  type Grid,
  type GridLineView,
  type GridPreviewResponse,
  type GridWrite,
} from "./gridApi";
import { listExchangeKeys, networkLabel, type ExchangeKey, type TradingNetwork } from "./tradingApi";

import styles from "./TradingGrid.module.css";

/**
 * 现货网格。
 *
 * 这个页面要回答的核心问题不是"怎么填参数"，而是
 * **"我这个账户到底能不能跑、要多少钱"**。
 *
 * 所以参数区旁边**始终**有一块实时预览：它显示每格间距、毛收益、
 * 双边手续费、步长零头、有效收益，以及两个档位的资金门槛。
 *
 * 「步长零头」是最反直觉、也最值钱的一行 —— 币安现货的数量必须是
 * 步长的整数倍，而买入到账量不是（手续费以基础币扣），于是每完成
 * 一次往返就有不到一个步长的货卖不出去。在 DOGE 上（步长 1、价 0.08）
 * 这一项高达每格名义的 7%，是双边手续费的三十多倍。不显示它，
 * 用户会照着一个"每格赚 2.3%"的界面把钱投进去，然后发现是净亏。
 */

interface Draft {
  symbol: string;
  lower: number;
  upper: number;
  levels: number;
  quoteBudget: number;
  stopPctPct: number;
  exchangeKeyId: number | null;
  mode: TradingNetwork;
}

const DEFAULT_DRAFT: Draft = {
  symbol: "DOGEUSDT",
  lower: 0.075,
  upper: 0.085,
  levels: 8,
  quoteBudget: 50,
  stopPctPct: 2,
  exchangeKeyId: null,
  mode: "testnet",
};

export default function TradingGrid() {
  const notify = useNotify();

  const [grids, setGrids] = useState<Grid[]>([]);
  const [keys, setKeys] = useState<ExchangeKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Grid | null>(null);
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [preview, setPreview] = useState<GridPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Grid | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [items, exchangeKeys] = await Promise.all([listGrids(), listExchangeKeys()]);
      setGrids(items);
      setKeys(exchangeKeys.filter((k) => !k.revoked));
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "读取网格失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 运行中的网格靠轮询刷新 —— 成交发生在两次推进之间，
  // 不刷新的话界面上永远是刚打开时的那一份状态。
  useEffect(() => {
    if (!grids.some((g) => g.running)) return;
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [grids, refresh]);

  const openCreate = () => {
    const activeKey = keys[0] ?? null;
    setEditing(null);
    setDraft({
      ...DEFAULT_DRAFT,
      exchangeKeyId: activeKey?.id ?? null,
      mode: (activeKey?.network as TradingNetwork) ?? "testnet",
    });
    setPreview(null);
    setEditorOpen(true);
  };

  const openEdit = (grid: Grid) => {
    setEditing(grid);
    setDraft({
      symbol: grid.symbol,
      lower: grid.lower,
      upper: grid.upper,
      levels: grid.levels,
      quoteBudget: grid.quoteBudget,
      stopPctPct: Number((grid.stopPct * 100).toFixed(4)),
      exchangeKeyId: grid.exchangeKeyId,
      mode: grid.mode,
    });
    setPreview(null);
    setEditorOpen(true);
  };

  /*
   * 预览是防抖的：用户拖数字框时每一帧都会改 draft，而这个接口背后
   * 是一次真实的交易所请求（读交易对规则和现价）。不防抖会把请求权重
   * 打光，而币安的权重封禁是按 IP 算的 —— 一次拖拽能把整个站点封掉。
   */
  const previewTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!editorOpen) return;
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      setPreviewing(true);
      previewGrid({
        symbol: draft.symbol,
        lower: draft.lower,
        upper: draft.upper,
        levels: draft.levels,
        quoteBudget: draft.quoteBudget,
        stopPct: draft.stopPctPct / 100,
        exchangeKeyId: draft.exchangeKeyId ?? undefined,
        mode: draft.mode,
      })
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 400);
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, [editorOpen, draft]);

  const save = async () => {
    if (draft.exchangeKeyId == null) {
      notify.error("缺少交易所密钥", "请先在「账户」里绑定一把币安密钥");
      return;
    }
    const body: GridWrite = {
      symbol: draft.symbol.trim().toUpperCase(),
      lower: draft.lower,
      upper: draft.upper,
      levels: Math.round(draft.levels),
      quoteBudget: draft.quoteBudget,
      stopPct: draft.stopPctPct / 100,
      exchangeKeyId: draft.exchangeKeyId,
      mode: draft.mode,
    };
    setSaving(true);
    try {
      if (editing) {
        await updateGrid(editing.id, body);
        notify.success("已保存", "改动在下次启动时生效");
      } else {
        await createGrid(body);
        notify.success("已创建", "确认参数无误后再点「开始」");
      }
      setEditorOpen(false);
      await refresh();
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : "请稍后再试");
    } finally {
      setSaving(false);
    }
  };

  const toggleRun = async (grid: Grid) => {
    setBusyId(grid.id);
    try {
      if (grid.running) {
        await stopGrid(grid.id);
        notify.success("已停止", "挂单已撤、持仓已市价卖出");
      } else {
        await startGrid(grid.id);
        notify.success("已启动", "网格会立刻按当前价挂出买单");
      }
      await refresh();
    } catch (err) {
      notify.error(
        grid.running ? "停止失败" : "启动失败",
        err instanceof ApiRequestError ? err.message : "请稍后再试",
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (grid: Grid) => {
    setBusyId(grid.id);
    try {
      await deleteGrid(grid.id);
      notify.success("已删除");
      await refresh();
    } catch (err) {
      notify.error("删除失败", err instanceof ApiRequestError ? err.message : "请先停止它");
    } finally {
      setBusyId(null);
    }
  };

  const showDetail = async (grid: Grid) => {
    try {
      setDetail(await getGrid(grid.id));
    } catch {
      notify.error("读取明细失败");
    }
  };

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "交易" }, { label: "网格" }]}>
      <div className={styles.page}>
        <header className={styles.head}>
          <div>
            <h1 className={styles.title}>现货网格</h1>
            <p className={styles.lead}>
              网格在一个价格区间里挂一串限价单：跌一格买、涨一格卖，靠来回震荡赚价差。
              它赚的是波动而不是方向 —— 所以单边下跌时会跌破区间，止损离场。
            </p>
          </div>
          <Button variant="primary" onClick={openCreate}>
            新建网格
          </Button>
        </header>

        {loading ? (
          <p className={styles.muted}>正在读取…</p>
        ) : loadError ? (
          <EmptyState title="读取失败" description={loadError} />
        ) : grids.length === 0 ? (
          <EmptyState
            title="还没有网格"
            description="新建一条之后，页面会先算出它需要多少钱、每格能赚多少，确认了再启动。"
          />
        ) : (
          <div className={styles.cards}>
            {grids.map((grid) => (
              <GridCard
                key={grid.id}
                grid={grid}
                busy={busyId === grid.id}
                onToggle={() => void toggleRun(grid)}
                onEdit={() => openEdit(grid)}
                onDelete={() => void remove(grid)}
                onDetail={() => void showDetail(grid)}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent
          title={editing ? "修改网格" : "新建网格"}
          description="左列填参数，右列实时算出它能不能跑、要多少钱。确认了再保存。"
        >
          <div className={styles.editor}>
            <div className={styles.form}>
              <div className={styles.field}>
                <Input
                  label="交易对"
                  hideLabel
                  id="grid-symbol"
                  value={draft.symbol}
                  list="grid-symbol-presets"
                  placeholder="DOGEUSDT"
                  onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                />
                <datalist id="grid-symbol-presets">
                  {GRID_SYMBOL_PRESETS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <p className={styles.hint}>
                  只支持 USDT 现货对。步长越细的币越适合小资金 —— DOGE 每格要几美元的货才划得来，
                  SHIB、PEPE 这类只要一美元。
                </p>
              </div>

              <div className={styles.pair}>
                <NumberField
                  label="区间下沿"
                  value={draft.lower}
                  onValueChange={(v) => setDraft((d) => ({ ...d, lower: v }))}
                  min={0}
                  step={0.0001}
                  formatOptions={{ maximumFractionDigits: 8 }}
                />
                <NumberField
                  label="区间上沿"
                  value={draft.upper}
                  onValueChange={(v) => setDraft((d) => ({ ...d, upper: v }))}
                  min={0}
                  step={0.0001}
                  formatOptions={{ maximumFractionDigits: 8 }}
                />
              </div>

              <NumberField
                label="网格线数量"
                description="线越多每格越窄。太窄的话手续费会吃掉全部收益。"
                value={draft.levels}
                onValueChange={(v) => setDraft((d) => ({ ...d, levels: Math.round(v) }))}
                min={3}
                max={200}
                step={1}
              />

              <NumberField
                label="投入金额"
                suffix="USDT"
                description="最坏情况（每条网格线上都持有一格）的占用上限。"
                value={draft.quoteBudget}
                onValueChange={(v) => setDraft((d) => ({ ...d, quoteBudget: v }))}
                min={1}
                step={1}
              />

              <NumberField
                label="止损距离"
                suffix="%"
                description="跌破下沿之后再跌这么多就清仓停机。"
                value={draft.stopPctPct}
                onValueChange={(v) => setDraft((d) => ({ ...d, stopPctPct: v }))}
                min={0.1}
                max={50}
                step={0.5}
              />

              <div className={styles.field}>
                <Select
                  label="交易所密钥"
                  hideLabel
                  value={draft.exchangeKeyId ? String(draft.exchangeKeyId) : ""}
                  onValueChange={(v) => setDraft((d) => ({ ...d, exchangeKeyId: Number(v) }))}
                  options={keys.map((k) => ({
                    value: String(k.id),
                    label: `${k.label || `密钥 #${k.id}`} · ${networkLabel(k.network)}`,
                  }))}
                  placeholder="请选择"
                />
              </div>

              <div className={styles.field}>
                <Select
                  label="环境"
                  hideLabel
                  value={draft.mode}
                  onValueChange={(v) => setDraft((d) => ({ ...d, mode: v as TradingNetwork }))}
                  options={[
                    { value: "testnet", label: "测网" },
                    { value: "live", label: "实盘（真钱）" },
                  ]}
                />
              </div>

              <div className={styles.actions}>
                <Button variant="ghost" onClick={() => setEditorOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  loading={saving}
                  disabled={preview?.ok === false}
                >
                  {editing ? "保存" : "创建"}
                </Button>
              </div>
            </div>

            <PreviewPanel preview={preview} pending={previewing} budget={draft.quoteBudget} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent
          title={detail ? `${detail.symbol} 明细` : "明细"}
          description="逐笔成交来自交易所的 myTrades，手续费是真实值，不是按费率估的。"
        >
          {detail && <GridDetail grid={detail} />}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

/* ------------------------------------------------------------------ */
/* 预览面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 实时预览。
 *
 * 收益拆成四段显示，顺序就是钱的去向：
 *   间距 → 减双边手续费 → 减步长零头 → 有效收益
 *
 * 最后一段才是"落到口袋里多少"。只显示毛收益或"扣手续费后收益"，
 * 用户会照着一个不存在的数字做决定。
 */
function PreviewPanel({
  preview,
  pending,
  budget,
}: {
  preview: GridPreviewResponse | null;
  pending: boolean;
  budget: number;
}) {
  if (!preview) {
    return (
      <aside className={styles.preview}>
        <p className={styles.muted}>
          {pending ? "正在计算…" : "填好参数后这里会显示能不能跑、要多少钱。"}
        </p>
      </aside>
    );
  }
  const need = preview.requirement;
  const plan = preview.plan;

  return (
    <aside className={styles.preview}>
      <h3 className={styles.previewTitle}>这份网格</h3>

      <div className={styles.previewMeta}>
        <span>现价 {formatPrice(preview.lastPrice)}</span>
        <span>单边手续费 {formatPct(preview.feeRate)}</span>
        <span>
          数量步长 {preview.stepSize} · 价格精度 {preview.tickSize}
        </span>
      </div>

      {!preview.ok && (
        <div className={styles.blocker}>
          <strong>跑不起来</strong>
          <p>{preview.message}</p>
          {preview.reason === "grid_step_too_coarse" && (
            <p className={styles.blockerHint}>
              这一条不是手续费的问题，是<b>价格精度</b>的问题：币安现货的数量必须是步长的整数倍，
              而买入的手续费以基础币收取、到账量不是整数倍 —— 卖单只能少挂一点，
              剩下的零头卖不出去。换一个步长更细的交易对（SHIB、PEPE、BONK 这类），
              门槛会低两个数量级。
            </p>
          )}
        </div>
      )}

      {plan && (
        <>
          <div className={styles.breakdown}>
            <Row label="每格间距" value={formatPct(plan.spacingPct)} />
            <Row
              label="减 双边手续费"
              value={`− ${formatPct(plan.spacingPct - plan.netProfitPct)}`}
              negative
            />
            <Row label="减 步长零头" value={`− ${formatPct(plan.stepDustPct)}`} negative />
            <Row
              label="有效收益"
              value={formatPct(plan.effectiveNetPct)}
              emphasis
              tone={plan.effectiveNetPct > 0 ? "good" : "bad"}
            />
          </div>

          <dl className={styles.facts}>
            <Fact label="每格数量" value={`${formatQty(plan.qtyPerLevel)} ${preview.baseAsset}`} />
            <Fact label="每格名义" value={`${formatUsdt(plan.notionalPerLevel)} USDT`} />
            <Fact label="每格往返净赚" value={`${formatUsdt(plan.effectiveNetPerLevel, 4)} USDT`} />
            <Fact label="最坏占用" value={`${formatUsdt(plan.quoteNeeded)} USDT`} />
            <Fact label="止损价" value={formatPrice(plan.stopPrice)} />
            <Fact
              label="止损时最坏亏损"
              value={`${formatUsdt(plan.worstLossUsdt)} USDT`}
              tone="bad"
            />
          </dl>
        </>
      )}

      {need && (
        <div className={styles.requirement}>
          <h4 className={styles.requirementTitle}>资金门槛</h4>
          <div className={styles.gates}>
            <Gate
              label="刚刚能跑"
              amount={need.minBudget}
              budget={budget}
              note={`每格 ${formatUsdt(need.perLevelNotionalMin)} USDT · 有效收益 ${formatPct(
                need.effectivePctAtMin,
              )}`}
            />
            <Gate
              label="跑得舒服"
              amount={need.comfortableBudget}
              budget={budget}
              note={`每格 ${formatUsdt(need.perLevelNotionalOk)} USDT · 零头不到收益的一成`}
            />
          </div>
          <p className={styles.gateNote}>
            门槛是被
            <b>{need.limitedBy === "dust" ? "价格精度" : "交易所最小名义"}</b>
            顶起来的。
            {need.limitedBy === "dust"
              ? "换一个步长更细的交易对，门槛会立刻降下来。"
              : "加钱或者减少网格线都可以。"}
          </p>
        </div>
      )}
    </aside>
  );
}

function Row({
  label,
  value,
  negative,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasis?: boolean;
  tone?: "good" | "bad";
}) {
  const cls = [
    styles.rowValue,
    negative ? styles.rowNegative : "",
    emphasis ? styles.rowEmphasis : "",
    tone === "good" ? styles.good : "",
    tone === "bad" ? styles.bad : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const cls = tone === "bad" ? styles.bad : tone === "good" ? styles.good : undefined;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd className={cls}>{value}</dd>
    </div>
  );
}

function Gate({
  label,
  amount,
  budget,
  note,
}: {
  label: string;
  amount: number;
  budget: number;
  note: string;
}) {
  const enough = budget + 1e-9 >= amount;
  return (
    <div className={`${styles.gate} ${enough ? styles.gateOk : styles.gateShort}`}>
      <span className={styles.gateLabel}>{label}</span>
      <span className={styles.gateAmount}>{formatUsdt(amount)} USDT</span>
      <span className={styles.gateNote}>{note}</span>
      <span className={styles.gateFlag}>
        {enough ? "当前投入够" : `还差 ${formatUsdt(amount - budget)} USDT`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 列表卡片                                                            */
/* ------------------------------------------------------------------ */

function GridCard({
  grid,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onDetail,
}: {
  grid: Grid;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDetail: () => void;
}) {
  const snap = grid.snapshot;
  const stateLabel = gridStateLabel(snap?.state, grid.running);
  const reason = gridReasonLabel(snap?.lastReason, snap?.state);
  const tone: BadgeTone = snap?.state === "Error" ? "danger" : grid.running ? "success" : "neutral";

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle}>{grid.symbol}</h3>
          <p className={styles.cardSub}>
            {formatPrice(grid.lower)} – {formatPrice(grid.upper)} · {grid.levels} 条线 ·{" "}
            {networkLabel(grid.mode)}
          </p>
        </div>
        <Badge tone={tone}>{stateLabel}</Badge>
      </div>

      {snap ? (
        <>
          <div className={styles.stats}>
            <Stat label="往返" value={String(snap.roundTrips)} />
            <Stat
              label="已实现"
              value={formatUsdt(snap.realizedUsdt, 4)}
              tone={snap.realizedUsdt >= 0 ? "good" : "bad"}
            />
            <Stat
              label="持仓浮盈"
              value={formatUsdt(snap.unrealizedUsdt, 4)}
              tone={snap.unrealizedUsdt >= 0 ? "good" : "bad"}
            />
            <Stat label="挂单" value={String(snap.resting.length)} />
          </div>
          <GridLadder lines={snap.lines} />
          <p className={styles.footnote}>
            现价 {formatPrice(snap.lastPrice ?? 0)} · 持仓 {formatQty(snap.inventoryQty)} 个
            {snap.dustQty > 0 && ` · 零头 ${formatQty(snap.dustQty)} 个（小于步长，卖不出）`}
            {snap.placeFailed > 0 && ` · 这一拍有 ${snap.placeFailed} 格穿价跳过`}
          </p>
        </>
      ) : (
        <p className={styles.muted}>
          {grid.running ? "等待调度器推进…" : "未运行。启动后会立刻按当前价挂出买单。"}
        </p>
      )}

      {reason && <p className={styles.reason}>{reason}</p>}
      {snap?.lastError && <p className={styles.error}>{snap.lastError}</p>}
      {grid.warnings.map((w) => (
        <p key={w} className={styles.warning}>
          {w}
        </p>
      ))}

      <div className={styles.cardActions}>
        <Button
          size="sm"
          variant={grid.running ? "danger" : "primary"}
          loading={busy}
          onClick={onToggle}
        >
          {grid.running ? "停止并清仓" : "开始"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDetail}>
          明细
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={grid.running}>
          修改
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={grid.running}>
          删除
        </Button>
      </div>
    </div>
  );
}

/**
 * 网格阶梯图。
 *
 * 每一格一个方块，颜色表示它此刻的身份：挂着买单 / 挂着卖单 /
 * 已买到等卖 / 空着。这是网格唯一一个"一眼看懂它在干什么"的视图 ——
 * 表格看不出来，而这些方块排在一起就是一条价格轴（从左到右由低到高）。
 */
function GridLadder({ lines }: { lines: GridLineView[] }) {
  return (
    <div className={styles.ladder} role="img" aria-label="网格各条线的挂单状态，由低到高">
      {lines.map((line) => {
        const stateCls = styles[`rung_${line.state}` as keyof typeof styles] as string | undefined;
        return (
          <span
            key={line.index}
            className={[styles.rung, stateCls ?? ""].filter(Boolean).join(" ")}
            title={`${formatPrice(line.price)} · ${lineStateLabel(line.state)}`}
          >
            {line.side === "BUY" ? "买" : line.side === "SELL" ? "卖" : ""}
          </span>
        );
      })}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const cls = tone === "bad" ? styles.bad : tone === "good" ? styles.good : "";
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${cls}`}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 明细                                                                */
/* ------------------------------------------------------------------ */

function GridDetail({ grid }: { grid: Grid }) {
  const fills = grid.fills ?? [];
  const holdings = useMemo(
    () =>
      Object.entries(grid.holdings ?? {})
        .map(([level, qty]) => [Number(level), qty] as const)
        .sort((a, b) => a[0] - b[0]),
    [grid.holdings],
  );

  return (
    <div className={styles.detail}>
      <p className={styles.muted}>
        区间 {formatPrice(grid.lower)} – {formatPrice(grid.upper)} · 已实现{" "}
        {formatUsdt(grid.realizedUsdt ?? 0, 4)} USDT
      </p>

      {holdings.length > 0 && (
        <section className={styles.detailSection}>
          <h3 className={styles.detailTitle}>各格持仓</h3>
          <ul className={styles.holdingList}>
            {holdings.map(([level, qty]) => (
              <li key={level}>
                第 {level} 条线：{formatQty(qty)} 个
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.detailSection}>
        <h3 className={styles.detailTitle}>成交明细</h3>
        {fills.length === 0 ? (
          <p className={styles.muted}>还没有成交。</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>格</th>
                  <th>方向</th>
                  <th>价格</th>
                  <th>数量</th>
                  <th>手续费</th>
                  <th>已实现</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={f.id ?? i}>
                    <td>{new Date(f.filledAt).toLocaleString()}</td>
                    <td>{f.level < 0 ? "清仓" : f.level}</td>
                    <td>{f.side === "BUY" ? "买" : "卖"}</td>
                    <td>{formatPrice(f.price)}</td>
                    <td>{formatQty(f.qty)}</td>
                    <td>{formatUsdt(f.feeQuote, 6)}</td>
                    <td className={f.realizedUsdt >= 0 ? styles.good : styles.bad}>
                      {formatUsdt(f.realizedUsdt, 6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
