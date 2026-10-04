import React from "react";
import { errorInfo } from "../../../ooapi-server/src/services/error-codes.js";
import "./log-diagnostic-details.css";

export function ErrorCodeText({ code, compact = false }) {
  const info = errorInfo(code);
  return <span className={`oo-error-explanation${compact ? " is-compact" : ""}`}>
    <span>{info.title}{info.code ? <code>{info.code}</code> : null}</span>
    {!compact && <><span className="oo-error-meaning">{info.meaning}</span><span className="oo-error-action">排查：{info.action}</span></>}
  </span>;
}

const labels = {
  code: "系统错误", error_code: "系统错误", requestId: "请求 ID", request_id: "请求 ID", http_status: "HTTP 状态", upstream_error_code: "上游错误编号", upstream_code: "上游错误编号", reason: "分类原因",
  endpoint_attempts: "端点尝试", inbound_endpoint: "入站端点", upstream_endpoints: "上游路径", endpoint: "端点", protocol: "协议", status: "状态", retry_count: "重试次数",
  client_agent: "调用 Agent", agent_routing: "Agent 路由规则", id: "编号", version: "版本", source: "识别来源", confidence: "识别依据", reported_client: "请求标记的客户端", conflict: "标记冲突",
  model: "模型", requested_model: "请求模型", upstream_model: "上游模型", bill_model: "计费模型", pricing_model: "计价模型", display_model: "展示模型", model_calls: "模型调用明细",
  reasoning_effort: "实际推理档位", reasoning_requested: "传入推理档位", reasoning_selected: "选择的推理档位", reasoning_applied: "推理参数已下发",
  billing_details: "计费明细", billing_known: "计费结果已确认", billable: "存在可计费用量", partial_units: "部分结算单位", partial_tokens: "部分用量", usage: "用量",
  requested_price: "请求模型价格", original_price: "上游价格", alias_price: "别名价格", price: "平台价格", price_phase: "价格时段", priced_at: "计价时间戳", context_tier: "上下文计价档",
  components: "计费组成", input: "输入", output: "输出", cache: "缓存", tokens: "令牌数", unit_price: "单价（OD／百万 Tokens）", cost_od: "费用（OD）", mixed: "混合单价",
  platform_unit_prices: "平台单价集合", platform_price: "平台价格", price_quoted: "仅报价", usage_present: "存在用量", price_mode: "单价模式",
  raw_cost_od: "倍率前费用（OD）", base_cost_units: "基础计费单位", base_cost_od: "基础费用（OD）", multiplier: "倍率", charged_cost_units: "扣费单位", charged_cost_od: "扣费（OD）",
  pre_rate_rounding_units: "倍率前取整差额", adjustment_units: "结算调整单位", call_count: "调用次数", calls: "逐次调用", channel_quote: "渠道报价", quote_mode: "报价模式",
  currency: "上游币种", provider: "上游服务", url: "来源地址", captured_at: "采集时间戳", in: "输入单价", out: "输出单价",
  prompt_truncated: "上下文已截断", request_prompt_truncated: "保存的上游上下文已截断", input_truncated: "保存的输入已截断", output_truncated: "保存的输出已截断", text_truncated: "文本已截断", source_vendors: "接入来源",
};
const groups = [
  ["故障与重试", ["code", "error_code", "requestId", "request_id", "http_status", "upstream_error_code", "reason", "retry_count", "endpoint_attempts"]],
  ["端点与 Agent", ["inbound_endpoint", "upstream_endpoints", "client_agent", "agent_routing", "source_vendors"]],
  ["模型与推理", ["model", "requested_model", "upstream_model", "bill_model", "pricing_model", "display_model", "model_calls", "reasoning_effort", "reasoning_requested", "reasoning_selected", "reasoning_applied"]],
  ["计费与用量", ["billing_details", "billing_known", "billable", "partial_units", "partial_tokens", "usage", "requested_price", "original_price", "alias_price", "price", "price_phase", "priced_at", "context_tier"]],
  ["内容保存状态", ["prompt_truncated", "request_prompt_truncated", "input_truncated", "output_truncated", "text_truncated"]],
];
const valueText = value => value == null ? "未提供" : value === "" ? "空" : value === true ? "是" : value === false ? "否" : String(value);
const protocols = { chat: "Chat Completions", responses: "Responses", anthropic: "Messages" };
function EndpointAttempts({ items }) {
  return <ol className="oo-diagnostic-attempts">{items.map((item, index) => <li key={index}>
    <div className="oo-diagnostic-attempt-head"><span>尝试 {index + 1} · {protocols[item.protocol] || item.protocol || "未记录协议"}</span><span>HTTP {item.status || "未取得"}</span></div>
    <code>{item.endpoint || "未记录路径"}</code>
    {item.code ? <ErrorCodeText code={item.code} compact /> : null}
    {item.upstream_code ? <span className="oo-diagnostic-upstream-code">上游编号：{item.upstream_code}（由上游定义，不等同于系统错误码）</span> : null}
  </li>)}</ol>;
}
function Value({ value, field, depth = 0 }) {
  if (["code", "error_code"].includes(field) && typeof value === "string" && value) return <ErrorCodeText code={value} compact />;
  if (field === "endpoint_attempts" && Array.isArray(value) && value.every(v => v && typeof v === "object" && !Array.isArray(v))) return <EndpointAttempts items={value} />;
  if (value && typeof value === "object") {
    if (depth >= 10) return <pre className="oo-diagnostic-json">{JSON.stringify(value, null, 2)}</pre>;
    const entries = Object.entries(value);
    if (!entries.length) return <span className="oo-diagnostic-muted">{Array.isArray(value) ? "空列表" : "空对象"}</span>;
    return <details className="oo-diagnostic-object"><summary>{Array.isArray(value) ? `${entries.length} 项` : `${entries.length} 个字段`}</summary>
      <dl>{entries.map(([key, item]) => <div className="oo-diagnostic-field" key={key}><dt title={key}>{Array.isArray(value) ? `第 ${Number(key) + 1} 项` : labels[key] || key}</dt><dd><Value value={item} field={key} depth={depth + 1} /></dd></div>)}</dl>
    </details>;
  }
  return <span className={value == null || value === "" ? "oo-diagnostic-muted" : ""}>{valueText(value)}</span>;
}
export default function LogDiagnosticDetails({ value }) {
  let parsed = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { return <pre className="oo-diagnostic-json">{value || "未记录"}</pre>; } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return <Value value={parsed} />;
  const assigned = new Set(groups.flatMap(([, keys]) => keys));
  const sections = [...groups, ["其他字段", Object.keys(parsed).filter(k => !assigned.has(k))]];
  return <div className="oo-log-diagnostics">{sections.map(([title, keys]) => {
    const present = keys.filter(k => Object.hasOwn(parsed, k));
    return present.length ? <details key={title} className="oo-diagnostic-section"><summary>{title}<small>{present.length} 项</small></summary>
      <dl>{present.map(key => <div className="oo-diagnostic-field" key={key}><dt title={key}>{labels[key] || key}</dt><dd><Value value={parsed[key]} field={key} /></dd></div>)}</dl>
    </details> : null;
  })}<details className="oo-diagnostic-section"><summary>查看 JSON</summary><pre className="oo-diagnostic-json">{JSON.stringify(parsed, null, 2)}</pre></details></div>;
}
