const FIELDS = ["balance", "usage_summary", "usage_records", "request_content", "pricing"];

/** 后端逐项策略是展示依据；未知配置从严，不将隐藏字段补成零。 */
export function userDataVisibility(status, user) {
  const all = (value) => ({ version: 1, ...Object.fromEntries(FIELDS.map((key) => [key, value])) });
  if (Number(user?.role) >= 100) return all(true);
  const value = status?.user_data_visibility;
  if (value?.version !== 1 || FIELDS.some((key) => typeof value[key] !== "boolean")) return all(false);
  return { version: 1, ...Object.fromEntries(FIELDS.map((key) => [key, value[key]])), request_content: value.usage_records && value.request_content };
}
