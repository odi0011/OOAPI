package handlers

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/models"
	"ooapi/internal/oauth"
	"ooapi/internal/services"
)

// requestBaseURL 推导本站对外地址，用于拼 OAuth 回调地址。
//
// 优先用环境变量：线上经 nginx 反代，若不显式配置，
// 推导出的地址可能是内网的 127.0.0.1:3001，导致平台回调失败。
func requestBaseURL(c *gin.Context) string {
	if v := strings.TrimSpace(services.GetOption("site_base_url", "")); v != "" {
		return v
	}
	proto := c.GetHeader("X-Forwarded-Proto")
	if proto == "" {
		if c.Request.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := c.GetHeader("X-Forwarded-Host")
	if host == "" {
		host = c.Request.Host
	}
	return proto + "://" + host
}

// OAuthStart 跳转到第三方授权页。
// 前端用整页跳转（window.location）进入这里，而不是 fetch，
// 因为需要浏览器地址栏真正跳到平台域名。
func OAuthStart(c *gin.Context) {
	providerKey := c.Param("provider")
	baseURL := requestBaseURL(c)

	cfg, ok := services.OAuthConfig(providerKey, baseURL)
	if !ok {
		redirectAuthError(c, "该登录方式未启用")
		return
	}

	state, err := oauth.NewState()
	if err != nil {
		redirectAuthError(c, "生成授权状态失败")
		return
	}

	verifier := ""
	challenge := ""
	if cfg.Provider.UsePKCE {
		verifier, challenge, err = oauth.NewPKCE()
		if err != nil {
			redirectAuthError(c, "生成 PKCE 失败")
			return
		}
	}

	// 回调后要跳回哪里。必须是站内相对路径，避免被当成开放重定向跳板。
	redirectTo := sanitizeRedirect(c.Query("redirect_to"))

	if _, err := db.DB.Exec(
		`INSERT INTO oauth_states (state, provider, redirect_to, code_verifier, expires_at)
		 VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
		state, providerKey, redirectTo, verifier,
	); err != nil {
		log.Printf("[oauth] 保存 state 失败: %v", err)
		redirectAuthError(c, "初始化登录失败，请重试")
		return
	}

	// 顺手清理过期 state，省掉一个定时任务。
	services.CleanupAuthArtifacts()

	c.Redirect(http.StatusFound, cfg.AuthorizeURL(state, challenge))
}

// OAuthCallback 处理平台回调。
func OAuthCallback(c *gin.Context) {
	providerKey := c.Param("provider")
	baseURL := requestBaseURL(c)

	// 用户在平台上点了取消，会带 error 回来。
	if e := c.Query("error"); e != "" {
		desc := c.Query("error_description")
		if desc == "" {
			desc = e
		}
		redirectAuthError(c, "已取消授权："+desc)
		return
	}

	code := strings.TrimSpace(c.Query("code"))
	state := strings.TrimSpace(c.Query("state"))
	if code == "" || state == "" {
		redirectAuthError(c, "授权回调缺少必要参数")
		return
	}

	// state 一次性核销：先查后删，防止同一个 state 被重复使用（重放攻击）。
	var (
		storedProvider string
		redirectTo     string
		verifier       string
	)
	err := db.DB.QueryRow(
		"SELECT provider, redirect_to, code_verifier FROM oauth_states WHERE state = ? AND expires_at > NOW()",
		state,
	).Scan(&storedProvider, &redirectTo, &verifier)
	if err != nil {
		redirectAuthError(c, "授权状态已失效，请重新登录")
		return
	}
	if _, err := db.DB.Exec("DELETE FROM oauth_states WHERE state = ?", state); err != nil {
		log.Printf("[oauth] 删除 state 失败: %v", err)
	}

	// state 必须与发起时的平台一致，防止把 A 平台的码拿到 B 平台换。
	if storedProvider != providerKey {
		redirectAuthError(c, "授权状态与平台不匹配")
		return
	}

	cfg, ok := services.OAuthConfig(providerKey, baseURL)
	if !ok {
		redirectAuthError(c, "该登录方式未启用")
		return
	}

	info, err := cfg.Exchange(c.Request.Context(), code, verifier)
	if err != nil {
		// 平台返回的原始错误对排障有用（如回调地址不匹配），透传给前端展示。
		log.Printf("[oauth] %s 换取用户信息失败: %v", providerKey, err)
		redirectAuthError(c, "第三方登录失败："+err.Error())
		return
	}

	user, isNew, err := resolveOAuthUser(providerKey, info)
	if err != nil {
		log.Printf("[oauth] %s 匹配用户失败: %v", providerKey, err)
		redirectAuthError(c, err.Error())
		return
	}

	if user.Status != 1 {
		redirectAuthError(c, "账号已被禁用，请联系管理员")
		return
	}

	role := authz.ParseRole(user.Role)
	token, err := auth.Issue(services.JWTSecret(), user.ID, user.Username, user.Role)
	if err != nil {
		log.Printf("[oauth] 签发令牌失败: %v", err)
		redirectAuthError(c, "登录失败，请重试")
		return
	}

	if _, err := db.DB.Exec("UPDATE users SET last_login_at = NOW() WHERE id = ?", user.ID); err != nil {
		log.Printf("[oauth] 更新登录时间失败: %v", err)
	}

	// 登录审计（type = 5）：记录来源平台与新用户标记。
	auditLogin(user.ID, c.ClientIP(), c.Request.UserAgent(), providerKey+" 登录",
		"用户名 "+user.Username+" 新用户="+boolFlag(isNew))

	setAuthCookie(c, token)

	log.Printf("[oauth] %s 用户 %s（%s）登录成功，新用户=%v", providerKey, user.Username, role.Name(), isNew)

	// 回到前端回调页，由它写入本地令牌并跳转。
	// 令牌放在 fragment（#）里而不是 query：fragment 不会进服务器日志与 Referer。
	target := "/auth/callback#token=" + token + "&new=" + boolFlag(isNew)
	if redirectTo != "" && redirectTo != "/" {
		target += "&next=" + strings.ReplaceAll(redirectTo, "&", "%26")
	}
	c.Redirect(http.StatusFound, target)
}

// resolveOAuthUser 把三方身份映射到本站用户。
//
// 匹配顺序（顺序即是安全策略）：
//  1. 已绑定过该平台账号 → 直接用
//  2. 平台邮箱已验证 + 本站存在同邮箱用户 → 自动绑定
//  3. 都不匹配 → 建新号
//
// 第 2 步必须要求平台邮箱已验证。否则攻击者可以在某个平台
// 把邮箱改成受害者的地址，从而接管本站账号。
func resolveOAuthUser(providerKey string, info *oauth.UserInfo) (*models.User, bool, error) {
	// 1. 查已绑定记录
	var boundUserID int64
	err := db.DB.QueryRow(
		"SELECT user_id FROM user_oauth WHERE provider = ? AND provider_user_id = ?",
		providerKey, info.ProviderUserID,
	).Scan(&boundUserID)

	if err == nil {
		user, loadErr := loadUserByID(boundUserID)
		if loadErr != nil {
			return nil, false, errors.New("绑定的账号不存在")
		}
		// 顺带刷新资料，用户改了平台昵称或头像后这里能同步过来。
		if _, updErr := db.DB.Exec(
			`UPDATE user_oauth SET provider_username = ?, provider_email = ?, avatar_url = ?
			 WHERE provider = ? AND provider_user_id = ?`,
			info.Username, info.Email, info.AvatarURL, providerKey, info.ProviderUserID,
		); updErr != nil {
			log.Printf("[oauth] 刷新绑定资料失败: %v", updErr)
		}
		syncUserAvatar(user.ID, info.AvatarURL)
		return user, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("查询绑定关系失败: %w", err)
	}

	// 2. 邮箱已验证时尝试匹配已有账号
	if info.Email != "" && info.EmailVerified {
		var existingID int64
		err := db.DB.QueryRow(
			"SELECT id FROM users WHERE email = ? LIMIT 1",
			normalizeEmailForLookup(info.Email),
		).Scan(&existingID)
		if err == nil {
			user, loadErr := loadUserByID(existingID)
			if loadErr != nil {
				return nil, false, errors.New("匹配到的账号不存在")
			}
			if err := bindOAuth(user.ID, providerKey, info); err != nil {
				return nil, false, err
			}
			return user, false, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, false, fmt.Errorf("按邮箱匹配账号失败: %w", err)
		}
	}

	// 3. 建新号
	user, err := createOAuthUser(providerKey, info)
	if err != nil {
		return nil, false, err
	}
	return user, true, nil
}

// createOAuthUser 为三方登录创建本站账号。
//
// 用户名由平台昵称派生，冲突时追加数字后缀；
// 密码留空 —— 这类账号只能通过原平台登录，除非之后在设置里主动设密码。
func createOAuthUser(providerKey string, info *oauth.UserInfo) (*models.User, error) {
	base := sanitizeUsername(info.Username)
	if base == "" {
		base = providerKey + "_user"
	}

	username, err := uniqueUsername(base)
	if err != nil {
		return nil, err
	}

	email := ""
	nameVerified := 0
	if info.Email != "" {
		email = normalizeEmailForLookup(info.Email)
		if info.EmailVerified {
			nameVerified = 1
		}
	}

	giftOd := services.GetIntOption("quota_for_new_user", 0)
	unitsPerOd := services.GetIntOption("units_per_od", services.DefaultUnitsPerOD)
	quota := int64(giftOd) * int64(unitsPerOd)

	// 角色固定为普通用户 —— 三方登录绝不能带出管理员账号。
	const defaultRole = int(authz.RoleUser)

	res, err := db.DB.Exec(
		`INSERT INTO users (username, display_name, password_hash, email, email_verified, role, status, quota, group_name)
		 VALUES (?, ?, '', ?, ?, ?, 1, ?, ?)`,
		username, displayNameFallback(info.Username, username), email, nameVerified,
		defaultRole, quota, string(authz.DefaultGroup),
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号失败: %w", err)
	}

	newID, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("读取新账号 ID 失败: %w", err)
	}

	if err := bindOAuth(newID, providerKey, info); err != nil {
		// 绑定失败会让下次登录又建一个新号，因此这里必须回滚用户。
		if _, delErr := db.DB.Exec("DELETE FROM users WHERE id = ?", newID); delErr != nil {
			log.Printf("[oauth] 回滚新建账号失败: %v", delErr)
		}
		return nil, err
	}

	user, err := loadUserByID(newID)
	if err != nil {
		return nil, fmt.Errorf("读取新账号失败: %w", err)
	}
	return user, nil
}

func bindOAuth(userID int64, providerKey string, info *oauth.UserInfo) error {
	_, err := db.DB.Exec(
		`INSERT INTO user_oauth (user_id, provider, provider_user_id, provider_username, provider_email, avatar_url)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), provider_username = VALUES(provider_username)`,
		userID, providerKey, info.ProviderUserID, info.Username, info.Email, info.AvatarURL,
	)
	if err != nil {
		return fmt.Errorf("绑定三方账号失败: %w", err)
	}
	syncUserAvatar(userID, info.AvatarURL)
	return nil
}

// syncUserAvatar 把三方平台的头像写进 users.avatar_url。
//
// users 表上存一份快照，是为了让用户列表、日志等所有出现用户的地方
// 都能带着头像展示，而不必回查 user_oauth（一个用户可能绑多个平台）。
//
// 两个前提：
//  1. 新头像非空 —— 平台偶尔不返回头像，不该把已有的抹掉；
//  2. 用户没有自己上传过头像 —— 自定义头像存在 avatar_media_id，
//     它比平台头像优先级更高，绝不能被一次登录覆盖掉。
func syncUserAvatar(userID int64, avatarURL string) {
	if userID <= 0 || strings.TrimSpace(avatarURL) == "" {
		return
	}
	if _, err := db.DB.Exec(
		"UPDATE users SET avatar_url = ? WHERE id = ? AND avatar_url <> ? AND avatar_media_id = 0",
		avatarURL, userID, avatarURL,
	); err != nil {
		log.Printf("[oauth] 同步用户头像失败: %v", err)
	}
}

// uniqueUsername 生成不冲突的用户名，冲突时追加 _2、_3 …
// 上限 10 次尝试，避免极端情况下死循环。
func uniqueUsername(base string) (string, error) {
	candidate := base
	for i := 1; i <= 10; i++ {
		var exists int
		if err := db.DB.QueryRow("SELECT COUNT(*) FROM users WHERE username = ?", candidate).Scan(&exists); err != nil {
			return "", fmt.Errorf("检查用户名失败: %w", err)
		}
		if exists == 0 {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s_%d", base, i+1)
	}
	// 退路：用时间戳，几乎不可能再冲突。
	return fmt.Sprintf("%s_%d", base, time.Now().Unix()%100000), nil
}

// sanitizeUsername 把平台昵称转成合法用户名：
// 小写、只留字母数字下划线连字符、截断到 24 位（给后缀留空间）。
func sanitizeUsername(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		case r >= 0x4e00 && r <= 0x9fff:
			// 中文昵称无法直接当用户名（现有校验只允许 ASCII），
			// 转成拼音不现实，这里丢弃，让上层用平台前缀兜底。
			continue
		}
	}
	out := b.String()
	if len(out) > 24 {
		out = out[:24]
	}
	// 最少 3 位，不足就返回空让调用方兜底。
	if len(out) < 3 {
		return ""
	}
	return out
}

func displayNameFallback(name, username string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return username
	}
	if len([]rune(name)) > 32 {
		return string([]rune(name)[:32])
	}
	return name
}

func normalizeEmailForLookup(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func loadUserByID(id int64) (*models.User, error) {
	var u models.User
	err := db.DB.QueryRow(
		`SELECT id, username, display_name, password_hash, email, role, status,
		        quota, used_quota, group_name, created_at, updated_at, last_login_at,
		        avatar_url
		 FROM users WHERE id = ?`, id,
	).Scan(
		&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Email, &u.Role, &u.Status,
		&u.Quota, &u.UsedQuota, &u.GroupName, &u.CreatedAt, &u.UpdatedAt, &u.LastLoginAt,
		&u.AvatarURL,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// sanitizeRedirect 只允许站内相对路径，挡住开放重定向。
func sanitizeRedirect(to string) string {
	to = strings.TrimSpace(to)
	if to == "" {
		return ""
	}
	if !strings.HasPrefix(to, "/") || strings.HasPrefix(to, "//") {
		return ""
	}
	if len(to) > 200 {
		return ""
	}
	return to
}

func boolFlag(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

// redirectAuthError 把错误带回前端回调页展示。
// 错误文案放 fragment，既不进服务端日志也不进 Referer。
func redirectAuthError(c *gin.Context, message string) {
	c.Redirect(http.StatusFound, "/auth/callback#error="+urlEncode(message))
}

func urlEncode(s string) string {
	// 只做最小转义：错误文案主要含中文与标点，交给前端 decodeURIComponent。
	var b strings.Builder
	for _, r := range s {
		if r == '&' || r == '#' || r == '=' || r == '?' || r == ' ' || r == '%' {
			b.WriteString(fmt.Sprintf("%%%02X", r))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
