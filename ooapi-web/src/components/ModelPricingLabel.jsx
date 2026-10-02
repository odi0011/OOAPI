import React from "react";
import { Tooltip } from "antd";
import { ModelLabel } from "./VendorIcon";

export default function ModelPricingLabel({ model, vendor, tiers, size = 15 }) {
  return <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
    {/* 价格目录描述模型原厂；这里的 vendor 不是一次实际调用的渠道来源。 */}
    <ModelLabel model={model} channelType={vendor} catalog size={size} />
    {tiers?.length ? <Tooltip title={<div>
      <div>{tiers.some((t) => !t.from) ? "长上下文按整次调用选择单价" : "按调用开始时间选择单价"}（OD币 / 百万 Token）</div>
      {tiers.map((t) => <div key={t.from || t.minInputTokens} style={{ marginTop: 6 }}>
        {t.from ? `${t.from.slice(0, 10)} 起（UTC）` : `输入 ≥ ${Number(t.minInputTokens).toLocaleString()} Token`}：输入 {t.input} · 输出 {t.output} · 缓存 {t.cache ?? "—"}
      </div>)}
    </div>}><span style={{ fontSize: 11, color: "var(--ink-3)", cursor: "help", whiteSpace: "nowrap" }}>分档</span></Tooltip> : null}
  </span>;
}
