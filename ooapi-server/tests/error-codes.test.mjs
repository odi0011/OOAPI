import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, errorInfo, errorHelp } from "../src/services/error-codes.js";
import { TOOLS, nativeToolSpecs } from "../src/services/harness/tools.js";
import { pool } from "../src/db.js";
import { setOption } from "../src/config.js";

// 覆盖应用实际声明及分支引用的错误码，避免新增代码后页面重新退回纯英文编号。
const codes = new Set(["INVALID_REASONING", "TOOL_STEP_LIMIT", "QUOTA_EXHAUSTED", "TOKEN_INVALID", "TOKEN_DISABLED", "MODEL_NOT_ALLOWED", "GROUP_UNAVAILABLE", "RATE_LIMITED_LOCAL"]);
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) scan(file);
    else if (file.endsWith(".js")) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:\bcode\s*:\s*|\.code\s*=\s*)["']([A-Za-z][A-Za-z0-9_]+)["']/g)) {
        if (match[1].includes("_") || /^[A-Z]+$/.test(match[1])) codes.add(match[1]);
      }
      for (const match of source.matchAll(/["']((?:CHANNEL|LOGIN|BIND|AUTH|BILLING|USER)_[A-Z_]+)["']/g)) codes.add(match[1]);
    }
  }
}
scan(fileURLToPath(new URL("../src", import.meta.url)));
for (const code of codes) {
  const info = errorInfo(code);
  assert.ok(info.known, `缺少错误解释：${code}`);
  assert.ok(info.title && info.meaning && info.action);
}
assert.ok(errorHelp("CHANNEL_BAD_REQUEST").includes("不能确定具体根因"));
assert.equal(errorInfo("11133").known, false);
assert.ok(errorHelp("11133").includes("没有已确认的释义"));
assert.equal(errorInfo("https://private.invalid/?key=secret").code, "");
assert.ok(nativeToolSpecs(["account"])[0].parameters.properties.action.enum.includes("error_help"));

const originalQuery = pool.query;
let seen = [];
pool.query = async (sql, args = []) => {
  if (String(sql).startsWith("INSERT INTO options")) return [{ affectedRows: 1 }];
  seen.push({ sql, args });
  assert.match(sql, /FROM logs WHERE user_id = \?/);
  assert.equal(args[0], 7);
  assert.equal((sql.match(/\?/g) || []).length, args.length);
  return [[{ created_at: 1, type: 4, status: "error", error_code: "CHANNEL_BAD_REQUEST", request_id: "fixture-id", model: "fixture", content: "调用失败",
    detail: JSON.stringify({ http_status: 400, upstream_error_code: "11133", upstream_endpoints: ["/v2/chat/completions"],
      endpoint_attempts: [{ endpoint: "/v2/chat/completions?key=PRIVATE_FIXTURE", status: 400, code: "CHANNEL_BAD_REQUEST" }], api_key: "PRIVATE_FIXTURE", request_prompt_text: "PRIVATE_FIXTURE" }) }]];
};
try {
  const user = { id: 7, role: 1 };
  const one = await TOOLS.account.run({ action: "error_help", error_code: "CHANNEL_BAD_REQUEST" }, { user });
  assert.ok(one.ok && one.output.includes("上游拒绝请求") && one.output.includes("排查建议"));
  const all = await TOOLS.account.run({ action: "error_help" }, { user });
  for (const code of Object.keys(ERROR_CODES)) assert.ok(all.output.includes(code));
  assert.equal(seen.length, 0, "错误词典查询不访问用户数据");
  await setOption("user_data_visibility", JSON.stringify({ version: 1, balance: true, usage_summary: true, usage_records: true, request_content: true, pricing: true }));
  const ordinary = await TOOLS.account.run({ action: "errors" }, { user });
  assert.ok(ordinary.output.includes("上游拒绝请求"));
  assert.ok(!ordinary.output.includes("11133") && !ordinary.output.includes("/v2/") && !ordinary.output.includes("PRIVATE_FIXTURE"));
  assert.ok(!seen.at(-1).sql.includes(", detail"));
  const admin = await TOOLS.account.run({ action: "errors" }, { user: { ...user, role: 100 } });
  assert.ok(admin.output.includes("11133") && admin.output.includes("HTTP 400") && admin.output.includes("/v2/chat/completions"));
  assert.ok(!admin.output.includes("PRIVATE_FIXTURE"), "管理员工具只投影诊断字段，不把原始明细或凭据送入模型");
  await setOption("user_data_visibility", JSON.stringify({ version: 1, balance: false, usage_summary: false, usage_records: false, request_content: false, pricing: false }));
  const before = seen.length;
  assert.equal((await TOOLS.account.run({ action: "errors" }, { user })).ok, false);
  assert.equal(seen.length, before);
  assert.equal((await TOOLS.account.run({ action: "error_help", error_code: "11133" }, { user })).ok, true);
  console.log(`错误词典：${codes.size} 个应用错误码、Agent 查询及诊断权限边界通过`);
} finally { pool.query = originalQuery; await pool.end(); }
