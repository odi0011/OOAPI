import { useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { Button } from "@/components/arc/button/button";
import { apiRequest } from "@/lib/api";

import styles from "./TradingWorkbench.module.css";

/**
 * 交易工作台（/admin/trading/workbench）。
 * 只有一个决策角色：经中转跑一次测试，把模型、允许/拒绝和错误原样显示。
 */

interface DecisionResult {
  model: string;
  kind: string;
  allow: boolean | null;
  decision: string;
  detail?: string;
  error?: string;
}

function decisionLabel(result: DecisionResult): string {
  if (result.allow === true) return "允许";
  if (result.allow === false) return "拒绝";
  if (result.decision) return result.decision;
  return "—";
}

export default function TradingWorkbench() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFailed(null);
    try {
      const data = await apiRequest<DecisionResult>("/api/trading/workbench/decision", { method: "POST", body: {} });
      setResult(data);
    } catch (err) {
      setResult(null);
      setFailed(err instanceof Error ? err.message : "决策请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminLayout
      crumbs={[
        { label: "后台", href: "/admin" },
        { label: "交易" },
        { label: "工作台" },
      ]}
    >
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>工作台</h1>
        </header>
        <section className={styles.role} aria-labelledby="workbench-decision">
          <div className={styles.roleHead}>
            <h2 id="workbench-decision" className={styles.roleTitle}>决策</h2>
            <Button type="button" size="sm" loading={busy} onClick={() => void run()}>
              运行测试决策
            </Button>
          </div>
          {failed && <p className={styles.error}>{failed}</p>}
          {result && (
            <dl className={styles.result}>
              <div>
                <dt>模型</dt>
                <dd>{result.model || "—"}</dd>
              </div>
              <div>
                <dt>决策</dt>
                <dd>
                  {decisionLabel(result)}
                  {result.detail ? <span className={styles.detail}>{result.detail}</span> : null}
                </dd>
              </div>
              <div>
                <dt>错误</dt>
                <dd>{result.error || "—"}</dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}
