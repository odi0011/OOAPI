import OdAmount from "./OdAmount";
import React, { useRef, useState } from "react";
import { Button, Grid, Popover, Typography } from "antd";
import { fmtOd, odOf } from "../services/format";
import "./billing.css";

const finite = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const compact = (value, digits = 8) => finite(value) === null ? "—" : Number(value).toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
const odText = (value, perUnit) => finite(value) === null ? "—" : <OdAmount>{fmtOd(Number(value) * perUnit, perUnit, 12, false).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")}</OdAmount>;
const safeUrl = (value) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
};

function PriceList({ price }) {
  const value = (number) => finite(number) === null ? "未知" : <OdAmount>{compact(number)}</OdAmount>;
  return <div className="oo-billing-prices">
    <span>输入 <b>{value(price?.in)}</b></span>
    <span>输出 <b>{value(price?.out)}</b></span>
    <span>缓存读取 <b>{value(price?.cache)}</b></span>
  </div>;
}

function ChannelQuote({ quote }) {
  const available = quote?.status === "available" && quote?.currency === "USD" && quote?.price;
  const doc = safeUrl(quote?.url);
  const source = { channel_free_sku: "渠道标明的免费 SKU", official_channel_published: "该渠道官方公布价", channel_catalog: "渠道模型目录价" }[quote?.source];
  if (!available) return null;
  return <div className="oo-billing-channel">
    <div className="oo-billing-section-title">渠道原始报价 <span>每百万 Token</span></div>
    {available ? <>
      {quote.model ? <div className="oo-billing-sku">SKU <span>{quote.model}</span></div> : null}
      <PriceList price={quote.price} />
    </> : <div className="oo-billing-note">{quote?.status === "credits" ? "未知：该渠道按积分计费，未取得可核对的货币单价。" : "未知：该记录未取得实际渠道 SKU 的报价。"}</div>}
    {source ? <div className="oo-billing-note">{source} · 调用时保存</div> : null}
    {doc ? <Typography.Link href={doc} target="_blank" rel="noopener noreferrer">查看渠道文档 ↗</Typography.Link> : !available ? <div className="oo-billing-note">请查阅该渠道文档；模型原厂价不能代替渠道报价。</div> : null}
  </div>;
}

/** 只展示服务端保存的账单，不根据当前模型价或旧 SKU 价格重新算费。 */
export function BillingDetails({ record, isAdmin = false, perUnit = 10000, compactView = false }) {
  const bill = record?.billing_details?.version === 1 ? record.billing_details : null;
  const quotes = (Array.isArray(bill?.calls) ? bill.calls : []).map(c => c?.channel_quote).filter(Boolean);
  const sameQuote = quotes.length === Number(bill?.call_count) && quotes.every(q => q.status === "available" && q.provider === quotes[0]?.provider && q.model === quotes[0]?.model && JSON.stringify(q.price) === JSON.stringify(quotes[0]?.price));
  const channelQuote = bill?.channel_quote || (sameQuote ? quotes[0] : null);
  const charged = record?.billing_known === false ? null : finite(bill?.charged_cost_od) ?? (finite(record?.quota) === null ? null : odOf(record.quota, perUnit));
  const rows = [["input", "输入"], ["output", "输出"], ["cache", "缓存读取"]];
  const raw = finite(bill?.raw_cost_od), base = finite(bill?.base_cost_od);
  const rounding = finite(bill?.pre_rate_rounding_units) !== null ? Number(bill.pre_rate_rounding_units) !== 0 : raw !== null && base !== null && Math.abs(raw - base) > 0.000000001;
  return <div className={`oo-billing-details${compactView ? " oo-billing-details--compact" : ""}`}>
    <div className="oo-billing-heading"><strong>计费明细</strong></div>
    {bill ? <>
      <table className="oo-billing-breakdown">
        <thead><tr><th>类别</th><th>Token</th><th>单价 / 百万</th><th>费用</th></tr></thead>
        <tbody>{rows.map(([key, label]) => {
          const item = bill.components?.[key];
          return <tr key={key}><th>{label}</th><td>{finite(item?.tokens) === null ? "—" : Number(item.tokens).toLocaleString()}</td><td>{item?.mixed ? "多档" : <OdAmount>{compact(item?.unit_price)}</OdAmount>}</td><td>{odText(item?.cost_od, perUnit)}</td></tr>;
        })}</tbody>
      </table>
      {bill.price_mode === "mixed" ? <div className="oo-billing-mixed">
        <div className="oo-billing-section-title">本次实际单价 <span>每百万 Token</span></div>
        {rows.map(([key, label]) => <div key={key}><span>{label}</span><b>{bill.platform_unit_prices?.[key]?.length ? bill.platform_unit_prices[key].map((value, index) => <React.Fragment key={index}>{index ? " / " : ""}<OdAmount>{compact(value)}</OdAmount></React.Fragment>) : "未保存"}</b></div>)}
      </div> : null}
      <div className="oo-billing-note">输入量不含缓存读取；单价采用本次调用保存的平台计费价。</div>
      {Number(bill.call_count) > 1 ? <div className="oo-billing-note">合计 {bill.call_count} 次模型调用，各次费用分别计价后汇总。</div> : null}
      <div className="oo-billing-totals">
        <div><span>原始费用</span><b>{odText(raw, perUnit)}</b></div>
        {rounding ? <div><span>倍率前计费额 <small>取整后</small></span><b>{odText(base, perUnit)}</b></div> : null}
        <div><span>分组倍率</span><b>{finite(bill.multiplier) === null ? "—" : `× ${compact(bill.multiplier, 6)}`}</b></div>
        <div className="oo-billing-charged"><span>用户扣费</span><b>{charged === null ? "待核查" : odText(charged, perUnit)}</b></div>
      </div>
      {bill.price_quoted ? <div className="oo-billing-note">本次未产生计费消耗，单价为请求报价。</div> : null}
    </> : <>
      <div className="oo-billing-note">该记录未保存费用分解、单价与倍率快照；不按当前价格回填。</div>
      <div className="oo-billing-totals"><div className="oo-billing-charged"><span>用户扣费</span><b>{charged === null ? "待核查" : odText(charged, perUnit)}</b></div></div>
      {isAdmin && record?.effective_price ? <div className="oo-billing-channel"><div className="oo-billing-section-title">已保存的平台单价 <span>每百万 Token</span></div><PriceList price={record.effective_price} /></div> : null}
    </>}
    {isAdmin ? <ChannelQuote quote={channelQuote} /> : null}

  </div>;
}

/** 真正的按钮保证触屏与键盘可用，事件留在计费入口，不误开整行详情。 */
export function BillingAmount({ record, isAdmin = false, perUnit = 10000 }) {
  const [open, setOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const popupContent = useRef(null);
  const known = record?.billing_known !== false;
  const quota = finite(record?.quota) ?? 0;
  const emptyFailure = quota === 0 && ["error", "stopped"].includes(record?.status);
  // 触屏会合成鼠标事件，窄屏只由点击开关；键盘用 Enter/空格打开，避免焦点与点击互相切换。
  return <Popover content={<div ref={popupContent} onClick={(event) => event.stopPropagation()} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setOpen(false); }}><BillingDetails record={record} isAdmin={isAdmin} perUnit={perUnit} compactView /></div>} trigger={screens.md ? ["hover", "click"] : ["click"]} open={open} onOpenChange={setOpen} rootClassName="oo-billing-popover" placement="top" arrow={false} align={{ offset: [0, 0] }}>
    <Button type="text" size="small" className="oo-billing-trigger" aria-label="查看计费明细" aria-expanded={open} onBlur={(event) => { if (!popupContent.current?.contains(event.relatedTarget)) setOpen(false); }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setOpen(false); if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); } }}>
      {!known ? <span className="oo-log-billing-muted">费用待核查</span> : emptyFailure ? <span className="oo-log-billing-muted">未计费</span> : <OdAmount quota={quota} perUnit={perUnit} digits={4} className="oo-billing-amount" />}
    </Button>
  </Popover>;
}
