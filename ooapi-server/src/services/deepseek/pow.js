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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

export async function solvePow(challenge) {
  if (!challenge || !challenge.challenge || !challenge.salt || !challenge.difficulty) {
    throw new Error("PoW challenge 字段不完整: " + JSON.stringify(challenge));
  }
  try {
    return await solvePowWasm(challenge);
  } catch (err) {
    console.warn("[deepseek/pow] wasm_solve 失败，改用预言机兜底:", err.message);
    return solvePowOracle(challenge);
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
