// OpenCode 模型定义（Zen + GO，都是 OpenAI 兼容网关，走同一个适配器 openai-compat）
// ---------------------------------------------------------------------------
// 清单来源：实测 GET https://opencode.ai/zen/v1/models 与 /zen/go/v1/models
// （两个端点都可**匿名**拉取，很适合做定时同步）。
//
// 已下架、务必不要加回来（2026-09 核实）：
//   qwen3-coder（2026-02-06 下架）、kimi-k2（2026-03-06 下架）、grok-code
// —— 它们曾在本文件里作为默认模型，会让新建渠道默认选中不存在的模型。
//
// GO 与 Zen 的模型池**不同**：GO 仅开源模型（GLM/Kimi/MiMo/Qwen/DeepSeek/MiniMax…），
// Zen 另有 Claude/GPT/Gemini 等闭源档位。
// 价格未收录官方数字前走默认兜底价并打告警，管理员可在「模型定价」补录。
export const REAL_MODELS = [
  // ---- Zen（含闭源）----
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", desc: "OpenCode Zen 通道", vision: true, thinkingDefault: false },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", desc: "Anthropic 档位", vision: true, thinkingDefault: false },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", desc: "Google 档位", vision: true, thinkingDefault: false },
  // ---- Zen + GO 共有（开源模型）----
  { id: "glm-5.3", label: "GLM-5.3", desc: "智谱旗舰", vision: false, thinkingDefault: false },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", desc: "DeepSeek 旗舰", vision: false, thinkingDefault: false },
  // ---- GO 侧主力（订阅仅含开源模型）----
  { id: "kimi-k3", label: "Kimi K3", desc: "Moonshot 旗舰（GO）", vision: false, thinkingDefault: false },
  { id: "minimax-m3", label: "MiniMax M3", desc: "MiniMax（GO）", vision: false, thinkingDefault: false },
  { id: "qwen3.8-max", label: "Qwen3.8 Max", desc: "通义旗舰（GO）", vision: false, thinkingDefault: false },
  { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", desc: "小米 MiMo（GO）", vision: false, thinkingDefault: false },
  { id: "longcat-2.0", label: "LongCat 2.0", desc: "LongCat（GO）", vision: false, thinkingDefault: false },
];

export const ALIASES = {};

export function resolveModel(requested) {
  const raw = String(requested || "").trim();
  return { model: raw || REAL_MODELS[0].id, thinking: false, search: false, vision: true, isReal: false };
}

export const CHANNEL_MODELS = REAL_MODELS.map((m) => m.id).join(",");

export function publicModels() {
  return REAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    desc: m.desc,
    vision: m.vision,
    thinkingDefault: m.thinkingDefault,
    supportsSearch: false,
    supportsThinking: false,
  }));
}
