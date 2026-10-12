/**
 * 统计接口的数据类型与取数钩子。
 *
 * 看板与消费分析用的是同一个接口（/api/admin/stats）：
 * 同一屏里的数字必须来自同一次查询，否则两块图会互相打架。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiRequestError, apiRequest } from "@/lib/api";

export interface StatsSummary {
  requests: number;
  failed: number;
  success_rate: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  avg_latency_ms: number;
  avg_first_token_ms: number;
}

export interface StatsTrendPoint {
  date: string;
  requests: number;
  failed: number;
  success_rate: number;
  cost: number;
  tokens: number;
  avg_latency_ms: number;
}

export interface StatsModelRow {
  model: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface StatsChannelRow {
  id: number;
  name: string;
  vendor: string;
  status: number;
  priority: number;
  weight: number;
  cooldown_until: string;
  ttft_ms: number;
  last_error: string;
  requests: number;
  failed: number;
  success_rate: number;
  cost: number;
  avg_latency_ms: number;
  latency: number[];
}

export interface StatsEvent {
  time: string;
  type: number;
  title: string;
  detail: string;
}

export interface StatsUserRow {
  user_id: number;
  username: string;
  display_name?: string;
  requests: number;
  cost: number;
}

/** 密钥维度的排行行。 */
export interface StatsTokenRow {
  token_id: number;
  name: string;
  owner: string;
  requests: number;
  cost: number;
}

/** 「最近调用」表格的一行。type 2 = 成功，3 = 失败。 */
export interface StatsRecentRow {
  id: number;
  created_at: string;
  user_id: number;
  username: string;
  model: string;
  type: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  first_token_ms: number;
  latency_ms: number;
}

export interface StatsActivityDay {
  date: string;
  count: number;
}

export interface StatsPayload {
  /** "global" = 全站范围；"self" = 仅当前用户。 */
  scope: "global" | "self";
  days: number;
  summary: StatsSummary;
  /** 上一个等长窗口的汇总，用于环比。 */
  prev: StatsSummary;
  quota: { total: number; used: number };
  trend: StatsTrendPoint[];
  models: StatsModelRow[];
  channels: StatsChannelRow[];
  hourly: number[];
  weekday: number[];
  activity: StatsActivityDay[];
  events: StatsEvent[];
  top_users: StatsUserRow[];
  /** 全站范围才有；个人视角为空数组。 */
  top_tokens: StatsTokenRow[];
  /** 最近调用（成功与失败都算，最多 8 条）。 */
  recent: StatsRecentRow[];
  /** 区间内的活跃用户数（全站范围才有，个人视角为 0）。 */
  active_users: number;
  /** 缓存命中率（命中输入 / 输入总量，百分比）。 */
  cache_rate: number;
  generated: string;
}

/** 计算环比百分比。基数为 0 时不显示百分比 —— 「+∞%」没有意义。 */
export function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/** 把环比格式化成 "+12.4%" 这种紧凑形式。 */
export function formatDelta(value: number | null): string {
  if (value === null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/**
 * 拉取统计数据。
 *
 * days 变化时重新取数；同一页面里多个图表共用一份数据，
 * 因此这里集中管理，而不是每个图表各拉一次。
 */
export function useStats(days = 30) {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 竞态保护：切窗口时旧的慢响应可能后到，
  // 不加这个会把新数据覆盖成旧数据。
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const payload = await apiRequest<StatsPayload>(`/api/admin/stats?days=${days}`);
      if (id !== requestId.current) return;
      setData(payload);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof ApiRequestError ? err.message : "统计数据加载失败");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}
