import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { SearchField } from "@/components/arc/search-field/search-field";
import { useAuth } from "@/contexts/AuthContext";
import { Perm, type Permission } from "@/lib/permissions";

import styles from "./AdminSettings.module.css";
import {
  SETTINGS_SECTIONS,
  TRADING_GROUP_LABEL,
  TRADING_NAV,
  type SettingsSection,
  type TradingNavItem,
} from "./settingsNav";

interface SettingsRailProps {
  current: "settings" | "strategy" | "account";
  /** 系统设置页当前滚动到的分区。策略和账户页不传。 */
  activeSection?: string;
  /** 已经在系统设置页时，点分区就地滚动，不整页跳转。 */
  onJumpSection?: (key: string) => void;
}

function matches(query: string, label: string, entries: readonly string[]): boolean {
  if (!query) return true;
  const hay = `${label} ${entries.join(" ")}`.toLowerCase();
  return hay.includes(query);
}

/**
 * 系统设置左侧分区。
 * 外观到网关仍是本页锚点。「交易」与它们同级，下面是策略和账户两个子页。
 */
export default function SettingsRail({ current, activeSection, onJumpSection }: SettingsRailProps) {
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const canEditOptions = can(Perm.OptionEdit);

  const sections = useMemo(
    () => (canEditOptions ? SETTINGS_SECTIONS.filter((section) => matches(q, section.label, section.entries)) : []),
    [canEditOptions, q],
  );

  const trading = useMemo(
    () => TRADING_NAV.filter((item) => {
      if (item.requiredPermission && !can(item.requiredPermission as Permission)) return false;
      return matches(q, item.label, item.entries) || matches(q, TRADING_GROUP_LABEL, []);
    }),
    [can, q],
  );

  return (
    <nav className={styles.rail} aria-label="设置分区">
      <SearchField label="搜索设置" value={query} onValueChange={setQuery} placeholder="搜索设置项" />

      <ul className={styles.railList}>
        {sections.map((section) => (
          <li key={section.key}>
            <SectionLink
              section={section}
              active={current === "settings" && activeSection === section.key}
              jump={current === "settings" ? onJumpSection : undefined}
            />
          </li>
        ))}
      </ul>

      {trading.length > 0 && (
        <div className={styles.railGroup}>
          <p className={styles.railGroupLabel}>{TRADING_GROUP_LABEL}</p>
          <ul className={styles.railList}>
            {trading.map((item) => (
              <li key={item.key}>
                <TradingLink item={item} active={current === item.key} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {sections.length === 0 && trading.length === 0 && <p className={styles.railEmpty}>没有匹配的设置项</p>}
    </nav>
  );
}

function SectionLink({
  section,
  active,
  jump,
}: {
  section: SettingsSection;
  active: boolean;
  jump?: (key: string) => void;
}) {
  const className = active ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem;
  if (jump) {
    return (
      <button type="button" className={className} aria-current={active ? "true" : undefined} onClick={() => jump(section.key)}>
        {section.label}
      </button>
    );
  }
  return (
    <Link className={className} to={`/admin/system#${section.key}`}>
      {section.label}
    </Link>
  );
}

function TradingLink({ item, active }: { item: TradingNavItem; active: boolean }) {
  const className = active
    ? `${styles.railItem} ${styles.railNested} ${styles.railItemActive}`
    : `${styles.railItem} ${styles.railNested}`;
  return (
    <Link className={className} to={item.href} aria-current={active ? "page" : undefined}>
      {item.label}
    </Link>
  );
}
