import dayjs from "dayjs";
import { CURRENCY_NAME, CURRENCY_CODE } from "../components/OdCoin";

// ---------------------------------------------------------------------------
// 额度与货币展示 —— 全站唯一入口
//
// 平台货币是 OD 币，1 OD = 1 美元（1:1），1 OD = 10000 额度单位。
// 以前每个页面各写各的换算，结果符号五花八门（有的 `$`、有的没单位），
// 同一个余额在不同页面看着像两种东西。所以统一收敛到这里：
// 页面只调用 fmtOd / odOf，不再自己拼符号。
//
// 币名来自 components/OdCoin.jsx —— 那是全站唯一定义处，改名只改那一处。
// ---------------------------------------------------------------------------

export const CURRENCY = CURRENCY_NAME; // 「OD币」
export { CURRENCY_NAME, CURRENCY_CODE };

export const DEFAULT_UNITS_PER_OD = 10000;

/** 管理员留空或填写相对路径时补全站点地址；无效配置不能让公开首页白屏。 */
export function apiEndpoint(raw, origin = window.location.origin) {
  try {
    const url = new URL(String(raw || "/v1").trim(), origin);
    // 旧部署可能仍保存着 IP + HTTP。HTTPS 域名页面不能把用户引回
    // 不安全的公网地址，公开接入示例应始终跟随当前站点来源。
    if (String(origin).startsWith("https:") && url.protocol !== "https:") {
      return String(origin).replace(/\/+$/, "") + "/v1";
    }
    if (["http:", "https:"].includes(url.protocol)) return url.href.replace(/\/+$/, "");
  } catch { /* 无效的站点配置使用当前站点的标准网关路径 */ }
  return origin + "/v1";
}

/** 从 /api/status 读取「多少额度单位 = 1 OD」，读不到就用默认值 */
export function unitsPerOd(status) {
  const n = Number(status?.units_per_od ?? status?.quota_per_unit);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UNITS_PER_OD;
}

/** 额度单位 → OD 数值（不带单位） */
export function odOf(quota, perUnit = DEFAULT_UNITS_PER_OD) {
  return (Number(quota) || 0) / (Number(perUnit) || DEFAULT_UNITS_PER_OD);
}

/**
 * 额度单位 → 展示字符串，例如 9999900 → "999.99 OD币"
 * @param {number} quota 额度单位
 * @param {number} perUnit 多少单位 = 1 OD
 * @param {number} digits 小数位（余额用 2，明细用 4）
 * @param {boolean} withUnit 是否带币名（输入框、纯数字列可关掉）
 */
export function fmtOd(quota, perUnit = DEFAULT_UNITS_PER_OD, digits = 2, withUnit = true) {
  const s = odOf(quota, perUnit).toFixed(digits);
  return withUnit ? `${s} ${CURRENCY_NAME}` : s;
}

export function fmtDate(ts, fmt = "YYYY-MM-DD HH:mm:ss") {
  const n = Number(ts);
  if (!n || n <= 0) return "-";
  return dayjs(n * 1000).format(fmt);
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  // execCommand 失败（非安全上下文/旧浏览器）时必须 reject，
  // 否则页面会误报「已复制」，用户拿到的是空剪贴板
  const okFlag = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!okFlag) return Promise.reject(new Error("复制失败，请手动复制"));
  return Promise.resolve();
}
