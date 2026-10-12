import { Input } from "@/components/arc/input/input";
import IconUpload from "@/components/admin/IconUpload";

import styles from "./Section.module.css";

interface SiteSectionProps {
  value: {
    system_name: string;
    logo: string;
    api_endpoint: string;
    site_base_url: string;
  };
  onChange: (value: Partial<SiteSectionProps["value"]>) => void;
}

export default function SiteSection({ value, onChange }: SiteSectionProps) {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>站点</h2>
      </header>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>站点名称</strong>
          </div>
          <div className={styles.rowControl}>
            <Input
              label="站点名称"
              value={value.system_name}
              maxLength={32}
              onChange={(e) => onChange({ system_name: e.target.value })}
            />
          </div>
        </div>

        {/* 站点图标用文件上传，不让管理员手填图片地址 */}
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>站点图标</strong>
          </div>
          <div className={styles.rowControl}>
            <IconUpload
              kind="logo"
              value={value.logo}
              previewSize={56}
              label="上传站点图标"
              description="建议正方形图片。上传后立即在全站生效"
              onChange={(url) => onChange({ logo: url })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>接口地址</strong>
          </div>
          <div className={styles.rowControl}>
            <Input
              label="接口地址"
              placeholder="https://ooapi.space/v1"
              value={value.api_endpoint}
              onChange={(e) => onChange({ api_endpoint: e.target.value })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>站点对外地址</strong>
          </div>
          <div className={styles.rowControl}>
            <Input
              label="站点地址"
              placeholder="https://ooapi.space"
              value={value.site_base_url}
              onChange={(e) => onChange({ site_base_url: e.target.value })}
            />
          </div>
        </div>
      </div>
    </>
  );
}
