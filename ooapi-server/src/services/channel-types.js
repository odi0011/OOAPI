// 上游厂商注册表
// ===========================================================================
// 设计原则：**厂商是唯一维度**，不再分「API 渠道 / 反代渠道」两类。
//
// 同一个厂商可以同时支持多种接入方式，比如 DeepSeek 既能用网页版反代（登账号），
// 也能用官方 API（填 Key）。所以「接入方式」是厂商下面的一个选项，而不是并列的
// 渠道类型 —— 之前把两者并列，会导致同一个厂商出现两个互不相干的条目。
//
// 数据结构：
//   PROVIDERS[i].methods[]  —— 该厂商支持的接入方式
//     relay  网页版反代：登录账号即可，无需上游 Key
//     api    官方 API  ：填上游 Key，走 OpenAI 兼容协议
//
// 适配器解析规则（见 adapterFor）：
//   relay → 用该厂商自己的适配器（各家签名/风控都不一样）
//   api   → 统一走 openai-compat（绝大多数厂商都提供 OpenAI 兼容接口）
// 订阅型 OAuth 接入方式（参考 CLIProxyAPI / sub2api 的反代协议）：
//   codex        ChatGPT 订阅（Codex OAuth，responses 协议）
//   claude-oauth Claude 订阅（Claude Code OAuth，messages 协议）
//   antigravity  Google 订阅（Antigravity/Code Assist OAuth）
//   grok-oauth   xAI Grok 订阅（device-code OAuth，responses 协议）
// 与 relay 的区别：不需要浏览器，凭据是 OAuth 令牌（粘贴官方 CLI / CPA / sub2api 的凭据文件）
export const OAUTH_METHODS = ["codex", "claude-oauth", "antigravity", "grok-oauth", "kiro", "openai-web", "workbuddy", "qoder"];

export function isOAuthMethod(key) {
  return OAUTH_METHODS.includes(String(key || ""));
}

// 订阅渠道的凭据粘贴表单（各厂商共用同一字段名 token，内容为凭据 JSON）
function oauthCredentialField(placeholder, hint) {
  return [
    {
      key: "token",
      label: "凭据 JSON",
      type: "textarea",
      required: true,
      rows: 6,
      placeholder,
      hint,
    },
  ];
}

export const PROVIDERS = [
  {
    key: "deepseek",
    name: "DeepSeek",
    vendor: "deepseek",
    desc: "原生多模态，官方 V4.1-Flash 能力与价格",
    methods: [
      {
        key: "relay",
        label: "登录账号",
        desc: "登录 DeepSeek 账号即可",
        loginModes: ["password", "paste"],
        loginFields: [
          { key: "account", label: "手机号 / 邮箱", type: "text", required: true, placeholder: "13800138000 或 you@example.com" },
          { key: "areaCode", label: "区号", type: "text", default: "+86" },
          { key: "password", label: "密码", type: "password", required: true },
        ],
        pasteHint: "浏览器登录 chat.deepseek.com 后，控制台执行 localStorage.getItem('userToken') 取 value 字段",
        // 远程抓取：服务器端打开登录页，管理员扫码/输验证码后自动读 localStorage.userToken
        entryUrl: "https://chat.deepseek.com/",
        captureHint: "登录 DeepSeek 网页版（可用手机 App 扫码），完成后点「抓取登录态」自动填表",
        needsBrowser: false,
        defaultModels: [
          { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
        testModel: "deepseek-flash",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填开放平台的 API Key",
        baseUrl: "https://api.deepseek.com",
        keyHint: "sk-...",
        // 官方当前只有这两个模型（旧 ID deepseek-chat/reasoner 已停用，不再登记）
        defaultModels: [
          { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
        testModel: "deepseek-flash",
      },
    ],
  },
  {
    key: "glm",
    name: "智谱 GLM",
    vendor: "zhipu",
    desc: "GLM 系列，网页版与开放平台双通道",
    methods: [
      {
        key: "relay",
        label: "登录账号",
        desc: "登录 Z.ai 账号，验证码自动处理",
        loginModes: ["browser"],
        loginFields: [],
        needsBrowser: true,
        browserHint: "该渠道需在服务器上打开浏览器登录一次（验证码由页面自动处理），之后长期有效",
        // 远程抓取：与适配器 ENTRY_URL 保持一致（chat.z.ai）
        entryUrl: "https://chat.z.ai",
        captureHint: "登录 Z.ai（验证码由页面自动处理），完成后点「抓取登录态」",
        defaultModels: [
          { id: "glm-5.3", name: "GLM-5.3" },
          { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
          { id: "glm-5v-turbo", name: "GLM-5V Turbo" },
        ],
        testModel: "glm-5.3-flash",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填开放平台的 API Key",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        keyHint: "填写开放平台的 API Key",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "kimi",
    name: "Kimi",
    vendor: "kimi",
    desc: "月之暗面 Kimi，支持深度思考与联网",
    methods: [
      {
        key: "relay",
        label: "登录账号",
        desc: "粘贴网页登录态即可",
        loginModes: ["paste"],
        loginFields: [],
        pasteHint: "浏览器登录 kimi.com 后，复制 Cookie 中 kimi-auth 的值（JWT，以 eyJ 开头）",
        // 远程抓取：与适配器 ENTRY_URL 保持一致（www.kimi.com）
        entryUrl: "https://www.kimi.com/",
        captureHint: "登录 Kimi 网页版（手机号验证码/扫码），完成后点「抓取登录态」自动填表",
        needsBrowser: false,
        defaultModels: [
          { id: "kimi-k3", name: "Kimi K3" },
          { id: "kimi-k2.6", name: "Kimi K2.6" },
        ],
        testModel: "kimi-k3",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填 Moonshot 开放平台的 API Key",
        baseUrl: "https://api.moonshot.cn",
        keyHint: "sk-...",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "doubao",
    name: "豆包",
    vendor: "doubao",
    desc: "字节豆包，网页版需扫码登录",
    methods: [
      {
        key: "relay",
        label: "登录账号",
        desc: "扫码登录一次，之后长期有效",
        loginModes: ["browser"],
        loginFields: [],
        needsBrowser: true,
        browserHint: "该渠道需在服务器上打开浏览器扫码登录一次，之后长期有效",
        // 远程抓取：与适配器 ENTRY_URL 保持一致
        entryUrl: "https://www.doubao.com/chat/",
        captureHint: "用手机 App 扫码登录豆包，完成后点「抓取登录态」",
        defaultModels: [
          { id: "doubao-pro", name: "豆包 Pro" },
          { id: "doubao-lite", name: "豆包 Lite" },
        ],
        testModel: "doubao-pro",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填火山方舟的 API Key",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        keyHint: "填写火山方舟的 API Key",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "qwen",
    name: "通义千问",
    vendor: "qwen",
    desc: "阿里通义千问，网页版风控较重",
    methods: [
      {
        key: "relay",
        label: "登录账号",
        desc: "登录一次，风控较重",
        loginModes: ["browser"],
        loginFields: [],
        needsBrowser: true,
        browserHint: "该渠道需在服务器上打开浏览器登录一次（阿里风控较重），之后长期有效",
        // 远程抓取：与适配器 ENTRY_URL 保持一致
        entryUrl: "https://chat.qwen.ai/",
        captureHint: "登录通义千问（阿里风控较重，耐心完成验证），完成后点「抓取登录态」",
        defaultModels: [
          { id: "qwen3.8-max", name: "通义千问 3.8 Max" },
          { id: "qwen3.7-plus", name: "通义千问 3.7 Plus" },
        ],
        testModel: "qwen3.8-max",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填阿里云百炼的 API Key",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
        keyHint: "sk-...",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    vendor: "openai",
    desc: "官方接口、OpenAI 格式中转，或 ChatGPT 订阅（Codex OAuth）",
    methods: [
      {
        key: "codex",
        adapter: "codex",
        label: "ChatGPT 订阅（Codex OAuth）",
        desc: "粘贴 Codex CLI 的凭据，走订阅用量",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "tokens": { "access_token": "...", "refresh_token": "...", "account_id": "..." } }',
          "本机运行 Codex CLI 登录后，复制 ~/.codex/auth.json 的完整内容"
        ),
        pasteHint: "Codex CLI 登录凭据（auth.json）：访问 chatgpt.com 订阅额度，平台自动用 refresh_token 续期并定期写回",
        // 线上账号实测可用的 Codex 模型（免费档含 luna/terra/5.5；付费档另有 sol/astra 等）
        defaultModels: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { id: "gpt-5.5", name: "GPT-5.5" },
          { id: "codex-auto-review", name: "Codex Auto Review" },
        ],
        testModel: "gpt-5.6-luna",
      },
      {
        // 第三方网页版反代：ChatGPT Web（chat2api 协议），模型与计费仍归 OpenAI
        key: "openai-web",
        adapter: "openai-web",
        label: "反代（网页版）",
        desc: "用 ChatGPT 网页版账号跑对话（无需 Codex 订阅）",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "accessToken": "...", "refreshToken": "可选" }',
          "登录 chatgpt.com 后打开 /api/auth/session 复制 accessToken；带 refreshToken 可自动续期"
        ),
        pasteHint: "ChatGPT 网页版 access_token：走网页版对话额度；触发风控的账号会显式报错，请换号",
        // 网页版凭据就在 chatgpt.com 自己的会话里：在服务器浏览器里登录一次即可抓取，
        // 管理员不用自己开控制台翻 /api/auth/session（手机号/邮箱验证码在同一个页面里人工完成）。
        entryUrl: "https://chatgpt.com/auth/login",
        captureApi: "/api/auth/session",
        captureHint: "在打开的页面里完成 ChatGPT 登录（含邮箱验证码），登录后点「抓取登录态」自动取 access_token",
        defaultModels: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-5.5", name: "GPT-5.5" },
          { id: "gpt-4o", name: "GPT-4o" },
        ],
        testModel: "gpt-5.6-luna",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填 Base URL 与 API Key",
        baseUrl: "https://api.openai.com",
        keyHint: "sk-...",
        defaultModels: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "gpt-4o-mini", name: "GPT-4o mini" },
        ],
        testModel: "gpt-4o-mini",
      },
    ],
  },
  {
    key: "anthropic",
    name: "Anthropic",
    vendor: "claude",
    desc: "Claude 系列：官方 API 或 Claude 订阅（Claude Code OAuth）",
    methods: [
      {
        key: "claude-oauth",
        adapter: "claude-oauth",
        label: "Claude 订阅（Claude Code OAuth）",
        desc: "粘贴 Claude Code 凭据，走订阅用量",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "access_token": "...", "refresh_token": "...", "expires_at": 0 }',
          "本机运行 Claude Code 登录后，复制 ~/.claude/.credentials.json 的 claudeAiOauth 字段内容"
        ),
        pasteHint: "Claude Code 登录凭据：访问 Claude 订阅额度，平台自动续期；请求会按官方 CLI 协议注入身份提示词",
        defaultModels: [
          { id: "claude-opus-5", name: "Claude Opus 5" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        ],
        testModel: "claude-haiku-4.5",
      },
      {
        // 第三方工具反代：Kiro（AWS Q / CodeWhisperer）订阅里的 Claude 模型
        // 工具只是通道，模型与计费仍归 Anthropic
        key: "kiro",
        adapter: "kiro",
        label: "反代（Kiro）",
        desc: "用 Kiro/AWS Q 订阅跑 Claude 模型",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "accessToken": "...", "refreshToken": "...", "region": "us-east-1", "profileArn": "可选" }',
          "粘贴 Kiro 的 kiro-auth-token.json；也可只填 refreshToken（AWS SSO 凭据需带 clientId/clientSecret）"
        ),
        pasteHint: "Kiro auth 文件：accessToken/refreshToken（+ region/profileArn；SSO 形态带 clientId/clientSecret），平台自动续期",
        defaultModels: [
          { id: "claude-opus-5", name: "Claude Opus 5" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        ],
        testModel: "claude-haiku-4.5",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填 Base URL 与 API Key",
        baseUrl: "https://api.anthropic.com",
        keyHint: "sk-ant-...",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "gemini",
    name: "Google Gemini",
    vendor: "gemini",
    desc: "Gemini 系列：官方 API 或 Google 订阅（Antigravity OAuth）",
    methods: [
      {
        key: "antigravity",
        adapter: "antigravity",
        label: "Google 订阅（Antigravity OAuth）",
        desc: "粘贴 Google OAuth 凭据，走订阅用量",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "access_token": "...", "refresh_token": "...", "project_id": "..." }',
          "Antigravity / Gemini CLI 的 OAuth 凭据（access_token + refresh_token）；project_id 可留空自动引导"
        ),
        pasteHint: "Google 订阅凭据：访问 Antigravity/Gemini Code Assist 订阅额度，平台自动续期并引导 project_id",
        defaultModels: [
          { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ],
        testModel: "",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填写 Base URL 与 API Key",
        baseUrl: "https://generativelanguage.googleapis.com",
        keyHint: "填写 Gemini API Key",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "custom",
    name: "自定义",
    vendor: "custom",
    desc: "任意 OpenAI 兼容上游，地址与模型全部自己填",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "自行填写 Base URL、API Key 与模型",
        baseUrl: "",
        keyHint: "sk-...",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "grok",
    name: "xAI Grok",
    vendor: "grok",
    desc: "Grok 系列：订阅 OAuth（device-code）或官方 API Key",
    methods: [
      {
        key: "grok-oauth",
        adapter: "grok",
        label: "Grok 订阅（xAI OAuth）",
        desc: "粘贴 CPA/sub2api 导出的 Grok 凭据",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "type": "xai", "access_token": "...", "refresh_token": "...", "auth_kind": "oauth" }',
          "支持 CPA 的 xai auth 文件、sub2api 导出的 grok 凭据；含 refresh_token 即可自动续期"
        ),
        pasteHint: "Grok 订阅凭据：走 cli-chat-proxy.grok.com 的 Responses 通道，平台自动续期并保持官方 CLI 指纹",
        defaultModels: [
          { id: "grok-4.6", name: "Grok 4.6" },
          { id: "grok-4.5", name: "Grok 4.5" },
          { id: "grok-4.3", name: "Grok 4.3" },
        ],
        testModel: "grok-4.5",
      },
      {
        key: "api",
        label: "API Key",
        desc: "xAI 官方 API Key（api.x.ai）",
        baseUrl: "https://api.x.ai/v1",
        keyHint: "xai-...",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    key: "workbuddy",
    name: "WorkBuddy / CodeBuddy",
    vendor: "workbuddy",
    desc: "腾讯 WorkBuddy/CodeBuddy 桌面端凭据反代（后端本身就是 OpenAI 协议）",
    methods: [
      {
        key: "workbuddy",
        adapter: "workbuddy",
        label: "桌面端凭据（WorkBuddy）",
        desc: "粘贴桌面端登录凭据，走腾讯托管模型",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "access_token": "...", "device_token": "...", "user_id": "...", "enterprise_id": "可选" }',
          "登录 WorkBuddy/CodeBuddy 桌面端后，复制本机登录文件（workbuddy-desktop.info）里的 token 与设备头"
        ),
        pasteHint: "WorkBuddy 凭据：access_token（Bearer）+ X-Device-Token/X-User-Id（风控头）；token 过期后重新粘贴",
        defaultModels: [
          { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash（腾讯）" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro（腾讯）" },
          { id: "glm-5.3", name: "GLM-5.3（腾讯）" },
          { id: "kimi-k3", name: "Kimi K3（腾讯）" },
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna（腾讯）" },
        ],
        testModel: "deepseek-v4.1-flash",
      },
    ],
  },
  {
    key: "qoder",
    name: "Qoder（阿里）",
    vendor: "qoder",
    desc: "Qoder 订阅经本地桥（qoder2api）转 OpenAI 协议；PAT 作为 Key",
    methods: [
      {
        key: "qoder",
        adapter: "qoder",
        label: "本地桥（qoder2api）",
        desc: "桥地址 + Qoder PAT",
        loginModes: ["paste"],
        loginFields: oauthCredentialField(
          '{ "personal_token": "pt-...", "endpoint": "http://127.0.0.1:8963" }',
          "先在本地起 qoder2api/qoder-proxy 桥；PAT 在 qoder.com「服务集成 → 个人访问令牌」创建"
        ),
        pasteHint: "Qoder 推理协议需官方 WASM 签名，服务端不直连；桥默认 http://127.0.0.1:8963，凭据为 PAT（pt-...）",
        defaultModels: [
          { id: "Qwen3.7-Max", name: "Qwen3.7 Max" },
          { id: "Qwen3.7-Plus", name: "Qwen3.7 Plus" },
          { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
          { id: "GLM-5.2", name: "GLM-5.2" },
          { id: "Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
        ],
        testModel: "Qwen3.7-Plus",
      },
    ],
  },
];

/* ------------------------------ 查询工具 ------------------------------ */

export function getProvider(key) {
  return PROVIDERS.find((p) => p.key === key) || null;
}

export function providerKeys() {
  return PROVIDERS.map((p) => p.key);
}

export function enabledProviders() {
  return PROVIDERS;
}

/** 取某个厂商的某种接入方式配置 */
export function getMethod(providerKey, methodKey) {
  const p = getProvider(providerKey);
  if (!p) return null;
  return p.methods.find((m) => m.key === methodKey) || null;
}

/** 厂商默认接入方式：优先反代（平台的特色能力），否则第一个 */
export function defaultMethodKey(providerKey) {
  const p = getProvider(providerKey);
  if (!p) return "api";
  return p.methods.some((m) => m.key === "relay") ? "relay" : p.methods[0].key;
}

/** 某厂商是否支持某种接入方式 */
export function supportsMethod(providerKey, methodKey) {
  return Boolean(getMethod(providerKey, methodKey));
}

/** 渠道是否走订阅 OAuth 接入 */
export function isSubscriptionChannel(providerKey, methodKey) {
  return isOAuthMethod(methodKey) && supportsMethod(providerKey, methodKey);
}

/**
 * 适配器 key 解析 —— 调度层的入口
 *   relay → 该厂商自己的适配器（各家签名/风控不同，必须专实现）
 *   api   → 统一 openai-compat（OpenAI 兼容协议）
 *   订阅 OAuth → 方法上显式声明的 adapter（codex / claude-oauth / antigravity）
 */
export function adapterFor(providerKey, methodKey) {
  const m = getMethod(providerKey, methodKey);
  if (m?.adapter) return m.adapter;
  if (methodKey === "api") return "openai-compat";
  return providerKey;
}

/** 该接入方式是否需要我们能驱动浏览器 */
export function needsBrowser(providerKey, methodKey) {
  return Boolean(getMethod(providerKey, methodKey)?.needsBrowser);
}

/** 对外下发用（前端「添加渠道」按此渲染，不含函数） */
export function publicProviders() {
  return PROVIDERS.map((p) => ({
    key: p.key,
    name: p.name,
    vendor: p.vendor,
    desc: p.desc,
    defaultMethod: defaultMethodKey(p.key),
    methods: p.methods.map((m) => ({
      key: m.key,
      label: m.label,
      desc: m.desc,
      // 订阅 OAuth 方式（codex / claude-oauth / antigravity）：前端按「粘贴凭据」渲染
      oauth: isOAuthMethod(m.key),
      loginModes: m.loginModes || [],
      loginFields: m.loginFields || [],
      pasteHint: m.pasteHint || "",
      browserHint: m.browserHint || "",
      // 远程登录抓取能力：有 entryUrl 就说明支持「打开登录页自动抓取」
      captureHint: m.captureHint || "",
      canCapture: Boolean(m.entryUrl),
      needsBrowser: Boolean(m.needsBrowser),
      baseUrl: m.baseUrl || "",
      keyHint: m.keyHint || "",
      defaultModels: m.defaultModels || [],
      testModel: m.testModel || "",
    })),
  }));
}
