import { useCallback, useEffect, useState } from "react";

import type { NotificationItem } from "@/components/arc/notification-center/notification-center";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Permission } from "@/lib/permissions";

/**
 * 顶栏通知。
 *
 * 从真实数据派生，而不是维护一张通知表：通知的意义在于「现在有什么要处理」，
 * 一旦落库就会积累大量已经过时的条目，反而掩盖真正的问题。
 * 这里每次打开后台都按当前状态重新计算，处理完就自动消失。
 *
 * 数据源：
 *   - 账号故障/冷却（需要 channel:view）
 *   - 我方额度告警：账号余额、密钥额度
 */

interface ChannelRow {
  id: number;
  name: string;
  status: number;
  cooldown_until: string;
  last_error: string;
  success_rate: number;
  requests: number;
}

interface TokenRow {
  id: number;
  name: string;
  status: number;
  quota: number;
  unlimited_quota: boolean;
  used_quota: number;
  expired_at: string;
}

const READ_KEY = "ooapi_read_notifications";

/** 读取「已读」标记。只是体验细节，出错就当没有。 */
function loadRead(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveRead(set: Set<string>) {
  try {
    // 只保留最近 100 条，避免无限增长。
    localStorage.setItem(READ_KEY, JSON.stringify([...set].slice(-100)));
  } catch {
    /* 隐私模式下不可用 */
  }
}

export function useNotifications(can: (permission: Permission) => boolean) {
  const { user } = useAuth();
  const [items, setItems] = useState<NotificationItem[]>([]);

  const build = useCallback(async () => {
    const out: NotificationItem[] = [];

    // ---------- 账号异常：需要账号查看权限 ----------
    if (can("channel:view")) {
      try {
        const data = await apiRequest<{ items: ChannelRow[] }>("/api/admin/channels");
        for (const ch of data.items) {
          if (ch.status !== 1) {
            out.push({
              id: `channel-disabled-${ch.id}`,
              title: `账号「${ch.name}」已禁用`,
              description: ch.last_error || "该账号已被手动或自动禁用，流量不会流向它。",
              time: "当前状态",
              tone: "warning",
            });
          } else if (ch.cooldown_until) {
            out.push({
              id: `channel-cooling-${ch.id}-${ch.cooldown_until}`,
              title: `账号「${ch.name}」冷却中`,
              description: ch.last_error || "近期调用失败，正在冷却，到点自动恢复。",
              time: `至 ${ch.cooldown_until.slice(11, 16)}`,
              tone: "warning",
            });
          } else if (ch.requests >= 10 && ch.success_rate < 95) {
            out.push({
              id: `channel-rate-${ch.id}`,
              title: `账号「${ch.name}」成功率偏低`,
              description: `近期成功率 ${ch.success_rate}%，共 ${ch.requests} 次调用。`,
              time: "近 30 天",
              tone: "warning",
            });
          }
        }
      } catch {
        /* 无权限或网络问题时跳过这一类，不影响其余通知 */
      }
    }

    // ---------- 账号额度 ----------
    if (user && user.quota > 0) {
      const remaining = user.quota - user.used_quota;
      const pct = (user.used_quota / user.quota) * 100;
      if (pct >= 80) {
        out.push({
          id: `account-quota-${Math.floor(pct)}`,
          title: pct >= 100 ? "账号余额已用尽" : "账号余额不足",
          description: `已用 ${pct.toFixed(1)}%，剩余 ${remaining.toLocaleString("zh-CN")} 单位。余额不足时调用会被拒绝。`,
          time: "当前状态",
          tone: pct >= 100 ? "warning" : "info",
        });
      }
    }

    // ---------- 密钥额度与过期 ----------
    try {
      const data = await apiRequest<{ items: TokenRow[] }>("/api/token/");
      const now = Date.now();
      for (const t of data.items) {
        if (t.status !== 1) continue;

        if (!t.unlimited_quota && t.quota > 0) {
          const pct = (t.used_quota / t.quota) * 100;
          if (pct >= 80) {
            out.push({
              id: `token-quota-${t.id}-${Math.floor(pct)}`,
              title: pct >= 100 ? `密钥「${t.name}」额度已用完` : `密钥「${t.name}」额度将满`,
              description: `已用 ${pct.toFixed(1)}%（${t.used_quota.toLocaleString("zh-CN")} / ${t.quota.toLocaleString("zh-CN")}）。`,
              time: "当前状态",
              tone: pct >= 100 ? "warning" : "info",
            });
          }
        }

        if (t.expired_at) {
          const days = (new Date(t.expired_at).getTime() - now) / 86400000;
          if (days < 0) {
            out.push({
              id: `token-expired-${t.id}`,
              title: `密钥「${t.name}」已过期`,
              description: `过期时间 ${t.expired_at}，该密钥已无法调用。`,
              time: "已过期",
              tone: "warning",
            });
          } else if (days <= 7) {
            out.push({
              id: `token-expiring-${t.id}`,
              title: `密钥「${t.name}」即将过期`,
              description: `还有 ${Math.ceil(days)} 天（${t.expired_at}）到期。`,
              time: `${Math.ceil(days)} 天后`,
              tone: "warning",
            });
          }
        }
      }
    } catch {
      /* 未登录或无密钥时跳过 */
    }

    // 已读的那批不再计入未读，但它们仍显示在列表里。
    const read = loadRead();
    setItems(out.map((n) => ({ ...n, read: read.has(n.id) })));
  }, [can, user]);

  useEffect(() => {
    void build();
  }, [build]);

  // 标记已读：由通知中心回调触发。
  const markRead = useCallback((id: string, read: boolean) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read } : n)));
    const set = loadRead();
    if (read) set.add(id);
    else set.delete(id);
    saveRead(set);
  }, []);

  return {
    notifications: items.map((n) => ({
      ...n,
      read: n.read ?? false,
    })),
    unreadCount: items.filter((n) => !n.read).length,
    markRead,
  };
}
