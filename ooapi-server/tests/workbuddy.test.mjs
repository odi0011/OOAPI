// WorkBuddy 适配器单测：域判定、头组、积分聚合（不联网）
import { realmOf, realmEndpoints, buildHeaders, parseAuthJson } from "../src/services/upstream/workbuddy.js";
import { quotaSupportFor } from "../src/services/upstream/quota.js";

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

// realm 判定（用真实 JWT 结构）
const mk = (iss) => `x.${Buffer.from(JSON.stringify({ iss })).toString("base64url")}.y`;
ck("iss=workbuddy.ai → global", realmOf(mk("https://www.workbuddy.ai/auth/realms/copilot")) === "global");
ck("iss=codebuddy.ai → global", realmOf(mk("https://www.codebuddy.ai/auth/realms/x")) === "global");
ck("iss=codebuddy.cn → cn", realmOf(mk("https://www.codebuddy.cn/auth/realms/x")) === "cn");
ck("iss=tencent.com → cn", realmOf(mk("https://copilot.tencent.com/auth/realms/x")) === "cn");
ck("非 JWT + 域线索 → global", realmOf("not-a-jwt", "https://www.workbuddy.ai") === "global");
ck("完全无线索 → cn（默认）", realmOf("not-a-jwt") === "cn");

const g = realmEndpoints("global");
const c = realmEndpoints("cn");
ck("global 的 api/billing 同为 workbuddy.ai", g.api.includes("workbuddy.ai") && g.billing.includes("workbuddy.ai"));
ck("cn 的 api 是 copilot.tencent.com", c.api.includes("copilot.tencent.com"));
ck("cn 的 billing 是 codebuddy.cn（两域不同）", c.billing.includes("codebuddy.cn"));

// 头组必须包含的关键头
const H = buildHeaders({ token: "t", userId: "u1", realm: "global", sse: true });
ck("带 Authorization", H.authorization === "Bearer t");
ck("带 X-CodeBuddy-Request（风控闸门）", H["x-codebuddy-request"] === "1");
ck("X-Domain 与 realm 一致", H["x-domain"] === "www.workbuddy.ai");
ck("Origin 与 realm 一致", H.origin === "https://www.workbuddy.ai");
ck("UA 是双段（单段会被 12403 拒）", /^CLI\/[\d.]+ CodeBuddy\/[\d.]+$/.test(H["user-agent"]), H["user-agent"]);
ck("带 X-User-Id", H["x-user-id"] === "u1");
const H2 = buildHeaders({ token: "t", realm: "cn" });
ck("无企业时发 X-No-Enterprise-Id", H2["x-no-enterprise-id"] === "1" && !H2["x-enterprise-id"]);
ck("cn 的 X-Domain 是 codebuddy.cn", H2["x-domain"] === "www.codebuddy.cn");

// 凭据解析：domain 字段（一键绑定的产物）
const p1 = parseAuthJson(JSON.stringify({ access_token: "tok", domain: "www.workbuddy.ai", user_id: "u2" }));
ck("认 domain → endpoint", p1.endpoint === "https://www.workbuddy.ai", p1.endpoint);
ck("domain 形态的 realm 判为 global", realmOf("tok-" + Buffer.from(JSON.stringify({iss:"https://www.workbuddy.ai"})).toString("base64url"), p1.endpoint) === "global");

// 积分支持
ck("quotaSupportFor(workbuddy) → supported", quotaSupportFor({ type: "workbuddy", method: "workbuddy" }).supported === true);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
