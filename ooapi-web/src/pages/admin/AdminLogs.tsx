import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Cpu, Database, FileText, Network, RefreshCw, Terminal } from "lucide-react";

import { Avatar } from "@/components/arc/avatar/avatar";
import Badge from "@/components/arc/badge/badge";
import { BottomSheet } from "@/components/arc/bottom-sheet/bottom-sheet";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Pagination } from "@/components/arc/pagination/pagination";
import { ScrollArea } from "@/components/arc/scroll-area/scroll-area";
import { SearchField } from "@/components/arc/search-field/search-field";
import { Select } from "@/components/arc/select/select";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import Tooltip from "@/components/arc/tooltip/tooltip";
import AdminLayout from "@/components/admin/AdminLayout";
import CurrencyIcon from "@/components/CurrencyIcon";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrency, type CurrencyConfig } from "@/contexts/CurrencyContext";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { callerClient, callerClientIcon } from "@/lib/callerClients";
import { Perm } from "@/lib/permissions";
import { vendorIconUrl, vendorOfModel } from "@/lib/vendorIcons";

import styles from "./AdminLogs.module.css";

/**
 * 使用记录：每一次模型调用的用量审计。
 *
 *   2 = 成功调用
 *   3 = 请求失败（所有账号都没成功；quota 一般为 0）
 *   4 = 账号尝试失败（换账号后整体可能仍成功）—— 单独标出来，
 *       否则「为什么成功率不是 100%」永远对不上账。
 *
 * 列表行自带结算快照（价格、倍率、金额），详情接口再补上原文与账单聚合。
 */
interface UsageItem extends Record<string, unknown> {
  id: number;
  user_id: number;
  username: string;
  display_name: string;
  /** 头像地址，可能为空（此时 Avatar 显示姓名首字母）。 */
  avatar_url?: string;
  token_id: number;
  token_name: string;
  channel_id: number;
  channel_name: string;
  type: number;
  model: string;
  /** 请求的模型名 / 上游实际模型 / 计费模型；与 model 相同则不必展示。 */
  requested_model?: string;
  upstream_model?: string;
  pricing_model?: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  quota: number;
  latency_ms: number;
  first_token_ms: number;
  ip: string;
  user_agent?: string;
  caller_client: string;
  detail: string;
  created_at: string;
  /** 账单聚合：列表行也带回，详情接口返回前先用它渲染。 */
  billing?: UsageBilling;
}

/** 后端附带的账单聚合视图：字段都是本次调用的结算快照。 */
interface UsageBilling {
  input_price: number;
  output_price: number;
  cached_price: number;
  raw_cost: number;
  base_quota: number;
  group_rate: number;
  quota: number;
  units_per_unit: number;
  /** 老记录没有快照（group_rate=0）；为 false 时不能把 0 读成免费。 */
  recorded: boolean;
}

/** GET /api/logs/usage/:id：列表行的全部字段 + 原文快照 + 账单聚合。 */
interface UsageDetail extends UsageItem {
  input_recorded?: boolean;
  prompt_recorded?: boolean;
  output_recorded?: boolean;
  input_text: string;
  prompt_text: string;
  output_text: string;
  text_truncated: boolean;
  billing?: UsageBilling;
}

interface UsageSummary {
  calls: number;
  errors: number;
  attempts: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  avg_first_token_ms: number;
  avg_latency_ms: number;
}

interface UsageFilterOptions {
  models: { value: string; count: number }[];
  tokens: { id: number; name: string; count: number }[];
  channels: { id: number; name: string; count: number }[];
}

interface UsageListResponse {
  items: UsageItem[];
  total: number;
  page: number;
  size: number;
  admin: boolean;
  can_view_channel: boolean;
}

const PAGE_SIZE = 20;

const RANGE_OPTIONS = [
  { value: "1", label: "近 24 小时" },
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "0", label: "全部时间" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "success", label: "成功" },
  { value: "error", label: "错误" },
  { value: "attempt", label: "账号尝试失败" },
];

const NO_FILTERS: UsageFilterOptions = { models: [], tokens: [], channels: [] };

export default function AdminLogs() {
  const currency = useCurrency();
  const { can } = useAuth();
  // 后端响应里的 admin 才是最终口径；先按能力点渲染，避免首帧闪一下列。
  const mayViewAll = can(Perm.LogViewAll);

  const [items, setItems] = useState<UsageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [filterOptions, setFilterOptions] = useState<UsageFilterOptions>(NO_FILTERS);
  const [scope, setScope] = useState({ admin: mayViewAll, canViewChannel: mayViewAll });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 详情：列表行先渲染，详情接口返回后替换成带原文与账单的完整记录。
  const [detail, setDetail] = useState<UsageItem | null>(null);
  const [detailFull, setDetailFull] = useState<UsageDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);

  // 筛选条件
  const [days, setDays] = useState("30");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");

  const requestId = useRef(0);

  // 关键词输入即搜会按每个按键发一次请求；等用户停一下再搜。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedKeyword(keyword.trim());
      setPage(1);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const load = useCallback(async () => {
    const token = ++requestId.current;
    setLoading(true);
    setLoadError(null);

    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      days,
    });
    if (model) params.set("model", model);
    if (status) params.set("status", status);
    if (tokenId) params.set("token_id", tokenId);
    if (channelId && scope.admin) params.set("channel_id", channelId);
    if (appliedKeyword) params.set("keyword", appliedKeyword);
    const query = params.toString();

    // 列表与汇总分开取：汇总挂了列表照常显示，而不是整页空白。
    const [listResult, summaryResult] = await Promise.allSettled([
      apiRequest<UsageListResponse>(`/api/logs/usage?${query}`),
      apiRequest<UsageSummary>(`/api/logs/usage/summary?${query}`),
    ]);
    if (token !== requestId.current) return;

    if (listResult.status === "fulfilled") {
      setItems(listResult.value.items ?? []);
      setTotal(listResult.value.total ?? 0);
      setScope({ admin: Boolean(listResult.value.admin), canViewChannel: Boolean(listResult.value.can_view_channel) });
    } else {
      setItems([]);
      setTotal(0);
      setLoadError(listResult.reason instanceof ApiRequestError ? listResult.reason.message : "使用记录加载失败");
    }
    // 汇总失败时清空而不是保留上一次的数据，避免旧范围数字与新范围表格并存。
    setSummary(summaryResult.status === "fulfilled" ? summaryResult.value : null);
    setLoading(false);
  }, [page, days, model, status, tokenId, channelId, appliedKeyword, scope.admin]);

  useEffect(() => {
    void load();
  }, [load]);

  // 筛选下拉的候选项与列表同一时间口径，只统计当前范围内出现过的值。
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ days });
    if (status) params.set("status", status);
    apiRequest<UsageFilterOptions>(`/api/logs/usage/filters?${params.toString()}`)
      .then((data) => {
        if (alive) {
          setFilterOptions({ models: data.models ?? [], tokens: data.tokens ?? [], channels: data.channels ?? [] });
        }
      })
      .catch(() => {
        /* 下拉拿不到就保留上一次的选项，不影响主列表 */
      });
    return () => {
      alive = false;
    };
  }, [days, status]);

  /** 打开详情：先用列表行立即渲染，再请求详情接口补充原文与账单快照。 */
  const openDetail = useCallback((row: UsageItem) => {
    const token = ++detailRequest.current;
    setDetail(row);
    setDetailFull(null);
    setDetailError(null);
    setDetailLoading(true);
    setDetailOpen(true);

    apiRequest<UsageDetail>(`/api/logs/usage/${row.id}`)
      .then((data) => {
        if (token === detailRequest.current) setDetailFull(data);
      })
      .catch((error: unknown) => {
        if (token !== detailRequest.current) return;
        setDetailError(error instanceof ApiRequestError ? error.message : "详情加载失败");
      })
      .finally(() => {
        if (token === detailRequest.current) setDetailLoading(false);
      });
  }, []);

  /** 关闭只作废在途请求并收起面板：行数据留到下一次打开，退出动画里内容不会闪空。 */
  const closeDetail = useCallback(() => {
    detailRequest.current += 1;
    setDetailOpen(false);
    setDetailLoading(false);
  }, []);

  const modelOptions = [
    { value: "", label: "全部模型" },
    ...filterOptions.models.map((m) => ({ value: m.value, label: `${m.value}（${m.count}）` })),
  ];
  const tokenOptions = [
    { value: "", label: "全部密钥" },
    ...filterOptions.tokens.map((t) => ({ value: String(t.id), label: `${t.name || `#${t.id}`}（${t.count}）` })),
  ];
  const channelOptions = [
    { value: "", label: "全部账号" },
    ...filterOptions.channels.map((c) => ({ value: String(c.id), label: `${c.name || `#${c.id}`}（${c.count}）` })),
  ];

  const columns: DataColumn<UsageItem>[] = [
    {
      key: "created_at",
      label: "时间",
      sortable: true,
      width: 100,
      render: (_, row) => (
        <span className={styles.timeCell} data-log-id={row.id}>
          <span className={styles.timeClock}>{clockOf(row.created_at)}</span>
          <span className={styles.timeDate}>{dateOf(row.created_at)}</span>
        </span>
      ),
    },
    ...(scope.admin
      ? [
          {
            key: "user",
            label: "用户",
            sortable: false,
            width: 150,
            render: (_: unknown, row: UsageItem) => <UserCell row={row} />,
          } as DataColumn<UsageItem>,
        ]
      : []),
    {
      key: "model",
      label: "模型",
      sortable: true,
      width: 190,
      render: (_, row) => <ModelCell model={row.model} />,
    },
    {
      key: "billing",
      label: "计费",
      sortable: false,
      width: 132,
      render: (_, row) => <BillingCell row={row} currency={currency} />,
    },
    {
      key: "tokens",
      label: "Tokens",
      sortable: false,
      width: 150,
      render: (_, row) => (
        <span className={styles.metricCell}>
          <MetricRow
            icon={<ArrowDownToLine className={styles.metricIcon} size={12} aria-hidden="true" />}
            label="输入"
            value={formatNumber(row.prompt_tokens)}
          />
          <MetricRow
            icon={<ArrowUpFromLine className={styles.metricIcon} size={12} aria-hidden="true" />}
            label="输出"
            value={formatNumber(row.completion_tokens)}
          />
          <MetricRow
            icon={<Database className={styles.metricIcon} size={12} aria-hidden="true" />}
            label="缓存"
            value={formatNumber(row.cached_tokens)}
            muted={!row.cached_tokens}
          />
        </span>
      ),
    },
    {
      key: "duration",
      label: "首字 / 总耗时",
      sortable: false,
      width: 124,
      render: (_, row) => (
        <span className={styles.metricCell}>
          <MetricRow label="首字" value={formatDuration(row.first_token_ms)} tone={durationTone(row.first_token_ms)} />
          <MetricRow label="总耗时" value={formatDuration(row.latency_ms)} tone={durationTone(row.latency_ms)} />
        </span>
      ),
    },
    {
      key: "token",
      label: "密钥",
      sortable: false,
      width: 112,
      render: (_, row) => (
        <span className={styles.truncate} title={row.token_name ? `#${row.token_id} ${row.token_name}` : undefined}>
          {row.token_name || (row.token_id ? `#${row.token_id}` : "账户额度")}
        </span>
      ),
    },
    ...(scope.canViewChannel
      ? [
          {
            key: "channel",
            label: "账号",
            sortable: false,
            width: 122,
            render: (_: unknown, row: UsageItem) => (
              <span className={styles.truncate} title={row.channel_name ? `#${row.channel_id} ${row.channel_name}` : undefined}>
                {row.channel_name || "—"}
              </span>
            ),
          } as DataColumn<UsageItem>,
        ]
      : []),
    {
      key: "source",
      label: "来源",
      sortable: false,
      width: 140,
      render: (_, row) => <CallerCell caller={row.caller_client} userAgent={row.user_agent} admin={scope.admin} />,
    },
  ];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 从单元格反查所属行的记录：行内第一个带 data-log-id 的节点是时间格。 */
  function rowFrom(target: HTMLElement): UsageItem | undefined {
    const id = target.closest("tr")?.querySelector<HTMLElement>("[data-log-id]")?.dataset.logId;
    if (!id) return undefined;
    return items.find((item) => String(item.id) === id);
  }

  /** 整行可点开详情；表头、按钮与选中文本不触发。 */
  function onTableClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, label, select, textarea, [role='button']") || window.getSelection()?.toString()) return;
    const row = rowFrom(target);
    if (row) openDetail(row);
  }

  /** 键盘等价路径：焦点落在行内时按 Enter / 空格同样打开详情。 */
  function onTableKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, label, select, textarea, [role='button']")) return;
    const row = rowFrom(target);
    if (!row) return;
    event.preventDefault();
    openDetail(row);
  }

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "使用记录" }]}>
      <div className={styles.page}>
        <h1 className={styles.title}>使用记录</h1>

        {/* ---------- 筛选 ---------- */}
        <div className={styles.toolbar}>
          <div className={styles.range}>
            <Select
              label="时间范围"
              value={days}
              options={RANGE_OPTIONS}
              onValueChange={(value) => {
                setDays(value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.model}>
            <Select
              label="模型"
              value={model}
              options={modelOptions}
              onValueChange={(value) => {
                setModel(value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.status}>
            <Select
              label="状态"
              value={status}
              options={STATUS_OPTIONS}
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.token}>
            <Select
              label="密钥"
              value={tokenId}
              options={tokenOptions}
              onValueChange={(value) => {
                setTokenId(value);
                setPage(1);
              }}
            />
          </div>
          {scope.admin && (
            <div className={styles.channel}>
              <Select
                label="账号"
                value={channelId}
                options={channelOptions}
                onValueChange={(value) => {
                  setChannelId(value);
                  setPage(1);
                }}
              />
            </div>
          )}
          <div className={styles.search}>
            <SearchField
              label="搜索"
              value={keyword}
              placeholder={scope.admin ? "搜索用户 / 内容 / 模型" : "搜索内容 / 模型"}
              onValueChange={setKeyword}
            />
          </div>
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </Button>
        </div>

        {/* ---------- 汇总：紧凑标签条，主体是记录表，统计只做辅助 ---------- */}
        {summary && (
          <div className={styles.stats} aria-label="区间汇总">
            <StatChip label="调用" value={formatNumber(summary.calls)} hint="区间调用次数" />
            <StatChip label="错误" value={formatNumber(summary.errors)} tone={summary.errors > 0 ? "danger" : undefined} hint="所有账号都没成功的请求" />
            <StatChip label="账号尝试失败" value={formatNumber(summary.attempts)} tone={summary.attempts > 0 ? "warning" : undefined} hint="换账号后整体可能仍成功" />
            <StatChip
              label="消耗"
              value={
                <span className={styles.amount}>
                  {formatQuota(summary.cost, currency.unitsPerUnit)}
                  <CurrencyIcon src={currency.icon} size="0.9em" />
                </span>
              }
              hint="区间实际扣费"
            />
            <StatChip
              label="Tokens"
              value={formatNumber(summary.prompt_tokens + summary.completion_tokens)}
              hint={`提示 ${formatNumber(summary.prompt_tokens)} · 补全 ${formatNumber(summary.completion_tokens)}`}
            />
            <StatChip
              label="缓存命中"
              value={cacheRateOf(summary)}
              tone={cacheRateOf(summary) !== "—" && (summary.cached_tokens / Math.max(1, summary.prompt_tokens)) * 100 >= 50 ? "success" : undefined}
              hint={`命中 ${formatNumber(summary.cached_tokens)} / 输入 ${formatNumber(summary.prompt_tokens)}`}
            />
            <StatChip label="平均首字" value={formatDuration(summary.avg_first_token_ms)} hint="流式首个增量到达的平均耗时" />
            <StatChip label="平均耗时" value={formatDuration(summary.avg_latency_ms)} hint="端到端平均耗时" />
          </div>
        )}

        {/* ---------- 列表 ---------- */}
        {loadError && (
          <div className={styles.error} role="alert">
            <span className={styles.errorText}>使用记录加载失败：{loadError}</span>
            <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {loading && !items.length ? (
          <p className={styles.loading}>正在加载使用记录…</p>
        ) : items.length ? (
          <>
            <div className={styles.table} data-loading={loading || undefined} onClick={onTableClick} onKeyDown={onTableKeyDown}>
              <SortableDataTable<UsageItem>
                rows={items}
                columns={columns}
                rowKey="id"
                caption="使用记录列表"
                emptyMessage="没有匹配的使用记录"
                defaultSort={{ key: "created_at", direction: "desc" }}
                itemName={{ one: "条记录", other: "条记录" }}
              />
            </div>
            <div className={styles.pagination}>
              <span>共 {formatNumber(total)} 条 · 每页 {PAGE_SIZE} 条</span>
              <Pagination page={page} pageCount={pageCount} onPageChange={setPage} label="使用记录分页" />
            </div>
          </>
        ) : !loadError ? (
          <div className={styles.empty}>
            <EmptyState
              icon={<FileText size={22} aria-hidden="true" />}
              title="暂无使用记录"
              description="调用接口后会在这里看到每一次请求的模型、用量与费用；也可以调整上面的筛选条件。"
            />
          </div>
        ) : null}
      </div>

      {/* ---------- 调用详情：Bottom sheet。整行点击或回车打开 ---------- */}
      <BottomSheet
        open={detailOpen}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        title="调用详情"
        description={detail ? `${detail.model || "（模型未记录）"} · ${detail.created_at || "（时间未记录）"}` : undefined}
        detents={[0.6, 0.94]}
        initialDetent={0}
        closeLabel="关闭"
      >
        {detail && (
          <ScrollArea className={styles.sheetScroll} label="调用详情内容" fade={14}>
            <div className={styles.sheetContent}>
              <BillingSection row={detailFull ?? detail} billing={(detailFull ?? detail).billing} currency={currency} />
              <ContentSection full={detailFull} loading={detailLoading} error={detailError} />
              <RequestSection row={detailFull ?? detail} admin={scope.admin} canViewChannel={scope.canViewChannel} />
            </div>
          </ScrollArea>
        )}
      </BottomSheet>
    </AdminLayout>
  );
}

/* ---------- 单元格 ---------- */

function MetricRow({
  label,
  value,
  tone,
  muted,
  icon,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning" | "danger";
  muted?: boolean;
  /** 行首小图标（Tokens 列）。 */
  icon?: ReactNode;
}) {
  return (
    <span className={styles.metricRow} data-icon={icon ? "" : undefined}>
      <span className={styles.metricLabel}>
        {icon}
        {label}
      </span>
      <span className={styles.metricValue} data-tone={tone} data-muted={muted || undefined}>
        {value}
      </span>
    </span>
  );
}

function StatChip({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "danger" | "warning" | "success" }) {
  return (
    <span className={styles.stat} data-tone={tone}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </span>
  );
}

/** 用户：头像 + 名称（+ 账号），表格与详情共用。 */
function UserCell({ row }: { row: UsageItem }) {
  return (
    <span className={styles.userCell}>
      <Avatar name={displayNameOf(row)} src={row.avatar_url || undefined} size="sm" />
      <span className={styles.userText}>
        <span className={styles.userName}>{displayNameOf(row)}</span>
        {row.display_name && row.username ? <span className={styles.userHandle}>@{row.username}</span> : null}
      </span>
    </span>
  );
}

/** 模型：厂商图标 + 模型名（不按模型名猜渠道，图标只表示厂商线索）。 */
function ModelCell({ model }: { model: string }) {
  const [broken, setBroken] = useState(false);
  const icon = vendorIconUrl(vendorOfModel(model));
  return (
    <span className={styles.modelCell}>
      {icon && !broken ? (
        <img className={styles.modelIcon} src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <Cpu className={styles.modelFallback} size={14} aria-hidden="true" />
      )}
      <span className={styles.modelName} title={model || undefined}>
        {model || "—"}
      </span>
    </span>
  );
}

/** 计费：失败类型先给状态标签，金额只在实际扣费时显示。 */
function BillingCell({ row, currency }: { row: UsageItem; currency: CurrencyConfig }) {
  const amount =
    row.quota > 0 ? (
      <span className={styles.amount}>
        {formatQuota(row.quota, currency.unitsPerUnit)}
        <CurrencyIcon src={currency.icon} size="0.9em" />
      </span>
    ) : null;
  if (row.type === 3) {
    return (
      <span className={styles.billingCell}>
        <Badge size="sm" tone="danger">调用失败</Badge>
        {amount}
      </span>
    );
  }
  if (row.type === 4) {
    return (
      <span className={styles.billingCell}>
        <Badge size="sm" tone="warning">账号失败</Badge>
        {amount}
      </span>
    );
  }
  return <span className={styles.billingCell}>{amount ?? <span className={styles.muted}>—</span>}</span>;
}

/** 来源：按入站 UA 推测的客户端；原文只对管理员可见。 */
function CallerCell({ caller, userAgent, admin }: { caller: string; userAgent?: string; admin: boolean }) {
  const [broken, setBroken] = useState(false);
  const client = callerClient(caller);
  const icon = callerClientIcon(client);
  const ua = userAgent?.trim() ?? "";
  const tip = admin && ua ? ua : client.kind === "unknown" ? "未识别" : ua ? `${client.name} · 按入站 User-Agent 推测` : client.name;
  const Fallback = client.kind === "relay" ? Network : Terminal;
  return (
    <Tooltip content={tip}>
      <span className={styles.callerCell} tabIndex={0}>
        {icon && !broken ? (
          <img className={styles.callerMark} src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <Fallback className={styles.callerFallback} size={14} aria-hidden="true" />
        )}
        <span className={styles.callerName}>{client.kind === "unknown" ? "未识别" : client.name}</span>
      </span>
    </Tooltip>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{children}</span>
    </div>
  );
}

/* ---------- 详情区块 ---------- */

/**
 * 计费明细：直接用本次调用保存的快照字段，不按当前定价重算。
 *
 * 计费口径（与网关一致）：prompt_tokens 是含缓存命中的总输入，
 * 缓存按 cached_tokens 单独计价 —— 这里照实展示，不做「输入扣缓存」。
 */
function BillingSection({ row, billing, currency }: { row: UsageItem; billing?: UsageBilling; currency: CurrencyConfig }) {
  if (!billing) {
    return (
      <section className={styles.section} aria-label="计费明细">
        <h3 className={styles.sectionTitle}>计费明细</h3>
        <p className={styles.sectionNote}>正在加载计费快照…</p>
      </section>
    );
  }

  // 快照是后加的能力：老记录没有单价/倍率，若照常渲染会显示一串 0，
  // 看起来像「这次调用免费」。如实告知未保存分解，只展示实际扣费。
  const recorded = billing.recorded !== false;
  if (!recorded) {
    return (
      <section className={styles.section} aria-label="计费明细">
        <h3 className={styles.sectionTitle}>计费明细</h3>
        <p className={styles.sectionNote}>
          该记录未保存费用分解、单价与倍率快照；不按当前价格回填。实际扣费见下方金额。
        </p>
        <div className={styles.billSummary}>
          <SummaryRow
            label="实际扣费"
            value={
              billing.quota > 0 ? (
                <span className={styles.amount}>
                  {formatQuota(billing.quota, billing.units_per_unit || currency.unitsPerUnit)}
                  <CurrencyIcon src={currency.icon} size="0.9em" />
                </span>
              ) : (
                <span className={styles.muted}>—</span>
              )
            }
          />
        </div>
      </section>
    );
  }

  const feeOf = (tokens: number, price: number) => ((Number(tokens) || 0) / 1e6) * (Number(price) || 0);
  const lines = [
    { key: "input", label: "输入", tokens: row.prompt_tokens, price: billing.input_price },
    { key: "output", label: "输出", tokens: row.completion_tokens, price: billing.output_price },
    { key: "cached", label: "缓存读取", tokens: row.cached_tokens, price: billing.cached_price },
  ];
  const totalTokens = lines.reduce((sum, line) => sum + (Number(line.tokens) || 0), 0);
  const totalFee = lines.reduce((sum, line) => sum + feeOf(line.tokens, line.price), 0);
  const unitsPerUnit = billing.units_per_unit || currency.unitsPerUnit;

  return (
    <section className={styles.section} aria-label="计费明细">
      <h3 className={styles.sectionTitle}>计费明细</h3>
      <table className={styles.billTable}>
        <caption className={styles.srOnly}>本次调用计费明细</caption>
        <thead>
          <tr>
            <th scope="col">类别</th>
            <th scope="col" className={styles.billNum}>Token</th>
            <th scope="col" className={styles.billNum}>单价（每百万）</th>
            <th scope="col" className={styles.billNum}>费用</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key}>
              <td>{line.label}</td>
              <td className={styles.billNum}>{formatNumber(line.tokens)}</td>
              <td className={styles.billNum}>{formatPrice(line.price)}</td>
              <td className={styles.billNum}>{formatCost(feeOf(line.tokens, line.price))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>合计 · 模型调用次数 1 次</td>
            <td className={styles.billNum}>{formatNumber(totalTokens)}</td>
            <td className={styles.billNum}>—</td>
            <td className={styles.billNum}>{formatCost(totalFee)}</td>
          </tr>
        </tfoot>
      </table>
      <div className={styles.billSummary}>
        <SummaryRow label="倍率前未取整成本" value={`${formatCost(billing.raw_cost)} 单位`} />
        <SummaryRow label="倍率前计费额（取整后）" value={`${formatNumber(billing.base_quota)} 单位`} />
        <SummaryRow label="分组倍率" value={billing.group_rate > 0 ? `×${formatRate(billing.group_rate)}` : "未记录"} />
        <SummaryRow
          label="实际扣费"
          value={
            <span className={styles.amount}>
              {formatQuota(billing.quota, unitsPerUnit)}
              <CurrencyIcon src={currency.icon} size="0.9em" />
            </span>
          }
        />
      </div>
      <p className={styles.sectionNote}>
        单价为本次调用保存的平台价；倍率与金额为结算快照，不随当前定价变化。单价单位：{currency.name} / 百万 token；本页金额按 1 {currency.name} ={" "}
        {formatNumber(unitsPerUnit)} 单位换算。
      </p>
    </section>
  );
}

/** 调用内容：实际输入 / 上游上下文 / 输出原文，各用一个等宽文本块。 */
function ContentSection({ full, loading, error }: { full: UsageDetail | null; loading: boolean; error: string | null }) {
  return (
    <section className={styles.section} aria-label="调用内容">
      <h3 className={styles.sectionTitle}>调用内容</h3>
      {loading && <p className={styles.sectionNote}>正在加载调用内容…</p>}
      {error && <p className={styles.sectionError}>调用内容加载失败：{error}</p>}
      {full && (
        <>
          <TextBlock
            label="实际输入"
            value={full.input_text}
            recorded={full.input_recorded !== false}
            missing="（该记录未保存用户输入）"
            blank="（本次输入没有文本）"
          />
          <TextBlock
            label="上游上下文"
            value={full.prompt_text}
            recorded={full.prompt_recorded !== false && Boolean(full.prompt_text)}
            missing="（未保存上游上下文）"
            blank="（未保存上游上下文）"
          />
          <TextBlock
            label="输出内容"
            value={full.output_text}
            recorded={full.output_recorded !== false}
            missing="（该记录未保存输出原文）"
            blank="（本次调用没有输出）"
          />
          {full.text_truncated && <p className={styles.sectionNote}>原文较长，已保留部分内容（最多 4000 字符）。</p>}
        </>
      )}
    </section>
  );
}

/**
 * 等宽文本块：超出 max-height 由 Arc ScrollArea 内部滚动。
 *
 * recorded 区分「未保存」与「确实为空」—— 老记录三个字段是 NULL，
 * 照直说「没有文本」会把系统没记当成用户没发。
 */
function TextBlock({ label, value, recorded, missing, blank }: { label: string; value?: string; recorded: boolean; missing: string; blank: string }) {
  const text = typeof value === "string" ? value.trim() : "";
  return (
    <div className={styles.textBlock}>
      <span className={styles.textLabel}>{label}</span>
      <ScrollArea className={styles.textScroll} maxHeight={180} fade={12} label={label}>
        {text ? (
          <pre className={styles.textContent}>{value}</pre>
        ) : (
          <p className={styles.textEmpty}>{recorded ? blank : missing}</p>
        )}
      </ScrollArea>
    </div>
  );
}

/** 请求信息：时间、用户、模型映射、用量与链路细节。 */
function RequestSection({ row, admin, canViewChannel }: { row: UsageItem; admin: boolean; canViewChannel: boolean }) {
  const mapping = admin ? modelMapping(row) : [];
  return (
    <section className={styles.section} aria-label="请求信息">
      <h3 className={styles.sectionTitle}>请求信息</h3>
      <div className={styles.detailList}>
        <DetailRow label="时间">{row.created_at || "—"}</DetailRow>
        <DetailRow label="用户">
          <UserCell row={row} />
        </DetailRow>
        <DetailRow label="模型">
          <span className={styles.modelBlock}>
            <ModelCell model={row.model} />
            {mapping.map((line) => (
              <span key={line} className={styles.modelMapping}>
                {line}
              </span>
            ))}
          </span>
        </DetailRow>
        <DetailRow label="类型">{usageTypeBadge(row.type)}</DetailRow>
        <DetailRow label="Tokens">
          <span className={styles.breakdown}>
            <span>输入 {formatNumber(row.prompt_tokens)}</span>
            <span>输出 {formatNumber(row.completion_tokens)}</span>
            <span>缓存 {formatNumber(row.cached_tokens)}</span>
            <span className={styles.breakdownTotal}>合计 {formatNumber(row.prompt_tokens + row.completion_tokens)}</span>
          </span>
        </DetailRow>
        <DetailRow label="首字 / 总耗时">
          <span className={styles.durationLine}>
            <span data-tone={durationTone(row.first_token_ms)}>{formatDuration(row.first_token_ms)}</span>
            <span className={styles.muted}> / </span>
            <span data-tone={durationTone(row.latency_ms)}>{formatDuration(row.latency_ms)}</span>
          </span>
        </DetailRow>
        <DetailRow label="密钥">
          {row.token_id ? `#${row.token_id} ${row.token_name || "（名称未记录）"}` : "账户额度（未用密钥）"}
        </DetailRow>
        {canViewChannel && (
          <DetailRow label="账号">{row.channel_name ? `#${row.channel_id} ${row.channel_name}` : "—"}</DetailRow>
        )}
        <DetailRow label="IP">{row.ip || "—"}</DetailRow>
        {admin && <DetailRow label="设备 / User-Agent">{row.user_agent || "—"}</DetailRow>}
        <DetailRow label="调用来源">
          {callerLabel(row.caller_client)}
          <span className={styles.muted}> · 按入站 User-Agent 推测，未验证来源</span>
        </DetailRow>
        <DetailRow label="状态详情">
          <span className={row.type !== 2 ? styles.failText : undefined}>{row.detail || "—"}</span>
        </DetailRow>
      </div>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.billSummaryRow}>
      <span className={styles.billSummaryLabel}>{label}</span>
      <span className={styles.billSummaryValue}>{value}</span>
    </div>
  );
}

/* ---------- 格式化 ---------- */

/** 模型映射只给管理员看；与记录里的模型相同就不重复展示。 */
function modelMapping(row: UsageItem): string[] {
  const lines: string[] = [];
  const chain: string[] = [];
  if (row.requested_model && row.requested_model !== row.model) chain.push(`请求 ${row.requested_model}`);
  if (row.upstream_model && row.upstream_model !== row.model) chain.push(`上游 ${row.upstream_model}`);
  if (chain.length) lines.push(chain.join(" → "));
  if (row.pricing_model && row.pricing_model !== row.model) lines.push(`计费 ${row.pricing_model}`);
  return lines;
}

function displayNameOf(row: UsageItem): string {
  return row.display_name || row.username || "—";
}

function usageTypeBadge(type: number) {
  if (type === 2) return <Badge size="sm" tone="success">成功</Badge>;
  if (type === 3) return <Badge size="sm" tone="danger">请求失败</Badge>;
  if (type === 4) return <Badge size="sm" tone="warning">账号尝试失败</Badge>;
  return <Badge size="sm" tone="neutral">其他</Badge>;
}

function callerLabel(value?: string): string {
  const client = callerClient(value);
  return client.kind === "unknown" ? "未识别" : client.name;
}

function clockOf(raw: string): string {
  if (!raw) return "—";
  return raw.length > 10 ? raw.slice(11, 19) : raw;
}

function dateOf(raw: string): string {
  if (!raw) return "—";
  return raw.slice(0, 10);
}

function formatNumber(value: number | null | undefined): string {
  return (Number(value) || 0).toLocaleString("zh-CN");
}

function formatQuota(units: number, unitsPerUnit: number): string {
  if (!unitsPerUnit) return "0";
  const value = units / unitsPerUnit;
  if (value === 0) return "0";
  // 小额费用保留 6 位小数，否则会全被舍成 0.0000。
  return value < 0.01 ? value.toFixed(6) : value.toFixed(4);
}

/** 成本 / 费用：最多 6 位小数，去掉多余的零；取整后为 0 的非零值显式标出来。 */
function formatCost(value: number): string {
  const n = Number(value) || 0;
  if (n === 0) return "0";
  const rounded = Number(n.toFixed(6));
  if (rounded === 0) return "<0.000001";
  return String(rounded);
}

/** 单价：货币 / 百万 token，最多 6 位小数。 */
function formatPrice(value: number): string {
  const n = Number(value) || 0;
  if (n === 0) return "0";
  return String(Number(n.toFixed(6)));
}

function formatRate(value: number): string {
  return String(Number((Number(value) || 0).toFixed(4)));
}

function formatDuration(value: number | null | undefined): string {
  const n = Number(value) || 0;
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

/** 耗时着色：<5s 绿、5–15s 黄、≥15s 红；0 / 未记录不着色。 */
function durationTone(value: number): "success" | "warning" | "danger" | undefined {
  const n = Number(value) || 0;
  if (n <= 0) return undefined;
  if (n >= 15000) return "danger";
  if (n >= 5000) return "warning";
  return "success";
}

function cacheRateOf(summary: UsageSummary): string {
  if (!summary.prompt_tokens) return "—";
  return `${((summary.cached_tokens / summary.prompt_tokens) * 100).toFixed(1)}%`;
}
