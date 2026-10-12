import { NumberField } from "@/components/arc/number-field/number-field";

import styles from "./Section.module.css";

interface GatewaySectionProps {
  value: { request_timeout_ms: number };
  onChange: (value: Partial<GatewaySectionProps["value"]>) => void;
}

export default function GatewaySection({ value, onChange }: GatewaySectionProps) {
  const seconds = Math.round(value.request_timeout_ms / 1000);

  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>网关</h2>
      </header>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>请求超时</strong>
            <p>
              单次上游调用的最长等待时间。当前为 {seconds} 秒，
              上限 600 秒。
            </p>
          </div>
          <div className={styles.rowControl}>
            <NumberField
              label="超时时间"
              suffix=" 秒"
              value={seconds}
              min={1}
              max={600}
              step={5}
              largeStep={60}
              onValueChange={(v) => onChange({ request_timeout_ms: v * 1000 })}
              description="长文本生成场景建议不低于 60 秒"
            />
          </div>
        </div>
      </div>
    </>
  );
}
