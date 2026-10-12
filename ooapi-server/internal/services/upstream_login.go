package services

/*
订阅账号的交互式 OAuth 登录（Codex / Claude / Google Antigravity）。

为什么是「打开授权页 + 手动粘贴回调地址」而不是自动回调：
本平台部署在服务器上，而官方 CLI 客户端注册的 redirect_uri 固定指向
http://localhost:<port>（用户自己电脑上的端口）。浏览器登录完会跳到用户本机，
那儿没有我们的服务，页面打不开 —— 这是标准现象，与
`gcloud auth login --no-launch-browser` 一致：用户把地址栏里那串带 ?code= 的
完整 URL 复制回来，服务端据此换 token。

好处：不需要公网回调地址、不需要备案域名，也不要求服务器能被用户浏览器访问。

安全要点：
  · state 随机生成、内存暂存、一次性消费、绑定发起人（owner），
    防止把别人的授权码绑进自己的账号（CSRF / 会话混淆）；
  · 全部走 HTTPS 官方端点，不经任何第三方中转；
  · codex / claude 用 PKCE（S256）；Google 用 access_type=offline + prompt=consent
    换取 refresh_token（否则账号一小时后失效）。

与设备码授权（device_bind.go）的区别：那条链路是「服务端拿 device_code 轮询」，
用户不需要粘贴任何东西；这条是「用户浏览器登录 → 回调地址粘回来换 token」。
两者都产出加密凭据，但上游协议完全不同。
*/

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"ooapi/internal/cryptoutil"
)

// ---------- 厂商配置 ----------

// UpstreamLoginVendor 是支持交互式登录的订阅厂商标识（也是渠道的 method）。
const (
	LoginVendorCodex       = "codex"
	LoginVendorClaudeOAuth = "claude-oauth"
	LoginVendorAntigravity = "antigravity"
)

// UpstreamLoginMethods 是三个订阅接入方式，供路由与校验共用。
func UpstreamLoginMethods() []string {
	return []string{LoginVendorCodex, LoginVendorClaudeOAuth, LoginVendorAntigravity}
}

// UpstreamLoginVendorOfMethod 判断 method 是否属于订阅登录渠道。
func UpstreamLoginVendorOfMethod(method string) (string, bool) {
	switch strings.TrimSpace(method) {
	case LoginVendorCodex:
		return LoginVendorCodex, true
	case LoginVendorClaudeOAuth:
		return LoginVendorClaudeOAuth, true
	case LoginVendorAntigravity:
		return LoginVendorAntigravity, true
	}
	return "", false
}

// UpstreamVendorForLoginMethod 返回该登录方式必须搭配的渠道厂商。
//
// 渠道厂商沿用站点既有的厂商 key（openai / anthropic / gemini），
// 因为同一个厂商下既有 API Key 渠道也有订阅渠道，厂商不该重复。
// 校验时必须用这张表，不能让「anthropic 厂商 + codex 登录」这种错配落库 ——
// 后果是请求带着 Claude 凭据打到 OpenAI 的地址上。
func UpstreamVendorForLoginMethod(method string) string {
	switch strings.TrimSpace(method) {
	case LoginVendorCodex:
		return "openai"
	case LoginVendorClaudeOAuth:
		return "anthropic"
	case LoginVendorAntigravity:
		return "gemini"
	}
	return ""
}

// 官方 CLI 使用的公开客户端标识。
//
// 这些是「安装型应用」的公开凭据：OpenAI 的 Codex CLI 与 Anthropic 的
// Claude Code 都把 client_id 写在开源仓库里，Google 的 Gemini CLI 更是在
// 源码注释里明说 client secret 不算机密（installed application）。
// 因此内置为默认值开箱即用；想走自建客户端用环境变量覆盖。
// 注意：**登录与刷新必须用同一套凭据**，否则 refresh_token 会因 client 不匹配被拒。
const (
	codexClientID       = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexRedirectURI    = "http://localhost:1455/auth/callback"
	codexAuthURL        = "https://auth.openai.com/oauth/authorize"
	codexTokenURL       = "https://auth.openai.com/oauth/token"
	codexScope          = "openid profile email offline_access"
	claudeOAuthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeOAuthRedirect = "http://localhost:54545/callback"
	claudeOAuthAuthURL  = "https://claude.ai/oauth/authorize"
	claudeOAuthTokenURL = "https://platform.claude.com/v1/oauth/token"
	claudeOAuthScope    = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
	googleRedirectURI   = "http://localhost:51121/oauth-callback"
	googleAuthURL       = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL      = "https://oauth2.googleapis.com/token"
)

/*
令牌端点的可替换副本（仅测试使用）。

测试要验证「换令牌时到底发了什么参数」，这必须打到一台本地假服务器上 ——
否则测不出 code_verifier / redirect_uri / grant_type 有没有写对。
生产代码读的是下面这对变量，默认值就是上面的官方端点，行为完全一致。
*/
var (
	codexTokenURLForTest  = codexTokenURL
	claudeTokenURLForTest = claudeOAuthTokenURL
)

/*
Google OAuth 客户端凭据**只从环境变量读**，不写进代码。

	GOOGLE_OAUTH_CLIENT_ID
	GOOGLE_OAUTH_CLIENT_SECRET

为什么不留内置默认值：这对凭据虽然是 Google 公开发布的安装型应用凭据
（Gemini CLI 等多个开源项目都内嵌），但把它写进源码有两个实际问题：

  1. GitHub 的推送保护会把它判成「泄露的密钥」而**拒收整个仓库**；
  2. 更根本的：内嵌的 client secret 任何人都能提取，等同于公开值，
     对「谁在用」无从追溯。放在部署环境的 .env 里（权限 600），
     至少能按部署实例区分。

代价是全新部署必须自己配这两个变量才能用 Google 订阅登录 ——
启动时若缺失会记一条明确的日志（见 googleOAuthCreds 的调用方），
而不是让人对着一个「授权失败」猜原因。
*/
func googleOAuthCreds() (clientID, clientSecret string, builtin bool) {
	id := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"))
	return id, secret, id != "" && secret != ""
}

// googleScopes 是 Antigravity 客户端注册的 scope 集合（与 CLIProxyAPI 的
// Antigravity provider 一致）。少一个 cclog / experimentsandconfigs 都会 403。
var googleScopes = []string{
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
}

// ---------- 会话状态 ----------

const upstreamLoginTTL = 15 * time.Minute

type upstreamLoginSession struct {
	owner       int64
	vendor      string
	verifier    string // PKCE code_verifier（codex / claude）
	redirectURI string
	createdAt   time.Time
}

// UpstreamLoginStart 是一次登录的公开信息（不含任何凭据）。
type UpstreamLoginStart struct {
	Vendor      string `json:"vendor"`
	AuthURL     string `json:"auth_url"`
	State       string `json:"state"`
	RedirectURI string `json:"redirect_uri"`
	ExpiresIn   int    `json:"expires_in"`
}

// UpstreamLoginCredential 是换回来的凭据（服务端内部流转，绝不出现在响应里）。
type UpstreamLoginCredential struct {
	Vendor       string
	Encrypted    string // 加密后的凭据 JSON
	AccountLabel string
	ExpiresAt    int64
}

// UpstreamLoginService 管理进行中的交互式登录。
//
// 与设备授权引擎（DeviceBindService）一样是内存表：服务重启会丢掉进行中的
// 登录（用户重新点一次即可），这是可接受的取舍 —— 凭据本身落库加密存储。
type UpstreamLoginService struct {
	mu       sync.Mutex
	sessions map[string]*upstreamLoginSession
	client   *http.Client
}

var UpstreamLogins = NewUpstreamLoginService()

// NewUpstreamLoginService 构造登录服务。
func NewUpstreamLoginService() *UpstreamLoginService {
	return &UpstreamLoginService{
		sessions: map[string]*upstreamLoginSession{},
		client:   &http.Client{Timeout: 30 * time.Second},
	}
}

// loginClient 可在测试中替换（指向 httptest 服务器）。
var loginClient = func() *http.Client { return UpstreamLogins.client }

func (s *UpstreamLoginService) sweepLocked(now time.Time) {
	for state, session := range s.sessions {
		if now.Sub(session.createdAt) > upstreamLoginTTL {
			delete(s.sessions, state)
		}
	}
}

// randomURLSafe 生成 n 字节的 URL 安全随机串（PKCE verifier / state 共用）。
func randomURLSafe(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Start 生成授权地址并记住这次登录（owner 绑定，防串号）。
func (s *UpstreamLoginService) Start(vendor string, owner int64) (UpstreamLoginStart, error) {
	vendor = strings.TrimSpace(vendor)
	state, err := randomURLSafe(24)
	if err != nil {
		return UpstreamLoginStart{}, errors.New("生成登录标识失败")
	}

	session := &upstreamLoginSession{owner: owner, vendor: vendor, createdAt: time.Now()}
	var authURL string

	switch vendor {
	case LoginVendorCodex:
		verifier, err := randomURLSafe(48)
		if err != nil {
			return UpstreamLoginStart{}, errors.New("生成 PKCE 校验串失败")
		}
		session.verifier = verifier
		session.redirectURI = codexRedirectURI
		params := url.Values{
			"client_id":                  {codexClientID},
			"redirect_uri":               {codexRedirectURI},
			"response_type":              {"code"},
			"scope":                      {codexScope},
			"state":                      {state},
			"code_challenge":             {pkceChallenge(verifier)},
			"code_challenge_method":      {"S256"},
			"id_token_add_organizations": {"true"},
			"codex_cli_simplified_flow":  {"true"},
			"originator":                 {"codex_cli_rs"},
		}
		authURL = codexAuthURL + "?" + params.Encode()

	case LoginVendorClaudeOAuth:
		verifier, err := randomURLSafe(48)
		if err != nil {
			return UpstreamLoginStart{}, errors.New("生成 PKCE 校验串失败")
		}
		session.verifier = verifier
		session.redirectURI = claudeOAuthRedirect
		params := url.Values{
			"client_id":             {claudeOAuthClientID},
			"redirect_uri":          {claudeOAuthRedirect},
			"response_type":         {"code"},
			"scope":                 {claudeOAuthScope},
			"state":                 {state},
			"code_challenge":        {pkceChallenge(verifier)},
			"code_challenge_method": {"S256"},
		}
		authURL = claudeOAuthAuthURL + "?" + params.Encode()

	case LoginVendorAntigravity:
		clientID, _, okCreds := googleOAuthCreds()
		if !okCreds {
			return UpstreamLoginStart{}, errors.New("Google 订阅登录未配置：请在 .env 里设置 GOOGLE_OAUTH_CLIENT_ID 与 GOOGLE_OAUTH_CLIENT_SECRET（Google Cloud Console 创建 OAuth 客户端时获得）")
		}
		session.redirectURI = googleRedirectURI
		params := url.Values{
			"client_id":     {clientID},
			"redirect_uri":  {googleRedirectURI},
			"response_type": {"code"},
			"scope":         {strings.Join(googleScopes, " ")},
			"state":         {state},
			// access_type=offline + prompt=consent 才下发 refresh_token；
			// 少任何一个，账号只能活一小时。
			"access_type": {"offline"},
			"prompt":      {"consent"},
		}
		authURL = googleAuthURL + "?" + params.Encode()

	default:
		return UpstreamLoginStart{}, fmt.Errorf("不支持交互式登录的厂商：%s", vendor)
	}

	s.mu.Lock()
	s.sweepLocked(time.Now())
	s.sessions[state] = session
	s.mu.Unlock()

	return UpstreamLoginStart{
		Vendor:      vendor,
		AuthURL:     authURL,
		State:       state,
		RedirectURI: session.redirectURI,
		ExpiresIn:   int(upstreamLoginTTL / time.Second),
	}, nil
}

// takeSession 取出并删除一个登录会话（一次性）。owner 不匹配直接拒绝。
func (s *UpstreamLoginService) takeSession(state string, owner int64) (*upstreamLoginSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(time.Now())
	session := s.sessions[strings.TrimSpace(state)]
	if session == nil {
		return nil, errors.New("这次登录已超时或不存在，请重新发起授权")
	}
	if session.owner != owner {
		// 不删除：可能是别人正在进行的登录，删掉等于帮助攻击者打断它。
		return nil, errors.New("这次登录不属于当前管理员，请重新发起授权")
	}
	delete(s.sessions, state)
	return session, nil
}

// ExtractAuthCode 从用户粘贴的内容里取出授权码与 state。
//
// 用户可能粘贴：完整回调 URL、只有 code、甚至整段浏览器地址栏文本 —— 都要能处理。
func ExtractAuthCode(input string) (code, state string) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return "", ""
	}
	if i := strings.Index(raw, "?"); i >= 0 {
		if values, err := url.ParseQuery(raw[i+1:]); err == nil {
			if c := strings.TrimSpace(values.Get("code")); c != "" {
				return c, strings.TrimSpace(values.Get("state"))
			}
		}
	}
	if values, err := url.ParseQuery(raw); err == nil {
		if c := strings.TrimSpace(values.Get("code")); c != "" {
			return c, strings.TrimSpace(values.Get("state"))
		}
	}
	/*
		只粘贴了 code：整串按 code 处理（去掉可能的 URL 编码）。

		必须排掉「看起来像 URL 但不是回调」的输入：用户把授权失败页或别的
		地址粘进来时，整串被当成 code 就会拿去换令牌，上游回一句 invalid_grant，
		用户完全不知道问题出在「粘错了东西」。
	*/
	if strings.Contains(raw, "://") {
		return "", ""
	}
	if decoded, err := url.QueryUnescape(raw); err == nil {
		raw = decoded
	}
	if raw != "" && !strings.ContainsAny(raw, " \t\r\n") {
		return raw, ""
	}
	return "", ""
}

// Exchange 用粘贴回来的授权码换取凭据。
func (s *UpstreamLoginService) Exchange(ctx context.Context, vendor string, owner int64, pasted string) (UpstreamLoginCredential, error) {
	vendor = strings.TrimSpace(vendor)
	code, state := ExtractAuthCode(pasted)
	if code == "" {
		return UpstreamLoginCredential{}, errors.New("没有找到授权码，请把浏览器地址栏里那一整串 URL 复制过来")
	}
	// state 必填且必须命中本次登录：否则别人的授权码可能被绑进本平台。
	if state == "" {
		return UpstreamLoginCredential{}, errors.New("缺少 state：请重新点击「一键登录」发起授权，再粘贴回调地址")
	}
	session, err := s.takeSession(state, owner)
	if err != nil {
		return UpstreamLoginCredential{}, err
	}
	if session.vendor != vendor {
		return UpstreamLoginCredential{}, errors.New("这次登录与当前厂商不匹配，请重新发起授权")
	}

	var credential map[string]any
	var label string
	var expiresAt int64

	switch vendor {
	case LoginVendorCodex:
		credential, label, expiresAt, err = s.exchangeCodex(ctx, session, code)
	case LoginVendorClaudeOAuth:
		credential, label, expiresAt, err = s.exchangeClaudeOAuth(ctx, session, code)
	case LoginVendorAntigravity:
		credential, label, expiresAt, err = s.exchangeGoogle(ctx, session, code)
	default:
		err = fmt.Errorf("不支持交互式登录的厂商：%s", vendor)
	}
	if err != nil {
		return UpstreamLoginCredential{}, err
	}

	raw, err := json.Marshal(credential)
	if err != nil {
		return UpstreamLoginCredential{}, errors.New("凭据序列化失败")
	}
	encrypted, err := cryptoutil.Encrypt(JWTSecret(), string(raw))
	if err != nil {
		return UpstreamLoginCredential{}, errors.New("凭据加密失败")
	}
	return UpstreamLoginCredential{Vendor: vendor, Encrypted: encrypted, AccountLabel: label, ExpiresAt: expiresAt}, nil
}

// ---------- 各厂商的换取实现 ----------

// jwtPayloadOrNil 是 decodeJWTPayload 的宽松封装：解析失败返回 nil。
//
// 复用 WorkBuddy 那套已测试过的解析（段数校验、base64 填充兼容），
// 只用于读取展示信息（邮箱 / 账号 id），不参与任何鉴权决策。
func jwtPayloadOrNil(token string) map[string]any {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return nil
	}
	return payload
}

func stringOf(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// tokenHTTP 发一次 token 交换请求。
//
// contentType 为 form 或 json；上游对两者的要求不一致
// （OpenAI/Google 收表单，Anthropic 收 JSON），传错就是 400。
func tokenHTTP(ctx context.Context, endpoint, contentType string, payload map[string]string) (map[string]any, int, string, error) {
	var body io.Reader
	if contentType == "json" {
		raw, _ := json.Marshal(payload)
		body = strings.NewReader(string(raw))
	} else {
		values := url.Values{}
		for k, v := range payload {
			values.Set(k, v)
		}
		body = strings.NewReader(values.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return nil, 0, "", errors.New("构造令牌请求失败")
	}
	// contentType 是内部简写（"form" / "json"），必须翻成真正的 MIME 类型 ——
	// 直接把它塞进 Content-Type 会让上游收到 "form"，解析不到任何字段，
	// 表现为「换令牌返回 400 且看不出哪里不对」。
	header := "application/x-www-form-urlencoded"
	if contentType == "json" {
		header = "application/json"
	}
	req.Header.Set("Content-Type", header)
	req.Header.Set("Accept", "application/json")
	resp, err := loginClient().Do(req)
	if err != nil {
		return nil, 0, "", errors.New("无法连接授权服务器：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, string(raw), nil
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, resp.StatusCode, string(raw), errors.New("令牌响应不是合法 JSON")
	}
	return parsed, resp.StatusCode, "", nil
}

// tokenErrorHint 把上游的常见错误翻译成人看得懂的一句话。
func tokenErrorHint(status int, raw string) string {
	low := strings.ToLower(raw)
	switch {
	case strings.Contains(low, "redirect_uri_mismatch"):
		return "回调地址不匹配：若用自建 OAuth 客户端，请把它注册的回调地址改成与本平台显示的一致"
	case strings.Contains(low, "invalid_grant"):
		return "授权码无效或已被使用（同一个码只能用一次，请重新发起授权）"
	case strings.Contains(low, "invalid_client"):
		return "客户端凭据无效，请检查服务端 OAuth 配置"
	}
	return fmt.Sprintf("HTTP %d：%s", status, truncateForHint(raw, 300))
}

func truncateForHint(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// exchangeCodex 用授权码换 Codex 凭据。
func (s *UpstreamLoginService) exchangeCodex(ctx context.Context, session *upstreamLoginSession, code string) (map[string]any, string, int64, error) {
	payload := map[string]string{
		"client_id":     codexClientID,
		"code":          code,
		"grant_type":    "authorization_code",
		"redirect_uri":  session.redirectURI,
		"code_verifier": session.verifier,
	}
	parsed, status, raw, err := tokenHTTP(ctx, codexTokenURLForTest, "form", payload)
	if err != nil {
		return nil, "", 0, err
	}
	if parsed == nil {
		return nil, "", 0, errors.New("换取令牌失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	refresh := stringOf(parsed, "refresh_token")
	if access == "" {
		return nil, "", 0, errors.New("上游没有返回 access_token")
	}
	if refresh == "" {
		// 没有 refresh_token 等于一小时后必然失效的废号，当场告诉用户重来。
		return nil, "", 0, errors.New("上游没有返回 refresh_token（无法自动续期），请重新登录并确认授权")
	}
	jwt := jwtPayloadOrNil(stringOf(parsed, "id_token"))
	authClaims, _ := jwt["https://api.openai.com/auth"].(map[string]any)
	accountID := stringOf(authClaims, "chatgpt_account_id")
	if accountID == "" {
		accountID = stringOf(jwt, "chatgpt_account_id")
	}
	email := stringOf(jwt, "email")
	planType := stringOf(authClaims, "chatgpt_plan_type")
	expiresIn := numberOr(parsed["expires_in"], 3600)

	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    time.Now().Unix() + expiresIn,
	}
	if idToken := stringOf(parsed, "id_token"); idToken != "" {
		credential["id_token"] = idToken
	}
	if accountID != "" {
		credential["account_id"] = accountID
	}
	if email != "" {
		credential["email"] = email
	}
	if planType != "" {
		credential["plan_type"] = planType
	}
	label := email
	if label == "" {
		label = accountID
	}
	return credential, label, time.Now().Unix() + expiresIn, nil
}

// exchangeClaudeOAuth 用授权码换 Claude 订阅凭据（JSON 请求体）。
func (s *UpstreamLoginService) exchangeClaudeOAuth(ctx context.Context, session *upstreamLoginSession, code string) (map[string]any, string, int64, error) {
	payload := map[string]string{
		"client_id":     claudeOAuthClientID,
		"code":          code,
		"grant_type":    "authorization_code",
		"redirect_uri":  session.redirectURI,
		"code_verifier": session.verifier,
	}
	parsed, status, raw, err := tokenHTTP(ctx, claudeTokenURLForTest, "json", payload)
	if err != nil {
		return nil, "", 0, err
	}
	if parsed == nil {
		return nil, "", 0, errors.New("换取令牌失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	refresh := stringOf(parsed, "refresh_token")
	if access == "" {
		return nil, "", 0, errors.New("上游没有返回 access_token")
	}
	if refresh == "" {
		return nil, "", 0, errors.New("上游没有返回 refresh_token（无法自动续期），请重新登录并确认授权")
	}
	expiresIn := numberOr(parsed["expires_in"], 3600)
	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    time.Now().Unix() + expiresIn,
	}
	// 账号与组织标识用于展示与刷新时回填。
	if account, ok := parsed["account"].(map[string]any); ok {
		if uuid := stringOf(account, "uuid"); uuid != "" {
			credential["account_uuid"] = uuid
		}
		if email := stringOf(account, "email_address"); email != "" {
			credential["email"] = email
		}
	}
	if org, ok := parsed["organization"].(map[string]any); ok {
		if uuid := stringOf(org, "uuid"); uuid != "" {
			credential["organization_uuid"] = uuid
		}
	}
	if scope := stringOf(parsed, "scope"); scope != "" {
		credential["scope"] = scope
	}
	label := ""
	if v, ok := credential["email"].(string); ok {
		label = v
	}
	if label == "" {
		if v, ok := credential["account_uuid"].(string); ok {
			label = v
		}
	}
	return credential, label, time.Now().Unix() + expiresIn, nil
}

// exchangeGoogle 用授权码换 Google 凭据（Antigravity / Gemini CLI）。
func (s *UpstreamLoginService) exchangeGoogle(ctx context.Context, session *upstreamLoginSession, code string) (map[string]any, string, int64, error) {
	clientID, clientSecret, okCreds := googleOAuthCreds()
	if !okCreds {
		return nil, "", 0, errors.New("Google 订阅登录未配置：缺少 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET")
	}
	payload := map[string]string{
		"client_id":     clientID,
		"client_secret": clientSecret,
		"code":          code,
		"grant_type":    "authorization_code",
		"redirect_uri":  session.redirectURI,
	}
	parsed, status, raw, err := tokenHTTP(ctx, googleTokenURL, "form", payload)
	if err != nil {
		return nil, "", 0, err
	}
	if parsed == nil {
		return nil, "", 0, errors.New("换取令牌失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	refresh := stringOf(parsed, "refresh_token")
	if access == "" {
		return nil, "", 0, errors.New("上游没有返回 access_token")
	}
	if refresh == "" {
		// Google 只在 access_type=offline 且 prompt=consent 时给 refresh_token；
		// 已经授权过的账号再登一次可能不给 —— 提示用户重新授权。
		return nil, "", 0, errors.New("上游没有返回 refresh_token（无法自动续期）。请重新发起授权，并在 Google 授权页确认「允许」")
	}
	expiresIn := numberOr(parsed["expires_in"], 3600)
	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    time.Now().Unix() + expiresIn,
	}
	if scope := stringOf(parsed, "scope"); scope != "" {
		credential["scope"] = scope
	}
	if idToken := stringOf(parsed, "id_token"); idToken != "" {
		if jwt := jwtPayloadOrNil(idToken); jwt != nil {
			if email := stringOf(jwt, "email"); email != "" {
				credential["email"] = email
			}
		}
	}
	label := ""
	if v, ok := credential["email"].(string); ok {
		label = v
	}
	return credential, label, time.Now().Unix() + expiresIn, nil
}

// numberOr 把 JSON 数字（float64）转成 int，缺失时用兜底值。
func numberOr(v any, fallback int64) int64 {
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return int64(n)
		}
	case int64:
		if n > 0 {
			return n
		}
	case json.Number:
		if parsed, err := n.Int64(); err == nil && parsed > 0 {
			return parsed
		}
	}
	return fallback
}

/* ---------- 登录凭据的暂存与消费 ---------- */

/*
换回来的凭据在「账号落库之前」需要暂时存放。

存放的是**已加密的密文**，不是明文令牌 —— 与设备授权的票据表同一原则：
凭据只在服务端流动，前端只拿一个句柄。句柄一次性、有过期、绑定发起人。
*/

type storedLoginCredential struct {
	owner     int64
	cred      UpstreamLoginCredential
	expiresAt time.Time
}

const loginCredentialTTL = 10 * time.Minute

var (
	loginCredentialMu sync.Mutex
	loginCredentials  = map[string]*storedLoginCredential{}
)

// StoreLoginCredential 暂存一次登录结果，返回句柄。
func StoreLoginCredential(owner int64, cred UpstreamLoginCredential) string {
	handle, err := randomURLSafe(24)
	if err != nil {
		// 随机源失败是极端情况：退回时间戳 + 计数器仍能保证句柄唯一。
		handle = "cred-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	loginCredentialMu.Lock()
	now := time.Now()
	for key, entry := range loginCredentials {
		if now.After(entry.expiresAt) {
			delete(loginCredentials, key)
		}
	}
	loginCredentials[handle] = &storedLoginCredential{owner: owner, cred: cred, expiresAt: now.Add(loginCredentialTTL)}
	loginCredentialMu.Unlock()
	return handle
}

// TakeLoginCredential 取出并删除暂存的凭据（一次性消费）。
func TakeLoginCredential(owner int64, handle string) (UpstreamLoginCredential, bool) {
	loginCredentialMu.Lock()
	defer loginCredentialMu.Unlock()
	entry := loginCredentials[strings.TrimSpace(handle)]
	if entry == nil || entry.owner != owner || time.Now().After(entry.expiresAt) {
		return UpstreamLoginCredential{}, false
	}
	delete(loginCredentials, handle)
	return entry.cred, true
}

// RestoreLoginCredential 把消费掉的凭据放回去（拉模型失败等可重试的场景）。
func RestoreLoginCredential(owner int64, handle string, cred UpstreamLoginCredential) {
	if strings.TrimSpace(handle) == "" {
		return
	}
	loginCredentialMu.Lock()
	loginCredentials[handle] = &storedLoginCredential{owner: owner, cred: cred, expiresAt: time.Now().Add(loginCredentialTTL)}
	loginCredentialMu.Unlock()
}

// TakeLoginCredentialForChannel 取出凭据用于写入某个已存在的渠道（重新授权）。
//
// 单独一个方法是为了让「重新授权一个已有账号」也走一次性句柄，
// 但允许调用方决定是否消费（写库成功才消费）。
func TakeLoginCredentialForChannel(owner int64, handle string, consume bool) (UpstreamLoginCredential, bool) {
	if consume {
		return TakeLoginCredential(owner, handle)
	}
	loginCredentialMu.Lock()
	defer loginCredentialMu.Unlock()
	entry := loginCredentials[strings.TrimSpace(handle)]
	if entry == nil || entry.owner != owner || time.Now().After(entry.expiresAt) {
		return UpstreamLoginCredential{}, false
	}
	return entry.cred, true
}

// LoginCredentialMarker 返回订阅渠道在 api_key 里存放的内部标识。
//
// 与设备授权同一格式（ooapi-<method>-channel-<id>）：传输层据此判断
// 「这是内部渠道的请求」，从而把标识换成真实凭据、并且拒绝把它发往其它主机。
// id 为 0 时用于插入前占位，插入后回填真实 ID。
func LoginCredentialMarker(method string, id int64) string {
	if _, ok := UpstreamLoginVendorOfMethod(method); !ok {
		return ""
	}
	return "ooapi-" + method + "-channel-" + strconv.FormatInt(id, 10)
}

// IsLoginCredentialMarker 判断一个 api_key 是否是订阅渠道的内部标识。
func IsLoginCredentialMarker(key string) bool {
	for _, method := range UpstreamLoginMethods() {
		if strings.HasPrefix(strings.TrimSpace(key), "ooapi-"+method+"-channel-") {
			return true
		}
	}
	return false
}

/* ---------- 凭据导入（粘贴官方 CLI / CPA / sub2api 导出的凭据） ---------- */

/*
与「交互式登录」并列的另一条入口：用户手里已经有别的工具导出的凭据文件
（官方 CLI 的 auth.json / .credentials.json、CPA auth 文件、sub2api 导出），
直接粘进来就能建账号，不必重新走一遍登录。

各家的字段命名不统一（官方 CLI 用 camelCase，其余用 snake_case），
所以每个厂商一份解析、按别名逐个尝试。原则与设备授权一致：
**缺 refresh_token 一律拒绝** —— 没有它账号一小时后必然失效，
收下来只会让管理员以为配好了。
*/

// maxImportedCredentialBytes 限制粘贴内容的大小（凭据文件只有几 KB）。
const maxImportedCredentialBytes = 64 << 10

// ImportLoginCredential 解析粘贴的凭据并加密，返回可交给创建流程的结果。
func ImportLoginCredential(vendor string, raw string) (UpstreamLoginCredential, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return UpstreamLoginCredential{}, errors.New("请粘贴凭据文件的内容")
	}
	if len(trimmed) > maxImportedCredentialBytes {
		return UpstreamLoginCredential{}, errors.New("凭据内容过大，请确认粘贴的是凭据文件本身")
	}
	// 先剥掉外层可能包着的代码块围栏（用户从聊天窗口复制时常见）。
	trimmed = stripCodeFence(trimmed)
	var root map[string]any
	if json.Unmarshal([]byte(trimmed), &root) != nil {
		return UpstreamLoginCredential{}, errors.New("凭据不是合法 JSON，请粘贴凭据文件的完整内容")
	}

	var credential any
	var label string
	var err error
	switch vendor {
	case LoginVendorCodex:
		credential, label, err = parseCodexCredential(root)
	case LoginVendorClaudeOAuth:
		credential, label, err = parseClaudeOAuthCredential(root)
	case LoginVendorAntigravity:
		credential, label, err = parseAntigravityCredential(root)
	default:
		return UpstreamLoginCredential{}, errors.New("该接入方式不支持粘贴凭据导入")
	}
	if err != nil {
		return UpstreamLoginCredential{}, err
	}
	encrypted, err := encryptJSON(credential)
	if err != nil {
		return UpstreamLoginCredential{}, errors.New("凭据加密失败")
	}
	expiresAt := int64(0)
	if m, ok := credential.(map[string]any); ok {
		expiresAt = jwInt64(m["expires_at"])
	}
	return UpstreamLoginCredential{Vendor: vendor, Encrypted: encrypted, AccountLabel: label, ExpiresAt: expiresAt}, nil
}

// stripCodeFence 去掉 ```json ... ``` 这类围栏。
func stripCodeFence(s string) string {
	if !strings.HasPrefix(s, "```") {
		return s
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.LastIndex(s, "```"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// credentialNode 按各家的常见包装层逐层尝试（token / tokens / credentials / oauth 等）。
func credentialNode(root, nested map[string]any, nestedKey string) map[string]any {
	if nestedKey != "" {
		if child, ok := root[nestedKey].(map[string]any); ok {
			return child
		}
	}
	for _, key := range []string{"token", "tokens", "credentials", "oauth", "token_data"} {
		if child, ok := root[key].(map[string]any); ok {
			return child
		}
	}
	if nested != nil {
		return nested
	}
	return root
}

// firstString 返回第一个非空字符串（按优先级尝试多个字段名）。
func firstString(sources []map[string]any, keys ...string) string {
	for _, source := range sources {
		if source == nil {
			continue
		}
		for _, key := range keys {
			if v, ok := source[key].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	return ""
}

// toEpochSeconds 把各种时间写法归一到秒级时间戳。
//
// 支持：unix 秒、unix 毫秒（>1e12 视为毫秒）、RFC3339 字符串。
// 认不出来返回 0 —— 调用方据此触发一次刷新（刷新后会写入真实过期时间）。
func toEpochSeconds(v any) int64 {
	switch n := v.(type) {
	case float64:
		return normalizeEpoch(int64(n))
	case int64:
		return normalizeEpoch(n)
	case json.Number:
		if parsed, err := n.Int64(); err == nil {
			return normalizeEpoch(parsed)
		}
	case string:
		text := strings.TrimSpace(n)
		if text == "" {
			return 0
		}
		if parsed, err := strconv.ParseInt(text, 10, 64); err == nil {
			return normalizeEpoch(parsed)
		}
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, text); err == nil {
				return parsed.Unix()
			}
		}
	}
	return 0
}

func normalizeEpoch(v int64) int64 {
	if v <= 0 {
		return 0
	}
	if v > 1e12 {
		return v / 1000
	}
	return v
}

// parseCodexCredential 解析 Codex 凭据（官方 auth.json / CPA / 裸对象）。
func parseCodexCredential(root map[string]any) (map[string]any, string, error) {
	node := credentialNode(root, nil, "")
	sources := []map[string]any{node, root}
	access := firstString(sources, "access_token", "accessToken")
	refresh := firstString(sources, "refresh_token", "refreshToken")
	if access == "" {
		return nil, "", errors.New("凭据里缺少 access_token")
	}
	if refresh == "" {
		return nil, "", errors.New("凭据里缺少 refresh_token（订阅渠道必须能自动续期，请用能导出 refresh_token 的文件）")
	}
	idToken := firstString(sources, "id_token", "idToken")
	accountID := firstString(sources, "account_id", "chatgpt_account_id")
	email := firstString(sources, "email")
	planType := firstString(sources, "plan_type")
	expiresAt := toEpochSeconds(firstValue(sources, "expires_at", "expiresAt", "expiry", "expiry_date"))
	if accountID == "" || email == "" {
		if jwt := jwtPayloadOrNil(idToken); jwt != nil {
			authClaims, _ := jwt["https://api.openai.com/auth"].(map[string]any)
			if accountID == "" {
				accountID = firstString([]map[string]any{authClaims, jwt}, "chatgpt_account_id")
			}
			if email == "" {
				email = firstString([]map[string]any{jwt}, "email")
			}
			if planType == "" {
				planType = firstString([]map[string]any{authClaims}, "chatgpt_plan_type")
			}
		}
	}
	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    expiresAt,
	}
	if idToken != "" {
		credential["id_token"] = idToken
	}
	if accountID != "" {
		credential["account_id"] = accountID
	}
	if email != "" {
		credential["email"] = email
	}
	if planType != "" {
		credential["plan_type"] = planType
	}
	if email != "" {
		return credential, email, nil
	}
	return credential, accountID, nil
}

// parseClaudeOAuthCredential 解析 Claude 凭据（官方 .credentials.json 是 camelCase）。
func parseClaudeOAuthCredential(root map[string]any) (map[string]any, string, error) {
	node := credentialNode(root, nil, "claudeAiOauth")
	sources := []map[string]any{node, root}
	access := firstString(sources, "accessToken", "access_token")
	refresh := firstString(sources, "refreshToken", "refresh_token")
	if access == "" {
		return nil, "", errors.New("凭据里缺少 access_token")
	}
	if refresh == "" {
		return nil, "", errors.New("凭据里缺少 refresh_token（订阅渠道必须能自动续期，请用能导出 refresh_token 的文件）")
	}
	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    toEpochSeconds(firstValue(sources, "expiresAt", "expires_at")),
	}
	email := firstString(sources, "email")
	// 账号与组织 UUID 用于刷新时回填（官方刷新响应会带上）。
	// 官方凭据文件是 camelCase（accountUuid），其余导出多为 snake_case，两种都要认。
	accountUUID := firstString(sources, "account_uuid", "accountUuid")
	orgUUID := firstString(sources, "organization_uuid", "organizationUuid")
	if email != "" {
		credential["email"] = email
	}
	if accountUUID != "" {
		credential["account_uuid"] = accountUUID
	}
	if orgUUID != "" {
		credential["organization_uuid"] = orgUUID
	}
	if scope := firstString(sources, "scope"); scope != "" {
		credential["scope"] = scope
	}
	// 展示名优先邮箱，其次账号 UUID（官方凭据文件里通常只有后者）。
	label := email
	if label == "" {
		label = accountUUID
	}
	return credential, label, nil
}

// parseAntigravityCredential 解析 Google 凭据。
//
// 时间字段的写法各家不同：官方 CLI 用 expiry_date（毫秒），
// 也有用 expired / expiry / expires_at 的 —— 全部交给 toEpochSeconds 归一。
// 认不出来就是 0，会触发首次请求前的刷新（刷新后会写入真实过期时间）。
func parseAntigravityCredential(root map[string]any) (map[string]any, string, error) {
	node := credentialNode(root, nil, "")
	sources := []map[string]any{node, root}
	access := firstString(sources, "access_token", "accessToken")
	refresh := firstString(sources, "refresh_token", "refreshToken")
	if access == "" {
		return nil, "", errors.New("凭据里缺少 access_token")
	}
	if refresh == "" {
		return nil, "", errors.New("凭据里缺少 refresh_token（订阅渠道必须能自动续期，请用能导出 refresh_token 的文件）")
	}
	credential := map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"expires_at":    toEpochSeconds(firstValue(sources, "expired", "expiry_date", "expiry", "expires_at")),
	}
	// 项目号可能在顶层、也可能在 cloudaicompanionProject；
	// 缺了不影响导入 —— 首次请求时由引导流程补上并写回凭据。
	projectSources := append([]map[string]any{root}, sources...)
	if project := firstString(projectSources, "project_id", "projectId", "cloudaicompanionProject"); project != "" {
		credential["project_id"] = project
	}
	if email := firstString(sources, "email"); email != "" {
		credential["email"] = email
	}
	return credential, firstString(sources, "email", "project_id"), nil
}

// firstValue 返回第一个非 nil 的原始值（供时间字段用）。
func firstValue(sources []map[string]any, keys ...string) any {
	for _, source := range sources {
		if source == nil {
			continue
		}
		for _, key := range keys {
			if v, ok := source[key]; ok && v != nil {
				return v
			}
		}
	}
	return nil
}

// jwInt64 把 map 里的数字读成 int64。
func jwInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		if parsed, err := n.Int64(); err == nil {
			return parsed
		}
	}
	return 0
}
