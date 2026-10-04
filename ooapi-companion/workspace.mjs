import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = (message, code = "LOCAL_INVALID") => Object.assign(new Error(message), { code });
const FILE_LIMIT = 256000, OUTPUT_LIMIT = 96000;
const hidden = name => /^(?:\.env(?:\..*)?|\.jwt-secret|\.admin-password|id_rsa|id_ed25519)$|\.(?:pem|p12|pfx|key)$/i.test(name);
const gitDirectory = name => name.toLowerCase() === ".git";
const checkAbort = signal => { if (signal?.aborted) throw failure("本地操作已停止。", "ABORTED"); };

export async function openWorkspace(root, { allowWrite = false, allowExec = false, dockerImage = "" } = {}) {
  const absolute = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(absolute)).isDirectory()) throw failure("授权根路径必须是目录。");
  const inside = target => { const relative = path.relative(absolute, target); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  async function resolve(relative = ".", { missing = false } = {}) {
    if (typeof relative !== "string" || !relative || relative.length > 2048 || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw failure("只接受工作区内的相对路径。");
    const pieces = relative.replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
    if (pieces.some(p => p === ".." || gitDirectory(p) || hidden(p))) throw failure("路径越界或属于受保护文件。");
    if (await fs.realpath(absolute) !== absolute) throw failure("工作区根目录已变更，请重新授权。");
    let current = absolute;
    for (let i = 0; i < pieces.length; i++) {
      current = path.join(current, pieces[i]);
      let info;
      try { info = await fs.lstat(current); }
      catch (error) { if (error.code === "ENOENT" && missing && i === pieces.length - 1) return current; throw failure("文件或上级目录不存在。"); }
      // 内部链接也不跟随，避免读写期间改指向导致越界。
      if (info.isSymbolicLink()) throw failure("不允许经过符号链接或目录联接。");
      if (!inside(await fs.realpath(current))) throw failure("路径逃离授权工作区。");
      if (i < pieces.length - 1 && !info.isDirectory()) throw failure("上级路径不是目录。");
    }
    return current;
  }
  async function read(relative) {
    const file = await resolve(relative), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > FILE_LIMIT) throw failure("只支持不超过 256 KB 的文本文件。");
      if (process.platform === "linux" && !inside(await fs.realpath(`/proc/self/fd/${handle.fd}`))) throw failure("文件在打开期间已移出工作区。");
      const bytes = await handle.readFile();
      if (bytes.includes(0)) throw failure("二进制文件不作为文本读取。");
      return { path: relative, content: bytes.toString("utf8"), sha256: sha256(bytes), bytes: bytes.length };
    } finally { await handle.close(); }
  }
  async function write(relative, content, expectedSha256) {
    if (!allowWrite) throw failure("此工作区没有本地写入授权。", "LOCAL_PERMISSION");
    if (typeof content !== "string" || Buffer.byteLength(content) > FILE_LIMIT) throw failure("写入必须是不超过 256 KB 的文本。");
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256 || "")) throw failure("写入必须提供读取时的 expectedSha256；新增文件必须显式传 null。");
    const destination = await resolve(relative, { missing: true });
    async function verify() {
      let current;
      try { current = await read(relative); }
      catch (error) { if (await fs.lstat(destination).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw error; }
      if ((current?.sha256 ?? null) !== expectedSha256) throw failure("文件已被其他操作修改，请重新读取后生成修改。", "LOCAL_CONFLICT");
    }
    await verify();
    const temporary = path.join(path.dirname(destination), `.ooapi-write-${crypto.randomUUID()}`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
      if (await resolve(relative, { missing: true }) !== destination) throw failure("写入位置已经变化。");
      await verify();
      // 新增文件采用链接的排他语义，防止在验证后覆盖第三方刚创建的文件。
      if (expectedSha256 === null) { await fs.link(temporary, destination); await fs.unlink(temporary); }
      else { const old = await fs.stat(destination); await fs.chmod(temporary, old.mode & 0o777); await fs.rename(temporary, destination); }
    } finally { await handle?.close(); await fs.unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
    let actual;
    try { actual = await read(relative); }
    catch { throw Object.assign(failure("写入已提交但无法读回核验，请检查本机文件，不能自动重跑。", "LOCAL_WRITE_UNCONFIRMED"), { outcome: "unknown" }); }
    if (actual.sha256 !== sha256(content)) throw Object.assign(failure("写入已提交，但文件随后发生变化；结果未确认，请核对本机文件。", "LOCAL_WRITE_UNCONFIRMED"), { outcome: "unknown" });
    return { path: relative, sha256: actual.sha256, bytes: actual.bytes, changed: true, verified: true };
  }
  async function list(relative = ".") {
    const directory = await resolve(relative);
    if (!(await fs.stat(directory)).isDirectory()) throw failure("list 需要目录。");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return { path: relative, entries: entries.filter(e => !hidden(e.name) && !gitDirectory(e.name) && !e.isSymbolicLink()).slice(0, 500).map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" })), truncated: entries.length > 500 };
  }
  async function search({ path: relative = ".", query, limit = 100 }, signal) {
    if (typeof query !== "string" || !query || query.length > 500) throw failure("search 需要长度 1–500 的字面文本 query。");
    const matches = []; let files = 0, visited = 0, truncated = false;
    const visit = async (directory, depth = 0) => {
      if (depth > 24 || files >= 2000 || visited >= 10000 || matches.length >= Math.min(Number(limit) || 100, 200)) { truncated = true; return; }
      const items = await fs.readdir(await resolve(directory), { withFileTypes: true });
      for (const item of items) {
        checkAbort(signal); visited++;
        if (visited >= 10000 || files >= 2000 || matches.length >= Math.min(Number(limit) || 100, 200)) { truncated = true; break; }
        if (item.isSymbolicLink() || hidden(item.name) || gitDirectory(item.name) || ["node_modules", "dist"].includes(item.name)) continue;
        const filename = path.posix.join(directory.replace(/\\/g, "/"), item.name);
        if (item.isDirectory()) await visit(filename, depth + 1);
        else if (item.isFile()) {
          files++;
          let file; try { file = await read(filename); } catch { continue; }
          for (const [index, line] of file.content.split(/\r?\n/).entries()) if (line.includes(query)) {
            matches.push({ path: filename, line: index + 1, text: line.slice(0, 400) });
            if (matches.length >= Math.min(Number(limit) || 100, 200)) break;
          }
        }
      }
    };
    await visit(relative); return { matches, filesScanned: files, truncated };
  }
  const docker = await dockerCapability(dockerImage, allowExec);
  async function execute(action, args, { signal } = {}) {
    checkAbort(signal);
    if (action === "list") return list(args.path || ".");
    if (action === "read") return read(args.path);
    if (action === "search") return search(args, signal);
    if (action === "write") return write(args.path, args.content, args.expectedSha256);
    if (action === "patch") {
      const before = await read(args.path);
      if (args.expectedSha256 !== before.sha256) throw failure("文件版本不匹配，请重新读取。", "LOCAL_CONFLICT");
      const patches = args.patches === undefined ? [{ find: args.find, replace: args.replace }] : args.patches;
      if (!Array.isArray(patches) || !patches.length || patches.length > 50) throw failure("patch 需要 1–50 个文本替换。");
      let content = before.content;
      for (const patch of patches) {
        if (!patch || typeof patch.find !== "string" || !patch.find || typeof patch.replace !== "string") throw failure("每个 patch 需要非空 find 与 replace 字符串。");
        if (content.split(patch.find).length !== 2) throw failure("patch 的 find 必须恰好匹配一次。");
        content = content.replace(patch.find, () => patch.replace);
      }
      return write(args.path, content, args.expectedSha256);
    }
    if (action === "exec") {
      if (!docker.available) throw failure("本机没有授权 Docker 隔离执行，或配置的本地镜像不可用；不会退回宿主机 shell。", "LOCAL_EXEC_UNAVAILABLE");
      const directory = await resolve(args.cwd || ".");
      if (!(await fs.stat(directory)).isDirectory()) throw failure("命令 cwd 必须是工作区内目录。");
      if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 16000) throw failure("命令内容无效。");
      const containerName = `ooapi-local-${crypto.randomUUID()}`;
      const mount = `type=bind,source=${absolute},target=/workspace${allowWrite ? "" : ",readonly"}`;
      if (absolute.includes(",")) throw failure("Docker 工作区路径不能包含逗号。");
      const command = ["run", "--rm", "--pull=never", "--name", containerName, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", "--user", `${process.getuid?.() || 65534}:${process.getgid?.() || 65534}`, "--mount", mount, "--workdir", path.posix.join("/workspace", path.relative(absolute, directory).replace(/\\/g, "/")), "--entrypoint", "/bin/sh", docker.image, "-lc", args.command];
      // 终止 Docker CLI 不会可靠停止容器，因此超时/停止后单独删除容器。
      try { return await spawnBounded("docker", ["--host", docker.endpoint, ...command], { signal, timeoutMs: Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 1800000), outputLimit: OUTPUT_LIMIT }); }
      finally { await spawnBounded("docker", ["--host", docker.endpoint, "rm", "-f", containerName], { timeoutMs: 10000, outputLimit: 1000 }).catch(() => {}); }
    }
    throw failure("未知本地操作。");
  }
  return { root: absolute, capabilities: { read: true, write: allowWrite, exec: docker.available, docker: docker.available }, execute };
}

export function spawnBounded(command, args, { signal, timeoutMs = 5000, outputLimit = 96000 } = {}) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    let output = "", size = 0, truncated = false, stopped = false;
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const data = chunk => { const room = outputLimit - size; if (room > 0) { output += chunk.subarray(0, room).toString("utf8"); size += Math.min(room, chunk.length); } if (chunk.length > room) truncated = true; };
    child.stdout.on("data", data); child.stderr.on("data", data);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", () => { cleanup(); reject(failure("本地执行程序不可用。", "LOCAL_EXEC_UNAVAILABLE")); });
    child.once("close", code => { cleanup(); resolve({ exitCode: code, output, truncated, stopped }); });
  });
}
export function localDockerEndpoint(value) {
  // named-pipe scheme 本身不保证本机；远程 UNC 必须拒绝，只接受 ./pipe。
  return typeof value === "string" && (/^unix:\/\/\/[^\x00-\x20?#]+$/.test(value) || /^npipe:\/{2,4}\.\/pipe\/[a-z0-9_.-]+$/i.test(value));
}
export async function dockerCapability(image, allowed) {
  if (!allowed || !image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(image)) return { available: false };
  if (process.env.DOCKER_HOST && !localDockerEndpoint(process.env.DOCKER_HOST)) return { available: false };
  try {
    const context = await spawnBounded("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeoutMs: 5000, outputLimit: 1000 });
    if (context.exitCode !== 0 || !localDockerEndpoint(context.output.trim())) return { available: false };
    const endpoint = process.env.DOCKER_HOST || context.output.trim();
    const engine = await spawnBounded("docker", ["--host", endpoint, "info", "--format", "{{.OSType}}"], { timeoutMs: 5000, outputLimit: 1000 });
    if (engine.exitCode !== 0 || engine.output.trim() !== "linux") return { available: false };
    const inspected = await spawnBounded("docker", ["--host", endpoint, "image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 5000, outputLimit: 1000 });
    const pinned = inspected.output.trim();
    return { available: inspected.exitCode === 0 && /^sha256:[a-f0-9]{64}$/.test(pinned), image: pinned, endpoint };
  } catch { return { available: false }; }
}
