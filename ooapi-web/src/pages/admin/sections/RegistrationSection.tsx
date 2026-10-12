import { NumberField } from "@/components/arc/number-field/number-field";
import Switch from "@/components/arc/switch/switch";

import styles from "./Section.module.css";

interface RegistrationSectionProps {
  value: {
    password_register_enabled: boolean;
    password_login_enabled: boolean;
    quota_for_new_user: number;
  };
  onChange: (value: Partial<RegistrationSectionProps["value"]>) => void;
}

export default function RegistrationSection({ value, onChange }: RegistrationSectionProps) {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>注册与登录</h2>
      </header>

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>开放注册</strong>
            <p>关闭后新用户无法自行注册，需由管理员创建。</p>
          </div>
          <div className={styles.rowControl}>
            <Switch
              label={value.password_register_enabled ? "已开放" : "已关闭"}
              checked={value.password_register_enabled}
              onCheckedChange={(checked) => onChange({ password_register_enabled: checked })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>密码登录</strong>
            <p>关闭后只能使用第三方登录或邮箱验证码。</p>
          </div>
          <div className={styles.rowControl}>
            <Switch
              label={value.password_login_enabled ? "已启用" : "已禁用"}
              checked={value.password_login_enabled}
              onCheckedChange={(checked) => onChange({ password_login_enabled: checked })}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>新用户赠送额度</strong>
            <p>注册时自动发放，单位为 OD 币。设为 0 表示不赠送。</p>
          </div>
          <div className={styles.rowControl}>
            <NumberField
              label="赠送额度"
              suffix=" OD"
              value={value.quota_for_new_user}
              min={0}
              max={100000}
              step={1}
              onValueChange={(v) => onChange({ quota_for_new_user: v })}
              description="1 OD = 1 美元"
            />
          </div>
        </div>
      </div>
    </>
  );
}
