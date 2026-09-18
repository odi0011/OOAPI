// DeepSeek 网页版 PoW 求解器（集成自 deepseek-web-api 工具）
//
// 协议来源：chat.deepseek.com 官方前端 bundle 逆向并逐行验证（2026-08）
// 1. 谓词：DeepSeekHashV1 是魔改 Keccak（23 轮、rate 136、32 字节输出），
//    求解目标：hashV1(`${salt}_${expire_at}_${nonce}`) === challenge（64 位 hex 全等）
//    difficulty 只是 nonce 搜索上限。
// 2. wasm 调用协议（vendor/sha3_wasm_bg.wasm，与官方同一文件）：
//      retptr = __wbindgen_add_to_stack_pointer(-16)
//      __wbindgen_export_0(len, 1) 分配内存写入 challenge 与 prefix
//      wasm_solve(retptr, cPtr, cLen, pPtr, pLen, difficulty)
//      status = Int32[retptr/4]（0=失败），answer = Float64[(retptr+8)/8]
// 3. 请求头：X-DS-PoW-Response = base64(JSON.stringify({
//      algorithm, challenge, salt, answer, signature, target_path }))
//
// 历史教训：本文件曾被当作「死代码」随 services/deepseek/ 目录一起删除，
// 但 upstream/deepseek.js 仍在 import，导致 DeepSeek 适配器整个加载失败；
// 恢复时移到 upstream/ 下并改名为 deepseek-pow.js（勿再删）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "..", "..", "vendor", "sha3_wasm_bg.wasm");

let wasmExportsPromise = null;

function getWasmExports() {
  if (!wasmExportsPromise) {
    wasmExportsPromise = WebAssembly.instantiate(readFileSync(WASM_PATH), { wbg: {} }).then(
      (result) => result.instance.exports
    );
  }
  return wasmExportsPromise;
}

const encoder = new TextEncoder();

function putString(wasm, value) {
  const bytes = encoder.encode(value);
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

export function powPrefix(challenge) {
  const expireAt = challenge.expire_at ?? challenge.expireAt;
  return `${challenge.salt}_${expireAt}_`;
}

// 主路径：与官方一致的 wasm_solve
export async function solvePowWasm(challenge) {
  const wasm = await getWasmExports();
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [cPtr, cLen] = putString(wasm, challenge.challenge);
    const [pPtr, pLen] = putString(wasm, powPrefix(challenge));
    wasm.wasm_solve(retptr, cPtr, cLen, pPtr, pLen, Number(challenge.difficulty));
    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    if (status === 0 || !Number.isFinite(answer)) {
      throw new Error("wasm_solve 未找到解");
    }
    return Math.floor(answer);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

// 兜底路径：用 wasm 导出的 wasm_deepseek_hash_v1 当预言机逐 nonce 试探
export async function solvePowOracle(challenge) {
  const wasm = await getWasmExports();
  const prefix = powPrefix(challenge);
  const limit = Number(challenge.difficulty) || 10_000_000;
  for (let nonce = 0; nonce < limit; nonce++) {
    const [ip, il] = putString(wasm, prefix + nonce);
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    let hex;
    try {
      wasm.wasm_deepseek_hash_v1(retptr, ip, il);
      const view = new DataView(wasm.memory.buffer);
      const p = view.getUint32(retptr, true);
      const len = view.getUint32(retptr + 4, true);
      hex = Buffer.from(new Uint8Array(wasm.memory.buffer).slice(p, p + len)).toString("utf8");
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
    if (hex === challenge.challenge) return nonce;
  }
  throw new Error(`PoW 求解失败：nonce 超出上限 ${limit}`);
}

// difficulty 来自上游 JSON：不设上限时，异常/恶意上游可以要求 1e9 次同步哈希，
// 阻塞整个 Node 事件循环（连 execute 的超时定时器都无法触发）。正常 challenge 远小于此。
const MAX_DIFFICULTY = 1 << 24;
const POW_TIMEOUT_MS = 60_000;

// ---------- worker 池（单 worker，串行处理求解任务）----------
// 求解是同步 CPU 密集操作：放主线程会阻塞事件循环，放 worker 后超时可强制终止。
let powWorker = null;
let powSeq = 0;
const powJobs = new Map();
let powIdleTimer = null;

/** 终止 worker（进程退出时调用；也用于空闲回收），未完成任务全部拒绝 */
export function closePowWorker() {
  if (powIdleTimer) {
    clearTimeout(powIdleTimer);
    powIdleTimer = null;
  }
  const w = powWorker;
  powWorker = null;
  for (const job of powJobs.values()) job.reject(new Error("PoW worker 已关闭"));
  powJobs.clear();
  if (w) w.terminate().catch(() => {});
}

// 空闲回收：worker 的 MessagePort 在部分执行路径下会持有事件循环，
// 长期空闲时主动终止，避免脚本/测试场景进程无法退出。next solve 会自动重建。
function schedulePowIdleClose(worker) {
  if (powIdleTimer) clearTimeout(powIdleTimer);
  powIdleTimer = setTimeout(() => {
    if (powJobs.size === 0 && powWorker === worker) closePowWorker();
  }, 5 * 60 * 1000);
  powIdleTimer.unref?.();
}

function getPowWorker() {
  if (powWorker) return powWorker;
  const w = new Worker(new URL("./deepseek-pow-worker.mjs", import.meta.url));
  w.unref?.(); // 空闲 worker 不阻止进程退出
  w.on("message", (m) => {
    const job = powJobs.get(m.id);
    if (!job) return;
    powJobs.delete(m.id);
    if (m.ok) job.resolve(m.answer);
    else job.reject(new Error(m.error || "PoW worker 求解失败"));
    schedulePowIdleClose(w);
  });
  w.on("error", (e) => {
    for (const job of powJobs.values()) job.reject(e);
    powJobs.clear();
    if (powWorker === w) powWorker = null; // 下次请求重建
  });
  w.on("exit", () => {
    if (powWorker === w) powWorker = null;
  });
  powWorker = w;
  schedulePowIdleClose(w);
  return w;
}

function solvePowInWorker(challenge) {
  const w = getPowWorker();
  const id = ++powSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      powJobs.delete(id);
      // 卡死的 worker 无法自愈：终止并让下次重建
      w.terminate().catch(() => {});
      if (powWorker === w) powWorker = null;
      reject(Object.assign(new Error(`PoW 求解超时（${POW_TIMEOUT_MS}ms）`), { code: "CHANNEL_TIMEOUT" }));
    }, POW_TIMEOUT_MS);
    powJobs.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ id, challenge });
  });
}

export async function solvePow(challenge) {
  if (!challenge || !challenge.challenge || !challenge.salt || !challenge.difficulty) {
    throw new Error("PoW challenge 字段不完整: " + JSON.stringify(challenge));
  }
  const difficulty = Number(challenge.difficulty);
  if (!Number.isFinite(difficulty) || difficulty <= 0 || difficulty > MAX_DIFFICULTY) {
    throw Object.assign(new Error(`PoW difficulty 异常（${challenge.difficulty}），拒绝求解`), {
      code: "CHANNEL_BAD_RESPONSE",
    });
  }
  try {
    return await solvePowInWorker(challenge);
  } catch (err) {
    // 超时/取消类错误直接抛出；worker 启动失败等基础设施问题回退主线程求解
    if (err.code) throw err;
    console.warn("[deepseek/pow] worker 求解失败，回退主线程：", err.message);
    try {
      return await solvePowWasm(challenge);
    } catch (e2) {
      console.warn("[deepseek/pow] wasm_solve 失败，改用预言机兜底:", e2.message);
      return solvePowOracle(challenge);
    }
  }
}

// 组装 X-DS-PoW-Response 请求头（字段与顺序与官方前端一致）
export function buildPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm || "DeepSeekHashV1",
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path || "/api/v0/chat/completion",
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
