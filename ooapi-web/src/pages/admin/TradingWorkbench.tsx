import AdminLayout from "@/components/admin/AdminLayout";

import styles from "./TradingWorkbench.module.css";

/**
 * 交易工作台（/admin/trading/workbench）。
 * 空白页壳：同一后台布局里只有标题，不拉数据、不画图、不调模型。
 */
export default function TradingWorkbench() {
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
      </div>
    </AdminLayout>
  );
}
