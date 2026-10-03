// 对外仅声明当前密钥的倍率，价格基准是本站模型定价，不是原厂标价。
export function keyBillingInfo(groupName, rate, { compatibility = false, at = new Date() } = {}) {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Billing rate unavailable");
  return {
    object: compatibility ? "sub2api.key_billing" : "ooapi.key_billing",
    schema_version: 1,
    billing_scope: "token",
    group_name: groupName,
    group_rate_multiplier: rate,
    resolved_rate_multiplier: rate,
    peak_rate_enabled: false,
    effective_rate_multiplier: rate,
    observed_at: at.toISOString(),
    rate_basis: "platform_model_price",
    note: "倍率应用于本站配置的模型单价；模型分时/长上下文价格与额度舍入另按实际账单执行。此接口不发起模型调用、不计费。",
  };
}
