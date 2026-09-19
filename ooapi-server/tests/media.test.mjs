// 媒体库核心逻辑测试（不连库的部分：类型嗅探、尺寸解析、签名）
// ---------------------------------------------------------------------------
// 为什么这些必须测：
//   · 类型嗅探是安全边界 —— 它决定「什么能被用户上传并在本站源下渲染」。
//     嗅探写错（比如把 SVG/HTML 当图片放行）会造成存储型 XSS。
//   · 尺寸解析错了不会报错，只是列表里宽高显示错误，很难被发现。
//   · 签名是「<img> 带不了 Authorization」的替代方案，签错等于任何人可看任何文件。
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { sniff, imageSize, blobPath, signMedia, verifyMediaSign } = await import("../src/services/media.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

/** 造一个最小 PNG（IHDR 里写死宽高，够 imageSize 解析） */
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR 长度
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function fakeJpeg(w, h) {
  // FFD8 + APP0(段) + SOF0(含宽高) + 结束
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2); // 段长
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2); // 段长（不含 marker）
  sof[4] = 8; // 精度
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function fakeGif(w, h) {
  const b = Buffer.alloc(20);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function fakePdf() {
  return Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");
}

console.log("类型嗅探（安全边界）");

await t("PNG / JPEG / GIF / PDF 识别正确", () => {
  assert.equal(sniff(fakePng(10, 10)).ext, "png");
  assert.equal(sniff(fakeJpeg(10, 10)).ext, "jpg");
  assert.equal(sniff(fakeGif(10, 10)).ext, "gif");
  assert.equal(sniff(fakePdf()).ext, "pdf");
  assert.equal(sniff(fakePng(1, 1)).kind, "image");
  assert.equal(sniff(fakePdf()).kind, "file");
});

await t("纯文本被识别为 txt", () => {
  const r = sniff(Buffer.from("hello world\n这是一段中文说明\n", "utf8"));
  assert.equal(r.ext, "txt");
  assert.equal(r.kind, "file");
});

await t("SVG 必须被拒绝（可内嵌脚本，是存储型 XSS 入口）", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  const r = sniff(svg);
  // SVG 是文本 → 会命中 txt（kind=file，下载时强制 attachment，不会 inline 渲染）
  assert.ok(r === null || r.kind === "file", `SVG 不能以 image 类型入库，实际 ${JSON.stringify(r)}`);
  assert.notEqual(r?.mime, "image/svg+xml", "不能把 SVG 标记为图片 MIME");
});

await t("HTML 不会被当成图片", () => {
  const html = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>", "utf8");
  const r = sniff(html);
  assert.ok(r === null || r.kind === "file");
  assert.notEqual(r?.kind, "image");
});

await t("含 NUL 的二进制不被当文本", () => {
  const bin = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from("text")]);
  assert.equal(sniff(bin), null, "未知二进制应被拒绝，而不是猜一个类型");
});

await t("空内容不识别出类型", () => {
  assert.equal(sniff(Buffer.alloc(0)), null);
});

console.log("\n图片尺寸解析");

await t("PNG 宽高", () => {
  assert.deepEqual(imageSize(fakePng(1920, 1080), "png"), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(fakePng(1, 1), "png"), { width: 1, height: 1 });
});

await t("JPEG 宽高", () => {
  assert.deepEqual(imageSize(fakeJpeg(800, 600), "jpg"), { width: 800, height: 600 });
});

await t("GIF 宽高", () => {
  assert.deepEqual(imageSize(fakeGif(320, 240), "gif"), { width: 320, height: 240 });
});

await t("畸形文件返回 0 而不是抛错", () => {
  assert.deepEqual(imageSize(Buffer.alloc(4), "png"), { width: 0, height: 0 });
  assert.deepEqual(imageSize(Buffer.from([0xff, 0xd8]), "jpg"), { width: 0, height: 0 });
  assert.deepEqual(imageSize(Buffer.from("垃圾数据"), "jpg"), { width: 0, height: 0 });
});

console.log("\n磁盘路径分片");

await t("blob 路径按前 2/次 2 位分片，且带规范扩展名", () => {
  const sha = "7f3a9c8b1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a";
  const p = blobPath(sha, "png");
  assert.ok(p.includes(`7f${require("node:path").sep}3a`) || p.includes("7f/3a") || p.includes("7f\\3a"), `实际 ${p}`);
  assert.ok(p.endsWith(`${sha}.png`));
});

console.log("\n读取签名（等价于访问凭据）");

await t("签名可验证通过", async () => {
  const s = await signMedia(123);
  assert.equal(await verifyMediaSign(123, s), true);
});

await t("改 id 或改签名都验不过（防枚举与篡改）", async () => {
  const s = await signMedia(123);
  assert.equal(await verifyMediaSign(124, s), false, "换 id 必须失败");
  assert.equal(await verifyMediaSign(123, `${s}x`), false, "篡改签名必须失败");
  assert.equal(await verifyMediaSign(123, "garbage"), false);
  assert.equal(await verifyMediaSign(123, ""), false);
  assert.equal(await verifyMediaSign(123, null), false);
});

await t("伪造的过期时间无法通过（签名覆盖了 exp）", async () => {
  const s = await signMedia(123, -10); // 已过期
  assert.equal(await verifyMediaSign(123, s), false, "过期签名必须失败");
  // 手工把 exp 改到未来但保留旧签名 → 也必须失败
  const [exp, sig] = String(s).split(".");
  const forged = `${Number(exp) + 99999}.${sig}`;
  assert.equal(await verifyMediaSign(123, forged), false, "篡改过期时间必须失败");
});

await t("不同 id 的签名不通用", async () => {
  const a = await signMedia(1);
  const b = await signMedia(2);
  assert.notEqual(a, b);
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
