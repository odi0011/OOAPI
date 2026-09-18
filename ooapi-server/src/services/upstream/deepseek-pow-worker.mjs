// DeepSeek PoW 求解 worker（worker_threads）
// ---------------------------------------------------------------------------
// 为什么要单独跑在 worker 里：
//   wasm_solve / 预言机兜底都是同步 CPU 密集调用，直接在主线程跑会阻塞整个
//   Node 事件循环（execute 的超时定时器、其他用户的请求全部卡住）。
//   放到 worker 后主线程只等待消息，超时可直接 terminate。
import { parentPort } from "node:worker_threads";
import { solvePowWasm, solvePowOracle } from "./deepseek-pow.js";

parentPort.on("message", async ({ id, challenge }) => {
  try {
    let answer;
    try {
      answer = await solvePowWasm(challenge);
    } catch {
      // 与主线程逻辑一致：wasm_solve 失败时走预言机兜底
      answer = await solvePowOracle(challenge);
    }
    parentPort.postMessage({ id, ok: true, answer });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
});
