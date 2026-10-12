import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { History, Network, RefreshCw, Terminal } from "lucide-react";

import { Avatar } from "@/components/arc/avatar/avatar";
import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
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

import styles from "./AdminOperationLogs.module.css";

/**
 * 操作日志：行为审计（谁改了配置、谁登录过）。
 *
 * 与「使用记录」分成两页：那边是用量审计（每次模型调用），
 * 这边是操作审计。查询维度、保留策略、读者都不同，
 * 混在一起会让真正的操作记录被调用记录淹没。
 *
 *   1 = 管理操作
 *   5 = 登录
 */
interface OperationItem extends Record<string, unknown> {
  id: number;
  user_id: number;
  username: string;
  display_name: string;
  avatar_url: string;
  type: number;
  action: string;
  detail: string;
  quota: number;
  ip: string;
  user_agent?: string;
  caller_client: string;
  created_at: string;
}

interface OperationListResponse {
  items: OperationItem[];
  total: number;
  page: number;
  size: number;
  admin: boolean;
}

const PAGE_SIZE = 20;

const RANGE_OPTIONS = [
  { value: "1", label: "今天" },
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "0", label: "全部时间" },
];

const TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "1", label: "管理操作" },
  { value: "5", label: "登录" },
];

export default function AdminOperationLogs() {
  const currency = useCurrency();
  const { can } = useAuth();
  // 后端响应里的 admin 才是最终口径；先按能力点渲染，避免首帧闪一下管理员信息。
  const mayViewAll = can(Perm.LogViewAll);

  const [items, setItems] = useState<OperationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [admin, setAdmin] = useState(mayViewAll);
  const [detail, setDetail] = useState<OperationItem | null>(null);

  // 筛选条件
  const [days, setDays] = useState("30");
  const [type, setType] = useState("");
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
    if (type) params.set("type", type);
    if (appliedKeyword) params.set("keyword", appliedKeyword);

    try {
      const data = await apiRequest<OperationListResponse>(`/api/logs/operation?${params.toString()}`);
      if (token !== requestId.current) return;
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setAdmin(Boolean(data.admin));
    } catch (err) {
      if (token !== requestId.current) return;
      setItems([]);
      setTotal(0);
      setLoadError(err instanceof ApiRequestError ? err.message : "操作日志加载失败");
    } finally {
      if (token === requestId.current) setLoading(false);
    }
  }, [page, days, type, appliedKeyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataColumn<OperationItem>[] = [
    {
      key: "created_at",
      label: "时间",
      sortable: true,
      width: 152,
      render: (_, row) => (
        <span className={styles.timeCell} data-op-id={row.id}>
          {row.created_at || "—"}
        </span>
      ),
    },
    {
      key: "user",
      label: "操作者",
      sortable: false,
      width: 186,
      render: (_, row) => (
        <span className={styles.userCell}>
          <Avatar name={row.display_name || row.username || "—"} src={row.avatar_url || undefined} size="sm" />
          <span className={styles.userText}>
            <span className={styles.userName}>{row.display_name || row.username || "—"}</span>
            {row.username && row.display_name ? <span className={styles.userHandle}>@{row.username}</span> : null}
          </span>
        </span>
      ),
    },
    {
      key: "type",
      label: "类型",
      sortable: false,
      width: 92,
      render: (_, row) => operationTypeBadge(row.type),
    },
    {
      key: "content",
      label: "内容",
      sortable: false,
      render: (_, row) => (
        <span className={styles.ellipsis} title={row.action || undefined}>
          {row.action || "—"}
        </span>
      ),
    },
    {
      key: "quota",
      label: "额度变动",
      sortable: false,
      width: 132,
      render: (_, row) => <QuotaCell row={row} currency={currency} />,
    },
    {
      key: "ip",
      label: "IP",
      sortable: false,
      width: 132,
      render: (_, row) => <span className={styles.ipCell}>{row.ip || "—"}</span>,
    },
    {
      key: "source",
      label: "来源",
      sortable: false,
      width: 140,
      render: (_, row) => <CallerCell caller={row.caller_client} userAgent={row.user_agent} admin={admin} />,
    },
    {
      key: "detail",
      label: "详情",
      sortable: false,
      width: 84,
      render: (_, row) => (
        <Button
          className={styles.rowAction}
          size="sm"
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation();
            setDetail(row);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 整行可点开详情；表头、按钮与选中文本不触发。 */
  function onTableClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, label, select, textarea, [role='button']") || window.getSelection()?.toString()) return;
    const id = target.closest("tr")?.querySelector<HTMLElement>("[data-op-id]")?.dataset.opId;
    if (!id) return;
    const row = items.find((item) => String(item.id) === id);
    if (row) setDetail(row);
  }

  return (
    <AdminLayout crumbs={[{ label: "后台", href: "/admin" }, { label: "操作日志" }]}>
      <div className={styles.page}>
        <h1 className={styles.title}>操作日志</h1>

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
          <div className={styles.type}>
            <Select
              label="类型"
              value={type}
              options={TYPE_OPTIONS}
              onValueChange={(value) => {
                setType(value);
                setPage(1);
              }}
            />
          </div>
          <div className={styles.search}>
            <SearchField
              label="搜索"
              value={keyword}
              placeholder={admin ? "搜索用户 / 内容" : "搜索内容"}
              onValueChange={setKeyword}
            />
          </div>
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </Button>
        </div>

        {/* ---------- 列表 ---------- */}
        {loadError && (
          <div className={styles.error} role="alert">
            <span className={styles.errorText}>操作日志加载失败：{loadError}</span>
            <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {loading && !items.length ? (
          <p className={styles.loading}>正在加载操作日志…</p>
        ) : items.length ? (
          <>
            <div className={styles.table} data-loading={loading || undefined} onClick={onTableClick}>
              <SortableDataTable<OperationItem>
                rows={items}
                columns={columns}
                rowKey="id"
                caption="操作日志列表"
                emptyMessage="没有匹配的操作记录"
                defaultSort={{ key: "created_at", direction: "desc" }}
                itemName={{ one: "条记录", other: "条记录" }}
              />
            </div>
            <div className={styles.pagination}>
              <span>共 {formatNumber(total)} 条 · 每页 {PAGE_SIZE} 条</span>
              <Pagination page={page} pageCount={pageCount} onPageChange={setPage} label="操作日志分页" />
            </div>
          </>
        ) : !loadError ? (
          <div className={styles.empty}>
            <EmptyState
              icon={<History size={22} aria-hidden="true" />}
              title="暂无操作记录"
              description="管理操作与登录会记录在这里。可以调整时间范围或关键词后再看。"
            />
          </div>
        ) : null}
      </div>

      {/* ---------- 操作详情 ---------- */}
      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className={styles.detailDialog} bodyClassName={styles.detailBody} title="操作详情">
          {detail && (
            <>
              <ScrollArea className={styles.detailScroll} label="操作详情内容" fade={14}>
                <div className={styles.detailList}>
                  <DetailRow label="时间">{detail.created_at || "—"}</DetailRow>
                  <DetailRow label="操作者">
                    <span className={styles.detailUser}>
                      <Avatar name={detail.display_name || detail.username || "—"} src={detail.avatar_url || undefined} size="sm" />
                      <span>
                        {detail.display_name || detail.username || "—"}
                        {detail.display_name && detail.username ? <span className={styles.muted}>（@{detail.username}）</span> : null}
                      </span>
                    </span>
                  </DetailRow>
                  <DetailRow label="类型">{operationTypeBadge(detail.type)}</DetailRow>
                  <DetailRow label="内容">{detail.action || "—"}</DetailRow>
                  <DetailRow label="详情">
                    <span className={detail.detail ? undefined : styles.muted}>{detail.detail || "—"}</span>
                  </DetailRow>
                  <DetailRow label="额度变动">
                    <QuotaCell row={detail} currency={currency} />
                  </DetailRow>
                  <DetailRow label="IP">{detail.ip || "—"}</DetailRow>
                  {admin && <DetailRow label="设备 / User-Agent">{detail.user_agent || "—"}</DetailRow>}
                  <DetailRow label="来源">
                    {callerLabel(detail.caller_client)}
                    <span className={styles.muted}> · 按入站 User-Agent 推测，未验证来源</span>
                  </DetailRow>
                </div>
              </ScrollArea>
              <div className={styles.detailActions}>
                <Button size="sm" variant="secondary" onClick={() => setDetail(null)}>
                  关闭
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

/* ---------- 单元格 ---------- */

/** 额度变动：管理操作可能带来增额（+），其余按扣减（-）展示。 */
function QuotaCell({ row, currency }: { row: OperationItem; currency: CurrencyConfig }) {
  const quota = Number(row.quota) || 0;
  if (!quota) {
    return <span className={styles.muted}>—</span>;
  }
  const positive = row.type === 1 && quota > 0;
  return (
    <span className={styles.quotaCell} data-positive={positive || undefined}>
      {positive ? "+" : "-"}
      {formatQuota(Math.abs(quota), currency.unitsPerUnit)}
      <CurrencyIcon src={currency.icon} size="0.9em" />
    </span>
  );
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

/* ---------- 格式化 ---------- */

function operationTypeBadge(type: number) {
  if (type === 1) return <Badge size="sm" tone="info">管理</Badge>;
  if (type === 5) return <Badge size="sm" tone="neutral">登录</Badge>;
  return <Badge size="sm" tone="neutral">其他</Badge>;
}

function callerLabel(value?: string): string {
  const client = callerClient(value);
  return client.kind === "unknown" ? "未识别" : client.name;
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
