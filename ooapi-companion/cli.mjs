#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicJson, privateDirectory } from "./journal.mjs";
import { createApi, validateServer, runConnected, assertPrivateStateLocation } from "./runner.mjs";

export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() || "help", options = {};
  const booleans = new Set(["allow-write", "allow-exec", "allow-http-localhost"]);
  const allowed = new Set([...booleans, "server", "root", "state-dir", "docker-image", "label"]);
  for (let i = 0; i < argv.length; i++) { const key = argv[i].replace(/^--/, ""); if (!argv[i].startsWith("--") || !allowed.has(key)) throw new Error("未知命令参数。"); options[key] = booleans.has(key) ? true : argv[++i]; if (options[key] === undefined) throw new Error("命令参数缺少值。"); }
  if (command === "help") { console.log("OOAPI 本地执行器（Node 18+，零依赖）\n配对：node cli.mjs pair --server https://你的平台 --root /本机项目 [--allow-write] [--allow-exec --docker-image 已安装镜像] [--label 项目简称]\n重连：node cli.mjs start\n更改本地授权：重新执行 pair；管理员身份不会赋予本机权限。\n默认只读；exec 只在已安装 Docker Linux 镜像内执行，默认禁止网络，不使用宿主机 shell。"); return; }
  if (!["pair", "start"].includes(command)) throw new Error("只支持 pair、start、help。");
  if (command === "pair" && (!options.server || !options.root)) throw new Error("配对需要 --server 与 --root；根目录只保存在本机。");
  const pairingRoot = command === "pair" ? await fs.realpath(path.resolve(options.root)) : null;
  const requestedState = path.resolve(options["state-dir"] || path.join(os.homedir(), ".ooapi-companion"));
  if (pairingRoot) assertPrivateStateLocation(pairingRoot, requestedState);
  const stateDirectory = await privateDirectory(requestedState);
  // 再核对解析后的真实目录，父级链接也不能让凭据落入项目。
  if (pairingRoot) assertPrivateStateLocation(pairingRoot, stateDirectory);
  const configFile = path.join(stateDirectory, "device.json"), ctrl = new AbortController();
  const stop = () => ctrl.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    let config;
    if (command === "pair") {
      const root = pairingRoot, server = validateServer(options.server, options["allow-http-localhost"]);
      const response = await createApi(server, null, { allowHttpLocalhost: options["allow-http-localhost"] })("/pair/start", {}, ctrl.signal);
      config = { server, bearer: response.bearer, deviceId: response.deviceId, workspaceId: crypto.randomUUID(), root, stateDirectory, label: options.label || "本地工作区", allowWrite: options["allow-write"] === true, allowExec: options["allow-exec"] === true, dockerImage: options["docker-image"] || "", allowHttpLocalhost: options["allow-http-localhost"] === true };
      await atomicJson(configFile, config);
      console.log(`请在已登录平台的「本地工作区」输入一次性配对码：${response.code}\n有效期 5 分钟。根目录：${root}\n本地授权：读取${config.allowWrite ? "、写入" : ""}${config.allowExec ? "、Docker 隔离命令" : ""}。`);
      const api = createApi(server, config.bearer, { allowHttpLocalhost: config.allowHttpLocalhost }); let paired = false;
      while (!ctrl.signal.aborted && Date.now() < response.expiresAt) {
        const status = await api("/runner/status", {}, ctrl.signal);
        if (status.paired) { paired = true; console.log(`已与平台用户 #${status.userId} 配对。`); break; }
        await new Promise(resolve => { let timer; const finish = () => { clearTimeout(timer); ctrl.signal.removeEventListener("abort", finish); resolve(); }; timer = setTimeout(finish, 2000); ctrl.signal.addEventListener("abort", finish, { once: true }); });
      }
      if (!paired) throw new Error("配对未完成，请重新运行 pair。");
    } else {
      try { config = JSON.parse(await fs.readFile(configFile, "utf8")); }
      catch { throw new Error("未找到本机设备配置，请先运行 pair。"); }
      config.stateDirectory = stateDirectory;
    }
    let last = "";
    await runConnected(config, { signal: ctrl.signal, onStatus: (status, workspace) => { if (status !== last) console.log(status === "connected" ? `工作区 ${workspace.id} 已连接；读取：是，写入：${workspace.capabilities.write ? "是" : "否"}，隔离命令：${workspace.capabilities.exec ? "是" : "不可用"}。` : "连接中断，等待重连；已开始的调用不会重复执行。"); last = status; } });
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("本地执行器未能启动或连接，请检查启动参数、HTTPS 服务、配对状态与本机目录权限；不会回退到宿主机命令执行。"); process.exitCode = 1; });
