#!/usr/bin/env node
import { main } from "./cli.mjs";
const args = process.argv.slice(2);
main([args.includes("--server") ? "pair" : "start", ...args]).catch(() => { console.error("本地执行器启动失败，请检查参数、HTTPS、配对和目录权限。不会退回宿主机命令执行。"); process.exitCode = 1; });
