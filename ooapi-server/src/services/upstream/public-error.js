// 上游message可能夹带响应正文、供应商网址或凭据。公开说明只能从固定文案生成，
// 识别原文仅用于选取参数错误类别；不能把原文“截短/替换几个关键字”后继续下发。
const MESSAGES = Object.freeze({
  NO_CHANNEL: "当前没有可用渠道，请稍后重试或选择其他模型。",
  VISION_NOT_SUPPORTED: "当前渠道不支持图片，请移除图片或选择其他模型。",
  CHANNEL_RATE_LIMIT: "上游请求频率受限，请稍后重试。",
  CHANNEL_AUTH_EXPIRED: "上游服务鉴权失败，请联系管理员。",
  CHANNEL_TIMEOUT: "上游响应超时，请稍后重试。",
  CHANNEL_NETWORK: "上游连接中断，请稍后重试。",
  BILLING_FAILED: "本轮计费未完成，请联系管理员核查。",
  BILLING_UNCERTAIN: "本轮计费提交结果待核查，请联系管理员。",
});

/** 返回可安全用于公开API、消息part、审计content与console的错误说明。 */
export function publicRunError(err, { stopped = false } = {}) {
  if (stopped) return "已停止生成。本轮已产生的用量照常计费。";
  const value = Number(err?.httpStatus || err?.status);
  const status = Number.isInteger(value) && value >= 400 && value <= 599 ? value : 0;
  const prefix = status ? `上游请求失败（HTTP ${status}）：` : "上游请求失败：";
  // HTTP参数拒绝可给出行动建议，但实际响应中的数字、模型名和账号信息均不复制。
  if (err?.code === "CHANNEL_BAD_REQUEST" || [400, 413, 422].includes(status)) {
    const upstream = String(err?.message || "");
    if (/illegal[\s_-]+short[\s_-]+input|distillat(?:ion|ing|e)|heartbeat[\s_-]+(?:probing|probe)|非法短输入|蒸馏|心跳探测/i.test(upstream)) {
      return `${prefix}上游拒绝了短输入，或将请求识别为蒸馏、心跳探测。请补充实际问题内容后重试。`;
    }
    if (/(?:input|message|prompt)[\s\S]{0,80}(?:too short|minimum.{0,20}length|at least.{0,12}(?:character|token))|(?:输入|消息|提问)[\s\S]{0,50}(?:太短|过短|至少)/i.test(upstream)) return `${prefix}输入内容过短，请补充内容后重试。`;
    if (/context.{0,30}(?:length|limit|exceed)|(?:上下文|输入|消息).{0,30}(?:过长|超长|超出|超过)/i.test(upstream)) return `${prefix}输入超过上下文长度限制，请缩短内容或新建会话。`;
    if (/model.{0,30}(?:not found|not exist|invalid|unsupported)|模型.{0,30}(?:不存在|无效|不支持)/i.test(upstream)) return `${prefix}所选模型不可用，请选择其他模型。`;
  }
  return MESSAGES[err?.code] || (status ? `上游请求失败（HTTP ${status}），请检查模型或稍后重试。` : "生成失败，请稍后重试或联系管理员。");
}
