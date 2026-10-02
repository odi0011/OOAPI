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
const kimi = await import("../src/services/upstream/kimi.js");
const { adapterKeyFor } = await import("../src/services/router.js");
const { parseCookieInput, cookieHeader, cookieValue } = await import("../src/services/upstream/cookie-input.js");
const { restoreCookies } = await import("../src/services/upstream/browser-driver.js");

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
  const padded = await mimo.importAuth({ token: "test-base64-value==" });
  assert.equal(padded.token, "test-base64-value==", "带等号的裸凭据不能误当 Cookie");
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

await t("StepFun：发送请求时把 cookies 数组还原成 Cookie 串", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return new Response("{}", { status: 200 });
  };
  try {
    await stepfun.verify({
      id: 7,
      api_key: "sessionid=s-1; active-token=t-2",
      other: { cookies: [{ name: "sessionid", value: "s-1" }, { name: "active-token", value: "t-2" }] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(request && new Headers(request.headers).get("cookie"), "sessionid=s-1; active-token=t-2");
});

await t("StepFun：粘贴不含等号的内容必须报错（多半粘错了东西）", async () => {
  // 用户可能把密码、别家的 token 粘进来 —— 要在提交时就拒绝，
  // 不能等调用时才报错（那时用户已经以为配好了）
  await assert.rejects(() => stepfun.importAuth({ token: "just-a-random-string" }), /没有解析到 Cookie/);
});

/* ============================ Kimi / 通用 relay ============================ */
await t("Kimi：完整 Cookie 串自动提取 kimi-auth 并保留其它 Cookie", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
  const r = await kimi.importAuth({ token: `foo=bar; kimi-auth=${jwt}; device_id=d-1` });
  assert.equal(r.token, jwt);
  assert.equal(r.other.method, "relay");
  assert.deepEqual(r.other.cookies, [
    { name: "foo", value: "bar" },
    { name: "kimi-auth", value: jwt },
    { name: "device_id", value: "d-1" },
  ]);
});

await t("Kimi：JSON Cookie 数组也能自动提取 kimi-auth", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.sig";
  const r = await kimi.importAuth({ token: JSON.stringify({ cookies: [
    { name: "kimi-auth", value: jwt },
    { name: "foo", value: "bar" },
  ] }) });
  assert.equal(r.token, jwt);
  assert.equal(r.other.cookies.length, 2);
});

await t("网页 relay 渠道按厂商适配器路由，不误走 openai-compat", async () => {
  for (const [type, expected] of [["deepseek", "deepseek"], ["glm", "glm"], ["kimi", "kimi"], ["doubao", "doubao"], ["qwen", "qwen"]]) {
    assert.equal(adapterKeyFor({ type, other: { method: "relay" } }), expected, `${type} 应走 ${expected}`);
    assert.equal(adapterKeyFor({ type, other: {} }), expected, "历史无 method 的网页渠道也应走厂商适配器");
    assert.equal(adapterKeyFor({ type, other: { method: "api" } }), "openai-compat", "API Key 模式继续走兼容 API");
  }
});

/* ============================ Cookie 输入矩阵 ============================ */
const matrixJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig";
for (const [name, mod, fields, expected] of [
  ["StepFun", stepfun, { "Oasis-Token": "test-step-value==", "Oasis-Webid": "test-device" }, "Oasis-Token=test-step-value==; Oasis-Webid=test-device"],
  ["MiMo", mimo, { xiaomichatbot_serviceToken: "test-mimo", userId: "test-user", xiaomichatbot_ph: "test-ph" }, "test-mimo"],
  ["MiniMax", minimax, { token: matrixJwt, device: "test-device" }, matrixJwt],
  ["Kimi", kimi, { "kimi-auth": matrixJwt, device: "test-device" }, matrixJwt],
]) {
  const entries = Object.entries(fields).map(([name, value]) => ({ name, value }));
  for (const [format, value] of [
    ["Request Headers", "Cookie: " + cookieHeader(entries)],
    ["扩展 Cookie 数组", JSON.stringify(entries)],
    ["Cookie 对象映射", JSON.stringify({ cookies: fields })],
    ["JSON 包装 Cookie 串", JSON.stringify({ cookies: cookieHeader(entries) })],
    ["辅助 Cookies 字段", null],
  ]) {
    await t(name + "：" + format + " 自动解析为具名凭据", async () => {
      const r = await mod.importAuth(value == null ? { cookies: JSON.stringify(entries) } : { token: value });
      assert.equal(r.token, expected);
      if (name === "MiMo") {
        assert.equal(r.other.user_id, "test-user");
        assert.equal(r.other.ph, "test-ph");
      }
    });
  }
}

for (const name of ["glm", "doubao", "qwen"]) {
  await t(name + "：主框、辅助框与扩展 Cookie 保留为浏览器可注入结构", async () => {
    const mod = await import("../src/services/upstream/" + name + ".js");
    for (const input of [
      { token: "Cookie: session=test-session; device=test-device" },
      { token: JSON.stringify([{ name: "session", value: "test-session" }, { name: "device", value: "test-device" }]) },
      { cookies: "session=test-session; device=test-device" },
      { token: "test-token", cookies: '{"session":"test-session","device":"test-device"}' },
    ]) {
      const r = await mod.importAuth(input);
      assert.equal(cookieHeader(r.other.cookies), "session=test-session; device=test-device");
      assert.equal(r.other.method, "relay");
      if (input.token === "test-token") assert.equal(r.token, input.token);
    }
    await assert.rejects(() => mod.importAuth({ token: "", cookies: "invalid-cookies" }), (e) => e.code === "CHANNEL_BAD_PARAMS");
    await assert.rejects(() => mod.importAuth({ token: "{invalid-json" }), (e) => e.code === "CHANNEL_BAD_PARAMS");
  });
}

await t("Cookie 保留签名中的等号；单独提取 token 才安全解码", () => {
  const list = parseCookieInput("Cookie: session=a%2Fb==; quoted=\"a%3Db\"; bad=raw%QQ");
  assert.equal(cookieHeader(list), 'session=a%2Fb==; quoted="a%3Db"; bad=raw%QQ');
  assert.equal(cookieValue(list, "session"), "a/b==");
  assert.equal(cookieValue(list, "quoted"), "a=b");
  assert.equal(cookieValue(list, "bad"), "raw%QQ");
  assert.equal(cookieHeader([{ name: "bad\r\nname", value: "x" }, { name: "bad", value: "x\r\nsecret" }]), "");
});

await t("浏览器首建 about:blank 的 Cookie 使用登录入口 URL，并补齐域名路径", async () => {
  let submitted;
  const count = await restoreCookies({ addCookies: async (list) => { submitted = list; } },
    { url: () => "about:blank" }, [{ name: "session", value: "test-value" }], "https://example.com/login");
  assert.equal(count, 1);
  assert.equal(submitted[0].url, "https://example.com/login");
  await restoreCookies({ addCookies: async (list) => { submitted = list; } }, null,
    [{ name: "session", value: "test-value", domain: ".example.com", sameSite: "no_restriction" }]);
  assert.equal(submitted[0].path, "/");
  assert.equal(submitted[0].sameSite, "None");
});

await t("浏览器 Cookie 注入失败不泄露值，不悄悄以游客状态继续", async () => {
  await assert.rejects(
    () => restoreCookies({ addCookies: async () => { throw new Error("test-private-cookie-value"); } },
      { url: () => "about:blank" }, [{ name: "session", value: "test-private-cookie-value" }]),
    (e) => e.code === "CHANNEL_NOT_READY" && !e.message.includes("test-private-cookie-value"),
  );
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
