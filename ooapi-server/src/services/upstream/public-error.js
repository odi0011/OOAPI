// 上游message可能夹带响应正文、供应商网址或凭据。公开说明只能从固定文案生成，
// 识别原文仅用于选取参数错误类别；不能把原文“截短/替换几个关键字”后继续下发。
const MESSAGES = Object.freeze({
  INVALID_REASONING: "该模型不支持所选思考强度，请在会话设定中选择模型默认。",
  CONTEXT_COMPACTION_FAILED: "上下文压缩未完成，历史消息仍保留。请缩短附件或新建会话后继续。",
  CONTEXT_LENGTH: "当前问题或附件超过可用上下文，请拆分内容后继续。历史消息仍保留。",
  NO_CHANNEL: "当前没有可用渠道，请稍后重试或选择其他模型。",
  VISION_NOT_SUPPORTED: "当前渠道不支持图片，请移除图片或选择其他模型。",
  CHANNEL_RATE_LIMIT: "上游请求频率受限，请稍后重试。",
  CHANNEL_AUTH_EXPIRED: "上游服务鉴权失败，请联系管理员。",
  CHANNEL_FORBIDDEN: "上游限制了此次调用的模型或客户端权限，请选择其他模型或联系管理员核查。",
  CHANNEL_TIMEOUT: "上游响应超时，请稍后重试。",
  CHANNEL_NETWORK: "上游连接中断，请稍后重试。",
  BILLING_FAILED: "本轮计费未完成，请联系管理员核查。",
  BILLING_UNCERTAIN: "本轮计费提交结果待核查，请联系管理员。",
  TOOL_PROTOCOL_ERROR: "模型未能完成工具调用，无法取得所需的真实数据。请重试或更换模型；本轮已产生的用量保留在使用记录中。",
  TOOL_RESPONSE_ERROR: "模型只返回了工具状态，未完成实际回答。请重试或更换模型；已取得的工具结果与本轮用量已保留。",
  TOOL_STEP_LIMIT: "本轮已达到工具步骤上限，尚未完成最终回答。工具结果和已产生的用量已保留，可继续提问或重试。",
});

/** 返回可安全用于公开API、消息part、审计content与console的错误说明。 */
export function publicRunError(err, { stopped = false } = {}) {
  if (stopped) return "已停止生成。本轮已产生的用量照常计费。";
  // 本地校验错误也带 400，必须先看业务码，不能被下方“模型不支持”关键词吞掉。
  if (err?.code === "INVALID_REASONING") return MESSAGES.INVALID_REASONING;
  if (err?.code === "NO_CHANNEL" && err?.reason === "COOLING") return "可用渠道暂处于故障冷却中，请稍后重试；管理员可在渠道管理中查看状态。";
  if (err?.code === "CHANNEL_EMPTY") return "上游未返回可用内容，请稍后重试；已产生的用量保留在使用记录中。";
  if (err?.capability === "systemone") return "此模型仅支持结构化判断，请输入包含 state 和 questions 的 JSON，或选择对话模型。";
  const value = Number(err?.httpStatus || err?.status);
  const status = Number.isInteger(value) && value >= 400 && value <= 599 ? value : 0;
  const prefix = status ? `上游请求失败（HTTP ${status}）：` : "上游请求失败：";
  // HTTP参数拒绝可给出行动建议，但实际响应中的数字、模型名和账号信息均不复制。
  if (err?.code === "CHANNEL_BAD_REQUEST" || [400, 413, 422].includes(status)) {
    const upstream = String(err?.message || "");
    if (/illegal[\s_-]+short[\s_-]+input|distillat(?:ion|ing|e)|heartbeat[\s_-]+(?:probing|probe)|非法短输入|蒸馏|心跳探测/i.test(upstream)) {
      return `${prefix}上游按请求审核策略拒绝了此次调用。可选择其他模型，或联系管理员核查。`;
    }
    if (/(?:input|message|prompt)[\s\S]{0,80}(?:too short|minimum.{0,20}length|at least.{0,12}(?:character|token))|(?:输入|消息|提问)[\s\S]{0,50}(?:太短|过短|至少)/i.test(upstream)) return `${prefix}输入内容过短，请补充内容后重试。`;
    if (/context.{0,30}(?:length|limit|exceed)|(?:上下文|输入|消息).{0,30}(?:过长|超长|超出|超过)/i.test(upstream)) return `${prefix}输入超过上下文长度限制，请缩短内容或新建会话。`;
    // model_param_invalid / invalid_request_error 说的是参数，不是模型不存在。
    // WorkBuddy 的 11133 会带这两个字段；宽泛的 model...invalid 曾误报为模型不可用。
    if (/model[\s_-]+param(?:eter)?[\s_-]+invalid|invalid[\s_-]+request[\s_-]+parameters|request parameters.{0,60}(?:reject|invalid)|请求参数.{0,30}(?:不符合|无效)/i.test(upstream)) return `${prefix}请求参数或工具调用历史不符合上游要求，请联系管理员核查协议转换。`;
    if (/\bmodel(?:[\s:="']+.{0,24})?\s+(?:not found|not exist|is invalid|is unsupported)|\b(?:invalid|unsupported)[\s_-]+model\b|模型.{0,30}(?:不存在|无效|不支持)/i.test(upstream)) return `${prefix}所选模型不可用，请选择其他模型。`;
  }
  return MESSAGES[err?.code] || (status ? `上游请求失败（HTTP ${status}），请检查模型或稍后重试。` : "生成失败，请稍后重试或联系管理员。");
}
