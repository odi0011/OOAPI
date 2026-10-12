export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  category: string;
  source: string;
}

export const MODEL_CATALOG: ModelInfo[] = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", vendor: "OpenAI", description: "复杂推理、编程与日常工作", category: "通用", source: "https://platform.openai.com/docs/models" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", vendor: "Anthropic", description: "编程与 Agent 任务", category: "编程", source: "https://www.anthropic.com/claude-sonnet-5-5" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vendor: "DeepSeek", description: "视觉理解与高吞吐推理", category: "推理", source: "https://api-docs.deepseek.com/news/news260910" },
  { id: "grok-4.7", name: "Grok 4.7", vendor: "xAI", description: "工具调用与可配置推理", category: "推理", source: "https://docs.x.ai/developers/models" },
  { id: "kimi-k3", name: "Kimi K3", vendor: "Moonshot", description: "长上下文与视觉理解", category: "长上下文", source: "https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", vendor: "OpenAI", description: "复杂任务旗舰模型", category: "旗舰", source: "https://platform.openai.com/docs/models" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", vendor: "Anthropic", description: "快速响应与低成本调用", category: "轻量", source: "https://www.anthropic.com/claude-haiku-5-5" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", vendor: "OpenAI", description: "高频轻量任务", category: "轻量", source: "https://platform.openai.com/docs/models" },
];
