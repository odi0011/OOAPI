import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import Switch from "@/components/arc/switch/switch";
import AdminLayout from "@/components/admin/AdminLayout";
import { ApiRequestError } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import tokenStyles from "./AdminTokens.module.css";
import styles from "./AdminExchangeKeys.module.css";
import {
  createExchangeKey,
  discardLegacyStrategyDraft,
  exchangeLabel,
  listExchangeKeys,
  networkLabel,
  revealExchangeKey,
  revokeExchangeKey,
  type ExchangeKey,
  type TradingNetwork,
} from "./tradingApi";

/**
 * 用户自绑交易所 API Key。
 *
 * GET 列表只含打码值。明文只经 POST /api/trading/exchange-keys/:id/reveal。
 * 复制口径对齐密钥管理：未点「显示」不能复制，复制时再打一次 reveal，
 * 不复制列表上的打码串。
 *
 * network 为 testnet 或 live。新建不会作废旧 Key，测网和实盘可以同时留着。
 * 不再使用时走 DELETE（与 POST /revoke 相同，只改作废标记）。
 */

interface Draft {
  label: string;
  network: TradingNetwork;
  apiKey: string;
  apiSecret: string;
}

const EMPTY_DRAFT: Draft = { label: "", network: "testnet", apiKey: "", apiSecret: "" };

interface RevealedSecret {
  id: number;
  apiKey: string;
  apiSecret: string;
}

function formatTime(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export default function AdminExchangeKeys() {
  const notify = useNotify();
  const action = useAsyncGuard();

  const [items, setItems] = useState<ExchangeKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [rebuildAck, setRebuildAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  /** 点过「显示」（或创建后成功 reveal）才允许复制。 */
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<number>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    discardLegacyStrategyDraft();
    try {
      setItems(await listExchangeKeys());
    } catch (err) {
      setLoadError(errorText(err, "加载交易所密钥失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function rememberRevealed(id: number) {
    setRevealedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setRebuildAck(false);
    setDialogOpen(true);
  }

  async function create() {
    if (!action.acquire()) return;
    const label = draft.label.trim();
    const apiKey = draft.apiKey.trim();
    const apiSecret = draft.apiSecret.trim();
    if (!label || !apiKey || !apiSecret) {
      notify.error("请填完名称、API Key 和 Secret");
      action.release();
      return;
    }
    if (!rebuildAck) {
      notify.error("请先确认旧 Key 已作废", "重建并关闭提现之后，再勾选确认");
      action.release();
      return;
    }

    setSaving(true);
    try {
      const created = await createExchangeKey({
        label,
        network: draft.network,
        apiKey,
        apiSecret,
      });
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      setRebuildAck(false);
      await load();
      try {
        const plain = await revealExchangeKey(created.id);
        rememberRevealed(created.id);
        setRevealed({ id: created.id, ...plain });
        notify.success("密钥已绑定", "请立即复制，并确认这把密钥已关闭提现权限");
      } catch (err) {
        notify.error("密钥已保存，但没能读出明文", errorText(err, "请在列表里点「显示」"));
      }
    } catch (err) {
      notify.error("绑定失败", errorText(err, "请稍后再试"));
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function reveal(item: ExchangeKey) {
    if (!action.acquire()) return;
    try {
      const plain = await revealExchangeKey(item.id);
      rememberRevealed(item.id);
      setRevealed({ id: item.id, ...plain });
    } catch (err) {
      notify.error("读取密钥失败", errorText(err, "请稍后再试"));
    } finally {
      action.release();
    }
  }

  /**
   * 复制必须先点过「显示」，再打 POST /reveal，把返回的明文写入剪贴板。
   * 列表上的打码串不能复制。
   */
  async function copyField(id: number, field: "apiKey" | "apiSecret") {
    if (!revealedIds.has(id) || !action.acquire()) return;
    try {
      const plain = await revealExchangeKey(id);
      const text = plain[field];
      try {
        await navigator.clipboard.writeText(text);
        notify.success("已复制到剪贴板");
      } catch {
        setRevealed({ id, ...plain });
        notify.error("复制失败", "完整密钥已显示，请手动选中复制");
      }
    } catch (err) {
      notify.error("复制失败", errorText(err, "请稍后再试"));
    } finally {
      action.release();
    }
  }

  async function revoke(item: ExchangeKey) {
    if (item.revoked || !action.acquire()) return;
    try {
      const next = await revokeExchangeKey(item.id);
      setItems((prev) => prev.map((row) => (row.id === item.id ? next : row)));
      if (revealed?.id === item.id) setRevealed(null);
      notify.success(`已作废密钥「${item.label || "未命名"}」`);
    } catch (err) {
      notify.error("作废失败", errorText(err, "请稍后再试"));
    } finally {
      action.release();
    }
  }

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "交易所密钥" }]}
      actions={
        <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy || loading}>
          绑定密钥
        </Button>
      }
    >
      <div className={tokenStyles.page}>
        <header className={tokenStyles.head}>
          <div>
            <h1 className={tokenStyles.title}>交易所密钥</h1>
            <p className={styles.lead}>
              自己绑定币安 USDT 合约的 API Key。测网和实盘可以各留一把，互不覆盖。
            </p>
          </div>
        </header>

        <div className={tokenStyles.notice}>
          <strong>到交易所关掉提现后再绑</strong>
          <p>
            旧 Key 先在交易所侧作废，重新创建一把，并关掉提现权限，只留合约交易需要的权限。
            回到这里自绑时，已有的密钥不会自动作废。不再使用的，在本页长按作废。这里不会代你发起提现。
          </p>
        </div>

        <p className={styles.hint}>
          列表只显示打码。点「显示」才会向服务器读取明文，未显示前不能复制。
        </p>

        {loading ? (
          <p className={tokenStyles.loading}>加载中…</p>
        ) : loadError ? (
          <p className={tokenStyles.err}>
            {loadError}
          </p>
        ) : items.length === 0 ? (
          <div className={tokenStyles.empty}>
            <EmptyState
              title="还没有交易所密钥"
              description="先在交易所作废旧 Key，重建并关闭提现后再绑定。列表保持打码，点显示后才能复制。"
              action={
                <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy}>
                  绑定密钥
                </Button>
              }
            />
          </div>
        ) : (
          <div className={tokenStyles.list}>
            {items.map((item) => {
              const revealedThis = revealedIds.has(item.id);
              return (
                <article key={item.id} className={tokenStyles.item}>
                  <div className={tokenStyles.itemMain}>
                    <div className={tokenStyles.itemHead}>
                      <strong className={tokenStyles.itemName}>{item.label || "未命名"}</strong>
                      <span className={tokenStyles.groupTag}>{exchangeLabel(item.exchange)}</span>
                      <span className={item.network === "live" ? tokenStyles.groupTag : tokenStyles.unlimitedTag}>
                        {networkLabel(item.network)}
                      </span>
                      {item.revoked && <span className={tokenStyles.offTag}>已作废</span>}
                    </div>

                    <SecretRow
                      label="API Key"
                      masked={item.apiKeyMasked || "••••••••"}
                      revealed={revealedThis}
                      busy={action.busy || loading}
                      onReveal={() => void reveal(item)}
                      onCopy={() => void copyField(item.id, "apiKey")}
                    />
                    <SecretRow
                      label="Secret"
                      masked={item.apiSecretMasked || "••••••••"}
                      revealed={revealedThis}
                      busy={action.busy || loading}
                      onReveal={() => void reveal(item)}
                      onCopy={() => void copyField(item.id, "apiSecret")}
                    />

                    <dl className={tokenStyles.meta}>
                      <div>
                        <dt>网络</dt>
                        <dd>{networkLabel(item.network)}</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{formatTime(item.createdAt)}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className={tokenStyles.itemActions}>
                    <HoldToConfirm
                      label="长按作废"
                      confirmedLabel="已作废"
                      tone="danger"
                      duration={1200}
                      disabled={action.busy || item.revoked}
                      confirmed={item.revoked}
                      onConfirm={() => void revoke(item)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(next) => { if (!action.busy) setDialogOpen(next); }}>
        <DialogContent
          title="绑定交易所密钥"
          description="旧 Key 先在交易所侧作废。重建一把、关掉提现，再填到这里。已有的密钥不会被这次绑定覆盖。"
        >
          <div className={tokenStyles.form} inert={action.busy}>
            <Input
              label="名称"
              placeholder="例如：币安合约主号"
              value={draft.label}
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <div className={styles.networkRow}>
              <span className={styles.networkLabel}>网络</span>
              <SegmentedControl
                label="密钥网络"
                value={draft.network}
                onValueChange={(network) => {
                  if (network === "testnet" || network === "live") setDraft({ ...draft, network });
                }}
                options={[
                  { value: "testnet", label: "测网" },
                  { value: "live", label: "实盘" },
                ]}
              />
              <p className={styles.networkHint}>测网和实盘分开保存，可以同时留着。策略环境跟这把密钥不一致时会提示，仍可保存。</p>
            </div>
            <PasswordField
              label="API Key"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              description="列表里打码。未点「显示」前不能复制。"
            />
            <PasswordField
              label="API Secret"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiSecret}
              onChange={(e) => setDraft({ ...draft, apiSecret: e.target.value })}
              description="请确认这把密钥没有提现权限。"
            />
            <div className={tokenStyles.switchRow}>
              <Switch
                label="这是重建后的新 Key，且已关闭提现"
                checked={rebuildAck}
                onCheckedChange={setRebuildAck}
              />
            </div>
          </div>
          <div className={`${tokenStyles.dialogActions} ${styles.dialogActions}`}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={action.busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} disabled={action.busy || !rebuildAck} onClick={() => void create()}>
              创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent
          title="请立即复制密钥"
          description="完整内容来自一次 reveal。列表保持打码，未显示前不能复制。复制会再向服务器读取明文。"
        >
          {revealed && (
            <>
              <div className={styles.secretBlock}>
                <span className={styles.secretLabel}>API Key</span>
                <code className={tokenStyles.revealedKey}>{revealed.apiKey}</code>
              </div>
              <div className={styles.secretBlock}>
                <span className={styles.secretLabel}>API Secret</span>
                <code className={tokenStyles.revealedKey}>{revealed.apiSecret}</code>
              </div>
              <div className={`${tokenStyles.dialogActions} ${styles.dialogActions}`}>
                <Button variant="secondary" size="sm" disabled={action.busy} onClick={() => void copyField(revealed.id, "apiKey")}>
                  复制 API Key
                </Button>
                <Button variant="secondary" size="sm" disabled={action.busy} onClick={() => void copyField(revealed.id, "apiSecret")}>
                  复制 Secret
                </Button>
                <Button variant="primary" size="sm" onClick={() => setRevealed(null)}>
                  我已保存
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

function SecretRow({
  label,
  masked,
  revealed,
  busy,
  onReveal,
  onCopy,
}: {
  label: string;
  masked: string;
  revealed: boolean;
  busy: boolean;
  onReveal: () => void;
  onCopy: () => void;
}) {
  return (
    <div className={tokenStyles.keyRow}>
      <span className={styles.fieldLabel}>{label}</span>
      <code className={tokenStyles.key} onCopy={(event) => event.preventDefault()}>{masked}</code>
      <button type="button" className={tokenStyles.miniBtn} onClick={onReveal} disabled={busy}>
        显示
      </button>
      <button
        type="button"
        className={`${tokenStyles.miniBtn} ${styles.copyBtn}`}
        disabled={!revealed || busy}
        aria-label={revealed ? `复制完整${label}` : `请先显示完整${label}后再复制`}
        title={revealed ? `复制完整${label}` : "请先显示完整密钥"}
        onClick={onCopy}
      >
        复制
      </button>
    </div>
  );
}
