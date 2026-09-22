// 安全回归：一键绑定的跨厂商写入防护、设备绑定轮询互斥、凭据内地址（endpoint）
// 不得作为出站目标。
//
// 这三条都来自 AI协作.md 第 46 批远端复审的 P0/P1 段。它们的共同点是
// **「看起来只是数据」的字段被当成了目标地址或归属依据**，所以测试也按这个
// 角度写：喂进去一份恶意/错配的输入，断言它不会变成出站目标或落库动作。
//
// 说明：device-bind 的上游调用走全局 fetch，测试里整体替换 globalThis.fetch，
// 不产生真实网络请求。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function ck(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}
const SRC = (p) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

/* ==================== ① 跨厂商写入防护 ==================== */
console.log("\n=== ① 一键绑定凭据不得跨厂商写入 ===");
{
  const src = SRC("routes/channel.js");
  ck("定义了 assertBindVendorFits 校验函数", /function assertBindVendorFits\(channelType, vendor\)/.test(src));
  ck("厂商不匹配时抛可识别错误码 BIND_VENDOR_MISMATCH", /BIND_VENDOR_MISMATCH/.test(src));
  ck("/devices/claim 写库前先校验", /assertBindVendorFits\(ch\.type, rec\.vendor\)[\s\S]{0,200}?applyCredentialToChannel/.test(src));
  ck("/devices/poll 直连渠道路径也校验", /assertBindVendorFits\(ch\.type, vendor\)/.test(src));
  ck(
    "ticket 里记录了归属厂商（而非请求体传的值）",
    /pendingCredentials\.set\(ticket, \{ credential: out\.credential, vendor, at: Date\.now\(\) \}\)/.test(src)
  );
  ck(
    "applyCredentialToChannel 收 vendor 参数并在有值时校验",
    /async function applyCredentialToChannel\(\{ id, type, method, credential, vendor \}\)/.test(src) &&
      /if \(vendor\) assertBindVendorFits\(targetType, vendor\)/.test(src)
  );
  ck(
    "建渠道时（/login）提前校验 ticket 归属，避免先建后删",
    /const bindTicket = String\(rest\.bindTicket \|\| ""\)\.trim\(\);[\s\S]{0,400}?assertBindVendorFits\(type, rec\.vendor\)/.test(
      src
    )
  );
}

/* ==================== ② 设备绑定轮询互斥 ==================== */
console.log("\n=== ② 设备绑定轮询并发互斥（同一 session 不会重复打上游/重复写回）===");
{
  const src = SRC("services/device-bind.js");
  ck("会话对象带 polling 闸门", /if \(s\.polling\)/.test(src));
  ck("闸门在 finally 里释放", /finally \{[\s\S]{0,200}?s\.polling = false/.test(src));
  ck("终态用 sessions.delete 的返回值判定唯一胜者", /const won = sessions\.delete\(key\)/.test(src));
  ck("pollDeviceBind 回传服务端记录的 vendor", /vendor: out\.vendor \|\| s\.vendor/.test(src));

  // 行为验证：替换全局 fetch，观察同一 session 的并发 poll 打了几次上游
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // wbStart 需要 state + authUrl；wbPoll 返回「等待授权」
    if (String(url).includes("/auth/state")) {
      return new Response(JSON.stringify({ data: { state: "S1", authUrl: "https://example.com/auth" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 1001, msg: "waiting" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const db = await import("../src/services/device-bind.js");
  const started = await db.startDeviceBind("workbuddy", { realm: "cn" });
  ck("startDeviceBind 返回 sessionId", Boolean(started.sessionId), JSON.stringify(started));
  calls.length = 0;

  // 三个并发 poll（模拟前端轮询重叠 + 另一个管理员同时点）
  const [a, b, c] = await Promise.all([
    db.pollDeviceBind(started.sessionId),
    db.pollDeviceBind(started.sessionId),
    db.pollDeviceBind(started.sessionId),
  ]);
  const upstreamHits = calls.filter((u) => u.includes("/auth/token")).length;
  ck("并发 3 次 poll 只打上游 1 次", upstreamHits === 1, `实际 ${upstreamHits} 次：${calls.join(" | ")}`);
  const statuses = [a.status, b.status, c.status].sort();
  ck("其余两次返回 pending（未消费会话）", statuses.filter((s) => s === "pending").length >= 2, statuses.join(","));
  ck("poll 回传 vendor=workbuddy", [a, b, c].every((x) => x.vendor === "workbuddy"), JSON.stringify([a.vendor, b.vendor, c.vendor]));

  // 会话仍然有效：互斥不该把会话吃掉（还在等用户授权）
  calls.length = 0;
  const again = await db.pollDeviceBind(started.sessionId);
  ck("互斥后会话仍可继续轮询", again.status === "pending", JSON.stringify(again));
  ck("后续轮询恢复正常打上游", calls.some((u) => u.includes("/auth/token")), calls.join(" | "));
  db.cancelDeviceBind(started.sessionId);
  ck("取消后会话失效", (await db.pollDeviceBind(started.sessionId)).status === "expired");
}

/* ==================== ③ 凭据内 endpoint 不得外送凭据 ==================== */
console.log("\n=== ③ 凭据里的 endpoint 不得成为出站目标（PAT/Token 外送防护）===");
{
  const q = await import("../src/services/upstream/qoder.js");
  const evil = ['https://evil.example.com', 'http://169.254.169.254', 'http://10.0.0.5:8963', 'http://192.168.1.9:8963'];
  for (const ep of evil) {
    let msg = "";
    try {
      q.assertBridgeAllowed(ep);
    } catch (e) {
      msg = e.message;
    }
    ck(`Qoder 拒绝桥地址 ${ep}`, /不在白名单内/.test(msg), msg.slice(0, 60));
  }
  let okMsg = "";
  try {
    q.assertBridgeAllowed("http://127.0.0.1:8963");
  } catch (e) {
    okMsg = e.message;
  }
  ck("Qoder 允许本机默认桥 127.0.0.1:8963", !okMsg, okMsg);

  // 导入时即拒绝（否则坏地址会被落库，之后每次对话都失败）
  let importRejected = false;
  try {
    await q.importAuth({ token: JSON.stringify({ personal_token: "pt-abc", endpoint: "https://evil.example.com" }) });
  } catch (e) {
    importRejected = /不在白名单内/.test(e.message);
  }
  ck("导入恶意 endpoint 的凭据被拒", importRejected);

  const qsrc = SRC("services/upstream/qoder.js");
  ck("decorated() 也走白名单（防老库里的坏地址）", /base_url: assertBridgeAllowed\(/.test(qsrc));
  ck("凭据写入时标记 allow_private_upstream（本地桥豁免公网校验）", /allow_private_upstream: true/.test(qsrc));

  // openai-compat：出站请求统一走 guardedFetch（逐跳重定向校验）
  const csrc = SRC("services/upstream/openai-compat.js");
  ck("定义了 guardedFetch", /async function guardedFetch\(url, init = \{\}, \{ allowPrivate = false \} = \{\}\)/.test(csrc));
  ck("chat 路径使用 guardedFetch", /const resp = await guardedFetch\(\s*url,/.test(csrc));
  ck("verify 路径使用 guardedFetch", /guardedFetch\(models/.test(csrc));
  ck("拉模型路径使用 guardedFetch", /await guardedFetch\(\s*models,/.test(csrc));
  ck("重定向逐跳校验（redirect: manual）", /redirect: "manual"/.test(csrc));
  const rawFetches = (csrc.match(/await fetch\(/g) || []).length;
  ck("只剩 guardedFetch 内部一处裸 fetch", rawFetches === 1, `实际 ${rawFetches} 处`);

  // WorkBuddy：凭据 endpoint 只参与 realm 二分判定，base_url 恒为官方常量
  const wb = await import("../src/services/upstream/workbuddy.js");
  const wbEvil = JSON.stringify({
    access_token: "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ3b3JrYnVkZHkuYWkifQ.x",
    endpoint: "https://evil.example.com",
  });
  const imported = await wb.importAuth({ token: wbEvil });
  ck(
    "WorkBuddy 落库的 endpoint 被覆盖为官方域",
    imported.other.endpoint === "https://www.workbuddy.ai",
    imported.other.endpoint
  );
  ck(
    "realmEndpoints 只返回两个硬编码官方域",
    wb.realmEndpoints("global").api === "https://www.workbuddy.ai" &&
      wb.realmEndpoints("cn").api === "https://copilot.tencent.com"
  );
  const wsrc = SRC("services/upstream/workbuddy.js");
  ck("workbuddy 的 base_url 只来自 realmEndpoints", /base_url: `\$\{e\.api\}\/v2`/.test(wsrc));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
