// 在线更新：从 GitHub 拉取最新源码并热替换。
// ===========================================================================
// 安全要点（这是最容易出事故的地方，改动前务必看完）：
//
// 1. **只覆盖源码**。`.env` / `.jwt-secret` / `data/` / `node_modules/` /
//    `web/`（前端构建产物）永远不碰 —— 覆盖了就等于把线上配置和用户数据清空。
// 2. 更新前**先备份**当前源码到 `.backup-<时间戳>/`，失败可回滚。
// 3. 更新用 `git` 拉取到临时目录再 `rsync` 覆盖，**不是**在安装目录里直接
//    `git pull` —— 安装目录本身不一定是 git 仓库，且 pull 冲突会卡住服务。
// 4. 重建前端与重启服务是**分离的步骤**：源码替换成功但前端构建失败时，
//    仍然要重启后端（新后端 + 旧前端仍可正常工作）。
// 5. 绝不在请求线程里同步等待重启：重启会杀掉自己，所以先返回响应，
//    再由一个 detached 的子进程延迟执行 restart（否则前端只会看到连接中断）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// services/ -> src/ -> ooapi-server/
const SERVER_ROOT = path.resolve(__dirname, "..", "..");
// ooapi-server/ -> 项目根（同级还有 ooapi-web）
const PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");
const WEB_ROOT = path.join(PROJECT_ROOT, "ooapi-web");
const WEB_DIST = path.join(WEB_ROOT, "dist");
const STATIC_WEB = path.join(SERVER_ROOT, "web");

const REPO = process.env.GITHUB_REPO || "odi0011/OOAPI";
const BRANCH = process.env.GITHUB_BRANCH || "main";
export const REPO_URL = `https://github.com/${REPO}`;

// 更新时**永不覆盖**的路径（相对 ooapi-server/）
const PROTECTED = new Set([".env", ".jwt-secret", "node_modules", "data", "web"]);

/** 运行外部命令，返回 stdout；失败时抛出带 stderr 的错误 */
async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await pexec(cmd, args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return stdout.trim();
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || "").slice(-900);
    throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} 失败：${detail}`);
  }
}

async function has(cmd, args = ["--version"]) {
  try {
    await run(cmd, args);
    return true;
  } catch {
    return false;
  }
}

/** 备份当前源码（不含被保护目录），返回备份路径 */
async function backupSource() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(SERVER_ROOT, `.backup-${stamp}`);
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(SERVER_ROOT)) {
    if (PROTECTED.has(entry) || entry.startsWith(".backup-")) continue;
    await fs.cp(path.join(SERVER_ROOT, entry), path.join(dest, entry), { recursive: true });
  }
  // 只留最近 3 份，避免磁盘被备份堆满
  const all = (await fs.readdir(SERVER_ROOT))
    .filter((n) => n.startsWith(".backup-"))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - 3))) {
    await fs.rm(path.join(SERVER_ROOT, old), { recursive: true, force: true });
  }
  return dest;
}

/** rsync 覆盖单个目录，自动排除受保护项；无 rsync 时退回逐文件复制 */
async function syncTree(src, dest, exclude) {
  if (await has("rsync")) {
    const args = ["-a", "--delete"];
    for (const e of exclude) args.push(`--exclude=${e}`);
    args.push(`${src}/`, `${dest}/`);
    await run("rsync", args);
    return "rsync";
  }
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (exclude.includes(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await fs.rm(d, { recursive: true, force: true });
      await fs.cp(s, d, { recursive: true });
    } else {
      await fs.cp(s, d);
    }
  }
  return "copy";
}

/**
 * 检查更新：把远端拉到临时目录，对比提交与文件差异。
 * 不修改任何东西，可随时调用。
 */
export async function checkUpdate() {
  if (!(await has("git"))) {
    return { ok: false, error: "服务端未安装 git，无法在线更新" };
  }
  const tmp = path.join(process.env.TMPDIR || "/tmp", `ooapi-check-${Date.now()}`);
  try {
    await run("git", ["clone", "--depth", "1", "--branch", BRANCH, REPO_URL, tmp]);

    const remoteHead = await run("git", ["-C", tmp, "rev-parse", "HEAD"]);
    const remoteShort = await run("git", ["-C", tmp, "rev-parse", "--short", "HEAD"]);
    const remoteDate = await run("git", ["-C", tmp, "log", "-1", "--format=%ci"]);
    const remoteMsg = await run("git", ["-C", tmp, "log", "-1", "--format=%s"]);
    const remoteSubject = await run("git", ["-C", tmp, "log", "-1", "--format=%an"]);

    // 本地版本戳：上次更新成功时写入，没有则视为未知
    const stampFile = path.join(SERVER_ROOT, ".update-stamp.json");
    let local = { commit: "", short: "", date: "", message: "" };
    try {
      local = JSON.parse(await fs.readFile(stampFile, "utf8"));
    } catch {
      /* 首次更新，无本地戳 */
    }

    // 文件级差异：比较远端与本地实际源码
    const changed = [];
    const diffDirs = ["src", "vendor", "public"];
    for (const rel of diffDirs) {
      const a = path.join(tmp, "ooapi-server", rel);
      if (!existsSync(a)) continue;
      await collectDiff(a, path.join(SERVER_ROOT, rel), rel, changed);
    }
    for (const f of ["package.json", "package-lock.json"]) {
      const a = path.join(tmp, "ooapi-server", f);
      const b = path.join(SERVER_ROOT, f);
      if (existsSync(a) && !(await sameFile(a, b))) changed.push(`ooapi-server/${f}`);
    }

    await fs.rm(tmp, { recursive: true, force: true });

    const upToDate = Boolean(local.commit) && local.commit === remoteHead;
    return {
      ok: true,
      repo: REPO_URL,
      branch: BRANCH,
      local,
      remote: {
        commit: remoteHead,
        short: remoteShort,
        date: remoteDate,
        message: remoteMsg,
        author: remoteSubject,
      },
      upToDate,
      changedCount: changed.length,
      changed: changed.slice(0, 60),
    };
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function sameFile(a, b) {
  try {
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

async function collectDiff(srcDir, destDir, relPrefix, out) {
  const walk = async (s, d, rel) => {
    const entries = await fs.readdir(s, { withFileTypes: true });
    for (const ent of entries) {
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        await walk(sp, dp, r);
      } else if (!(await sameFile(sp, dp))) {
        out.push(`ooapi-server/${r}`);
      }
    }
  };
  await walk(srcDir, destDir, relPrefix).catch(() => {});
}

/**
 * 执行更新。
 * @param {(step: string, detail?: string) => void} onStep 进度回调（写入日志便于排查）
 * @param {boolean} restart 是否在完成后重启服务
 */
export async function performUpdate(onStep = () => {}, { restart = true } = {}) {
  const log = [];
  const step = (s) => {
    log.push(s);
    try {
      onStep(s);
    } catch {
      /* 回调异常不影响更新 */
    }
  };

  if (!(await has("git"))) throw new Error("服务端未安装 git，无法在线更新");

  const tmp = path.join(process.env.TMPDIR || "/tmp", `ooapi-update-${Date.now()}`);
  const result = { ok: false, steps: log, backup: "", frontendBuilt: false };

  try {
    step("拉取仓库最新代码…");
    await run("git", ["clone", "--depth", "1", "--branch", BRANCH, REPO_URL, tmp]);
    const newCommit = await run("git", ["-C", tmp, "rev-parse", "HEAD"]);
    const newShort = await run("git", ["-C", tmp, "rev-parse", "--short", "HEAD"]);

    step("备份当前源码…");
    result.backup = await backupSource();

    // 依赖变化要在覆盖之前判断（覆盖后两边就一样了，比较必然相等）
    const pkgChanged = !(await sameFile(
      path.join(tmp, "ooapi-server", "package.json"),
      path.join(SERVER_ROOT, "package.json")
    ));

    step("同步后端源码（保留 .env / data / node_modules / web）…");
    const exclude = [".env", ".jwt-secret", "node_modules", "data", "web", ".backup-*", ".update-stamp.json"];
    await syncTree(path.join(tmp, "ooapi-server"), SERVER_ROOT, exclude);

    step("同步前端源码（保留 node_modules）…");
    if (existsSync(path.join(tmp, "ooapi-web"))) {
      await fs.mkdir(WEB_ROOT, { recursive: true });
      await syncTree(path.join(tmp, "ooapi-web"), WEB_ROOT, ["node_modules", "dist", ".env"]);
    }

    step(pkgChanged ? "依赖有变化，安装后端依赖…" : "安装后端依赖…");
    await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: SERVER_ROOT });

    step("构建前端…");
    try {
      // 关键坑：systemd 单元里设了 NODE_ENV=production，而更新器是服务进程的子进程
      // 会继承这个变量 —— npm 在 NODE_ENV=production 下 **默认跳过 devDependencies**，
      // 而 vite 正是 devDependency，被跳过后构建必然报 "vite: not found"。
      // 所以这里必须 --include=dev 显式带上，并把 NODE_ENV 覆盖掉。
      const frontEnv = { ...process.env, NODE_ENV: "development" };
      const needDeps =
        !existsSync(path.join(WEB_ROOT, "node_modules")) ||
        !existsSync(path.join(WEB_ROOT, "node_modules", ".bin")) ||
        !existsSync(path.join(WEB_ROOT, "node_modules", ".bin", "vite"));
      step(needDeps ? "  前端依赖缺失，正在安装（含 devDependencies）…" : "  同步前端依赖…");
      await run("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], { cwd: WEB_ROOT, env: frontEnv });
      await run("npm", ["run", "build"], { cwd: WEB_ROOT, env: frontEnv });
      // 清空旧产物再拷贝，避免旧哈希文件残留导致白屏
      await fs.rm(path.join(STATIC_WEB, "assets"), { recursive: true, force: true });
      await fs.mkdir(STATIC_WEB, { recursive: true });
      await fs.cp(WEB_DIST, STATIC_WEB, { recursive: true });
      result.frontendBuilt = true;
      step("前端构建完成");
    } catch (e) {
      // 前端失败不回滚后端：新后端 + 旧前端仍可用
      step(`前端构建失败（后端已更新，前端保持原样）：${e.message}`);
    }

    step("执行数据库迁移…");
    for (const m of ["migrate2.mjs", "migrate3.mjs", "migrate5.mjs"]) {
      const f = path.join(SERVER_ROOT, m);
      if (!existsSync(f)) continue;
      try {
        await run("node", [f], { cwd: SERVER_ROOT });
        step(`  ${m} 完成`);
      } catch (e) {
        step(`  ${m} 跳过：${String(e.message).slice(0, 160)}`);
      }
    }

    // 写入版本戳，供「检查更新」比对
    await fs.writeFile(
      path.join(SERVER_ROOT, ".update-stamp.json"),
      JSON.stringify(
        {
          commit: newCommit,
          short: newShort,
          date: new Date().toISOString(),
          message: await run("git", ["-C", tmp, "log", "-1", "--format=%s"]).catch(() => ""),
          pkgChanged,
        },
        null,
        2
      )
    );

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

    result.ok = true;
    result.commit = newShort;
    step(`更新完成（${newShort}）`);

    if (restart) {
      step("准备重启服务…");
      scheduleRestart();
    } else {
      step("已跳过重启（需手动重启才生效）");
    }
    return result;
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    step(`更新失败：${e.message}`);
    result.error = e.message;
    return result;
  }
}

/**
 * 延迟重启：必须脱离当前进程执行。
 * 直接 `systemctl restart` 会把正在响应请求的自己杀掉，所以用 detached 子进程
 * 先 sleep 一小段（保证 HTTP 响应已经发出去），再执行重启。
 */
function scheduleRestart() {
  const cmd = "sleep 1; systemctl restart ooapi || (kill -TERM $PPID 2>/dev/null || true)";
  try {
    const child = execFile("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    console.error("[update] 排程重启失败：", e.message);
  }
}

/** 供前端轮询：服务是否已经用上新代码 */
export async function currentStamp() {
  try {
    return JSON.parse(await fs.readFile(path.join(SERVER_ROOT, ".update-stamp.json"), "utf8"));
  } catch {
    return null;
  }
}
