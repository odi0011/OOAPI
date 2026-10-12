import { canonicalVendor, vendorLabel } from "./vendorIcons";

/** 设备授权厂商：每条授权链路对应后端 deviceVendorMethods 里的一个 key。 */
export type DeviceVendor = "cline" | "kiro" | "workbuddy" | "grok";

/**
 * 订阅登录方式（交互式 OAuth）：对应后端 services.UpstreamLoginVendorOfMethod。
 *
 * 与设备授权的区别：这条链路要用户去官方页面登录、再把回调地址粘回来
 * （官方客户端的回调指向 localhost，服务器收不到，见 SubscriptionLoginPanel 说明）。
 */
export type SubscriptionVendor = "codex" | "claude-oauth" | "antigravity";

export interface ConnectionPreset {
  id: string;
  label: string;
  baseURL: string;
  modelPaths?: string;
  headers?: string;
  hint?: string;
  auth?: "device" | "subscription";
  /** 设备授权厂商（auth === "device" 时必填）：决定调用哪条授权链路。 */
  deviceVendor?: DeviceVendor;
  /** 订阅登录方式（auth === "subscription" 时必填）。 */
  subscriptionVendor?: SubscriptionVendor;
  disabled?: boolean;
}
export interface UpstreamProvider {
  key: string;
  connections: ConnectionPreset[];
}

const chat = (baseURL: string, label = "官方 API"): ConnectionPreset => ({ id: "api", label, baseURL });
const messages = (baseURL: string): ConnectionPreset => ({ id: "messages", label: "Anthropic 兼容 API", baseURL, modelPaths: "messages: *" });
const bridge = (label = "反代 API / 外部桥接"): ConnectionPreset => ({
  id: "bridge", label, baseURL: "", disabled: true, hint: "原版的此类账号反代适配器尚未迁移，当前不可使用。",
});
const relay = [chat("", "OpenAI 兼容"), messages("")];

/** 地址与接入类别核对原版 channel-types.js；仅展示当前 Go 网关实际可接入的协议。 */
export const UPSTREAM_PROVIDERS: UpstreamProvider[] = [
  { key: "deepseek", connections: [chat("https://api.deepseek.com/v1"), bridge()] },
  { key: "zhipu", connections: [chat("https://open.bigmodel.cn/api/paas/v4"), bridge()] },
  { key: "moonshot", connections: [chat("https://api.moonshot.cn/v1"), bridge()] },
  { key: "bytedance", connections: [chat("https://ark.cn-beijing.volces.com/api/v3"), bridge()] },
  { key: "qwen", connections: [chat("https://dashscope.aliyuncs.com/compatible-mode/v1"), bridge()] },
  { key: "openai", connections: [chat("https://api.openai.com/v1"), { id: "responses", label: "Responses 兼容 API", baseURL: "https://api.openai.com/v1", modelPaths: "responses: *" }, { id: "codex", label: "Codex 订阅一键登录", baseURL: "https://chatgpt.com/backend-api/codex", auth: "subscription", subscriptionVendor: "codex" }] },
  { key: "anthropic", connections: [messages("https://api.anthropic.com/v1"), { id: "claude-oauth", label: "Claude 订阅一键登录", baseURL: "https://api.anthropic.com/v1", auth: "subscription", subscriptionVendor: "claude-oauth" }] },
  { key: "gemini", connections: [chat("https://generativelanguage.googleapis.com/v1beta/openai"), { id: "antigravity", label: "Google 订阅一键登录（Antigravity）", baseURL: "https://daily-cloudcode-pa.googleapis.com/v1internal", auth: "subscription", subscriptionVendor: "antigravity" }] },
  // Grok 设备授权：地址取后端 services.GrokCLIBase（创建时服务端按票据精确比对，
  // 少一段 /v1 会被拒绝）；官方 API Key 走 api.x.ai。
  { key: "xai", connections: [
    { id: "grok", label: "账号一键登录", baseURL: "https://cli-chat-proxy.grok.com/v1", auth: "device", deviceVendor: "grok" },
    chat("https://api.x.ai/v1"),
  ] },
  { key: "mimo", connections: [chat("https://api.xiaomimimo.com/v1"), bridge()] },
  { key: "minimax", connections: [chat("https://api.minimax.cn/v1"), bridge()] },
  { key: "stepfun", connections: [chat("https://api.stepfun.com/v1"), bridge()] },
  { key: "ark", connections: [chat("https://ark.cn-beijing.volces.com/api/v3")] },
  { key: "hunyuan", connections: [chat("https://api.hunyuan.cloud.tencent.com/v1")] },
  { key: "meta", connections: [chat("https://api.meta.ai/v1")] },
  { key: "mistral", connections: [chat("https://api.mistral.ai/v1")] },
  { key: "cohere", connections: [bridge("兼容 API")] },
  { key: "baidu", connections: [bridge("文心兼容 API")] },
  { key: "nvidia", connections: [chat("https://integrate.api.nvidia.com/v1")] },
  { key: "cerebras", connections: [chat("https://api.cerebras.ai/v1")] },
  { key: "longcat", connections: [chat("https://api.longcat.chat/openai/v1"), messages("https://api.longcat.chat/anthropic/v1")] },
  { key: "typesafe", connections: [bridge("Jev 外部兼容桥接（非原生 System One）")] },
  { key: "opencode", connections: [
    { id: "zen", label: "Zen · 按量付费", baseURL: "https://opencode.ai/zen/v1", modelPaths: "messages: claude-*, qwen3*, minimax*\nresponses: grok-*, gpt-*, muse-spark-*\nchat: *" },
    { id: "go", label: "Go · 订阅套餐", baseURL: "https://opencode.ai/zen/go/v1", headers: "x-opencode-session: {{session}}", modelPaths: "messages: claude-*, qwen3*, minimax*, hy3, hy4*\nresponses: grok-*, gpt-*, muse-spark-*\nchat: *" },
  ] },
  { key: "openrouter", connections: [chat("https://openrouter.ai/api/v1", "聚合 API")] },
  { key: "siliconflow", connections: [chat("https://api.siliconflow.cn/v1", "聚合 API")] },
  { key: "chutes", connections: [chat("https://llm.chutes.ai/v1", "聚合 API")] },
  { key: "cline", connections: [{ id: "cli", label: "账号一键登录", baseURL: "https://api.cline.bot/api/v1", auth: "device", deviceVendor: "cline" }, chat("https://api.cline.bot/api/v1", "Cline API Key")] },
  // Kiro 走 AWS SSO OIDC 设备授权；WorkBuddy 走官方 state/authUrl 授权。
  // 两者的接口地址都由服务端按凭据里的 region/realm 推导，前端只负责发起授权。
  { key: "kiro", connections: [{ id: "kiro", label: "账号一键登录（AWS SSO）", baseURL: "https://codewhisperer.us-east-1.amazonaws.com", auth: "device", deviceVendor: "kiro" }] },
  { key: "workbuddy", connections: [{ id: "workbuddy", label: "账号一键登录", baseURL: "https://www.workbuddy.ai/v2", auth: "device", deviceVendor: "workbuddy" }] },
  { key: "qoder", connections: [{ id: "api", label: "PAT 兼容桥 API", baseURL: "", hint: "原版 Qoder 不提供一键登录。请填写已有 qoder2api / qoder-proxy 的公网地址与服务密钥。" }] },
  { key: "trae", connections: [bridge("Trae 账号反代（待迁移）")] },
  { key: "cursor", connections: [bridge("Cursor 账号反代（待迁移）")] },
  { key: "zcode", connections: [bridge("ZCode 账号反代（待迁移）")] },
  { key: "autoclaw", connections: [bridge("AutoClaw 账号反代（待迁移）")] },
  { key: "custom", connections: relay },
];

export function providerFor(vendor: string): UpstreamProvider | undefined {
  return UPSTREAM_PROVIDERS.find((p) => p.key === canonicalVendor(vendor));
}

export function connectionFor(vendor: string, baseURL: string): ConnectionPreset | undefined {
  return providerFor(vendor)?.connections.find((c) => c.baseURL && c.baseURL.replace(/\/$/, "") === baseURL.replace(/\/$/, ""));
}

export function providerOptions() {
  return UPSTREAM_PROVIDERS.map((p) => ({ value: p.key, label: vendorLabel(p.key) }));
}
