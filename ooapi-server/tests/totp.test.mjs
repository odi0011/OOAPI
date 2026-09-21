// TOTP 单测 —— 用 RFC 6238 附录 B 的官方测试向量，不是自造期望值。
// 为什么必须用官方向量：TOTP 实现错了（截断偏移、计数器字节序、补零）
// 通常会生成「看起来完全正常的 6 位数字」，只有对着官方向量才能发现。
import { totp, base32Decode, totpRemaining, looksLikeTotpSecret } from "../src/services/totp.js";

let pass = 0;
let fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// RFC 6238 附录 B：seed ASCII "12345678901234567890" → base32 如下
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

console.log("=== RFC 6238 附录 B 官方向量（8 位码）===");
for (const [sec, want] of RFC_VECTORS) {
  const got = totp(RFC_SEED, { at: sec * 1000, digits: 8 });
  ck(`t=${sec}s → ${want}`, got === want, `实际 ${got}`);
}

console.log("\n=== 6 位码（厂商实际用的形态）===");
// 同一时刻取 8 位码的后 6 位，是 RFC 6238 的既定关系
for (const [sec, want8] of RFC_VECTORS.slice(0, 3)) {
  const got6 = totp(RFC_SEED, { at: sec * 1000, digits: 6 });
  ck(`t=${sec}s 6 位 = 8 位末 6 位`, got6 === want8.slice(-6), `实际 ${got6}，期望 ${want8.slice(-6)}`);
}

console.log("\n=== base32 解码容错（各家后台展示格式不一）===");
const raw = base32Decode(RFC_SEED);
ck("解码出 20 字节", raw.length === 20, `实际 ${raw.length}`);
ck("解码内容为数字串", raw.toString("utf8") === "12345678901234567890", raw.toString("utf8"));
ck("小写也能解", base32Decode(RFC_SEED.toLowerCase()).equals(raw));
ck("带空格/连字符也能解", base32Decode("GEZD GNBV-GY3T QOJQ GEZD GNBV GY3T QOJQ").equals(raw));
ck("带 = 填充也能解", base32Decode(`${RFC_SEED}====`).equals(raw));
ck("空密钥返回空 buffer（由 totp 报错）", base32Decode("").length === 0);
ck("非法字符被跳过不抛错", base32Decode("GEZD@GNBV!GY3T").length > 0);

console.log("\n=== 错误处理 ===");
let threw = null;
try { totp(""); } catch (e) { threw = e; }
ck("空密钥抛 TOTP_BAD_SECRET", threw?.code === "TOTP_BAD_SECRET", String(threw?.code));
threw = null;
try { totp("!!!!!!!!"); } catch (e) { threw = e; }
ck("纯非法字符抛 TOTP_BAD_SECRET", threw?.code === "TOTP_BAD_SECRET");

console.log("\n=== 时间窗口与有效期 ===");
ck("步长 30 时剩余秒数在 1..30", (() => {
  const r = totpRemaining({ at: 1000 });
  return r >= 1 && r <= 30;
})(), String(totpRemaining({ at: 1000 })));
ck("整 30s 边界剩余 30", totpRemaining({ at: 30_000 }) === 30, String(totpRemaining({ at: 30_000 })));
ck("同一窗口内码不变", totp(RFC_SEED, { at: 30_000 }) === totp(RFC_SEED, { at: 59_000 }));
ck("跨窗口后码改变", totp(RFC_SEED, { at: 30_000 }) !== totp(RFC_SEED, { at: 60_000 }));

console.log("\n=== 密钥形态识别（前端提示用）===");
ck("32 位 base32 识别为密钥", looksLikeTotpSecret("DLS4FDR7A2KWMOTFOP3F32OR5HMFOOGZ"));
ck("6 位数字码不识别为密钥", !looksLikeTotpSecret("142718"));
ck("过短不识别", !looksLikeTotpSecret("ABCD"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
