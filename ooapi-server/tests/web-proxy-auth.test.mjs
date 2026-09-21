// 三家网页版反代的凭据解析测试
// ---------------------------------------------------------------------------
// 为什么测这个：`importAuth` 是用户接触的第一个环节 ——
// 解析失败会直接让「添加渠道」报错，而三种适配器的凭据形态各不相同
// （MiMo 是三段 cookie、MiniMax 是 JWT + 指纹、StepFun 是纯 cookie 串）。
// 这些是纯函数，不需要网络与账号，所以必须覆盖。
import assert from "node:assert/strict";

const mimo = await import("../src/services/upstream/mimo-web.js");
const minimax = await import("../src/services/upstream/minimax-web.js");
const stepfun = await import("../src/services/upstream/stepfun-web.js");

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

/* ============================ 小米 MiMo ============================ */
await t("MiMo：粘贴完整 cookie 串能解析出三个字段", async () => {
  const r = await mimo.importAuth({
    token: "serviceToken=st-abc; userId=12345; xiaomichatbot_ph=ph-xyz; other=1",
  });
  assert.equal(r.token, "st-abc", "serviceToken 应作为 api_key");
  assert.equal(r.other.service_token, "st-abc");
  assert.equal(r.other.user_id, "12345");
  assert.equal(r.other.ph, "ph-xyz");
  // 三个字段都要落库 —— 漏了 ph 会被风控（它同时是 URL query 参数）
  assert.equal(r.other.method, "mimo");
});

await t("MiMo：粘贴 JSON 也能解析（扩展导出/手工拼）", async () => {
  const r = await mimo.importAuth({
    token: JSON.stringify({ serviceToken: "st-1", userId: "99", xiaomichatbot_ph: "ph-1" }),
  });
  assert.equal(r.token, "st-1");
  assert.equal(r.other.user_id, "99");
  assert.equal(r.other.ph, "ph-1");
});

await t("MiMo：只给裸 serviceToken 也能建渠道（不报错）", async () => {
  const r = await mimo.importAuth({ token: "st-bare-token-value" });
  assert.equal(r.token, "st-bare-token-value");
  assert.equal(r.other.user_id, "");
  assert.equal(r.other.ph, "");
});

await t("MiMo：空内容必须报错（不能静默建出坏渠道）", async () => {
  await assert.rejects(() => mimo.importAuth({ token: "" }), /为空|没有解析/);
  await assert.rejects(() => mimo.importAuth({}), /为空|没有解析/);
});

/* ============================ MiniMax ============================ */
await t("MiniMax：粘贴 JWT 时指纹由 token 稳定派生", async () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
  const a = await minimax.importAuth({ token });
  const b = await minimax.importAuth({ token });
  assert.equal(a.token, token);
  assert.equal(a.other.method, "minimax-web");
  assert.ok(a.other.fingerprint.uuid && a.other.fingerprint.device_id, "应派生指纹");
  // **同一 token 必须派生同一指纹** —— 随机变化是强风控信号（会算错签名 yy）
  assert.equal(a.other.fingerprint.device_id, b.other.fingerprint.device_id, "指纹必须稳定");
  assert.equal(a.other.fingerprint.uuid, b.other.fingerprint.uuid);
});

await t("MiniMax：粘贴 JSON 时优先采用用户给的指纹（抓包值不能被覆盖）", async () => {
  const r = await minimax.importAuth({
    token: JSON.stringify({
      token: "eyJx.eyJy.zzz",
      fingerprint: { uuid: "my-uuid", device_id: "my-device", screen_width: 2560, screen_height: 1440 },
    }),
  });
  // 用户抓包时的屏幕尺寸参与签名计算，**必须原样使用** ——
  // 换成平台默认值会让 yy 算错，上游直接拒
  assert.equal(r.other.fingerprint.uuid, "my-uuid");
  assert.equal(r.other.fingerprint.device_id, "my-device");
  assert.equal(r.other.fingerprint.screen_width, 2560);
  assert.equal(r.other.fingerprint.screen_height, 1440);
});

await t("MiniMax：cookie 串形态也能取到 token", async () => {
  const r = await minimax.importAuth({ token: "a=1; token=eyJhbGciOi.test.sig; b=2" });
  assert.equal(r.token, "eyJhbGciOi.test.sig");
});

/* ============================ StepFun ============================ */
await t("StepFun：cookie 串解析为 other.cookies 数组", async () => {
  const r = await stepfun.importAuth({ token: "sessionid=s-1; active-token=t-2; other=3" });
  assert.equal(r.other.method, "stepfun-web");
  assert.equal(r.other.cookies.length, 3, "应解析出 3 个 cookie");
  assert.equal(r.other.cookies[0].name, "sessionid");
  assert.equal(r.other.cookies[0].value, "s-1");
  // api_key 存 cookie 串本身（与其它网页反代渠道一致）
  assert.match(r.token, /sessionid=s-1/);
});

await t("StepFun：粘贴不含等号的内容必须报错（多半粘错了东西）", async () => {
  // 用户可能把密码、别家的 token 粘进来 —— 要在提交时就拒绝，
  // 不能等调用时才报错（那时用户已经以为配好了）
  await assert.rejects(() => stepfun.importAuth({ token: "just-a-random-string" }), /没有解析到 Cookie/);
});

/* ============================ 适配器契约 ============================ */
await t("三家都实现了完整适配器契约", async () => {
  for (const [name, mod] of [["mimo-web", mimo], ["minimax-web", minimax], ["stepfun-web", stepfun]]) {
    for (const fn of ["importAuth", "chat", "verify", "loginModes", "fetchUpstreamModels"]) {
      assert.equal(typeof mod[fn], "function", `${name} 缺 ${fn}`);
    }
    assert.ok(mod.ENTRY_URL, `${name} 缺 ENTRY_URL（「抓取登录态」要用）`);
    assert.ok(mod.loginModes().includes("capture"), `${name} 应支持抓取登录态`);
  }
});

await t("图片输入明确报错而不是静默丢弃", async () => {
  // 静默丢弃是最坏情况：用户以为图发出去了，模型根本没看到
  const fake = { other: {}, api_key: "x" };
  for (const [name, mod] of [["mimo-web", mimo], ["minimax-web", minimax], ["stepfun-web", stepfun]]) {
    await assert.rejects(
      () => mod.chat({ channel: fake, model: "m", prompt: "hi", images: [{ data: "x" }], signal: AbortSignal.timeout(1000) }),
      (e) => e.code === "VISION_NOT_SUPPORTED",
      `${name} 的图片输入应抛 VISION_NOT_SUPPORTED`
    );
  }
});

await t("上游模型清单格式正确", async () => {
  for (const [name, mod] of [["mimo-web", mimo], ["minimax-web", minimax], ["stepfun-web", stepfun]]) {
    const list = mod.fetchUpstreamModels();
    assert.ok(Array.isArray(list) && list.length > 0, `${name} 模型清单为空`);
    for (const m of list) {
      assert.ok(m.id && m.name, `${name} 的模型项缺 id/name`);
    }
  }
});

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
