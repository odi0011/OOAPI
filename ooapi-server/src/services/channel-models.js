// auto 是渠道自己的动态路由器，不能像普通模型一样跨账号合并身份或价格。
// 保留上游声明；只在公共目录中使用稳定的渠道编号，避免新增渠道后再次改名。
export function autoModelIdentity(model) {
  return String(model || "").trim().toLowerCase()
    .replace(/^~/, "")
    .replace(/:(free|batch|extended|thinking)$/i, "")
    .replace(/-(search|thinking|agent|agent-swarm)$/i, "");
}

export function isAutoModel(model) {
  return /^(?:.*\/)?auto$/.test(autoModelIdentity(model));
}

export function autoChannelId(model) {
  const match = autoModelIdentity(model).match(/^(?:.*\/)?([1-9]\d*)-auto$/);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? Number(match[1]) : null;
}

export function channelPublicModel(channel, model) {
  const id = Number(channel?.id);
  return isAutoModel(model) && Number.isSafeInteger(id) && id > 0 ? `${id}-auto` : String(model || "").trim();
}

export function channelUpstreamModel(channel, model, fallback = "auto") {
  if (autoChannelId(model) !== Number(channel?.id)) return model;
  const declared = Array.isArray(channel.models) ? channel.models : String(channel.models || "").split(/[\s,，]+/);
  return declared.find(isAutoModel) || (isAutoModel(fallback) ? fallback : "auto");
}
