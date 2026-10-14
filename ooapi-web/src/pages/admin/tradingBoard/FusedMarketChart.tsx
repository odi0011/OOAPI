import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import styles from "../TradingBoard.module.css";
import type { ChartMark, FusedSeries } from "./fusedSeries";

/**
 * 一张图上的全部品种。纵轴是涨跌幅（%），不是价格。
 * 开仓和决策以标记画在对应品种的时间上。
 */

interface FusedMarketChartProps {
  series: readonly FusedSeries[];
  marks: readonly ChartMark[];
  hidden: ReadonlySet<string>;
}

interface Palette {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
}

const LIGHT: Palette = {
  background: "#ffffff",
  text: "#131722",
  grid: "#f0f3fa",
  border: "#e0e3eb",
  crosshair: "#9598a1",
};

const DARK: Palette = {
  background: "#131722",
  text: "#d1d4dc",
  grid: "#2a2e39",
  border: "#2a2e39",
  crosshair: "#758696",
};

function palette(): Palette {
  return document.documentElement.dataset.theme === "dark" ? DARK : LIGHT;
}

export default function FusedMarketChart({ series, marks, hidden }: FusedMarketChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const linesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const markersRef = useRef<Map<string, ISeriesMarkersPluginApi<Time>>>(new Map());
  const fittedKey = useRef("");
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const colors = palette();
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        // 站点默认字体是展示体，数字会糊。时间轴和涨跌幅用正文黑体。
        fontFamily: '"Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
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
      rightPriceScale: {
        borderColor: colors.border,
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        locale: "zh-CN",
        priceFormatter: (price: number) => `${price > 0 ? "+" : ""}${price.toFixed(2)}%`,
      },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
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
      el.style.background = next.background;
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setReady((value) => value + 1);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      linesRef.current.clear();
      markersRef.current.clear();
      fittedKey.current = "";
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || ready === 0) return;

    const alive = new Set(series.map((item) => item.symbol));
    for (const [symbol, line] of linesRef.current) {
      if (alive.has(symbol)) continue;
      chart.removeSeries(line);
      linesRef.current.delete(symbol);
      markersRef.current.delete(symbol);
    }

    for (const item of series) {
      let line = linesRef.current.get(item.symbol);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: item.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        });
        linesRef.current.set(item.symbol, line);
        markersRef.current.set(item.symbol, createSeriesMarkers(line, []));
      }
      line.applyOptions({
        color: item.color,
        visible: !hidden.has(item.symbol),
      });
      const data: LineData<UTCTimestamp>[] = item.points.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
      }));
      line.setData(data);
      const marksForLine = marks
        .filter((mark) => mark.symbol === item.symbol)
        .map((mark) => ({
          time: mark.time as UTCTimestamp,
          position: mark.position,
          color: mark.color,
          shape: mark.shape,
          text: mark.text,
        }));
      markersRef.current.get(item.symbol)?.setMarkers(marksForLine);
    }

    const first = series[0]?.points[0]?.time ?? 0;
    const lastSeries = series[0];
    const last = lastSeries ? lastSeries.points[lastSeries.points.length - 1]?.time ?? 0 : 0;
    const key = `${series.map((item) => item.symbol).join(",")}:${first}:${last}`;
    if (fittedKey.current !== key && series.some((item) => item.points.length > 0)) {
      chart.timeScale().fitContent();
      fittedKey.current = key;
    }
  }, [series, marks, hidden, ready]);

  return (
    <div
      ref={host}
      className={styles.fusedHost}
      data-chart-lib="lightweight-charts"
      data-chart-kind="fused-returns"
      aria-label="全部品种融合涨跌幅"
    />
  );
}
