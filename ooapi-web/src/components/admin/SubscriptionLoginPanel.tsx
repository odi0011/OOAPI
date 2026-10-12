import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { BadgeCheck, ExternalLink, Link2 } from "lucide-react";

import { Button } from "@/components/arc/button/button";
import { Textarea } from "@/components/arc/textarea/textarea";
import { useNotify } from "@/lib/useNotify";
import { apiRequest } from "@/lib/api";
import styles from "./DeviceLoginPanel.module.css";

/*
  订阅账号的交互式登录面板（Codex / Claude / Google）。

  与设备码授权（DeviceLoginPanel）的区别在于最后一步：
  设备码是「服务端拿 code 轮询」，用户什么都不用粘；
  这条是「用户在官方页面登录 → 浏览器跳到 localhost（打不开，属正常现象）
  → 把地址栏那串 URL 复制回这里」。

  为什么不做自动回调：官方客户端注册的 redirect_uri 固定指向
  http://localhost:<port>，浏览器会把用户带到**他自己电脑**的那个端口上，
  服务器上的我们收不到。这是标准现象（与 gcloud --no-launch-browser 一致）。
*/

const GradientBackdrop = lazy(() => import("@/vendor/feral-gradient"));

export type SubscriptionVendor = "codex" | "claude-oauth" | "antigravity";

/** 服务端返回的是 snake_case（与其余管理接口一致）。 */
interface LoginStart {
  auth_url: string;
  state: string;
  redirect_uri: string;
  expires_in: number;
}

interface ExchangeResult {
  ticket: string;
  account: string;
  expires_in?: number;
}

interface Props {
  vendor: SubscriptionVendor;
  channelId?: number;
  /** 本次会话内刚完成授权（用于禁用重复发起）。 */
  authorized: boolean;
  /** 该账号此前已经绑定过凭据（编辑已有账号时用）。 */
  bound?: boolean;
  disabled?: boolean;
  /**
   * 授权完成回调：ticket 是服务端的一次性凭据句柄。
   * 立即拉模型用的也是这个 ticket（服务端只读预览，不消费）。
   */
  onAuthorized: (ticket: string) => void;
}

const VENDOR_LABEL: Record<SubscriptionVendor, string> = {
  codex: "Codex",
  "claude-oauth": "Claude",
  antigravity: "Google",
};

/** 回调地址必须落在官方域上，防止把用户引导到第三方页面。 */
function isAllowedAuthURL(vendor: SubscriptionVendor, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (vendor === "codex") return host === "auth.openai.com";
  if (vendor === "claude-oauth") return host === "claude.ai";
  return host === "accounts.google.com";
}

export default function SubscriptionLoginPanel({ vendor, channelId, authorized, bound = false, disabled, onAuthorized }: Props) {
  const notify = useNotify();
  const label = VENDOR_LABEL[vendor];
  const [start, setStart] = useState<LoginStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [granted, setGranted] = useState<{ account: string } | null>(null);
  /** 入口二选一：交互式登录 / 粘贴已导出的凭据文件。 */
  const [mode, setMode] = useState<"login" | "import">("login");
  const [paste, setPaste] = useState("");
  const mounted = useRef(true);
  const authorizedRef = useRef(onAuthorized);
  const disabledRef = useRef(disabled);
  const authorizedStateRef = useRef(authorized);
  authorizedRef.current = onAuthorized;
  disabledRef.current = disabled;
  authorizedStateRef.current = authorized;

  useEffect(() => () => { mounted.current = false; }, []);

  async function begin() {
    if (disabledRef.current || authorizedStateRef.current || starting) return;
    setStarting(true);
    setMessage("");
    try {
      const started = await apiRequest<LoginStart>("/api/admin/channels/devices/login/start", {
        method: "POST",
        body: { vendor },
      });
      if (!started.auth_url || !isAllowedAuthURL(vendor, started.auth_url)) {
        throw new Error("授权服务返回了不安全的地址");
      }
      if (!mounted.current) return;
      setStart(started);
      // 新标签页打开官方授权页：本页保持可见，用户回来粘贴。
      window.open(started.auth_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      if (mounted.current) setMessage(err instanceof Error ? err.message : "发起授权失败");
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  /**
   * 导入已导出的凭据（官方 CLI / CPA / sub2api）。
   *
   * 与登录并列的入口：用户手里已经有别的工具登录出来的凭据文件时，
   * 不必重新走一遍授权。产出同样是凭据句柄，后续流程完全一致。
   */
  async function importCredential() {
    if (disabledRef.current || busy) return;
    if (!paste.trim()) {
      notify.warning("请粘贴凭据内容", "官方 CLI 的 auth.json / .credentials.json，或 CPA / sub2api 导出文件");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<ExchangeResult>("/api/admin/channels/devices/login/import", {
        method: "POST",
        body: { vendor, input: paste },
      });
      if (!mounted.current) return;
      setGranted({ account: result.account ?? "" });
      setPaste("");
      notify.success(`已导入「${label} 账号」凭据`);
      authorizedRef.current(result.ticket);
    } catch (err) {
      if (mounted.current) setMessage(err instanceof Error ? err.message : "导入凭据失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function submit() {
    if (!start || disabledRef.current || busy) return;
    if (!input.trim()) {
      notify.warning("请粘贴回调地址", "浏览器跳到 localhost 打不开是正常的，把地址栏那一整串复制过来即可");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<ExchangeResult>("/api/admin/channels/devices/login/exchange", {
        method: "POST",
        body: { vendor, input: input.trim() },
      });
      if (!mounted.current) return;
      setGranted({ account: result.account ?? "" });
      setStart(null);
      setInput("");
      notify.success(`「${label} 账号」授权成功`);
      authorizedRef.current(result.ticket);
    } catch (err) {
      if (mounted.current) setMessage(err instanceof Error ? err.message : "换取凭据失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  // 已授权：整块渐变面板（与设备授权同一套视觉）。
  if (granted || bound) {
    return <div className={styles.granted} role="status">
      <Suspense fallback={null}>
        <GradientBackdrop
          className={styles.grantedBg}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", aspectRatio: "auto" }}
          speed={26}
        />
      </Suspense>
      <span className={styles.grantedScrim} aria-hidden="true" />
      <div className={styles.grantedContent}>
        <span className={styles.grantedBadge}><BadgeCheck size={15} aria-hidden="true" />已授权</span>
        <span className={styles.grantedTitle}>{label} 账号已连接</span>
        {granted?.account && <span className={styles.grantedMeta}>{granted.account}</span>}
        {!granted && (
          <button type="button" className={styles.grantedAction} disabled={disabled || starting} onClick={() => void begin()}>
            <Link2 size={13} aria-hidden="true" />重新登录其它账号
          </button>
        )}
        {message && <span className={styles.grantedMeta}>{message}</span>}
      </div>
    </div>;
  }

  return <div className={styles.panel}>
    <span className={styles.panelSheen} aria-hidden="true" />
    <div className={styles.panelInner}>
      <strong className={styles.title}>{label} 账号</strong>
      {/* 两个入口：一键登录（走官方授权）或粘贴已有凭据（别再走一遍授权）。 */}
      {!start && <div className={styles.fieldRow}>
        <Button size="sm" variant={mode === "login" ? "secondary" : "ghost"} disabled={disabled || busy} onClick={() => { setMode("login"); setMessage(""); }}>一键登录</Button>
        <Button size="sm" variant={mode === "import" ? "secondary" : "ghost"} disabled={disabled || busy} onClick={() => { setMode("import"); setMessage(""); }}>粘贴凭据</Button>
      </div>}
      {!start && mode === "import" ? <>
        <span className={styles.note}>
          粘贴官方 CLI 导出的凭据文件内容（Codex 的 auth.json、Claude 的 .credentials.json），
          或 CPA / sub2api 导出文件。必须包含 refresh_token，否则账号无法自动续期。
        </span>
        <div className={styles.fields}>
          <Textarea
            label="凭据内容"
            rows={5}
            value={paste}
            disabled={disabled || busy}
            placeholder='{"access_token":"...","refresh_token":"..."}'
            onChange={(e) => setPaste(e.target.value)}
          />
        </div>
        <div className={styles.fieldRow}>
          <Button size="sm" loading={busy} disabled={disabled || busy} onClick={() => void importCredential()}>导入凭据</Button>
        </div>
      </> : !start ? <>
        <span className={styles.note}>
          点下面的按钮打开官方授权页；登录完成后浏览器会跳到一个打不开的 localhost 地址 ——
          这是正常的，把地址栏里那一整串 URL 复制回来即可。
        </span>
        <Button size="sm" variant="secondary" disabled={disabled || starting} loading={starting} onClick={() => void begin()}>
          <Link2 size={14} />{channelId ? `重新登录 ${label} 账号` : `一键登录 ${label} 账号`}
        </Button>
      </> : <>
        <a className={styles.link} href={start.auth_url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} />打开官方授权页
        </a>
        <span className={styles.note}>
          完成登录后浏览器会跳到 <code>{start.redirect_uri}</code>（打不开是正常的），
          把地址栏里的完整 URL 粘贴到下面。
        </span>
        <div className={styles.fields}>
          <Textarea
            label="回调地址"
            rows={3}
            value={input}
            disabled={disabled || busy}
            placeholder={`${start.redirect_uri}?code=...&state=...`}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className={styles.fieldRow}>
          <Button size="sm" loading={busy} disabled={disabled || busy} onClick={() => void submit()}>完成授权</Button>
        </div>
      </>}
      {message && <p role="status">{message}</p>}
    </div>
  </div>;
}
