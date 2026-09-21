// TOTP（RFC 6238）—— 两因素认证的动态码生成
// ===========================================================================
// 为什么需要它：接入带 2FA 的厂商（ChatGPT 网页版等）时，管理员手上只有
// 「邮箱 + 密码 + 2FA 密钥」，而**密钥不是验证码** —— 验证码每 30 秒变一次，
// 必须自己按 RFC 6238 算出来。平台此前完全没有这块能力。
//
// 实现为零依赖（node:crypto）：只用到 HmacSHA1 与 base32 解码。
// 自检向量取 RFC 6238 附录 B（seed = "12345678901234567890" 的 base32），
// 单测在同目录 tests/totp.test.mjs，改动本文件必须让它继续通过。
import crypto from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * base32 解码（RFC 4648）。
 * 容错：忽略空格与连字符（用户从各家后台复制时常带这些分隔符）、
 * 大小写不敏感、去掉末尾的 `=` 填充。密钥本身含非 base32 字符时按序跳过，
 * 不抛错 —— 因为各家后台的展示格式差异很大，报错不如尽力解出。
 */
export function base32Decode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * 生成 TOTP 动态码。
 *
 * @param {string} secret        base32 密钥（用户从 2FA 后台复制的那串）
 * @param {object} [opts]
 * @param {number} [opts.step]   时间步长秒，默认 30（绝大多数厂商）
 * @param {number} [opts.digits] 位数，默认 6；部分老系统用 8 位
 * @param {number} [opts.at]     计算基准时间（毫秒），默认当前 —— 显式传入便于单测
 * @param {string} [opts.algorithm] 摘要算法，默认 sha1（RFC 6238 的默认且最通用）
 * @returns {string} 补零后的动态码
 */
export function totp(secret, { step = 30, digits = 6, at = Date.now(), algorithm = "sha1" } = {}) {
  const key = base32Decode(secret);
  if (!key.length) {
    throw Object.assign(new Error("2FA 密钥为空或不是有效的 base32 字符串"), { code: "TOTP_BAD_SECRET" });
  }
  const counter = Math.floor(at / 1000 / step);
  // 8 字节大端计数器（高 32 位先用除法，避免位运算在 >2^31 时溢出）
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);

  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  // 动态截断（RFC 4226 §5.3）：取末字节低 4 位作为偏移
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * 当前动态码还有多少秒过期。
 *
 * 用途：临近过期时（如剩余 <5s）应先等到下一个窗口再提交 ——
 * 否则请求在路上就过期了，上游报「验证码错误」，而管理员会以为密钥填错了。
 */
export function totpRemaining({ step = 30, at = Date.now() } = {}) {
  const elapsed = Math.floor(at / 1000) % step;
  return step - elapsed;
}

/**
 * 取一个「提交时仍然有效」的动态码。
 * 剩余时间不足 minRemaining 秒时，等到下一个时间窗口再生成。
 */
export async function totpFresh(secret, { step = 30, digits = 6, minRemaining = 5 } = {}) {
  const left = totpRemaining({ step });
  if (left < minRemaining) {
    await new Promise((r) => setTimeout(r, (left + 1) * 1000));
  }
  return totp(secret, { step, digits });
}

/** 看起来像不像 base32 密钥（用于前端提示与参数校验，不做强校验） */
export function looksLikeTotpSecret(s) {
  const clean = String(s || "").replace(/[\s-]/g, "").replace(/=+$/, "");
  return clean.length >= 16 && /^[A-Z2-7]+$/i.test(clean);
}
