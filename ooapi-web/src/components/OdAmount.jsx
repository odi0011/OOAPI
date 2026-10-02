import React from "react";
import { OdCoin } from "./OdCoin";
import { fmtOd, odOf, unitsPerOd } from "../services/format";

/** 全站金额：保留原精度，单位始终在数字末尾；未知值不能被格式化成零。 */
export default function OdAmount({ quota, perUnit = unitsPerOd(), digits = 2, children, size = 14, className = "", style }) {
  const known = quota !== null && quota !== undefined && quota !== "" && Number.isFinite(Number(quota));
  const amount = known ? Math.abs(odOf(quota, perUnit)) : 0;
  const precision = amount > 0 && amount < 0.01 ? Math.max(digits, 4) : digits;
  const value = children ?? (known ? fmtOd(quota, perUnit, precision, false) : "—");
  const hasAmount = typeof value === "number" || (typeof value === "string" && /\d/.test(value));
  return <span className={`oo-od-amount ${className}`} style={style}><span className="oo-num">{value}</span>{hasAmount ? <OdCoin size={size} /> : null}</span>;
}

/** 仅转换展示文案；日志原文、复制内容与 Markdown 代码保持原样。 */
export function OdText({ children }) {
  const text = String(children ?? ""), parts = [], pattern = /OD\s*币|(\d[\d,.]*\s*)OD\b/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    parts.push(text.slice(last, match.index), match[1] || "", <OdCoin key={match.index} size={14} />);
    last = pattern.lastIndex;
  }
  return <>{parts}{text.slice(last)}</>;
}
