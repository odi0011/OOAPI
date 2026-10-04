import { toolPresentation } from "./tool-presentation.js";
// 审批绑定当前运行与一次调用；浏览器只能提交决定，不能替换工具或参数。
import crypto from "node:crypto";

export function requestApproval(run, { tool, name, args, presentation }, { signal, emit, timeoutMs = 300000 } = {}) {
  if (signal?.aborted || run.settled) return Promise.reject(Object.assign(new Error("已停止"), { code: "ABORTED" }));
  const id = crypto.randomUUID();
  const part = { id, type: "approval", tool, name, args: structuredClone(args), presentation: presentation || toolPresentation(tool, args), status: "pending", created: Date.now(), expiresAt: Date.now() + timeoutMs };
  run.approvals ||= new Map();
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (decision) => {
      if (!run.approvals.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      emit?.({ type: "part_update", id, patch: { status: decision, ended: Date.now() } });
      if (decision === "cancelled") reject(Object.assign(new Error("已停止"), { code: "ABORTED" }));
      else resolve(decision === "approved");
    };
    const abort = () => finish("cancelled");
    run.approvals.set(id, { finish, expiresAt: part.expiresAt });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish("expired"), timeoutMs);
    timer.unref?.();
    emit?.({ type: "part", part });
  });
}

export function decideApproval(run, userId, id, decision) {
  if (!run || run.settled || Number(run.userId) !== Number(userId)) return false;
  if (!["approved", "denied"].includes(decision)) return false;
  const pending = run.approvals?.get(String(id));
  if (!pending) return false;
  if (Date.now() >= pending.expiresAt) { pending.finish("expired"); return false; }
  pending.finish(decision);
  return true;
}
