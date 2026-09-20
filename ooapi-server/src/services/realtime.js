// 实时推送中枢（进程内 SSE 广播）
// ===========================================================================
// 用途：社区消息、联机对战状态这类「服务端主动通知」的场景。
//
// 为什么用进程内 Map 而不是 Redis/消息队列：
//   本项目按**单机单实例**部署（见文档「长期取舍项」）。引入外部中间件会带来
//   运维成本，而单实例下进程内广播已完全够用。多实例部署时必须改成共享存储，
//   否则同一用户连到 A 实例、消息从 B 实例发出就收不到 —— 这一点已登记在待办。
//
// 使用的两个硬性约束（踩过坑的写法）：
//   ① **写失败必须摘除连接**：客户端断开后 write 会抛，若不删就会一直往死连接
//      写、内存只增不减；这里统一在 fail 时 unregister。
//   ② **SSE 必须关掉 nginx 缓冲**（`x-accel-buffering: no`）：否则事件会攒在
//      反代缓冲区里，表现为「消息要等到下一条才一起到」。
import { EventEmitter } from "node:events";

/** userId → Set<res>（同一用户多标签页/多设备各一条连接） */
const clients = new Map();

/** 全局事件总线：联机对战等「按房间广播」的场景订阅它，避免实时层反向依赖业务路由 */
export const bus = new EventEmitter();
bus.setMaxListeners(0); // 订阅者数量随房间数增长，不设上限（避免 Node 警告刷屏）

export function sseHeaders(res) {
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  // nginx 反代下必须显式关闭缓冲，否则事件会被攒着一起发
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
}

export function register(userId, res) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
}

export function unregister(userId, res) {
  const uid = Number(userId) || 0;
  const set = clients.get(uid);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(uid);
}

/** 单条事件写帧。返回 false 表示该连接已不可用（调用方应摘除） */
function writeFrame(res, event, data) {
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
    return true;
  } catch {
    return false;
  }
}

/** 推给单个用户的所有连接 */
export function push(userId, event, data) {
  const uid = Number(userId) || 0;
  const set = clients.get(uid);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const res of [...set]) {
    if (writeFrame(res, event, data)) n += 1;
    else unregister(uid, res); // 死连接立刻摘除，否则会一直往它写
  }
  return n;
}

/** 推给多个用户（按去重后的 id 集合） */
export function pushMany(userIds, event, data) {
  const seen = new Set();
  let n = 0;
  for (const id of userIds || []) {
    const uid = Number(id) || 0;
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    n += push(uid, event, data);
  }
  return n;
}

/** 在线用户 id 列表（前端显示「谁在线」用；只反映当前有 SSE 连接的人） */
export function onlineUserIds() {
  return [...clients.keys()];
}

export function isOnline(userId) {
  const set = clients.get(Number(userId) || 0);
  return Boolean(set && set.size);
}

/** 连接数（监控用） */
export function connectionCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

/**
 * 心跳：定期给所有连接发注释帧。
 * 有些反代会掐掉 60s 无数据的连接；注释帧不算数据但能保活。
 * 由调用方（index.js）启动，避免模块顶层副作用导致测试里也起定时器。
 */
export function startHeartbeat(intervalMs = 15000) {
  const timer = setInterval(() => {
    for (const [uid, set] of [...clients.entries()]) {
      for (const res of [...set]) {
        if (!writeFrame(res, "ping", { at: Date.now() })) unregister(uid, res);
      }
    }
  }, intervalMs);
  timer.unref?.(); // 别让心跳定时器拖住进程退出
  return timer;
}
