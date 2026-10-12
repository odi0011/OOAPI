"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionStyle, type Transition, type Variants } from "motion/react";
import { Check, Mail } from "lucide-react";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import { OneTimeCode, type OneTimeCodeStatus } from "../../../bencho/one-time-code/OneTimeCode";
import { PasswordField } from "../../password-field/password-field";
import { motionTokens } from "../../lib/motion-tokens";
import { authProvidersIcon } from "./provider-icons";
import styles from "./login-centered.module.css";

/**
 * Arc UI 的 login-centered 块，按 OOAPI 的认证方式改造。
 *
 * 原组件是「Passkey / 邮箱验证码」免密流程。本站的登录方式由管理端配置决定，
 * 因此这里做三件事：
 *   1. 保留组件的视觉外壳（居中卡片、同心圆环背景、步骤动画、顶栏与页脚）
 *   2. 三种登录方式各自独立显示 —— 未配置的整块隐藏，而不是显示一个点了报错的按钮
 *   3. 邮箱验证码使用单输入框的 OneTimeCode，状态由真实异步验证驱动
 */

type Step = "credentials" | "email" | "code" | "done";
export type LoginMethod = "Password" | "Email code" | string;

/** 已启用的三方平台，由父组件从后端拉取后传入。 */
export interface EnabledProvider {
  key: string;
  display_name: string;
}

export interface LoginCenteredProps {
  /** 账号密码登录。 */
  onPasswordLogin?: (username: string, password: string) => void | Promise<void>;
  /** 发送邮箱验证码。 */
  onSendEmailCode?: (email: string) => void | Promise<void>;
  /** 用邮箱验证码登录。 */
  onEmailCodeLogin?: (email: string, code: string) => void | Promise<void>;
  /** 点击某个三方平台，由父组件做整页跳转。 */
  onOAuth?: (providerKey: string) => void;
  /** 登录成功并展示完成态之后的回调。 */
  onSignedIn?: () => void;
  /** 去注册入口。 */
  onSignUp?: () => void;
  /** 完成态展示的账号名。 */
  accountName?: string;

  /** 以下开关决定各登录方式是否显示。 */
  passwordEnabled?: boolean;
  emailCodeEnabled?: boolean;
  oauthProviders?: EnabledProvider[];

  fullScreen?: boolean;
  termsHref?: string;
  privacyHref?: string;
  className?: string;
}

type StepCustom = { direction: number; reduce: boolean };

/** 验证码位数，与后端 randomCode(6) 一致。 */
const CODE_LENGTH = 6;

/** Concentric rings behind the card. Outer rings drift further, so the set reads as depth rather than a flat pattern. */
const rings = Array.from({ length: 14 }, (_, index) => ({ r: 224 + index * 60, k: 1 + index * .34, major: index % 3 === 2 }));
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/** Steps rise into place out of a small blur; going back, they settle down from above. */
const stepMotion: Variants = {
  enter: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0 } : { opacity: 0, y: direction * 12, filter: `blur(${motionTokens.blur.soft}px)` },
  center: ({ reduce }: StepCustom) => ({ opacity: 1, y: 0, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .06 }, filter: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .04 } } }),
  exit: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: direction * -8, filter: `blur(${motionTokens.blur.soft}px)`, transition: { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard } },
};
const swap = (reduce: boolean) => ({
  initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.soft}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } },
  transition: (reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }) as Transition,
});
/** Seconds roll down while the timer runs and back up when a new code restarts it. */
const roll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${-0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
};

/** 重发倒计时，与后端 codeResendInterval 的 60 秒保持一致。 */
const RESEND_SECONDS = 60;

function RollingTime({ seconds, reduce }: { seconds: number; reduce: boolean }) {
  const [shown, setShown] = useState({ seconds, direction: 1 });
  if (shown.seconds !== seconds) setShown({ seconds, direction: seconds < shown.seconds ? 1 : -1 });
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const transition: Transition = reduce ? { duration: 0 } : { y: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.fast } };
  return <span className={styles.time}>{text.split("").map((character, index) => <span key={index} className={styles.timeColumn}>
    <AnimatePresence initial={false} mode="popLayout" custom={shown.direction}><motion.span key={character} custom={shown.direction} variants={roll} initial="enter" animate="center" exit="exit" transition={transition}>{character}</motion.span></AnimatePresence>
  </span>)}</span>;
}

/** The card follows its content on a spring only while the view changes; otherwise it stays auto, so field messages open without lag. */
function useViewHeight(view: string, reduce: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const measured = useRef(0);
  const gliding = useRef(false);
  const lastView = useRef(view);
  const glide = useCallback((to: number) => {
    gliding.current = true;
    animate(height, to, { ...motionTokens.spring.smooth, onComplete: () => { gliding.current = false; height.jump("auto"); } });
  }, [height]);
  useEffect(() => {
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      measured.current = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      if (gliding.current) glide(measured.current);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [glide]);
  useLayoutEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    const current = height.get();
    const from = typeof current === "number" ? current : measured.current;
    const to = track.current?.offsetHeight ?? 0;
    if (reduce || !from || !to) { gliding.current = false; height.jump("auto"); return; }
    if (current === "auto") height.jump(from);
    glide(to);
  }, [view, reduce, height, glide]);
  return { track, height };
}

/** Pointer drift for the line backdrop: fine pointers with hover only, never under reduced motion. */
function useDrift(reduce: boolean) {
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const x = useSpring(pointerX, { visualDuration: .9, bounce: 0 });
  const y = useSpring(pointerY, { visualDuration: .9, bounce: 0 });
  const dx = useTransform(x, value => `${value.toFixed(2)}px`);
  const dy = useTransform(y, value => `${value.toFixed(2)}px`);
  const canHover = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => { canHover.current = query.matches; };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (reduce || !canHover.current || event.pointerType !== "mouse") return;
    const box = event.currentTarget.getBoundingClientRect();
    pointerX.set(((event.clientX - box.left) / box.width - .5) * -2);
    pointerY.set(((event.clientY - box.top) / box.height - .5) * -2);
  };
  const onPointerLeave = () => { pointerX.set(0); pointerY.set(0); };
  return { style: { "--dx": dx, "--dy": dy } as MotionStyle, onPointerMove, onPointerLeave };
}

/** 完成态停留时长：让对勾动画走完再跳转，避免刚看见就切页。 */
const DONE_HOLD_MS = 1100;

export function LoginCentered({
  onPasswordLogin,
  onSendEmailCode,
  onEmailCodeLogin,
  onOAuth,
  onSignedIn,
  onSignUp,
  accountName = "",
  passwordEnabled = true,
  emailCodeEnabled = false,
  oauthProviders = [],
  fullScreen = false,
  termsHref,
  privacyHref,
  className,
}: LoginCenteredProps) {
  const reduce = !!useReducedMotion();
  const userRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const timers = useRef<number[]>([]);

  const [step, setStep] = useState<Step>(passwordEnabled ? "credentials" : "email");
  /** 只有两屏且始终向前，方向固定为 1。 */
  const direction = 1;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeStatus, setCodeStatus] = useState<OneTimeCodeStatus>("idle");
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<null | "password" | "send" | "verify">(null);
  const [submitError, setSubmitError] = useState("");
  const [status, setStatus] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [method, setMethod] = useState<LoginMethod>("Password");

  const { track, height } = useViewHeight(step, reduce);
  const drift = useDrift(reduce);

  const usernameError = (touched || attempted) && !username.trim() ? "请输入用户名。" : "";
  const emailError = (touched || attempted) && !isEmail(email) ? (email.trim() ? "请输入完整邮箱地址，例如 name@example.com。" : "请输入邮箱地址。") : "";
  const custom: StepCustom = { direction, reduce };

  // 两种方式都不可用时没有任何入口，此时给出明确说明而不是空卡片。
  const noMethodAvailable = !passwordEnabled && !emailCodeEnabled && oauthProviders.length === 0;

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => { if (step === "done") doneRef.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== "code" || resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(seconds => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [step, resendIn]);

  function later(run: () => void, ms: number) { timers.current.push(window.setTimeout(run, ms)); }

  /** 进入完成态：展示片刻后交给上层跳转。 */
  function finish(how: LoginMethod) {
    setBusy(null);
    setMethod(how);
    setStep("done");
    setStatus(`已通过${how === "Password" ? "账号密码" : "邮箱验证码"}登录`);
    later(() => onSignedIn?.(), reduce ? 0 : DONE_HOLD_MS);
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    setSubmitError("");
    if (!username.trim()) { userRef.current?.focus(); return; }
    if (!password) { setSubmitError("请输入密码。"); return; }

    setBusy("password");
    setStatus("正在登录");
    try {
      await onPasswordLogin?.(username.trim(), password);
      finish("Password");
    } catch (error) {
      setBusy(null);
      setSubmitError(error instanceof Error && error.message ? error.message : "登录失败，请稍后重试。");
      setStatus("登录失败");
    }
  }

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    setSubmitError("");
    if (!isEmail(email)) { emailRef.current?.focus(); return; }

    setBusy("send");
    setStatus("正在发送验证码");
    try {
      if (!onSendEmailCode) throw new Error("邮箱验证码登录暂不可用，请稍后重试。");
      await onSendEmailCode(email.trim().toLowerCase());
      setBusy(null);
      setCode("");
      setCodeStatus("idle");
      setResendIn(RESEND_SECONDS);
      setStep("code");
      setStatus(`验证码已发送至 ${email.trim()}`);
      later(() => codeRef.current?.querySelector("input")?.focus(), 60);
    } catch (error) {
      setBusy(null);
      setSubmitError(error instanceof Error && error.message ? error.message : "验证码发送失败，请稍后重试。");
      setStatus("发送失败");
    }
  }

  async function verifyCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy) return;
    setSubmitError("");

    if (code.length < CODE_LENGTH) {
      setSubmitError(`请输入完整的 ${CODE_LENGTH} 位验证码。`);
      return;
    }

    if (!onEmailCodeLogin) {
      setSubmitError("邮箱验证码登录暂不可用，请稍后重试。");
      setCodeStatus("error");
      return;
    }

    setBusy("verify");
    setCodeStatus("verifying");
    setStatus("正在校验验证码");
    try {
      await onEmailCodeLogin(email.trim().toLowerCase(), code);
      setCodeStatus("success");
      setStatus("验证码已验证");
      later(() => finish("Email code"), reduce ? 0 : 1000);
    } catch (error) {
      setBusy(null);
      setCodeStatus("error");
      setSubmitError(error instanceof Error && error.message ? error.message : "验证码不正确或已过期。");
      setStatus("验证失败");
      later(() => codeRef.current?.querySelector("input")?.focus(), 60);
    }
  }

  async function resend() {
    if (busy || resendIn > 0) return;
    setSubmitError("");
    setBusy("send");
    setStatus("正在重新发送验证码");
    try {
      if (!onSendEmailCode) throw new Error("邮箱验证码登录暂不可用，请稍后重试。");
      await onSendEmailCode(email.trim().toLowerCase());
      setBusy(null);
      setCode("");
      setCodeStatus("idle");
      setResendIn(RESEND_SECONDS);
      setStatus("新验证码已发送");
    } catch (error) {
      setBusy(null);
      setSubmitError(error instanceof Error && error.message ? error.message : "发送失败，请稍后重试。");
    }
  }

  function changeEmail() {
    if (busy) return;
    setAttempted(false);
    setSubmitError("");
    setCode("");
    setCodeStatus("idle");
    setStep("email");
    setStatus("修改邮箱");
  }

  function openLegal(href: string, label: string) {
    return (event: { preventDefault: () => void }) => {
      if (!href.startsWith("#")) return;
      event.preventDefault();
      setStatus(`${label} 将在应用内打开`);
    };
  }

  // #terms / #privacy 这类锚点没有对应文档，点了只会改状态栏文案。
  // 没有真实地址就不渲染，避免空链。
  const termsLink = documentHref(termsHref);
  const privacyLink = documentHref(privacyHref);

  const showOAuth = oauthProviders.length > 0;
  // 「或」分隔线只在上下都有内容时才画。
  const showDivider = showOAuth && (passwordEnabled || emailCodeEnabled);

  return (
    <section className={[styles.screen, fullScreen ? styles.fullScreen : "", className].filter(Boolean).join(" ")} aria-label="登录 OOAPI" onPointerMove={drift.onPointerMove} onPointerLeave={drift.onPointerLeave}>
      <motion.div className={styles.backdrop} style={drift.style} aria-hidden="true">
        <svg className={styles.lines}>
          <svg x="50%" y="50%" overflow="visible">
            <line className={styles.axis} x1="-2400" x2="2400" y1="0" y2="0" />
            <line className={styles.axis} x1="0" x2="0" y1="-2400" y2="2400" />
            {rings.map(ring => <circle key={ring.r} className={ring.major ? `${styles.ring} ${styles.ringMajor}` : styles.ring} r={ring.r} cx="0" cy="0" style={{ "--k": ring.k } as CSSProperties} />)}
          </svg>
        </svg>
      </motion.div>

      <header className={styles.bar}>
        <span className={styles.mark}>
          <img src="/logo.jpg" alt="" width={20} height={20} style={{ borderRadius: 9999, objectFit: "cover", display: "block" }} />
          OOAPI
        </span>
        {onSignUp && <p className={styles.switch}>
          <span className={styles.switchPrompt}>还没有账号？</span>
          <button type="button" className={styles.switchButton} onClick={onSignUp}>立即注册</button>
        </p>}
      </header>

      <div className={styles.stage}>
        <div className={styles.card}>
          <motion.div className={styles.viewport} style={{ height }}>
            <div ref={track} className={styles.track}>
              <AnimatePresence mode="popLayout" initial={false} custom={custom}>
                {step === "credentials" && <motion.div key="credentials" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                  <div className={styles.heading}>
                    <h2>登录 OOAPI</h2>
                    <p>使用你的用户名与密码继续。</p>
                  </div>

                  <form className={styles.form} onSubmit={event => void submitPassword(event)} noValidate>
                    <Input ref={userRef} label="用户名" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} readOnly={!!busy} error={usernameError} onChange={event => setUsername(event.target.value)} onBlur={() => { if (username.trim()) setTouched(true); }} />
                    <PasswordField label="密码" name="password" autoComplete="current-password" value={password} readOnly={!!busy} onChange={event => setPassword(event.target.value)} />
                    {submitError && <p className={styles.submitError} role="alert">{submitError}</p>}
                    <Button type="submit" className={styles.wide} loading={busy === "password"}>登录</Button>
                  </form>

                  {/* 仅在管理员配好 SMTP 后才提供邮箱验证码入口 */}
                  {emailCodeEnabled && (
                    <button type="button" className={styles.textButton} onClick={() => { setSubmitError(""); setAttempted(false); setStep("email"); setStatus("使用邮箱验证码登录"); }}>
                      <Mail size={14} strokeWidth={1.75} aria-hidden="true" />
                      使用邮箱验证码登录
                    </button>
                  )}

                  {showDivider && <div className={styles.divider}>或</div>}

                  {showOAuth && <div className={styles.sso} role="group" aria-label="第三方登录">
                    {oauthProviders.map(provider => <Button key={provider.key} type="button" variant="secondary" className={styles.ssoButton} aria-label={`使用 ${provider.display_name} 登录`} onClick={() => onOAuth?.(provider.key)}>
                      {authProvidersIcon(provider.key)}{provider.display_name}
                    </Button>)}
                  </div>}
                </motion.div>}

                {step === "email" && <motion.div key="email" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                  <div className={styles.heading}>
                    <h2>邮箱验证码登录</h2>
                    <p>我们会向你的邮箱发送 6 位验证码。</p>
                  </div>

                  <form className={styles.form} onSubmit={event => void submitEmail(event)} noValidate>
                    <Input ref={emailRef} label="邮箱" type="email" name="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@example.com" value={email} readOnly={busy === "send"} error={emailError} onChange={event => setEmail(event.target.value)} onBlur={() => { if (email.trim()) setTouched(true); }} />
                    {submitError && <p className={styles.submitError} role="alert">{submitError}</p>}
                    <Button type="submit" className={styles.wide} loading={busy === "send"}>发送验证码</Button>
                  </form>

                  <button type="button" className={styles.textButton} onClick={() => { setSubmitError(""); setAttempted(false); setStep(passwordEnabled ? "credentials" : "email"); setStatus("返回账号密码登录"); }}>
                    <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                    使用账号密码登录
                  </button>

                  {showDivider && <div className={styles.divider}>或</div>}

                  {showOAuth && <div className={styles.sso} role="group" aria-label="第三方登录">
                    {oauthProviders.map(provider => <Button key={provider.key} type="button" variant="secondary" className={styles.ssoButton} aria-label={`使用 ${provider.display_name} 登录`} onClick={() => onOAuth?.(provider.key)}>
                      {authProvidersIcon(provider.key)}{provider.display_name}
                    </Button>)}
                  </div>}
                </motion.div>}

                {step === "code" && <motion.div key="code" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                  <div className={styles.heading}>
                    <h2>查收邮件</h2>
                    <p>验证码已发送至 <span className={styles.address}>{email.trim()}</span>。<button type="button" className={styles.inlineButton} onClick={changeEmail}>换个邮箱</button></p>
                  </div>

                  <form className={styles.form} onSubmit={event => void verifyCode(event)} noValidate>
                    <div ref={codeRef}>
                      <OneTimeCode label="验证码" value={code} onChange={value => { setCode(value); setCodeStatus("idle"); if (submitError && value) setSubmitError(""); }} status={codeStatus} error={submitError} disabled={busy === "send"} length={CODE_LENGTH} autoFocus />
                    </div>
                    <Button type="submit" className={styles.wide} loading={busy === "verify"}>验证并登录</Button>
                  </form>

                  <button type="button" className={styles.textButton} aria-disabled={resendIn > 0 || !!busy || undefined} aria-label={resendIn > 0 ? `重新发送，${resendIn} 秒后可用` : "重新发送验证码"} onClick={() => void resend()}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span key={resendIn > 0 ? "wait" : "ready"} className={styles.resendLabel} {...swap(reduce)}>{resendIn > 0 ? <>重新发送 <RollingTime seconds={resendIn} reduce={reduce} /></> : "重新发送验证码"}</motion.span>
                    </AnimatePresence>
                  </button>
                </motion.div>}

                {step === "done" && <motion.div key="done" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                  <svg className={styles.success} viewBox="0 0 48 48" aria-hidden="true">
                    <g transform="rotate(-90 24 24)"><motion.circle cx="24" cy="24" r="22.25" fill="none" stroke="currentColor" strokeWidth="1.5" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: motionTokens.duration.considered, ease: [...motionTokens.ease.inOut], delay: .16 }, opacity: { duration: motionTokens.duration.instant, delay: .16 } }} /></g>
                    <motion.path d="M15.5 24.5l5.5 5.5 11.5-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: motionTokens.duration.standard + .08, ease: [...motionTokens.ease.enter], delay: .52 }, opacity: { duration: motionTokens.duration.instant, delay: .52 } }} />
                  </svg>
                  <div className={styles.heading}><h2 ref={doneRef} tabIndex={-1}>欢迎回来</h2><p>已登录为 <span className={styles.address}>{accountName || username.trim() || email.trim()}</span>，正在进入控制台…</p></div>
                  <dl className={styles.details}>
                    <div><dt>登录方式</dt><dd>{method === "Password" ? "账号密码" : method === "Email code" ? "邮箱验证码" : method}</dd></div>
                    <div><dt>有效期</dt><dd>24 小时</dd></div>
                  </dl>
                  <Button type="button" variant="secondary" className={styles.wide} onClick={onSignedIn}>立即进入</Button>
                </motion.div>}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>

      <footer className={styles.foot}>
        <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
        <span className={styles.status} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}><motion.span key={status} {...swap(reduce)}>{status}</motion.span></AnimatePresence></span>
        {(termsLink || privacyLink) && <nav className={styles.legal} aria-label="Legal">
          {termsLink && <a href={termsLink} onClick={openLegal(termsLink, "服务条款")}>服务条款</a>}
          {privacyLink && <a href={privacyLink} onClick={openLegal(privacyLink, "隐私政策")}>隐私政策</a>}
        </nav>}
      </footer>

      {noMethodAvailable && (
        <p className={styles.srOnly} role="alert">
          管理员尚未启用任何登录方式
        </p>
      )}
    </section>
  );
}

/** 只接受能打开的文档地址。空串和 #hash 都视为没有文档。 */
function documentHref(href?: string): string {
  const trimmed = href?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("#")) return "";
  return trimmed;
}

export default LoginCentered;
