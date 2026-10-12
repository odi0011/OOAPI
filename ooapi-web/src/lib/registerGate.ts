/**
 * 注册是否明确开放。
 *
 * 只认 public settings 里的布尔 `register_enabled === true`。
 * 未加载、请求失败、字段缺失、字符串 "true"/"false"，
 * 以及单独的 `password_register_enabled`，一律关闭。
 */
export function isRegisterExplicitlyEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  return (settings as { register_enabled?: unknown }).register_enabled === true;
}
