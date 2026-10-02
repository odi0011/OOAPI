// Request Headers、扩展导出和 Cookies 面板的输入统一解析。
// Cookie 值保持原样（可能是签名值）；只有提取单个 token 时才按需 URL 解码。
export function parseCookieInput(raw) {
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^cookie\s*:\s*/i, "");
    if (!text) return [];
    if (/^[\[{]/.test(text)) {
      try { return parseCookieInput(JSON.parse(text)); } catch { return []; }
    }
    return text.split(";").map((pair) => {
      const i = pair.indexOf("=");
      if (i < 1) return null;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      return /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value) ? { name, value } : null;
    }).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.value != null)
      .map((c) => ({ ...c, value: String(c.value) }))
      .filter((c) => /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(c.name) && !/[\r\n;]/.test(c.value));
  }
  if (raw && typeof raw === "object") {
    if (raw.cookies != null || raw.cookie != null || raw.cookies_raw != null) {
      return parseCookieInput(raw.cookies ?? raw.cookie ?? raw.cookies_raw);
    }
    return parseCookieInput(Object.entries(raw).filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([name, value]) => ({ name, value })));
  }
  return [];
}

export function cookieHeader(raw) {
  return parseCookieInput(raw).map((c) => c.name + "=" + c.value).join("; ");
}

export function cookieValue(cookies, ...names) {
  for (const name of names) {
    const value = cookies.find((c) => c.name.toLowerCase() === name.toLowerCase())?.value;
    if (!value) continue;
    const text = String(value).replace(/^"|"$/g, "");
    try { return decodeURIComponent(text); } catch { return text; }
  }
  return "";
}

// cookies 是新增表单的辅助字段。主框已有凭据时保留主框并合并 cookies，
// 只填辅助字段时也可解析，不能把对象强转成 [object Object]。
export function credentialText(input) {
  if (typeof input === "string") return input.trim();
  const raw = input?.token ?? input?.json ?? "";
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  const text = String(raw || "").trim();
  if (!input?.cookies) return text;
  const cookies = parseCookieInput(input.cookies);
  if (!cookies.length) {
    throw Object.assign(new Error("补充 Cookies 格式不正确，请粘贴完整 Cookie 串或导出的 JSON 数组"), { code: "CHANNEL_BAD_PARAMS" });
  }
  let obj;
  try { obj = JSON.parse(text); } catch { /* 裸 token / Cookie */ }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) return JSON.stringify({ cookies, ...obj });
  const mainCookies = parseCookieInput(obj ?? text);
  if (mainCookies.length) {
    const names = new Set(mainCookies.map((c) => c.name));
    return JSON.stringify({ cookies: [...mainCookies, ...cookies.filter((c) => !names.has(c.name))] });
  }
  return JSON.stringify({ ...(text ? { token: text } : {}), cookies });
}

// 浏览器驱动型渠道仍由页面计算签名，但手工粘贴的 Cookie 必须实际注入会话。
export async function importBrowserCookieAuth(input = {}) {
  const text = credentialText(input);
  let obj;
  try { obj = JSON.parse(text); } catch {
    if (/^[\[{]/.test(text)) {
      throw Object.assign(new Error("凭据 JSON 格式不正确，请完整复制 Cookie 或凭据内容"), { code: "CHANNEL_BAD_PARAMS" });
    }
  }
  const cookieSource = obj && !Array.isArray(obj) && (obj.token || obj.access_token)
    ? obj.cookies ?? obj.cookie ?? obj.cookies_raw ?? ""
    : obj ?? text;
  const cookies = parseCookieInput(cookieSource);
  const token = obj && !Array.isArray(obj)
    ? String(obj.token || obj.access_token || "").trim()
    : cookies.length ? "" : text;
  return { token, other: { method: "relay", ...(cookies.length ? { cookies } : {}) } };
}
