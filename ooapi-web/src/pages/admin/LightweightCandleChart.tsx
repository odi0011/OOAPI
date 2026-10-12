import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import styles from "./TradingDesk.module.css";
import type { EngineKline, EngineLevels } from "./tradingApi";
import { referenceLineSpecs, toCandlePoints, type LevelLineKey } from "./candleSeries";

/**
 * 交易台 K 线。只用 TradingView Lightweight Charts，不手搓蜡烛。
 * 蜡烛来自 klines，标记价常驻，有仓时再画 levels 的入场、止损、止盈。
 */

interface LightweightCandleChartProps {
  timeframe: string;
  candles: readonly EngineKline[];
  markPrice?: number;
  levels?: EngineLevels | null;
  /** true 有仓，false 空仓，null 持仓还没读到。 */
  positionOpen: boolean | null;
}

const LINE_COLOR: Record<LevelLineKey, string> = {
  mark: "#2962ff",
  entry: "#f0b90b",
  stop: "#f23645",
  takeProfit: "#089981",
};

interface Palette {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
}

const LIGHT: Palette = {
  background: "#ffffff",
  text: "#131722",
  grid: "#f0f3fa",
  border: "#e0e3eb",
  crosshair: "#9598a1",
  up: "#089981",
  down: "#f23645",
};

const DARK: Palette = {
  background: "#131722",
  text: "#d1d4dc",
  grid: "#2a2e39",
  border: "#2a2e39",
  crosshair: "#758696",
  up: "#089981",
  down: "#f23645",
};

function palette(): Palette {
  return document.documentElement.dataset.theme === "dark" ? DARK : LIGHT;
}

export default function LightweightCandleChart({
  timeframe,
  candles,
  markPrice,
  levels,
  positionOpen,
}: LightweightCandleChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const fittedChart = useRef<IChartApi | null>(null);
  const fitKey = useRef("");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const colors = palette();
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
        horzLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
      localization: { locale: "zh-CN" },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    el.style.background = colors.background;

    const applyTheme = () => {
      const next = palette();
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: next.background },
          textColor: next.text,
        },
        grid: {
          vertLines: { color: next.grid },
          horzLines: { color: next.grid },
        },
        crosshair: {
          vertLine: { color: next.crosshair, labelBackgroundColor: next.crosshair },
          horzLine: { color: next.crosshair, labelBackgroundColor: next.crosshair },
        },
        rightPriceScale: { borderColor: next.border },
        timeScale: { borderColor: next.border },
      });
      series.applyOptions({
        upColor: next.up,
        downColor: next.down,
        borderUpColor: next.up,
        borderDownColor: next.down,
        wickUpColor: next.up,
        wickDownColor: next.down,
      });
      el.style.background = next.background;
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const points = toCandlePoints(candles);
    const data: CandlestickData<UTCTimestamp>[] = points.map((point) => ({
      time: point.time as UTCTimestamp,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
    }));
    const key = timeframe;
    const follow = fittedChart.current === chart && fitKey.current === key && chart.timeScale().scrollPosition() < 2;
    series.setData(data);

    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = referenceLineSpecs({ markPrice, levels, positionOpen }).map((spec) =>
      series.createPriceLine({
        price: spec.price,
        title: spec.title,
        color: LINE_COLOR[spec.key],
        lineWidth: 1,
        lineStyle: spec.key === "mark" ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
      }),
    );

    if (data.length === 0) return;
    if (fittedChart.current !== chart || fitKey.current !== key) {
      chart.timeScale().fitContent();
      fittedChart.current = chart;
      fitKey.current = key;
      return;
    }
    if (follow) chart.timeScale().scrollToPosition(0, false);
  }, [candles, levels, markPrice, positionOpen, timeframe]);

  return (
    <div
      ref={host}
      className={styles.chartHost}
      data-chart-lib="lightweight-charts"
      aria-label={`${timeframe} K 线`}
    />
  );
}
