import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import Badge, { type BadgeTone } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ApiRequestError, reportUnauthorized } from "@/lib/api";

import LiveBalancePanel from "./LiveBalancePanel";
import deskStyles from "./TradingDesk.module.css";
import styles from "./TradingWorkbench.module.css";
import { getEngineBalance, type EngineBalance } from "./tradingApi";

/**
 * 交易工作台。
 *
 * 左边是账户额度，右边把这条测试链摊成一条流水线：抓行情、扫描、提案、
 * 审核、决策，再到风控与撮合。流水线上能一眼看出跑到第几步，下面那块
 * 跟着展开当前这一步的模型、结论和原始产物。
 *
 * 流程走 SSE：后端每推进一步就写一条事件，页面据此标出正在跑的角色。
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
  /** 一句话结论，就是流水线上那行小字。 */
  summary: string;
  /** 原始产物，展开当前这一步才看。 */
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

function settled(node: NodeState): boolean {
  return node.status === "done" || node.status === "error";
}

function emptyNodes(): Record<RoleName, NodeState> {
  const nodes = {} as Record<RoleName, NodeState>;
  for (const role of ROLES) {
    nodes[role] = { status: "pending", model: "", summary: "", artifact: "" };
  }
  return nodes;
}

/** 一条事件落进对应步骤。未跑到的角色保持原样，不做占位推断。 */
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
  if (settled(node)) return "本地规则";
  return undefined;
}

export default function TradingWorkbench() {
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState(emptyNodes);
  const [failed, setFailed] = useState<string | null>(null);
  /** 手动点中的步骤。为空时跟着当前跑的那一步走。 */
  const [picked, setPicked] = useState<RoleName | null>(null);
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
    setPicked(null); // 重新开跑就跟着流程走，不留在上一轮看过的那一步

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

  const runningRole = useMemo(
    () => ROLES.find((role) => nodes[role].status === "running") ?? null,
    [nodes],
  );
  const doneCount = useMemo(() => ROLES.filter((role) => settled(nodes[role])).length, [nodes]);
  // 没人点过就跟着跑：正在跑的那步优先，其次最后跑完的那步。
  const active = useMemo(() => {
    if (picked) return picked;
    if (runningRole) return runningRole;
    return [...ROLES].reverse().find((role) => settled(nodes[role])) ?? ROLES[0];
  }, [picked, runningRole, nodes]);

  const activeNode = nodes[active];

  return (
    <AdminLayout
      crumbs={[{ label: "后台", href: "/admin" }, { label: "交易" }, { label: "工作台" }]}
    >
      <div className={deskStyles.page}>
        <header className={deskStyles.pageHead}>
          <div>
            <h1 className={deskStyles.pageTitle}>工作台</h1>
            <p className={deskStyles.pageLead}>
              左边是账户额度，右边跑一轮测试链：抓行情、扫描、提案、审核、决策，再到风控与撮合。
              点流水线上的任一步，看它这一步的模型、结论和原始产物。
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

        <div className={styles.layout}>
          {/* 窄栏形态：去掉曲线，权益与明细竖排。交易台那边仍是完整面板。 */}
          <LiveBalancePanel
            variant="rail"
            balance={balance}
            loading={balanceLoading}
            error={balanceError}
          />

          <section className={deskStyles.panel} aria-label="测试链">
            <header className={`${deskStyles.panelHead} ${styles.chainHead}`}>
              <div>
                <h2>测试链</h2>
                <p>
                  CRAWLER、SCAN、RISK、FILLS 是服务端本地规则，其余三步走模型。
                </p>
              </div>
              <p className={styles.progress} data-busy={busy || undefined} role="status">
                {progressText(busy, doneCount, runningRole)}
              </p>
            </header>

            {failed ? (
              <p className={deskStyles.readError} role="alert">
                {failed}
              </p>
            ) : null}

            <div className={styles.pipeline} role="group" aria-label="测试链步骤">
              {ROLES.map((role, index) => (
                <Fragment key={role}>
                  {index > 0 ? (
                    <span
                      className={styles.link}
                      data-done={settled(nodes[ROLES[index - 1]!]) || undefined}
                      aria-hidden="true"
                    />
                  ) : null}
                  <button
                    type="button"
                    className={styles.node}
                    data-active={active === role || undefined}
                    data-status={nodes[role].status}
                    aria-pressed={active === role}
                    onClick={() => setPicked(role)}
                  >
                    <span className={styles.nodeHead}>
                      <span className={styles.nodeIndex}>{index + 1}</span>
                      <span className={styles.nodeRole}>{role}</span>
                    </span>
                    <span className={styles.nodeStatus}>{STATUS[nodes[role].status].label}</span>
                  </button>
                </Fragment>
              ))}
            </div>

            <article className={styles.detail} aria-label={`${active} 这一步`}>
              <header className={styles.detailHead}>
                <h3 className={styles.detailTitle}>{active}</h3>
                {modelOf(activeNode) ? (
                  <span className={styles.detailModel}>{modelOf(activeNode)}</span>
                ) : null}
                <Badge tone={STATUS[activeNode.status].tone} size="sm">
                  {STATUS[activeNode.status].label}
                </Badge>
              </header>
              <p className={styles.detailSummary}>{summaryOf(activeNode, busy)}</p>
              {/* 拦截类的产物常常就只有那一句话，和上面的结论一模一样，不再重复一遍。 */}
              {activeNode.artifact && activeNode.artifact !== activeNode.summary ? (
                <pre className={styles.artifact}>{activeNode.artifact}</pre>
              ) : null}
              {activeNode.artifact ? null : (
                <p className={styles.detailEmpty}>这一步还没有产物。</p>
              )}
            </article>
          </section>
        </div>
      </div>
    </AdminLayout>
  );
}

function progressText(busy: boolean, done: number, running: RoleName | null): string {
  if (running) return `${done} / ${ROLES.length} · 正在跑 ${running}`;
  if (busy) return `${done} / ${ROLES.length} · 收尾中`;
  if (done === 0) return "尚未运行";
  return `${done} / ${ROLES.length} 完成`;
}
