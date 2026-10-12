import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import Button from "@/components/arc/button/button";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { PROVIDERS } from "./ProviderWell";
import styles from "./ModelActivity.module.css";

const ENTRIES = [
  { key: "openai", label: "GPT-6.1 Sol", values: [28, 35, 39, 44, 49, 57, 63] },
  { key: "claude", label: "Claude Sonnet 5.5", values: [39, 42, 41, 46, 52, 59, 61] },
  { key: "deepseek", label: "DeepSeek V4.1 Flash", values: [19, 21, 29, 35, 46, 56, 67] },
  { key: "kimi", label: "Kimi K3", values: [18, 23, 26, 31, 34, 40, 48] },
  { key: "grok", label: "Grok 4.7", values: [12, 13, 18, 24, 29, 32, 39] },
];
const HOURS = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"];
const REQUEST_STAGES = [
  { name: "网关请求", value: 342800, details: "收到应用发出的模型请求" },
  { name: "通过认证", value: 341950, details: "验证令牌与模型权限" },
  { name: "上游响应", value: 341420, details: "账号完成模型推理" },
  { name: "调用完成", value: 341168, details: "流式与非流式响应交付" },
];

export function ModelRace() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [unit, setUnit] = useState("calls");
  const region = useRef<HTMLElement>(null);
  const inView = useInView(region, { amount: .35 });
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!playing || !inView || reduced) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % HOURS.length), 2400);
    return () => clearInterval(timer);
  }, [playing, inView, reduced]);
  const multiplier = unit === "calls" ? 1000 : 2280000;
  const rows = ENTRIES.map((entry) => ({ ...entry, value: entry.values[frame] * multiplier })).sort((a, b) => b.value - a.value);
  const maximum = rows[0].value;
  const format = (value: number) => unit === "calls" ? value.toLocaleString("en-US") : (value / 1000000).toFixed(1) + "M";
  const step = (direction: number) => { setPlaying(false); setFrame((current) => (current + direction + HOURS.length) % HOURS.length); };
  return <article className={styles.panel} ref={region} aria-label="模型调用排行">
    <div className={styles.heading}><h3>模型调用排行</h3><span>{HOURS[frame]}</span></div>
    <div className={styles.controls}><SegmentedControl options={[{ value: "calls", label: "调用量" }, { value: "tokens", label: "Tokens" }]} value={unit} onValueChange={setUnit} label="排行指标" /><div><Button variant="ghost" size="sm" aria-label="上一时段" onClick={() => step(-1)}><ChevronLeft size={15} /></Button><Button variant="ghost" size="sm" aria-label={playing ? "暂停排行" : "播放排行"} onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={14} /> : <Play size={14} />}</Button><Button variant="ghost" size="sm" aria-label="下一时段" onClick={() => step(1)}><ChevronRight size={15} /></Button></div></div>
    <ol className={styles.raceList}>{rows.map((entry, index) => <motion.li key={entry.key} layout={reduced ? false : "position"} transition={{ type: "spring", stiffness: 140, damping: 24 }}>
      <span className={styles.rank}>{index + 1}</span><img src={PROVIDERS.find((provider) => provider.id === entry.key)?.icon} alt="" />
      <div className={styles.barRow}><div><span>{entry.label}</span><strong>{format(entry.value)}</strong></div><div className={styles.track}><motion.span animate={{ width: (entry.value / maximum * 100) + "%" }} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 100, damping: 22 }} style={{ background: "var(--series-" + ((ENTRIES.findIndex((item) => item.key === entry.key) % 4) + 1) + ")" }} /></div></div>
    </motion.li>)}</ol>
    <div className={styles.timeline}><span>08:00</span><input type="range" min={0} max={HOURS.length - 1} step={1} value={frame} aria-label="排行时段" onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} /><span>20:00</span></div>
    <div className={styles.panelFooter}><span>Top 5</span><strong>{format(rows.reduce((sum, entry) => sum + entry.value, 0))} <small>{unit === "calls" ? "次请求" : "Tokens"}</small></strong></div>
  </article>;
}

export function RequestFunnel() {
  const [active, setActive] = useState(3);
  const reduced = useReducedMotion();
  const first = REQUEST_STAGES[0].value;
  const rate = (REQUEST_STAGES[3].value / first * 100).toFixed(2);
  const widths = [312, 262, 215, 169, 133];
  return <article className={styles.panel} aria-label="请求处理漏斗">
    <div className={styles.heading}><h3>请求处理</h3><span>过去 24 小时</span></div>
    <div className={styles.funnelSummary}><strong>{rate}<small>%</small></strong><span>请求完成率</span></div>
    <div className={styles.funnelBody}><svg viewBox="0 0 360 230" role="img" aria-label="从网关请求到调用完成的四个处理阶段">
      {REQUEST_STAGES.map((stage, index) => {
        const top = 12 + index * 48;
        const left = (360 - widths[index]) / 2;
        const right = (360 + widths[index]) / 2;
        const bottomLeft = (360 - widths[index + 1]) / 2;
        const bottomRight = (360 + widths[index + 1]) / 2;
        const path = "M" + left + " " + top + "H" + right + "L" + bottomRight + " " + (top + 41) + "H" + bottomLeft + "Z";
        return <g key={stage.name} onPointerEnter={() => setActive(index)}>
          <motion.path d={path} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .4, delay: index * .09 }} fill={index === active ? "var(--accent)" : "color-mix(in oklab, var(--accent) " + (12 + index * 11) + "%, var(--surface-muted))"} />
          <text x="180" y={top + 25} textAnchor="middle" fill={index === active ? "var(--accent-foreground)" : "var(--text-secondary)"}>{stage.name}</text>
        </g>;
      })}
    </svg><div className={styles.stageList}>{REQUEST_STAGES.map((stage, index) => <button type="button" key={stage.name} aria-pressed={index === active} onClick={() => setActive(index)} onFocus={() => setActive(index)}><span>{stage.name}</span><strong>{stage.value.toLocaleString("en-US")}</strong><small>{(stage.value / first * 100).toFixed(2)}%</small></button>)}</div></div>
    <div className={styles.funnelDetail} aria-live="polite"><span>{REQUEST_STAGES[active].details}</span><ArrowRight size={14} /></div>
    <div className={styles.panelFooter}><span>已完成</span><strong>{REQUEST_STAGES[3].value.toLocaleString("en-US")} <small>次请求</small></strong></div>
  </article>;
}
