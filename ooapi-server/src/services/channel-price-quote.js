// 渠道报价与平台计价是两份事实。这里只取本次渠道可确认的公开报价，
// 不读取管理员价表、不查历史 alias 价、不发网络请求，更不保存渠道凭据。
import { DEFAULT_PRICES, effectivePrice, parsePriceTiers, storedPriceTiers, priceForTokens } from "./pricing.js";
import { canonicalModelName } from "./models.js";
import { applyVendorRequest } from "./upstream/vendor-quirks.js";

const DOCUMENTS = {
  cline: "https://docs.cline.bot/",
  openrouter: "https://openrouter.ai/docs/guides/overview/models",
  opencode: "https://opencode.ai/docs/zen/",
  workbuddy: "https://www.codebuddy.ai/",
  qoder: "https://docs.qoder.com/",
  kiro: "https://kiro.dev/docs/",
  cursor: "https://docs.cursor.com/account/pricing",
  trae: "https://www.trae.ai/",
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  glm: "https://open.bigmodel.cn/pricing",
  "glm-global": "https://docs.z.ai/guides/overview/pricing",
  qwen: "https://help.aliyun.com/zh/model-studio/model-pricing",
  kimi: "https://platform.moonshot.ai/docs/pricing/chat",
  minimax: "https://platform.minimax.io/docs/guides/pricing-paygo",
  mimo: "https://mimo.mi.com/docs/en-US/price/pay-as-you-go",
  grok: "https://docs.x.ai/docs/models",
  stepfun: "https://platform.stepfun.com/",
  ark: "https://www.volcengine.com/docs/82379/",
  doubao: "https://www.volcengine.com/docs/82379/",
};
const OFFICIAL_HOSTS = {
  openai: ["api.openai.com"], anthropic: ["api.anthropic.com"],
  gemini: ["generativelanguage.googleapis.com"], deepseek: ["api.deepseek.com"],
  glm: ["api.z.ai"], qwen: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
  kimi: ["api.moonshot.ai"], minimax: ["api.minimax.io"],
  mimo: ["api.xiaomimimo.com"], grok: ["api.x.ai"], stepfun: ["api.stepfun.com"],
};
const CREDIT_CHANNELS = new Set(["workbuddy", "qoder", "kiro", "cursor", "trae"]);
const MONEY = (p) => ({ in: Number(p.input), out: Number(p.output), cache: Number(p.cache) > 0 ? Number(p.cache) : null });

/** 发起调用时捕获；后续配置变化不能改变本次报价。返回值只有安全元信息。 */
export function channelPriceQuote(channel, { model = "", at = Date.now() } = {}) {
  const provider = String(channel?.type || "").toLowerCase();
  let host = "";
  try { const u = new URL(channel?.base_url || ""); if (u.protocol === "https:") host = u.hostname.toLowerCase(); } catch { /* 不从未知反代猜报价 */ }
  const documentKey = provider === "glm" && host === "api.z.ai" ? "glm-global" : provider;
  const body = { model };
  if (channel) applyVendorRequest(body, { channel, model });
  const routeModel = String(body.model || model || "");
  const quote = {
    status: CREDIT_CHANNELS.has(provider) ? "credits" : "unavailable",
    price: null, currency: null, model: routeModel, provider,
    source: "unavailable", url: DOCUMENTS[documentKey] || null, document_key: documentKey,
    captured_at: Number(at) || Date.now(),
  };
  // 只对本次实际聚合渠道的显式免费SKU确认0；规范名本身不能证明免费。
  if (["cline", "openrouter", "opencode"].includes(provider) && /:free$/i.test(routeModel)) {
    return { ...quote, status: "available", currency: "USD", source: "channel_free_sku", price: { in: 0, out: 0, cache: 0 } };
  }
  const method = String(channel?.other?.method || "");
  if (method !== "api" || !OFFICIAL_HOSTS[provider]?.includes(host)) return quote;
  const identity = canonicalModelName(routeModel);
  // 平台把人民币目录折成OD的价不是渠道原始美元报价；不倒算、不冒充原价。
  const official = DEFAULT_PRICES.find((p) => p.type === provider && String(p.model).toLowerCase() === identity && /官方/.test(p.remark || "") && /美元|USD/.test(p.remark || "") && !/人民币|¥|÷|折算|估录|估算|待复核|旧命名/.test(p.remark || ""));
  if (!official) return quote;
  const terms = effectivePrice({ ...official, tiers: parsePriceTiers(storedPriceTiers(official)) }, quote.captured_at).price;
  return { ...quote, status: "available", currency: "USD", source: "official_channel_published", price: MONEY(terms),
    // 调用开始时冻结价档；真实usage返回后才知道应套哪档上下文价格。
    terms: { input: terms.input, output: terms.output, cache: terms.cache, tiers: terms.tiers || [] } };
}

/** 落日志前只保留报价快照，不把内部分档配置和任意额外字段序列化。 */
export function finalizeChannelQuote(snapshot, promptTokens = 0) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const price = snapshot.status === "available" ? (snapshot.terms ? MONEY(priceForTokens(snapshot.terms, promptTokens)) : snapshot.price) : null;
  return { status: ["available", "credits", "unavailable"].includes(snapshot.status) ? snapshot.status : "unavailable",
    price: price ? { in: Number(price.in) || 0, out: Number(price.out) || 0, cache: price.cache == null ? null : Number(price.cache) || 0 } : null,
    currency: price ? "USD" : null, model: String(snapshot.model || "").slice(0, 128),
    provider: String(snapshot.provider || "").slice(0, 32), source: String(snapshot.source || "unavailable").slice(0, 64),
    url: DOCUMENTS[snapshot.document_key === "glm-global" && snapshot.provider === "glm" ? "glm-global" : String(snapshot.provider || "")] || null, captured_at: Number(snapshot.captured_at) || 0 };
}
