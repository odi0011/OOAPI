"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Transition, type Variants } from "motion/react";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { Input } from "../../input/input";
import { PasswordField } from "../../password-field/password-field";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./signup-form.module.css";

export interface SignupDetails {
  name: string;
  email: string;
  password: string;
  productUpdates: boolean;
}

/** 已启用的三方平台，由父组件从后端拉取后传入。 */
export interface EnabledProvider {
  key: string;
  display_name: string;
}

/** 未知平台的兜底图标，避免按钮上缺一块。 */
function GenericProviderMark() {
  return <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fillOpacity="0.18" />
    <circle cx="12" cy="12" r="4" />
  </svg>;
}

export interface SignupFormProps {
  /** Receives the details once every field is valid. Throw to show a submit error. */
  onSubmit?: (details: SignupDetails) => void | Promise<void>;
  /** An error from your API, shown above the submit button. */
  serverError?: string | null;
  /** Called when someone picks a single sign-on provider. */
  onProvider?: (providerKey: string) => void;
  /**
   * 已启用的三方平台。为空数组时不渲染任何三方按钮 ——
   * 未配置的平台应当直接不显示，而不是显示一个点了报错的按钮。
   */
  providers?: EnabledProvider[];
}

type Field = "name" | "email" | "password";
type Step = "form" | "done";
type StepCustom = { direction: number; reduce: boolean };

/** 内置支持的平台标记，按 key 索引。 */
const providerMarks: Record<string, string> = {
  github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  gitlab: "M23.6 9.6l-.03-.08-3.26-8.5a.85.85 0 0 0-1.6.09l-2.2 6.72H7.5L5.3 1.11a.85.85 0 0 0-1.6-.09L.44 9.52l-.03.08a6.05 6.05 0 0 0 2 6.99l.01.01.03.02 4.96 3.71 2.45 1.86 1.5 1.13a1 1 0 0 0 1.21 0l1.5-1.13 2.45-1.86 4.99-3.73.01-.01a6.05 6.05 0 0 0 2-6.99z",
  gitee: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.85 0 3.58-.5 5.06-1.38l-3.9-2.25a3.9 3.9 0 0 1-1.16.18c-2.16 0-3.9-1.74-3.9-3.9s1.74-3.9 3.9-3.9h5.62c.24 0 .44-.2.44-.44V8.4c0-.24-.2-.44-.44-.44H9.62c-.24 0-.44.2-.44.44v1.1c0 .24.2.44.44.44h4.3c.24 0 .44.2.44.44v.9c0 .24-.2.44-.44.44h-4.3a4.78 4.78 0 0 0-4.78 4.78c0 .63.13 1.24.35 1.79L4.6 17.1A9.94 9.94 0 0 1 2 12C2 6.48 6.48 2 12 2z",
  qq: "M12.003 2c-2.3 0-4 2-4 5 0 1.1-.3 1.6-1.2 2.7C5.4 11.7 4 14 4 16.2c0 1.4.6 2.3 1.5 2.3.6 0 1.2-.4 1.7-1 .7 1 1.5 1.6 2.3 1.8-.3.4-.5.8-.5 1.2 0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.5-1.2.8-.2 1.6-.8 2.3-1.8.5.6 1.1 1 1.7 1 .9 0 1.5-.9 1.5-2.3 0-2.2-1.4-4.5-2.8-6.5-.9-1.1-1.2-1.6-1.2-2.7 0-3-1.7-5-4-5z",
  discord: "M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z",
};

const GOOGLE_PATHS: Array<{ fill: string; d: string }> = [
  { fill: "#4285F4", d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" },
  { fill: "#34A853", d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" },
  { fill: "#FBBC05", d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" },
  { fill: "#EA4335", d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" },
];

function ProviderMark({ providerKey }: { providerKey: string }) {
  const key = providerKey.toLowerCase();

  if (key === "google") {
    return <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      {GOOGLE_PATHS.map(p => <path key={p.fill} fill={p.fill} d={p.d} />)}
    </svg>;
  }

  if (key === "microsoft") {
    return <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>;
  }

  const d = providerMarks[key];
  if (!d) return <GenericProviderMark />;

  return <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={d} />
  </svg>;
}

function getErrors(name: string, email: string, password: string) {
  return {
    name: name.trim().length < 2 ? "请填写完整的用户名。" : "",
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? "请输入完整邮箱地址，例如 name@example.com。" : "",
    password: password.length < 8 ? "密码至少 8 位。" : "",
  };
}

function passwordScore(password: string) {
  if (!password) return 0;
  return [password.length >= 8, password.length >= 12, /[a-z]/.test(password) && /[A-Z]/.test(password), /\d|[^\w\s]/.test(password)].filter(Boolean).length;
}
const strengthLabel = ["", "弱", "一般", "良好", "很强"];

/** Steps cross over sideways out of a small blur; going back, they return from the other side. */
const stepMotion: Variants = {
  enter: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0 } : { opacity: 0, x: direction * 24, filter: `blur(${motionTokens.blur.soft}px)` },
  center: ({ reduce }: StepCustom) => ({ opacity: 1, x: 0, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { x: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .05 }, filter: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter } } }),
  exit: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: direction * -16, filter: `blur(${motionTokens.blur.soft}px)`, transition: { x: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard }, filter: { duration: motionTokens.duration.exit } } },
};
const swap = (reduce: boolean) => ({
  initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.soft}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } },
  transition: (reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }) as Transition,
});

/** The card follows its content on a spring only while the step changes; otherwise it stays auto, so field messages open without lag. */
function useStepHeight(step: Step, reduce: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const measured = useRef(0);
  const gliding = useRef(false);
  const lastStep = useRef(step);
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
    if (lastStep.current === step) return;
    lastStep.current = step;
    const current = height.get();
    const from = typeof current === "number" ? current : measured.current;
    const to = track.current?.offsetHeight ?? 0;
    if (reduce || !from || !to) { gliding.current = false; height.jump("auto"); return; }
    if (current === "auto") height.jump(from);
    glide(to);
  }, [step, reduce, height, glide]);
  return { track, height };
}

export function SignupForm({ onSubmit, serverError, onProvider, providers = [] }: SignupFormProps) {
  const reduce = !!useReducedMotion();
  const feedbackId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const timers = useRef<number[]>([]);
  const [step, setStep] = useState<Step>("form");
  const [direction, setDirection] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [productUpdates, setProductUpdates] = useState(false);
  const [touched, setTouched] = useState<Record<Field, boolean>>({ name: false, email: false, password: false });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<null | "form" | string>(null);
  const [method, setMethod] = useState<string>("Email");
  const [submitError, setSubmitError] = useState("");
  const [status, setStatus] = useState("");
  const { track, height } = useStepHeight(step, reduce);
  const errors = getErrors(name, email, password);
  const score = passwordScore(password);
  const visibleError = (field: Field) => (touched[field] || submitted ? errors[field] : "");
  const passwordError = visibleError("password");
  const custom: StepCustom = { direction, reduce };
  const shownError = submitError || serverError || "";
  const feedback = passwordError ? { key: "error", text: passwordError } : password ? { key: `s${score}`, text: `密码强度：${strengthLabel[Math.max(score, 1)]}` } : { key: "hint", text: "至少 8 位字符。" };

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => { if (step === "done") doneRef.current?.focus(); }, [step]);

  function markTouched(field: Field) {
    setTouched(current => ({ ...current, [field]: true }));
  }

  function finish(how: string) {
    setBusy(null);
    setMethod(how);
    setDirection(1);
    setStep("done");
    setStatus(how === "Email" ? "账号已通过邮箱创建" : `账号已通过 ${how} 创建`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setSubmitError("");
    const nextErrors = getErrors(name, email, password);
    const firstInvalid = (Object.keys(nextErrors) as Field[]).find(field => nextErrors[field]);
    if (firstInvalid) {
      ({ name: nameRef, email: emailRef, password: passwordRef })[firstInvalid].current?.focus();
      return;
    }
    setBusy("form");
    setStatus("正在创建账号");
    try {
      await Promise.all([onSubmit?.({ name: name.trim(), email: email.trim(), password, productUpdates }), new Promise(resolve => window.setTimeout(resolve, 700))]);
      finish("Email");
    } catch (error) {
      setBusy(null);
      setSubmitError(error instanceof Error && error.message ? error.message : "账号创建失败，请重试。");
      setStatus("账号创建失败");
    }
  }

  /**
   * 三方注册：直接整页跳到后端的授权入口。
   *
   * 不做「假装成功、过 900ms 再显示欢迎」那套模拟 ——
   * 这里必须真的去平台，回来时由后端完成建号，
   * 否则用户会看到一个并未真正创建的账号。
   */
  function continueWith(providerKey: string, displayName: string) {
    if (busy) return;
    setBusy(providerKey);
    setStatus(`正在跳转到 ${displayName}`);
    onProvider?.(providerKey);
    // 跳转由父组件触发；失败时（例如被浏览器拦截）恢复按钮可用。
    timers.current.push(window.setTimeout(() => setBusy(null), 4000));
  }

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setProductUpdates(false);
    setTouched({ name: false, email: false, password: false });
    setSubmitted(false);
    setSubmitError("");
    setDirection(-1);
    setStep("form");
    setStatus("请重新填写注册信息");
    timers.current.push(window.setTimeout(() => nameRef.current?.focus(), 60));
  }

  const firstName = name.trim().split(/\s+/)[0] || "there";

  return (
    <section className={styles.block} aria-label="创建 OOAPI 账号">
      <motion.div className={styles.viewport} style={{ height }}>
        <div ref={track} className={styles.track}>
          <AnimatePresence mode="popLayout" initial={false} custom={custom}>
            {step === "form" ? (
              <motion.div key="form" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                <div className={styles.heading}><h2>创建账号</h2><p>填写用户名、邮箱与密码即可开始使用 OOAPI。</p></div>
                {/* 只有在管理员配好并启用了某个平台后，才渲染该按钮 */}
                {providers.length > 0 && <>
                  <div className={styles.sso} role="group" aria-label="使用第三方账号注册">
                    {providers.map(provider => <Button key={provider.key} type="button" variant="secondary" className={styles.ssoButton} aria-label={`使用 ${provider.display_name} 注册`} loading={busy === provider.key} aria-disabled={(!!busy && busy !== provider.key) || undefined} onClick={() => continueWith(provider.key, provider.display_name)}>
                      <ProviderMark providerKey={provider.key} />{provider.display_name}
                    </Button>)}
                  </div>
                  <div className={styles.divider}>或</div>
                </>}
                <form onSubmit={event => void submit(event)} noValidate className={styles.form}>
                  <Input ref={nameRef} label="用户名" name="name" autoComplete="username" placeholder="仅字母、数字、下划线，3–32 位" value={name} onChange={event => setName(event.target.value)} onBlur={() => { if (name) markTouched("name"); }} error={visibleError("name")} readOnly={!!busy} />
                  <Input ref={emailRef} label="邮箱" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@example.com" value={email} onChange={event => setEmail(event.target.value)} onBlur={() => { if (email) markTouched("email"); }} error={visibleError("email")} readOnly={!!busy} />
                  <div className={styles.passwordGroup}>
                    <PasswordField ref={passwordRef} label="密码" name="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} onBlur={() => { if (password) markTouched("password"); }} aria-invalid={passwordError ? true : undefined} aria-describedby={feedbackId} readOnly={!!busy} />
                    <div className={styles.feedback}>
                      <span id={feedbackId} className={styles.feedbackText} data-error={passwordError ? true : undefined} role={passwordError ? "alert" : undefined}>
                        <AnimatePresence mode="popLayout" initial={false}><motion.span key={feedback.key} {...swap(reduce)}>{feedback.text}</motion.span></AnimatePresence>
                      </span>
                      <span className={styles.meter} data-level={score} aria-hidden="true">{[1, 2, 3, 4].map(bar => <span key={bar} data-on={bar <= score || undefined} />)}</span>
                    </div>
                  </div>
                  <div className={styles.updates}><Checkbox label="订阅产品更新邮件" checked={productUpdates} onCheckedChange={checked => setProductUpdates(checked === true)} disabled={!!busy} /></div>
                  <AnimatePresence initial={false}>
                    {shownError && <motion.div key="error" className={styles.row} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
                      <p className={styles.submitError} role="alert">{shownError}</p>
                    </motion.div>}
                  </AnimatePresence>
                  <Button className={styles.wide} type="submit" loading={busy === "form"}>创建账号</Button>
                </form>
              </motion.div>
            ) : (
              <motion.div key="done" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                <svg className={styles.success} viewBox="0 0 48 48" aria-hidden="true">
                  <g transform="rotate(-90 24 24)"><motion.circle cx="24" cy="24" r="22.25" fill="none" stroke="currentColor" strokeWidth="1.5" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: motionTokens.duration.considered, ease: motionTokens.ease.inOut, delay: .16 }, opacity: { duration: motionTokens.duration.instant, delay: .16 } }} /></g>
                  <motion.path d="M15.5 24.5l5.5 5.5 11.5-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { duration: motionTokens.duration.standard + .08, ease: motionTokens.ease.enter, delay: .5 }, opacity: { duration: motionTokens.duration.instant, delay: .5 } }} />
                </svg>
                <div className={styles.heading}><h2 ref={doneRef} tabIndex={-1}>欢迎，{firstName}</h2><p>账号已创建完成，现在可以开始使用了。</p></div>
                <dl className={styles.details}>
                  <div><dt>注册方式</dt><dd>{method === "Email" ? "邮箱与密码" : method}</dd></div>
                  <div><dt>用户名</dt><dd>{name.trim()}</dd></div>
                </dl>
                <Button type="button" variant="secondary" className={styles.wide} onClick={reset}>重新填写</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <footer className={styles.footer}>
        <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
        <span className={styles.status} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}><motion.span key={status} {...swap(reduce)}>{status}</motion.span></AnimatePresence></span>
        <span className={styles.switch}>已有账号？<button type="button" className={styles.textButton} onClick={() => { window.location.href = "/login"; }}>去登录</button></span>
      </footer>
    </section>
  );
}

export default SignupForm;
