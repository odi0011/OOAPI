package authz

import "strings"

// Role 是用户在站内的粗粒度身份。数值越大权限越高，
// 保留区间便于将来插入中间层级而不必改存量数据。
type Role int

const (
	RoleGuest Role = 0   // 未登录访客
	RoleUser  Role = 1   // 普通用户
	RoleAdmin Role = 100 // 管理员
	RoleRoot  Role = 1000 // 超管
)

func (r Role) Valid() bool {
	switch r {
	case RoleGuest, RoleUser, RoleAdmin, RoleRoot:
		return true
	}
	return false
}

func (r Role) AtLeast(min Role) bool { return r >= min }

func (r Role) Name() string {
	switch r {
	case RoleRoot:
		return "超管"
	case RoleAdmin:
		return "管理员"
	case RoleUser:
		return "普通用户"
	default:
		return "访客"
	}
}

func ParseRole(v int) Role {
	r := Role(v)
	if !r.Valid() {
		return RoleUser
	}
	return r
}

// Permission 是细粒度能力点。
// 判断一律走「能力点」而不是直接比较角色数值，
// 这样将来调整某个角色的权限只需改下面的映射表。
type Permission string

const (
	// —— 站点与内容（普通用户即可） ——
	PermViewOwnProfile   Permission = "profile:view_self"
	PermEditOwnProfile   Permission = "profile:edit_self"
	PermManageOwnTokens  Permission = "token:manage_self"
	PermViewOwnLogs      Permission = "log:view_self"
	PermViewPricing      Permission = "pricing:view"
	PermUseChat          Permission = "chat:use"

	// —— 账号 ——
	PermChannelView   Permission = "channel:view"
	PermChannelEdit   Permission = "channel:edit"
	PermChannelDelete Permission = "channel:delete"

	// —— 定价 ——
	PermPricingEdit Permission = "pricing:edit"

	// —— 用户管理 ——
	PermUserView       Permission = "user:view"
	PermUserEdit       Permission = "user:edit"
	PermUserManageQuota Permission = "user:quota"

	// —— 日志 ——
	PermLogViewAll     Permission = "log:view_all"
	PermLogDelete      Permission = "log:delete"

	// —— 系统 ——
	PermOptionView   Permission = "option:view"
	PermOptionEdit   Permission = "option:edit"
	PermSystemUpdate Permission = "system:update"
	PermRoleAssign   Permission = "role:assign"
)

// rolePermissions 是角色到能力点的唯一映射表。
// 新增能力点时，默认只有超管拥有，再按需下发，避免误开放。
var rolePermissions = map[Role]map[Permission]struct{}{
	RoleUser: {
		PermViewOwnProfile:  {},
		PermEditOwnProfile:  {},
		PermManageOwnTokens: {},
		PermViewOwnLogs:     {},
		PermViewPricing:     {},
		PermUseChat:         {},
	},

	RoleAdmin: {
		PermViewOwnProfile:  {},
		PermEditOwnProfile:  {},
		PermManageOwnTokens: {},
		PermViewOwnLogs:     {},
		PermViewPricing:     {},
		PermUseChat:         {},

		PermChannelView:   {},
		PermChannelEdit:   {},
		PermChannelDelete: {},
		PermPricingEdit:   {},

		PermUserView:        {},
		PermUserEdit:        {},
		PermUserManageQuota: {},

		PermLogViewAll: {},
		PermLogDelete: {},
	},

	RoleRoot: {
		PermViewOwnProfile:  {},
		PermEditOwnProfile:  {},
		PermManageOwnTokens: {},
		PermViewOwnLogs:     {},
		PermViewPricing:     {},
		PermUseChat:         {},

		PermChannelView:   {},
		PermChannelEdit:   {},
		PermChannelDelete: {},
		PermPricingEdit:   {},

		PermUserView:        {},
		PermUserEdit:        {},
		PermUserManageQuota: {},

		PermLogViewAll: {},
		PermLogDelete: {},

		PermOptionView:   {},
		PermOptionEdit:   {},
		PermSystemUpdate: {},
		PermRoleAssign:   {},
	},
}

// Can 判断角色是否拥有某能力点。
func Can(r Role, p Permission) bool {
	perms, ok := rolePermissions[r]
	if !ok {
		return false
	}
	_, ok = perms[p]
	return ok
}

// CanAny 任一满足即可，用于一个接口接受多种能力的场景。
func CanAny(r Role, ps ...Permission) bool {
	for _, p := range ps {
		if Can(r, p) {
			return true
		}
	}
	return false
}

// PermissionsOf 返回该角色的全部能力点，前端据此隐藏无权限入口。
// 前端的隐藏只是体验优化，真正的拦截始终在后端。
func PermissionsOf(r Role) []string {
	perms, ok := rolePermissions[r]
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(perms))
	for p := range perms {
		out = append(out, string(p))
	}
	return out
}

// CanAssignRole 判断 actor 能否把目标用户设为 target。
//
// PermRoleAssign 当前只授予超管，因此正常情况下这里等价于「只有超管能改角色」。
// 下面的层级判断是纵深防御：将来若把 role:assign 下放给管理员，
// 它能立刻挡住「给自己或同级提权」与「给超管降级」这两条横向越权路径，
// 不必再回头改代码。
func CanAssignRole(actor, target Role) bool {
	if !Can(actor, PermRoleAssign) {
		return false
	}
	if actor == RoleRoot {
		return true
	}
	return target < actor
}

// CanModifyUser 判断 actor 能否改动 target 这个用户的资料、状态与额度。
// 与角色变更同样遵循「不能碰同级及以上」，避免横向越权。
func CanModifyUser(actor, target Role) bool {
	if !CanAny(actor, PermUserEdit, PermUserManageQuota) {
		return false
	}
	if actor == RoleRoot {
		return true
	}
	return target < actor
}

// Group 是用户分组名，用于模型白名单与倍率区分。
// 目前只做归一化与合法性校验，具体策略由上层决定。
type Group string

const DefaultGroup Group = "default"

func ParseGroup(s string) Group {
	g := strings.TrimSpace(s)
	if g == "" {
		return DefaultGroup
	}
	if len(g) > 64 {
		g = g[:64]
	}
	return Group(g)
}

// ParseGroups 解析逗号分隔的分组列表，去重并保序。
func ParseGroups(s string) []string {
	if strings.TrimSpace(s) == "" {
		return []string{}
	}
	seen := map[string]struct{}{}
	out := []string{}
	for _, part := range strings.Split(s, ",") {
		g := strings.TrimSpace(part)
		if g == "" {
			continue
		}
		if _, dup := seen[g]; dup {
			continue
		}
		seen[g] = struct{}{}
		out = append(out, g)
	}
	return out
}
