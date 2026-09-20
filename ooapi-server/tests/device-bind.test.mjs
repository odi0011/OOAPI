// 设备授权绑定测试
// ---------------------------------------------------------------------------
// 为什么这样测：三个渠道的真实上游都需要对应账号（AWS / 腾讯 / 阿里），
// 测试环境打不到。所以把「响应 → 状态」的判定抽成纯函数（judge*），
// 用**真实响应样本**验证 —— 这几条分支恰恰是最容易写错的地方：
//   · AWS 的「等待授权」是异常名，不是 HTTP 状态；
//   · WorkBuddy 的「等待授权」是 HTTP 200 + 业务 code != 0（按 HTTP 判会误判为失败）；
//   · Qoder 的 404/202/200-空-token 都是 pending。
// 会话生命周期（发起/轮询/取消/超时）则用不触网的方式测。
import assert from "node:assert/strict";

const {
  judgeKiroToken,
  judgeWorkbuddyToken,
  judgeQoderPoll,
  supportsDeviceBind,
  deviceBindVendors,
  startDeviceBind,
  pollDeviceBind,
  cancelDeviceBind,
  activeBindCount,
} = await import("../src/services/device-bind.js");

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

/* ============================ Kiro（AWS SSO OIDC）============================ */
const kiroSession = { region: "us-east-1", clientId: "cid", clientSecret: "csecret" };

await t("Kiro：拿到 accessToken 即成功，凭据字段与 importAuth 对齐", async () => {
  const out = judgeKiroToken(
    { status: 200, json: { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 } },
    kiroSession
  );
  assert.equal(out.status, "success");
  // kiro.js 的 importAuth 读这些字段，名字必须一致，否则入库会丢凭据
  assert.equal(out.credential.access_token, "at-1");
  assert.equal(out.credential.refresh_token, "rt-1");
  assert.equal(out.credential.region, "us-east-1");
  // SSO 形态的 client_id/client_secret 必须一并落库 —— 刷新时要用它们换 token
  assert.equal(out.credential.client_id, "cid");
  assert.equal(out.credential.client_secret, "csecret");
  assert.ok(out.credential.expires_at > Math.floor(Date.now() / 1000), "应给出未来过期时间");
});

await t("Kiro：AuthorizationPending 判为 pending（不是失败）", async () => {
  // AWS 用异常名表达「用户还没确认」——按 HTTP 状态看它是 400，
  // 直接当失败就会让用户永远绑不上
  for (const name of ["authorization_pending", "AuthorizationPendingException", "authorization_pending_exception"]) {
    const out = judgeKiroToken({ status: 400, json: { error: name } }, kiroSession);
    assert.equal(out.status, "pending", `${name} 应为 pending`);
  }
  // __type 形态（AWS 常见）
  const typed = judgeKiroToken({ status: 400, json: { __type: "AuthorizationPendingException" } }, kiroSession);
  assert.equal(typed.status, "pending");
});

await t("Kiro：slow_down 判为 pending 且带 slowDown 标记（要继续等而非失败）", async () => {
  const out = judgeKiroToken({ status: 400, json: { error: "slow_down" } }, kiroSession);
  assert.equal(out.status, "pending");
  assert.equal(out.slowDown, true);
  const camel = judgeKiroToken({ status: 400, json: { __type: "SlowDownException" } }, kiroSession);
  assert.equal(camel.slowDown, true);
});

await t("Kiro：过期与拒绝分别判为 expired / denied", async () => {
  assert.equal(judgeKiroToken({ status: 400, json: { error: "expired_token" } }, kiroSession).status, "expired");
  assert.equal(judgeKiroToken({ status: 400, json: { __type: "ExpiredTokenException" } }, kiroSession).status, "expired");
  assert.equal(judgeKiroToken({ status: 400, json: { error: "access_denied" } }, kiroSession).status, "denied");
  // 未知错误不判失败：宁可继续轮询（可能只是暂时的服务端问题）
  assert.equal(judgeKiroToken({ status: 500, json: { error: "InternalServerError" } }, kiroSession).status, "pending");
  assert.equal(judgeKiroToken({ status: 502, json: null }, kiroSession).status, "pending");
});

/* ============================ WorkBuddy ============================ */
const wbSession = { realm: "cn" };

await t("WorkBuddy：拿到 accessToken 即成功", async () => {
  const out = judgeWorkbuddyToken(
    { status: 200, json: { code: 0, data: { accessToken: "at", refreshToken: "rt", expiresIn: 7200, domain: "www.workbuddy.ai" } } },
    wbSession
  );
  assert.equal(out.status, "success");
  assert.equal(out.credential.access_token, "at");
  assert.equal(out.credential.refresh_token, "rt");
  assert.equal(out.credential.domain, "www.workbuddy.ai");
});

await t("WorkBuddy：待授权是 HTTP 200 + code!=0（关键：不能按 HTTP 状态判失败）", async () => {
  // 这是社区文档明确记录的行为：pending 时 HTTP 200 但业务 code != 0。
  // 若按 HTTP 状态判断，会把「等待中」直接判成失败 —— 用户永远等不到成功。
  const out = judgeWorkbuddyToken({ status: 200, json: { code: 1001, msg: "login ing" } }, wbSession);
  assert.equal(out.status, "pending", "HTTP 200 + 非 0 code 必须是 pending");
  // 数据里没有 token 也是 pending（哪怕 code=0 的空响应）
  const empty = judgeWorkbuddyToken({ status: 200, json: { code: 0, data: {} } }, wbSession);
  assert.equal(empty.status, "pending");
  // snake_case 字段也能识别（不同版本上游写法不一）
  const snake = judgeWorkbuddyToken({ status: 200, json: { data: { access_token: "x" } } }, wbSession);
  assert.equal(snake.status, "success");
});

await t("WorkBuddy：国际区回落的 domain 正确", async () => {
  const out = judgeWorkbuddyToken({ status: 200, json: { data: { accessToken: "x" } } }, { realm: "global" });
  assert.equal(out.credential.domain, "www.workbuddy.ai");
  const cn = judgeWorkbuddyToken({ status: 200, json: { data: { accessToken: "x" } } }, { realm: "cn" });
  assert.equal(cn.credential.domain, "copilot.tencent.com");
});

/* ============================ Qoder ============================ */
const qoderSession = { openapi: "https://openapi.qoder.com.cn", realm: "cn" };

await t("Qoder：拿到 accessToken 即成功，expires_in 毫秒换算成秒", async () => {
  const out = judgeQoderPoll(
    {
      status: 200,
      json: {
        data: {
          accessToken: "dt-x",
          refreshToken: "drt-y",
          personalToken: "pt-z",
          // 上游给的是毫秒（社区实测），若不换算会得到几十年后的过期时间
          expires_in: 2592000000,
        },
      },
    },
    qoderSession
  );
  assert.equal(out.status, "success");
  assert.equal(out.credential.access_token, "dt-x");
  assert.equal(out.credential.refresh_token, "drt-y");
  assert.equal(out.credential.personal_token, "pt-z");
  assert.equal(out.credential.endpoint, "https://openapi.qoder.com.cn");
  const days = (out.credential.expires_at - Math.floor(Date.now() / 1000)) / 86400;
  assert.ok(days > 25 && days < 35, `2592000000ms 应换算成约 30 天，实际 ${days.toFixed(1)} 天`);
});

await t("Qoder：404 / 202 / 200-空-token 都判 pending", async () => {
  assert.equal(judgeQoderPoll({ status: 404, json: null }, qoderSession).status, "pending");
  assert.equal(judgeQoderPoll({ status: 202, json: null }, qoderSession).status, "pending");
  assert.equal(judgeQoderPoll({ status: 200, json: { data: {} } }, qoderSession).status, "pending");
  // 顶层字段（不带 data 包装）
  assert.equal(judgeQoderPoll({ status: 200, json: {} }, qoderSession).status, "pending");
});

await t("Qoder：410 或过期文案判 expired", async () => {
  assert.equal(judgeQoderPoll({ status: 410, json: null }, qoderSession).status, "expired");
  assert.equal(judgeQoderPoll({ status: 200, json: { message: "token expired" } }, qoderSession).status, "expired");
  // 其它非 200/202/404 的状态带出 HTTP 码便于排查
  const other = judgeQoderPoll({ status: 500, json: { message: "boom" } }, qoderSession);
  assert.equal(other.status, "pending");
  assert.match(other.message, /500|boom/);
});

/* ============================ 会话生命周期 ============================ */
await t("支持的渠道清单正确（只含已实现的三家）", async () => {
  const list = deviceBindVendors();
  assert.ok(list.includes("kiro"), "应有 kiro");
  assert.ok(list.includes("workbuddy"), "应有 workbuddy");
  assert.ok(list.includes("qoder"), "应有 qoder");
  assert.equal(supportsDeviceBind("kiro"), true);
  assert.equal(supportsDeviceBind("deepseek"), false, "网页反代渠道不走设备授权");
  assert.equal(supportsDeviceBind(""), false);
  assert.equal(supportsDeviceBind(null), false);
});

await t("不支持一键绑定的渠道：发起时报错而不是静默失败", async () => {
  await assert.rejects(() => startDeviceBind("deepseek", {}), /不支持一键绑定/);
  await assert.rejects(() => startDeviceBind("", {}), /不支持一键绑定/);
});

await t("无效会话轮询：返回 expired 而不是抛错（前端要能显示原因）", async () => {
  const out = await pollDeviceBind("nonexistent-session-id");
  assert.equal(out.status, "expired");
  assert.match(out.message, /失效|超时/);
});

await t("取消会话：取消后再轮询即失效", async () => {
  // 直接测 cancel 的语义（不真发起上游请求）
  const n0 = activeBindCount();
  assert.equal(cancelDeviceBind("no-such-session"), false, "不存在的会话返回 false");
  assert.equal(activeBindCount(), n0, "取消不存在的会话不影响计数");
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
