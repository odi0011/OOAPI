package models

import "time"

// User 是用户表的内存表示。
// PasswordHash 带 json:"-"，任何序列化都不会把它带到响应里，
// 避免某处忘了裁剪字段导致哈希外泄。
type User struct {
	ID           int64      `json:"id"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"display_name"`
	PasswordHash string     `json:"-"`
	Email        string     `json:"email"`
	Role         int        `json:"role"`
	Status       int        `json:"status"`
	Quota        int64      `json:"quota"`
	UsedQuota    int64      `json:"used_quota"`
	GroupName    string     `json:"group_name"`
	AffCode      string     `json:"aff_code,omitempty"`
	AffCount     int        `json:"aff_count,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	LastLoginAt  *time.Time `json:"last_login_at,omitempty"`
	// AvatarURL 是可直接展示的头像地址。
	// 自定义头像指向 /api/media/avatar/<uid>?v=<mediaID>（带版本号便于长缓存），
	// 未上传时为空串或三方登录带回的外链，前端用姓名首字母兜底。
	AvatarURL string `json:"avatar_url,omitempty"`
	// SessionVersion 不进任何 JSON：它只用于作废已签发的登录令牌。
	SessionVersion int `json:"-"`
}

// Public 返回可安全对外展示的字段集合。
// 个人主页等匿名可访问的接口必须走这里，避免顺手返回邮箱与余额。
type PublicUser struct {
	ID          int64     `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	RoleName    string    `json:"role_name"`
	CreatedAt   time.Time `json:"created_at"`
}

func (u *User) Public(roleName string) PublicUser {
	return PublicUser{
		ID:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		RoleName:    roleName,
		CreatedAt:   u.CreatedAt,
	}
}

// Token 是对外 API 令牌，用于 /v1 接口鉴权。
type Token struct {
	ID        int64      `json:"id"`
	UserID    int64      `json:"user_id"`
	Name      string     `json:"name"`
	APIKey    string     `json:"api_key"`
	Status    int        `json:"status"`
	Quota     int64      `json:"quota"`
	UsedQuota int64      `json:"used_quota"`
	GroupName string     `json:"group_name"`
	Models    string     `json:"models"`
	ExpiredAt *time.Time `json:"expired_at"`
	CreatedAt time.Time  `json:"created_at"`
}

// GroupRestricted 判断该令牌是否限制了模型范围。
func (t *Token) GroupRestricted() bool {
	return t.GroupName != "" && t.GroupName != "default"
}
