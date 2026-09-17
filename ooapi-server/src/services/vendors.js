// 厂商注册表：管理端与前端共用同一份元信息
// ---------------------------------------------------------------------------
// 新增厂商只需在此登记：类型、展示名、登录方式、默认模型、适配器能力。
// 前端「添加账号」弹窗按此渲染，无需改前端代码。
export const VENDORS = [
  {
    key: "deepseek",
    name: "DeepSeek",
    channelType: "deepseek",
    desc: "官方 V4.1-Flash 能力，原生多模态、支持看图",
    // 平台内置登录（账号密码）；有验证码时可改用粘贴
    loginModes: ["password", "paste"],
    fields: [
      { key: "account", label: "手机号 / 邮箱", type: "text", required: true, placeholder: "13800138000 或 you@example.com" },
      { key: "areaCode", label: "区号", type: "text", default: "+86" },
      { key: "password", label: "密码", type: "password", required: true },
    ],
    models: ["deepseek-flash", "deepseek-v4-pro"],
    baseUrl: "https://chat.deepseek.com",
    supportsBatch: true,
    supportsVision: true,
    hint: "登录态可能触发风控；若提示需验证码，请改用「粘贴登录态」方式",
  },
  {
    key: "glm",
    name: "智谱 GLM",
    channelType: "glm",
    desc: "GLM-5.3 系列，浏览器驱动（自动过验证码）",
    // 登录由浏览器承载，无需粘贴：添加后在后台点「登录」打开浏览器一次即可
    loginModes: ["browser"],
    fields: [],
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-4.7", "glm-5v-turbo", "glm-4.5", "glm-4.5-air"],
    baseUrl: "https://chat.z.ai",
    supportsBatch: false,
    supportsVision: true,
    hint: "该厂商有前端验证码，采用浏览器驱动：添加后在浏览器里登录一次，之后可长期自动运行",
  },
  {
    key: "kimi",
    name: "Kimi",
    channelType: "kimi",
    desc: "K2.6 / K3，支持深度思考与联网",
    loginModes: ["paste"],
    fields: [],
    models: ["kimi-k3", "kimi-k2.6", "kimi-k2"],
    baseUrl: "https://www.kimi.com",
    supportsBatch: false,
    supportsVision: false,
    hint: "需粘贴登录态：浏览器登录 kimi.com 后，复制 cookie 中 kimi-auth 的值（JWT）",
  },
  {
    key: "doubao",
    name: "豆包",
    channelType: "doubao",
    desc: "字节豆包，浏览器驱动（自动过签名）",
    loginModes: ["browser"],
    fields: [],
    models: ["doubao-pro", "doubao-lite"],
    baseUrl: "https://www.doubao.com",
    supportsBatch: false,
    supportsVision: false,
  },
  {
    key: "qwen",
    name: "通义千问",
    channelType: "qwen",
    desc: "阿里通义千问，浏览器驱动（自动过风控）",
    loginModes: ["browser"],
    fields: [],
    models: ["qwen3.8-max", "qwen3.7-plus", "qwen3-max", "qwen-plus"],
    baseUrl: "https://chat.qwen.ai",
    supportsBatch: false,
    supportsVision: false,
  },
];

export function getVendor(key) {
  return VENDORS.find((v) => v.key === key) || null;
}

// 当前已实现适配器、可用的厂商
export function activeVendors() {
  return VENDORS.filter((v) => v.enabled !== false);
}

// 全部厂商类型（供渠道页筛选）
export function vendorTypes() {
  return VENDORS.map((v) => v.channelType);
}
