import { useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import Switch from "@/components/arc/switch/switch";
import AdminLayout from "@/components/admin/AdminLayout";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import { bindExchangeKey, removeExchangeKey, useExchangeKeys, type ExchangeKey } from "./exchangeKeyStore";
import tokenStyles from "./AdminTokens.module.css";
import styles from "./AdminExchangeKeys.module.css";

/**
 * 用户自绑交易所 API Key。
 *
 * 列表打码、reveal 后才能复制，口径对齐密钥管理：
 * 未显示完整内容时，复制按钮不可用，也不复制打码串。
 *
 * 再绑一把时，本会话里的旧 Key 全部作废。
 * 交易所侧要先作废旧 Key、重建并关掉提现，再回到这里自绑。
 */

interface Draft {
  name: string;
  apiKey: string;
  apiSecret: string;
}

const EMPTY_DRAFT: Draft = { name: "", apiKey: "", apiSecret: "" };

function maskSecret(value: string): string {
  const text = value.trim();
  if (text.length <= 8) return "••••••••";
  return `${text.slice(0, 4)}••••••••${text.slice(-4)}`;
}

function formatTime(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

export default function AdminExchangeKeys() {
  const notify = useNotify();
  const action = useAsyncGuard();

  const items = useExchangeKeys();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [rebuildAck, setRebuildAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<ExchangeKey | null>(null);
  /** 点过列表上的「显示」之后，才允许从列表复制完整密钥。 */
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Record<string, boolean>>({});

  /** 打开完整密钥。列表上的复制要等用户点过「显示」才放开。 */
  function reveal(item: ExchangeKey) {
    setRevealed(item);
    setRevealedIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  }

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setRebuildAck(false);
    setDialogOpen(true);
  }

  function create() {
    if (!action.acquire()) return;
    const name = draft.name.trim();
    const apiKey = draft.apiKey.trim();
    const apiSecret = draft.apiSecret.trim();
    if (!name || !apiKey || !apiSecret) {
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
      const hadPrevious = items.some((row) => !row.revoked);
      const item = bindExchangeKey({
        name,
        exchange: "binance",
        apiKey,
        apiSecret,
      });
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      setRebuildAck(false);
      // 创建弹窗本身就是那一次完整展示，弹窗里可以复制。
      // 列表仍打码，复制按钮要等用户再点「显示」才放开。
      setRevealed(item);
      notify.success(
        hadPrevious ? "新密钥已绑定，旧 Key 已作废" : "密钥已绑定",
        "请立即复制，并确认这把密钥已关闭提现权限",
      );
    } finally {
      setSaving(false);
      action.release();
    }
  }

  function remove(item: ExchangeKey) {
    if (deletedIds[item.id] || !action.acquire()) return;
    setDeletedIds((prev) => ({ ...prev, [item.id]: true }));
    removeExchangeKey(item.id);
    setRevealedIds((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    if (revealed?.id === item.id) setRevealed(null);
    notify.success(`已删除密钥「${item.name}」`);
    action.release();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify.success("已复制到剪贴板");
    } catch {
      notify.error("复制失败，请手动选中复制");
    }
  }

  function copyField(item: ExchangeKey, field: "apiKey" | "apiSecret") {
    if (!revealedIds.has(item.id)) {
      notify.error("请先显示完整密钥", "未显示前不能复制");
      return;
    }
    void copy(item[field]);
  }

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "交易所密钥" }]}
      actions={
        <Button variant="primary" size="sm" onClick={openCreate} disabled={action.busy}>
          绑定密钥
        </Button>
      }
    >
      <div className={tokenStyles.page}>
        <header className={tokenStyles.head}>
          <div>
            <h1 className={tokenStyles.title}>交易所密钥</h1>
            <p className={styles.lead}>
              自己绑定币安 USDT 合约的 API Key。旧 Key 先作废，重建并关掉提现之后再自绑。
            </p>
          </div>
        </header>

        <div className={tokenStyles.notice}>
          <strong>旧 Key 作废后再绑</strong>
          <p>
            到交易所把旧 Key 作废，重新创建一把，并关掉提现权限，只留合约交易需要的权限。
            然后再回到这里自绑。本页再绑一把时，之前的 Key 也会标成已作废。这里不会代你发起提现。
          </p>
        </div>

        <p className={styles.sessionNote}>
          接口尚未接通，密钥只留在当前会话里，刷新后会消失。列表始终打码，未显示前不能复制。
        </p>

        {items.length === 0 ? (
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
                      <strong className={tokenStyles.itemName}>{item.name}</strong>
                      <span className={tokenStyles.groupTag}>币安</span>
                      <span className={tokenStyles.unlimitedTag}>USDT 合约</span>
                      {item.revoked && <span className={tokenStyles.offTag}>已作废</span>}
                    </div>

                    <SecretRow
                      label="API Key"
                      masked={maskSecret(item.apiKey)}
                      revealed={revealedThis}
                      busy={action.busy}
                      onReveal={() => reveal(item)}
                      onCopy={() => copyField(item, "apiKey")}
                    />
                    <SecretRow
                      label="Secret"
                      masked={maskSecret(item.apiSecret)}
                      revealed={revealedThis}
                      busy={action.busy}
                      onReveal={() => reveal(item)}
                      onCopy={() => copyField(item, "apiSecret")}
                    />

                    <dl className={tokenStyles.meta}>
                      <div>
                        <dt>交易所</dt>
                        <dd>币安</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{formatTime(item.createdAt)}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className={tokenStyles.itemActions}>
                    <HoldToConfirm
                      key={String(action.busy)}
                      label="长按删除"
                      confirmedLabel="已删除"
                      tone="danger"
                      duration={1200}
                      disabled={action.busy}
                      confirmed={deletedIds[item.id] ?? false}
                      onConfirm={() => remove(item)}
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
          description="旧 Key 先作废。重建一把、关掉提现，再填到这里。再绑时，本页已有的 Key 也会作废。"
        >
          <div className={tokenStyles.form} inert={action.busy}>
            <Input
              label="名称"
              placeholder="例如：币安合约主号"
              value={draft.name}
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
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
            <Button variant="primary" size="sm" loading={saving} disabled={action.busy || !rebuildAck} onClick={create}>
              创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent
          title="请立即复制密钥"
          description="完整内容只在显示后出现。请确认交易所侧已关闭提现权限。列表保持打码，未显示前不能复制。"
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
                <Button variant="secondary" size="sm" onClick={() => void copy(revealed.apiKey)}>
                  复制 API Key
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void copy(revealed.apiSecret)}>
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
      <code className={tokenStyles.key}>{masked}</code>
      <button type="button" className={tokenStyles.miniBtn} onClick={onReveal} disabled={busy}>
        显示
      </button>
      <button
        type="button"
        className={`${tokenStyles.miniBtn} ${styles.copyBtn}`}
        disabled={!revealed || busy}
        title={revealed ? `复制完整${label}` : "请先显示完整密钥"}
        onClick={onCopy}
      >
        复制
      </button>
    </div>
  );
}
