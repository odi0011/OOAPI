// 真实构建产物与浏览器交互；所有API读写均为内存fixture，绝不访问DB、客户密钥或上游。
// BASE=候选地址；不传BASE则只启动静态dist服务器。截图默认写入系统TEMP。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { publicProviders } from "../src/services/channel-types.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.resolve(process.env.MODEL_SOURCE_DIST || path.join(repo, "ooapi-web/dist"));
const screenshots = process.env.MODEL_SOURCE_SCREENSHOTS || path.join(os.tmpdir(), `ooapi-model-source-ui-${Date.now()}`);
await mkdir(screenshots, { recursive: true });
let staticServer;
if (!process.env.BASE) {
  staticServer = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const requested = path.resolve(dist, "." + pathname);
      if (requested !== dist && !requested.startsWith(dist + path.sep)) { res.writeHead(404).end(); return; }
      const filename = path.extname(pathname) ? requested : path.join(dist, "index.html");
      const data = await readFile(filename);
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2" })[path.extname(filename)] || "application/octet-stream");
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
}
const BASE = (process.env.BASE || `http://127.0.0.1:${staticServer.address().port}`).replace(/\/$/, "");
const baseOrigin = new URL(BASE).origin;
const shared = "claude-sonnet-5";
const examples = [
  ["qwen/qwen3.6-235b", "cline", "qwen.png"],
  ["cohere/command-a", "cline", "cohere.png"],
  ["google/gemini-3.1-pro", "cline", "gemini.svg"],
  ["deepseek-flash", "opencode", "deepseek.png"],
  ["fledge-alpha", "opencode", null],
  [shared, "kiro", "claude.svg"],
  ["auto", "kiro", null],
];
const files = { cline: "cline.png", opencode: "opencode.png", kiro: "kiro.png", openai: "openai.svg" };
const vendors = ["cline", "kiro", "opencode"];
const labelSelector = (model) => `[data-model-name=${JSON.stringify(model)}]`;
const providers = publicProviders();
const recentLogs = (state) => [...state.logs.slice(0, 6), ...state.logs.slice(-2)];
let assertions = 0;
const results = [];
const check = (value, description) => { assert(value, description); assertions++; };
const same = (actual, expected, description) => { assert.deepEqual(actual, expected, description); assertions++; };

function fixture(theme) {
  const channels = [
    { id: 1, name: "Fixture Cline A", type: "cline", models: [...examples.filter((x) => x[1] === "cline").map((x) => x[0]), shared] },
    { id: 2, name: "Fixture OpenCode", type: "opencode", models: [...examples.filter((x) => x[1] === "opencode").map((x) => x[0]), shared] },
    { id: 3, name: "Fixture Kiro", type: "kiro", models: [shared, "auto"] },
    { id: 4, name: "Fixture Cline B", type: "cline", models: [examples[0][0], shared] },
    { id: 5, name: "Fixture Outside OpenAI", type: "openai", models: [shared, examples[0][0], "outside-only-model"] },
    { id: 6, name: "Fixture Resolved Cline", type: "cline", models: ["gpt-*"], model_vendors: { "server-resolved-qwen": ["cline"] } },
    { id: 7, name: "Fixture Alias OpenCode", type: "opencode", models: ["gpt-5.6-luna-thinking"], model_vendors: { "gpt-5.6-luna": ["opencode"] } },
  ].map((row) => ({ ...row, typeName: providers.find((p) => p.key === row.type)?.name || row.type, status: 1, isApiKey: true, method: "api", methodLabel: "API Key", base_url: "https://fixture.invalid/v1", priority: 0, weight: 1, auto_ban: true, groups: row.id === 5 ? ["Outside group"] : ["Source matrix"], recent: [] }));
  const groupRows = [
    { id: 21, name: "Source matrix", channel_ids: [1, 2, 3, 4], models: [shared, ...examples.filter((x) => x[0] !== shared).map((x) => x[0])], rate: 1 },
    { id: 22, name: "Outside group", channel_ids: [5], models: [shared, "outside-only-model"], rate: 1 },
    { id: 23, name: "Resolved wildcard", channel_ids: [6], models: ["server-resolved-qwen"], rate: 1 },
    { id: 24, name: "Canonical alias", channel_ids: [7], models: ["gpt-5.6-luna"], rate: 1 },
  ];
  const sources = (group) => {
    const map = {};
    for (const c of channels.filter((c) => group.channel_ids.includes(c.id))) for (const model of [...c.models.filter((m) => !m.includes("*")), ...Object.keys(c.model_vendors || {})]) map[model] = [...new Set([...(map[model] || []), c.type])].sort();
    return map;
  };
  const groups = () => groupRows.map((g) => ({ ...g, channel_ids: [...g.channel_ids], models: [...g.models], vendors: [...new Set(channels.filter((c) => g.channel_ids.includes(c.id)).map((c) => c.type))].sort(), model_vendors: sources(g), remark: "Isolated source fixture" }));
  const logs = [
    ...examples.map(([model, channel_type], index) => ({ id: index + 100, model, channel_type, source_vendors: [channel_type] })),
    { id: 150, model: "gpt-5.6-luna", channel_type: "cline", source_vendors: ["opencode", "cline", "cline"] },
    { id: 151, model: "gpt-no-source-fixture", channel_type: "cline", source_vendors: [] },
  ].map((row) => ({ ...row, type: 2, status: "success", quota: 1, units: 1, created_at: 1780000000, prompt_tokens: 100, completion_tokens: 10, cache_tokens: 20, elapsed_ms: 1000, first_token_ms: 200, user_id: 1, username: "source-ui-fixture", group_name: "Source matrix", input_text: "Fixture input", output_text: "Fixture output", input_recorded: true, output_recorded: true, billing_known: true }));
  const models = channels.filter((c) => c.id <= 3).flatMap((c) => c.models.map((id) => ({ id, label: id, vendor: c.type, supportsThinking: true, supportsVision: false, supportsSearch: false })));
  const session = { id: "source-ui-session", title: "Source icon fixture", agent: "general", model: examples[0][0], settings: { channelType: "cline", tools: [] }, todo: [], pinned: false, archived: false, created_at: 1780000000, updated_at: 1780000000 };
  const status = { system_name: "OOAPI fixture", units_per_od: 10000, default_theme: theme, default_collapse_sidebar: true, expose_pricing_to_user: true,
    user_data_visibility: { version: 1, balance: true, usage_summary: true, usage_records: true, request_content: true, pricing: true },
    appearance: { mode: theme, accent: "#3b6ef5", background: "pure", radius: "default", density: "compact", font_size: 13, font_family: "system", user_custom: false } };
  const counts = { groupSaves: 0, chatSaves: 0, upstreamLists: 0 };
  return { channels, groups, groupRows, logs, models, session, status, counts, userRole: 1000, pendingModelReads: [] };
}

async function installFixtures(context, state, violations) {
  await context.addInitScript(() => { localStorage.clear(); localStorage.setItem("ooapi-token", "isolated-model-source-ui"); });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    if (url.origin !== baseOrigin || pathname.startsWith("/v1") || pathname.startsWith("/v1beta")) {
      violations.push(`Blocked ${method} ${pathname}`); await route.abort(); return;
    }
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET") { violations.push(`Blocked non-API write ${method} ${pathname}`); await route.abort(); return; }
      await route.continue(); return;
    }
    let data;
    if (method === "PUT" && /^\/api\/channel\/groups\/\d+$/.test(pathname)) {
      const body = request.postDataJSON(), group = state.groupRows.find((g) => g.id === Number(pathname.split("/").at(-1)));
      assert(group, "Only existing in-memory groups may be saved");
      Object.assign(group, { name: body.name, models: [...body.models], channel_ids: body.channel_ids.map(Number), rate: body.rate, vendor: body.type });
      state.counts.groupSaves++; data = { id: group.id };
    } else if (method === "POST" && /^\/api\/channel\/\d+\/upstream-models$/.test(pathname)) {
      const channel = state.channels.find((c) => c.id === Number(pathname.split("/")[3]));
      assert(channel, "Model list fixture must reference a fixture channel");
      state.counts.upstreamLists++; data = { models: channel.models, source: "upstream" };
    } else if (method === "POST" && pathname === "/api/channel/fetch-models") {
      // 只读列表请求也完全留在内存；让旧请求在切换厂商后才返回，实际验证异步竞态。
      const body = request.postDataJSON();
      data = await new Promise((resolve) => state.pendingModelReads.push({ body, resolve }));
    } else if (method === "PUT" && pathname === `/api/chat/sessions/${state.session.id}`) {
      const body = request.postDataJSON(); Object.assign(state.session, body); state.counts.chatSaves++; data = { session: state.session };
    } else if (method !== "GET") {
      violations.push(`Blocked API write ${method} ${pathname}`);
      await route.fulfill({ status: 403, json: { success: false, message: "Only explicitly configured in-memory fixture writes are allowed" } }); return;
    } else if (pathname === "/api/status") data = state.status;
    else if (pathname === "/api/user/self") data = { id: 1, username: "source-ui-fixture", display_name: "Fixture user", role: state.userRole, status: 1, quota: 10000, group_name: "Source matrix" };
    else if (pathname === "/api/channel/providers") data = providers;
    else if (pathname === "/api/channel/" || pathname === "/api/channel") data = state.channels;
    else if (pathname === "/api/channel/groups" || pathname === "/api/token/groups") data = state.groups();
    else if (pathname === "/api/channel/stats") data = { total: state.channels.length, enabled: state.channels.length, disabled: 0, byType: {} };
    else if (pathname === "/api/channel/devices/vendors") data = { vendors: [], methods: [] };
    else if (pathname === "/api/channel/oauth/info") data = { supported: false };
    else if (pathname === "/api/token/" || pathname === "/api/token") data = [{ id: 81, name: "Fixture token", status: 1, group: "Source matrix", group_name: "Source matrix", unlimited_quota: true, remain_quota: 10000, used_quota: 0, expired_time: -1, created_time: 1780000000 }];
    else if (pathname === "/api/log/usage") data = { items: state.logs, total: state.logs.length };
    else if (pathname === "/api/log/usage/summary") data = { calls: 9, units: 9, prompt_tokens: 900, completion_tokens: 90, cache_tokens: 180, cache_rate: 20, avg_elapsed: 1000, avg_first_token: 200 };
    else if (pathname === "/api/log/usage/analysis") data = { byDay: [], byModel: [], modelSeries: [], hourly: [] };
    else if (pathname === "/api/log/usage/filters") data = { models: [], tokens: [], groups: [] };
    else if (pathname === "/api/dashboard/self") data = { account: { quota: 10000, used_quota: 9, active_tokens: 1, total_tokens: 1, group_name: "Source matrix" }, recent_logs: recentLogs(state), range: { days: 30 } };
    else if (pathname === "/api/pricing/public") data = { items: [...examples.map(([model, , vendorFile]) => ({ model, vendor: vendorFile ? "cline" : "", input: 1, output: 2, cache: .1 })), { model: "new-catalog-fixture", vendor: "nvidia", input: 1, output: 2, cache: .1 }] };
    else if (pathname === "/api/pricing/pending") data = { count: 0, items: [] };
    else if (pathname.endsWith("/unread")) data = { total: 0, count: 0 };
    else if (pathname === "/api/chat/meta") data = { models: state.models, vendors: vendors.map((vendor) => ({ vendor, vendorName: vendor, models: state.models.filter((m) => m.vendor === vendor) })), keys: [{ id: 81, name: "Fixture token", group_name: "Source matrix", status: 1, usable: true }], active_key_id: 81, defaults: { agent: "general" }, agents: [{ id: "general", name: "通用助手" }] };
    else if (pathname === "/api/chat/sessions") data = { sessions: [state.session], counts: { active: 1, archived: 0, byProject: {} } };
    else if (pathname === "/api/chat/projects") data = { projects: [] };
    else if (pathname === `/api/chat/sessions/${state.session.id}`) data = { session: state.session, messages: [] };
    else if (pathname === `/api/chat/sessions/${state.session.id}/running`) data = { running: false };
    else { violations.push(`Unconfigured read ${pathname}`); await route.fulfill({ status: 404, json: { success: false, message: "No fixture for this read" } }); return; }
    await route.fulfill({ json: { success: true, data } });
  });
}

async function verifyImages(scope, expectedFiles, description) {
  await scope.scrollIntoViewIfNeeded();
  const images = scope.locator("img");
  same(await images.evaluateAll((nodes) => nodes.map((img) => new URL(img.src).pathname).sort()), expectedFiles.map((file) => `/icons/${file}`).sort(), `${description}: actual image sources`);
  if (expectedFiles.length) {
    await scope.evaluate(async (node) => {
      await Promise.all([...node.querySelectorAll("img")].map((img) => img.complete && img.naturalWidth > 0 ? undefined : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Source icon did not load")), 8000);
        const finish = () => { clearTimeout(timer); img.removeEventListener("load", finish); img.removeEventListener("error", finish); img.naturalWidth > 0 ? resolve() : reject(new Error("Broken source icon")); };
        img.addEventListener("load", finish); img.addEventListener("error", finish);
      })));
    });
    check(await images.evaluateAll((nodes) => nodes.every((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)), `${description}: decoded images`);
  } else check(await scope.locator('[aria-label="来源未标注"]').count() === 1, `${description}: neutral unknown source`);
}
async function verifyLabel(scope, model, expected, description, catalog = false) {
  const label = scope.locator(labelSelector(model)).first();
  await label.waitFor({ state: "visible" });
  same(await label.getAttribute("data-model-sources"), catalog ? "catalog" : [...new Set(expected)].sort().join(","), `${description}: source metadata`);
  await verifyImages(label, catalog ? expected.filter(Boolean) : [...new Set(expected)].map((v) => files[v]), description);
}
function field(scope, label) {
  return scope.locator(".ant-form-item").filter({ has: scope.page().locator(".ant-form-item-label").getByText(label, { exact: true }) }).first().locator(".ant-select").first();
}
async function findModelOption(page, select, model) {
  await openSelect(select);
  await select.getByRole("combobox").fill(model);
  const option = page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ has: page.locator(labelSelector(model)) }).first();
  await option.waitFor({ state: "visible" }); return option;
}
async function openSelect(select) {
  // 选择框中心可能正好落在已选标签的×上；用真实键盘聚焦/展开避免误删模型。
  const input = select.getByRole("combobox");
  await input.focus(); await input.press("ArrowDown");
}
async function closeOptions(page) {
  // 点弹窗内侧留白：标题在手机长表单里会离屏，字段标签可能被向上展开的下拉遮挡。
  // 位置取当前真实几何交集，不点击mask、不force点击、更不改DOM来关闭控件。
  const dialog = page.getByRole("dialog"), box = await dialog.locator(".ant-modal-content").boundingBox(), viewport = page.viewportSize();
  assert(box, "Modal content must exist before closing its model menu");
  const top = Math.max(6, box.y + 6), bottom = Math.min(viewport.height - 6, box.y + box.height - 6);
  assert(bottom > top && box.x + 6 >= 0 && box.x + 6 < viewport.width, "Modal inner padding must be visible");
  await page.mouse.click(box.x + 6, (top + bottom) / 2);
  await page.locator(".ant-select-dropdown:visible").waitFor({ state: "hidden" });
  assert(await dialog.isVisible(), "Closing a model menu must leave its parent modal open");
}
async function screenshot(page, name) { await page.screenshot({ path: path.join(screenshots, name + ".png"), fullPage: true, animations: "disabled" }); }

async function groupFlow(page, state, variant) {
  await page.goto(`${BASE}/admin/groups`, { waitUntil: "networkidle" });
  const row = () => page.locator("tr.ant-table-row").filter({ hasText: "Source matrix" });
  await verifyLabel(row(), shared, vendors, "group table multi-source");
  await verifyLabel(page.locator("tr.ant-table-row").filter({ hasText: "Outside group" }), shared, ["openai"], "same model in another group keeps its own source");
  await row().locator(labelSelector(shared)).hover();
  const tip = page.locator(".ant-tooltip:visible").filter({ has: page.locator(labelSelector(examples[0][0])) }).first();
  await tip.waitFor({ state: "visible" });
  for (const [model, source] of examples) await verifyLabel(tip, model, model === shared ? vendors : [source], `group tooltip ${model}`);
  await page.mouse.move(0, 0); await page.keyboard.press("Escape");
  await row().getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog"), modelSelect = field(dialog, "支持的模型"), memberSelect = field(dialog, "包含哪些账号");
  for (const [model, source] of examples) {
    await verifyLabel(modelSelect, model, model === shared ? vendors : [source], `group selected ${model}`);
    const option = await findModelOption(page, modelSelect, model);
    await verifyLabel(option, model, model === shared ? vendors : [source], `group option ${model}`); await closeOptions(page);
  }
  await screenshot(page, `${variant}-group-all-sources`);
  const removeMember = async (name) => {
    await memberSelect.locator(".ant-select-selection-item").filter({ hasText: name }).locator(".ant-select-selection-item-remove").click();
  };
  await removeMember("Fixture Kiro");
  await verifyLabel(modelSelect, shared, ["cline", "opencode"], "remove Kiro updates selected model immediately");
  check(await modelSelect.locator(labelSelector("auto")).count() === 0, "Removing the only auto channel removes its selected model");
  await removeMember("Fixture Cline B");
  await verifyLabel(modelSelect, shared, ["cline", "opencode"], "remove duplicate vendor keeps one Cline icon");
  await removeMember("Fixture Cline A");
  await verifyLabel(modelSelect, shared, ["opencode"], "remove last Cline immediately removes Cline source");
  check(await modelSelect.locator(labelSelector(examples[0][0])).count() === 0, "Removing last Qwen source prunes Qwen selection");
  const option = await findModelOption(page, modelSelect, shared);
  await verifyLabel(option, shared, ["opencode"], "updated model option source"); await closeOptions(page);
  await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
  await dialog.waitFor({ state: "hidden" });
  same(state.groupRows[0].channel_ids, [2], "Group save only changes the in-memory selected channel");
  await verifyLabel(row(), shared, ["opencode"], "group table reflects saved source");
  await page.reload({ waitUntil: "networkidle" });
  await verifyLabel(row(), shared, ["opencode"], "group refresh preserves saved source");
  await row().getByRole("button", { name: "编辑", exact: true }).click();
  await verifyLabel(field(dialog, "支持的模型"), shared, ["opencode"], "group reopened selected source");
  for (const name of ["Fixture Cline A", "Fixture Kiro", "Fixture Cline B"]) {
    const selected = field(dialog, "包含哪些账号"); await openSelect(selected); await selected.getByRole("combobox").fill(name);
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: name }).first().click(); await closeOptions(page);
  }
  await dialog.getByRole("button", { name: /^全\s*选$/ }).click();
  await verifyLabel(field(dialog, "支持的模型"), shared, vendors, "reselect channels restores all different sources");
  const restored = field(dialog, "支持的模型");
  await openSelect(restored);
  await restored.getByRole("combobox").fill("outside-only-model");
  await page.waitForTimeout(100);
  check(await page.locator(".ant-select-dropdown:visible .ant-select-item-option").count() === 0, "Unselected outside-group model cannot enter the candidate list");
  await closeOptions(page);
  await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
  await dialog.waitFor({ state: "hidden" });
  await verifyLabel(row(), "auto", ["kiro"], "saved restored group table uses the selected model's actual source");
  await row().locator(labelSelector("auto")).hover();
  await verifyLabel(page.locator(".ant-tooltip:visible").filter({ has: page.locator(labelSelector(shared)) }).first(), shared, vendors, "saved restored group source, without outside OpenAI pollution");
  await page.mouse.move(0, 0);
  await page.reload({ waitUntil: "networkidle" });
  await verifyLabel(row(), "auto", ["kiro"], "refreshed restored group table source");
  await row().locator(labelSelector("auto")).hover();
  await verifyLabel(page.locator(".ant-tooltip:visible").filter({ has: page.locator(labelSelector(shared)) }).first(), shared, vendors, "refreshed restored group multiple sources");
  await page.mouse.move(0, 0);
  same(state.counts.groupSaves, 2, "Both group membership changes were saved only in memory");
  const wildcardRow = page.locator("tr.ant-table-row").filter({ hasText: "Resolved wildcard" });
  await verifyLabel(wildcardRow, "server-resolved-qwen", ["cline"], "wildcard uses only explicit backend resolved metadata");
  await wildcardRow.getByRole("button", { name: "编辑", exact: true }).click();
  const wildcardSelect = field(dialog, "支持的模型");
  await verifyLabel(wildcardSelect, "server-resolved-qwen", ["cline"], "wildcard selected explicit source");
  const wildcardOption = await findModelOption(page, wildcardSelect, "server-resolved-qwen");
  await verifyLabel(wildcardOption, "server-resolved-qwen", ["cline"], "wildcard resolved option source");
  await closeOptions(page);
  await openSelect(wildcardSelect); await wildcardSelect.getByRole("combobox").fill("gpt-");
  await page.waitForTimeout(100);
  check(await page.locator(".ant-select-dropdown:visible .ant-select-item-option").count() === 0, "Wildcard literal and manufacturer guesses are absent from model options");
  await closeOptions(page);
  const addUnrelated = async () => {
    const members = field(dialog, "包含哪些账号");
    await openSelect(members); await members.getByRole("combobox").fill("Fixture Kiro");
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "Fixture Kiro" }).first().click(); await closeOptions(page);
  };
  const removeUnrelated = async () => field(dialog, "包含哪些账号").locator(".ant-select-selection-item").filter({ hasText: "Fixture Kiro" }).locator(".ant-select-selection-item-remove").click();
  await addUnrelated();
  await verifyLabel(wildcardSelect, "server-resolved-qwen", ["cline"], "adding an unrelated channel preserves the resolved wildcard selection");
  await removeUnrelated();
  await verifyLabel(wildcardSelect, "server-resolved-qwen", ["cline"], "removing an unrelated channel preserves the resolved wildcard selection");
  await dialog.getByRole("button", { name: /^保\s*存$/ }).click(); await dialog.waitFor({ state: "hidden" });
  same(state.groupRows.find((g) => g.id === 23).models, ["server-resolved-qwen"], "Wildcard membership edits persist the legitimate resolved model");
  await page.reload({ waitUntil: "networkidle" });
  await verifyLabel(wildcardRow, "server-resolved-qwen", ["cline"], "wildcard resolved model survives save and refresh");

  const aliasRow = page.locator("tr.ant-table-row").filter({ hasText: "Canonical alias" });
  await verifyLabel(aliasRow, "gpt-5.6-luna", ["opencode"], "canonical table model uses its backend-confirmed channel");
  await aliasRow.getByRole("button", { name: "编辑", exact: true }).click();
  const aliasSelect = field(dialog, "支持的模型");
  await verifyLabel(aliasSelect, "gpt-5.6-luna", ["opencode"], "canonical selected label differs from raw thinking alias but retains its source");
  const aliasOption = await findModelOption(page, aliasSelect, "gpt-5.6-luna");
  await verifyLabel(aliasOption, "gpt-5.6-luna", ["opencode"], "canonical option reads confirmed backend mapping"); await closeOptions(page);
  await addUnrelated();
  await verifyLabel(aliasSelect, "gpt-5.6-luna", ["opencode"], "adding unrelated channel does not prune canonical alias model");
  await removeUnrelated();
  await verifyLabel(aliasSelect, "gpt-5.6-luna", ["opencode"], "removing unrelated channel does not prune canonical alias model");
  await dialog.getByRole("button", { name: /^保\s*存$/ }).click(); await dialog.waitFor({ state: "hidden" });
  same(state.groupRows.find((g) => g.id === 24).models, ["gpt-5.6-luna"], "Canonical model is preserved when membership changes are saved");
  await page.reload({ waitUntil: "networkidle" });
  await verifyLabel(aliasRow, "gpt-5.6-luna", ["opencode"], "canonical source persists after save and refresh");
  same(state.counts.groupSaves, 4, "Four fixture-only group saves cover regular, wildcard and alias selections");
}

async function channelRaceFlow(page, state, variant) {
  await page.getByRole("button", { name: "添加渠道" }).click();
  const dialog = page.getByRole("dialog");
  const pickProvider = async (vendor) => {
    await dialog.getByRole("button", { name: `选择厂商 ${providers.find((p) => p.key === vendor).name}`, exact: true }).click();
    await dialog.locator(".ant-radio-button-wrapper").filter({ hasText: "API Key" }).first().click();
  };
  const keyInput = () => dialog.locator('input[type="password"]').first();
  const fetchList = () => dialog.getByRole("button", { name: /从上游获取模型/ });
  const waitForRead = async (count) => {
    for (let n = 0; n < 100 && state.pendingModelReads.length < count; n++) await page.waitForTimeout(20);
    same(state.pendingModelReads.length, count, "Expected in-memory model request was sent");
  };
  await pickProvider("openai"); await keyInput().fill("fixture-only-old"); await fetchList().click(); await waitForRead(1);
  await pickProvider("opencode"); await keyInput().fill("fixture-only-current"); await fetchList().click(); await waitForRead(2);
  same(state.pendingModelReads.map((r) => r.body.type), ["openai", "opencode"], "Both delayed reads use the actual selected provider");
  state.pendingModelReads[0].resolve({ models: ["stale-openai-model"], source: "upstream", clineGroups: { total: 1, tiers: [{ key: "stale", label: "STALE GROUP", count: 1, models: ["stale-openai-model"] }], groups: [] } });
  await page.waitForTimeout(150);
  check(await fetchList().getAttribute("class").then((s) => s.includes("ant-btn-loading")), "Late old response cannot stop the current list loading indicator");
  check(await dialog.getByText("STALE GROUP").count() === 0, "Late old response cannot restore old grouping");
  state.pendingModelReads[1].resolve({ models: ["fledge-alpha"], source: "upstream" });
  await verifyLabel(field(dialog, "模型范围"), "fledge-alpha", ["opencode"], "current provider response uses its actual source");
  check(await dialog.locator(labelSelector("stale-openai-model")).count() === 0, "Old list did not populate the current form");
  const option = await findModelOption(page, field(dialog, "模型范围"), "fledge-alpha");
  await verifyLabel(option, "fledge-alpha", ["opencode"], "current provider dropdown after late response"); await closeOptions(page);
  await pickProvider("openai");
  check(await dialog.locator(labelSelector("fledge-alpha")).count() === 0, "Provider switch clears the prior selected models");
  const cleared = field(dialog, "模型范围");
  await openSelect(cleared); await page.waitForTimeout(100);
  check(await page.locator(".ant-select-dropdown:visible [data-model-name]").count() === 0, "Provider switch also clears previously fetched dropdown options");
  await closeOptions(page);
  await keyInput().fill("fixture-only-third"); await fetchList().click(); await waitForRead(3);
  // 凭据变更也应让在途清单失效，不能只覆盖切换已保存channelId的旧路径。
  await keyInput().fill("fixture-only-fourth");
  state.pendingModelReads[2].resolve({ models: ["stale-key-model"], source: "upstream" });
  await page.waitForTimeout(150);
  check(await dialog.locator(labelSelector("stale-key-model")).count() === 0, "Late response for changed credentials cannot select old models");
  check(!await fetchList().getAttribute("class").then((s) => s.includes("ant-btn-loading")), "Credential switch clears stale loading state");
  await screenshot(page, `${variant}-channel-source-race`);
  await dialog.getByRole("button", { name: /^取\s*消$/ }).click(); await dialog.waitFor({ state: "hidden" });
}

async function channelFlow(page, state, variant) {
  await page.goto(`${BASE}/admin/channel`, { waitUntil: "networkidle" });
  for (const channel of state.channels.filter((c) => c.id <= 3)) {
    await page.getByRole("button", { name: `${channel.name} 编辑`, exact: true }).click();
    const dialog = page.getByRole("dialog"), select = field(dialog, "模型范围");
    for (const model of channel.models) {
      await verifyLabel(select, model, [channel.type], `channel selected ${model}`);
      const option = await findModelOption(page, select, model);
      await verifyLabel(option, model, [channel.type], `channel option ${model}`); await closeOptions(page);
    }
    await screenshot(page, `${variant}-channel-${channel.type}`);
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click(); await dialog.waitFor({ state: "hidden" });
  }
}

async function tokenFlow(page, variant, width) {
  await page.goto(`${BASE}/token`, { waitUntil: "networkidle" });
  if (width >= 1024) {
    const row = page.locator("tr.ant-table-row").filter({ hasText: "Fixture token" });
    await verifyLabel(row, "auto", ["kiro"], "token model table sources");
    await row.locator(labelSelector("auto")).hover();
    const tip = page.locator(".ant-tooltip:visible").filter({ has: page.locator(labelSelector(examples[0][0])) }).first();
    for (const [model, source] of examples) await verifyLabel(tip, model, model === shared ? vendors : [source], `token model tooltip ${model}`);
    await page.mouse.move(0, 0);
  }
  await screenshot(page, `${variant}-token-models`);
}

async function usageFlow(page, state, variant) {
  await page.goto(`${BASE}/log`, { waitUntil: "networkidle" });
  for (const record of state.logs) {
    const row = page.getByRole("button", { name: `查看 ${record.model} 详情`, exact: true });
    await verifyLabel(row, record.model, record.source_vendors, `usage row ${record.model}`);
    await row.click();
    const drawer = page.locator(".ant-drawer:visible");
    await verifyLabel(drawer, record.model, record.source_vendors, `usage drawer ${record.model}`);
    if (record.id === 150) await screenshot(page, `${variant}-usage-multiple-sources`);
    await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" });
  }
  await page.goto(`${BASE}/console`, { waitUntil: "networkidle" });
  for (const record of recentLogs(state)) await verifyLabel(page.locator(".oo-dashboard-table"), record.model, record.source_vendors, `console recent ${record.model}`);
  await screenshot(page, `${variant}-console-recent`);
}

async function catalogFlow(page, variant) {
  await page.goto(`${BASE}/pricing`, { waitUntil: "networkidle" });
  for (const [model, , file] of examples) await verifyLabel(page.locator(".ant-table"), model, file ? [file] : [], `catalog original ${model}`, true);
  await verifyLabel(page.locator(".ant-table"), "new-catalog-fixture", ["nvidia.png"], "catalog unknown name uses explicit manufacturer metadata", true);
  await screenshot(page, `${variant}-catalog-original`);
}

async function chatFlow(page, state, variant) {
  await page.goto(`${BASE}/chat?s=${state.session.id}`, { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: "选择模型", exact: true });
  await trigger.waitFor({ state: "visible" });
  for (const model of state.models) {
    await trigger.click();
    const group = page.locator(".bui-modelgroup").filter({ has: page.locator(`.bui-modelgroup-head img[alt=${JSON.stringify(model.vendor)}]`) });
    const option = group.locator(`button[title=${JSON.stringify(model.id)}]`);
    await verifyImages(option, [files[model.vendor]], `chat picker ${model.vendor}/${model.id}`);
    await option.click();
    await verifyImages(trigger, [files[model.vendor]], `chat selected ${model.vendor}/${model.id}`);
    // PUT由内存fixture处理，不能用本地显示通过掩盖保存错源。
    for (let n = 0; n < 60 && (state.session.model !== model.id || state.session.settings.channelType !== model.vendor); n++) await page.waitForTimeout(50);
    same([state.session.model, state.session.settings.channelType], [model.id, model.vendor], "Chat selection saves the actual source to the memory fixture");
  }
  await trigger.click(); await screenshot(page, `${variant}-chat-picker`); await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await verifyImages(page.getByRole("button", { name: "选择模型", exact: true }), [files[state.session.settings.channelType]], "chat reload selected source");
}

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const combinations = [["desktop-light", 1440, "light"], ["desktop-dark", 1440, "dark"], ["mobile-light", 390, "light"], ["mobile-dark", 390, "dark"]];
  const selected = process.env.MODEL_SOURCE_VARIANT ? combinations.filter(([variant]) => variant === process.env.MODEL_SOURCE_VARIANT) : combinations;
  assert(selected.length, "MODEL_SOURCE_VARIANT must name one of the four supported variants");
  for (const [variant, width, theme] of selected) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 }, colorScheme: theme });
    const state = fixture(theme), violations = [], errors = [], before = assertions;
    await installFixtures(context, state, violations);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { errors.push(`Native dialog ${dialog.type()}`); void dialog.dismiss(); });
    try {
      await groupFlow(page, state, variant);
      await channelFlow(page, state, variant);
      await channelRaceFlow(page, state, variant);
      state.userRole = 1;
      await tokenFlow(page, variant, width);
      await usageFlow(page, state, variant);
      await catalogFlow(page, variant);
      await chatFlow(page, state, variant);
      check(await page.evaluate((value) => document.documentElement.dataset.theme === value, theme), `${variant}: actual requested theme`);
      same(violations, [], `${variant}: no unapproved requests or real API traffic`);
      same(errors, [], `${variant}: no native dialog or runtime error`);
      const result = { variant, assertions: assertions - before, ...state.counts, delayedModelReads: state.pendingModelReads.length, bundle: await page.locator('script[type="module"]').getAttribute("src") };
      results.push(result); console.log(`MODEL_SOURCE_UI_VARIANT_PASS ${JSON.stringify(result)}`);
    } catch (error) {
      await screenshot(page, `${variant}-failure`).catch(() => {});
      throw new Error(`${variant}: ${error.message}`, { cause: error });
    } finally { await context.close(); }
  }
  await writeFile(path.join(screenshots, "summary.json"), JSON.stringify({ assertions, failures: 0, results }, null, 2));
  console.log(`MODEL_SOURCE_UI_PASS: ${assertions} assertions, failures=0; API/DB/upstream writes=0, screenshots=${screenshots}`);
} finally {
  await browser?.close();
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
}
