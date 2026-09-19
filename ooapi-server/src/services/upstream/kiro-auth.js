// Kiro 凭据解析（无外部依赖，便于单测）
export const DEFAULT_REGION = "us-east-1";

// AWS region 白名单：只允许「小写字母/数字/连字符」。
// region 会被直接拼进上游主机名（codewhisperer.{region}.amazonaws.com、
// prod.{region}.auth.desktop.kiro.dev），而它来自外部凭据文件 —— 不校验的话
// region = "@127.0.0.1:8080/" 会把带 Bearer 令牌的请求打到内网（SSRF + 令牌外泄）。
// 覆盖 us-gov-west-1 / cn-north-1 等全部现行 region 形态。
const REGION_RE = /^[a-z0-9-]{2,32}$/;

/**
 * 校验并归一化 region。
 * 注意：**读取路径也要过这一层** —— 仅在建渠道时校验，挡不住本次加固之前
 * 已经导进库里的脏值（那些渠道每次请求都会拿 other.region 拼主机名）。
 * @returns {string} 合法 region；非法/为空时回落 DEFAULT_REGION
 */
export function safeRegion(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return REGION_RE.test(s) ? s : DEFAULT_REGION;
}

// 平台模型 → Kiro modelId（Kiro 接受带点/带版本号的名称，网关会归一化）
const MODEL_MAP = {
  "claude-opus-5": "claude-opus-4.5",
  "claude-sonnet-5": "claude-sonnet-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
};

export function kiroModelId(model) {
  const m = String(model || "").trim();
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  // 已带版本号（claude-sonnet-4-5 / claude-sonnet-4.5）原样透传
  return m || "claude-sonnet-4.5";
}

function normalize(t) {
  const str = (v) => String(v || "").trim();
  const access_token = str(t.accessToken || t.access_token);
  const refresh_token = str(t.refreshToken || t.refresh_token);
  // 非法值落到默认 region（见 safeRegion 注释）
  const region = safeRegion(str(t.region || t.regionId || t.region_id));
  const profile_arn = str(t.profileArn || t.profile_arn);
  const client_id = str(t.clientId || t.client_id);
  const client_secret = str(t.clientSecret || t.client_secret);
  if (!refresh_token && !access_token) {
    throw Object.assign(new Error("缺少 accessToken/refreshToken（请粘贴 Kiro 的 kiro-auth-token.json）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  return { access_token, refresh_token, region, profile_arn, client_id, client_secret };
}

/** 归一化各种导出形态：kiro-auth-token.json / SSO 缓存 / 嵌套 auth 包装 / 裸 refresh token */
export function parseAuthJson(raw) {
  let j = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    try {
      j = JSON.parse(text);
    } catch {
      // 裸 refresh token（不含 JSON）：只有它也能靠刷新换到 access token
      if (text.length >= 20) return normalize({ refresh_token: text });
      throw Object.assign(new Error("凭据不是合法 JSON，也不是有效的 refresh token"), { code: "LOGIN_BAD_PARAMS" });
    }
  }
  const t = j?.auth || j?.credentials || j?.token || j;
  return normalize(t);
}
