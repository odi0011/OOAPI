// Cline 转发模型的定价归属
// ===========================================================================
// 用户要求（原话）：
//   「去配置价格，但是不要设置为 0，如果模型已有实际厂商则直接归属于实际厂商
//     对应模型的价格即可。还有 Cline 的模型较多，然后也分档…」
//
// 背景：Cline 的 `/models` 返回 **454 个**模型（实测线上），它本质是 OpenRouter
// 目录的转发 —— 名字形如 `anthropic/claude-sonnet-4.5`、`x-ai/grok-4.3`、
// `~openai/gpt-luna-latest`（`~` = 别名路由）、带 `:free` / `:batch` 后缀。
// 上游只给 `{id, object, created, owned_by}`，**没有任何价格字段**（已核对：
// 454 个条目的键并集就只有这四个），所以价格必须由我们这边定。
//
// 为什么不做成「往 model_prices 表插 293 行」：
//   · 293 行会把「模型定价」页撑成一片谁也看不懂的清单，管理员反而找不到要改的那条；
//   · 其中绝大多数是**同一个模型的不同写法**（`:batch` / `:free` / `-2024-08-06` /
//     `~x-ai/...`），逐条定价等于把同一件事抄十几遍，改一次价要改十几处；
//   · 真正需要管理员手工定价的是「我们没见过的厂商」，而不是「已认识模型的别名」。
// 所以这里做成**解析规则**：DB 里的价格永远优先（管理员显式配的说了算），
// 命中规则时给出归属价，两边都没命中才进「待定价」清单。
//
// 价格口径（两档，都写进 remark 让管理员看得见）：
//   · **官方价**：厂商公开定价，直接录入（OpenAI / Anthropic / Google / Mistral /
//     Cohere / Amazon / Perplexity 等有公开价目表的）；
//   · **同档归属**：模型是本平台已定价型号的同代/同尺寸版本时，按该型号计价
//     （这正是用户说的「归属于实际厂商对应模型的价格」）。remark 里写明归给了谁。
//
// 绝不写 0：0 会让这个模型在被调用时**不计费**，等于白送上游成本
//（用户明确要求「不要设置为 0」）。定价再低也必须是正数。

/** 归一化 Cline 模型名：去 `~` 前缀、去 `:free`/`:batch` 后缀、去厂商前缀、转小写 */
export function normalizeClineModel(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("~")) s = s.slice(1); // ~openai/gpt-luna-latest = 别名路由
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/:(free|batch|extended|thinking)$/i, "");
  s = s.replace(/-(latest|preview)$/i, "");
  return s.toLowerCase();
}

/**
 * 归属规则表 —— **顺序敏感，先匹配先生效**（把更具体的写在前面）。
 * 每项：[匹配规则, 输入价, 输出价, 缓存价, 归属厂商, 说明]
 * 价格单位：美元 / 百万 token（与 DEFAULT_PRICES 同口径）。
 */
const RULES = [
  // ---------- OpenAI ----------
  // 三代同堂，必须从旧到新、从具体到笼统地排，否则 gpt-4 会把 gpt-4.1 / gpt-4o 全吃掉
  [/^gpt-3\.5-turbo/, 0.5, 1.5, 0.05, "openai", "OpenAI 官方价（gpt-3.5-turbo）"],
  [/^gpt-4-turbo/, 10, 30, 1, "openai", "OpenAI 官方价（gpt-4-turbo）"],
  [/^gpt-4-0613$|^gpt-4$/, 30, 60, 3, "openai", "OpenAI 官方价（gpt-4 初代）"],
  [/^gpt-4\.1-nano/, 0.1, 0.4, 0.025, "openai", "OpenAI 官方价（gpt-4.1-nano）"],
  [/^gpt-4\.1-mini/, 0.4, 1.6, 0.1, "openai", "OpenAI 官方价（gpt-4.1-mini）"],
  [/^gpt-4\.1/, 2, 8, 0.5, "openai", "OpenAI 官方价（gpt-4.1）"],
  [/^gpt-4o-mini/, 0.15, 0.6, 0.075, "openai", "OpenAI 官方价（gpt-4o-mini）"],
  [/^gpt-4o/, 2.5, 10, 1.25, "openai", "OpenAI 官方价（gpt-4o）"],
  // gpt-5.x 各代：**尺寸档必须排在笼统的代际档之前**（规则先匹配先生效），
  // 否则 gpt-5.4-nano 会拿到主线价，等于按旗舰价收小模型的费。
  [/^gpt-5\.[1-9].*-nano/, 0.05, 0.4, 0.005, "openai", "归属 gpt-5-nano（nano 档）"],
  [/^gpt-5\.[1-9].*-mini/, 0.25, 2, 0.025, "openai", "归属 gpt-5-mini（mini 档）"],
  [/^gpt-5\.[1-9].*-luna/, 0.25, 2, 0.025, "openai", "归属 gpt-5.6-luna（轻量档）"],
  [/^gpt-5\.[1-9].*-terra/, 1.25, 10, 0.125, "openai", "归属 gpt-5.6-terra（中档）"],
  [/^gpt-5\.[1-9].*-sol|^gpt-5\.[1-9].*-astra/, 1.75, 14, 0.175, "openai", "归属 gpt-5.6-sol / gpt-6-astra（旗舰档）"],
  [/^gpt-5\.[1-5]/, 1.25, 10, 0.125, "openai", "归属 gpt-5 主线（5.1~5.5 同代价）"],
  // 裸档位名（`~openai/gpt-luna-latest` 归一化后就是 `gpt-luna`）：
  // `~` 是 Cline/OpenRouter 的别名路由，`-latest` 已被 normalize 去掉，
  // 所以这里必须按「档位词」匹配，不能指望 `gpt-6-luna` 那种带代号的写法。
  [/^gpt-(luna|mini)/, 0.25, 2, 0.025, "openai", "归属 gpt-5.6-luna（轻量档）"],
  [/^gpt-(terra)/, 1.25, 10, 0.125, "openai", "归属 gpt-5.6-terra（中档）"],
  [/^gpt-(sol|astra|omnix)/, 1.75, 14, 0.175, "openai", "归属 gpt-5.6-sol / gpt-6-astra（旗舰档）"],
  // gpt-5.x 各档：本平台定价表里已有同代同档，按档归属
  [/^gpt-5\.6-luna|^gpt-6-luna/, 0.25, 2, 0.025, "openai", "归属 gpt-5.6-luna（同代同档）"],
  [/^gpt-5\.6-terra|^gpt-6-terra/, 1.25, 10, 0.125, "openai", "归属 gpt-5.6-terra（同代同档）"],
  [/^gpt-5\.6-sol|^gpt-6-sol|^gpt-6-astra|^gpt-5\.6-astra|^gpt-5\.6-omnix/, 1.75, 14, 0.175, "openai", "归属 gpt-5.6-sol / gpt-6-astra（旗舰档）"],
  [/^gpt-5-nano/, 0.05, 0.4, 0.005, "openai", "OpenAI 官方价（gpt-5-nano）"],
  [/^gpt-5-mini/, 0.25, 2, 0.025, "openai", "OpenAI 官方价（gpt-5-mini）"],
  [/^gpt-5(-|$)/, 1.25, 10, 0.125, "openai", "OpenAI 官方价（gpt-5 主线；含 codex 变体）"],
  // `gpt-chat-latest` 归一化后是 `gpt-chat`（-latest 被去掉），所以匹配到 gpt-chat 为止
  [/^gpt-chat/, 5, 15, 0.5, "openai", "OpenAI 官方价（gpt-5-chat-latest）"],
  [/^gpt-audio-mini/, 10, 20, 1, "openai", "归属 gpt-4o-mini 音频档（官方音频接口按 gpt-4o 档计）"],
  [/^gpt-audio/, 32, 64, 3.2, "openai", "OpenAI 官方音频价（gpt-4o-audio 档）"],
  [/^gpt-oss-safeguard|^gpt-oss-20b/, 0.08, 0.3, 0.01, "openai", "开源权重档（gpt-oss-20b 量级）"],
  [/^gpt-oss-120b/, 0.15, 0.6, 0.02, "openai", "开源权重档（gpt-oss-120b）"],
  [/^gpt-image/, 5, 40, 0.5, "openai", "OpenAI 官方价（图像生成档）"],
  [/^gpt/, 1.25, 10, 0.125, "openai", "OpenAI 家族兜底（按 gpt-5 主线）"],
  [/^o1-pro/, 150, 600, 15, "openai", "OpenAI 官方价（o1-pro）"],
  [/^o1(-|$)/, 15, 60, 7.5, "openai", "OpenAI 官方价（o1）"],
  [/^o3/, 2, 8, 0.5, "openai", "OpenAI 官方价（o3）"],
  [/^o4-mini/, 1.1, 4.4, 0.275, "openai", "OpenAI 官方价（o4-mini）"],
  [/^codex/, 0.25, 2, 0.025, "openai", "归属 codex-auto-review"],

  // ---------- Anthropic ----------
  [/^claude-3-haiku|^claude-3\.5-haiku/, 0.25, 1.25, 0.03, "anthropic", "Anthropic 官方价（haiku 旧代）"],
  [/^claude-3-opus/, 15, 75, 1.5, "anthropic", "Anthropic 官方价（opus 旧代）"],
  [/^claude-3\.5-sonnet|^claude-3\.7-sonnet|^claude-sonnet-4(-|$)/, 3, 15, 0.3, "anthropic", "Anthropic 官方价（sonnet 3.5~4 档）"],
  [/^claude-opus-4\.1/, 15, 75, 1.5, "anthropic", "Anthropic 官方价（opus-4.1）"],
  [/^claude-opus-4/, 5, 25, 0.5, "anthropic", "归属 claude-opus-4.5（无 4.1 溢价的新代 opus 档）"],
  [/^claude-opus-5/, 5, 25, 0.5, "anthropic", "Anthropic 官方价（opus-5）"],
  [/^claude-sonnet-5/, 2, 10, 0.2, "anthropic", "Anthropic 官方价（sonnet-5）"],
  [/^claude-sonnet-4\.5|^claude-sonnet-4\.6/, 3, 15, 0.3, "anthropic", "Anthropic 官方价（sonnet-4.5/4.6）"],
  [/^claude-haiku-4\.5/, 1, 5, 0.1, "anthropic", "Anthropic 官方价（haiku-4.5）"],
  // claude-fable-*：Anthropic 的新命名档，本平台尚无对应型号 → 按 sonnet 档归属
  [/^claude-fable/, 3, 15, 0.3, "anthropic", "归属 sonnet 档（平台暂无 fable 型号价目）"],
  [/^claude-haiku/, 1, 5, 0.1, "anthropic", "归属 claude-haiku-4.5"],
  [/^claude-sonnet/, 3, 15, 0.3, "anthropic", "归属 claude-sonnet-4.6"],
  [/^claude-opus/, 5, 25, 0.5, "anthropic", "归属 claude-opus-4.5"],
  [/^claude/, 3, 15, 0.3, "anthropic", "Anthropic 家族兜底（按 sonnet 档）"],

  // ---------- Google ----------
  [/^gemini-2\.5-flash-lite/, 0.1, 0.4, 0.025, "gemini", "Google 官方价（2.5-flash-lite）"],
  [/^gemini-2\.5-flash/, 0.3, 2.5, 0.075, "gemini", "Google 官方价（2.5-flash）"],
  [/^gemini-2\.5-pro/, 1.25, 10, 0.31, "gemini", "Google 官方价（2.5-pro）"],
  [/^gemini-3\.8-flash/, 1.5, 9, 0.375, "gemini", "归属 gemini-3.8-flash"],
  [/^gemini-3\.\d-flash-lite|^gemini-3-flash-lite/, 0.1, 0.4, 0.025, "gemini", "归属 gemini-2.5-flash-lite（lite 档）"],
  [/^gemini-3\.\d-pro|^gemini-3-pro|^gemini-pro/, 1.25, 10, 0.31, "gemini", "归属 gemini-2.5-pro（pro 档）"],
  [/^gemini-3\.\d-flash|^gemini-3-flash|^gemini-flash/, 1.5, 9, 0.375, "gemini", "归属 gemini-3.5-flash（flash 档）"],
  [/^gemini-3/, 1.5, 9, 0.375, "gemini", "归属 gemini-3.5-flash"],
  [/^lyria/, 0.1, 0.4, 0.025, "gemini", "归属 gemini-2.5-flash-lite（音乐生成档）"],
  [/^gemma-4/, 0.1, 0.4, 0.025, "gemini", "归属 gemini-2.5-flash-lite（开源 Gemma 档）"],
  [/^gemma-3|^gemma-2/, 0.05, 0.15, 0.01, "gemini", "开源 Gemma 档（gemma-3-27b 量级）"],
  [/^gemini/, 1.25, 10, 0.31, "gemini", "Google 家族兜底（按 2.5-pro 档）"],

  // ---------- xAI Grok ----------
  [/^grok-4\.6/, 2, 6, 0.3, "grok", "归属 grok-4.6"],
  [/^grok-4\.7/, 2, 6, 0.3, "grok", "归属 grok-4.6（新代同档）"],
  [/^grok-4\.20|^grok-4\.3|^grok-build/, 1.25, 2.5, 0.2, "grok", "归属 grok-4.3"],
  [/^grok-4\.20-multi-agent/, 2, 6, 0.3, "grok", "归属 grok-4.6（多智能体档）"],
  [/^grok-3-mini/, 0.3, 0.5, 0.075, "grok", "xAI 官方价（grok-3-mini）"],
  [/^grok/, 1.25, 2.5, 0.2, "grok", "xAI 家族兜底（按 grok-4.3 档）"],

  // ---------- DeepSeek ----------
  [/^deepseek-r1-distill/, 0.23, 0.69, 0.02, "deepseek", "官方价（R1 蒸馏档）"],
  [/^deepseek-r1/, 0.55, 2.19, 0.14, "deepseek", "DeepSeek 官方价（R1）"],
  [/^deepseek-v3\.1|^deepseek-v3\.2/, 0.28, 0.42, 0.028, "deepseek", "归属 deepseek-v3.2"],
  [/^deepseek-v4-flash|^deepseek-v4\.1-flash/, 0.3, 1.2, 0.006, "deepseek", "归属 deepseek-v4.1-flash（flash 档）"],
  [/^deepseek-v4-pro|^deepseek-pro/, 1.32, 3.96, 0.044, "deepseek", "归属 deepseek-v4-pro"],
  [/^deepseek-chat/, 0.27, 1.1, 0.027, "deepseek", "归属 deepseek-chat"],
  [/^deepseek/, 0.3, 1.2, 0.006, "deepseek", "DeepSeek 家族兜底（flash 档）"],

  // ---------- 智谱 GLM / z-ai ----------
  [/^glm-5\.3-flash|^glm-4\.5-air|^glm-flash/, 0.111, 0.389, 0.032, "glm", "归属 glm-5.3-flash"],
  [/^glm-5|^glm-latest/, 1.111, 3.889, 0.278, "glm", "归属 glm-5.3"],
  [/^glm-4\.7|^glm-4\.6/, 0.278, 1.111, 0.056, "glm", "归属 glm-4.6"],
  [/^glm-4\.5/, 0.111, 0.278, 0, "glm", "归属 glm-4.5"],
  [/^glm-4v|^glm-4-plus/, 0.694, 0.694, 0.07, "glm", "归属 glm-4-plus（视觉档）"],
  [/^glm-4-flash|^glm-4-air/, 0.014, 0.014, 0, "glm", "归属 glm-4-flashx（免费档）"],
  [/^glm-4/, 0.139, 0.139, 0.014, "glm", "归属 glm-4"],
  [/^glm|^chatglm|^zhipu/, 1.111, 3.889, 0.278, "glm", "智谱家族兜底（按 glm-5.3 档）"],

  // ---------- 通义千问 ----------
  // 尺寸档按参数量分：小尺寸走 flash 价、中档走 plus、旗舰走 max
  [/^qwen3\.8-max|^qwen3\.7-max|^qwen3-max|^qwen-max/, 0.347, 1.389, 0, "qwen", "归属 qwen3-max"],
  [/^qwen3\.8-max/, 1.667, 5, 0.208, "qwen", "归属 qwen3.8-max"],
  [/^qwen3\.\d-plus|^qwen-plus/, 0.278, 1.111, 0.044, "qwen", "归属 qwen3.7-plus"],
  [/^qwen3\.\d-flash|^qwen3-coder-flash|^qwen-flash|^qwen-turbo/, 0.028, 0.111, 0, "qwen", "归属 qwen-flash"],
  [/^qwen3-coder/, 0.3, 1.2, 0.03, "qwen", "归属 qwen3-max 的 coder 档"],
  [/^qwen3-235b|^qwen3\.5-397b|^qwen3\.8-2\.4t|^qwen3-vl-235b/, 0.2, 0.6, 0, "qwen", "归属 qwen3-235b-a22b（超大尺寸）"],
  [/^qwen3\.\d-27b|^qwen3\.\d-32b|^qwen3-3[02]b|^qwen3-14b/, 0.15, 0.6, 0.015, "qwen", "中尺寸档（14B~32B）"],
  [/^qwen3\.\d-9b|^qwen3\.\d-8b|^qwen3-8b|^qwen3-30b|^qwen3-coder-30b/, 0.07, 0.28, 0.007, "qwen", "小尺寸档（8B~30B-A3B）"],
  [/^qwen3-next|^qwen3\.5-122b|^qwen3\.5-35b|^qwen3\.6-27b|^qwen3\.6-35b/, 0.1, 0.8, 0.01, "qwen", "中尺寸档（next / 3.5~3.6 系）"],
  [/^qwen2\.5-vl|^qwen-2\.5-72b|^qwen2\.5-72b/, 0.35, 0.4, 0, "qwen", "归属 qwen2.5-72b（旧代大尺寸）"],
  [/^qwen-2\.5-coder-32b|^qwen-2\.5-32b/, 0.07, 0.16, 0, "qwen", "旧代 coder 中尺寸档"],
  [/^qwen-2\.5|^qwen2\.5/, 0.05, 0.1, 0, "qwen", "旧代小尺寸档"],
  [/^qwen3-vl/, 0.15, 0.6, 0.015, "qwen", "VL 中尺寸档"],
  [/^qwen3\.8|^qwen3\.7|^qwen3\.6|^qwen3\.5/, 0.278, 1.111, 0.044, "qwen", "3.5~3.8 通用档（按 plus 档）"],
  [/^qwen/, 0.278, 1.111, 0.044, "qwen", "通义家族兜底（按 plus 档）"],

  // ---------- 混元（腾讯）----------
  [/^hunyuan|^hy3|^hy4|^hy-?[0-9]/, 0.15, 0.6, 0.015, "hunyuan", "归属混元 Hy3 档"],
  [/^hy-mt2|^hy-mt/, 0.1, 0.4, 0.01, "hunyuan", "混元翻译档（Hy-MT2）"],

  // ---------- 豆包 / Seed（字节）----------
  [/^seed-2\.0-mini|^seed-1-6-flash|^seed-1\.6-flash/, 0.028, 0.278, 0.006, "ark", "归属 doubao-seed-2.0-mini"],
  [/^seed-2\.0-lite|^seed-2-0-lite/, 0.083, 0.5, 0.017, "ark", "归属 doubao-seed-2.0-lite"],
  [/^seed-2\.0-code/, 0.444, 2.222, 0.089, "ark", "归属 doubao-seed-2.0-code"],
  [/^seed-2\.0-pro/, 0.444, 2.222, 0.089, "ark", "归属 doubao-seed-2.0-pro"],
  [/^seed-2-1-turbo|^seed-2\.1/, 0.417, 2.083, 0.083, "ark", "归属 doubao-seed-2.1-turbo"],
  [/^seed-1\.6|^seed-1-6/, 0.111, 1.111, 0.022, "ark", "归属 doubao-seed-1.6"],
  [/^doubao|^seed/, 0.111, 1.111, 0.022, "ark", "豆包/Seed 家族兜底"],
  [/^ui-tars/, 0.1, 0.3, 0.01, "ark", "字节 UI-TARS 档"],

  // ---------- 小米 MiMo ----------
  [/^mimo-v2\.6-flash/, 0.15, 0.6, 0.015, "mimo", "归属 mimo-v2.6-flash"],
  [/^mimo-v2\.6-pro/, 0.5, 2, 0.05, "mimo", "归属 mimo-v2.6-pro"],
  [/^mimo/, 0.139, 0.278, 0, "mimo", "归属 mimo-v2.5"],

  // ---------- MiniMax ----------
  [/^minimax-m3/, 0.292, 1.167, 0.029, "minimax", "归属 MiniMax-M3"],
  [/^minimax-m2/, 0.292, 1.167, 0.029, "minimax", "归属 MiniMax-M2.x"],
  [/^minimax-m1/, 0.4, 2.2, 0.04, "minimax", "归属 MiniMax-M1"],
  [/^minimax/, 0.2, 1.1, 0.02, "minimax", "MiniMax 家族兜底"],

  // ---------- Kimi / Moonshot ----------
  [/^kimi-k3/, 3, 15, 0.3, "kimi", "归属 kimi-k3"],
  [/^kimi-k2\.6/, 0.95, 4, 0.16, "kimi", "归属 kimi-k2.6"],
  [/^kimi-k2|^kimi-thinking|^kimi-latest|^kimi/, 0.55, 2.2, 0.1, "kimi", "归属 kimi-k2"],
  [/^moonshot-v1-8k/, 0.167, 0.167, 0, "kimi", "Moonshot 官方价（v1-8k）"],
  [/^moonshot-v1-32k/, 0.333, 0.333, 0, "kimi", "Moonshot 官方价（v1-32k）"],
  [/^moonshot-v1-128k/, 0.833, 0.833, 0, "kimi", "Moonshot 官方价（v1-128k）"],
  [/^moonshot/, 0.95, 4, 0.16, "kimi", "归属 kimi-k2.6"],

  // ---------- Mistral ----------
  [/^mistral-large/, 2, 6, 0.2, "mistralai", "Mistral 官方价（large）"],
  [/^mistral-medium/, 0.4, 2, 0.04, "mistralai", "Mistral 官方价（medium-3）"],
  [/^magistral/, 0.5, 1.5, 0.05, "mistralai", "Mistral 官方价（magistral）"],
  [/^codestral/, 0.3, 0.9, 0.03, "mistralai", "Mistral 官方价（codestral）"],
  [/^devstral/, 0.1, 0.3, 0.01, "mistralai", "Mistral 官方价（devstral）"],
  [/^voxtral/, 0.1, 0.3, 0.01, "mistralai", "Mistral 官方价（voxtral）"],
  [/^ministral-3b/, 0.04, 0.04, 0, "mistralai", "Mistral 官方价（ministral-3b）"],
  [/^ministral-8b/, 0.1, 0.1, 0, "mistralai", "Mistral 官方价（ministral-8b）"],
  [/^ministral-14b/, 0.2, 0.2, 0, "mistralai", "Mistral 官方价（ministral-14b）"],
  [/^ministral/, 0.1, 0.3, 0.01, "mistralai", "Mistral ministral 档"],
  [/^mistral-small/, 0.1, 0.3, 0.01, "mistralai", "Mistral 官方价（small）"],
  [/^mistral-nemo/, 0.15, 0.15, 0, "mistralai", "Mistral 官方价（nemo）"],
  [/^mistral-saba/, 0.2, 0.6, 0.02, "mistralai", "Mistral 官方价（saba）"],
  [/^mixtral-8x22b/, 0.9, 0.9, 0, "mistralai", "Mistral 官方价（mixtral-8x22b）"],
  [/^pixtral/, 0.15, 0.15, 0, "mistralai", "Mistral 官方价（pixtral）"],

  // ---------- NVIDIA Nemotron ----------
  [/^nemotron-3\.5-content-safety/, 0.05, 0.2, 0.005, "nvidia", "内容安全小模型档"],
  [/^nemotron-3\.5-lightning/, 0.1, 0.4, 0.01, "nvidia", "轻量档"],
  [/^nemotron-3-nano/, 0.05, 0.2, 0.005, "nvidia", "Nano 档"],
  [/^nemotron-3-super/, 0.3, 1.2, 0.03, "nvidia", "Super 档"],
  [/^nemotron-3-ultra|^nemotron-4/, 1, 3, 0.1, "nvidia", "Ultra 档"],
  [/^nemotron/, 0.3, 1.2, 0.03, "nvidia", "Nemotron 家族兜底"],

  // ---------- Meta Llama ----------
  [/^llama-4-maverick/, 0.2, 0.6, 0.02, "meta", "Llama-4 Maverick 档"],
  [/^llama-4-scout/, 0.1, 0.3, 0.01, "meta", "Llama-4 Scout 档"],
  [/^llama-guard/, 0.05, 0.2, 0.005, "meta", "Guard 小模型档"],
  [/^llama-3\.3-70b|^llama-3\.1-70b/, 0.35, 0.4, 0, "meta", "70B 档"],
  [/^llama-3\.1-405b|^llama-3-405b/, 2, 2, 0, "meta", "405B 档"],
  [/^llama-3\.2-[13]b|^llama-3\.1-8b/, 0.05, 0.1, 0, "meta", "小尺寸档"],
  [/^llama/, 0.2, 0.6, 0.02, "meta", "Llama 家族兜底"],
  [/^muse-/, 0.15, 0.6, 0.015, "meta", "Meta muse 档"],

  // ---------- Cohere ----------
  [/^command-a-plus|^command-a/, 2.5, 10, 0.25, "cohere", "Cohere 官方价（command-a）"],
  [/^command-r-plus/, 2.5, 10, 0.25, "cohere", "Cohere 官方价（command-r-plus）"],
  [/^command-r-08|^command-r7b/, 0.15, 0.6, 0.015, "cohere", "Cohere 官方价（command-r）"],
  [/^command/, 1, 3, 0.1, "cohere", "Cohere 家族兜底"],
  [/^north-/, 0.5, 2, 0.05, "cohere", "Cohere North 档"],

  // ---------- Amazon Nova ----------
  [/^nova-micro/, 0.035, 0.14, 0.004, "amazon", "Amazon 官方价（nova-micro）"],
  [/^nova-lite|^nova-2-lite/, 0.06, 0.24, 0.006, "amazon", "Amazon 官方价（nova-lite）"],
  [/^nova-pro/, 0.8, 3.2, 0.08, "amazon", "Amazon 官方价（nova-pro）"],
  [/^nova-premier/, 2.5, 12.5, 0.25, "amazon", "Amazon 官方价（nova-premier）"],
  [/^nova/, 0.06, 0.24, 0.006, "amazon", "Nova 家族兜底"],

  // ---------- Perplexity ----------
  [/^sonar-pro/, 3, 15, 0.3, "perplexity", "Perplexity 官方价（sonar-pro）"],
  [/^sonar-reasoning/, 2, 8, 0.2, "perplexity", "Perplexity 官方价（sonar-reasoning）"],
  [/^sonar-deep-research/, 2, 8, 0.2, "perplexity", "Perplexity 官方价（deep-research）"],
  [/^sonar/, 1, 1, 0, "perplexity", "Perplexity 官方价（sonar）"],

  // ---------- 其余有公开价的小厂商 ----------
  [/^granite-4\.0-h-micro/, 0.017, 0.11, 0.002, "ibm", "IBM Granite 官方价（micro）"],
  [/^granite/, 0.05, 0.2, 0.005, "ibm", "IBM Granite 档"],
  [/^phi-4/, 0.07, 0.14, 0, "microsoft", "Microsoft 官方价（phi-4）"],
  [/^phi-/, 0.1, 0.3, 0.01, "microsoft", "Microsoft Phi 档"],
  [/^wizardlm/, 0.5, 0.5, 0, "microsoft", "WizardLM 档"],
  [/^mercury-2\.5/, 0.25, 1, 0.025, "inception", "Inception Mercury 档"],
  [/^mercury-/, 0.25, 1, 0.025, "inception", "Inception Mercury 档"],
  [/^reka-edge/, 0.1, 0.1, 0, "rekaai", "Reka Edge 官方价"],
  [/^reka-flash/, 0.1, 0.2, 0, "rekaai", "Reka Flash 官方价"],
  [/^reka/, 0.1, 0.2, 0, "rekaai", "Reka 家族兜底"],
  [/^solar-pro4/, 0.3, 1.2, 0.03, "upstage", "Upstage Solar Pro4 档"],
  [/^solar-/, 0.25, 0.25, 0, "upstage", "Upstage Solar 档"],
  [/^ernie/, 0.5, 1.5, 0.05, "baidu", "百度文心档"],
  [/^kat-coder/, 0.4, 1.5, 0.04, "kwaipilot", "Kwaipilot Kat Coder 档"],
  [/^dots-/, 0.2, 0.8, 0.02, "dots-studio", "Dots Studio 档"],
  [/^inkling-small/, 0.15, 0.6, 0.015, "thinkingmachines", "Thinking Machines 小档"],
  [/^inkling/, 0.5, 2, 0.05, "thinkingmachines", "Thinking Machines 档"],
  [/^fugu-max|^sakana-namazu/, 0.5, 2, 0.05, "sakana", "Sakana 档"],
  [/^fugu/, 1, 4, 0.1, "sakana", "Sakana 旗舰档"],
  [/^laguna-s-/, 0.2, 0.8, 0.02, "poolside", "Poolside Laguna 档"],
  [/^laguna/, 0.1, 0.4, 0.01, "poolside", "Poolside Laguna 小档"],
  [/^aion-3\.0-mini/, 0.2, 0.8, 0.02, "aion-labs", "aion-labs 小档"],
  [/^aion-3/, 0.5, 2, 0.05, "aion-labs", "aion-labs 3.0 档"],
  [/^aion/, 0.2, 0.8, 0.02, "aion-labs", "aion-labs 档"],
  [/^nex-n2\.5-mini/, 0.1, 0.4, 0.01, "nex-agi", "nex-agi 小档"],
  [/^nex-n2\.5/, 0.5, 2, 0.05, "nex-agi", "nex-agi 档"],
  [/^schematron-v2-turbo/, 0.2, 0.8, 0.02, "inference-net", "inference-net turbo 档"],
  [/^schematron/, 0.1, 0.4, 0.01, "inference-net", "inference-net 档"],
  [/^morph-v3-large/, 0.9, 1.9, 0.09, "morph", "Morph 官方价（large）"],
  [/^morph-v3-fast/, 0.5, 1.2, 0.05, "morph", "Morph 官方价（fast）"],
  [/^relace-apply/, 0.85, 1.25, 0.085, "relace", "Relace 官方价（apply）"],
  [/^relace-search/, 1, 3, 0.1, "relace", "Relace 官方价（search）"],
  [/^relace/, 0.85, 1.25, 0.085, "relace", "Relace 档"],
  [/^lfm-/, 0.02, 0.05, 0, "liquid", "Liquid AI 小模型档"],
  [/^palmyra/, 0.6, 6, 0.06, "writer", "Writer Palmyra 档"],
  [/^trinity-large/, 0.35, 0.4, 0, "arcee-ai", "Arcee Trinity 档"],
  [/^perceptron/, 0.3, 1.2, 0.03, "perceptron", "Perceptron 档"],
  [/^ternary-bonsai/, 0.1, 0.4, 0.01, "prism-ml", "Prism ML 档"],
  [/^grok-latest/, 1.25, 2.5, 0.2, "grok", "归属 grok-4.3（最新别名）"],

  // ---------- 社区微调模型（OpenRouter 长尾，无对应厂商价目）----------
  // 这些是开源权重的社区微调（Hermes / Euryale / MythoMax / Cydonia…），
  // 上游按开源档计费。给一个真实的**开源档**价格（不是 0），管理员要改可直接在
  // 「模型定价」里加一条精确价 —— DB 永远优先于本表。
  [/^hermes-3-llama-3\.1-405b|^hermes-4-405b|^hermes/, 0.5, 1.5, 0.05, "openrouter", "开源权重档（社区微调）"],
  [/^l3\.?\d?-(lunaris|euryale)|^l3-/, 0.35, 0.4, 0, "openrouter", "开源权重档（Llama-3 微调）"],
  [/^magnum-|^mythomax|^remm-slerp|^gryphe/, 0.15, 0.15, 0, "openrouter", "开源权重档（13B~72B 微调）"],
  [/^cydonia|^skyfall|^unslopnemo|^thedrummer/, 0.3, 0.6, 0.03, "openrouter", "开源权重档（24B~36B 微调）"],
  [/^dolphin-/, 0.2, 0.6, 0.02, "openrouter", "开源权重档（Dolphin 微调）"],
  [/^weaver|^mancer/, 0.2, 0.6, 0.02, "openrouter", "开源权重档（Mancer）"],
  [/^dots-3-note|^dots-/, 0.2, 0.8, 0.02, "openrouter", "开源权重档（Dots）"],

  // ---------- 三方聚合 / 路由型（ling、nex、openrouter auto 等）----------
  [/^ling-/, 0.1, 0.4, 0.01, "inclusionai", "开源权重档（Ling 3.0）"],
  // openrouter/auto 这类是**路由器**，模型由上游按提示词动态决定 ——
  // 没有确定的模型价。给一个中等档位，并在 remark 里说清它是路由型，
  // 避免管理员以为这是某个具体模型的真实单价。
  [/^auto|^fusion|^pareto|^bodybuilder|^free$/, 0.3, 1.2, 0.03, "openrouter", "路由型模型（上游动态选模型），按平台默认中档计价"],
];

/**
 * 查 Cline 模型的归属价。
 * @param {string} raw Cline 返回的模型 id（可带 `~`、`:` 后缀、厂商前缀）
 * @returns {{input:number, output:number, cache:number, type:string, remark:string, hit:string} | null}
 *   null = 本表不认识它（应由调用方按「待定价」处理）
 */
export function clinePriceFor(raw) {
  const m = normalizeClineModel(raw);
  if (!m) return null;
  for (const [re, input, output, cache, type, remark] of RULES) {
    if (re.test(m)) {
      return { input, output, cache, type, remark: `Cline 转发：${remark}`, hit: String(re) };
    }
  }
  return null;
}

/** 规则条数（测试与自检用） */
export const CLINE_RULE_COUNT = RULES.length;

// ---------------------------------------------------------------------------
// 分档 / 分厂商 —— 「添加厂商获取模型」里 Cline 专属的分组选择
// ---------------------------------------------------------------------------
// 用户要求（原话）：「还有 Cline 的模型较多，然后也分档，所以需要在添加厂商获取模型
// 这边给 Cline 单独做一下分档，分模型的功能。」
//
// 为什么必须分组：Cline 的 `/models` 实测返回 **454 个**。把 454 项平铺进一个多选框，
// 管理员只能靠滚动和搜索，既看不出「哪些是免费的、哪些是旗舰」，
// 也不知道选中之后要按什么价收费 —— 而这两件事恰好决定了该选哪些。
//
// 两个维度都要给：
//   · **档位**（free/light/mid/flagship）：按输出价分四档。选模型的真实决策是
//     「我要便宜的干活还是贵的干活」，档位直接对应成本，是主维度。
//   · **厂商**（anthropic/openai/google…）：同一个模型族横向比较时要按厂商看
//     （「Gemini 全系都试一下」）。这是次维度，用于精确圈定范围。
// 两者组合使用（例如「Anthropic 的旗舰档」），所以分开提供而不是揉成一层。

/** 档位定义：输出价（美元/百万 token）上界 → 档位。免费模型单独识别（`:free` 后缀）。 */
export const CLINE_TIERS = [
  { key: "free", label: "免费档", desc: "上游标注 :free 的模型", max: 0 },
  { key: "light", label: "轻量档", desc: "输出 < $2 / 百万 token", max: 2 },
  { key: "mid", label: "中档", desc: "输出 $2 ~ $8", max: 8 },
  { key: "flagship", label: "旗舰档", desc: "输出 ≥ $8", max: Infinity },
];

/** 该模型的档位（免费后缀优先于价格判定） */
export function clineTierOf(raw) {
  if (/:free$/i.test(String(raw || ""))) return "free";
  const p = clinePriceFor(raw);
  if (!p) return "mid"; // 规则未覆盖（应已不存在）：归中档而不是兜底价，避免被当成旗舰
  const out = Number(p.output) || 0;
  if (out < 2) return "light";
  if (out < 8) return "mid";
  return "flagship";
}

/** 厂商前缀 → 展示名（用于分组标题）。未收录的原样返回，不隐藏 —— 藏着比显示小写前缀更糟。 */
const VENDOR_LABEL = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  "z-ai": "智谱 GLM",
  moonshotai: "Kimi",
  minimax: "MiniMax",
  mistralai: "Mistral",
  "meta-llama": "Meta Llama",
  meta: "Meta",
  nvidia: "NVIDIA",
  cohere: "Cohere",
  amazon: "Amazon Nova",
  perplexity: "Perplexity",
  tencent: "腾讯混元",
  "bytedance-seed": "字节 Seed",
  bytedance: "字节",
  xiaomi: "小米 MiMo",
  inclusionai: "InclusionAI",
  mistral: "Mistral",
  stepfun: "阶跃星辰",
  baidu: "百度文心",
  "ibm-granite": "IBM Granite",
  microsoft: "Microsoft",
  meituan: "美团 LongCat",
  upstage: "Upstage",
  rekaai: "Reka",
  morph: "Morph",
  relace: "Relace",
  inception: "Inception",
  "inference-net": "Inference.net",
  thinkingmachines: "Thinking Machines",
  sakana: "Sakana",
  poolside: "Poolside",
  "aion-labs": "Aion Labs",
  "nex-agi": "Nex AGI",
  "arcee-ai": "Arcee",
  liquid: "Liquid",
  writer: "Writer",
  perceptron: "Perceptron",
  "prism-ml": "Prism ML",
  openrouter: "OpenRouter 路由/开源档",
};

/**
 * 把 Cline 的模型清单分成「厂商组」，每组内再标出档位与价格。
 *
 * @param {string[]} ids 上游返回的模型 id 列表
 * @returns {{groups: Array<{key:string,label:string,count:number,models:Array<{id:string,tier:string,tierLabel:string,input:number,output:number,label:string}>}>,
 *            tiers: Array<{key:string,label:string,desc:string,count:number,models:string[]}>,
 *            total:number, freeCount:number}}
 *   分组按「模型数降序、同数按名称」排序：数量最多的厂商排最前，管理员最可能先看它。
 */
export function clineModelGroups(ids) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x)).filter(Boolean) : [];
  const byVendor = new Map();
  const byTier = new Map(CLINE_TIERS.map((t) => [t.key, []]));

  for (const id of list) {
    const bare = id.startsWith("~") ? id.slice(1) : id;
    const slash = bare.indexOf("/");
    const vendor = slash > 0 ? bare.slice(0, slash) : "(其他)";
    const p = clinePriceFor(id);
    const tier = clineTierOf(id);
    const tierMeta = CLINE_TIERS.find((t) => t.key === tier);
    const item = {
      id,
      tier,
      tierLabel: tierMeta?.label || tier,
      // 价格给出来是为了「选之前就知道花多少」。规则未覆盖时给 null（不假装知道）。
      input: p ? p.input : null,
      output: p ? p.output : null,
      ownedBy: p ? p.type : vendor,
      label: id,
    };
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(item);
    byTier.get(tier)?.push(id);
  }

  const groups = [...byVendor.entries()]
    .map(([key, models]) => ({
      key,
      label: VENDOR_LABEL[key] || key,
      count: models.length,
      models: models.sort((a, b) => (a.output ?? 0) - (b.output ?? 0) || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const tiers = CLINE_TIERS.map((t) => {
    const models = byTier.get(t.key) || [];
    return { key: t.key, label: t.label, desc: t.desc, count: models.length, models };
  });

  return { groups, tiers, total: list.length, freeCount: (byTier.get("free") || []).length };
}
