import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import Badge, { type BadgeTone } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Card } from "@/components/arc/card/card";
import { ApiRequestError, reportUnauthorized } from "@/lib/api";

import LiveBalancePanel from "./LiveBalancePanel";
import deskStyles from "./TradingDesk.module.css";
import styles from "./TradingWorkbench.module.css";
import { getEngineBalance, type EngineBalance } from "./tradingApi";

/**
 * 交易工作台。
 *
 * 上面是账户额度，下面把这条测试链按角色摊成盒子：抓行情、扫描、提案、
 * 审核、决策，再到风控与撮合。上一轮的结果留在盒子上，点开看这一步的原始产物。
 *
 * 流程走 SSE：后端每推进一步就写一条事件，页面据此标出当前在跑哪个角色。
 * 因此这里用裸 fetch 而不是 apiRequest —— 流式响应要自己读 body，
 * 套不进那一层统一封装；代价是 401 得自己报上去（见下面的 reportUnauthorized）。
 *
 * 账户读的是「最新策略」绑定的交易所账户（服务端在没传 strategyId 时回落），
 * 与这条链无关：链跑在测试盘行情上，撮合是纸面的，不碰账户。
 */

const ROLES = ["CRAWLER", "SCAN", "CHIEF", "VET", "决策", "RISK", "FILLS"] as const;

type RoleName = (typeof ROLES)[number];
type NodeStatus = "pending" | "running" | "done" | "error";

interface NodeState {
  status: NodeStatus;
  /** 后端给的模型名。本地规则那几步没有模型，这里是空串。 */
  model: string;
  /** 一句话结论，就是盒子正面显示的那行。 */
  summary: string;
  /** 原始产物，点开盒子才看。 */
  artifact: string;
}

interface StreamEvent {
  role?: string;
  status: NodeStatus | "complete";
  summary?: string;
  artifact?: string;
  model?: string;
}

const STATUS: Record<NodeStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: "neutral", label: "等待" },
  running: { tone: "info", label: "进行中" },
  done: { tone: "success", label: "完成" },
  error: { tone: "danger", label: "失败" },
};

/** 账户额度刷新间隔。这是交易所账户实读，不动它就一直停在进页面那一刻。 */
const BALANCE_POLL_MS = 30_000;

const WORKBENCH_STREAM = "/api/trading/workbench/decision";

function isRole(value: string | undefined): value is RoleName {
  return value !== undefined && (ROLES as readonly string[]).includes(value);
}

function emptyNodes(): Record<RoleName, NodeState> {
  const nodes = {} as Record<RoleName, NodeState>;
  for (const role of ROLES) {
    nodes[role] = { status: "pending", model: "", summary: "", artifact: "" };
  }
  return nodes;
}

/** 一条事件落进对应盒子。未跑到的角色保持原样，不做占位推断。 */
function applyEvent(
  setNodes: Dispatch<SetStateAction<Record<RoleName, NodeState>>>,
  event: StreamEvent,
): void {
  if (event.status === "complete" || !isRole(event.role)) return;
  const role = event.role;
  if (event.status === "running") {
    setNodes((current) => ({ ...current, [role]: { ...current[role], status: "running" } }));
    return;
  }
  setNodes((current) => ({
    ...current,
    [role]: {
      status: event.status === "error" ? "error" : "done",
      model: event.model ?? current[role].model,
      summary: event.summary ?? "",
      artifact: event.artifact ?? "",
    },
  }));
}

function summaryOf(node: NodeState, busy: boolean): string {
  if (node.status === "running") return "进行中…";
  // 没跑起来之前说「等待上一步」是假话 —— 没有任何一步在跑。
  if (node.status === "pending") return busy ? "等待上一步" : "尚未运行";
  return node.summary || "这一步没有回报。";
}

function modelOf(node: NodeState): string | undefined {
  if (node.model) return node.model;
  // 跑完之后仍然没有模型名，说明这一步走的是服务端本地规则（抓行情、扫描、风控、撮合）。
  if (node.status === "done" || node.status === "error") return "本地规则";
  return undefined;
}

function RoleCard({ role, node, busy }: { role: RoleName; node: NodeState; busy: boolean }) {
  const status = STATUS[node.status];
  return (
    <Card
      title={role}
      description={summaryOf(node, busy)}
      meta={modelOf(node)}
      action={
        <Badge tone={status.tone} size="sm">
          {status.label}
        </Badge>
      }
      // 没有产物就不展开：空盒子不该能点开一个空面板。
      details={
        node.artifact ? (
          <pre className={styles.artifact}>{node.artifact}</pre>
        ) : undefined
      }
    />
  );
}

export default function TradingWorkbench() {
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState(emptyNodes);
  const [failed, setFailed] = useState<string | null>(null);
  const [balance, setBalance] = useState<EngineBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceError, setBalanceError] = useState<string | undefined>(undefined);

  // 一轮要打模型，可能跑几十秒。换页或被下一轮打断时得把流掐掉，
  // 否则读到的分片会继续往已经离场的组件里写。
  const stream = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;

    setBusy(true);
    setFailed(null);
    setNodes(emptyNodes());

    try {
      const response = await fetch(WORKBENCH_STREAM, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });

      if (response.status === 401) {
        // 会话在中途失效。别的页面由 apiRequest 统一跳登录页，
        // 这条流绕过了那一层，得自己把信号报上去，不然同一件事表现不一致。
        reportUnauthorized();
        return;
      }
      if (!response.ok || !response.body) {
        setFailed(`这一轮没有跑起来（HTTP ${response.status}）`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 用空行分隔事件；末尾那段可能还没收全，留在 buffer 里等下一片。
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            continue; // 半条 JSON 不该让整轮停下
          }
          applyEvent(setNodes, event);
        }
      }
    } catch (err) {
      // 主动掐掉的流不算失败。
      if (controller.signal.aborted) return;
      setFailed(err instanceof Error ? err.message : "这一轮中断了");
    } finally {
      if (stream.current === controller) {
        stream.current = null;
        setBusy(false);
      }
    }
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      setBalance(await getEngineBalance());
      setBalanceError(undefined);
    } catch (err) {
      setBalanceError(err instanceof ApiRequestError ? err.message : "读取账户失败");
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
    const timer = window.setInterval(() => void loadBalance(), BALANCE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      stream.current?.abort();
    };
  }, [loadBalance]);

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "交易" }, { label: "工作台" }]}
    >
      <div className={deskStyles.page}>
        <header className={deskStyles.pageHead}>
          <div>
            <h1 className={deskStyles.pageTitle}>工作台</h1>
            <p className={deskStyles.pageLead}>
              上面是账户额度，下面把测试链按角色摊开：抓行情、扫描、提案、审核、决策，再到风控与撮合。
              点开盒子看这一步的原始产物。
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run()}
          >
            {busy ? "正在运行…" : "跑一轮"}
          </Button>
        </header>

        {/* 交易所账户：权益、今日盈亏、钱包/可用/保证金与持仓，与交易台同一块面板 */}
        <LiveBalancePanel balance={balance} loading={balanceLoading} error={balanceError} />

        <section className={deskStyles.panel} aria-label="测试链角色">
          <header className={deskStyles.panelHead}>
            <h2>测试链角色</h2>
            <p>
              七个角色依次交接。CRAWLER、SCAN、RISK、FILLS 是服务端本地规则，其余三步走模型。
            </p>
          </header>

          {failed ? (
            <p className={deskStyles.readError} role="alert">
              {failed}
            </p>
          ) : null}

          <div className={styles.roles}>
            {ROLES.map((role) => (
              <RoleCard key={role} role={role} node={nodes[role]} busy={busy} />
            ))}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
