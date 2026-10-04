const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
const reference = part => {
  if (part?.type !== "local_context" || !validId(part.workspaceId) || !validId(part.ref)) return null;
  const match = part.ref.match(/^([a-zA-Z0-9_-]{8,64})-message-(0|[1-9]\d{0,9})$/);
  return match ? { ref: part.ref, runId: match[1], segment: Number(match[2]), workspaceId: part.workspaceId } : null;
};
const actualParts = state => Array.isArray(state?.parts) && state.parts.every(part => part && typeof part === "object" && !Array.isArray(part)) ? state.parts : null;

/** save(ref, {parts}) 只写已绑定的本机，返回值中绝不携带正文、工具参数或错误详情。 */
export async function archiveLocalMessage({ workspace, run, segment, parts, save } = {}) {
  if (!validId(workspace?.id) || !validId(run?.id) || !Number.isSafeInteger(segment) || segment < 0 || segment > 9999999999) throw new Error("本地消息归档编号无效。");
  const ref = `${run.id}-message-${segment}`;
  if (!validId(ref) || !actualParts({ parts })) throw new Error("本地消息归档内容无效。");
  const part = { type: "local_context", id: `local-context-${ref}`, ref, workspaceId: workspace.id };
  if (workspace.online && typeof save === "function") {
    try { await save(ref, { parts: structuredClone(parts) }); }
    catch { /* 设备可能刚离线。云端仍只留引用，最近一段可从原run检查点恢复。 */ }
  }
  return part;
}

/** 仅在已鉴权、已确认归属的服务端会话加载处调用；workspace/load 由服务端绑定，不接受请求传入。 */
export async function hydrateLocalMessages(messages, { workspace, load, signal, deadlineMs = 12000, fallbackRefs = new Set() } = {}) {
  if (!Array.isArray(messages)) return [];
  const result = messages.slice();
  if (!workspace?.online || !validId(workspace.id) || typeof load !== "function" || signal?.aborted) return result;
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(Number(deadlineMs) || 12000, 20000)));
  const readSignal = controller.signal;
  const read = async ref => {
    if (readSignal.aborted) throw new Error("本地历史加载已结束。");
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(new Error("本地历史加载已结束。")); readSignal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (readSignal.aborted) throw new Error("本地历史加载已结束。");
      return load(ref, { signal: readSignal, workspaceId: workspace.id });
    }), cancelled]); }
    finally { readSignal.removeEventListener("abort", abort); }
  };
  const candidates = [], latest = new Map(), seen = new Map();
  let selected = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    // 用户输入的附件/文本即使恰好含ref也不是服务器签发的助手消息归档。
    if (message?.role !== "assistant" || !Array.isArray(message.parts)) continue;
    const entry = message.parts.map(reference).filter(part => part?.workspaceId === workspace.id).at(-1);
    if (!entry) continue;
    const newest = latest.get(entry.runId);
    if (!newest || entry.segment > newest.segment) latest.set(entry.runId, entry);
    if (selected++ < 50) {
      const existing = seen.get(entry.ref);
      if (existing) existing.indices.push(index);
      else { const candidate = { ...entry, indices: [index] }; seen.set(entry.ref, candidate); candidates.push(candidate); }
    }
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length && !readSignal.aborted) {
      const entry = candidates[cursor++];
      let parts;
      try { parts = actualParts(await read(entry.ref)); }
      catch { /* 单份归档缺失不影响其他消息，也不把本机错误路径带入云端响应。 */ }
      // 主run检查点不断更新，只能用于该run最新一段，不能拿新内容顶替旧历史。
      if (!parts && !readSignal.aborted && fallbackRefs?.has?.(entry.ref) && latest.get(entry.runId)?.ref === entry.ref) {
        try {
          const checkpoint = await read(entry.runId);
          // 只能由服务端允许的已落库消息分段兜底；运行中的新step不能冒充旧消息。
          if (checkpoint?.billingSegment === entry.segment) parts = actualParts(checkpoint);
        }
        catch { /* 云端占位仍可读，等待本机恢复或重新归档。 */ }
      }
      if (parts && !readSignal.aborted) {
        try { for (const index of entry.indices) result[index] = { ...messages[index], parts: structuredClone(parts) }; }
        catch { /* 畸形本机缓存同样保留云端占位，不使整段会话加载失败。 */ }
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker)); return result; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", externalAbort); }
}
