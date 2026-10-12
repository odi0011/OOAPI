package services

import (
	"errors"
	"log"
	"strconv"
	"strings"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
	"ooapi/internal/oauth"
)

var (
	ErrUnknownProvider    = errors.New("不支持的登录平台")
	ErrIncompleteProvider = errors.New("请先填写 Client ID 与 Client Secret 再启用")
	ErrIncompleteSMTP     = errors.New("请先填写 SMTP 服务器地址再启用")
)

// 配置项键名约定：oauth_<平台>_client_id / _client_secret / _enabled
func clientIDKey(provider string) string     { return "oauth_" + provider + "_client_id" }
func clientSecretKey(provider string) string { return "oauth_" + provider + "_client_secret" }
func enabledKey(provider string) string      { return "oauth_" + provider + "_enabled" }

// OAuthProviderState 是某个平台的配置概览，用于管理端展示。
// 注意只暴露「是否已配置」与掩码，绝不返回完整密钥。
type OAuthProviderState struct {
	Key          string `json:"key"`
	DisplayName  string `json:"display_name"`
	Enabled      bool   `json:"enabled"`
	Configured   bool   `json:"configured"`
	ClientID     string `json:"client_id"`
	SecretMasked string `json:"secret_masked"`
	CallbackURL  string `json:"callback_url"`
	// UsePKCE 提示管理员该平台走 PKCE，回调地址必须与平台后台完全一致。
	UsePKCE bool `json:"use_pkce"`
}

// OAuthConfig 返回某个平台可用的接入配置；未配置或未启用时返回 false。
func OAuthConfig(providerKey, baseURL string) (*oauth.Config, bool) {
	p, ok := oauth.Lookup(providerKey)
	if !ok {
		return nil, false
	}

	if !GetBoolOption(enabledKey(p.Key), false) {
		return nil, false
	}

	clientID := strings.TrimSpace(GetOption(clientIDKey(p.Key), ""))
	secretRaw := GetOption(clientSecretKey(p.Key), "")
	if clientID == "" || secretRaw == "" {
		return nil, false
	}

	secret, err := cryptoutil.Decrypt(JWTSecret(), secretRaw)
	if err != nil {
		log.Printf("[oauth] 解密 %s 的 Client Secret 失败: %v", p.Key, err)
		return nil, false
	}

	return &oauth.Config{
		Provider:     p,
		ClientID:     clientID,
		ClientSecret: secret,
		RedirectURI:  OAuthCallbackURL(p.Key, baseURL),
	}, true
}

// OAuthCallbackURL 拼出回调地址。
// 平台后台登记的回调地址必须与此完全一致，否则授权会被拒绝。
func OAuthCallbackURL(providerKey, baseURL string) string {
	return strings.TrimRight(baseURL, "/") + "/api/auth/oauth/" + providerKey + "/callback"
}

// EnabledOAuthProviders 返回已启用的平台列表，供登录页渲染按钮。
// 只返回 key 与显示名 —— 前端不需要也不应该知道 Client ID。
func EnabledOAuthProviders(baseURL string) []map[string]string {
	out := []map[string]string{}
	for _, p := range oauth.All() {
		if _, ok := OAuthConfig(p.Key, baseURL); !ok {
			continue
		}
		out = append(out, map[string]string{
			"key":          p.Key,
			"display_name": p.DisplayName,
		})
	}
	return out
}

// OAuthProviderStates 返回全部平台的配置状态，供管理端展示。
func OAuthProviderStates(baseURL string) []OAuthProviderState {
	out := make([]OAuthProviderState, 0, 7)
	for _, p := range oauth.All() {
		clientID := strings.TrimSpace(GetOption(clientIDKey(p.Key), ""))
		secretRaw := GetOption(clientSecretKey(p.Key), "")

		masked := ""
		if secretRaw != "" {
			plain, err := cryptoutil.Decrypt(JWTSecret(), secretRaw)
			if err == nil {
				masked = cryptoutil.MaskSecret(plain)
			} else {
				masked = "（解密失败）"
			}
		}

		out = append(out, OAuthProviderState{
			Key:          p.Key,
			DisplayName:  p.DisplayName,
			Enabled:      GetBoolOption(enabledKey(p.Key), false),
			Configured:   clientID != "" && secretRaw != "",
			ClientID:     clientID,
			SecretMasked: masked,
			CallbackURL:  OAuthCallbackURL(p.Key, baseURL),
			UsePKCE:      p.UsePKCE,
		})
	}
	return out
}

// SaveOAuthProvider 保存某个平台的配置。
//
// 两个约定：
//   - 传入空 secret 表示「保持原值不变」，这样管理员改 Client ID 时
//     不必重新粘贴一遍密钥（也避免掩码值被当成真密钥存回去）。
//   - 密钥加密后再入库，数据库备份泄露时不会直接暴露。
func SaveOAuthProvider(providerKey, clientID, clientSecret string, enabled bool) error {
	if _, ok := oauth.Lookup(providerKey); !ok {
		return ErrUnknownProvider
	}

	updates := map[string]string{
		enabledKey(providerKey): boolString(enabled),
	}

	if clientID != "" {
		updates[clientIDKey(providerKey)] = strings.TrimSpace(clientID)
	}

	if clientSecret != "" {
		enc, err := cryptoutil.Encrypt(JWTSecret(), clientSecret)
		if err != nil {
			return err
		}
		updates[clientSecretKey(providerKey)] = enc
	}

	// 开关打开但凭据不全时拒绝，否则登录页会显示一个点不通的按钮。
	if enabled {
		id := strings.TrimSpace(GetOption(clientIDKey(providerKey), ""))
		secret := GetOption(clientSecretKey(providerKey), "")
		if v, ok := updates[clientIDKey(providerKey)]; ok {
			id = v
		}
		if v, ok := updates[clientSecretKey(providerKey)]; ok {
			secret = v
		}
		if id == "" || secret == "" {
			return ErrIncompleteProvider
		}
	}

	return SetOptions(updates)
}

// ---------- SMTP ----------

// SMTPConfig 是发信配置。
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	FromName string
	// UseTLS 为 true 时用直连 TLS（通常 465 端口），
	// 否则用 STARTTLS（587 或 25 端口）。
	UseTLS bool
}

// SMTPConfigState 是给管理端看的概览，密码只回掩码。
type SMTPConfigState struct {
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Username     string `json:"username"`
	PasswordMask string `json:"password_masked"`
	From         string `json:"from"`
	FromName     string `json:"from_name"`
	UseTLS       bool   `json:"use_tls"`
	Configured   bool   `json:"configured"`
	Enabled      bool   `json:"enabled"`
}

const (
	smtpHostKey = "smtp_host"
	smtpPortKey = "smtp_port"
	smtpUserKey = "smtp_username"
	smtpPassKey = "smtp_password"
	smtpFromKey = "smtp_from"
	smtpNameKey = "smtp_from_name"
	smtpTLSKey  = "smtp_use_tls"
	smtpOnKey   = "smtp_enabled"
)

// GetSMTPConfig 返回发信配置；未配置或未启用时第二个返回值为 false。
func GetSMTPConfig() (SMTPConfig, bool) {
	if !GetBoolOption(smtpOnKey, false) {
		return SMTPConfig{}, false
	}

	host := strings.TrimSpace(GetOption(smtpHostKey, ""))
	if host == "" {
		return SMTPConfig{}, false
	}

	passRaw := GetOption(smtpPassKey, "")
	pass := ""
	if passRaw != "" {
		plain, err := cryptoutil.Decrypt(JWTSecret(), passRaw)
		if err != nil {
			log.Printf("[smtp] 解密密码失败: %v", err)
			return SMTPConfig{}, false
		}
		pass = plain
	}

	port := GetIntOption(smtpPortKey, 587)
	if port <= 0 || port > 65535 {
		port = 587
	}

	from := strings.TrimSpace(GetOption(smtpFromKey, ""))
	if from == "" {
		from = GetOption(smtpUserKey, "")
	}

	return SMTPConfig{
		Host:     host,
		Port:     port,
		Username: strings.TrimSpace(GetOption(smtpUserKey, "")),
		Password: pass,
		From:     from,
		FromName: GetOption(smtpNameKey, "OOAPI"),
		UseTLS:   GetBoolOption(smtpTLSKey, port == 465),
	}, true
}

// SMTPAvailable 表示邮箱验证码登录是否可用，登录页据此决定是否显示入口。
func SMTPAvailable() bool {
	_, ok := GetSMTPConfig()
	return ok
}

// SMTPState 返回管理端展示用的配置。
func SMTPState() SMTPConfigState {
	passRaw := GetOption(smtpPassKey, "")
	masked := ""
	if passRaw != "" {
		if plain, err := cryptoutil.Decrypt(JWTSecret(), passRaw); err == nil {
			masked = cryptoutil.MaskSecret(plain)
		} else {
			masked = "（解密失败）"
		}
	}

	host := strings.TrimSpace(GetOption(smtpHostKey, ""))
	user := strings.TrimSpace(GetOption(smtpUserKey, ""))

	return SMTPConfigState{
		Host:         host,
		Port:         GetIntOption(smtpPortKey, 587),
		Username:     user,
		PasswordMask: masked,
		From:         GetOption(smtpFromKey, ""),
		FromName:     GetOption(smtpNameKey, "OOAPI"),
		UseTLS:       GetBoolOption(smtpTLSKey, false),
		Configured:   host != "" && user != "",
		Enabled:      GetBoolOption(smtpOnKey, false),
	}
}

// SaveSMTP 保存发信配置。空密码表示保持原值。
func SaveSMTP(cfg SMTPConfig, enabled bool) error {
	updates := map[string]string{
		smtpHostKey: cfg.Host,
		smtpPortKey: itoa(cfg.Port),
		smtpUserKey: cfg.Username,
		smtpFromKey: cfg.From,
		smtpNameKey: cfg.FromName,
		smtpTLSKey:  boolString(cfg.UseTLS),
		smtpOnKey:   boolString(enabled),
	}

	if cfg.Password != "" {
		enc, err := cryptoutil.Encrypt(JWTSecret(), cfg.Password)
		if err != nil {
			return err
		}
		updates[smtpPassKey] = enc
	}

	if enabled && cfg.Host == "" {
		return ErrIncompleteSMTP
	}

	return SetOptions(updates)
}

// ---------- 展示用开关 ----------

// PublicAuthProviders 汇总登录页需要的认证方式信息。
// 只暴露「有哪些方式可用」，不含任何凭据。
func PublicAuthProviders(baseURL string) map[string]any {
	return map[string]any{
		"oauth":              EnabledOAuthProviders(baseURL),
		"email_code_enabled": SMTPAvailable(),
		"password_enabled":   GetBoolOption("password_login_enabled", true),
	}
}

// ---------- 小工具 ----------

func boolString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func itoa(v int) string {
	return strconv.Itoa(v)
}

// 清理过期的 oauth_states 与 email_codes，避免表无限增长。
// 由请求路径惰性触发，不需要额外的定时任务。
func CleanupAuthArtifacts() {
	if db.DB == nil {
		return
	}
	if _, err := db.DB.Exec("DELETE FROM oauth_states WHERE expires_at < NOW()"); err != nil {
		log.Printf("[cleanup] 清理 oauth_states 失败: %v", err)
	}
	if _, err := db.DB.Exec("DELETE FROM email_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)"); err != nil {
		log.Printf("[cleanup] 清理 email_codes 失败: %v", err)
	}
}
