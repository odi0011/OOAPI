// 服务退出时先停止站内生成并等落库/结算，再关闭浏览器和数据库。
// 与 SSE 连接数无关：用户断线后运行仍在后台，server.close() 不会等它。
let draining = false;
const active = new Set();

export function isChatDraining() {
  return draining;
}

/** 在首次异步前登记；完成回调必须在结算、消息落库和预占退款后调用。 */
export function trackChatRun(controller) {
  if (draining) return null;
  let resolve;
  const task = { controller, completion: new Promise((r) => { resolve = r; }) };
  active.add(task);
  return () => {
    if (!active.delete(task)) return;
    resolve();
  };
}

/** 进入永久退出态。超时返回未完成数，让退出流程有界，不能伪称已保存。 */
export async function drainChatRuns({ timeoutMs = 8000 } = {}) {
  draining = true;
  const tasks = [...active];
  for (const task of tasks) {
    try { task.controller.abort(); } catch { /* 一个中止失败不能漏掉其他运行 */ }
  }
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.min(60000, Number(timeoutMs))) : 8000;
  let timer;
  try {
    await Promise.race([
      Promise.all(tasks.map((task) => task.completion)),
      new Promise((resolve) => { timer = setTimeout(resolve, budget); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const pending = tasks.filter((task) => active.has(task)).length;
  return { total: tasks.length, completed: tasks.length - pending, pending, timedOut: pending > 0 };
}
