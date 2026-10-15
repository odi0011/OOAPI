import { useEffect, useState } from "react";

import AdminLayout from "@/components/admin/AdminLayout";
import { apiRequest } from "@/lib/api";

import styles from "./TradingWorkbench.module.css";

/**
 * 交易工作台。没有页面标题。
 * 角色横排，两条测试链把交接摊开。数字只来自这次请求。
 */

interface Step {
  role: string;
  model?: string;
  artifact?: string;
  error?: string;
}

interface Chain {
  name: string;
  steps: Step[];
}

interface PageData {
  roles: Step[];
  chains: Chain[];
}

function StepCard({ step }: { step: Step }) {
  return (
    <article className={styles.role}>
      <p className={styles.roleName}>{step.role}</p>
      {step.model ? <p className={styles.model}>{step.model}</p> : null}
      {step.artifact ? <pre className={styles.artifact}>{step.artifact}</pre> : null}
      {step.error ? <p className={styles.error}>{step.error}</p> : null}
      {!step.artifact && !step.error ? <p className={styles.pending}>等待这一步</p> : null}
    </article>
  );
}

export default function TradingWorkbench() {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<PageData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setFailed(null);
    try {
      const next = await apiRequest<PageData>("/api/trading/workbench/decision", { method: "POST", body: {} });
      setData(next);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "测试链请求失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run();
  }, []);

  return (
    <AdminLayout
      crumbs={[
        { label: "后台", href: "/admin" },
        { label: "交易", href: "/admin/trading" },
      ]}
    >
      <div className={styles.page}>
        <button type="button" className={styles.run} disabled={busy} onClick={() => void run()}>
          {busy ? "正在请求测试盘和中转" : "再跑一次测试链"}
        </button>
        {failed ? <p className={styles.error}>{failed}</p> : null}
        <div className={styles.roles}>
          {(data?.roles ?? placeholderRoles).map((step) => (
            <StepCard key={step.role} step={busy && !data ? { ...step, artifact: undefined, error: undefined } : step} />
          ))}
        </div>
        {(data?.chains ?? []).map((chain) => (
          <section key={chain.name} className={styles.chain} aria-label={chain.name}>
            <p className={styles.chainName}>{chain.name}</p>
            <div className={styles.chainSteps}>
              {chain.steps.map((step, index) => (
                <div key={chain.name + step.role} className={styles.chainStep}>
                  {index > 0 ? <span className={styles.arrow}>→</span> : null}
                  <StepCard step={step} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </AdminLayout>
  );
}

const placeholderRoles: Step[] = [
  { role: "CRAWLER" },
  { role: "SCAN" },
  { role: "CHIEF", model: "lfm-2.5-2.6b" },
  { role: "VET", model: "minimax-m2.5" },
  { role: "决策", model: "jev-1.13-free" },
  { role: "RISK" },
  { role: "FILLS" },
];
