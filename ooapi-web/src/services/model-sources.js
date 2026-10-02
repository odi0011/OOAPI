// 运行模型的来源只读渠道元信息；原厂推断仅用于模型价格目录。
// 不在前端裁切模型名/能力后缀，以免把两个不同模型的来源合到一起。
export function normalizeSourceVendors(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
    .filter(Boolean))].sort();
}

export function modelSourceMap(channels = [], selectedModels = []) {
  const result = Object.create(null);
  for (const channel of channels) {
    const vendors = normalizeSourceVendors(channel.type);
    if (!vendors.length) continue;
    const declared = (Array.isArray(channel.models) ? channel.models : []).filter((m) => typeof m === "string" && m.trim());
    // 空范围/显式通配使用服务端按调度规则展开的清单，前端不凭厂商名臆造模型。
    const candidates = !declared.length || declared.some((m) => m.includes("*"))
      ? [...declared.filter((m) => !m.includes("*")), ...Object.keys(channel.model_vendors || {})] : declared;
    // 已保存的规范名可能不同于上游ID；只接受服务端明确确认的映射，避免展开所有别名造成重复候选。
    for (const model of [...candidates, ...selectedModels.filter((m) => Object.hasOwn(channel.model_vendors || {}, m))]) {
      if (typeof model !== "string" || !model.trim()) continue;
      const name = model.trim();
      result[name] = normalizeSourceVendors([...(result[name] || []), ...vendors]);
    }
  }
  return result;
}

export function modelSourceVendors(model, sources) {
  const name = String(model || "").trim();
  return sources && Object.hasOwn(sources, name) ? normalizeSourceVendors(sources[name]) : [];
}
