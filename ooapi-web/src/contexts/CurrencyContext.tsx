import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { apiRequest } from "@/lib/api";

/** 货币配置。名称、图标与兑换比例都由管理员在设置里配置。 */
export interface CurrencyConfig {
  name: string;
  /** 自定义图标地址；空则用内置金币图标。 */
  icon: string;
  /** 1 单位货币等于多少美元。默认 1。 */
  rate: number;
  /** 1 单位货币等于多少内部额度单位。 */
  unitsPerUnit: number;
}

const DEFAULT: CurrencyConfig = {
  name: "OD币",
  icon: "",
  rate: 1,
  unitsPerUnit: 10000,
};

const CurrencyContext = createContext<CurrencyConfig>(DEFAULT);

interface PublicSettings {
  currency_name?: string;
  currency_icon?: string;
  currency_rate?: number;
  units_per_od?: number;
}

/**
 * 货币 Provider。
 *
 * 全站金额展示统一从这里取配置：
 * 名称与图标都要跟着管理员改，不能在前端写死 "OD"。
 * 数据来自公开接口，因此未登录的首页访客也能看到正确的货币名。
 */
export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useState<CurrencyConfig>(DEFAULT);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<PublicSettings>("/api/settings/public");
      setCurrency({
        name: data.currency_name || DEFAULT.name,
        icon: data.currency_icon || "",
        rate: typeof data.currency_rate === "number" && data.currency_rate > 0 ? data.currency_rate : DEFAULT.rate,
        unitsPerUnit:
          typeof data.units_per_od === "number" && data.units_per_od > 0
            ? data.units_per_od
            : DEFAULT.unitsPerUnit,
      });
    } catch {
      /* 取不到就用默认值 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => currency, [currency]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyConfig {
  return useContext(CurrencyContext);
}

/**
 * 把内部额度单位格式化成显示金额。
 * 全站统一走这里，避免各处换算口径不一致。
 */
export function formatAmount(units: number, currency: CurrencyConfig, decimals = 4): string {
  if (!currency.unitsPerUnit) return "0";
  return (units / currency.unitsPerUnit).toFixed(decimals);
}

/** 把「美元」换算成「多少单位货币」，用于展示等值信息。 */
export function usdToCurrency(usd: number, currency: CurrencyConfig): number {
  if (!currency.rate) return usd;
  return usd / currency.rate;
}
