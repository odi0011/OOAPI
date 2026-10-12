package services

// Grok（xAI）订阅账号的设备码授权与凭据管理。
//
// 设备流走 xAI 官方 OAuth 2.0 device-code（RFC 8628）：
//
//	POST https://auth.x.ai/oauth2/device/code → {device_code, user_code, verification_uri*, interval, expires_in}
//	POST https://auth.x.ai/oauth2/token       → grant_type=urn:ietf:params:oauth:grant-type:device_code
//
// 刷新同样是 token 端点（grant_type=refresh_token，与原始实现一致：不带 scope）。
// 凭据加密落库（auth_credential），与 Cline / Kiro / WorkBuddy 共用同一条 secretbox 路径。
//
// 过期策略（与 WorkBuddy 的线上教训一致）：
//   - access_token 是 JWT 时以 `exp` claim 为权威过期时间；畸形/不合理时回退 expires_in。
//   - 本地估算只用于决定「是否值得提前续期」，绝不作为拦截请求的依据：
//     估算可能不准（凭据被提前判成过期），请求是否过期以上游 401/403 为准，
//     由传输层给出「重新一键登录」提示。
//
// 与原始实现（src/services/upstream/oauth-login.js + grok.js）对齐：
//   - client_id b1a00492-073a-47ea-816f-4c329264a828
//   - scope "openid profile email offline_access grok-cli:access api:access"
//   - 401 或 403 都可能是凭据失效；刷新后重试一次，仍失败才提示重新登录。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

const (
	// GrokClientID 是 xAI 官方 Grok CLI 的公开 OAuth 客户端 ID（原始实现同值）。
	GrokClientID = "b1a00492-073a-47ea-816f-4c329264a828"
	// GrokScopes 是 Grok CLI 订阅所需的授权范围（原始实现同值）。
	GrokScopes = "openid profile email offline_access grok-cli:access api:access"

	// GrokCLIBase 是订阅（OAuth）渠道的官方 CLI 代理地址；设备授权渠道固定用它。
	GrokCLIBase = "https://cli-chat-proxy.grok.com/v1"
	// GrokAPIBase 是官方 API Key 地址（api 方式渠道用，设备渠道不涉及）。
	GrokAPIBase = "https://api.x.ai/v1"

	grokDeviceGrant  = "urn:ietf:params:oauth:grant-type:device_code"
	grokRefreshGrant = "refresh_token"

	// grokRefreshLead 是提前续期的裕量（秒）：剩余不足 5 分钟就续期。
	grokRefreshLead = 300
	// grokCredentialTTLCap 收敛设备授权会话存活时间（秒），原始实现同样以 15 分钟为界。
	grokCredentialTTLCap = 900
	// grokMinClientVersion 是 xAI 当前接受的最低 CLI 版本（低于它上游返回 HTTP 426）。
	grokMinClientVersion = "1.0.13"
)

// 授权端点做成包级变量，测试可指向 httptest mock 服务器。
var (
	grokDeviceURL = "https://auth.x.ai/oauth2/device/code"
	grokTokenURL  = "https://auth.x.ai/oauth2/token"
)

var grokAuthClient = &http.Client{
	Timeout:       20 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// GrokCredential 是落库的加密凭据形态。
// 只存令牌与可展示的账号标识；绝不含任何 API Key 字段，也绝不回传给前端。
type GrokCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type,omitempty"`
	Scope        string `json:"scope,omitempty"`
	ExpiresAt    int64  `json:"expires_at"`
	Email        string `json:"email,omitempty"`
	Sub          string `json:"sub,omitempty"`
	Plan         string `json:"plan,omitempty"`
}

// GrokDeviceStart 是一次设备授权会话的服务端上下文（device_code 不落任何响应）。
type GrokDeviceStart struct {
	DeviceCode string
	UserCode   string
	VerifyURL  string
	Interval   int // 秒
	ExpiresIn  int // 秒
}

// GrokChannelBaseURL 返回设备授权渠道固定的官方订阅地址。
func GrokChannelBaseURL() string { return GrokCLIBase }

// IsGrokSubscriptionBase 判断 base_url 是否为官方订阅（CLI 代理）地址。
func IsGrokSubscriptionBase(raw string) bool {
	return strings.TrimRight(strings.TrimSpace(raw), "/") == GrokCLIBase
}

// GrokClientVersion 返回透传给上游的 CLI 版本号。
//
// 原始实现允许渠道用 other.client_version 覆盖；Go 端没有该字段（不新增列），
// 固定使用最低兼容版本：低于它会收到 HTTP 426。
func GrokClientVersion() string { return grokMinClientVersion }

// GrokUserAgent 返回 CLI 通道要求的 UA。
func GrokUserAgent() string { return "xai-grok-workspace/" + grokMinClientVersion }

// GrokSessionID 由渠道 ID 确定性派生会话标识（等价于原始实现的
// seededUuid(profileSeed(channel), "grok-session")，profileSeed = "grok:{id}"）。
// 同一账号每次请求都带同一个值，重启不变；它同时用于 x-grok-conv-id 头与
// 请求体里的 prompt_cache_key。
func GrokSessionID(channelID int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("ooapi-cli-profile|grok-session|grok:%d", channelID)))
	h := hex.EncodeToString(sum[:])[:32]
	// 版本位 4（0100），变体位 8/9/a/b —— 与 seededUuid 的位运算一致。
	variant := (grokHexNibble(h[16]) & 0x3) | 0x8
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-" + fmt.Sprintf("%x", variant) + h[17:20] + "-" + h[20:32]
}

func grokHexNibble(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return 0
}

// grokSnippet 截取上游原文用于错误信息（避免把整段响应写进错误）。
func grokSnippet(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// grokOfficialVerifyURL 校验授权地址必须是 xAI 官方 https 域名。
func grokOfficialVerifyURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "x.ai" || strings.HasSuffix(host, ".x.ai")
}

// grokFormPost 发一次 x-www-form-urlencoded 请求并解析 JSON 响应。
// 返回 (HTTP 状态, JSON 对象, 原文, 错误)；响应不是 JSON 时 JSON 为 nil，原文保留用于报错。
func grokFormPost(ctx context.Context, target string, form url.Values) (int, map[string]any, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, "", errors.New("无法构造 Grok 授权请求")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OOAPI-Gateway/1.0")
	resp, err := grokAuthClient.Do(req)
	if err != nil {
		return 0, nil, "", errors.New("Grok 授权服务连接失败或超时")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return resp.StatusCode, nil, "", errors.New("Grok 授权响应过大或读取失败")
	}
	raw := string(data)
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		out = nil
	}
	return resp.StatusCode, out, raw, nil
}

// grokJWTExpiry 取 access_token 的真实过期时间（JWT `exp`，秒）。
//
// 合理性窗口：已过期超过 5 分钟 / 距今超过 400 天视为不可信，返回 0 由调用方回退。
// 畸形、缺失或非数字的 exp 一律返回 0 —— 本函数不得 panic。
func grokJWTExpiry(token string, now time.Time) int64 {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return 0
	}
	exp, ok := jwtSecondsClaim(payload["exp"])
	if !ok {
		return 0
	}
	if exp <= now.Unix()-300 || exp >= now.Unix()+400*24*60*60 {
		return 0
	}
	return exp
}

// grokClaimString 从 JWT payload 里取第一个非空字符串 claim。
func grokClaimString(payload map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := payload[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// grokCredentialFrom 把 token 端点响应组装成凭据。
// access/refresh 由调用方给出（刷新时新值可能缺失，回退旧值）。
func grokCredentialFrom(accessToken, refreshToken string, j map[string]any) GrokCredential {
	cred := GrokCredential{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		TokenType:    clineString(j, "token_type"),
		Scope:        clineString(j, "scope"),
	}
	now := time.Now()
	// 兜底：上游响应里的 expires_in；没有该字段时才是 3600 秒的保守估计。
	cred.ExpiresAt = now.Unix() + int64(clineSeconds(j, 3600, "expires_in"))
	// 权威来源：access_token 是 JWT 时 `exp` 才是真实过期时间。
	if exp := grokJWTExpiry(accessToken, now); exp > 0 {
		cred.ExpiresAt = exp
	}
	// 账号标识只用于「绑到了哪个账号」的展示；优先 id_token，其次 access_token。
	idPayload, _ := decodeJWTPayload(clineString(j, "id_token"))
	accessPayload, _ := decodeJWTPayload(accessToken)
	pick := func(keys ...string) string {
		if v := grokClaimString(idPayload, keys...); v != "" {
			return v
		}
		return grokClaimString(accessPayload, keys...)
	}
	cred.Email = pick("email")
	cred.Sub = pick("sub")
	// plan 是尽力而为的展示字段：xAI 的 claim 名称可能变化，取不到就留空。
	cred.Plan = pick("plan", "tier", "subscription_tier")
	return cred
}

// GrokStartDevice 发起一次设备授权，返回用户码与授权地址。
func GrokStartDevice(ctx context.Context) (GrokDeviceStart, error) {
	status, j, raw, err := grokFormPost(ctx, grokDeviceURL, url.Values{
		"client_id": {GrokClientID},
		"scope":     {GrokScopes},
	})
	if err != nil {
		return GrokDeviceStart{}, err
	}
	if status < 200 || status >= 300 {
		msg := clineString(j, "error_description", "error", "message")
		if msg == "" {
			msg = grokSnippet(raw)
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status)
		}
		return GrokDeviceStart{}, fmt.Errorf("获取 Grok 设备码失败（HTTP %d）：%s", status, msg)
	}
	deviceCode := clineString(j, "device_code")
	userCode := clineString(j, "user_code")
	if deviceCode == "" || userCode == "" {
		return GrokDeviceStart{}, errors.New("Grok 授权响应缺少设备码")
	}
	// 优先 verification_uri_complete（带上用户码，少一步输入），回退 verification_uri。
	verify := clineString(j, "verification_uri_complete", "verification_uri")
	if !grokOfficialVerifyURL(verify) {
		return GrokDeviceStart{}, errors.New("Grok 授权地址不是官方地址")
	}
	interval := clineSeconds(j, 5, "interval")
	if interval < 3 {
		interval = 3
	}
	ttl := clineSeconds(j, 900, "expires_in")
	if ttl > grokCredentialTTLCap {
		ttl = grokCredentialTTLCap
	}
	return GrokDeviceStart{
		DeviceCode: deviceCode,
		UserCode:   userCode,
		VerifyURL:  verify,
		Interval:   interval,
		ExpiresIn:  ttl,
	}, nil
}

// GrokJudgeToken 把一次 token 端点响应判定成统一状态（纯函数，便于测试）。
//
// RFC 8628 的 pending 不是 HTTP 2xx：authorization_pending / slow_down 都要继续轮询；
// expired_token / access_denied 是终态；其余错误带上游原文报错。
// 与原始实现一致：先按 HTTP 状态判定，只有 2xx 才可能成功；错误码优先取
// JSON 的 error/code 字段，响应不是 JSON 时用原文做关键词判定（原始实现同样如此）。
func GrokJudgeToken(status int, j map[string]any, raw string) (DevicePoll, GrokCredential) {
	out := DevicePoll{Vendor: "grok", Method: "grok"}
	if status >= 200 && status < 300 {
		if access := clineString(j, "access_token"); access != "" {
			out.Status = "success"
			return out, grokCredentialFrom(access, clineString(j, "refresh_token"), j)
		}
	}
	code := clineString(j, "error", "code", "__type")
	if code == "" {
		code = grokSnippet(raw)
	}
	switch {
	case strings.Contains(code, "authorization_pending"):
		out.Status = "pending"
		out.Message = "等待在浏览器中完成授权"
	case strings.Contains(code, "slow_down"):
		out.Status = "pending"
		out.SlowDown = true
		out.Message = "轮询过快，已自动放慢"
	case strings.Contains(code, "expired_token"):
		out.Status = "expired"
		out.Message = "授权码已过期，请重新发起绑定"
	case strings.Contains(code, "access_denied"):
		out.Status = "denied"
		out.Message = "用户在授权页拒绝了本次请求"
	default:
		out.Status = "error"
		msg := clineString(j, "error_description", "message")
		if msg == "" {
			msg = code
		}
		if msg == "" {
			msg = grokSnippet(raw)
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status)
		}
		out.Message = "Grok 授权失败：" + msg
	}
	return out, GrokCredential{}
}

// GrokPollDevice 轮询一次设备授权。
func GrokPollDevice(ctx context.Context, s GrokDeviceStart) (DevicePoll, GrokCredential, error) {
	status, j, raw, err := grokFormPost(ctx, grokTokenURL, url.Values{
		"grant_type":  {grokDeviceGrant},
		"client_id":   {GrokClientID},
		"device_code": {s.DeviceCode},
	})
	if err != nil {
		return DevicePoll{}, GrokCredential{}, err
	}
	out, cred := GrokJudgeToken(status, j, raw)
	return out, cred, nil
}

// EncryptGrokCredential 加密 Grok 凭据。
func EncryptGrokCredential(cred GrokCredential) (string, error) {
	if JWTSecret() == "" {
		return "", errors.New("凭据加密密钥尚未初始化")
	}
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return "", errors.New("Grok 授权未返回可用凭据")
	}
	data, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	return cryptoutil.Encrypt(JWTSecret(), string(data))
}

// DecryptGrokCredential 解密落库凭据，并用 JWT 的 exp 校正当地过期时间。
func DecryptGrokCredential(stored string) (GrokCredential, error) {
	var cred GrokCredential
	if !cryptoutil.IsEncrypted(stored) {
		return cred, errors.New("Grok 凭据未加密或缺失，请重新一键登录")
	}
	raw, err := cryptoutil.Decrypt(JWTSecret(), stored)
	if err != nil {
		return cred, errors.New("Grok 凭据解密失败，请检查服务器加密密钥")
	}
	if json.Unmarshal([]byte(raw), &cred) != nil {
		return cred, errors.New("Grok 凭据格式损坏，请重新一键登录")
	}
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return cred, errors.New("Grok 凭据缺少令牌，请重新一键登录")
	}
	// 旧记录可能带的是历史估算；JWT 的 exp 更权威（与 WorkBuddy 的校正一致）。
	if exp := grokJWTExpiry(cred.AccessToken, time.Now()); exp > 0 {
		cred.ExpiresAt = exp
	}
	return cred, nil
}

// refreshGrokCredential 走 token 端点续期（grant_type=refresh_token，不带 scope）。
func refreshGrokCredential(ctx context.Context, cred GrokCredential) (GrokCredential, error) {
	if strings.TrimSpace(cred.RefreshToken) == "" {
		return cred, errors.New("Grok 登录已过期，请重新一键登录")
	}
	status, j, raw, err := grokFormPost(ctx, grokTokenURL, url.Values{
		"grant_type":    {grokRefreshGrant},
		"client_id":     {GrokClientID},
		"refresh_token": {cred.RefreshToken},
	})
	if err != nil {
		return cred, err
	}
	if status < 200 || status >= 300 {
		msg := clineString(j, "error_description", "error", "message")
		if msg == "" {
			msg = grokSnippet(raw)
		}
		return cred, fmt.Errorf("Grok 登录态续期失败（HTTP %d）：%s", status, msg)
	}
	access := clineString(j, "access_token")
	if access == "" {
		return cred, errors.New("Grok 刷新响应缺少 access_token")
	}
	refresh := clineString(j, "refresh_token")
	if refresh == "" {
		refresh = cred.RefreshToken
	}
	fresh := grokCredentialFrom(access, refresh, j)
	// 新响应里没有的身份信息沿用旧值，账号标签不因刷新而丢失。
	if fresh.Email == "" {
		fresh.Email = cred.Email
	}
	if fresh.Sub == "" {
		fresh.Sub = cred.Sub
	}
	if fresh.Plan == "" {
		fresh.Plan = cred.Plan
	}
	if fresh.TokenType == "" {
		fresh.TokenType = cred.TokenType
	}
	if fresh.Scope == "" {
		fresh.Scope = cred.Scope
	}
	return fresh, nil
}

// 固定条带锁限制内存占用；auth_version CAS 防止在途刷新覆盖管理员重绑。
var grokRefreshLocks [64]sync.Mutex

// ResolveGrokCredential 解析渠道凭据，必要时提前续期（单飞）。
func ResolveGrokCredential(ctx context.Context, id int64) (GrokCredential, error) {
	return resolveGrokCredential(ctx, id, false)
}

// ForceRefreshGrokCredential 强制续期（上游 401/403 重试路径用）。
func ForceRefreshGrokCredential(ctx context.Context, id int64) (GrokCredential, error) {
	return resolveGrokCredential(ctx, id, true)
}

// resolveGrokCredential 读取并（必要时）刷新凭据。
//
// 关键策略：刷新失败不阻断请求 —— 只要手里还有 access_token 就原样返回，
// 让上游 401/403 决定是否真的过期（本地 expires_at 可能只是错误的估算，
// 与 WorkBuddy 线上问题同源）。只有确实无令牌可用时才报错。
func resolveGrokCredential(ctx context.Context, id int64, force bool) (GrokCredential, error) {
	if id <= 0 {
		return GrokCredential{}, errors.New("Grok 账号 ID 不正确")
	}
	mu := &grokRefreshLocks[uint64(id)%uint64(len(grokRefreshLocks))]
	mu.Lock()
	defer mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		var vendor, method, base, stored string
		var version int64
		err := db.DB.QueryRowContext(ctx, "SELECT vendor, method, base_url, COALESCE(auth_credential, ''), auth_version FROM channels WHERE id = ?", id).Scan(&vendor, &method, &base, &stored, &version)
		if err != nil {
			return GrokCredential{}, errors.New("读取 Grok 账号凭据失败")
		}
		if vendor != "grok" || method != "grok" {
			return GrokCredential{}, errors.New("该账号不是 Grok 设备授权渠道")
		}
		cred, err := DecryptGrokCredential(stored)
		if err != nil {
			return GrokCredential{}, err
		}
		// 凭据只能发往官方订阅地址：地址漂移（脏数据/人为改库）一律拒绝。
		if !IsGrokSubscriptionBase(base) {
			return GrokCredential{}, errors.New("该账号的 Grok 接口地址不是官方订阅地址，拒绝发送凭据")
		}
		now := time.Now().Unix()
		if !force && cred.AccessToken != "" && cred.ExpiresAt-grokRefreshLead > now {
			return cred, nil
		}
		fresh, err := refreshGrokCredential(ctx, cred)
		if err != nil {
			// 本地估算不作为拦截依据：有令牌就继续用，由上游决定是否失效。
			if !force && cred.AccessToken != "" {
				return cred, nil
			}
			return cred, err
		}
		encrypted, err := EncryptGrokCredential(fresh)
		if err != nil {
			return GrokCredential{}, err
		}
		result, err := db.DB.ExecContext(ctx, `UPDATE channels SET auth_credential = ?, auth_expires_at = ?, auth_version = auth_version + 1 WHERE id = ? AND vendor = 'grok' AND method = 'grok' AND auth_version = ?`, encrypted, fresh.ExpiresAt, id, version)
		if err != nil {
			return GrokCredential{}, errors.New("Grok 续期凭据保存失败")
		}
		count, err := result.RowsAffected()
		if err != nil {
			return GrokCredential{}, err
		}
		if count == 1 {
			return fresh, nil
		}
		// CAS 失败：期间管理员换过凭据，重读一次再决定。
	}
	return GrokCredential{}, errors.New("Grok 凭据正在更新，请重试")
}

// grokAccountLabel 拼出可展示的账号标识：「Grok 订阅」加上 JWT 派生的
// 邮箱 / 套餐名。这些是展示信息而不是令牌，用于告诉管理员绑到了哪个账号。
func grokAccountLabel(cred GrokCredential) string {
	label := "Grok 订阅"
	if cred.Email != "" {
		label += " · " + cred.Email
	}
	if cred.Plan != "" {
		label += " · " + cred.Plan
	}
	return label
}
