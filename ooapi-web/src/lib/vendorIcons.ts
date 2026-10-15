export interface VendorMeta {
  label: string;
  icon: string;
}

/** 登录平台不参与上游账号选择。 */
export const AUTH_PLATFORMS: Record<string, VendorMeta> = {
  google: { label: "Google", icon: "google.svg" },
  github: { label: "GitHub", icon: "github.svg" },
  gitlab: { label: "GitLab", icon: "gitlab.svg" },
  gitee: { label: "Gitee", icon: "gitee.svg" },
  microsoft: { label: "Microsoft", icon: "microsoft.svg" },
  discord: { label: "Discord", icon: "discord.svg" },
  qq: { label: "QQ", icon: "qq.svg" },
  wechat: { label: "微信", icon: "wechat.svg" },
  x: { label: "X", icon: "x.svg" },
};

export const VENDORS: Record<string, VendorMeta> = {
  openai: { label: "OpenAI", icon: "openai.svg" },
  anthropic: { label: "Anthropic / Claude", icon: "claude.svg" },
  gemini: { label: "Google Gemini", icon: "gemini.svg" },
  deepseek: { label: "DeepSeek", icon: "original/deepseek.png" },
  zhipu: { label: "智谱 GLM", icon: "original/zhipu.svg" },
  moonshot: { label: "Kimi · 月之暗面", icon: "original/kimi.png" },
  qwen: { label: "通义千问", icon: "original/qwen.png" },
  bytedance: { label: "豆包", icon: "original/doubao.png" },
  minimax: { label: "MiniMax", icon: "original/minimax.png" },
  stepfun: { label: "阶跃星辰", icon: "original/stepfun.png" },
  mimo: { label: "小米 MiMo", icon: "original/mimo.png" },
  ark: { label: "火山方舟", icon: "original/ark.png" },
  xai: { label: "xAI Grok", icon: "grok.svg" },
  hunyuan: { label: "腾讯混元", icon: "original/hunyuan.png" },
  meta: { label: "Meta", icon: "meta.svg" },
  mistral: { label: "Mistral AI", icon: "mistral.svg" },
  cohere: { label: "Cohere", icon: "cohere.svg" },
  baidu: { label: "百度文心", icon: "baidu.svg" },
  nvidia: { label: "NVIDIA NIM", icon: "original/nvidia.png" },
  cerebras: { label: "Cerebras", icon: "original/cerebras.png" },
  perplexity: { label: "Perplexity", icon: "perplexity.svg" },
  alibaba: { label: "阿里云", icon: "alibaba.svg" },
  huggingface: { label: "Hugging Face", icon: "huggingface.svg" },
  ollama: { label: "Ollama", icon: "ollama.svg" },
  replicate: { label: "Replicate", icon: "replicate.svg" },
  opencode: { label: "OpenCode", icon: "original/opencode.png" },
  openrouter: { label: "OpenRouter", icon: "openrouter.svg" },
  siliconflow: { label: "硅基流动", icon: "original/siliconflow.ico" },
  chutes: { label: "Chutes", icon: "original/chutes.png" },
  typesafe: { label: "TypeSafe / Jev", icon: "original/typesafe.png" },
  longcat: { label: "LongCat · 美团", icon: "original/longcat.png" },
  kiro: { label: "Kiro · AWS", icon: "original/kiro.png" },
  workbuddy: { label: "WorkBuddy / CodeBuddy", icon: "original/workbuddy.svg" },
  qoder: { label: "Qoder · 阿里", icon: "original/qoder.svg" },
  cline: { label: "Cline", icon: "original/cline.png" },
  trae: { label: "Trae · 字节", icon: "original/trae.png" },
  cursor: { label: "Cursor", icon: "original/cursor.png" },
  zcode: { label: "ZCode · 智谱", icon: "original/zhipu.svg" },
  autoclaw: { label: "AutoClaw · 智谱", icon: "original/zhipu.svg" },
  custom: { label: "自定义兼容服务", icon: "" },
};

const ALIASES: Record<string, string> = {
  glm: "zhipu", "z-ai": "zhipu", "zai-org": "zhipu", chatglm: "zhipu",
  kimi: "moonshot", moonshotai: "moonshot", doubao: "bytedance",
  claude: "anthropic", google: "gemini", grok: "xai", "x-ai": "xai",
  volcengine: "ark", xiaomi: "mimo", tencent: "hunyuan", codebuddy: "workbuddy",
  mistralai: "mistral", "meta-llama": "meta", "deepseek-ai": "deepseek",
  "bytedance-seed": "bytedance",
};

export function canonicalVendor(vendor: string): string {
  const key = vendor.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

const MODEL_PREFIXES: Array<[string, string]> = [
  ["gpt", "openai"], ["o1", "openai"], ["o3", "openai"], ["o4", "openai"],
  ["chatgpt", "openai"], ["codex", "openai"], ["text-", "openai"],
  ["dall", "openai"], ["whisper", "openai"], ["claude", "anthropic"],
  ["gemini", "gemini"], ["gemma", "gemini"], ["deepseek", "deepseek"],
  ["kimi", "moonshot"], ["moonshot", "moonshot"], ["glm", "zhipu"], ["chatglm", "zhipu"],
  ["qwen", "qwen"], ["tongyi", "qwen"], ["ernie", "baidu"], ["wenxin", "baidu"],
  ["doubao", "bytedance"], ["ep-", "bytedance"], ["skylark", "bytedance"],
  ["abab", "minimax"], ["minimax", "minimax"], ["mistral", "mistral"],
  ["mixtral", "mistral"], ["codestral", "mistral"], ["llama", "meta"],
  ["muse-spark", "meta"], ["command", "cohere"], ["grok", "xai"], ["sonar", "perplexity"],
  ["nemotron", "nvidia"], ["step", "stepfun"], ["mimo", "mimo"], ["jev", "typesafe"],
  ["longcat", "longcat"], ["hunyuan", "hunyuan"], ["hy3", "hunyuan"],
  ["hy4", "hunyuan"], ["hy-", "hunyuan"], ["composer", "cursor"],
  ["space-bunny", "opencode"], ["big-pickle", "opencode"], ["cat-jam", "opencode"], ["omen-alpha", "opencode"],
];

/** 聚合目录的 vendor/model、~vendor/model 先剥离前缀，API 标识本身不改。 */
export function vendorOfModel(model: string): string | null {
  const raw = model.trim().toLowerCase().replace(/^~/, "");
  const name = raw.slice(raw.lastIndexOf("/") + 1);
  let best: [string, string] | undefined;
  for (const pair of MODEL_PREFIXES) {
    if (name.startsWith(pair[0]) && (!best || pair[0].length > best[0].length)) best = pair;
  }
  if (best) return best[1];
  const prefix = canonicalVendor(raw.split("/")[0]);
  return raw.includes("/") && VENDORS[prefix] ? prefix : null;
}

export function vendorIconUrl(vendor: string | null | undefined): string | null {
  if (!vendor) return null;
  // OAuth 的 google 标志与模型目录的 Gemini 标志分别保留。
  const meta = AUTH_PLATFORMS[vendor.toLowerCase()] ?? VENDORS[canonicalVendor(vendor)];
  return meta?.icon ? `/vendors/${meta.icon}` : null;
}

export function vendorLabel(vendor: string | null | undefined): string {
  if (!vendor) return "未知厂商";
  return VENDORS[canonicalVendor(vendor)]?.label ?? AUTH_PLATFORMS[vendor.toLowerCase()]?.label ?? vendor;
}
