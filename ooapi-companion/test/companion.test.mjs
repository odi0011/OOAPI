import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openWorkspace, sha256, spawnBounded, localDockerEndpoint, dockerCapability } from "../workspace.mjs";
import { createExecutor, validateServer, createApi } from "../runner.mjs";
import { createJournal } from "../journal.mjs";
import { main } from "../cli.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ooapi-local-test-"));
  const root = path.join(directory, "root"), state = path.join(directory, "state"), outside = path.join(directory, "outside");
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
  t.after(async () => { const absolute = path.resolve(directory); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(absolute, { recursive: true, force: true }); });
  return { root, state, outside };
}
test("真实文件 list/read/search；白名单根目录与符号链接不可逃逸", async t => {
  const { root, outside } = await fixture(t);
  await fs.writeFile(path.join(root, "hello.txt"), "第一行\n真实查询关键词\n"); await fs.writeFile(path.join(root, ".env"), "synthetic-fixture-only");
  await fs.mkdir(path.join(root, ".GIT")); await fs.writeFile(path.join(root, ".GIT", "config"), "关键词 synthetic-private-git-config");
  await fs.writeFile(path.join(outside, "outside.txt"), "not-in-workspace");
  await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const workspace = await openWorkspace(root);
  assert.deepEqual((await workspace.execute("list", {})).entries, [{ name: "hello.txt", type: "file" }]);
  const read = await workspace.execute("read", { path: "hello.txt" }); assert.equal(read.sha256, sha256(read.content));
  const searched = await workspace.execute("search", { query: "关键词" }); assert.equal(searched.matches[0].line, 2);
  assert.equal(searched.matches.length, 1, "大小写Git目录都不能被搜索");
  for (const relative of ["../outside/outside.txt", "escape/outside.txt", ".env", ".GIT/config", ".git/config", ".GiT/config", outside, "C:\\outside.txt", "hello.txt:stream"]) await assert.rejects(workspace.execute("read", { path: relative }), /工作区|符号链接|越界|受保护|相对/);
  await assert.rejects(workspace.execute("write", { path: "hello.txt", content: "bad", expectedSha256: read.sha256 }), /没有本地写入授权/);
});

test("真实CLI pair在联网及写device.json前拒绝项目内私有状态目录", async t => {
  const { root, outside } = await fixture(t), originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("配对不应发请求"); };
  try {
    const alias = path.join(outside, "state-parent-alias"); await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    for (const state of [root, path.join(root, "private-state"), path.join(alias, "private-state")]) {
      await assert.rejects(main(["pair", "--server", "https://example.invalid", "--root", root, "--state-dir", state]), /私有状态目录必须位于授权工作区之外/);
      await assert.rejects(fs.access(path.join(state, "device.json")), { code: "ENOENT" });
    }
    assert.equal(calls, 0, "本地私有目录被拒时不向云请求任何配对凭据");
  } finally { globalThis.fetch = originalFetch; }
});
test("写入/patch强制版本条件，新增排他；外部变化不覆盖", async t => {
  const { root } = await fixture(t), workspace = await openWorkspace(root, { allowWrite: true });
  await assert.rejects(workspace.execute("write", { path: "new.txt", content: "one" }), /expectedSha256/);
  const created = await workspace.execute("write", { path: "new.txt", content: "one", expectedSha256: null }); assert.equal(created.verified, true); assert.equal(created.sha256, sha256(await fs.readFile(path.join(root, "new.txt"))));
  const before = await workspace.execute("read", { path: "new.txt" });
  await workspace.execute("patch", { path: "new.txt", find: "one", replace: "two", expectedSha256: before.sha256 });
  assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "two");
  await assert.rejects(workspace.execute("write", { path: "new.txt", content: "bad", expectedSha256: before.sha256 }), /其他操作修改/);
  await assert.rejects(workspace.execute("write", { path: "new.txt", content: "bad", expectedSha256: null }), /其他操作修改/);
  const current = await workspace.execute("read", { path: "new.txt" });
  await assert.rejects(workspace.execute("patch", { path: "new.txt", find: "not-found", replace: "bad", expectedSha256: current.sha256 }), /恰好匹配一次/);
  await workspace.execute("patch", { path: "new.txt", patches: [{ find: "two", replace: "three" }, { find: "three", replace: "$& literal" }], expectedSha256: current.sha256 });
  assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "$& literal");
  const final = await workspace.execute("read", { path: "new.txt" });
  await assert.rejects(workspace.execute("patch", { path: "new.txt", patches: [{ find: "$&", replace: "changed" }, { find: "missing", replace: "bad" }], expectedSha256: final.sha256 }), /恰好匹配一次/);
  assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), final.content, "后续替换无效时整个patch不写入");
});

test("提交后真实读回核验；外部改动造成unknown，不误报未执行或成功", async t => {
  const { root, state } = await fixture(t), workspaceId = crypto.randomUUID();
  await fs.writeFile(path.join(root, "victim.txt"), "before");
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => { await originalRename(source, destination); if (destination === path.join(root, "victim.txt")) await fs.writeFile(destination, "external-after-commit"); };
  try {
    const executor = await createExecutor({ root, stateDirectory: state, workspaceId, allowWrite: true });
    const call = { workspaceId, callId: crypto.randomUUID(), action: "write", args: { path: "victim.txt", expectedSha256: sha256("before"), content: "requested" } };
    const result = await executor.execute(call); assert.equal(result.ok, false); assert.equal(result.outcome, "unknown"); assert.equal(result.uncertain, true);
    assert.equal(await fs.readFile(path.join(root, "victim.txt"), "utf8"), "external-after-commit");
    assert.deepEqual(await executor.execute(call), result, "未知副作用不会重放写入");
  } finally { fs.rename = originalRename; }
});
test("没有Docker配置绝不退回宿主机shell", async t => {
  const { root } = await fixture(t), workspace = await openWorkspace(root, { allowExec: true });
  assert.equal(workspace.capabilities.exec, false);
  await assert.rejects(workspace.execute("exec", { command: "echo must-not-run > marker.txt" }), /不会退回宿主机 shell/);
  await assert.rejects(fs.access(path.join(root, "marker.txt")));
});

test("Docker仅允许本机socket/pipe，远程UNC及网络端点在调用CLI前拒绝", async () => {
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine", "npipe://./pipe/dockerDesktopLinuxEngine"]) assert.equal(localDockerEndpoint(endpoint), true);
  const oldHost = process.env.DOCKER_HOST;
  try {
    for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://example.invalid", "unix://remote/var/run/docker.sock", "npipe:////remote/pipe/docker_engine", "npipe:////localhost/pipe/docker_engine", "npipe:////./pipe/../other", "unix:///var/run/docker.sock\n"]) {
      assert.equal(localDockerEndpoint(endpoint), false); process.env.DOCKER_HOST = endpoint;
      assert.deepEqual(await dockerCapability("fixture-installed-image", true), { available: false });
    }
  } finally { if (oldHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldHost; }
});
test("真实持久callId journal；重启不重写、不重跑未完成副作用", async t => {
  const { root, state } = await fixture(t), workspaceId = crypto.randomUUID();
  const options = { root, stateDirectory: state, workspaceId, allowWrite: true };
  const first = await createExecutor(options), call = { callId: crypto.randomUUID(), workspaceId, action: "write", args: { path: "once.txt", content: "one", expectedSha256: null } };
  const results = await Promise.all([first.execute(call), first.execute(call)]); assert.equal(results[0].ok, true); assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].outcome, "executed");
  const second = await createExecutor(options); assert.deepEqual(await second.execute(call), results[0]);
  assert.equal((await second.execute({ ...call, args: { ...call.args, content: "tampered" } })).ok, false);
  assert.equal(await fs.readFile(path.join(root, "once.txt"), "utf8"), "one");
  const interrupted = { callId: crypto.randomUUID(), workspaceId, action: "write", args: { path: "unknown.txt", content: "must-not-repeat", expectedSha256: null } };
  const journal = await createJournal(path.join(state, "calls", workspaceId));
  await journal.begin(interrupted.callId, sha256(JSON.stringify({ workspaceId, action: interrupted.action, args: interrupted.args })));
  const third = await createExecutor(options), uncertain = await third.execute(interrupted);
  assert.equal(uncertain.uncertain, true); assert.equal(uncertain.outcome, "unknown"); await assert.rejects(fs.access(path.join(root, "unknown.txt")));
  const recovered = await third.execute({ callId: crypto.randomUUID(), workspaceId, action: "result_get", args: { callId: call.callId } });
  assert.deepEqual(JSON.parse(recovered.output), { found: true, ...results[0] });
  const otherId = crypto.randomUUID(), other = await createExecutor({ ...options, workspaceId: otherId });
  const isolated = await other.execute({ callId: crypto.randomUUID(), workspaceId: otherId, action: "result_get", args: { callId: call.callId } }); assert.deepEqual(JSON.parse(isolated.output), { found: false });
});

test("命令实际先写后失败仍为executed；重启journal不重复副作用", async t => {
  const { root, state } = await fixture(t), workspaceId = crypto.randomUUID();
  // 注入仅用于验证runner协议：真实Node子进程写fixture后exit(7)，不冒充Docker验收。
  const workspaceFactory = async root => ({ root, capabilities: { read: true, write: true, exec: true }, execute: async action => {
    assert.equal(action, "exec");
    return spawnBounded(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], 'once\\n');process.exit(7)", path.join(root, "partial.txt")]);
  } });
  const options = { root, stateDirectory: state, workspaceId, workspaceFactory }, first = await createExecutor(options);
  const call = { workspaceId, callId: crypto.randomUUID(), action: "exec", args: { command: "fixture-partial-write-exit7" } };
  const failed = await first.execute(call); assert.equal(failed.ok, false); assert.equal(failed.outcome, "executed"); assert.equal(JSON.parse(failed.output).exitCode, 7);
  const second = await createExecutor(options); assert.deepEqual(await second.execute(call), failed);
  assert.equal(await fs.readFile(path.join(root, "partial.txt"), "utf8"), "once\n");
  const noExec = await createExecutor({ root, stateDirectory: state, workspaceId });
  const denied = await noExec.execute({ ...call, callId: crypto.randomUUID() }); assert.equal(denied.outcome, "not_executed");
});
test("代码/写入参数/模型文本的检查点仅保存本机私有目录", async t => {
  const { root, state } = await fixture(t), workspaceId = crypto.randomUUID(), executor = await createExecutor({ root, stateDirectory: state, workspaceId });
  const runId = crypto.randomUUID(), checkpoint = { runId, messages: [{ role: "assistant", content: "private-model-code" }], pending: { action: "write", args: { path: "code.js", content: "private-code" } } };
  const saved = await executor.execute({ callId: crypto.randomUUID(), workspaceId, action: "context_save", args: { runId, state: checkpoint } }); assert.equal(JSON.parse(saved.output).ref, runId);
  const loaded = await executor.execute({ callId: crypto.randomUUID(), workspaceId, action: "context_load", args: { runId } }); assert.deepEqual(JSON.parse(loaded.output), checkpoint);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(createExecutor({ root, stateDirectory: path.join(root, "state"), workspaceId }), /工作区之外/);
});

test("慢检查点提交不能在后来的新检查点之后覆盖；读取等待保存队列", async t => {
  const { root, state } = await fixture(t), workspaceId = crypto.randomUUID(), runId = crypto.randomUUID();
  const executor = await createExecutor({ root, stateDirectory: state, workspaceId }), destination = path.join(state, "contexts", `${workspaceId}-${runId}.json`), originalRename = fs.rename;
  fs.rename = async (source, target) => { if (target === destination && JSON.parse(await fs.readFile(source, "utf8")).version === 1) await new Promise(r => setTimeout(r, 50)); await originalRename(source, target); };
  try {
    const save = version => executor.execute({ workspaceId, callId: crypto.randomUUID(), action: "context_save", args: { runId, state: { version } } });
    const first = save(1), second = save(2), loaded = executor.execute({ workspaceId, callId: crypto.randomUUID(), action: "context_load", args: { runId } });
    await Promise.all([first, second]); assert.deepEqual(JSON.parse((await loaded).output), { version: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), { version: 2 });
  } finally { fs.rename = originalRename; }
});
test("HTTPS及固定来源，禁止凭据URL/公网HTTP/重定向", async () => {
  assert.equal(validateServer("https://example.invalid"), "https://example.invalid");
  for (const url of ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/path", "http://127.0.0.1:3001"]) assert.throws(() => validateServer(url));
  assert.equal(validateServer("http://127.0.0.1:3001", true), "http://127.0.0.1:3001");
  let calls = 0;
  const api = createApi("https://example.invalid", "synthetic-bearer-not-real", { fetchImpl: async (url, options) => { calls++; assert.equal(options.redirect, "error"); assert.equal(new URL(url).hostname, "example.invalid"); return new Response(JSON.stringify({ success: true, data: { okay: true } })); } });
  assert.deepEqual(await api("/runner/status"), { okay: true }); assert.equal(calls, 1);
});
test("原生进程限输出、超时和主动停止；不是shell字符串执行", async () => {
  const bounded = await spawnBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { outputLimit: 100 }); assert.equal(bounded.output.length, 100); assert.equal(bounded.truncated, true);
  const ctrl = new AbortController(), running = spawnBounded(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { signal: ctrl.signal, timeoutMs: 5000 }); setTimeout(() => ctrl.abort(), 40); assert.equal((await running).stopped, true);
  assert.equal((await spawnBounded(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 40 })).stopped, true);
});
