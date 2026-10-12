const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..', 'ooapi-web');
const ts = require(path.join(root, 'node_modules/typescript'));
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  cache.set(file, mod);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod.require = (id) => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id);
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  mod._compile(output, file);
  return mod.exports;
}
const icons = load(path.join(root, 'src/lib/vendorIcons.ts'));
const presets = load(path.join(root, 'src/lib/upstreamProviders.ts'));
const relayCallers = ['sub2api', 'new-api', 'one-api', 'cpa'];
const forbiddenProviderKeys = new Set([...relayCallers, 'newapi', 'oneapi', 'qq', 'wechat']);
for (const [key, meta] of Object.entries(icons.VENDORS)) {
  assert(!['qq', 'wechat', 'github', 'gitlab', 'gitee', 'discord', 'microsoft', 'x'].includes(key));
  if (meta.icon) assert(fs.existsSync(path.join(root, 'public/vendors', meta.icon)), `missing vendor icon: ${key}`);
}
for (const [key, meta] of Object.entries(icons.AUTH_PLATFORMS)) {
  assert(meta.icon, `missing auth platform icon: ${key}`);
  assert(fs.existsSync(path.join(root, 'public/vendors', meta.icon)), `missing auth platform icon: ${key}`);
}
for (const alias of ['sub2api', 'new-api', 'one-api', 'CPA']) {
  assert.equal(icons.canonicalVendor(alias), alias.toLowerCase(), `relay alias treated as vendor: ${alias}`);
}
for (const provider of presets.UPSTREAM_PROVIDERS) {
  assert(!relayCallers.includes(provider.key), `relay caller exposed as provider: ${provider.key}`);
  assert(!forbiddenProviderKeys.has(provider.key), `non-provider choice: ${provider.key}`);
  assert(icons.VENDORS[provider.key], `missing provider metadata: ${provider.key}`);
  assert(provider.connections.length > 0);
  for (const conn of provider.connections) {
    assert(!/\/(chat\/completions|messages|responses)$/.test(conn.baseURL), `endpoint suffix in base: ${provider.key}`);
    assert(!/^https?:\/\/(localhost|127\.|192\.168\.|10\.)/.test(conn.baseURL));
    if (conn.auth === 'device') {
      // 真实一键登录只对三个厂商开放（Cline / Kiro / WorkBuddy）；
      // 其余厂商的反代账号由管理员自行填写地址，不得伪装成设备授权。
      // 设备授权厂商由后端白名单决定（见 internal/handlers/device_bind.go 的 vendors 列表）。
      // 注意 provider.key 与 deviceVendor 不必同名：Grok 的厂商键是 xai，设备厂商是 grok。
      // 连接 id 与厂商名不必相同（Cline 的 id 是 cli、厂商是 cline），
      // 但 deviceVendor 必须落在后端设备白名单里，否则点下去会 400。
      assert(['cline', 'kiro', 'workbuddy', 'grok'].includes(conn.deviceVendor), `unexpected device vendor: ${conn.deviceVendor}`);
      assert(conn.baseURL, `device preset missing base URL: ${provider.key}`);
      assert(!conn.disabled, `device preset disabled: ${provider.key}`);
    }
  }
}
const devicePresets = presets.UPSTREAM_PROVIDERS.flatMap((provider) => provider.connections.filter((conn) => conn.auth === 'device'));
assert.equal(devicePresets.length, 4, 'device preset catalog is not truthful');
for (const vendor of ['cline', 'kiro', 'workbuddy', 'grok']) {
  assert(devicePresets.some((conn) => conn.deviceVendor === vendor), `missing device preset: ${vendor}`);
}
// 订阅登录（交互式 OAuth）：三个厂商各一条，与后端 UpstreamLoginVendorOfMethod 对齐。
const subscriptionPresets = presets.UPSTREAM_PROVIDERS.flatMap((provider) => provider.connections.filter((conn) => conn.auth === 'subscription'));
assert.equal(subscriptionPresets.length, 3, 'subscription preset catalog is not truthful');
for (const vendor of ['codex', 'claude-oauth', 'antigravity']) {
  assert(subscriptionPresets.some((conn) => conn.subscriptionVendor === vendor), `missing subscription preset: ${vendor}`);
}
assert(subscriptionPresets.every((conn) => conn.baseURL), 'subscription preset must pin the official upstream address');
const pageSource = fs.readFileSync(path.join(root, 'src/pages/admin/AdminChannels.tsx'), 'utf8');
assert(pageSource.includes('deviceVendor'), 'channels page does not pass the device vendor');
assert(pageSource.includes('deviceMethod'), 'channels page does not pass the device method');
for (const [model, expected] of [['glm-5.3','zhipu'], ['z-ai/glm-5.3','zhipu'], ['zai-org/GLM-4.6','zhipu'], ['~openai/gpt-5.5','openai'], ['anthropic/claude-sonnet','anthropic'], ['x-ai/grok-4.7','xai'], ['mimo-v2.6','mimo'], ['hy-4-preview','hunyuan']]) {
  assert.equal(icons.vendorOfModel(model), expected, model);
  assert(icons.vendorIconUrl(expected));
}
const page = fs.readFileSync(path.join(root, 'src/pages/admin/AdminChannels.tsx'), 'utf8');
assert(page.includes('<SortableDataTable<Channel>'));
assert(!page.includes('<article key={ch.id}'));
assert(page.includes('headers: draft.headers'));
assert(page.includes('model_paths: isLoginChannel ? "" : draft.modelPaths'));
assert(page.includes('<HoldToConfirm'));
console.log('PASS: provider choices, brand assets, normalized model icons, honest API/device/subscription presets, Arc account table and confirmation wiring');
