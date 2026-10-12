package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// UserInfo 是各平台用户资料的归一化结果。
// 不同平台的字段名、嵌套结构差异很大，统一在各自的解析函数里抹平。
type UserInfo struct {
	ProviderUserID string
	Username       string
	Email          string
	// EmailVerified 表示平台是否确认该邮箱真实可用。
	// 只有它为 true 时才允许用邮箱去匹配已有账号，否则会有账号接管风险。
	EmailVerified bool
	AvatarURL     string
}

// Provider 描述一个 OAuth2 平台的接入方式。
type Provider struct {
	Key         string
	DisplayName string
	AuthorizeURL string
	TokenURL     string
	Scopes       []string
	// UsePKCE 开启后授权时带 code_challenge，回调时带 code_verifier。
	// 对公开客户端尤为重要，机密客户端开启也无副作用。
	UsePKCE bool
	// ExtraAuthParams 是少数平台需要的额外授权参数。
	ExtraAuthParams map[string]string
	// FetchUserInfo 用拿到的 access token 拉取用户资料。
	FetchUserInfo func(ctx context.Context, client *http.Client, accessToken string) (*UserInfo, error)
}

// httpClient 是各平台请求共用的客户端。
// 超时必须有：回调路径上卡住会一直占着连接。
var httpClient = &http.Client{Timeout: 15 * time.Second}

// registry 是内置支持的平台。新增平台只需在这里补一项。
var registry = map[string]*Provider{
	"google": {
		Key:          "google",
		DisplayName:  "Google",
		AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scopes:       []string{"openid", "email", "profile"},
		UsePKCE:      true,
		ExtraAuthParams: map[string]string{
			// 让用户每次都能选择账号，而不是被浏览器静默复用上一个。
			"prompt": "select_account",
		},
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				Sub           string `json:"sub"`
				Email         string `json:"email"`
				EmailVerified bool   `json:"email_verified"`
				Name          string `json:"name"`
				Picture       string `json:"picture"`
			}
			if err := getJSON(ctx, client, "https://openidconnect.googleapis.com/v1/userinfo", token, &raw); err != nil {
				return nil, err
			}
			return &UserInfo{
				ProviderUserID: raw.Sub,
				Username:       raw.Name,
				Email:          raw.Email,
				EmailVerified:  raw.EmailVerified,
				AvatarURL:      raw.Picture,
			}, nil
		},
	},

	"github": {
		Key:          "github",
		DisplayName:  "GitHub",
		AuthorizeURL: "https://github.com/login/oauth/authorize",
		TokenURL:     "https://github.com/login/oauth/access_token",
		Scopes:       []string{"read:user", "user:email"},
		UsePKCE:      false,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				ID        int64  `json:"id"`
				Login     string `json:"login"`
				Name      string `json:"name"`
				Email     string `json:"email"`
				AvatarURL string `json:"avatar_url"`
			}
			if err := getJSON(ctx, client, "https://api.github.com/user", token, &raw); err != nil {
				return nil, err
			}

			info := &UserInfo{
				ProviderUserID: strconv.FormatInt(raw.ID, 10),
				Username:       raw.Login,
				AvatarURL:      raw.AvatarURL,
			}

			// /user 的 email 字段在用户设为私密时为空，必须再查 /user/emails。
			if raw.Email != "" {
				info.Email = raw.Email
				info.EmailVerified = true
			} else {
				var emails []struct {
					Email    string `json:"email"`
					Primary  bool   `json:"primary"`
					Verified bool   `json:"verified"`
				}
				if err := getJSON(ctx, client, "https://api.github.com/user/emails", token, &emails); err == nil {
					// 优先取「主邮箱且已验证」的那条，其次退回第一个已验证的。
					for _, e := range emails {
						if e.Primary && e.Verified {
							info.Email, info.EmailVerified = e.Email, true
							break
						}
					}
					if info.Email == "" {
						for _, e := range emails {
							if e.Verified {
								info.Email, info.EmailVerified = e.Email, true
								break
							}
						}
					}
				}
			}
			return info, nil
		},
	},

	"microsoft": {
		Key:          "microsoft",
		DisplayName:  "Microsoft",
		AuthorizeURL: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		TokenURL:     "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		Scopes:       []string{"openid", "email", "profile", "User.Read"},
		UsePKCE:      true,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				Sub               string `json:"sub"`
				Email             string `json:"email"`
				PreferredUsername string `json:"preferred_username"`
				Name              string `json:"name"`
				Picture           string `json:"picture"`
			}
			if err := getJSON(ctx, client, "https://graph.microsoft.com/oidc/userinfo", token, &raw); err != nil {
				return nil, err
			}
			email := raw.Email
			if email == "" {
				email = raw.PreferredUsername
			}
			// 微软不返回 email_verified；能取到值即视为该租户已确认。
			return &UserInfo{
				ProviderUserID: raw.Sub,
				Username:       raw.Name,
				Email:          email,
				EmailVerified:  email != "",
				AvatarURL:      raw.Picture,
			}, nil
		},
	},

	"gitlab": {
		Key:          "gitlab",
		DisplayName:  "GitLab",
		AuthorizeURL: "https://gitlab.com/oauth/authorize",
		TokenURL:     "https://gitlab.com/oauth/token",
		Scopes:       []string{"read_user"},
		UsePKCE:      true,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				ID              int64  `json:"id"`
				Username        string `json:"username"`
				Name            string `json:"name"`
				Email           string `json:"email"`
				AvatarURL       string `json:"avatar_url"`
				EmailVerified   bool   `json:"email_verified"`
				ConfirmedAt     string `json:"confirmed_at"`
			}
			if err := getJSON(ctx, client, "https://gitlab.com/api/v4/user", token, &raw); err != nil {
				return nil, err
			}
			return &UserInfo{
				ProviderUserID: strconv.FormatInt(raw.ID, 10),
				Username:       raw.Username,
				Email:          raw.Email,
				// GitLab 用 confirmed_at 表示邮箱已确认。
				EmailVerified: raw.EmailVerified || raw.ConfirmedAt != "",
				AvatarURL:     raw.AvatarURL,
			}, nil
		},
	},

	"gitee": {
		Key:          "gitee",
		DisplayName:  "Gitee",
		AuthorizeURL: "https://gitee.com/oauth/authorize",
		TokenURL:     "https://gitee.com/oauth/token",
		Scopes:       []string{"user_info", "emails"},
		UsePKCE:      true,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				ID        int64  `json:"id"`
				Login     string `json:"login"`
				Name      string `json:"name"`
				Email     string `json:"email"`
				AvatarURL string `json:"avatar_url"`
			}
			if err := getJSON(ctx, client, "https://gitee.com/api/v5/user", token, &raw); err != nil {
				return nil, err
			}
			return &UserInfo{
				ProviderUserID: strconv.FormatInt(raw.ID, 10),
				Username:       raw.Login,
				Email:          raw.Email,
				// Gitee 有邮箱即视为可用（其邮箱需注册验证）。
				EmailVerified: raw.Email != "",
				AvatarURL:     raw.AvatarURL,
			}, nil
		},
	},

	"qq": {
		Key:          "qq",
		DisplayName:  "QQ",
		AuthorizeURL: "https://graph.qq.com/oauth2.0/authorize",
		TokenURL:     "https://graph.qq.com/oauth2.0/token",
		Scopes:       []string{"get_user_info"},
		UsePKCE:      false,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			// QQ 的 openid 接口返回的是 JSONP：callback( {...} );
			// 且必须再调 get_user_info 才拿得到昵称与头像，没有邮箱字段。
			body, err := getRaw(ctx, client, "https://graph.qq.com/oauth2.0/me?access_token="+url.QueryEscape(token))
			if err != nil {
				return nil, err
			}
			openid, err := parseQQOpenID(body)
			if err != nil {
				return nil, err
			}

			var profile struct {
				Nickname  string `json:"nickname"`
				FigureURL string `json:"figureurl_qq_2"`
			}
			u := "https://graph.qq.com/user/get_user_info?access_token=" + url.QueryEscape(token) +
				"&oauth_consumer_key=" + url.QueryEscape(clientIDFromContext(ctx)) +
				"&openid=" + url.QueryEscape(openid)
			if err := getJSONWithQuery(ctx, client, u, &profile); err != nil {
				// 拿不到昵称不算致命，openid 已足够标识用户。
				profile.Nickname = ""
			}

			return &UserInfo{
				ProviderUserID: openid,
				Username:       profile.Nickname,
				// QQ 不提供邮箱，只能靠 openid 标识；下游需要它来建号时走无邮箱分支。
				AvatarURL: profile.FigureURL,
			}, nil
		},
	},

	"discord": {
		Key:          "discord",
		DisplayName:  "Discord",
		AuthorizeURL: "https://discord.com/api/oauth2/authorize",
		TokenURL:     "https://discord.com/api/oauth2/token",
		Scopes:       []string{"identify", "email"},
		UsePKCE:      true,
		FetchUserInfo: func(ctx context.Context, client *http.Client, token string) (*UserInfo, error) {
			var raw struct {
				ID            string `json:"id"`
				Username      string `json:"username"`
				GlobalName    string `json:"global_name"`
				Email         string `json:"email"`
				Verified      bool   `json:"verified"`
				Avatar        string `json:"avatar"`
			}
			if err := getJSON(ctx, client, "https://discord.com/api/users/@me", token, &raw); err != nil {
				return nil, err
			}
			name := raw.GlobalName
			if name == "" {
				name = raw.Username
			}
			avatar := ""
			if raw.Avatar != "" {
				avatar = fmt.Sprintf("https://cdn.discordapp.com/avatars/%s/%s.png", raw.ID, raw.Avatar)
			}
			return &UserInfo{
				ProviderUserID: raw.ID,
				Username:       name,
				Email:          raw.Email,
				EmailVerified:  raw.Verified,
				AvatarURL:      avatar,
			}, nil
		},
	},
}

// Lookup 按 key 取平台定义。
func Lookup(key string) (*Provider, bool) {
	p, ok := registry[strings.ToLower(strings.TrimSpace(key))]
	return p, ok
}

// All 返回全部内置平台，管理端用它渲染配置表单。
func All() []*Provider {
	// 固定顺序，避免每次刷新页面顺序都变。
	order := []string{"google", "github", "microsoft", "gitlab", "gitee", "qq", "discord"}
	out := make([]*Provider, 0, len(order))
	for _, k := range order {
		if p, ok := registry[k]; ok {
			out = append(out, p)
		}
	}
	return out
}

// ---------- 内部辅助 ----------

// clientIDFromContext 让 QQ 的 get_user_info 能拿到 client_id。
// QQ 这个接口要求把 client_id 作为 oauth_consumer_key 传入，
// 而它是配置项而非平台常量，因此通过 context 传递。
type clientIDKey struct{}

func WithClientID(ctx context.Context, clientID string) context.Context {
	return context.WithValue(ctx, clientIDKey{}, clientID)
}

func clientIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(clientIDKey{}).(string); ok {
		return v
	}
	return ""
}

func getJSON(ctx context.Context, client *http.Client, endpoint, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	// GitHub 要求带 UA，否则直接拒绝。
	req.Header.Set("User-Agent", "ooapi-gateway")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("平台返回 %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("解析平台响应失败: %w", err)
	}
	return nil
}

func getJSONWithQuery(ctx context.Context, client *http.Client, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ooapi-gateway")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("平台返回 %d", resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

func getRaw(ctx context.Context, client *http.Client, endpoint string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ooapi-gateway")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("平台返回 %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return string(body), nil
}

// parseQQOpenID 从 JSONP 里抠出 openid。
// 响应形如：callback( {"client_id":"1","openid":"ABC"} );
func parseQQOpenID(body string) (string, error) {
	start := strings.Index(body, "{")
	end := strings.LastIndex(body, "}")
	if start < 0 || end <= start {
		return "", fmt.Errorf("无法解析 QQ openid 响应")
	}
	var parsed struct {
		OpenID string `json:"openid"`
	}
	if err := json.Unmarshal([]byte(body[start:end+1]), &parsed); err != nil {
		return "", fmt.Errorf("解析 QQ openid 失败: %w", err)
	}
	if parsed.OpenID == "" {
		return "", fmt.Errorf("QQ 未返回 openid")
	}
	return parsed.OpenID, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
