// 使用前端已有的 JSX 编译器和 React 服务端渲染，验证实际组件；不依赖数据库或浏览器。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { errorInfo } from "../src/services/error-codes.js";
const requireWeb = createRequire(new URL("../../ooapi-web/package.json", import.meta.url));
const React = requireWeb("react"), { renderToStaticMarkup } = requireWeb("react-dom/server");
const { transformSync } = requireWeb("esbuild");
const agents = JSON.parse(fs.readFileSync(new URL("../src/services/client-agents.json", import.meta.url), "utf8"));
const icon = () => React.createElement("i");
const controls = {
  Tooltip: ({ title, children }) => React.createElement("div", null, children, React.createElement("span", { className: "fixture-tooltip" }, title)),
  Alert: ({ message }) => React.createElement("p", null, message),
  Button: ({ children, ...props }) => React.createElement("button", { "aria-label": props["aria-label"], disabled: props.disabled }, children),
  Select: () => React.createElement("select"), Switch: () => React.createElement("input"), InputNumber: () => React.createElement("input"),
};
function component(name, extra = {}) {
  const source = fs.readFileSync(new URL(`../../ooapi-web/src/components/${name}.jsx`, import.meta.url), "utf8");
  const code = transformSync(source, { loader: "jsx", format: "cjs", target: "node18" }).code;
  const module = { exports: {} };
  const dependencies = {
    react: React, "./arc/index": controls, "./arc/icons": { RobotOutlined: icon, ArrowUpOutlined: icon, DeleteOutlined: icon, PlusOutlined: icon },
    "../../../ooapi-server/src/services/error-codes.js": { errorInfo },
    "../../../ooapi-server/src/services/client-agents.json": agents,
    "../services/reasoning-display": { reasoningLabel: value => value, requestedReasoningLabel: value => value },
    "./BrandLogo": { __esModule: true, default: () => React.createElement("img", { "data-brand-logo": "true", alt: "fixture-site-logo" }) },
    "../context/AppContext": { useApp: () => ({ status: { system_name: "Fixture Site" } }) },
    ...extra,
  };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: path => {
      if (path.endsWith(".css")) return {};
      assert(Object.hasOwn(dependencies, path), `unapproved frontend dependency: ${path}`);
      return dependencies[path];
    },
  }, { filename: `${name}.jsx` });
  return module.exports;
}
const Diagnostics = component("LogDiagnosticDetails").default;
const Badge = component("ClientAgentBadge").default;
const routing = component("AgentRoutingSettings", { "./ClientAgentBadge": { __esModule: true, default: Badge, CLIENT_AGENTS: agents } });
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test("all diagnostic sections and nested objects start closed for objects and JSON strings", () => {
  const detail = {
    code: "CHANNEL_BAD_REQUEST", endpoint_attempts: [{ protocol: "chat", endpoint: "/v1/chat/completions", status: 400 }],
    client_agent: { id: "codex", source: "user-agent", reported_client: { id: "opencode" } },
    model_calls: [{ model: "fixture" }], billing_details: { calls: [{ components: { input: { tokens: 0 } } }] },
    prompt_truncated: false, extra: { nested: { value: "<script>window.fixtureUnsafe=true</script>" } },
  };
  for (const value of [detail, JSON.stringify(detail)]) {
    const markup = render(Diagnostics, { value });
    assert((markup.match(/<details\b/g) || []).length >= 10);
    assert.doesNotMatch(markup, /<details\b[^>]*\bopen(?:=|\s|>)/);
    assert.match(markup, /故障与重试/);
    assert.match(markup, /计费与用量/);
    assert.match(markup, /查看 JSON/);
    assert.doesNotMatch(markup, /<script>/);
  }
});

test("unknown or disabled Agent stays hidden even if a stale caller requests unknown display", () => {
  for (const agent of [{}, { id: "arbitrary" }, { id: "", source: "disabled" }]) {
    assert.equal(render(Badge, { agent, showUnknown: true }), "");
  }
});

test("normalized Codex is shown; heuristic claims are qualified and relay stays the main badge", () => {
  const codex = render(Badge, { agent: { id: "codex", source: "user-agent", confidence: "heuristic", version: "0.123.0" } });
  assert.match(codex, /data-agent="codex"/);
  assert.match(codex, /codex\.svg/);
  assert.match(codex, /请求标记推测/);
  const relay = render(Badge, { agent: { id: "sub2api", source: "header", confidence: "declared", reported_client: { id: "codex", version: "0.123.0" } } });
  assert.match(relay, /data-agent="sub2api"/);
  assert.doesNotMatch(relay, /data-agent="codex"/);
  assert.match(relay, /请求标记的客户端：Codex 0\.123\.0/);
  assert.match(relay, /仅为请求声明/);
  const internal = render(Badge, { agent: { id: "ooapi", source: "internal", confidence: "internal" } });
  assert.match(internal, /Fixture Site/);
  assert.match(internal, /data-brand-logo="true"/);
});

test("old Agent settings default to empty bindings; editing rules preserves bindings and vice versa", () => {
  assert.equal(routing.routingValue({ version: 1, rules: [] }).bindings.length, 0);
  assert.equal(routing.routingValue({ version: 1, rules: [], bindings: {} }), null);
  let changed;
  const binding = { tokenId: 42, agent: "codex" };
  const rule = { id: "fixture-rule", agent: "opencode", enabled: false, models: [], preferredChannels: [], reasoning: "preserve", timeoutMs: null, retries: null };
  const config = { version: 1, rules: [rule], bindings: [binding] };
  const tree = routing.default({ value: config, onChange: next => { changed = next; } });
  const all = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    all.push(node); walk(node.props?.children);
  };
  walk(tree);
  all.find(node => node.props?.["aria-label"] === "添加 Agent 规则").props.onClick();
  assert.equal(changed.rules.length, 2);
  assert.equal(changed.bindings[0], binding);
  all.find(node => node.props?.["aria-label"] === "添加密钥绑定").props.onClick();
  assert.equal(changed.rules[0], rule);
  assert.equal(changed.bindings.length, 2);
  assert.equal(changed.bindings[1].tokenId, null);
  all.find(node => node.props?.["aria-label"] === "绑定 1 密钥编号").props.onChange(17);
  assert.equal(changed.bindings[0].tokenId, 17);
  assert.equal(changed.rules[0], rule);
  all.find(node => node.props?.["aria-label"] === "删除绑定 1").props.onClick();
  assert.equal(changed.bindings.length, 0);
  assert.equal(changed.rules[0], rule);
});
