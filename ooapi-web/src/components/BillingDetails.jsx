import OdAmount from "./OdAmount";
import React, { useState } from "react";
import {  Button, Table, Drawer, Typography  } from "./arc/index";
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
export function BillingDetails({ record, isAdmin = false, perUnit = 10000, compactView = false, hideTitle = false }) {
  const bill = record?.billing_details?.version === 1 ? record.billing_details : null;
  const quotes = (Array.isArray(bill?.calls) ? bill.calls : []).map(c => c?.channel_quote).filter(Boolean);
  const sameQuote = quotes.length === Number(bill?.call_count) && quotes.every(q => q.status === "available" && q.provider === quotes[0]?.provider && q.model === quotes[0]?.model && JSON.stringify(q.price) === JSON.stringify(quotes[0]?.price));
  const channelQuote = bill?.channel_quote || (sameQuote ? quotes[0] : null);
  const charged = record?.billing_known === false ? null : finite(bill?.charged_cost_od) ?? (finite(record?.quota) === null ? null : odOf(record.quota, perUnit));
  const rows = [["input", "输入"], ["output", "输出"], ["cache", "缓存读取"]];
  const raw = finite(bill?.raw_cost_od), base = finite(bill?.base_cost_od);
  const rounding = finite(bill?.pre_rate_rounding_units) !== null ? Number(bill.pre_rate_rounding_units) !== 0 : raw !== null && base !== null && Math.abs(raw - base) > 0.000000001;
  return <div className={`oo-billing-details${compactView ? " oo-billing-details--compact" : ""}`}>
    {!hideTitle ? <div className="oo-billing-heading"><strong>计费明细</strong></div> : null}
    {bill ? <>
      <Table size="small" pagination={false} rowKey="key" dataSource={rows.map(([key,label])=>({key,label,...bill.components?.[key]}))} columns={[
        {title:"类别",dataIndex:"label",width:80},
        {title:"Token",dataIndex:"tokens",align:"right",render:v=>finite(v)===null?"—":Number(v).toLocaleString()},
        {title:"单价 / 百万",key:"price",align:"right",render:(_,item)=>item.mixed?"多档":<OdAmount>{compact(item.unit_price)}</OdAmount>},
        {title:"费用",dataIndex:"cost_od",align:"right",render:v=>odText(v,perUnit)},
      ]}/>
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
  const known = record?.billing_known !== false;
  const quota = finite(record?.quota) ?? 0;
  const emptyFailure = quota === 0 && ["error", "stopped"].includes(record?.status);
  // 计费明细是整行详情之外的第二层信息：只在明确点击时打开 Bottom sheet，
  // 避免鼠标扫过表格就弹层，也避免点击计费时触发行详情。
  // Portal 仍沿 React 树冒泡，拦截层要包含整个抽屉，关闭按钮与遮罩也不能触发行详情。
  return <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <Button type="text" size="small" className="oo-billing-trigger" aria-label="查看计费明细" aria-expanded={open}
      onClick={(event) => { event.stopPropagation(); setOpen(true); }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setOpen(false); if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); } }}>
      {!known ? <span className="oo-log-billing-muted">费用待核查</span> : emptyFailure ? <span className="oo-log-billing-muted">未计费</span> : <OdAmount quota={quota} perUnit={perUnit} digits={4} className="oo-billing-amount" />}
    </Button>
    <Drawer title="计费明细" open={open} placement="bottom" width="100%" className="oo-billing-sheet" onClose={() => setOpen(false)}>
      <BillingDetails record={record} isAdmin={isAdmin} perUnit={perUnit} hideTitle />
    </Drawer>
  </span>;
}
