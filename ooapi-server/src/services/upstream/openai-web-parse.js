// OpenAI 网页版凭据/模型解析（无外部依赖，便于单测）
// 平台模型 → 网页版模型（网页版对模型名挑剔，拿不准就用 auto，由账号侧决定）
const MODEL_MAP = {
  "gpt-5.6-luna": "auto",
  "gpt-5.6-terra": "auto",
  "gpt-5.6-sol": "auto",
  "gpt-5.5": "auto",
  "gpt-4o": "gpt-4o",
};

export function webModelId(model) {
  const m = String(model || "").trim();
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  if (/^gpt-4o/.test(m)) return m;
  return "auto";
}

/** 解析凭据：单 access_token 字符串 / 会话 JSON / {access_token, refresh_token} */
export function parseAuthJson(raw) {
  let j = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.length >= 40 && !text.startsWith("{")) return { access_token: text, refresh_token: "", email: "" };
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("凭据不是合法 JSON，也不是 access_token"), { code: "LOGIN_BAD_PARAMS" });
    }
  }
  const t = j?.session || j?.credentials || j?.token || j;
  const access_token = String(t.accessToken || t.access_token || "").trim();
  const refresh_token = String(t.refreshToken || t.refresh_token || "").trim();
  const email = String(t.email || j?.user?.email || "").trim();
  if (!access_token && !refresh_token) {
    throw Object.assign(new Error("缺少 access_token（请从 chatgpt.com/api/auth/session 复制）"), {
      code: "LOGIN_BAD_PARAMS",
    });
  }
  return { access_token, refresh_token, email };
}
