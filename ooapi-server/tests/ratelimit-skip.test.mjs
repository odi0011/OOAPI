// 限流的 skipSuccessful 行为验证（真实 HTTP，不靠读源码）
//
// 为什么必须实测：`res.on("finish")` 里计数是对**响应结束后**的异步写，
// 如果写错（比如写成同步判断）就会出现「成功也计数」或「失败不计数」，
// 而这两种错法都只会在真实请求里暴露，静态断言看不出来。
import http from "node:http";
import express from "express";
import { rateLimit } from "../src/middleware/ratelimit.js";

let pass = 0;
let fail = 0;
const t = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
};

const app = express();
app.set("trust proxy", true);
// 失败层：3 次失败 / 10 秒（成功不计）
app.post("/ok", rateLimit({ windowMs: 10_000, max: 3, keyPrefix: "t", skipSuccessful: true }), (req, res) => {
  res.status(200).json({ ok: true });
});
app.post("/bad", rateLimit({ windowMs: 10_000, max: 3, keyPrefix: "t", skipSuccessful: true }), (req, res) => {
  res.status(400).json({ ok: false });
});
// 对照：旧行为（一律计数）
app.post("/plain", rateLimit({ windowMs: 10_000, max: 3, keyPrefix: "p" }), (req, res) => {
  res.status(200).json({ ok: true });
});

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const port = server.address().port;

const hit = (path) =>
  new Promise((resolve) => {
    const req = http.request({ port, path, method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.end();
  });

// 需要绕过 express 的默认 404（/ok 与 /bad 都定义在同一个 keyPrefix "t" 上，
// 但 key 里包含 path 吗？不包含 —— 所以两者共享同一个桶。这正好用来验证
// 「失败计数、成功不计数」在同一桶里的相互作用。）
console.log("=== ① skipSuccessful：连续成功不该被限流 ===");
{
  const codes = [];
  for (let i = 0; i < 6; i += 1) codes.push(await hit("/ok"));
  t("连续 6 次成功全部 200（上限 3 但成功不计数）", codes.every((c) => c === 200), JSON.stringify(codes));
}

console.log("\n=== ② skipSuccessful：失败才计数 ===");
{
  // 同一 keyPrefix "t" 的桶已被上面的成功请求污染了吗？成功不写入，所以应为空
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push(await hit("/bad"));
  // 前 3 次 400（计满），第 4 次 429
  t("前 3 次失败返回 400、第 4 次被限流为 429", codes.slice(0, 3).every((c) => c === 400) && codes[3] === 429,
    JSON.stringify(codes));
}

console.log("\n=== ③ 对照：旧行为（一律计数）===");
{
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push(await hit("/plain"));
  t("一律计数时，第 4 次成功也被限流（说明开关真的起作用）",
    codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, JSON.stringify(codes));
}

server.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
