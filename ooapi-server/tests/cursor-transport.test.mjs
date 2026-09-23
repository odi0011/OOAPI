// Cursor Connect/HTTP2 传输层的行为锁
// ===========================================================================
// 为什么这层需要单独的测试：它不是普通的 fetch 适配器，而是**自己实现了协议**——
//   · HTTP/2（Node 的 fetch 走 h1.1 会被上游 415 拒，实测确认）
//   · Connect 帧（5 字节头 + JSON；不帧装上游会回
//     "protocol error: missing input message for server-streaming method"）
//   · 错误在帧里而不在状态码里（未认证也是 HTTP 200 + flag=2 的 error 帧）
// 任何一处写错，现象都是"200 但没内容"或"连不上"，极难反推。所以逐条锁住：
// 帧编解码、半帧拼接、错误识别、以及 SSRF 白名单。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} → ${e.message}`);
  }
};
const ck = (c, m) => {
  if (!c) throw new Error(m || "断言失败");
};

const { encodeFrame, decodeFrames, detectFrameError, assertCursorHost } = await import(
  "../src/services/upstream/cursor-transport.js"
);

console.log("=== ① Connect 帧编解码 ===");
t("编码 = 1 字节 flag + 4 字节大端长度 + JSON", () => {
  const obj = { model: "composer-2.5", prompt: "hi" };
  const f = encodeFrame(obj);
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  ck(f.length === payload.length + 5, `帧长应为 payload+5，实际 ${f.length}`);
  ck(f[0] === 0, "flag 应为 0（数据帧）");
  ck(f.readUInt32BE(1) === payload.length, "长度字段应为大端 payload 长度");
  ck(f.subarray(5).toString("utf8") === JSON.stringify(obj), "payload 不是原 JSON");
});
t("往返一致", () => {
  const obj = { a: 1, b: ["x", "y"], c: { d: true } };
  const { frames, rest } = decodeFrames(encodeFrame(obj));
  ck(frames.length === 1, `应解出 1 帧，实际 ${frames.length}`);
  ck(JSON.stringify(frames[0].json) === JSON.stringify(obj), "往返后对象不一致");
  ck(rest.length === 0, "不应有剩余字节");
});
t("多帧连续解码", () => {
  const buf = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]);
  const { frames } = decodeFrames(buf);
  ck(frames.length === 3, `应解出 3 帧，实际 ${frames.length}`);
  ck(frames.map((f) => f.json.n).join(",") === "1,2,3", "顺序不对");
});
t("半帧不误判（流式分包的关键）", () => {
  const buf = encodeFrame({ text: "很长的内容".repeat(20) });
  // 只给前 9 字节：连长度字段都没读完
  const a = decodeFrames(buf.subarray(0, 9));
  ck(a.frames.length === 0, "半帧不该解出内容");
  ck(a.rest.length === 9, "半帧应留在 rest 里等下一段");
  // 再补一半
  const b = decodeFrames(Buffer.concat([a.rest, buf.subarray(9, 20)]));
  ck(b.frames.length === 0, "仍不完整时不该出帧");
  // 补齐
  const c = decodeFrames(Buffer.concat([b.rest, buf.subarray(20)]));
  ck(c.frames.length === 1, `补齐后应解出 1 帧，实际 ${c.frames.length}`);
});
t("非 JSON 帧不抛错（只把 json 置空）", () => {
  const bad = Buffer.alloc(5 + 3);
  bad[0] = 0;
  bad.writeUInt32BE(3, 1);
  bad.write("xyz", 5, "utf8");
  const { frames } = decodeFrames(bad);
  ck(frames.length === 1 && frames[0].json === null, "坏帧应保留 raw 但 json 为 null");
});
t("声明长度过大时停下（不分配巨量内存）", () => {
  const evil = Buffer.alloc(5);
  evil[0] = 0;
  evil.writeUInt32BE(400 * 1024 * 1024, 1); // 400MB 声明
  const { frames, rest } = decodeFrames(evil);
  ck(frames.length === 0, "离谱长度的帧应被跳过");
  ck(rest.length === 5, "整段应作为 rest 留着");
});

console.log("\n=== ② 错误帧识别（上游 200 也可能是错误）===");
t("unauthenticated → CHANNEL_AUTH_EXPIRED（附上游 debug 码）", () => {
  const r = detectFrameError({
    error: { code: "unauthenticated", details: [{ debug: { error: "ERROR_NOT_LOGGED_IN", details: { detail: "try logging in" } } }] },
  });
  ck(r, "没识别出错误");
  ck(r.code === "CHANNEL_AUTH_EXPIRED", `错误码应为 AUTH_EXPIRED，实际 ${r.code}`);
  ck(/ERROR_NOT_LOGGED_IN/.test(r.message), "消息里应带上游 debug 码，便于排查");
});
t("permission_denied → CHANNEL_FORBIDDEN", () => {
  const r = detectFrameError({ error: { code: "permission_denied", message: "no" } });
  ck(r && r.code === "CHANNEL_FORBIDDEN", `实际 ${r?.code}`);
});
t("resource_exhausted / 限流措辞 → CHANNEL_RATE_LIMITED", () => {
  ck(detectFrameError({ error: { code: "resource_exhausted" } })?.code === "CHANNEL_RATE_LIMITED", "code 分支没命中");
  ck(detectFrameError({ error: { code: "x", message: "quota exceeded" } })?.code === "CHANNEL_RATE_LIMITED", "文案分支没命中");
});
t("正常内容不误判", () => {
  ck(detectFrameError({ text: "hello" }) === null, "正常帧被当成错误");
  ck(detectFrameError(null) === null, "null 被当成错误");
});

console.log("\n=== ③ SSRF 白名单（这层绕过了项目共用的 guardedFetch）===");
t("允许 Cursor 官方域", () => {
  for (const u of ["https://api2.cursor.sh/aiserver.v1.AiService/StreamChat", "https://us.api2.cursor.sh/x", "https://api.cursor.com/v1/me"]) {
    assertCursorHost(u); // 不抛即通过
  }
});
t("拒绝第三方主机（凭据不能外发）", () => {
  let threw = false;
  try {
    assertCursorHost("https://evil.example/steal");
  } catch {
    threw = true;
  }
  ck(threw, "第三方主机没被拒绝");
});
t("拒绝 http（只允许 https）", () => {
  let threw = false;
  try {
    assertCursorHost("http://api2.cursor.sh/x");
  } catch {
    threw = true;
  }
  ck(threw, "http 没被拒绝");
});
t("非法 URL 报可归因的错误", () => {
  try {
    assertCursorHost("not-a-url");
    ck(false, "非法 URL 没报错");
  } catch (e) {
    ck(e.code === "CHANNEL_NOT_READY", `错误码应为 CHANNEL_NOT_READY，实际 ${e.code}`);
  }
});

console.log("\n=== ④ 传输层的关键协议约定（源码级锚点）===");
const src = read("src/services/upstream/cursor-transport.js");
t("用 node:http2 而不是 fetch（fetch 走 h1 会被 415）", () => {
  ck(/import http2 from "node:http2"/.test(src), "没有用 node:http2");
  ck(/http2\.connect\(/.test(src), "没有建立 h2 连接");
  ck(!/\bfetch\(/.test(src), "传输层里出现了 fetch（会走 h1.1 被拒）");
});
t("发送 Connect 必需的两个头", () => {
  ck(/"content-type": "application\/connect\+json"/.test(src), "缺 content-type: application/connect+json");
  ck(/"connect-protocol-version": "1"/.test(src), "缺 connect-protocol-version");
});
t("有超时与取消（否则半开连接会占死串行槽）", () => {
  ck(/timeoutMs/.test(src) && /setTimeout\(/.test(src), "没有超时");
  ck(/CHANNEL_TIMEOUT/.test(src), "超时没有用可归因的错误码");
  ck(/signal\.addEventListener\("abort"/.test(src), "没有处理取消");
});
t("连接与请求都挂了 error 处理（h2 的错误在事件里）", () => {
  ck(/client\.on\("error"/.test(src), "连接级 error 没处理");
  ck(/req\.on\("error"/.test(src), "请求级 error 没处理");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
