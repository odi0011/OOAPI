import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { SearchField } from "@/components/arc/search-field/search-field";
import { useAuth } from "@/contexts/AuthContext";
import { Perm } from "@/lib/permissions";

import styles from "./AdminSettings.module.css";
import { SETTINGS_SECTIONS, STRATEGY_NAV, type SettingsSection } from "./settingsNav";

interface SettingsRailProps {
  current: "settings" | "strategy";
  /** 系统设置页当前滚动到的分区。策略页不传。 */
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
 * 策略和外观、站点同级。这里没有「交易」分组，也没有账户。
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
  const showStrategy = canEditOptions && matches(q, STRATEGY_NAV.label, STRATEGY_NAV.entries);

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
        {showStrategy && (
          <li>
            <Link
              className={current === "strategy" ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem}
              to={STRATEGY_NAV.href}
              aria-current={current === "strategy" ? "page" : undefined}
            >
              {STRATEGY_NAV.label}
            </Link>
          </li>
        )}
      </ul>

      {sections.length === 0 && !showStrategy && <p className={styles.railEmpty}>没有匹配的设置项</p>}
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
