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
import { clinePriceFor } from "./cline-prices.js";

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
const CNY_PER_USD = 7.2; // 官方人民币价折算美元用（平台币制固定 1 OD = 1 USD）
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
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]] },
    type: "deepseek",
    remark: "官方峰谷价（高峰=北京时间工作日 9-12/14-18，其余半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },
  {
    model: "deepseek-v4-pro",
    input: 1.32,
    output: 3.96,
    cache: 0.044,
    offpeakInput: 0.66,
    offpeakOutput: 1.98,
    offpeakCache: 0.022,
    offpeakRule: { offset: 8, days: [1, 2, 3, 4, 5], peak: [["09:00", "12:00"], ["14:00", "18:00"]] },
    type: "deepseek",
    remark: "官方峰谷价（高峰=北京时间工作日 9-12/14-18，其余半价）；来源 api-docs.deepseek.com/quick_start/pricing/",
  },

  // --- 智谱 GLM（官方人民币价 ÷ 7.2；来源 open.bigmodel.cn/pricing）---
  { model: "glm-5.3", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `官方 ¥8/¥28/缓存 ¥2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5.3-flash", input: 0.111, output: 0.389, cache: 0.032, type: "glm", remark: `官方 ¥0.8/¥2.8/缓存 ¥0.23 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5.2", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `官方 ¥8/¥28/缓存 ¥2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5v-turbo", input: 0.694, output: 3.056, cache: 0.167, type: "glm", remark: `官方 ≤32K 档 ¥5/¥22/缓存 ¥1.2 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.7", input: 0.278, output: 1.111, cache: 0.056, type: "glm", remark: `官方 ¥2/¥8/缓存 ¥0.4 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.6", input: 0.278, output: 1.111, cache: 0.056, type: "glm", remark: `官方 ¥2/¥8/缓存 ¥0.4 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.5", input: 0.111, output: 0.278, cache: 0, type: "glm", remark: `官方 ¥0.8/¥2（官方公告即将下线）÷ ${CNY_PER_USD}；来源 docs.bigmodel.cn` },
  // glm-5 / glm-5.1：5.x 早期档，官方已由 5.2 取代；按 5.2 同档价录入，
  // 避免落到兜底价（那会让这些档位比旗舰还贵）
  { model: "glm-5", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `按 5.2 同档价录入（官方页已下架 5/5.1）÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-5.1", input: 1.111, output: 3.889, cache: 0.278, type: "glm", remark: `按 5.2 同档价录入（官方页已下架 5/5.1）÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.5-air", input: 0.111, output: 0.278, cache: 0.022, type: "glm", remark: `官方 ¥0.8/¥2/缓存 ¥0.16 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },

  // --- Kimi（官方美元价；来源 platform.kimi.com/docs/pricing/chat）---
  { model: "kimi-k3", input: 3.00, output: 15.00, cache: 0.30, type: "kimi", remark: "官方定价，1M 上下文；来源 platform.kimi.com/docs/pricing/chat-k3" },
  { model: "kimi-k2.6", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "官方定价；来源 platform.kimi.com/docs/pricing/chat" },
  // kimi-k2 是仍在注册表里的经典档（网页反代 SCENARIO_K2 会用到）。
  // 缺这一行会让它落到「同厂商最高档兜底」= 按 k3 旗舰价（3.00/15.00）计费，
  // 相对 k2.6 档最多多收约 3 倍。
  { model: "kimi-k2", input: 0.55, output: 2.20, cache: 0.10, type: "kimi", remark: "经典档，按上一代官方价录入（待官方页复核）；来源 platform.kimi.com/docs/pricing/chat" },

  // --- 通义千问（官方人民币价 ÷ 7.2；来源 help.aliyun.com/zh/model-studio）---
  { model: "qwen3.8-max", input: 1.667, output: 5.000, cache: 0.208, type: "qwen", remark: `官方 ¥12/¥36/缓存 ¥1.5 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio/qwen3-8-max` },
  { model: "qwen3.7-plus", input: 0.278, output: 1.111, cache: 0.044, type: "qwen", remark: `官方 ¥2/¥8/缓存 ¥0.32 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen3-max", input: 0.347, output: 1.389, cache: 0, type: "qwen", remark: `官方 ¥2.5/¥10（未公布缓存档）÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-plus", input: 0.111, output: 0.278, cache: 0, type: "qwen", remark: `官方 ¥0.8/¥2（≤128K 档）÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },

  // --- 豆包（本平台 doubao-pro/lite 为通用档位，价格对应官方 Seed 2.0 Pro/Lite ≤32K 档）---
  { model: "doubao-pro", input: 0.444, output: 2.222, cache: 0.089, type: "doubao", remark: `对应官方 Seed-2.0-Pro ≤32K：¥3.2/¥16/缓存 ¥0.64 ÷ ${CNY_PER_USD}；来源 ai.volcengine.com/model` },
  { model: "doubao-lite", input: 0.083, output: 0.500, cache: 0.017, type: "doubao", remark: `对应官方 Seed-2.0-Lite ≤32K：¥0.6/¥3.6/缓存 ¥0.12 ÷ ${CNY_PER_USD}；来源 ai.volcengine.com/model` },

  // --- 火山方舟（2026-09 接入；官方按输入长度分档，取最常用档并在 remark 注明）---
  { model: "doubao-seed-2-1-pro", input: 0.833, output: 4.167, cache: 0.167, type: "ark", remark: `官方 ≤1024 输入档 ¥6/¥30/缓存 ¥1.2 ÷ ${CNY_PER_USD}；长输入档更贵；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-1-turbo", input: 0.417, output: 2.083, cache: 0.083, type: "ark", remark: `官方 ≤256 输入档 ¥3/¥15/缓存 ¥0.6 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-pro", input: 0.444, output: 2.222, cache: 0.089, type: "ark", remark: `官方 ≤32K 档 ¥3.2/¥16/缓存 ¥0.64 ÷ ${CNY_PER_USD}；32–128K 与 128–256K 档更贵；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-lite", input: 0.083, output: 0.500, cache: 0.017, type: "ark", remark: `官方 ¥0.6/¥3.6 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-mini", input: 0.028, output: 0.278, cache: 0.008, type: "ark", remark: `官方 ¥0.2/¥2.0 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-2-0-code", input: 0.444, output: 2.222, cache: 0.089, type: "ark", remark: `官方 ¥3.2/¥16 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1.8", input: 0.111, output: 1.111, cache: 0, type: "ark", remark: `官方 ¥0.8 入；输出按长度 ¥2.0(短)–¥8.0(长)，此处取长输出档；÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1.6", input: 0.111, output: 1.111, cache: 0, type: "ark", remark: `按 Seed-1.6 官方档位折算 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1-6-flash", input: 0.028, output: 0.278, cache: 0, type: "ark", remark: `高速档按官方 flash 档折算 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },
  { model: "doubao-seed-1-6-vision", input: 0.111, output: 1.111, cache: 0, type: "ark", remark: `视觉档按 Seed-1.6 同档折算 ÷ ${CNY_PER_USD}；来源 docs.volcengine.com 模型定价页` },

  // --- 小米 MiMo（2026-09 接入；官方人民币价，海外另有美元价）---
  { model: "mimo-v2.5-pro", input: 0.417, output: 0.833, cache: 0.003, type: "mimo", remark: `官方 ¥3.00 入 / ¥6.00 出 / 缓存 ¥0.025 ÷ ${CNY_PER_USD}；来源 mimo.mi.com 定价页` },
  { model: "mimo-v2.5", input: 0.139, output: 0.278, cache: 0.003, type: "mimo", remark: `官方 ¥1.00 入 / ¥2.00 出 / 缓存 ¥0.02 ÷ ${CNY_PER_USD}；来源 mimo.mi.com 定价页` },

  // --- MiniMax（2026-09 接入；国内人民币价，M3 按输入长度分档取 ≤512k 档）---
  { model: "MiniMax-M3", input: 0.292, output: 1.167, cache: 0.058, type: "minimax", remark: `官方 ≤512k 输入档 ¥2.10/¥8.40/缓存 ¥0.42（永久五折）÷ ${CNY_PER_USD}；>512k 档翻倍；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M2.7", input: 0.292, output: 1.167, cache: 0.058, type: "minimax", remark: `官方 ¥2.1/¥8.4/缓存 ¥0.42 ÷ ${CNY_PER_USD}；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M2.7-highspeed", input: 0.583, output: 2.333, cache: 0.058, type: "minimax", remark: `高速档官方 ¥4.2/¥16.8 ÷ ${CNY_PER_USD}；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M2.5", input: 0.292, output: 1.167, cache: 0.058, type: "minimax", remark: `历史档按官方同档折算 ÷ ${CNY_PER_USD}；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M2.1", input: 0.292, output: 1.167, cache: 0.058, type: "minimax", remark: `历史档按官方同档折算 ÷ ${CNY_PER_USD}；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M2", input: 0.292, output: 1.167, cache: 0.058, type: "minimax", remark: `历史档按官方同档折算 ÷ ${CNY_PER_USD}；来源 platform.minimax.io 定价页` },
  { model: "MiniMax-M3-priority", input: 0.438, output: 1.750, cache: 0.087, type: "minimax", remark: `service_tier=priority 为标准价 1.5 倍；来源 platform.minimax.io 定价页` },

  // --- 阶跃星辰 StepFun（2026-09 接入；官方人民币价，含缓存命中档）---
  { model: "step-5-preview", input: 0.972, output: 2.778, cache: 0.049, type: "stepfun", remark: `官方 ¥7/¥20/缓存命中 ¥0.35 ÷ ${CNY_PER_USD}；来源 platform.stepfun.com 定价页` },
  { model: "step-3.7-flash", input: 0.188, output: 1.125, cache: 0.038, type: "stepfun", remark: `官方 ¥1.35/¥8.1/缓存命中 ¥0.27 ÷ ${CNY_PER_USD}；来源 platform.stepfun.com 定价页` },
  { model: "step-3.5-flash", input: 0.097, output: 0.292, cache: 0.019, type: "stepfun", remark: `官方 ¥0.7/¥2.1/缓存命中 ¥0.14 ÷ ${CNY_PER_USD}；来源 platform.stepfun.com 定价页` },
  { model: "step-3.5-flash-2603", input: 0.097, output: 0.292, cache: 0.019, type: "stepfun", remark: `同 step-3.5-flash 官方档位 ÷ ${CNY_PER_USD}；来源 platform.stepfun.com 定价页` },

  // --- OpenAI（美元牌价；官方页对爬虫 403，录入后需人工复核）---
  { model: "gpt-4o", input: 2.50, output: 10.00, cache: 1.25, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-4o-mini", input: 0.15, output: 0.60, cache: 0.075, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-mini", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "gpt-5-nano", input: 0.05, output: 0.40, cache: 0.005, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o3", input: 2.00, output: 8.00, cache: 0.50, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  { model: "o4-mini", input: 1.10, output: 4.40, cache: 0.275, type: "openai", remark: "官方牌价录入；来源 openai.com/api/pricing/" },
  // 订阅/网页版反代产出的型号：按 OpenAI 同档次官方价录入（订阅渠道按 token 折算成本，
  // 平台侧不区分「订阅额度已付」与「按量付费」，统一用官方牌价口径）。
  // 缺少这些行会让 gpt-5.6-* 落到兜底档（比官方价低 3~8 倍 = 系统性少计费）。
  { model: "gpt-5.6-sol", input: 1.75, output: 14.00, cache: 0.175, type: "openai", remark: "对标 gpt-5.x 旗舰档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.6-terra", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "对标 gpt-5.x 主力档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.6-luna", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "对标 gpt-5.x mini 档官方价；来源 openai.com/api/pricing/" },
  { model: "gpt-5.5", input: 1.25, output: 10.00, cache: 0.125, type: "openai", remark: "对标 gpt-5 官方价；来源 openai.com/api/pricing/" },
  { model: "codex-auto-review", input: 0.25, output: 2.00, cache: 0.025, type: "openai", remark: "代码审查档，对标 gpt-5-mini 官方价；来源 openai.com/api/pricing/" },

  // --- Anthropic（美元牌价）--- 渠道类型统一用 anthropic（与 channel-types 的接入方式一致，
  // 之前写 "claude" 会和模型登记表/定价导入校验打架）
  { model: "claude-opus-5", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-sonnet-5", input: 2.00, output: 10.00, cache: 0.20, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },
  { model: "claude-haiku-4.5", input: 1.00, output: 5.00, cache: 0.10, type: "anthropic", remark: "官方定价；来源 anthropic.com/pricing" },

  // --- Google（美元牌价）---
  { model: "gemini-3.5-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-pro", input: 1.25, output: 10.00, cache: 0.125, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash", input: 0.30, output: 2.50, cache: 0.03, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },

  // --- xAI Grok（美元牌价，取自 docs.x.ai 页面内嵌的 __XAI_PUBLIC_MODELS__ 官方价表；
  //     价格为「每百万 token」，页面单位是 1e-4 美元）---
  { model: "grok-4.6", input: 2.00, output: 6.00, cache: 0.50, type: "grok", remark: "官方价表（长上下文档 $2.2/$6.6）；来源 docs.x.ai/docs/models" },
  { model: "grok-4.5", input: 2.00, output: 6.00, cache: 0.30, type: "grok", remark: "官方价表；来源 docs.x.ai/docs/models" },
  { model: "grok-4.3", input: 1.25, output: 2.50, cache: 0.20, type: "grok", remark: "官方价表；来源 docs.x.ai/docs/models" },
  { model: "grok-3-mini", input: 0.30, output: 0.50, cache: 0.03, type: "grok", remark: "轻量档，按官方 4.3 档一半估录入，待官方页复核；来源 docs.x.ai/docs/models" },

  // --- 后续批次新接入的档位（此前落到兜底价 0.30/1.20 并打告警）---
  // 阿里通义：qwen-max 对应官方 max 档，turbo/flash 是轻量档
  { model: "qwen-max", input: 0.347, output: 1.389, cache: 0, type: "qwen", remark: `对应官方 max 档 ¥2.5/¥10 ÷ ${CNY_PER_USD}（与 qwen3-max 同档）；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-max-latest", input: 0.347, output: 1.389, cache: 0, type: "qwen", remark: `官方 max 最新版同档价 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-turbo", input: 0.056, output: 0.222, cache: 0, type: "qwen", remark: `官方 turbo 档 ¥0.4/¥1.6 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen-flash", input: 0.028, output: 0.111, cache: 0, type: "qwen", remark: `官方 flash 档 ¥0.2/¥0.8 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  { model: "qwen3.7-max", input: 0.347, output: 1.389, cache: 0.030, type: "qwen", remark: `官方 3.7-max 与 max 同档 ¥2.5/¥10、缓存 ¥0.22 ÷ ${CNY_PER_USD}；来源 help.aliyun.com/zh/model-studio` },
  // Google：3.8-flash 是 3.5-flash 的迭代档，官方同档价
  { model: "gemini-3.8-flash", input: 1.50, output: 9.00, cache: 0.15, type: "gemini", remark: "与 3.5-flash 同档官方牌价；来源 ai.google.dev/gemini-api/docs/pricing" },
  { model: "gemini-2.5-flash-lite", input: 0.10, output: 0.40, cache: 0.025, type: "gemini", remark: "官方牌价录入；来源 ai.google.dev/gemini-api/docs/pricing" },
  // Anthropic：4.5 代 sonnet/haiku（旧代命名，按官方历史价录入）
  { model: "claude-sonnet-4.6", input: 3.00, output: 15.00, cache: 0.30, type: "anthropic", remark: "4.6 代 sonnet 官方价（与 4.5 同档）；来源 anthropic.com/pricing" },
  { model: "claude-sonnet-4.5", input: 3.00, output: 15.00, cache: 0.30, type: "anthropic", remark: "4.5 代 sonnet 官方价；来源 anthropic.com/pricing" },
  { model: "claude-opus-4.5", input: 5.00, output: 25.00, cache: 0.50, type: "anthropic", remark: "4.5 代 opus 官方价；来源 anthropic.com/pricing" },
  // 智谱视觉档：与对应文本档同价（官方视觉不加价）
  { model: "glm-5v", input: 0.60, output: 2.20, cache: 0.11, type: "glm", remark: `视觉档与 glm-5.2 同价 ¥4.3/¥15.8 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4.6v", input: 0.28, output: 1.10, cache: 0.06, type: "glm", remark: `视觉档与 glm-4.6 同价 ¥2/¥8 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4v", input: 0.14, output: 0.14, cache: 0, type: "glm", remark: `官方 glm-4v ¥1/¥1 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  // WorkBuddy（腾讯托管）的 DeepSeek 档：底层同名模型，按 DeepSeek 官方价计
  { model: "deepseek-v4.1-flash", input: 0.30, output: 1.20, cache: 0.006, type: "deepseek", remark: "腾讯托管同名档，按 DeepSeek 官方 flash 价录入；来源 api-docs.deepseek.com/quick_start/pricing/" },
  // 小米 MiMo / 美团 LongCat：官方未公布完整价表，按公开档位与同类轻量档估录，待官方页复核
  { model: "mimo-v2.6-pro", input: 0.50, output: 2.00, cache: 0.05, type: "mimo", remark: "官方未公布完整价表，按同类 pro 档估录，待复核" },
  { model: "longcat-2.0", input: 0.30, output: 1.20, cache: 0.03, type: "longcat", remark: "官方未公布完整价表，按同类轻量档估录，待复核" },

  // --- 上一代档位：仍在注册表里可被请求，不给价会按「同厂商最贵档」兜底，
  //     即用旗舰价收轻量档的钱（最多差 20 倍）。按官方历史价补录。---
  { model: "glm-4", input: 0.139, output: 0.139, cache: 0, type: "glm", remark: `官方 ¥1/¥1（4 代基础档）÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-plus", input: 0.694, output: 0.694, cache: 0, type: "glm", remark: `官方 ¥5/¥5（4 代增强档）÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-air", input: 0.014, output: 0.014, cache: 0, type: "glm", remark: `官方 ¥0.1/¥0.1（4 代轻量）÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  { model: "glm-4-flash", input: 0, output: 0, cache: 0, type: "glm", remark: "官方免费档（¥0）；来源 open.bigmodel.cn/pricing" },
  { model: "glm-4-flashx", input: 0.014, output: 0.014, cache: 0, type: "glm", remark: `官方 ¥0.1/¥0.1 高速版 ÷ ${CNY_PER_USD}；来源 open.bigmodel.cn/pricing` },
  // kimi-latest / kimi-thinking 是官方「跟随最新档」的别名，按 k2.6 档价录入
  { model: "kimi-latest", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "跟随最新档，按 k2.6 同价录入；来源 platform.kimi.com/docs/pricing/chat" },
  { model: "kimi-thinking", input: 0.95, output: 4.00, cache: 0.16, type: "kimi", remark: "思考档，按 k2.6 同价录入；来源 platform.kimi.com/docs/pricing/chat" },
  { model: "moonshot-v1-8k", input: 0.167, output: 0.167, cache: 0, type: "kimi", remark: `官方 ¥1.2/¥1.2（8K）÷ ${CNY_PER_USD}；来源 platform.moonshot.cn/docs/pricing` },
  { model: "moonshot-v1-32k", input: 0.333, output: 0.333, cache: 0, type: "kimi", remark: `官方 ¥2.4/¥2.4（32K）÷ ${CNY_PER_USD}；来源 platform.moonshot.cn/docs/pricing` },
  { model: "moonshot-v1-128k", input: 0.833, output: 0.833, cache: 0, type: "kimi", remark: `官方 ¥6/¥6（128K）÷ ${CNY_PER_USD}；来源 platform.moonshot.cn/docs/pricing` },
  // 聚合渠道上的开源权重模型（OpenRouter / NIM 常用 `vendor/模型` 形式，
  // 前缀会被 getPrice 剥掉，这里按对应开源模型的托管价录入）
  { model: "deepseek-chat", input: 0.27, output: 1.10, cache: 0.07, type: "deepseek", remark: "DeepSeek-V3 对话档官方价（旧命名 deepseek-chat）；来源 api-docs.deepseek.com/quick_start/pricing/" },
  { model: "deepseek-v3.2", input: 0.28, output: 0.42, cache: 0.028, type: "deepseek", remark: "V3.2 官方价（开源权重托管同价）；来源 api-docs.deepseek.com/quick_start/pricing/" },
  { model: "qwen3-235b-a22b", input: 0.20, output: 0.60, cache: 0.02, type: "qwen", remark: "Qwen3-235B 开源权重，按官方百炼托管价录入；来源 help.aliyun.com/zh/model-studio" },

  // --- 线上实测发现的「渠道在用但无价」的模型（新门禁会拦下它们，故补录）---
  // 补录依据：这些是上游渠道实际暴露的档位，官方页若未公布就按同档估录并在 remark 注明。
  { model: "gpt-6-astra", input: 2.50, output: 20.00, cache: 0.25, type: "openai", remark: "未在官方价表找到，按 gpt-5.6-sol 旗舰档估录，待官方页复核" },
  { model: "mimo-v2.6-flash", input: 0.15, output: 0.60, cache: 0.015, type: "mimo", remark: "小米 MiMo 轻量档，按同厂 v2.6-pro 的 1/3 估录，待官方页复核" },
  { model: "omen-alpha", input: 0.30, output: 1.20, cache: 0.03, type: "opencode", remark: "OpenCode 平台上的未公开档位，按同类轻量档估录，待复核" },
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
    m.set(String(r.model).toLowerCase(), {
      model: r.model,
      input: Number(r.input_price) || 0,
      output: Number(r.output_price) || 0,
      cache: Number(r.cache_price) || 0,
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
  return `${tz}时间 ${days} ${wins} 为高峰，其余半价`;
}

// 取模型价格：精确匹配 → 最长前缀匹配 → 同厂商兜底 → 全局兜底
const warnedModels = new Set();
const MAX_WARNED_MODELS = 500;
export async function getPrice(model) {
  const prices = await loadPrices();
  let m = String(model || "").toLowerCase();
  // 聚合渠道（OpenRouter / NVIDIA NIM / HuggingFace 风格）的模型名带厂商前缀：
  // `zai-org/GLM-4.6`、`anthropic/claude-sonnet-4.5`、`Qwen/Qwen3-235B-A22B`。
  // 这些前缀只是路由标识，底层就是同名模型 —— 不去掉就会整片落到兜底价，
  // 而兜底价比实际价可能差几倍（用户按贵档付费）。统一剥成裸模型名再匹配。
  const slash = m.lastIndexOf("/");
  if (slash > 0 && slash < m.length - 1) m = m.slice(slash + 1);
  // 兜底链的返回值统一带 exact:false —— 调用方（如「按上游实际档位计价」）
  // 需要知道这个价格是查到的还是猜的，靠 remark 字符串匹配太脆弱。
  if (prices.has(m)) return { ...prices.get(m), exact: true };
  // 模糊匹配：deepseek-chat-search → deepseek-chat。
  // 必须取「命中长度最长」的前缀，不能取 Map 里第一个命中的：
  // 短前缀可能贵 10 倍（如 glm-5.3-flash-search 先命中 glm-5.3 而不是 glm-5.3-flash）。
  let best = null;
  let bestLen = -1;
  for (const [k, v] of prices) {
    if (k.length > bestLen && m.startsWith(k)) {
      best = v;
      bestLen = k.length;
    }
  }
  if (best) return { ...best, exact: true }; // 前缀命中：仍算精确（deepseek-chat-search → deepseek-chat）
  // Cline 转发目录（454 个模型，形如 `anthropic/claude-sonnet-4.5`、`~openai/gpt-luna-latest`）：
  // 上游只给 {id, object, created, owned_by}，**没有任何价格字段**（实测核对过），
  // 所以价格由 cline-prices.js 的归属规则定。位置刻意放在 DB 命中之后、同族兜底之前：
  //   · DB 里的价格永远优先 —— 管理员在「模型定价」显式配的那条说了算；
  //   · 规则比「同族兜底」准得多（同族兜底会拿最贵档，实测 mimo-v2.6-flash 被按
  //     claude-opus-5 收费）；规则表里每条都写明了归属到哪个型号或哪家官方价。
  const clineHit = clinePriceFor(m);
  if (clineHit) {
    return {
      model,
      input: clineHit.input,
      output: clineHit.output,
      cache: clineHit.cache,
      type: clineHit.type,
      exact: false, // 是归属价而非逐条配置：调用方（与管理员）要知道这一点
      remark: clineHit.remark,
    };
  }
  // 同族匹配：请求名是某个已配价模型名的前缀（kimi-k2 → kimi-k2.6、deepseek-v4 → deepseek-v4-pro）。
  // 取「最短的那个」（最贴近的族），比直接跳到「同厂商最贵档」准确得多 ——
  // 按最贵档兜底会让上一代/中端模型被按旗舰价收（kimi-k2 落到 kimi-k3 就是 3 倍）。
  let family = null;
  let familyLen = Infinity;
  for (const [k, v] of prices) {
    if (k.length < m.length) continue; // 只考虑比请求名更长的
    if (k.startsWith(m) && k.length < familyLen) {
      family = v;
      familyLen = k.length;
    }
  }
  if (family) return { ...family, model, remark: `${family.model} 同族兜底（原模型未单独定价）` };
  // 兜底不能一律按 DeepSeek 价：反代/订阅渠道产出的模型（gpt-5.6-*、grok-* 等）单价是
  // DeepSeek flash 的 3~10 倍，一律按它算等于系统性少计费。这里再退一步按「同厂商最贵档」
  // （宁可高估不可漏收），真的连厂商都判定不出来才退回 DeepSeek 档。
  const vendor = await vendorOfModel(model);
  const vendorPrice = vendor ? priciestOfVendor(prices, vendor) : null;
  // 告警集合设上限：渠道声明 models="*" 时，调用方可用任意模型名无限撑大内存。
  if (m && !warnedModels.has(m) && warnedModels.size < MAX_WARNED_MODELS) {
    warnedModels.add(m);
    console.warn(
      `[pricing] 模型「${model}」未配置价格，暂按${vendorPrice ? `同厂商（${vendor}）最高档` : "全表最贵档"}计费，请在「模型定价」中补充`
    );
  }
  if (vendorPrice) {
    return { ...vendorPrice, model, remark: `未配置价格，按同厂商（${vendor}）最高档兜底` };
  }
  // 判定不出厂商（custom/中转渠道的自定义模型名，例如挂在第三方聚合站上的 claude-opus）
  // 时，绝不能退回 DeepSeek 最低档：那比真实成本低约 20 倍，等于系统性少收。
  // 改为取「全表最贵档」——宁可高估后由管理员改价，也不要静默漏收。
  const anyPrice = priciestOfAll(prices);
  if (anyPrice) {
    return { ...anyPrice, model, remark: `未配置价格且无法判定厂商，按全表最贵档（${anyPrice.model}）兜底` };
  }
  return { model, input: 0.30, output: 1.20, cache: 0.006, type: "", remark: "未配置价格，按默认档计价" };
}

/** 全表最贵档（按输出价，其次输入价）——用于无法判定厂商时的兜底 */
function priciestOfAll(prices) {
  let best = null;
  for (const v of prices.values()) {
    if (!best) {
      best = v;
      continue;
    }
    const out = Number(v.output) || 0;
    const bestOut = Number(best.output) || 0;
    if (out > bestOut || (out === bestOut && (Number(v.input) || 0) > (Number(best.input) || 0))) best = v;
  }
  return best;
}

/** 该模型归属的厂商（渠道类型）——复用模型登记表，避免定价与归属两处口径分裂 */
async function vendorOfModel(model) {
  try {
    const { modelRegistry } = await import("./models.js");
    const reg = await modelRegistry();
    return reg.get(String(model || "").toLowerCase())?.type || "";
  } catch {
    return "";
  }
}

/** 某厂商已登记的最贵档价格（按输出价排序；同价取输入价更高的） */
function priciestOfVendor(prices, vendor) {
  let best = null;
  for (const v of prices.values()) {
    if (String(v.type || "") !== String(vendor)) continue;
    if (!best) {
      best = v;
      continue;
    }
    const out = Number(v.output) || 0;
    const bestOut = Number(best.output) || 0;
    if (out > bestOut || (out === bestOut && (Number(v.input) || 0) > (Number(best.input) || 0))) best = v;
  }
  return best;
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
export function computeCost({ price, promptTokens = 0, completionTokens = 0, cacheTokens = 0, contextBilling = "auto" }) {
  // 缓存命中不能超过输入总量（上游字段异常时按输出去重，避免负基数）
  const cache = Math.max(0, Math.min(Number(cacheTokens) || 0, Number(promptTokens) || 0));
  const base = Math.max(0, (Number(promptTokens) || 0) - cache);
  // 未配置缓存价（NULL/0）时回退输入价：直接按 0 计费等于对缓存命中部分免单
  const cachePrice = Number(price.cache) > 0 ? Number(price.cache) : Number(price.input) || 0;
  const outTokens = contextBilling === "input_only" ? 0 : Number(completionTokens) || 0;
  const od =
    (base / 1e6) * price.input +
    (outTokens / 1e6) * price.output +
    (cache / 1e6) * cachePrice;
  // 先做微小的浮点校正再向上取整，避免 0.0001 的表示误差多收 1 厘
  const units = od * UNITS_PER_OD;
  return Math.max(1, Math.ceil(Math.round(units * 1e6) / 1e6));
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
  const ts = now();
  let added = 0;
  for (const p of DEFAULT_PRICES) {
    const [ret] = await pool.query(
      `INSERT INTO model_prices
         (model, input_price, output_price, cache_price,
          offpeak_input_price, offpeak_output_price, offpeak_cache_price, offpeak_rule,
          channel_type, remark, updated_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE model = model`,
      [
        p.model,
        p.input,
        p.output,
        p.cache,
        p.offpeakInput ?? null,
        p.offpeakOutput ?? null,
        p.offpeakCache ?? null,
        p.offpeakRule ? JSON.stringify(p.offpeakRule) : null,
        p.type,
        p.remark,
        ts,
      ]
    );
    if (ret.affectedRows === 1) added += 1;
  }
  if (added) {
    invalidatePrices();
    console.log(`[init] 已写入默认模型价格 ${added} 条（可在「模型定价」中调整）`);
  }
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
  const [rows] = await pool.query(
    "SELECT id, name, type, models FROM channels WHERE status = 1 AND models IS NOT NULL AND models <> ''"
  );
  const byModel = new Map();
  for (const r of rows) {
    for (const raw of String(r.models || "").split(",")) {
      const m = raw.trim();
      if (!m || m === "*") continue;
      const key = m.toLowerCase();
      // 精确命中（含最长前缀命中）都算「已定价」—— 见 getPrice 的匹配顺序
      let priced = prices.has(key);
      if (!priced) {
        let bestLen = -1;
        for (const k of prices.keys()) if (key.startsWith(k) && k.length > bestLen) bestLen = k.length;
        priced = bestLen >= 0;
      }
      if (priced) continue;
      // Cline 归属规则（cline-prices.js）命中的同样算「已定价」——
      // 否则 Cline 那 454 个模型会整片出现在待定价徽标里（几百个数字，等于没提示）。
      if (clinePriceFor(key)) continue;
      if (!byModel.has(m)) byModel.set(m, { model: m, type: String(r.type || ""), channels: [] });
      byModel.get(m).channels.push({ id: Number(r.id), name: String(r.name || "") });
    }
  }
  const models = [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
  return { models, count: models.length };
}

/**
 * 该模型是否已定价（可放行）。与 getPrice 的匹配顺序保持一致：
 * 精确命中 / 最长前缀命中 / Cline 归属规则 都算「已定价」。
 *
 * 第三项不能少：Cline 的 454 个模型里绝大多数靠归属规则定价（DB 里没有逐条记录），
 * 少了它会让「无价即不放行」把整个 Cline 渠道全拦下来。
 */
export async function isModelPriced(model) {
  const prices = await loadPrices();
  const m = String(model || "").toLowerCase();
  if (!m) return false;
  const stripped = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  if (prices.has(m) || prices.has(stripped)) return true;
  for (const key of [m, stripped]) {
    for (const k of prices.keys()) if (key.startsWith(k)) return true;
  }
  return Boolean(clinePriceFor(m));
}
