// Kiro 凭据解析（无外部依赖，便于单测）
export const DEFAULT_REGION = "us-east-1";

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
  const region = str(t.region || t.regionId || t.region_id) || DEFAULT_REGION;
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
