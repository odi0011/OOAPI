package services

// 腾讯 WorkBuddy / CodeBuddy（CLI 凭据反代）的设备授权与凭据管理。
//
// 协议是腾讯自研的 state + authUrl（不是 RFC 8628）：
//
//	① POST {base}/v2/plugin/auth/state?platform=CLI → {data:{state, authUrl}}
//	② 用户在浏览器打开 authUrl 登录
//	③ GET  {base}/v2/plugin/auth/token?state=...    → 待授权时 HTTP 200 但业务 code != 0
//
// 关键点：**pending 不是 HTTP 错误**，必须看响应体里有没有令牌。
// 另外上游校验来源头（x-requested-with / origin / referer / 双段 UA），缺失会被直接拒。
//
// 该厂商**没有刷新流程**（原实现同样没有）：令牌过期只能重新一键绑定。
// realm（国际/国内）决定域：域错了会被网关 401（返回 HTML 而非 JSON），
// 看起来像 token 过期，实际只要换域即可 —— 因此 realm 落库并在传输层强校验。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

const (
	WorkBuddyCNBase     = "https://copilot.tencent.com"
	WorkBuddyGlobalBase = "https://www.workbuddy.ai"
	// workBuddyStartUA 是发起设备授权时使用的双段 UA（与聊天 UA 的版本号不同，各自实测可用）。
	workBuddyStartUA = "CLI/2.63.2 CodeBuddy/2.63.2"
)

// workBuddyAPIBase 可被测试替换为 httptest 服务器地址。
var workBuddyAPIBase = func(realm string) string {
	if NormalizeWorkBuddyRealm(realm) == "global" {
		return WorkBuddyGlobalBase
	}
	return WorkBuddyCNBase
}

var workBuddyAuthClient = &http.Client{
	Timeout:       20 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// WorkBuddyCredential 是落库的加密凭据形态。
type WorkBuddyCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Realm        string `json:"realm"`
	Endpoint     string `json:"endpoint"`
	UserID       string `json:"user_id"`
	EnterpriseID string `json:"enterprise_id"`
	ExpiresAt    int64  `json:"expires_at"`
}

// WorkBuddyDeviceStart 是一次设备授权会话的服务端上下文。
type WorkBuddyDeviceStart struct {
	Base      string
	Realm     string
	State     string
	VerifyURL string
	Interval  int // 秒
	ExpiresIn int // 秒
}

// NormalizeWorkBuddyRealm 归一 realm；默认为 global（按产品契约）。
func NormalizeWorkBuddyRealm(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), "cn") {
		return "cn"
	}
	return "global"
}

// WorkBuddyBaseURL 返回该 realm 的 API 基址（不带版本段，即凭据里的 endpoint）。
func WorkBuddyBaseURL(realm string) string {
	return workBuddyAPIBase(realm)
}

// WorkBuddyChannelBaseURL 返回渠道 base_url（openai-compat 会再拼 /chat/completions）。
func WorkBuddyChannelBaseURL(realm string) string {
	return strings.TrimRight(workBuddyAPIBase(realm), "/") + "/v2"
}

// WorkBuddyRealmHosts 返回 realm 的 API 基址、浏览器域与语言：
// 请求打到 copilot.tencent.com，而 Origin / X-Domain 用的是 www.codebuddy.cn（国内）。
func WorkBuddyRealmHosts(realm string) (api, webHost, locale string) {
	if NormalizeWorkBuddyRealm(realm) == "global" {
		return WorkBuddyGlobalBase, "www.workbuddy.ai", "en-US"
	}
	return WorkBuddyCNBase, "www.codebuddy.cn", "zh-CN"
}

// WorkBuddyRealmOfBase 判断 base_url 是否属于某个官方域；返回对应 realm。
func WorkBuddyRealmOfBase(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme != "https" || u.User != nil {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "www.workbuddy.ai":
		return "global", true
	case "copilot.tencent.com":
		return "cn", true
	}
	return "", false
}

// workBuddyStartHeaders 是发起/轮询设备授权必须携带的来源头（缺失会被上游拒）。
func workBuddyStartHeaders(realm string) map[string]string {
	_, webHost, _ := WorkBuddyRealmHosts(realm)
	return map[string]string{
		"x-requested-with": "XMLHttpRequest",
		"origin":           "https://" + webHost,
		"referer":          "https://" + webHost + "/",
		"user-agent":       workBuddyStartUA,
	}
}

// WorkBuddyStartDevice 发起一次设备授权，返回用户需要打开的授权地址。
func WorkBuddyStartDevice(ctx context.Context, realm string) (WorkBuddyDeviceStart, error) {
	realm = NormalizeWorkBuddyRealm(realm)
	base := workBuddyAPIBase(realm)
	status, j, err := deviceHTTPJSON(ctx, workBuddyAuthClient, http.MethodPost, base+"/v2/plugin/auth/state?platform=CLI", map[string]any{}, workBuddyStartHeaders(realm))
	if err != nil {
		return WorkBuddyDeviceStart{}, err
	}
	data := mapObject(j, "data")
	state := clineString(data, "state")
	if state == "" {
		state = clineString(j, "state")
	}
	authURL := clineString(data, "authUrl")
	if authURL == "" {
		authURL = clineString(j, "authUrl")
	}
	if status < 200 || status >= 300 || state == "" || authURL == "" {
		msg := clineString(j, "msg", "message")
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status)
		}
		return WorkBuddyDeviceStart{}, fmt.Errorf("发起 WorkBuddy 授权失败：%s", msg)
	}
	if u, err := url.Parse(authURL); err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return WorkBuddyDeviceStart{}, errors.New("WorkBuddy 授权地址不合法")
	}
	return WorkBuddyDeviceStart{Base: base, Realm: realm, State: state, VerifyURL: authURL, Interval: 3, ExpiresIn: 600}, nil
}

// decodeJWTPayload 解码 JWT 的 payload 段（第二段），纯标准库实现。
//
// WorkBuddy 的 access_token 是 JWT：真实过期时间在 `exp` claim 里，账号版本在
// `iss` claim 里。任何畸形输入（空串、段数不对、base64 或 JSON 解析失败、
// 解析出的不是 JSON 对象）都必须返回 false —— 这个函数不得 panic，
// 调用方据此回退到其它估算方式。
func decodeJWTPayload(token string) (map[string]any, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	// JWT 固定三段 header.payload.signature；签名可以为空（alg:none），
	// 但不能缺段或多段（多段是 JWE，payload 是密文，解不出 claim）。
	if len(parts) != 3 || parts[1] == "" {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// 少数实现会带 "=" 填充；再试一次带填充的 URL 编码。
		raw, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, false
		}
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil || payload == nil {
		return nil, false
	}
	return payload, true
}

// jwtSecondsClaim 从 JWT claim 里取秒级时间戳：JSON 数字（float64 / json.Number）
// 或数字字符串。非法或非正数返回 false。
func jwtSecondsClaim(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return int64(n), true
		}
	case json.Number:
		if i, err := n.Int64(); err == nil && i > 0 {
			return i, true
		}
	case string:
		if i, err := strconv.ParseInt(strings.TrimSpace(n), 10, 64); err == nil && i > 0 {
			return i, true
		}
	}
	return 0, false
}

// workBuddyRealmOfJWT 从 access_token 的 `iss` claim 判定账号版本，
// 与原始实现 realmOf 一致：workbuddy.ai / codebuddy.ai → global，
// codebuddy.cn / tencent.com → cn。判不出来时返回 ("", false)。
func workBuddyRealmOfJWT(token string) (string, bool) {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return "", false
	}
	iss, _ := payload["iss"].(string)
	iss = strings.ToLower(strings.TrimSpace(iss))
	if iss == "" {
		return "", false
	}
	if strings.Contains(iss, "workbuddy.ai") || strings.Contains(iss, "codebuddy.ai") {
		return "global", true
	}
	if strings.Contains(iss, "codebuddy.cn") || strings.Contains(iss, "tencent.com") {
		return "cn", true
	}
	return "", false
}

// workBuddyJWTExpiry 取 access_token 的真实过期时间（JWT `exp`，秒）。
//
// 这是权威过期时间：上游响应里的 expiresIn 常常缺失（曾因此用 3600 兜底，
// 导致「1 小时后凭据被当成过期」的线上问题）。畸形、缺失或明显不合理的
// exp（已过期超过 5 分钟 / 距今超过 30 天）返回 0，由调用方回退。
func workBuddyJWTExpiry(token string, now time.Time) int64 {
	payload, ok := decodeJWTPayload(token)
	if !ok {
		return 0
	}
	exp, ok := jwtSecondsClaim(payload["exp"])
	if !ok {
		return 0
	}
	/*
		合理性窗口（实测校准）。

		实测 WorkBuddy 真实 token 的 exp 约为签发后 1 年（Keycloak 默认长期会话），
		早先设的「30 天上限」会把它判为不可信、回退到 3600 秒兜底 ——
		结果凭据被标成 1 小时到期，一小时后就开始报「登录已过期」，
		而 token 其实还有一年有效期。上限放宽到 400 天。
	*/
	if exp <= now.Unix()-300 || exp >= now.Unix()+400*24*60*60 {
		return 0
	}
	return exp
}

// WorkBuddyJudgeToken 把一次轮询判定成统一状态（纯函数，便于测试）。
// pending 的判据是「没有令牌」，而不是 HTTP 状态码。
func WorkBuddyJudgeToken(status int, j map[string]any, realm string) (DevicePoll, WorkBuddyCredential) {
	out := DevicePoll{Vendor: "workbuddy", Method: "workbuddy", Status: "pending", Message: clineString(j, "msg", "message")}
	data := mapObject(j, "data")
	token := clineString(data, "accessToken", "access_token")
	if token == "" {
		if out.Message == "" && status != http.StatusOK {
			out.Message = fmt.Sprintf("HTTP %d", status)
		}
		return out, WorkBuddyCredential{}
	}
	out.Status = "success"
	out.Message = ""
	realm = NormalizeWorkBuddyRealm(realm)
	// 账号版本以 token 自己的 iss 为准：域与账号不匹配时上游会 401，
	// 看起来与「登录过期」一模一样（原始实现同样按 iss 判域）。
	if fromJWT, ok := workBuddyRealmOfJWT(token); ok {
		realm = fromJWT
	}
	now := time.Now()
	// 兜底：上游响应里的 expiresIn；没有该字段时才是 3600 秒的保守估计。
	expiresAt := now.Unix() + int64(clineSeconds(data, 3600, "expiresIn", "expires_in"))
	// 权威来源：access_token 是 JWT，`exp` 才是真实过期时间。
	if exp := workBuddyJWTExpiry(token, now); exp > 0 {
		expiresAt = exp
	}
	return out, WorkBuddyCredential{
		AccessToken:  token,
		RefreshToken: clineString(data, "refreshToken", "refresh_token"),
		Realm:        realm,
		Endpoint:     WorkBuddyBaseURL(realm),
		ExpiresAt:    expiresAt,
	}
}

// WorkBuddyPollDevice 轮询一次设备授权；成功后尽力补账号信息（失败不阻断）。
func WorkBuddyPollDevice(ctx context.Context, s WorkBuddyDeviceStart) (DevicePoll, WorkBuddyCredential, error) {
	base := strings.TrimRight(strings.TrimSpace(s.Base), "/")
	if base == "" {
		base = workBuddyAPIBase(s.Realm)
	}
	target := base + "/v2/plugin/auth/token?state=" + url.QueryEscape(s.State)
	status, j, err := deviceHTTPJSON(ctx, workBuddyAuthClient, http.MethodGet, target, nil, workBuddyStartHeaders(s.Realm))
	if err != nil {
		return DevicePoll{}, WorkBuddyCredential{}, err
	}
	out, cred := WorkBuddyJudgeToken(status, j, s.Realm)
	if out.Status != "success" {
		return out, WorkBuddyCredential{}, nil
	}
	uid, eid := workBuddyAccountInfo(ctx, base, s.State, cred.AccessToken)
	cred.UserID = uid
	cred.EnterpriseID = eid
	return out, cred, nil
}

// workBuddyAccountInfo 尽力而为地取 uid / enterpriseId（有它聊天才带 X-User-Id）。
func workBuddyAccountInfo(ctx context.Context, base, state, token string) (string, string) {
	status, j, err := deviceHTTPJSON(ctx, workBuddyAuthClient, http.MethodGet, base+"/v2/plugin/login/account?state="+url.QueryEscape(state), nil, map[string]string{
		"authorization": "Bearer " + token,
		"user-agent":    workBuddyStartUA,
	})
	if err != nil || status < 200 || status >= 300 {
		return "", ""
	}
	data := mapObject(j, "data")
	if len(data) == 0 {
		data = j
	}
	return clineString(data, "uid", "userId", "user_id"), clineString(data, "enterpriseId", "enterprise_id")
}

// EncryptWorkBuddyCredential 加密 WorkBuddy 凭据。
func EncryptWorkBuddyCredential(cred WorkBuddyCredential) (string, error) {
	if JWTSecret() == "" {
		return "", errors.New("凭据加密密钥尚未初始化")
	}
	if cred.AccessToken == "" {
		return "", errors.New("WorkBuddy 授权未返回可用凭据")
	}
	data, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	return cryptoutil.Encrypt(JWTSecret(), string(data))
}

// DecryptWorkBuddyCredential 解密落库凭据，并归一 realm/endpoint。
func DecryptWorkBuddyCredential(stored string) (WorkBuddyCredential, error) {
	var cred WorkBuddyCredential
	if !cryptoutil.IsEncrypted(stored) {
		return cred, errors.New("WorkBuddy 凭据未加密或缺失，请重新绑定")
	}
	raw, err := cryptoutil.Decrypt(JWTSecret(), stored)
	if err != nil {
		return cred, errors.New("WorkBuddy 凭据解密失败，请检查服务器加密密钥")
	}
	if json.Unmarshal([]byte(raw), &cred) != nil {
		return cred, errors.New("WorkBuddy 凭据格式损坏，请重新绑定")
	}
	cred.Realm = NormalizeWorkBuddyRealm(cred.Realm)
	if cred.AccessToken == "" {
		return cred, errors.New("WorkBuddy 凭据缺少 access_token，请重新绑定")
	}
	if cred.Endpoint == "" {
		cred.Endpoint = WorkBuddyBaseURL(cred.Realm)
	}
	// 旧凭据可能存着「1 小时」的兜底估算（历史 bug）；JWT 的 exp 更权威。
	// 校正后回写库：不回写的话，账号卡片的「凭据约 N 分钟后到期」会一直显示旧值，
	// 而实际凭据是好的 —— 显示与真实状态不符比不显示更误导。
	if exp := workBuddyJWTExpiry(cred.AccessToken, time.Now()); exp > 0 {
		cred.ExpiresAt = exp
	}
	return cred, nil
}

// PersistWorkBuddyExpiry 把校正后的过期时间回写库（best-effort，失败不影响本次请求）。
func PersistWorkBuddyExpiry(ctx context.Context, id int64, cred WorkBuddyCredential) {
	if id <= 0 || cred.ExpiresAt <= 0 {
		return
	}
	encrypted, err := EncryptWorkBuddyCredential(cred)
	if err != nil {
		return
	}
	_, _ = db.DB.ExecContext(ctx,
		"UPDATE channels SET auth_credential = ?, auth_expires_at = ? WHERE id = ? AND method = 'workbuddy'",
		encrypted, cred.ExpiresAt, id)
}

// ResolveWorkBuddyCredential 读取渠道凭据。
//
// 本厂商没有刷新流程（原实现同样没有）：这里只解密 + 校验渠道地址与 realm 一致。
// 地址与 realm 不一致时拒绝发送 —— 域不匹配会让有效令牌被上游 401。
func ResolveWorkBuddyCredential(ctx context.Context, id int64) (WorkBuddyCredential, error) {
	if id <= 0 {
		return WorkBuddyCredential{}, errors.New("WorkBuddy 账号 ID 不正确")
	}
	var vendor, method, base, stored string
	err := db.DB.QueryRowContext(ctx, "SELECT vendor, method, base_url, COALESCE(auth_credential, '') FROM channels WHERE id = ?", id).Scan(&vendor, &method, &base, &stored)
	if err != nil {
		return WorkBuddyCredential{}, errors.New("读取 WorkBuddy 账号凭据失败")
	}
	if vendor != "workbuddy" || method != "workbuddy" {
		return WorkBuddyCredential{}, errors.New("该账号不是 WorkBuddy 设备授权渠道")
	}
	cred, err := DecryptWorkBuddyCredential(stored)
	if err != nil {
		return WorkBuddyCredential{}, err
	}
	baseRealm, ok := WorkBuddyRealmOfBase(base)
	if !ok {
		return WorkBuddyCredential{}, errors.New("该账号的 WorkBuddy 接口地址不是官方地址，拒绝发送凭据")
	}
	if baseRealm != cred.Realm {
		return WorkBuddyCredential{}, errors.New("该账号的接口地址与账号所在版本（国际/国内）不一致，请重新绑定")
	}
	// 校正后的有效期回写（旧记录带的是历史兜底估算）。写失败不影响本次请求。
	PersistWorkBuddyExpiry(ctx, id, cred)
	return cred, nil
}
