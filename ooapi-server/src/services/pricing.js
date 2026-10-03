// OD 币计价
// ---------------------------------------------------------------------------
// 币制：1 OD 币 = 1 美元（1:1）。额度以「厘」为最小单位存储，
//       1 OD 币 = 10000 厘（即支持 0.0001 OD 币精度）。
// 价格：model_prices 表按模型存「OD 币 / 百万 token」，含缓存命中档，
//       与 new-api 的 model_ratio 思路一致但更直观（直接存价格而非倍率）。
// 公式：
//   cost = (prompt_tokens/1e6 * input_price
//         + completion_tokens/1e6 * output_price
//         + cache_tokens/1e6 * cache_price) * UNITS_PER_OD
//   向上取整，最低 1 厘（避免零计费刷量）。
import { pool } from "../db.js";
import { now } from "../utils.js";
import { normalizeClineModel } from "./cline-prices.js";

export const UNITS_PER_OD = 10000; // 1 OD 币 = 10000 厘
export const CURRENCY = "OD币";

// 默认价格表（OD 币 / 百万 token，1 OD = $1）
// ---------------------------------------------------------------------------
// 维护规则（重要）：
//   · 每条 remark 必须写清【官方来源】，禁止「同上」「官方定价页」这类无意义描述；
//   · 只收录真实存在的模型 ID（以官方文档为准），且与各厂商模型注册表
//     （services/upstream/*-models.js）严格一一对应。能力（思考/联网/看图）是请求参数，
//     不是模型，禁止再造 deepseek-vision 之类的"能力模型"；
//   · 官方只公布人民币价的（GLM/千问/豆包），按固定汇率折算 USD 并写明折算口径；
//     官方直接给美元价的（DeepSeek/Kimi/OpenAI/Anthropic/Google）直接使用；
//   · 本表只用于「缺该模型时插入」，绝不覆盖管理员改过的价格。
// 来源（2026-09 复核）：
//   · DeepSeek https://api-docs.deepseek.com/quick_start/pricing/（美元，高峰价）
//   · 智谱 https://open.bigmodel.cn/pricing（人民币）
//   · Kimi https://platform.kimi.com/docs/pricing/chat（美元）
//   · 阿里云百炼 https://help.aliyun.com/zh/model-studio/（人民币）
//   · 火山方舟 https://ai.volcengine.com/model（人民币）
//   · OpenAI https://openai.com/api/pricing/ · Anthropic https://www.anthropic.com/pricing
//   · Google https://ai.google.dev/gemini-api/docs/pricing
const CNY_PER_USD = 6.71; // 官方人民币价折算美元用（7.2 → 6.71，2026-09-28 按当日汇率重估；平台币制固定 1 OD = 1 USD）
// 国办发明电〔2025〕7号；只登记已公布年度，不能把2026日期套到未来。
// https://www.gov.cn/zhengce/content/202511/content_7047090.htm
const CN_PUBLIC_HOLIDAYS_2026 = [["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"], ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"], ["2026-10-01", "2026-10-07"]];
export const DEFAULT_PRICES = [
  // --- DeepSeek：官方当前只有这两个模型（网页反代输出的也是 flash）---
  // 官方按钟点差异定价（2026-09 官方定价页脚注原文：Off-peak rates are half of the peak rates.
  // Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday），
  // 即北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，其余时段（含整个周末）半价。
  // 注意：阿里百炼 / 火山方舟上托管的 DeepSeek 窗口不同（百炼是每天 22:00-08:00 闲时），
  // 若接的是那两家的通道，需要在该渠道对应的模型价格里单独改 offpeak_rule。
  {
    model: "deepseek-flash",
    input: 0.30,
    output: 1.20,
    cache: 0.006,
    offpeakInput: 0.15,
    offpeakOutput: 0.60,
    offpeakCache: 0.003,
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]], offpeakDates: CN_PUBLIC_HOLIDAYS_2026 },
    type: "deepseek",
    remark: "官方美元峰谷价（2026-10-01 复核）；周一至五9-12/14-18峰价，公共假期除外，已配置2026假期；来源 api-docs.deepseek.com/quick_start/pricing/；假期 gov.cn/zhengce/content/202511/content_7047090.htm",
  },
  {
    model: "deepseek-v4-pro",
    input: 1.32,
    output: 3.96,
    cache: 0.044,
    offpeakInput: 0.66,
    offpeakOutput: 1.98,
    offpeakCache: 0.022,
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]], offpeakDates: CN_PUBLIC_HOLIDAYS_2026 },
    type: "deepseek",
    remark: "官方美元峰谷价（2026-10-01 复核）；周一至五9-12/14-18峰价，公共假期除外，已配置2026假期；来源 api-docs.deepseek.com/quick_start/pricing/；假期 gov.cn/zhengce/content/202511/content_7047090.htm",
  },

  // --- 智谱 GLM（2026-10-01 复核 Z.AI 官方美元价，不使用人民币换算）---
  { model: "glm-5.3", input: 1.40, output: 4.40, cache: 0.26, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-5.3-flash", input: 0.15, output: 0.50, cache: 0.03, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-5.3-flashx", input: 0.37, output: 1.25, cache: 0.075, type: "glm", remark: "Z.AI 官方美元价，FlashX 为独立 API ID（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing 与 https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash" },
  { model: "glm-5.2", input: 1.40, output: 4.40, cache: 0.26, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-5v-turbo", input: 0.745156, output: 3.278689, cache: 0.178838, type: "glm", remark: `官方 ≤32K 档 ¥5/¥22/缓存 ¥1.2 ÷ 6.71；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.7", input: 0.60, output: 2.20, cache: 0.11, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-4.6", input: 0.60, output: 2.20, cache: 0.11, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-4.5", input: 0.60, output: 2.20, cache: 0.11, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-5", input: 1.00, output: 3.20, cache: 0.20, type: "glm", remark: "Z.AI 官方美元价，独立于 5.1/5.2 档（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-5.1", input: 1.40, output: 4.40, cache: 0.26, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-4.5-air", input: 0.20, output: 1.10, cache: 0.03, type: "glm", remark: "Z.AI 官方美元价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },

  // --- Kimi（2026-10-01 复核官方海外美元价；来源 platform.moonshot.ai/docs/pricing/chat）---
  { model: "kimi-k3", input: 3.00, output: 15.00, cache: 0.30, type: "kimi", remark: "官方海外美元价，1M 上下文（2026-10-01 复核）；来源 https://platform.moonshot.ai/docs/pricing/chat" },
  { model: "kimi-k2.6", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "官方海外美元价（2026-10-01 复核）；来源 https://platform.moonshot.ai/docs/pricing/chat" },
  { model: "kimi-k2.7-code", input: 0.95, output: 4.00, cache: 0.19, type: "kimi", remark: "官方海外美元价，256K 多模态编程模型（2026-10-01 复核）；来源 https://platform.moonshot.ai/docs/pricing/chat" },
  { model: "kimi-k2.7-code-highspeed", input: 1.90, output: 8.00, cache: 0.38, type: "kimi", remark: "官方海外美元价，高速版为独立 API ID（2026-10-01 复核）；来源 https://platform.moonshot.ai/docs/pricing/chat" },
  // kimi-k2 是仍在注册表里的经典档（网页反代 SCENARIO_K2 会用到）。
  // 缺这一行会让它落到「同厂商最高档兜底」= 按 k3 旗舰价（3.00/15.00）计费，
  // 相对 k2.6 档最多多收约 3 倍。
  { model: "kimi-k2", input: 0.55, output: 2.20, cache: 0.10, type: "kimi", remark: "经典档，按上一代官方价录入（待官方页复核）；来源 platform.kimi.com/docs/pricing/chat" },

  // --- 通义千问（2026-10-01 复核官网 China Beijing 美元目录，不使用人民币换算）---
  // 与默认 DashScope API endpoint 的地区一致；缓存取普通隐式档（官网标准20%），
  // 3.8 Max/Flash/2.4T 的缓存为官网明确例外，仅控制台公布，保留 null 而非猜价。
  { model: "qwen3.8-max", input: 1.65, output: 4.951, cache: null, type: "qwen", remark: "官方Beijing美元价，≤1000000输入；缓存单价仅控制台公布（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.8-max-prime", input: 3.301, output: 9.902, cache: null, type: "qwen", remark: "官方Beijing美元价，真实独立Prime API ID，≤1000000输入；无公开缓存单价（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing" },
  { model: "qwen3.8-flash", input: 0.113, output: 0.382, cache: null, type: "qwen", remark: "官方Beijing美元价，≤1000000输入；缓存单价仅控制台公布（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.8-2.4t-a95b", input: 1.65, output: 4.951, cache: null, type: "qwen", remark: "官方Beijing美元价，≤1000000输入；缓存单价仅控制台公布（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.8-27b", input: 0.424, output: 1.696, cache: 0.0848, type: "qwen", remark: "官方Beijing美元价，≤1000000输入；缓存取官网隐式档20%，显式档另价（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.7-plus", input: 0.276, output: 1.101, cache: 0.0552, tiers: [{ minInputTokens: 256001, input: 0.826, output: 3.301, cache: 0.1652 }], type: "qwen", remark: "官方Beijing美元list价，思考/非思考同价，>256000输入长档；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.6-plus", input: 0.276, output: 1.651, cache: null, tiers: [{ minInputTokens: 256001, input: 1.101, output: 6.602, cache: null }], type: "qwen", remark: "官方Beijing美元价，思考/非思考同价，>256000输入长档；官网未列隐式缓存支持，显式缓存为不同请求模式，缓存价待确认（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.5-plus", input: 0.115, output: 0.688, cache: null, tiers: [{ minInputTokens: 128001, input: 0.287, output: 1.72, cache: null }, { minInputTokens: 256001, input: 0.573, output: 3.44, cache: null }], type: "qwen", remark: "官方Beijing美元价，思考/非思考同价，>128000/>256000输入分档；官网未列隐式缓存支持，显式缓存为不同请求模式，缓存价待确认（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3-max", input: 0.359, output: 1.434, cache: 0.0718, tiers: [{ minInputTokens: 32001, input: 0.574, output: 2.294, cache: 0.1148 }, { minInputTokens: 128001, input: 1.004, output: 4.014, cache: 0.2008 }], type: "qwen", remark: "官方Beijing美元价，>32000/>128000输入分档；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen-plus", input: 0.115, output: 0.287, cache: 0.023, tiers: [{ minInputTokens: 128001, input: 0.345, output: 2.868, cache: 0.069 }, { minInputTokens: 256001, input: 0.689, output: 6.881, cache: 0.1378 }], type: "qwen", remark: "官方Beijing非思考美元价，>128000/>256000输入分档；思考输出另为1.147/3.441/9.175；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.7-flash", input: 0.028, output: 0.110, cache: 0.0056, tiers: [{ minInputTokens: 32001, input: 0.083, output: 0.330, cache: 0.0166 }, { minInputTokens: 256001, input: 0.165, output: 0.660, cache: 0.033 }], type: "qwen", remark: "官方Beijing美元价，>32000/>256000输入分档；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.6-flash", input: 0.165, output: 0.99, cache: null, tiers: [{ minInputTokens: 256001, input: 0.66, output: 3.961, cache: null }], type: "qwen", remark: "官方Beijing美元价，>256000输入长档；官网未列隐式缓存支持，显式缓存为不同请求模式，缓存价待确认（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.5-flash", input: 0.029, output: 0.287, cache: null, tiers: [{ minInputTokens: 128001, input: 0.115, output: 1.147, cache: null }, { minInputTokens: 256001, input: 0.172, output: 1.72, cache: null }], type: "qwen", remark: "官方Beijing美元价，>128000/>256000输入分档；官网未列隐式缓存支持，显式缓存为不同请求模式，缓存价待确认（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },

  // --- 豆包（本平台 doubao-pro/lite 为通用档位，价格对应官方 Seed 2.0 Pro/Lite ≤32K 档）---
  { model: "doubao-pro", input: 0.4769, output: 2.384501, cache: 0.09538, type: "doubao", remark: `对应官方 Seed-2.0-Pro ≤32K：¥3.2/¥16/缓存 ¥0.64 ÷ 6.71；来源 ai.volcengine.com/model` },
  { model: "doubao-lite", input: 0.089419, output: 0.536513, cache: 0.017884, type: "doubao", remark: `对应官方 Seed-2.0-Lite ≤32K：¥0.6/¥3.6/缓存 ¥0.12 ÷ 6.71；来源 ai.volcengine.com/model` },

  // --- 火山方舟（2026-09 接入；官方按输入长度分档，取最常用档并在 remark 注明）---
  { model: "doubao-seed-2-1-pro", input: 0.894188, output: 4.470939, cache: 0.178838, type: "ark", remark: `官方 ≤1024 输入档 ¥6/¥30/缓存 ¥1.2 ÷ 6.71；长输入档更贵；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-1-turbo", input: 0.447094, output: 2.235469, cache: 0.089419, type: "ark", remark: `官方 ≤256 输入档 ¥3/¥15/缓存 ¥0.6 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-pro", input: 0.4769, output: 2.384501, cache: 0.09538, type: "ark", remark: `官方 ≤32K 档 ¥3.2/¥16/缓存 ¥0.64 ÷ 6.71；32–128K 与 128–256K 档更贵；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-lite", input: 0.089419, output: 0.536513, cache: 0.017, type: "ark", remark: `官方 ¥0.6/¥3.6 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-mini", input: 0.029806, output: 0.298063, cache: 0.008, type: "ark", remark: `官方 ¥0.2/¥2.0 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-code", input: 0.4769, output: 2.384501, cache: 0.089, type: "ark", remark: `官方 ¥3.2/¥16 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1.8", input: 0.119225, output: 1.19225, cache: 0, type: "ark", remark: `官方 ¥0.8 入；输出按长度 ¥2.0(短)–¥8.0(长)，此处取长输出档 ¥8 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1.6", input: 0.119106, output: 1.192131, cache: 0, type: "ark", remark: `按 Seed-1.6 官方档位折算 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1-6-flash", input: 0.030045, output: 0.298301, cache: 0, type: "ark", remark: `高速档按官方 flash 档折算 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1-6-vision", input: 0.119106, output: 1.192131, cache: 0, type: "ark", remark: `视觉档按 Seed-1.6 同档折算 ÷ 6.71；来源 docs.volcengine.com 模型定价页` },

  // --- 小米 MiMo（2026-10-01 复核官方海外美元价，不使用人民币换算）---
  { model: "mimo-v2.5-pro", input: 0.435, output: 0.87, cache: 0.0036, type: "mimo", remark: "官方海外美元价（2026-10-01 复核）；2026-10-21 北京时间 10:00 下线；来源 https://mimo.mi.com/docs/en-US/price/pay-as-you-go" },
  { model: "mimo-v2.5", input: 0.14, output: 0.28, cache: 0.0028, type: "mimo", remark: "官方海外美元价（2026-10-01 复核）；2026-10-21 北京时间 10:00 下线；来源 https://mimo.mi.com/docs/en-US/price/pay-as-you-go" },
  { model: "mimo-v2.6-pro-ultraspeed", input: 4.35, output: 8.70, cache: 0.036, type: "mimo", remark: "官方海外美元价，UltraSpeed 为独立 API ID（2026-10-01 复核）；来源 https://mimo.mi.com/docs/en-US/price/pay-as-you-go" },

  // --- MiniMax（2026-10-01 复核官方美元价；M3 取 ≤512K 标准档，>512K 档翻倍）---
  { model: "MiniMax-M3", input: 0.30, output: 1.20, cache: 0.06, tiers: [{ minInputTokens: 512001, input: 0.60, output: 2.40, cache: 0.12 }], type: "minimax", remark: "官方美元价，≤512k 输入标准档永久五折；>512k 输入全请求用长档，priority 参数为标准价 1.5 倍（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.7", input: 0.30, output: 1.20, cache: 0.06, type: "minimax", remark: "官方美元价（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.7-highspeed", input: 0.60, output: 2.40, cache: 0.06, type: "minimax", remark: "官方美元价，高速版为独立 API ID（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.5", input: 0.30, output: 1.20, cache: 0.03, type: "minimax", remark: "官方美元历史价（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.5-highspeed", input: 0.60, output: 2.40, cache: 0.03, type: "minimax", remark: "官方美元历史价，高速版为独立 API ID（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.1", input: 0.30, output: 1.20, cache: 0.03, type: "minimax", remark: "官方美元历史价（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2.1-highspeed", input: 0.60, output: 2.40, cache: 0.03, type: "minimax", remark: "官方美元历史价，高速版为独立 API ID（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },
  { model: "MiniMax-M2", input: 0.30, output: 1.20, cache: 0.03, type: "minimax", remark: "官方美元历史价（2026-10-01 复核）；来源 https://platform.minimax.io/docs/guides/pricing-paygo" },

  // --- 阶跃星辰 StepFun（2026-09 接入；官方人民币价，含缓存命中档）---
  { model: "step-5-preview", input: 1.043219, output: 2.980626, cache: 0.052161, type: "stepfun", remark: `官方 ¥7/¥20/缓存命中 ¥0.35 ÷ 6.71；来源 platform.stepfun.com 定价页` },
  { model: "step-3.7-flash", input: 0.201192, output: 1.207154, cache: 0.040238, type: "stepfun", remark: `官方 ¥1.35/¥8.1/缓存命中 ¥0.27 ÷ 6.71；来源 platform.stepfun.com 定价页` },
  { model: "step-3.5-flash", input: 0.104322, output: 0.312966, cache: 0.020864, type: "stepfun", remark: `官方 ¥0.7/¥2.1/缓存命中 ¥0.14 ÷ 6.71；来源 platform.stepfun.com 定价页` },
  { model: "step-3.5-flash-2603", input: 0.104083, output: 0.313323, cache: 0.020387, type: "stepfun", remark: `同 step-3.5-flash 官方档位 ÷ 6.71；来源 platform.stepfun.com 定价页` },

  // --- OpenAI（2026-10-01 官网 Standard 美元价；>272000 输入时全请求走长上下文档）---
  // Fast/Flex/Batch 是处理模式，不能从聚合模型后缀直接断定已使用该折扣档。
  { model: "gpt-6.1-sol", input: 2.00, output: 10.00, cache: 0.10, tiers: [{ minInputTokens: 272001, input: 4.00, output: 15.00, cache: 0.20 }], type: "openai", remark: "官方 Standard 美元价，最新 Sol；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-6-sol", input: 2.00, output: 10.00, cache: 0.20, tiers: [{ minInputTokens: 272001, input: 4.00, output: 15.00, cache: 0.40 }], type: "openai", remark: "官方 Standard 美元价，独立于 6.1 Sol；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-6-luna", input: 0.10, output: 0.50, cache: 0.01, tiers: [{ minInputTokens: 272001, input: 0.20, output: 0.75, cache: 0.02 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-4o", input: 2.50, output: 10.00, cache: 1.25, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-4o-mini", input: 0.15, output: 0.60, cache: 0.075, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5-mini", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5-nano", input: 0.05, output: 0.40, cache: 0.005, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o3", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o4-mini", input: 1.10, output: 4.40, cache: 0.275, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.6-sol", input: 4.00, output: 20.00, cache: 0.40, tiers: [{ minInputTokens: 272001, input: 8.00, output: 30.00, cache: 0.80 }], type: "openai", remark: "官方 Standard 美元促销价至少持续至2026-11-21；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.6-terra", input: 2.00, output: 12.00, cache: 0.20, tiers: [{ minInputTokens: 272001, input: 4.00, output: 18.00, cache: 0.40 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.6-luna", input: 0.20, output: 1.20, cache: 0.02, tiers: [{ minInputTokens: 272001, input: 0.40, output: 1.80, cache: 0.04 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.5", input: 5.00, output: 30.00, cache: 0.50, tiers: [{ minInputTokens: 272001, input: 10.00, output: 45.00, cache: 1.00 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.5-pro", input: 30.00, output: 180.00, cache: null, tiers: [{ minInputTokens: 272001, input: 60.00, output: 270.00, cache: null }], type: "openai", remark: "官方真实独立 Pro 档，无缓存价；>272000 输入用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.4", input: 2.50, output: 15.00, cache: 0.25, tiers: [{ minInputTokens: 272001, input: 5.00, output: 22.50, cache: 0.50 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.4-pro", input: 30.00, output: 180.00, cache: null, tiers: [{ minInputTokens: 272001, input: 60.00, output: 270.00, cache: null }], type: "openai", remark: "官方真实独立 Pro 档，无缓存价；>272000 输入用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.4-mini", input: 0.75, output: 4.50, cache: 0.075, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.4-nano", input: 0.20, output: 1.25, cache: 0.02, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.2", input: 1.75, output: 14.00, cache: 0.175, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.2-pro", input: 21.00, output: 168.00, cache: null, type: "openai", remark: "官方真实独立 Pro 档，无缓存价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.1", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5-pro", input: 15.00, output: 120.00, cache: null, type: "openai", remark: "官方真实独立 Pro 档，无缓存价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-4.1", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-4.1-mini", input: 0.40, output: 1.60, cache: 0.10, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-4.1-nano", input: 0.10, output: 0.40, cache: 0.025, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o1", input: 15.00, output: 60.00, cache: 7.50, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o1-pro", input: 150.00, output: 600.00, cache: null, type: "openai", remark: "官方真实独立 Pro 档，无缓存价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o3-pro", input: 20.00, output: 80.00, cache: null, type: "openai", remark: "官方真实独立 Pro 档，无缓存价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "o3-mini", input: 1.10, output: 4.40, cache: 0.55, type: "openai", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "chat-latest", input: 5.00, output: 30.00, cache: 0.50, type: "openai", remark: "官方 ChatGPT API 独立 ID，跟随最新（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.3-codex", input: 1.75, output: 14.00, cache: 0.175, type: "openai", remark: "官方 Codex API 独立 ID（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5-search-api", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方 Search API 独立 ID；工具费另计，非本表 token 费（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.6-cyber", input: 12.50, output: 75.00, cache: 1.25, type: "openai", remark: "官方 Daybreak 专用美元价；目录登记不表示当前渠道授权可用（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "gpt-5.5-cyber", input: 12.50, output: 75.00, cache: 1.25, type: "openai", remark: "官方 Daybreak 专用美元价；目录登记不表示当前渠道授权可用（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },

  { model: "qwen3-coder-next", input: 0.144, output: 0.574, cache: null, tiers: [{ minInputTokens: 32001, input: 0.216, output: 0.861, cache: null }, { minInputTokens: 128001, input: 0.359, output: 1.434, cache: null }], type: "qwen", remark: "官方Beijing美元价；>32K/>128K输入分档，缓存待确认（2026-10-02复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing" },

  // --- Anthropic（美元牌价）--- 渠道类型统一用 anthropic（与 channel-types 的接入方式一致，
  // 之前写 "claude" 会和模型登记表/定价导入校验打架）
  { model: "claude-fable-5-1", input: 10.00, output: 50.00, cache: 0.25, type: "anthropic", remark: "官方美元价，API ID 经官网发布页确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://www.anthropic.com/claude-fable-and-mythos-5-1" },
  { model: "claude-opus-5-5", input: 4.00, output: 20.00, cache: 0.20, type: "anthropic", remark: "官方美元价，API ID 经官网发布页确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://www.anthropic.com/news/claude-opus-5-5" },
  { model: "claude-sonnet-5-5", input: 2.00, output: 10.00, cache: 0.20, type: "anthropic", remark: "官方美元价，API ID 经官网模型页确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://www.anthropic.com/claude/sonnet" },
  { model: "claude-opus-5", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://www.anthropic.com/pricing" },
  { model: "claude-sonnet-5", input: 2.00, output: 10.00, cache: 0.20, type: "anthropic", remark: "官方 Standard 美元价（2026-10-01 复核）；来源 https://www.anthropic.com/pricing" },
  { model: "claude-haiku-4-5", input: 1.00, output: 5.00, cache: 0.10, type: "anthropic", remark: "官方 Standard 美元价，规范 API ID 经官方 SDK 确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },
  { model: "claude-fable-5", input: 10.00, output: 50.00, cache: 1.00, type: "anthropic", remark: "官方上一代 Fable 美元价，独立于5.1（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },
  { model: "claude-opus-4-8", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方美元历史价，规范 API ID 经官方 SDK 确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },
  { model: "claude-opus-4-7", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方美元历史价，规范 API ID 经官方 SDK 确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },
  { model: "claude-opus-4-6", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方美元历史价，规范 API ID 经官方 SDK 确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },

  { model: "claude-mythos-5-1", input: 10, output: 50, cache: 0.25, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },
  { model: "claude-mythos-5", input: 10, output: 50, cache: 1, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },
  { model: "claude-opus-4-1", input: 15, output: 75, cache: 1.5, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },
  { model: "claude-opus-4", input: 15, output: 75, cache: 1.5, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },
  { model: "claude-sonnet-4", input: 3, output: 15, cache: 0.3, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },
  { model: "claude-haiku-3-5", input: 0.8, output: 4, cache: 0.08, type: "anthropic", remark: "官方Standard美元价（2026-10-02复核）；来源 https://platform.claude.com/docs/en/about-claude/pricing" },

  // --- Google（美元牌价）---
  { model: "gemini-3.5-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "官方 Standard 文本美元价（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.6-flash", input: 0.75, output: 3.75, cache: 0.075, scheduledPrices: [{ from: "2027-01-01T00:00:00Z", input: 1.50, output: 7.50, cache: 0.15 }], type: "gemini", remark: "官方 Standard 美元促销价至2026-12-31；2027-01-01起1.50/7.50/0.15，官网未明确切换时区，本表按UTC日期（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.7-flash", input: 0.75, output: 3.75, cache: 0.075, scheduledPrices: [{ from: "2027-01-01T00:00:00Z", input: 1.50, output: 7.50, cache: 0.15 }], type: "gemini", remark: "官方 Standard 美元促销价至2026-12-31；2027-01-01起1.50/7.50/0.15，官网未明确切换时区，本表按UTC日期（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.5-flash-lite", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "官方 Standard 文本美元价（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.1-flash-lite", input: 0.25, output: 1.50, cache: 0.025, type: "gemini", remark: "官方 Standard 文本美元价；音频输入0.50/缓存0.05不包含在此文本档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.1-pro-preview", input: 2.00, output: 12.00, cache: 0.20, tiers: [{ minInputTokens: 200001, input: 4.00, output: 18.00, cache: 0.40 }], type: "gemini", remark: "官方 Standard 美元价；>200000 输入全请求用长档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3.1-pro-preview-customtools", input: 2.00, output: 12.00, cache: 0.20, tiers: [{ minInputTokens: 200001, input: 4.00, output: 18.00, cache: 0.40 }], type: "gemini", remark: "官方独立 Custom Tools endpoint，与3.1 Pro同价；>200000 输入用长档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-3-flash-preview", input: 0.50, output: 3.00, cache: 0.05, type: "gemini", remark: "官方 Standard 文本美元价；音频输入1.00/缓存0.10不包含在此文本档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-robotics-er-2-preview", input: 1.00, output: 5.00, cache: 0.10, scheduledPrices: [{ from: "2027-01-01T00:00:00Z", input: 2.00, output: 10.00, cache: 0.20 }], type: "gemini", remark: "官方 Standard 美元促销价至2026-12-31；2027-01-01起2.00/10.00/0.20，官网未明确切换时区，本表按UTC日期（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.00, cache: 0.125, tiers: [{ minInputTokens: 200001, input: 2.50, output: 15.00, cache: 0.25 }], type: "gemini", remark: "官方 Standard 美元价；>200000 输入全请求用长档；仅向已有活跃用户开放（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "官方 Standard 文本美元价；音频输入1.00/缓存0.10不包含在此文本档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },

  // --- xAI Grok（美元牌价，取自 docs.x.ai 页面内嵌的 __XAI_PUBLIC_MODELS__ 官方价表；
  //     价格为「每百万 token」，页面单位是 1e-4 美元）---
  { model: "grok-4.7", input: 2.00, output: 6.00, cache: 0.50, tiers: [{ minInputTokens: 200000, input: 4.00, output: 12.00, cache: 1.00 }], type: "grok", remark: "官方 global 美元价，最新 API ID；>=200000 输入全请求用长档；US区域另加10%（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-build-0.1", input: 1.00, output: 2.00, cache: 0.20, tiers: [{ minInputTokens: 200000, input: 2.00, output: 4.00, cache: 0.40 }], type: "grok", remark: "官方 global 美元价，独立 API ID；>=200000 输入用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.6", input: 2.00, output: 6.00, cache: 0.50, tiers: [{ minInputTokens: 200000, input: 4.00, output: 12.00, cache: 1.00 }], type: "grok", remark: "官方 global 美元价；>=200000 输入全请求用长档；旧2.2/6.6为US区域短档而非长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.5", input: 2.00, output: 6.00, cache: 0.30, tiers: [{ minInputTokens: 200000, input: 4.00, output: 12.00, cache: 0.60 }], type: "grok", remark: "官方 global 美元价；>=200000 输入全请求用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.3", input: 1.25, output: 2.50, cache: 0.20, tiers: [{ minInputTokens: 200000, input: 2.50, output: 5.00, cache: 0.40 }], type: "grok", remark: "官方 global 美元价；>=200000 输入全请求用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.20-multi-agent-0309", input: 1.25, output: 2.50, cache: 0.20, tiers: [{ minInputTokens: 200000, input: 2.50, output: 5.00, cache: 0.40 }], type: "grok", remark: "官方独立 multi-agent API ID；>=200000 输入用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.20-0309-reasoning", input: 1.25, output: 2.50, cache: 0.20, tiers: [{ minInputTokens: 200000, input: 2.50, output: 5.00, cache: 0.40 }], type: "grok", remark: "官方独立 reasoning API ID；>=200000 输入用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },
  { model: "grok-4.20-0309-non-reasoning", input: 1.25, output: 2.50, cache: 0.20, tiers: [{ minInputTokens: 200000, input: 2.50, output: 5.00, cache: 0.40 }], type: "grok", remark: "官方独立 non-reasoning API ID；>=200000 输入用长档（2026-10-01 复核）；来源 https://docs.x.ai/developers/pricing" },

  // --- 后续批次新接入的档位（此前落到兜底价 0.30/1.20 并打告警）---
  // 阿里通义：qwen-max 对应官方 max 档，turbo/flash 是轻量档
  { model: "qwen-max", input: 0.345, output: 1.377, cache: 0.069, type: "qwen", remark: "官方Beijing美元价，真实独立API ID无分档；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen-max-latest", input: 0.37234, output: 1.490432, cache: 0, type: "qwen", remark: `官方 max 最新版同档价 ÷ 6.71；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-turbo", input: 0.044, output: 0.087, cache: 0.0088, type: "qwen", remark: "官方Beijing非思考美元价；思考输出另为0.431，缓存取官网隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing" },
  { model: "qwen-flash", input: 0.022, output: 0.216, cache: 0.0044, tiers: [{ minInputTokens: 128001, input: 0.087, output: 0.861, cache: 0.0174 }, { minInputTokens: 256001, input: 0.173, output: 1.721, cache: 0.0346 }], type: "qwen", remark: "官方Beijing美元价，真实独立API ID；>128000/>256000输入分档；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "qwen3.7-max", input: 1.65, output: 4.951, cache: 0.33, type: "qwen", remark: "官方Beijing美元价，真实独立API ID，≤1000000输入；缓存取隐式20%（2026-10-01 复核）；来源 https://www.alibabacloud.com/help/en/model-studio/model-pricing 与 https://www.alibabacloud.com/help/en/model-studio/context-cache" },
  { model: "gemini-3.8-flash", input: 0.75, output: 3.75, cache: 0.075, scheduledPrices: [{ from: "2027-01-01T00:00:00Z", input: 1.50, output: 7.50, cache: 0.15 }], type: "gemini", remark: "官方 Standard 美元促销价至2026-12-31；2027-01-01起1.50/7.50/0.15，官网未明确切换时区，本表按UTC日期（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash-lite", input: 0.10, output: 0.40, cache: 0.01, type: "gemini", remark: "官方 Standard 文本美元价；音频输入0.30/缓存0.03不包含在此文本档（2026-10-01 复核）；来源 https://ai.google.dev/gemini-api/docs/pricing" },
  // Anthropic：4.5 代 sonnet/haiku（旧代命名，按官方历史价录入）
  { model: "claude-sonnet-4-6", input: 3.00, output: 15.00, cache: 0.30, type: "anthropic", remark: "官方美元历史价，规范 API ID 经发布页确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://www.anthropic.com/news/claude-sonnet-4-6" },
  { model: "claude-sonnet-4-5", input: 3.00, output: 15.00, cache: 0.30, type: "anthropic", remark: "官方美元历史价，规范 API ID 经发布页确认（2026-10-01 复核）；2026-11-30下线；来源 https://www.anthropic.com/pricing 与 https://www.anthropic.com/news/claude-sonnet-4-5" },
  { model: "claude-opus-4-5", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方美元历史价，规范 API ID 经官方 SDK 确认（2026-10-01 复核）；来源 https://www.anthropic.com/pricing 与 https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts" },
  // 智谱视觉档：与对应文本档同价（官方视觉不加价）
  { model: "glm-5v", input: 0.640835, output: 2.354694, cache: 0.11, type: "glm", remark: `视觉档与 glm-5.2 同价 ¥4.3/¥15.8 ÷ 6.71；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.6v", input: 0.30, output: 0.90, cache: 0.05, type: "glm", remark: "Z.AI 官方美元视觉档价（2026-10-01 复核）；来源 https://docs.z.ai/guides/overview/pricing" },
  { model: "glm-4v", input: 0.149031, output: 0.149031, cache: 0, type: "glm", remark: `官方 glm-4v ¥1/¥1 ÷ 6.71；来源 open.bigmodel.cn/pricing` },
  // WorkBuddy（腾讯托管）的 DeepSeek 档：与官方 deepseek-flash 是**同一个模型**
  // （官方已把 V4.1-Flash 更名为 deepseek-flash，用户确认），不再单独定价 ——
  // 托管渠道声明旧 id deepseek-v4.1-flash，路由按别名归一（deepseek-models.js#ALIASES），
  // 计费走上面 deepseek-flash 一行（峰谷同价口径）。
  { model: "mimo-v2.6-pro", input: 0.435, output: 0.87, cache: 0.0036, type: "mimo", remark: "官方海外美元价（2026-10-01 复核）；来源 https://mimo.mi.com/docs/en-US/price/pay-as-you-go" },
  // 美团 LongCat：尚未取得官方美元价，保留历史平台价等待复核。

  // --- 上一代档位：仍在注册表里可被请求，不给价会按「同厂商最贵档」兜底，
  //     即用旗舰价收轻量档的钱（最多差 20 倍）。按官方历史价补录。---
  { model: "glm-4", input: 0.149031, output: 0.149031, cache: 0, type: "glm", remark: `官方 ¥1/¥1（4 代基础档）÷ 6.71；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-plus", input: 0.745156, output: 0.745156, cache: 0, type: "glm", remark: `官方 ¥5/¥5（4 代增强档）÷ 6.71；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-air", input: 0.014903, output: 0.014903, cache: 0, type: "glm", remark: `官方 ¥0.1/¥0.1（4 代轻量）÷ 6.71；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-flash", input: 0, output: 0, cache: 0, type: "glm", remark: "官方免费档（¥0）；来源 open.bigmodel.cn/pricing" },
  { model: "glm-4-flashx", input: 0.014903, output: 0.014903, cache: 0, type: "glm", remark: `官方 ¥0.1/¥0.1 高速版 ÷ 6.71；来源 open.bigmodel.cn/pricing` },
  // kimi-latest / kimi-thinking 是官方「跟随最新档」的别名，按 k2.6 档价录入
  { model: "kimi-latest", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "跟随最新档，按 k2.6 同价录入；来源 platform.kimi.com/docs/pricing/chat" },
  { model: "kimi-thinking", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "思考档，按 k2.6 同价录入；来源 platform.kimi.com/docs/pricing/chat" },
  { model: "moonshot-v1-8k", input: 0.178838, output: 0.178838, cache: 0, type: "kimi", remark: `官方 ¥1.2/¥1.2（8K）÷ 6.71；来源 platform.moonshot.cn/docs/pricing` },
  { model: "moonshot-v1-32k", input: 0.357675, output: 0.357675, cache: 0, type: "kimi", remark: `官方 ¥2.4/¥2.4（32K）÷ 6.71；来源 platform.moonshot.cn/docs/pricing` },
  { model: "moonshot-v1-128k", input: 0.894188, output: 0.894188, cache: 0, type: "kimi", remark: `官方 ¥6/¥6（128K）÷ 6.71；来源 platform.moonshot.cn/docs/pricing` },
  // 聚合渠道上的开源权重模型（OpenRouter / NIM 常用 `vendor/模型` 形式，
  // 前缀会被 getPrice 剥掉，这里按对应开源模型的托管价录入）
  { model: "deepseek-chat", input: 0.27, output: 1.10, cache: 0.07, type: "deepseek", remark: "DeepSeek-V3 对话档官方价（旧命名 deepseek-chat）；来源 api-docs.deepseek.com/quick_start/pricing/" },
  { model: "qwen3-235b-a22b", input: 0.20, output: 0.60, cache: 0.02, type: "qwen", remark: "Qwen3-235B 开源权重，按官方百炼托管价录入；来源 help.aliyun.com/zh/model-studio" },

  // --- 线上实测发现的「渠道在用但无价」的模型（新门禁会拦下它们，故补录）---
  // 仅收录可核实的官方报价；未公布价格的型号保留待定价。
  { model: "gpt-6-astra", input: 10.00, output: 50.00, cache: 1.00, tiers: [{ minInputTokens: 272001, input: 20.00, output: 75.00, cache: 2.00 }], type: "openai", remark: "官方 Standard 美元价；>272000 输入全请求用长档（2026-10-01 复核）；来源 https://developers.openai.com/api/docs/pricing" },
  { model: "mimo-v2.6-flash", input: 0.14, output: 0.28, cache: 0.0028, type: "mimo", remark: "官方海外美元价（2026-10-01 复核）；来源 https://mimo.mi.com/docs/en-US/price/pay-as-you-go" },
];

// 价格缓存（避免每请求查库）
let priceCache = new Map();
let priceCacheAt = 0;
const PRICE_TTL_MS = 30_000;

export async function loadPrices() {
  // 注意用时间戳判断而不是 size：空表也是合法结果，否则每次调用都会查库
  if (Date.now() - priceCacheAt < PRICE_TTL_MS) return priceCache;
  const [rows] = await pool.query("SELECT * FROM model_prices");
  const m = new Map();
  for (const r of rows) {
    if (/估录|对标 .*官方价|归属规则/.test(r.remark || "")) continue;
    m.set(String(r.model).toLowerCase(), {
      model: r.model,
      input: Number(r.input_price) || 0,
      output: Number(r.output_price) || 0,
      cache: Number(r.cache_price) || 0,
      tiers: parsePriceTiers(r.price_tiers),
      // 闲时价：NULL 表示不启用分时（与改造前行为一致）
      offpeakInput: r.offpeak_input_price === null ? null : Number(r.offpeak_input_price),
      offpeakOutput: r.offpeak_output_price === null ? null : Number(r.offpeak_output_price),
      offpeakCache: r.offpeak_cache_price === null ? null : Number(r.offpeak_cache_price),
      offpeakRule: r.offpeak_rule || "",
      type: r.channel_type || "",
      remark: r.remark || "",
    });
  }
  priceCache = m;
  priceCacheAt = Date.now();
  return m;
}

export function invalidatePrices() {
  priceCacheAt = 0;
}

// ---------------------------------------------------------------------------
// 分时（峰谷）定价
// ---------------------------------------------------------------------------
// 背景：多数厂商按时段统一定价，但 DeepSeek 官方按钟点差异定价
// （高峰=北京时间周一至周五 9:00-12:00、14:00-18:00，其余时段半价；
// 阿里百炼托管的 DeepSeek 窗口不同，是每天 22:00-08:00 为闲时）。
// 因此规则必须可配，不能写死窗口。
//
// 为什么用固定 UTC 偏移而不是 Intl/timeZone：
//   中国无夏令时，偏移运算不依赖 ICU，跨平台（不同 Node 构建）行为完全一致。
// 规则 JSON：{ "offset": 8, "days": [1,2,3,4,5], "peak": [["09:00","12:00"],["14:00","18:00"]] }
//   offset = 相对 UTC 的小时偏移（8 = 北京时间）
//   days   = 视作「工作日」的星期（1=周一 … 7=周日）；不在其中 = 全天闲时
//   peak   = 高峰窗口；窗口之外均为闲时（与官方「其余为空闲时段」表述一致）
// 跨零点窗口（如 22:00-08:00）也支持：起 > 止时按「跨天」处理。

function parseRule(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":");
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh)) return null;
  return hh * 60 + (Number.isFinite(mm) ? mm : 0);
}

/** 给定时刻是否处于高峰时段（规则缺失时一律视为高峰 = 用基准价，保持向后兼容） */
export function isPeakAt(rule, atMs) {
  const r = parseRule(rule);
  if (!r || !Array.isArray(r.peak) || !r.peak.length) return true;
  const offset = Number(r.offset) || 0;
  // 先偏移到规则所在时区，再用 UTC 取值：避免依赖进程时区设置
  const d = new Date(Number(atMs) + offset * 3600_000);
  const date = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  if (Array.isArray(r.offpeakDates) && r.offpeakDates.some((range) => Array.isArray(range) && range.length === 2 && date >= range[0] && date <= range[1])) return false;
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (Array.isArray(r.days) && r.days.length && !r.days.includes(day)) return false;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return r.peak.some(([a, b]) => {
    const s = toMinutes(a);
    const e = toMinutes(b);
    if (s === null || e === null) return false;
    // 起 > 止 = 跨零点（如 22:00-08:00）
    return s <= e ? min >= s && min < e : min >= s || min < e;
  });
}

/**
 * 取「该时刻生效的单价」。
 * 必须返回**新对象**：getPrice 返回的是 30s 缓存里的同一个引用，
 * 就地改 input/output 会污染同缓存周期内的所有请求。
 * @returns {{price: object, phase: "peak"|"offpeak"|"flat"}}
 */
export function effectivePrice(price, atMs = Date.now()) {
  const timed = parsePriceTiers(price?.tiers).filter((t) => t.from && Date.parse(t.from) <= Number(atMs))
    .sort((a, b) => Date.parse(b.from) - Date.parse(a.from))[0];
  if (timed) price = { ...price, input: timed.input ?? price.input, output: timed.output ?? price.output, cache: timed.cache ?? price.cache };
  const hasOff = price?.offpeakInput != null || price?.offpeakOutput != null || price?.offpeakCache != null;
  // 没配闲时价 → 全时段按基准价（flat），与改造前逐厘一致
  if (!hasOff) return { price, phase: "flat" };
  if (isPeakAt(price.offpeakRule, atMs)) return { price, phase: "peak" };
  return {
    phase: "offpeak",
    price: {
      ...price,
      input: price.offpeakInput ?? price.input,
      output: price.offpeakOutput ?? price.output,
      cache: price.offpeakCache ?? price.cache,
    },
  };
}

/** 给人看的规则摘要（管理端展示；识别不出规则时返回空串） */
export function describeRule(rule) {
  const r = parseRule(rule);
  if (!r || !Array.isArray(r.peak) || !r.peak.length) return "";
  const offset = Number(r.offset) || 0;
  const tz = offset === 8 ? "北京" : offset === 0 ? "UTC" : `UTC${offset >= 0 ? "+" : ""}${offset}`;
  const days = Array.isArray(r.days) && r.days.length ? (r.days.length === 7 ? "每天" : `周${r.days.join("/")}`) : "每天";
  const wins = r.peak.map(([a, b]) => `${a}-${b}`).join("、");
  return `${tz}时间 ${days} ${wins} 为高峰，其余半价${r.offpeakDates?.length ? "（含已配置公共假期）" : ""}`;
}

// 只认定价表里的规范模型，不再把前缀相似、聚合规则或同厂商档位当作定价。
export async function getPrice(model) {
  const { canonicalModelName } = await import("./models.js");
  const key = canonicalModelName(model);
  const price = (await loadPrices()).get(key);
  if (price) return { ...price, exact: true };
  // 失败审计可以记录零消耗，但执行入口必须先通过 assertModelPriced。
  return { model: key, input: 0, output: 0, cache: 0, type: "", exact: false, unpriced: true };
}

export async function assertModelPriced(model) {
  if (!await isModelPriced(model)) throw Object.assign(new Error(`模型「${model}」尚未定价，请联系管理员确认归属或配置价格`), { code: "MODEL_NOT_PRICED", status: 400, model, billable: false });
}


// 计费：返回「厘」为单位的整数
/**
 * @param {object} p
 * @param {object} p.price            生效单价（已套峰谷）
 * @param {number} p.promptTokens
 * @param {number} p.completionTokens
 * @param {number} p.cacheTokens
 * @param {string} [p.contextBilling] 账号级计费口径（渠道 other.context_billing）：
 *   auto/full  = 输入+输出 都计（默认）
 *   input_only = 只计输入（上游按上下文长度计费、不按生成量计费的账号；
 *                **会改变用户实际扣费**，仅在该账号确实如此计费时才设）
 */
export function parsePriceTiers(raw) {
  try { const list = typeof raw === "string" ? JSON.parse(raw) : raw; return Array.isArray(list) ? list.filter((t) => t && (t.from ? Number.isFinite(Date.parse(t.from)) : Number.isFinite(Number(t.minInputTokens)) && Number(t.minInputTokens) > 0) && [t.input, t.output, t.cache].every((v) => v == null || Number.isFinite(Number(v)) && Number(v) >= 0)) : []; }
  catch { return []; }
}

/** 官方上下文档按整次输入量选价，不只给超过阈值的尾部 token 加价。 */
export function priceForTokens(price, promptTokens = 0) {
  const tier = parsePriceTiers(price?.tiers).filter((t) => !t.from && Number(promptTokens) >= Number(t.minInputTokens) && Number(t.minInputTokens) > 0)
    .sort((a, b) => Number(b.minInputTokens) - Number(a.minInputTokens))[0];
  return tier ? { ...price, input: tier.input ?? price.input, output: tier.output ?? price.output, cache: tier.cache ?? price.cache, contextTier: Number(tier.minInputTokens) } : price;
}

export function storedPriceTiers(p) {
  const list = [...(p.tiers || []), ...(p.scheduledPrices || [])];
  return list.length ? JSON.stringify(list) : null;
}

function costAmounts({ price, promptTokens = 0, completionTokens = 0, cacheTokens = 0, contextBilling = "auto" }) {
  price = priceForTokens(price, promptTokens);
  // 缓存命中不能超过输入总量（上游字段异常时按输出去重，避免负基数）
  const cache = Math.max(0, Math.min(Number(cacheTokens) || 0, Number(promptTokens) || 0));
  const base = Math.max(0, (Number(promptTokens) || 0) - cache);
  // 未配置缓存价（NULL/0）时回退输入价：直接按 0 计费等于对缓存命中部分免单
  const cachePrice = Number(price.cache) > 0 ? Number(price.cache) : Number(price.input) || 0;
  const outTokens = contextBilling === "input_only" ? 0 : Number(completionTokens) || 0;
  const input = (base / 1e6) * price.input;
  const output = (outTokens / 1e6) * price.output;
  const cached = (cache / 1e6) * cachePrice;
  return { price, base, outTokens, cache, cachePrice, input, output, cached, od: input + output + cached };
}

export function computeCost(args) {
  const { od } = costAmounts(args);
  // 先做微小的浮点校正再向上取整，避免 0.0001 的表示误差多收 1 厘
  const units = od * UNITS_PER_OD;
  return Math.max(1, Math.ceil(Math.round(units * 1e6) / 1e6));
}

const auditNumber = (n) => Number(Number(n || 0).toFixed(12));

/** 计费快照与真实扣费复用同一公式；不对各分项单独取整，避免改动金额。 */
export function billingDetails({ calls = [], multiplier = 1, chargedUnits = 0, baseUnits = null } = {}) {
  const rows = calls.map((call) => {
    const t = call.tokens || {};
    const a = costAmounts({ price: call.price, ...t, contextBilling: call.contextBilling || "auto" });
    const component = (tokens, unitPrice, cost) => ({ tokens, unit_price: Number(unitPrice) || 0, cost_od: auditNumber(cost) });
    return {
      components: {
        input: component(a.base, a.price.input, a.input),
        output: component(a.outTokens, call.contextBilling === "input_only" ? 0 : a.price.output, a.output),
        cache: component(a.cache, a.cachePrice, a.cached),
      },
      platform_price: { in: Number(a.price.input) || 0, out: call.contextBilling === "input_only" ? 0 : Number(a.price.output) || 0, cache: a.cachePrice },
      raw_cost_od: auditNumber(a.od),
      billable: call.billable !== false,
      base_cost_units: call.billable === false ? 0 : computeCost({ price: call.price, ...t, contextBilling: call.contextBilling || "auto" }),
      price_phase: call.phase || "peak", context_tier: Number(a.price.contextTier) || 0,
      priced_at: Number(call.at) || 0, context_billing: call.contextBilling || "auto",
      ...(call.requestedModel ? { requested_model: call.requestedModel } : {}),
      ...(call.upstreamModel ? { upstream_model: call.upstreamModel } : {}),
      ...(call.pricingModel ? { pricing_model: call.pricingModel } : {}),
      channel_quote: call.channelQuote || null,
    };
  });
  const components = {};
  for (const key of ["input", "output", "cache"]) {
    const prices = new Set(rows.map((r) => r.components[key].unit_price));
    components[key] = { tokens: rows.reduce((n, r) => n + r.components[key].tokens, 0),
      unit_price: prices.size === 1 ? [...prices][0] : null,
      mixed: prices.size > 1,
      cost_od: auditNumber(rows.reduce((n, r) => n + r.components[key].cost_od, 0)) };
  }
  const rawCost = auditNumber(rows.reduce((n, r) => n + r.raw_cost_od, 0));
  const base = baseUnits === null ? rows.reduce((n, r) => n + r.base_cost_units, 0) : Number(baseUnits) || 0;
  const rate = Number(multiplier) || 1;
  const charged = chargedUnits === null ? null : Number(chargedUnits) || 0;
  const phases = [...new Set(rows.map((r) => r.price_phase))];
  const platformPrices = new Set(rows.map((r) => JSON.stringify(r.platform_price)));
  const unitPrices = Object.fromEntries(["input", "output", "cache"].map((key) => [key,
    [...new Set(rows.map((r) => r.components[key].unit_price))].slice(0, 40)]));
  const usagePresent = rows.some((r) => Object.values(r.components).some((c) => c.tokens > 0));
  return { version: 1, components,
    platform_unit_prices: unitPrices, usage_present: usagePresent,
    price_quoted: !usagePresent || rows.every((r) => !r.billable),
    platform_price: platformPrices.size === 1 ? rows[0].platform_price : null,
    price_mode: platformPrices.size > 1 ? "mixed" : "single",
    raw_cost_od: rawCost, base_cost_units: base, base_cost_od: auditNumber(base / UNITS_PER_OD), multiplier: rate,
    charged_cost_units: charged, charged_cost_od: charged === null ? null : auditNumber(charged / UNITS_PER_OD),
    pre_rate_rounding_units: auditNumber(base - rawCost * UNITS_PER_OD),
    adjustment_units: charged === null ? null : auditNumber(charged - base * rate),
    price_phase: phases.join("+") || "peak", context_tier: rows.length === 1 ? rows[0].context_tier : null,
    channel_quote: rows.length === 1 ? rows[0].channel_quote : null,
    quote_mode: rows.length > 1 ? "mixed" : "single",
    call_count: rows.length, calls: rows.slice(0, 40) };
}

/**
 * 归一化上游 usage：
 *   · 对象（OpenAI 兼容渠道返回 {prompt_tokens, completion_tokens, cached_tokens}）
 *   · 数字（反代适配器只给总量）
 *   · null（完全不提供）
 * @returns {{promptTokens:number, completionTokens:number, cacheTokens:number, totalTokens:number, hasDetail:boolean}}
 */
// 单次 usage 上限：正常对话不可能超过 1 亿 token（约 3 亿字符）。
// 上游返回异常值（如 1e15）时不至于把用户额度与日志一次拉爆。
const MAX_USAGE = 1e8;
const clampUsage = (n) => Math.max(0, Math.min(MAX_USAGE, Math.round(Number(n) || 0)));

export function normalizeUsage(u) {
  if (!u) return { promptTokens: 0, completionTokens: 0, cacheTokens: 0, totalTokens: 0, hasDetail: false, partial: false };
  if (typeof u === "object") {
    const p = clampUsage(u.prompt_tokens ?? u.input_tokens);
    const c = clampUsage(u.completion_tokens ?? u.output_tokens);
    const cache = clampUsage(
      u.cached_tokens ?? u.cache_tokens ?? u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens
    );
    const total = clampUsage(u.total_tokens) || p + c;
    // 判定口径：**字段存在且值大于 0** 才算「这一侧有真实数据」。
    // 两种历史坑都由此避开：
    //   ① 上游只回 total_tokens，经 openai-compat 的 pickUsage 后被补成
    //      {prompt:0, completion:0, total:N} —— 若按「字段存在」判定就会当成精确明细，
    //      splitTokens 返回 0/0/0，整单只剩 1 单位兜底价（近乎白送）；
    //   ② 上游只回 output_tokens（豆包）—— 若把缺失的 prompt 当 0，
    //      整段输入（可能是几万 token 上下文）不计费。
    // 把「值为 0」与「字段缺失」一律视为「该侧没有数据」，交给估算补齐。
    const hasP = p > 0;
    const hasC = c > 0;
    const hasDetail = hasP && hasC;
    return {
      promptTokens: p,
      completionTokens: c,
      cacheTokens: Math.min(cache, p),
      totalTokens: total,
      hasDetail,
      // 只有一侧有数据：splitTokens 用真实的一侧 + 估算另一侧
      partial: (hasP || hasC) && !hasDetail,
      hasPrompt: hasP,
      hasCompletion: hasC,
    };
  }
  const t = clampUsage(u);
  return { promptTokens: 0, completionTokens: 0, cacheTokens: 0, totalTokens: t, hasDetail: false, partial: false };
}

// token 估算（仅在拿不到上游明细时使用）
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  // 中文约 1.5 字符/token，英文约 4 字符/token，取折中
  return Math.max(1, Math.ceil(s.length / 3));
}

// 拆分计费 token：
//   有上游明细 → 直接精确计费（含缓存命中）
//   只报了一侧（partial）→ 已报的那侧用真实值，缺的那侧估算补齐
//   只有总量   → 按估算比例拆分
//   什么都没有 → 全按估算
export function splitTokens({ prompt, output, upstreamTotal }) {
  const u = normalizeUsage(upstreamTotal);
  if (u.hasDetail) {
    // 唯一「精确」的分支：上游给了 input/output 明细，直接用
    return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, cacheTokens: u.cacheTokens, estimated: false };
  }
  const estP = estimateTokens(prompt);
  const estC = estimateTokens(output);
  if (u.partial) {
    // 上游只给了 input_tokens 或只给了 output_tokens：缺的一侧按字符估算，
    // 而不是当成 0（那会让这一侧完全不计费）。
    return {
      promptTokens: u.hasPrompt ? u.promptTokens : estP,
      completionTokens: u.hasCompletion ? u.completionTokens : estC,
      cacheTokens: u.cacheTokens,
      // 只要有一侧是估算的，整体就算 estimated —— 不能与精确计费混同口径
      estimated: !u.hasPrompt || !u.hasCompletion,
    };
  }
  if (u.totalTokens > 0 && estP + estC > 0) {
    const p = Math.max(1, Math.round((u.totalTokens * estP) / (estP + estC)));
    return { promptTokens: p, completionTokens: Math.max(1, u.totalTokens - p), cacheTokens: 0, estimated: true };
  }
  // 上游完全没给 usage：两侧都靠字符估算。
  // 网页反代渠道（mimo / minimax / stepfun）走的就是这条 —— 它们的响应里
  // 根本没有 usage，长上下文或思考型请求会系统性偏差（第 46 批复审点名）。
  // 计费仍按估算走（不能不计费），但必须**显式标记**，让调用方/日志能区分。
  return { promptTokens: estP, completionTokens: estC, cacheTokens: 0, estimated: true };
}

/**
 * 逐次调用的 token 汇总 —— 与「逐调用计费」**同一口径**（c.tokens 优先，其次按
 * usage / 字符估算）。日志、消息统计、消息 footer 展示的 token 数必须用这一组：
 *
 * 线上事故（用户实测报过）：失败/中止轮（kind=对话（部分））在没有可见正文时，
 * 调用方传进来的汇总还是 0/0，而钱是按「失败步的长上下文」算出来的 ——
 * 于是出现「收了费但 token 显示 0/0」的记录。根因就是**展示用的汇总**与
 * **计费用的逐调用**是两套算法；这里把汇总收敛成同一个函数，两边不再漂移。
 * @param {Array} calls [{ prompt, output, usage, tokens? }]
 */
export function sumCallTokens(calls = []) {
  const total = { promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
  for (const c of calls || []) {
    if (!c) continue;
    const t = c.tokens || splitTokens({ prompt: c.prompt || "", output: c.output || "", upstreamTotal: c.usage || null });
    total.promptTokens += t.promptTokens;
    total.completionTokens += t.completionTokens;
    total.cacheTokens += t.cacheTokens;
  }
  return total;
}

// 金额展示（OD 币）
export function unitsToOd(units) {
  return Number(units || 0) / UNITS_PER_OD;
}

export function formatOd(units, digits = 4) {
  return `${unitsToOd(units).toFixed(digits)} ${CURRENCY}`;
}

// 扣费：用户额度 + 令牌额度 + 计数。（历史函数已删除：路由统一用各自的原子扣费逻辑）

/**
 * 写入内置默认价格（仅在 model_prices 缺该模型时插入，绝不覆盖管理员改过的价格）。
 * 全新安装由启动流程调用，避免所有模型都落到「未配置价格」兜底档导致漏计费。
 */
export async function seedDefaultPrices() {
  const { canonicalModelName, warmAliasMap } = await import("./models.js");
  await warmAliasMap();
  const ts = now();
  let added = 0;
  for (const p of DEFAULT_PRICES) {
    if (canonicalModelName(p.model) !== String(p.model).toLowerCase()) continue;
    const [ret] = await pool.query(
      `INSERT INTO model_prices
         (model, input_price, output_price, cache_price,
          offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
          channel_type, remark, updated_time, price_tiers)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE model = model`,
      [
        p.model,
        p.input,
        p.output,
        p.cache ?? 0,
        p.offpeakInput ?? null,
        p.offpeakOutput ?? null,
        p.offpeakCache ?? null,
        p.offpeakRule ? JSON.stringify(p.offpeakRule) : null,
        p.type,
        p.remark,
        ts,
        storedPriceTiers(p),
      ]
    );
    if (ret.affectedRows === 1) added += 1;
  }
  if (added) {
    invalidatePrices();
    console.log(`[init] 已写入默认模型价格 ${added} 条（可在「模型定价」中调整）`);
  }
}

/** 管理员发布本轮已复核的官方价；独立调用，不在重启时反复覆盖手动设置。 */
export async function refreshVerifiedPrices() {
  const { canonicalModelName } = await import("./models.js");
  const conn = await pool.getConnection();
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (const p of DEFAULT_PRICES) {
      if (!p.remark?.includes("2026-10-01") || canonicalModelName(p.model) !== String(p.model).toLowerCase()) continue;
      await conn.query(`INSERT INTO model_prices
        (model,input_price,output_price,cache_price,offpeak_input_price,offpeak_output_price,offpeak_cache_price,offpeak_rule,channel_type,remark,updated_time,price_tiers)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
        input_price=VALUES(input_price),output_price=VALUES(output_price),cache_price=VALUES(cache_price),
        offpeak_input_price=VALUES(offpeak_input_price),offpeak_output_price=VALUES(offpeak_output_price),offpeak_cache_price=VALUES(offpeak_cache_price),
        offpeak_rule=VALUES(offpeak_rule),channel_type=VALUES(channel_type),remark=VALUES(remark),updated_time=VALUES(updated_time),price_tiers=VALUES(price_tiers)`,
        [p.model, p.input, p.output, p.cache ?? 0, p.offpeakInput ?? null, p.offpeakOutput ?? null, p.offpeakCache ?? null, p.offpeakRule ? JSON.stringify(p.offpeakRule) : null, p.type, p.remark, now(), storedPriceTiers(p)]);
      updated++;
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
  if (updated) invalidatePrices();
  return { updated };
}

/** 一份规范价格，保留别名的旧报价供管理员审计；幂等且全部在事务内。 */
export async function consolidateModelPrices() {
  const { canonicalModelName, warmAliasMap } = await import("./models.js");
  await warmAliasMap();
  const conn = await pool.getConnection();
  let merged = 0;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM model_prices FOR UPDATE");
    const byName = new Map(rows.map((r) => [String(r.model).toLowerCase(), r]));
    // 正常路由先于 batch/free，以免新库只有聚合条目时被半价 SKU 决定基准价。
    const aliases = rows.filter((r) => canonicalModelName(r.model) !== String(r.model).toLowerCase())
      .sort((a, b) => Number(/:(free|batch|extended|thinking)$/i.test(a.model)) - Number(/:(free|batch|extended|thinking)$/i.test(b.model)) || String(a.model).localeCompare(String(b.model)));
    for (const r of aliases) {
      const model = canonicalModelName(r.model);
      if (!model) continue;
      await conn.query("INSERT INTO model_price_aliases (alias,model,original_price,updated_time) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE model=VALUES(model), original_price=VALUES(original_price), updated_time=VALUES(updated_time)",
        [r.model, model, JSON.stringify(r), now()]);
      if (!byName.has(model) && !/:(free|batch|extended|thinking)$/i.test(r.model)) {
        await conn.query("UPDATE model_prices SET model=? WHERE model=?", [model, r.model]);
        byName.set(model, r);
      } else {
        await conn.query("DELETE FROM model_prices WHERE model=?", [r.model]);
      }
      merged++;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
  if (merged) invalidatePrices();
  return { merged };
}

/** 历史聚合 SKU 原报价，仅供审计；不能拿它替代规范模型计费。 */
export async function originalModelPrice(model) {
  const raw = String(model || "").trim();
  const { canonicalModelName } = await import("./models.js");
  if (canonicalModelName(raw) === raw.toLowerCase()) return null;
  const [rows] = await pool.query("SELECT original_price FROM model_price_aliases WHERE alias=?", [raw]);
  let p = null;
  try { p = rows[0] ? JSON.parse(rows[0].original_price) : null; } catch { /* 不伪造旧价 */ }
  return p ? { model: raw, in: Number(p.input_price), out: Number(p.output_price), cache: Number(p.cache_price), source: p.remark || "" } : null;
}

// ---------------------------------------------------------------------------
// 未定价模型（待定价清单）与「无价即不放行」
// ---------------------------------------------------------------------------
// 用户要求（原话）：
//   「如果上游返回了价格则使用价格，若没返回则不给用户使用，直接明文返回
//    xxx模型未设定价格。在这个模型被获取到的瞬间，就应该通知管理员
//    （后台左侧模型定价项放红色徽标显示待定价模型数量），管理员可在这里进行模型定价。」
//
// 为什么必须拦：未定价的模型会走兜底链（同族 → 同厂商最贵档 → 全表最贵档）。
// 那条链是「宁可高估不可漏收」的权宜之计，但它有两个问题：
//   ① 用户按一个**猜出来的**价格付费，可能是真实价格的几倍（mimo-v2.6-flash
//      实测被按 claude-opus-5 的最贵档收费）；
//   ② 管理员永远不知道有模型漏配了价 —— 兜底静默生效，没人会去查。
// 所以改成：没价就不放行，并把「待定价」显式摊到管理员面前。

/**
 * 平台已登记但**没有精确价格**的模型（= 待定价清单）。
 *
 * 判定范围刻意只取「渠道声明过的模型」而不是整个注册表：
 *   注册表里有大量厂商占位名（glm / zhipu / kimi / qwen / tongyi …），
 *   它们不是真实模型、也不需要定价；把它们算进待定价会让徽标长期挂着一个
 *   虚高的数字，管理员点进去发现一半是垃圾项 —— 那种徽标很快就会被无视。
 *
 * @returns {Promise<{models: Array<{model:string, type:string, channels:Array<{id:number,name:string}>}>, count:number}>}
 */
export async function pendingPricedModels() {
  const prices = await loadPrices();
  const { canonicalModelName, modelIdentity, modelRegistry } = await import("./models.js");
  await modelRegistry();
  const { collectAvailableModels } = await import("./router.js");
  const [rows] = await pool.query("SELECT id,name,type,models FROM channels");
  const pending = new Map();
  for (const row of rows) {
    for (const raw of collectAvailableModels([row])) {
      if (raw.includes("*")) continue;
      const key = canonicalModelName(raw);
      if (prices.has(key)) continue;
      if (!pending.has(key)) {
        const plain = modelIdentity(raw).toLowerCase();
        const candidates = /^(?:\d+-auto|auto|default|latest)$/.test(plain.split("/").pop()) ? [] : [...prices.values()]
          .filter(p => plain !== p.model.toLowerCase() && new RegExp("^" + p.model.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[-:]").test(plain))
          .sort((a,b) => b.model.length - a.model.length).slice(0, 8)
          .map(p => ({ model: p.model, type: p.type, input: p.input, output: p.output, cache: p.cache }));
        pending.set(key, { model: key, type: row.type, channels: [], candidates });
      }
      const item = pending.get(key);
      if (!item.channels.some(c => c.id === row.id)) item.channels.push({ id: row.id, name: row.name, type: row.type, model: raw });
      if (item.type !== row.type) item.type = "other";
    }
  }
  const models = [...pending.values()].sort((a,b) => a.model.localeCompare(b.model));
  return { models, count: models.length };
}

export async function isModelPriced(model) {
  const { canonicalModelName } = await import("./models.js");
  return (await loadPrices()).has(canonicalModelName(model));
}
