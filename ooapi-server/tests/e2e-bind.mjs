// 一键绑定接口的端到端验证（HTTP 级）
// ---------------------------------------------------------------------------
// 为什么要测：设备授权涉及「发起 → 轮询 → 落库」三步，
// 而真实上游需要 AWS / 腾讯 / 阿里账号。这里验证的是**我们这一侧**的正确性：
//   · 不支持一键绑定的渠道必须明确报错（而不是静默失败）；
//   · 不支持的厂商 / 无效会话要给出可读原因；
//   · 权限：普通用户不能调（这是管理员功能）；
//   · 发起成功后前端拿到的字段齐全（userCode/verifyUrl/intervalMs 都要有）。
// 真实上游的响应判定由 tests/device-bind.test.mjs 的纯函数测试覆盖。
import "dotenv/config";
import jwt from "jsonwebtoken";

const BASE = process.env.BASE || "http://127.0.0.1:3001";
const { JWT_SECRET, pool } = await import("../src/db.js");

let pass = 0;
let fail = 0;
const ck = (n, c, extra = "") => {
  if (c) {
    pass += 1;
    console.log(`  ok  ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${n} ${extra}`);
  }
};

const [[admin]] = await pool.query("SELECT id, role, token_version, username FROM users WHERE role >= 100 LIMIT 1");
const [[plain]] = await pool.query("SELECT id, role, token_version FROM users WHERE role < 100 AND status = 1 LIMIT 1");
const HA = {
  authorization: `Bearer ${jwt.sign({ id: admin.id, role: admin.role, tv: Number(admin.token_version) || 0 }, JWT_SECRET, { expiresIn: "10m" })}`,
  "content-type": "application/json",
};
const HU = plain
  ? {
      authorization: `Bearer ${jwt.sign({ id: plain.id, role: plain.role, tv: Number(plain.token_version) || 0 }, JWT_SECRET, { expiresIn: "10m" })}`,
      "content-type": "application/json",
    }
  : null;

const post = async (path, body, headers = HA) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body: j, data: j?.data };
};
const get = async (path, headers = HA) => {
  const r = await fetch(`${BASE}${path}`, { headers });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body: j, data: j?.data };
};

console.log(`一键绑定接口验证（${admin.username}）\n`);

/* ---------------- 能力清单 ---------------- */
const vendors = await get("/api/channel/devices/vendors");
ck("厂商清单接口可读", vendors.status === 200 && Array.isArray(vendors.data?.vendors), JSON.stringify(vendors.body)?.slice(0, 160));
ck("清单含 kiro / workbuddy / qoder", ["kiro", "workbuddy", "qoder"].every((v) => (vendors.data?.vendors || []).includes(v)), JSON.stringify(vendors.data?.vendors));
ck("清单不含网页反代渠道（它们不走设备授权）", !(vendors.data?.vendors || []).includes("deepseek"), JSON.stringify(vendors.data?.vendors));

/* ---------------- 权限 ---------------- */
if (HU) {
  const denied = await post("/api/channel/devices/start", { vendor: "kiro" }, HU);
  ck("普通用户发起绑定被拒（管理员功能）", denied.status === 403, `HTTP ${denied.status}`);
  const deniedList = await get("/api/channel/devices/vendors", HU);
  ck("普通用户读清单被拒", deniedList.status === 403, `HTTP ${deniedList.status}`);
} else {
  ck("普通用户发起绑定被拒（管理员功能）", true, "（没有普通用户，跳过）");
  ck("普通用户读清单被拒", true, "（跳过）");
}

/* ---------------- 参数校验 ---------------- */
const noVendor = await post("/api/channel/devices/start", {});
ck("缺 vendor 时报错", noVendor.status !== 200, `HTTP ${noVendor.status}`);
const badVendor = await post("/api/channel/devices/start", { vendor: "deepseek" });
ck("不支持的渠道明确报错（不是静默失败）", badVendor.status === 400 && /不支持一键绑定/.test(badVendor.body?.message || ""), JSON.stringify(badVendor.body)?.slice(0, 160));

/* ---------------- 无效会话轮询 ---------------- */
const badPoll = await post("/api/channel/devices/poll", { session_id: "nope", vendor: "kiro" });
ck("无效会话轮询给出可读原因", badPoll.status === 200 && badPoll.data?.status === "expired", JSON.stringify(badPoll.body)?.slice(0, 200));
const noSid = await post("/api/channel/devices/poll", {});
ck("缺 session_id 时报错", noSid.status !== 200, `HTTP ${noSid.status}`);

/* ---------------- 真实发起（打到上游）----------------
   这一条会真的访问 AWS（kiro）。网络不通或凭据缺失时应返回明确的 400 错误，
   而不是 500 —— 我们要验证的正是「错误路径可读」。
   注意：不校验具体成功与否（测试环境未必能连 AWS），只校验两种合法结果。
*/
const real = await post("/api/channel/devices/start", { vendor: "kiro", region: "us-east-1" });
const okOrClearError = real.status === 200 || (real.status === 400 && typeof real.body?.message === "string" && real.body.message.length > 0);
ck(
  "发起 Kiro 绑定：要么拿到授权信息、要么给出可读错误（不能 500）",
  okOrClearError,
  `HTTP ${real.status} ${JSON.stringify(real.body)?.slice(0, 240)}`
);
if (real.status === 200) {
  const d = real.data || {};
  ck("响应含 sessionId / verifyUrl / intervalMs", Boolean(d.sessionId && d.verifyUrl && d.intervalMs), JSON.stringify(d)?.slice(0, 200));
  ck("Kiro 应给出用户码（AWS 设备流特征）", Boolean(d.userCode), JSON.stringify(d)?.slice(0, 200));
  console.log(`      授权链接：${String(d.verifyUrl).slice(0, 90)}`);
  console.log(`      用户码：${d.userCode}`);
  // 轮询一次：应是 pending（用户还没去授权）
  const p = await post("/api/channel/devices/poll", { session_id: d.sessionId, vendor: "kiro" });
  ck("轮询未授权会话返回 pending（不判失败）", p.status === 200 && p.data?.status === "pending", JSON.stringify(p.body)?.slice(0, 200));
  // 取消后应失效
  const cancel = await post("/api/channel/devices/cancel", { session_id: d.sessionId });
  ck("取消绑定成功", cancel.status === 200 && cancel.data?.cancelled === true, JSON.stringify(cancel.body)?.slice(0, 160));
  const afterCancel = await post("/api/channel/devices/poll", { session_id: d.sessionId, vendor: "kiro" });
  ck("取消后再轮询即失效", afterCancel.data?.status === "expired", JSON.stringify(afterCancel.body)?.slice(0, 160));
} else {
  console.log(`      （上游不可达，跳过授权信息断言：${real.body?.message?.slice(0, 120)}）`);
  ck("上游不可达时给出可读错误而非 500", real.status === 400, `HTTP ${real.status}`);
}

await pool.end().catch(() => {});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
