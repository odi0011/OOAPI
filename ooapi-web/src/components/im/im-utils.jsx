// 消息中心的共用小件：时间格式、消息分组、头像（含在线点 / 群头像）
import React from "react";
import UserAvatar, { hueOf } from "../UserAvatar";

export const RECALL_WINDOW_SEC = 120; // 与后端 routes/chatroom.js 的撤回窗口一致
export const MAX_TEXT = 4000; // 与后端 MAX_TEXT 一致（超长后端报错，前端提前提示）
const GROUP_GAP_SEC = 5 * 60;

export const nameOf = (u) => (u ? u.remark || u.display_name || u.username || `用户 #${u.id}` : "");

const pad = (n) => String(n).padStart(2, "0");
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function dayDiff(d, now = new Date()) {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

/** 会话列表的时间：今天 HH:mm / 昨天 / 本周 周X / 更早 M-D（跨年带年份） */
export function fmtListTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return "";
  const d = new Date(t * 1000);
  const diff = dayDiff(d);
  if (diff <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return "昨天";
  if (diff < 7) return `周${WEEK[d.getDay()]}`;
  if (d.getFullYear() !== new Date().getFullYear()) return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function fmtClock(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDay(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  const diff = dayDiff(d);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  const base = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
  return d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年${base}` : base;
}

/**
 * 消息流 → 渲染条目：插入日期分隔线，并标出「同一人 5 分钟内的连续消息」。
 * 连续消息只在第一条显示头像/名字，气泡贴紧 —— 高频对话时一屏能多看一倍内容。
 */
export function buildRows(msgs) {
  const rows = [];
  let prev = null;
  let lastDay = "";
  for (const m of msgs) {
    const day = new Date((Number(m.created_time) || 0) * 1000).toDateString();
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `d-${day}`, label: fmtDay(m.created_time) });
      lastDay = day;
      prev = null;
    }
    if (m.type === "system") {
      rows.push({ kind: "system", key: `s-${m.id || m.client_id}`, msg: m });
      prev = null;
      continue;
    }
    const continued =
      prev && prev.user_id === m.user_id && Number(m.created_time) - Number(prev.created_time) < GROUP_GAP_SEC;
    rows.push({ kind: "msg", key: m.client_id || `m-${m.id}`, msg: m, continued: Boolean(continued) });
    prev = m;
  }
  // 反向再扫一遍：标出每段连续消息的最后一条（气泡圆角与段间距用）
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "msg") continue;
    const next = rows[i + 1];
    rows[i].last = !(next && next.kind === "msg" && next.continued);
  }
  return rows;
}

/** 头像 + 在线点（在线点只在「知道状态」时画：online 为 undefined 不画） */
export function PresenceAvatar({ user, size = 36, online }) {
  return (
    <span className="oo-im-avatar" style={{ width: size, height: size }}>
      <UserAvatar user={user} size={size} />
      {online === undefined ? null : <i className={`oo-im-dot${online ? " is-on" : ""}`} aria-label={online ? "在线" : "离线"} />}
    </span>
  );
}

/** 群头像：圆角方块 + 群名首字（与用户的圆形头像一眼区分） */
export function GroupAvatar({ name, id, size = 36 }) {
  const hue = hueOf(`g${id || name}`);
  const initial = String(name || "群").trim().slice(0, 1) || "群";
  return (
    <span
      className="oo-im-group-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)), "--hue": hue }}
    >
      {initial}
    </span>
  );
}

export function RoomAvatar({ room, size = 36, online }) {
  if (room?.type === "single") return <PresenceAvatar user={room.peer || { username: room.title }} size={size} online={online} />;
  return <GroupAvatar name={room?.title || room?.name} id={room?.id} size={size} />;
}

/** 通知导航栏刷新红点（MainLayout 监听这个事件） */
export function pingBadges() {
  window.dispatchEvent(new Event("ooapi:badges"));
}
