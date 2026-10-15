import { useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";

import styles from "./TradingWorkbench.module.css";

/**
 * 交易工作台。没有页面标题。
 * 一轮只有一条流程。节点上是一句话，原文要另外打开。
 */

const ROLES = ["CRAWLER", "SCAN", "CHIEF", "VET", "决策", "RISK", "FILLS"] as const;

type RoleName = (typeof ROLES)[number];
type NodeStatus = "pending" | "running" | "done" | "error";

interface NodeState {
  status: NodeStatus;
  summary: string;
  artifact: string;
}

const emptyNodes = (): Record<RoleName, NodeState> => {
  const nodes = {} as Record<RoleName, NodeState>;
  for (const role of ROLES) {
    nodes[role] = { status: "pending", summary: "", artifact: "" };
  }
  return nodes;
};

interface StreamEvent {
  role?: RoleName;
  status: NodeStatus | "complete";
  summary?: string;
  artifact?: string;
}

export default function TradingWorkbench() {
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState(emptyNodes);
  const [selected, setSelected] = useState<RoleName | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFailed(null);
    setShowRaw(false);
    setNodes(emptyNodes());
    try {
      const response = await fetch("/api/trading/workbench/decision", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok || !response.body) {
        setFailed("这一轮没有跑起来");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            continue;
          }
          if (event.status === "complete" || !event.role) continue;
          const role = event.role;
          setNodes((current) => ({
            ...current,
            [role]: {
              status: event.status === "running" || event.status === "done" || event.status === "error" ? event.status : "pending",
              summary: event.summary ?? "",
              artifact: event.artifact ?? current[role].artifact,
            },
          }));
        }
      }
    } catch {
      setFailed("这一轮中断了");
    } finally {
      setBusy(false);
    }
  }

  const selectedNode = selected ? nodes[selected] : null;
  const rawText = selectedNode?.artifact || selectedNode?.summary || "";

  return (
    <AdminLayout
      crumbs={[
        { label: "后台", href: "/admin" },
        { label: "交易", href: "/admin/trading" },
      ]}
    >
      <div className={styles.page}>
        <div className={styles.controls}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void run()}>
            跑一轮
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setShowRaw((open) => !open)}
          >
            查看产物
          </button>
        </div>
        {failed ? <p className={styles.error}>{failed}</p> : null}
        <div className={styles.flow}>
          {ROLES.map((role, index) => {
            const node = nodes[role];
            return (
              <div key={role} className={styles.step}>
                {index > 0 ? <span className={styles.arrow}>→</span> : null}
                <button
                  type="button"
                  className={styles.node}
                  data-status={node.status}
                  data-selected={selected === role ? "true" : "false"}
                  onClick={() => setSelected(role)}
                >
                  <span className={styles.role}>{role}</span>
                  <span className={styles.line}>{lineFor(node)}</span>
                </button>
              </div>
            );
          })}
        </div>
        {showRaw ? (
          <pre className={styles.raw}>
            {selected ? (rawText || "这一步还没有产物") : "先点一个节点"}
          </pre>
        ) : null}
      </div>
    </AdminLayout>
  );
}

function lineFor(node: NodeState): string {
  if (node.status === "running") return "进行中";
  if (node.status === "pending") return "等待";
  return node.summary || "等待";
}
