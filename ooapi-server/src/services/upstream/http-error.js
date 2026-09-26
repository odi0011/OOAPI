// 上游 HTTP 错误的统一分类 —— 网页反代适配器共用
// ===========================================================================
// 为什么需要单独一个模块：这段逻辑此前在每个适配器里各写一遍，而写出来的都是
// 「401/403 → CHANNEL_AUTH_EXPIRED，其余 → CHANNEL_HTTP_ERROR」。这有两个问题
// （第 46 批复审点名）：
//
//  ① **429 被归成普通 HTTP 错误**。限流是可自愈的（等一会儿就好），
//     而分类错误的后果是 `execute.js` 用错冷却档位：要么立刻重试把风控打得更凶，
//     要么当成坏渠道直接禁用 —— 前者触发更严的限流，后者要管理员手工恢复。
//  ② **403 一律当成凭据过期**。403 有三种完全不同的成因：
//        · WAF/风控拦截（Cloudflare、阿里的滑块页）→ 该换 IP/降频，不是换凭据；
//        · 真正的 token 失效 → 要管理员重抓凭据；
//        · 权限不足（免费号用付费模型）→ 换模型即可，重抓凭据没用。
//     一律按「凭据失效」处理，会把可自愈的风控写成「请重新登录」，
//     管理员反复重抓也修不好（实测踩过这种误判）。
//
// 分类结果只做「给 execute.js 挑冷却档位 + 给管理员可读提示」两件事，
// 调用方仍然要自己 throw（各适配器的错误文案带自己的厂商名）。
export const UPSTREAM_ERROR = {
  AUTH_EXPIRED: "CHANNEL_AUTH_EXPIRED", // 凭据真的失效 → 需人工重抓
  RATE_LIMITED: "CHANNEL_RATE_LIMITED", // 限流/风控 → 可自愈，冷却后重试
  FORBIDDEN: "CHANNEL_FORBIDDEN", // 权限不足（模型档位/账号权限）→ 换模型或换号
  HTTP_ERROR: "CHANNEL_HTTP_ERROR", // 其余
  NOT_APPROVED: "CHANNEL_NOT_APPROVED", // 账号被上游标记为未批准渠道（2026-09-26 新增，见下）
};

/**
 * 「账号被上游标记为未批准的调用渠道」的响应特征。
 *
 * 实测（2026-09-26，WorkBuddy/CodeBuddy）：腾讯对个人账号转 API 的风控分两档 ——
 *   11128（400）Illegal API invocation from an unapproved channel
 *   11140（403）request illegal +「内容未通过安全审核」displayMsg
 * 关键事实：**凭据是有效的**（同一时段老账号的真实流量成功，新绑定账号首调被拦），
 * 归成「凭据失效」会把管理员引进重新绑定的死胡同（实测连绑 4 次全部无效）。
 * 正确姿势：可换渠道重试（别的账号可能没事）+ 长冷却（execute.cooldownFor 6h），
 * 且不进 AUTO_PAUSE_CODES（自动恢复 T1 上线前，停了就回不来）。
 */
const NOT_APPROVED_HINTS = [
  "11128",
  "11140",
  "unapproved channel",
  "illegal api invocation",
  "request illegal",
];

/** 该上游响应是否为「账号未批准/风控标记」类（与具体 HTTP 状态码无关：400/403 都出现过） */
export function isNotApprovedResponse(body = "") {
  const text = String(body || "").toLowerCase();
  return NOT_APPROVED_HINTS.some((h) => text.includes(h));
}

/** 响应体里出现这些字样，说明是风控/验证页而不是 API 响应 */
const WAF_HINTS = [
  "cloudflare",
  "cf-chl",
  "captcha",
  "verify you are human",
  "请完成验证",
  "安全验证",
  "滑块",
  "访问过于频繁",
  "robot",
  "risk control",
  "风控",
];

/** 权限/档位不足的字样 */
const PERMISSION_HINTS = ["permission", "forbidden", "insufficient", "not allowed", "无权限", "未开通", "权限"];

/**
 * 给一个上游响应分类。
 * @param {number} status HTTP 状态码
 * @param {string} body 响应体（已截断也可，只做关键字匹配）
 * @returns {{code: string, hint: string}} code 用 UPSTREAM_ERROR 的取值
 */
export function classifyUpstreamHttp(status, body = "") {
  const text = String(body || "").toLowerCase();
  const waf = WAF_HINTS.some((h) => text.includes(h));

  // 「账号未批准/风控标记」优先于一切状态码判断：400 和 403 都出现过（11128/11140），
  // 放在 403 分支之后会被「凭据失效」吞掉 —— 那正是实测踩过的误归类。
  if (isNotApprovedResponse(body)) {
    return {
      code: UPSTREAM_ERROR.NOT_APPROVED,
      hint: "上游把该账号标记为未批准的调用渠道（风控拦截）：非凭据问题，重新绑定无效；建议稍后重试或更换账号",
    };
  }

  if (status === 429) {
    return {
      code: UPSTREAM_ERROR.RATE_LIMITED,
      hint: "上游限流（429），稍后会自动重试；频繁出现请调低该渠道的每分钟上限",
    };
  }
  if (status === 403) {
    if (waf) {
      return {
        code: UPSTREAM_ERROR.RATE_LIMITED,
        // 风控页也走「可自愈」档：等一会儿往往就恢复，不必惊动管理员重登
        hint: "上游风控拦截（403，返回的是验证页而不是接口数据），已按可自愈处理；反复出现请降低调用频率",
      };
    }
    if (PERMISSION_HINTS.some((h) => text.includes(h))) {
      return {
        code: UPSTREAM_ERROR.FORBIDDEN,
        hint: "该账号无权使用所请求的模型（403 权限不足），请改用账号可用的模型档位",
      };
    }
    return {
      code: UPSTREAM_ERROR.AUTH_EXPIRED,
      hint: "登录态已失效（403），请重新抓取凭据",
    };
  }
  if (status === 401) {
    return { code: UPSTREAM_ERROR.AUTH_EXPIRED, hint: "登录态已失效（401），请重新抓取凭据" };
  }
  return { code: UPSTREAM_ERROR.HTTP_ERROR, hint: "" };
}

/**
 * 便捷包装：按分类抛错，错误对象带上 `hint`（前端可直接展示）
 * 与 `status`（便于日志与监控按上游状态聚合）。
 */
export function throwUpstreamHttpError(status, body, prefix = "") {
  const { code, hint } = classifyUpstreamHttp(status, body);
  const preview = String(body || "").replace(/\s+/g, " ").slice(0, 200);
  const detail = hint || `上游返回 HTTP ${status}：${preview}`;
  throw Object.assign(new Error(prefix ? `${prefix}：${detail}` : detail), {
    code,
    status,
    hint,
  });
}
