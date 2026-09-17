// 统一模型层：聚合各厂商模型，提供模型名 → 渠道匹配所需的解析
// ---------------------------------------------------------------------------
// 设计原则（重要）：
//   网关/对话路由**只负责把用户请求的模型名透传**给渠道层匹配，
//   各厂商的别名映射由各自适配器内部完成。
//   这样新增厂商时无需改动网关代码。
import { VENDORS } from "./vendors.js";

// 各厂商的模型定义（懒加载，避免循环依赖）
const VENDOR_MODEL_MODULES = {
  deepseek: () => import("./upstream/deepseek-models.js"),
  glm: () => import("./upstream/glm-models.js"),
  kimi: () => import("./upstream/kimi-models.js"),
  doubao: () => import("./upstream/doubao-models.js"),
};

/**
 * 聚合所有厂商的对外模型列表
 * @param {string[]|null} onlyTypes 限定厂商类型（null = 全部已启用）
 */
export async function allPublicModels(onlyTypes = null) {
  const types = onlyTypes || VENDORS.filter((v) => v.enabled !== false).map((v) => v.channelType);
  const out = [];
  for (const t of types) {
    const loader = VENDOR_MODEL_MODULES[t];
    if (!loader) continue;
    try {
      const mod = await loader();
      if (typeof mod.publicModels !== "function") continue;
      for (const m of mod.publicModels()) {
        out.push({ ...m, vendor: t, vendorName: VENDORS.find((v) => v.channelType === t)?.name || t });
      }
    } catch {
      /* 该厂商模型模块不可用时跳过 */
    }
  }
  return out;
}

/**
 * 渠道匹配用的模型名解析。
 * 注意：**不做跨厂商映射**，只把带能力后缀的名字归一化后原样返回，
 *      真正的别名映射（如 glm-4 → glm-4.7）在各适配器内部。
 * 这样 glm-5.3-flash 只会匹配声明了该模型的 GLM 渠道。
 */
export function modelForChannelMatch(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return "";
  // 去掉能力后缀（-search / -thinking）—— 渠道声明的是基础模型名
  return raw.replace(/-(search|thinking|agent|agent-swarm)$/i, "");
}

/**
 * 校验模型是否属于某个厂商（用于管理端提示，不用于调度）
 */
export async function modelBelongsToVendor(model, channelType) {
  const loader = VENDOR_MODEL_MODULES[channelType];
  if (!loader) return false;
  try {
    const mod = await loader();
    if (typeof mod.publicModels !== "function") return false;
    const names = mod.publicModels().map((m) => m.id.toLowerCase());
    const m = String(model || "").toLowerCase().replace(/-(search|thinking)$/i, "");
    return names.some((n) => n === m);
  } catch {
    return false;
  }
}

/** 已注册的厂商类型 */
export function supportedVendorTypes() {
  return Object.keys(VENDOR_MODEL_MODULES);
}
