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
    keyUrl: "https://platform.deepseek.com/api_keys",
    vendor: "deepseek",
    desc: "原生多模态，官方 V4.1-Flash 能力与价格",
    methods: [
      {
        key: "relay",
        label: "网页对话",
        desc: "登录 DeepSeek 账号即可（网页版通道）",
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
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    vendor: "zhipu",
    desc: "GLM 系列，网页版与开放平台双通道",
    methods: [
      {
        key: "relay",
        label: "系统驱动",
        desc: "登录 Z.ai 账号后在服务器浏览器里跑（页面自己算签名）",
        // 只留 paste：`browser` 代表服务器浏览器登录，已废弃
        //（用户实测「卡的不行、吃服务器内存」，且本机浏览器粘贴完全能替代）。
        // 留着它会让这些厂商在弹窗里多出一个 tab —— 「有的一个 tab 有的两个」的根源。
        loginModes: ["paste"],
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
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    vendor: "kimi",
    desc: "月之暗面 Kimi，支持深度思考与联网",
    methods: [
      {
        key: "relay",
        label: "网页对话",
        desc: "粘贴网页版登录态即可",
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
    keyUrl: "https://console.volcengine.com/ark",
    vendor: "doubao",
    desc: "字节豆包，网页版需扫码登录",
    methods: [
      {
        key: "relay",
        label: "系统驱动",
        desc: "扫码登录一次后在服务器浏览器里跑（a_bogus 签名由页面生成）",
        // 只留 paste：`browser` 代表服务器浏览器登录，已废弃
        //（用户实测「卡的不行、吃服务器内存」，且本机浏览器粘贴完全能替代）。
        // 留着它会让这些厂商在弹窗里多出一个 tab —— 「有的一个 tab 有的两个」的根源。
        loginModes: ["paste"],
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
    keyUrl: "https://bailian.console.aliyun.com/",
    vendor: "qwen",
    desc: "阿里通义千问，网页版风控较重",
    methods: [
      {
        key: "relay",
        label: "系统驱动",
        desc: "登录一次后在服务器浏览器里跑（风控较重，页面自己算签名）",
        // 只留 paste：`browser` 代表服务器浏览器登录，已废弃
        //（用户实测「卡的不行、吃服务器内存」，且本机浏览器粘贴完全能替代）。
        // 留着它会让这些厂商在弹窗里多出一个 tab —— 「有的一个 tab 有的两个」的根源。
        loginModes: ["paste"],
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
    keyUrl: "https://platform.openai.com/api-keys",
    vendor: "openai",
    desc: "官方接口、OpenAI 格式中转，或 ChatGPT 订阅（Codex OAuth）",
    methods: [
      {
        key: "codex",
        adapter: "codex",
        label: "Codex",
        // 登录入口：ChatGPT 订阅页（用户在这里登录后，Codex CLI 才能授权取凭据）
        entryUrl: "https://chatgpt.com/#settings/Subscription",
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
        label: "网页对话",
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
        // 浏览器 UI 驱动反代：与上一个方法的根本区别在于**请求从哪发出去**。
        // 「反代（网页版）」在 Node 里直接拼 HTTP（现在会被 sentinel 的 turnstile 拦死，
        // Node 端无解）；这个方式在服务器浏览器里驱动真实页面 UI，页面自己过风控。
        key: "openai-web-ui",
        adapter: "openai-web-ui",
        label: "系统驱动",
        desc: "用邮箱+密码+2FA 自动登录，在服务器浏览器里驱动页面（无需手工操作）",
        loginModes: ["password"],
        // needs2fa：让前端在账号密码之外多渲染一个「2FA 密钥」输入框。
        // 密钥（base32）≠ 6 位动态码 —— 后者每 30 秒变一次，没法存下来复用。
        needs2fa: true,
        loginFields: [
          { key: "account", label: "邮箱", type: "text", required: true, placeholder: "you@example.com" },
          { key: "password", label: "密码", type: "password", required: true },
          {
            key: "totpSecret",
            label: "2FA 密钥",
            type: "password",
            placeholder: "验证器 App 里那串 base32 密钥（未开两步验证可留空）",
          },
        ],
        needsBrowser: true,
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
    keyUrl: "https://console.anthropic.com/settings/keys",
    vendor: "claude",
    desc: "Claude 系列：官方 API 或 Claude 订阅（Claude Code OAuth）",
    methods: [
      {
        key: "claude-oauth",
        adapter: "claude-oauth",
        label: "Claude 订阅",
        entryUrl: "https://claude.ai/login",
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
        key: "api",
        adapter: "anthropic-compat",
        label: "API Key（Anthropic 兼容）",
        desc: "标准 /v1/messages 协议：官方 API 或任意 Anthropic 兼容中转",
        baseUrl: "https://api.anthropic.com",
        keyHint: "sk-ant-...",
        defaultModels: [
          { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
        testModel: "claude-haiku-4-5",
      },
    ],
  },
  {
    key: "gemini",
    name: "Google Gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    vendor: "gemini",
    desc: "Gemini 系列：官方 API 或 Google 订阅（Antigravity OAuth）",
    methods: [
      {
        key: "antigravity",
        adapter: "antigravity",
        label: "Google 订阅",
        entryUrl: "https://accounts.google.com/",
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
        desc: "填写 Gemini API Key（走 Google 官方的 OpenAI 兼容端点）",
        // 必须用 **OpenAI 兼容端点**，不能填裸域名。
        //
        // 原值 `https://generativelanguage.googleapis.com` 是 Google 的原生 API
        // 根地址，而本平台的 API Key 渠道统一走 openai-compat（拼 `/v1/chat/completions`），
        // 于是实际请求会打到 `.../v1/chat/completions` —— 那个路径在 Google 那边
        // **不存在**（原生协议是 `/v1beta/models/{model}:generateContent`）。
        // 结果：用户以为配好的是 Google 官方 API，实际每个请求都必然 404。
        // 第 46 批复审点名了这一点，给出的两条出路里选「让它真的可用」。
        //
        // Google 官方提供 OpenAI 兼容层：`/v1beta/openai/`，支持
        // chat/completions 与 models，**并返回真实 usage**（原生协议要自己解析
        // usageMetadata，走兼容层两条协议都能正确计费）。
        // 填完整端点（到 /chat/completions）：openai-compat 的 endpoints()
        // 会据此推出 models 端点，且不会再多拼一层版本段。
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        keyHint: "填写 Google AI Studio 的 Gemini API Key（AIza...）",
        defaultModels: [],
        testModel: "",
      },
    ],
  },
  {
    // Kiro 独立成厂商（此前挂在 anthropic 下）。用户指出「workbuddy 都单独拉成厂商了，
    // kiro 为啥寄居在 claude 里」—— 这批评是对的。
    //
    // **归属该按「用谁的订阅/账号」定，不该按「跑什么模型」定**：Kiro 是 AWS 的产品，
    // 用 AWS 订阅登录、凭据是 kiro-auth-token.json；而 anthropic 下的 claude-oauth
    // 走的是 Claude Code CLI 凭据 —— 两条完全不同的链路。
    // 挂在 anthropic 下的实际后果：新增渠道要在厂商列表先找「Anthropic」、
    // 再在凭据里找「反代（Kiro）」，用户根本想不到 Kiro 藏在 Claude 里面。
    //
    // 它跑的 Claude 模型**仍归 Anthropic 厂商**（模型归属 ≠ 账号归属），
    // 所以 vendor 标 anthropic、defaultModels 保留 claude-* 真实模型名。
    key: "kiro",
    name: "Kiro（AWS）",
    vendor: "anthropic",
    desc: "AWS Kiro 订阅反代：用 Kiro 账号跑 Claude 模型（凭据 kiro-auth-token.json）",
    methods: [
      {
      // 第三方工具反代：Kiro（AWS Q / CodeWhisperer）订阅里的 Claude 模型
      // 工具只是通道，模型与计费仍归 Anthropic
      key: "kiro",
      adapter: "kiro",
      label: "Kiro",
      desc: "用 Kiro/AWS Q 订阅跑 Claude 模型",
      // 凭据在 Kiro 客户端里：点开这个入口登录后，本机 ~/.aws/sso/cache/ 会出现
      // 对应的 token 文件（或从 Kiro 设置里导出 kiro-auth-token.json）
      entryUrl: "https://app.kiro.dev/",
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
    ],
  },
  {
    key: "custom",
    name: "自定义（通用兼容）",
    vendor: "custom",
    desc: "任意 OpenAI 兼容 / Anthropic 兼容上游，地址与模型全部自己填",
    methods: [
      {
        key: "api",
        adapter: "openai-compat",
        label: "OpenAI 兼容",
        desc: "自填 Base URL、API Key 与模型（/v1/chat/completions 协议）",
        baseUrl: "",
        keyHint: "sk-...",
        defaultModels: [],
        testModel: "",
      },
      {
        key: "anthropic",
        adapter: "anthropic-compat",
        label: "Anthropic 兼容",
        desc: "自填 Base URL、API Key 与模型（/v1/messages 协议）",
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
    keyUrl: "https://console.x.ai/",
    vendor: "grok",
    desc: "Grok 系列：订阅 OAuth（device-code）或官方 API Key",
    methods: [
      {
        key: "grok-oauth",
        // adapter 名必须与 router.js 的 ADAPTERS 表键**完全一致**。
        // 这里曾写 "grok" 而表里注册的是 "grok-oauth" → 解析出的 key 查不到
        // → 渠道一建就「适配器不可用」。静态一致性检查（tests/adapter-registry）
        // 会盯住这类不一致。
        adapter: "grok-oauth",
        label: "Grok 订阅",
        entryUrl: "https://accounts.x.ai/",
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
    keyUrl: "https://www.workbuddy.ai/",
    vendor: "workbuddy",
    desc: "腾讯 WorkBuddy/CodeBuddy 桌面端凭据反代（后端本身就是 OpenAI 协议）",
    methods: [
      {
        key: "workbuddy",
        adapter: "workbuddy",
        label: "WorkBuddy",
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
    keyUrl: "https://qoder.com/account/integrations",
    vendor: "qoder",
    desc: "Qoder 订阅经本地桥（qoder2api）转 OpenAI 协议；PAT 作为 Key",
    methods: [
      {
        key: "qoder",
        adapter: "qoder",
        label: "Qoder",
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
  // ---- 国产厂商直连（OpenAI 兼容，Key + Base URL）----
  // 这四家都是标准 OpenAI 协议，走 openai-compat；协议差异在 vendor-quirks.js 处理。
  {
    key: "mimo",
    name: "小米 MiMo",
    keyUrl: "https://platform.xiaomimimo.com/",
    vendor: "mimo",
    desc: "小米 MiMo：MiMo Studio 网页版反代，或官方 API 直连",
    methods: [
      {
        key: "mimo-web",
        adapter: "mimo-web",
        label: "网页对话",
        desc: "用小米账号登录，走订阅额度",
        // 只保留 paste：抓取（浏览器登录）是 paste 面板里的入口，不是独立模式。
        // 见前端 credOptions 的注释 —— 拆成两个模式会让弹窗裂出两个按钮，
        // 而其中一个（capture）没有对应渲染分支，点进去是空白表单。
        loginModes: ["paste"],
        entryUrl: "https://aistudio.xiaomimimo.com/",
        captureHint: "登录 MiMo Studio（小米账号 SSO），完成后点「抓取登录态」自动读取 Cookie",
        pasteHint:
          "MiMo Studio 登录态：复制 Cookie 里的 serviceToken / userId / xiaomichatbot_ph（三个都要；只填 serviceToken 仍可建渠道，但缺 ph 易被风控）",
        defaultModels: [
          { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
          { id: "mimo-v2.5", name: "MiMo V2.5" },
        ],
        testModel: "mimo-v2.5",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填 platform.xiaomimimo.com 的 API Key（sk-...）",
        baseUrl: "https://api.xiaomimimo.com/v1",
        keyHint: "sk-...",
        defaultModels: [
          { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
          { id: "mimo-v2.5", name: "MiMo V2.5" },
        ],
        testModel: "mimo-v2.5",
      },
    ],
  },
  {
    key: "minimax",
    name: "MiniMax",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    vendor: "minimax",
    desc: "MiniMax：MiniMax Agent 网页版反代，或官方 API 直连（国内 api.minimax.cn / 国际 api.minimax.io）",
    methods: [
      {
        key: "minimax-web",
        adapter: "minimax-web",
        label: "网页对话",
        desc: "用 MiniMax 账号登录，走 C 端额度",
        // 只保留 paste：抓取（浏览器登录）是 paste 面板里的入口，不是独立模式。
        // 见前端 credOptions 的注释 —— 拆成两个模式会让弹窗裂出两个按钮，
        // 而其中一个（capture）没有对应渲染分支，点进去是空白表单。
        loginModes: ["paste"],
        // 注意：chat.minimaxi.com 已 307 跳转到 agent.minimaxi.com，接入点是后者
        entryUrl: "https://agent.minimaxi.com/",
        captureHint: "登录 MiniMax Agent，完成后点「抓取登录态」自动读取 token",
        pasteHint:
          "MiniMax Agent 登录态：复制 Cookie 里的 token（JWT）。签名是纯 MD5 可复刻，指纹参数由平台稳定派生",
        defaultModels: [
          { id: "MiniMax-M3", name: "MiniMax M3" },
          { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
        ],
        testModel: "MiniMax-M2.7",
      },
      {
        key: "api",
        label: "API Key",
        desc: "平台强制开启 reasoning_split，思维链不会混进正文",
        baseUrl: "https://api.minimax.cn/v1",
        keyHint: "填 MiniMax 开放平台的 API Key",
        defaultModels: [
          { id: "MiniMax-M3", name: "MiniMax M3" },
          { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
        ],
        testModel: "MiniMax-M2.7",
      },
    ],
  },
  {
    key: "stepfun",
    name: "阶跃星辰 StepFun",
    keyUrl: "https://platform.stepfun.com/interface-key",
    vendor: "stepfun",
    desc: "阶跃星辰：chat.stepfun.com 网页版反代，或官方 API 直连",
    methods: [
      {
        key: "stepfun-web",
        adapter: "stepfun-web",
        label: "网页对话",
        desc: "手机号登录，走 C 端额度（协议零签名）",
        // 只保留 paste：抓取（浏览器登录）是 paste 面板里的入口，不是独立模式。
        // 见前端 credOptions 的注释 —— 拆成两个模式会让弹窗裂出两个按钮，
        // 而其中一个（capture）没有对应渲染分支，点进去是空白表单。
        loginModes: ["paste"],
        // 不要用 yuewen.cn：实测该域名 TLS 证书已过期并返回 403，品牌已退役
        entryUrl: "https://chat.stepfun.com/",
        captureHint: "登录 chat.stepfun.com（手机号短信），完成后点「抓取登录态」自动读取 Cookie",
        pasteHint: "chat.stepfun.com 登录态：复制 Cookie（形如 a=b; c=d）",
        defaultModels: [
          { id: "step-5-preview", name: "Step 5 Preview" },
          { id: "step-3.7-flash", name: "Step 3.7 Flash" },
        ],
        testModel: "step-3.5-flash",
      },
      {
        key: "api",
        label: "API Key",
        desc: "填 platform.stepfun.com 的 API Key",
        baseUrl: "https://api.stepfun.com/v1",
        keyHint: "填 StepFun 开放平台的 API Key",
        defaultModels: [
          { id: "step-5-preview", name: "Step 5 Preview" },
          { id: "step-3.7-flash", name: "Step 3.7 Flash" },
        ],
        testModel: "step-3.5-flash",
      },
    ],
  },
  {
    key: "ark",
    name: "火山方舟",
    keyUrl: "https://console.volcengine.com/ark",
    vendor: "ark",
    desc: "字节火山方舟（Doubao Seed 系列；API Key 鉴权时 model 直接填模型名，无需 ep- 接入点）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "方舟在容量紧张时会自动降级模型，平台会按实际生效的模型计费",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        keyHint: "填火山方舟的 API Key",
        defaultModels: [
          { id: "doubao-seed-2-1-pro", name: "Doubao Seed 2.1 Pro" },
          { id: "doubao-seed-2-1-turbo", name: "Doubao Seed 2.1 Turbo" },
        ],
        testModel: "doubao-seed-1-6-flash",
      },
    ],
  },
  // ---- 三方兼容聚合（OpenAI / Anthropic 协议接入，Key + Base URL）----
  {
    key: "opencode",
    name: "OpenCode",
    keyUrl: "https://opencode.ai/auth",
    vendor: "opencode",
    // Zen 与 GO 是 OpenCode 的**两个独立产品**（不是同一产品的两个名字）：
    //   · Zen：按量付费（预充值、零加价），模型池约 76 个（含 Claude/GPT/Gemini）
    //   · GO ：$10/月订阅，模型池约 40 个（**仅开源模型**：GLM/Kimi/MiMo/Qwen/DeepSeek/MiniMax…）
    // 官网 FAQ 原话：「Is Go the same as Zen? → No.」
    // 两者**鉴权完全一致**（同一把 `sk-`+64 位 key，两个前缀都能通过），
    // 区别只在 baseUrl 的 path 前缀与计费来源 —— 所以做成同一厂商下的两个接入方式，
    // 正好对应「同一把 key，换个地址就是另一个套餐」。
    desc: "OpenCode 官方模型网关：Zen（按量付费）或 GO（$10/月订阅）",
    methods: [
      {
        // Zen 保留 key="api"（历史渠道都用它，改 key 会让既有渠道解析不到适配器）
        key: "api",
        // 走专用适配器：Go 订阅必须带 x-opencode-session 与自述 UA，
        // 缺了会被 400 missing_session_id 拒绝（见 upstream/opencode.js）
        adapter: "opencode",
        label: "Zen（按量付费）",
        desc: "OpenCode Zen API Key（opencode.ai/zen，预充值按量计费，含 Claude/GPT/Gemini）",
        baseUrl: "https://opencode.ai/zen/v1",
        keyHint: "sk-...",
        // 清单实测自 GET https://opencode.ai/zen/v1/models（可匿名拉取）。
        // 注意 qwen3-coder / grok-code / kimi-k2 已从 Zen 下架，
        // 留在默认列表会让管理员一建渠道就默认选中不存在的模型。
        defaultModels: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          { id: "glm-5.3", name: "GLM-5.3" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
        testModel: "gpt-5.6-luna",
      },
      {
        // GO：与 Zen 同一把 key、不同 path 前缀（/zen/go/v1）。
        // 用独立 method key（不叫 "api"）→ isApiKeyMethod 判定为 API Key 型，
        // 前端会渲染成独立一档表单，baseUrl 自带、用户不用填地址。
        key: "go",
        adapter: "opencode",
        label: "GO（$10/月订阅）",
        desc: "OpenCode GO 订阅（opencode.ai/zen/go，仅开源模型；用同一把 sk- key）",
        baseUrl: "https://opencode.ai/zen/go/v1",
        keyHint: "sk-...（与 Zen 同一把 key；需该账号本人订阅了 GO 才计入订阅额度）",
        // 清单实测自 GET https://opencode.ai/zen/go/v1/models（可匿名拉取，约 40 个）。
        // 这里只留各家族旗舰，完整清单用「从上游获取模型」拉。
        defaultModels: [
          { id: "glm-5.3", name: "GLM-5.3" },
          { id: "kimi-k3", name: "Kimi K3" },
          { id: "minimax-m3", name: "MiniMax M3" },
          { id: "qwen3.8-max", name: "Qwen3.8 Max" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
          { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro" },
          { id: "longcat-2.0", name: "LongCat 2.0" },
        ],
        testModel: "glm-5.3",
      },
    ],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    vendor: "openrouter",
    desc: "多厂商聚合（OpenAI 兼容，模型用 vendor/model 命名）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "OpenRouter API Key（openrouter.ai）",
        baseUrl: "https://openrouter.ai/api/v1",
        keyHint: "sk-or-...",
        defaultModels: [
          { id: "openai/gpt-5.5", name: "OpenAI GPT-5.5" },
          { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        ],
        testModel: "openai/gpt-5.5",
      },
    ],
  },
  {
    // Cline（cline.bot）—— 调研结论：**官方就提供标准 OpenAI 兼容 API**，
    // 所以按普通 API Key 渠道接入，**不需要**任何反代/逆向。
    //
    // 调研记录（2026-09-23，逐条有据可查）：
    //   · 官方端点 POST https://api.cline.bot/api/v1/chat/completions，
    //     认证 Authorization: Bearer <key>；Key 在 app.cline.bot → Settings → API Keys
    //     创建，与扩展登录得到的 account token **是同一套头格式**（官方文档 api/authentication）。
    //   · GET {base}/models **公开无需鉴权**（实测返回 200 + 454 个模型），
    //     所以拉模型清单不需要先有 Key。
    //   · 模型 id 是 vendor/model 形式（同 OpenRouter）：anthropic/claude-sonnet-4.6、
    //     openai/gpt-5.6-luna、google/gemini-3.5-flash 等；另有 :free / :batch 后缀档。
    //     getPrice 已支持剥离 vendor/ 前缀，所以这些 id 能直接命中平台已有定价。
    //   · 计费形态：Cline 自己的 credit（usage-billing）或 ClinePass 订阅（$9.99/月）。
    //
    // **为什么接成 API Key 而不是反代**（调研里最关键的结论）：
    // 社区确有一批 cline2api 反代项目（拿扩展 refreshToken + 伪造客户端头），
    // 但那条路对我们是多余的 —— 官方既有标准 API、又有正式签发的 Key。
    // 且它明确违反其 ToS（§2.2 禁止「以官方提供之外的技术手段访问」、§7.3 禁止共享订阅），
    // 并已被部分封堵（订阅档 cline-pass/* 直接 403 "only available via Cline product surfaces"）。
    // 用官方 Key 既稳定、又不涉封号风险。
    key: "cline",
    name: "Cline",
    keyUrl: "https://app.cline.bot/settings/api-keys",
    vendor: "cline",
    desc: "Cline 官方 API（OpenAI 兼容，模型用 vendor/model 命名）",
    methods: [
      {
        // ── 方式一：一键绑定（设备授权，主路径）──
        // 用户点一下 → 打开 authkit.cline.bot/device 输用户码 → 自动写入凭据。
        // 走 WorkOS 的标准 RFC 8628 设备流，端点均已实测（见 device-bind.js 的注释）。
        key: "cli",
        adapter: "cline",
        label: "Cline 账号（一键绑定）",
        desc: "设备授权绑定 Cline 账号，自动续期；无需手工找 token",
        loginModes: ["paste"],
        loginFields: [],
        pasteHint: "粘贴 Cline 的 refreshToken（或包含它的完整 JSON）；也可直接用上方「一键绑定」",
        testModel: "anthropic/claude-haiku-4.5",
        // 与 api 方式同一份清单（账号绑定与 API Key 能用的模型集合相同）
        defaultModels: [
          { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5" },
          { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
          { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "openai/gpt-5.5", name: "GPT-5.5" },
          { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "z-ai/glm-5.3", name: "GLM-5.3" },
          { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
          { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
        ],
      },
      {
        // ── 方式二：官方 API Key ──
        // Cline 在 app.cline.bot 提供正式签发的 API Key，与扩展登录的 account token
        // 是同一套 Bearer 头格式。手上已有 Key 的用这条，最省事。
        key: "api",
        // API Key 方式同样走 cline 适配器：客户端标识头 + 响应包封解包都要用
        //（Key 方式不需要刷新逻辑，但标识头不带会被上游 403）
        adapter: "cline",
        label: "API Key",
        desc: "Cline API Key（app.cline.bot → Settings → API Keys）",
        baseUrl: "https://api.cline.bot/api/v1",
        keyHint: "Cline 账号的 API Key",
        defaultModels: [
          { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5" },
          { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
          { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "openai/gpt-5.5", name: "GPT-5.5" },
          { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "z-ai/glm-5.3", name: "GLM-5.3" },
          { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
          { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
        ],
        testModel: "anthropic/claude-haiku-4.5",
      },
    ],
  },
  {
    key: "siliconflow",
    name: "硅基流动",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    vendor: "siliconflow",
    desc: "国内模型聚合（OpenAI 兼容）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "SiliconFlow API Key（siliconflow.cn）",
        baseUrl: "https://api.siliconflow.cn/v1",
        keyHint: "sk-...",
        defaultModels: [
          { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2" },
          { id: "Qwen/Qwen3-235B-A22B", name: "Qwen3 235B" },
          { id: "zai-org/GLM-4.6", name: "GLM-4.6" },
          { id: "moonshotai/Kimi-K2", name: "Kimi K2" },
        ],
        testModel: "deepseek-ai/DeepSeek-V3.2",
      },
    ],
  },
  // ---- 2026 新增（调研 + 端点实测，见 AI协作.md 第 48 批）----
  {
    key: "typesafe",
    name: "TypeSafe AI（Jev）",
    keyUrl: "https://console.typesafe.ai/keys",
    vendor: "typesafe",
    // Jev 与传统 chat 模型的根本区别：**它不生成文本**。
    // 输入 state + 类型化 problems，输出类型化判断 + 概率 + 置信度
    // （noul 是/否、choice 多选上限 255、score 评分），全程无 free-text。
    // 因此它**刻意不兼容 OpenAI**，只有一个端点 POST /v1/systemone。
    desc: "Jev（System One 判定模型）：不生成文本，输出类型化判断与置信度；协议非 OpenAI 兼容",
    methods: [
      {
        key: "systemone",
        // 非 OpenAI 协议 → 用独立适配器（不能走 openai-compat）
        adapter: "typesafe",
        label: "System One",
        desc: "原生 /v1/systemone：请求 {state, model, questions}，响应 {model, answers, usage}",
        baseUrl: "https://api.typesafe.ai",
        keyHint: "TypeSafe API Key（console.typesafe.ai/keys 获取）",
        // 实测 GET /v1/models 无 key 返回 403「Must supply an API key」→ 地址与鉴权方式确认
        defaultModels: [
          { id: "jev-latest", name: "Jev Latest（稳定版）" },
          { id: "jev-preview", name: "Jev Preview" },
          { id: "jev-1.13.0", name: "Jev 1.13.0" },
        ],
        testModel: "jev-latest",
      },
    ],
  },
  {
    key: "longcat",
    name: "LongCat（美团）",
    keyUrl: "https://longcat.chat/platform/api_keys",
    vendor: "longcat",
    desc: "LongCat-2.0，1M 上下文；OpenAI 与 Anthropic 双协议",
    methods: [
      {
        key: "api",
        label: "OpenAI 兼容",
        desc: "LongCat 开放平台（api.longcat.chat/openai）",
        baseUrl: "https://api.longcat.chat/openai",
        keyHint: "在 longcat.chat/platform/api_keys 获取",
        defaultModels: [{ id: "LongCat-2.0", name: "LongCat-2.0" }],
        testModel: "LongCat-2.0",
      },
      {
        // 双协议：实测 /anthropic/v1/messages 返回 405（端点存在、仅不收 GET），
        // 说明上游同时提供 Anthropic 协议 —— 用 anthropic-compat 适配器接入，
        // 这样 Claude SDK 的客户端也能直接打这个渠道。
        key: "anthropic",
        adapter: "anthropic-compat",
        label: "Anthropic 兼容",
        desc: "同一账号的 Claude 协议端点（api.longcat.chat/anthropic）",
        baseUrl: "https://api.longcat.chat/anthropic",
        keyHint: "与 OpenAI 端点同一把 key",
        defaultModels: [{ id: "LongCat-2.0", name: "LongCat-2.0" }],
        testModel: "LongCat-2.0",
      },
    ],
  },
  {
    key: "chutes",
    name: "Chutes",
    keyUrl: "https://chutes.ai/app/api",
    vendor: "chutes",
    desc: "去中心化算力聚合（Kimi K3 / GLM / DeepSeek / Qwen）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "Chutes（llm.chutes.ai，支持 PAYG 与 $10/月订阅）",
        baseUrl: "https://llm.chutes.ai/v1",
        keyHint: "在 chutes.ai 控制台获取",
        // 实测 GET /v1/models 返回 200（清单可匿名读取）
        defaultModels: [
          { id: "moonshotai/Kimi-K3", name: "Kimi K3" },
          { id: "zai-org/GLM-5.2", name: "GLM 5.2" },
          { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
          { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5 397B" },
        ],
        testModel: "zai-org/GLM-5.2",
      },
    ],
  },
  {
    key: "nvidia",
    name: "NVIDIA NIM",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    vendor: "nvidia",
    desc: "NVIDIA 官方推理服务（Nemotron 系列）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "build.nvidia.com 的 API Key（integrate.api.nvidia.com）",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        keyHint: "nvapi-...",
        // 实测 GET /v1/models 返回 200
        defaultModels: [
          { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B" },
          { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B" },
        ],
        testModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
      },
    ],
  },
  {
    key: "cerebras",
    name: "Cerebras",
    keyUrl: "https://cloud.cerebras.ai/",
    vendor: "cerebras",
    desc: "Cerebras 推理云（官方称 OpenAI 客户端兼容）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "Cerebras（api.cerebras.ai，另有 Code 订阅）",
        baseUrl: "https://api.cerebras.ai/v1",
        keyHint: "csk-...",
        // 实测 GET /v1/models 返回 403（需鉴权）→ 地址确认
        defaultModels: [
          { id: "qwen-3.8-27b", name: "Qwen 3.8 27B" },
          { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
        ],
        testModel: "qwen-3.8-27b",
      },
    ],
  },
  {
    key: "hunyuan",
    name: "腾讯混元",
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    vendor: "hunyuan",
    desc: "混元 Hy3 系列（官方明确兼容 OpenAI 接口规范）",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "腾讯云混元（api.hunyuan.cloud.tencent.com）",
        baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
        keyHint: "在腾讯云控制台获取",
        // 实测 GET /v1/models 返回 401（需鉴权）→ 地址确认
        defaultModels: [
          { id: "hunyuan-hy3", name: "混元 Hy3" },
          { id: "hunyuan-turbos-latest", name: "混元 TurboS" },
        ],
        testModel: "hunyuan-hy3",
      },
    ],
  },
  {
    key: "meta",
    name: "Meta（Muse Spark）",
    keyUrl: "https://dev.meta.ai/",
    vendor: "meta",
    desc: "Meta Muse Spark 系列，1M 上下文",
    methods: [
      {
        key: "api",
        label: "API Key",
        desc: "Meta Model API（api.meta.ai）",
        baseUrl: "https://api.meta.ai/v1",
        keyHint: "在 Meta 开发者平台获取",
        // 实测 GET /v1/models 返回 401（需鉴权）→ 地址确认。
        // 注意：官方文档站（dev.meta.ai）在本机与服务器均连接超时，
        // 模型 id 与定价取自社区实现（CLIProxyAPI 配置），可能随官方调整。
        defaultModels: [
          { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
          { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
          { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
        ],
        testModel: "muse-spark-1.3",
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
/**
 * 该接入方式是不是「API Key 型」——
 * 判据：有 Base URL、且没有登录方式（loginModes）。
 *
 * 为什么不只判 `key === "api"`：同一厂商下可能有**多个 API Key 型方式**，
 * 它们的区别只在 baseUrl（典型：OpenCode 的 Zen 与 GO 是同一把 key、
 * 不同 path 前缀），也可能用不同协议（自定义厂商下的 Anthropic 兼容）。
 * 把判据锁死在字符串 "api" 上会导致这些方式：
 *   · 在「添加渠道」里根本不出现（前端按 key==="api" 才会渲染 API Key 选项）；
 *   · 后端 methodOf 把它归一成 relay，适配器解析不到。
 * 用「有 baseUrl 且无 loginModes」描述这类方式，语义自洽且能自动覆盖新套餐。
 */
export function isApiKeyMethod(providerKey, methodKey) {
  const m = getMethod(providerKey, methodKey);
  if (!m) return String(methodKey || "") === "api";
  if (String(methodKey) === "api") return true;
  return Boolean(m.baseUrl) && !(m.loginModes || []).length;
}

export function adapterFor(providerKey, methodKey) {
  const m = getMethod(providerKey, methodKey);
  if (m?.adapter) return m.adapter;
  if (isApiKeyMethod(providerKey, methodKey)) return "openai-compat";
  return providerKey;
}

/** 该接入方式是否需要我们能驱动浏览器 */
export function needsBrowser(providerKey, methodKey) {
  return Boolean(getMethod(providerKey, methodKey)?.needsBrowser);
}

/** 对外下发用（前端「添加渠道」按此渲染，不含函数） */
/**
 * 本机浏览器登录指引 —— 每个网页反代渠道的凭据，在**用户自己的浏览器**里从哪取。
 *
 * 为什么要有这份数据（用户反馈）：
 *   「所有快捷登录你都是做的内置浏览器？这不是给服务器徒增压力吗，而且压根没必要啊，
 *    就直接唤起用户本机浏览器窗口就行啊，登录完抓回调参数回填不就行了吗？」
 *
 * 这个判断是对的，而且成本差异很大：服务器浏览器要为每次登录起一个真实 Chromium
 * （带 xvfb 显示、过风控、读 localStorage），而绝大多数情况下**用户自己的浏览器
 * 早就登录好了**，只要告诉他去哪儿复制那串凭据即可 —— 零服务器开销、还更快。
 *
 * 但有一个诚实的例外必须保留服务器浏览器：**HttpOnly cookie 用 JS 读不到**。
 * 这类渠道（豆包/通义/StepFun 等纯 cookie 登录态）用户仍能手工从开发者工具复制，
 * 只是步骤多一些；服务器浏览器可以自动读，所以它作为**备选**保留，
 * 而不是像以前那样当唯一路径。
 *
 * 字段：
 *   · steps   给人看的分步说明（本机浏览器登录后要先做什么）
 *   · snippet 可选的一行控制台代码（能直接 copy 出凭据的渠道）
 *   · console 提示是否需要在控制台执行（前端据此显示「复制取凭据代码」按钮）
 */
const LOCAL_LOGIN_GUIDE = {
  "deepseek:relay": {
    steps: [
      "在打开的页面完成登录（可用手机 App 扫码）",
      "登录后按 F12 打开开发者工具，切到 Console",
      "粘贴下面这行代码并回车，凭据会自动进剪贴板",
    ],
    // 值本身是 JSON，真实 token 在 .value 里（只 copy(整个对象) 会被适配器判为非法）
    snippet: "copy(JSON.parse(localStorage.getItem('userToken')).value)",
  },
  "glm:relay": {
    steps: [
      "在打开的页面完成登录（验证码由页面自己处理）",
      "登录后按 F12 → Console",
      "粘贴下面这行代码并回车，凭据会自动进剪贴板",
    ],
    snippet: "copy(localStorage.getItem('token'))",
  },
  "kimi:relay": {
    steps: [
      "在打开的页面完成登录（手机号验证码 / 扫码）",
      "登录后按 F12 → Application → Cookies → https://www.kimi.com",
      "找到名为 kimi-auth 的那一行，双击 Value 全选复制（一串以 eyJ 开头的 JWT）",
    ],
    // kimi-auth 可能是 HttpOnly，document.cookie 取不到；先给一行尝试，
    // 取不到时下面的手工步骤是可靠路径（不把「可能失败」写成「一定能用」）
    snippet: "copy((document.cookie.match(/(?:^|;\\s*)kimi-auth=([^;]+)/)||[])[1]||'取不到（HttpOnly）：请按上面手工步骤复制')",
  },
  "doubao:relay": {
    steps: [
      "在打开的页面用手机 App 扫码登录",
      "登录后按 F12 → Network，刷新一下页面，点任意一个请求",
      "在 Request Headers 里找到 cookie: 那一行，把整行的值复制过来",
    ],
  },
  "qwen:relay": {
    steps: [
      "在打开的页面完成登录（阿里风控较重，可能需要拖动验证）",
      "登录后按 F12 → Network，刷新页面，点任意一个请求",
      "在 Request Headers 里找到 cookie: 那一行，把整行的值复制过来",
    ],
  },
  "minimax:minimax-web": {
    steps: [
      "在打开的页面完成登录",
      "登录后按 F12 → Console",
      "粘贴下面这行代码并回车；若提示取不到，改从 Application → Cookies 里复制 token 的值",
    ],
    snippet: "copy(localStorage.getItem('token') || (document.cookie.match(/(?:^|;\\s*)token=([^;]+)/)||[])[1] || '取不到：请从 Application → Cookies 复制 token 的值')",
  },
  "mimo:mimo-web": {
    steps: [
      "在打开的页面完成登录（小米账号）",
      "登录后按 F12 → Network，刷新页面，点任意一个请求",
      "在 Request Headers 里找到 cookie: 那一行，整行值复制过来（适配器会自动取出 serviceToken / userId / xiaomichatbot_ph 三个值）",
    ],
  },
  "stepfun:stepfun-web": {
    steps: [
      "在打开的页面完成登录（手机号验证码）",
      "登录后按 F12 → Network，刷新页面，点任意一个请求",
      "在 Request Headers 里找到 cookie: 那一行，把整行的值复制过来",
    ],
  },
  "openai:openai-web": {
    steps: [
      "在打开的页面完成登录（含邮箱验证码）",
      "登录后按 F12 → Console",
      "粘贴下面这行代码并回车：它请求 ChatGPT 自己的 session 接口，把 accessToken 复制进剪贴板",
    ],
    // 走官方 session 接口而不是读 cookie：access_token 不在 cookie 里（实测），
    // 而且带着会话请求更稳（与服务器端抓取用的是同一个端点 /api/auth/session）。
    snippet:
      "(async()=>{try{const j=await (await fetch('/api/auth/session',{credentials:'include'})).json();const t=j&&j.accessToken;if(t){copy(t);console.log('已复制 access_token')}else{console.log('没取到 access_token，确认已登录后再试')}}catch(e){console.log('请求失败：'+e.message)}})()",
  },

  // ---- 订阅 / 反代类：凭据都在**本机客户端**里，不在浏览器里 ----
  // 用户反馈：「手动填凭证也没引导用户要拿哪个字段啊？」——
  // 这几家原先只有一行 pasteHint（一句话说明），没有分步指引，
  // 管理员看到「凭据 JSON」这个框不知道该往里放什么文件。
  "openai:codex": {
    steps: [
      "本机装好 Codex CLI 并登录（命令行执行 codex login，浏览器会弹出授权页，按提示完成）",
      "登录后打开凭据文件：Windows 在资源管理器地址栏输入 %USERPROFILE%\\.codex 回车，找到 auth.json（macOS / Linux 就是 ~/.codex/auth.json）",
      "用记事本打开 auth.json，把**全部内容**原样粘到下面的「凭据 JSON」框（含 tokens 与 account_id）",
      "找不到该文件：说明 CLI 还没登录成功，回到第 1 步重跑 codex login",
    ],
    note: "还没装 CLI：直接点上面的登录小窗也行 —— 授权后地址栏会停在一个打不开的 localhost 地址，把整串 URL 粘到下方输入框即可",
  },
  "anthropic:claude-oauth": {
    steps: [
      "本机装好 Claude Code 并登录（命令行执行 claude，按提示完成 OAuth 授权）",
      "登录后打开凭据文件：Windows 在资源管理器地址栏输入 %USERPROFILE%\\.claude 回车，找到 .credentials.json（macOS 也可用「钥匙串访问」搜 Claude Code-credentials）",
      "用记事本打开该文件，把**全部内容**原样粘到下面的「凭据 JSON」框",
    ],
    note: "或直接点上面的登录小窗：授权后页面会跳到打不开的 localhost 地址（正常现象），把地址栏整串 URL 粘回下方输入框即可",
  },
  "gemini:antigravity": {
    steps: [
      "本机装好 Antigravity 客户端并登录 Google 账号（登录后它会自己写入凭据缓存）",
      "打开凭据目录：Windows 在资源管理器地址栏输入 %USERPROFILE%\\.antigravity 回车（macOS / Linux 就是 ~/.antigravity/）",
      "找到文件名含 oauth / token 字样的那个 json（不同版本路径略有差异），用记事本打开",
      "把**全部内容**粘到下面的「凭据 JSON」框；只想给 refresh_token 也可以，平台会自行换 access_token",
    ],
    note: "或直接点上面的登录小窗：授权后把地址栏整串 URL 粘回下方输入框",
  },
  "kiro:kiro": {
    steps: [
      "本机装好 Kiro 客户端并登录（登录后凭据会缓存到本机）",
      "打开缓存目录：Windows 在资源管理器地址栏输入 %USERPROFILE%\\.aws\\sso\\cache 回车（macOS / Linux：~/.aws/sso/cache/）",
      "按「修改时间」排序，打开最新的那个 json（文件名是一串哈希），用记事本查看内容",
      "把**全部内容**粘到下面的「凭据 JSON」框，至少要有 accessToken 与 refreshToken",
    ],
    note: "更省事的做法：用上面的「一键绑定」—— 点开授权页登录确认后，凭据由服务端直接写入渠道，不用手工复制任何文件",
  },
  "grok:grok-oauth": {
    steps: [
      "推荐用上面的「设备码登录」：点一下会给出一个验证链接与代码，在任意浏览器授权即可，凭据自动回填",
      "若要手工填：本机登录 grok.com 后，从浏览器开发者工具的 Application → Local Storage 里找 sso / sso-rw 两项的值",
      "把两个值拼成 JSON 粘到下面的「凭据 JSON」框：{ \"sso\": \"...\", \"ssoRw\": \"...\" }",
    ],
    note: "设备码登录是官方支持的路径，比手工复制 cookie 稳得多，优先用它",
  },
  // 自定义（Anthropic 兼容）：凭据由管理员从**上游服务商**那里拿，我们无从指引具体路径，
  // 但要明确说清「该填什么」——不然面对一个「凭据 JSON」框完全不知道放什么。
  "custom:anthropic": {
    steps: [
      "这个接入方式对接的是你自己的 Anthropic 兼容服务，凭据从**该服务商**的管理后台获取（不是 Anthropic 官网）",
      "在该服务商后台打开「API Key / 密钥」页面新建一把，复制那串 Key（常见形如 sk-ant-... 或 sk-...）",
      "把 Key 直接粘到下面输入框；若服务商给的是一个 JSON 文件，用记事本打开并把**全部内容**原样粘进来（平台会自动识别字段）",
    ],
    note: "不确定该填哪个字段：先粘进去点一次「测试」—— 报错会说明上游拒绝的具体原因",
  },
  "cline:cli": {
    steps: [
      "点下面的「一键绑定」最省事：会打开 Cline 官方授权页，登录后凭据自动写回渠道",
      "若要手工填：登录 app.cline.bot 后按 F12 → Application → Cookies",
      "找到名为 cline_session（或 workos_session）的那一行，复制它的值粘到下面输入框",
    ],
    note: "用邮箱密码换来的 token 有有效期，平台会自动续期；续期失败时会在这里提示重新绑定",
  },
};
/**
 * 取某接入方式的本机登录指引（没有登记则返回 null，前端退回纯说明文案）。
 * **必须带 provider**：多个厂商的网页反代方法键都叫 relay，
 * 只按 method 查会互相撞车（早先一版就是这么写的，结果一条都取不到）。
 */
export function localLoginGuide(providerKey, methodKey) {
  const k = [String(providerKey || ""), String(methodKey || "")].join(":");
  return LOCAL_LOGIN_GUIDE[k] || null;
}

export function publicProviders() {
  // 「自定义（通用兼容）」强制排最后：它是兜底选项，不是厂商。
  // 混在厂商中间会让人以为它也是一家，而且新厂商接入时容易被挤到下面找不着。
  // 在**后端**排序而不是前端：前端有多处渲染厂商列表（弹窗、筛选下拉），
  // 只改一处必然会漏（历史上就漏过）。
  const ordered = [...PROVIDERS].sort((a, b) => {
    if (a.key === "custom") return 1;
    if (b.key === "custom") return -1;
    return 0;
  });
  return ordered.map((p) => ({
    key: p.key,
    name: p.name,
    vendor: p.vendor,
    // 图标标识：**优先用厂商 key，而不是 vendor**。
    // 两者语义不同：vendor 表示「模型归哪家」（Kiro 跑的 Claude 归 anthropic），
    // 而 key 表示「这个厂商在产品里叫什么」（kiro）。厂商列表的图标要的是后者 ——
    // 用 vendor 会让 Kiro 显示成 Claude 图标（用户看不出这是 Kiro）。
    icon: p.icon || p.key,
    // 获取 API Key 的官方页面：前端在「API Key」标题旁渲染成可点击小字，
    // 省得用户自己去搜「XX 的 key 在哪」。
    keyUrl: p.keyUrl || "",
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
      // 需要 2FA：前端在账号密码之外多渲染一个密钥输入框（见 needs2fa 的说明）
      needs2fa: Boolean(m.needs2fa),
      // 是否 API Key 型接入方式：前端据此渲染「API Key」那一档表单。
      // 不能让它去判 key === "api"（那会让第二个 API Key 型方式整档消失）。
      apiKey: isApiKeyMethod(p.key, m.key),
      pasteHint: m.pasteHint || "",
      browserHint: m.browserHint || "",
      // 远程登录抓取能力：有 entryUrl 就说明支持「打开登录页自动抓取」
      captureHint: m.captureHint || "",
      canCapture: Boolean(m.entryUrl),
      // **登录页地址必须原样下发** —— 前端「弹出登录小窗」按钮就是拿它开窗口的。
      //
      // 这里踩过一个真实的坑：早先只下发了 `canCapture: Boolean(m.entryUrl)` 这个
      // **布尔**，而前端按钮读的是 `pickMethod.entryUrl` —— 那个字段根本不存在，
      // 于是按钮**永远不渲染**。用户实测反馈：「点击跳转对应登录地址的按钮呢？
      // 你不是说做了吗？」—— 后端注释里写着「支持抓取」，前端却一个按钮都看不到。
      // 教训：能力布尔值不能替代数据本身；前端要用什么就原样给什么。
      entryUrl: m.entryUrl || "",
      // 本机浏览器登录指引（凭据在用户浏览器里的位置 + 可选的取码一行）
      localLogin: localLoginGuide(p.key, m.key),
      needsBrowser: Boolean(m.needsBrowser),
      baseUrl: m.baseUrl || "",
      keyHint: m.keyHint || "",
      defaultModels: m.defaultModels || [],
      testModel: m.testModel || "",
    })),
  }));
}
