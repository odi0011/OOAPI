import { Input } from "@/components/arc/input/input";
import { NumberField } from "@/components/arc/number-field/number-field";
import IconUpload from "@/components/admin/IconUpload";
import CurrencyIcon from "@/components/CurrencyIcon";

import styles from "./Section.module.css";

interface BillingSectionProps {
  value: {
    currency_name: string;
    currency_icon: string;
    currency_rate: number;
    units_per_od: number;
  };
  onChange: (value: Partial<BillingSectionProps["value"]>) => void;
}

export default function BillingSection({ value, onChange }: BillingSectionProps) {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>计费与货币</h2>
      </header>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>货币名称</strong>
          </div>
          <div className={styles.rowControl}>
            <Input
              label="货币名称"
              value={value.currency_name}
              maxLength={16}
              onChange={(e) => onChange({ currency_name: e.target.value })}
            />
          </div>
        </div>

        {/*
          货币图标用文件上传，不是让管理员手填图片地址 ——
          填地址要求先把图片传到别处，多一步且常填错。
        */}
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>货币图标</strong>
          </div>
          <div className={styles.rowControl}>
            <IconUpload
              kind="currency"
              value={value.currency_icon}
              previewSize={48}
              label="上传货币图标"
              description="建议正方形 SVG。留空则使用内置金币图标"
              onChange={(url) => onChange({ currency_icon: url })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>兑换比例</strong>
          </div>
          <div className={styles.rowControl}>
            <NumberField
              label="1 单位货币等于多少美元"
              value={value.currency_rate}
              min={0.0001}
              max={100000}
              step={0.1}
              largeStep={1}
              scrub
              formatOptions={{ maximumFractionDigits: 4 }}
              onValueChange={(v) => onChange({ currency_rate: v })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>额度单位</strong>
          </div>
          <div className={styles.rowControl}>
            <NumberField
              label="每单位货币对应的额度单位数"
              value={value.units_per_od}
              min={1}
              max={1000000}
              step={1000}
              largeStep={10000}
              onValueChange={(v) => onChange({ units_per_od: v })}
            />
          </div>
        </div>

        {/* 当前配置的效果预览，让管理员改完立刻看到实际样子 */}
        <div className={styles.previewRow}>
          <span className={styles.previewLabel}>展示效果</span>
          <span className={styles.previewValue}>
            1,234.5678 <CurrencyIcon src={value.currency_icon} />
          </span>
          <span className={styles.previewNote}>
            1 <CurrencyIcon src={value.currency_icon} /> ≈ {value.currency_rate} 美元
          </span>
        </div>
      </div>
    </>
  );
}
