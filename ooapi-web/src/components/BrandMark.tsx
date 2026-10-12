import { Cpu, Network } from "lucide-react";
import { vendorIconUrl, vendorLabel, vendorOfModel } from "@/lib/vendorIcons";
import styles from "./BrandMark.module.css";

export function VendorMark({ vendor, label = false }: { vendor: string; label?: boolean }) {
  const src = vendorIconUrl(vendor);
  return <span className={styles.mark}>
    {src ? <img src={src} alt="" /> : <Network size={17} aria-hidden="true" />}
    {/* 长厂商名（如 WorkBuddy / CodeBuddy）要能截断：否则会把所在容器撑宽，
        在居中的标签槽里两侧溢出，图标被推得与相邻行对不齐。 */}
    {label && <span className={styles.label}>{vendorLabel(vendor)}</span>}
  </span>;
}

export function ModelMark({ model, fallback }: { model: string; fallback?: string }) {
  const vendor = vendorOfModel(model) ?? fallback;
  const src = vendorIconUrl(vendor);
  return <span className={styles.mark} title={vendor ? `${vendorLabel(vendor)} · ${model}` : model}>
    {src ? <img src={src} alt="" /> : <Cpu size={16} aria-hidden="true" />}
    <span className={styles.model}>{model}</span>
  </span>;
}
