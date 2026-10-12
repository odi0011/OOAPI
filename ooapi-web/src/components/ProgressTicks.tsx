import { useRef, useState } from "react";

import styles from "./ProgressTicks.module.css";

/* ── 进度刻度 ────────────────────────────────────────────────
   两个数字加一排刻度，仅此而已。

   它原本还带标题、状态标签、一句鼓励话和一个增量胶囊 —— 四段文字
   在解释一根已经说明了自己的横条。它们之所以在那儿，只是因为少了
   它们这块显得太空，而「为了让版面显得完整而写字」是最糟的写字理由：
   一个需要配文才显得完成的组件，是一个还没完成的组件。

   留下的只有刻度本身说不出来的东西 —— 数值，以及「拖动是预览、
   不是确认」这个事实。增量只在拖动时存在，因为静止状态下没有可比较
   的对象。
   ────────────────────────────────────────────────────────── */

/** 默认刻度数。34 根在常见的 340px 卡片里约每根 7px，疏密刚好。 */
const DEFAULT_TICKS = 34;

export interface ProgressTicksProps {
  /** 已完成的比例，0–100。 */
  value: number;
  /** 头部右侧的补充读数，例如「1,257 次 / 目标 2,000」。 */
  caption?: string;
  /** 刻度数量。 */
  ticks?: number;
  /** 容器宽度，默认 340。 */
  width?: number | string;
  className?: string;
}

export default function ProgressTicks({
  value,
  caption,
  ticks = DEFAULT_TICKS,
  width = 340,
  className,
}: ProgressTicksProps) {
  const committed = Math.min(100, Math.max(0, value));
  const [cursor, setCursor] = useState<number | null>(null);
  const shown = cursor === null ? committed : Math.round(((cursor + 1) / ticks) * 100);
  const filled = Math.round((shown / 100) * ticks);
  const delta = shown - committed;

  /* ── 整行读指针，刻度自己不读 ─────────────────────────────
     早先每根刻度各挂一个 onPointerEnter，这是最直观的写法，
     但只在鼠标下成立。触摸会被捕获到它起始的那根刻度上：手指
     沿整行划过，浏览器始终把事件发给第一根，其余的 enter 永远
     不触发，游标就卡住不动。问题不是事件丢了 —— 而是它们全都
     发给了错误的元素。

     改为整行一个处理函数，索引从指针的实际位置算出来。鼠标划过
     第 12 根和手指拖过第 12 根走的是同一条路径，两者不再是两套
     代码。 */
  const row = useRef<HTMLDivElement | null>(null);
  const down = useRef(false);

  const at = (clientX: number) => {
    const b = row.current?.getBoundingClientRect();
    if (!b || !b.width) return null;
    const i = Math.floor(((clientX - b.left) / b.width) * ticks);
    return Math.min(ticks - 1, Math.max(0, i));
  };

  const track = (e: React.PointerEvent) => {
    /* 鼠标悬停即擦除，和它一直以来的行为一致；手指必须按下才响应，
       否则划过的滚动操作会被这一行抢走。 */
    if (e.pointerType !== "mouse" && !down.current) return;
    setCursor(at(e.clientX));
  };

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(" ")}
      style={{ width }}
    >
      <div className={styles.head}>
        <span className={styles.figure}>
          {shown}
          <i>%</i>
        </span>
        {/* 只在拖动时出现，且只在它确实说明问题时出现 */}
        <span className={styles.delta} data-show={cursor !== null && delta !== 0} data-up={delta > 0}>
          {delta > 0 ? "+" : ""}
          {delta}
        </span>
        {caption && <span className={styles.caption}>{caption}</span>}
      </div>

      <div
        className={styles.tickRow}
        ref={row}
        onPointerDown={(e) => {
          down.current = true;
          /* 对未激活的 pointer id 调用会抛异常（脚本触发的按下就是这种），
             而擦除功能本身不依赖它。 */
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 指针不活跃，忽略 */
          }
          setCursor(at(e.clientX));
        }}
        onPointerMove={track}
        onPointerUp={() => {
          down.current = false;
          setCursor(null);
        }}
        onPointerCancel={() => {
          down.current = false;
          setCursor(null);
        }}
        onPointerLeave={() => {
          if (!down.current) setCursor(null);
        }}
      >
        {Array.from({ length: ticks }, (_, i) => (
          <div
            key={i}
            className={styles.tick}
            data-on={i < filled}
            data-cursor={cursor !== null && i === cursor}
            /* 高度 = 基线 52% + 正弦起伏 ±14% + 已完成段抬高 26%。
               起伏让整排看起来像数据而不是进度条，抬高让已完成的部分
               在轮廓上也高出未完成的部分，不必只靠颜色区分。 */
            style={{ height: `${52 + Math.round(Math.sin(i / 3.1) * 14) + (i < filled ? 26 : 0)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
