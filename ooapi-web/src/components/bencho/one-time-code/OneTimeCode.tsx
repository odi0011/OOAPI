import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import styles from "./OneTimeCode.module.css";

/* ══ One-time code ════════════════════════════════════════
   Six small cells and a caret. Digits rise into their cells;
   a right code draws the cells together until they fuse into
   one capsule that says so, and a wrong one sends a shiver
   down the row and drains the digits out.

   ── SIX CELLS, ONE FIELD ────────────────────────────────
   The same call the sign-in sheet makes, for the same reasons:
   six real inputs break paste, autofill from the notification,
   backspace and screen readers. So there is one invisible
   input over the row and the cells are drawn underneath it.

   ── THE MERGE IS THE GOO'S ──────────────────────────────
   The cells sit under a blur-and-threshold filter, far enough
   apart that it never bridges them. Verifying slides them to
   the middle while a capsule grows out of the same point: as
   they close, the filter joins them, and what is left is one
   shape. Nobody draws the in-between — it is the filter
   deciding when two things are close enough to be one.

   ── THE ANSWER IS A KNOB ────────────────────────────────
   A code nobody on the wall can know is not a demonstration.
   Accept and Reject are the two things the component does
   with a full row, so the panel picks which one you see. */

/* ── inlined from lab/motionkit ──────────────────────── */
/* ══ liquid ═══════════════════════════════════════════════
   Shared parts for the Framer Motion layer: one spring, one
   goo filter, one velocity→skew binding.

   ── why the filter is a hook ────────────────────────────
   The filter is embedded in each component's own return, but
   its id CANNOT be a literal. Every block here renders twice
   at once — once in the wall card, once in the detail overlay
   — and duplicate SVG ids do not scope, they collide: the
   second instance silently steals the first one's filter.
   useId() gives each mount its own name.

   ── what the goo can and cannot do ──────────────────────
   This is feGaussianBlur + feColorMatrix, not a shader. The
   matrix multiplies alpha by `cut` and subtracts half of it,
   so alpha below 0.5 lands on zero and everything above 0.536
   is fully opaque. That hard edge is what fuses nearby shapes
   into one blob — and it is also why this must never touch
   text: glyph antialiasing lives entirely below 0.5, so type
   under this filter loses its edges and then itself. */

function useGoo(blur = 7, cut = 28) {
  /* useId yields ":r0:" — legal in an id attribute but not in
     a url(#…) reference, so strip the colons. */
  const id = `goo-${useId().replace(/:/g, "")}`;
  const goo = (
    <svg className={styles["liq-defs"]} aria-hidden="true" focusable="false">
      <defs>
        <filter
          id={id}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="smear" />
          <feColorMatrix
            in="smear"
            type="matrix"
            values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${cut} ${-(cut / 2)}`}
          />
        </filter>
      </defs>
    </svg>
  );
  return { id, url: `url(#${id})`, goo };
}

/* ── inlined from lab/spring ──────────────────────── */
/* ── one spring, for everything that settles ───────────────
   The maths was already on this bench twice, copied by hand:
   Humidity's wheel and Brightness's column both accumulate
   velocity toward a target, damp it, and snap when both the
   delta and the velocity fall under 0.02. Two copies is a
   coincidence; five would be a policy, so it comes out here
   before the elastic blocks are written against it.

   The two shipped copies are deliberately NOT refactored onto
   this. They work, they are tuned, and rewriting the innards
   of two live components to prove a point about duplication
   is how a good afternoon becomes a bad one. This is the one
   new code uses.

   Frames, not milliseconds. `dt` is expressed in sixtieths of
   a second and the damping is RAISED to it rather than
   multiplied by it, so a dropped frame decays the same amount
   of energy as the two frames it replaced. Multiplying is the
   version that makes a spring behave differently on a busy
   page, which is the hardest kind of bug to see.

   The loop parks itself the moment the value has settled.
   CLAUDE.md is not complimentary about the one permanent
   requestAnimationFrame already on this bench and there is no
   case for five more. */

/* Read once, the way the wheel and the pill nav do. A
   preference, not a live input. */
const stillness = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* how long a cell takes to swell and settle when a digit lands */
const POP_MS = 260;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const u = clamp((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/* a cell, and the air between two */
const W = 36;
const H = 44;
const G = 7;
/* the capsule a right code becomes */
const CAP = 128;
/* ── the merge is a SPRING, not a tween ─────────────────
   It was a 560ms ease-in-out, which arrived and stopped. A
   spring a little under critical lets the capsule run past its
   size and come back — stretching long and thin on the way out
   and settling round — which is what makes the fuse read as
   liquid rather than as boxes sliding. Per frame at 60Hz, from
   a stiffness and a damping ratio, as spring.ts does. */
const MERGE = (() => {
  const k = 0.075;
  const zeta = 0.42;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();
const SHAKE_MS = 620;

type Phase = "type" | "check" | "ok" | "no";

export type OneTimeCodeStatus = "idle" | "verifying" | "success" | "error";

export interface OneTimeCodeProps {
  value: string;
  onChange: (value: string) => void;
  status?: OneTimeCodeStatus;
  length?: 4 | 6;
  corner?: number;
  label?: string;
  description?: string;
  error?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

/* The source's Accept / Reject knob was a demonstration.
   Production state comes only from the parent's asynchronous
   verifier: reaching six digits does not verify the code. */
export function OneTimeCode({
  value,
  onChange,
  status = "idle",
  /* how many digits, 4 or 6 */
  length = 6,
  /* the cells' corner, px; the capsule wears the same one */
  corner = 12,
  label = "验证码",
  description,
  error,
  autoFocus = false,
  disabled = false,
  className,
}: OneTimeCodeProps) {
  const n = length === 4 ? 4 : 6;
  const r = clamp(corner, 0, H / 2);
  const rowW = n * W + (n - 1) * G;
  const still = stillness();

  const fieldId = useId();
  const code = value.replace(/\D/g, "").slice(0, n);
  const phase: Phase = status === "verifying" ? "check" : status === "success" ? "ok" : status === "error" ? "no" : "type";
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const previous = useRef({ code, status });
  const [focus, setFocus] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  /* moving parts, read by the loop */
  const caret = useRef({ x: W / 2, v: 0 });
  /* when each cell last took a digit — for the little swell */
  const popAt = useRef<number[]>([]);
  const merge = useRef({ m: 0, v: 0, to: 0 });
  const shook = useRef(0);
  const raf = useRef(0);
  const [, setTick] = useState(0);
  const live = useRef({ code, n, phase });
  live.current = { code, n, phase };

  /* ── the one loop ────────────────────────────────────────
     Runs while something moves and stops itself after, so a
     row nobody is typing into costs nothing. */
  const wake = () => {
    if (raf.current) return;
    let prev = 0;
    const tick = (t: number) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      let busy = false;
      const { code: c, n: count, phase: currentPhase } = live.current;

      /* the caret, on a spring with a little give */
      const target = Math.min(c.length, count - 1) * (W + G) + W / 2;
      const k = caret.current;
      if (still) { k.x = target; k.v = 0; }
      else {
        k.v += (target - k.x) * 0.2 * dt;
        k.v *= Math.pow(0.62, dt);
        k.x += k.v * dt;
        if (Math.abs(target - k.x) < 0.05 && Math.abs(k.v) < 0.05) { k.x = target; k.v = 0; }
        else busy = true;
      }

      /* the merge, sprung */
      const mg = merge.current;
      if (mg.m !== mg.to || mg.v !== 0) {
        if (still) { mg.m = mg.to; mg.v = 0; }
        else {
          mg.v += (mg.to - mg.m) * MERGE.k * dt;
          mg.v *= Math.pow(MERGE.d, dt);
          mg.m += mg.v * dt;
          if (Math.abs(mg.to - mg.m) < 0.0008 && Math.abs(mg.v) < 0.0008) { mg.m = mg.to; mg.v = 0; }
          else busy = true;
        }
      }

      if (t - shook.current < SHAKE_MS + n * 45 + 200) busy = true;
      if (currentPhase === "check" && !still) busy = true;

      setTick((x) => x + 1);
      /* a cell still swelling from a digit keeps the loop alive */
      if (popAt.current.some((at) => t - at < POP_MS)) busy = true;
      raf.current = busy ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);
  useEffect(() => { wake(); }, [code, n, phase]);

  const fuse = (to: 0 | 1) => {
    merge.current = { ...merge.current, to };
    wake();
  };

  /* External status is authoritative. Error shivers do not
     schedule a success or an automatic retry. Resetting the
     parent's status splits the capsule back into its cells. */
  useEffect(() => {
    if (status === "error" && previous.current.status !== "error") {
      shook.current = performance.now();
      input.current?.focus();
      input.current?.select();
    }
    if (status === "success") input.current?.blur();
    previous.current.status = status;
    fuse(status === "success" ? 1 : 0);
  }, [status]);

  /* each new digit swells its cell — a paste runs along the row */
  useEffect(() => {
    const before = previous.current.code;
    if (!still && code.length > before.length) {
      const t0 = performance.now();
      for (let i = before.length; i < code.length; i++) popAt.current[i] = t0 + (i - before.length) * 45;
    }
    previous.current.code = code;
    wake();
  }, [code]);

  useEffect(() => {
    if (autoFocus && !disabled) input.current?.focus();
  }, [autoFocus, disabled]);

  const changeCode = (raw: string) => {
    if (disabled || phase === "check" || phase === "ok") return;
    onChange(raw.replace(/\D/g, "").slice(0, n));
  };

  /* ── where everything is this frame ──────────────────────── */
  const now = performance.now();
  /* the raw spring runs past 0 and 1; the cells' travel is
     clamped to it, and only the capsule is allowed to take the
     overshoot, as a stretch */
  const raw = merge.current.m;
  const m = clamp(raw, 0, 1);
  const em = m;
  const home = (i: number) => i * (W + G);
  const mid = (rowW - W) / 2;
  const since = now - shook.current;
  const shaking = phase === "no" && since < SHAKE_MS && !still;
  const shake = (i: number) =>
    shaking ? 5 * Math.exp(-since / 190) * Math.sin((since / 1000) * Math.PI * 2 * 10 + i * 0.55) : 0;
  const cellX = (i: number) => mix(home(i), mid, em) + shake(i);
  /* ── a digit arriving ─────────────────────────────────────
     The cell that takes it swells a touch and settles: up and
     back on one half-sine, four per cent at the top. Small on
     purpose — it is an acknowledgement, not an event. */
  const pop = (i: number) => {
    const at = popAt.current[i];
    if (at === undefined) return 1;
    const u = (now - at) / POP_MS;
    return u > 0 && u < 1 ? 1 + 0.04 * Math.sin(Math.PI * u) : 1;
  };
  /* checking: a soft wave of breath through the cells */
  const breath = (i: number) => {
    if (phase !== "check" || still) return pop(i);
    const u = ((now % 900) / 900) * (n + 2) - i;
    return 1 - 0.07 * (u > 0 && u < 2 ? Math.sin((u / 2) * Math.PI) : 0);
  };
  const over = raw - 1;
  /* long and thin past its size, round again as it settles:
     width and height trade, so it reads as one soft thing */
  const capW = CAP * smooth(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.9);
  const capSy = 1 - Math.max(-0.12, over) * 0.55;
  /* cells round off into the capsule's pill as they close in,
     so the two shapes agree by the time the goo joins them */
  const cellR = mix(r, H / 2, smooth(0.15, 0.7, m));
  const typing = phase === "type" && focus;

  const { url, goo } = useGoo(3, 24);

  return (
    <div className={[styles.fieldGroup, className].filter(Boolean).join(" ")}>
      {label && <label className={styles.label} htmlFor={fieldId}>{label}</label>}
      {description && <p className={styles.description} id={descriptionId}>{description}</p>}
      <div className={styles["otp"]} data-phase={phase} data-disabled={disabled || undefined} aria-busy={status === "verifying" || undefined}>
      <div className={styles["otp-row"]} style={{ width: rowW, height: H }}>
        {/* the cells and the capsule: one colour, under the filter */}
        <div className={styles["otp-goo"]} aria-hidden="true" style={{ filter: still ? undefined : url }}>
          {Array.from({ length: n }, (_, i) => (
            <span
              key={i}
              className={styles["otp-cell"]}
              style={{
                width: W,
                borderRadius: cellR,
                transform: `translateX(${cellX(i).toFixed(2)}px) scale(${breath(i).toFixed(3)})`,
              }}
            />
          ))}
          {capW > 0.5 && (
            <span
              className={styles["otp-cell"]}
              /* always a full pill — the capsule is a result, not
                 a cell, and wears the rounded shape whatever the
                 Corner knob says the cells are */
              style={{
                width: capW,
                borderRadius: H / 2,
                transform: `translateX(${((rowW - capW) / 2).toFixed(2)}px) scaleY(${capSy.toFixed(3)})`,
              }}
            />
          )}
        </div>

        {/* the digits — an empty cell is just the cell */}
        {Array.from({ length: n }, (_, i) => {
          const d = code[i];
          const x = cellX(i);
          /* a wrong code drains right to left */
          const out = phase === "no" && !still ? smooth(0, 1, (since - 300 - (n - 1 - i) * 45) / 220) : 0;
          return (
            <span
              key={i}
              className={styles["otp-slot"]}
              style={{
                width: W,
                transform: `translateX(${x.toFixed(2)}px)`,
                opacity: 1 - smooth(0, 0.45, m),
              }}
            >
              {d && (
                <span
                  key={`${i}-${d}`}
                  className={styles["otp-digit"]}
                  style={{ translate: `0 ${(out * 8).toFixed(2)}px`, opacity: 1 - out }}
                >
                  {d}
                </span>
              )}
            </span>
          );
        })}

        {/* the caret, stretched by its own speed */}
        <i
          className={styles["otp-caret"]}
          /* not until the cells have come apart again, or it
             stands in an empty slot the capsule is still on */
          data-on={typing && code.length < n && m < 0.08}
          style={{
            transform: `translateX(${(caret.current.x - 1).toFixed(2)}px) scaleX(${(1 + Math.min(5, Math.abs(caret.current.v) * 0.9)).toFixed(3)})`,
          }}
        />

        {/* what the capsule says */}
        <span className={styles["otp-ok"]} aria-hidden="true" style={{ opacity: smooth(0.72, 1, m), scale: `${mix(0.92, 1, smooth(0.72, 1, m))}` }}>
          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
          已验证
        </span>

        <input
          ref={input}
          id={fieldId}
          name="verification-code"
          className={styles["otp-field"]}
          value={code}
          onChange={(e) => changeCode(e.target.value)}
          onPaste={(e) => { e.preventDefault(); changeCode(e.clipboardData.getData("text")); }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={n}
          readOnly={phase === "check" || phase === "ok"}
          disabled={disabled}
          aria-label={label || `${n} 位验证码`}
          aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}
          aria-invalid={status === "error" || !!error || undefined}
          spellCheck={false}
        />
      </div>
        {goo}
      </div>
      {error && <p className={styles.error} id={errorId} role="alert">{error}</p>}
      <span className={styles.srOnly} role="status" aria-live="polite">{status === "verifying" ? "正在验证验证码" : status === "success" ? "验证码已验证" : ""}</span>
    </div>
  );
}


export default OneTimeCode;
