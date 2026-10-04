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

export function channelUpstreamModel(channel, model, fallback = "auto", canonicalize = autoModelIdentity) {
  const declared = Array.isArray(channel?.models) ? channel.models : String(channel?.models || "").split(/[\s,，]+/);
  const owner = autoChannelId(model);
  if (owner === Number(channel?.id)) return declared.find(isAutoModel) || (isAutoModel(fallback) ? fallback : "auto");
  if (owner || channel?.other?.method !== "antigravity") return model;

  // 展示、权限和计费会归一掉 -thinking，但 Antigravity 将它作为真正的模型 SKU。
  // 渠道探针保留原名；真实对话也必须从本渠道声明恢复，不能拿其他渠道的目录兜底。
  const ids = [...new Set(declared.map(id => String(id).trim()).filter(id => id && !id.includes("*")))];
  const requested = String(model || "").trim().toLowerCase();
  const exact = ids.find(id => id.toLowerCase() === requested);
  if (exact) return exact;
  // 此模块也被前端复用；服务端传入统一别名解析器，不能在这里引入数据库/适配器。
  const canonical = canonicalize(model);
  const matches = canonical ? ids.filter(id => canonicalize(id) === canonical) : [];
  // 同身份多个变体时不按目录顺序猜档位；只有唯一声明可以无歧义地恢复。
  return matches.length === 1 ? matches[0] : model;
}
