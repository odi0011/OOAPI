// 在临时安装目录模拟完整 updater：既验证私有运行数据保护，也验证失败后的源码回滚。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const originalExec = childProcess.execFile;
const originalFetch = globalThis.fetch;
const originalPlatform = process.platform;
const originalTmp = process.env.TMPDIR;
const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ooapi-binance-update-"));
const source = await fs.readFile(fileURLToPath(new URL("../src/services/updater.js", import.meta.url)), "utf8");
const write = async (base, name, content) => { const file = path.join(base, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
const copyTree = async (from, to, excluded = []) => {
  assert(path.resolve(to).startsWith(`${path.resolve(taskRoot)}${path.sep}`), "Fixture filesystem writes must stay inside the owned temporary directory");
  await fs.mkdir(to, { recursive: true });
  const ignored = (name) => name.startsWith(".") || excluded.some((value) => value.endsWith("*") ? name.startsWith(value.slice(0, -1)) : value === name);
  const sourceNames = new Set();
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (ignored(entry.name)) continue;
    sourceNames.add(entry.name);
    if (entry.isDirectory()) await copyTree(path.join(from, entry.name), path.join(to, entry.name), excluded);
    else await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
  for (const entry of await fs.readdir(to)) if (!ignored(entry) && !sourceNames.has(entry)) await fs.rm(path.join(to, entry), { recursive: true, force: true });
};

try {
  Object.defineProperty(process, "platform", { value: "linux" });
  globalThis.fetch = async () => new Response(JSON.stringify({ service: "od-binance", database: "connected" }));
  for (const shouldFail of [false, true]) {
    const base = path.join(taskRoot, shouldFail ? "rollback" : "success");
    const server = path.join(base, "ooapi-server");
    const engine = path.join(base, "ooapi-binance");
    const remote = path.join(base, "remote");
    process.env.TMPDIR = path.join(base, "temporary");
    await fs.mkdir(process.env.TMPDIR, { recursive: true });
    await write(server, "src/services/updater.js", source);
    await write(server, "package.json", '{"type":"module"}');
    await write(server, "src/version.js", "backend-before");
    await write(server, ".env", "private-platform-config");
    await write(server, ".admin-password", "private-administrator-config");
    await write(server, "data/binance-bridge.key", "private-bridge-key");
    await write(server, "web/index.html", "static-before");
    // 历次前端备份不得挤占后端的三份保留名额，更不能删除刚创建的本次回滚点。
    for (let index = 0; index < 4; index++) await write(server, `.backup-web-${index}/src/placeholder`, "old-web-source");
    await write(engine, "app/version.py", "engine-before");
    await write(engine, "requirements.txt", "existing-runtime");
    await write(engine, ".env", "private-engine-config");
    await write(engine, ".venv/bin/python", "existing-python-runtime");
    await write(engine, "data/trades", "existing-assets");
    await write(path.join(base, "ooapi-web"), "src/version.jsx", "web-before");
    await write(remote, "ooapi-server/package.json", '{"type":"module"}');
    await write(remote, "ooapi-server/src/version.js", "backend-after");
    await write(remote, "ooapi-binance/app/version.py", "engine-after");
    await write(remote, "ooapi-binance/requirements.txt", "updated-runtime");
    await write(remote, "ooapi-binance/.env", "must-never-overwrite");
    await write(remote, "ooapi-web/src/version.jsx", "web-after");
    await write(remote, "scripts/start-binance.sh", "reviewed-installer");
    const operations = [];
    const mocked = () => ({ unref() {} });
    mocked[promisify.custom] = async (command, args, options = {}) => {
      operations.push([command, ...args]);
      let stdout = "";
      if (command === "git" && args[0] === "clone") await fs.cp(remote, args.at(-1), { recursive: true });
      else if (command === "git" && args.includes("rev-parse")) stdout = "reviewed-commit";
      else if (command === "git" && args.includes("log")) stdout = "reviewed release";
      else if (command === "rsync" && args[0] === "-a") await copyTree(args.at(-2).replace(/\/$/, ""), args.at(-1).replace(/\/$/, ""), args.filter((value) => value.startsWith("--exclude=")).map((value) => value.slice(10)));
      else if (command === "npm" && args[0] === "run") {
        await write(options.cwd, "dist/index.html", "reviewed-html");
        await write(options.cwd, "dist/assets/main.js", "production-react");
      } else if (args.includes("pip") && shouldFail) {
        throw Object.assign(new Error("fixture failure"), { stderr: "test-only dependency install failure" });
      }
      return { stdout, stderr: "" };
    };
    childProcess.execFile = mocked;
    syncBuiltinESMExports();
    const { performUpdate } = await import(`${pathToFileURL(path.join(server, "src/services/updater.js"))}?fixture=${shouldFail}`);
    const result = await performUpdate(() => {}, { restart: true });
    assert.equal(result.ok, !shouldFail);
    assert.equal(result.rolledBack, shouldFail);
    assert.equal(await fs.readFile(path.join(server, ".env"), "utf8"), "private-platform-config");
    assert.equal(await fs.readFile(path.join(server, ".admin-password"), "utf8"), "private-administrator-config");
    assert.equal(await fs.readFile(path.join(server, "data/binance-bridge.key"), "utf8"), "private-bridge-key");
    assert.equal(await fs.readFile(path.join(engine, ".env"), "utf8"), "private-engine-config");
    assert.equal(await fs.readFile(path.join(engine, ".venv/bin/python"), "utf8"), "existing-python-runtime");
    assert.equal(await fs.readFile(path.join(engine, "data/trades"), "utf8"), "existing-assets");
    assert.equal(await fs.readFile(path.join(engine, "app/version.py"), "utf8"), shouldFail ? "engine-before" : "engine-after");
    assert.equal(await fs.readFile(path.join(server, "src/version.js"), "utf8"), shouldFail ? "backend-before" : "backend-after");
    assert.equal(await fs.readFile(path.join(server, "web/index.html"), "utf8"), shouldFail ? "static-before" : "reviewed-html");
    assert(!(await exists(path.join(result.binanceBackup, ".env"))));
    assert(!(await exists(path.join(result.binanceBackup, ".venv"))));
    assert(!(await exists(path.join(result.binanceBackup, "data"))));
    assert(!(await exists(path.join(result.backup, ".env"))));
    assert(!(await exists(path.join(result.backup, ".admin-password"))));
    assert(operations.some(([command, ...args]) => command === "systemctl" && args[0] === "stop"));
    assert(operations.some(([command, ...args]) => command === "systemctl" && args[0] === "start"));
  }
  console.log("BINANCE_UPDATE_PASS: successful update and failed-update rollback preserve configuration, bridge key, Python environment and assets");
} finally {
  childProcess.execFile = originalExec;
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
  Object.defineProperty(process, "platform", { value: originalPlatform });
  if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
  assert.equal(path.dirname(await fs.realpath(taskRoot)), await fs.realpath(os.tmpdir()));
  await fs.rm(taskRoot, { recursive: true, force: true });
}
