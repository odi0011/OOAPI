/** 与后端 authz.Permission 一一对应的能力点。 */
export const Perm = {
  ViewOwnProfile: "profile:view_self",
  EditOwnProfile: "profile:edit_self",
  ManageOwnTokens: "token:manage_self",
  ViewOwnLogs: "log:view_self",
  ViewPricing: "pricing:view",
  UseChat: "chat:use",

  ChannelView: "channel:view",
  ChannelEdit: "channel:edit",
  ChannelDelete: "channel:delete",

  PricingEdit: "pricing:edit",

  UserView: "user:view",
  UserEdit: "user:edit",
  UserManageQuota: "user:quota",

  LogViewAll: "log:view_all",
  LogDelete: "log:delete",

  OptionView: "option:view",
  OptionEdit: "option:edit",
  SystemUpdate: "system:update",
  RoleAssign: "role:assign",
} as const;

export type Permission = (typeof Perm)[keyof typeof Perm];

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: number;
  role_name: string;
  quota: number;
  used_quota: number;
  group_name: string;
  permissions: string[];
  /** 头像地址；空串表示未设置（前端回退到首字母）。 */
  avatar_url?: string;
  created_at?: string;
  last_login_at?: string | null;
}

/**
 * 判断是否拥有某能力点。
 *
 * 重要：前端的判断只用于隐藏入口、优化体验。
 * 真正的拦截必须在后端 —— 前端代码用户可改，不能作为安全边界。
 */
export function can(
  user: AuthUser | null,
  permission: Permission | Permission[],
): boolean {
  if (!user) return false;

  const list = Array.isArray(permission) ? permission : [permission];
  return list.some((p) => user.permissions.includes(p));
}

/** 是否是管理员及以上（用于展示管理区入口）。 */
export function isAdmin(user: AuthUser | null): boolean {
  return can(user, [Perm.UserView, Perm.ChannelView, Perm.OptionView]);
}
