import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { BadgeCheck, ExternalLink, Link2 } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { apiRequest } from "@/lib/api";
import { useNotify } from "@/lib/useNotify";
import styles from "./DeviceLoginPanel.module.css";

/*
  已授权面板的背景：外部渐变引擎（367 KB 预构建产物）。
  用 lazy 单独成 chunk —— 只有真正出现「已授权」面板时才下载，
  不给后台主包增加体积。
*/
const GradientBackdrop = lazy(() => import("@/vendor/feral-gradient"));

export type DeviceVendor = "cline" | "kiro" | "workbuddy" | "grok";
export type DeviceMethod = "cli" | "kiro" | "workbuddy" | "grok";

interface DeviceSession {
  sessionId: string;
  userCode?: string;
  verifyUrl: string;
  intervalMs: number;
  expiresIn: number;
}
interface ActiveDeviceSession extends DeviceSession {
  userCode: string;
  channelId: number;
  expiresAt: number;
}
interface PollResult {
  status: "pending" | "success" | "denied" | "expired" | "error";
  ticket?: string;
  channel_id?: number;
  intervalMs?: number;
  message?: string;
  /** 授权成功后服务端给出的账号标识（区域 / 平台 / 企业 ID），不含 token。 */
  account?: string;
  expires_in?: number;
}
interface Props {
  vendor: DeviceVendor;
  method: DeviceMethod;
  channelId?: number;
  onAuthorized: (ticket?: string) => void;
  /** 本次会话内刚授权完成（用于禁用重复发起）。 */
  authorized: boolean;
  /** 该账号此前已经绑定过凭据（编辑已有账号时用）：直接展示已授权面板。 */
  bound?: boolean;
  disabled?: boolean;
}

const VENDOR_LABEL: Record<DeviceVendor, string> = { cline: "Cline", kiro: "Kiro", workbuddy: "WorkBuddy", grok: "Grok" };
const REALM_OPTIONS = [
  { value: "global", label: "国际版（global）" },
  { value: "cn", label: "中国版（cn）" },
];

const cancelDeviceSession = (sessionId: string) => apiRequest("/api/admin/channels/devices/cancel", { method: "POST", body: { session_id: sessionId } }).catch(() => {});
const pollDelay = (intervalMs: number, minimum: number) => Math.max(minimum, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : minimum);
const isExpectedSuccess = (result: PollResult, channelId: number) => result.status === "success" && (channelId > 0 ? result.channel_id === channelId : Boolean(result.ticket));

/** 授权页地址必须落在该厂商的官方域名上，防止把用户引导到第三方页面。 */
function isAllowedVerifyUrl(vendor: DeviceVendor, raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (vendor === "cline") return host === "authkit.cline.bot";
  if (vendor === "kiro") return host === "awsapps.com" || host.endsWith(".awsapps.com") || host === "amazonaws.com" || host.endsWith(".amazonaws.com");
  // Grok：设备授权页在 auth.x.ai（xAI 官方域），也允许 grok.com 的控制台页。
  if (vendor === "grok") return host === "auth.x.ai" || host === "x.ai" || host.endsWith(".x.ai") || host === "grok.com" || host.endsWith(".grok.com");
  return host === "www.workbuddy.ai" || host === "www.codebuddy.cn";
}

/** 授权凭据只存在服务器；前端接收有时效且只能消费一次的绑定票据。 */
export default function DeviceLoginPanel({ vendor, method, channelId, onAuthorized, authorized, bound = false, disabled }: Props) {
  const notify = useNotify();
  const label = VENDOR_LABEL[vendor];
  const targetChannelId = channelId ?? 0;
  const [session, setSession] = useState<ActiveDeviceSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  /** 授权成功后渲染的成功卡片数据（账号标识 + 有效期）。 */
  const [granted, setGranted] = useState<{ account: string; expiresIn: number; relinked: boolean } | null>(null);
  const [region, setRegion] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [realm, setRealm] = useState("global");
  const generation = useRef(0);
  const sessionRef = useRef<ActiveDeviceSession | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const targetChannelIdRef = useRef(targetChannelId);
  const authorizedStateRef = useRef(authorized);
  const disabledRef = useRef(disabled);
  const authorizedRef = useRef(onAuthorized);
  const identityRef = useRef(`${vendor}:${method}`);
  targetChannelIdRef.current = targetChannelId;
  authorizedStateRef.current = authorized;
  disabledRef.current = disabled;
  authorizedRef.current = onAuthorized;

  async function cancel() {
    generation.current++;
    const active = sessionRef.current;
    sessionRef.current = null;
    if (mounted.current) setSession(null);
    if (active) await cancelDeviceSession(active.sessionId);
  }

  useEffect(() => () => {
    mounted.current = false;
    generation.current++;
    const active = sessionRef.current;
    sessionRef.current = null;
    if (active) void cancelDeviceSession(active.sessionId);
  }, []);

  useEffect(() => {
    const active = sessionRef.current;
    if (active && active.channelId !== targetChannelId) void cancel();
  }, [targetChannelId]);

  // 切换授权厂商/接入方式时旧会话立即作废，避免票据落到新的目标账号上。
  useEffect(() => {
    if (identityRef.current === `${vendor}:${method}`) return;
    identityRef.current = `${vendor}:${method}`;
    if (sessionRef.current) void cancel();
  }, [vendor, method]);

  useEffect(() => {
    if ((authorized || disabled) && sessionRef.current) void cancel();
  }, [authorized, disabled]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current;
    const active = session;
    const isCurrent = () => !disposed && current === generation.current && sessionRef.current?.sessionId === active.sessionId;
    const schedule = (delay: number) => { timer = setTimeout(() => void poll(), delay); };
    async function poll() {
      if (!isCurrent()) return;
      if (Date.now() >= active.expiresAt) {
        if (mounted.current) setMessage("授权已过期，请重新发起登录。");
        await cancel();
        return;
      }
      try {
        const result = await apiRequest<PollResult>("/api/admin/channels/devices/poll", { method: "POST", body: { session_id: active.sessionId, channel_id: active.channelId } });
        if (!isCurrent()) return;
        if (result.status === "pending") {
          schedule(pollDelay(result.intervalMs || active.intervalMs, 1500));
          return;
        }
        sessionRef.current = null;
        if (mounted.current) setSession(null);
        if (isExpectedSuccess(result, active.channelId)) {
          authorizedRef.current(result.ticket);
          if (mounted.current) {
            // 成功状态单独存一份结构化数据给卡片渲染，message 只留给失败提示。
            setGranted({ account: result.account ?? "", expiresIn: result.expires_in ?? 0, relinked: active.channelId > 0 });
            setMessage("");
            notify.success(`「${label} 账号」授权成功`);
          }
        } else {
          if (result.status === "success") void cancelDeviceSession(active.sessionId);
          if (mounted.current) {
            setMessage(result.message || "授权未完成，请重新登录。");
            notify.error("授权未完成", result.message);
          }
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (mounted.current) setMessage(err instanceof Error ? err.message : "授权查询失败");
        // 网络错误与授权失败区分；按服务端最小间隔继续查询，允许取消。
        schedule(pollDelay(active.intervalMs, 5000));
      }
    }
    schedule(pollDelay(active.intervalMs, 1500));
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [session, notify, label]);

  async function start() {
    if (disabledRef.current || authorizedStateRef.current || locked.current || !mounted.current) return;
    locked.current = true;
    setStarting(true); setMessage("");
    const current = ++generation.current;
    const startedChannelId = targetChannelIdRef.current;
    let started: DeviceSession | null = null;
    try {
      const body: Record<string, unknown> = { vendor, method, channel_id: startedChannelId };
      if (vendor === "kiro") {
        if (region.trim()) body.region = region.trim();
        if (startUrl.trim()) body.start_url = startUrl.trim();
      } else if (vendor === "workbuddy") {
        body.realm = realm;
      }
      started = await apiRequest<DeviceSession>("/api/admin/channels/devices/start", { method: "POST", body });
      if (!mounted.current || current !== generation.current || startedChannelId !== targetChannelIdRef.current || disabledRef.current || authorizedStateRef.current) {
        await cancelDeviceSession(started.sessionId);
        return;
      }
      if (!started.sessionId || !started.verifyUrl) throw new Error("授权服务返回了无效的会话");
      if (!isAllowedVerifyUrl(vendor, started.verifyUrl)) throw new Error("授权服务返回了不安全的地址");
      const expiresIn = Number.isFinite(started.expiresIn) ? Math.max(1, started.expiresIn) : 1;
      const active: ActiveDeviceSession = { ...started, userCode: started.userCode ?? "", expiresIn, channelId: startedChannelId, expiresAt: Date.now() + expiresIn * 1000 };
      sessionRef.current = active;
      setSession(active);
    } catch (err) {
      if (started) await cancelDeviceSession(started.sessionId);
      if (!mounted.current || current !== generation.current) return;
      const text = err instanceof Error ? err.message : "发起授权失败";
      setMessage(text); notify.error(`发起 ${label} 登录失败`, text);
    } finally {
      locked.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  /*
    已授权状态（本次刚授权完成，或编辑一个早就绑好的账号）：
    整块就是渐变面板本身 —— 不再套一层灰底容器，否则四边会露出一圈灰色。
    bound 与 granted 的区别在于「要不要给重新登录的入口」：
    刚授权完不需要，历史绑定的账号可能需要换一个账号绑定。
  */
  if (granted || bound) {
    const expires = granted && granted.expiresIn > 0
      ? `凭据约 ${Math.max(1, Math.round(granted.expiresIn / 60))} 分钟后到期，届时自动续期`
      : "";
    return <div className={styles.granted} role="status">
      {/* 渐变引擎配方的原始比例是 2048×1506，这里改由容器决定高度（填满整块面板） */}
      <Suspense fallback={null}>
        <GradientBackdrop
          className={styles.grantedBg}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", aspectRatio: "auto" }}
          speed={26}
        />
      </Suspense>
      {/* 配方两端有很浅的米色，压一层薄暗角保证白字在任何一帧都读得清 */}
      <span className={styles.grantedScrim} aria-hidden="true" />
      <div className={styles.grantedContent}>
        <span className={styles.grantedBadge}><BadgeCheck size={15} aria-hidden="true" />已授权</span>
        <span className={styles.grantedTitle}>{label} 账号已连接</span>
        {granted?.account && <span className={styles.grantedMeta}>{granted.account}</span>}
        {expires && <span className={styles.grantedMeta}>{expires}</span>}
        {!granted && (
          <button type="button" className={styles.grantedAction} disabled={disabled || starting} onClick={() => void start()}>
            <Link2 size={13} aria-hidden="true" />重新登录其它账号
          </button>
        )}
        {message && <span className={styles.grantedMeta}>{message}</span>}
      </div>
    </div>;
  }

  /*
    未授权状态：整块灰底，内容正居中（水平 + 垂直），底纹做一层很轻的流动。

    居中用一个内层 .panelInner 承担：外层 flex 居中、内层按内容排布，
    这样内容多少都居中，不会因为某一项变高就偏上。
  */
  return <div className={styles.panel}>
    <span className={styles.panelSheen} aria-hidden="true" />
    <div className={styles.panelInner}>
    <strong className={styles.title}>{label} 账号</strong>
    {!session && vendor === "kiro" && <div className={styles.fields}>
      <Input label="区域（留空自动探测）" placeholder="us-east-1" value={region} disabled={disabled || starting} onChange={(e) => setRegion(e.target.value)} />
      <Input label="启动地址 startUrl（留空用 AWS Builder ID）" value={startUrl} disabled={disabled || starting} onChange={(e) => setStartUrl(e.target.value)} />
    </div>}
    {!session && vendor === "workbuddy" && <div className={styles.fieldRow}>
      <Select label="区域" value={realm} options={REALM_OPTIONS} disabled={disabled || starting} onValueChange={setRealm} />
    </div>}
    {session ? <>
      {session.userCode ? <>
        <span>在官方授权页确认登录；设备代码：</span>
        <strong className={styles.code}>{session.userCode}</strong>
      </> : <span>在弹出的官方授权页完成登录，完成后本页会自动继续。</span>}
      <a className={styles.link} href={session.verifyUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />打开官方授权页</a>
      <span className={styles.note}>正在等待授权（最多 {Math.ceil(session.expiresIn / 60)} 分钟）。{session.userCode ? "不要把授权代码发给他人。" : ""}</span>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void cancel()}>取消授权</Button>
    </> : <Button size="sm" variant="secondary" disabled={disabled || starting || authorized} loading={starting} onClick={() => void start()}><Link2 size={14} />{authorized ? `${label} 账号已授权` : channelId ? `重新登录 ${label} 账号` : `一键登录 ${label} 账号`}</Button>}
    {message && <p role="status">{message}</p>}
    </div>
  </div>;
}
