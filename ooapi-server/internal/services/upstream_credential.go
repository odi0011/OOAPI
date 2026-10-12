package services

/*
订阅账号（Codex / Claude / Antigravity）的凭据读写与刷新。

与设备授权渠道共用同一套存储位置：channels.auth_credential（AES-256-GCM 加密）
+ channels.api_key 存内部标识（ooapi-<method>-channel-<id>）。
传输层按标识取出凭据、必要时刷新，再把凭据送给上游。

刷新策略与 Kiro / Grok / WorkBuddy 一致，原因也一样：
**本地算出的过期时间不可靠**，是否真的过期以上游 401/403 为准；
本地时间只用来「提前一点刷新」，不用来拒绝请求。
*/

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

// ---------- 凭据结构 ----------

// CodexCredential 是 Codex（ChatGPT 订阅）凭据。
type CodexCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token,omitempty"`
	AccountID    string `json:"account_id,omitempty"`
	Email        string `json:"email,omitempty"`
	PlanType     string `json:"plan_type,omitempty"`
	ExpiresAt    int64  `json:"expires_at"`
}

// ClaudeOAuthCredential 是 Claude 订阅（Claude Code OAuth）凭据。
type ClaudeOAuthCredential struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresAt        int64  `json:"expires_at"`
	Email            string `json:"email,omitempty"`
	AccountUUID      string `json:"account_uuid,omitempty"`
	OrganizationUUID string `json:"organization_uuid,omitempty"`
	Scope            string `json:"scope,omitempty"`
	// ProjectID 预留给未来可能出现的项目级计费，当前未使用。
	ProjectID string `json:"project_id,omitempty"`
}

// AntigravityCredential 是 Google（Antigravity / Gemini CLI）凭据。
type AntigravityCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
	ProjectID    string `json:"project_id,omitempty"`
	Email        string `json:"email,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

// refreshLead 是提前刷新的窗口：过期前 5 分钟就换新令牌，
// 避免「刚好卡在过期那一刻」的请求白跑一次 401。
const refreshLead = 300

/* ---------- 通用：解密 / 加密 / 刷新锁 ---------- */

// decryptJSON 解密并反序列化一个凭据对象。
func decryptJSON(stored, what string, out any) error {
	if !cryptoutil.IsEncrypted(stored) {
		return errors.New(what + "凭据未加密或缺失，请重新授权")
	}
	raw, err := cryptoutil.Decrypt(JWTSecret(), stored)
	if err != nil {
		return errors.New(what + "凭据解密失败，请检查服务器加密密钥")
	}
	if json.Unmarshal([]byte(raw), out) != nil {
		return errors.New(what + "凭据格式损坏，请重新授权")
	}
	return nil
}

func encryptJSON(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return cryptoutil.Encrypt(JWTSecret(), string(raw))
}

/*
每个渠道一把刷新锁。

并发请求遇到同一个过期账号时，如果各自去刷新，会同时打上游若干次，
而且后到的响应可能覆盖先到的（refresh_token 轮换的厂商会直接失效）。
锁住之后只有第一个真正刷新，其余等锁释放后重新读库拿新令牌。
*/
var (
	codexRefreshLocks       = [64]sync.Mutex{}
	claudeOAuthRefreshLocks = [64]sync.Mutex{}
	antigravityRefreshLocks = [64]sync.Mutex{}
)

func codexRefreshLock(id int64) *sync.Mutex       { return &codexRefreshLocks[uint64(id)%64] }
func claudeRefreshLock(id int64) *sync.Mutex      { return &claudeOAuthRefreshLocks[uint64(id)%64] }
func antigravityRefreshLock(id int64) *sync.Mutex { return &antigravityRefreshLocks[uint64(id)%64] }

// channelCredentialRow 读取渠道的厂商/方式/地址/密文与版本号。
type channelCredentialRow struct {
	Vendor  string
	Method  string
	BaseURL string
	Stored  string
	Version int64
}

func readChannelCredentialRow(ctx context.Context, id int64) (channelCredentialRow, error) {
	var row channelCredentialRow
	err := db.DB.QueryRowContext(ctx,
		"SELECT vendor, method, base_url, COALESCE(auth_credential, ''), auth_version FROM channels WHERE id = ?", id,
	).Scan(&row.Vendor, &row.Method, &row.BaseURL, &row.Stored, &row.Version)
	if err != nil {
		return row, errors.New("读取账号凭据失败")
	}
	return row, nil
}

// persistCredential 写回刷新后的凭据（乐观并发：版本号变了就放弃写入）。
//
// 与 Kiro 的做法一致：版本号用于判断「期间有没有别人改过凭据」。
// 放弃写入是安全的 —— 另一路已经写入了更新鲜的令牌。
func persistCredential(ctx context.Context, id int64, version int64, method string, v any) error {
	encrypted, err := encryptJSON(v)
	if err != nil {
		return err
	}
	result, err := db.DB.ExecContext(ctx,
		"UPDATE channels SET auth_credential = ?, auth_version = auth_version + 1 WHERE id = ? AND method = ? AND auth_version = ?",
		encrypted, id, method, version)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return errors.New("凭据已被其它请求更新，放弃本次写入")
	}
	return nil
}

/* ---------- Codex ---------- */

// ResolveCodexCredential 读取（必要时刷新）Codex 凭据。
func ResolveCodexCredential(ctx context.Context, id int64) (CodexCredential, error) {
	return resolveCodexCredential(ctx, id, false)
}

// ForceRefreshCodexCredential 强制刷新（上游 401 重试路径用）。
func ForceRefreshCodexCredential(ctx context.Context, id int64) (CodexCredential, error) {
	return resolveCodexCredential(ctx, id, true)
}

func resolveCodexCredential(ctx context.Context, id int64, force bool) (CodexCredential, error) {
	if id <= 0 {
		return CodexCredential{}, errors.New("Codex 账号 ID 不正确")
	}
	mu := codexRefreshLock(id)
	mu.Lock()
	defer mu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		row, err := readChannelCredentialRow(ctx, id)
		if err != nil {
			return CodexCredential{}, err
		}
		if row.Vendor != "openai" || row.Method != LoginVendorCodex {
			return CodexCredential{}, errors.New("该账号不是 Codex 订阅渠道")
		}
		var cred CodexCredential
		if err := decryptJSON(row.Stored, "Codex", &cred); err != nil {
			return CodexCredential{}, err
		}
		now := time.Now().Unix()
		if !force && cred.AccessToken != "" && cred.ExpiresAt-refreshLead > now {
			return cred, nil
		}
		fresh, err := refreshCodexCredential(ctx, cred)
		if err != nil {
			// 刷新失败不阻断：手里还有令牌就让上游自己判断是否过期。
			if !force && cred.AccessToken != "" && cred.ExpiresAt > now {
				return cred, nil
			}
			return CodexCredential{}, err
		}
		if err := persistCredential(ctx, id, row.Version, LoginVendorCodex, fresh); err != nil {
			// 别人抢先写入了：重读一次用最新的。
			if attempt < 2 {
				continue
			}
		}
		return fresh, nil
	}
	return CodexCredential{}, errors.New("刷新 Codex 凭据失败，请重试")
}

// refreshCodexCredential 用 refresh_token 换新的 access_token。
func refreshCodexCredential(ctx context.Context, cred CodexCredential) (CodexCredential, error) {
	if strings.TrimSpace(cred.RefreshToken) == "" {
		return cred, errors.New("缺少 refresh_token，请重新一键登录 Codex")
	}
	parsed, status, raw, err := tokenHTTP(ctx, codexTokenURL, "form", map[string]string{
		"client_id":     codexClientID,
		"grant_type":    "refresh_token",
		"refresh_token": cred.RefreshToken,
		"scope":         "openid profile email",
	})
	if err != nil {
		return cred, err
	}
	if parsed == nil {
		return cred, errors.New("刷新 Codex 登录态失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	if access == "" {
		return cred, errors.New("刷新响应里没有 access_token，请重新一键登录 Codex")
	}
	fresh := cred
	fresh.AccessToken = access
	if refresh := stringOf(parsed, "refresh_token"); refresh != "" {
		fresh.RefreshToken = refresh
	}
	fresh.ExpiresAt = time.Now().Unix() + numberOr(parsed["expires_in"], 3600)
	if idToken := stringOf(parsed, "id_token"); idToken != "" {
		fresh.IDToken = idToken
		if jwt := jwtPayloadOrNil(idToken); jwt != nil {
			authClaims, _ := jwt["https://api.openai.com/auth"].(map[string]any)
			if accountID := stringOf(authClaims, "chatgpt_account_id"); accountID != "" {
				fresh.AccountID = accountID
			}
			if email := stringOf(jwt, "email"); email != "" {
				fresh.Email = email
			}
			if plan := stringOf(authClaims, "chatgpt_plan_type"); plan != "" {
				fresh.PlanType = plan
			}
		}
	}
	return fresh, nil
}

/* ---------- Claude 订阅 ---------- */

// ResolveClaudeOAuthCredential 读取（必要时刷新）Claude 订阅凭据。
func ResolveClaudeOAuthCredential(ctx context.Context, id int64) (ClaudeOAuthCredential, error) {
	return resolveClaudeOAuthCredential(ctx, id, false)
}

// ForceRefreshClaudeOAuthCredential 强制刷新（上游 401 重试路径用）。
func ForceRefreshClaudeOAuthCredential(ctx context.Context, id int64) (ClaudeOAuthCredential, error) {
	return resolveClaudeOAuthCredential(ctx, id, true)
}

func resolveClaudeOAuthCredential(ctx context.Context, id int64, force bool) (ClaudeOAuthCredential, error) {
	if id <= 0 {
		return ClaudeOAuthCredential{}, errors.New("Claude 账号 ID 不正确")
	}
	mu := claudeRefreshLock(id)
	mu.Lock()
	defer mu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		row, err := readChannelCredentialRow(ctx, id)
		if err != nil {
			return ClaudeOAuthCredential{}, err
		}
		if row.Vendor != "anthropic" || row.Method != LoginVendorClaudeOAuth {
			return ClaudeOAuthCredential{}, errors.New("该账号不是 Claude 订阅渠道")
		}
		var cred ClaudeOAuthCredential
		if err := decryptJSON(row.Stored, "Claude", &cred); err != nil {
			return ClaudeOAuthCredential{}, err
		}
		now := time.Now().Unix()
		if !force && cred.AccessToken != "" && cred.ExpiresAt-refreshLead > now {
			return cred, nil
		}
		fresh, err := refreshClaudeOAuthCredential(ctx, cred)
		if err != nil {
			if !force && cred.AccessToken != "" && cred.ExpiresAt > now {
				return cred, nil
			}
			return ClaudeOAuthCredential{}, err
		}
		if err := persistCredential(ctx, id, row.Version, LoginVendorClaudeOAuth, fresh); err != nil {
			if attempt < 2 {
				continue
			}
		}
		return fresh, nil
	}
	return ClaudeOAuthCredential{}, errors.New("刷新 Claude 凭据失败，请重试")
}

// refreshClaudeOAuthCredential 刷新 Claude 订阅令牌（JSON 请求体）。
func refreshClaudeOAuthCredential(ctx context.Context, cred ClaudeOAuthCredential) (ClaudeOAuthCredential, error) {
	if strings.TrimSpace(cred.RefreshToken) == "" {
		return cred, errors.New("缺少 refresh_token，请重新一键登录 Claude")
	}
	parsed, status, raw, err := tokenHTTP(ctx, claudeOAuthTokenURL, "json", map[string]string{
		"client_id":     claudeOAuthClientID,
		"grant_type":    "refresh_token",
		"refresh_token": cred.RefreshToken,
		"scope":         claudeOAuthScope,
	})
	if err != nil {
		return cred, err
	}
	if parsed == nil {
		return cred, errors.New("刷新 Claude 登录态失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	if access == "" {
		return cred, errors.New("刷新响应里没有 access_token，请重新一键登录 Claude")
	}
	fresh := cred
	fresh.AccessToken = access
	if refresh := stringOf(parsed, "refresh_token"); refresh != "" {
		fresh.RefreshToken = refresh
	}
	fresh.ExpiresAt = time.Now().Unix() + numberOr(parsed["expires_in"], 3600)
	if account, ok := parsed["account"].(map[string]any); ok {
		if uuid := stringOf(account, "uuid"); uuid != "" {
			fresh.AccountUUID = uuid
		}
		if email := stringOf(account, "email_address"); email != "" {
			fresh.Email = email
		}
	}
	if org, ok := parsed["organization"].(map[string]any); ok {
		if uuid := stringOf(org, "uuid"); uuid != "" {
			fresh.OrganizationUUID = uuid
		}
	}
	return fresh, nil
}

/* ---------- Google / Antigravity ---------- */

// ResolveAntigravityCredential 读取（必要时刷新）Google 订阅凭据。
func ResolveAntigravityCredential(ctx context.Context, id int64) (AntigravityCredential, error) {
	return resolveAntigravityCredential(ctx, id, false)
}

// ForceRefreshAntigravityCredential 强制刷新（上游 401 重试路径用）。
func ForceRefreshAntigravityCredential(ctx context.Context, id int64) (AntigravityCredential, error) {
	return resolveAntigravityCredential(ctx, id, true)
}

func resolveAntigravityCredential(ctx context.Context, id int64, force bool) (AntigravityCredential, error) {
	if id <= 0 {
		return AntigravityCredential{}, errors.New("Google 账号 ID 不正确")
	}
	mu := antigravityRefreshLock(id)
	mu.Lock()
	defer mu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		row, err := readChannelCredentialRow(ctx, id)
		if err != nil {
			return AntigravityCredential{}, err
		}
		if row.Vendor != "gemini" || row.Method != LoginVendorAntigravity {
			return AntigravityCredential{}, errors.New("该账号不是 Google 订阅渠道")
		}
		var cred AntigravityCredential
		if err := decryptJSON(row.Stored, "Google", &cred); err != nil {
			return AntigravityCredential{}, err
		}
		now := time.Now().Unix()
		if !force && cred.AccessToken != "" && cred.ExpiresAt-refreshLead > now {
			return cred, nil
		}
		fresh, err := refreshAntigravityCredential(ctx, cred)
		if err != nil {
			if !force && cred.AccessToken != "" && cred.ExpiresAt > now {
				return cred, nil
			}
			return AntigravityCredential{}, err
		}
		if err := persistCredential(ctx, id, row.Version, LoginVendorAntigravity, fresh); err != nil {
			if attempt < 2 {
				continue
			}
		}
		return fresh, nil
	}
	return AntigravityCredential{}, errors.New("刷新 Google 凭据失败，请重试")
}

// refreshAntigravityCredential 刷新 Google 令牌。
func refreshAntigravityCredential(ctx context.Context, cred AntigravityCredential) (AntigravityCredential, error) {
	if strings.TrimSpace(cred.RefreshToken) == "" {
		return cred, errors.New("缺少 refresh_token，请重新一键登录 Google 账号")
	}
	// 刷新必须用与登录同一套客户端凭据：否则 refresh_token 会因 client 不匹配被拒。
	// 这也是原版踩过的坑（登录用内置凭据、刷新读环境变量而没兜底 → 必然 401）。
	clientID, clientSecret, _ := googleOAuthCreds()
	parsed, status, raw, err := tokenHTTP(ctx, googleTokenURL, "form", map[string]string{
		"client_id":     clientID,
		"client_secret": clientSecret,
		"grant_type":    "refresh_token",
		"refresh_token": cred.RefreshToken,
	})
	if err != nil {
		return cred, err
	}
	if parsed == nil {
		return cred, errors.New("刷新 Google 登录态失败（" + tokenErrorHint(status, raw) + "）")
	}
	access := stringOf(parsed, "access_token")
	if access == "" {
		return cred, errors.New("刷新响应里没有 access_token，请重新一键登录 Google 账号")
	}
	fresh := cred
	fresh.AccessToken = access
	if refresh := stringOf(parsed, "refresh_token"); refresh != "" {
		fresh.RefreshToken = refresh
	}
	fresh.ExpiresAt = time.Now().Unix() + numberOr(parsed["expires_in"], 3600)
	return fresh, nil
}

/* ---------- Antigravity 项目引导 ---------- */

// Antigravity 的私有接口要求带上 Google Cloud 项目号（cloudaicompanionProject）。
// 没有存过就现拉一次：loadCodeAssist 查已有项目，查不到就 onboardUser 开通。
// 结果写回凭据，避免每次请求都多一轮往返。
const (
	antigravityLoadCodeAssistURL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
	antigravityOnboardUserURL    = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser"
	// antigravityClientVersion 与官方客户端一致；写错的后果是上游按未知客户端拒绝。
	antigravityClientVersion = "2.9.1"
)

// EnsureAntigravityProject 返回该账号的项目号，必要时引导一次并写回凭据。
func EnsureAntigravityProject(ctx context.Context, id int64, cred AntigravityCredential) (string, error) {
	if strings.TrimSpace(cred.ProjectID) != "" {
		return cred.ProjectID, nil
	}
	project, err := antigravityBootstrapProject(ctx, cred.AccessToken)
	if err != nil {
		return "", err
	}
	// 写回失败不影响本次请求：下次再查一遍即可。
	if row, err := readChannelCredentialRow(ctx, id); err == nil {
		cred.ProjectID = project
		_ = persistCredential(ctx, id, row.Version, LoginVendorAntigravity, cred)
	}
	return project, nil
}

// antigravityBootstrapProject 走官方的「查项目 → 开通项目」引导流程。
func antigravityBootstrapProject(ctx context.Context, accessToken string) (string, error) {
	metadata := map[string]any{
		// 故意用 snake_case：部分账号对 camelCase 会直接拒绝（原版注释如此）。
		"ide_type":    "ANTIGRAVITY",
		"ide_version": antigravityClientVersion,
		"ide_name":    "antigravity",
	}
	loadBody, _ := json.Marshal(map[string]any{"metadata": metadata})
	loaded, err := antigravityPostJSON(ctx, antigravityLoadCodeAssistURL, accessToken, loadBody, false)
	if err == nil {
		if project := antigravityProjectOf(loaded); project != "" {
			return project, nil
		}
	}

	tier := antigravityTierOf(loaded)
	if tier == "" {
		tier = "free-tier"
	}
	onboardBody, _ := json.Marshal(map[string]any{"tier_id": tier, "metadata": metadata})
	// 开通是异步的：上游先返回「处理中」，需要隔几秒再问一次。
	for attempt := 0; attempt < 5; attempt++ {
		onboarded, err := antigravityPostJSON(ctx, antigravityOnboardUserURL, accessToken, onboardBody, true)
		if err == nil {
			if project := antigravityProjectOf(onboarded); project != "" {
				return project, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return "", errors.New("未能获取 Google 项目号（账号可能未开通 Antigravity 权限）")
}

// antigravityPostJSON 发一次带 Bearer 的 JSON POST。
func antigravityPostJSON(ctx context.Context, endpoint, accessToken string, body []byte, withNodeClient bool) (map[string]any, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, errors.New("构造请求失败")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("User-Agent", antigravityUserAgent(withNodeClient))
	resp, err := loginClient().Do(req)
	if err != nil {
		return nil, errors.New("无法连接 Google 上游：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := readAllLimited(resp.Body, 4<<20)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New("Google 引导接口返回 " + resp.Status)
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errors.New("Google 引导响应不是合法 JSON")
	}
	return parsed, nil
}

// antigravityUserAgent 是官方客户端的 UA 形状。
// onboardUser 走 node 客户端（带 google-api-nodejs-client 后缀），其余不带 ——
// 与官方客户端的实际行为一致。
func antigravityUserAgent(withNodeClient bool) string {
	ua := "antigravity/hub/" + antigravityClientVersion + " darwin/arm64"
	if withNodeClient {
		ua += " google-api-nodejs-client/10.3.0"
	}
	return ua
}

// antigravityProjectOf 从引导响应里挖出项目号。
//
// 上游在不同版本里把它放在不同层级，值本身还可能是个对象 —— 都要能认，
// 否则表现是「登录成功但所有请求 4xx」。
func antigravityProjectOf(parsed map[string]any) string {
	if parsed == nil {
		return ""
	}
	candidates := []any{parsed["cloudaicompanionProject"], parsed["projectId"], parsed["project"]}
	if response, ok := parsed["response"].(map[string]any); ok {
		candidates = append([]any{response["cloudaicompanionProject"]}, candidates...)
	}
	for _, candidate := range candidates {
		switch v := candidate.(type) {
		case string:
			if trimmed := strings.TrimSpace(v); trimmed != "" {
				return trimmed
			}
		case map[string]any:
			for _, key := range []string{"id", "projectId", "project"} {
				if s := stringOf(v, key); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

// antigravityTierOf 从 loadCodeAssist 响应里挑出开通用的档位。
func antigravityTierOf(parsed map[string]any) string {
	if parsed == nil {
		return ""
	}
	if tiers, ok := parsed["allowedTiers"].([]any); ok {
		for _, entry := range tiers {
			tier, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if isDefault, _ := tier["isDefault"].(bool); isDefault {
				if id := stringOf(tier, "id"); id != "" {
					return id
				}
			}
		}
	}
	if current, ok := parsed["currentTier"].(map[string]any); ok {
		if id := stringOf(current, "id"); id != "" {
			return id
		}
	}
	return ""
}

// readAllLimited 读满上限即停（防止上游异常响应把内存撑爆）。
func readAllLimited(r io.Reader, limit int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r, limit))
}

/*
AntigravityProjectFor 供传输层调用：返回项目号（必要时引导并写回）。

用函数变量而不是直接调用 EnsureAntigravityProject，是为了让传输层的测试
能在不联网的前提下替换掉这一步 —— 否则每个传输测试都要搭一台假 Google。
*/
var AntigravityProjectFor = EnsureAntigravityProject

/* ---------- 订阅凭据的解密（供未落库的登录流程使用） ---------- */

// DecryptCodexCredential 解密一份 Codex 凭据密文。
func DecryptCodexCredential(stored string) (CodexCredential, error) {
	var cred CodexCredential
	if err := decryptJSON(stored, "Codex", &cred); err != nil {
		return cred, err
	}
	return cred, nil
}

// DecryptClaudeOAuthCredential 解密一份 Claude 订阅凭据密文。
func DecryptClaudeOAuthCredential(stored string) (ClaudeOAuthCredential, error) {
	var cred ClaudeOAuthCredential
	if err := decryptJSON(stored, "Claude", &cred); err != nil {
		return cred, err
	}
	return cred, nil
}

// DecryptAntigravityCredential 解密一份 Google 凭据密文。
func DecryptAntigravityCredential(stored string) (AntigravityCredential, error) {
	var cred AntigravityCredential
	if err := decryptJSON(stored, "Google", &cred); err != nil {
		return cred, err
	}
	return cred, nil
}
