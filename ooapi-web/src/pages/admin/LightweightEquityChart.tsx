import { useEffect, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import styles from "./TradingDesk.module.css";
import type { EquityMarker, EquityPoint } from "./tradingApi";

/**
 * 权益 / 余额曲线。软面积线 + 紧凑十字线，不用大块粉色 tooltip。
 * 默认展示服务端下发的近 2 小时点；开平标记画在时间轴上方。
 */

interface LightweightEquityChartProps {
  points: readonly EquityPoint[];
  markers?: readonly EquityMarker[];
}

interface Palette {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  line: string;
  top: string;
  bottom: string;
}

const LIGHT: Palette = {
  background: "#ffffff",
  text: "#131722",
  grid: "#f0f3fa",
  border: "#e0e3eb",
  crosshair: "#9598a1",
  line: "#2962ff",
  top: "rgba(41, 98, 255, 0.28)",
  bottom: "rgba(41, 98, 255, 0.02)",
};

const DARK: Palette = {
  background: "#131722",
  text: "#d1d4dc",
  grid: "#2a2e39",
  border: "#2a2e39",
  crosshair: "#758696",
  line: "#5b8def",
  top: "rgba(91, 141, 239, 0.28)",
  bottom: "rgba(91, 141, 239, 0.02)",
};

function palette(): Palette {
  return document.documentElement.dataset.theme === "dark" ? DARK : LIGHT;
}

export default function LightweightEquityChart({ points, markers = [] }: LightweightEquityChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fittedKey = useRef("");

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
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: colors.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: colors.line,
        },
        horzLine: {
          color: colors.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: colors.line,
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: colors.line,
      topColor: colors.top,
      bottomColor: colors.bottom,
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    const onResize = () => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const markerApi = markersRef.current;
    if (!chart || !series) return;
    const data = points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.equity))
      .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.equity }));
    series.setData(data);

    const marks = markers
      .filter((m) => Number.isFinite(m.t))
      .map((m) => {
        const long = (m.side ?? "").toLowerCase().includes("long") || m.side === "多";
        const open = m.kind === "open";
        return {
          time: Math.floor(m.t / 1000) as UTCTimestamp,
          position: open ? ("belowBar" as const) : ("aboveBar" as const),
          color: long ? "#089981" : "#f23645",
          shape: open ? ("arrowUp" as const) : m.kind === "close" ? ("arrowDown" as const) : ("circle" as const),
          text: markerText(m),
        };
      });
    markerApi?.setMarkers(marks);

    const key = `${data.length}:${data[0]?.time ?? 0}:${data[data.length - 1]?.time ?? 0}`;
    if (fittedKey.current !== key) {
      chart.timeScale().fitContent();
      fittedKey.current = key;
    }
  }, [points, markers]);

  return (
    <div
      ref={host}
      className={`${styles.chartHost} ${styles.equityChartHost}`}
      data-chart-lib="lightweight-charts"
      data-chart-kind="equity"
    />
  );
}

function markerText(m: EquityMarker): string {
  const sym = (m.symbol ?? "").replace(/USDT$/i, "");
  const kind =
    m.kind === "open" ? "开" : m.kind === "close" ? "平" : m.kind === "adjust" ? "调" : m.kind;
  const side = (m.side ?? "").toLowerCase().includes("short") || m.side === "空" ? "空" : m.side ? "多" : "";
  return [sym, side, kind].filter(Boolean).join(" ");
}
