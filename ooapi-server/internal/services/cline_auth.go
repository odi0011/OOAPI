package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

const (
	ClineAPIBase         = "https://api.cline.bot/api/v1"
	clineClientID        = "client_01K3A541FN8TA3EPPHTD2325AR"
	clineDeviceURL       = "https://api.workos.com/user_management/authorize/device"
	clineAuthenticateURL = "https://api.workos.com/user_management/authenticate"
	clineRefreshURL      = ClineAPIBase + "/auth/refresh"
)

// OAuth credentials never occupy the API-key column.
type ClineCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
}

var clineAuthClient = &http.Client{
	Timeout:       20 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func clineJSON(ctx context.Context, target string, body any) (int, map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, errors.New("无法构造 Cline 授权请求")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OOAPI-Gateway/1.0")
	resp, err := clineAuthClient.Do(req)
	if err != nil {
		return 0, nil, errors.New("Cline 授权服务连接失败或超时")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return resp.StatusCode, nil, errors.New("Cline 授权响应过大或读取失败")
	}
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		return resp.StatusCode, nil, fmt.Errorf("Cline 授权响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	return resp.StatusCode, out, nil
}

func clineString(j map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := j[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
func clineSeconds(j map[string]any, fallback int, keys ...string) int {
	for _, k := range keys {
		if n, ok := j[k].(float64); ok && n > 0 && n <= 86400 {
			return int(n)
		}
	}
	return fallback
}
func clineTokenObject(j map[string]any) map[string]any {
	for _, k := range []string{"data", "tokens"} {
		if obj, ok := j[k].(map[string]any); ok {
			j = obj
		}
	}
	return j
}
func clineCredentialFrom(j map[string]any, oldRefresh string) ClineCredential {
	j = clineTokenObject(j)
	refresh := clineString(j, "refresh_token", "refreshToken")
	if refresh == "" {
		refresh = oldRefresh
	}
	return ClineCredential{
		AccessToken:  clineString(j, "access_token", "accessToken"),
		RefreshToken: refresh,
		ExpiresAt:    time.Now().Unix() + int64(clineSeconds(j, 3600, "expires_in", "expiresIn")),
	}
}
func EncryptClineCredential(cred ClineCredential) (string, error) {
	if JWTSecret() == "" {
		return "", errors.New("凭据加密密钥尚未初始化")
	}
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return "", errors.New("Cline 授权未返回可用凭据")
	}
	data, err := json.Marshal(cred)
	if err != nil {
		return "", err
	}
	return cryptoutil.Encrypt(JWTSecret(), string(data))
}
func decryptClineCredential(stored string) (ClineCredential, error) {
	var cred ClineCredential
	if !cryptoutil.IsEncrypted(stored) {
		return cred, errors.New("Cline 凭据未加密或缺失，请重新绑定")
	}
	raw, err := cryptoutil.Decrypt(JWTSecret(), stored)
	if err != nil {
		return cred, errors.New("Cline 凭据解密失败，请检查服务器加密密钥")
	}
	if json.Unmarshal([]byte(raw), &cred) != nil {
		return cred, errors.New("Cline 凭据格式损坏，请重新绑定")
	}
	return cred, nil
}

// DecryptClineCredential 解密存储的 Cline 凭据。
// 供设备票据链路使用：渠道还没落库时按渠道 ID 解析凭据是走不通的，
// 那时只能从票据里的密文直接解密。
func DecryptClineCredential(stored string) (ClineCredential, error) {
	return decryptClineCredential(stored)
}
func refreshClineCredential(ctx context.Context, cred ClineCredential) (ClineCredential, error) {
	if cred.RefreshToken == "" {
		return cred, errors.New("Cline 登录已过期，请重新一键绑定")
	}
	status, j, err := clineJSON(ctx, clineRefreshURL, map[string]string{"refreshToken": cred.RefreshToken, "grantType": "refresh_token"})
	if err != nil {
		return cred, err
	}
	if status < 200 || status >= 300 {
		return cred, fmt.Errorf("Cline 凭据续期失败（HTTP %d），请重新绑定或稍后重试", status)
	}
	fresh := clineCredentialFrom(j, cred.RefreshToken)
	if fresh.AccessToken == "" {
		return cred, errors.New("Cline 刷新响应缺少 accessToken")
	}
	return fresh, nil
}

// Fixed stripes bound lock memory; CAS prevents an in-flight refresh overwriting a rebind.
var clineRefreshLocks [64]sync.Mutex

func ResolveClineToken(ctx context.Context, id int64) (string, error) {
	if id <= 0 {
		return "", errors.New("Cline 账号 ID 不正确")
	}
	mu := &clineRefreshLocks[uint64(id)%uint64(len(clineRefreshLocks))]
	mu.Lock()
	defer mu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		var vendor, method, base, stored string
		var version int64
		err := db.DB.QueryRowContext(ctx, "SELECT vendor, method, base_url, COALESCE(auth_credential, ''), auth_version FROM channels WHERE id = ?", id).Scan(&vendor, &method, &base, &stored, &version)
		if err != nil {
			return "", errors.New("读取 Cline 账号凭据失败")
		}
		if vendor != "cline" || method != "cli" || base != ClineAPIBase {
			return "", errors.New("该账号不是 Cline 设备授权渠道")
		}
		cred, err := decryptClineCredential(stored)
		if err != nil {
			return "", err
		}
		if cred.AccessToken != "" && cred.ExpiresAt > time.Now().Unix()+300 {
			return cred.AccessToken, nil
		}
		fresh, err := refreshClineCredential(ctx, cred)
		if err != nil {
			if cred.AccessToken != "" && cred.ExpiresAt > time.Now().Unix()+30 {
				return cred.AccessToken, nil
			}
			return "", err
		}
		encrypted, err := EncryptClineCredential(fresh)
		if err != nil {
			return "", err
		}
		result, err := db.DB.ExecContext(ctx, `UPDATE channels SET auth_credential = ?, auth_expires_at = ?, auth_version = auth_version + 1 WHERE id = ? AND vendor = 'cline' AND method = 'cli' AND auth_version = ?`, encrypted, fresh.ExpiresAt, id, version)
		if err != nil {
			return "", errors.New("Cline 续期凭据保存失败")
		}
		count, err := result.RowsAffected()
		if err != nil {
			return "", err
		}
		if count == 1 {
			return fresh.AccessToken, nil
		}
	}
	return "", errors.New("Cline 凭据正在更新，请重试")
}

// Attribution only: no official-product fingerprints or subscription-gate bypass headers.
func SetClineRequestHeaders(req *http.Request) {
	req.Header.Set("HTTP-Referer", "https://cline.bot")
	req.Header.Set("X-Title", "OOAPI")
	req.Header.Set("User-Agent", "OOAPI-Gateway/1.0")
}

func UnwrapClineEnvelope(raw []byte) []byte {
	var j map[string]json.RawMessage
	if json.Unmarshal(raw, &j) != nil || j["choices"] != nil {
		return raw
	}
	var inner map[string]json.RawMessage
	if json.Unmarshal(j["data"], &inner) != nil || inner["choices"] == nil {
		return raw
	}
	if inner["usage"] == nil && j["usage"] != nil {
		inner["usage"] = j["usage"]
	}
	result, err := json.Marshal(inner)
	if err != nil {
		return raw
	}
	return result
}
