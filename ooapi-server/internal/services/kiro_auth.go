package services

// Kiro（AWS CodeWhisperer / Amazon Q Developer 桌面工具）的设备授权与凭据管理。
//
// 设备流走 AWS SSO OIDC 官方 API：
//
//	POST https://oidc.{region}.amazonaws.com/client/register      （字段 camelCase）
//	POST https://oidc.{region}.amazonaws.com/device_authorization （startUrl 与 region 不匹配时 400）
//	POST https://oidc.{region}.amazonaws.com/token                 （grantType 是长 URN）
//
// 刷新同样是 OIDC token 端点，grantType=refresh_token。
// 凭据加密落库（auth_credential），与 Cline 共用 secretbox 路径。
//
// 安全约束：
//   - region 会拼进主机名（oidc.{region}.amazonaws.com / codewhisperer.{region}.amazonaws.com），
//     来源包括请求参数与历史库值，读取路径也必须过白名单，否则脏 region 会把
//     Bearer 令牌打到攻击者/内网主机（SSRF + 令牌外泄）。
//   - 仅允许 https 且域名后缀为 .amazonaws.com 的授权/接口地址。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

const (
	kiroDefaultRegion   = "us-east-1"
	KiroDefaultStartURL = "https://view.awsapps.com/start"
	kiroClientName      = "OOAPI Gateway"
	kiroDeviceGrant     = "urn:ietf:params:oauth:grant-type:device_code"
	kiroRefreshGrant    = "refresh_token"
	// kiroRefreshLead 是提前刷新的裕量（秒）：剩余不足 5 分钟就续期。
	kiroRefreshLead = 300
	// kiroCredentialTTLCap 收敛会话存活时间（秒），上游一般给 600。
	kiroCredentialTTLCap = 900
)

var kiroScopes = []string{
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
	"codewhisperer:transformations",
	"codewhisperer:taskassist",
}

// KiroRegionCandidates 是用户未指定（或指定无效）时按顺序尝试的 region。
// 每个 region 的 clientId 独立，必须各自注册一次。
var KiroRegionCandidates = []string{"us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1", "ap-southeast-1"}

// 授权端点可在测试中指向 httptest mock 服务器。
var (
	kiroOIDCRegisterURL = func(region string) string { return "https://oidc." + region + ".amazonaws.com/client/register" }
	kiroOIDCDeviceURL   = func(region string) string {
		return "https://oidc." + region + ".amazonaws.com/device_authorization"
	}
	kiroOIDCTokenURL = func(region string) string { return "https://oidc." + region + ".amazonaws.com/token" }
)

var kiroAuthClient = &http.Client{
	Timeout:       20 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

var kiroRegionPattern = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)

// KiroCredential 是落库的加密凭据形态（与设备绑定/刷新链路字段对齐）。
// 同样是 OAuth 凭据：绝不占用 api_key 列，也绝不回传给前端。
type KiroCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Region       string `json:"region"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	ExpiresAt    int64  `json:"expires_at"`
}

// KiroDeviceStart 是一次设备授权会话的服务端上下文。
type KiroDeviceStart struct {
	Region       string
	StartURL     string
	ClientID     string
	ClientSecret string
	DeviceCode   string
	UserCode     string
	VerifyURL    string
	Interval     int // 秒
	ExpiresIn    int // 秒
}

// KiroSafeRegion 校验并归一化 region；非法/为空时回落到默认 region。
func KiroSafeRegion(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if kiroRegionPattern.MatchString(s) {
		return s
	}
	return kiroDefaultRegion
}

// KiroAPIBaseURL 返回官方推理端点（codewhisperer）。
func KiroAPIBaseURL(region string) string {
	return "https://codewhisperer." + KiroSafeRegion(region) + ".amazonaws.com"
}

// IsKiroBaseURL 判断一个 base_url 是否是我们允许写入/请求的 Kiro 官方地址。
func IsKiroBaseURL(raw string) bool {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	region := KiroRegionFromHost(u.Hostname())
	return region != "" && u.Host == "codewhisperer."+region+".amazonaws.com"
}

// KiroRegionFromHost 从 codewhisperer.{region}.amazonaws.com 解出合法 region；不匹配返回空串。
func KiroRegionFromHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if !strings.HasSuffix(host, ".amazonaws.com") || !strings.HasPrefix(host, "codewhisperer.") {
		return ""
	}
	region := strings.TrimSuffix(strings.TrimPrefix(host, "codewhisperer."), ".amazonaws.com")
	if !kiroRegionPattern.MatchString(region) {
		return ""
	}
	return region
}

// KiroModelID 把平台模型名映射成 Kiro 接受的 modelId。
func KiroModelID(model string) string {
	switch strings.TrimSpace(model) {
	case "claude-opus-5":
		return "claude-opus-4.5"
	case "claude-sonnet-5":
		return "claude-sonnet-4.5"
	case "claude-haiku-4.5":
		return "claude-haiku-4.5"
	}
	if m := strings.TrimSpace(model); m != "" {
		return m
	}
	return "claude-sonnet-4.5"
}

// KiroDeviceFingerprint 是 Kiro 客户端 UA 里稳定可复现的设备指纹。
func KiroDeviceFingerprint(channelID int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("ooapi-%d", channelID)))
	return hex.EncodeToString(sum[:])[:40]
}

// kiroOrderedRegions 生成「提示优先 + 候选补齐」的 region 尝试顺序；脏提示直接丢弃
// （不能带着未校验的字符串去拼主机名）。
func kiroOrderedRegions(hint string) []string {
	out := []string{}
	clean := strings.ToLower(strings.TrimSpace(hint))
	if clean != "" && kiroRegionPattern.MatchString(clean) {
		out = append(out, clean)
	}
	for _, r := range KiroRegionCandidates {
		if r != clean {
			out = append(out, r)
		}
	}
	return out
}

func kiroOfficialVerifyURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "amazonaws.com" || strings.HasSuffix(host, ".amazonaws.com") ||
		host == "awsapps.com" || strings.HasSuffix(host, ".awsapps.com")
}

// KiroStartDevice 依次尝试 region 完成「注册客户端 + 设备授权」，返回用户码与授权地址。
func KiroStartDevice(ctx context.Context, startURL, regionHint string) (KiroDeviceStart, error) {
	start := strings.TrimSpace(startURL)
	if start == "" {
		start = KiroDefaultStartURL
	}
	if u, err := url.Parse(start); err != nil || u.Scheme != "https" || u.Host == "" {
		return KiroDeviceStart{}, errors.New("start_url 必须是合法的 https 地址")
	}
	regions := kiroOrderedRegions(regionHint)
	lastErr := "未知错误"
	for _, region := range regions {
		status, reg, err := deviceHTTPJSON(ctx, kiroAuthClient, http.MethodPost, kiroOIDCRegisterURL(region), map[string]any{
			"clientName": kiroClientName,
			"clientType": "public",
			"scopes":     kiroScopes,
		}, nil)
		if err != nil {
			lastErr = fmt.Sprintf("region %s 注册失败：%v", region, err)
			continue
		}
		clientID := clineString(reg, "clientId")
		clientSecret := clineString(reg, "clientSecret")
		if status < 200 || status >= 300 || clientID == "" || clientSecret == "" {
			lastErr = fmt.Sprintf("region %s 注册失败（HTTP %d）", region, status)
			continue
		}
		status, dev, err := deviceHTTPJSON(ctx, kiroAuthClient, http.MethodPost, kiroOIDCDeviceURL(region), map[string]any{
			"clientId":     clientID,
			"clientSecret": clientSecret,
			"startUrl":     start,
		}, nil)
		if err != nil {
			lastErr = fmt.Sprintf("region %s：%v", region, err)
			continue
		}
		deviceCode := clineString(dev, "deviceCode")
		if status < 200 || status >= 300 || deviceCode == "" {
			msg := clineString(dev, "message", "error_description", "error")
			if msg == "" {
				msg = fmt.Sprintf("HTTP %d", status)
			}
			lastErr = fmt.Sprintf("region %s：%s", region, msg)
			continue
		}
		verify := clineString(dev, "verificationUriComplete", "verificationUri")
		if !kiroOfficialVerifyURL(verify) {
			lastErr = fmt.Sprintf("region %s：授权地址不是官方地址", region)
			continue
		}
		interval := clineSeconds(dev, 5, "interval")
		if interval < 3 {
			interval = 3
		}
		ttl := clineSeconds(dev, 600, "expiresIn", "expires_in")
		if ttl > kiroCredentialTTLCap {
			ttl = kiroCredentialTTLCap
		}
		return KiroDeviceStart{
			Region:       region,
			StartURL:     start,
			ClientID:     clientID,
			ClientSecret: clientSecret,
			DeviceCode:   deviceCode,
			UserCode:     clineString(dev, "userCode"),
			VerifyURL:    verify,
			Interval:     interval,
			ExpiresIn:    ttl,
		}, nil
	}
	return KiroDeviceStart{}, fmt.Errorf("AWS SSO 设备授权失败（试过 %d 个 region）：%s", len(regions), lastErr)
}

// KiroJudgeToken 把 AWS token 端点响应判定成统一状态（纯函数，便于测试）。
//
// AWS 的 pending 是「异常名」而不是 HTTP 状态码；slow_down 要继续轮询而不是失败。
func KiroJudgeToken(status int, j map[string]any, s KiroDeviceStart) (DevicePoll, KiroCredential) {
	out := DevicePoll{Vendor: "kiro", Method: "kiro"}
	access := clineString(j, "accessToken", "access_token")
	if access != "" {
		out.Status = "success"
		cred := KiroCredential{
			AccessToken:  access,
			RefreshToken: clineString(j, "refreshToken", "refresh_token"),
			Region:       KiroSafeRegion(s.Region),
			ClientID:     s.ClientID,
			ClientSecret: s.ClientSecret,
			ExpiresAt:    time.Now().Unix() + int64(clineSeconds(j, 1800, "expiresIn", "expires_in")),
		}
		return out, cred
	}
	code := clineString(j, "error", "__type", "code")
	switch {
	case strings.Contains(code, "authorization_pending"), strings.Contains(code, "AuthorizationPending"):
		out.Status = "pending"
		out.Message = "等待在浏览器中完成授权"
	case strings.Contains(code, "slow_down"), strings.Contains(code, "SlowDown"):
		out.Status = "pending"
		out.SlowDown = true
		out.Message = "轮询过快，已自动放慢"
	case strings.Contains(code, "expired_token"), strings.Contains(code, "ExpiredToken"):
		out.Status = "expired"
		out.Message = "授权码已过期，请重新发起绑定"
	case strings.Contains(code, "access_denied"), strings.Contains(code, "AccessDenied"):
		out.Status = "denied"
		out.Message = "用户在授权页拒绝了本次请求"
	default:
		out.Status = "pending"
		if code != "" {
			out.Message = code
		} else {
			out.Message = fmt.Sprintf("HTTP %d", status)
		}
	}
	return out, KiroCredential{}
}

// KiroPollDevice 轮询一次设备授权。
func KiroPollDevice(ctx context.Context, s KiroDeviceStart) (DevicePoll, KiroCredential, error) {
	status, j, err := deviceHTTPJSON(ctx, kiroAuthClient, http.MethodPost, kiroOIDCTokenURL(s.Region), map[string]any{
		"clientId":     s.ClientID,
		"clientSecret": s.ClientSecret,
		"deviceCode":   s.DeviceCode,
		"grantType":    kiroDeviceGrant,
	}, nil)
	if err != nil {
		return DevicePoll{}, KiroCredential{}, err
	}
	out, cred := KiroJudgeToken(status, j, s)
	return out, cred, nil
}

// EncryptKiroCredential 加密 Kiro 凭据（复用 secretbox 路径）。
func EncryptKiroCredential(cred KiroCredential) (string, error) {
	if JWTSecret() == "" {
		return "", errors.New("凭据加密密钥尚未初始化")
	}
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return "", errors.New("Kiro 授权未返回可用凭据")
	}
	data, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	return cryptoutil.Encrypt(JWTSecret(), string(data))
}

// DecryptKiroCredential 解密落库的 Kiro 凭据；读取路径同样强制校验 region 白名单。
func DecryptKiroCredential(stored string) (KiroCredential, error) {
	var cred KiroCredential
	if !cryptoutil.IsEncrypted(stored) {
		return cred, errors.New("Kiro 凭据未加密或缺失，请重新绑定")
	}
	raw, err := cryptoutil.Decrypt(JWTSecret(), stored)
	if err != nil {
		return cred, errors.New("Kiro 凭据解密失败，请检查服务器加密密钥")
	}
	if json.Unmarshal([]byte(raw), &cred) != nil {
		return cred, errors.New("Kiro 凭据格式损坏，请重新绑定")
	}
	cred.Region = KiroSafeRegion(cred.Region)
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return cred, errors.New("Kiro 凭据缺少令牌，请重新绑定")
	}
	return cred, nil
}

// refreshKiroCredential 走 OIDC token 端点续期（grantType=refresh_token）。
func refreshKiroCredential(ctx context.Context, cred KiroCredential) (KiroCredential, error) {
	if cred.RefreshToken == "" {
		return cred, errors.New("Kiro 登录缺少 refresh_token，请重新一键绑定")
	}
	region := KiroSafeRegion(cred.Region)
	status, j, err := deviceHTTPJSON(ctx, kiroAuthClient, http.MethodPost, kiroOIDCTokenURL(region), map[string]any{
		"clientId":     cred.ClientID,
		"clientSecret": cred.ClientSecret,
		"refreshToken": cred.RefreshToken,
		"grantType":    kiroRefreshGrant,
	}, nil)
	if err != nil {
		return cred, err
	}
	if status < 200 || status >= 300 {
		return cred, fmt.Errorf("Kiro 凭据续期失败（HTTP %d），请重新绑定或稍后重试", status)
	}
	fresh := KiroCredential{
		AccessToken:  clineString(j, "accessToken", "access_token"),
		RefreshToken: clineString(j, "refreshToken", "refresh_token"),
		Region:       region,
		ClientID:     cred.ClientID,
		ClientSecret: cred.ClientSecret,
		ExpiresAt:    time.Now().Unix() + int64(clineSeconds(j, 3600, "expiresIn", "expires_in")),
	}
	if fresh.AccessToken == "" {
		return cred, errors.New("Kiro 刷新响应缺少 accessToken")
	}
	if fresh.RefreshToken == "" {
		fresh.RefreshToken = cred.RefreshToken
	}
	return fresh, nil
}

// 固定条带锁限制内存占用；auth_version CAS 防止在途刷新覆盖管理员重绑。
var kiroRefreshLocks [64]sync.Mutex

// ResolveKiroCredential 解析渠道凭据，必要时提前续期（单飞）。
func ResolveKiroCredential(ctx context.Context, id int64) (KiroCredential, error) {
	return resolveKiroCredential(ctx, id, false)
}

// ForceRefreshKiroCredential 强制续期（403 重试路径用）。
func ForceRefreshKiroCredential(ctx context.Context, id int64) (KiroCredential, error) {
	return resolveKiroCredential(ctx, id, true)
}

func resolveKiroCredential(ctx context.Context, id int64, force bool) (KiroCredential, error) {
	if id <= 0 {
		return KiroCredential{}, errors.New("Kiro 账号 ID 不正确")
	}
	mu := &kiroRefreshLocks[uint64(id)%uint64(len(kiroRefreshLocks))]
	mu.Lock()
	defer mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		var vendor, method, base, stored string
		var version int64
		err := db.DB.QueryRowContext(ctx, "SELECT vendor, method, base_url, COALESCE(auth_credential, ''), auth_version FROM channels WHERE id = ?", id).Scan(&vendor, &method, &base, &stored, &version)
		if err != nil {
			return KiroCredential{}, errors.New("读取 Kiro 账号凭据失败")
		}
		if vendor != "kiro" || method != "kiro" {
			return KiroCredential{}, errors.New("该账号不是 Kiro 设备授权渠道")
		}
		cred, err := DecryptKiroCredential(stored)
		if err != nil {
			return KiroCredential{}, err
		}
		if strings.TrimRight(strings.TrimSpace(base), "/") != KiroAPIBaseURL(cred.Region) {
			return KiroCredential{}, errors.New("该账号的 Kiro 接口地址不是官方地址，拒绝发送凭据")
		}
		now := time.Now().Unix()
		if !force && cred.AccessToken != "" && cred.ExpiresAt-kiroRefreshLead > now {
			return cred, nil
		}
		fresh, err := refreshKiroCredential(ctx, cred)
		if err != nil {
			if !force && cred.AccessToken != "" && cred.ExpiresAt > now+30 {
				return cred, nil
			}
			return KiroCredential{}, err
		}
		encrypted, err := EncryptKiroCredential(fresh)
		if err != nil {
			return KiroCredential{}, err
		}
		result, err := db.DB.ExecContext(ctx, `UPDATE channels SET auth_credential = ?, auth_expires_at = ?, auth_version = auth_version + 1 WHERE id = ? AND vendor = 'kiro' AND method = 'kiro' AND auth_version = ?`, encrypted, fresh.ExpiresAt, id, version)
		if err != nil {
			return KiroCredential{}, errors.New("Kiro 续期凭据保存失败")
		}
		count, err := result.RowsAffected()
		if err != nil {
			return KiroCredential{}, err
		}
		if count == 1 {
			return fresh, nil
		}
	}
	return KiroCredential{}, errors.New("Kiro 凭据正在更新，请重试")
}
