import { useState } from "react";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import AdminLayout from "@/components/admin/AdminLayout";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import tokenStyles from "./AdminTokens.module.css";
import styles from "./AdminExchangeKeys.module.css";

/**
 * 用户自绑交易所 API Key。
 *
 * 列表打码、reveal 后才能复制，口径对齐密钥管理：
 * 未显示完整内容时，复制按钮不可用，也不复制打码串。
 *
 * TODO(trading): 后端还没有交易所密钥字段。
 * 数据只留在当前会话的内存里，不写 localStorage，不打计费或跨域接口。
 * 接通后改为 /api/trading/exchange-keys，reveal 走单独接口。
 */

interface ExchangeKey {
  id: string;
  name: string;
  exchange: "binance";
  apiKey: string;
  apiSecret: string;
  createdAt: string;
}

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

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

export default function AdminExchangeKeys() {
  const notify = useNotify();
  const action = useAsyncGuard();

  const [items, setItems] = useState<ExchangeKey[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
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

    setSaving(true);
    try {
      const item: ExchangeKey = {
        id: newId(),
        name,
        exchange: "binance",
        apiKey,
        apiSecret,
        createdAt: new Date().toISOString(),
      };
      setItems((prev) => [item, ...prev]);
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      // 创建弹窗本身就是那一次完整展示，弹窗里可以复制。
      // 列表仍打码，复制按钮要等用户再点「显示」才放开。
      setRevealed(item);
      notify.success("密钥已创建", "请立即复制，并确认交易所已关闭提现权限");
    } finally {
      setSaving(false);
      action.release();
    }
  }

  function remove(item: ExchangeKey) {
    if (deletedIds[item.id] || !action.acquire()) return;
    setDeletedIds((prev) => ({ ...prev, [item.id]: true }));
    setItems((prev) => prev.filter((row) => row.id !== item.id));
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
              自己绑定币安 USDT 合约的 API Key。请先在交易所关掉提现权限，只留合约交易需要的权限。
            </p>
          </div>
        </header>

        <div className={tokenStyles.notice}>
          <strong>关闭提现权限</strong>
          <p>
            密钥若带提现权限，泄露后可以直接转走资金。创建前到交易所把提现关掉。
            本页只做绑定壳，不会代你发起提现。
          </p>
        </div>

        <p className={styles.sessionNote}>
          接口尚未接通，密钥只留在当前会话里，刷新后会消失。列表始终打码，未显示前不能复制。
        </p>

        {items.length === 0 ? (
          <div className={tokenStyles.empty}>
            <EmptyState
              title="还没有交易所密钥"
              description="绑定一把已关闭提现权限的币安 API Key。列表保持打码，点显示后才能复制。"
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
          description="首发只绑定币安 USDT 合约。创建前请到交易所关闭提现权限。"
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
          </div>
          <div className={`${tokenStyles.dialogActions} ${styles.dialogActions}`}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={action.busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} disabled={action.busy} onClick={create}>
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
