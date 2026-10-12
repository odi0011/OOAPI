package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Config 是某个平台在本站的接入配置。
type Config struct {
	Provider     *Provider
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

// AuthorizeURL 拼出跳转到平台的授权地址。
//
// state 用于防 CSRF；codeChallenge 用于 PKCE，
// 两者都由调用方生成并暂存，回调时再核对。
func (c *Config) AuthorizeURL(state, codeChallenge string) string {
	q := url.Values{}
	q.Set("client_id", c.ClientID)
	q.Set("redirect_uri", c.RedirectURI)
	q.Set("response_type", "code")
	q.Set("state", state)
	if len(c.Provider.Scopes) > 0 {
		q.Set("scope", strings.Join(c.Provider.Scopes, " "))
	}
	if c.Provider.UsePKCE && codeChallenge != "" {
		q.Set("code_challenge", codeChallenge)
		q.Set("code_challenge_method", "S256")
	}
	for k, v := range c.Provider.ExtraAuthParams {
		q.Set(k, v)
	}
	return c.Provider.AuthorizeURL + "?" + q.Encode()
}

// Exchange 用授权码换取 access token，并拉取用户资料。
func (c *Config) Exchange(ctx context.Context, code, codeVerifier string) (*UserInfo, error) {
	token, err := c.exchangeToken(ctx, code, codeVerifier)
	if err != nil {
		return nil, err
	}

	ctx = WithClientID(ctx, c.ClientID)
	info, err := c.Provider.FetchUserInfo(ctx, httpClient, token)
	if err != nil {
		return nil, err
	}
	if info.ProviderUserID == "" {
		return nil, fmt.Errorf("平台未返回用户标识")
	}
	return info, nil
}

// exchangeToken 处理取令牌的三个平台差异：
//   - 响应可能是 JSON，也可能是 urlencoded（QQ、GitHub 的某些情况）
//   - 客户端认证可能是 body 里的 client_secret，也可能要求 HTTP Basic（GitHub 推荐）
//   - 少数平台不返回 token_type
func (c *Config) exchangeToken(ctx context.Context, code, codeVerifier string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", c.RedirectURI)

	if c.Provider.UsePKCE && codeVerifier != "" {
		form.Set("code_verifier", codeVerifier)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Provider.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ooapi-gateway")

	// GitHub 与 GitLab 接受 Basic 认证；其余平台用 body 传参。
	// 同时提供两种，绝大多数平台会忽略不用的那一种。
	if c.ClientSecret != "" {
		basic := base64.StdEncoding.EncodeToString([]byte(url.QueryEscape(c.ClientID) + ":" + url.QueryEscape(c.ClientSecret)))
		req.Header.Set("Authorization", "Basic "+basic)
		form.Set("client_id", c.ClientID)
		form.Set("client_secret", c.ClientSecret)
		req.Body = io.NopCloser(strings.NewReader(form.Encode()))
		req.ContentLength = int64(len(form.Encode()))
	} else {
		form.Set("client_id", c.ClientID)
		req.Body = io.NopCloser(strings.NewReader(form.Encode()))
		req.ContentLength = int64(len(form.Encode()))
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("请求令牌失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}

	// 失败响应里可能含 error_description，尽量把它带给排障的人。
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("换取令牌失败（%d）：%s", resp.StatusCode, extractError(body))
	}

	return parseTokenResponse(body)
}

// parseTokenResponse 兼容 JSON 与 urlencoded 两种令牌响应格式。
func parseTokenResponse(body []byte) (string, error) {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "", fmt.Errorf("令牌响应为空")
	}

	// JSON 格式
	if strings.HasPrefix(text, "{") {
		var raw struct {
			AccessToken      string `json:"access_token"`
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		if err := json.Unmarshal([]byte(text), &raw); err != nil {
			return "", fmt.Errorf("解析令牌响应失败: %w", err)
		}
		if raw.AccessToken == "" {
			msg := raw.ErrorDescription
			if msg == "" {
				msg = raw.Error
			}
			if msg == "" {
				msg = "平台未返回 access_token"
			}
			return "", fmt.Errorf("%s", msg)
		}
		return raw.AccessToken, nil
	}

	// urlencoded 格式（QQ 走这条）
	values, err := url.ParseQuery(text)
	if err != nil {
		return "", fmt.Errorf("解析令牌响应失败: %w", err)
	}
	if token := values.Get("access_token"); token != "" {
		return token, nil
	}
	if e := values.Get("error_description"); e != "" {
		return "", fmt.Errorf("%s", e)
	}
	if e := values.Get("error"); e != "" {
		return "", fmt.Errorf("%s", e)
	}
	return "", fmt.Errorf("平台未返回 access_token")
}

func extractError(body []byte) string {
	var raw struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &raw); err == nil {
		if raw.ErrorDescription != "" {
			return raw.ErrorDescription
		}
		if raw.Error != "" {
			return raw.Error
		}
	}
	// 非 JSON 就截断原文，避免把整页 HTML 塞进错误信息。
	s := strings.TrimSpace(string(body))
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	if s == "" {
		s = "无响应内容"
	}
	return s
}

// ---------- state 与 PKCE ----------

// NewState 生成随机 state。
func NewState() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// NewPKCE 生成 PKCE 的 verifier 与其 S256 challenge。
// verifier 需要暂存到回调时使用，challenge 放进授权链接。
func NewPKCE() (verifier, challenge string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}
