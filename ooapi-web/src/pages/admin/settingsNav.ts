/**
 * 系统设置左侧分区。
 * 策略配置留在这里，和外观、站点同级，不再套「交易」分组。
 * 数据看板和账户在侧栏「交易」下，不进设置。
 */

export interface SettingsSection {
  key: string;
  label: string;
  entries: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { key: "appearance", label: "外观", entries: ["站点字体", "明暗模式", "主题色", "布局密度"] },
  { key: "site", label: "站点", entries: ["站点名称", "Logo", "接口地址", "站点地址"] },
  { key: "registration", label: "注册与登录", entries: ["开放注册", "密码登录", "新用户赠送额度"] },
  { key: "auth", label: "第三方与邮件", entries: ["Google", "GitHub", "SMTP", "邮箱验证码"] },
  { key: "billing", label: "计费", entries: ["货币名称", "额度单位"] },
  { key: "gateway", label: "网关", entries: ["请求超时"] },
];

export const STRATEGY_PATH = "/admin/system/strategy";
export const DASHBOARD_PATH = "/admin/trading/dashboard";
export const ACCOUNT_PATH = "/admin/trading/account";

/** 系统设置里的策略页。只放配置，不放行情和账户。 */
export const STRATEGY_NAV = {
  key: "strategy",
  label: "策略",
  href: STRATEGY_PATH,
  entries: ["策略", "杠杆", "止损", "止盈", "EMA", "逐仓", "测网", "实盘"],
  requiredPermission: "option:edit" as const,
};
