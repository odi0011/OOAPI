// 真运行会话归一化与策略合并；不初始化数据库或调用付费模型。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { normalizeHarnessBudget } from "../src/services/harness/runtime.js";

globalThis.__ooSessionPolicyFixture = { crypto, normalizeHarnessBudget };
const sessionSource = readFileSync(new URL("../src/services/harness/sessions.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const sessionPrelude = `const {crypto,normalizeHarnessBudget}=globalThis.__ooSessionPolicyFixture;
const pool={};const now=()=>123;const safeJSONParse=(value,fallback)=>{try{return JSON.parse(value)}catch{return fallback}};
const PLATFORM_TOOL_IDS=["models","pricing"];
`;
const sessions = await import(`data:text/javascript;base64,${Buffer.from(sessionPrelude + sessionSource).toString("base64")}`);
globalThis.__ooSessionPolicyFixture.sessions = sessions;
const policySource = readFileSync(new URL("../src/services/harness/policy.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const policyPrelude = `const {TOOL_IDS,MAX_STEPS_LIMIT}=globalThis.__ooSessionPolicyFixture.sessions;
const PLATFORM_TOOL_IDS=["models","pricing"];const getOption=()=>null;const setOption=async()=>{};
`;
const { agentPolicy, resolveSessionPolicySettings } = await import(`data:text/javascript;base64,${Buffer.from(policyPrelude + policySource).toString("base64")}`);
const { sanitizeSettings, sessionToResponse, DEFAULT_MAX_STEPS, MAX_STEPS_LIMIT } = sessions;

test("新会话默认96步，明确设置的旧12步保留，执行保护由服务端管理", () => {
  assert.equal(DEFAULT_MAX_STEPS, 96);
  assert.equal(sanitizeSettings().maxSteps, 96);
  assert.equal(sanitizeSettings({}, { previous: { maxSteps: 12 } }).maxSteps, 12);
  assert.equal(sessionToResponse({ settings: '{"maxSteps":12}' }).settings.maxSteps, 12);
  assert.equal(sanitizeSettings({ maxSteps: 1.9 }).maxSteps, 1);
  assert.equal(sanitizeSettings({ maxSteps: 999 }).maxSteps, MAX_STEPS_LIMIT);
});

test("用户步数与管理员上限取较小值，审批设定保留，旧用户预算不再生效", () => {
  const policy = agentPolicy();
  const requested = sanitizeSettings({ maxSteps: 1, permissionMode: "ask", instructions: "保持简短", budget: { maxModelCalls: 3 } });
  const effective = resolveSessionPolicySettings(requested, policy);
  assert.equal(effective.maxSteps, 1);
  assert.equal(effective.permissionMode, "ask");
  assert.equal(effective.instructions, "保持简短");
  assert.equal(effective.budget.maxModelCalls, 64, "已移除的任务预算不能继续限制普通对话");
  assert.equal(resolveSessionPolicySettings(sanitizeSettings({ maxSteps: 256 }), policy).maxSteps, 96);
  assert.equal(resolveSessionPolicySettings(sanitizeSettings({ maxSteps: 256 }), { ...policy, maxSteps: 7 }).maxSteps, 7);
  assert.equal(resolveSessionPolicySettings(sanitizeSettings({}, { previous: { maxSteps: 12 } }), policy).maxSteps, 12);
});

test("本次工具清单仅能收窄策略，不能增加被管理员禁用的能力", () => {
  const policy = { ...agentPolicy(), tools: ["account", "models"] };
  const requested = ["pricing", "models", "models", "invented-tool"];
  const effective = resolveSessionPolicySettings(sanitizeSettings({ tools: requested }), policy, { requestedTools: requested });
  assert.deepEqual(effective.tools, ["models"]);
  assert.deepEqual(policy.tools, ["account", "models"]);
  assert.deepEqual(requested, ["pricing", "models", "models", "invented-tool"]);
  assert.deepEqual(resolveSessionPolicySettings(sanitizeSettings(), policy, { requestedTools: [] }).tools, []);
  assert.deepEqual(resolveSessionPolicySettings(sanitizeSettings(), { ...policy, tools: [] }, { requestedTools: ["account"] }).tools, []);
});

test("历史隐藏 tools/search 不恢复，本次未提交工具时沿用当前管理员策略", () => {
  const policy = { ...agentPolicy(), tools: ["account", "models"] };
  const old = sanitizeSettings({}, { previous: { tools: [], search: false, maxSteps: 12 } });
  const effective = resolveSessionPolicySettings(old, policy);
  assert.deepEqual(effective.tools, policy.tools);
  assert.notEqual(effective.tools, policy.tools);
  assert.equal(effective.search, null);
  assert.equal(effective.maxSteps, 12);
  assert.deepEqual(resolveSessionPolicySettings(old, policy, { requestedTools: null }).tools, policy.tools);
});

test("HTTP入口实际使用本次工具参数并把当前策略上限写入元信息", () => {
  const chat = readFileSync(new URL("../src/routes/chat.js", import.meta.url), "utf8");
  assert.match(chat, /resolveSessionPolicySettings\(sessionSettings, policy, \{ requestedTools: settingsPatch\?\.tools \}\)/);
  assert.match(chat, /maxSteps: Math\.min\(DEFAULT_MAX_STEPS, policy\.maxSteps\), maxStepsLimit: policy\.maxSteps/);
  assert.match(chat, /tools: toolSpecs\(policy\.tools, req\.user\)/);
  assert.doesNotMatch(chat, /sanitizeSettings\(settingsPatch[^;]+\.\.\.agentPolicy\(\)/);
});
